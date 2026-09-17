'use strict';
/**
 * HTTP-Trigger: Eingangsrechnung -> Klassifizierung + Validierung + Werk + Daten
 * ============================================================================
 *   GET  /api/intake              -> JSON-Info (Health)
 *   POST /api/intake?werk=<Kuerzel> -> Body = ZUGFeRD-PDF | XRechnung-XML | normales PDF
 *                                    Antwort = JSON-Umschlag (siehe unten)
 *
 * ZWECK: Eingangsstufe. Eine Datei rein, ein JSON raus, das Power Automate alles
 * liefert, um die Rechnung geprueft in ERAR_<Werk> abzulegen. Das Werk ist bei
 * Eingang meist schon durch das Postfach bekannt -> ?werk= uebergeben; ohne
 * Hinweis wird es aus dem Empfaenger abgeleitet.
 *
 * Antwort:
 *   {
 *     klassifizierung: 'zugferd' | 'xrechnung-xml' | 'pdf-ohne-xml',
 *     quelle:          'PDF' | 'XML',
 *     werk:            Ablage-Werk (Ausgang: aus Verkaeufer; Eingang: ?werk=/Empfaenger),
 *     werkErkannt:     aus dem RechnungsEMPFÄNGER abgeleitet (Eingang-Gegenprobe),
 *     werkAusVerkaeufer: aus dem AUSSTELLER abgeleitet (Ausgang-Erkennung),
 *     richtung:        'Eingang' | 'Ausgang' (DIHAG-Gesellschaft = Aussteller -> Ausgang),
 *     zielbibliothek:  'ERAR_<Werk>' (Eingang) | 'AR_<Werk>' (Ausgang) — fertig fuer den Flow,
 *     werkMismatch:    true, wenn Eingang und ?werk= != werkErkannt (moegliche Fehlleitung),
 *     konform:         'gruen'|'gelb'|'rot'|'ungeprueft',
 *     konformLabel, accepted, errorCount, warningCount, meldungen[],
 *     bericht:         <roher KoSIT-Pruefbericht als String>  (Archiv/GoBD),
 *     berichtHtml?:    <HTML-Darstellung, falls eingebettet>,
 *     pdfa:            { konform, ... } | null  (veraPDF, nur bei PDF-Eingang),
 *     pdfXmlAbgleich:  { status: 'ok'|'abweichung'|'nicht-pruefbar', hinweis } | null (nur ZUGFeRD:
 *                      Sichtbild gegen eingebettete XML — abweichender Betrag/Nummer = Warnung),
 *     auslandOhneLeitweg: true, wenn XRechnung an Auslandskunde ohne Leitweg (Prozesshinweis),
 *     daten:           { nummer, datum, steller, empfaenger, netto, ... } | null,
 *     xml:             <extrahierte/empfangene E-Rechnungs-XML> | null,
 *     lesbarPdfBase64: <XML -> gerendertes PDF/A, base64> | null,
 *   }
 *
 * authLevel "function" (per ?code=<KEY>, ohne M365) — wie /api/validate, /api/convert.
 */
const { app } = require('@azure/functions');
const { validateXml, istMinimalprofil } = require('../kosit');
const { validateMustang } = require('../mustang');
const { extractInvoiceXml } = require('../pdfxml');
const { validatePdfA } = require('../verapdf');
const { convertXmlToPdf, parseInvoiceData } = require('../converter');
const { detectWerkFromBuyer, detectWerkFromSeller } = require('../werk');
const { normalizeBody } = require('../httpbody');
const { pdfXmlAbgleich } = require('../pdfabgleich');

app.http('intake', {
  methods: ['GET', 'POST'],
  authLevel: 'function',
  route: 'intake',
  handler: async (request, context) => {
    if (request.method === 'GET') {
      return {
        status: 200,
        jsonBody: {
          service: 'E-Rechnung Eingangsstufe (Klassifizierung + Validierung + Werk)',
          usage: 'POST ZUGFeRD-PDF | XRechnung-XML | normales PDF (optional ?werk=<Kuerzel> '
               + 'aus dem Postfach) -> JSON { klassifizierung, richtung, zielbibliothek, werk, '
               + 'werkErkannt, werkAusVerkaeufer, werkMismatch, konform, bericht, pdfa, daten, '
               + 'xml, lesbarPdfBase64 }',
        },
      };
    }

    const raw = Buffer.from(await request.arrayBuffer());
    if (!raw.length) return problem(400, 'Leerer Request-Body. Bitte PDF oder XML senden.');

    // Body robust normalisieren (roh, base64 oder Power-Automate-{$content}-Wrapper).
    const norm = normalizeBody(raw);
    if (!norm) {
      return problem(400, 'Body ist weder ein PDF (%PDF-) noch XML (<…>) — '
        + 'auch nicht als base64 oder Power-Automate-Wrapper erkennbar.');
    }
    const buf = norm.buf;
    const isPdf = norm.isPdf;

    // Werk ist bei Eingang i. d. R. schon durch das Postfach / die E-Mail-Adresse
    // bekannt -> als ?werk=<Kuerzel> uebergeben. Dann dient die Kaeufer-Erkennung
    // nur noch als Gegenprobe (werkMismatch). Ohne Hinweis wird das Werk aus dem
    // Empfaenger abgeleitet.
    const werkHinweis = String(request.query.get('werk') || request.query.get('gesellschaft') || '')
      .toUpperCase().trim();

    const res = {
      klassifizierung: null,
      quelle: isPdf ? 'PDF' : 'XML',
      werk: werkHinweis,
      werkErkannt: '',
      werkAusVerkaeufer: '',
      werkMismatch: false,
      richtung: '',
      zielbibliothek: '',
      konform: 'ungeprueft',
      konformLabel: 'Ungeprueft',
      accepted: null,
      errorCount: 0,
      warningCount: 0,
      meldungen: [],
      meldungenText: '',
      hinweis: '',
      pruefwerkzeug: '',
      bericht: null,
      pdfa: null,
      daten: null,
      dateibasis: '',
      pdfXmlAbgleich: null,
      auslandOhneLeitweg: false,
      xml: null,
      lesbarPdfBase64: null,
    };

    // 1) Klassifizieren + XML gewinnen
    let xml = null;
    if (isPdf) {
      try { xml = await extractInvoiceXml(buf); } catch { xml = null; }
      res.klassifizierung = xml ? 'zugferd' : 'pdf-ohne-xml';
    } else {
      xml = buf.toString('utf8');
      res.klassifizierung = 'xrechnung-xml';
    }

    // 2) PDF/A-Huelle jeder eingehenden PDF pruefen (veraPDF), sofern konfiguriert.
    if (isPdf) {
      try { const p = await validatePdfA(buf); if (p) res.pdfa = p; }
      catch (e) { res.pdfa = { konform: 'ungeprueft', error: msg(e) }; }
    }

    // 3) Reine PDF ohne E-Rechnung: kein XML -> nur archivieren + kennzeichnen.
    //    Ohne strukturierte Daten ist die Richtung nicht sicher bestimmbar; ein
    //    reines Scan-PDF ist praktisch immer ein Eingang -> Default Eingang.
    if (!xml) {
      res.konformLabel = 'Ungeprueft (kein E-Rechnungs-XML)';
      res.richtung = 'Eingang';
      res.zielbibliothek = werkHinweis ? `ERAR_${werkHinweis}` : '';
      return { status: 200, jsonBody: res };
    }

    res.xml = xml;

    // 4) Validierung inkl. vollstaendigem Bericht (Archiv/GoBD).
    //    ZUGFeRD/Factur-X -> Mustang (prueft das TATSAECHLICHE Profil, EXTENDED
    //    inklusive; kein EN16931-Fehlalarm). Reine XRechnung-XML -> KoSIT.
    const zugferd = res.klassifizierung === 'zugferd';
    try {
      const v = zugferd
        ? await validateMustang(buf, { withReport: true, minimalprofil: istMinimalprofil(xml) })
        : await validateXml(xml, { withReport: true });
      res.konform = v.konform;
      res.konformLabel = v.konformLabel;
      res.accepted = v.accepted;
      res.errorCount = v.errorCount;
      res.warningCount = v.warningCount;
      res.meldungen = v.meldungen;
      res.meldungenText = v.meldungenText || '';
      res.hinweis = v.hinweis || '';
      res.bericht = v.bericht || null;
      res.pruefwerkzeug = zugferd ? 'Mustang (ZUGFeRD-Profil)' : 'KoSIT (XRechnung/EN16931)';
      if (v.berichtHtml) res.berichtHtml = v.berichtHtml;
      if (v.profilFallback) res.profilFallback = v.profilFallback;
    } catch (e) {
      context.error('Validierung fehlgeschlagen:', e);
      res.konform = 'ungeprueft';
      res.validierungsFehler = msg(e);
    }

    // 5) Kopfdaten + Werk-Gegenprobe aus dem Empfaenger.
    try {
      const d = parseInvoiceData(xml);
      res.daten = mapDaten(d);
      // Kollisions-/dublettensicherer Dateiname-Baustein: <Nummer>_<StellerVat>.
      // Zwei Lieferanten koennen dieselbe Rechnungsnummer vergeben -> erst mit der
      // Aussteller-USt-IdNr. (BT-31) wird der Schluessel eindeutig. Existiert die
      // Datei mit diesem Namen bereits in ERAR_<Werk>, ist es eine echte Dublette.
      res.dateibasis = _dateibasis(res.daten);
      res.werkErkannt = detectWerkFromBuyer(res.daten);         // kaeuferbasiert (Eingang)
      res.werkAusVerkaeufer = detectWerkFromSeller(res.daten);  // ausstellerbasiert (Ausgang)

      // Richtung: ist eine DIHAG-Gesellschaft der VERKAEUFER -> Ausgangsrechnung,
      // sonst Eingang. So landet eine WGC-Ausgangsrechnung, die im Eingangs-
      // Postfach ankommt, nicht mehr faelschlich in ERAR_<Werk>.
      res.richtung = res.werkAusVerkaeufer ? 'Ausgang' : 'Eingang';

      // Ablage-Werk + fertige Zielbibliothek (AR_<Werk> = Ausgang | ERAR_<Werk> =
      // Eingang) — der Flow schreibt damit ohne eigene Logik in die richtige Bibliothek.
      const werkAblage = res.richtung === 'Ausgang'
        ? (res.werkAusVerkaeufer || werkHinweis)
        : (werkHinweis || res.werkErkannt);
      if (werkAblage) res.werk = werkAblage;
      res.zielbibliothek = werkAblage
        ? `${res.richtung === 'Ausgang' ? 'AR' : 'ERAR'}_${werkAblage}`
        : '';

      // Gegenprobe nur fuer Eingang sinnvoll (Postfach-Werk vs. Empfaenger-Werk).
      res.werkMismatch = !!(res.richtung === 'Eingang' && werkHinweis
        && res.werkErkannt && werkHinweis !== res.werkErkannt);

      // Auslandskunde als XRechnung ohne Leitweg -> EN16931/ZUGFeRD (Factur-X)
      // waere passender. Reiner Prozesshinweis (keine Schema-Abwertung): eine
      // XRechnung an einen auslaendischen Empfaenger ohne Leitweg ist unpraktisch.
      const istXRechnung = /xrechnung/i.test(xml);
      const land = String(res.daten.empfaengerLand
        || (res.daten.empfaengerVat || '').slice(0, 2) || '').toUpperCase();
      if (istXRechnung && land && land !== 'DE' && !res.daten.leitwegid) {
        res.auslandOhneLeitweg = true;
        res.hinweis = [res.hinweis,
          `Auslandskunde (${land}) ohne Leitweg als XRechnung — EN16931/ZUGFeRD (Factur-X) waere passender.`]
          .filter(Boolean).join(' | ');
      }
    } catch (e) {
      res.datenFehler = msg(e);
    }

    // PDF↔XML-Abgleich (nur ZUGFeRD): Sichtbild gegen eingebettete XML pruefen —
    // faengt einen abweichenden Betrag/Nummer ab, den keine Schema-Pruefung sieht.
    if (res.klassifizierung === 'zugferd') {
      try {
        const ab = await pdfXmlAbgleich(buf, res.daten || {});
        res.pdfXmlAbgleich = ab;
        if (ab.status === 'abweichung') {
          // Nicht-schema-erkennbare Abweichung -> Warnung (gelb), sofern nicht schon rot.
          if (res.konform !== 'rot') {
            res.konform = 'gelb';
            res.konformLabel = 'Gelb - Warnungen';
            res.accepted = true;
          }
          res.hinweis = [res.hinweis, ab.hinweis].filter(Boolean).join(' | ');
        } else if (ab.status === 'nicht-pruefbar' && ab.hinweis) {
          res.hinweis = [res.hinweis, ab.hinweis].filter(Boolean).join(' | ');
        }
      } catch (e) {
        res.pdfXmlAbgleich = { status: 'nicht-pruefbar', pruefbar: false, fehler: msg(e), hinweis: '' };
      }
    }

    // 6) Reines XML -> lesbares PDF/A rendern ("konvertiertes PDF").
    if (res.klassifizierung === 'xrechnung-xml') {
      try {
        const { pdf } = await convertXmlToPdf(xml);
        res.lesbarPdfBase64 = Buffer.from(pdf).toString('base64');
      } catch (e) {
        res.renderFehler = msg(e);
      }
    }

    return { status: 200, jsonBody: res };
  },
});

/** Geparste Rechnungsdaten -> flaches Feld-Set fuer die SharePoint-Spalten. */
function mapDaten(d) {
  d = d || {};
  return {
    nummer:             d.rechnungsnummer   || '',
    datum:              d.rechnungsdatum    || '',
    faelligkeit:        d.faelligkeitsdatum || '',
    art:                d.rechnungsart      || '',
    syntax:             d.syntax            || '',
    steller:            d.verkaeufer        || '',
    stellerVat:         d.verkaeufervat     || '',
    empfaenger:         d.kaeufer           || '',
    empfaengerVat:      d.kaeufervat        || '',
    empfaengerOrt:      d.kaeuferstadt      || '',
    empfaengerLand:     d.kaeuferland       || '',
    leitwegid:          d.leitwegid         || '',
    bestellnummer:      d.bestellnummer     || '',
    lieferscheinnummer: d.lieferscheinnummer|| '',
    zahlungsreferenz:   d.zahlungsreferenz  || '',
    netto:              Number(d.netTotal   || 0),
    mwst:               Number(d.vatTotal   || 0),
    brutto:             Number(d.grossTotal || 0),
    waehrung:           d.waehrung          || 'EUR',
  };
}

/**
 * Dublettensicherer Dateiname-Baustein: "<Nummer>_<Lieferantenkennung>".
 * Lieferant = USt-IdNr. des Ausstellers (BT-31, weltweit eindeutig), sonst ein
 * Namens-Slug. Der Lieferant steht BEWUSST HINTEN: eine USt-IdNr. beginnt mit
 * Buchstaben, so kürzt die Monitoring-Datums-Strip-Regel (_\d{6,8}$) eine rein
 * numerische Rechnungsnummer nicht faelschlich weg. Ergebnis ist zugleich der
 * Dedup-Schluessel: gleiche Datei im ERAR_<Werk> = echte Dublette.
 */
function _dateibasis(d) {
  if (!d) return '';
  const clean = (s, max) => String(s || '')
    .replace(/[\\/:*?"<>|#%]+/g, ' ').replace(/\s+/g, ' ').trim()
    .replace(/\s/g, '_').slice(0, max);
  const nummer = clean(d.nummer, 40);
  let steller = String(d.stellerVat || '').replace(/[^A-Za-z0-9]/g, '').toUpperCase();
  if (!steller) steller = clean(d.steller, 24).replace(/[^A-Za-z0-9_]/g, '');
  return [nummer, steller].filter(Boolean).join('_');
}

function msg(e) { return e && e.message ? e.message : String(e); }

function problem(status, message) {
  return {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
    jsonBody: { error: message },
  };
}

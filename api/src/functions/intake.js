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
 *     pdfXmlAbgleich:  { status: 'ok'|'abweichung'|'nicht-pruefbar', materiell, hinweis } | null
 *                      (nur ZUGFeRD; XML bindend -> nur MATERIELLE Abweichung = Rueckfrage),
 *     buchung:         'automatik' | 'unter_vorbehalt' | 'manuell' | 'zurueckgewiesen',
 *     formatMangel:    true, wenn PDF/A-3 fehlt bzw. keine XML (sonstige Rechnung, P1/P2),
 *     manuellePruefung:true + manuellePruefungGrund bei Reverse-Charge/innergem./steuerfrei (P6),
 *     rueckfrageLieferant: true bei materieller PDF↔XML-Abweichung (P4),
 *     zurueckweisung:  { grund, text } | null (harter Stopp MINIMUM/BASIC-WL, P3),
 *     kreditorAktion:  { art:'berichtigung'|'zurueckweisung', grund, text } | null,
 *     konvertiertesPdf:true, wenn ein technisch konvertiertes Ersatz-PDF erzeugt wurde (P8),
 *     formaleHinweise: [ … ] (Leitweg/elektr. Adresse — kein USt-Pruefgrund, P5),
 *     daten:           { nummer, datum, steller, empfaenger, netto, steuerkategorie, ... } | null,
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

// Standardtext fuer die Berichtigungs-Aufforderung an den Kreditor (Punkte 1/2:
// fehlendes PDF/A-3 bzw. fehlende eingebettete XML -> "sonstige Rechnung", nicht
// ablehnen, unter Vorbehalt buchen, Berichtigung anfordern).
const TEXT_BERICHTIGUNG_FORMAT =
  'Ihre Rechnung erfuellt nicht das gesetzliche E-Rechnungs-Format (PDF/A-3 fehlerhaft '
  + 'bzw. keine eingebettete XML). Wir verarbeiten sie als sonstige Rechnung unter '
  + 'Vorbehalt; bitte uebermitteln Sie eine korrigierte E-Rechnung (XRechnung oder '
  + 'ZUGFeRD/Factur-X, Profil EN16931 oder hoeher).';

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
      // Buchungs-/Prozesssteuerung (UStAE/GoBD):
      buchung: 'automatik',        // 'automatik' | 'unter_vorbehalt' | 'manuell' | 'zurueckgewiesen'
      formatMangel: false,         // PDF/A-3 fehlt bzw. keine XML -> sonstige Rechnung (P1/P2)
      manuellePruefung: false,     // Reverse-Charge/innergem./steuerfrei -> Vier-Augen (P6)
      manuellePruefungGrund: '',
      rueckfrageLieferant: false,  // materielle PDF↔XML-Abweichung (P4)
      kreditorAktion: null,        // { art:'berichtigung'|'zurueckweisung', grund, text }
      zurueckweisung: null,        // harter Stopp MINIMUM/BASIC-WL (P3)
      konvertiertesPdf: false,     // technisch konvertiertes Ersatz-PDF erzeugt (P8)
      pdfXmlAbgleich: null,
      xml: null,
      lesbarPdfBase64: null,
    };

    // 1) Klassifizieren + XML gewinnen
    let xml = null;
    let embeddedUnsupported = false;   // eingebettete XML vorhanden, aber Fremdformat (openTRANS/BMEcat)
    if (isPdf) {
      try { xml = await extractInvoiceXml(buf); }
      catch (e) { xml = null; if (e && e.code === 'EMBEDDED_NOT_EINVOICE') embeddedUnsupported = true; }
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

    // 3) Reine PDF ohne E-Rechnung: KEIN Ablehnungsgrund (Punkt 2). Als "sonstige
    //    Rechnung" werten, unter Vorbehalt buchen, Berichtigung anfordern. Ohne
    //    strukturierte Daten ist die Richtung nicht sicher bestimmbar -> Eingang.
    if (!xml) {
      res.konformLabel = 'Sonstige Rechnung (keine E-Rechnung)';
      res.formatMangel = true;
      res.buchung = 'unter_vorbehalt';
      res.kreditorAktion = {
        art: 'berichtigung',
        grund: embeddedUnsupported ? 'fremdformat-xml' : 'keine-xml',
        text: TEXT_BERICHTIGUNG_FORMAT,
      };
      res.hinweis = embeddedUnsupported
        ? 'Eingebettete XML ist kein EN16931-Format (z. B. openTRANS/BMEcat), keine ZUGFeRD/Factur-X-'
          + 'Rechnung — als sonstige Rechnung unter Vorbehalt gebucht, Berichtigung (echte E-Rechnung) '
          + 'angefordert (UStAE 14.1 Abs. 2 / 15.2a Abs. 1a).'
        : 'Keine eingebettete E-Rechnungs-XML — als sonstige Rechnung unter '
          + 'Vorbehalt gebucht, Berichtigung angefordert (UStAE 14.1 Abs. 2 / 15.2a Abs. 1a).';
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
      if (v.formaleHinweise && v.formaleHinweise.length) res.formaleHinweise = v.formaleHinweise;

      // Punkt 3: MINIMUM/BASIC-WL = harter Stopp -> automatische Zurueckweisung.
      if (v.zurueckweisung) {
        res.zurueckweisung = v.zurueckweisung;
        res.kreditorAktion = { art: 'zurueckweisung', grund: v.zurueckweisung.grund, text: v.zurueckweisung.text };
        res.buchung = 'zurueckgewiesen';
      }
      // Punkt 1: PDF/A-3 fehlt -> KEIN Ablehnungsgrund. Sonstige Rechnung, unter
      // Vorbehalt buchen, Berichtigung anfordern (konform bleibt das XML-Urteil).
      if (v.pdfaMangel && !res.zurueckweisung) {
        res.formatMangel = true;
        if (res.buchung === 'automatik') res.buchung = 'unter_vorbehalt';
        res.kreditorAktion = res.kreditorAktion
          || { art: 'berichtigung', grund: 'kein-pdfa3', text: TEXT_BERICHTIGUNG_FORMAT };
        res.hinweis = [res.hinweis,
          'PDF/A-3 fehlt — als sonstige Rechnung unter Vorbehalt gebucht, Berichtigung angefordert.']
          .filter(Boolean).join(' | ');
      }
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

      // Punkt 6: Reverse-Charge / innergemeinschaftliche Lieferung / steuerfrei
      // (§4 Nr. 1-7) -> ZWINGEND manuelle Pruefung (Vier-Augen), keine Automatik-
      // buchung (Vorsteuerrisiko, GoBD-Kontrollverfahren). Standard-Inlandsumsatz
      // (S = 19/7 %) und "ohne USt-Ausweis" (Z) bleiben in der Automatik.
      const kat = String(res.daten.steuerkategorie || '').toUpperCase();
      if (['AE', 'K', 'G', 'E', 'O'].includes(kat)) {
        res.manuellePruefung = true;
        if (res.buchung !== 'zurueckgewiesen') res.buchung = 'manuell';
        res.manuellePruefungGrund = {
          AE: 'Reverse-Charge (§13b UStG)',
          K:  'Innergemeinschaftliche Lieferung',
          G:  'Ausfuhrlieferung (Drittland)',
          E:  'Steuerbefreit (§4 UStG)',
          O:  'Nicht steuerbar',
        }[kat] || 'Steuerbefreiung/Sonderfall';
        res.hinweis = [res.hinweis, `${res.manuellePruefungGrund} — manuelle Pruefung (Vier-Augen) erforderlich.`]
          .filter(Boolean).join(' | ');
      }
    } catch (e) {
      res.datenFehler = msg(e);
    }

    // Punkt 4: PDF↔XML-Abgleich (nur ZUGFeRD). Die XML ist umsatzsteuerlich bindend
    // (UStAE 14.4 Abs. 3) -> NICHT abwerten, immer aus der XML buchen. Nur bei
    // MATERIELLER Abweichung (Steuerbetrag/Belegidentitaet, rundungstolerant)
    // automatische Rueckfrage an den Lieferanten anstossen.
    if (res.klassifizierung === 'zugferd') {
      try {
        const ab = await pdfXmlAbgleich(buf, res.daten || {});
        res.pdfXmlAbgleich = ab;
        if (ab.status === 'abweichung' && ab.materiell) {
          res.rueckfrageLieferant = true;
          res.hinweis = [res.hinweis, ab.hinweis].filter(Boolean).join(' | ');
        } else if (ab.status === 'nicht-pruefbar' && ab.hinweis) {
          res.hinweis = [res.hinweis, ab.hinweis].filter(Boolean).join(' | ');
        }
      } catch (e) {
        res.pdfXmlAbgleich = { status: 'nicht-pruefbar', pruefbar: false, materiell: false, fehler: msg(e), hinweis: '' };
      }
    }

    // 6) Lesbares/technisch konvertiertes PDF/A rendern (Punkt 8):
    //    - reine XRechnung-XML: immer (es gibt kein lesbares Original)
    //    - ZUGFeRD mit PDF/A-3-Mangel: Ersatz-PDF aus der XML erzeugen. Das Original
    //      bleibt ZUSAETZLICH erhalten (der Flow ersetzt es NICHT); das Ersatz-PDF
    //      wird als "technisch konvertiert" gekennzeichnet (GoBD Rz. 135).
    if (res.klassifizierung === 'xrechnung-xml' || res.formatMangel) {
      try {
        const { pdf } = await convertXmlToPdf(xml);
        res.lesbarPdfBase64 = Buffer.from(pdf).toString('base64');
        res.konvertiertesPdf = true;
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
    steuerkategorie:    d.steuerkategorie   || '',   // UNTDID 5305 (S/Z/AE/K/G/E/O) -> Punkt 6
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

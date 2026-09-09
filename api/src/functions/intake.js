'use strict';
/**
 * HTTP-Trigger: Eingangsrechnung -> Klassifizierung + Validierung + Werk + Daten
 * ============================================================================
 *   GET  /api/intake  -> JSON-Info (Health)
 *   POST /api/intake  -> Body = ZUGFeRD-PDF | XRechnung-XML | normales PDF
 *                        Antwort = JSON-Umschlag (siehe unten)
 *
 * ZWECK: zentrale Eingangsstufe ("Monitoring"). Eine Datei rein, ein JSON raus,
 * das Power Automate alles liefert, um die Rechnung geprueft in die richtige
 * Werk-Bibliothek ERAR_<Werk> einzusortieren.
 *
 * Antwort:
 *   {
 *     klassifizierung: 'zugferd' | 'xrechnung-xml' | 'pdf-ohne-xml',
 *     quelle:          'PDF' | 'XML',
 *     werk:            'WGC' | 'SHB' | '' (aus dem RechnungsEMPFÄNGER erkannt),
 *     konform:         'gruen'|'gelb'|'rot'|'ungeprueft',
 *     konformLabel, accepted, errorCount, warningCount, meldungen[],
 *     bericht:         <roher KoSIT-Pruefbericht als String>  (Archiv/GoBD),
 *     berichtHtml?:    <HTML-Darstellung, falls eingebettet>,
 *     pdfa:            { konform, ... } | null  (veraPDF, nur bei PDF-Eingang),
 *     daten:           { nummer, datum, steller, empfaenger, netto, ... } | null,
 *     xml:             <extrahierte/empfangene E-Rechnungs-XML> | null,
 *     lesbarPdfBase64: <XML -> gerendertes PDF/A, base64> | null,
 *   }
 *
 * authLevel "function" (per ?code=<KEY>, ohne M365) — wie /api/validate, /api/convert.
 */
const { app } = require('@azure/functions');
const { validateXml } = require('../kosit');
const { extractInvoiceXml } = require('../pdfxml');
const { validatePdfA } = require('../verapdf');
const { convertXmlToPdf, parseInvoiceData } = require('../converter');
const { detectWerkFromBuyer } = require('../werk');

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
          usage: 'POST ZUGFeRD-PDF | XRechnung-XML | normales PDF -> JSON '
               + '{ klassifizierung, werk, konform, bericht, pdfa, daten, xml, lesbarPdfBase64 }',
        },
      };
    }

    const buf = Buffer.from(await request.arrayBuffer());
    if (!buf.length) return problem(400, 'Leerer Request-Body. Bitte PDF oder XML senden.');

    const head = buf.subarray(0, 1024).toString('latin1');
    const isPdf = head.includes('%PDF-');

    const res = {
      klassifizierung: null,
      quelle: isPdf ? 'PDF' : 'XML',
      werk: '',
      konform: 'ungeprueft',
      konformLabel: 'Ungeprueft',
      accepted: null,
      errorCount: 0,
      warningCount: 0,
      meldungen: [],
      bericht: null,
      pdfa: null,
      daten: null,
      xml: null,
      lesbarPdfBase64: null,
    };

    // 1) Klassifizieren + XML gewinnen
    let xml = null;
    if (isPdf) {
      try { xml = await extractInvoiceXml(buf); } catch { xml = null; }
      res.klassifizierung = xml ? 'zugferd' : 'pdf-ohne-xml';
    } else {
      const s = buf.toString('utf8');
      if (!s.trimStart().startsWith('<')) {
        return problem(400, 'Body ist weder ein PDF (%PDF-) noch XML (<...>).');
      }
      xml = s;
      res.klassifizierung = 'xrechnung-xml';
    }

    // 2) PDF/A-Huelle jeder eingehenden PDF pruefen (veraPDF), sofern konfiguriert.
    if (isPdf) {
      try { const p = await validatePdfA(buf); if (p) res.pdfa = p; }
      catch (e) { res.pdfa = { konform: 'ungeprueft', error: msg(e) }; }
    }

    // 3) Reine PDF ohne E-Rechnung: kein XML -> nur archivieren + kennzeichnen.
    if (!xml) {
      res.konformLabel = 'Ungeprueft (kein E-Rechnungs-XML)';
      return { status: 200, jsonBody: res };
    }

    res.xml = xml;

    // 4) KoSIT-Validierung inkl. vollstaendigem Bericht (Archiv/GoBD).
    try {
      const v = await validateXml(xml, { withReport: true });
      res.konform = v.konform;
      res.konformLabel = v.konformLabel;
      res.accepted = v.accepted;
      res.errorCount = v.errorCount;
      res.warningCount = v.warningCount;
      res.meldungen = v.meldungen;
      res.bericht = v.bericht || null;
      if (v.berichtHtml) res.berichtHtml = v.berichtHtml;
    } catch (e) {
      context.error('KoSIT-Validierung fehlgeschlagen:', e);
      res.konform = 'ungeprueft';
      res.validierungsFehler = msg(e);
    }

    // 5) Kopfdaten + Werk aus dem Empfaenger.
    try {
      const d = parseInvoiceData(xml);
      res.daten = mapDaten(d);
      res.werk = detectWerkFromBuyer(res.daten);
    } catch (e) {
      res.datenFehler = msg(e);
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

function msg(e) { return e && e.message ? e.message : String(e); }

function problem(status, message) {
  return {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
    jsonBody: { error: message },
  };
}

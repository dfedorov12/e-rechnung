'use strict';
/**
 * HTTP-Trigger: E-Rechnungs-XML -> KoSIT-Validierung (JSON-Verdikt)
 * ================================================================
 *   GET  /api/validate  -> JSON-Info (Health / Daemon-URL)
 *   POST /api/validate  -> Body = XML (XRechnung/CII/UBL)
 *                          Antwort = JSON { konform, konformLabel, accepted,
 *                                           errorCount, warningCount, meldungen }
 *
 * Ruft intern den KoSIT-Daemon (kosit-service/) auf. authLevel "function"
 * (per Key erreichbar, ohne M365) — genau wie /api/convert.
 * Aus Power Automate: HTTP POST -> Ergebnis in die SharePoint-Spalte
 * "Konformitaet" (konformLabel) und "ValidierungsMeldung" schreiben.
 */
const { app } = require('@azure/functions');
const { validateXml, KOSIT_DAEMON_URL } = require('../kosit');
const { extractInvoiceXml } = require('../pdfxml');

app.http('validate', {
  methods: ['GET', 'POST'],
  authLevel: 'function',
  route: 'validate',
  handler: async (request, context) => {
    if (request.method === 'GET') {
      return {
        status: 200,
        jsonBody: {
          service: 'E-Rechnung KoSIT-Validierung',
          daemon: KOSIT_DAEMON_URL,
          usage: 'POST XML (XRechnung/CII/UBL) ODER ZUGFeRD/Factur-X-PDF -> { konform: gruen|gelb|rot, konformLabel, accepted, meldungen[] }',
        },
      };
    }

    // Body als Bytes lesen (XML oder ZUGFeRD-PDF). PDF -> eingebettete XML ziehen.
    const buf = Buffer.from(await request.arrayBuffer());
    const head = buf.subarray(0, 1024).toString('latin1');
    const isPdf = head.includes('%PDF-');

    let xml;
    if (isPdf) {
      try {
        xml = await extractInvoiceXml(buf);
      } catch (err) {
        return problem(400, 'ZUGFeRD-PDF ohne lesbare E-Rechnungs-XML: '
          + (err && err.message ? err.message : String(err)));
      }
    } else {
      xml = buf.toString('utf8');
      if (!xml.trimStart().startsWith('<')) {
        return problem(400, 'Bitte die E-Rechnungs-XML oder ein ZUGFeRD-PDF als Request-Body senden.');
      }
    }

    try {
      const result = await validateXml(xml);
      result.quelle = isPdf ? 'ZUGFeRD-PDF' : 'XML';
      return { status: 200, jsonBody: result };
    } catch (err) {
      context.error('KoSIT-Validierung fehlgeschlagen:', err);
      return problem(502, 'KoSIT-Validierung fehlgeschlagen: ' + (err && err.message ? err.message : String(err)));
    }
  },
});

function problem(status, message) {
  return {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
    jsonBody: { error: message },
  };
}

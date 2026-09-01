'use strict';
/**
 * HTTP-Trigger: E-Rechnungs-XML -> PDF
 * ====================================
 *   GET  /api/convert   -> JSON-Info (Health-Check / Erreichbarkeitstest)
 *   POST /api/convert   -> Body = XML (CII/UBL), Antwort = application/pdf
 *
 * authLevel "anonymous": ohne M365-Anmeldung erreichbar (fuer Power Automate).
 * Fuer einen einfachen Schutz auf "function" umstellen (siehe README).
 */
const { app } = require('@azure/functions');
const { convertXmlToPdf, healthInfo } = require('../converter');

app.http('convert', {
  methods: ['GET', 'POST'],
  authLevel: 'anonymous',
  route: 'convert',
  handler: async (request, context) => {
    if (request.method === 'GET') {
      return { status: 200, jsonBody: healthInfo() };
    }

    const raw = await request.text();
    const trimmed = (raw || '').trimStart(); // trimStart() entfernt auch ein fuehrendes BOM (U+FEFF)
    if (!trimmed) {
      return problem(400, 'Leerer Request-Body. Bitte die E-Rechnungs-XML als Body senden.');
    }
    if (!trimmed.startsWith('<')) {
      return problem(400, 'Der Body ist keine XML. Bitte die E-Rechnung als XML (CII oder UBL) senden.');
    }

    let result;
    try {
      result = await convertXmlToPdf(raw);
    } catch (err) {
      context.error('Konvertierung fehlgeschlagen:', err);
      return problem(400, 'Konvertierung fehlgeschlagen: ' + (err && err.message ? err.message : String(err)));
    }

    const { data, pdf } = result;
    const nr = String(data.rechnungsnummer || 'rechnung').replace(/[^\w.\-]+/g, '_') || 'rechnung';

    return {
      status: 200,
      headers: {
        'Content-Type': 'application/pdf',
        'Content-Disposition': `attachment; filename="${nr}.pdf"`,
        'X-Invoice-Number': encodeURIComponent(String(data.rechnungsnummer || '')),
        'X-Invoice-Syntax': String(data.syntax || ''),
        'X-Invoice-Positions': String((data.positionen || []).length),
      },
      body: Buffer.from(pdf),
    };
  },
});

function problem(status, message) {
  return {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
    jsonBody: { error: message },
  };
}

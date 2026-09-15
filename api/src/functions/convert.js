'use strict';
/**
 * HTTP-Trigger: E-Rechnungs-XML -> PDF
 * ====================================
 *   GET  /api/convert   -> JSON-Info (Health-Check / Erreichbarkeitstest)
 *   POST /api/convert   -> Body = XML (CII/UBL), Antwort = application/pdf
 *
 * authLevel "function": per Function-Key erreichbar (ohne M365), fuer Power Automate.
 * Der Key gehoert NICHT in den Code — in Power Automate als ?code=<KEY> anhaengen.
 * Antwort: application/pdf (PDF/A-3b, Schrift eingebettet).
 */
const { app } = require('@azure/functions');
const { convertXmlToPdf, healthInfo } = require('../converter');
const { normalizeBody } = require('../httpbody');
const { extractInvoiceXml } = require('../pdfxml');

app.http('convert', {
  methods: ['GET', 'POST'],
  authLevel: 'function',
  route: 'convert',
  handler: async (request, context) => {
    if (request.method === 'GET') {
      return { status: 200, jsonBody: healthInfo() };
    }

    // Body robust normalisieren (rohe XML, base64, Power-Automate-{$content}-Wrapper
    // ODER ein ZUGFeRD-PDF) — analog /api/intake und /api/validate.
    const raw = Buffer.from(await request.arrayBuffer());
    const norm = normalizeBody(raw);
    if (!norm) {
      return problem(400, 'Leerer/ungueltiger Body. Bitte die E-Rechnungs-XML senden '
        + '(auch base64 / Power-Automate-Wrapper), oder ein ZUGFeRD-PDF.');
    }

    let xml;
    if (norm.isPdf) {
      // ZUGFeRD/Factur-X: eingebettete XML herausziehen und daraus das lesbare PDF rendern.
      try {
        xml = await extractInvoiceXml(norm.buf);
      } catch (err) {
        return problem(400, 'ZUGFeRD-PDF ohne lesbare E-Rechnungs-XML: '
          + (err && err.message ? err.message : String(err)));
      }
    } else {
      xml = norm.buf.toString('utf8');
    }

    const trimmed = xml.replace(/^﻿/, '').trimStart(); // fuehrendes BOM entfernen
    if (!trimmed.startsWith('<')) {
      return problem(400, 'Der Body ist keine XML. Bitte die E-Rechnung als XML (CII oder UBL) senden.');
    }

    let result;
    try {
      result = await convertXmlToPdf(xml);
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

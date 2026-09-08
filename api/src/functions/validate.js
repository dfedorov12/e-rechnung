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
          usage: 'POST XML (XRechnung/CII/UBL) -> { konform: gruen|gelb|rot, konformLabel, accepted, meldungen[] }',
        },
      };
    }

    const raw = await request.text();
    const trimmed = (raw || '').trimStart(); // entfernt auch fuehrendes BOM
    if (!trimmed || !trimmed.startsWith('<')) {
      return problem(400, 'Bitte die E-Rechnungs-XML als Request-Body senden.');
    }

    try {
      const result = await validateXml(raw);
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

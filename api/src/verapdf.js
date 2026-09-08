'use strict';
/**
 * Client zum veraPDF-Dienst (PDF/A-3b-Pruefung).
 * Der Dienst laeuft als eigener Container (verapdf-service/); seine URL kommt
 * aus der App-Einstellung VERAPDF_URL. Ist sie nicht gesetzt, wird PDF/A
 * uebersprungen (null) statt zu scheitern.
 */
const VERAPDF_URL = process.env.VERAPDF_URL || '';

async function validatePdfA(pdfBuffer) {
  if (!VERAPDF_URL) return null; // nicht konfiguriert -> kein PDF/A-Check
  const resp = await fetch(VERAPDF_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/pdf' },
    body: pdfBuffer,
  });
  const text = await resp.text();
  if (!resp.ok) {
    throw new Error(`veraPDF-Dienst HTTP ${resp.status}: ${text.slice(0, 200)}`);
  }
  try {
    return JSON.parse(text);
  } catch (e) {
    throw new Error('veraPDF-Antwort war kein JSON.');
  }
}

module.exports = { validatePdfA, VERAPDF_URL };

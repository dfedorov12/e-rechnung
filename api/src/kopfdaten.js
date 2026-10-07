'use strict';
/**
 * Kopfdaten einer sonstigen Rechnung aus dem PDF-Text
 * ===================================================
 * Eine PDF ohne E-Rechnungs-XML bringt keine strukturierten Daten mit. Den
 * Lieferanten, seine USt-IdNr., Rechnungsnummer, Datum und Bruttobetrag
 * liest js/lieferant.js trotzdem meist sicher aus dem Text (dieselbe Logik
 * wie im Monitoring). Das Ergebnis ist ein Vorschlag: es steuert keine
 * Buchung, es füllt nur die Spalten, die sonst leer blieben.
 *
 * Scans ohne Textebene liefern null.
 */
const path = require('path');
const pdfParse = require('pdf-parse');

let lieferantAusText = null;
try {
  ({ lieferantAusText } = require(path.join(__dirname, '..', 'vendor', 'lieferant.js')));
} catch (e) { /* vendor nicht synchronisiert: dann ohne Kopfdaten */ }

/**
 * @param {Buffer} pdfBuf
 * @returns {Promise<null|{nummer, datum, steller, stellerVat, brutto, kleinunternehmer}>}
 */
async function kopfdatenAusPdf(pdfBuf) {
  if (!lieferantAusText) return null;
  let text = '';
  try { text = String((await pdfParse(pdfBuf)).text || ''); }
  catch (e) { return null; }
  const l = lieferantAusText(text);
  if (!l.lesbar || (!l.name && !l.vat && !l.nummer)) return null;
  return {
    nummer: l.nummer || null,
    datum: l.datum || null,
    steller: l.name || null,
    stellerVat: l.vat || null,
    brutto: l.brutto == null ? null : l.brutto,
    kleinunternehmer: !!l.kleinunternehmer,
  };
}

module.exports = { kopfdatenAusPdf };

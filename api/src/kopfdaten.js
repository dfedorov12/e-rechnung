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
 * Den Text holt pdf.js 3.11.174, dieselbe Version wie im Browser, damit
 * Prüfdienst und Monitoring dieselben Zeilen sehen. pdf-parse (älteres pdf.js)
 * scheitert an manchen PDFs, etwa solchen aus pdf-lib, und ist nur Rückfall.
 *
 * Scans ohne Textebene liefern null.
 */
const path = require('path');
const pdfParse = require('pdf-parse');

let lieferant = null;
try { lieferant = require(path.join(__dirname, '..', 'vendor', 'lieferant.js')); }
catch (e) { /* vendor nicht synchronisiert: dann ohne Kopfdaten */ }

let pdfjs = null;
try { pdfjs = require('pdfjs-dist/legacy/build/pdf.js'); }
catch (e) { /* ohne pdfjs-dist nur pdf-parse */ }

async function _text(pdfBuf) {
  if (pdfjs && lieferant && lieferant.textAusPdf) {
    globalThis.pdfjsLib = pdfjs;
    try {
      return await lieferant.textAusPdf(pdfBuf, { verbosity: 0, isEvalSupported: false, disableFontFace: true, useSystemFonts: false });
    } catch (e) { /* weiter mit pdf-parse */ }
  }
  return String((await pdfParse(pdfBuf)).text || '');
}

/**
 * @param {Buffer} pdfBuf
 * @returns {Promise<null|{nummer, datum, steller, stellerVat, brutto, kleinunternehmer}>}
 */
async function kopfdatenAusPdf(pdfBuf) {
  if (!lieferant) return null;
  let text = '';
  try { text = await _text(pdfBuf); }
  catch (e) { return null; }
  const l = lieferant.lieferantAusText(text);
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

'use strict';
/**
 * Text eines PDFs lesen (Prüfdienst)
 * ==================================
 * Erste Wahl ist pdf.js 3.11.174, dieselbe Version wie im Browser
 * (js/vendor/pdf.min.js). Die Zeilen baut textAusPdf aus js/lieferant.js,
 * damit Prüfdienst und Monitoring denselben Text sehen.
 *
 * pdf-parse (älteres pdf.js) ist nur Rückfall: Es scheitert im Azure-Kontext
 * an PDFs mit komprimierter Querverweistabelle, etwa aus pdf-lib, mit
 * „Invalid PDF structure".
 */
const path = require('path');
const pdfParse = require('pdf-parse');

let lieferant = null;
try { lieferant = require(path.join(__dirname, '..', 'vendor', 'lieferant.js')); }
catch (e) { /* vendor nicht synchronisiert */ }

let pdfjs = null;
try { pdfjs = require('pdfjs-dist/legacy/build/pdf.js'); }
catch (e) { /* ohne pdfjs-dist nur pdf-parse */ }

const OPTIONEN = { verbosity: 0, isEvalSupported: false, disableFontFace: true, useSystemFonts: false };

/**
 * @param {Buffer} pdfBuf   bleibt unverändert (pdf.js bekommt eine Kopie)
 * @returns {Promise<{text: string, quelle: 'pdfjs'|'pdf-parse'}>}  wirft, wenn beide scheitern
 */
async function pdfText(pdfBuf) {
  if (pdfjs && lieferant && lieferant.textAusPdf) {
    globalThis.pdfjsLib = pdfjs;
    try {
      return { text: await lieferant.textAusPdf(pdfBuf, OPTIONEN), quelle: 'pdfjs' };
    } catch (e) { /* weiter mit pdf-parse */ }
  }
  return { text: String((await pdfParse(pdfBuf)).text || ''), quelle: 'pdf-parse' };
}

module.exports = { pdfText };

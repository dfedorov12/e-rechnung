'use strict';
/**
 * Serverseitiger Adapter fuer die Browser-Konverter-Module
 * ========================================================
 * Laedt die im Browser genutzten Module unveraendert in Node:
 *   - vendor/xmlinvoice.js  -> parseInvoiceXML(xmlString)  (nutzt DOMParser)
 *   - vendor/xml2pdf.js     -> buildInvoicePdf(data)       (nutzt PDFLib)
 *
 * WICHTIG: Die Module werden per `new Function(...)` im HOST-Realm ausgefuehrt
 * (NICHT in einer vm-Sandbox). Grund: `xml2pdf.js` erzeugt Arrays
 * (`doc.addPage([w, h])`), die pdf-lib per `instanceof Array` prueft. In einer
 * vm-Sandbox haben solche Arrays einen anderen Realm -> die Pruefung schlaegt
 * fehl ("page must be of type ... but was ..."). Im Host-Realm passt alles.
 *
 * Single Source of Truth: `scripts/sync.js` kopiert die beiden Live-Dateien aus
 * ../js nach ./vendor. Diese Datei liest ausschliesslich aus ./vendor, damit das
 * deploybare Paket in sich geschlossen ist.
 */
const fs = require('fs');
const path = require('path');
const PDFLib = require('pdf-lib');
const xmldom = require('@xmldom/xmldom');

const VENDOR_DIR = path.join(__dirname, '..', 'vendor');
const fontkit = require('@pdf-lib/fontkit');
let EMBED_FONTS = null;
try { EMBED_FONTS = require(path.join(VENDOR_DIR, 'font-embed.js')); } catch (e) { /* Fallback: Standard-Helvetica */ }

/** DOMParser-Ersatz fuer Node: xmldom mit strengem Fehler-Handler. */
class NodeDOMParser {
  parseFromString(str, type) {
    return new xmldom.DOMParser({
      errorHandler: {
        warning() {},
        error() {},
        fatalError(msg) { throw new Error('XML ungueltig: ' + msg); },
      },
    }).parseFromString(str, type || 'application/xml');
  }
}

/**
 * Liest eine vendor-Datei und fuehrt sie im Host-Realm aus. Gibt die
 * gewuenschten Top-Level-Funktionen als Objekt zurueck.
 */
function compile(file, wanted) {
  const full = path.join(VENDOR_DIR, file);
  if (!fs.existsSync(full)) {
    throw new Error(`Konverter-Modul fehlt: vendor/${file}. Bitte "npm run sync" ausfuehren.`);
  }
  const source = fs.readFileSync(full, 'utf8');
  const returns = wanted
    .map(n => `${n}: (typeof ${n} === 'function') ? ${n} : undefined`)
    .join(', ');
  // eslint-disable-next-line no-new-func
  const factory = new Function('PDFLib', 'fontkit', 'EMBED_FONTS', 'DOMParser', 'TextEncoder', 'atob', 'console',
    `${source}\n;return { ${returns} };`);
  return factory(PDFLib, fontkit, EMBED_FONTS, NodeDOMParser, globalThis.TextEncoder, globalThis.atob, console);
}

let _mods = null;
function modules() {
  if (_mods) return _mods;
  const a = compile('xmlinvoice.js', ['parseInvoiceXML']);
  const b = compile('xml2pdf.js', ['buildInvoicePdf']);
  const c = compile('zugferd.js', ['makeReadablePdfA3']);
  if (typeof a.parseInvoiceXML !== 'function' || typeof b.buildInvoicePdf !== 'function') {
    throw new Error('Konverter-Module (vendor/) konnten nicht geladen werden.');
  }
  _mods = {
    parseInvoiceXML: a.parseInvoiceXML,
    buildInvoicePdf: b.buildInvoicePdf,
    makeReadablePdfA3: c.makeReadablePdfA3,
  };
  return _mods;
}

/**
 * XML-String -> { data, pdf }.
 * @param   {string} xmlString  E-Rechnungs-XML (CII oder UBL)
 * @returns {Promise<{ data: object, pdf: Uint8Array }>}
 */
async function convertXmlToPdf(xmlString) {
  const { parseInvoiceXML, buildInvoicePdf, makeReadablePdfA3 } = modules();
  const data = parseInvoiceXML(xmlString);
  let pdf = await buildInvoicePdf(data);
  // PDF/A-3b: Schrift ist via fontkit eingebettet; hier OutputIntent/XMP/Trailer-ID ergaenzen.
  if (typeof makeReadablePdfA3 === 'function') {
    try { pdf = await makeReadablePdfA3(pdf); }
    catch (e) { console.warn('PDF/A-Finalisierung uebersprungen:', e.message); }
  }
  return { data, pdf };
}

/** Kleine Info-Antwort fuer GET (Health-Check / Erreichbarkeitstest). */
function healthInfo() {
  return {
    service: 'DIHAG E-Rechnung - XML zu PDF Konverter',
    status: 'ok',
    usage: {
      method: 'POST',
      contentType: 'application/xml',
      body: 'E-Rechnungs-XML (XRechnung / ZUGFeRD, Syntax CII oder UBL)',
      response: 'application/pdf',
    },
  };
}

module.exports = { convertXmlToPdf, healthInfo };

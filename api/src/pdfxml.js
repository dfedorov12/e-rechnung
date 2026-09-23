'use strict';
/**
 * Eingebettete E-Rechnungs-XML aus einem ZUGFeRD/Factur-X-PDF ziehen.
 * ==================================================================
 * ZUGFeRD/Factur-X hängt die XML als Datei-Anhang ans PDF (PDF /Names ->
 * /EmbeddedFiles). Die App bettet sie via pdf-lib attach() als "factur-x.xml"
 * bzw. "xrechnung.xml" ein (js/zugferd.js). Hier holen wir sie wieder heraus,
 * damit /api/validate auch ZUGFeRD-PDFs an KoSIT geben kann.
 */
const { PDFDocument, PDFName, PDFDict, PDFArray } = require('pdf-lib');
const zlib = require('zlib');

async function extractInvoiceXml(pdfBytes) {
  const doc = await PDFDocument.load(pdfBytes, {
    throwOnInvalidObject: false,
    updateMetadata: false,
    ignoreEncryption: true,
  });

  const specs = _collectEmbeddedFiles(doc);
  if (!specs.length) {
    throw new Error('Keine eingebettete Datei gefunden (kein ZUGFeRD/Factur-X-PDF?).');
  }

  // Kandidaten in sinnvoller Reihenfolge pruefen: bekannte Namen zuerst, dann jede .xml.
  const ordered = [
    ...specs.filter(s => /(factur-x|zugferd|xrechnung|cii|ubl|order-x|invoice)\.xml$/i.test(s.name)),
    ...specs.filter(s => /\.xml$/i.test(s.name)),
    ...specs,
  ];

  // WICHTIG: Nur eine echte EN16931-E-Rechnung (CII = ZUGFeRD/Factur-X, oder UBL)
  // gilt als E-Rechnung. Andere eingebettete XML (z. B. openTRANS/BMEcat, ein
  // beliebiger Beleg-Anhang) ist KEINE ZUGFeRD-Rechnung -> wird nicht als solche
  // ausgegeben, damit die PDF sauber als "sonstige Rechnung" (pdf-ohne-xml) laeuft,
  // statt faelschlich durch die ZUGFeRD-Pruefung mit Profilfehler rot zu werden.
  const seen = new Set();
  let fallback = null;
  for (const s of ordered) {
    if (seen.has(s.stream)) continue;
    seen.add(s.stream);
    const text = _streamText(s.stream);
    if (!text || !text.trimStart().startsWith('<')) continue;
    if (detectEInvoiceSyntax(text)) return text;          // echte E-Rechnung
    if (!fallback) fallback = { name: s.name, text };
  }
  if (fallback) {
    const err = new Error(`Eingebettete Datei "${fallback.name}" ist kein EN16931-Format `
      + '(z. B. openTRANS/BMEcat) — keine ZUGFeRD/Factur-X-E-Rechnung.');
    err.code = 'EMBEDDED_NOT_EINVOICE';
    throw err;
  }
  throw new Error('Eingebettete Datei ist keine XML.');
}

/**
 * Erkennt, ob ein XML-Text eine EN16931-E-Rechnung ist.
 * @returns {'CII'|'UBL'|null}  CII = ZUGFeRD/Factur-X/XRechnung-CII, UBL = XRechnung-UBL
 */
function detectEInvoiceSyntax(text) {
  if (!text) return null;
  const head = text.slice(0, 4000);
  if (/CrossIndustryInvoice|CrossIndustryDocument|uncefact:data:standard:CrossIndustry/i.test(head)) return 'CII';
  if (/oasis:names:specification:ubl:schema:xsd:(Invoice|CreditNote)-2/i.test(head)) return 'UBL';
  return null;
}

/** Stream dekodieren + als UTF-8 lesen (BOM entfernen). */
function _streamText(stream) {
  const bytes = _decodeStream(stream);
  let text = Buffer.from(bytes).toString('utf8');
  if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1); // BOM
  return text;
}

/* ── PDF-Namensbaum /Names -> /EmbeddedFiles auslesen ──────────────────── */

function _collectEmbeddedFiles(doc) {
  const ctx = doc.context;
  const namesDict = doc.catalog.lookupMaybe(PDFName.of('Names'), PDFDict);
  if (!namesDict) return [];
  const efTree = namesDict.lookupMaybe(PDFName.of('EmbeddedFiles'), PDFDict);
  if (!efTree) return [];
  const out = [];
  _walkNameTree(ctx, efTree, out);
  return out;
}

function _walkNameTree(ctx, node, out, depth) {
  if ((depth || 0) > 32) return; // Schutz gegen Zyklen
  const names = node.lookupMaybe(PDFName.of('Names'), PDFArray);
  if (names) {
    for (let i = 0; i + 1 < names.size(); i += 2) {
      const nameObj = names.lookup(i);
      const spec = names.lookup(i + 1, PDFDict);
      if (!spec) continue;
      const efDict = spec.lookupMaybe(PDFName.of('EF'), PDFDict);
      if (!efDict) continue;
      const streamRef = efDict.get(PDFName.of('F')) || efDict.get(PDFName.of('UF'));
      const stream = streamRef ? ctx.lookup(streamRef) : null;
      if (!stream || !stream.contents) continue;
      out.push({ name: _textOf(nameObj), stream });
    }
  }
  const kids = node.lookupMaybe(PDFName.of('Kids'), PDFArray);
  if (kids) {
    for (let i = 0; i < kids.size(); i++) {
      const kid = kids.lookup(i, PDFDict);
      if (kid) _walkNameTree(ctx, kid, out, (depth || 0) + 1);
    }
  }
}

function _textOf(obj) {
  if (!obj) return '';
  try {
    if (typeof obj.decodeText === 'function') return obj.decodeText();
    if (typeof obj.asString === 'function') return obj.asString();
  } catch (e) { /* ignore */ }
  return String(obj);
}

function _decodeStream(stream) {
  const raw = Buffer.from(stream.contents || []);
  const filter = stream.dict ? stream.dict.get(PDFName.of('Filter')) : null;
  const isFlate = filter ? /FlateDecode/.test(filter.toString()) : false;
  if (!isFlate) return raw;
  try { return zlib.inflateSync(raw); }
  catch (e) {
    try { return zlib.inflateRawSync(raw); }
    catch (e2) { return raw; }
  }
}

module.exports = { extractInvoiceXml, detectEInvoiceSyntax };

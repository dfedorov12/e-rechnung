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

  // Bevorzugt bekannte E-Rechnungs-Anhänge, sonst irgendeine .xml, sonst die erste.
  const pick =
    specs.find(s => /(factur-x|zugferd|xrechnung|cii|order-x|invoice)\.xml$/i.test(s.name)) ||
    specs.find(s => /\.xml$/i.test(s.name)) ||
    specs[0];

  const bytes = _decodeStream(pick.stream);
  const text = Buffer.from(bytes).toString('utf8').replace(/^﻿/, '');
  if (!text.trimStart().startsWith('<')) {
    throw new Error(`Eingebettete Datei "${pick.name}" ist keine XML.`);
  }
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

module.exports = { extractInvoiceXml };

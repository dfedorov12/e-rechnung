/**
 * OCR-Texterkennung für gescannte PDFs (Tesseract.js, lokal gehostet)
 * ===================================================================
 * Gescannte Rechnungen (Bild-PDFs ohne Textebene) werden Seite für Seite
 * zu einem Canvas gerendert und per Tesseract erkannt. Das Ergebnis wird
 * in dieselbe Item-Form gebracht wie die PDF.js-Textebene
 * ({ text, x, y, pw, ph, w, page }) und kann so durch denselben Parser
 * (extractInvoiceDataFromItems) laufen.
 */

const OCR = {
  lang:  'deu',
  // ~200 dpi: verifizierte Auflösung für vollständige Positions- und
  // Datumserkennung. Niedriger (144/180 dpi) verliert Datum bzw. Zuschlagszeilen.
  scale: 2.78,
  // Absolute URLs (vom Worker-Kontext aus korrekt auflösbar)
  base:  new URL('js/vendor/tesseract/', document.baseURI).href,
};

/**
 * Rendert alle Seiten, erkennt Text und liefert positionierte Items.
 * @param {PDFDocumentProxy} pdfDoc
 * @param {(p:{page:number,total:number,status:string,progress:number})=>void} onProgress
 * @returns {Promise<Array<{text,x,y,pw,ph,w,page}>>}
 */
async function ocrCollectItems(pdfDoc, onProgress) {
  if (typeof Tesseract === 'undefined') {
    throw new Error('Tesseract.js nicht geladen');
  }

  const total = pdfDoc.numPages;
  let curPage = 1;

  const worker = await Tesseract.createWorker(OCR.lang, 1, {
    workerPath: OCR.base + 'worker.min.js',
    corePath:   OCR.base + 'tesseract-core-simd-lstm.wasm.js',
    langPath:   OCR.base + 'lang',
    gzip:       false,   // lokale deu.traineddata ist unkomprimiert
    logger: m => {
      if (onProgress && m.status) {
        onProgress({ page: curPage, total, status: m.status, progress: m.progress || 0 });
      }
    },
  });

  const allItems = [];
  try {
    for (let p = 1; p <= total; p++) {
      curPage = p;
      const canvas = await _renderPageToCanvas(pdfDoc, p, OCR.scale);
      const { data } = await worker.recognize(canvas, {}, { tsv: true });
      allItems.push(..._tsvToItems(data.tsv, p, canvas.width, canvas.height, OCR.scale));
    }
  } finally {
    await worker.terminate();
  }
  return allItems;
}

/** Seite zu einem Offscreen-Canvas rendern. */
async function _renderPageToCanvas(pdfDoc, pageNum, scale) {
  const page   = await pdfDoc.getPage(pageNum);
  const vp     = page.getViewport({ scale });
  const canvas = document.createElement('canvas');
  canvas.width  = Math.ceil(vp.width);
  canvas.height = Math.ceil(vp.height);
  const ctx = canvas.getContext('2d');
  // Weißer Hintergrund (verhindert schwarze Flächen bei transparenten PDFs)
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  await page.render({ canvasContext: ctx, viewport: vp }).promise;
  return canvas;
}

/**
 * Tesseract-TSV (Wortebene, level 5) → positionierte Items in PDF-Punkten.
 * Die y-Koordinate wird je Tesseract-Zeile (block|par|line) vereinheitlicht,
 * damit die Zeilen-Clusterung im Parser nicht an OCR-Rauschen zerbricht.
 */
function _tsvToItems(tsv, page, imgW, imgH, scale) {
  if (!tsv) return [];
  const pwPt = imgW / scale, phPt = imgH / scale;
  const words = [];
  const lineTop = new Map();   // block|par|line → kleinster top-Wert der Zeile
  for (const row of tsv.split('\n')) {
    const c = row.split('\t');
    if (c[0] !== '5') continue;            // nur Wörter
    const text = (c[11] || '').trim();
    if (!text) continue;
    const key = c[2] + '|' + c[3] + '|' + c[4];
    const top = +c[7];
    words.push({ text, key, left: +c[6], top, width: +c[8] });
    if (!lineTop.has(key) || top < lineTop.get(key)) lineTop.set(key, top);
  }
  return words.map(w => ({
    text: w.text,
    x:    w.left / scale,
    y:    phPt - lineTop.get(w.key) / scale,   // gemeinsame Zeilen-Baseline, y von unten
    pw:   pwPt,
    ph:   phPt,
    w:    w.width / scale,
    page,
  }));
}

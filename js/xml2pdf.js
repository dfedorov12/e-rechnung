/**
 * Rechnungsdaten → lesbares PDF (pdf-lib, lokal gehostet)
 * ========================================================
 * Erzeugt aus einem geparsten E-Rechnungs-Datenobjekt (xmlinvoice.js)
 * ein sauber formatiertes A4-PDF mit Adressblöcken, Positionstabelle,
 * Summen und Zahlungsinformationen. Mehrseitig bei vielen Positionen.
 */

const _PDF = {
  pageW: 595.28,           // A4 Hochformat in pt
  pageH: 841.89,
  margin: 50,
  colPrimary: [0.10, 0.34, 0.63],   // DIHAG-Blau
  colGray:    [0.42, 0.45, 0.50],
  colLight:   [0.90, 0.91, 0.93],
};

/**
 * Haupteinstieg: Datenobjekt → PDF-Bytes.
 * @param   {object} data  Ergebnis von parseInvoiceXML()
 * @returns {Promise<Uint8Array>}
 */
async function buildInvoicePdf(data) {
  const { PDFDocument, StandardFonts, rgb } = PDFLib;
  const doc  = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);

  const M = _PDF.margin;
  const W = _PDF.pageW;
  const primary = rgb(..._PDF.colPrimary);
  const gray    = rgb(..._PDF.colGray);
  const light   = rgb(..._PDF.colLight);
  const black   = rgb(0.12, 0.14, 0.18);

  let page, y;

  const newPage = () => {
    page = doc.addPage([_PDF.pageW, _PDF.pageH]);
    y = _PDF.pageH - M;
  };

  // WinAnsi-sichere Zeichen (pdf-lib Standard-Fonts können kein Unicode)
  const enc = s => String(s ?? '')
    .replace(/[‐-―]/g, '-')       // diverse Striche → Bindestrich
    .replace(/…/g, '...')
    .replace(/[‘’]/g, "'")
    .replace(/[“-„]/g, '"')
    .replace(/[^\x20-\x7E\xA0-\xFF€]/g, '?');

  const text = (s, x, yy, opts = {}) => {
    page.drawText(enc(s), {
      x, y: yy,
      size:  opts.size  || 9,
      font:  opts.bold ? bold : font,
      color: opts.color || black,
    });
  };

  const textRight = (s, xRight, yy, opts = {}) => {
    const f = opts.bold ? bold : font;
    const w = f.widthOfTextAtSize(enc(s), opts.size || 9);
    text(s, xRight - w, yy, opts);
  };

  const hline = (yy, x1 = M, x2 = W - M, col = light) => {
    page.drawLine({ start: { x: x1, y: yy }, end: { x: x2, y: yy }, thickness: 0.7, color: col });
  };

  /** Text auf Breite umbrechen (einfacher Wort-Umbruch). */
  const wrap = (s, maxW, size = 9) => {
    const words = enc(s).split(/\s+/);
    const lines = [];
    let cur = '';
    for (const wd of words) {
      const probe = cur ? cur + ' ' + wd : wd;
      if (font.widthOfTextAtSize(probe, size) <= maxW) { cur = probe; }
      else { if (cur) lines.push(cur); cur = wd; }
    }
    if (cur) lines.push(cur);
    return lines.length ? lines : [''];
  };

  const fmtEur  = n => (n || 0).toLocaleString('de-DE', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + ' €';
  const fmtDate = s => s ? s.split('-').reverse().join('.') : '–';

  /* ── Seite 1: Kopf ── */
  newPage();

  text('RECHNUNG', M, y - 10, { size: 22, bold: true, color: primary });
  textRight(`Nr. ${data.rechnungsnummer || '–'}`, W - M, y - 8, { size: 12, bold: true });
  textRight(`konvertiert aus ${data.syntax || 'XML'}-E-Rechnung`, W - M, y - 22, { size: 8, color: gray });
  y -= 44;
  hline(y, M, W - M, primary);
  y -= 24;

  /* ── Adressblöcke ── */
  const colB = W / 2 + 10;
  text('RECHNUNGSSTELLER', M, y, { size: 7.5, bold: true, color: gray });
  text('RECHNUNGSEMPFÄNGER', colB, y, { size: 7.5, bold: true, color: gray });
  y -= 14;

  const sellerLines = [
    [data.verkaeufer, true],
    [data.verkaeufstrasse],
    [[data.verkaeufplz, data.verkaeufstadt].filter(Boolean).join(' ')],
    [data.verkaeufland !== 'DE' ? data.verkaeufland : ''],
    [data.verkaeufervat      ? `USt-IdNr.: ${data.verkaeufervat}` : ''],
    [data.verkaeufersteuernr ? `Steuernr.: ${data.verkaeufersteuernr}` : ''],
    [data.verkaeufkontakt    ? `Ansprechpartner: ${data.verkaeufkontakt}` : ''],
    [data.verkaeuftel        ? `Tel.: ${data.verkaeuftel}` : ''],
    [data.verkaeuferemail || ''],
  ].filter(([s]) => s);

  const buyerLines = [
    [data.kaeufer, true],
    [data.kaeuferstrasse],
    [[data.kaeuferplz, data.kaeuferstadt].filter(Boolean).join(' ')],
    [data.kaeuferland !== 'DE' ? data.kaeuferland : ''],
    [data.kaeufervat ? `USt-IdNr.: ${data.kaeufervat}` : ''],
    [data.leitwegid  ? `Leitweg-ID: ${data.leitwegid}` : ''],
    [data.kaeufermail || ''],
  ].filter(([s]) => s);

  const blockStart = y;
  let ys = y;
  for (const [s, b] of sellerLines) { text(s, M, ys, { size: 9, bold: !!b }); ys -= 13; }
  let yb = blockStart;
  for (const [s, b] of buyerLines)  { text(s, colB, yb, { size: 9, bold: !!b }); yb -= 13; }
  y = Math.min(ys, yb) - 16;

  /* ── Metadaten-Zeile ── */
  const meta = [
    ['Rechnungsdatum',  fmtDate(data.rechnungsdatum)],
    ['Lieferdatum',     fmtDate(data.lieferdatum)],
    ['Fällig am',       fmtDate(data.faelligkeitsdatum)],
    ['Zahlungsreferenz', data.zahlungsreferenz || '–'],
  ];
  const metaW = (W - 2 * M) / meta.length;
  meta.forEach(([label, val], i) => {
    text(label, M + i * metaW, y, { size: 7.5, bold: true, color: gray });
    text(val,   M + i * metaW, y - 12, { size: 9 });
  });
  y -= 34;

  /* ── Lieferanschrift (BG-13) ── */
  if (data.lieferName || data.lieferStrasse || data.lieferPlz) {
    text('LIEFERANSCHRIFT', M, y, { size: 7.5, bold: true, color: gray });
    y -= 12;
    const addr = [
      data.lieferName,
      data.lieferStrasse,
      [data.lieferPlz, data.lieferStadt].filter(Boolean).join(' '),
      data.lieferLand && data.lieferLand !== 'DE' ? data.lieferLand : '',
    ].filter(Boolean).join(' · ');
    for (const l of wrap(addr, W - 2 * M)) { text(l, M, y, { size: 9 }); y -= 12; }
    y -= 10;
  }

  /* ── Positionstabelle ── */
  // Spalten: # | Beschreibung | Menge | Einheit | Einzelpreis | MwSt % | Gesamt
  const cols = {
    nr:     { x: M,       w: 22 },
    besch:  { x: M + 24,  w: 216 },
    menge:  { x: M + 244, w: 46, right: true },
    einheit:{ x: M + 294, w: 42 },
    preis:  { x: M + 338, w: 62, right: true },
    mwst:   { x: M + 404, w: 36, right: true },
    gesamt: { x: M + 444, w: W - 2 * M - 444, right: true },
  };

  const tableHeader = () => {
    page.drawRectangle({ x: M - 4, y: y - 4, width: W - 2 * M + 8, height: 16, color: light });
    text('#',           cols.nr.x, y, { size: 7.5, bold: true, color: gray });
    text('Beschreibung', cols.besch.x, y, { size: 7.5, bold: true, color: gray });
    textRight('Menge',  cols.menge.x + cols.menge.w, y, { size: 7.5, bold: true, color: gray });
    text('Einheit',     cols.einheit.x, y, { size: 7.5, bold: true, color: gray });
    textRight('Einzelpreis', cols.preis.x + cols.preis.w, y, { size: 7.5, bold: true, color: gray });
    textRight('MwSt.',  cols.mwst.x + cols.mwst.w, y, { size: 7.5, bold: true, color: gray });
    textRight('Gesamt', cols.gesamt.x + cols.gesamt.w, y, { size: 7.5, bold: true, color: gray });
    y -= 20;
  };

  tableHeader();

  (data.positionen || []).forEach((p, i) => {
    const beschLines = wrap(p.beschreibung || '–', cols.besch.w);
    const rowH = Math.max(13, beschLines.length * 11 + 2);

    // Seitenumbruch, wenn Zeile + Summenblock nicht mehr passen
    if (y - rowH < M + 60) {
      newPage();
      tableHeader();
    }

    const gesamt = p.gesamt || (p.menge * p.einzelpreis);
    text(String(i + 1), cols.nr.x, y, { size: 9, color: gray });
    beschLines.forEach((l, li) => text(l, cols.besch.x, y - li * 11, { size: 9 }));
    textRight(String(p.menge ?? ''), cols.menge.x + cols.menge.w, y, { size: 9 });
    text(p.einheit || '', cols.einheit.x, y, { size: 9 });
    textRight(fmtEur(p.einzelpreis), cols.preis.x + cols.preis.w, y, { size: 9 });
    textRight((p.mwst ?? 0) + ' %', cols.mwst.x + cols.mwst.w, y, { size: 9 });
    textRight(fmtEur(gesamt), cols.gesamt.x + cols.gesamt.w, y, { size: 9 });

    y -= rowH;
    hline(y + 4);
    y -= 6;
  });

  /* ── Summenblock ── */
  if (y < M + 110) newPage();
  y -= 6;
  const sumX = W - M - 200;

  const sumRow = (label, val, opts = {}) => {
    text(label, sumX, y, { size: opts.size || 9, bold: opts.bold, color: opts.color });
    textRight(val, W - M, y, { size: opts.size || 9, bold: opts.bold, color: opts.color });
    y -= opts.gap || 15;
  };

  sumRow('Nettobetrag', fmtEur(data.netTotal));
  sumRow('MwSt.',       fmtEur(data.vatTotal));
  hline(y + 8, sumX, W - M, primary);
  y -= 2;
  sumRow('Gesamtbetrag', fmtEur(data.grossTotal), { size: 11, bold: true, color: primary, gap: 22 });

  /* ── Steuerbefreiung (BT-118/BT-120) ── */
  if (data.befreiungsgrund || (data.steuerkategorie && !['S', 'Z'].includes(data.steuerkategorie))) {
    text('STEUERBEFREIUNG', M, y, { size: 7.5, bold: true, color: gray });
    y -= 13;
    const katName = {
      K: 'Innergemeinschaftliche Lieferung', AE: 'Reverse Charge',
      G: 'Ausfuhrlieferung Drittland', E: 'Steuerbefreit', O: 'Nicht steuerbar',
    }[data.steuerkategorie] || '';
    const line = [katName ? `Kategorie ${data.steuerkategorie} (${katName})` : '', data.befreiungsgrund]
      .filter(Boolean).join(': ');
    for (const l of wrap(line, W - 2 * M)) { text(l, M, y, { size: 9 }); y -= 12; }
    y -= 6;
  }

  /* ── Zahlung / Notiz ── */
  if (data.iban || data.bic) {
    text('ZAHLUNGSINFORMATIONEN', M, y, { size: 7.5, bold: true, color: gray });
    y -= 13;
    if (data.iban) { text(`IBAN: ${data.iban.replace(/(.{4})/g, '$1 ').trim()}`, M, y, { size: 9 }); y -= 13; }
    if (data.bic)  { text(`BIC: ${data.bic}`, M, y, { size: 9 }); y -= 13; }
    y -= 6;
  }

  if (data.notiz) {
    text('HINWEISE', M, y, { size: 7.5, bold: true, color: gray });
    y -= 13;
    for (const l of wrap(data.notiz, W - 2 * M)) {
      if (y < M + 30) newPage();
      text(l, M, y, { size: 9 });
      y -= 12;
    }
  }

  /* ── Fußzeile auf jeder Seite ── */
  const pages = doc.getPages();
  pages.forEach((pg, i) => {
    pg.drawLine({ start: { x: M, y: M - 14 }, end: { x: W - M, y: M - 14 }, thickness: 0.5, color: light });
    pg.drawText(enc(`Konvertiert aus ${data.syntax || 'XML'}-E-Rechnung (EN 16931) · DIHAG E-Rechnung Konverter`), {
      x: M, y: M - 26, size: 7, font, color: gray,
    });
    const pn = enc(`Seite ${i + 1} / ${pages.length}`);
    pg.drawText(pn, {
      x: W - M - font.widthOfTextAtSize(pn, 7), y: M - 26, size: 7, font, color: gray,
    });
  });

  return doc.save();
}

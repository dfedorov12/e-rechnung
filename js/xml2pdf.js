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

/* BT-3 (UNTDID 1001) → Überschrift + Klartext-Bezeichnung */
const _RA_TITLE = {
  '381': 'GUTSCHRIFT', '389': 'GUTSCHRIFT', '384': 'RECHNUNGSKORREKTUR',
  '383': 'BELASTUNGSANZEIGE', '386': 'VORAUSZAHLUNGSRECHNUNG', '326': 'TEILRECHNUNG',
  '875': 'ABSCHLAGSRECHNUNG', '876': 'TEILSCHLUSSRECHNUNG', '877': 'SCHLUSSRECHNUNG',
};
const _RA_LABEL = {
  '380': 'Rechnung', '381': 'Kaufmännische Gutschrift', '383': 'Belastungsanzeige',
  '384': 'Rechnungskorrektur', '386': 'Vorauszahlungsrechnung', '389': 'Gutschrift (Selbstfakturierung)',
  '326': 'Teilrechnung', '875': 'Abschlagsrechnung (Bau)', '876': 'Teilschlussrechnung (Bau)',
  '877': 'Schlussrechnung (Bau)',
};

/**
 * Haupteinstieg: Datenobjekt → PDF-Bytes.
 * @param   {object} data  Ergebnis von parseInvoiceXML()
 * @returns {Promise<Uint8Array>}
 */
async function buildInvoicePdf(data) {
  const { PDFDocument, StandardFonts, rgb } = PDFLib;
  const doc  = await PDFDocument.create();

  // PDF/A-3b verlangt vollständig eingebettete Schriften. Die pdf-lib-Standard-
  // schrift Helvetica ist NICHT einbettbar. Wenn fontkit + die eingebettete
  // Schrift (js/vendor/font-embed.js) verfügbar sind, echte TrueType-Schrift
  // einbetten; sonst Fallback auf Helvetica (dann kein PDF/A).
  const _fk = (typeof fontkit !== 'undefined') ? fontkit
            : (typeof window !== 'undefined' && window.fontkit) ? window.fontkit : null;
  const _ef = (typeof EMBED_FONTS !== 'undefined') ? EMBED_FONTS
            : (typeof window !== 'undefined' && window.EMBED_FONTS) ? window.EMBED_FONTS : null;
  let font, bold;
  if (_fk && _ef) {
    doc.registerFontkit(_fk);
    const _u8 = b64 => { const bin = atob(b64); const u = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i); return u; };
    font = await doc.embedFont(_u8(_ef.regular), { subset: true });
    bold = await doc.embedFont(_u8(_ef.bold),    { subset: true });
  } else {
    font = await doc.embedFont(StandardFonts.Helvetica);
    bold = await doc.embedFont(StandardFonts.HelveticaBold);
  }

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

  const raCode  = String(data.rechnungsart || '380');
  const raTitle = _RA_TITLE[raCode] || 'RECHNUNG';
  const raLabel = _RA_LABEL[raCode] || 'Rechnung';
  let titleSize = 22;   // lange Titel (z. B. VORAUSZAHLUNGSRECHNUNG) verkleinern, damit sie nicht an die Nr. stoßen
  while (titleSize > 13 && bold.widthOfTextAtSize(enc(raTitle), titleSize) > (W / 2 - M)) titleSize -= 1;
  text(raTitle, M, y - 10, { size: titleSize, bold: true, color: primary });
  textRight(`Rechnungsnummer ${data.rechnungsnummer || '–'}`, W - M, y - 8, { size: 12, bold: true });
  textRight(`Rechnungsart (BT-3): ${raCode} – ${raLabel}`, W - M, y - 22, { size: 8, color: gray });
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
    [data.registernr         ? `Register: ${data.registernr}` : ''],
    [data.rechtsangaben || ''],
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
    [data.leitwegid       ? `Käuferreferenz: ${data.leitwegid}` : ''],
    [data.bestellnummer   ? `Bestellnummer: ${data.bestellnummer}` : ''],
    [data.projektreferenz ? `Projektreferenz: ${data.projektreferenz}` : ''],
    [data.vertragsnummer  ? `Vertragsnummer: ${data.vertragsnummer}` : ''],
    [data.kaeufermail || ''],
  ].filter(([s]) => s);

  // Spaltenbreiten begrenzen und umbrechen, damit lange Zeilen (z. B. Rechtsform)
  // nicht in die andere Spalte / über andere Zeilen schreiben.
  const sellerColW = colB - M - 14;
  const buyerColW  = W - M - colB;
  const blockStart = y;
  let ys = y;
  for (const [s, b] of sellerLines) {
    for (const ln of wrap(String(s), sellerColW)) { text(ln, M, ys, { size: 9, bold: !!b }); ys -= 12; }
  }
  let yb = blockStart;
  for (const [s, b] of buyerLines) {
    for (const ln of wrap(String(s), buyerColW)) { text(ln, colB, yb, { size: 9, bold: !!b }); yb -= 12; }
  }
  y = Math.min(ys, yb) - 16;

  /* ── Metadaten-Zeile ── */
  const abrZeitraum = (data.abrZeitraumStart || data.abrZeitraumEnde)
    ? `${fmtDate(data.abrZeitraumStart)} – ${fmtDate(data.abrZeitraumEnde)}`
    : '–';
  const meta = [
    ['Rechnungsdatum',      fmtDate(data.rechnungsdatum)],
    ['Lieferdatum',         fmtDate(data.lieferdatum)],
    ['Abrechnungszeitraum', abrZeitraum],
    ['Lieferscheinnummer',  data.lieferscheinnummer || '–'],
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
    nr:     { x: M,       w: 32 },
    besch:  { x: M + 36,  w: 204 },
    menge:  { x: M + 244, w: 46, right: true },
    einheit:{ x: M + 294, w: 42 },
    preis:  { x: M + 338, w: 62, right: true },
    mwst:   { x: M + 404, w: 36, right: true },
    gesamt: { x: M + 444, w: W - 2 * M - 444, right: true },
  };

  const tableHeader = () => {
    page.drawRectangle({ x: M - 4, y: y - 4, width: W - 2 * M + 8, height: 16, color: light });
    text('Pos.',        cols.nr.x, y, { size: 7.5, bold: true, color: gray });
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
    text(String(p.posnr || (i + 1)), cols.nr.x, y, { size: 9, color: gray });
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
  // Gezahlter Betrag (BT-113), Rundungsbetrag (BT-114), Fälliger Betrag (BT-115)
  const hasExtra = (data.gezahlt || 0) !== 0 || (data.rundung || 0) !== 0
    || (data.faelligerBetrag && Math.abs(data.faelligerBetrag - (data.grossTotal || 0)) > 0.005);
  sumRow('Gesamtbetrag', fmtEur(data.grossTotal),
    { size: 11, bold: true, color: primary, gap: hasExtra ? 16 : 22 });
  if (hasExtra) {
    if ((data.gezahlt || 0) !== 0) sumRow('Gezahlter Betrag', '-' + fmtEur(data.gezahlt));
    if ((data.rundung || 0) !== 0) sumRow('Rundungsbetrag', fmtEur(data.rundung));
    const faellig = (data.faelligerBetrag != null && data.faelligerBetrag !== 0)
      ? data.faelligerBetrag
      : ((data.grossTotal || 0) - (data.gezahlt || 0) + (data.rundung || 0));
    hline(y + 8, sumX, W - M, light);
    y -= 2;
    sumRow('Fälliger Betrag', fmtEur(faellig), { size: 11, bold: true, color: primary, gap: 22 });
  }

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
  if (data.iban || data.bic || data.kontoinhaber || data.faelligkeitsdatum || data.zahlungsbedingungen || data.zahlungsreferenz) {
    if (y < M + 80) newPage();
    text('ZAHLUNGSINFORMATIONEN', M, y, { size: 7.5, bold: true, color: gray });
    y -= 13;
    if (data.kontoinhaber)      { for (const l of wrap(`Kontoinhaber: ${data.kontoinhaber}`, W - 2 * M)) { text(l, M, y, { size: 9 }); y -= 12; } }
    if (data.iban) { text(`IBAN: ${data.iban.replace(/(.{4})/g, '$1 ').trim()}`, M, y, { size: 9 }); y -= 13; }
    if (data.bic)  { text(`BIC: ${data.bic}`, M, y, { size: 9 }); y -= 13; }
    if (data.zahlungsbedingungen) {
      for (const l of wrap(`Zahlungsbedingungen: ${data.zahlungsbedingungen}`, W - 2 * M)) {
        if (y < M + 30) newPage();
        text(l, M, y, { size: 9 }); y -= 12;
      }
    }
    if (data.faelligkeitsdatum) { text(`Fällig am: ${fmtDate(data.faelligkeitsdatum)}`, M, y, { size: 9 }); y -= 13; }
    if (data.zahlungsreferenz) {
      for (const l of wrap(`Zahlungsreferenz: ${data.zahlungsreferenz}`, W - 2 * M)) {
        if (y < M + 30) newPage();
        text(l, M, y, { size: 9 }); y -= 12;
      }
    }
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

  /* ── Seite 2: Weitere Angaben aus der XML ── */
  const _weitere = data.weitere || [];
  const _hasPosExtra = (data.positionen || []).some(p => p.note || (p.posExtra && p.posExtra.length));
  if (_weitere.length || _hasPosExtra) {
    newPage();
    text('WEITERE ANGABEN AUS DER XML', M, y - 4, { size: 13, bold: true, color: primary });
    y -= 12; hline(y, M, W - M, primary); y -= 16;
    text('Ergänzende Rechnungsinhalte, die auf Seite 1 nicht dargestellt sind.', M, y, { size: 8, color: gray });
    y -= 18;

    const labW = 165;
    const kv = (label, value) => {
      const lines = wrap(String(value), W - M - (M + labW));
      const need = Math.max(13, lines.length * 12);
      if (y - need < M + 26) newPage();
      text(label, M, y, { size: 8.5, bold: true, color: gray });
      lines.forEach((l, i) => text(l, M + labW, y - i * 12, { size: 9 }));
      y -= need;
    };
    const grp = (title) => {
      if (y < M + 46) newPage();
      y -= 5;
      text(String(title).toUpperCase(), M, y, { size: 8, bold: true, color: primary });
      y -= 14;
    };

    let cur = null;
    for (const it of _weitere) {
      if (it.group !== cur) { grp(it.group); cur = it.group; }
      kv(it.label, it.value);
    }
    (data.positionen || []).forEach((p, i) => {
      const items = [];
      if (p.note) items.push(['Hinweis (BT-127)', p.note]);
      (p.posExtra || []).forEach(e => items.push([e.label, e.value]));
      if (!items.length) return;
      grp(`Position ${p.posnr || (i + 1)}: ${(p.beschreibung || '').slice(0, 60)}`);
      for (const [l, v] of items) kv(l, v);
    });
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

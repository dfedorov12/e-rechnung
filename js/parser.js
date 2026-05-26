/**
 * PDF Invoice Parser
 * Extracts structured invoice data from German PDF invoices using PDF.js text content.
 * Strategy:
 *   - footerText   → seller (USt-IdNr, Steuer-Nr, IBAN, BIC, Adresse)
 *   - leftColumnText → buyer (Adressfenster links oben)
 *   - rightText    → metadata (Rechnungsnummer, Datum, …)
 */

async function extractInvoiceData(pdfDoc) {
  const { fullText, leftText, leftColumnText, rightText, footerText } =
    await _extractTextSections(pdfDoc);

  // Englischsprachige Industrierechnung (Walzengiesserei / PIOMBINO-Format)
  if (_isEnglishIndustrialInvoice(fullText)) {
    return {
      ...extractMetadataEnglish(fullText),
      ...extractSellerEnglish(footerText, fullText),
      ...extractBuyerEnglish(leftColumnText, fullText),
      positionen: extractLineItemsEnglish(fullText),
    };
  }

  return {
    ...extractMetadata(rightText, fullText),
    ...extractSeller(footerText, fullText),
    ...extractBuyer(leftColumnText, leftText, fullText),
    positionen: extractLineItems(fullText),
  };
}

/* ══════════════════════════════════════════════════════
   Detektor: Englische Industrierechnung
   Erkennt Format mit "Invoice Nr", "pcs." und Tabellenkopf
══════════════════════════════════════════════════════ */
function _isEnglishIndustrialInvoice(text) {
  return /Invoice\s*Nr[:\s]/i.test(text) &&
         /\bpcs\.\b/i.test(text) &&
         /Item\s+Product\s+Quantity\s+Unit\s+price/i.test(text);
}

/* ══════════════════════════════════════════════════════
   Text Extraction
══════════════════════════════════════════════════════ */
async function _extractTextSections(pdfDoc) {
  const allItems = [];

  for (let p = 1; p <= pdfDoc.numPages; p++) {
    const page    = await pdfDoc.getPage(p);
    const vp      = page.getViewport({ scale: 1 });
    const content = await page.getTextContent();

    for (const item of content.items) {
      const s = item.str;
      if (!s || !s.trim()) continue;
      allItems.push({
        text: s,
        x:  item.transform[4],
        y:  item.transform[5],
        pw: vp.width,
        ph: vp.height,
        w:  item.width || 0,   // advance width → gap detection for joined chars
      });
    }
  }

  // Top → bottom, left → right
  allItems.sort((a, b) => b.y - a.y || a.x - b.x);

  /**
   * Cluster items into visual lines (±4 pt) and return newline-joined string.
   * Uses gap-based joining: gap < 2 pt between consecutive items → no space
   * (fixes "Me uselwitz" → "Meuselwitz", "D-0 4610" → "D-04610").
   */
  function toLines(items) {
    const map = {};
    for (const it of items) {
      const ky = Math.round(it.y / 4) * 4;
      if (!map[ky]) map[ky] = [];
      map[ky].push(it);
    }
    return Object.values(map)
      .sort((a, b) => b[0].y - a[0].y)
      .map(ls => {
        const sorted = ls.sort((a, b) => a.x - b.x);
        return sorted.reduce((acc, it, i) => {
          if (i === 0) return it.text;
          const prev = sorted[i - 1];
          const gap  = it.x - (prev.x + (prev.w || 0));
          return acc + (gap < 2 ? '' : ' ') + it.text;
        }, '');
      })
      .join('\n');
  }

  const fullText       = toLines(allItems);
  const leftColumnText = toLines(allItems.filter(i => i.x < i.pw * 0.48));
  const leftText       = allItems.filter(i => i.x < i.pw * 0.48).map(i => i.text).join(' ');
  const rightText      = toLines(allItems.filter(i => i.x > i.pw * 0.48));
  // Footer = bottom 22 % of page (small y values in PDF coordinate space)
  // + last 15 lines of fullText as additional fallback (covers y-coordinate edge cases)
  const footerByY    = toLines(allItems.filter(i => i.y < i.ph * 0.22));
  const footerByEnd  = fullText.split('\n').slice(-15).join('\n');
  const footerText   = footerByY + '\n' + footerByEnd;

  return { fullText, leftText, leftColumnText, rightText, footerText };
}

/* ══════════════════════════════════════════════════════
   Metadata  (Rechnungsnummer, Datum, …)
══════════════════════════════════════════════════════ */
function extractMetadata(rightText, fullText) {
  const r   = {};
  const src = rightText + '\n' + fullText;

  _try(src, [
    /Rechnungs-?Nr\.?\s*[:\s]+([A-Z0-9][A-Z0-9\-\/\.]{2,20})/i,
    /Invoice\s*(?:No|Nr)\.?\s*[:\s]+([A-Z0-9][A-Z0-9\-\/\.]{2,20})/i,
  ], m => r.rechnungsnummer = m[1].trim());

  _try(src, [
    /Re\.?-?Datum\s*[:\s]+(\d{2}\.\d{2}\.\d{4})/i,
    /Rechnungsdatum\s*[:\s]+(\d{2}\.\d{2}\.\d{4})/i,
    /Datum\s*[:\s]+(\d{2}\.\d{2}\.\d{4})/,
  ], m => r.rechnungsdatum = _deDate(m[1]));

  const ldm = src.match(/Leistungs-?Dat\.?\s*[:\s]+(\d{2}\.\d{2}\.\d{4})/i);
  if (ldm) r.lieferdatum = _deDate(ldm[1]);

  const zbm = fullText.match(/Zahlungsbedingung\s*[:\s]+(.{5,100})/i);
  if (zbm) r.notiz = 'Zahlungsbedingung: ' + zbm[1].trim().replace(/\s+/g, ' ');

  return r;
}

/* ══════════════════════════════════════════════════════
   Seller  (Rechnungssteller)
   Sucht zuerst in footerText, dann im gesamten fullText.
══════════════════════════════════════════════════════ */
function extractSeller(footerText, fullText) {
  const r   = {};
  // footerText first → most reliable source for seller data
  const src = footerText + '\n' + fullText;

  // ── USt-IdNr ──────────────────────────────────────────────────────────────
  // Separator: space / colon / · (U+00B7) / • (U+2022 bullet) / pipe
  // Primary: label + value.  Fallback: "DE NNN NNN NNN" value pattern directly.
  const _sep = /[\s:·•|]*/;
  const vatm =
    src.match(/USt-?Id\.?-?Nr\.?[\s:·•|]*\s*(DE(?:\s*\d){9})/i) ||
    src.match(/(DE\s+\d{3}\s+\d{3}\s+\d{3})\b/);          // "DE 812 264 517"
  if (vatm) r.verkaeufervat = vatm[1].replace(/\s/g, '');

  // ── Steuernummer ──────────────────────────────────────────────────────────
  // Primary: label + value.  Fallback: xxx/xxx/xxxxx pattern (unique in invoice).
  const stm =
    src.match(/Steuer-?(?:Nr\.?|nummer)[\s:·•|]*\s*(\d{1,3}\/\d{2,3}\/\d{4,8})/i) ||
    src.match(/\b(\d{3}\/\d{3}\/\d{4,8})\b/);             // "232/118/07369"
  if (stm) r.verkaeufersteuernr = stm[1];

  // ── IBAN ──────────────────────────────────────────────────────────────────
  const ibanm = src.match(/IBAN[\s:·•|]*\s*(DE\d{2}[\s\d]{15,27})/i);
  if (ibanm) r.iban = ibanm[1].replace(/\s/g, '');

  // ── BIC ───────────────────────────────────────────────────────────────────
  const bicm = src.match(/BIC[\s:·•|]*\s*([A-Z]{4}[A-Z]{2}[A-Z0-9]{2}(?:[A-Z0-9]{3})?)/i);
  if (bicm) r.bic = bicm[1];

  // ── Telefon ───────────────────────────────────────────────────────────────
  // Matches "Tel: +49 341 123456" or "Telefon: 0341/123456"
  const telm = src.match(/Tel\.?(?:efon)?\s*[:\s•|]+([+\d][\d\s()\/\-\.]{5,20})/i);
  if (telm) r.verkaeuftel = telm[1].trim().replace(/\s+/g, ' ');

  // ── E-Mail ────────────────────────────────────────────────────────────────
  const emailm = src.match(/E-?Mail\s*[:\s•|]+([a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,})/i) ||
                 src.match(/([a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,})/);
  if (emailm) r.verkaeuferemail = emailm[1].trim();

  // Name + Adresse — Suche bevorzugt in Fußzeile
  // Pattern 1: "Name · Straße · PLZ Stadt"  (beliebiges Sonderzeichen als Trenner)
  const dotPat = /([A-ZÄÖÜ].+?(?:GmbH|AG|KG|OHG|SE|UG|e\.V\.))\s*[^\wäöüÄÖÜß\s\n\-,\.]{1,3}\s*(.+?(?:str(?:aße|\.)?|[Ww]eg|[Gg]asse|[Pp]latz|[Ss]traße).+?)\s*[^\wäöüÄÖÜß\s\n\-,\.]{1,3}\s*(\d{4,5})\s+([A-ZÄÖÜa-zäöüß][A-ZÄÖÜa-zäöüß\-]+)/i;
  // Pattern 2: "Name - Str. - PLZ Stadt"  (Leerzeichen um Bindestrich = Trenner, nicht Bindestrich im Namen)
  const dashPat = /([A-ZÄÖÜ].+?(?:GmbH|AG|KG|OHG|SE|UG))\s{1,3}-\s{1,3}(.+?(?:str(?:aße|\.)?|[Ww]eg|[Gg]asse|[Ss]tr\.).+?)\s{1,3}-\s{1,3}(\d{4,5})\s+([A-ZÄÖÜa-zäöüß][A-ZÄÖÜa-zäöüß\-]+)/i;

  for (const pat of [dotPat, dashPat]) {
    // Try footer first, then full text
    const m = footerText.match(pat) || fullText.match(pat);
    if (m) {
      r.verkaeufer      = m[1].trim();
      r.verkaeufstrasse = m[2].trim().replace(/\s{2,}/g, ' ');
      r.verkaeufplz     = m[3];
      r.verkaeufstadt   = m[4].trim();
      r.verkaeufland    = 'DE';
      break;
    }
  }

  return r;
}

/* ══════════════════════════════════════════════════════
   Buyer  (Rechnungsempfänger)
   Primärstrategie: linke Spalte mit Zeilenstruktur.
   Die Absenderzeile wird erkannt durch: GmbH/AG/KG UND
   eine 5-stellige PLZ auf DERSELBEN Zeile.
══════════════════════════════════════════════════════ */
function extractBuyer(leftColumnText, leftText, fullText) {
  const r = {};

  // Absenderzeile-Erkennung: Company + PLZ auf einer Zeile
  // z. B. "Stahl- und Hartgusswerk Bösdorf GmbH Werkstr. 7 - 04249 Leipzig"
  const isAbsender = l => /(?:GmbH|AG|KG|OHG|UG|e\.V\.)/.test(l) && /\b\d{5}\b/.test(l);

  // ── Strategie 1: linke Spalte mit Zeilenstruktur ──
  if (leftColumnText) {
    const lcLines = leftColumnText
      .split('\n')
      .map(l => l.trim())
      .filter(l => l.length > 2 && !/^[-_=]+$/.test(l) && !isAbsender(l));

    const compIdx = lcLines.findIndex(l =>
      /\b(?:GmbH|AG|KG|GbR|e\.V\.|mbH)\b/i.test(l)
    );

    if (compIdx >= 0) {
      r.kaeufer = lcLines[compIdx];

      // PLZ + Stadt — z. B. "D-04610 Meuselwitz" oder "04610 Meuselwitz"
      for (const line of lcLines.slice(compIdx + 1)) {
        const plzm = line.match(/[A-Z]?-?(\d{5})\s+([A-ZÄÖÜa-zäöüß][A-ZÄÖÜa-zäöüß\-]+)/);
        if (plzm) { r.kaeuferplz = plzm[1]; r.kaeuferstadt = plzm[2]; break; }
      }

      // Straße: erste Zeile nach Firmenname, die NICHT die PLZ-Zeile ist
      for (const line of lcLines.slice(compIdx + 1)) {
        if (/[A-Z]?-?\d{5}/.test(line)) break; // PLZ erreicht → Abbruch
        if (!r.kaeuferstrasse && line !== r.kaeufer) {
          r.kaeuferstrasse = line;
        }
      }

      r.kaeuferland = 'DE';
    }
  }

  // ── Strategie 2: fullText-Block zwischen RECHNUNG und Rechnungs-Nr. ──
  if (!r.kaeufer) {
    const bm = fullText.match(
      /RECHNUNG[\s\S]{0,500}?(\n[A-ZÄÖÜ][^\n]+(?:GmbH|AG|KG|GbR|e\.V\.|mbH)[^\n]*\n[\s\S]{0,500}?)Rechnungs-?Nr/i
    );
    if (bm) {
      const block    = bm[1];
      const rawLines = block
        .split('\n')
        .map(l => l.trim())
        .filter(l => l.length > 2 && !/^[-_=]+$/.test(l) && !isAbsender(l));

      if (rawLines[0]) r.kaeufer = rawLines[0];

      const plzm = block.match(/[A-Z]?-?(\d{5})\s+([A-ZÄÖÜa-zäöüß\-]+)/);
      if (plzm) { r.kaeuferplz = plzm[1]; r.kaeuferstadt = plzm[2]; }

      for (const line of rawLines.slice(1)) {
        if (/[A-Z]?-?\d{5}/.test(line)) break;
        if (!r.kaeuferstrasse && line !== r.kaeufer) r.kaeuferstrasse = line;
      }
      r.kaeuferland = 'DE';
    }
  }

  // ── Strategie 3: flat leftText als letzter Ausweg ──
  if (!r.kaeufer && leftText) {
    const words   = leftText.split(/\s{3,}|\n/).map(s => s.trim()).filter(Boolean);
    const compIdx = words.findIndex(l => /GmbH|AG|KG|GbR/i.test(l));
    if (compIdx >= 0) {
      r.kaeufer = words[compIdx];
      if (words[compIdx + 1]) r.kaeuferstrasse = words[compIdx + 1];
      const plzm = leftText.match(/[A-Z]?-?(\d{5})\s+([A-ZÄÖÜa-zäöüß]+)/);
      if (plzm) { r.kaeuferplz = plzm[1]; r.kaeuferstadt = plzm[2]; }
      r.kaeuferland = 'DE';
    }
  }

  return r;
}

/* ══════════════════════════════════════════════════════
   Line Items
══════════════════════════════════════════════════════ */
function extractLineItems(fullText) {
  const items = [];

  // ── Pattern A: SHB-Format "Beschreibung : Preis Gesamt €/Einheit €" ──
  const shbRe = /([A-Za-zÄÖÜäöüß0-9][^:\n]{3,80}?)\s*:\s*([\d]+[,.][\d]{2})\s+([\d]+[,.][\d]{2})\s*€\/([\w\.]+)\s*€/g;
  let m;
  while ((m = shbRe.exec(fullText)) !== null) {
    const desc = m[1].trim().replace(/^0+\d+\s+/, '').trim();
    if (!desc || desc.length < 3 || /^[-_\s]+$/.test(desc)) continue;

    const pre   = fullText.substring(Math.max(0, m.index - 300), m.index);
    const menm  = pre.match(/Menge\s*[:\s]+\s*([\d,]+)\s*x/i);
    const menge = menm ? _parseDE(menm[1]) : 1;

    const post  = fullText.substring(m.index, m.index + 500);
    const mwstm = post.match(/MwSt\s*[:\s]+\s*([\d,]+)\s*%/i);
    const mwst  = mwstm ? _parseDE(mwstm[1]) : 19;

    items.push({
      beschreibung: desc,
      menge:        menge || 1,
      einheit:      _unitCode(m[4]),
      einzelpreis:  _parseDE(m[2]),
      mwst,
    });
  }
  if (items.length > 0) return items;

  // ── Pattern A2: "Name: Einzelpreis €/Einheit Gesamtpreis €"  (SHB-Format) ──
  // e.g. "Philips B Line 346B1C/00: 299,00 €/Stk 299,00 €"
  const shbRe2 = /([A-Za-zÄÖÜäöüß0-9][^:\n]{3,80}?)\s*:\s*([\d]+[,.][\d]{2})\s*€\/([\w\.]+)\s+([\d]+[,.][\d]{2})\s*€/g;
  while ((m = shbRe2.exec(fullText)) !== null) {
    const desc = m[1].trim().replace(/^\d+\.?\s+/, '').trim();
    if (!desc || desc.length < 3 || /^[-_\s]+$/.test(desc)) continue;

    const unitPrice = _parseDE(m[2]);
    const total     = _parseDE(m[4]);
    const menge     = unitPrice > 0 ? Math.round((total / unitPrice) * 1000) / 1000 : 1;
    const context   = fullText.substring(m.index, m.index + 400);
    const mwstm     = context.match(/MwSt\.?\s*[:\s]+\s*([\d,]+)\s*%/i) ||
                      context.match(/(\d{1,2})[,.]?0*\s*%/);
    const mwst      = mwstm ? parseFloat(mwstm[1]) : 19;

    items.push({
      beschreibung: desc,
      menge:        menge || 1,
      einheit:      _unitCode(m[3]),
      einzelpreis:  unitPrice,
      mwst,
    });
  }
  if (items.length > 0) return items;

  // ── Pattern B: Tabellen-Format "Bezeichnung  Menge  Einheit  Preis  MwSt%" ──
  const tableRe = /([A-Za-zÄÖÜäöüß0-9][^\n]{4,80})\s+([\d,]+)\s+(Stk|Std|h|kg|m|lfm|Psch|Pkt)\s+([\d,.]+)\s+(19|7|0),?0*\s*%/gi;
  while ((m = tableRe.exec(fullText)) !== null) {
    items.push({
      beschreibung: m[1].trim(),
      menge:        _parseDE(m[2]),
      einheit:      _unitCode(m[3]),
      einzelpreis:  _parseDE(m[4]),
      mwst:         parseFloat(m[5]),
    });
  }
  if (items.length > 0) return items;

  // ── Pattern C: Fallback — Nettowert als Einzelposition ──
  // Try to read the actual product/service description from the text before the total.
  const netm   = fullText.match(/Nettowert?\s*[:\s]+\s*([\d.]+,[\d]{2})\s*€/i) ||
                 fullText.match(/Netto(?:betrag|summe)?\s*[:\s]+\s*([\d.]+,[\d]{2})/i);
  const mwstPct = fullText.match(/MwSt\s*[:\s]+\s*([\d,]+)\s*%/i);
  if (netm) {
    const netIdx    = netm.index;
    const preceding = fullText.substring(Math.max(0, netIdx - 1500), netIdx);

    // Lines that are clearly NOT product descriptions
    const skipLine = /^(Re\.?-?(?:Nr|Datum)|Rechnungs|Liefer(?:datum|ung)?[:\s]|Zahlungs|Kunden-?Nr|Bestell|Pos(?:ition)?\.?\s*\d|Artikel-?Nr\.?|Beschreibung|Bezeichnung|Menge\s|Einheit\s|Einzel|Gesamt|Netto|Brutto|MwSt|USt|Summe|Total|Betrag|Seite\s*\d|Bank|IBAN|BIC|Tel\.?|Fax|E-?Mail|www\.|An\s|Von\s|Firma|PLZ|DIHAG|SHB)/i;

    const candidateLines = preceding
      .split('\n')
      .map(l => l.trim())
      .filter(l =>
        l.length >= 5 &&
        /[A-Za-zÄÖÜäöüß]{2,}/.test(l) &&  // at least 2 consecutive letters
        !/^\d+[.,]\d{2}/.test(l) &&        // not starting with amount
        !/^[\d\s.,/\-–]+$/.test(l) &&      // not purely numbers / separators
        !skipLine.test(l)
      );

    const descRaw = candidateLines.length > 0
      ? candidateLines[candidateLines.length - 1]
      : '';

    // Strip trailing price info: ": 299,00 €/Stk 299,00 €"  or  "299,00 €/Stk"
    const descClean = descRaw
      .replace(/\s*:\s*[\d.,]+\s*€\/[\w\.]+.*$/i, '')
      .replace(/\s+[\d.,]+\s*€\/[\w\.]+.*$/i, '')
      .trim();

    items.push({
      beschreibung: descClean.length >= 5 ? descClean : 'Lieferung / Leistung (aus Nettowert)',
      menge:        1,
      einheit:      'Pausch.',
      einzelpreis:  _parseDE(netm[1]),
      mwst:         mwstPct ? _parseDE(mwstPct[1]) : 19,
    });
  }

  return items;
}

/* ══════════════════════════════════════════════════════
   ENGLISCHE INDUSTRIERECHNUNG — Spezialisierte Extraktion
   (Walzengiesserei Coswig / PIOMBINO-Format)
══════════════════════════════════════════════════════ */

/**
 * Metadaten: Rechnungsnummer, Datum (DD.MM.YY → 4-stellig),
 * Lieferdatum, Fälligkeitsdatum
 */
function extractMetadataEnglish(fullText) {
  const r = {};

  // Rechnungsnummer: "Invoice Nr: 4240007"
  const invM = fullText.match(/Invoice\s*Nr[:\s]+(\d{4,12})/i);
  if (invM) r.rechnungsnummer = invM[1].trim();

  // Datum-Zeile nach Header "Delivery note Delivery date Date":
  // Datenzeile enthält "3240007  08.01.24  08.01.24" (Delivery date + Invoice date)
  const dtRowM = fullText.match(
    /Delivery\s+note\s+Delivery\s+date\s+Date[\s\S]{0,200}?(\d{2}\.\d{2}\.\d{2})\s+(\d{2}\.\d{2}\.\d{2})/i
  );
  if (dtRowM) {
    r.lieferdatum    = _deDate(_fixYear(dtRowM[1]));
    r.rechnungsdatum = _deDate(_fixYear(dtRowM[2]));
  }

  // Fälligkeitsdatum: "until 15.01.2024 net = 8.095,21 EUR"
  const dueM = fullText.match(/until\s+(\d{2}\.\d{2}\.\d{4})/i);
  if (dueM) r.faelligkeitsdatum = _deDate(dueM[1]);

  return r;
}

/**
 * Verkäufer: Name aus "Account holder:", IBAN, BIC, E-Mail
 * (Adresse ist in diesem PDF-Format nicht enthalten)
 */
function extractSellerEnglish(footerText, fullText) {
  const r = {};
  const src = footerText + '\n' + fullText;

  // Name aus "Account holder: Walzengiesserei Coswig GmbH"
  const ahM = fullText.match(/Account\s+holder[:\s]+(.+)/i);
  if (ahM) r.verkaeufer = ahM[1].trim().replace(/\s{2,}/g, ' ');

  // IBAN
  const ibanM = src.match(/IBAN[:\s·•|]+([A-Z]{2}\d{2}[\s\d]{10,30})/i);
  if (ibanM) r.iban = ibanM[1].replace(/\s/g, '');

  // BIC: sowohl "BIC:" als auch "BIC code:"
  const bicM = src.match(/BIC(?:\s+code)?[:\s·•|]+([A-Z]{6}[A-Z0-9]{2,5})/i);
  if (bicM) r.bic = bicM[1];

  // E-Mail (Operator-Zeile: "andreasbuchs@walze-coswig.de")
  const emailM = src.match(/([a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,})/);
  if (emailM) r.verkaeuferemail = emailM[1];

  return r;
}

/**
 * Käufer: Firmenname (international: S.p.A., Ltd, Inc. …),
 * Adresse, PLZ, Stadt, Land aus dem Adressblock links oben.
 * Käufer-USt-IdNr aus "Your VAT reg. no.:"
 */
function extractBuyerEnglish(leftColumnText, fullText) {
  const r = {};

  // Käufer-USt-IdNr: "Your VAT reg. no.: IT01804670493"
  const vatM = fullText.match(/Your\s+VAT\s+reg\.?\s*no\.?\s*[:\s]+([A-Z]{2}[\dA-Z]{2,12})/i);
  if (vatM) r.kaeufervatnr = vatM[1];  // gespeichert für Anzeige / Notiz

  if (!leftColumnText) return r;

  // Internationale Rechtsformen
  const intlForms = /S\.p\.A\.|S\.A\.|S\.r\.l\.|Ltd\.?|Inc\.?|Corp\.?|GmbH|AG|B\.V\.|N\.V\.|Oy|A\/S|PLC/i;

  const lines = leftColumnText
    .split('\n')
    .map(l => l.trim())
    .filter(l => l.length > 1);

  const ci = lines.findIndex(l => intlForms.test(l));
  if (ci < 0) return r;

  r.kaeufer = lines[ci];

  // Zeilen nach Firmenname auswerten
  const skipLine = /^(Administrative|Office|Department|Attn|c\/o|P\.O\.\s*Box|Abt\.)/i;

  for (const line of lines.slice(ci + 1)) {
    // PLZ + Stadt: "57025 PIOMBINO (LI)" oder "D-04610 Meuselwitz"
    const plzM = line.match(/[A-Z]?-?(\d{4,6})\s+([A-ZÄÖÜ][A-ZÄÖÜa-zäöüß\s\-()/]+?)(?:\s+\([A-Z]{2}\))?$/);
    if (plzM && !r.kaeuferplz) {
      r.kaeuferplz   = plzM[1];
      r.kaeuferstadt = plzM[2].trim();
      continue;
    }

    // Land: Zeile nur aus Großbuchstaben "ITALIEN", "GERMANY" …
    if (/^[A-ZÄÖÜ\s]{4,20}$/.test(line) && !r.kaeuferland) {
      r.kaeuferland = _countryCode(line.trim());
      continue;
    }

    // Straße: erste sinnvolle Zeile, keine Skip-Zeile, noch keine PLZ
    if (!r.kaeuferstrasse && !r.kaeuferplz && !skipLine.test(line)) {
      r.kaeuferstrasse = line;
    }
  }

  return r;
}

/**
 * Positionen: Produktcode + "N pcs." + Einzelpreis + Gesamtpreis
 * Beschreibung aus der Folgezeile.
 * Überspringt Prepayment-Zeilen (Anzahlungen).
 * MwSt immer 0 % (innergemeinschaftliche Lieferung).
 */
function extractLineItemsEnglish(fullText) {
  const items  = [];
  const lines  = fullText.split('\n');

  // Muster: [Pos] ProduktCode ... N pcs. Einzelpreis Gesamtpreis
  // z. B. "1    31857                             1 pcs.   55.187,37     55.187,37"
  // oder  "     14166                             1 pcs.   6.549,64       6.549,64"
  const itemRe = /(?:^\s*\d+\s+)?(\d{4,6})\s[\s\S]*?(\d+)\s+pcs\.\s+([\d.]+,\d{2})\s+([\d.]+,\d{2})/;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // Summen-/Anzahlungs-/Steuerzeilen überspringen
    if (/^\s*(Total|Prepayment|Tax|Note to|We confirm|We kindly|Country of|Herewith)\b/i.test(line)) continue;

    const m = line.match(itemRe);
    if (!m) continue;

    const productCode = m[1];
    const menge       = parseFloat(m[2]) || 1;
    const einzelpreis = _parseDE(m[3]);

    // Beschreibung: nächste Nicht-Leer-Zeile, die keine technische Detailzeile ist
    let desc = productCode;
    for (let j = i + 1; j < lines.length && j <= i + 4; j++) {
      const nl = lines[j].trim();
      if (!nl) continue;
      if (/^(Your Order|Our order|Drawing|Dimensions|Quality|Weight|Surface|No of|Prepayment|Total|\d{4,6}\s)/i.test(nl)) break;
      desc = nl;
      break;
    }

    items.push({
      beschreibung: `${productCode} – ${desc}`,
      menge,
      einheit:      'Stk',
      einzelpreis,
      mwst:         0,  // VAT-exempt: steuerfreie innergemeinschaftliche Lieferung
    });
  }

  return items;
}

/* ══════════════════════════════════════════════════════
   Helpers
══════════════════════════════════════════════════════ */
function _try(text, patterns, fn) {
  for (const p of patterns) {
    const m = text.match(p);
    if (m) { fn(m); return true; }
  }
  return false;
}

function _deDate(s) {
  const [d, mo, y] = s.split('.');
  return `${y}-${mo.padStart(2, '0')}-${d.padStart(2, '0')}`;
}

function _parseDE(s) {
  return parseFloat(String(s).replace(/\./g, '').replace(',', '.')) || 0;
}

function _unitCode(u) {
  const map = {
    Stk: 'Stk', St: 'Stk', Anz: 'Stk',
    HUR: 'h', h: 'h', Std: 'h', Stunde: 'h',
    kg: 'kg', m: 'm', km: 'km',
    LS: 'Pausch.', Psch: 'Pausch.',
  };
  return map[u] || 'Stk';
}

/**
 * Zweistelliges Jahr → vierstellig: "24" → "2024", "99" → "1999"
 * "08.01.24" → "08.01.2024"
 */
function _fixYear(dateStr) {
  return dateStr.replace(/^(\d{2}\.\d{2}\.)(\d{2})$/, (_, dm, yy) => {
    const year = parseInt(yy, 10) + (parseInt(yy, 10) >= 50 ? 1900 : 2000);
    return dm + year;
  });
}

/**
 * Ländername (englisch/deutsch) → ISO 3166-1 Alpha-2
 */
function _countryCode(name) {
  const map = {
    'ITALIEN': 'IT', 'ITALY': 'IT',
    'DEUTSCHLAND': 'DE', 'GERMANY': 'DE',
    'FRANKREICH': 'FR', 'FRANCE': 'FR',
    'ÖSTERREICH': 'AT', 'AUSTRIA': 'AT',
    'SPANIEN': 'ES', 'SPAIN': 'ES',
    'NIEDERLANDE': 'NL', 'NETHERLANDS': 'NL',
    'BELGIEN': 'BE', 'BELGIUM': 'BE',
    'SCHWEIZ': 'CH', 'SWITZERLAND': 'CH',
    'GROSSBRITANNIEN': 'GB', 'UNITED KINGDOM': 'GB',
    'TSCHECHIEN': 'CZ', 'CZECH REPUBLIC': 'CZ',
    'POLEN': 'PL', 'POLAND': 'PL',
  };
  return map[name.toUpperCase()] || name.slice(0, 2).toUpperCase();
}

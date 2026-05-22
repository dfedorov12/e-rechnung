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

  return {
    ...extractMetadata(rightText, fullText),
    ...extractSeller(footerText, fullText),
    ...extractBuyer(leftColumnText, leftText, fullText),
    positionen: extractLineItems(fullText),
  };
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
        x: item.transform[4],
        y: item.transform[5],
        pw: vp.width,
        ph: vp.height,
      });
    }
  }

  // Top → bottom, left → right
  allItems.sort((a, b) => b.y - a.y || a.x - b.x);

  /** Cluster items into visual lines (±4 pt) and return newline-joined string */
  function toLines(items) {
    const map = {};
    for (const it of items) {
      const ky = Math.round(it.y / 4) * 4;
      if (!map[ky]) map[ky] = [];
      map[ky].push(it);
    }
    return Object.values(map)
      .sort((a, b) => b[0].y - a[0].y)
      .map(ls => ls.sort((a, b) => a.x - b.x).map(i => i.text).join(' '))
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

  // USt-IdNr — "DE 812 264 517", "DE812264517", "DE  812  264  517"
  // Separator between label and value: space, colon, middle-dot (·), pipe, etc.
  const vatm = src.match(/USt-?Id\.?-?Nr\.?[\s:·|]*\s*(DE(?:\s*\d){9})/i);
  if (vatm) r.verkaeufervat = vatm[1].replace(/\s/g, '');

  // Steuernummer — "232/118/07369"
  const stm = src.match(/Steuer-?(?:Nr\.?|nummer)[\s:·|]*\s*(\d{1,3}\/\d{2,3}\/\d{4,8})/i);
  if (stm) r.verkaeufersteuernr = stm[1];

  // IBAN
  const ibanm = src.match(/IBAN[\s:·|]*\s*(DE\d{2}(?:[\s\d]{15,27}))/i);
  if (ibanm) r.iban = ibanm[1].replace(/\s/g, '');

  // BIC
  const bicm = src.match(/BIC[\s:·|]*\s*([A-Z]{4}[A-Z]{2}[A-Z0-9]{2}(?:[A-Z0-9]{3})?)/i);
  if (bicm) r.bic = bicm[1];

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
  const netm   = fullText.match(/Nettowert?\s*[:\s]+\s*([\d.]+,[\d]{2})\s*€/i) ||
                 fullText.match(/Netto(?:betrag|summe)?\s*[:\s]+\s*([\d.]+,[\d]{2})/i);
  const mwstPct = fullText.match(/MwSt\s*[:\s]+\s*([\d,]+)\s*%/i);
  if (netm) {
    items.push({
      beschreibung: 'Lieferung / Leistung (aus Nettowert)',
      menge:        1,
      einheit:      'Pausch.',
      einzelpreis:  _parseDE(netm[1]),
      mwst:         mwstPct ? _parseDE(mwstPct[1]) : 19,
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

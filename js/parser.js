/**
 * PDF Invoice Parser
 * Extracts structured invoice data from German PDF invoices using PDF.js text content.
 * Strategy: column-aware extraction (left = recipient, right = metadata) + full-text regex.
 */

async function extractInvoiceData(pdfDoc) {
  const { fullText, leftText, rightText, lines } = await _extractTextSections(pdfDoc);

  return {
    ...extractMetadata(rightText, fullText),
    ...extractSeller(fullText),
    ...extractBuyer(fullText, leftText),
    positionen: extractLineItems(fullText),
  };
}

/* ── Text Extraction ── */
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
        x:    item.transform[4],
        y:    item.transform[5],
        pw:   vp.width,          // page width for column split
        ph:   vp.height,
      });
    }
  }

  // Sort top-to-bottom, left-to-right
  allItems.sort((a, b) => b.y - a.y || a.x - b.x);

  // Cluster into visual lines (items with similar y within ±3pt)
  const lineMap = {};
  for (const it of allItems) {
    const ky = Math.round(it.y / 4) * 4;
    if (!lineMap[ky]) lineMap[ky] = [];
    lineMap[ky].push(it);
  }
  const lines = Object.values(lineMap)
    .sort((a, b) => b[0].y - a[0].y)
    .map(ls => ls.sort((a, b) => a.x - b.x).map(i => i.text).join(' '));

  const fullText  = lines.join('\n');
  const leftText  = allItems.filter(i => i.x < i.pw * 0.48).map(i => i.text).join(' ');
  const rightText = allItems.filter(i => i.x > i.pw * 0.48).map(i => i.text).join(' ');

  return { fullText, leftText, rightText, lines };
}

/* ── Metadata (Rechnungsnummer, Datum, etc.) ── */
function extractMetadata(rightText, fullText) {
  const r = {};
  const src = rightText + '\n' + fullText; // prefer right column but fall back

  _try(src, [
    /Rechnungs-?Nr\.?\s*[:\s]+([A-Z0-9][A-Z0-9\-\/\.]{2,20})/i,
    /Invoice\s*(?:No|Nr)\.?\s*[:\s]+([A-Z0-9][A-Z0-9\-\/\.]{2,20})/i,
  ], m => r.rechnungsnummer = m[1].trim());

  _try(src, [
    /Re\.?-?Datum\s*[:\s]+(\d{2}\.\d{2}\.\d{4})/i,
    /Rechnungsdatum\s*[:\s]+(\d{2}\.\d{2}\.\d{4})/i,
    /Datum\s*[:\s]+(\d{2}\.\d{2}\.\d{4})/,
  ], m => r.rechnungsdatum = _deDate(m[1]));

  // Leistungsdatum — first occurrence (not the one embedded in position blocks)
  const ldm = src.match(/Leistungs-?Dat\.?\s*[:\s]+(\d{2}\.\d{2}\.\d{4})/i);
  if (ldm) r.lieferdatum = _deDate(ldm[1]);

  // Zahlungsreferenz = Rechnungsnummer by default (filled later in app.js)
  // Notiz from Zahlungsbedingung
  const zbm = fullText.match(/Zahlungsbedingung\s*[:\s]+(.{5,100})/i);
  if (zbm) r.notiz = 'Zahlungsbedingung: ' + zbm[1].trim().replace(/\s+/g, ' ');

  return r;
}

/* ── Seller (Rechnungssteller) ── */
function extractSeller(fullText) {
  const r = {};

  // USt-IdNr — handle "DE 812 264 517" (with spaces)
  const vatm = fullText.match(/USt-?IdNr\.?\s*[^\w\n]{0,4}\s*(DE[\s\d]{9,14})/i);
  if (vatm) r.verkaeufervat = vatm[1].replace(/\s/g, '');

  // Steuernummer
  const stm = fullText.match(/Steuer-?Nr\.?\s*[^\w\n]{0,4}\s*([\d]+\/[\d\/]+)/i);
  if (stm) r.verkaeufersteuernr = stm[1];

  // IBAN
  const ibanm = fullText.match(/IBAN\s*[^\w\n]{0,4}\s*(DE\d{2}[\d\s]{15,25})/i);
  if (ibanm) r.iban = ibanm[1].replace(/\s/g, '');

  // BIC
  const bicm = fullText.match(/BIC\s*[^\w\n]{0,4}\s*([A-Z]{4}[A-Z]{2}[A-Z0-9]{2}(?:[A-Z0-9]{3})?)/i);
  if (bicm) r.bic = bicm[1];

  // Seller name + address from footer/Absenderzeile
  // Pattern 1: "Name • Straße • PLZ Stadt" — any non-word/non-hyphen separator char (•, ·, |, ●, ▪, …)
  const dotPat = /([A-ZÄÖÜ].+?(?:GmbH|AG|KG|OHG|SE|UG|e\.V\.))\s*[^\wäöüÄÖÜß\s\n\-,\.]{1,3}\s*(.+?(?:str(?:aße|\.)?|[Ww]eg|[Gg]asse|[Pp]latz|[Ss]traße).+?)\s*[^\wäöüÄÖÜß\s\n\-,\.]{1,3}\s*(\d{4,5})\s+([A-ZÄÖÜa-zäöüß][A-ZÄÖÜa-zäöüß\-]+)/i;
  // Pattern 2: "Name - Str. - PLZ Stadt" — space REQUIRED on both sides of dash (avoids matching hyphens inside "Stahl- und Hartgusswerk")
  const dashPat = /([A-ZÄÖÜ].+?(?:GmbH|AG|KG|OHG|SE|UG))\s{1,3}-\s{1,3}(.+?(?:str(?:aße|\.)?|[Ww]eg|[Gg]asse|[Ss]tr\.).+?)\s{1,3}-\s{1,3}(\d{4,5})\s+([A-ZÄÖÜa-zäöüß][A-ZÄÖÜa-zäöüß\-]+)/i;

  for (const pat of [dotPat, dashPat]) {
    const m = fullText.match(pat);
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

/* ── Buyer (Rechnungsempfänger) ── */
function extractBuyer(fullText, leftText) {
  const r = {};

  // The recipient block is in the left column, between the sender line and "Rechnungs-Nr."
  // In the full text it appears as: RECHNUNG ... (sender address) ... (recipient lines) ... Rechnungs-Nr.
  const blockMatch = fullText.match(/RECHNUNG[\s\S]{0,300}?(\n[A-ZÄÖÜ][^\n]+(?:GmbH|AG|KG|GbR|e\.V\.|GmbH & Co|mbH)[^\n]*\n[\s\S]{0,300}?)Rechnungs-?Nr/i);

  if (blockMatch) {
    const block = blockMatch[1];
    // Filter out Absenderzeile: "Company GmbH - Straße - PLZ Stadt" (small sender line above address window)
    const absenderPat = /^[A-ZÄÖÜ].+?(?:GmbH|AG|KG|UG)\s+-\s+.+?\s+-\s+\d{4,5}/;
    const rawLines = block.split('\n').map(l => l.trim()).filter(l =>
      l.length > 2 && !/^[-_]+$/.test(l) && !absenderPat.test(l)
    );

    // First line = company name
    if (rawLines[0]) r.kaeufer = rawLines[0];

    // PLZ + Stadt (format: "D-04610 Meuselwitz" or "04610 Meuselwitz")
    const plzm = block.match(/[A-Z]?-?(\d{5})\s+([A-ZÄÖÜa-zäöüß\-]+)/);
    if (plzm) { r.kaeuferplz = plzm[1]; r.kaeuferstadt = plzm[2]; }

    // Street: a line that has digits but is not a PLZ line and not the company name
    for (const line of rawLines.slice(1)) {
      if (/\d/.test(line) && !line.match(/^\d{5}/) && !line.match(/[A-Z]-?\d{5}/)) {
        r.kaeuferstrasse = line; break;
      }
      // Street without house number (e.g., "Industriepark Nord")
      if (!r.kaeuferstrasse && line !== r.kaeufer && !line.match(/\d{4,5}/)) {
        r.kaeuferstrasse = line;
      }
    }

    r.kaeuferland = 'DE';
  }

  // Fallback: use left-column text
  if (!r.kaeufer && leftText) {
    const leftLines = leftText.split(/\s{3,}|\n/).map(s => s.trim()).filter(Boolean);
    const compIdx = leftLines.findIndex(l => /GmbH|AG|KG|GbR/i.test(l));
    if (compIdx >= 0) {
      r.kaeufer = leftLines[compIdx];
      if (leftLines[compIdx + 1]) r.kaeuferstrasse = leftLines[compIdx + 1];
      const plzm = leftText.match(/[A-Z]?-?(\d{5})\s+([A-ZÄÖÜa-zäöüß]+)/);
      if (plzm) { r.kaeuferplz = plzm[1]; r.kaeuferstadt = plzm[2]; }
      r.kaeuferland = 'DE';
    }
  }

  return r;
}

/* ── Line Items ── */
function extractLineItems(fullText) {
  const items = [];

  // ── Pattern A (SHB format) ──
  // "Artikel-Name : UnitPrice TotalPrice €/Unit €"
  // e.g.: "Philips B Line 346B1C/00 : 299,00 299,00 €/Stk €"
  const shbRe = /([A-Za-zÄÖÜäöüß0-9][^:\n]{3,80}?)\s*:\s*([\d]+[,.][\d]{2})\s+([\d]+[,.][\d]{2})\s*€\/([\w\.]+)\s*€/g;
  let m;
  while ((m = shbRe.exec(fullText)) !== null) {
    const desc = m[1].trim().replace(/^0+\d+\s+/, '').trim(); // strip leading "0001 "
    if (!desc || desc.length < 3) continue;
    if (/^[-_\s]+$/.test(desc)) continue;

    // Menge: look backwards for "Menge : X,XX x"
    const pre  = fullText.substring(Math.max(0, m.index - 300), m.index);
    const menm = pre.match(/Menge\s*[:\s]+\s*([\d,]+)\s*x/i);
    const menge = menm ? _parseDE(menm[1]) : 1;

    // MwSt: look forwards
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

  // ── Pattern B: "Bezeichnung    Menge Einheit    Einzelpreis    MwSt%" ──
  // Typical table row format
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

  // ── Pattern C: Fallback — use Nettowert as single position ──
  const netm = fullText.match(/Nettowert?\s*[:\s]+\s*([\d.]+,[\d]{2})\s*€/i) ||
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

/* ── Helpers ── */
function _try(text, patterns, fn) {
  for (const p of patterns) {
    const m = text.match(p);
    if (m) { fn(m); return true; }
  }
  return false;
}

function _deDate(s) {
  const [d, mo, y] = s.split('.');
  return `${y}-${mo.padStart(2,'0')}-${d.padStart(2,'0')}`;
}

function _parseDE(s) {
  return parseFloat(String(s).replace(/\./g, '').replace(',', '.')) || 0;
}

function _unitCode(u) {
  const map = { Stk:'Stk', St:'Stk', Anz:'Stk', HUR:'h', h:'h', Std:'h', Stunde:'h',
                kg:'kg', m:'m', km:'km', 'LS':'Pausch.', Psch:'Pausch.' };
  return map[u] || 'Stk';
}

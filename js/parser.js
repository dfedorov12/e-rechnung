/**
 * PDF Invoice Parser
 * Extracts structured invoice data from German PDF invoices using PDF.js text content.
 * Strategy:
 *   - footerText      → seller (USt-IdNr, Steuer-Nr, IBAN, BIC, Adresse)
 *   - leftColumnText  → buyer (Adressfenster links oben)
 *   - rightText       → metadata (Rechnungsnummer, Datum, …)
 *   - _COMPANY_REGISTRY → bekannte Rechnungssteller (WGC, SHB) werden am PDF
 *                         erkannt und vollständig vorausgefüllt
 */

/* ══════════════════════════════════════════════════════
   Bekannte Rechnungssteller — Stammdaten-Registry
   Erkennung erfolgt automatisch anhand von PDF-Inhalt.
   Registry-Daten überschreiben extrahierte Seller-Felder
   (kanonische Quelle für Adresse, USt-IdNr., Kontakt).
══════════════════════════════════════════════════════ */
const _COMPANY_REGISTRY = {

  WGC: {
    verkaeufer:         'Walzengießerei Coswig GmbH',
    verkaeufstrasse:    'Grenzstraße 1',
    verkaeufplz:        '01640',
    verkaeufstadt:      'Coswig',
    verkaeufland:       'DE',
    verkaeuftel:        '+49 3523 950',
    verkaeuferemail:    'wgc@walze-coswig.de',
    verkaeufervat:      'DE140598967',
    verkaeufersteuernr: '209/197/00034',
    iban:               'DE33820700000130805501',
    bic:                'DEUTDE8EXXX',
    // detect: E-Mail-Domain oder Firmenname im PDF
    _detect: /walze-coswig|walzengi.{0,6}erei\s+coswig|account\s+holder[:\s]+walzen/i,
  },

  SHB: {
    verkaeufer:         'SHB Stahl- und Hartgusswerk Bösdorf GmbH',
    verkaeufstrasse:    'Werkstraße 7',
    verkaeufplz:        '04249',
    verkaeufstadt:      'Leipzig',
    verkaeufland:       'DE',
    verkaeuftel:        '+49 341 42 79 0',
    verkaeuferemail:    'sales@shb-guss.de',
    verkaeufervat:      'DE812264517',
    verkaeufersteuernr: '232/118/07369',
    // Zahlungskonto laut Rechnungsfuß ("Wir erbitten die Zahlungen … IBAN: DE 77 … 01")
    iban:               'DE77820700000338669501',
    bic:                'DEUTDE8EXXX',
    // detect: E-Mail-Domain, Firmenname oder „Bösdorf" im PDF
    _detect: /shb-guss|bösdorf|b.sdorf|stahl-?\s*und\s*hartguss|shb\s+stahl/i,
  },

};

/**
 * Erkennt den Rechnungssteller anhand des PDF-Volltexts.
 * Gibt die Registry-Daten (ohne _detect) zurück oder null.
 */
function _detectCompany(fullText) {
  for (const [, entry] of Object.entries(_COMPANY_REGISTRY)) {
    if (entry._detect.test(fullText)) {
      const { _detect, ...data } = entry;   // _detect nicht ins Ergebnis
      return data;
    }
  }
  return null;
}

/**
 * Bequemer Einstieg: sammelt Text-Items aus dem PDF (PDF.js-Textebene)
 * und extrahiert daraus die Rechnungsdaten.
 */
async function extractInvoiceData(pdfDoc) {
  const items = await collectPdfItems(pdfDoc);
  return extractInvoiceDataFromItems(items);
}

/**
 * Extrahiert Rechnungsdaten aus einer Liste von Text-Items.
 * Items stammen entweder aus der PDF-Textebene (collectPdfItems)
 * oder aus der OCR-Texterkennung (ocr.js → ocrCollectItems).
 * Item-Form: { text, x, y, pw, ph, w, page }
 */
function extractInvoiceDataFromItems(allItems) {
  const { fullText, leftText, leftColumnText, rightText, footerText, buyerBlock } =
    _buildSections(allItems);

  let result;

  // Englischsprachige WGC-Rechnung (Item/Product/pcs.-Format)
  if (_isEnglishIndustrialInvoice(fullText)) {
    result = {
      ...extractMetadataEnglish(fullText),
      ...extractSellerEnglish(footerText, fullText),
      ...extractBuyerEnglish(leftColumnText, fullText),
      positionen: extractLineItemsEnglish(fullText),
    };
  // Deutschsprachige WGC-Rechnung (Pos/Artikel/Stück-Format)
  } else if (_isGermanWGCInvoice(fullText)) {
    result = {
      ...extractMetadataGermanWGC(fullText),
      ...extractSeller(footerText, fullText),
      ...extractBuyerWGCGerman(leftColumnText, leftText, fullText),
      positionen: extractLineItemsGermanWGC(fullText),
    };
  // SHB-Rechnung (Bezeichnung/Preis/Nettowert-Format)
  } else if (_isGermanSHBInvoice(fullText)) {
    result = {
      ...extractMetadataGermanSHB(fullText),
      ...extractSeller(footerText, fullText),
      ...extractBuyerGermanSHB(buyerBlock, fullText),
      positionen: extractLineItemsGermanSHB(fullText),
    };
  } else {
    result = {
      ...extractMetadata(rightText, fullText),
      ...extractSeller(footerText, fullText),
      ...extractBuyer(leftColumnText, leftText, fullText),
      positionen: extractLineItems(fullText),
    };
  }

  // Bekannten Rechnungssteller erkennen → Stammdaten vollständig überschreiben
  const company = _detectCompany(fullText);
  if (company) Object.assign(result, company);

  return result;
}

/* ══════════════════════════════════════════════════════
   Detektoren: WGC-Rechnungsformate
══════════════════════════════════════════════════════ */
function _isEnglishIndustrialInvoice(text) {
  return /Invoice\s*Nr[:\s]/i.test(text) &&
         /\bpcs\./i.test(text) &&
         /Item\s+Product\s+Quantity\s+Unit\s+price/i.test(text);
}

function _isGermanWGCInvoice(text) {
  return /Pos\s+Artikel\s+Menge\s+Einzelpreis/i.test(text) &&
         /walze-coswig|walzengi/i.test(text);
}

function _isGermanSHBInvoice(text) {
  return /Rechnungs-Nr\.\s*:/i.test(text) &&
         /Nettowert\s*:/i.test(text) &&
         /(shb-guss|bösdorf|b.sdorf|Hartgusswerk)/i.test(text);
}

/* ══════════════════════════════════════════════════════
   DEUTSCHSPRACHIGE WGC-RECHNUNG
   (TKP, NEUMAN, FAIR, VOESTDON — Pos/Artikel/Stück)
══════════════════════════════════════════════════════ */

function extractMetadataGermanWGC(fullText) {
  const r = {};

  // Rechnungsnummer: "Rechnung  Nr: 4260264"
  const invM = fullText.match(/Rechnung\s+Nr[:\s]+(\d{4,12})/i);
  if (invM) r.rechnungsnummer = invM[1];

  // Datum-Zeile: "Lieferdatum Datum" + Datenzeile "08.05.26  12.05.26"
  const dtM = fullText.match(
    /Lieferdatum\s+Datum[\s\S]{0,200}?(\d{2}\.\d{2}\.\d{2})\s+(\d{2}\.\d{2}\.\d{2})/i
  );
  if (dtM) {
    r.lieferdatum    = _deDate(_fixYear(dtM[1]));
    r.rechnungsdatum = _deDate(_fixYear(dtM[2]));
  }

  // Fälligkeitsdatum: "zum 26.05.2026"
  const dueM = fullText.match(/zum\s+(\d{2}\.\d{2}\.\d{4})/i);
  if (dueM) r.faelligkeitsdatum = _deDate(dueM[1]);

  return r;
}

/**
 * Käufer für deutsche WGC-Rechnungen.
 * Adressblock links oben; PLZ-Format oft "DE 59269 Beckum".
 */
function extractBuyerWGCGerman(leftColumnText, leftText, fullText) {
  const r = extractBuyer(leftColumnText, leftText, fullText);

  // Fallback: PLZ-Muster "DE 59269 Stadt" oder "CZ 73961 TRINEC"
  if (!r.kaeuferplz && leftColumnText) {
    const plzM = leftColumnText.match(
      /\b([A-Z]{2})\s+(\d{4,5})\s+([A-ZÄÖÜ][A-ZÄÖÜa-zäöüß\s\-]+)/
    );
    if (plzM) {
      r.kaeuferland  = plzM[1];
      r.kaeuferplz   = plzM[2];
      r.kaeuferstadt = plzM[3].trim().split(/\s{2,}/)[0];
    }
  }

  return r;
}

/**
 * Positionen für deutsche WGC-Rechnungen.
 * Format: [Pos] Artikel Menge Stück Einzelpreis [%] Gesamtpreis
 * Beschreibung steht auf der Folgezeile.
 * MwSt wird aus der "MWSt." Summenzeile gelesen.
 */
function extractLineItemsGermanWGC(fullText) {
  const items = [];
  const lines = fullText.split('\n');

  // Dokument-MwSt aus Summenzeile "MWSt.  nettobetrag  19,00  steuer"
  const mwstDocM = fullText.match(/MWSt\.\s+[\d.,]+\s+(\d{1,2})(?:,\d+)?\s+[\d.,]+/i);
  const mwstDoc  = mwstDocM ? parseFloat(mwstDocM[1]) : 0;

  // Strukturzeilen, die definitiv keine Positionen oder Beschreibungen sind
  const skipRe = /^(?:Nettosumme|Zwischensumme|Endsumme|MWSt|Anzahlung|CDR|FDR|FAT|SAT|Rechnung\s+Nr|Seite\s*\d|Pos\s+Artikel|^EUR\b|Versandart|Lieferbedingung|Zahlung|Hinweis|Warenursprung|HS-Code|Hiermit|Ware\s+bleibt|Zeitpunkt|Bank|Konto|IBAN|BIC|Wir\s+bitten)/i;

  // WGC-spezifische technische Detailzeilen (Bestellreferenzen, Maßdaten, Werkstoff …)
  // BEWUSST ENG: echte Beschreibungen wie "Material documentation", "Shielding block"
  // oder "External verification" dürfen NICHT hier stehen!
  const techRe = /^(?:Ihre\s+Bestellung|Auftrags-Nr|Kundenzeichn|Modellnummer|Abmessung|Werkstoff|Masse\s*[\/|]|Ober|Produktions|Verbringung|Abgang|Lieferreferenz|z\.\s*Zt\.|KE\d|Pattern\s+\d)/i;

  // Positionszeile: [Nr.] ArtikelCode Menge Einheit [...]
  // \s* statt \s+: toleriert PDF.js-Glyphen ohne Zwischenraum (gap < 2 pt)
  // Einheiten: St(ück)/VE/Stk/ME/Pce/pcs
  const itemRe = /^(?:\d+(?:\.\d+)?\s+)?(\d{2,6})\s+(\d+)\s*(?:St|VE|Stk|ME|Pce|pcs)/i;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line || skipRe.test(line)) continue;

    const codeM = line.match(itemRe);
    if (!codeM) continue;

    const code  = codeM[1];
    const menge = parseFloat(codeM[2]) || 1;

    // Beträge in der aktuellen Zeile — Minus-Zeichen miterfassen (Gutschriften)
    let amounts = (line.match(/-?[\d.]+,\d{2}/g) || []).map(_parseDE);

    // Fallback: Beträge auf der nächsten Zeile (manche PDFs brechen die Zeile um)
    if (amounts.length === 0) {
      for (let k = i + 1; k <= i + 2 && k < lines.length; k++) {
        const nl = lines[k].trim();
        if (nl && /^[-\d.,\s]+$/.test(nl)) {
          amounts = (nl.match(/-?[\d.]+,\d{2}/g) || []).map(_parseDE);
          break;
        }
      }
    }
    if (amounts.length === 0) continue;

    const total       = amounts[amounts.length - 1];
    const einzelpreis = menge > 0 ? total / menge : amounts[0];

    // Beschreibung: erste sinnvolle Folgezeile (nicht techn. Detail, nicht Nummer, nicht zu kurz)
    let desc = code;
    for (let j = i + 1; j <= i + 6 && j < lines.length; j++) {
      const nl = lines[j].trim();
      if (!nl) continue;
      if (skipRe.test(nl) || techRe.test(nl)) continue;   // Strukturzeile / techn. Detail
      if (itemRe.test(nl)) break;                           // nächste Position beginnt
      if (/^[-\d.,\s]{2,}$/.test(nl)) continue;            // reine Zahlenzeile
      if (nl.length < 3) continue;                          // zu kurz
      desc = nl;
      break;
    }

    items.push({
      beschreibung: `${code} – ${desc}`,
      menge,
      einheit:      'Stk',
      einzelpreis,
      mwst:         mwstDoc,
    });
  }

  // Endsumme-Prüfung: stimmt die Summe der Positionen mit der Nettosumme überein?
  return _validateAndFallback(items, _extractNetTotalGermanWGC(fullText), mwstDoc);
}

/* ══════════════════════════════════════════════════════
   SHB-RECHNUNG (Stahl- und Hartgusswerk Bösdorf GmbH)
   Format: Bezeichnung / Preis €/ME Gesamt / Nettowert
══════════════════════════════════════════════════════ */

function extractMetadataGermanSHB(fullText) {
  const r = {};

  // Rechnungsnummer: "Rechnungs-Nr. : 2600290"
  const nrM = fullText.match(/Rechnungs-Nr\.\s*:\s*(\d{4,12})/i);
  if (nrM) r.rechnungsnummer = nrM[1];

  // Rechnungsdatum: "Re.-Datum : 08.05.2026"
  const datM = fullText.match(/Re\.-Datum\s*:\s*(\d{2}\.\d{2}\.\d{4})/i);
  if (datM) r.rechnungsdatum = _deDate(datM[1]);

  // Leistungs-/Lieferdatum: "Leistungs-Dat. : 08.05.2026"
  const leistM = fullText.match(/Leistungs-Dat\.\s*:\s*(\d{2}\.\d{2}\.\d{4})/i);
  if (leistM) r.lieferdatum = _deDate(leistM[1]);

  // Fälligkeit: "Zahlungseingang : Bis zum 07.07.2026 netto"
  const faellM = fullText.match(/Zahlungseingang\s*:\s*Bis\s+zum\s+(\d{2}\.\d{2}\.\d{4})/i);
  if (faellM) r.faelligkeitsdatum = _deDate(faellM[1]);

  return r;
}

/**
 * Käufer aus dem SHB-Adressfenster (Seite 1, links oben).
 * Block-Aufbau: [Name (1-2 Zeilen)] [Abteilung] [Straße/Postfach] [D-PLZ Ort]
 */
function extractBuyerGermanSHB(buyerBlock, fullText) {
  const r = { kaeuferland: 'DE' };

  const lines = (buyerBlock || '')
    .split('\n')
    .map(l => l.trim())
    .filter(Boolean)
    // SHB-Absenderzeile entfernen ("...Hartgusswerk Bösdorf GmbH - Werkstr. 7...")
    .filter(l => !/Hartgusswerk\s+B.sdorf|Werkstr\.\s*7/i.test(l))
    .slice(0, 8);

  if (lines.length === 0) return r;

  // PLZ/Ort: "D-16748 Hennigsdorf"  (Länderpräfix D-, dann PLZ, dann Ort)
  const plzIdx = lines.findIndex(l => /^[A-Z]{0,2}-?\d{4,5}\s+\S/.test(l));
  if (plzIdx >= 0) {
    const plzM = lines[plzIdx].match(/^([A-Z]{0,2})-?(\d{4,5})\s+(.+)$/);
    if (plzM) {
      r.kaeuferland  = (!plzM[1] || plzM[1] === 'D') ? 'DE' : plzM[1];
      r.kaeuferplz   = plzM[2];
      r.kaeuferstadt = plzM[3].trim();
    }
    // Straße = Zeile direkt vor der PLZ-Zeile
    if (plzIdx >= 1) r.kaeuferstrasse = lines[plzIdx - 1];
  }

  // Name = erste Zeile; fehlt die Rechtsform, zweite (ziffernlose) Zeile anhängen
  // (z.B. "KOMATSU" + "Germany GmbH")
  const legalForm = /\b(GmbH|AG|KG|SE|mbH|e\.K\.|OHG|Co\b|S\.p\.A\.)/i;
  let name = lines[0];
  if (!legalForm.test(name) && lines.length > 1 && legalForm.test(lines[1]) && !/\d/.test(lines[1])) {
    name = `${name} ${lines[1]}`;
  }
  r.kaeufer = name;

  return r;
}

/**
 * Positionen für SHB-Rechnungen.
 *   0001 ...
 *   Bezeichnung : <Text> <Menge> <Einheit>
 *   Preis [...] : <Einzel> €/<Einheit> <Gesamt> €     (Hauptposition)
 *   Modelleinrichtung : <Einzel> €/Pos. <Gesamt> €    (Hauptposition)
 *   MTZ | ETZ : <Einzel> €/kg <Gesamt> €              (Zuschlag → eigene Position)
 * Auch kombinierte Zeilen ("Preis inkl. ETZ/MTZ nach VB 2.045,69 €/Stk 20.456,90 €").
 * Einzelpreis wird als Gesamt/Menge gesetzt → Summe bleibt exakt.
 */
function extractLineItemsGermanSHB(fullText) {
  const items = [];
  const lines = fullText.split('\n');

  const mwstM   = fullText.match(/MwSt\s*:\s*(\d{1,2})(?:,\d+)?\s*%/i);
  const mwstDoc = mwstM ? parseFloat(mwstM[1]) : 19;

  // Preiszeile generisch:  LABEL  EINZEL €/EINHEIT  GESAMT €
  // (LABEL beliebig, mit/ohne Doppelpunkt — toleriert "Preis inkl. ETZ/MTZ nach VB")
  const priceRe = /^(.+?)\s*:?\s*(-?[\d.]+,\d{2})\s*€\s*\/\s*([A-Za-zäöüÄÖÜ.]+)\s+(-?[\d.]+,\d{2})\s*€\s*$/i;
  // Bezeichnung mit nachgestellter Menge+Einheit
  const bezRe   = /^Bezeichnung\s*:\s*(.+?)\s+(\d+(?:,\d+)?)\s+(Stk|St[üu]ck|St|Anz|Pos\.?|kg|t)\s*$/i;

  let desc = null, menge = 1, einheit = 'Stk', posNr = null;

  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;

    // Ende des Positionsbereichs
    if (/^Nettowert\s*:/i.test(line)) break;

    // Positionsnummer "0001 ..."
    const posM = line.match(/^(0\d{3})\b/);
    if (posM) posNr = posM[1];

    // Bezeichnung
    const bezM = line.match(bezRe);
    if (bezM) {
      desc    = bezM[1].trim();
      menge   = _parseDE(bezM[2]) || 1;
      einheit = bezM[3];
      continue;
    }
    // Bezeichnung ohne erkennbare Menge/Einheit
    const bezPlain = line.match(/^Bezeichnung\s*:\s*(.+)$/i);
    if (bezPlain) { desc = bezPlain[1].trim(); menge = 1; einheit = 'Stk'; continue; }

    // Preiszeile
    const pM = line.match(priceRe);
    if (pM) {
      const label  = pM[1].trim();
      const gesamt = _parseDE(pM[4]);

      // Zuschlag nur wenn das Label MIT MTZ/ETZ BEGINNT (eigenständige Zeile).
      // "Preis inkl. ETZ/MTZ …" beginnt mit "Preis" → Hauptposition.
      if (/^MTZ\b/i.test(label) || /^ETZ\b/i.test(label)) {
        const name = /^MTZ/i.test(label)
          ? 'MTZ – Materialteuerungszuschlag'
          : 'ETZ – Energieteuerungszuschlag';
        items.push({ beschreibung: name, menge: 1, einheit: 'Pausch.', einzelpreis: gesamt, mwst: mwstDoc });
      } else {
        // Hauptposition (Preis / Modelleinrichtung / Preis inkl. …)
        const m = menge > 0 ? menge : 1;
        items.push({
          beschreibung: `${posNr ? posNr + ' – ' : ''}${desc || label}`,
          menge:        m,
          einheit:      _unitCode(einheit),
          einzelpreis:  gesamt / m,   // Gesamt/Menge → Summe bleibt exakt
          mwst:         mwstDoc,
        });
      }
    }
  }

  return _validateAndFallback(items, _extractNetTotalGermanSHB(fullText), mwstDoc);
}

/* ══════════════════════════════════════════════════════
   Text Extraction
══════════════════════════════════════════════════════ */

/**
 * Sammelt Text-Items aus der PDF.js-Textebene.
 * Item-Form: { text, x, y, pw, ph, w, page }.
 * Koordinaten in PDF-Punkten, y von unten (PDF-Konvention).
 */
async function collectPdfItems(pdfDoc) {
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
        x:   item.transform[4],
        y:   item.transform[5],
        pw:  vp.width,
        ph:  vp.height,
        w:   item.width || 0,
        page: p,            // ← Seitennummer: verhindert y-Überlappung zwischen Seiten
      });
    }
  }

  return allItems;
}

/**
 * Cluster items into visual lines (±4 pt) and return newline-joined string.
 *
 * WICHTIG: Jede Seite hat einen eigenen Cluster-Namespace.
 * Ohne diese Trennung würden Items von Seite 2 (gleicher y-Bereich wie Seite 1)
 * zwischen Items von Seite 1 einsortiert und die Zeilenreihenfolge zerstören.
 *
 * Sortierung: Seite aufsteigend → innerhalb Seite y absteigend (oben zuerst)
 *             → innerhalb Zeile x aufsteigend (links zuerst).
 * Gap-Joining: gap < 2 pt → kein Leerzeichen
 *   (behebt "Me uselwitz" → "Meuselwitz", "D-0 4610" → "D-04610").
 */
function _toLines(items) {
  const rows = new Map();
  for (const it of items) {
    const key = `${it.page || 0}|${Math.round(it.y / 4) * 4}`;
    if (!rows.has(key)) rows.set(key, { page: it.page || 0, y: it.y, ls: [] });
    rows.get(key).ls.push(it);
  }
  return [...rows.values()]
    .sort((a, b) => a.page - b.page || b.y - a.y)
    .map(({ ls }) => {
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

/**
 * Baut aus Text-Items die Abschnitts-Strings, auf denen die Extraktoren arbeiten.
 * Identisch für PDF.js-Items und OCR-Items (gleiche Item-Form).
 */
function _buildSections(allItems) {
  const toLines = _toLines;

  const fullText       = toLines(allItems);
  const leftColumnText = toLines(allItems.filter(i => i.x < i.pw * 0.48));
  const leftText       = allItems
    .filter(i => i.x < i.pw * 0.48)
    .sort((a, b) => a.page - b.page || b.y - a.y || a.x - b.x)
    .map(i => i.text).join(' ');
  const rightText      = toLines(allItems.filter(i => i.x > i.pw * 0.48));
  // Footer = bottom 22 % jeder Seite (y < ph*0.22 in PDF-Koordinaten)
  // + letzte 15 Zeilen als Fallback (Seller-Daten die per y nicht erwischt werden)
  const footerByY   = toLines(allItems.filter(i => i.y < i.ph * 0.22));
  const footerByEnd = fullText.split('\n').slice(-15).join('\n');
  const footerText  = footerByY + '\n' + footerByEnd;

  // Käufer-Adressfenster: Seite 1, linke Spalte, oberes Drittel (y > ph*0.68).
  // Isoliert den Empfänger-Adressblock von der rechts stehenden Metadaten-Spalte.
  const buyerBlock  = toLines(allItems.filter(i => i.page === 1 && i.x < i.pw * 0.48 && i.y > i.ph * 0.68));

  return { fullText, leftText, leftColumnText, rightText, footerText, buyerBlock };
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

  // Total-Prüfung: stimmt die Summe der Positionen mit dem Invoice-Total überein?
  return _validateAndFallback(items, _extractNetTotalEnglish(fullText), 0);
}

/* ══════════════════════════════════════════════════════
   Endsumme-Validierung & Fallback-Position
══════════════════════════════════════════════════════ */

/**
 * Liefert den Netto-Erwartungswert für deutsche WGC-Rechnungen.
 * Immer Endsumme als verbindlicher Gesamtbetrag (brutto oder netto).
 * Falls MwSt-Satz vorhanden, wird der Nettobetrag zurückgerechnet:
 *   net = Endsumme / (1 + MwSt/100)
 * Bei MwSt-freien Rechnungen gilt:
 *   net = Endsumme
 */
function _extractNetTotalGermanWGC(fullText) {
  // Endsumme = verbindlicher Gesamtbetrag (brutto mit MwSt oder netto ohne MwSt)
  const ends = [...fullText.matchAll(/Endsumme\s+([\d.]+,\d{2})/gi)];
  if (ends.length === 0) return null;
  const endsumme = _parseDE(ends[ends.length - 1][1]);

  // MwSt-Satz aus der Zusammenfassungszeile ermitteln
  const mwstM = fullText.match(/MWSt\.\s+[\d.,]+\s+(\d{1,2})(?:,\d+)?\s+[\d.,]+/i);
  const mwst  = mwstM ? parseFloat(mwstM[1]) : 0;

  // Nettobetrag zurückrechnen
  return mwst > 0 ? endsumme / (1 + mwst / 100) : endsumme;
}

/**
 * Liefert den Netto-Erwartungswert für SHB-Rechnungen.
 * "Nettowert : 59.000,00 €" ist der ausgewiesene Nettobetrag.
 */
function _extractNetTotalGermanSHB(fullText) {
  const m = [...fullText.matchAll(/Nettowert\s*:\s*([\d.]+,\d{2})/gi)];
  return m.length ? _parseDE(m[m.length - 1][1]) : null;
}

/**
 * Liefert den Netto-Erwartungswert für englische WGC-Rechnungen.
 * Nimmt die ERSTE eigenständige "Total BETRAG"-Zeile
 * (vor einem etwaigen Prepayment-Abzug auf einer Folgezeile).
 */
function _extractNetTotalEnglish(fullText) {
  const m = fullText.match(/^\s*Total\s+([\d.]+,\d{2})\s*$/m);
  return m ? _parseDE(m[1]) : null;
}

/**
 * Prüft ob die Summe der extrahierten Positionen mit dem erwarteten
 * Nettobetrag übereinstimmt (Toleranz ±1,00 €).
 * Bei Abweichung: eine Sammelposition mit dem korrekten Nettobetrag.
 *
 * @param {object[]} items        - Extrahierte Positionen
 * @param {number|null} netExpected - Erwarteter Nettobetrag aus PDF
 * @param {number} mwstDoc        - MwSt-Satz für die Sammelposition
 */
function _validateAndFallback(items, netExpected, mwstDoc) {
  if (netExpected === null) return items;

  const netExtracted = items.reduce((s, it) => s + it.einzelpreis * it.menge, 0);
  // Positionen vorhanden und Summe passt → unverändert übernehmen
  if (items.length > 0 && Math.abs(netExtracted - netExpected) <= 1.0) return items;

  // Differenz zu groß → Sammelposition mit korrektem Betrag
  console.warn(
    `[parser] Positions-Summe ${netExtracted.toFixed(2)} weicht von Endsumme ` +
    `${netExpected.toFixed(2)} ab (Δ ${(netExtracted - netExpected).toFixed(2)}). ` +
    'Verwende Sammelposition.'
  );
  return [{
    beschreibung: 'Lieferung und Leistung laut Rechnung (Endsumme aus PDF)',
    menge:        1,
    einheit:      'Pausch.',
    einzelpreis:  netExpected,
    mwst:         mwstDoc,
  }];
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

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

/**
 * Leerer Registry-Eintrag (Gerüst) für ein noch nicht gepflegtes Werk.
 * Inaktiv (_detect:null, _aktiv:false) → wird von _detectCompany übersprungen,
 * bis Stammdaten gepflegt und _detect/_aktiv gesetzt sind.
 */
function _werkGeruest(werk) {
  return {
    verkaeufer: '', verkaeufstrasse: '', verkaeufplz: '', verkaeufstadt: '',
    verkaeufland: 'DE', verkaeuftel: '', verkaeuferemail: '',
    verkaeufervat: '', verkaeufersteuernr: '', iban: '', bic: '',
    handelsregister: '', registernr: '', geschaeftsfuehrung: '',
    _werk: werk, _detect: null, _aktiv: false,
  };
}

const _COMPANY_REGISTRY = {

  WGC: {
    verkaeufer:         'Walzengießerei Coswig GmbH',
    verkaeufstrasse:    'Grenzstraße 1',
    verkaeufplz:        '01640',
    verkaeufstadt:      'Coswig',
    verkaeufland:       'DE',
    verkaeuftel:        '+49 3523 950',
    verkaeuferemail:    'sales@walze-coswig.de',
    verkaeufervat:      'DE140598967',
    verkaeufersteuernr: '209/197/00034',
    iban:               'DE33820700000130805501',
    bic:                'DEUTDE8EXXX',
    // Regulatorische Pflichtangaben (BT-30 / BT-33) — laut Briefkopf (Footer ist
    // eine Grafik, daher nicht per Text auslesbar → hier fest hinterlegt):
    handelsregister:    'Amtsgericht Dresden',
    registernr:         'HRB 312',
    geschaeftsfuehrung: 'Viktor Babushchak',
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
    // Regulatorische Pflichtangaben (BT-30 / BT-33) — laut Rechnungsfuß
    handelsregister:    'Amtsgericht Leipzig',
    registernr:         'HRB 13893',
    geschaeftsfuehrung: 'Viktor Babushchak',
    // detect: E-Mail-Domain, Firmenname oder „Bösdorf" im PDF
    _detect: /shb-guss|bösdorf|b.sdorf|stahl-?\s*und\s*hartguss|shb\s+stahl/i,
  },

  // ── ZAI · Zaigler (DIHAG-Gruppe) ────────────────────────────────────────
  // Ausgangsrechnungen aus dem ERP (combit List & Label). Format-Parser unten:
  // _isZaiInvoice + extract*Zai. Aus dem PDF-TEXT lesbar sind nur Tel/E-Mail/
  // IBAN/BIC — die regulatorischen Stammdaten stehen im Briefkopf (Grafik) und
  // MÜSSEN hier gepflegt werden. TODO ausfüllen, dann ist ZAI vollständig:
  ZAI: {
    verkaeufer:         'Dihag Zaigler GmbH',
    verkaeufstrasse:    'Gummistr. 28',
    verkaeufplz:        '95326',
    verkaeufstadt:      'Kulmbach',
    verkaeufland:       'DE',
    verkaeuftel:        '+49 9221 944-0',
    verkaeuferemail:    '',   // keine feste Sales-Adresse geliefert → Kontakt-Mail aus PDF-Text
    verkaeufervat:      'DE368990137',
    verkaeufersteuernr: '208/124/40021',
    // Master-Bankverbindung (Deutsche Bank) — nur FALLBACK. Entschieden: die
    // E-Rechnung SPIEGELT die auf der Rechnung gedruckte Bank (Factoring-Regel:
    // extrahierte Fuß-IBAN hat Vorrang), z. B. Sparkasse Donnersberg. Diese
    // Master-IBAN greift nur, wenn keine IBAN im PDF steht.
    iban:               'DE77820700000154699301',
    bic:                'DEUTDE8EXXX',
    handelsregister:    'Amtsgericht München',
    registernr:         'HRB 291945',
    geschaeftsfuehrung: 'Viktor Babushchak',
    // detect: E-Mail-Domain/AGB-URL „dihag-zaigler.com" oder Firmenname im PDF
    _detect: /dihag-zaigler|zaigler/i,
    _aktiv: true,
  },

  // ── Gerüst der übrigen 7 Werke (Layouts unterschiedlich) ────────────────
  // Inaktiv bis Stammdaten + je ein Beispiel-PDF vorliegen. Dann: Felder in
  // _werkGeruest-Ausgabe ausfüllen bzw. Eintrag wie ZAI ausschreiben, _detect
  // setzen, _aktiv:true — UND je Werk einen Format-Parser (_is<Werk>Invoice +
  // extract*<Werk>) ergänzen und in extractInvoiceDataFromItems einhängen.
  // ── EIS · DIHAG Gienanth, Eisenberg (SAP-Formular, Parser extractEis) ──
  // E-Rechnung nur für Kunden mit Anschrift im Inland (_nurInland): EU-Ausland
  // und Drittland bleiben PDF, Drittland zudem unterschrieben (Präferenzangaben).
  EIS: {
    verkaeufer:         'DIHAG Gienanth GmbH',
    verkaeufstrasse:    'Ramsener Str. 1',
    verkaeufplz:        '67304',
    verkaeufstadt:      'Eisenberg (Pfalz)',
    verkaeufland:       'DE',
    verkaeuftel:        '',   // Durchwahl des Ansprechpartners aus Feld (13), sonst Zentrale aus dem Fuß
    verkaeuferemail:    '',
    verkaeufervat:      'DE368676368',
    verkaeufersteuernr: '',
    iban:               'DE46820700000154698501',
    bic:                'DEUTDE8EXXX',
    handelsregister:    'Amtsgericht Kaiserslautern',
    registernr:         'HRB 34046',
    geschaeftsfuehrung: 'Viktor Babushchak, Dr. Hans-Jürgen Brenninger',
    _detect: /dihag-gienanth\.com|HRB\s*34046/i,
    _nurInland: true,
    _aktiv: true,
  },
  DSO: _werkGeruest('DSO'),
  LEG: _werkGeruest('LEG'),
  // ── EWA · Eisenwerk Arnstadt (SAP Adobe-Formular, Parser extractEwa) ──
  EWA: {
    verkaeufer:         'Eisenwerk Arnstadt GmbH',
    verkaeufstrasse:    'Bierweg 4',
    verkaeufplz:        '99310',
    verkaeufstadt:      'Arnstadt',
    verkaeufland:       'DE',
    verkaeuftel:        '+49 3628 596 101',
    verkaeuferemail:    'info@ewa-guss.de',
    verkaeufervat:      'DE812737567',
    verkaeufersteuernr: '',
    iban:               'DE92820700000126644400',   // EUR-Konto; GBP-Rechnungen nennen ein eigenes, das aus dem PDF gilt
    bic:                'DEUTDE8EXXX',
    handelsregister:    'Amtsgericht Jena',
    registernr:         'HRB 110887',
    geschaeftsfuehrung: 'Viktor Babushchak',
    _detect: /ewa-guss\.de|HRB\s*110887/i,
    _aktiv: true,
  },
  HOL: _werkGeruest('HOL'),
  MEG: _werkGeruest('MEG'),
  SCH: _werkGeruest('SCH'),

};

/**
 * Erkennt den Rechnungssteller anhand des PDF-Volltexts.
 * Gibt die Registry-Daten (ohne _detect) zurück oder null.
 */
function _detectCompany(fullText) {
  for (const [key, entry] of Object.entries(_COMPANY_REGISTRY)) {
    // Skelett-/inaktive Werke überspringen (kein _detect oder _aktiv:false)
    if (entry._aktiv === false || !entry._detect) continue;
    if (entry._detect.test(fullText)) {
      // Interne Felder (_detect, _aktiv, _werk, …) nicht ins Ergebnis
      const data = {};
      for (const [k, v] of Object.entries(entry)) if (!k.startsWith('_')) data[k] = v;
      // Registry-Schlüssel = Werk-Kürzel (WGC/SHB/ZAI…) → als Gesellschaft mitgeben,
      // damit der manuelle Konverter die Ausgangsrechnung ins richtige AR_<Werk> legt.
      data.gesellschaft = key;
      return data;
    }
  }
  return null;
}

/**
 * Aktive Werk-Kürzel aus der Registry (WGC/SHB/ZAI…) — Skelette/inaktive Werke
 * (kein _detect oder _aktiv:false) ausgeschlossen. Einzige Quelle für das
 * Gesellschaft-Dropdown, damit neue Werke automatisch erscheinen, sobald ihr
 * Registry-Eintrag gepflegt und _aktiv ist.
 */
function activeWerke() {
  return Object.keys(_COMPANY_REGISTRY).filter(k => {
    const e = _COMPANY_REGISTRY[k];
    return e && e._aktiv !== false && e._detect;
  });
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
  let eigenesLayout = false;   // Parser liest Lieferanschrift und Lieferschein selbst

  // Englischsprachige WGC-Rechnung (Item/Product/pcs.-Format)
  if (_isEnglishIndustrialInvoice(fullText)) {
    result = {
      ...extractMetadataEnglish(fullText),
      ...extractSellerEnglish(footerText, fullText),
      ...extractBuyerEnglish(buyerBlock, leftColumnText, fullText),
      positionen: extractLineItemsEnglish(fullText),
    };
  // Deutschsprachige WGC-Rechnung (Pos/Artikel/Stück-Format)
  } else if (_isGermanWGCInvoice(fullText)) {
    result = {
      ...extractMetadataGermanWGC(fullText),
      ...extractSeller(footerText, fullText),
      ...extractBuyerWGCGerman(buyerBlock, leftColumnText, leftText, fullText),
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
  // EWA-Rechnung (Eisenwerk Arnstadt, SAP Adobe-Formular, de/en/fr)
  } else if (_isEwaInvoice(fullText)) {
    result = { ...extractSeller(footerText, fullText), ...extractEwa(fullText, allItems) };
    eigenesLayout = true;
  // EIS-Rechnung (Gienanth, SAP-Formular mit Feldnummern (10) bis (34))
  } else if (_isEisInvoice(fullText)) {
    result = { ...extractSeller(footerText, fullText), ...extractEis(fullText) };
    eigenesLayout = true;
  // ZAI-Rechnung (Zaigler, combit-Layout: Beleg-Nr./Pos. Bezeichnung Menge …)
  } else if (_isZaiInvoice(fullText)) {
    result = {
      ...extractMetadataZai(fullText),
      ...extractSeller(footerText, fullText),   // Tel/E-Mail/IBAN/BIC aus dem Text
      ...extractBuyerZai(buyerBlock, leftColumnText, fullText),
      positionen: extractLineItemsZai(fullText),
    };
  } else {
    result = {
      ...extractMetadata(rightText, fullText),
      ...extractSeller(footerText, fullText),
      ...extractBuyer(leftColumnText, leftText, fullText),
      positionen: extractLineItems(fullText),
    };
  }

  if (!eigenesLayout) {
    // Lieferanschrift (Shipping Address) — steht bei WGC/SHB am Rechnungsende
    Object.assign(result, _extractShipTo(fullText));

    // Lieferschein-/Versandavis-Nummer (BT-16), falls noch nicht gesetzt
    if (!result.lieferscheinnummer) Object.assign(result, _extractLieferschein(fullText));
  }

  // Steuerkategorie für 0%-Positionen erkennen (UNTDID 5305: K/AE/G)
  Object.assign(result, _detectTaxCategory(fullText, result));

  // Bekannten Rechnungssteller erkennen → kanonische Stammdaten überschreiben.
  // IBAN/BIC sind hiervon AUSGENOMMEN: sie stammen aus dem Rechnungsfuß, weil
  // WGC je nach Factoring zwei verschiedene Bankkonten (IBANs) verwendet.
  const company = _detectCompany(fullText);
  if (company) {
    const extractedIban = result.iban;
    const extractedBic  = result.bic;
    // Nur befüllte Registry-Felder überlagern — leere TODO-Platzhalter (z. B.
    // noch nicht gepflegte Werke) dürfen die aus dem Text gelesenen Werte
    // NICHT mit Leerstrings überschreiben.
    for (const [k, v] of Object.entries(company)) {
      if (v !== null && v !== undefined && v !== '') result[k] = v;
    }
    if (extractedIban) result.iban = extractedIban;
    if (extractedBic)  result.bic  = extractedBic;
  }

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

// ZAI/Zaigler (combit List & Label): verkäufer-verankert (dihag-zaigler-Domain
// in Kontakt-Mail/AGB-URL) + charakteristisches "Beleg-Nr."-Label.
function _isZaiInvoice(text) {
  return /dihag-zaigler/i.test(text) && /Beleg-?Nr\.?\s*:/i.test(text);
}

/* ══════════════════════════════════════════════════════
   DEUTSCHSPRACHIGE WGC-RECHNUNG
   (TKP, NEUMAN, FAIR, VOESTDON — Pos/Artikel/Stück)
══════════════════════════════════════════════════════ */

function extractMetadataGermanWGC(fullText) {
  const r = {};

  // Rechnungsnummer: "Rechnung Nr: 4260264" — auch Gutschrift/Rechnungskorrektur
  const invM = fullText.match(/(?:Rechnung(?:skorrektur)?|Gutschrift)\s+Nr[:\s]+(\d{4,12})/i);
  if (invM) r.rechnungsnummer = invM[1];

  // Datum-Zeile: "Lieferdatum Datum" + Datenzeile "08.05.26  12.05.26"
  const dtM = fullText.match(
    /Lieferdatum\s+Datum[\s\S]{0,200}?(\d{2}\.\d{2}\.\d{2})\s+(\d{2}\.\d{2}\.\d{2})/i
  );
  if (dtM) {
    r.lieferdatum    = _deDate(_fixYear(dtM[1]));
    r.rechnungsdatum = _deDate(_fixYear(dtM[2]));
  }

  // Fälligkeitsdatum: verbindlicher LETZTER Zahltermin.
  // Bei Skonto gibt es zwei "zum …"-Zeilen — der Netto-Termin ("rein netto")
  // ist maßgeblich, nicht der frühere (kürzere) Skonto-Termin.
  const dueNetto = fullText.match(/zum\s+(\d{2}\.\d{2}\.\d{4})\s+rein\s+netto/i);
  const dueAll   = [...fullText.matchAll(/zum\s+(\d{2}\.\d{2}\.\d{4})/gi)];
  if (dueNetto)          r.faelligkeitsdatum = _deDate(dueNetto[1]);
  else if (dueAll.length) r.faelligkeitsdatum = _deDate(dueAll[dueAll.length - 1][1]);

  // Ansprechpartner: Nachname unter der "Bearbeiter:"-Kopfzeile
  // "Bearbeiter: Telefon Fax Kunde …" → Datenzeile "Viehrig 95-211 95-205 …"
  const bearbM = fullText.match(/Bearbeiter\s*:[^\n]*\n\s*([A-ZÄÖÜ][A-Za-zäöüß\-]+)/);
  if (bearbM) r.verkaeufkontakt = bearbM[1];

  // Zahlungsbedingungen → Notiz: kompletter Block ("Zahlung"-Zeile + alle
  // folgenden Konditionszeilen: Tage / Skonto / zum … netto). Zeilenanker
  // gegen "Anzahlung"/"Sonderzahlung".
  const notiz = _extractZahlungsblock(fullText, /^[ \t]*Zahlung\b[ \t:]*/, /(\d+\s*Tage|Skonto|^zum\s+\d|rein\s+netto|%|EUR|netto)/i);
  if (notiz) r.notiz = notiz;

  return r;
}

/**
 * Kompletten Zahlungsbedingungs-Block als mehrzeilige Notiz extrahieren.
 * @param {string} fullText
 * @param {RegExp} labelRe  Anker der Startzeile (z. B. /^Zahlung/ oder /^Payment/)
 * @param {RegExp} condRe   Muster einer Konditions-Folgezeile
 * @returns {string} "Zahlung: …\n…" oder '' wenn kein Block gefunden
 */
function _extractZahlungsblock(fullText, labelRe, condRe) {
  const lines = fullText.split('\n');
  const zi = lines.findIndex(l => labelRe.test(l));
  if (zi < 0) return '';

  const first = lines[zi].replace(labelRe, '').trim();
  const block = [];
  // Layout-Quirk (z. B. MULTIGEAR): "N Tage netto" steht direkt ÜBER dem
  // "Zahlung"-Label — mitnehmen, wenn das Label selbst leer ist.
  if (!first && zi > 0 && /^\d+\s*(Tage|days)\b/i.test(lines[zi - 1].trim())) {
    block.push(lines[zi - 1].trim());
  }
  if (first) block.push(first);
  for (let k = zi + 1; k < Math.min(zi + 6, lines.length); k++) {
    const l = lines[k].trim();
    if (!l || !condRe.test(l)) break;   // Ende des Blocks
    block.push(l);
  }
  return block.length ? 'Zahlung: ' + block.join('\n') : '';
}

/**
 * Käufer für deutsche WGC-Rechnungen.
 * Primär: isoliertes Adressfenster (Seite 1 links oben) — verhindert
 * Fehltreffer aus Konditionen-/Bestellzeilen weiter unten.
 * Fallback: bisherige Extraktion aus der linken Spalte.
 */
function extractBuyerWGCGerman(buyerBlock, leftColumnText, leftText, fullText) {
  // Käufer-USt-IdNr: "Ihre USt-Id-Nr: DE815902511" (optional, BT-48)
  // oder Schweizer Format "Empfänger MwStNr.: CHE-101.390.201"
  const vatM = fullText.match(/Ihre\s+USt-?Id-?Nr\.?\s*:?[ \t]*([A-Z]{2}[\dA-Z ]{2,18})/i)
            || fullText.match(/(?:Empf.nger\s+)?MwSt-?Nr\.?\s*:?[ \t]*(CHE-?[\d.\s]{9,15})/i);
  const kaeufervat = vatM ? vatM[1].replace(/\s+/g, '') : '';

  const w = _parseBuyerWindow(buyerBlock);
  if (kaeufervat) w.kaeufervat = kaeufervat;
  if (w.kaeufer && w.kaeuferplz) return w;

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

  // Fenster-Teilergebnisse haben Vorrang, wo vorhanden
  for (const [k, v] of Object.entries(w)) if (v) r[k] = v;
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

  // Positionszeile: [PosNr] ArtikelCode Menge Einheit [...]
  // PosNr optional & mehrstufig: "1", "10", "1.1", "1.2.1", "1,2", "1,2,3"
  //   (Komma wird später zu Punkt normalisiert)
  // \s* statt \s+: toleriert PDF.js-Glyphen ohne Zwischenraum (gap < 2 pt)
  // Einheiten: St(ück)/VE/Stk/ME/Pce/pcs
  const itemRe = /^(?:(\d+(?:[.,]\d+)*)\s+)?(\d{2,6})\s+(\d+)\s*(?:St|VE|Stk|ME|Pce|pcs)/i;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line || skipRe.test(line)) continue;

    const codeM = line.match(itemRe);
    if (!codeM) continue;

    const posnr = _normPosNr(codeM[1]);
    const code  = codeM[2];
    const menge = parseFloat(codeM[3]) || 1;

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

    const total     = amounts[amounts.length - 1];
    let einzelpreis = menge > 0 ? total / menge : amounts[0];

    // %-Spalte (zwischen Einzelpreis und Gesamtpreis): [einzel, pct, gesamt]
    // Richtung mathematisch prüfen: Zuschlag (1+p/100) oder Rabatt (1−p/100).
    // App-Konvention: rabatt > 0 mindert → Zuschlag wird als negativer Rabatt gemappt.
    let rabatt = 0;
    if (amounts.length >= 3 && menge > 0) {
      const einzelRaw = amounts[0];
      const pct       = amounts[amounts.length - 2];
      if (pct > 0 && pct < 100) {
        const withZuschlag = menge * einzelRaw * (1 + pct / 100);
        const withRabatt   = menge * einzelRaw * (1 - pct / 100);
        if (Math.abs(withZuschlag - total) <= 0.02) {
          einzelpreis = einzelRaw;
          rabatt      = -pct;                 // Zuschlag (z. B. NEUMAN +5 %)
        } else if (Math.abs(withRabatt - total) <= 0.02) {
          einzelpreis = einzelRaw;
          rabatt      = pct;                  // echter Rabatt
        }
      }
    }

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
      posnr,
      beschreibung: `${code} – ${desc}`,
      menge,
      einheit:      'Stk',
      einzelpreis,
      rabatt,
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

  // Käufer-USt-IdNr: "Ihre USt-Id-Nr: DE…" (optional, BT-48)
  const vatM = fullText.match(/Ihre\s+USt-?Id-?Nr\.?\s*:?[ \t]*([A-Z]{2}[\dA-Z ]{2,18})/i);
  if (vatM) r.kaeufervat = vatM[1].replace(/\s+/g, '');

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
        items.push({ posnr: '', beschreibung: name, menge: 1, einheit: 'Pausch.', einzelpreis: gesamt, mwst: mwstDoc });
      } else {
        // Hauptposition (Preis / Modelleinrichtung / Preis inkl. …)
        const m = menge > 0 ? menge : 1;
        items.push({
          posnr:        _normPosNr(posNr),
          beschreibung: desc || label,
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
   ZAI-RECHNUNG  (Zaigler, DIHAG-Gruppe)
   combit-Layout: "Beleg-Nr."/"Beleg-Datum" + Positionstabelle
   "Pos. Bezeichnung Menge Einheit Einzelpreis EUR Gesamtpreis EUR".
   Verkäufer-Stammdaten liefert die Registry (ZAI); hier nur Metadaten,
   Käufer (auslandsfähig via _parseBuyerWindow) und Positionen.
══════════════════════════════════════════════════════ */

function extractMetadataZai(fullText) {
  const r = {};

  // Rechnungsnummer: "Beleg-Nr.: 2026.001772" (der Punkt gehört zur ERP-Nummer).
  // Nur mit Bindestrich und Doppelpunkt: Bei Storno-Rechnungen steht im Kopf zusätzlich
  // "zu Belegnr. 2026.001234" (die stornierte Rechnung), die darf nicht greifen.
  const nrM = fullText.match(/Beleg-Nr\.?\s*:\s*([0-9][0-9.\-\/]{3,20})/i);
  if (nrM) r.rechnungsnummer = nrM[1].trim();

  // Storno-Rechnung / Gutschrift → BT-3 381, Bezug auf die stornierte Rechnung (BT-25)
  if (/Storno-?\s*Rechnung|^\s*Gutschrift\b/im.test(fullText)) {
    r.rechnungsart = '381';
    const vorM = fullText.match(/zu\s+Beleg-?\s*nr\.?\s*:?\s*([0-9][0-9.\-\/]{3,20})/i);
    if (vorM) r.vorrechnungsnummer = vorM[1].trim();
  }

  // Rechnungsdatum: "Beleg-Datum: 16.09.2026"
  const datM = fullText.match(/Beleg-?Datum\s*:?\s*(\d{2}\.\d{2}\.\d{4})/i);
  if (datM) r.rechnungsdatum = _deDate(datM[1]);

  // Leistungs-/Lieferdatum: "Lieferdatum: 16.09.2026"
  const ldM = fullText.match(/Lieferdatum\s*:?\s*(\d{2}\.\d{2}\.\d{4})/i);
  if (ldM) r.lieferdatum = _deDate(ldM[1]);

  // Fälligkeit: "Zahlbar ohne Abzug bis zum 15.11.2026!"
  const faellM = fullText.match(/bis\s+zum\s+(\d{2}\.\d{2}\.\d{4})/i);
  if (faellM) r.faelligkeitsdatum = _deDate(faellM[1]);

  // Ansprechpartner (Verkäuferkontakt, BT-41): "Ansprechpartner: Döring Gerhard"
  const apM = fullText.match(/Ansprechpartner\s*:?\s*([A-ZÄÖÜ][A-Za-zäöüß.\-]+(?:\s+[A-ZÄÖÜ][A-Za-zäöüß.\-]+)?)/);
  if (apM) r.verkaeufkontakt = apM[1].trim();

  // Kunden-Nr. (BT-46, Kennung des Käufers) und Lieferanten-Nr. (BT-29, unter dieser
  // Nummer führt der Kunde ZAI als Lieferanten; viele Kunden buchen damit automatisch)
  const kdM = fullText.match(/Kunden-Nr\.?\s*:\s*([A-Z0-9][A-Z0-9\-\/]*)/i);
  if (kdM) r.kundennummer = kdM[1];
  const lfM = fullText.match(/Lieferanten-Nr\.?\s*:\s*([A-Z0-9][A-Z0-9\-\/]*)/i);
  if (lfM) r.lieferantennummer = lfM[1];

  // Bestellnummer des Kunden (BT-13): erste "Best.Nr. 4500012345 Pos. 20" → 4500012345
  const bestM = fullText.match(/Best\.?\s*-?\s*Nr\.?\s*:?\s*([A-Z0-9][A-Z0-9\-\/.]*)/i);
  if (bestM) r.bestellnummer = bestM[1].replace(/[.\/]+$/, '');

  // Summenzeile des Originals: "982,62  19,00 %  186,69  1.169,31". Die MwSt übernimmt die
  // E-Rechnung von hier, statt sie neu zu rechnen: Das ERP rundet anders (186,69 statt
  // 186,70). EN 16931 (BR-CO-17) lässt diese Abweichung zu. Die letzte Summenzeile zählt,
  // Zwischensummen auf Folgeseiten haben nur zwei Werte.
  const summen = [...fullText.matchAll(/(-?[\d.]+,\d{2})\s+(\d{1,2}(?:,\d+)?)\s*%\s+(-?[\d.]+,\d{2})\s+(-?[\d.]+,\d{2})/g)];
  if (summen.length) {
    const z = summen[summen.length - 1];
    r.steuerbetrag = _parseDE(z[3]);
    r.gesamtbetrag = _parseDE(z[4]);
  }

  // Hinweise (BT-22): Zahlungsbedingung und die Fußtexte bis zur Bankverbindung
  // (AGB-Hinweis, Leistungstag, Lieferbedingung, ggf. Hinweis zur Steuerschuldnerschaft)
  const zeilen = fullText.split('\n').map(z => z.trim());
  const zb = zeilen.findIndex(z => /^Zahlungsbedingung\b/i.test(z));
  const hinweise = [];
  if (zb >= 0) {
    const zbText = zeilen[zb].replace(/^Zahlungsbedingung\s*:?\s*/i, '').replace(/^"|"$|!+"?$/g, '').replace(/"/g, '').trim();
    if (zbText) hinweise.push('Zahlungsbedingung: ' + zbText.replace(/!+$/, ''));
    for (let i = zb + 1; i < zeilen.length; i++) {
      const z = zeilen[i];
      if (!z) continue;
      if (/^Unsere\s+Bankverbindung|^Seite\s*:?\s*\d|^(?:Deutsche\s+Bank|Sparkasse|IBAN|BIC)\b/i.test(z)) break;
      hinweise.push(z);
    }
  }
  // Zwei Zeilen des AGB-Hinweises zu einem Satz zusammenfassen
  if (hinweise.length) r.notiz = hinweise.join('\n').replace(/Geschäftsbedingungen\.\nDie AGB/, 'Geschäftsbedingungen. Die AGB');

  return r;
}

function extractBuyerZai(buyerBlock, leftColumnText, fullText) {
  // Auslandsfähiges Adressfenster nutzen (erkennt SAS/SARL, „FRANKREICH" → FR)
  const r = _parseBuyerWindow((buyerBlock && buyerBlock.trim()) ? buyerBlock : (leftColumnText || ''));

  // Käufer-USt-IdNr (BT-48): "Ihre Ust.ID: FR51530107341"
  const vatM = fullText.match(/Ihre\s+Ust\.?-?\s*ID\.?\s*:?\s*([A-Z]{2}[\dA-Z]{6,14})/i);
  if (vatM) r.kaeufervat = vatM[1].replace(/\s+/g, '');

  return r;
}

/**
 * Positionen einer ZAI-Rechnung, blockweise über alle Seiten:
 *   Bestellblock (Bestellung vom / Best.Nr. / Komm. / Auftrags/Pos.-Nr.) → Positionshinweis
 *   Positionszeile (Pos. Artikel Menge Einheit Einzelpreis Gesamtpreis)
 *   Detailzeilen (Zeichnung, Guss-Nr., AVO …) → Positionsbeschreibung
 *   Lieferschein-Nr. / Lieferdatum → Positionshinweis
 * Preiszeilen ohne Positionsnummer ("Erstmusterkosten 1 Stück …") sind eigene
 * Positionen oder, wenn die Position davor noch keinen Preis hat, deren Preis.
 * Die auf jeder Seite wiederholten Köpfe (Seite: n … Pos. Bezeichnung …) fallen heraus.
 */
function extractLineItemsZai(fullText) {
  const EINHEIT = '(St[üu]ck|Stk|St|kg|to?|m|Std|h|l|Pausch\\.?)';
  const BETRAG = '(-?[\\d.]+,\\d{2})';
  const mitNr = new RegExp('^(\\d{1,3})\\s+(?:(\\S.*?)\\s+)?(\\d+(?:[.,]\\d+)?)\\s+' + EINHEIT + '\\s+' + BETRAG + '\\s+' + BETRAG + '$', 'i');
  const ohneNr = new RegExp('^(\\S.*?)\\s+(\\d+(?:[.,]\\d+)?)\\s+' + EINHEIT + '\\s+' + BETRAG + '\\s+' + BETRAG + '$', 'i');
  const nurKopf = /^(\d{1,3})\s+(\S.*)$/;
  const bestellZeile = /^(?:Bestellung\s+vom|Best\.?\s*-?\s*Nr|Komm\.|Kommission\s*:|Auftrags?\/?\s*Pos)/i;
  const lsZeile = /^(?:Lieferschein-?\s*Nr|Lieferdatum)\b/i;
  const summenKopf = /^Nettobetrag\s+MwSt/i;
  const summen4 = /^-?[\d.]+,\d{2}\s+\d{1,2}(?:,\d+)?\s*%\s+-?[\d.]+,\d{2}\s+-?[\d.]+,\d{2}$/;

  // Dokument-MwSt aus der (letzten) Summenzeile
  const summen = [...fullText.matchAll(/[\d.]+,\d{2}\s+(\d{1,2}(?:,\d+)?)\s*%\s+[\d.]+,\d{2}\s+[\d.]+,\d{2}/g)];
  const mwstDoc = summen.length ? _parseDE(summen[summen.length - 1][1]) : 0;

  // Nur den Positionsbereich nehmen, Seitenköpfe und Zwischensummen überspringen
  const roh = fullText.split('\n').map(z => z.trim());
  const zeilen = [];
  let imBereich = false, imKopf = false;
  for (let i = 0; i < roh.length; i++) {
    const z = roh[i];
    if (!z) continue;
    if (/^Pos\.\s+Bezeichnung/i.test(z)) { imBereich = true; imKopf = false; continue; }
    if (!imBereich) continue;
    if (/^Seite\s*:?\s*\d/i.test(z)) { imKopf = true; continue; }
    if (imKopf) continue;
    if (summenKopf.test(z)) {
      const naechste = roh.slice(i + 1).find(x => x);
      if (naechste && summen4.test(naechste)) break;      // echte Endsumme: Positionsbereich zu Ende
      continue;                                          // Zwischensumme auf einer Folgeseite
    }
    if (/^\d{1,2}(?:,\d+)?\s*%\s+-?[\d.]+,\d{2}$/.test(z)) continue;   // "19,00 % 0,00"
    if (/^Zahlungsbedingung\b/i.test(z)) break;
    zeilen.push(z);
  }

  const items = [];
  let offen = null;            // aktuelle Position
  let bestellung = [];         // Bestellblock für die nächste Position
  const neuePos = (posnr, artikel) => {
    offen = { posnr, artikel: (artikel || '').replace(/\s{2,}/g, ' ').trim(), details: [], hinweise: bestellung.slice(),
      bestellposition: _bestellposition(bestellung), menge: null, einheit: 'C62', einzelpreis: 0, preis: false };
    bestellung = [];
    items.push(offen);
    return offen;
  };
  const letzteNr = () => {
    for (let i = items.length - 1; i >= 0; i--) if (/^\d+$/.test(items[i].posnr)) return Number(items[i].posnr);
    return 0;
  };

  for (const z of zeilen) {
    let m;
    if (bestellZeile.test(z) && !(offen && /^Kommission\s*:/i.test(z))) {
      bestellung.push(z.replace(/\s+/g, ' '));
      offen = null;
      continue;
    }
    if ((m = z.match(mitNr))) {
      const p = neuePos(_normPosNr(m[1]), m[2] || '');
      p.menge = _parseDE(m[3]) || 1;
      p.einheit = _unitCode(m[4]);
      const gesamt = _parseDE(m[6]);
      p.einzelpreis = _preisAusGesamt(gesamt, p.menge, _parseDE(m[5]));
      p.preis = true;
      continue;
    }
    if ((m = z.match(nurKopf)) && Number(m[1]) === letzteNr() + 1 && !/\d{2}\.\d{2}\.\d{4}/.test(z)) {
      neuePos(_normPosNr(m[1]), m[2]);
      continue;
    }
    if ((m = z.match(ohneNr)) && !lsZeile.test(z)) {
      const menge = _parseDE(m[2]) || 1;
      const gesamt = _parseDE(m[5]);
      let p;
      if (offen && !offen.preis) {
        // Preis zur Position davor (z. B. Storno: Kopfzeile ohne Preis, Preis weiter unten)
        p = offen;
        p.preisText = m[1].trim();
      } else {
        const basis = letzteNr() || 1;
        const geschwister = items.filter(x => String(x.posnr).startsWith(basis + '.')).length;
        p = neuePos(`${basis}.${geschwister + 1}`, m[1]);
      }
      p.menge = menge;
      p.einheit = _unitCode(m[3]);
      p.einzelpreis = _preisAusGesamt(gesamt, menge, _parseDE(m[4]));
      p.preis = true;
      continue;
    }
    if (!offen) continue;
    if (lsZeile.test(z)) { offen.hinweise.push(z.replace(/\s+/g, ' ')); continue; }
    offen.details.push(z);
  }

  const fertig = items.filter(p => p.preis).map(p => {
    // Name (BT-153): Artikel + erste sprechende Detailzeile, wie bisher
    const sprechend = p.details.find(d => d.length >= 3 && !/^[-\d.,\s%\/#]+$/.test(d) && !/^\d/.test(d))
      || p.details.find(d => d.length >= 3) || '';
    const zusatz = p.preisText || sprechend;   // bepreiste Zeile (Storno) geht vor
    const name = p.artikel ? (zusatz && zusatz !== p.artikel ? `${p.artikel} – ${zusatz}` : p.artikel) : zusatz;
    return {
      posnr: p.posnr,
      beschreibung: name || 'Position ' + p.posnr,
      details: p.details.join('\n'),                 // BT-154 Positionsbeschreibung
      positionsnotiz: p.hinweise.join('\n'),         // BT-127 Positionshinweis
      bestellposition: p.bestellposition,            // BT-132
      menge: p.menge,
      einheit: p.einheit,
      einzelpreis: p.einzelpreis,
      mwst: mwstDoc,
    };
  });

  return _validateAndFallback(fertig, _extractNetTotalZai(fullText), mwstDoc);
}

/**
 * Einzelpreis so wählen, dass Menge mal Preis den gedruckten Gesamtpreis ergibt.
 * Das ERP rechnet mit mehr Stellen als es druckt (3 x 160,88 = 482,64, gedruckt 482,63).
 * Daher der gedruckte Preis, wenn er passt, sonst so wenige Nachkommastellen wie nötig.
 */
function _preisAusGesamt(gesamt, menge, gedruckt) {
  if (!(menge > 0)) return gedruckt;
  const r2 = x => Math.round(x * 100) / 100;
  // Gedruckter Preis (ggf. je 3 Stück umgerechnet) mit so wenigen Stellen wie möglich
  for (const st of [2, 3, 4, 6]) {
    const f = Math.pow(10, st), p = Math.round(gedruckt * f) / f;
    if (r2(menge * p) === r2(gesamt)) return p;
  }
  if (r2(menge * gedruckt) === r2(gesamt)) return gedruckt;
  for (const st of [3, 4, 6]) {
    const f = Math.pow(10, st);
    const preis = Math.round(gesamt / menge * f) / f;
    if (r2(menge * preis) === r2(gesamt)) return preis;
  }
  return gesamt / menge;
}

/** Positionsnummer der Bestellung aus "Best.Nr. 4500012345 Pos. 20" bzw. "… / M21 Pos. 4". */
function _bestellposition(bestellung) {
  const z = (bestellung || []).find(x => /Best\.?\s*-?\s*Nr/i.test(x)) || '';
  const m = z.match(/\bPos\.?\s*(\d+(?:\s*[+,]\s*\d+)*)/i);
  return m ? m[1].replace(/\s+/g, '') : '';
}

/* ══════════════════════════════════════════════════════
   EWA · Eisenwerk Arnstadt (SAP mit Adobe-Formular)
   Deutsch, englisch, französisch; Währung laut Beleg (EUR, GBP, CZK …).
   Im Kopf stehen links die Anschriften, rechts Beschriftung und Wert in
   zwei Spalten. Die Zeilen mischt pdf.js, daher liest der Kopf über die
   x-Position der Textstücke, Positionen und Summen über die Zeilen.
══════════════════════════════════════════════════════ */
function _isEwaInvoice(text) {
  return /Eisenwerk Arnstadt GmbH\s*\|\s*Bierweg/i.test(text);
}

/** Zahl im Format der Belegsprache: en 32,400.00 · de 32.400,00 · fr 32 400,00 */
function _ewaZahl(s, sprache) {
  let t = String(s || '').trim().replace(/\s+/g, ' ');
  if (sprache === 'en') t = t.replace(/,/g, '');
  else t = t.replace(sprache === 'fr' ? / /g : /\./g, '').replace(/ /g, '').replace(',', '.');
  const n = parseFloat(t);
  return isFinite(n) ? n : 0;
}

const _EWA_LABEL = [
  ['nummer', /^(?:Nummer|Number|Numéro)$/i],
  ['datum', /^(?:Datum|Date)$/i],
  ['auftrag', /^(?:Kundenauftrag|Order Number|notre no\. de commande)\b\s*(.*)$/i],
  ['bestellung', /^(?:Referenznummer|Reference Number|votre no\. de commande)\b\s*(.*)$/i],
  ['lieferung', /^(?:Lieferungsnummer|Delivery Number|Numéro de livraison)\b\s*(.*)$/i],
  ['kunde', /^(?:Kundennummer|Customer Number|Numéro de client)\b\s*(.*)$/i],
  ['leistung', /^(?:Liefer\/Leistungsdatum|Delivery\/Service date|Date de livraison\/?)\s*(.*)$/i],
  ['ihreUst', /^(?:Ihre UST-ID|Your tax Number|Votre numéro de TVA)\b\s*(.*)$/i],
  ['unsereUst', /^(?:Unsere UST-ID|Our tax Number|Notre numéro de TVA)\b\s*(.*)$/i],
  ['bearbeiter', /^(?:Sachbearbeiter|Clerk|responsable du dossier)\b\s*(.*)$/i],
];
const _EWA_VERSAND = /^(?:Versandanschrift|Ship-to address|Adresse d'expédition)$/i;

function extractEwa(fullText, items) {
  const r = {};
  const titel = (fullText.match(/^(Rechnung|Gutschrift|Invoice|Credit\s+memo|Credit\s+note|Facture|Avoir)$/im) || [])[1] || '';
  const sprache = /^(?:Invoice|Credit)/i.test(titel) ? 'en' : /^(?:Facture|Avoir)/i.test(titel) ? 'fr' : 'de';
  r.rechnungsart = /^(?:Gutschrift|Credit|Avoir)/i.test(titel) ? '381' : '380';
  const zahl = s => _ewaZahl(s, sprache);
  const BETRAG = sprache === 'en' ? '-?\\d{1,3}(?:,\\d{3})*\\.\\d{2}' : sprache === 'fr' ? '-?\\d{1,3}(?: \\d{3})*,\\d{2}' : '-?\\d{1,3}(?:\\.\\d{3})*,\\d{2}';
  const MENGE = sprache === 'en' ? '\\d{1,3}(?:,\\d{3})*(?:\\.\\d+)?' : sprache === 'fr' ? '\\d{1,3}(?: \\d{3})*(?:,\\d+)?' : '\\d{1,3}(?:\\.\\d{3})*(?:,\\d+)?';
  const datum = s => {
    const de = String(s || '').match(/(\d{2})\.(\d{2})\.(\d{4})/);
    if (de) return `${de[3]}-${de[2]}-${de[1]}`;
    const iso = String(s || '').match(/(\d{4})-(\d{2})-(\d{2})/);
    return iso ? iso[0] : '';
  };

  // ── Kopf aus den Textstücken der ersten Seite ────────────────────────────
  const s1 = (items || []).filter(it => (it.page || 1) === 1 && it.text && it.text.trim());
  const rel = it => it.x / (it.pw || 595);
  const iWaehrung = s1.find(it => /^(?:Währung|Currency|Monnaie)$/i.test(it.text.trim()));
  const yGrenze = iWaehrung ? iWaehrung.y : 0;
  if (iWaehrung) {
    const w = s1.find(it => it !== iWaehrung && Math.abs(it.y - iWaehrung.y) < 3 && rel(it) > rel(iWaehrung));
    if (w && /^[A-Z]{3}$/.test(w.text.trim())) r.waehrung = w.text.trim();
  }
  const kopf = s1.filter(it => it.y > yGrenze + 2 && rel(it) < 0.85 && !/Bierweg 4 \||Arnstadt GmbH \|/.test(it.text));
  const zeilen = liste => {
    const out = [];
    liste.slice().sort((a, b) => b.y - a.y || a.x - b.x).forEach(it => {
      const z = out[out.length - 1];
      if (z && Math.abs(z.y - it.y) < 3) z.text += ' ' + it.text.trim();
      else out.push({ y: it.y, text: it.text.trim() });
    });
    return out;
  };
  const links = zeilen(kopf.filter(it => rel(it) < 0.45)).map(z => z.text);
  const labels = kopf.filter(it => rel(it) >= 0.45 && rel(it) < 0.70);
  const werte = kopf.filter(it => rel(it) >= 0.70);
  const kopfWerte = {};
  const verbraucht = new Set();
  for (const l of labels.sort((a, b) => b.y - a.y)) {
    for (const [key, re] of _EWA_LABEL) {
      const m = l.text.trim().match(re);
      if (!m) continue;
      let wert = (m[1] || '').trim();
      if (!wert) {
        const w = werte.filter(x => !verbraucht.has(x) && Math.abs(x.y - l.y) <= 9)
          .sort((a, b) => Math.abs(a.y - l.y) - Math.abs(b.y - l.y))[0];
        if (w) { verbraucht.add(w); wert = w.text.trim(); }
      }
      if (wert && !kopfWerte[key]) kopfWerte[key] = wert;
      break;
    }
  }
  if (kopfWerte.nummer) r.rechnungsnummer = kopfWerte.nummer;
  if (kopfWerte.datum) r.rechnungsdatum = datum(kopfWerte.datum);
  if (kopfWerte.bestellung) r.bestellnummer = kopfWerte.bestellung;
  if (kopfWerte.lieferung) r.lieferscheinnummer = kopfWerte.lieferung;
  if (kopfWerte.kunde) r.kundennummer = kopfWerte.kunde;
  if (kopfWerte.leistung) r.lieferdatum = datum(kopfWerte.leistung);
  if (kopfWerte.ihreUst) r.kaeufervat = kopfWerte.ihreUst.replace(/\s+/g, '');
  if (kopfWerte.bearbeiter) r.verkaeufkontakt = kopfWerte.bearbeiter;

  // Anschriften: Rechnungsempfänger, danach ggf. Versandanschrift
  const iVersand = links.findIndex(l => _EWA_VERSAND.test(l));
  const kaeuferZeilen = iVersand >= 0 ? links.slice(0, iVersand) : links;
  const mails = [];
  const ohneMail = kaeuferZeilen.filter(l => {
    const m = l.match(/^[\w.+-]+@[\w-]+(?:\.[\w-]+)+$/);
    if (m) mails.push(m[0]);
    return !m;
  });
  if (mails.length) r.kaeufermail = mails[0];                 // BT-49 steht bei manchen Kunden im Anschriftfeld
  const k = _ewaAnschrift(ohneMail);
  Object.assign(r, { kaeufer: k.name, kaeuferzusatz: k.zusatz, kaeuferstrasse: k.strasse, kaeuferplz: k.plz, kaeuferstadt: k.stadt, kaeuferland: k.land });
  if (iVersand >= 0) {
    const v = _ewaAnschrift(links.slice(iVersand + 1));
    if (v.name && !(v.strasse === k.strasse && v.plz === k.plz)) {
      Object.assign(r, { lieferName: v.name, lieferStrasse: v.strasse, lieferPlz: v.plz, lieferStadt: v.stadt, lieferLand: v.land });
    } else if (v.land) r.lieferLand = v.land;
  }

  // ── Zeilen unterhalb des Kopfs ───────────────────────────────────────────
  const z = fullText.split('\n').map(l => l.trim()).filter(Boolean);
  const SEITENKOPF = /^(?:Beleg|Document)\s+\d+$|^(?:Datum|Date)\s+\d{2}\.\d{2}\.\d{4}\s+(?:Seite|Page)|^(?:Seite|Page)\s*\d+\s*(?:von|of|de)\s*\d+$/i;
  const FUSS = /^Eisenwerk Arnstadt GmbH\s*·|^Mail info@ewa-guss|^Geschäftsführung\s/;
  const iZahl = z.findIndex(l => /^(?:Zahlungsbedingungen|Terms of payment|Conditions de paiement)\b/i.test(l));
  const iLief = z.findIndex(l => /^(?:Lieferbedingungen|Terms of delivery|Conditions de livraison)\b/i.test(l));
  let zahlung = '';
  if (iZahl >= 0) {
    const teile = [z[iZahl].replace(/^(?:Zahlungsbedingungen|Terms of payment|Conditions de paiement)\s*/i, '')];
    for (let i = iZahl + 1; i < (iLief > iZahl ? iLief : iZahl + 3); i++) teile.push(z[i]);
    zahlung = teile.filter(Boolean).join('; ');
    // Fälligkeit: Datum „ohne Abzug", sonst das letzte Datum
    const netto = zahlung.match(/(\d{2}\.\d{2}\.\d{4}|\d{4}-\d{2}-\d{2})[^;]*?(?:ohne Abzug|without deduction)|(?:Sans déduction jusqu'au|Up to)\s+(\d{2}\.\d{2}\.\d{4}|\d{4}-\d{2}-\d{2})\s*(?:without deduction)?(?:;|$)/i);
    const alle = [...zahlung.matchAll(/\d{2}\.\d{2}\.\d{4}|\d{4}-\d{2}-\d{2}/g)].map(m => m[0]);
    const f = netto ? (netto[1] || netto[2]) : alle[alle.length - 1];
    if (f) r.faelligkeitsdatum = datum(f);
  }
  const lieferbedingung = iLief >= 0 ? z[iLief].replace(/^(?:Lieferbedingungen|Terms of delivery|Conditions de livraison)\s*/i, '') : '';

  // ── Positionen ───────────────────────────────────────────────────────────
  const posRe = /^(\d{1,4})\s+(?:Material|Matériel)\s+(.+)$/i;
  const iErste = z.findIndex(l => posRe.test(l));
  const iSumme = z.findIndex(l => /^(?:Gesamtbetrag ohne Steuer|Total net value|Total sans taxe)\b/i.test(l));
  const bereich = iErste >= 0 ? z.slice(iErste, iSumme > iErste ? iSumme : z.length) : [];
  const zeileBetrag = new RegExp('^(.*?)\\s*(' + BETRAG + ')$');
  const mengeRe = new RegExp('^(?:Menge|Quantity|Quantité)\\s+(' + MENGE + ')\\s+(\\S+)$', 'i');
  const proRe = new RegExp('(' + BETRAG + '|-?[\\d.,]+\\s*%)\\s*(?:[A-Z]{3}\\s+)?(?:pro|per|par)\\s+(' + MENGE + ')\\s+(\\S+)', 'i');
  const items2 = [];
  let p = null, imKond = false, warennr = false;
  for (const l of bereich) {
    if (SEITENKOPF.test(l) || FUSS.test(l)) continue;
    let m;
    if ((m = l.match(posRe))) {
      p = { posnr: m[1], text: m[2].trim(), menge: 1, einheit: 'Stk', preis: null, preisMenge: 1, betraege: [], nettowert: null, details: [], notiz: [] };
      items2.push(p); imKond = false; warennr = false;
      continue;
    }
    if (!p) continue;
    if ((m = l.match(/^(?:Kundenmaterial|Customer Material|Matériel du client)\s+(.+)$/i))) { p.details.push('Kundenmaterial ' + m[1]); continue; }
    if ((m = l.match(mengeRe))) { p.menge = zahl(m[1]); p.einheit = /^(?:KG)$/i.test(m[2]) ? 'kg' : 'Stk'; continue; }
    if ((m = l.match(/^(?:Konditionen|Conditions)\b\s*(.*)$/i))) { imKond = true; if (!m[1]) continue; }
    if (imKond && (m = (/^(?:Konditionen|Conditions)\b/i.test(l) ? l.replace(/^(?:Konditionen|Conditions)\s*/i, '') : l).match(zeileBetrag)) && /(?:pro|per|par)\s|%/i.test(m[1])) {
      const betrag = zahl(m[2]);
      const name = m[1].replace(/\s+-?\d[\d.,\s]*\s*(?:%|[A-Z]{3}\s+(?:pro|per|par)\b.*)$/i, '').trim();
      if (/^(?:Nettowert|Net value|Valeur nette)/i.test(name)) p.nettowert = betrag;
      else {
        p.betraege.push(betrag);
        const pro = m[1].match(proRe);
        // Erste Kondition mit „pro" ist der Grundpreis, alles Weitere (Zuschlag, Abschlag) steht in der Beschreibung
        if (p.preis === null && pro && !/%$/.test(pro[1].trim())) { p.preis = zahl(pro[1]); p.preisMenge = zahl(pro[2]) || 1; }
        else p.details.push(`${m[1].trim()} = ${m[2]}`);
      }
      continue;
    }
    imKond = false;
    if (/^(?:Statistische Warennr\.|Commodity code|Code statistique des)\s*$/i.test(l)) { warennr = true; continue; }
    if (/^marchandises$/i.test(l)) continue;                    // zweite Zeile von „Code statistique des marchandises“
    if (warennr && /^\d{6,10}$/.test(l)) { p.details.push('Warennr. ' + l); warennr = false; continue; }
    if ((m = l.match(/^(?:Statistische Warennr\.|Commodity code)\s+(\d+)$/i))) { p.details.push('Warennr. ' + m[1]); continue; }
    if (/^(?:zu Bestellung|Gutschriftsanforderung|Charge|Lieferschein|Delivery note)\b/i.test(l)) { p.notiz.push(l); continue; }
    p.details.push(l);
  }

  // ── Summen, Zuschläge auf Belegebene, Hinweise ───────────────────────────
  let netto = null, satz = null;
  const notiz = [];
  let imBank = false;
  for (let i = iSumme >= 0 ? iSumme : z.length; i < z.length; i++) {
    const l = z[i];
    let m;
    if (SEITENKOPF.test(l) || FUSS.test(l)) continue;
    if ((m = l.match(new RegExp('^(?:Gesamtbetrag ohne Steuer|Total net value|Total sans taxe)\\s+(' + BETRAG + ')$', 'i')))) { netto = zahl(m[1]); continue; }
    if ((m = l.match(new RegExp('^(?:Umsatzsteuer|Value added tax|Taxe|TVA)\\s+([\\d.,]+)\\s*%\\s+(' + BETRAG + ')$', 'i')))) {
      satz = zahl(m[1]); r.steuerbetrag = zahl(m[2]); continue;
    }
    if ((m = l.match(new RegExp('^(?:Endbetrag|Final amount|Montant final)\\s+(' + BETRAG + ')$', 'i')))) { r.gesamtbetrag = zahl(m[1]); continue; }
    // Zuschlag auf Belegebene, z. B. „Verpackungszuschlag 1,14 EUR pro 1 ST 408,12"
    if (satz === null && (m = l.match(zeileBetrag)) && /(?:pro|per|par)\s/i.test(m[1])) {
      const pro = m[1].match(proRe);
      const betrag = zahl(m[2]);
      const name = m[1].replace(/\s*-?[\d.,]+.*$/, '').trim() || 'Zuschlag';
      const menge = pro && zahl(pro[1]) ? Math.round(betrag / (zahl(pro[1]) / (zahl(pro[2]) || 1)) * 1000) / 1000 : 1;
      items2.push({ posnr: '', text: name, menge, einheit: 'Stk', preis: pro ? zahl(pro[1]) : betrag, preisMenge: pro ? zahl(pro[2]) || 1 : 1,
        betraege: [betrag], nettowert: null, details: [], notiz: [], belegebene: true });
      continue;
    }
    if (/^(?:Bankverbindung|Bank details|coordonnées bancaires)\s*:?$/i.test(l)) { imBank = true; continue; }
    if (imBank) { if (/^(?:Kontoinhaber|Account holder|propriétaire du compte)\b/i.test(l)) imBank = false; continue; }
    notiz.push(l);
  }
  const mwst = satz !== null ? satz : 19;

  // Steuerart
  const text = fullText;
  if (mwst > 0) r.steuerkategorie = 'S';
  else if (/innergemeinschaftlich|intra-?community|intracommunautaire/i.test(text)) r.steuerkategorie = 'K';
  else if (/export|Ausfuhr/i.test(text)) r.steuerkategorie = 'G';
  if (r.steuerkategorie === 'K' && !r.lieferLand && r.kaeuferland && r.kaeuferland !== 'DE') r.lieferLand = r.kaeuferland;
  if (r.steuerkategorie === 'K' && !r.lieferdatum) r.lieferdatum = r.rechnungsdatum;

  // Gutschrift ohne Zahlungsziel (BR-CO-25)
  if (!zahlung && !r.faelligkeitsdatum && r.rechnungsart === '381') zahlung = 'Gutschrift';

  const kopfZeilen = [];
  if (kopfWerte.auftrag) kopfZeilen.push('Unsere Auftragsnummer ' + kopfWerte.auftrag);
  if (lieferbedingung) kopfZeilen.push('Lieferbedingung: ' + lieferbedingung);
  r.notiz = [zahlung ? 'Zahlungsbedingung: ' + zahlung : '', ...kopfZeilen, notiz.join('\n')].filter(Boolean).join('\n');

  const fertig = items2.map((x, i) => {
    const gesamt = x.nettowert !== null ? x.nettowert : x.betraege.reduce((s, b) => s + b, 0);
    const menge = x.menge || 1;
    const gedruckt = x.preis !== null ? x.preis / (x.preisMenge || 1) : gesamt / menge;
    return {
      posnr: x.posnr || String((parseInt((items2[i - 1] || {}).posnr, 10) || 0) + 10),
      beschreibung: x.text,
      details: x.details.join('\n'),
      positionsnotiz: x.notiz.join('\n'),
      menge,
      einheit: x.einheit,
      einzelpreis: _preisAusGesamt(Math.round(gesamt * 100) / 100, menge, gedruckt),
      mwst,
    };
  });
  const erwartet = netto !== null ? netto + items2.filter(x => x.belegebene).reduce((s, x) => s + x.betraege[0], 0) : null;
  r.positionen = _validateAndFallback(fertig, erwartet, mwst);
  return r;
}

/**
 * Anschriftzeilen: Name, ggf. Zusatz, Straße, PLZ und Ort, Land.
 * Formate: „10115 Berlin", „SE-411 01 STADT / SCHWEDEN", „110 00 STADT",
 * britisch Ort und Postcode auf eigenen Zeilen („SAMPLETON", „AB1 2CD").
 */
function _ewaAnschrift(zeilen) {
  const a = zeilen.map(l => l.trim()).filter(Boolean);
  const r = { name: '', zusatz: '', strasse: '', plz: '', stadt: '', land: 'DE' };
  if (!a.length) return r;
  const landCode = l => (/^[A-ZÄÖÜß ]{3,30}$/.test(l) ? _countryCode(l, true) : '');
  if (a.length > 2 && landCode(a[a.length - 1])) r.land = landCode(a.pop());
  let iOrt = -1;
  for (let i = a.length - 1; i > 0; i--) {
    if (/^[A-Z]{1,2}\d[A-Z\d]?\s?\d[A-Z]{2}$/.test(a[i]) && i > 1) {          // britischer Postcode
      r.plz = a[i]; r.stadt = a[i - 1]; iOrt = i - 1; break;
    }
    const m = a[i].match(/^(?:[A-Z]{1,2}-)?(\d{3}\s\d{2}|\d{4,6})\s+(.+?)(?:\s*\/\s*[A-ZÄÖÜß ]+)?$/);
    if (m) { r.plz = m[1]; r.stadt = m[2].trim(); iOrt = i; break; }
  }
  if (iOrt < 0) { r.name = a[0]; r.strasse = a.slice(1).join(', '); return r; }
  r.strasse = iOrt >= 2 ? a[iOrt - 1] : '';
  const vorStrasse = a.slice(0, iOrt >= 2 ? iOrt - 1 : iOrt);
  const RECHTSFORM = /\b(?:GmbH|AG|KG|SE|Ltd\.?|Limited|S\.?A\.?|a\.\s?s\.|s\.r\.o\.|S\.p\.A\.|S\.r\.l\.|Inc\.?|AB|BV|NV|Co\.)\b/i;
  r.name = vorStrasse[0] || '';
  const rest = vorStrasse.slice(1);
  // Rechtsform in der zweiten Zeile („Muster-Armaturen" / „Beispiel GmbH & Co. KG") gehört zum Namen
  if (rest.length && !RECHTSFORM.test(r.name) && RECHTSFORM.test(rest[0])) r.name += ' ' + rest.shift();
  r.zusatz = rest.join(', ');
  return r;
}

/* ══════════════════════════════════════════════════════
   EIS · DIHAG Gienanth (SAP-Formular mit VDA-Feldnummern)
   Rechnung, Lastschrift (Überschrift „Rechnung"), Gutschrift, Anzahlung;
   deutsch oder englisch (Invoice, Credit Memo, Down payment req.).
   Kopffelder stehen als Beschriftung mit Wert in der nächsten Zeile.
══════════════════════════════════════════════════════ */
function _isEisInvoice(text) {
  return /Ramsener\s+Str/i.test(text) && /(Konto bei Empfänger|account number at recipient)/i.test(text);
}

const _EIS_DATUM = /(\d{2}\.\d{2}\.\d{4})/;
const _EIS_FUSS = /^(?:DIHAG Gienanth GmbH\s*·|Handelsregister\s+Amtsgericht|IBAN\s+DE\d{2}\s)/;
const _EIS_SEITENKOPF = /^(?:Rechnung|Gutschrift|Lastschrift|Invoice|Credit\s+Memo|Credit\s+note|Down\s+payment\s+req\.?)\s+Nr\.?\s*(\d{6,10})\s+(?:vom|from)\s+(\d{2}\.\d{2}\.\d{4})/i;
const _EIS_TITEL = /^(?:Rechnung|Gutschrift|Lastschrift|Invoice|Credit\s+Memo|Credit\s+note|Down|payment\s+req\.?|Anzahlung\w*|Schlussrechnung)$/i;

function extractEis(fullText) {
  const z = fullText.split('\n').map(l => l.trim()).filter(Boolean);
  const r = {};
  const idx = (re, ab = 0) => { for (let i = ab; i < z.length; i++) if (re.test(z[i])) return i; return -1; };

  // ── Kopf bis zur Kundennummer ────────────────────────────────────────────
  const iKunde = idx(/^(?:Kundennummer|customer number)\b/i);
  const kopf = z.slice(0, iKunde > 0 ? iKunde : 20);
  const kopfText = kopf.join('\n');
  if (/^(?:Gutschrift|Credit\s+(?:Memo|note))\b/im.test(kopfText)) r.rechnungsart = '381';
  else if (/^(?:Down$|Anzahlung)/im.test(kopfText)) r.rechnungsart = '386';
  else r.rechnungsart = '380';

  const seitenkopf = z.map(l => l.match(_EIS_SEITENKOPF)).find(Boolean);
  const benutzt = new Set();
  // Belegnummer: Zeile nach „Nummer" bzw. „no." (nicht „delivery note no.")
  const iNr = kopf.findIndex(l => (/(?:^|\s)Nummer$/.test(l) || /(?:^|\s)no\.$/i.test(l)) && !/delivery note no\./i.test(l));
  if (iNr >= 0) {
    for (let k = iNr + 1; k <= iNr + 2 && k < kopf.length; k++) {
      const m = kopf[k].match(/(?:^|\s)(\d{6,10})$/);
      // Steht nur die Nummer in der Zeile, ist sie verbraucht; sonst trägt die Zeile auch PLZ und Ort
      if (m) { r.rechnungsnummer = m[1]; if (kopf[k] === m[1]) benutzt.add(k); break; }
    }
  }
  if (!r.rechnungsnummer && seitenkopf) r.rechnungsnummer = seitenkopf[1];
  // Belegdatum: Zeile nach „Datum" bzw. „date"
  const iDat = kopf.findIndex(l => /(?:^|\s)(?:Datum|date)$/.test(l) && !/dispatch date$/i.test(l));
  for (let k = iDat + 1; iDat >= 0 && k <= iDat + 2; k++) {
    const m = (z[k] || '').match(_EIS_DATUM);
    if (m) { r.rechnungsdatum = _deDate(m[1]); if (k < kopf.length) benutzt.add(k); break; }
  }
  if (!r.rechnungsdatum && seitenkopf) r.rechnungsdatum = _deDate(seitenkopf[2]);
  // Versanddatum (4) = Leistungsdatum
  const iVers = kopf.findIndex(l => /(?:Versanddatum|dispatch date)$/i.test(l));
  if (iVers >= 0 && /^\d{2}\.\d{2}\.\d{4}$/.test(kopf[iVers + 1] || '')) {
    r.lieferdatum = _deDate(kopf[iVers + 1]); benutzt.add(iVers + 1);
  }
  // Reine Zahlenzeilen im Kopf: Lieferschein (80…) und Konto bei Empfänger
  kopf.forEach((l, k) => {
    if (k < 2 || benutzt.has(k) || !/^\d[\d ]*$/.test(l)) return;
    benutzt.add(k);
    for (const t of l.split(/\s+/)) {
      if (/^80\d{6}$/.test(t)) r.lieferscheinnummer = r.lieferscheinnummer || t;
      else if (!r.lieferantennummer) r.lieferantennummer = t;   // BT-29: unser Konto beim Kunden
    }
  });

  // Rechnungsadresse: übrige Kopfzeilen ohne Beschriftungen, Titel und Werte
  const adresse = [];
  kopf.forEach((l, k) => {
    if (k < 2 || benutzt.has(k)) return;
    if (/Konto bei Empfänger|account number|Rechnungsadresse|invoice address|Versanddatum|dispatch date/i.test(l)) return;
    if (_EIS_TITEL.test(l) || /^(?:Datum|date|Nummer|no\.)$/i.test(l) || /^\d{2}\.\d{2}\.\d{4}$/.test(l)) return;
    let rein = l.replace(/\s+(?:Nummer|no\.|Datum|date)$/i, '').trim();
    if (r.rechnungsnummer && rein.endsWith(' ' + r.rechnungsnummer)) rein = rein.slice(0, -r.rechnungsnummer.length).trim();
    if (rein) adresse.push(rein);
  });
  Object.assign(r, _eisAdresse(adresse));

  // Kundennummer und USt-IdNr. des Kunden
  if (iKunde >= 0) {
    const werte = (z[iKunde + 1] || '').split(/\s+/);
    const nr = werte.find(t => /^\d{5,10}$/.test(t));
    const vat = werte.find(t => /^[A-Z]{2}[A-Z0-9]{5,14}$/.test(t) && !/^Page/i.test(t));
    if (nr) r.kundennummer = nr;
    if (vat) r.kaeufervat = vat;
  }

  // ── Bestellblock (10) bis (14) ───────────────────────────────────────────
  const i10 = idx(/^\(10\)\s*(?:Ihr Zeichen|your reference)/i);
  const i20 = idx(/^(?:frei|free)\s*\(20\)/i);
  let auftrag = '', bestelldatum = '';
  if (i10 >= 0 && i20 > i10) {
    const block = z.slice(i10 + 1, i20).filter(l => !/^Auftragsnummer$/i.test(l));
    const erste = block[0] || '';
    // „Bestellnummer Nachname Vorname Durchwahl", die Durchwahl kann fehlen
    const m = erste.match(/^(\S+)\s+([A-Za-zÄÖÜäöüß][^\d]*?)(?:\s+((?:\(0\)\s*)?\d[\d\/\- ]{4,}))?$/);
    if (m) {
      r.bestellnummer = m[1];
      r.verkaeufkontakt = m[2].trim();
      if (m[3]) r.verkaeuftel = m[3].trim();
    } else if (/^\S+$/.test(erste)) r.bestellnummer = erste;
    block.slice(1).forEach(l => {
      const d = l.match(/^(\d{2}\.\d{2}\.\d{4})(?:\s+(\d+))?$/);
      if (d && !bestelldatum) {
        bestelldatum = d[1];
        // Englisches Formular: der Rest der Durchwahl rutscht hinter das Bestelldatum
        if (d[2] && r.verkaeuftel && /\d$/.test(r.verkaeuftel)) r.verkaeuftel += ' ' + d[2];
      } else if (/^\d{3,10}$/.test(l) && !auftrag) auftrag = l;
    });
  }

  // Kontakt des Rechnungsstellers (BT-41 bis BT-43): SAP druckt „Nachname Vorname",
  // die Mail folgt dem Muster vorname.nachname@dihag-gienanth.com
  if (r.verkaeufkontakt) r.verkaeuferemail = _eisKontaktMail(r.verkaeufkontakt);
  if (!r.verkaeuftel) r.verkaeuftel = '+49 6351 408-0';

  // ── Lieferbedingung (15) ─────────────────────────────────────────────────
  let lieferbedingung = '';
  if (i20 >= 0) {
    const l1 = (z[i20 + 1] || '').replace(/\s+(?:gewicht|weight)$/i, '').trim();
    const l2 = (z[i20 + 2] || '').replace(/^X\s*/, '').replace(/(?:\s+[\d.]+){1,2}$/, '')
      .replace(/\s+(?:LKW|Bahn|Schiff|See\w*|Luft\w*|Paket\w*|Spedition|Kurier|Abholung)$/i, '').trim();
    lieferbedingung = [l1, /^[A-Za-zÄÖÜäöüß][\wÄÖÜäöüß .\/-]*$/.test(l2) ? l2 : ''].filter(Boolean).join(' ');
  }

  // ── Versandanschrift (25) und Zahlungsbedingung ──────────────────────────
  const i25 = idx(/^\(25\)\s*(?:Versandanschrift|shipping-address)/i);
  let zahlung = '';
  if (i25 >= 0) {
    let l1 = z[i25 + 1] || '';
    const zb = l1.match(/\s(\d+\s+(?:Tage|days)\b.*|sofort.*|immediately.*)$/i);
    if (zb) { zahlung = zb[1].trim(); l1 = l1.slice(0, zb.index).trim(); }
    const strasse = (z[i25 + 2] || '').replace(/\s*(?:Fälligkeitsdatum|Due date)\s*:.*$/i, '').trim();
    const m = l1.match(/^(\d{6,8})\s+(.+?)\s+(\d{5})\s+(.+)$/);
    if (m && m[1] !== r.kundennummer) {
      // SAP kürzt den Namen auf 35 Zeichen: gleicher Anfang wie der Kunde → voller Name
      const kurz = m[2].replace(/\s+\S{0,3}$/, '');
      const name = r.kaeufer && kurz.length > 10 && r.kaeufer.startsWith(kurz) ? r.kaeufer : m[2];
      Object.assign(r, { lieferName: name, lieferStrasse: strasse, lieferPlz: m[3], lieferStadt: m[4], lieferLand: 'DE' });
    }
  }
  const faellig = fullText.match(/(?:Fälligkeitsdatum|Due date)\s*:\s*(\d{2}\.\d{2}\.\d{4})/i);
  if (faellig) r.faelligkeitsdatum = _deDate(faellig[1]);

  // ── Positionen ───────────────────────────────────────────────────────────
  const iPos = idx(/^Pos\.\s*\(21\)/i);
  const iSumme = idx(/^(?:Summe Positionen|Total Amount Before Tax)\b/i, iPos + 1);
  const bereich = iPos >= 0 ? z.slice(iPos + 1, iSumme > iPos ? iSumme : z.length) : [];
  const kopfNotiz = [];
  const items = [];
  let offen = null, imShipTo = false, shipTo = [];
  const posRe = /^(\d{3})\s+(.+?)\s+(\d{1,3}(?:\.\d{3})*(?:,\d+)?)\s+(\d)(?:\s+(-?[\d.]+,\d{2})\s+(-?[\d.]+,\d{2}))?$/;
  for (const l of bereich) {
    if (_EIS_FUSS.test(l) || _EIS_SEITENKOPF.test(l) || /^\(2[78]\)|^Pos\.\s*\(21\)/i.test(l)) continue;
    let m;
    if ((m = l.match(posRe))) {
      offen = { posnr: _normPosNr(m[1]), text: m[2], menge: _parseDE(m[3]), preis: m[5] ? _parseDE(m[5]) : null,
        gesamt: m[6] ? _parseDE(m[6]) : null, einheit: 'Stk', preiseinheit: 1, details: [], notiz: [] };
      items.push(offen);
      imShipTo = false;
      continue;
    }
    if (!offen) {
      // Zeilen vor der ersten Position: Bezug, Grund, abweichende Anschriften
      if (/^Ship to ad+ress/i.test(l)) { imShipTo = true; continue; }
      if (/^Bill to/i.test(l)) { imShipTo = false; }
      if (imShipTo) { shipTo.push(l); continue; }
      kopfNotiz.push(l);
      continue;
    }
    if (offen.gesamt === null && (m = l.match(/^(-?[\d.]+,\d{2})\s+(-?[\d.]+,\d{2})$/))) {
      offen.preis = _parseDE(m[1]); offen.gesamt = _parseDE(m[2]);
      continue;
    }
    if ((m = l.match(/^(.*?)\s*\/\s*(\d+)\s+([A-Z]{1,4})$/))) {
      offen.preiseinheit = parseInt(m[2], 10) || 1;
      offen.einheit = /^(?:KG)$/i.test(m[3]) ? 'kg' : /^(?:M)$/i.test(m[3]) ? 'm' : 'Stk';
      if (m[1]) offen.details.push(/^\S+$/.test(m[1]) ? 'Sach-Nr. ' + m[1] : m[1]);
      continue;
    }
    if ((m = l.match(/^Gesamtnettowert\s+[\d.]+,\d{2}\s+(-?[\d.]+,\d{2})$/i))) {
      offen.gesamt = _parseDE(m[1]);                      // Preis inkl. Zuschlägen
      continue;
    }
    if (/^\+{3,}$/.test(l)) continue;
    if (/^(?:LS\s+\d|Lieferschein|Auftragsnummer|Bestellnummer|Neuberechnung|#\d)/i.test(l)) { offen.notiz.push(l); continue; }
    offen.details.push(l);
  }

  // ── Summen und Hinweise nach den Positionen ──────────────────────────────
  let netto = null, satz = null;
  const notiz = [];
  const anzahlungen = [];
  let imAnzahlung = false;
  for (let i = iSumme >= 0 ? iSumme : z.length; i < z.length; i++) {
    const l = z[i];
    let m;
    // Schlussrechnung: Block der erhaltenen Anzahlungen (BT-113)
    if (/^(?:payments received until|erhaltene Anzahlungen|Anzahlungen bis)/i.test(l)) { imAnzahlung = true; continue; }
    if (imAnzahlung) {
      if ((m = l.match(/^(\d{6,10})\s*\/\s*(\d{2}\.\d{2}\.\d{4})\s+[\d,]+\s+(-?[\d.]+,\d{2})\s+(-?[\d.]+,\d{2})\s+(-?[\d.]+,\d{2})$/))) {
        anzahlungen.push({ nr: m[1], datum: m[2], netto: _parseDE(m[3]), steuer: _parseDE(m[4]), brutto: _parseDE(m[5]) });
        continue;
      }
      if (/^(?:invoice no\.?\s*\/\s*date|Rechnungs?-?\s*Nr\.?\s*\/\s*Datum|total amount\s+[\d,]+\s|Summe\s+[\d,]+\s|remaining amount|Restbetrag|VAT\s+[\d,]+\s*%|MwSt\.?\s+[\d,]+\s*%|due remaining|fälliger Restbetrag)/i.test(l)) continue;
      imAnzahlung = false;
    }
    if ((m = l.match(/^(?:Summe Positionen|Total Amount Before Tax)\s+(-?[\d.]+,\d{2})$/i))) { netto = _parseDE(m[1]); continue; }
    if ((m = l.match(/^(?:Umsatzsteuer|German VAT)\s+(\d{1,2},\d{2})\s*%?\s+(-?[\d.]+,\d{2})$/i))) {
      satz = _parseDE(m[1]); r.steuerbetrag = _parseDE(m[2]); continue;
    }
    if ((m = l.match(/^(?:Endbetrag|Total Amount)\s+(-?[\d.]+,\d{2})$/i))) { r.gesamtbetrag = _parseDE(m[1]); continue; }
    if (_EIS_FUSS.test(l) || _EIS_SEITENKOPF.test(l) || /^-{5,}$|^signat/i.test(l)) continue;
    notiz.push(l);
  }
  const mwst = satz !== null ? satz : 19;

  // Schlussrechnung: bereits gezahlte Anzahlungen abziehen
  if (anzahlungen.length) {
    r.gezahlt = Math.round(anzahlungen.reduce((s, a) => s + a.brutto, 0) * 100) / 100;
    notiz.unshift('Anzahlungen: ' + anzahlungen.map(a => `${a.nr} vom ${a.datum} über ${a.brutto.toFixed(2).replace('.', ',')} EUR`).join('; '));
    if (!r.vorrechnungsnummer && anzahlungen.length === 1) {
      r.vorrechnungsnummer = anzahlungen[0].nr; r.vorrechnungsdatum = _deDate(anzahlungen[0].datum);
    }
  }

  // Bezug auf die ursprüngliche Rechnung (Gutschrift)
  const bezugText = kopfNotiz.concat(notiz).join(' ');
  const bezug = bezugText.match(/(?:GS\s+zu\s+RE|Credit note for invoice no\.?)\s*#?\s*(\d{6,10})\s+(?:vom|from)\s+(\d{2})[.\/](\d{2})[.\/](\d{4})/i);
  if (bezug) { r.vorrechnungsnummer = bezug[1]; r.vorrechnungsdatum = `${bezug[4]}-${bezug[3]}-${bezug[2]}`; }

  // Lieferort aus „Ship to adress" (letzte Zeile = Land), sonst Land des Kunden
  if (shipTo.length) {
    const land = _countryCode(shipTo[shipTo.length - 1]);
    if (/^[A-Z]{2}$/.test(land)) r.lieferLand = land;
  }
  if (!r.lieferLand && r.kaeuferland && r.kaeuferland !== 'DE') r.lieferLand = r.kaeuferland;

  // Leistungsdatum bei Sammelrechnung: letztes Lieferscheindatum
  if (!r.lieferdatum) {
    const ls = [...fullText.matchAll(/\bLS\s+\d{8}\s+vom\s+(\d{2}\.\d{2}\.\d{4})/g)].map(m => _deDate(m[1])).sort();
    if (ls.length) r.lieferdatum = ls[ls.length - 1];
  }

  // Steuerart
  if (mwst > 0) r.steuerkategorie = 'S';
  else if (/innergemeinschaftlich|intra[- ]?(?:EU|community)/i.test(fullText)) r.steuerkategorie = 'K';
  else if (/Tax-Exempt Export|Ausfuhr/i.test(fullText)) r.steuerkategorie = 'G';
  // Innergemeinschaftlich braucht ein Leistungsdatum (BR-IC-11). Ohne Versand
  // (Lastschrift, Gutschrift) gilt das Belegdatum.
  if (r.steuerkategorie === 'K' && !r.lieferdatum) r.lieferdatum = r.rechnungsdatum;

  // Gutschrift ohne Zahlungsziel: EN 16931 verlangt Fälligkeit oder Zahlungsbedingung (BR-CO-25)
  if (!zahlung && !r.faelligkeitsdatum && r.rechnungsart === '381') zahlung = 'Gutschrift';

  // Hinweis (BT-22): Bestellung, Lieferbedingung, Zahlungsbedingung, Texte des Belegs
  const kopfZeilen = [];
  if (r.bestellnummer) kopfZeilen.push(`Bestellung ${r.bestellnummer}${bestelldatum ? ' vom ' + bestelldatum : ''}${auftrag ? ', unsere Auftragsnummer ' + auftrag : ''}`);
  if (lieferbedingung) kopfZeilen.push('Lieferbedingung: ' + lieferbedingung);
  r.notiz = [zahlung ? 'Zahlungsbedingung: ' + zahlung : '', ...kopfZeilen, kopfNotiz.join('\n'), notiz.join('\n')]
    .filter(Boolean).join('\n');

  const fertig = items.filter(p => p.gesamt !== null).map(p => {
    const gedruckt = p.preis !== null ? p.preis / p.preiseinheit : 0;
    return {
      posnr: p.posnr,
      beschreibung: p.text,
      details: p.details.join('\n'),                  // BT-154
      positionsnotiz: p.notiz.join('\n'),             // BT-127
      menge: p.menge || 1,
      einheit: p.einheit,
      einzelpreis: _preisAusGesamt(p.gesamt, p.menge || 1, gedruckt),
      mwst,
    };
  });
  r.positionen = _validateAndFallback(fertig, netto, mwst);
  return r;
}

/** „Müller Anna" → anna.mueller@dihag-gienanth.com */
function _eisKontaktMail(name) {
  const teile = String(name || '').trim().toLowerCase()
    .replace(/ä/g, 'ae').replace(/ö/g, 'oe').replace(/ü/g, 'ue').replace(/ß/g, 'ss')
    .split(/\s+/).map(t => t.replace(/[^a-z-]/g, '')).filter(Boolean);
  if (teile.length < 2) return '';
  const nachname = teile[0], vorname = teile.slice(1).join('-');
  return `${vorname}.${nachname}@dihag-gienanth.com`;
}

/** Erzeugt das Werk E-Rechnungen nur für Kunden im Inland (Registry _nurInland)? */
function werkNurInland(werk) {
  const e = _COMPANY_REGISTRY[String(werk || '').toUpperCase()];
  return !!(e && e._nurInland);
}

/**
 * Anschrift aus den Kopfzeilen: Name (eine oder mehrere Zeilen), Straße,
 * PLZ und Ort, im Ausland zuletzt das Land in Großbuchstaben.
 */
function _eisAdresse(zeilen) {
  const r = {};
  const a = zeilen.slice();
  if (!a.length) return r;
  const letzte = a[a.length - 1];
  if (a.length > 2 && /^[A-ZÄÖÜ][A-ZÄÖÜ .]{1,30}$/.test(letzte)) { r.kaeuferland = _countryCode(letzte); a.pop(); }
  else r.kaeuferland = 'DE';
  let iOrt = -1;
  for (let i = a.length - 1; i > 0; i--) {
    if (/^(?:\d{4,6}|\d{3}\s\d{2})\s+\S/.test(a[i]) || /\d{3}[- ]?\d{2,4}$/.test(a[i])) { iOrt = i; break; }
  }
  if (iOrt < 0) iOrt = a.length - 1;
  const ort = a[iOrt];
  const m = ort.match(/^((?:\d{4,6}|\d{3}\s\d{2}))\s+(.+)$/) || ort.match(/^(.+?)[,\s]+([A-Z]{0,2}\s?\d{3,6}(?:-\d{3,4})?)$/);
  if (m && /^\d/.test(m[1])) { r.kaeuferplz = m[1]; r.kaeuferstadt = m[2]; }
  else if (m) { r.kaeuferstadt = m[1]; r.kaeuferplz = m[2].trim(); }
  else r.kaeuferstadt = ort;
  if (iOrt >= 2) { r.kaeuferstrasse = a[iOrt - 1]; r.kaeufer = a.slice(0, iOrt - 1).join(' '); }
  else { r.kaeufer = a.slice(0, iOrt).join(' '); }
  // Weitere Zeilen nach dem Ort (z. B. Bezirk in Indien) an die Stadt hängen
  if (iOrt < a.length - 1) r.kaeuferstadt = [r.kaeuferstadt, ...a.slice(iOrt + 1)].join(' ');
  return r;
}

/** Netto-Erwartungswert: erster Betrag der (letzten) ZAI-Summenzeile (= Nettobetrag). */
function _extractNetTotalZai(fullText) {
  const alle = [...fullText.matchAll(/(-?[\d.]+,\d{2})\s+\d{1,2}(?:,\d+)?\s*%\s+-?[\d.]+,\d{2}\s+-?[\d.]+,\d{2}/g)];
  return alle.length ? _parseDE(alle[alle.length - 1][1]) : null;
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

  // Fälligkeitsdatum: verbindlicher LETZTER Zahltermin ("net =").
  // Bei Skonto stünde der Skonto-Termin zuerst → Netto-Termin bevorzugen.
  const dueNet = fullText.match(/until\s+(\d{2}\.\d{2}\.\d{4})\s+net\b/i);
  const dueAll = [...fullText.matchAll(/until\s+(\d{2}\.\d{2}\.\d{4})/gi)];
  if (dueNet)          r.faelligkeitsdatum = _deDate(dueNet[1]);
  else if (dueAll.length) r.faelligkeitsdatum = _deDate(dueAll[dueAll.length - 1][1]);

  // Ansprechpartner: Nachname unter der "Operator:"-Kopfzeile
  // "Operator: Tel. Fax Customer …" → Datenzeile "Buchs 95-246 95-215 …"
  const opM = fullText.match(/Operator\s*:[^\n]*\n\s*([A-ZÄÖÜ][A-Za-zäöüß\-]+)/);
  if (opM) r.verkaeufkontakt = opM[1];

  // Zahlungsbedingungen → Notiz: kompletter Block ("Payment"-Zeile + Folgezeilen).
  // Zeilenanker gegen "Prepayment"/"Payment Term:".
  const notiz = _extractZahlungsblock(fullText, /^[ \t]*Payment\b[ \t:]*/, /(\d+\s*days|discount|cash|^until\s+\d|^at\s+latest|net\b|%|EUR|USD)/i);
  if (notiz) r.notiz = notiz;

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
 * Käufer: Firmenname, Adresse, PLZ, Stadt, Land — primär aus dem
 * isolierten Adressfenster (Seite 1, links oben), Fallback linke Spalte.
 * Käufer-USt-IdNr aus "Your VAT reg. no.:"
 */
function extractBuyerEnglish(buyerBlock, leftColumnText, fullText) {
  const r = {};

  // Käufer-USt-IdNr: "Your VAT reg. no.: IT01804670493"
  const vatM = fullText.match(/Your\s+VAT\s+reg\.?\s*no\.?\s*[:\s]+([A-Z]{2}[\dA-Z]{2,12})/i);
  if (vatM) r.kaeufervat = vatM[1];

  // Primär das Adressfenster nutzen — die linke Spalte enthält weiter unten
  // Konditionen ("Pricing DAP …", "Payment …"), die sonst als Adresse
  // fehlinterpretiert werden (INCOTERMS matcht z. B. auf "Inc").
  const src = (buyerBlock && buyerBlock.trim()) ? buyerBlock : (leftColumnText || '');
  return Object.assign(r, _parseBuyerWindow(src));
}

/**
 * Adressfenster (Name / [Abteilung] / Straße / PLZ Ort / [Land]) parsen.
 * Gemeinsame Logik für englische und deutsche WGC-Rechnungen.
 */
function _parseBuyerWindow(src) {
  const r = {};

  const lines = (src || '')
    .split('\n')
    .map(l => l.trim())
    .filter(l => l.length > 1)
    .filter(l => !/walze-coswig|walzengie/i.test(l))   // Absenderzeile
    .filter(l => !/^Your\s+VAT|^Ihre\s+USt|^Operator|^Bearbeiter|^Invoice\s+Nr|^Rechnung\s+Nr|@/i.test(l));

  if (!lines.length) return r;

  // Internationale Rechtsformen — mit Wortgrenzen (kein Treffer in "INCOTERMS")
  const intlForms = /(?:^|\s)(?:S\.p\.A\.?|S\.A\.?|S\.?C\.?A\.?|SCA|S\.r\.l\.?|a\.s\.?|Ltd\.?|Inc\.?|Corp\.?|GmbH|AG|SE|KG|B\.V\.?|N\.V\.?|Oy|A\/S|AB|PLC|SAS)(?=[\s,.;)]|$)/i;

  // Firmenzeile: erste Zeile mit Rechtsform — sonst erste Zeile des Fensters.
  // Mehrzeilige Namen: alle Zeilen vom Fensteranfang bis zur Rechtsform-Zeile
  // gehören zum Namen (z. B. "Deutsche Edelstahlwerke" + "Witten/Krefeld GmbH & Co. KG").
  // Vorangehende Zeilen dürfen aber keine Straße/PLZ sein (Sicherheitsnetz).
  let ci = lines.findIndex(l => intlForms.test(l));
  if (ci < 0) ci = 0;
  const addrLike = /^[A-Z]{0,2}[-\s]?\d{4,6}\s|(?:stra(?:ß|ss)e|str\.|weg|gasse|platz|allee)\b/i;
  const nameParts = lines.slice(0, ci + 1).filter(l => !addrLike.test(l));
  r.kaeufer = (nameParts.length ? nameParts : [lines[ci]]).join(' ');

  const after = lines.slice(ci + 1);

  // PLZ-Zeile: "LU 1160 LUXEMBOURG", "D-04610 Meuselwitz", "57025 PIOMBINO (LI)"
  let plzIdx = -1, plzM = null;
  for (let i = 0; i < after.length; i++) {
    let m = after[i].match(/^([A-Z]{1,2})?[-\s]?(\d{4,6})\s+([A-ZÄÖÜ][^\n]*?)(?:\s+\([A-Z]{2}\))?$/);
    // Fallback: PLZ mit Leerzeichen aus PDF.js-Glyphen ("33 2 11 GIJÓN" → "33211")
    if (!m) {
      const m2 = after[i].match(/^([A-Z]{1,2})?[-\s]?(\d[\d ]{2,7}\d)\s+([A-ZÄÖÜ].*)$/);
      const digits = m2 ? m2[2].replace(/ /g, '') : '';
      if (m2 && digits.length >= 4 && digits.length <= 6) m = [m2[0], m2[1], digits, m2[3]];
    }
    if (m) { plzIdx = i; plzM = m; break; }
  }
  if (plzM) {
    if (plzM[1]) {
      const one = { D: 'DE', A: 'AT', F: 'FR', I: 'IT', L: 'LU', B: 'BE', E: 'ES', P: 'PT' };
      r.kaeuferland = plzM[1].length === 1 ? (one[plzM[1]] || plzM[1]) : plzM[1];
    }
    r.kaeuferplz   = plzM[2];
    r.kaeuferstadt = plzM[3].trim();
    // Straße = Zeile direkt über der PLZ-Zeile (Fensteradresse)
    if (plzIdx > 0) r.kaeuferstrasse = after[plzIdx - 1];
  } else {
    // UK-Format: alphanumerische PLZ, oft "STADT/COUNTY, DN16 1BP" (keine numerische PLZ)
    const ukIdx = after.findIndex(l => /\b[A-Z]{1,2}\d[A-Z\d]?\s*\d[A-Z]{2}\b/.test(l));
    if (ukIdx >= 0) {
      const l  = after[ukIdx];
      const pc = l.match(/\b([A-Z]{1,2}\d[A-Z\d]?\s*\d[A-Z]{2})\b/)[1];
      r.kaeuferplz   = pc.replace(/\s+/g, ' ').trim();
      r.kaeuferstadt = l.replace(pc, '').replace(/[,\s]+$/, '').split(',').pop().trim() || l.split(',')[0].trim();
      if (ukIdx > 0) r.kaeuferstrasse = after[ukIdx - 1].replace(/,\s*$/, '');
    }
  }

  // Land aus reiner Großbuchstaben-Zeile ("LUXEMBURG", "ITALIEN", "TSCHECHISCHE REPUBLIK").
  // Die LETZTE passende Zeile nehmen — das Land steht am Ende des Adressblocks
  // (sonst würde z. B. "BHILAI STEEL PLANT" als Land interpretiert).
  if (!r.kaeuferland) {
    const cls = after.filter(l => /^[A-ZÄÖÜ][A-ZÄÖÜ\s]{3,30}$/.test(l) && !/\d/.test(l) && l !== r.kaeuferstadt);
    if (cls.length) r.kaeuferland = _countryCode(cls[cls.length - 1].trim());
  }

  // Fallback Straße: erste sinnvolle Zeile nach dem Namen
  if (!r.kaeuferstrasse) {
    const skipLine = /^(Administrative|Office|Department|Attn|Purchasing|Accounts|c\/o|P\.?O\.?\s*Box|PF\s|Abt\.)/i;
    r.kaeuferstrasse = after.find(l =>
      !skipLine.test(l) && l !== r.kaeuferstadt && !/^\d{4,6}\s/.test(l) &&
      !/^[A-ZÄÖÜ][A-ZÄÖÜ\s]{3,30}$/.test(l)
    ) || '';
  }

  return r;
}

/* ══════════════════════════════════════════════════════
   Lieferanschrift (Shipping Address, BG-13 DELIVER TO)
   WGC deutsch:  "Versandanschrift: NAME" + Folgezeilen
   WGC englisch: "Shipping address: NAME" + Folgezeilen
   SHB:          "Lieferanschrift : NAME" + Folgezeilen
══════════════════════════════════════════════════════ */
function _extractShipTo(fullText) {
  const r = {};
  const lines = fullText.split('\n').map(l => l.trim());

  const labelRe = /^(?:Lieferanschrift|Versandanschrift|Shipping\s+address|Delivery\s+address)\s*:?\s*(.*)$/i;
  const li = lines.findIndex(l => labelRe.test(l));
  if (li < 0) return r;

  // Blockzeilen einsammeln: Label-Rest + Folgezeilen bis Terminator/PLZ-Zeile
  const stopRe = /^(?:Blatt\s|Seite\s|Wir\s+erbitten|IBAN|BIC\b|Bank\b|Konto|SHB\s+Stahl|Rechnungs?-?\s*Nr|Hinweis|Zahlung|Payment|Pricing|Mode\s+of|General\s+Notes|Versandart|Lieferbedingung|\*{3,}|_{5,})/i;
  const block = [];
  const first = lines[li].match(labelRe)[1].trim();
  if (first) block.push(first);

  let plzM = null, plzIdx = -1;
  for (let k = li + 1; k < Math.min(li + 8, lines.length); k++) {
    const l = lines[k];
    if (!l || stopRe.test(l)) break;
    block.push(l);

    // PLZ-Zeile: "57250 Netphen", "DE 59269 Beckum", "LU 4823 RODANGE"
    const m = l.match(/^([A-Z]{1,2})?[-\s]?(\d{4,6})\s+([A-ZÄÖÜ][^\n]*?)(?:\s+\([A-Z]{2}\))?$/);
    if (m) {
      plzM = m; plzIdx = block.length - 1;
      // Optionale Länderzeile direkt danach ("LUXEMBURG", "ITALIEN")
      const next = lines[k + 1];
      if (next && /^[A-ZÄÖÜ][A-ZÄÖÜ\s]{3,30}$/.test(next) && !/\d/.test(next)) {
        r.lieferLand = _countryCode(next.trim());
      }
      break;
    }
  }
  if (!block.length) return r;

  if (plzM) {
    if (plzM[1]) {
      const one = { D: 'DE', A: 'AT', F: 'FR', I: 'IT', L: 'LU', B: 'BE', E: 'ES', P: 'PT' };
      r.lieferLand = plzM[1].length === 1 ? (one[plzM[1]] || plzM[1]) : plzM[1];
    }
    r.lieferPlz   = plzM[2];
    r.lieferStadt = plzM[3].trim();
    // Straße = Zeile direkt über der PLZ-Zeile, alles davor = Name(-szeilen)
    if (plzIdx >= 2) {
      r.lieferStrasse = block[plzIdx - 1];
      r.lieferName    = block.slice(0, plzIdx - 1).join(' ');
    } else if (plzIdx === 1) {
      r.lieferName = block[0];
    }
  } else {
    // Kein PLZ-Muster (z. B. Indien): Name = erste Zeile, Rest als Straße,
    // Land aus letzter Großbuchstaben-Zeile, PLZ aus "POST CODE 490001"
    r.lieferName = block[0];
    const rest = block.slice(1).filter(l => {
      if (/^[A-ZÄÖÜ][A-ZÄÖÜ\s]{3,30}$/.test(l) && !/\d/.test(l)) {
        r.lieferLand = _countryCode(l.trim());
        return false;
      }
      return true;
    });
    const pcM = rest.join(' ').match(/POST\s*CODE[:\s]*(\d{4,8})/i);
    if (pcM) r.lieferPlz = pcM[1];
    r.lieferStrasse = rest.join(', ');
  }

  if ((r.lieferName || r.lieferStrasse) && !r.lieferLand) r.lieferLand = 'DE';
  return r;
}

/**
 * Lieferschein-/Versandavis-Nummer (BT-16, Despatch advice reference).
 * Deutsche Labels ("Lieferschein-Nr.: 2026.004785", "Lieferschein 12345") und
 * englisch ("Delivery note 3240007"). Wert: erste Nummer nach dem Label.
 */
function _extractLieferschein(fullText) {
  const m = fullText.match(/(?:Lieferschein(?:-?Nr\.?|nummer)?|Delivery\s+note)\s*[:.]?\s*([0-9][0-9.\-\/]{3,20})/i);
  return m ? { lieferscheinnummer: m[1].replace(/[.\-\/]+$/, '').trim() } : {};
}

/* ══════════════════════════════════════════════════════
   Steuerkategorie bei 0%-Positionen (UNTDID 5305)
   K  = innergemeinschaftliche Lieferung  (BT-121: VATEX-EU-IC)
   AE = Reverse Charge                    (BT-121: VATEX-EU-AE)
   G  = Ausfuhr Drittland                 (BT-121: VATEX-EU-G)
══════════════════════════════════════════════════════ */
function _detectTaxCategory(fullText, result) {
  const hasZero = (result.positionen || []).some(p => !(parseFloat(p.mwst) > 0));
  if (!hasZero) return {};

  // 1) Expliziter Hinweis im Rechnungstext
  if (/innergemeinschaftlich|intra-?community/i.test(fullText))
    return { steuerkategorie: 'K' };
  if (/reverse\s+charge|Steuerschuldnerschaft\s+des\s+Leistungsempf/i.test(fullText))
    return { steuerkategorie: 'AE' };
  if (/Ausfuhrlieferung|export\s+delivery/i.test(fullText))
    return { steuerkategorie: 'G' };

  // 2) Fallback über das Bestimmungsland (Lieferanschrift vor Empfänger)
  const EU = new Set(['AT','BE','BG','HR','CY','CZ','DK','EE','FI','FR','GR','EL','DE',
                      'HU','IE','IT','LV','LT','LU','MT','NL','PL','PT','RO','SK','SI','ES','SE']);
  const dest = result.lieferLand || result.kaeuferland;
  if (dest && !EU.has(dest))    return { steuerkategorie: 'G' };   // Drittland
  if (dest && dest !== 'DE')    return { steuerkategorie: 'K' };   // EU-Ausland
  return {};
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

  // Muster: [PosNr] ProduktCode ... N pcs. Einzelpreis [%] Gesamtpreis
  // z. B. "1    31857                             1 pcs.   55.187,37     55.187,37"
  // oder  "1.1  33225                             4 pcs.   11.800,50      47.202,00"
  // PosNr optional & mehrstufig ("1", "1.1", "1,2"); %-Spalte optional
  const itemRe = /(?:^\s*(\d+(?:[.,]\d+)*)\s+)?(\d{4,6})\s[\s\S]*?(\d+)\s+pcs\.\s+([\d.]+,\d{2})(?:\s+(\d{1,2},\d{2}))?\s+([\d.]+,\d{2})/;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // Summen-/Anzahlungs-/Steuerzeilen überspringen
    if (/^\s*(Total|Prepayment|Tax|Note to|We confirm|We kindly|Country of|Herewith)\b/i.test(line)) continue;

    const m = line.match(itemRe);
    if (!m) continue;

    const posnr       = _normPosNr(m[1]);
    const productCode = m[2];
    const menge       = parseFloat(m[3]) || 1;
    const einzelpreis = _parseDE(m[4]);

    // %-Spalte: Richtung prüfen (Zuschlag → negativer Rabatt, Rabatt → positiv)
    let rabatt = 0;
    if (m[5]) {
      const pct   = _parseDE(m[5]);
      const total = _parseDE(m[6]);
      if (pct > 0 && pct < 100) {
        if (Math.abs(menge * einzelpreis * (1 + pct / 100) - total) <= 0.02) rabatt = -pct;
        else if (Math.abs(menge * einzelpreis * (1 - pct / 100) - total) <= 0.02) rabatt = pct;
      }
    }

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
      posnr,
      beschreibung: `${productCode} – ${desc}`,
      menge,
      einheit:      'Stk',
      einzelpreis,
      rabatt,
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

  const netExtracted = items.reduce(
    (s, it) => s + it.einzelpreis * it.menge * (1 - (it.rabatt || 0) / 100), 0
  );
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

/**
 * Positionsnummer normalisieren:
 *   "1,2" → "1.2", "1,2,3" → "1.2.3" (Komma-Trenner → Punkt)
 *   "0001" → "1", "0010" → "10" (führende Nullen je Ebene entfernen)
 * @returns {string} normalisierte Nummer oder '' wenn nicht vorhanden
 */
function _normPosNr(s) {
  if (!s) return '';
  return String(s).trim()
    .split(/[.,]/)
    .map(part => part.replace(/^0+(?=\d)/, ''))  // führende Nullen weg, min. 1 Ziffer
    .join('.');
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
function _countryCode(name, streng) {   // streng: unbekannter Name → ''
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
    'TSCHECHIEN': 'CZ', 'CZECH REPUBLIC': 'CZ', 'TSCHECHISCHE REPUBLIK': 'CZ',
    'POLEN': 'PL', 'POLAND': 'PL',
    'LUXEMBURG': 'LU', 'LUXEMBOURG': 'LU',
    'INDIEN': 'IN', 'INDIA': 'IN',
    'DÄNEMARK': 'DK', 'DAENEMARK': 'DK', 'DENMARK': 'DK',
    'SCHWEDEN': 'SE', 'SWEDEN': 'SE', 'SUÈDE': 'SE',
    'NORWEGEN': 'NO', 'NORWAY': 'NO',
    'FINNLAND': 'FI', 'FINLAND': 'FI',
    'PORTUGAL': 'PT',
    'IRLAND': 'IE', 'IRELAND': 'IE',
    'UNGARN': 'HU', 'HUNGARY': 'HU',
    'SLOWAKEI': 'SK', 'SLOVAKIA': 'SK',
    'SLOWENIEN': 'SI', 'SLOVENIA': 'SI',
    'RUMÄNIEN': 'RO', 'ROMANIA': 'RO',
    'BULGARIEN': 'BG', 'BULGARIA': 'BG',
    'KROATIEN': 'HR', 'CROATIA': 'HR',
    'GRIECHENLAND': 'GR', 'GREECE': 'GR',
    'TÜRKEI': 'TR', 'TURKEY': 'TR', 'TURKIYE': 'TR',
    'USA': 'US', 'UNITED STATES': 'US', 'UNITED STATES OF AMERICA': 'US',
    'CHINA': 'CN', 'JAPAN': 'JP', 'SÜDKOREA': 'KR', 'SOUTH KOREA': 'KR',
    'GROSSBRITANNIEN UND NORDIRLAND': 'GB',
  };
  const n = name.toUpperCase().replace(/ß/g, 'SS');
  return map[n] || map[name.toUpperCase()] || (streng ? '' : n.slice(0, 2));
}

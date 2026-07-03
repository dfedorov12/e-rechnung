/**
 * E-Rechnungs-XML → Datenobjekt
 * ==============================
 * Liest XRechnung / ZUGFeRD-XML in beiden Syntaxen:
 *   - UN/CEFACT CII  (rsm:CrossIndustryInvoice)  — auch von dieser App erzeugt
 *   - OASIS UBL      (ubl:Invoice)
 * Ergebnis nutzt dieselben Feldnamen wie der Rest der App
 * (verkaeufer, kaeufer, positionen, …).
 */

/**
 * Haupteinstieg: XML-String → Rechnungsdaten.
 * @throws {Error} wenn das XML kein bekanntes Rechnungsformat ist
 */
function parseInvoiceXML(xmlString) {
  const doc = new DOMParser().parseFromString(xmlString.replace(/^﻿/, ''), 'application/xml');
  if (doc.getElementsByTagName('parsererror').length > 0) {
    throw new Error('Ungültiges XML — Datei konnte nicht gelesen werden.');
  }
  const root = doc.documentElement;
  const rootName = root.localName || root.nodeName.replace(/^.*:/, '');

  if (rootName === 'CrossIndustryInvoice') return _parseCII(root);
  if (rootName === 'Invoice')              return _parseUBL(root);
  throw new Error(`Kein bekanntes E-Rechnungsformat (Wurzelelement: ${rootName}). ` +
                  'Erwartet: CrossIndustryInvoice (CII) oder Invoice (UBL).');
}

/* ══════════════════════════════════════════════════════
   DOM-Helfer (namespace-agnostisch über localName)
══════════════════════════════════════════════════════ */

/** Kind-Elemente (nodeType 1) — funktioniert auch ohne .children-Support. */
function _children(el) {
  if (!el) return [];
  if (el.children) return Array.from(el.children);
  return Array.from(el.childNodes || []).filter(n => n.nodeType === 1);
}

/** Erstes Nachfahren-Element entlang eines localName-Pfads. */
function _q(el, ...path) {
  let cur = el;
  for (const name of path) {
    if (!cur) return null;
    cur = _children(cur).find(c => c.localName === name) || null;
  }
  return cur;
}

/** Textinhalt entlang eines Pfads ('' wenn nicht vorhanden). */
function _t(el, ...path) {
  const n = _q(el, ...path);
  return n ? n.textContent.trim() : '';
}

/** Alle direkten/tiefen Kind-Elemente mit localName (rekursiv). */
function _all(el, name) {
  const out = [];
  const walk = n => {
    for (const c of _children(n)) {
      if (c.localName === name) out.push(c);
      walk(c);
    }
  };
  if (el) walk(el);
  return out;
}

/** "20260518" oder "2026-05-18" → "2026-05-18" */
function _xmlDate(s) {
  if (!s) return '';
  const c = s.trim();
  if (/^\d{8}$/.test(c))            return `${c.slice(0, 4)}-${c.slice(4, 6)}-${c.slice(6, 8)}`;
  if (/^\d{4}-\d{2}-\d{2}/.test(c)) return c.slice(0, 10);
  return '';
}

/** UN/ECE-Einheitencode → App-Einheit */
function _unitFromCode(code) {
  const map = {
    C62: 'Stk', HUR: 'h', KGM: 'kg', MTR: 'm', MTK: 'm²', MTQ: 'm³',
    LTR: 'l', DAY: 'Tag', MON: 'Monat', KMT: 'km', LS: 'Pausch.',
  };
  return map[code] || 'Stk';
}

/* ══════════════════════════════════════════════════════
   CII  (rsm:CrossIndustryInvoice)
══════════════════════════════════════════════════════ */
function _parseCII(root) {
  const r = { syntax: 'CII', positionen: [] };

  const exDoc = _q(root, 'ExchangedDocument');
  r.rechnungsnummer = _t(exDoc, 'ID');
  r.rechnungsdatum  = _xmlDate(_t(exDoc, 'IssueDateTime', 'DateTimeString'));
  r.notiz           = _t(exDoc, 'IncludedNote', 'Content');

  const trans     = _q(root, 'SupplyChainTradeTransaction');
  const agreement = _q(trans, 'ApplicableHeaderTradeAgreement');
  const delivery  = _q(trans, 'ApplicableHeaderTradeDelivery');
  const settle    = _q(trans, 'ApplicableHeaderTradeSettlement');

  // Verkäufer
  const seller = _q(agreement, 'SellerTradeParty');
  if (seller) {
    r.verkaeufer       = _t(seller, 'Name');
    r.verkaeufkontakt  = _t(seller, 'DefinedTradeContact', 'PersonName');
    r.verkaeuftel      = _t(seller, 'DefinedTradeContact', 'TelephoneUniversalCommunication', 'CompleteNumber');
    r.verkaeuferemail  = _t(seller, 'DefinedTradeContact', 'EmailURIUniversalCommunication', 'URIID')
                       || _t(seller, 'URIUniversalCommunication', 'URIID');
    r.verkaeufstrasse  = _t(seller, 'PostalTradeAddress', 'LineOne');
    r.verkaeufplz      = _t(seller, 'PostalTradeAddress', 'PostcodeCode');
    r.verkaeufstadt    = _t(seller, 'PostalTradeAddress', 'CityName');
    r.verkaeufland     = _t(seller, 'PostalTradeAddress', 'CountryID') || 'DE';
    for (const reg of _all(seller, 'SpecifiedTaxRegistration')) {
      const id = _q(reg, 'ID');
      if (!id) continue;
      const scheme = id.getAttribute('schemeID');
      if (scheme === 'VA') r.verkaeufervat      = id.textContent.trim();
      if (scheme === 'FC') r.verkaeufersteuernr = id.textContent.trim();
    }
  }

  // Käufer
  const buyer = _q(agreement, 'BuyerTradeParty');
  if (buyer) {
    r.kaeufer        = _t(buyer, 'Name');
    r.kaeuferstrasse = _t(buyer, 'PostalTradeAddress', 'LineOne');
    r.kaeuferplz     = _t(buyer, 'PostalTradeAddress', 'PostcodeCode');
    r.kaeuferstadt   = _t(buyer, 'PostalTradeAddress', 'CityName');
    r.kaeuferland    = _t(buyer, 'PostalTradeAddress', 'CountryID') || 'DE';
    const uri = _q(buyer, 'URIUniversalCommunication', 'URIID');
    if (uri) {
      if (uri.getAttribute('schemeID') === '0204') r.leitwegid  = uri.textContent.trim();
      else                                          r.kaeufermail = uri.textContent.trim();
    }
    // Käufer-USt-IdNr (BT-48)
    const bReg = _q(buyer, 'SpecifiedTaxRegistration', 'ID');
    if (bReg && bReg.getAttribute('schemeID') === 'VA') r.kaeufervat = bReg.textContent.trim();
  }
  if (!r.leitwegid) {
    const buyerRef = _t(agreement, 'BuyerReference');
    // BuyerReference = Leitweg-ID, sofern sie nicht nur die Rechnungsnummer spiegelt
    if (buyerRef && buyerRef !== r.rechnungsnummer) r.leitwegid = buyerRef;
  }

  r.lieferdatum = _xmlDate(_t(delivery, 'ActualDeliverySupplyChainEvent', 'OccurrenceDateTime', 'DateTimeString'));

  // Lieferanschrift (BG-13 DELIVER TO)
  const shipTo = _q(delivery, 'ShipToTradeParty');
  if (shipTo) {
    r.lieferName    = _t(shipTo, 'Name');
    r.lieferStrasse = _t(shipTo, 'PostalTradeAddress', 'LineOne');
    r.lieferPlz     = _t(shipTo, 'PostalTradeAddress', 'PostcodeCode');
    r.lieferStadt   = _t(shipTo, 'PostalTradeAddress', 'CityName');
    r.lieferLand    = _t(shipTo, 'PostalTradeAddress', 'CountryID');
  }

  // Zahlung / Summen
  if (settle) {
    r.zahlungsreferenz  = _t(settle, 'PaymentReference');
    r.iban              = _t(settle, 'SpecifiedTradeSettlementPaymentMeans', 'PayeePartyCreditorFinancialAccount', 'IBANID');
    r.bic               = _t(settle, 'SpecifiedTradeSettlementPaymentMeans', 'PayeeSpecifiedCreditorFinancialInstitution', 'BICID');
    r.faelligkeitsdatum = _xmlDate(_t(settle, 'SpecifiedTradePaymentTerms', 'DueDateDateTime', 'DateTimeString'));
    const sums = _q(settle, 'SpecifiedTradeSettlementHeaderMonetarySummation');
    r.netTotal   = parseFloat(_t(sums, 'LineTotalAmount'))  || 0;
    r.vatTotal   = parseFloat(_t(sums, 'TaxTotalAmount'))   || 0;
    r.grossTotal = parseFloat(_t(sums, 'GrandTotalAmount')) || 0;
  }

  // Positionen
  for (const li of _all(trans, 'IncludedSupplyChainTradeLineItem')) {
    const qtyEl = _q(li, 'SpecifiedLineTradeDelivery', 'BilledQuantity');
    const menge = qtyEl ? parseFloat(qtyEl.textContent) || 0 : 0;
    r.positionen.push({
      beschreibung: _t(li, 'SpecifiedTradeProduct', 'Name'),
      menge,
      einheit:      _unitFromCode(qtyEl ? qtyEl.getAttribute('unitCode') : ''),
      einzelpreis:  parseFloat(_t(li, 'SpecifiedLineTradeAgreement', 'NetPriceProductTradePrice', 'ChargeAmount')) || 0,
      mwst:         parseFloat(_t(li, 'SpecifiedLineTradeSettlement', 'ApplicableTradeTax', 'RateApplicablePercent')) || 0,
      gesamt:       parseFloat(_t(li, 'SpecifiedLineTradeSettlement', 'SpecifiedTradeSettlementLineMonetarySummation', 'LineTotalAmount')) || 0,
    });
  }

  return r;
}

/* ══════════════════════════════════════════════════════
   UBL  (ubl:Invoice)
══════════════════════════════════════════════════════ */
function _parseUBL(root) {
  const r = { syntax: 'UBL', positionen: [] };

  r.rechnungsnummer   = _t(root, 'ID');
  r.rechnungsdatum    = _xmlDate(_t(root, 'IssueDate'));
  r.faelligkeitsdatum = _xmlDate(_t(root, 'DueDate'));
  r.notiz             = _t(root, 'Note');
  r.lieferdatum       = _xmlDate(_t(root, 'Delivery', 'ActualDeliveryDate'));

  // Lieferanschrift (BG-13): cac:Delivery > DeliveryLocation/Address + DeliveryParty
  const dloc = _q(root, 'Delivery', 'DeliveryLocation', 'Address');
  if (dloc) {
    r.lieferStrasse = _t(dloc, 'StreetName');
    r.lieferStadt   = _t(dloc, 'CityName');
    r.lieferPlz     = _t(dloc, 'PostalZone');
    r.lieferLand    = _t(dloc, 'Country', 'IdentificationCode');
  }
  r.lieferName = _t(root, 'Delivery', 'DeliveryParty', 'PartyName', 'Name');

  const buyerRef = _t(root, 'BuyerReference');

  // Verkäufer
  const sp = _q(root, 'AccountingSupplierParty', 'Party');
  if (sp) {
    r.verkaeufer      = _t(sp, 'PartyLegalEntity', 'RegistrationName') || _t(sp, 'PartyName', 'Name');
    r.verkaeufstrasse = _t(sp, 'PostalAddress', 'StreetName');
    r.verkaeufplz     = _t(sp, 'PostalAddress', 'PostalZone');
    r.verkaeufstadt   = _t(sp, 'PostalAddress', 'CityName');
    r.verkaeufland    = _t(sp, 'PostalAddress', 'Country', 'IdentificationCode') || 'DE';
    r.verkaeufervat   = _t(sp, 'PartyTaxScheme', 'CompanyID');
    r.verkaeufkontakt = _t(sp, 'Contact', 'Name');
    r.verkaeuftel     = _t(sp, 'Contact', 'Telephone');
    r.verkaeuferemail = _t(sp, 'Contact', 'ElectronicMail') || _t(sp, 'EndpointID');
  }

  // Käufer
  const cp = _q(root, 'AccountingCustomerParty', 'Party');
  if (cp) {
    r.kaeufer        = _t(cp, 'PartyLegalEntity', 'RegistrationName') || _t(cp, 'PartyName', 'Name');
    r.kaeuferstrasse = _t(cp, 'PostalAddress', 'StreetName');
    r.kaeuferplz     = _t(cp, 'PostalAddress', 'PostalZone');
    r.kaeuferstadt   = _t(cp, 'PostalAddress', 'CityName');
    r.kaeuferland    = _t(cp, 'PostalAddress', 'Country', 'IdentificationCode') || 'DE';
    r.kaeufermail    = _t(cp, 'EndpointID') || _t(cp, 'Contact', 'ElectronicMail');
    r.kaeufervat     = _t(cp, 'PartyTaxScheme', 'CompanyID');   // BT-48
  }
  if (buyerRef && buyerRef !== r.rechnungsnummer) r.leitwegid = buyerRef;

  // Zahlung
  const pm = _q(root, 'PaymentMeans');
  if (pm) {
    r.zahlungsreferenz = _t(pm, 'PaymentID');
    r.iban             = _t(pm, 'PayeeFinancialAccount', 'ID');
    r.bic              = _t(pm, 'PayeeFinancialAccount', 'FinancialInstitutionBranch', 'ID');
  }

  // Summen
  const lmt = _q(root, 'LegalMonetaryTotal');
  if (lmt) {
    r.netTotal   = parseFloat(_t(lmt, 'TaxExclusiveAmount')) || parseFloat(_t(lmt, 'LineExtensionAmount')) || 0;
    r.grossTotal = parseFloat(_t(lmt, 'TaxInclusiveAmount')) || parseFloat(_t(lmt, 'PayableAmount')) || 0;
    r.vatTotal   = parseFloat(_t(root, 'TaxTotal', 'TaxAmount')) || (r.grossTotal - r.netTotal);
  }

  // Positionen
  for (const li of _all(root, 'InvoiceLine')) {
    const qtyEl = _q(li, 'InvoicedQuantity');
    r.positionen.push({
      beschreibung: _t(li, 'Item', 'Name') || _t(li, 'Item', 'Description'),
      menge:        qtyEl ? parseFloat(qtyEl.textContent) || 0 : 0,
      einheit:      _unitFromCode(qtyEl ? qtyEl.getAttribute('unitCode') : ''),
      einzelpreis:  parseFloat(_t(li, 'Price', 'PriceAmount')) || 0,
      mwst:         parseFloat(_t(li, 'Item', 'ClassifiedTaxCategory', 'Percent')) || 0,
      gesamt:       parseFloat(_t(li, 'LineExtensionAmount')) || 0,
    });
  }

  return r;
}

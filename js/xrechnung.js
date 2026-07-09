/**
 * XRechnung 3.0 / ZUGFeRD 2.3 XML Generator
 * Profil: EN 16931 (COMFORT)
 * Standard: CII UN/CEFACT
 */

function buildXML(data, profile = 'xrechnung') {
  const guideline = profile === 'zugferd'
    ? 'urn:cen.eu:en16931:2017'
    : 'urn:cen.eu:en16931:2017#compliant#urn:xeinkauf.de:kosit:xrechnung_3.0';

  const fmt = (n) => parseFloat(n || 0).toFixed(2);
  const fmtDate = (s) => {
    if (!s) return '';
    // Input: YYYY-MM-DD (HTML date) or DD.MM.YYYY
    if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s.replace(/-/g, '');
    if (/^\d{2}\.\d{2}\.\d{4}$/.test(s)) {
      const [d, m, y] = s.split('.');
      return `${y}${m}${d}`;
    }
    return s.replace(/\D/g, '').slice(0, 8);
  };

  // Steuerkategorie für 0%-Positionen (UNTDID 5305): Z, K, AE, G, E
  // 19 %/7 % sind immer Kategorie S.
  const zeroCat = ['Z', 'K', 'AE', 'G', 'E'].includes(data.steuerkategorie)
    ? data.steuerkategorie : 'Z';
  const catOf = rate => rate > 0 ? 'S' : zeroCat;

  // Befreiungsgrund (BT-120 Text / BT-121 Code) je Kategorie
  const EXEMPT_DEFAULTS = {
    K:  { code: 'VATEX-EU-IC', text: 'Steuerfreie innergemeinschaftliche Lieferung (§ 4 Nr. 1b UStG)' },
    AE: { code: 'VATEX-EU-AE', text: 'Steuerschuldnerschaft des Leistungsempfängers (Reverse Charge, § 13b UStG)' },
    G:  { code: 'VATEX-EU-G',  text: 'Steuerfreie Ausfuhrlieferung in ein Drittland (§ 4 Nr. 1a UStG)' },
    E:  { code: '',            text: 'Steuerbefreite Leistung' },
  };

  // Compute line totals and VAT summaries
  const lines = data.positionen || [];
  const vatGroups = {};

  lines.forEach(p => {
    // Rabatt (>0 mindert) / Zuschlag (<0 erhöht) in den Zeilenwert einrechnen
    const net = parseFloat(p.menge || 0) * parseFloat(p.einzelpreis || 0)
              * (1 - (parseFloat(p.rabatt) || 0) / 100);
    const rate = (p.mwst != null && p.mwst !== '') ? parseFloat(p.mwst) : 19;
    const key = String(rate);
    if (!vatGroups[key]) vatGroups[key] = { base: 0, amount: 0, rate };
    vatGroups[key].base += net;
    vatGroups[key].amount += net * rate / 100;
  });

  const netTotal = Object.values(vatGroups).reduce((s, g) => s + g.base, 0);
  const vatTotal = Object.values(vatGroups).reduce((s, g) => s + g.amount, 0);
  const grossTotal = netTotal + vatTotal;

  const esc = (s) => String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

  // Eindeutige LineIDs (BT-126): Positionsnummer bevorzugen, Kollisionen auflösen
  const _usedIds = new Set();
  const lineIds = lines.map((p, i) => {
    let id = String(p.posnr || (i + 1)).trim() || String(i + 1);
    while (_usedIds.has(id)) id = `${id}.${i + 1}`;
    _usedIds.add(id);
    return id;
  });

  const lineXML = lines.map((p, i) => {
    // Effektiver Einzelpreis nach Rabatt/Zuschlag → Menge × Preis = Zeilensumme (konsistent)
    const rabattFaktor = 1 - (parseFloat(p.rabatt) || 0) / 100;
    const effPreis = parseFloat(p.einzelpreis || 0) * rabattFaktor;
    const net = parseFloat(p.menge || 0) * effPreis;
    const rate = (p.mwst != null && p.mwst !== '') ? parseFloat(p.mwst) : 19;
    const unitCode = mapUnit(p.einheit || 'Stk');
    return `
    <ram:IncludedSupplyChainTradeLineItem>
      <ram:AssociatedDocumentLineDocument>
        <ram:LineID>${esc(lineIds[i])}</ram:LineID>
      </ram:AssociatedDocumentLineDocument>
      <ram:SpecifiedTradeProduct>
        <ram:Name>${esc(p.beschreibung)}</ram:Name>
      </ram:SpecifiedTradeProduct>
      <ram:SpecifiedLineTradeAgreement>
        <ram:NetPriceProductTradePrice>
          <ram:ChargeAmount>${fmt(effPreis)}</ram:ChargeAmount>
        </ram:NetPriceProductTradePrice>
      </ram:SpecifiedLineTradeAgreement>
      <ram:SpecifiedLineTradeDelivery>
        <ram:BilledQuantity unitCode="${unitCode}">${fmt(p.menge)}</ram:BilledQuantity>
      </ram:SpecifiedLineTradeDelivery>
      <ram:SpecifiedLineTradeSettlement>
        <ram:ApplicableTradeTax>
          <ram:TypeCode>VAT</ram:TypeCode>
          <ram:CategoryCode>${catOf(rate)}</ram:CategoryCode>
          <ram:RateApplicablePercent>${fmt(rate)}</ram:RateApplicablePercent>
        </ram:ApplicableTradeTax>
        <ram:SpecifiedTradeSettlementLineMonetarySummation>
          <ram:LineTotalAmount>${fmt(net)}</ram:LineTotalAmount>
        </ram:SpecifiedTradeSettlementLineMonetarySummation>
      </ram:SpecifiedLineTradeSettlement>
    </ram:IncludedSupplyChainTradeLineItem>`;
  }).join('');

  const vatXML = Object.values(vatGroups).map(g => {
    const cat = catOf(g.rate);
    // BT-120/BT-121 nur bei echten Befreiungskategorien (nicht S, nicht Z — BR-Z-10)
    const ex = (cat !== 'S' && cat !== 'Z') ? EXEMPT_DEFAULTS[cat] : null;
    const reasonText = ex ? (data.befreiungsgrund || ex.text) : '';
    return `
      <ram:ApplicableTradeTax>
        <ram:CalculatedAmount>${fmt(g.amount)}</ram:CalculatedAmount>
        <ram:TypeCode>VAT</ram:TypeCode>
        ${ex ? `<ram:ExemptionReason>${esc(reasonText)}</ram:ExemptionReason>` : ''}
        <ram:BasisAmount>${fmt(g.base)}</ram:BasisAmount>
        <ram:CategoryCode>${cat}</ram:CategoryCode>
        ${ex && ex.code ? `<ram:ExemptionReasonCode>${ex.code}</ram:ExemptionReasonCode>` : ''}
        <ram:RateApplicablePercent>${fmt(g.rate)}</ram:RateApplicablePercent>
      </ram:ApplicableTradeTax>`;
  }).join('');

  // EN 16931 allows multiple SpecifiedTaxRegistration entries (VA + FC)
  const sellerVat = [
    data.verkaeufervat
      ? `<ram:SpecifiedTaxRegistration><ram:ID schemeID="VA">${esc(data.verkaeufervat)}</ram:ID></ram:SpecifiedTaxRegistration>`
      : '',
    data.verkaeufersteuernr
      ? `<ram:SpecifiedTaxRegistration><ram:ID schemeID="FC">${esc(data.verkaeufersteuernr)}</ram:ID></ram:SpecifiedTaxRegistration>`
      : '',
  ].filter(Boolean).join('\n        ');

  // BG-6 SELLER CONTACT — mandatory for XRechnung (BR-DE-2)
  // BT-41 PersonName is mandatory within BG-6 (BR-DE-5).
  // Derive from email localpart if not explicitly provided.
  const contactName = data.verkaeufkontakt ||
    (data.verkaeuferemail
      ? data.verkaeuferemail.split('@')[0]
          .replace(/[._\-]/g, ' ')
          .replace(/\b\w/g, l => l.toUpperCase())
      : 'Ansprechpartner');

  const sellerContact = (data.verkaeufkontakt || data.verkaeuftel || data.verkaeuferemail)
    ? `<ram:DefinedTradeContact>
          <ram:PersonName>${esc(contactName)}</ram:PersonName>
          ${data.verkaeuftel ? `<ram:TelephoneUniversalCommunication><ram:CompleteNumber>${esc(data.verkaeuftel)}</ram:CompleteNumber></ram:TelephoneUniversalCommunication>` : ''}
          ${data.verkaeuferemail ? `<ram:EmailURIUniversalCommunication><ram:URIID>${esc(data.verkaeuferemail)}</ram:URIID></ram:EmailURIUniversalCommunication>` : ''}
        </ram:DefinedTradeContact>`
    : '';

  const buyerRef = esc(data.leitwegid || data.rechnungsnummer);
  const note = data.notiz ? `<ram:IncludedNote><ram:Content>${esc(data.notiz)}</ram:Content></ram:IncludedNote>` : '';
  const dueDateXML = data.faelligkeitsdatum
    ? `<ram:SpecifiedTradePaymentTerms>
        <ram:DueDateDateTime>
          <udt:DateTimeString format="102">${fmtDate(data.faelligkeitsdatum)}</udt:DateTimeString>
        </ram:DueDateDateTime>
      </ram:SpecifiedTradePaymentTerms>`
    : '';

  const ibanXML = data.iban
    ? `<ram:SpecifiedTradeSettlementPaymentMeans>
        <ram:TypeCode>58</ram:TypeCode>
        <ram:PayeePartyCreditorFinancialAccount>
          <ram:IBANID>${esc(data.iban.replace(/\s/g, ''))}</ram:IBANID>
        </ram:PayeePartyCreditorFinancialAccount>
        ${data.bic ? `<ram:PayeeSpecifiedCreditorFinancialInstitution><ram:BICID>${esc(data.bic)}</ram:BICID></ram:PayeeSpecifiedCreditorFinancialInstitution>` : ''}
      </ram:SpecifiedTradeSettlementPaymentMeans>`
    : '';

  return `<?xml version="1.0" encoding="UTF-8"?>
<rsm:CrossIndustryInvoice
  xmlns:rsm="urn:un:unece:uncefact:data:standard:CrossIndustryInvoice:100"
  xmlns:ram="urn:un:unece:uncefact:data:standard:ReusableAggregateBusinessInformationEntity:100"
  xmlns:udt="urn:un:unece:uncefact:data:standard:UnqualifiedDataType:100"
  xmlns:qdt="urn:un:unece:uncefact:data:standard:QualifiedDataType:100"
  xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">

  <rsm:ExchangedDocumentContext>
    ${profile !== 'zugferd' ? `<ram:BusinessProcessSpecifiedDocumentContextParameter>
      <ram:ID>urn:fdc:peppol.eu:2017:poacc:billing:01:1.0</ram:ID>
    </ram:BusinessProcessSpecifiedDocumentContextParameter>` : ''}
    <ram:GuidelineSpecifiedDocumentContextParameter>
      <ram:ID>${guideline}</ram:ID>
    </ram:GuidelineSpecifiedDocumentContextParameter>
  </rsm:ExchangedDocumentContext>

  <rsm:ExchangedDocument>
    <ram:ID>${esc(data.rechnungsnummer)}</ram:ID>
    <ram:TypeCode>380</ram:TypeCode>
    <ram:IssueDateTime>
      <udt:DateTimeString format="102">${fmtDate(data.rechnungsdatum)}</udt:DateTimeString>
    </ram:IssueDateTime>
    ${note}
  </rsm:ExchangedDocument>

  <rsm:SupplyChainTradeTransaction>
    ${lineXML}

    <ram:ApplicableHeaderTradeAgreement>
      <ram:BuyerReference>${buyerRef}</ram:BuyerReference>

      <ram:SellerTradeParty>
        <ram:Name>${esc(data.verkaeufer)}</ram:Name>
        ${sellerContact}
        <ram:PostalTradeAddress>
          <ram:PostcodeCode>${esc(data.verkaeufplz)}</ram:PostcodeCode>
          <ram:LineOne>${esc(data.verkaeufstrasse)}</ram:LineOne>
          <ram:CityName>${esc(data.verkaeufstadt)}</ram:CityName>
          <ram:CountryID>${esc(data.verkaeufland || 'DE')}</ram:CountryID>
        </ram:PostalTradeAddress>
        ${data.verkaeuferemail ? `<ram:URIUniversalCommunication>
          <ram:URIID schemeID="EM">${esc(data.verkaeuferemail)}</ram:URIID>
        </ram:URIUniversalCommunication>` : ''}
        ${sellerVat}
      </ram:SellerTradeParty>

      <ram:BuyerTradeParty>
        <ram:Name>${esc(data.kaeufer)}</ram:Name>
        <ram:PostalTradeAddress>
          <ram:PostcodeCode>${esc(data.kaeuferplz)}</ram:PostcodeCode>
          <ram:LineOne>${esc(data.kaeuferstrasse)}</ram:LineOne>
          <ram:CityName>${esc(data.kaeuferstadt)}</ram:CityName>
          <ram:CountryID>${esc(data.kaeuferland || 'DE')}</ram:CountryID>
        </ram:PostalTradeAddress>
        ${data.leitwegid ? `<ram:URIUniversalCommunication>
          <ram:URIID schemeID="0204">${esc(data.leitwegid)}</ram:URIID>
        </ram:URIUniversalCommunication>` : (data.kaeufermail ? `<ram:URIUniversalCommunication>
          <ram:URIID schemeID="EM">${esc(data.kaeufermail)}</ram:URIID>
        </ram:URIUniversalCommunication>` : '')}
        ${data.kaeufervat ? `<ram:SpecifiedTaxRegistration><ram:ID schemeID="VA">${esc(data.kaeufervat)}</ram:ID></ram:SpecifiedTaxRegistration>` : ''}
      </ram:BuyerTradeParty>
    </ram:ApplicableHeaderTradeAgreement>

    <ram:ApplicableHeaderTradeDelivery>
      ${(data.lieferName || data.lieferStrasse || data.lieferPlz ||
         (zeroCat === 'K' && lines.some(p => !(parseFloat(p.mwst) > 0)))) ? `<ram:ShipToTradeParty>
        ${data.lieferName ? `<ram:Name>${esc(data.lieferName)}</ram:Name>` : ''}
        <ram:PostalTradeAddress>
          ${data.lieferPlz ? `<ram:PostcodeCode>${esc(data.lieferPlz)}</ram:PostcodeCode>` : ''}
          ${data.lieferStrasse ? `<ram:LineOne>${esc(data.lieferStrasse)}</ram:LineOne>` : ''}
          ${data.lieferStadt ? `<ram:CityName>${esc(data.lieferStadt)}</ram:CityName>` : ''}
          <!-- BT-80: bei innergemeinschaftl. Lieferung Pflicht (BR-IC-12) — Fallback Empfängerland -->
          <ram:CountryID>${esc(data.lieferLand || data.kaeuferland || 'DE')}</ram:CountryID>
        </ram:PostalTradeAddress>
      </ram:ShipToTradeParty>` : ''}
      ${data.lieferdatum ? `<ram:ActualDeliverySupplyChainEvent>
        <ram:OccurrenceDateTime>
          <udt:DateTimeString format="102">${fmtDate(data.lieferdatum)}</udt:DateTimeString>
        </ram:OccurrenceDateTime>
      </ram:ActualDeliverySupplyChainEvent>` : ''}
    </ram:ApplicableHeaderTradeDelivery>

    <ram:ApplicableHeaderTradeSettlement>
      <ram:PaymentReference>${esc(data.zahlungsreferenz || data.rechnungsnummer)}</ram:PaymentReference>
      <ram:InvoiceCurrencyCode>EUR</ram:InvoiceCurrencyCode>
      ${ibanXML}
      ${vatXML}
      ${dueDateXML}
      <ram:SpecifiedTradeSettlementHeaderMonetarySummation>
        <ram:LineTotalAmount>${fmt(netTotal)}</ram:LineTotalAmount>
        <ram:TaxBasisTotalAmount>${fmt(netTotal)}</ram:TaxBasisTotalAmount>
        <ram:TaxTotalAmount currencyID="EUR">${fmt(vatTotal)}</ram:TaxTotalAmount>
        <ram:GrandTotalAmount>${fmt(grossTotal)}</ram:GrandTotalAmount>
        <ram:DuePayableAmount>${fmt(grossTotal)}</ram:DuePayableAmount>
      </ram:SpecifiedTradeSettlementHeaderMonetarySummation>
    </ram:ApplicableHeaderTradeSettlement>
  </rsm:SupplyChainTradeTransaction>

</rsm:CrossIndustryInvoice>`;
}

function mapUnit(einheit) {
  const map = {
    'Stk': 'C62', 'Stück': 'C62', 'St.': 'C62',
    'h': 'HUR', 'Std': 'HUR', 'Stunde': 'HUR',
    'kg': 'KGM',
    'm': 'MTR', 'lfm': 'MTR',
    'm²': 'MTK', 'qm': 'MTK',
    'm³': 'MTQ',
    'l': 'LTR',
    'Tag': 'DAY', 'Tage': 'DAY',
    'Monat': 'MON',
    'km': 'KMT',
    'Pausch.': 'LS', 'Pauschal': 'LS',
  };
  return map[einheit] || 'C62';
}

function calcTotals(positionen) {
  const vatGroups = {};
  positionen.forEach(p => {
    const net = parseFloat(p.menge || 0) * parseFloat(p.einzelpreis || 0)
              * (1 - (parseFloat(p.rabatt) || 0) / 100);
    const rate = (p.mwst != null && p.mwst !== '') ? parseFloat(p.mwst) : 19;
    const key = String(rate);
    if (!vatGroups[key]) vatGroups[key] = { base: 0, amount: 0, rate };
    vatGroups[key].base += net;
    vatGroups[key].amount += net * rate / 100;
  });
  const netTotal = Object.values(vatGroups).reduce((s, g) => s + g.base, 0);
  const vatTotal = Object.values(vatGroups).reduce((s, g) => s + g.amount, 0);
  return { netTotal, vatTotal, grossTotal: netTotal + vatTotal, vatGroups };
}

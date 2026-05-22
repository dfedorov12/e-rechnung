/**
 * XRechnung 3.0 / ZUGFeRD 2.3 XML Generator
 * Profil: EN 16931 (COMFORT)
 * Standard: CII UN/CEFACT
 */

function buildXML(data, profile = 'xrechnung') {
  const guideline = profile === 'zugferd'
    ? 'urn:cen.eu:en16931:2017#compliant#urn:factur-x.eu:1p0:en16931'
    : 'urn:cen.eu:en16931:2017#compliant#urn:xoev-de:kosit:standard:xrechnung_3.0';

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

  // Compute line totals and VAT summaries
  const lines = data.positionen || [];
  const vatGroups = {};

  lines.forEach(p => {
    const net = parseFloat(p.menge || 0) * parseFloat(p.einzelpreis || 0);
    const rate = parseFloat(p.mwst || 19);
    const key = String(rate);
    if (!vatGroups[key]) vatGroups[key] = { base: 0, amount: 0, rate };
    vatGroups[key].base += net;
    vatGroups[key].amount += net * rate / 100;
  });

  const netTotal = Object.values(vatGroups).reduce((s, g) => s + g.base, 0);
  const vatTotal = Object.values(vatGroups).reduce((s, g) => s + g.amount, 0);
  const grossTotal = netTotal + vatTotal;

  const esc = (s) => String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

  const lineXML = lines.map((p, i) => {
    const net = parseFloat(p.menge || 0) * parseFloat(p.einzelpreis || 0);
    const rate = parseFloat(p.mwst || 19);
    const unitCode = mapUnit(p.einheit || 'Stk');
    return `
    <ram:IncludedSupplyChainTradeLineItem>
      <ram:AssociatedDocumentLineDocument>
        <ram:LineID>${i + 1}</ram:LineID>
      </ram:AssociatedDocumentLineDocument>
      <ram:SpecifiedTradeProduct>
        <ram:Name>${esc(p.beschreibung)}</ram:Name>
      </ram:SpecifiedTradeProduct>
      <ram:SpecifiedLineTradeAgreement>
        <ram:NetPriceProductTradePrice>
          <ram:ChargeAmount>${fmt(p.einzelpreis)}</ram:ChargeAmount>
        </ram:NetPriceProductTradePrice>
      </ram:SpecifiedLineTradeAgreement>
      <ram:SpecifiedLineTradeDelivery>
        <ram:BilledQuantity unitCode="${unitCode}">${fmt(p.menge)}</ram:BilledQuantity>
      </ram:SpecifiedLineTradeDelivery>
      <ram:SpecifiedLineTradeSettlement>
        <ram:ApplicableTradeTax>
          <ram:TypeCode>VAT</ram:TypeCode>
          <ram:CategoryCode>${vatCategoryCode(rate)}</ram:CategoryCode>
          <ram:RateApplicablePercent>${fmt(rate)}</ram:RateApplicablePercent>
        </ram:ApplicableTradeTax>
        <ram:SpecifiedTradeSettlementLineMonetarySummation>
          <ram:LineTotalAmount>${fmt(net)}</ram:LineTotalAmount>
        </ram:SpecifiedTradeSettlementLineMonetarySummation>
      </ram:SpecifiedLineTradeSettlement>
    </ram:IncludedSupplyChainTradeLineItem>`;
  }).join('');

  const vatXML = Object.values(vatGroups).map(g => `
      <ram:ApplicableTradeTax>
        <ram:CalculatedAmount>${fmt(g.amount)}</ram:CalculatedAmount>
        <ram:TypeCode>VAT</ram:TypeCode>
        <ram:BasisAmount>${fmt(g.base)}</ram:BasisAmount>
        <ram:CategoryCode>${vatCategoryCode(g.rate)}</ram:CategoryCode>
        <ram:RateApplicablePercent>${fmt(g.rate)}</ram:RateApplicablePercent>
      </ram:ApplicableTradeTax>`).join('');

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
  const sellerContact = (data.verkaeufkontakt || data.verkaeuftel || data.verkaeuferemail)
    ? `<ram:DefinedTradeContact>
          ${data.verkaeufkontakt ? `<ram:PersonName>${esc(data.verkaeufkontakt)}</ram:PersonName>` : ''}
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
      </ram:BuyerTradeParty>
    </ram:ApplicableHeaderTradeAgreement>

    <ram:ApplicableHeaderTradeDelivery>
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

function vatCategoryCode(rate) {
  if (rate === 0) return 'Z';
  return 'S';
}

function calcTotals(positionen) {
  const vatGroups = {};
  positionen.forEach(p => {
    const net = parseFloat(p.menge || 0) * parseFloat(p.einzelpreis || 0);
    const rate = parseFloat(p.mwst || 19);
    const key = String(rate);
    if (!vatGroups[key]) vatGroups[key] = { base: 0, amount: 0, rate };
    vatGroups[key].base += net;
    vatGroups[key].amount += net * rate / 100;
  });
  const netTotal = Object.values(vatGroups).reduce((s, g) => s + g.base, 0);
  const vatTotal = Object.values(vatGroups).reduce((s, g) => s + g.amount, 0);
  return { netTotal, vatTotal, grossTotal: netTotal + vatTotal, vatGroups };
}

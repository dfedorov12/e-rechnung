'use strict';
/**
 * EU-VIES – USt-IdNr-Prüfung (Fallback, wenn BZSt nicht erreichbar ist)
 * ====================================================================
 * EU-weiter Bestätigungsdienst der Kommission. Liefert Gültigkeit, für viele
 * Mitgliedstaaten den registrierten Namen/Adresse und eine Anfragekennung
 * (requestIdentifier) als Nachweis.
 *
 *   POST https://ec.europa.eu/taxation_customs/vies/rest-api/check-vat-number
 *   Body: { countryCode, vatNumber, requesterMemberStateCode, requesterNumber,
 *           traderName, traderStreet, traderPostalCode, traderCityName }
 *   Antwort: { valid, requestIdentifier, name, address, trader*Match: VALID|INVALID|NOT_PROCESSED }
 */
const VIES_URL = process.env.VIES_URL
  || 'https://ec.europa.eu/taxation_customs/vies/rest-api/check-vat-number';

const MATCH_TEXT = { VALID: 'stimmt überein', INVALID: 'stimmt nicht überein', NOT_PROCESSED: 'nicht geprüft' };

/**
 * @param {{vatIdOwn:string, vatId:string, company?:string, city?:string, zip?:string, street?:string}} p
 */
async function pruefeVies(p) {
  const vat = String(p.vatId || '').replace(/\s+/g, '').toUpperCase();
  const own = String(p.vatIdOwn || '').replace(/\s+/g, '').toUpperCase();

  const body = { countryCode: vat.slice(0, 2), vatNumber: vat.slice(2) };
  if (own.startsWith('DE')) { body.requesterMemberStateCode = 'DE'; body.requesterNumber = own.slice(2); }
  if (p.company) body.traderName = String(p.company).trim();
  if (p.street)  body.traderStreet = String(p.street).trim();
  if (p.zip)     body.traderPostalCode = String(p.zip).trim();
  if (p.city)    body.traderCityName = String(p.city).trim();

  const r = await fetch(VIES_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
    body: JSON.stringify(body),
  });
  const d = await r.json().catch(() => ({}));

  const ergebnis = {}, ergebnisText = {};
  for (const [feld, key] of [['firmenname', 'traderNameMatch'], ['strasse', 'traderStreetMatch'], ['plz', 'traderPostalCodeMatch'], ['ort', 'traderCityMatch']]) {
    if (d[key] && d[key] !== '---') { ergebnis[feld] = d[key]; ergebnisText[feld] = MATCH_TEXT[d[key]] || d[key]; }
  }

  const val = d.valid === true;
  return {
    quelle: 'VIES',
    moeglich: true,
    qualifiziert: Object.values(ergebnis).some(v => v !== 'NOT_PROCESSED'),
    gueltig: val,
    httpStatus: r.status,
    status: val ? 'VIES-gueltig' : 'VIES-ungueltig',
    statusText: val ? 'USt-IdNr. ist gültig (VIES).' : 'USt-IdNr. ist nicht gültig (VIES).',
    anfrageId: d.requestIdentifier || '',
    zeitpunkt: d.requestDate || '',
    registriert: {
      name:    (d.name && d.name !== '---') ? d.name : '',
      adresse: (d.address && d.address !== '---') ? String(d.address).replace(/\s*\n\s*/g, ', ').trim() : '',
    },
    ergebnis,
    ergebnisText,
    eigeneUstId: own,
    pruefUstId: vat,
  };
}

module.exports = { pruefeVies, VIES_URL };

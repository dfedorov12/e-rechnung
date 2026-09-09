'use strict';
/**
 * BZSt eVatR – qualifizierte (oder einfache) USt-IdNr-Bestätigung
 * ===============================================================
 * Neue REST-API des Bundeszentralamts für Steuern (seit 01.07.2025; die alte
 * XML-RPC-Schnittstelle ist seit 30.11.2025 abgeschaltet).
 *
 *   POST https://api.evatr.vies.bzst.de/app/v1/abfrage
 *   Body (JSON, deutsche Feldnamen):
 *     anfragendeUstid  – eigene deutsche USt-IdNr (Anfragender, DE…)
 *     angefragteUstid  – zu prüfende ausländische EU-USt-IdNr
 *     firmenname, ort  – Pflicht für die QUALIFIZIERTE Bestätigung
 *     plz, strasse     – optional (erhöhen die Aussagekraft)
 *   Antwort:
 *     status (evatr-XXXX), id (Nachweis), anfrageZeitpunkt, gueltigAb/Bis,
 *     ergFirmenname/ergOrt/ergPlz/ergStrasse = A|B|C|D
 *       A stimmt überein · B stimmt nicht · C nicht angefragt · D vom EU-Staat nicht mitgeteilt
 *
 * Kein Zertifikat/Key nötig (wie die alte Schnittstelle). Ohne Firmenname/Ort
 * wird nur die EINFACHE Bestätigung (Gültigkeit) geliefert.
 */
const BZST_BASE = process.env.BZST_URL || 'https://api.evatr.vies.bzst.de/app/v1';

// USt-IdNr, die "gültig" bedeuten (0000 = gültig, 0003 = gültig, aber qual. Felder unvollständig).
const GUELTIG_STATUS = new Set(['evatr-0000', 'evatr-0003']);
const CODE_TEXT = {
  A: 'stimmt überein',
  B: 'stimmt nicht überein',
  C: 'nicht angefragt',
  D: 'vom EU-Mitgliedstaat nicht mitgeteilt',
};

// Statusmeldungs-Katalog (Klartext je Statuscode) – einmal laden, dann cachen.
let _statusCache = null;
async function statusText(status) {
  if (!status) return '';
  if (!_statusCache) {
    _statusCache = {};
    try {
      const r = await fetch(`${BZST_BASE}/info/statusmeldungen`, { headers: { Accept: 'application/json' } });
      if (r.ok) for (const s of await r.json()) if (s && s.status) _statusCache[s.status] = s.meldung || '';
    } catch { /* Klartext ist optional */ }
  }
  return _statusCache[status] || '';
}

/**
 * @param {{vatIdOwn:string, vatId:string, company?:string, city?:string, zip?:string, street?:string}} p
 * @returns {Promise<object>} normalisiertes Ergebnis
 */
async function pruefeBzst(p) {
  const body = {
    anfragendeUstid: clean(p.vatIdOwn),
    angefragteUstid: clean(p.vatId),
  };
  const qualifiziert = !!(p.company && p.city);
  if (qualifiziert) {
    body.firmenname = String(p.company).trim();
    body.ort = String(p.city).trim();
    if (p.zip)    body.plz = String(p.zip).trim();
    if (p.street) body.strasse = String(p.street).trim();
  }

  const r = await fetch(`${BZST_BASE}/abfrage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = await r.json().catch(() => ({}));
  const status = data.status || `http-${r.status}`;

  const ergebnis = {}, ergebnisText = {};
  for (const [feld, key] of [['firmenname', 'ergFirmenname'], ['ort', 'ergOrt'], ['plz', 'ergPlz'], ['strasse', 'ergStrasse']]) {
    if (data[key]) { ergebnis[feld] = data[key]; ergebnisText[feld] = CODE_TEXT[data[key]] || data[key]; }
  }

  return {
    quelle: 'BZSt',
    moeglich: true,
    qualifiziert: qualifiziert && Object.keys(ergebnis).length > 0,
    gueltig: GUELTIG_STATUS.has(status),
    httpStatus: r.status,
    status,
    statusText: await statusText(status),
    anfrageId: data.id || '',
    zeitpunkt: data.anfrageZeitpunkt || '',
    gueltigAb: data.gueltigAb || '',
    gueltigBis: data.gueltigBis || '',
    ergebnis,
    ergebnisText,
    eigeneUstId: body.anfragendeUstid,
    pruefUstId: body.angefragteUstid,
  };
}

function clean(v) { return String(v || '').replace(/\s+/g, '').toUpperCase(); }

module.exports = { pruefeBzst, BZST_BASE };

'use strict';
/**
 * HTTP-Trigger: qualifizierte USt-IdNr-Prüfung für den Ausgangsrechnungsprozess
 * ============================================================================
 *   GET  /api/vat  -> Info
 *   POST /api/vat  -> Body JSON { vatIdOwn, vatId, company, city, zip, street }
 *                     Antwort = normalisiertes Ergebnis inkl. `bericht` (Nachweis).
 *
 * Primär BZSt (deutsche qualifizierte Bestätigung, A/B/C/D + Anfrage-ID);
 * Fallback EU-VIES, falls BZSt nicht erreichbar ist (Wartungsfenster).
 *
 * authLevel "anonymous": wird direkt aus dem Browser-Tool (index.html) aufgerufen.
 * Enthält KEINE Geheimnisse; BZSt/VIES sind selbst ohne Auth erreichbar. Ergebnis
 * wird kurz gecacht (Rate-Limits der BZSt schonen).
 */
const { app } = require('@azure/functions');
const { pruefeBzst } = require('../bzst');
const { pruefeVies } = require('../vies');

const _cache = new Map();          // key -> { t, res }
const TTL_MS = 12 * 3600 * 1000;   // 12 h

app.http('vat', {
  methods: ['GET', 'POST'],
  authLevel: 'anonymous',
  route: 'vat',
  handler: async (request, context) => {
    if (request.method === 'GET') {
      return {
        status: 200,
        jsonBody: {
          service: 'USt-IdNr-Prüfung (BZSt qualifiziert, VIES-Fallback)',
          usage: 'POST { vatIdOwn (DE…), vatId (EU, nicht-DE), company, city, zip, street } '
               + '-> { gueltig, qualifiziert, ergebnis{firmenname,ort,plz,strasse}, anfrageId, bericht }',
        },
      };
    }

    let p;
    try { p = await request.json(); } catch { return problem(400, 'Request-Body muss JSON sein.'); }

    const vatId    = norm(p.vatId);
    const vatIdOwn = norm(p.vatIdOwn);

    if (!/^[A-Z]{2}[0-9A-Z]{2,15}$/.test(vatId)) {
      return problem(400, 'Ungültige zu prüfende USt-IdNr (Feld "vatId").');
    }
    if (vatId.startsWith('DE')) {
      return { status: 200, jsonBody: {
        moeglich: false,
        grund: 'BZSt/VIES bestätigen nur ausländische EU-USt-IdNr (nicht DE). '
             + 'Inlandsrechnungen brauchen keine qualifizierte Bestätigung.',
      } };
    }
    if (!vatIdOwn.startsWith('DE')) {
      return problem(400, 'Anfragende USt-IdNr ("vatIdOwn") muss deutsch sein (DE…).');
    }

    const params = {
      vatIdOwn, vatId,
      company: str(p.company), city: str(p.city), zip: str(p.zip), street: str(p.street),
    };

    const key = JSON.stringify(params);
    const hit = _cache.get(key);
    if (hit && Date.now() - hit.t < TTL_MS) {
      return { status: 200, jsonBody: { ...hit.res, cached: true } };
    }

    let res;
    try {
      res = await pruefeBzst(params);
    } catch (e) {
      context.warn('BZSt nicht erreichbar -> VIES-Fallback:', e && e.message);
      try {
        res = await pruefeVies(params);
        res.fallback = 'BZSt nicht erreichbar – EU-VIES verwendet';
      } catch (e2) {
        return problem(502, 'Weder BZSt noch VIES erreichbar: ' + (e2 && e2.message ? e2.message : String(e2)));
      }
    }

    res.bericht = baueBericht(res);
    _cache.set(key, { t: Date.now(), res });
    return { status: 200, jsonBody: res };
  },
});

/** Menschlich lesbarer Nachweis (für Anzeige/Druck/Ablage an der Rechnung). */
function baueBericht(res) {
  const L = { firmenname: 'Firmenname', ort: 'Ort', plz: 'PLZ', strasse: 'Straße' };
  const zeilen = [
    ['Quelle', res.quelle + (res.fallback ? ' (Fallback)' : '')],
    ['Art', res.qualifiziert ? 'Qualifizierte Bestätigung' : 'Einfache Bestätigung (Gültigkeit)'],
    ['Anfragende USt-IdNr.', res.eigeneUstId],
    ['Geprüfte USt-IdNr.', res.pruefUstId],
    ['Ergebnis', res.gueltig ? 'GÜLTIG' : 'NICHT gültig'],
    ['Status', [res.status, res.statusText].filter(Boolean).join(' – ')],
  ];
  if (res.qualifiziert) {
    for (const f of ['firmenname', 'ort', 'plz', 'strasse']) {
      if (res.ergebnis[f]) zeilen.push([L[f], `${res.ergebnis[f]} – ${res.ergebnisText[f]}`]);
    }
  }
  if (res.registriert && res.registriert.name) {
    zeilen.push(['Registriert (VIES)', [res.registriert.name, res.registriert.adresse].filter(Boolean).join(', ')]);
  }
  if (res.gueltigAb || res.gueltigBis) zeilen.push(['Gültigkeit', [res.gueltigAb, res.gueltigBis].filter(Boolean).join(' – ')]);
  zeilen.push(['Anfrage-ID (Nachweis)', res.anfrageId || '—']);
  zeilen.push(['Zeitpunkt', res.zeitpunkt || '—']);
  return { titel: 'USt-IdNr-Bestätigung', zeilen };
}

function norm(v) { return String(v || '').replace(/\s+/g, '').toUpperCase(); }
function str(v) { return v == null ? '' : String(v).trim(); }
function problem(status, message) {
  return { status, headers: { 'Content-Type': 'application/json; charset=utf-8' }, jsonBody: { error: message } };
}

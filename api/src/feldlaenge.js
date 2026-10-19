'use strict';
/**
 * Längengrenze der SharePoint-Textspalten
 * =======================================
 * „Eine Textzeile“ nimmt höchstens 255 Zeichen. Ist die Zielspalte so angelegt
 * (z. B. Validierungsmeldung in der Eingangsrechnungsliste auf gruppe_wgc), bricht
 * „Element aktualisieren“ im Flow mit PatchItem „maximum length 255“ ab. Darum
 * liefert /api/intake jeden Text, den der Flow in eine Spalte schreibt, höchstens
 * 255 Zeichen lang. Der volle Hinweis steht zusätzlich in hinweisLang, für Spalten
 * mit mehreren Textzeilen.
 */

const SP_TEXT = 255;

// Satzende: Punkt vor Leerzeichen und Großbuchstabe, nicht hinter einer
// Abkürzung aus einem Kleinbuchstaben („z. B.“).
const SATZENDE = /(?<![\s.][a-zäöü])\.(?= [A-ZÄÖÜ])/g;

/**
 * Text auf max Zeichen kürzen, möglichst an einem Satzende oder einem „ | “.
 * Gekürzte Texte enden auf „…“. Kurze Texte bleiben unverändert.
 */
function kuerzen(text, max = SP_TEXT) {
  if (text == null) return text;
  let s = String(text);
  if (s.length <= max) return s;
  s = s.replace(/\s+/g, ' ').trim();
  if (s.length <= max) return s;

  const roh = s.slice(0, max - 2);
  let schnitt = -1;
  for (const m of roh.matchAll(SATZENDE)) schnitt = m.index + 1;
  const trenner = roh.lastIndexOf(' | ');
  if (trenner > schnitt) schnitt = trenner;
  if (schnitt < max * 0.6) {
    const leer = roh.lastIndexOf(' ');
    schnitt = leer >= max * 0.6 ? leer : roh.length;
  }
  return roh.slice(0, schnitt).trim() + ' …';
}

/**
 * Antwort von /api/intake auf die Spaltenlängen bringen.
 * hinweis wird gekürzt, der volle Text bleibt in hinweisLang. In daten werden nur
 * Werte gekürzt, die länger als 255 Zeichen sind.
 */
function feldGrenzen(res) {
  if (!res) return res;
  res.hinweisLang = res.hinweis || '';
  res.hinweis = kuerzen(res.hinweis || '');
  for (const k of ['konformLabel', 'manuellePruefungGrund']) {
    if (typeof res[k] === 'string') res[k] = kuerzen(res[k]);
  }
  if (res.daten) {
    for (const [k, v] of Object.entries(res.daten)) {
      if (typeof v === 'string' && v.length > SP_TEXT) res.daten[k] = kuerzen(v);
    }
  }
  return res;
}

module.exports = { SP_TEXT, kuerzen, feldGrenzen };

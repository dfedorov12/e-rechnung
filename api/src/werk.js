'use strict';
/**
 * Werk-Erkennung fuer EINGANGSrechnungen
 * ======================================
 * Bei Eingangsrechnungen ist das Werk der RECHNUNGSEMPFÄNGER (Kaeufer = die
 * DIHAG-Gesellschaft), NICHT der Aussteller. (Der Browser-Konverter erkennt bei
 * Ausgangsrechnungen umgekehrt am Verkaeufer, siehe js/sharepoint.js.)
 *
 * Erkannt wird an Firmenname, Ort und Leitweg-ID des Empfaengers.
 *
 * Aktuell befuellt: WGC, SHB (dafuer ist der Eingangs-Flow gedacht). Weitere
 * Werke ergaenzen, sobald Firmenname/Ort je Werk feststehen:
 *   EIS, DSO, LEG, EWA, HOL, MEG, SCH, ZAI
 */

// Werk -> Erkennungswoerter (Kleinschreibung). Reihenfolge = Prioritaet.
// Kurzkuerzel (<= 3 Zeichen) werden als ganzes Wort gematcht, laengere als Teilstring.
const WERK_MUSTER = [
  { werk: 'SHB', woerter: ['bösdorf', 'boesdorf', 'hartguss', 'shb'] },
  { werk: 'WGC', woerter: ['coswig', 'walzengießerei', 'walzengiesserei', 'walzen', 'wgc'] },
  { werk: 'ZAI', woerter: ['zaigler'] },   // Dihag Zaigler GmbH, Kulmbach
  // Übrige Werke: Erkennungswoerter (Firmenname/Ort/Leitweg des EMPFAENGERS)
  // ergaenzen, sobald bekannt. Leere Listen sind inert (kein Treffer).
  { werk: 'EIS', woerter: [] },   // TODO
  { werk: 'DSO', woerter: [] },   // TODO
  { werk: 'LEG', woerter: [] },   // TODO
  { werk: 'EWA', woerter: [] },   // TODO
  { werk: 'HOL', woerter: [] },   // TODO
  { werk: 'MEG', woerter: [] },   // TODO
  { werk: 'SCH', woerter: [] },   // TODO
];

/**
 * @param {object} daten  geparste Kopfdaten (siehe intake.js mapDaten): erwartet
 *                        mindestens empfaenger, empfaengerOrt, leitwegid.
 * @returns {string}      Werk-Kuerzel ('WGC'|'SHB'|...) oder '' wenn unklar.
 */
function _matchWerk(hay) {
  hay = String(hay || '').toLowerCase();
  if (!hay) return '';
  const trifft = w =>
    (w.length <= 3 ? new RegExp('\\b' + w + '\\b').test(hay) : hay.includes(w));
  for (const m of WERK_MUSTER) {
    if (m.woerter.some(trifft)) return m.werk;
  }
  return '';
}

function detectWerkFromBuyer(daten) {
  return _matchWerk([
    daten && daten.empfaenger,
    daten && daten.empfaengerOrt,
    daten && daten.leitwegid,
  ].filter(Boolean).join(' '));
}

/**
 * Werk am VERKAEUFER (Aussteller) erkennen — fuer die Richtungsbestimmung:
 * ist eine DIHAG-Gesellschaft der Aussteller, ist es eine AUSGANGSrechnung.
 * Nutzt dieselben Erkennungswoerter, angewandt auf Aussteller-Name/USt-IdNr.
 */
function detectWerkFromSeller(daten) {
  return _matchWerk([
    daten && daten.steller,
    daten && daten.stellerVat,
  ].filter(Boolean).join(' '));
}

module.exports = { detectWerkFromBuyer, detectWerkFromSeller, WERK_MUSTER };

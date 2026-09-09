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
  // { werk: 'EIS', woerter: [] },   // TODO Firmenname/Ort ergaenzen
  // { werk: 'DSO', woerter: [] },
  // { werk: 'LEG', woerter: [] },
  // { werk: 'EWA', woerter: [] },
  // { werk: 'HOL', woerter: [] },
  // { werk: 'MEG', woerter: [] },
  // { werk: 'SCH', woerter: [] },
  // { werk: 'ZAI', woerter: [] },
];

/**
 * @param {object} daten  geparste Kopfdaten (siehe intake.js mapDaten): erwartet
 *                        mindestens empfaenger, empfaengerOrt, leitwegid.
 * @returns {string}      Werk-Kuerzel ('WGC'|'SHB'|...) oder '' wenn unklar.
 */
function detectWerkFromBuyer(daten) {
  const hay = [
    daten && daten.empfaenger,
    daten && daten.empfaengerOrt,
    daten && daten.leitwegid,
  ].filter(Boolean).join(' ').toLowerCase();
  if (!hay) return '';

  const trifft = w =>
    (w.length <= 3 ? new RegExp('\\b' + w + '\\b').test(hay) : hay.includes(w));

  for (const m of WERK_MUSTER) {
    if (m.woerter.some(trifft)) return m.werk;
  }
  return '';
}

module.exports = { detectWerkFromBuyer, WERK_MUSTER };

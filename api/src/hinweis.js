'use strict';
/**
 * Klartext-Hinweis für Rechnungen mit Warnungen („gelb“)
 * =======================================================
 * Warnungen sind keine Fehler: Die E-Rechnung ist gültig und wird automatisch
 * gebucht. Bis 10/2026 schrieb die Prüfung für „gelb“ keinen Hinweis, im
 * Monitoring stand dann „gelb“ ohne Begründung. Jetzt steht die erste Warnung da.
 */

/**
 * @param {string[]} texte  Warnungstexte aus dem Prüfbericht (KoSIT oder Mustang)
 * @returns {string}        z. B. „Nur Warnungen, die Rechnung ist gültig: [BR-DE-21] … (und 2 weitere)“
 */
function hinweisWarnungen(texte) {
  const warn = Array.from(new Set((texte || []).map(t => String(t || '').trim()).filter(Boolean)));
  if (!warn.length) return 'Nur Warnungen, die Rechnung ist gültig.';
  const erste = warn[0].length > 160 ? warn[0].slice(0, 157) + '…' : warn[0];
  return `Nur Warnungen, die Rechnung ist gültig: ${erste}`
    + (warn.length > 1 ? ` (und ${warn.length - 1} weitere)` : '');
}

module.exports = { hinweisWarnungen };

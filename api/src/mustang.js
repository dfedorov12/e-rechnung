'use strict';
/**
 * Mustangproject-Validierung (Client zum Mustang-Dienst, siehe mustang-service/)
 * =============================================================================
 * Validiert ZUGFeRD/Factur-X gegen das TATSAECHLICHE Profil (BASIC/EN16931/
 * EXTENDED) + PDF/A. KoSIT (XRechnung-Konfig) kann EXTENDED nicht korrekt pruefen
 * und meldet zulaessige Zusatzangaben als Fehler — dafuer gibt es diesen Dienst.
 *
 * Ergebnisform ist bewusst IDENTISCH zu kosit.js (validateXml), damit intake/
 * validate/Monitoring/Flow ohne Sonderfall funktionieren:
 *   { konform, konformLabel, accepted, errorCount, warningCount, meldungen[],
 *     meldungenText, hinweis, werkzeug, bericht? }
 */
const MUSTANG_URL = process.env.MUSTANG_URL || 'http://localhost:8090/';

/**
 * @param {Buffer} buf  ZUGFeRD/Factur-X-PDF oder CII-XML (roh).
 * @param {{ withReport?: boolean, minimalprofil?: boolean }} [opts]
 *        minimalprofil=true: Quelle ist Factur-X MINIMUM/BASIC-WL -> keine
 *        vollstaendige E-Rechnung; Urteil wird nicht auf "gruen" gelassen.
 */
async function validateMustang(buf, opts = {}) {
  const resp = await fetch(MUSTANG_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/octet-stream' },
    body: buf,
  });
  const report = await resp.text();
  if (resp.status !== 200 && resp.status !== 406) {
    throw new Error(`Mustang-Dienst HTTP ${resp.status}: ${report.slice(0, 200)}`);
  }
  const result = parseMustangReport(report, opts);
  if (opts.withReport) result.bericht = report;
  return result;
}

/**
 * Mustang-Report auswerten (defensiv gegen Format-Varianten der Mustang-Versionen).
 * Fehler = <error>-Elemente bzw. status="invalid"; Warnungen = <notice>/<warning>.
 */
function parseMustangReport(report, opts = {}) {
  const s = String(report || '');
  const decode = t => t
    .replace(/<[^>]+>/g, ' ')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'").replace(/&apos;/g, "'").replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ').trim();
  // Mustang-Meldungstext endet mit "… [ID FX-SCH-…] from /xslt/….xslt)" -> abschneiden.
  const clean = t => decode(t)
    .replace(/\s*\[ID\b[\s\S]*$/i, '')
    .replace(/\s*from\s+\/xslt\/[\s\S]*$/i, '')
    .trim();

  // Kein verwertbarer Report -> als Fehler behandeln (Aufrufer setzt validierungsFehler).
  if (!/<validation|<summary|status\s*=|<error|<messages|valid/i.test(s)) {
    throw new Error('Mustang: kein verwertbarer Report (' + s.slice(0, 120) + ')');
  }

  const errTexts = [];
  const warnTexts = [];
  let m;
  // Mustang: <error type=".." location=".." criterion="..grosser XPath..">Text</error>.
  // Das criterion-Attribut ist die XPath-Regel (unbrauchbar fuer Anzeige) -> ignorieren,
  // nur der Meldungstext (enthaelt [BR-…]/„Value of … is not allowed") wird genutzt.
  const errRe = /<error\b[^>]*>([\s\S]*?)<\/error>/gi;
  while ((m = errRe.exec(s))) { const t = clean(m[1]); if (t) errTexts.push(t); }
  const warnRe = /<(?:notice|warning)\b[^>]*>([\s\S]*?)<\/(?:notice|warning)>/gi;
  while ((m = warnRe.exec(s))) { const t = clean(m[1]); if (t) warnTexts.push(t); }

  const errorCount = errTexts.length;      // echte Anzahl (Mustang listet je Position)
  const warningCount = warnTexts.length;
  const invalid = /status\s*=\s*"?invalid/i.test(s) || errorCount > 0;

  // Fuer Anzeige/Text identische Meldungen zusammenfassen (sonst 7x dieselbe Zeile).
  const uniq = arr => Array.from(new Set(arr));
  const meldungen = uniq(errTexts).map(t => ({ level: 'error', text: t.slice(0, 300) }))
    .concat(uniq(warnTexts).map(t => ({ level: 'warning', text: t.slice(0, 300) })))
    .slice(0, 50);

  let konform = invalid ? 'rot' : (warningCount ? 'gelb' : 'gruen');
  let hinweis = '';
  if (invalid) {
    const first = uniq(errTexts)[0] || 'Dokument entspricht nicht dem deklarierten Profil.';
    hinweis = 'Profil-/Formatfehler (ZUGFeRD/Factur-X): ' + first.slice(0, 240);
  }

  // MINIMUM/BASIC-WL: strukturell evtl. gueltig, aber KEINE vollstaendige E-Rechnung.
  if (opts.minimalprofil) {
    if (konform === 'gruen') konform = 'gelb';
    hinweis = 'Profil Factur-X/ZUGFeRD MINIMUM bzw. BASIC-WL — keine vollstaendige '
      + 'E-Rechnung (nur Buchungshilfe, Positionsdaten fehlen); nach §14 UStG nicht als '
      + 'E-Rechnung anerkannt.';
  }

  // konformLabel-Strings MUESSEN zur SharePoint-Choice-Spalte "Konformitaet" passen
  // (dieselben Werte wie beim KoSIT-Pfad); das Werkzeug steht separat in `werkzeug`.
  const label = { gruen: 'Gruen - KoSIT ok', gelb: 'Gelb - Warnungen', rot: 'Rot - Fehler' }[konform];
  return {
    konform,
    konformLabel: label,
    accepted: konform !== 'rot',
    errorCount,
    warningCount,
    meldungen,
    meldungenText: meldungen.map(x => (x.level === 'error' ? 'Fehler' : 'Warnung') + ': ' + x.text).join(' | '),
    hinweis,
    werkzeug: 'Mustang (ZUGFeRD-Profil)',
  };
}

module.exports = { validateMustang, parseMustangReport, MUSTANG_URL };

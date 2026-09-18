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

// Standardtext fuer die automatische Zurueckweisung von MINIMUM/BASIC-WL (Punkt 3).
const TEXT_ZURUECKWEISUNG_MINIMAL =
  'Ihre Rechnung wurde im ZUGFeRD/Factur-X-Profil MINIMUM bzw. BASIC-WL uebermittelt. '
  + 'Diese Profile gelten nach §14 UStG nicht als elektronische Rechnung (keine vollstaendigen '
  + 'Positionsdaten). Bitte uebermitteln Sie eine E-Rechnung im Profil EN16931 (COMFORT) oder '
  + 'hoeher bzw. als XRechnung.';

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

  // Verdikt NUR aus dem <xml>-Teil ableiten. Der <pdf>-Teil (PDF/A-3-Huelle) ist
  // umsatzsteuerlich KEIN Ablehnungsgrund (UStAE 14.1 Abs. 2: fehlendes PDF/A-3 ->
  // "sonstige Rechnung", Berichtigung anfordern) und wird separat als pdfaMangel
  // gemeldet, statt in die Konformitaet zu zaehlen.
  const xmlSec = (s.match(/<xml\b[\s\S]*?<\/xml>/i) || [s])[0];
  const pdfSec = (s.match(/<pdf\b[\s\S]*?<\/pdf>/i) || [''])[0];
  const pdfaMangel = /not a pdf\/a|iscompliant=false|status\s*=\s*"?invalid/i.test(pdfSec);

  const errTexts = [];
  const warnTexts = [];
  let m;
  // <error …>Text</error> — nur der Meldungstext; das criterion-XPath-Attribut ignorieren.
  const errRe = /<error\b[^>]*>([\s\S]*?)<\/error>/gi;
  while ((m = errRe.exec(xmlSec))) { const t = clean(m[1]); if (t) errTexts.push(t); }
  const warnRe = /<(?:notice|warning)\b[^>]*>([\s\S]*?)<\/(?:notice|warning)>/gi;
  while ((m = warnRe.exec(xmlSec))) { const t = clean(m[1]); if (t) warnTexts.push(t); }

  const errorCount = errTexts.length;      // echte Anzahl (Mustang listet je Position)
  const warningCount = warnTexts.length;
  const invalid = /status\s*=\s*"?invalid/i.test(xmlSec) || errorCount > 0;

  // Fuer Anzeige/Text identische Meldungen zusammenfassen (sonst 7x dieselbe Zeile).
  const uniq = arr => Array.from(new Set(arr));
  const meldungen = uniq(errTexts).map(t => ({ level: 'error', text: t.slice(0, 300) }))
    .concat(uniq(warnTexts).map(t => ({ level: 'warning', text: t.slice(0, 300) })))
    .slice(0, 50);

  let konform = invalid ? 'rot' : (warningCount ? 'gelb' : 'gruen');
  let hinweis = '';
  let zurueckweisung = null;
  if (invalid) {
    const first = uniq(errTexts)[0] || 'Dokument entspricht nicht dem deklarierten Profil.';
    hinweis = 'Profil-/Formatfehler (ZUGFeRD/Factur-X): ' + first.slice(0, 240);
  }

  // MINIMUM/BASIC-WL sind KEINE E-Rechnung (UStAE 14.1 Abs. 14) -> HARTER STOPP:
  // automatische Zurueckweisung mit Standardtext, kein Ermessen im Pruefschritt.
  if (opts.minimalprofil) {
    konform = 'rot';
    hinweis = 'Profil Factur-X/ZUGFeRD MINIMUM bzw. BASIC-WL — keine E-Rechnung nach '
      + '§14 UStG (UStAE 14.1 Abs. 14). Automatische Zurueckweisung.';
    zurueckweisung = { grund: 'MINIMUM/BASIC-WL', text: TEXT_ZURUECKWEISUNG_MINIMAL };
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
    pdfaMangel,               // PDF/A-3-Huelle fehlerhaft (separat; kein Konformitaets-K.o.)
    zurueckweisung,           // {grund,text} bei hartem Stopp (MINIMUM/BASIC-WL), sonst null
    werkzeug: 'Mustang (ZUGFeRD-Profil)',
  };
}

module.exports = { validateMustang, parseMustangReport, MUSTANG_URL };

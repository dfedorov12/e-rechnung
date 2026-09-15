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
    .replace(/&#39;/g, "'").replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ').trim();

  // Kein verwertbarer Report -> als Fehler behandeln (Aufrufer setzt validierungsFehler).
  if (!/<validation|status\s*=|<error|<message|valid/i.test(s)) {
    throw new Error('Mustang: kein verwertbarer Report (' + s.slice(0, 120) + ')');
  }

  const meldungen = [];
  let m;
  // <error ...>Text</error>  (mit optionalem criterion=)
  const errRe = /<error\b([^>]*)>([\s\S]*?)<\/error>/gi;
  while ((m = errRe.exec(s))) {
    const crit = (m[1].match(/criterion="([^"]*)"/i) || ['', ''])[1];
    const text = ((crit ? crit + ': ' : '') + decode(m[2])).trim();
    if (text) meldungen.push({ level: 'error', text: text.slice(0, 300) });
  }
  // Selbstschliessende <error criterion=... message=.../>
  const errSelf = /<error\b([^>]*?)\/>/gi;
  while ((m = errSelf.exec(s))) {
    const a = m[1];
    const crit = (a.match(/criterion="([^"]*)"/i) || ['', ''])[1];
    const msg = (a.match(/message="([^"]*)"/i) || ['', ''])[1];
    const text = ((crit ? crit + ': ' : '') + (msg || '')).trim();
    if (text) meldungen.push({ level: 'error', text: text.slice(0, 300) });
  }
  // Warnungen/Hinweise
  const warnRe = /<(?:notice|warning)\b[^>]*>([\s\S]*?)<\/(?:notice|warning)>/gi;
  while ((m = warnRe.exec(s))) {
    const text = decode(m[1]);
    if (text) meldungen.push({ level: 'warning', text: text.slice(0, 300) });
  }

  let errorCount = meldungen.filter(x => x.level === 'error').length;
  const warningCount = meldungen.filter(x => x.level === 'warning').length;

  // Gesamturteil: explizites status="invalid" ODER gezaehlte Fehler.
  const invalid = /status\s*=\s*"?invalid/i.test(s) || errorCount > 0;

  let konform = invalid ? 'rot' : (warningCount ? 'gelb' : 'gruen');
  let hinweis = '';
  if (invalid) {
    const first = meldungen.find(x => x.level === 'error');
    hinweis = 'Profil-/Formatfehler (ZUGFeRD/Factur-X): '
      + (first ? first.text : 'Dokument entspricht nicht dem deklarierten Profil.');
  }

  // MINIMUM/BASIC-WL: strukturell evtl. gueltig, aber KEINE vollstaendige E-Rechnung.
  if (opts.minimalprofil) {
    if (konform === 'gruen') konform = 'gelb';
    hinweis = 'Profil Factur-X/ZUGFeRD MINIMUM bzw. BASIC-WL — keine vollstaendige '
      + 'E-Rechnung (nur Buchungshilfe, Positionsdaten fehlen); nach §14 UStG nicht als '
      + 'E-Rechnung anerkannt.';
    if (!errorCount) errorCount = 0; // Zaehler unveraendert; nur Einstufung/Hinweis
  }

  const label = { gruen: 'Gruen - KoSIT ok', gelb: 'Gelb - Warnungen', rot: 'Rot - Fehler' }[konform];
  const top = meldungen.slice(0, 50);
  return {
    konform,
    konformLabel: label,
    accepted: konform !== 'rot',
    errorCount,
    warningCount,
    meldungen: top,
    meldungenText: top.map(x => (x.level === 'error' ? 'Fehler' : 'Warnung') + ': ' + x.text).join(' | '),
    hinweis,
    werkzeug: 'Mustang (ZUGFeRD-Profil)',
  };
}

module.exports = { validateMustang, parseMustangReport, MUSTANG_URL };

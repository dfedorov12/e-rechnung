'use strict';
/**
 * KoSIT-Validierung (Client zum KoSIT-Validator im Daemon-Modus)
 * ==============================================================
 * Schickt eine E-Rechnungs-XML an den KoSIT-Daemon (HTTP) und wertet den
 * zurueckgelieferten Report aus -> { konform, accepted, meldungen }.
 *
 * Der Daemon (offizieller KoSIT-Validator, Java) laeuft als eigener Container,
 * siehe kosit-service/. Seine URL kommt aus der App-Einstellung KOSIT_DAEMON_URL.
 */
const KOSIT_DAEMON_URL = process.env.KOSIT_DAEMON_URL || 'http://localhost:8080/';

/** XML an den KoSIT-Daemon senden und Report auswerten. */
async function validateXml(xml) {
  const resp = await fetch(KOSIT_DAEMON_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/xml' },
    body: xml,
  });
  const reportXml = await resp.text();
  // KoSIT-Daemon signalisiert das Urteil auch per HTTP-Status:
  //   200 = angenommen, 406 = abgelehnt. In BEIDEN Faellen steht der Report im Body.
  // Nur echte Server-/Verbindungsfehler (kein Report) als Fehler behandeln.
  if (resp.status !== 200 && resp.status !== 406) {
    throw new Error(`KoSIT-Daemon HTTP ${resp.status}: ${reportXml.slice(0, 200)}`);
  }
  return parseReport(reportXml, resp.status === 406);
}

/**
 * KoSIT-Report auswerten.
 * Massgeblich ist das Urteil der Bewertung <rep:assessment>:
 *   <rep:accept> = angenommen (konform),  <rep:reject> = abgelehnt.
 * WICHTIG: NICHT jedes Element mit level-Attribut zaehlen — <s:customLevel> im
 * Szenario ist nur die Severity-KONFIGURATION der Regelcodes, kein Befund.
 * Einzelbefunde werden best effort aus den Schematron-Ergebnissen gezogen
 * (svrl:failed-assert = Fehler, svrl:successful-report[flag=warning] = Warnung);
 * fehlen diese, wird die HTML-Fehlertabelle des Reports als Fallback genutzt.
 */
function parseReport(reportXml, httpRejected) {
  const s = String(reportXml || '');
  const strip = t => t.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();

  // Authoritatives Urteil: HTTP-Status 406 des Daemons ODER <rep:reject> im Report.
  const rejected = httpRejected === true || /<rep:reject\b/i.test(s);

  const meldungen = [];
  let m;

  const failRe = /<svrl:failed-assert\b([^>]*)>([\s\S]*?)<\/svrl:failed-assert>/gi;
  while ((m = failRe.exec(s))) {
    const flag = (m[1].match(/flag="([^"]*)"/i) || ['', ''])[1].toLowerCase();
    const level = (flag === 'warning' || flag === 'warn') ? 'warning' : 'error';
    const text = strip(m[2]);
    if (text) meldungen.push({ level, text: text.slice(0, 300) });
  }
  const okRe = /<svrl:successful-report\b([^>]*)>([\s\S]*?)<\/svrl:successful-report>/gi;
  while ((m = okRe.exec(s))) {
    const flag = (m[1].match(/flag="([^"]*)"/i) || ['', ''])[1].toLowerCase();
    if (flag === 'warning' || flag === 'warn') {
      const text = strip(m[2]);
      if (text) meldungen.push({ level: 'warning', text: text.slice(0, 300) });
    }
  }

  // Fallback: HTML-Fehlertabelle, falls keine SVRL-Befunde eingebettet sind.
  if (!meldungen.length && rejected) {
    const rowRe = /<tr\b[^>]*>([\s\S]*?)<\/tr>/gi;
    while ((m = rowRe.exec(s))) {
      const text = strip(m[1]);
      if (text && /[A-Z]{2,}-[A-Z0-9-]*\d/.test(text)) meldungen.push({ level: 'error', text: text.slice(0, 300) });
    }
  }

  const errorCount   = meldungen.filter(x => x.level === 'error').length;
  const warningCount = meldungen.filter(x => x.level === 'warning').length;

  let konform;
  if (rejected || errorCount) konform = 'rot';
  else if (warningCount)      konform = 'gelb';
  else                        konform = 'gruen';

  const label = { gruen: 'Gruen - KoSIT ok', gelb: 'Gelb - Warnungen', rot: 'Rot - Fehler' }[konform];

  return {
    konform,                    // 'gruen' | 'gelb' | 'rot'
    konformLabel: label,        // passend zur SharePoint-Choice-Spalte "Konformitaet"
    accepted: konform !== 'rot',
    errorCount,
    warningCount,
    meldungen: meldungen.slice(0, 50),
  };
}

module.exports = { validateXml, parseReport, KOSIT_DAEMON_URL };

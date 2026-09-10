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

/**
 * XML an den KoSIT-Daemon senden und Report auswerten.
 * @param {string} xml
 * @param {{ withReport?: boolean }} [opts]  withReport=true haengt den vollstaendigen
 *        KoSIT-Pruefbericht an das Ergebnis an (Feld `bericht`, roh vom Daemon; bei
 *        eingebetteter HTML-Darstellung zusaetzlich `berichtHtml`). Fuer Archiv/GoBD.
 */
async function validateXml(xml, opts = {}) {
  let { status, reportXml } = await _postKosit(xml);
  let result = parseReport(reportXml, status === 406);

  // Kein Prüfszenario gegriffen ("Dokumenttyp unbekannt")? Bei Factur-X/ZUGFeRD-
  // Profilen (eingehende Rechnungen) gegen REINES EN16931 erneut prüfen — der
  // Inhalt ist identisch, nur die Profilkennung passt nicht zur XRechnung-Konfig.
  if (opts.profilFallback !== false && _keinSzenario(result, reportXml)) {
    const en = _en16931Guideline(xml);
    if (en !== xml) {
      const r2 = await _postKosit(en);
      const res2 = parseReport(r2.reportXml, r2.status === 406);
      if (!_keinSzenario(res2, r2.reportXml)) {
        result = res2;
        result.profilFallback = 'Gegen EN16931 geprüft (Factur-X/ZUGFeRD-Profil, nicht XRechnung).';
        reportXml = r2.reportXml;
      }
    }
  }

  if (opts.withReport) {
    // Roher KoSIT-Pruefbericht (offizielles, revisionssicher archivierbares Artefakt).
    result.bericht = reportXml;
    // Manche Reportvarianten betten eine HTML-Darstellung ein -> separat mitgeben.
    const hm = reportXml.match(/<html[\s\S]*?<\/html>/i);
    if (hm) result.berichtHtml = hm[0];
  }
  return result;
}

/** Eine XML an den KoSIT-Daemon senden. 200=accept, 406=reject; sonst Fehler. */
async function _postKosit(xml) {
  const resp = await fetch(KOSIT_DAEMON_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/xml' },
    body: xml,
  });
  const reportXml = await resp.text();
  if (resp.status !== 200 && resp.status !== 406) {
    throw new Error(`KoSIT-Daemon HTTP ${resp.status}: ${reportXml.slice(0, 200)}`);
  }
  return { status: resp.status, reportXml };
}

/** "Kein Szenario gegriffen / Dokumenttyp unbekannt" im Report erkennen. */
function _keinSzenario(result, reportXml) {
  const s = String(reportXml || '');
  return /keinem?\s+zul[aä]ssigen\s+Dokumenttyp|kein\w*\s+Pr[uü]fszenario|Dokumenttyp[^<]{0,40}unbekannt|kein\s+passendes\s+Szenario/i.test(s);
}

/**
 * Factur-X/ZUGFeRD-Profilkennung auf reines EN16931 zurücksetzen, damit die
 * EN16931-Szenarien der KoSIT-XRechnung-Konfig greifen. Nur die GuidelineID/
 * CustomizationID wird angefasst; der fachliche Inhalt bleibt unverändert.
 */
function _en16931Guideline(xml) {
  return String(xml).replace(
    /urn:cen\.eu:en16931:2017#compliant#urn:(?:factur-x\.eu|zugferd\.de|ferd-net\.de)[^<\s"']*/gi,
    'urn:cen.eu:en16931:2017'
  );
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

  const top = meldungen.slice(0, 50);
  return {
    konform,                    // 'gruen' | 'gelb' | 'rot'
    konformLabel: label,        // passend zur SharePoint-Choice-Spalte "Konformitaet"
    accepted: konform !== 'rot',
    errorCount,
    warningCount,
    meldungen: top,
    // Fertig zusammengesetzter Text fuer die SharePoint-Spalte (Power Automate braucht
    // dann kein Select/join ueber die Objekt-Liste). Leer, wenn keine Befunde.
    meldungenText: top.map(m => (m.level === 'error' ? 'Fehler' : 'Warnung') + ': ' + m.text).join(' | '),
  };
}

module.exports = { validateXml, parseReport, KOSIT_DAEMON_URL };

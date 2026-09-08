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
const { DOMParser } = require('@xmldom/xmldom');

const KOSIT_DAEMON_URL = process.env.KOSIT_DAEMON_URL || 'http://localhost:8080/';

/** XML an den KoSIT-Daemon senden und Report auswerten. */
async function validateXml(xml) {
  const resp = await fetch(KOSIT_DAEMON_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/xml' },
    body: xml,
  });
  const reportXml = await resp.text();
  if (!resp.ok) {
    throw new Error(`KoSIT-Daemon HTTP ${resp.status}: ${reportXml.slice(0, 200)}`);
  }
  return parseReport(reportXml);
}

/**
 * KoSIT-/VARL-Report auswerten. Robust gegen Namespace-Varianten:
 * es werden alle <...:message>-Elemente eingesammelt und nach level gezaehlt.
 */
function parseReport(reportXml) {
  const doc = new DOMParser({
    errorHandler: { warning() {}, error() {}, fatalError() {} },
  }).parseFromString(reportXml, 'application/xml');

  const all = doc.getElementsByTagName('*');
  const messages = [];
  let acceptRec = '';

  for (let i = 0; i < all.length; i++) {
    const el = all[i];
    const ln = (el.localName || el.nodeName || '').toLowerCase();
    if (ln === 'message') {
      const level = (el.getAttribute('level') || el.getAttribute('severity') || 'error').toLowerCase();
      const code  = el.getAttribute('code') || el.getAttribute('id') || '';
      const text  = (el.textContent || '').replace(/\s+/g, ' ').trim();
      messages.push({ level, code, text: text.slice(0, 300) });
    } else if (ln === 'acceptrecommendation') {
      acceptRec = (el.textContent || '').trim().toUpperCase();
    }
  }

  const errors   = messages.filter(m => m.level.startsWith('err'));
  const warnings = messages.filter(m => m.level.startsWith('warn'));

  let konform;
  if (errors.length)        konform = 'rot';
  else if (warnings.length) konform = 'gelb';
  else                      konform = 'gruen';
  // Explizite Ablehnung des Validators respektieren.
  if (acceptRec === 'REJECT' && konform === 'gruen') konform = 'rot';

  const label = { gruen: 'Gruen - KoSIT ok', gelb: 'Gelb - Warnungen', rot: 'Rot - Fehler' }[konform];

  return {
    konform,                    // 'gruen' | 'gelb' | 'rot'
    konformLabel: label,        // passend zur SharePoint-Choice-Spalte "Konformitaet"
    accepted: konform !== 'rot',
    errorCount: errors.length,
    warningCount: warnings.length,
    meldungen: messages.slice(0, 50),
  };
}

module.exports = { validateXml, parseReport, KOSIT_DAEMON_URL };

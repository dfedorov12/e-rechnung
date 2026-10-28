// node tests/kreditormail.test.js
// Mail an den Lieferanten bei Zurückweisung (rot, MINIMUM) und Abweichungen (gelb), api/src/kreditormail.js
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const API = path.join(__dirname, '..', 'api');
const { kreditorMail, VORLAGEN } = require(path.join(API, 'src', 'kreditormail.js'));

let n = 0;
const gleich = (ist, soll, m) => { assert.deepStrictEqual(ist, soll, m + ': ' + JSON.stringify(ist)); n++; };
const enthaelt = (s, teil, m) => { assert.ok(String(s).includes(teil), m + ': ' + teil + ' fehlt in ' + JSON.stringify(s)); n++; };

const daten = { nummer: '4711', datum: '2026-10-27', brutto: 1234.5, waehrung: 'EUR', empfaenger: 'Walzengießerei Coswig GmbH' };

// 1) Zurückweisung (rot): Vorlage wörtlich, Rechnung, Fehler als Liste, Gruß mit Empfänger
const rot = kreditorMail({
  richtung: 'Eingang', daten,
  kreditorAktion: { art: 'zurueckweisung', grund: 'pruefung-rot', text: 'x' },
  meldungen: [{ level: 'error', text: '[BR-CO-15] Summe <falsch> & Co' }, { level: 'warning', text: '[BR-DE-21] egal' }],
});
gleich(rot.art, 'Zurueckweisung', 'Art für KreditorMails');
gleich(rot.betreff, 'Zurückweisung Ihrer E-Rechnung 4711', 'Betreff');
for (const a of VORLAGEN.zurueckweisung.absaetze) enthaelt(rot.text, a, 'Absatz wörtlich');
enthaelt(rot.text, 'Sehr geehrte Damen und Herren,\n\nvielen Dank', 'Anrede');
enthaelt(rot.text, 'Rechnung 4711 vom 27.10.2026 über 1.234,50 EUR\nFestgestellte Mängel:\n- [BR-CO-15] Summe <falsch> & Co', 'Befunde im Text');
gleich(rot.text.includes('BR-DE-21'), false, 'Warnungen gehören nicht in die Zurückweisung');
enthaelt(rot.text, 'Für Rückfragen stehen wir Ihnen gerne zur Verfügung.\n\nVielen Dank für Ihre Unterstützung.\n\nMit freundlichen Grüßen\nWalzengießerei Coswig GmbH', 'Schluss');
enthaelt(rot.html, '<li>[BR-CO-15] Summe &lt;falsch&gt; &amp; Co</li>', 'HTML maskiert');
enthaelt(rot.html, '<p>Mit freundlichen Grüßen<br>Walzengießerei Coswig GmbH</p>', 'HTML Gruß');

// 2) MINIMUM/BASIC-WL: Befund ist der Text zur Profil-Zurückweisung
const minimal = kreditorMail({
  richtung: 'Eingang', daten: { nummer: 'A-1' },
  kreditorAktion: { art: 'zurueckweisung', grund: 'MINIMUM/BASIC-WL', text: 'Profil' },
  zurueckweisung: { grund: 'MINIMUM/BASIC-WL', text: 'Profil MINIMUM ist keine E-Rechnung.' },
  meldungen: [{ level: 'error', text: '[X] egal' }],
});
enthaelt(minimal.text, 'Rechnung A-1\nFestgestellte Mängel:\n- Profil MINIMUM ist keine E-Rechnung.', 'Profil als Befund');

// 3) Rot ohne einzelne Fehler: Klartext-Hinweis ohne interne Zusätze
const ohne = kreditorMail({
  richtung: '', daten: null, kreditorAktion: { art: 'zurueckweisung' }, meldungen: [],
  hinweis: 'Rechnerische Summen stimmen nicht. | Reverse-Charge (§13b UStG) — manuelle Pruefung',
});
enthaelt(ohne.text, 'Festgestellte Mängel:\n- Rechnerische Summen stimmen nicht.\n\nFür Rückfragen', 'Hinweis ohne Zusatz');
gleich(ohne.betreff, 'Zurückweisung Ihrer E-Rechnung', 'Betreff ohne Nummer');
enthaelt(ohne.text, '\n\nMit freundlichen Grüßen', 'Gruß ohne Empfänger');
gleich(/Mit freundlichen Grüßen\n/.test(ohne.text), false, 'kein leerer Name nach dem Gruß');

// 4) Abweichung (gelb): Warnungen, höchstens 10
const warnungen = Array.from({ length: 12 }, (_, i) => ({ level: 'warning', text: `[BR-DE-${i + 1}] Warnung ${i + 1}` }));
const gelb = kreditorMail({ richtung: 'Eingang', daten, kreditorAktion: { art: 'abweichung' }, meldungen: warnungen });
gleich(gelb.art, 'Abweichung', 'Art Abweichung');
gleich(gelb.betreff, 'Hinweis zu Ihrer E-Rechnung 4711', 'Betreff Abweichung');
for (const a of VORLAGEN.abweichung.absaetze) enthaelt(gelb.text, a, 'Absatz wörtlich');
enthaelt(gelb.text, 'Festgestellte Abweichungen:\n- [BR-DE-1] Warnung 1', 'erste Warnung');
enthaelt(gelb.text, '- [BR-DE-10] Warnung 10\n- (und 2 weitere, siehe Prüfbericht)', 'gekürzt');
gleich(gelb.text.includes('Für Rückfragen'), false, 'Abweichung ohne Rückfragen-Satz');
enthaelt(gelb.text, 'möglichst zu vermeiden.\n\nRechnung 4711', 'Befunde nach der Vorlage');

// 5) Keine Mail: Ausgang, sonstige Rechnung (Berichtigung), ohne Aktion
gleich(kreditorMail({ richtung: 'Ausgang', daten, kreditorAktion: { art: 'zurueckweisung' } }), null, 'Ausgang');
gleich(kreditorMail({ richtung: 'Eingang', daten, kreditorAktion: { art: 'berichtigung' } }), null, 'sonstige Rechnung');
gleich(kreditorMail({ richtung: 'Eingang', daten, kreditorAktion: null }), null, 'ohne Aktion');

// 6) /api/intake mit Prüfdienst-Attrappen: gelb -> Abweichung mit Mail, Ausgang ohne Mail, rot -> Zurückweisung
const SRC = path.join(API, 'src');
const handler = {};
const attrappe = (datei, exports) => {
  const f = require.resolve(datei);
  require.cache[f] = { id: f, filename: f, loaded: true, exports };
};
attrappe(require.resolve('@azure/functions', { paths: [path.join(SRC, 'functions')] }),
  { app: { http: (name, o) => { handler[name] = o.handler; } } });
let urteil;
attrappe(path.join(SRC, 'kosit.js'), { validateXml: async () => urteil, istMinimalprofil: () => false });
// PDF-Module laden pdf.js (Warnungen ohne canvas), für XML-Eingänge nicht nötig
attrappe(path.join(SRC, 'pdfabgleich.js'), { pdfXmlAbgleich: async () => ({ status: 'ok' }) });
attrappe(path.join(SRC, 'kopfdaten.js'), { kopfdatenAusPdf: async () => null });
const echt = require(path.join(SRC, 'converter.js'));
attrappe(path.join(SRC, 'converter.js'), { parseInvoiceData: echt.parseInvoiceData, convertXmlToPdf: async () => ({ pdf: new Uint8Array([37]) }) });
require(path.join(SRC, 'functions', 'intake.js'));

const ausgang = fs.readFileSync(path.join(API, 'test', 'sample-cii.xml'), 'utf8');
// Verkäufer und Käufer tauschen: Rechnung eines Lieferanten an WGC
const eingang = ausgang.replace(/Walzengiesserei Coswig GmbH/g, '#WGC#').replace(/Muster Maschinenbau GmbH/g, 'Walzengiesserei Coswig GmbH').replace(/#WGC#/g, 'Muster Maschinenbau GmbH');
const aufruf = async xml => (await handler.intake({
  method: 'POST', query: new URLSearchParams('werk=WGC'), arrayBuffer: async () => Buffer.from(xml),
}, { error() {}, log() {} })).jsonBody;

(async () => {
  urteil = { konform: 'gelb', konformLabel: 'Gelb - Warnungen', accepted: true, errorCount: 0, warningCount: 1,
    meldungen: [{ level: 'warning', text: '[BR-DE-21] Kennung der Spezifikation' }], hinweis: 'Nur Warnungen, die Rechnung ist gültig.' };
  let r = await aufruf(eingang);
  gleich([r.richtung, r.buchung, r.kreditorAktion && r.kreditorAktion.art], ['Eingang', 'unter_vorbehalt', 'abweichung'], 'gelb: Eingang, Vorbehalt, Abweichung');
  gleich(r.kreditorAktion.mail.betreff, 'Hinweis zu Ihrer E-Rechnung 4260999', 'gelb: Betreff mit Nummer');
  enthaelt(r.kreditorAktion.mail.text, '- [BR-DE-21] Kennung der Spezifikation', 'gelb: Warnung in der Mail');
  enthaelt(r.kreditorAktion.mail.text, 'Mit freundlichen Grüßen\nWalzengiesserei Coswig GmbH', 'gelb: Gruß mit Werk');

  r = await aufruf(ausgang);
  gleich([r.richtung, r.kreditorAktion && r.kreditorAktion.art, !!(r.kreditorAktion && r.kreditorAktion.mail)], ['Ausgang', 'abweichung', false], 'Ausgang: keine Mail');

  urteil = { konform: 'rot', konformLabel: 'Rot - Fehler', accepted: false, errorCount: 1, warningCount: 0,
    meldungen: [{ level: 'error', text: '[BR-CO-15] Summe' }], hinweis: 'Rechnerische Summen stimmen nicht zusammen.' };
  r = await aufruf(eingang);
  gleich([r.buchung, r.kreditorAktion.art, r.kreditorAktion.mail.art], ['zurueckgewiesen', 'zurueckweisung', 'Zurueckweisung'], 'rot: Zurückweisung');

  urteil = Object.assign({}, urteil, { konform: 'gruen', konformLabel: 'Gruen - KoSIT ok', accepted: true, errorCount: 0, meldungen: [] });
  r = await aufruf(eingang);
  gleich(r.kreditorAktion, null, 'grün: keine Aktion');

  console.log(`kreditormail: ${n} Prüfungen grün`);
})().catch(e => { console.error(e); process.exit(1); });

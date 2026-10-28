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

// Empfänger in der Rechnung absichtlich falsch: Kopf und Gruß kommen vom Werk des Postfachs
const daten = { nummer: '4711', datum: '2026-10-27', brutto: 1234.5, waehrung: 'EUR', empfaenger: 'INFIELD SAFETY GMBH * Nordstr. 10a' };

const aus64 = a => Buffer.from(a.base64, 'base64').toString('utf8');

// 1) Zurückweisung (rot): Vorlage wörtlich, nur die Rechnung im Text, Befunde im Anhang (eigener Bericht ohne KoSIT-HTML)
const rot = kreditorMail({
  richtung: 'Eingang', werk: 'WGC', daten, pruefwerkzeug: 'Mustang (ZUGFeRD-Profil)',
  kreditorAktion: { art: 'zurueckweisung', grund: 'pruefung-rot', text: 'x' },
  meldungen: [{ level: 'warning', text: '[BR-DE-21] Kennung' }, { level: 'error', text: '[BR-CO-15] Summe <falsch> & Co' }],
});
gleich(rot.art, 'Zurueckweisung', 'Art für KreditorMails');
gleich(rot.betreff, 'Zurückweisung Ihrer E-Rechnung 4711', 'Betreff');
for (const a of VORLAGEN.zurueckweisung.absaetze) { enthaelt(rot.text, a, 'Absatz wörtlich im Text'); enthaelt(rot.html, a, 'Absatz wörtlich im HTML'); }
enthaelt(rot.text, 'Sehr geehrte Damen und Herren,\n\nvielen Dank', 'Anrede');
enthaelt(rot.text, 'E-Rechnung zurückgewiesen\nRechnungsnummer: 4711\nRechnungsdatum: 27.10.2026\nBetrag: 1.234,50 EUR\nPrüfbericht: im Anhang (Pruefbericht_4711.html)', 'Angaben im Text');
gleich(/BR-CO-15|BR-DE-21/.test(rot.text + rot.html), false, 'keine Befunde in der Mail');
enthaelt(rot.text, 'Für Rückfragen stehen wir Ihnen gerne zur Verfügung.\n\nVielen Dank für Ihre Unterstützung.\n\nMit freundlichen Grüßen\nWalzengießerei Coswig GmbH', 'Schluss');
enthaelt(rot.html, 'Walzengießerei Coswig GmbH</div>', 'Firma im Kopf');
gleich(/INFIELD/.test(rot.text + rot.html), false, 'Empfänger aus der Rechnung nicht im Gruß');
gleich(/Mit freundlichen Grüßen\n/.test(kreditorMail({ richtung: 'Eingang', werk: 'XYZ', daten, kreditorAktion: { art: 'abweichung' } }).text), false, 'unbekanntes Werk ohne Namen');
enthaelt(rot.html, '#B42318', 'rote Akzentfarbe');
gleich([rot.anhang.name, rot.anhang.contentType], ['Pruefbericht_4711.html', 'text/html'], 'Anhang');
const bericht = aus64(rot.anhang);
enthaelt(bericht, '[BR-CO-15] Summe &lt;falsch&gt; &amp; Co', 'Befund maskiert im Bericht');
gleich(bericht.indexOf('BR-CO-15') < bericht.indexOf('BR-DE-21'), true, 'Fehler vor Warnungen');
enthaelt(bericht, 'Mustang (ZUGFeRD-Profil)', 'Prüfwerkzeug im Bericht');

// 1a) Rechnungsinhalt im eigenen Bericht: Elemente mit Position, Wert, Attributen, ohne Namensräume
const mitXml = aus64(kreditorMail({ richtung: 'Eingang', daten, kreditorAktion: { art: 'abweichung' },
  xml: '<rsm:CrossIndustryInvoice xmlns:rsm="urn:r" xmlns:ram="urn:a"><ram:ID>4711</ram:ID><ram:Total currencyID="EUR">5 &lt; 6</ram:Total></rsm:CrossIndustryInvoice>' }).anhang);
enthaelt(mitXml, 'Inhalt der Rechnung', 'Abschnitt Inhalt');
enthaelt(mitXml, '>0003</td>', 'Positionen gezählt');
enthaelt(mitXml, 'Total</span> <strong style="color:#1A2644;">5 &lt; 6</strong> <span style="font-size:12px;color:#6B7280;">currencyID: EUR</span>', 'Wert maskiert, Attribut');
gleich(/xmlns|urn:r/.test(mitXml), false, 'keine Namensräume');
gleich(aus64(kreditorMail({ richtung: 'Eingang', daten, kreditorAktion: { art: 'abweichung' }, xml: 'kein XML' }).anhang).includes('Inhalt der Rechnung'), false, 'ohne Element kein Abschnitt');

// 2) Auch bei KoSIT der eigene Bericht (gleiches Layout wie bei Mustang), KoSIT-HTML bleibt draußen
const kosit = aus64(kreditorMail({ richtung: 'Eingang', daten, kreditorAktion: { art: 'abweichung' }, pruefwerkzeug: 'KoSIT (XRechnung/EN16931)',
  meldungen: [{ level: 'warning', text: '[BR-DE-21] K' }],
  berichtHtml: '<html xmlns="http://www.w3.org/1999/xhtml"><head><title>Prüfbericht</title></head><body>KOSIT-ORIGINAL</body></html>' }).anhang);
gleich(kosit.includes('KOSIT-ORIGINAL'), false, 'nicht der KoSIT-Bericht');
enthaelt(kosit, 'KoSIT (XRechnung/EN16931)', 'Prüfwerkzeug KoSIT im eigenen Bericht');
enthaelt(kosit, '[BR-DE-21] K', 'KoSIT-Befund im eigenen Bericht');

// 3) MINIMUM/BASIC-WL: Profiltext als erster Befund im Bericht, Dateiname aus der Nummer
const minimal = kreditorMail({
  richtung: 'Eingang', daten: { nummer: 'A/1 2' },
  kreditorAktion: { art: 'zurueckweisung', grund: 'MINIMUM/BASIC-WL', text: 'Profil' },
  zurueckweisung: { grund: 'MINIMUM/BASIC-WL', text: 'Profil MINIMUM ist keine E-Rechnung.' },
  meldungen: [{ level: 'error', text: '[X] egal' }],
});
gleich(minimal.anhang.name, 'Pruefbericht_A-1-2.html', 'Dateiname ohne Sonderzeichen');
const mb = aus64(minimal.anhang);
gleich(mb.indexOf('Profil MINIMUM') > 0 && mb.indexOf('Profil MINIMUM') < mb.indexOf('[X] egal'), true, 'Profiltext zuerst');

// 4) Ohne Daten und Befunde: Hinweis ohne interne Zusätze, Betreff und Gruß ohne Lücken
const ohne = kreditorMail({
  richtung: '', daten: null, kreditorAktion: { art: 'zurueckweisung' }, meldungen: [],
  hinweis: 'Rechnerische Summen stimmen nicht. | Reverse-Charge (§13b UStG) manuelle Pruefung',
});
gleich(ohne.betreff, 'Zurückweisung Ihrer E-Rechnung', 'Betreff ohne Nummer');
gleich(ohne.anhang.name, 'Pruefbericht_E-Rechnung.html', 'Dateiname ohne Nummer');
enthaelt(aus64(ohne.anhang), 'Rechnerische Summen stimmen nicht.</td>', 'Hinweis als Befund');
gleich(aus64(ohne.anhang).includes('Reverse-Charge'), false, 'ohne internen Zusatz');
gleich(/Mit freundlichen Grüßen\n/.test(ohne.text), false, 'kein leerer Name nach dem Gruß');
gleich(ohne.html.includes('<strong'), false, 'HTML-Gruß ohne Firma');

// 5a) Abweichung (gelb): eigene Vorlage, orange
const gelb = kreditorMail({ richtung: 'Eingang', daten, kreditorAktion: { art: 'abweichung' }, meldungen: [{ level: 'warning', text: '[BR-DE-1] W' }] });
gleich([gelb.art, gelb.betreff], ['Abweichung', 'Hinweis zu Ihrer E-Rechnung 4711'], 'Art und Betreff Abweichung');
for (const a of VORLAGEN.abweichung.absaetze) enthaelt(gelb.text, a, 'Absatz wörtlich');
gleich(gelb.text.includes('Für Rückfragen'), false, 'Abweichung ohne Rückfragen-Satz');
enthaelt(gelb.text, 'möglichst zu vermeiden.\n\nGeringfügige Abweichungen, die Rechnung wird verarbeitet\nRechnungsnummer: 4711', 'Angaben nach der Vorlage');
enthaelt(gelb.html, '#F08300', 'orange Akzentfarbe');

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
  enthaelt(Buffer.from(r.kreditorAktion.mail.anhang.base64, 'base64').toString('utf8'), '[BR-DE-21] Kennung der Spezifikation', 'gelb: Warnung im Prüfbericht');
  enthaelt(r.kreditorAktion.mail.text, 'Mit freundlichen Grüßen\nWalzengießerei Coswig GmbH', 'gelb: Gruß mit Werk aus ?werk=');

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

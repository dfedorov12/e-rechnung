// node tests/umsatzgrenze.test.js
const assert = require('assert');
const ug = require('../js/umsatzgrenze.js');

let n = 0;
const ok = (c, m) => { assert.ok(c, m); n++; };

// Phase nach Rechnungsjahr
ok(ug.ugPhase('2026-12-31') === 'uebergang', '2026 = Uebergang');
ok(ug.ugPhase('2027-01-01') === 'grenze', '2027 = Grenze');
ok(ug.ugPhase('2027-12-31T10:00:00Z') === 'grenze', '2027 mit Uhrzeit');
ok(ug.ugPhase('2028-01-01') === 'pflicht', '2028 = Pflicht');
ok(ug.ugPhase('', '2027-05-01') === 'grenze', 'ohne Datum zaehlt heute');

// Sonstige Rechnung / Kleinbetrag
const pdf = { richtung: 'Eingang', formatmangel: true, brutto: null, datum: '2027-03-01' };
ok(ug.ugSonstige(pdf), 'Formatmangel im Eingang = sonstige Rechnung');
ok(!ug.ugSonstige({ richtung: 'Ausgang', formatmangel: true }), 'Ausgang nie');
ok(!ug.ugSonstige({ richtung: 'Eingang', formatmangel: false }), 'E-Rechnung nicht');
ok(ug.ugBraucht(pdf), 'ohne Betrag braucht Einschaetzung');
ok(!ug.ugBraucht(Object.assign({}, pdf, { brutto: 249.99 })), 'Kleinbetrag braucht keine');
ok(ug.ugBraucht(Object.assign({}, pdf, { brutto: 250.01 })), 'ueber 250 braucht eine');

// Folgen
ok(!ug.ugFolge('ueber', 'grenze').zulaessig, '2027 ueber 800k nicht zulaessig');
ok(ug.ugFolge('ueber', 'grenze').vorlage === 'ueber-anfordern', '2027 ueber -> anfordern');
ok(ug.ugFolge('bis', 'grenze').zulaessig, '2027 bis 800k zulaessig');
ok(ug.ugFolge('ueber', 'uebergang').vorlage === 'ueber-ankuendigen', '2026 ueber -> ankuendigen');
ok(ug.ugFolge('bis', 'uebergang').vorlage === 'bis-hinweis', '2026 bis -> Hinweis 2028');
ok(ug.ugFolge('bis', 'pflicht').vorlage === 'pflicht', '2028 immer Pflicht');

// Schluessel
ok(ug.ugKey('  Müller GmbH & Co. KG ') === 'müller gmbh co kg', 'Name normalisiert');
ok(ug.ugKey('MÜLLER GmbH & Co.KG') === 'müller gmbh co kg', 'gleiche Firma, gleicher Schluessel');
ok(ug.ugRechnungKey({ richtung: 'Eingang', baseKey: 'Scan_123' }) === 'e|scan_123', 'Rechnungsschluessel ohne Werk');

// Vorlagen
for (const art of ['ueber-anfordern', 'ueber-ankuendigen', 'bis-hinweis', 'pflicht']) {
  const v = ug.ugVorlage(art, { nummer: 'R-77', datum: '03.02.2027', jahr: 2027, absender: 'Denis Fedorov' });
  ok(v.betreff.length > 10, art + ': Betreff');
  ok(v.text.startsWith('Sehr geehrte Damen und Herren,'), art + ': Anrede');
  ok(v.text.endsWith('Mit freundlichen Grüßen\nDenis Fedorov'), art + ': Gruss mit Absender');
  ok(![8211, 8212].some(c => (v.betreff + v.text).includes(String.fromCharCode(c))), art + ': keine Gedankenstriche');
  ok(![...v.text].some(c => c.charCodeAt(0) < 32 && c.charCodeAt(0) !== 10), art + ': keine Steuerzeichen');
  ok(/XRechnung/.test(v.text), art + ': nennt die Formate');
}
ok(/R-77 vom 03\.02\.2027/.test(ug.ugVorlage('ueber-anfordern', { nummer: 'R-77', datum: '03.02.2027', jahr: 2027 }).text), 'Nr und Datum im Text');
ok(/Gesamtumsatz 2026/.test(ug.ugVorlage('ueber-anfordern', { jahr: 2027 }).text), 'Vorjahr aus Rechnungsjahr');
ok(!/ vom /.test(ug.ugVorlage('pflicht', {}).betreff), 'ohne Datum kein "vom"');

console.log(`umsatzgrenze: ${n} Pruefungen gruen`);

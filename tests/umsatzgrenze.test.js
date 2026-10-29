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

// ZUGFeRD mit PDF/A-Mangel bringt die XML mit: keine 800k-Einschätzung
ok(!ug.ugSonstige(Object.assign({}, pdf, { format: 'ZUGFeRD', ext: 'pdf' })), 'ZUGFeRD mit Formatmangel ist keine sonstige Rechnung');
ok(!ug.ugSonstige(Object.assign({}, pdf, { ext: 'pdf', dateien: [{ label: 'XML' }] })), 'PDF mit XML daneben auch nicht');
ok(ug.ugSonstige(Object.assign({}, pdf, { format: 'PDF', ext: 'pdf', dateien: [{ label: 'Lesbares PDF' }] })), 'PDF ohne E-Rechnung bleibt');
ok(!ug.ugBraucht(Object.assign({}, pdf, { format: 'ZUGFeRD', brutto: 5000 })), 'ZUGFeRD braucht keine Einschätzung');

// Folgen
ok(!ug.ugFolge('ueber', 'grenze').zulaessig, '2027 ueber 800k nicht zulaessig');
ok(ug.ugFolge('ueber', 'grenze').vorlage === 'ueber-ruecksendung', '2027 ueber -> Variante 1 Ruecksendung');
ok(ug.ugFolge('bis', 'grenze').vorlage === 'bis-akzeptanz', '2027 bis -> Variante 2 Akzeptanz');
ok(ug.ugFolge('bis', 'grenze').zulaessig, '2027 bis 800k zulaessig');
ok(ug.ugFolge('ueber', 'uebergang').vorlage === 'ueber-ankuendigen', '2026 ueber -> ankuendigen');
ok(ug.ugFolge('bis', 'uebergang').vorlage === 'bis-hinweis', '2026 bis -> Hinweis 2028');
ok(ug.ugFolge('bis', 'pflicht').vorlage === 'pflicht', '2028 immer Pflicht');

// Schluessel
ok(ug.ugKey('  Müller GmbH & Co. KG ') === 'müller gmbh co kg', 'Name normalisiert');
ok(ug.ugKey('MÜLLER GmbH & Co.KG') === 'müller gmbh co kg', 'gleiche Firma, gleicher Schluessel');
ok(ug.ugRechnungKey({ richtung: 'Eingang', baseKey: 'Scan_123' }) === 'e|scan_123', 'Rechnungsschluessel ohne Werk');

// Vorlagen
for (const art of ['ueber-ruecksendung', 'bis-akzeptanz', 'ueber-ankuendigen', 'bis-hinweis', 'pflicht']) {
  const v = ug.ugVorlage(art, { nummer: 'R-77', datum: '03.02.2027', jahr: 2027, absender: 'Denis Fedorov' });
  ok(v.betreff.length > 10, art + ': Betreff');
  ok(v.text.startsWith('Sehr geehrte Damen und Herren,'), art + ': Anrede');
  ok(v.text.endsWith('Mit freundlichen Grüßen\nDenis Fedorov'), art + ': Gruss mit Absender');
  ok(![8211, 8212].some(c => (v.betreff + v.text).includes(String.fromCharCode(c))), art + ': keine Gedankenstriche');
  ok(![...v.text].some(c => c.charCodeAt(0) < 32 && c.charCodeAt(0) !== 10), art + ': keine Steuerzeichen');
  ok(/XRechnung/.test(v.text), art + ': nennt die Formate');
}
ok(/R-77 vom 03\.02\.2027/.test(ug.ugVorlage('ueber-ruecksendung', { nummer: 'R-77', datum: '03.02.2027', jahr: 2027 }).betreff), 'Nr und Datum im Betreff');
ok(ug.ugVorlage('ueber-ruecksendung', {}).text.includes('Das vorliegende PDF-Dokument können wir aus diesem Grund leider nicht als Eingangsrechnung akzeptieren.'), 'Variante 1 wörtlich');
ok(ug.ugVorlage('bis-akzeptanz', {}).text.includes('Entsprechend werden wir Ihre Rechnung weiterverarbeiten.'), 'Variante 2 wörtlich');
ok(!/ vom /.test(ug.ugVorlage('pflicht', {}).betreff), 'ohne Datum kein "vom"');

// Mailauftrag
ok(ug.ugMailOk('rechnung@lieferant.de'), 'Mailadresse gueltig');
ok(ug.ugMailOk('  a.b-c@sub.firma.co.uk '), 'Mailadresse mit Leerraum');
ok(!ug.ugMailOk('rechnung@lieferant'), 'ohne Domainendung ungueltig');
ok(!ug.ugMailOk('a@b.de; c@d.de'), 'nur eine Adresse');
ok(!ug.ugMailOk(''), 'leer ungueltig');
const NL = String.fromCharCode(10);
ok(ug.ugMailHtml('Hallo <Welt> & Co' + NL + 'Zeile 2' + NL + NL + 'Absatz 2') === '<p>Hallo &lt;Welt&gt; &amp; Co<br>Zeile 2</p><p>Absatz 2</p>', 'HTML maskiert, Absaetze');
for (const art of ['ueber-ruecksendung', 'bis-akzeptanz', 'ueber-ankuendigen', 'bis-hinweis', 'pflicht']) {
  ok(ug.UG_MAIL_ART[art] && ug.UG_MAIL_ART[art].length < 40, art + ': Art fuer die Liste');
}

// Lieferant informiert: Ja/Nein an der Rechnung, Automatik bei schon eingeschaetztem Lieferanten
{
  const d = ug._ug.daten;
  d.lieferanten = { 'muster werkzeuge': { name: 'Muster Werkzeuge GmbH', vermutung: 'bis', vat: 'DE123456789' } };
  d.rechnungen = {};
  ug._ug.mails = {};
  const pdf = (nr, extra) => Object.assign({ richtung: 'Eingang', formatmangel: true, brutto: 900, baseKey: nr, steller: '' }, extra);
  const a = pdf('RE-1'), b = pdf('RE-2', { ustid: 'DE123456789' }), c = pdf('RE-3'), klein = pdf('RE-4', { brutto: 120 });
  ok(ug.ugInformiert(a) === '', 'nicht eingeschaetzt = offen');
  ok(ug.ugInformiert(b) === 'Automatik', 'Lieferant ueber USt-IdNr. schon eingeschaetzt');
  d.rechnungen[ug.ugRechnungKey(a)] = { lieferant: 'muster werkzeuge', informiert: 'Nein' };
  ok(ug.ugInformiert(a) === 'Nein', 'eingeschaetzt, nicht informiert');
  d.rechnungen[ug.ugRechnungKey(a)].informiert = 'Ja';
  ok(ug.ugInformiert(a) === 'Ja', 'eingeschaetzt und informiert');
  d.rechnungen[ug.ugRechnungKey(c)] = { lieferant: 'muster werkzeuge' };
  ok(ug.ugInformiert(c) === '', 'alte Einschaetzung ohne Angabe');
  ug._ug.mails[ug.ugRechnungKey(c)] = [{ status: 'Gesendet' }];
  ok(ug.ugInformiert(c) === 'Ja', 'Mail ueber den Flow = Ja');
  ug._ug.mails[ug.ugRechnungKey(c)] = [{ status: 'Fehler' }];
  ok(ug.ugInformiert(c) === '', 'fehlgeschlagene Mail zaehlt nicht');
  ok(ug.ugInformiert(klein) === '', 'Kleinbetrag braucht keine Info');
  ok(ug.ugInformiert(pdf('RE-5', { formatmangel: false })) === '', 'E-Rechnung braucht keine Info');
  const xml = pdf('RE-6', { formatmangel: false });
  ug._ug.mails[ug.ugRechnungKey(xml)] = [{ status: 'Gesendet', art: 'Abweichung' }];
  ok(ug.ugInformiert(xml) === 'Ja', 'E-Rechnung mit Hinweis-Mail aus dem Eingangs-Flow = Ja');
  ug._ug.mails[ug.ugRechnungKey(xml)] = [{ status: 'Fehler', art: 'Zurueckweisung' }];
  ok(ug.ugInformiert(xml) === '', 'E-Rechnung, Mail fehlgeschlagen');
}

// Lieferantenregister: Zuordnung an der Rechnung, USt-IdNr., Name, Schreibweise aus dem PDF
{
  const d = ug._ug.daten;
  d.lieferanten = {
    'muster werkzeuge gmbh': { name: 'Muster Werkzeuge GmbH', vat: 'DE123456789', aliase: ['Muster Werkzeug GmbH Frankfurt'] },
    'beispiel ag': { name: 'Beispiel AG', vat: '', vermutung: 'ueber' },
  };
  d.rechnungen = { 'e|scan_9': { lieferant: 'beispiel ag' } };
  const r = (extra) => Object.assign({ richtung: 'Eingang', baseKey: 'x' + Math.random(), steller: '', ustid: '' }, extra);
  ok(ug.ugLieferantFuer(r({ baseKey: 'Scan_9', ustid: 'DE123456789' })).treffer === 'rechnung', 'an der Rechnung bestätigt geht vor');
  ok(ug.ugLieferantFuer(r({ ustid: 'DE123456789' })).key === 'muster werkzeuge gmbh', 'über die USt-IdNr.');
  ok(ug.ugLieferantFuer(r({ steller: 'Muster Werkzeug GmbH, Frankfurt' })).treffer === 'alias', 'Schreibweise aus dem PDF gemerkt');
  ok(!ug.ugLieferantFuer(r({ steller: 'Muster Werkzeug GmbH Frankfurt', ustid: 'DE999999999' })), 'andere USt-IdNr.: kein Treffer');
  ok(ug.ugLieferantFuer(r({ steller: 'BEISPIEL AG' })).treffer === 'name', 'gleicher Name');
  ok(!ug.ugFuer(r({ ustid: 'DE123456789' })), 'bestätigt, aber nicht eingeschätzt: keine Einschätzung');
  ok(ug.ugFuer(r({ steller: 'Beispiel AG' })).vermutung === 'ueber', 'eingeschätzt');
  ok(ug.ugLieferantName(r({ baseKey: 'Scan_9', steller: 'Beisp1el A6' })) === 'Beispiel AG', 'bestätigter Name vor dem PDF-Text');
  ok(ug.ugLieferantName(r({ steller: 'Neu GmbH', ext: 'xml' })) === 'Neu GmbH', 'Name aus der XML');

  const user = { username: 'kb@dihag.com', name: 'Kreditoren Buchhaltung' };
  const e = ug.ugLieferantMerken({ name: 'Beispiel AG', vermutung: 'ueber', mail: 'r@beispiel.de' }, 'Beispiel AG',
    { steller: 'Beisp1el A6', ustid: 'DE555555555' }, user, '2026-10-29T10:00:00Z', { bestaetigen: true });
  ok(e.vermutung === 'ueber' && e.mail === 'r@beispiel.de', 'Einschätzung und Mail bleiben');
  ok(e.vat === 'DE555555555' && e.aliase[0] === 'Beisp1el A6', 'USt-IdNr. und Schreibweise gemerkt');
  ok(e.bestaetigtVonName === 'Kreditoren Buchhaltung' && e.bestaetigtAm === '2026-10-29T10:00:00Z', 'wer und wann');
  ok(!ug.ugLieferantMerken(e, 'Beispiel AG', { steller: 'beispiel ag' }, user, '').aliase.includes('beispiel ag'), 'gleicher Name ist kein Alias');
  const ohne = ug.ugLieferantMerken(null, 'Neu GmbH', { steller: '' }, user, '2026-10-29T11:00:00Z');
  ok(!ohne.bestaetigtAm, 'Merken ohne Bestätigen setzt kein Siegel');
  ok(ug.ugLieferantMerken(e, 'Beispiel AG', { steller: '' }, { username: 'x' }, '2026-10-30T09:00:00Z').bestaetigtAm === '2026-10-29T10:00:00Z', 'Siegel bleibt beim Merken');
  ok(ug.ugLieferantMerken(null, 'Neu GmbH', { steller: '' }, user, '', { vat: 'DE777777777' }).vat === 'DE777777777', 'USt-IdNr. aus dem Dialog');
}

// Mailadresse des Lieferanten wird beim Speichern gemerkt
(async () => {
  const bodies = [];
  global.SP = { graphBase: 'https://graph.test', scopes: [] };
  global.acquireToken = async () => 'token';
  global.getAuthUser = () => ({ username: 'test@dihag.com', name: 'Test' });
  global.fetch = async (url, opt) => { bodies.push(JSON.parse(Buffer.from(opt.body).toString('utf8')));
    return { ok: true, json: async () => ({ id: 'item1', eTag: 'e1' }) }; };
  ug._ug.siteId = 'site'; ug._ug.itemId = 'item1'; ug._ug.eTag = 'e0';
  ug._ug.daten = { version: 1, lieferanten: {}, rechnungen: {} };
  const r = { nummer: 'RE-9', werk: 'WGC', datum: '2026-10-01', steller: 'Muster Werkzeuge GmbH', ustid: '' };
  let e = await ug.ugSpeichern(r, 'Muster Werkzeuge GmbH', 'ja', '', 'RE-9', 'Ja', ' rechnung@muster-werkzeuge.de ');
  ok(e.mail === 'rechnung@muster-werkzeuge.de', 'Mail aus An gespeichert');
  ok(bodies[0].lieferanten[ug.ugKey('Muster Werkzeuge GmbH')].mail === 'rechnung@muster-werkzeuge.de', 'Mail in der Datei');
  e = await ug.ugSpeichern(r, 'Muster Werkzeuge GmbH', 'nein', '', 'RE-10', 'Nein', '');
  ok(e.mail === 'rechnung@muster-werkzeuge.de', 'leeres An behält die gemerkte Mail');
  e = await ug.ugSpeichern(r, 'Muster Werkzeuge GmbH', 'nein', '', 'RE-11', 'Nein', 'kaputt');
  ok(e.mail === 'rechnung@muster-werkzeuge.de', 'ungültiges An behält die gemerkte Mail');
  e = await ug.ugSpeichern(r, 'Muster Werkzeuge GmbH', 'nein', '', 'RE-12', 'Nein', 'buchhaltung@muster-werkzeuge.de');
  ok(e.mail === 'buchhaltung@muster-werkzeuge.de', 'neue Mail ersetzt die alte');
  ok(e.verlauf.length === 3, 'Verlauf der Einschätzung bleibt');
  ok(!e.bestaetigtAm, 'Einschätzung allein ist keine Bestätigung');
  // Bestätigen unter „Bearbeiten“: Einschätzung, Mail und „informiert“ bleiben, die Schreibweise kommt dazu
  const scan = { nummer: 'RE-13', werk: 'WGC', richtung: 'Eingang', baseKey: 'Scan_13', steller: 'Muster Werkzeuge GmbII', ustid: '' };
  ug._ug.daten.rechnungen[ug.ugRechnungKey(scan)] = { informiert: 'Ja' };
  e = await ug.ugBestaetigen(scan, 'Muster Werkzeuge GmbH');
  ok(e.vermutung === 'nein' && e.mail === 'buchhaltung@muster-werkzeuge.de' && e.verlauf.length === 3, 'Bestätigen ändert die Einschätzung nicht');
  ok(e.aliase.includes('Muster Werkzeuge GmbII'), 'Schreibweise aus dem PDF gemerkt');
  const zu = bodies[bodies.length - 1].rechnungen[ug.ugRechnungKey(scan)];
  ok(zu.lieferant === ug.ugKey('Muster Werkzeuge GmbH') && zu.informiert === 'Ja', 'Rechnung zugeordnet, informiert bleibt');
  ok(e.bestaetigtVon === 'test@dihag.com', 'Bestätigen setzt das Siegel');
  e = await ug.ugSpeichern(scan, 'Muster Werkzeuge GmbH', 'bis', '', 'RE-13', 'Nein', '');
  ok(e.aliase.includes('Muster Werkzeuge GmbII') && e.bestaetigtVon === 'test@dihag.com', 'Einschätzung behält die Schreibweisen');
  let fehler = '';
  try { await ug.ugBestaetigen(scan, '  '); } catch (x) { fehler = x.message; }
  ok(/Lieferanten angeben/.test(fehler), 'ohne Namen kein Eintrag');
  // Ordner Monitoring für das Konto nicht sichtbar: Laden meldet es, Schreiben nennt die Rechte
  global.fetch = async () => ({ ok: false, status: 404, text: async () => 'itemNotFound' });
  await ug.ugLaden('site', 'token');
  ok(/kein Zugriff/.test(ug._ug.fehler), 'kein Zugriff auf den Ordner erkannt');
  fehler = '';
  try { await ug.ugBestaetigen(scan, 'Muster Werkzeuge GmbH'); } catch (x) { fehler = x.message; }
  ok(/Schreibrechte/.test(fehler), '404 beim Schreiben = Rechte fehlen');
  // Absender der Rechnungsmail nur, wenn er von außen kommt
global.istEigeneMail = require('../js/lieferant.js').istEigeneMail;
ok(ug._ugAbsenderOk('rechnung@lieferant.de'), 'Lieferant als Absender');
ok(!ug._ugAbsenderOk('scanner@dihag.com'), 'Scanner im Haus nicht');
ok(!ug._ugAbsenderOk('erika.muster@dihag-zaigler.com'), 'weitergeleitet von Kollegin nicht');
ok(!ug._ugAbsenderOk('noreply@lieferant.de'), 'noreply nicht');
ok(!ug._ugAbsenderOk('tuev-sued_noreply@edoc-online.com'), 'noreply mitten in der Adresse nicht');
ok(!ug._ugAbsenderOk('rechnung.do-not-reply@lieferant.de'), 'do-not-reply nicht');
ok(ug._ugAbsenderOk('replyteam@lieferant.de'), 'reply allein ist in Ordnung');
ok(!ug._ugAbsenderOk(''), 'leer nicht');
ok(ug._ugAbsenderWahl('noreply@lieferant.de;buchhaltung@lieferant.de') === 'buchhaltung@lieferant.de', 'Reply-To mit mehreren Adressen');
ok(ug._ugAbsenderWahl('scanner@dihag.com') === '', 'nur interne Adresse: keine');
delete global.istEigeneMail;

console.log(`umsatzgrenze: ${n} Pruefungen gruen`);
})().catch(err => { console.error(err); process.exit(1); });

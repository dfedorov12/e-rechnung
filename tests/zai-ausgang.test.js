// node tests/zai-ausgang.test.js
// Ausgangsrechnung ZAI (ALF): erfundener Text im Layout, das pdf.js aus dem PDF liefert.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ctx = { console, window: {}, Math, Date, JSON, RegExp, String, Number, Array, Object, Set, Map, parseFloat, parseInt, isNaN };
vm.createContext(ctx);
vm.runInContext(fs.readFileSync(path.join(__dirname, '../js/parser.js'), 'utf8')
  + '\nthis.meta = extractMetadataZai; this.pos = extractLineItemsZai; this.fenster = _parseBuyerWindow;', ctx);

let n = 0;
const gleich = (ist, soll, m) => { assert.deepStrictEqual(ist, soll, m + ': ' + JSON.stringify(ist)); n++; };
const NL = String.fromCharCode(10);
const kopf = seite => [
  ...(seite > 1 ? ['Seite: ' + seite] : []),
  'Rechnung', 'Beispielguss Muster GmbH', '(Original)', 'Am Werk 7', '12345 Musterstadt Kunden-Nr.: 900001',
  'SAP-Nr.: 1009999', 'Beleg-Nr.: 2026.009001', 'Beleg-Datum: 22.10.2026', 'Lieferanten-Nr.: 7700123',
  'Ihre Ust.ID: DE999999999', 'Ansprechpartner: Muster Erika', 'Telefon: +49 9221 944-0',
  'E-Mail: erika.muster@dihag-zaigler.com',
];
const fuss = [
  'Nettobetrag MwSt. MwSt. -Betrag Rechnungsbetrag',
  '982,63 19,00 % 186,69 1.169,32',
  'Zahlungsbedingung: "Zahlbar ohne Abzug bis zum 05.11.2026!"',
  'Es gelten ausschließlich unsere allgemeinen Geschäftsbedingungen.',
  'Die AGB können auf unserer Homepage heruntergeladen werden.',
  'Leistungstag = Tag des Lieferscheins',
  'Lieferbedingung: FCA Kulmbach gem. Incoterms 2010',
  'Unsere Bankverbindung lautet:',
];

// 1) Rechnung über zwei Seiten, Bestellblock, Positionsdetails, leere Zwischensumme am Seitenende
const text = [
  ...kopf(1),
  'Pos. Bezeichnung Menge Einheit Einzelpreis EUR Gesamtpreis EUR',
  'Bestellung vom 08.07.2026', 'Best.Nr. 4500012345 Pos. 20', 'Komm. 11111A', 'Auftrags/Pos.-Nr. 2026.1000 / 1',
  '1 Gehäuse GH 100 10 Stück 50,00 500,00',
  'Zeichnung 4711-01', 'Guss-Nr.:', '101-1,102-1',
  'Lieferschein-Nr.: 2026.008001', 'Lieferdatum: 21.10.2026',
  'Nettobetrag MwSt. MwSt. -Betrag Rechnungsbetrag', '19,00 % 0,00',
  ...kopf(2),
  'Pos. Bezeichnung Menge Einheit Einzelpreis EUR Gesamtpreis EUR',
  'Best.Nr. 4500012345 Pos. 1+2',
  '2 Deckel DK 7 3 Stück 160,88 482,63',
  ...fuss,
].join(NL);

const m = ctx.meta(text);
gleich(m.rechnungsnummer, '2026.009001', 'Beleg-Nr.');
gleich(m.kundennummer, '900001', 'Kunden-Nr. (BT-46)');
gleich(m.lieferantennummer, '7700123', 'Lieferanten-Nr. beim Kunden (BT-29)');
gleich(m.bestellnummer, '4500012345', 'Bestellnummer (BT-13)');
gleich(m.steuerbetrag, 186.69, 'MwSt laut Original');
gleich(m.gesamtbetrag, 1169.32, 'Rechnungsbetrag');
gleich(/Zahlbar ohne Abzug bis zum 05\.11\.2026/.test(m.notiz), true, 'Zahlungsbedingung in der Notiz');
gleich(/Leistungstag = Tag des Lieferscheins/.test(m.notiz), true, 'Leistungstag in der Notiz');
gleich(/Lieferbedingung: FCA/.test(m.notiz), true, 'Lieferbedingung in der Notiz');
gleich(/Bankverbindung/.test(m.notiz), false, 'Bankverbindung nicht in der Notiz');
gleich(m.rechnungsart || '380', '380', 'normale Rechnung');

const p = ctx.pos(text);
gleich(p.length, 2, 'zwei Positionen, Seitenkopf und Zwischensumme übersprungen');
gleich([p[0].menge, p[0].einzelpreis], [10, 50], 'Menge und Preis Pos. 1');
gleich(p[0].bestellposition, '20', 'Bestellposition (BT-132)');
gleich(/Best\.Nr\. 4500012345/.test(p[0].positionsnotiz), true, 'Bestellblock im Positionshinweis');
gleich(/Lieferschein-Nr\.: 2026\.008001/.test(p[0].positionsnotiz), true, 'Lieferschein im Positionshinweis');
gleich(/Zeichnung 4711-01/.test(p[0].details), true, 'Zeichnung in der Positionsbeschreibung');
gleich(/101-1,102-1/.test(p[0].details), true, 'Guss-Nr. in der Positionsbeschreibung');
gleich(p[1].bestellposition, '1+2', 'Bestellposition mit Plus');
gleich(/Seite|Beleg-Nr|Nettobetrag/.test(p[0].details + p[1].details), false, 'kein Seitenkopf in den Details');
gleich(Math.round(p[1].menge * p[1].einzelpreis * 100) / 100, 482.63, 'Gesamtpreis Pos. 2 wie im Original');
gleich(p[0].einzelpreis, 50, 'gedruckter Preis, wenn er aufgeht');
gleich(p[1].einzelpreis, 160.877, 'sonst so wenige Stellen wie nötig');

// 2) Storno mit Bezug auf die ursprüngliche Rechnung
const storno = [...kopf(1).map(z => z === 'Rechnung' ? 'Storno-Rechnung' : z), 'zu Belegnr. 2026.008888',
  'Pos. Bezeichnung Menge Einheit Einzelpreis EUR Gesamtpreis EUR',
  '1 Gehäuse GH 100 10 Stück 50,00 500,00', ...fuss].join(NL);
const s = ctx.meta(storno);
gleich(s.rechnungsart, '381', 'Storno als Gutschrift (BT-3 381)');
gleich(s.vorrechnungsnummer, '2026.008888', 'Bezug auf Rechnung (BT-25)');

// 2b) Steuerhinweis auf der Folgeseite, Telefon des Ansprechpartners, Postfach in der Anschrift
const folgeseite = [...kopf(1).map(z => /^Telefon/.test(z) ? 'Telefon: +49 9221 944-222' : z),
  'Pos. Bezeichnung Menge Einheit Einzelpreis EUR Gesamtpreis EUR',
  '1 Gehäuse GH 100 1 Stück 500,00 500,00', ...fuss,
  'Seite: 2', ...kopf(2).slice(1),
  'Auf die Steuerschuldnerschaft des Leistungsempfängers gem. § 13b UStG (Reverse Charge-Verfahren) wird hingewiesen.',
  'Unsere Bankverbindung lautet:', 'Rechnungsempfänger: rechnung@beispielguss.example'].join(NL);
const f = ctx.meta(folgeseite);
gleich(/§ 13b UStG/.test(f.notiz), true, 'Steuerhinweis von Seite 2 im Hinweis');
gleich(f.verkaeuftel, '+49 9221 944-222', 'Durchwahl des Ansprechpartners');
gleich(ctx.meta(folgeseite.split(NL).filter(z => !/^Telefon/.test(z)).join(NL)).verkaeuftel, '+49 9221 944-0', 'ohne Telefonzeile die Zentrale');
const fe = ctx.fenster(['Beispiel Components SAS', '43, rue Exemple', 'CS 10106', '68000 Exempleville Cedex', 'FRANKREICH'].join(NL));
gleich([fe.kaeuferstrasse, fe.kaeuferzusatz, fe.kaeuferplz, fe.kaeuferland], ['43, rue Exemple', 'CS 10106', '68000', 'FR'], 'Postfach als Adresszusatz');
const fe2 = ctx.fenster(['Muster GmbH', 'Werkstraße 7', '12345 Musterstadt'].join(NL));
gleich([fe2.kaeuferstrasse, fe2.kaeuferzusatz], ['Werkstraße 7', undefined], 'normale Anschrift ohne Zusatz');

// 3) MwSt laut Original: das ERP rundet je Position, der Konverter über die Summe
const x = { console, window: {}, document: undefined, Math, JSON, String, Number, Object, parseFloat, isFinite };
vm.createContext(x);
vm.runInContext(fs.readFileSync(path.join(__dirname, '../js/xrechnung.js'), 'utf8') + NL + 'this.calcTotals = calcTotals;', x);
const pos = [{ menge: 10, einzelpreis: 50, mwst: 19 }, { menge: 3, einzelpreis: 482.63 / 3, mwst: 19 }];
const r2 = x.calcTotals(pos);
gleich(Math.round(r2.vatTotal * 100) / 100, 186.70, 'eigene Rechnung ohne Vorgabe');
const r3 = x.calcTotals(pos, '186.69');
gleich([r3.vatTotal, r3.steuerLautOriginal], [186.69, true], 'Vorgabe aus dem Original');
gleich(Math.round(r3.grossTotal * 100) / 100, 1169.32, 'Rechnungsbetrag wie im Original');
gleich(x.calcTotals(pos, '180.00').steuerLautOriginal, false, 'zu große Abweichung: eigene Rechnung');
gleich(x.calcTotals([...pos, { menge: 1, einzelpreis: 10, mwst: 7 }], '186.69').steuerLautOriginal, false, 'zwei Steuersätze: eigene Rechnung');
gleich(x.calcTotals(pos, '').steuerLautOriginal, false, 'leere Vorgabe');

console.log(`zai-ausgang: ${n} Prüfungen grün`);

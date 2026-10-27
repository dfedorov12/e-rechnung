// node tests/leg-ausgang.test.js
// Ausgangsrechnung LEG (Lintorfer Eisengießerei): gleiches SAP Adobe-Formular wie EWA.
// Erfundene Belege als Textstücke mit Position, durch den ganzen Parser.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ctx = { console: { log() {}, warn() {}, error() {} }, window: {}, Math, Date, JSON, RegExp, String, Number, Array, Object, Set, Map, parseFloat, parseInt, isNaN };
vm.createContext(ctx);
vm.runInContext(fs.readFileSync(path.join(__dirname, '../js/parser.js'), 'utf8')
  + '\nthis.parse = extractInvoiceDataFromItems; this.nurInland = werkNurInland; this.unterschrift = werkDrittlandUnterschrift;', ctx);

let n = 0;
const gleich = (ist, soll, m) => { assert.deepStrictEqual(ist, soll, m + ': ' + JSON.stringify(ist)); n++; };
const PW = 595, PH = 842;
const beleg = zeilen => {
  const items = [];
  let seite = 1;
  for (const z of zeilen) {
    if (z.seite) { seite = z.seite; continue; }
    const [y, ...zellen] = z;
    for (const [x, text] of zellen) items.push({ text, x: x * PW, y, pw: PW, ph: PH, w: text.length * 5, page: seite });
  }
  return ctx.parse(items);
};
const L = 0.052, R = 0.533, W = 0.714, LB = 0.100, VAL = 0.290;
// Absenderzeile wie bei LEG: das „|" hängt erst am zweiten Textstück
const ABSENDER = [721, [L, 'Lintorfer Eisengießerei GmbH'], [0.230, '| Rehhecke 83-87 | 40885 Ratingen']];
const FUSS = [
  [48, [L, 'Lintorfer Eisengießerei GmbH · Rehhecke 83 - 87 · 40885 Ratingen | www.lintorfereg.de · Tel +49 2102 3806 0 · Fax +49 2102 3806 30']],
  [36, [L, 'Mail info@lintorfereg.de | Handelsregister Amtsgericht Düsseldorf · HRB 42982 · Steuer-Nr. 147 / 5846 / 1173 · UST-IDNr. DE 811 154 479']],
  [24, [L, 'Geschäftsführung Dipl.Ing. Gunnar Jentsch · Viktor Babushchak']],
];
const kopf = (titel, nr, anschrift, extra = []) => [
  [741, [R, titel]], [725, [R, 'Nummer'], [W, nr]], ABSENDER, [710, [R, 'Datum'], [W, '07.08.2026']],
  ...anschrift,
  [695, [R, 'Kundenauftrag'], [W, '5237']], [650, [R, 'Kundennummer'], [W, '1099990']],
  [635, [R, 'Liefer/Leistungsdatum'], [W, '07.08.2026']], [589, [R, 'Sachbearbeiter Erika Muster']],
  ...extra,
  [578, [0.845, 'Währung'], [0.936, 'EUR']],
  [524, [L, 'Zahlungsbedingungen'], [0.267, 'Bis zum 07.08.2026 ohne Abzug']],
  [508, [L, 'Lieferbedingungen'], [0.267, 'FCA Ratingen']],
  [493, [L, 'Nettogewicht'], [0.267, '16,400 KG']],
];
const UKRAINE = [[705, [L, 'BEISPIEL STEEL CO. LTD']], [693, [L, 'Prospekt Muster, 1']], [682, [L, '49000 BEISPIELSTADT']], [670, [L, 'UKRAINE']]];
const POSITION = (preis) => [
  [440, [L, '1'], [LB, 'Material'], [VAL, '3009990 Kokille 3,6 t']],
  [425, [LB, 'Menge'], [VAL, '4 ST']],
  ...(preis ? [[410, [LB, 'Konditionen'], [VAL, 'Preis'], [0.601, '5,025.00 EUR'], [0.712, 'pro'], [0.776, '1 ST'], [0.897, '20,100.00']]] : []),
  [395, [LB, 'aus Gusseisen mit Kugelgraphit']],
  [380, [LB, 'Herkunftsland'], [VAL, 'DE']],
];

// 1) Anzahlungsanforderung: deutsche Beschriftung, englische Zahlen, Position ohne Preis
let r = beleg([
  ...kopf('Rechnung', '91099001', UKRAINE),
  [470, [L, '100% Anzahlung bei Auftragserteilung']],
  ...POSITION(false),
  [245, [L, 'Gesamtbetrag ohne Steuer'], [0.897, '0.00']],
  [230, [L, 'Umsatzsteuer 0.000 %'], [0.897, '0.00']],
  [215, [L, 'Endbetrag'], [0.897, '20,100.00']],
  ...FUSS,
]);
gleich([r.gesellschaft, r.rechnungsart, r.rechnungsnummer], ['LEG', '386', '91099001'], 'LEG erkannt, Anzahlung als 386');
gleich([r.kaeufer, r.kaeuferland, r.steuerkategorie], ['BEISPIEL STEEL CO. LTD', 'UA', 'G'], 'Empfänger statt Absender, Ukraine, Ausfuhr');
gleich([r.positionen.length, r.positionen[0].menge, r.positionen[0].einzelpreis, r.gesamtbetrag], [1, 4, 5025, 20100], 'Anzahlungsbetrag aus dem Endbetrag, englische Zahlen');
gleich(/100% Anzahlung bei Auftragserteilung/.test(r.notiz), true, 'Anzahlungshinweis im Hinweis');
gleich([r.verkaeufer, r.verkaeufervat, r.verkaeuferemail], ['Lintorfer Eisengießerei GmbH', 'DE811154479', 'info@lintorfereg.de'], 'Stammdaten LEG');

// 2) Schlussrechnung mit Block der erhaltenen Anzahlungen
r = beleg([
  ...kopf('Rechnung', '91099002', UKRAINE),
  [470, [L, 'Anzahlungen']],
  [458, [L, 'Nettobetrag'], [0.25, 'Steuerbetrag'], [0.4, 'Endbetrag'], [0.55, 'Haben-Betrag']],
  [446, [L, '20,100.00'], [0.25, '0.00'], [0.4, '20,100.00'], [0.55, '20,100.00']],
  ...POSITION(true),
  [245, [L, 'Gesamtbetrag ohne Steuer'], [0.897, '20,100.00']],
  [230, [L, 'Umsatzsteuer 0.000 %'], [0.897, '0.00']],
  [215, [L, 'Endbetrag'], [0.897, '20,100.00']],
  ...FUSS,
]);
gleich([r.rechnungsart, r.gezahlt, r.gesamtbetrag], ['380', 20100, 20100], 'Schlussrechnung: bereits gezahlt (BT-113)');
gleich(/Anzahlungen|Haben-Betrag/.test(r.notiz), false, 'Anzahlungsblock nicht im Hinweis');

// 3) Lastschrift Inland mit § 13b und Frachtzuschlag ohne „pro"
r = beleg([
  ...kopf('Lastschrift', '91099003', [[705, [L, 'Muster Recycling e. K.']], [693, [L, 'Werkstraße 5']], [682, [L, '59368 Musterstadt']]],
    [[620, [R, 'Ihre UST-ID'], [W, 'DE999999999']]]),
  [470, [L, 'Wir weisen auf Ihre Steuerschuldnerschaft gemäß § 13b Abs. 2 Nr. 7 UStG']],
  [440, [L, '10'], [LB, 'Material'], [VAL, '4300015 Schlackereste']],
  [425, [LB, 'Menge'], [VAL, '37.540 KG']],
  [410, [LB, 'Konditionen'], [VAL, 'Bruttowert'], [0.601, '25,00 EUR'], [0.712, 'pro'], [0.776, '1.000 KG'], [0.897, '938,50']],
  [395, [VAL, 'Nettowert 1'], [0.601, '25,00 EUR'], [0.712, 'pro'], [0.776, '1.000 KG'], [0.897, '938,50']],
  [380, [LB, 'Herkunftsland']],
  [245, [L, 'Gesamtbetrag ohne Steuer'], [0.897, '938,50']],
  [232, [L, 'Frachtzuschlag'], [0.897, '130,90']],
  [218, [L, 'Umsatzsteuer 0,000 %'], [0.897, '0,00']],
  [204, [L, 'Endbetrag'], [0.897, '1.069,40']],
  ...FUSS,
]);
gleich([r.rechnungsart, r.steuerkategorie, r.kaeuferland, r.kaeufervat], ['380', 'AE', 'DE', 'DE999999999'], 'Lastschrift als 380, Reverse Charge');
gleich(Array.from(r.positionen, p => [p.beschreibung, Math.round(p.menge * p.einzelpreis * 100) / 100]),
  [['4300015 Schlackereste', 938.5], ['Frachtzuschlag', 130.9]], 'Frachtzuschlag ohne Menge als Position');
gleich([r.positionen[0].menge, r.positionen[0].einheit, r.positionen[0].einzelpreis], [37540, 'kg', 0.025], 'Preis je 1.000 kg');
gleich(/Herkunftsland/.test(r.positionen[0].details), false, 'leeres Herkunftsland nicht in der Beschreibung');
gleich(/§ 13b/.test(r.notiz), true, '§-13b-Hinweis im Hinweis');

gleich([ctx.nurInland('LEG'), ctx.unterschrift('LEG')], [true, false], 'LEG wie EWA: nur Inland ohne Rückfrage, keine Unterschriftsregel');

console.log(`leg-ausgang: ${n} Prüfungen grün`);

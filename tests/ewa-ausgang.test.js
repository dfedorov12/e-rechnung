// node tests/ewa-ausgang.test.js
// Ausgangsrechnung EWA (Eisenwerk Arnstadt, SAP Adobe-Formular): erfundene Belege als
// Textstücke mit Position, wie pdf.js sie liefert. Läuft durch den ganzen Parser.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ctx = { console: { log() {}, warn() {}, error() {} }, window: {}, Math, Date, JSON, RegExp, String, Number, Array, Object, Set, Map, parseFloat, parseInt, isNaN };
vm.createContext(ctx);
vm.runInContext(fs.readFileSync(path.join(__dirname, '../js/parser.js'), 'utf8')
  + fs.readFileSync(path.join(__dirname, '../js/xrechnung.js'), 'utf8')
  + '\nthis.parse = extractInvoiceDataFromItems; this.skonto = _skontoZeile; this.buildXML = buildXML; this.nurInland = werkNurInland; this.versand = werkVersandPostfach;', ctx);

let n = 0;
const gleich = (ist, soll, m) => { assert.deepStrictEqual(ist, soll, m + ': ' + JSON.stringify(ist)); n++; };
const PW = 595, PH = 842;
// Zeile: [y, [x-Anteil, Text], …]; Seite über { seite: 2 }
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
const L = 0.052, R = 0.533, W = 0.714, POS = 0.052, LB = 0.100, VAL = 0.290;
const FUSS = [
  [48, [L, 'Eisenwerk Arnstadt GmbH · Bierweg 4 · 99310 Arnstadt | www.ewa-guss.de · Tel +49 3628 596 101 · Fax +49 3628 596 170']],
  [36, [L, 'Mail info@ewa-guss.de | Handelsregister Amtsgericht Jena · HRB 110887 · UST-IDNr. DE 812 737 567']],
  [24, [L, 'Geschäftsführung Viktor Babushchak']],
];

// 1) Deutsch, Inland: zwei Positionen mit Teuerungszuschlag, Skonto, Versandanschrift, Adresszusatz
let r = beleg([
  [760, [0.89, 'Seite 1 von 2']],
  [741, [R, 'Rechnung']],
  [725, [R, 'Nummer'], [W, '92099001']],
  [721, [L, 'Eisenwerk Arnstadt GmbH |'], [0.188, 'Bierweg 4 | 99310 Arnstadt']],
  [710, [R, 'Datum'], [W, '20.10.2026']],
  [705, [L, 'Muster-Armaturen']],
  [695, [R, 'Kundenauftrag'], [W, '5398']],
  [693, [L, 'Beispiel Muster GmbH & Co. KG']],
  [682, [L, 'c/o Zentraleinkauf']],
  [680, [R, 'Referenznummer'], [W, '4500012345']],
  [670, [L, 'Werkstraße 7']],
  [665, [R, 'Lieferungsnummer'], [W, '80099999']],
  [658, [L, '12345 Musterstadt']],
  [650, [R, 'Kundennummer'], [W, '1099999']],
  [640, [L, 'Versandanschrift']],
  [635, [R, 'Liefer/Leistungsdatum'], [W, '20.10.2026']],
  [626, [L, 'Muster-Armaturen Werk 2']],
  [620, [R, 'Ihre UST-ID'], [W, 'DE999999999']],
  [612, [L, 'Am Hafen 3']],
  [605, [R, 'Unsere UST-ID'], [W, 'DE812737567']],
  [599, [L, '54321 Beispielort']],
  [589, [R, 'Sachbearbeiter Erika Muster']],
  [578, [0.845, 'Währung'], [0.936, 'EUR']],
  [524, [L, 'Zahlungsbedingungen'], [0.267, 'Bis zum 03.11.2026 erhalten Sie 2,000 % Skonto']],
  [510, [0.267, 'Bis zum 19.11.2026 ohne Abzug']],
  [496, [L, 'Lieferbedingungen'], [0.267, 'FCA Arnstadt']],
  [481, [L, 'Nettogewicht'], [0.267, '18.607,05 KG']],
  [440, [POS, '10'], [LB, 'Material'], [VAL, '3009999 Gehäuse DN 50']],
  [425, [LB, 'Kundenmaterial'], [VAL, '101099999']],
  [410, [LB, 'Menge'], [VAL, '1.485 ST']],
  [395, [LB, 'Konditionen'], [VAL, 'Preis'], [0.601, '10,06 EUR'], [0.712, 'pro'], [0.776, '1 ST'], [0.897, '14.939,10']],
  [380, [VAL, 'Teuerungszuschlag'], [0.591, '460,00 EUR'], [0.712, 'pro'], [0.776, '1.000 KG'], [0.897, '8.559,24']],
  [365, [LB, 'EN-GJL-250/JL1040/5.1301']],
  [350, [LB, 'Herkunftsland'], [VAL, 'DE']],
  [335, [LB, 'Statistische Warennr.'], [VAL, '84839081']],
  [320, [POS, '20'], [LB, 'Material'], [VAL, '3009998 Deckel']],
  [305, [LB, 'Menge'], [VAL, '3 ST']],
  [290, [LB, 'Konditionen'], [VAL, 'Bruttowert'], [0.601, '22,07 EUR'], [0.712, 'pro'], [0.776, '3 ST'], [0.897, '22,07']],
  [275, [VAL, 'Nettowert 1'], [0.601, '22,07 EUR'], [0.712, 'pro'], [0.776, '3 ST'], [0.897, '22,07']],
  [260, [LB, 'zu Bestellung 4500012346']],
  [245, [L, 'Gesamtbetrag ohne Steuer'], [0.897, '23.520,41']],
  [230, [L, 'Verpackungszuschlag'], [0.300, '1,14'], [0.338, 'EUR'], [0.397, 'pro'], [0.462, '1 ST'], [0.897, '1.692,90']],
  [215, [L, 'Umsatzsteuer 19,00 %'], [0.897, '4.790,93']],
  [200, [L, 'Endbetrag'], [0.897, '30.004,24']],
  ...FUSS,
  { seite: 2 },
  [790, [L, 'Beleg 92099001']],
  [778, [L, 'Datum 20.10.2026'], [0.85, 'Seite 2 von 2']],
  [700, [L, 'Hinweis:']],
  [688, [L, 'Die Ware bleibt bis zur vollständigen Bezahlung im Eigentum der Eisenwerk Arnstadt GmbH.']],
  ...FUSS,
]);
gleich([r.gesellschaft, r.rechnungsart, r.rechnungsnummer, r.rechnungsdatum, r.waehrung], ['EWA', '380', '92099001', '2026-10-20', 'EUR'], 'Kopf');
gleich([r.kaeufer, r.kaeuferzusatz, r.kaeuferstrasse, r.kaeuferplz, r.kaeuferstadt, r.kaeuferland],
  ['Muster-Armaturen Beispiel Muster GmbH & Co. KG', 'c/o Zentraleinkauf', 'Werkstraße 7', '12345', 'Musterstadt', 'DE'], 'Anschrift mit Rechtsform in Zeile 2 und Zusatz');
gleich([r.lieferName, r.lieferStrasse, r.lieferPlz, r.lieferStadt], ['Muster-Armaturen Werk 2', 'Am Hafen 3', '54321', 'Beispielort'], 'Versandanschrift');
gleich([r.kundennummer, r.kaeufervat, r.bestellnummer, r.lieferscheinnummer, r.lieferdatum], ['1099999', 'DE999999999', '4500012345', '80099999', '2026-10-20'], 'Kopfwerte rechts');
gleich(r.verkaeufkontakt, 'Erika Muster', 'Sachbearbeiter in einem Textstück');
gleich([r.verkaeuferemail, r.verkaeuftel], ['invoicing@ewa-guss.de', '+49 3628 596 101'], 'Rechnungspostfach statt info@, ohne Durchwahl die Zentrale');
gleich(r.proforma, undefined, 'keine Proformarechnung');
gleich(r.faelligkeitsdatum, '2026-11-19', 'Fälligkeit = Datum ohne Abzug');
gleich([r.steuerkategorie, r.steuerbetrag, r.gesamtbetrag], ['S', 4790.93, 30004.24], 'Steuer');
gleich(r.positionen.length, 3, 'zwei Positionen und Verpackungszuschlag');
const ges = p => Math.round(p.menge * p.einzelpreis * 100) / 100;
gleich([ges(r.positionen[0]), ges(r.positionen[1]), ges(r.positionen[2])], [23498.34, 22.07, 1692.9], 'Positionswerte');
gleich(r.positionen[0].einzelpreis, 15.8238, 'Preis inkl. Teuerungszuschlag mit so wenigen Stellen wie nötig');
gleich(r.positionen[1].einzelpreis, 7.357, 'Preis je 3 Stück, Nettowert-Zeile zählt');
gleich(/Teuerungszuschlag 460,00 EUR pro 1\.000 KG = 8\.559,24/.test(r.positionen[0].details), true, 'Zuschlag in der Beschreibung');
gleich(/Warennr\. 84839081/.test(r.positionen[0].details) && /Kundenmaterial 101099999/.test(r.positionen[0].details), true, 'Warennr. und Kundenmaterial');
gleich(r.positionen[1].positionsnotiz, 'zu Bestellung 4500012346', 'Bestellbezug je Position');
gleich([r.positionen[2].beschreibung, r.positionen[2].menge], ['Verpackungszuschlag', 1485], 'Zuschlag auf Belegebene');
gleich(/^Zahlungsbedingung: Bis zum 03\.11\.2026 erhalten Sie 2,000 % Skonto; Bis zum 19\.11\.2026 ohne Abzug$/m.test(r.notiz), true, 'Zahlungsbedingung in einer Zeile');
gleich(/Unsere Auftragsnummer 5398/.test(r.notiz) && /Eigentum der Eisenwerk/.test(r.notiz) && !/Seite 2/.test(r.notiz), true, 'Hinweise ohne Seitenkopf');
gleich(ctx.skonto('Bis zum 03.11.2026 erhalten Sie 2,000 % Skonto; Bis zum 19.11.2026 ohne Abzug', '2026-10-20'), '#SKONTO#TAGE=14#PROZENT=2.00#', 'Skonto für XRechnung');
gleich(ctx.skonto('Bis zum 19.11.2026 ohne Abzug', '2026-10-20'), '', 'ohne Skonto keine Zeile');

// 2) Englisch, GBP, Ausfuhr: britischer Postcode, Mail im Anschriftfeld, englische Zahlen
r = beleg([
  [741, [R, 'Invoice']],
  [725, [R, 'Number'], [W, '92099002']],
  [721, [L, 'Eisenwerk Arnstadt GmbH |'], [0.188, 'Bierweg 4 | 99310 Arnstadt']],
  [710, [R, 'Date'], [W, '17.09.2026']],
  [705, [L, 'Sample Rail Ltd']],
  [695, [R, 'Order Number'], [W, '5223']],
  [693, [L, 'Unit 4, Example Park']],
  [681, [L, 'invoices@samplerail.example'], [R, 'Reference Number'], [W, '4500099999']],
  [668, [L, '1 Station Road']],
  [665, [R, 'Delivery Number'], [W, '80099998']],
  [655, [L, 'SAMPLETON']],
  [650, [R, 'Customer Number'], [W, '1099998']],
  [642, [L, 'AB1 2CD']],
  [635, [R, 'Delivery/Service date'], [W, '17.09.2026']],
  [628, [L, 'GROßBRITANNIEN']],
  [620, [R, 'Your tax Number'], [W, 'GB999999999']],
  [605, [R, 'Our tax Number'], [W, 'DE812737567']],
  [589, [R, 'Clerk'], [W, 'Erika Muster']],
  [578, [0.845, 'Currency'], [0.936, 'GBP']],
  [524, [L, 'Terms of payment'], [0.267, 'Up to 30.11.2026 without deduction']],
  [496, [L, 'Terms of delivery'], [0.267, 'FCA Arnstadt']],
  [440, [POS, '1'], [LB, 'Material'], [VAL, '3009997 Brake block']],
  [410, [LB, 'Quantity'], [VAL, '1,350 PC']],
  [395, [LB, 'Conditions'], [VAL, 'Price'], [0.601, '9.30 GBP'], [0.712, 'per'], [0.776, '1 PC'], [0.906, '12,555.00']],
  [380, [LB, 'Country of origin'], [VAL, 'DE']],
  [365, [LB, 'Commodity code'], [VAL, '86072110']],
  [245, [L, 'Total net value'], [0.897, '12,555.00']],
  [215, [L, 'Value added tax 0.000 %'], [0.897, '0.00']],
  [200, [L, 'Final amount'], [0.897, '12,555.00']],
  [185, [L, 'Tax free export']],
  [170, [L, 'Bank details:']],
  [158, [L, 'IBAN: DE38 8207 0000 0126 6444 02']],
  [146, [L, 'Account holder: Eisenwerk Arnstadt GmbH']],
  ...FUSS,
]);
gleich([r.rechnungsnummer, r.waehrung, r.steuerkategorie], ['92099002', 'GBP', 'G'], 'GBP, Ausfuhr');
gleich([r.kaeufer, r.kaeuferzusatz, r.kaeuferstrasse, r.kaeuferplz, r.kaeuferstadt, r.kaeuferland],
  ['Sample Rail Ltd', 'Unit 4, Example Park', '1 Station Road', 'AB1 2CD', 'SAMPLETON', 'GB'], 'britische Anschrift');
gleich(r.kaeufermail, 'invoices@samplerail.example', 'Rechnungsmail aus dem Anschriftfeld');
gleich([r.positionen[0].menge, r.positionen[0].einzelpreis], [1350, 9.3], 'englische Zahlen');
gleich([r.faelligkeitsdatum, r.gesamtbetrag], ['2026-11-30', 12555], 'Fälligkeit und Endbetrag');
gleich(r.iban, 'DE38820700000126644402', 'IBAN des GBP-Kontos aus dem Beleg');
gleich(/Bank details|Account holder/.test(r.notiz), false, 'Bankblock nicht im Hinweis');
const xml = ctx.buildXML({ ...r, kaeufermail: r.kaeufermail }, 'xrechnung');
gleich([/<ram:InvoiceCurrencyCode>GBP</.test(xml), /currencyID="GBP"/.test(xml), /<ram:LineTwo>Unit 4, Example Park</.test(xml)], [true, true, true], 'XML mit GBP und Adresszusatz');

// 3) Französisch, Leerzeichen als Tausendertrenner, innergemeinschaftlich
r = beleg([
  [741, [R, 'Facture']],
  [725, [R, 'Numéro'], [W, '92099003']],
  [721, [L, 'Eisenwerk Arnstadt GmbH |'], [0.188, 'Bierweg 4 | 99310 Arnstadt']],
  [710, [R, 'Date'], [W, '21.08.2026']],
  [705, [L, 'EXEMPLE SA']],
  [695, [R, 'notre no. de commande 5108']],
  [693, [L, 'TSA 12345']],
  [682, [L, '69000 LYON CEDEX 20']],
  [680, [R, 'votre no. de commande 02177-000099']],
  [670, [L, 'FRANKREICH']],
  [665, [R, 'Numéro de livraison'], [W, '80099997']],
  [650, [R, 'Numéro de client'], [W, '1099997']],
  [635, [R, 'Date de livraison/']],
  [629, [W, '21.08.2026']],
  [623, [R, 'prestation']],
  [608, [R, 'Votre numéro de TVA'], [W, 'FR99999999999']],
  [578, [0.845, 'Monnaie'], [0.936, 'EUR']],
  [524, [L, "Conditions de paiement"], [0.267, "Sans déduction jusqu'au 20.09.2026"]],
  [440, [POS, '30'], [LB, 'Matériel'], [VAL, '3009996 .0001']],
  [410, [LB, 'Quantité'], [VAL, '1 800 Pce']],
  [395, [LB, 'Conditions'], [0.601, '19,12 EUR'], [0.712, 'par'], [0.776, '1 Pce'], [0.897, '34 416,00']],
  [380, [LB, 'Code statistique des']],
  [374, [VAL, '86072110']],
  [368, [LB, 'marchandises']],
  [245, [L, 'Total sans taxe'], [0.897, '34 416,00']],
  [215, [L, 'Taxe 0,000 %'], [0.897, '0,00']],
  [200, [L, 'Montant final'], [0.897, '34 416,00']],
  [185, [L, 'livraison intracommunautaire exonérée de TVA']],
  ...FUSS,
]);
gleich([r.rechnungsnummer, r.bestellnummer, r.lieferdatum, r.steuerkategorie, r.kaeuferland, r.lieferLand], ['92099003', '02177-000099', '2026-08-21', 'K', 'FR', 'FR'], 'Französisch, IC-Lieferung');
gleich([r.kaeufer, r.kaeuferstrasse, r.kaeuferplz, r.kaeuferstadt], ['EXEMPLE SA', 'TSA 12345', '69000', 'LYON CEDEX 20'], 'französische Anschrift');
gleich([r.positionen[0].menge, r.positionen[0].einzelpreis, r.gesamtbetrag], [1800, 19.12, 34416], 'Leerzeichen als Tausendertrenner');
gleich(/marchandises/.test(r.positionen[0].details), false, 'zweite Zeile der Warennummer nicht in der Beschreibung');
gleich(r.faelligkeitsdatum, '2026-09-20', 'Fälligkeit französisch');

gleich([ctx.nurInland('EWA'), ctx.nurInland('EIS'), ctx.nurInland('ZAI')], [true, true, false], 'EWA wie EIS nur Inland ohne Rückfrage');

// 5) Durchwahl im Kopf, Proformarechnung ohne Bankverbindung
r = beleg([
  [741, [R, 'Proformarechnung']],
  [725, [R, 'Nummer'], [W, '92099009']],
  [721, [L, 'Eisenwerk Arnstadt GmbH |'], [0.188, 'Bierweg 4 | 99310 Arnstadt']],
  [710, [R, 'Datum'], [W, '20.10.2026']],
  [705, [L, 'Beispiel Muster GmbH']],
  [695, [R, 'Kundenauftrag'], [W, '5399']],
  [693, [L, 'Werkstraße 7']],
  [680, [L, '12345 Musterstadt'], [R, 'Referenznummer'], [W, '4500012399']],
  [650, [R, 'Kundennummer'], [W, '1099999']],
  [589, [R, 'Sachbearbeiter'], [W, 'Erika Muster']],
  [576, [R, 'Telefon'], [W, '+49 3628 596 123']],
  [560, [0.845, 'Währung'], [0.936, 'EUR']],
  [524, [L, 'Zahlungsbedingungen'], [0.267, 'Vorkasse']],
  [440, [POS, '10'], [LB, 'Material'], [VAL, '3009999 Gehäuse DN 50']],
  [410, [LB, 'Menge'], [VAL, '10 ST']],
  [395, [LB, 'Konditionen'], [VAL, 'Preis'], [0.601, '10,00 EUR'], [0.712, 'pro'], [0.776, '1 ST'], [0.897, '100,00']],
  [245, [L, 'Gesamtbetrag ohne Steuer'], [0.897, '100,00']],
  [215, [L, 'Umsatzsteuer 19,00 %'], [0.897, '19,00']],
  [200, [L, 'Endbetrag'], [0.897, '119,00']],
  ...FUSS,
]);
gleich([r.verkaeufkontakt, r.verkaeuftel], ['Erika Muster', '+49 3628 596 123'], 'Durchwahl aus dem Kopf');
gleich(r.proforma, true, 'Proformarechnung erkannt');
gleich(r.iban, 'DE92820700000126644400', 'ohne Bankverbindung auf dem Beleg das EUR-Konto aus den Stammdaten');

console.log(`ewa-ausgang: ${n} Prüfungen grün`);

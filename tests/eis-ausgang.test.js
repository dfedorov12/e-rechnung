// node tests/eis-ausgang.test.js
// Ausgangsrechnung EIS (DIHAG Gienanth, SAP): erfundene Belege im Layout, das pdf.js liefert.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ctx = { console: { log() {}, warn() {}, error() {} }, window: {}, Math, Date, JSON, RegExp, String, Number, Array, Object, Set, Map, parseFloat, parseInt, isNaN };
vm.createContext(ctx);
vm.runInContext(fs.readFileSync(path.join(__dirname, '../js/parser.js'), 'utf8')
  + '\nthis.eis = extractEis; this.istEis = _isEisInvoice; this.mail = _eisKontaktMail; this.nurInland = werkNurInland; this.unterschrift = werkDrittlandUnterschrift;', ctx);

let n = 0;
const gleich = (ist, soll, m) => { assert.deepStrictEqual(ist, soll, m + ': ' + JSON.stringify(ist)); n++; };
const NL = String.fromCharCode(10);
const FUSS = [
  'DIHAG Gienanth GmbH· Ramsener Straße 1 · 67304 Eisenberg (Pfalz) |www.dihag-gienanth.com Tel+49 (0) 6351 408-0 ·Fax+49 (0) 6351 408-101',
  'Handelsregister Amtsgericht Kaiserslautern HRB 34046 · USt.-IdNr. DE368676368 · Deutsche Bank AG · BIC DEUTDE8EXXX',
  'IBAN DE46 8207 0000 0154 6985 01 | Geschäftsführung , Viktor Babushchak · Dr. Hans-Jürgen Brenninger',
];
const KOPF_BESTELLUNG = [
  '(10) Ihr Zeichen (11) Bestellnummer Datum (12) Ihr Kontakt (13) Durchwahl (14) Unsere', 'Auftragsnummer',
  '4500012345 Muster Erika 06351/408-999', '09.07.2026', '30009999',
  'frei (20) unfrei (15) Lieferbedingungen (19) Versandart (21) Verpackungsart (22) Versandzeichen (23) Brutto Gesamt- (24) Netto',
  'FCA Frei Frachtführer gewicht', 'X Eisenberg LKW 1.234 1.200',
];
const POS_KOPF = [
  '(27) (28) Bestellnummer/ Sach-Nr. (29) Bestellungsbezeichnung (30)Menge M (32) Preis (34)Gesamtpreis in EUR',
  'Pos. (21) Verpackungsart E (18) Einheit EUR',
];

// 1) Einzelrechnung Inland, abweichende Versandanschrift, Preis je 1000 Stück
const rechnung = [
  'DIHAG Gienanth GmbH | Ramsener Str. 1 | 67304 Eisenberg (Pfalz)',
  'Konto bei Empfänger (2) Vermerk des Erhalts und der Bearbeitung (3) Lieferscheinnummer',
  '777001 80299999',
  'Rechnungsadresse (4) Versanddatum', '19.10.2026',
  'Musterbremsen GmbH', 'Werkstraße 7', 'Rechnung', '12345 Musterstadt Nummer', '90199999', 'Datum', '20.10.2026',
  'Kundennummer Ihre UST-ID Seite1 / 1', '1099999 DE999999999',
  ...KOPF_BESTELLUNG,
  '(25) Versandanschrift (26) Abladestation Zahlungsbedingung',
  '1099990 Musterbremsen GmbH Werk Süd 54321 Beispielort 30 Tage netto nach Rechnungsd.',
  'Am Hafen 3 Fälligkeitsdatum: 19.11.2026',
  ...POS_KOPF,
  '010 51234 4711-20-Muster Belagtraeger 10.161 1 2.463,52 25.031,80',
  '60000-10 /1000 ST',
  'Summe Positionen 25.031,80', 'Umsatzsteuer 19,00 % 4.756,04', 'Endbetrag 29.787,84',
  'Lieferscheindatum = Leistungsdatum',
  ...FUSS,
].join(NL);

gleich(ctx.istEis(rechnung), true, 'Layout erkannt');
let r = ctx.eis(rechnung);
gleich([r.rechnungsart, r.rechnungsnummer, r.rechnungsdatum], ['380', '90199999', '2026-10-20'], 'Art, Nummer, Datum');
gleich([r.kaeufer, r.kaeuferstrasse, r.kaeuferplz, r.kaeuferstadt, r.kaeuferland], ['Musterbremsen GmbH', 'Werkstraße 7', '12345', 'Musterstadt', 'DE'], 'Rechnungsadresse');
gleich([r.kundennummer, r.kaeufervat, r.lieferantennummer], ['1099999', 'DE999999999', '777001'], 'Kunden-Nr., USt-IdNr., Konto bei Empfänger');
gleich([r.lieferscheinnummer, r.lieferdatum], ['80299999', '2026-10-19'], 'Lieferschein und Versanddatum');
gleich([r.bestellnummer, r.verkaeufkontakt, r.verkaeuftel], ['4500012345', 'Muster Erika', '06351/408-999'], 'Bestellung und Ansprechpartner');
gleich(r.verkaeuferemail, 'erika.muster@dihag-gienanth.com', 'Kontakt-Mail aus dem Ansprechpartner');
gleich([r.lieferName, r.lieferStrasse, r.lieferPlz, r.lieferStadt], ['Musterbremsen GmbH Werk Süd', 'Am Hafen 3', '54321', 'Beispielort'], 'Versandanschrift');
gleich(r.faelligkeitsdatum, '2026-11-19', 'Fälligkeit');
gleich([r.steuerkategorie, r.steuerbetrag, r.gesamtbetrag], ['S', 4756.04, 29787.84], 'Steuer und Summe');
gleich(r.positionen.length, 1, 'eine Position');
const p = r.positionen[0];
gleich([p.posnr, p.menge, p.mwst, p.details], ['10', 10161, 19, 'Sach-Nr. 60000-10'], 'Position');
gleich(Math.round(p.menge * p.einzelpreis * 100) / 100, 25031.8, 'Gesamtpreis wie gedruckt trotz Preis je 1000');
gleich(/Zahlungsbedingung: 30 Tage netto/.test(r.notiz) && /Bestellung 4500012345 vom 09.07.2026, unsere Auftragsnummer 30009999/.test(r.notiz), true, 'Hinweis mit Zahlung und Bestellung');
gleich(/Lieferbedingung: FCA Frei Frachtführer Eisenberg/.test(r.notiz), true, 'Lieferbedingung mit Ort');
gleich(/Lieferscheindatum = Leistungsdatum/.test(r.notiz) && !/Handelsregister/.test(r.notiz), true, 'Fußtext ohne Firmenfuß');

// 2) Gutschrift mit Bezug, Preis auf der Folgezeile, Lieferschein steht unter der Adresse
const gutschrift = [
  'DIHAG Gienanth GmbH | Ramsener Str. 1 | 67304 Eisenberg (Pfalz)',
  'Konto bei Empfänger (2) Vermerk des Erhalts und der Bearbeitung (3) Lieferscheinnummer',
  '777002', 'Rechnungsadresse', '80288888', '(4) Versanddatum',
  'Beispielguss Eisengießerei', 'GmbH & Co. KG', 'Gutschrift', 'Gießereiweg 15 Nummer', '35260 Musterhausen 90188888', 'Datum', '31.08.2026',
  'Kundennummer Ihre UST-ID Seite1 / 1', '1088888 DE888888888',
  ...KOPF_BESTELLUNG,
  '(25) Versandanschrift (26) Abladestation Zahlungsbedingung',
  '1088888 Beispielguss Eisengießerei GmbH & C 35260 Musterhausen 30 Tage netto nach Rechnungsd.',
  'Gießereiweg 15 Fälligkeitsdatum: 30.09.2026',
  ...POS_KOPF,
  'GS zu RE # 90177777 vom', '17.04.2026', 'Reklamation per Mail am 05.06.2026',
  '014 50000B 90000 Muster Belagtraeger 6.720 1', '264,05 17.744,16', 'B000000FN01 / 100 ST',
  'Summe Positionen 17.744,16', 'Umsatzsteuer 19,00 % 3.371,39', 'Endbetrag 21.115,55',
  ...FUSS,
].join(NL);
r = ctx.eis(gutschrift);
gleich([r.rechnungsart, r.rechnungsnummer], ['381', '90188888'], 'Gutschrift als 381');
gleich([r.vorrechnungsnummer, r.vorrechnungsdatum], ['90177777', '2026-04-17'], 'Bezug auf die Rechnung (BT-25/26)');
gleich([r.kaeufer, r.kaeuferstrasse, r.kaeuferplz], ['Beispielguss Eisengießerei GmbH & Co. KG', 'Gießereiweg 15', '35260'], 'Name über zwei Zeilen');
gleich([r.lieferantennummer, r.lieferscheinnummer], ['777002', '80288888'], 'Konto und Lieferschein getrennt');
gleich(r.lieferName, undefined, 'gleiche Kunden-Nr. in der Versandanschrift: keine Lieferanschrift');
gleich(Math.round(r.positionen[0].menge * r.positionen[0].einzelpreis * 100) / 100, 17744.16, 'Preis aus der Folgezeile');
gleich(/Reklamation per Mail/.test(r.notiz), true, 'Grund der Gutschrift im Hinweis');

// 3) EU: Rechnungsadresse im Inland, Lieferung nach Rumänien, Zuschläge in der Position
const eu = [
  'DIHAG Gienanth GmbH | Ramsener Str. 1 | 67304 Eisenberg (Pfalz)',
  'Konto bei Empfänger (2) Vermerk des Erhalts und der Bearbeitung (3) Lieferscheinnummer',
  '777003 80277777', 'Rechnungsadresse (4) Versanddatum', '14.10.2026',
  'Muster Friction Products', 'International GmbH', 'Rechnung', 'Musterweg 9 Nummer', '99999 Beispielstadt 90177778', 'Datum', '14.10.2026',
  'Kundennummer Ihre UST-ID Seite1 / 2', '1077777 RO99999999',
  ...KOPF_BESTELLUNG,
  '(25) Versandanschrift (26) Abladestation Zahlungsbedingung',
  '1077770 Muster Friction Prods. 107025 Beispiel-Ort, Prahova 10 Tage netto', 'Fälligkeitsdatum: 24.10.2026',
  ...POS_KOPF,
  'Ship to adress:', 'Muster Friction Products', 'West Park 1', 'Romania',
  '010 50001 L-00001 Anpressplatte 48 1 9,19 441,12', '0400000000000 Stat. Warennummer 87089390 / 1 ST',
  'Metallteuerungszuschlag 0,72 34,42', 'Energieteuerungszuschlag 0,53 25,52', 'Gesamtnettowert 10,44 501,06',
  'Summe Positionen 501,06', 'Umsatzsteuer 0,00 0,00',
  ...FUSS,
  'Rechnung Nr. 90177778 vom 14.10.2026 Seite 2 / 2', 'Endbetrag 501,06', 'Steuerfreie Innergemeinschaftliche Lieferung',
  ...FUSS,
].join(NL);
r = ctx.eis(eu);
gleich([r.kaeuferland, r.lieferLand, r.steuerkategorie], ['DE', 'RO', 'K'], 'Anschrift Inland, Lieferung RO, innergemeinschaftlich');
gleich([r.positionen[0].mwst, r.gesamtbetrag], [0, 501.06], '0 % und Endbetrag von Seite 2');
gleich(Math.round(r.positionen[0].menge * r.positionen[0].einzelpreis * 100) / 100, 501.06, 'Gesamtnettowert inkl. Zuschlägen');
gleich(/Metallteuerungszuschlag/.test(r.positionen[0].details), true, 'Zuschläge in der Positionsbeschreibung');
gleich(/Seite 2/.test(r.notiz), false, 'Seitenkopf nicht im Hinweis');

// 4) Drittland, englisch: Schlussrechnung mit Anzahlung, Ansprechpartner ohne Durchwahl
const kopfEn = (titel, nr) => [
  'DIHAG Gienanth GmbH | Ramsener Str. 1 | 67304 Eisenberg (Pfalz)',
  'account number at recipient (2) notices of receipt and processing (3) delivery note no.',
  'invoice address (4) dispatch date',
  'Beispiel Casting Co., Ltd.', '1 Sample Road', titel, 'SAMPLETOWN 690-0000 no.', 'JAPAN ' + nr, 'date', '09.07.2026',
  'customer number at Gienanth your VAT-ID Page1 / 2', '1066666',
  '(10) your reference (11) order no date (12) your contact (13) direct dial (14) our order number',
];
const schluss = [
  ...kopfEn('Invoice', '90166666'),
  'IPD-026-099 Mustermann Jörg', '6173', '25.03.2026',
  'free (20) not free (15) Incoterms (19) disp.type (21) packing type (22) disp.character (23) gross total (24) net',
  'Free Carrier Eisenberg weight', 'X 0 0',
  '(25) shipping-address (26) receiving-/unloading pt terms of payment',
  '1066666 Beispiel Casting Co., Ltd. 6900000 Sampletown 60 days net after date of invoice',
  '1 Sample Road Due date: 07.09.2026',
  '(27) (28)order no./suppl.ref.no. (29) order description (30) quantity U (32) price (34)total EUR',
  'Pos. (21) packing type M (18) unit EUR',
  '010 MODELL HF 5 pairs of moulding boxes 1 1 175.000,00 175.000,00', '/ 1 PC', '70% final payment after release for production',
  'Total Amount Before Tax 175.000,00', 'German VAT 0,00 0,00', 'Total Amount 175.000,00',
  'payments received until date of final invoice', 'invoice no./date % net value VAT Final amount',
  '90165555/10.04.2026 0,00 52.500,00 0,00 52.500,00', 'total amount 0,00 52.500,00 0,00 52.500,00',
  'remaining amount net 122.500,00', 'VAT 0,00 %', 'due remaining amount 122.500,00',
  ...FUSS,
  'Invoice Nr. 90166666 from 09.07.2026 Page 2 / 2', 'Tax-Exempt Export',
  'Country of origin: Federal Republic of Germany', '----------------------------------', 'signat',
  ...FUSS,
].join(NL);
r = ctx.eis(schluss);
gleich([r.rechnungsart, r.rechnungsnummer, r.kaeuferland, r.steuerkategorie], ['380', '90166666', 'JP', 'G'], 'Drittland, Ausfuhr');
gleich([r.bestellnummer, r.verkaeufkontakt, r.verkaeuftel], ['IPD-026-099', 'Mustermann Jörg', '+49 6351 408-0'], 'Kontakt ohne Durchwahl, Zentrale');
gleich(r.verkaeuferemail, 'joerg.mustermann@dihag-gienanth.com', 'Kontakt-Mail auch ohne Durchwahl');
gleich([r.gezahlt, r.vorrechnungsnummer, r.vorrechnungsdatum], [52500, '90165555', '2026-04-10'], 'Anzahlung als bereits gezahlt (BT-113)');
gleich(/Anzahlungen: 90165555 vom 10.04.2026 über 52500,00 EUR/.test(r.notiz), true, 'Anzahlung im Hinweis');
gleich(/remaining|due remaining|total amount 0,00/i.test(r.notiz), false, 'Restbetragszeilen nicht im Hinweis');
gleich(/Country of origin/.test(r.notiz) && !/signat/.test(r.notiz), true, 'Ursprungsangabe im Hinweis, Unterschriftszeile nicht');

// 5) Gutschrift ins Drittland ohne Zahlungsziel, Durchwahl über zwei Zeilen
const gsEn = [
  ...kopfEn('Credit Memo', '90166667'),
  '95001460 Muster Hans (0) 6351 408', '34000262', '21.04.2026 262',
  'free (20) not free (15) Incoterms (19) disp.type (21) packing type (22) disp.character (23) gross total (24) net',
  'weight', 'X 0 0',
  '(25) shipping-address (26) receiving-/unloading pt terms of payment',
  '1066666 Beispiel Casting Co., Ltd. 6900000 Sampletown', '1 Sample Road Due date:',
  '(27) (28)order no./suppl.ref.no. (29) order description (30) quantity U (32) price (34)total EUR',
  'Pos. (21) packing type M (18) unit EUR',
  '010 99999QUHF Quality cost reimbursement 1 1 4.596,32 4.596,32', 'Code-No 84099900 / 1 PC',
  'Total Amount Before Tax 4.596,32', 'German VAT 0,00 0,00', 'Total Amount 4.596,32',
  ...FUSS,
].join(NL);
r = ctx.eis(gsEn);
gleich([r.rechnungsart, r.faelligkeitsdatum], ['381', undefined], 'Gutschrift ohne Fälligkeit');
gleich(/^Zahlungsbedingung: Gutschrift$/m.test(r.notiz), true, 'Zahlungshinweis für BR-CO-25');
gleich(r.verkaeuftel, '(0) 6351 408 262', 'Durchwahl aus zwei Zeilen');

// Kontakt-Mail und Umfang
gleich(ctx.mail('Müller Anna'), 'anna.mueller@dihag-gienanth.com', 'Umlaut');
gleich(ctx.mail('Mustermann Jörg'), 'joerg.mustermann@dihag-gienanth.com', 'ö');
gleich(ctx.mail('Weiß Hans Peter'), 'hans-peter.weiss@dihag-gienanth.com', 'ß und zwei Vornamen');
gleich(ctx.mail('Einzelname'), '', 'ohne Vornamen keine Mail');
gleich([ctx.nurInland('EIS'), ctx.nurInland('eis'), ctx.nurInland('ZAI')], [true, true, false], 'nur Inland bei EIS');

gleich([ctx.unterschrift('EIS'), ctx.unterschrift('EWA'), ctx.unterschrift('ZAI')], [true, false, false], 'unterschriebenes Original nur bei EIS');

console.log(`eis-ausgang: ${n} Prüfungen grün`);

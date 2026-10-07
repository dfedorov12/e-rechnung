// node tests/lieferant.test.js
// Erfundene Rechnungstexte in den Layouts, die pdf-parse bzw. pdf.js liefern.
const assert = require('assert');
const { lieferantAusText, istEigen } = require('../js/lieferant.js');

let n = 0;
const gleich = (ist, soll, m) => { assert.deepStrictEqual(ist, soll, m + ': ' + JSON.stringify(ist)); n++; };
const NL = String.fromCharCode(10);
const text = zeilen => zeilen.join(NL);

// 1) Absenderzeile oben, USt-IdNr. mit Leerzeichen im Fuß, eigene USt-IdNr. als „Ihre"
let r = lieferantAusText(text([
  'Muster Werkzeuge GmbH - Hauptstr. 5 - 01234 Musterstadt',
  'Walzengießerei Coswig GmbH', 'Grenzstraße 1', '01640 Coswig',
  'Rechnung 771234', 'Datum21.09.2026', 'Kundennummer4702',
  'Ihre Ust.Id DE140598967',
  'Summe869,90', 'MwSt. 19%165,28', 'Gesamt1.035,18',
  'Muster Werkzeuge GmbH', 'Hauptstr. 5', '01234 Musterstadt',
  'USt-Id-Nr.: DE 123 456 789', 'IBAN: DE14 7656 0060 0004 8843 96',
]));
gleich(r.name, 'Muster Werkzeuge GmbH', 'Name aus Absenderzeile');
gleich(r.vat, 'DE123456789', 'USt-IdNr. des Lieferanten, nicht die eigene');
gleich(r.nummer, '771234', 'Nummer hinter „Rechnung"');
gleich(r.datum, '2026-09-21', 'Datum angeklebt');
gleich(r.brutto, 1035.18, 'Gesamt angeklebt');
gleich(r.kleinunternehmer, false, 'kein § 19');

// 2) Werte vor den Beschriftungen, Nummer mit angeklebtem Wort
r = lieferantAusText(text([
  'Walzengießerei Coswig GmbH', 'Rechnung', 'Grenzstr. 1',
  '47835649', 'Rechnungs-Nr.:', '15.09.2026', 'Rechnungs-Datum:', '01640 Coswig',
  'Rechnung Nr. 914722Kunden Nr. 103160',
  'Beispiel Technik GmbH & Co. KG | Postfach 2001 | 71268 Renningen',
  'Rechnungsbetrag:', '         967,03',
  'Beispiel Technik GmbH & Co.KG', 'USt.Id.Nr. DE 987654321',
]));
gleich(r.nummer, '47835649', 'Wert vor der Beschriftung');
gleich(r.datum, '2026-09-15', 'Datum vor der Beschriftung');
gleich(r.brutto, 967.03, 'Betrag in der Zeile danach');
gleich(r.name, 'Beispiel Technik GmbH & Co. KG', 'GmbH & Co. KG vollständig');
gleich(r.vat, 'DE987654321', 'USt-IdNr. im Fuß');

// 3) Absender ohne Rechtsform, Kleinunternehmer
r = lieferantAusText(text([
  'Malerbetrieb Kunz, Am Markt 3, 04509 Delitzsch',
  'DIHAG Zaigler GmbH', 'Rechnung', 'Rechnungsnummer: 2026-118', 'Rechnungsdatum: 02.02.2027',
  'Malerarbeiten Halle 2', 'Gesamtbetrag 1.480,00 EUR',
  'Gemäß § 19 UStG wird keine Umsatzsteuer berechnet.',
]));
gleich(r.name, 'Malerbetrieb Kunz', 'Absender ohne Rechtsform');
gleich(r.nummer, '2026-118', 'Rechnungsnummer mit Label');
gleich(r.datum, '2027-02-02', 'Rechnungsdatum mit Label');
gleich(r.kleinunternehmer, true, '§ 19 UStG erkannt');
gleich(r.vat, '', 'keine USt-IdNr.');

// 4) Nur eigene Gesellschaften im Text: kein Lieferant
r = lieferantAusText(text([
  'SHB Stahl- und Hartgusswerk Bösdorf GmbH', 'USt-IdNr. DE 812 264 517',
  'Lintorfer Eisengießerei GmbH', 'Rechnung Nr. 4711', 'Datum: 01.03.2026', 'Endbetrag 120,00',
]));
gleich(r.name, '', 'eigene Gesellschaft nie als Lieferant');
gleich(r.vat, '', 'eigene USt-IdNr. nie als Lieferant');

// 5) Scan ohne Text
r = lieferantAusText('   ');
gleich(r.lesbar, false, 'Scan erkannt');
gleich(r.name + r.vat + r.nummer, '', 'Scan liefert nichts');

// 6) IBAN nicht als USt-IdNr.
r = lieferantAusText(text([
  'Probe Handel AG · Ring 1 · 10115 Berlin', 'Rechnung Nr. 55501', 'Datum 03.03.2026',
  'Bankverbindung IBAN DE12345678901234567890', 'Zu zahlen 99,00',
]));
gleich(r.vat, '', 'IBAN ist keine USt-IdNr.');
gleich(r.name, 'Probe Handel AG', 'AG aus Absenderzeile');

gleich(istEigen('DIHAG Holding GmbH'), true, 'DIHAG eigen');
gleich(istEigen('Meuselwitz Guss GmbH'), true, 'MEG eigen');
gleich(istEigen('Telekom Deutschland GmbH'), false, 'fremd');

console.log(`lieferant: ${n} Pruefungen gruen`);

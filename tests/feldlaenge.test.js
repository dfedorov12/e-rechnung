// node tests/feldlaenge.test.js
// Hinweise und Datenfelder aus /api/intake passen in „Eine Textzeile“ (255 Zeichen).
const assert = require('assert');
const { SP_TEXT, kuerzen, feldGrenzen } = require('../api/src/feldlaenge.js');

let n = 0;
const gleich = (ist, soll, m) => { assert.deepStrictEqual(ist, soll, m + ': ' + JSON.stringify(ist)); n++; };
const wahr = (b, m) => { assert.ok(b, m); n++; };

// 1) Kurze Texte bleiben unverändert, auch mit doppelten Leerzeichen
gleich(kuerzen('Alles gut.'), 'Alles gut.', 'kurz');
gleich(kuerzen('a  b'), 'a  b', 'kurz mit Leerzeichen');
gleich(kuerzen(''), '', 'leer');
gleich(kuerzen(null), null, 'null');
gleich(kuerzen('x'.repeat(255)), 'x'.repeat(255), 'genau 255');

// 2) Der Fall aus dem Flow: sonstige Rechnung mit Fremdformat-XML und PDF-Text
const alt = 'Eingebettete XML ist kein EN16931-Format (z. B. openTRANS/BMEcat), keine ZUGFeRD/Factur-X-'
  + 'Rechnung, als sonstige Rechnung unter Vorbehalt gebucht, Berichtigung (echte E-Rechnung) '
  + 'angefordert (UStAE 14.1 Abs. 2 / 15.2a Abs. 1a). Lieferant und Kopfdaten aus dem PDF-Text '
  + 'gelesen, bitte prüfen. Betrag laut Text: 1234,56 €.';
wahr(alt.length > SP_TEXT, 'Beispiel ist zu lang');
let k = kuerzen(alt);
wahr(k.length <= SP_TEXT, 'gekürzt auf 255: ' + k.length);
wahr(k.endsWith(' …'), 'endet auf …');
wahr(k.startsWith('Eingebettete XML'), 'Anfang bleibt');
wahr(/Abs\. 1a\)\. …$/.test(k), 'am letzten Satzende geschnitten: ' + k);

// 3) Trenner „ | “ zwischen den Teilhinweisen
const teile = ['A'.repeat(150), 'Reverse-Charge (§13b UStG), manuelle Pruefung (Vier-Augen) erforderlich.',
  'Materielle Abweichung Sichtbild und XML: Steuerbetrag 19,00 statt 190,00'].join(' | ');
k = kuerzen(teile);
wahr(k.length <= SP_TEXT, 'mit Trenner kurz genug');
wahr(/erforderlich\. …$/.test(k), 'am Trenner geschnitten: ' + k);

// 4) „z. B.“ und „Abs. 2“ sind kein Satzende
k = kuerzen('W'.repeat(230) + ' z. B. Muster und noch etwas mehr Text dahinter');
wahr(!/z\. …$/.test(k) && k.length <= SP_TEXT, 'nicht hinter z.: ' + k.slice(-20));

// 5) Ohne Satzende und Leerzeichen hart schneiden
k = kuerzen('y'.repeat(400));
gleich(k.length, SP_TEXT, 'hart geschnitten');

// 6) feldGrenzen: hinweisLang hält den vollen Text, daten nur bei Überlänge gekürzt
const res = feldGrenzen({
  hinweis: alt, konformLabel: 'Sonstige Rechnung (keine E-Rechnung)', manuellePruefungGrund: '',
  daten: { nummer: 'RE-1', steller: 'S'.repeat(300), netto: null, brutto: 12.5 },
});
gleich(res.hinweisLang, alt, 'hinweisLang ungekürzt');
wahr(res.hinweis.length <= SP_TEXT, 'hinweis gekürzt');
gleich(res.konformLabel, 'Sonstige Rechnung (keine E-Rechnung)', 'Label unverändert');
gleich(res.daten.nummer, 'RE-1', 'Nummer unverändert');
wahr(res.daten.steller.length <= SP_TEXT, 'langer Steller gekürzt');
gleich(res.daten.netto, null, 'null bleibt');
gleich(res.daten.brutto, 12.5, 'Zahl bleibt');
gleich(feldGrenzen({ hinweis: '' }).hinweisLang, '', 'leerer Hinweis');

console.log(`feldlaenge: ${n} Prüfungen grün`);

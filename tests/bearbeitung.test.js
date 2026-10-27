// node tests/bearbeitung.test.js
// Bearbeitung von Eingangsrechnungen im Monitoring (js/bearbeitung.js)
const assert = require('assert');
const B = require('../js/bearbeitung.js');

let n = 0;
const gleich = (ist, soll, m) => { assert.deepStrictEqual(ist, soll, m + ': ' + JSON.stringify(ist)); n++; };
const wirft = (fn, re, m) => { assert.throws(fn, re, m); n++; };

// 1) Felder lesen: leer bleibt '' bzw. null, Booleans robust
let b = B.bhAusFeldern({ Varialnummer: '123456', GFGesehen: true, Genehmigt: 'Ja', GenehmigungAnfordern: '0' });
gleich(b.varial, '123456', 'Varialnummer');
gleich(b.gfGesehen, true, 'GF gesehen');
gleich(b.anfordern, false, 'Auslöser als Text 0');
gleich(b.kontierung, '', 'leere Kontierung');
gleich(b.abasGesendet, null, 'nie gesetzt = null');
gleich(B.bhAusFeldern(null).genehmigt, '', 'ohne Felder');

// 2) Zieldatei: Original-PDF, sonst lesbares PDF, sonst Original
const pdf = { ext: 'pdf', sidecar: '' }, xml = { ext: 'xml', sidecar: '' };
const lesbar = { ext: 'pdf', sidecar: 'lesbar' }, kosit = { ext: 'xml', sidecar: 'kosit' };
gleich(B.bhZiel([xml, pdf, kosit]), pdf, 'ZUGFeRD: Original-PDF');
gleich(B.bhZiel([kosit, xml, lesbar]), lesbar, 'XRechnung: lesbares PDF');
gleich(B.bhZiel([kosit, xml]), xml, 'nur XML');

// 3) Zusammenführen: Zieldatei zuerst, Lücken aus Geschwistern
const z = { bh: B.bhAusFeldern({ Varialnummer: '111', GFGesehen: false }) };
const g = { bh: B.bhAusFeldern({ Varialnummer: '999', Bestellnummer: 'B-7', GFGesehen: true }) };
const m = B.bhZusammen([g, z], z);
gleich(m.varial, '111', 'Ziel gewinnt');
gleich(m.bestellnr, 'B-7', 'Bestellnummer aus dem XML');
gleich(m.gfGesehen, false, 'gesetztes Nein am Ziel gewinnt');

// 4) Mailadressen
gleich(B.bhMails('a@x.de'), 'a@x.de', 'eine');
gleich(B.bhMails(' a@x.de ; b@y.com,'), 'a@x.de; b@y.com', 'mehrere');
gleich(B.bhMails('a@x'), '', 'ohne Domain');
gleich(B.bhMails('a@x.de; kaputt'), '', 'eine kaputt');
gleich(B.bhMails(''), '', 'leer');

// 5) Änderungen: nur was sich ändert, Auswahl leer = null, Text getrimmt
const alt = B.bhAusFeldern({ Varialnummer: '123', Kontierung: '4711 KST 10', Genehmigt: 'Nein', GFGesehen: false });
gleich(B.bhAenderungen(alt, { varial: '123', kontierung: '4711 KST 10', genehmigt: 'Nein', gfGesehen: false }), {}, 'nichts geändert');
gleich(B.bhAenderungen(alt, { varial: ' 124 ' }), { Varialnummer: '124' }, 'Varialnummer getrimmt');
gleich(B.bhAenderungen(alt, { genehmigt: '' }), { Genehmigt: null }, 'Auswahl geleert');
gleich(B.bhAenderungen(alt, { gfGesehen: true }), { GFGesehen: true }, 'GF gesehen an');
gleich(B.bhAenderungen(alt, { kontierung: '4711 KST 10\n4712 KST 20\n' }), { Kontierung: '4711 KST 10\n4712 KST 20' }, 'Kontierung mehrzeilig');
gleich(B.bhAenderungen(alt, { bstatus: 'Vorkasse erfaßt' }), { Bearbeitungsstatus: 'Vorkasse erfaßt' }, 'Status mit ß');
gleich(B.bhAenderungen(B.bhAusFeldern({}), { notiz: '   ' }), {}, 'leere Notiz bleibt leer');

// 6) Anforderung
const a = B.bhAnforderung({ genehmiger: 'chef@walze-coswig.de', kommentar: ' bitte prüfen ', abasInfo: true,
  abasInfoAn: 'kollege@walze-coswig.de', von: 'buha@walze-coswig.de', jetzt: '2026-10-26T10:00:00Z' });
gleich(a.GenehmigungAnfordern, true, 'Auslöser');
gleich(a.GenehmigungAn, 'chef@walze-coswig.de', 'Genehmiger');
gleich(a.AnforderungKommentar, 'bitte prüfen', 'Kommentar getrimmt');
gleich(a.AbasInfoAn, 'kollege@walze-coswig.de', 'abas-Info');
gleich(a.Genehmigt, 'Nein', 'Genehmigt = Nein bis zur Antwort');
gleich(a.Bearbeitungsstatus, 'In Genehmigung', 'Bearbeitungsstatus');
gleich(a.GenehmigtVon, '', 'altes Ergebnis geleert');
gleich(B.bhAnforderung({ genehmiger: 'chef@x.de', abasInfo: false, abasInfoAn: 'egal' }).AbasInfoAn, '', 'ohne abas-Info');
wirft(() => B.bhAnforderung({ genehmiger: '' }), /Genehmigers/, 'Genehmiger fehlt');
wirft(() => B.bhAnforderung({ genehmiger: 'chef@x.de', abasInfo: true, abasInfoAn: 'kaputt' }), /abas/, 'abas-Adresse kaputt');

// 7) Stand und „in Genehmigung“
const s = f => B.bhAusFeldern(f);
gleich(B.bhGenehmigungsStand(s({})), '', 'nie angefordert');
gleich(B.bhGenehmigungsStand(s({ GenehmigungAnfordern: true, GenehmigungAn: 'chef@x.de' })), 'Angefordert bei chef@x.de, wartet auf den Flow', 'angefordert');
gleich(B.bhGenehmigungsStand(s({ Genehmigt: 'Nein', GenehmigungAn: 'chef@x.de', AngefordertAm: '2026-10-20T08:00:00Z' })), 'In Genehmigung bei chef@x.de seit 20.10.2026', 'beim Genehmiger');
gleich(B.bhGenehmigungsStand(s({ Genehmigt: 'Ja', GenehmigtVon: 'Max Chef', GenehmigtAm: '2026-10-21T09:00:00Z' })), 'Genehmigt von Max Chef am 21.10.2026', 'genehmigt');
gleich(B.bhGenehmigungsStand(s({ Genehmigt: 'Abgelehnt', GenehmigtVon: 'Max Chef' })), 'Abgelehnt von Max Chef', 'abgelehnt');
gleich(B.bhInGenehmigung(s({ Genehmigt: 'Nein' })), false, 'Nein ohne Genehmiger zählt nicht');
gleich(B.bhInGenehmigung(s({ Genehmigt: 'Nein', GenehmigungAn: 'chef@x.de' })), true, 'Nein mit Genehmiger');
gleich(B.bhInGenehmigung(null), false, 'Ausgang ohne Bearbeitung');

// 7b) Kopfdaten fürs lesbare PDF: nur was dort fehlt
const zeile = { listId: 'L', itemId: '1', nummer: '123456', steller: 'Test GmbH', netto: 500, brutto: 595, waehrungFeld: 'EUR' };
gleich(B.bhKopfdaten(zeile, { listId: 'L', itemId: '2', titel: '', steller: '', netto: null, brutto: null, waehrungFeld: '' }),
  { Title: '123456', Rechnungssteller: 'Test GmbH', Nettobetrag: 500, Bruttobetrag: 595, Waehrung: 'EUR' }, 'alles fehlt');
gleich(B.bhKopfdaten(zeile, { listId: 'L', itemId: '2', titel: 'X', steller: 'Y', netto: 1, brutto: 2, waehrungFeld: 'GBP' }), {}, 'nichts überschreiben');
gleich(B.bhKopfdaten(zeile, { listId: 'L', itemId: '1' }), {}, 'Zieldatei ist die Rechnung selbst');

// 8) Werte wie in der alten Liste
gleich(B.BH_GENEHMIGT.length, 9, 'Genehmigt: 9 alte Werte');
gleich(B.BH_STATUS.includes('Gebucht (m. Prüfg rechn & Stammd)'), true, 'Status Gebucht wie alt');

console.log(`bearbeitung: ${n} Prüfungen grün`);

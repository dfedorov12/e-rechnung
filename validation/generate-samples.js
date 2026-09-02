'use strict';
/**
 * Headless Sample-Generator für die Konformitätsprüfung
 * =====================================================
 * Erzeugt aus repräsentativen Rechnungsdaten mit dem ECHTEN Konverter
 * (js/xrechnung.js, js/xml2pdf.js, js/zugferd.js) je Fall:
 *   - <name>_xrechnung.xml   (reine XRechnung, CII)
 *   - <name>_zugferd.pdf      (ZUGFeRD: PDF aus Daten gerendert + XML eingebettet)
 *
 * Die Dateien landen in validation/out/ und werden anschließend gegen
 * KoSIT-Validator (XRechnung) + veraPDF (PDF/A-3) geprüft — lokal oder in CI.
 *
 * Läuft im HOST-Realm (new Function), damit pdf-lib die Arrays korrekt prüft.
 * Nutzt pdf-lib/@xmldom aus api/node_modules (kein zweites npm install nötig).
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const OUT = path.join(__dirname, 'out');
const PDFLib = require(path.join(ROOT, 'api/node_modules/pdf-lib'));
const fontkit = require(path.join(ROOT, 'api/node_modules/@pdf-lib/fontkit'));
const EMBED_FONTS = require(path.join(ROOT, 'js/vendor/font-embed.js'));

fs.mkdirSync(OUT, { recursive: true });

/* ── Konverter-Module im Host-Realm laden (fontkit + Schrift injiziert) ── */
function loadHost(file, wanted) {
  const src = fs.readFileSync(path.join(ROOT, file), 'utf8');
  const ret = wanted.map(n => `${n}:(typeof ${n}!=='undefined')?${n}:undefined`).join(', ');
  // eslint-disable-next-line no-new-func
  const factory = new Function('PDFLib', 'fontkit', 'EMBED_FONTS', 'console', 'atob', 'TextEncoder',
    `${src}\n;return { ${ret} };`);
  return factory(PDFLib, fontkit, EMBED_FONTS, console, globalThis.atob, globalThis.TextEncoder);
}

const xr = loadHost('js/xrechnung.js', ['buildXML', 'calcTotals']);
const xp = loadHost('js/xml2pdf.js', ['buildInvoicePdf']);
const zf = loadHost('js/zugferd.js', ['embedXMLIntoPDF', 'makeReadablePdfA3']);

/* ── Stammdaten der Aussteller ── */
const WGC = {
  verkaeufer: 'Walzengiesserei Coswig GmbH', verkaeufstrasse: 'Kurze Strasse 2',
  verkaeufplz: '01640', verkaeufstadt: 'Coswig', verkaeufland: 'DE',
  verkaeufervat: 'DE140156049', verkaeufkontakt: 'Viktor Babushchak',
  verkaeuftel: '+49 3523 77 0', verkaeuferemail: 'sales@walze-coswig.de',
  iban: 'DE60820700000130805500', bic: 'DEUTDE8CXXX',
  handelsregister: 'Amtsgericht Dresden', registernr: 'HRB 312', geschaeftsfuehrung: 'Viktor Babushchak',
  gesellschaft: 'WGC',
};
const SHB = {
  verkaeufer: 'Stahl- und Hartgusswerk Boesdorf GmbH', verkaeufstrasse: 'Werkstrasse 1',
  verkaeufplz: '04720', verkaeufstadt: 'Boesdorf', verkaeufland: 'DE',
  verkaeufervat: 'DE141420766', verkaeufkontakt: 'Viktor Babushchak',
  verkaeuftel: '+49 3431 60 0', verkaeuferemail: 'sales@shb-guss.de',
  iban: 'DE77820700000338669501', bic: 'DEUTDE8CXXX',
  handelsregister: 'Amtsgericht Leipzig', registernr: 'HRB 13893', geschaeftsfuehrung: 'Viktor Babushchak',
  gesellschaft: 'SHB',
};

/* ── Repräsentative Fälle ── */
const SAMPLES = [
  {
    name: 'wgc_standard_19',
    data: {
      ...WGC,
      kaeufer: 'Muster Maschinenbau GmbH', kaeuferstrasse: 'Industriestrasse 10',
      kaeuferplz: '44869', kaeuferstadt: 'Bochum', kaeuferland: 'DE',
      kaeufermail: 'kreditoren@muster.de', kaeufervat: 'DE123456789',
      rechnungsnummer: '4260901', rechnungsdatum: '2026-09-01', lieferdatum: '2026-08-28',
      faelligkeitsdatum: '2026-10-01', zahlungsreferenz: '4260901',
      notiz: 'Zahlung: 30 Tage netto ohne Abzug.', steuerkategorie: 'S', befreiungsgrund: '',
      positionen: [
        { posnr: '1', beschreibung: 'Walze GGG-70, bearbeitet', menge: 4, einheit: 'Stk', einzelpreis: 1250, rabatt: 0, mwst: 19 },
        { posnr: '2', beschreibung: 'Fracht/Verpackung', menge: 1, einheit: 'Pausch.', einzelpreis: 300, rabatt: 0, mwst: 19 },
      ],
    },
  },
  {
    name: 'shb_standard_19',
    data: {
      ...SHB,
      kaeufer: 'Beispiel Anlagenbau AG', kaeuferstrasse: 'Hauptstrasse 5',
      kaeuferplz: '70173', kaeuferstadt: 'Stuttgart', kaeuferland: 'DE',
      kaeufermail: 'rechnung@beispiel-ag.de', kaeufervat: 'DE987654321',
      rechnungsnummer: '5100777', rechnungsdatum: '2026-09-01', lieferdatum: '2026-08-30',
      faelligkeitsdatum: '2026-09-15', zahlungsreferenz: '5100777',
      notiz: 'Zahlbar innerhalb 14 Tagen.', steuerkategorie: 'S', befreiungsgrund: '',
      positionen: [
        { posnr: '1', beschreibung: 'Hartgussteil nach Zeichnung', menge: 12, einheit: 'Stk', einzelpreis: 89.5, rabatt: 0, mwst: 19 },
      ],
    },
  },
  {
    name: 'wgc_innergemeinschaftlich_K',
    data: {
      ...WGC,
      kaeufer: 'Voestalpine Beispiel GmbH', kaeuferstrasse: 'Voest-Alpine-Strasse 1',
      kaeuferplz: '4020', kaeuferstadt: 'Linz', kaeuferland: 'AT',
      kaeufermail: 'ap@voest-beispiel.at', kaeufervat: 'ATU12345678',
      rechnungsnummer: '4260902', rechnungsdatum: '2026-09-01', lieferdatum: '2026-08-29',
      faelligkeitsdatum: '2026-10-01', zahlungsreferenz: '4260902',
      notiz: 'Steuerfreie innergemeinschaftliche Lieferung (Art. 138 MwStSystRL).',
      steuerkategorie: 'K', befreiungsgrund: 'Innergemeinschaftliche Lieferung',
      positionen: [
        { posnr: '1', beschreibung: 'Walze GGG-70', menge: 2, einheit: 'Stk', einzelpreis: 2100, rabatt: 0, mwst: 0 },
      ],
    },
  },
  {
    name: 'wgc_ausfuhr_CH_G',
    data: {
      ...WGC,
      kaeufer: 'Burckhardt Beispiel AG', kaeuferstrasse: 'Industriestrasse 20',
      kaeuferplz: '8005', kaeuferstadt: 'Zuerich', kaeuferland: 'CH',
      kaeufermail: 'kreditoren@burckhardt-beispiel.ch', kaeufervat: '',
      rechnungsnummer: '4260903', rechnungsdatum: '2026-09-01', lieferdatum: '2026-08-27',
      faelligkeitsdatum: '2026-10-01', zahlungsreferenz: '4260903',
      notiz: 'Steuerfreie Ausfuhrlieferung in ein Drittland.',
      steuerkategorie: 'G', befreiungsgrund: 'Ausfuhrlieferung',
      positionen: [
        { posnr: '1', beschreibung: 'Hartgusswalze, roh', menge: 1, einheit: 'Stk', einzelpreis: 4800, rabatt: 0, mwst: 0 },
      ],
    },
  },
  {
    name: 'wgc_reverse_charge_AE',
    data: {
      ...WGC,
      kaeufer: 'Inland Reverse GmbH', kaeuferstrasse: 'Baustrasse 3',
      kaeuferplz: '01067', kaeuferstadt: 'Dresden', kaeuferland: 'DE',
      kaeufermail: 'ap@inland-reverse.de', kaeufervat: 'DE812345670',
      rechnungsnummer: '4260904', rechnungsdatum: '2026-09-01', lieferdatum: '2026-08-31',
      faelligkeitsdatum: '2026-10-01', zahlungsreferenz: '4260904',
      notiz: 'Steuerschuldnerschaft des Leistungsempfaengers (Reverse Charge, § 13b UStG).',
      steuerkategorie: 'AE', befreiungsgrund: 'Reverse Charge',
      positionen: [
        { posnr: '1', beschreibung: 'Bauleistung Stahlbau', menge: 1, einheit: 'Pausch.', einzelpreis: 7500, rabatt: 0, mwst: 0 },
      ],
    },
  },
  {
    name: 'wgc_mwst_gemischt_19_7',
    data: {
      ...WGC,
      kaeufer: 'Gemischt Handel GmbH', kaeuferstrasse: 'Marktstrasse 9',
      kaeuferplz: '04109', kaeuferstadt: 'Leipzig', kaeuferland: 'DE',
      kaeufermail: 'rechnung@gemischt.de', kaeufervat: 'DE246813570',
      rechnungsnummer: '4260905', rechnungsdatum: '2026-09-01', lieferdatum: '2026-08-30',
      faelligkeitsdatum: '2026-10-01', zahlungsreferenz: '4260905',
      notiz: 'Zahlung: 30 Tage netto.', steuerkategorie: 'S', befreiungsgrund: '',
      positionen: [
        { posnr: '1', beschreibung: 'Gussteil (19 %)', menge: 10, einheit: 'Stk', einzelpreis: 120, rabatt: 0, mwst: 19 },
        { posnr: '2', beschreibung: 'Fachliteratur/Doku (7 %)', menge: 1, einheit: 'Stk', einzelpreis: 80, rabatt: 0, mwst: 7 },
      ],
    },
  },
  {
    name: 'wgc_rabatt_skonto',
    data: {
      ...WGC,
      kaeufer: 'Rabatt Kunde GmbH', kaeuferstrasse: 'Rabattweg 2',
      kaeuferplz: '01097', kaeuferstadt: 'Dresden', kaeuferland: 'DE',
      kaeufermail: 'ek@rabatt-kunde.de', kaeufervat: 'DE135792460',
      rechnungsnummer: '4260906', rechnungsdatum: '2026-09-01', lieferdatum: '2026-08-29',
      faelligkeitsdatum: '2026-10-15', zahlungsreferenz: '4260906',
      notiz: 'Zahlung: 3 % Skonto innerhalb 10 Tagen (bis 11.09.2026), rein netto bis 15.10.2026.',
      steuerkategorie: 'S', befreiungsgrund: '',
      positionen: [
        { posnr: '1', beschreibung: 'Walze mit Positionsrabatt', menge: 5, einheit: 'Stk', einzelpreis: 1000, rabatt: 10, mwst: 19 },
        { posnr: '2', beschreibung: 'Bearbeitung', menge: 8, einheit: 'h', einzelpreis: 85, rabatt: 0, mwst: 19 },
      ],
    },
  },
  {
    name: 'wgc_grosse_liste_30pos',
    data: {
      ...WGC,
      kaeufer: 'Grossauftrag AG', kaeuferstrasse: 'Logistikpark 1',
      kaeuferplz: '39104', kaeuferstadt: 'Magdeburg', kaeuferland: 'DE',
      kaeufermail: 'kreditoren@grossauftrag.de', kaeufervat: 'DE998877665',
      rechnungsnummer: '4260907', rechnungsdatum: '2026-09-01', lieferdatum: '2026-08-25',
      faelligkeitsdatum: '2026-10-01', zahlungsreferenz: '4260907',
      notiz: 'Sammelrechnung.', steuerkategorie: 'S', befreiungsgrund: '',
      positionen: Array.from({ length: 30 }, (_, i) => ({
        posnr: String(i + 1), beschreibung: 'Gussteil Typ ' + (i + 1) + ' nach Zeichnung',
        menge: (i % 5) + 1, einheit: 'Stk', einzelpreis: 90 + i * 3, rabatt: 0, mwst: 19,
      })),
    },
  },
  {
    name: 'shb_innergemeinschaftlich_FR_K',
    data: {
      ...SHB,
      kaeufer: 'Fonderie Exemple SARL', kaeuferstrasse: 'Rue de la Fonderie 12',
      kaeuferplz: '59000', kaeuferstadt: 'Lille', kaeuferland: 'FR',
      kaeufermail: 'compta@fonderie-exemple.fr', kaeufervat: 'FR12345678901',
      rechnungsnummer: '5100778', rechnungsdatum: '2026-09-01', lieferdatum: '2026-08-28',
      faelligkeitsdatum: '2026-10-01', zahlungsreferenz: '5100778',
      notiz: 'Livraison intracommunautaire exonérée (art. 138 directive TVA).',
      steuerkategorie: 'K', befreiungsgrund: 'Innergemeinschaftliche Lieferung',
      positionen: [
        { posnr: '1', beschreibung: 'Hartgussteil', menge: 6, einheit: 'Stk', einzelpreis: 210, rabatt: 0, mwst: 0 },
      ],
    },
  },
  {
    name: 'wgc_rechnungskorrektur_384',
    data: {
      ...WGC, rechnungsart: '384',
      kaeufer: 'Muster Maschinenbau GmbH', kaeuferstrasse: 'Industriestrasse 10',
      kaeuferplz: '44869', kaeuferstadt: 'Bochum', kaeuferland: 'DE',
      kaeufermail: 'kreditoren@muster.de', kaeufervat: 'DE123456789',
      rechnungsnummer: '4260908', rechnungsdatum: '2026-09-02', lieferdatum: '2026-08-28',
      faelligkeitsdatum: '2026-10-02', zahlungsreferenz: '4260908',
      notiz: 'Rechnungskorrektur zur Rechnung 4260901 (Mengenkorrektur).', steuerkategorie: 'S', befreiungsgrund: '',
      positionen: [
        { posnr: '1', beschreibung: 'Walze GGG-70 (Korrektur Menge)', menge: 3, einheit: 'Stk', einzelpreis: 1250, rabatt: 0, mwst: 19 },
      ],
    },
  },
  {
    name: 'wgc_gutschrift_381',
    data: {
      ...WGC, rechnungsart: '381',
      kaeufer: 'Muster Maschinenbau GmbH', kaeuferstrasse: 'Industriestrasse 10',
      kaeuferplz: '44869', kaeuferstadt: 'Bochum', kaeuferland: 'DE',
      kaeufermail: 'kreditoren@muster.de', kaeufervat: 'DE123456789',
      rechnungsnummer: 'GS-4260909', rechnungsdatum: '2026-09-02', lieferdatum: '2026-08-28',
      faelligkeitsdatum: '2026-10-02', zahlungsreferenz: 'GS-4260909',
      notiz: 'Kaufmaennische Gutschrift (Reklamation).', steuerkategorie: 'S', befreiungsgrund: '',
      positionen: [
        { posnr: '1', beschreibung: 'Gutschrift Reklamation Walze', menge: 1, einheit: 'Stk', einzelpreis: 400, rabatt: 0, mwst: 19 },
      ],
    },
  },
];

/* ── Erzeugen ── */
(async () => {
  const results = [];
  for (const s of SAMPLES) {
    const totals = xr.calcTotals(s.data.positionen);

    // XRechnung (reines XML)
    const xml = xr.buildXML(s.data, 'xrechnung');
    fs.writeFileSync(path.join(OUT, `${s.name}_xrechnung.xml`), '﻿' + xml, 'utf8');

    // ZUGFeRD (PDF aus Daten gerendert + XML eingebettet = garantiert PDF≡XML)
    const zugXml = xr.buildXML(s.data, 'zugferd');
    const pdfData = {
      ...s.data, netTotal: totals.netTotal, vatTotal: totals.vatTotal, grossTotal: totals.grossTotal,
      positionen: s.data.positionen.map(p => ({ ...p, gesamt: p.menge * p.einzelpreis * (1 - (p.rabatt || 0) / 100) })),
    };
    // Ein Fall erhaelt Zusatzangaben -> erzeugt Seite 2 (prueft 2-seitiges PDF/A)
    if (s.name === 'wgc_standard_19') {
      pdfData.weitere = [
        { group: 'Referenzen', label: 'Lieferschein-Nr. (BT-16)', value: 'LS-2026-001' },
        { group: 'Steueraufschluesselung', label: 'S · 19 %', value: 'Basis 5.300,00 € · Steuer 1.007,00 €' },
      ];
      pdfData.positionen[0] = { ...pdfData.positionen[0], note: 'Testhinweis zur Position (BT-127).', posExtra: [{ label: 'Warennr./HS (BT-158)', value: '82090020' }] };
    }
    const renderedPdf = await xp.buildInvoicePdf(pdfData);
    const zugferdPdf = await zf.embedXMLIntoPDF(renderedPdf, zugXml, 'zugferd');
    fs.writeFileSync(path.join(OUT, `${s.name}_zugferd.pdf`), Buffer.from(zugferdPdf));

    // Reines PDF/A-3b wie es die API liefert (XML -> PDF, ohne eingebettetes XML)
    const readablePdf = await zf.makeReadablePdfA3(renderedPdf);
    fs.writeFileSync(path.join(OUT, `${s.name}_readable_pdfa.pdf`), Buffer.from(readablePdf));

    results.push({ name: s.name, gross: totals.grossTotal, kat: s.data.steuerkategorie,
      xmlBytes: Buffer.byteLength(xml), pdfBytes: zugferdPdf.length });
  }
  console.table(results);
  console.log(`\n${results.length} Fälle → ${OUT}`);
})().catch(e => { console.error(e); process.exit(1); });

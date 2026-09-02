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
const zf = loadHost('js/zugferd.js', ['embedXMLIntoPDF']);

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
    const renderedPdf = await xp.buildInvoicePdf(pdfData);
    const zugferdPdf = await zf.embedXMLIntoPDF(renderedPdf, zugXml, 'zugferd');
    fs.writeFileSync(path.join(OUT, `${s.name}_zugferd.pdf`), Buffer.from(zugferdPdf));

    results.push({ name: s.name, gross: totals.grossTotal, kat: s.data.steuerkategorie,
      xmlBytes: Buffer.byteLength(xml), pdfBytes: zugferdPdf.length });
  }
  console.table(results);
  console.log(`\n${results.length} Fälle → ${OUT}`);
})().catch(e => { console.error(e); process.exit(1); });

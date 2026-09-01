'use strict';
/**
 * Lokaler Smoketest OHNE Azure-Runtime:
 *   node scripts/sync.js && node test/run.js
 * Konvertiert test/sample-cii.xml und schreibt test/out.pdf.
 */
const fs = require('fs');
const path = require('path');
const { convertXmlToPdf, healthInfo } = require('../src/converter');

(async () => {
  console.log('health:', JSON.stringify(healthInfo().status));

  const xml = fs.readFileSync(path.join(__dirname, 'sample-cii.xml'), 'utf8');
  const { data, pdf } = await convertXmlToPdf(xml);

  const header = Buffer.from(pdf.slice(0, 5)).toString('latin1');
  const okHeader = header === '%PDF-';
  const outPath = path.join(__dirname, 'out.pdf');
  fs.writeFileSync(outPath, Buffer.from(pdf));

  console.log('--- geparste Daten ---');
  console.log('Syntax:        ', data.syntax);
  console.log('Rechnungsnr.:  ', data.rechnungsnummer);
  console.log('Verkaeufer:    ', data.verkaeufer);
  console.log('Kaeufer:       ', data.kaeufer);
  console.log('Positionen:    ', (data.positionen || []).length);
  console.log('Netto/MwSt/Brutto:', data.netTotal, data.vatTotal, data.grossTotal);
  console.log('Faellig am:    ', data.faelligkeitsdatum);
  console.log('IBAN:          ', data.iban);
  console.log('----------------------');
  console.log('PDF-Header %PDF-:', okHeader);
  console.log('PDF-Groesse:   ', Buffer.from(pdf).length, 'Bytes');
  console.log('geschrieben:   ', outPath);

  const problems = [];
  if (!okHeader) problems.push('PDF-Header fehlt');
  if (Buffer.from(pdf).length < 1000) problems.push('PDF verdaechtig klein');
  if (data.syntax !== 'CII') problems.push('Syntax nicht CII');
  if ((data.positionen || []).length !== 2) problems.push('Positionsanzahl != 2');
  if (Math.abs((data.grossTotal || 0) - 6307) > 0.001) problems.push('Bruttosumme falsch');

  if (problems.length) {
    console.error('FEHLGESCHLAGEN:', problems.join(' | '));
    process.exit(1);
  }
  console.log('OK - alle Pruefungen bestanden.');
})().catch(err => {
  console.error('EXCEPTION:', err);
  process.exit(1);
});

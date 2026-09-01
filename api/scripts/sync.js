'use strict';
/**
 * Kopiert die im Browser genutzten Konverter-Module aus ../js nach ./vendor,
 * damit die Azure Function EXAKT denselben Code ausfuehrt wie die Web-App.
 * Vor jedem Deploy und lokalen Start ausfuehren (npm run sync / prestart).
 */
const fs = require('fs');
const path = require('path');

const SRC = path.join(__dirname, '..', '..', 'js');   // e-rechnung/js
const DST = path.join(__dirname, '..', 'vendor');     // e-rechnung/api/vendor
const FILES = ['xmlinvoice.js', 'xml2pdf.js'];

fs.mkdirSync(DST, { recursive: true });

let updated = 0;
for (const f of FILES) {
  const from = path.join(SRC, f);
  const to = path.join(DST, f);
  if (fs.existsSync(from)) {
    fs.copyFileSync(from, to);
    console.log(`sync: ${f}  aktualisiert`);
    updated++;
  } else if (fs.existsSync(to)) {
    console.warn(`sync: ${f}  - Quelle nicht gefunden, vorhandene vendor-Kopie bleibt.`);
  } else {
    console.error(`sync: ${f}  FEHLT (weder Quelle noch vendor-Kopie)!`);
    process.exitCode = 1;
  }
}
console.log(`sync: ${updated}/${FILES.length} Datei(en) nach vendor/ kopiert.`);

// node tests/cache-version.test.js
// Jede lokale Einbindung in den HTML-Seiten trägt die Prüfsumme der Datei (scripts/cache-version.js)
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { mitVersionen, veraltet } = require('../scripts/cache-version.js');

let n = 0;
const gleich = (ist, soll, m) => { assert.deepStrictEqual(ist, soll, m + ': ' + JSON.stringify(ist)); n++; };

// 1) Testordner: Version wird gesetzt, ersetzt und bei gleichem Inhalt mit CRLF nicht geändert
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cv-'));
fs.mkdirSync(path.join(tmp, 'js'));
fs.writeFileSync(path.join(tmp, 'js', 'a.js'), 'let a = 1;\n');
const html = '<script src="js/a.js"></script><script src="https://cdn.example/x.js"></script><script src="js/fehlt.js"></script>';
const mit = mitVersionen(html, tmp);
gleich(/src="js\/a\.js\?v=[0-9a-f]{10}"/.test(mit), true, 'Version angehängt');
gleich(mit.includes('https://cdn.example/x.js"'), true, 'fremde Adressen bleiben');
gleich(mit.includes('src="js/fehlt.js"'), true, 'fehlende Datei bleibt ohne Version');
gleich(mitVersionen(mit, tmp), mit, 'zweiter Lauf ändert nichts');
fs.writeFileSync(path.join(tmp, 'js', 'a.js'), 'let a = 1;\r\n');
gleich(mitVersionen(mit, tmp), mit, 'CRLF ergibt dieselbe Version');
fs.writeFileSync(path.join(tmp, 'js', 'a.js'), 'let a = 2;\n');
gleich(mitVersionen(mit, tmp) !== mit, true, 'geänderte Datei bekommt neue Version');
fs.rmSync(tmp, { recursive: true, force: true });

// 2) Die echten Seiten sind aktuell (sonst: node scripts/cache-version.js)
gleich(veraltet(), [], 'Versionen in den HTML-Seiten aktuell');

console.log(`cache-version: ${n} Prüfungen grün`);

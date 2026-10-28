#!/usr/bin/env node
/**
 * Versionsnummern an Skripten und Stylesheets (Cache-Busting)
 * ===========================================================
 * GitHub Pages lässt Dateien bis zu 10 Minuten im Browser-Cache. Nach einer Änderung
 * kann ein Browser sonst eine Mischung aus alten und neuen Skripten laden. Dieses
 * Skript hängt an jede lokale Einbindung in den HTML-Seiten (js/…, css/…) ein
 * `?v=<Prüfsumme>` an. Ändert sich eine Datei, ändert sich ihre Adresse, und der
 * Browser holt sie neu. Unveränderte Dateien bleiben im Cache.
 *
 *   node scripts/cache-version.js            Versionen in allen *.html setzen
 *   node scripts/cache-version.js --pruefen  nur prüfen, Exit 1 wenn etwas veraltet ist
 *
 * Die Prüfsumme wird über den Inhalt mit LF-Zeilenenden gebildet, damit beide
 * Rechner (CRLF/LF) dieselbe Nummer bekommen.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const WURZEL = path.join(__dirname, '..');
const EINBINDUNG = /(src|href)="((?:js|css)\/[^"?#]+\.(?:js|css))(?:\?v=[0-9a-f]*)?"/g;

function pruefsumme(datei) {
  const inhalt = fs.readFileSync(datei, 'utf8').replace(/\r\n/g, '\n');
  return crypto.createHash('sha256').update(inhalt).digest('hex').slice(0, 10);
}

/** Seite mit aktuellen Versionen; fehlende Dateien bleiben unverändert. */
function mitVersionen(html, wurzel) {
  return html.replace(EINBINDUNG, (ganz, attr, pfad) => {
    const datei = path.join(wurzel, pfad);
    if (!fs.existsSync(datei)) return ganz;
    return `${attr}="${pfad}?v=${pruefsumme(datei)}"`;
  });
}

/** HTML-Seiten im Hauptordner, ohne Testseiten (_*.html). */
function seiten(wurzel) {
  return fs.readdirSync(wurzel).filter(f => /\.html$/i.test(f) && !f.startsWith('_')).map(f => path.join(wurzel, f));
}

/** @returns {string[]} Seiten, deren Versionen nicht stimmen */
function veraltet(wurzel = WURZEL) {
  return seiten(wurzel).filter(s => {
    const html = fs.readFileSync(s, 'utf8');
    return mitVersionen(html, wurzel) !== html;
  }).map(s => path.basename(s));
}

if (require.main === module) {
  if (process.argv.includes('--pruefen')) {
    const alt = veraltet();
    if (alt.length) {
      console.error('Versionen veraltet in: ' + alt.join(', ') + '. Bitte node scripts/cache-version.js ausführen.');
      process.exit(1);
    }
    console.log('Versionen aktuell.');
  } else {
    let n = 0;
    for (const s of seiten(WURZEL)) {
      const html = fs.readFileSync(s, 'utf8');
      const neu = mitVersionen(html, WURZEL);
      if (neu !== html) { fs.writeFileSync(s, neu); n++; console.log('aktualisiert: ' + path.basename(s)); }
    }
    console.log(n ? `${n} Seite(n) aktualisiert.` : 'Alles aktuell.');
  }
}

module.exports = { mitVersionen, veraltet, pruefsumme };

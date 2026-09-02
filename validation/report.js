'use strict';
/**
 * Erzeugt einen Konformitätsbericht (Markdown) aus den Validator-Reports.
 * Wird in der CI nach KoSIT/veraPDF/Mustang aufgerufen und nach
 * $GITHUB_STEP_SUMMARY + reports/KONFORMITAET.md geschrieben.
 *
 * Liest:
 *   reports/kosit/<fall>_xrechnung-report.xml  (KoSIT: akzeptiert/abgelehnt)
 *   reports/verapdf.txt                         (veraPDF: PASS/FAIL je PDF)
 *   reports/mustang.txt                         (Mustang: valid/invalid je PDF; optional)
 */
const fs = require('fs');
const path = require('path');

const CWD = process.cwd();
const OUT = path.join(CWD, 'validation', 'out');
const REP = path.join(CWD, 'reports');
const env = process.env;

function samples() {
  try {
    return fs.readdirSync(OUT)
      .filter(f => f.endsWith('_xrechnung.xml'))
      .map(f => f.replace('_xrechnung.xml', ''))
      .sort();
  } catch { return []; }
}

function kositStatus(s) {
  const f = path.join(REP, 'kosit', `${s}_xrechnung-report.xml`);
  if (!fs.existsSync(f)) return '–';
  const t = fs.readFileSync(f, 'utf8');
  return /<[a-z:]*reject|accepted="false"|>rejected</i.test(t) ? '❌ abgelehnt' : '✅ akzeptiert';
}

function mapFrom(file, re) {
  const m = {};
  const f = path.join(REP, file);
  if (fs.existsSync(f)) {
    for (const line of fs.readFileSync(f, 'utf8').split(/\r?\n/)) {
      const hit = re(line);
      if (hit) m[hit.name] = hit.status;
    }
  }
  return m;
}

const verapdf = mapFrom('verapdf.txt', line => {
  const mt = line.match(/^(PASS|FAIL)\s+.*?([^/\\]+)_zugferd\.pdf/);
  return mt ? { name: mt[2], status: mt[1] === 'PASS' ? '✅ PASS' : '❌ FAIL' } : null;
});

const mustang = mapFrom('mustang.txt', line => {
  const mt = line.match(/^(.*?):\s*(valid|invalid|n\/a)/i);
  if (!mt) return null;
  const st = /^valid/i.test(mt[2]) ? '✅ valid' : (/invalid/i.test(mt[2]) ? '❌ invalid' : '–');
  return { name: mt[1].trim(), status: st };
});

const now = new Date().toISOString().replace('T', ' ').slice(0, 16) + ' UTC';
const sha = (env.GITHUB_SHA || 'lokal').slice(0, 8);
const rows = samples().map(s =>
  `| \`${s}\` | ${kositStatus(s)} | ${verapdf[s] || '–'} | ${mustang[s] || '–'} |`);

const md = `# Konformitätsbericht — DIHAG E-Rechnung

**Datum:** ${now}
**Commit:** \`${sha}\`
**Prüfwerkzeuge:** KoSIT-Validator ${env.KOSIT_VALIDATOR_VER || '?'} · XRechnung-Konfiguration ${env.KOSIT_CONFIG_LABEL || 'release 2024-06-20 (XRechnung 3.0.2)'} · veraPDF ${env.VERAPDF_VER || '?'} · Mustangproject ${env.MUSTANG_VER || 'n/a'}

| Fall | KoSIT (XRechnung / EN 16931) | veraPDF (PDF/A-3b) | Mustang (ZUGFeRD) |
|------|------------------------------|--------------------|-------------------|
${rows.join('\n')}

Geprüft werden mit dem echten Konverter erzeugte Musterrechnungen (Modus „PDF aus Daten").
KoSIT + veraPDF sind der verbindliche Gate; Mustangproject läuft zusätzlich/informativ.
Automatisch erzeugt von \`validation/report.js\`.
`;

process.stdout.write(md);

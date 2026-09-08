'use strict';
/**
 * Schlanker HTTP-Wrapper um die veraPDF-CLI.
 *   GET  /   -> JSON-Info (Health)
 *   POST /   -> Body = PDF, Antwort = JSON { konform, flavour, compliant, meldungen[] }
 * Ruft `verapdf --flavour <F> --format mrr <tmp>` auf und wertet den
 * Machine-Readable-Report (MRR) aus (isCompliant + fehlgeschlagene Regeln).
 */
const http = require('http');
const { spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const VERAPDF = process.env.VERAPDF_BIN || '/opt/verapdf/verapdf';
const FLAVOUR = process.env.VERAPDF_FLAVOUR || '3b';
const PORT = parseInt(process.env.PORT || '8080', 10);

http.createServer((req, res) => {
  if (req.method === 'GET') {
    return json(res, 200, { service: 'veraPDF', flavour: 'PDF/A-' + FLAVOUR, bin: VERAPDF });
  }
  if (req.method !== 'POST') return json(res, 405, { error: 'Nur GET/POST.' });

  const chunks = [];
  let size = 0;
  req.on('data', c => { size += c.length; if (size <= 64 * 1024 * 1024) chunks.push(c); });
  req.on('end', () => {
    const buf = Buffer.concat(chunks);
    if (!buf.length || buf.subarray(0, 8).toString('latin1').indexOf('%PDF-') === -1) {
      return json(res, 400, { error: 'Bitte ein PDF als Body senden.' });
    }
    const tmp = path.join(os.tmpdir(), 'in_' + process.pid + '_' + Date.now() + '.pdf');
    try {
      fs.writeFileSync(tmp, buf);
      const r = spawnSync(VERAPDF, ['--flavour', FLAVOUR, '--format', 'mrr', tmp],
        { maxBuffer: 128 * 1024 * 1024, encoding: 'utf8' });
      const mrr = r.stdout || '';
      if (!mrr.trim()) {
        return json(res, 502, { konform: 'ungeprueft', error: 'veraPDF ohne Ausgabe: ' + String(r.stderr || '').slice(0, 300) });
      }
      return json(res, 200, parseMrr(mrr, FLAVOUR));
    } catch (e) {
      return json(res, 500, { error: String((e && e.message) || e) });
    } finally {
      try { fs.unlinkSync(tmp); } catch (_) { /* ignore */ }
    }
  });
}).listen(PORT, '0.0.0.0', () => console.log('veraPDF-Wrapper auf :' + PORT + ' (Flavour ' + FLAVOUR + ')'));

function parseMrr(mrr, flavour) {
  const compliant = /isCompliant="true"/i.test(mrr) && !/isCompliant="false"/i.test(mrr);
  const failures = [];
  const re = /<rule\b([^>]*?)>/gi;
  let m;
  while ((m = re.exec(mrr)) && failures.length < 60) {
    const a = m[1];
    if (!/status="failed"/i.test(a)) continue;
    const clause = (a.match(/clause="([^"]*)"/i) || ['', ''])[1];
    const test = (a.match(/testNumber="([^"]*)"/i) || ['', ''])[1];
    const label = (clause ? 'Clause ' + clause : '') + (test ? ' Test ' + test : '');
    if (label.trim()) failures.push(label.trim());
  }
  return {
    konform: compliant ? 'ok' : 'fehler',
    flavour: 'PDF/A-' + flavour,
    compliant,
    meldungen: Array.from(new Set(failures)).slice(0, 40),
  };
}

function json(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(body) });
  res.end(body);
}

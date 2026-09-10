/**
 * Rechnungsmonitoring
 * ===================
 * Liest ALLE Rechnungsbibliotheken (ERAR_<Werk> = Eingang, AR_<Werk> = Ausgang)
 * einer eigenen SharePoint-Site aus, aggregiert die Positionen und zeigt
 * KPI-Kacheln + filterbare Tabelle. Nutzt die vorhandene Auth/Graph-Infrastruktur
 * (auth.js, sharepoint.js: acquireToken, SP, _get).
 *
 * Provisionierung der Bibliotheken: scripts/provision-rechnungsmonitoring.ps1
 */

const MON = {
  // MUSS zur provisionierten Site passen (Format: host:/sites/<Name>).
  siteHost: 'dihag.sharepoint.com:/sites/Rechnungsmonitoring',
  libRe: /^(ERAR|AR)_(.+)$/i,   // ERAR_WGC, AR_SHB, ...
  intakeRe: /^Rechnungseingang$/i, // zentrale Eingangsstufe (werkuebergreifend)
  maxPagesPerLib: 30,            // Sicherheitslimit: 30 x 200 = 6000 Items je Bibliothek
};

let _monRecords = [];
const _monFilter = { werk: '', richtung: '', status: '', format: '', q: '' };

/* ── Laden ──────────────────────────────────────────────────────────── */

async function loadMonitoring(accessList) {
  const sub = document.getElementById('mon-subtitle');
  if (sub) sub.textContent = 'Rechnungsbibliotheken werden geladen…';

  try {
    const token = await acquireToken(SP.scopes);
    if (!token) return; // Redirect zu Microsoft läuft

    // Site auflösen
    let site;
    try {
      site = await _get(`${SP.graphBase}/sites/${MON.siteHost}`, token);
    } catch (e) {
      return _monShowSetup('Monitoring-Site nicht gefunden',
        `Erwartet: ${MON.siteHost}. Site im Admin-Center anlegen und `
        + `scripts/provision-rechnungsmonitoring.ps1 ausführen.`);
    }
    const siteId = site.id;

    // Bibliotheken der Site ermitteln
    const listsRes = await _get(
      `${SP.graphBase}/sites/${siteId}/lists?$select=id,name,displayName,list&$top=200`, token);

    const allow = new Set((accessList || []).map(s => String(s).toLowerCase()));
    const libs = (listsRes.value || [])
      .map(l => {
        const nm = l.name || l.displayName || '';
        const m = MON.libRe.exec(nm);
        if (m) {
          return {
            id: l.id, name: nm,
            richtung: m[1].toUpperCase() === 'ERAR' ? 'Eingang' : 'Ausgang',
            werk: m[2].toUpperCase(),
          };
        }
        // Zentrale Eingangsstufe: Werk noch nicht bekannt (wird beim Einsortieren gesetzt).
        if (MON.intakeRe.test(nm)) {
          return { id: l.id, name: nm, richtung: 'Eingang', werk: '', intake: true };
        }
        return null;
      })
      .filter(Boolean)
      // Zugriffsfilter greift nur fuer Werk-Bibliotheken; die Eingangsstufe ist
      // werkuebergreifend und immer sichtbar (SharePoint-Rechte gaten den Zugriff).
      .filter(l => l.intake || allow.size === 0 || allow.has(l.werk.toLowerCase()));

    if (!libs.length) {
      return _monShowSetup('Keine Rechnungsbibliotheken vorhanden',
        'Auf der Site wurden keine Bibliotheken ERAR_<Werk> / AR_<Werk> gefunden '
        + '(bzw. keine, auf die Sie Zugriff haben). Provisionierungsskript ausführen.');
    }

    // Positionen aller Bibliotheken einsammeln
    const recs = [];
    for (const lib of libs) {
      let url = `${SP.graphBase}/sites/${siteId}/lists/${lib.id}/items?$expand=fields&$top=200`;
      let pages = 0;
      while (url && pages < MON.maxPagesPerLib) {
        const page = await _get(url, token);
        for (const it of (page.value || [])) {
          const f = it.fields || {};
          if (!f.FileLeafRef && !f.Title) continue;         // Ordner / Leerzeilen überspringen
          recs.push(_monMap(it, f, lib));
        }
        url = page['@odata.nextLink'] || null;
        pages++;
      }
    }

    // XML + PDF + KoSIT-Bericht derselben Rechnung zu EINER Zeile zusammenfassen.
    _monRecords = _monGroup(recs);
    _monBuildFilterOptions(libs);
    _monApply();

    if (sub) sub.textContent =
      `${_monRecords.length} Rechnung(en) (${recs.length} Datei(en)) aus ${libs.length} Bibliothek(en) · Stand ${new Date().toLocaleString('de-DE')}`;
    const setup = document.getElementById('mon-setup');
    if (setup) setup.style.display = 'none';
    document.getElementById('mon-body').style.display = '';
  } catch (e) {
    _monShowSetup('Fehler beim Laden', e.message || String(e));
  }
}

function _monMap(it, f, lib) {
  const num = v => (typeof v === 'number' ? v : (v == null || v === '' ? null : parseFloat(v)));

  // Dateiname zerlegen: Endung + Sidecar-Typ (KoSIT-Bericht / lesbares PDF) erkennen,
  // damit XML, PDF und Bericht derselben Rechnung zusammengefasst werden können.
  const file = String(f.FileLeafRef || '');
  const ext  = (file.match(/\.(pdf|xml)$/i) || ['', ''])[1].toLowerCase();
  let stem   = file.replace(/\.(pdf|xml)$/i, '');
  let sidecar = '';
  if (/_kosit-?bericht$/i.test(stem)) { sidecar = 'kosit';  stem = stem.replace(/_kosit-?bericht$/i, ''); }
  else if (/_lesbar$/i.test(stem))    { sidecar = 'lesbar'; stem = stem.replace(/_lesbar$/i, ''); }

  // baseKey = Dateiname ohne Endung/Sidecar/Datum -> Gruppierungsschlüssel.
  // (Title ist im Flow oft leer ODER der ganze Dateiname -> zum Gruppieren untauglich.)
  const baseKey = stem.replace(/_\d{6,8}$/, '');
  const titleClean = (f.Title && String(f.Title).trim()) || '';
  // Anzeige-Nr.: echter Title (ohne Dateiendung/Sidecar-Suffix) sonst baseKey.
  const nummer = (titleClean && !/\.(pdf|xml)$/i.test(titleClean) && !/_kosit-?bericht$|_lesbar$/i.test(titleClean))
    ? titleClean : baseKey;
  return {
    file, ext, sidecar, baseKey,
    // Werk aus dem Bibliotheksnamen (AR_SHB -> SHB) = maessgeblich; das Feld
    // Gesellschaft kann leer/falsch sein und wird nur als Fallback genutzt.
    // Eingangsstufe: Werk erst nach Erkennung (Gesellschaft) bekannt, sonst "(Eingang)".
    werk:     (lib.werk || f.Gesellschaft || (lib.intake ? '(Eingang)' : '')).toString(),
    intake:   !!lib.intake,
    richtung: (lib.richtung || f.Richtung || '').toString(),
    nummer,
    art:      (f.Rechnungsart || '').toString(),
    steller:  (f.Rechnungssteller || '').toString(),
    empf:     (f.Rechnungsempfaenger || '').toString(),
    brutto:   num(f.Bruttobetrag),
    waehrung: (f.Waehrung || 'EUR').toString(),
    datum:    (f.Rechnungsdatum || f.Eingangszeitpunkt || it.createdDateTime || '').toString(),
    format:   (f.Format || '').toString(),
    status:   (f.Verarbeitungsstatus || '').toString(),
    konform:  (f.Konformitaet || '').toString(),
    fehler:   (f.Fehlermeldung || '').toString(),
    url:      (it.webUrl || '').toString(),
  };
}

/* ── Zusammenfassen: XML + PDF + KoSIT-Bericht einer Rechnung = 1 Zeile ── */

function _monGroup(recs) {
  const groups = new Map();
  for (const r of recs) {
    const key = [r.werk, r.richtung, (r.baseKey || r.file || '').toLowerCase()].join('|');
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(r);
  }
  const out = [];
  for (const arr of groups.values()) {
    const primaries = arr.filter(r => !r.sidecar);
    const primary = _monBestPrimary(primaries.length ? primaries : arr);

    // Verknüpfte Dateien der Rechnung (die anderen Repräsentationen + Bericht).
    primary.dateien = [];
    for (const r of arr) {
      if (r === primary || !r.url) continue;
      const label = r.sidecar === 'kosit' ? 'KoSIT-Bericht'
                  : r.sidecar === 'lesbar' ? 'Lesbares PDF'
                  : (r.ext ? r.ext.toUpperCase() : 'Datei');
      primary.dateien.push({ label, url: r.url });
    }
    // Metadaten aus Geschwisterdateien auffüllen, falls die Primärzeile sie nicht hat.
    for (const key of ['steller', 'empf', 'format', 'status', 'konform', 'fehler']) {
      if (!primary[key]) { const s = arr.find(r => r[key]); if (s) primary[key] = s[key]; }
    }
    if (primary.brutto == null) { const s = arr.find(r => r.brutto != null); if (s) primary.brutto = s.brutto; }
    // "öffnen" muss immer eine Datei treffen: hat die Primärzeile keine URL,
    // die erste verfügbare Geschwisterdatei nehmen.
    if (!primary.url) { const s = arr.find(r => r.url); if (s) primary.url = s.url; }
    out.push(primary);
  }
  return out;
}

// Beste Primärzeile: die mit den meisten Metadaten; bei Gleichstand PDF vor XML.
function _monBestPrimary(arr) {
  const score = r => (r.steller ? 2 : 0) + (r.empf ? 2 : 0) + (r.brutto != null ? 1 : 0)
                   + (r.format ? 1 : 0) + (r.konform ? 1 : 0) + (r.ext === 'pdf' ? 0.5 : 0);
  return arr.slice().sort((a, b) => score(b) - score(a))[0];
}

/* ── Filter & Rendering ─────────────────────────────────────────────── */

function _monBuildFilterOptions(libs) {
  const werke = Array.from(new Set(libs.map(l => l.werk))).sort();
  const status = Array.from(new Set(_monRecords.map(r => r.status).filter(Boolean))).sort();
  const formate = Array.from(new Set(_monRecords.map(r => r.format).filter(Boolean))).sort();
  _fillSelect('mon-f-werk', werke, 'Alle Werke');
  _fillSelect('mon-f-status', status, 'Alle Status');
  _fillSelect('mon-f-format', formate, 'Alle Formate');
}

function _fillSelect(id, values, allLabel) {
  const el = document.getElementById(id);
  if (!el) return;
  el.innerHTML = `<option value="">${allLabel}</option>`
    + values.map(v => `<option value="${_esc(v)}">${_esc(v)}</option>`).join('');
}

function _monApply() {
  const f = _monFilter;
  const q = f.q.trim().toLowerCase();
  const rows = _monRecords.filter(r =>
    (!f.werk || r.werk === f.werk) &&
    (!f.richtung || r.richtung === f.richtung) &&
    (!f.status || r.status === f.status) &&
    (!f.format || r.format === f.format) &&
    (!q || (r.nummer + ' ' + r.steller + ' ' + r.empf).toLowerCase().includes(q))
  );
  _monRenderKpis(rows);
  _monRenderTable(rows);
}

function _monRenderKpis(rows) {
  const total = rows.length;
  const eingang = rows.filter(r => r.richtung === 'Eingang').length;
  const ausgang = rows.filter(r => r.richtung === 'Ausgang').length;
  const offen = rows.filter(r => r.status && !['Gebucht', 'Archiviert'].includes(r.status)).length;
  const fehler = rows.filter(r => r.status === 'Fehler' || /^Rot/i.test(r.konform) || r.fehler).length;
  const summe = rows.reduce((s, r) => s + (r.brutto || 0), 0);

  const tiles = [
    ['Rechnungen gesamt', total, ''],
    ['Eingang', eingang, 'in'],
    ['Ausgang', ausgang, 'out'],
    ['Offen (nicht gebucht)', offen, 'warn'],
    ['Fehler / rot', fehler, 'bad'],
    ['Bruttosumme', summe.toLocaleString('de-DE', { style: 'currency', currency: 'EUR' }), 'sum'],
  ];
  document.getElementById('mon-kpis').innerHTML = tiles.map(([label, val, cls]) =>
    `<div class="mon-tile ${cls}"><div class="mon-tile-val">${_esc(String(val))}</div>`
    + `<div class="mon-tile-label">${_esc(label)}</div></div>`).join('');
}

function _monRenderTable(rows) {
  rows = rows.slice().sort((a, b) => (b.datum || '').localeCompare(a.datum || ''));
  const body = rows.map(r => {
    const betrag = r.brutto == null ? '' :
      r.brutto.toLocaleString('de-DE', { style: 'currency', currency: r.waehrung || 'EUR' });
    const datum = r.datum ? (r.datum.slice(0, 10)) : '';
    const richtCls = r.richtung === 'Eingang' ? 'pill-in' : 'pill-out';
    const kon = _monKonPill(r);
    const stat = r.status ? `<span class="pill pill-status">${_esc(r.status)}</span>` : '';
    const extra = (r.dateien || [])
      .map(d => `<a href="${_esc(d.url)}" target="_blank" rel="noopener">${_esc(d.label)} ↗</a>`)
      .join(' · ');
    const link = [
      r.url ? `<a href="${_esc(r.url)}" target="_blank" rel="noopener">öffnen ↗</a>` : '',
      extra,
    ].filter(Boolean).join(' · ');
    return `<tr>
      <td>${_esc(datum)}</td>
      <td><span class="pill pill-werk">${_esc(r.werk)}</span></td>
      <td><span class="pill ${richtCls}">${_esc(r.richtung)}</span></td>
      <td>${_esc(r.nummer)}</td>
      <td>${_esc(r.richtung === 'Eingang' ? r.steller : r.empf)}</td>
      <td style="text-align:right;white-space:nowrap;">${_esc(betrag)}</td>
      <td>${_esc(r.format)}</td>
      <td>${stat}</td>
      <td>${kon}</td>
      <td class="mon-err" title="${_esc(r.fehler)}">${_esc(r.fehler.slice(0, 60))}</td>
      <td>${link}</td>
    </tr>`;
  }).join('');

  document.getElementById('mon-tbody').innerHTML = body
    || `<tr><td colspan="11" style="text-align:center;color:var(--gray-500);padding:24px;">Keine Treffer.</td></tr>`;
  document.getElementById('mon-count').textContent = `${rows.length} angezeigt`;
}

function _monKonPill(r) {
  const v = (r.konform || '').toLowerCase();
  if (v.startsWith('gr')) return `<span class="pill pill-ok">grün</span>`;
  if (v.startsWith('gel')) return `<span class="pill pill-warn">gelb</span>`;
  if (v.startsWith('rot')) return `<span class="pill pill-bad">rot</span>`;
  return r.konform ? `<span class="pill">${_esc(r.konform)}</span>` : '';
}

function _monShowSetup(title, msg) {
  const body = document.getElementById('mon-body');
  if (body) body.style.display = 'none';
  const setup = document.getElementById('mon-setup');
  if (setup) {
    setup.style.display = '';
    setup.innerHTML = `<div class="mon-setup-card">
      <div style="font-size:34px;">🗂️</div>
      <h3>${_esc(title)}</h3>
      <p>${_esc(msg)}</p>
    </div>`;
  }
  const sub = document.getElementById('mon-subtitle');
  if (sub) sub.textContent = title;
}

/* ── Zugriff verweigert (analog Verlauf) ────────────────────────────── */

function monShowAccessDenied() {
  const sub = document.getElementById('mon-subtitle');
  if (sub) sub.textContent = 'Kein Zugriff';
  const body = document.getElementById('mon-body');
  if (body) body.style.display = 'none';
  _monShowSetup('Kein Zugriff auf das Rechnungsmonitoring',
    'Ihr Konto ist für keine Gesellschaft freigeschaltet. Bitte an die IT wenden.');
}

/* ── Filter-Events ──────────────────────────────────────────────────── */

function monInitFilterEvents() {
  const bind = (id, key) => {
    const el = document.getElementById(id);
    if (el) el.addEventListener('change', () => { _monFilter[key] = el.value; _monApply(); });
  };
  bind('mon-f-werk', 'werk');
  bind('mon-f-richtung', 'richtung');
  bind('mon-f-status', 'status');
  bind('mon-f-format', 'format');
  const q = document.getElementById('mon-f-q');
  if (q) q.addEventListener('input', () => { _monFilter.q = q.value; _monApply(); });
}

function _esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

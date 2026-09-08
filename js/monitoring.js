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
        const m = MON.libRe.exec(l.name || l.displayName || '');
        if (!m) return null;
        return {
          id: l.id,
          name: l.name || l.displayName,
          richtung: m[1].toUpperCase() === 'ERAR' ? 'Eingang' : 'Ausgang',
          werk: m[2].toUpperCase(),
        };
      })
      .filter(Boolean)
      .filter(l => allow.size === 0 ? true : allow.has(l.werk.toLowerCase()));

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

    _monRecords = recs;
    _monBuildFilterOptions(libs);
    _monApply();

    if (sub) sub.textContent =
      `${recs.length} Rechnung(en) aus ${libs.length} Bibliothek(en) · Stand ${new Date().toLocaleString('de-DE')}`;
    const setup = document.getElementById('mon-setup');
    if (setup) setup.style.display = 'none';
    document.getElementById('mon-body').style.display = '';
  } catch (e) {
    _monShowSetup('Fehler beim Laden', e.message || String(e));
  }
}

function _monMap(it, f, lib) {
  const num = v => (typeof v === 'number' ? v : (v == null || v === '' ? null : parseFloat(v)));
  // Rechnungsnr.: Titelfeld bevorzugen; sonst reine Nummer aus dem Dateinamen
  // (Muster "NR_JJJJMMTT.pdf|xml") ableiten statt den ganzen Dateinamen zu zeigen.
  const nummer = (f.Title && String(f.Title).trim())
    ? String(f.Title).trim()
    : String(f.FileLeafRef || '').replace(/_\d*\.(pdf|xml)$/i, '');
  return {
    // Werk aus dem Bibliotheksnamen (AR_SHB -> SHB) = maessgeblich; das Feld
    // Gesellschaft kann leer/falsch sein und wird nur als Fallback genutzt.
    werk:     (lib.werk || f.Gesellschaft || '').toString(),
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
    const link = r.url ? `<a href="${_esc(r.url)}" target="_blank" rel="noopener">öffnen ↗</a>` : '';
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

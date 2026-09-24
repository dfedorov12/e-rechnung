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
const _monFilter = { werk: '', richtung: '', klass: '', konform: '', buchung: '', status: '', from: '', to: '', q: '', flag: '' };
let _monSort = { key: 'datum', dir: -1 };   // -1 = absteigend (neueste zuerst)

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

    // Positionen aller Bibliotheken einsammeln — parallel (je Bibliothek ein
    // eigener, intern seitenweiser Abruf). Beschleunigt das Laden bei vielen
    // Werken deutlich gegenüber der früheren sequenziellen Schleife.
    const recsArrays = await Promise.all(libs.map(lib => _monFetchLib(siteId, lib, token)));
    const recs = recsArrays.flat();

    // XML + PDF + KoSIT-Bericht derselben Rechnung zu EINER Zeile zusammenfassen.
    _monRecords = _monGroup(recs);
    _monMarkDupes(_monRecords);   // echte Dubletten (Nummer + Aussteller) kennzeichnen
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

// Eine Bibliothek seitenweise abrufen. Sortiert NEUESTE ZUERST (fields/Created
// desc): so liefert das Seitenlimit maxPagesPerLib immer die aktuellsten
// Rechnungen, statt in der Graph-Default-Reihenfolge (ID aufsteigend = älteste
// zuerst) die neuen abzuschneiden. $orderby verlangt jenseits von 5000 Items eine
// indizierte Created-Spalte (Provisioning: provision-rechnungsmonitoring.ps1).
// Wird die Sortierung abgelehnt (noch nicht indiziert), wird ungeordnet geladen.
async function _monFetchLib(siteId, lib, token) {
  const base = `${SP.graphBase}/sites/${siteId}/lists/${lib.id}/items?$expand=fields&$top=200`;
  let url = `${base}&$orderby=fields/Created desc`;
  let ordered = true;
  const out = [];
  let pages = 0;
  while (url && pages < MON.maxPagesPerLib) {
    let page;
    try {
      page = await _get(url, token);
    } catch (e) {
      // Sortierung nicht möglich (unindiziert) -> einmalig ungeordnet neu starten.
      if (ordered && pages === 0) { ordered = false; url = base; continue; }
      throw e;
    }
    for (const it of (page.value || [])) {
      const f = it.fields || {};
      if (!f.FileLeafRef && !f.Title) continue;             // Ordner / Leerzeilen überspringen
      out.push(_monMap(it, f, lib));
    }
    url = page['@odata.nextLink'] || null;
    pages++;
  }
  return out;
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
    // KoSIT-Meldungen: entweder der fertige Klartext-Hinweis (API-Feld "hinweis")
    // oder der rohe meldungenText mit BR-Codes — _monHinweis macht daraus einen Satz.
    meldung:  (f.ValidierungsMeldung || '').toString(),
    // GoBD-Aufbewahrung: maßgeblich ist der TATSÄCHLICHE Purview-Aufbewahrungstag
    // (_ComplianceTag, den Graph als OData__ComplianceTag liefert) — ein nicht-leerer
    // Tag heißt: ein gesperrtes Aufbewahrungslabel liegt an. Fällt der Tag nicht durch
    // (tenantabhängig), greift die vom Flow gespiegelte Boolean-Spalte GoBDArchiviert.
    complianceTag: (f['OData__ComplianceTag'] || f._ComplianceTag || '').toString().trim(),
    gobd:     (f.GoBDArchiviert === true || f.GoBDArchiviert === 1
               || String(f.GoBDArchiviert).toLowerCase() === 'true'),
    // Prüfschritt-/Buchungssteuerung (UStAE/GoBD; /api/intake -> Flow -> SharePoint):
    buchung:               (f.Buchung || '').toString(),
    formatmangel:          _monBool(f.Formatmangel),
    manuellePruefung:      _monBool(f.ManuellePruefung),
    manuellePruefungGrund: (f.ManuellePruefungGrund || '').toString(),
    rueckfrage:            _monBool(f.Rueckfrage),
    konvertiert:           _monBool(f.KonvertiertesPdf),
    kreditorAktion:        (f.KreditorAktion || '').toString(),
    url:      (it.webUrl || '').toString(),
  };
}

/** Robust auf Boolean lesen (SharePoint liefert true/1/"true"/"1"). */
function _monBool(v) {
  return v === true || v === 1 || String(v).toLowerCase() === 'true' || String(v) === '1';
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
    for (const key of ['steller', 'empf', 'format', 'status', 'konform', 'fehler', 'meldung']) {
      if (!primary[key]) { const s = arr.find(r => r[key]); if (s) primary[key] = s[key]; }
    }
    if (primary.brutto == null) { const s = arr.find(r => r.brutto != null); if (s) primary.brutto = s.brutto; }
    // GoBD-archiviert, sobald IRGENDEINE Datei der Rechnung unter Aufbewahrung liegt
    // (Tag) bzw. der Flow es gesetzt hat; Tag-Wert für den Tooltip merken.
    primary.gobdArchiviert = arr.some(r => r.complianceTag || r.gobd);
    primary.complianceTag = (arr.find(r => r.complianceTag) || {}).complianceTag || '';
    // Prüfschritt-Flags: gesetzt, sobald IRGENDEINE Datei der Rechnung sie trägt.
    primary.formatmangel     = arr.some(r => r.formatmangel);
    primary.manuellePruefung = arr.some(r => r.manuellePruefung);
    primary.rueckfrage       = arr.some(r => r.rueckfrage);
    primary.konvertiert      = arr.some(r => r.konvertiert);
    for (const k of ['buchung', 'manuellePruefungGrund', 'kreditorAktion']) {
      if (!primary[k]) { const s = arr.find(r => r[k]); if (s) primary[k] = s[k]; }
    }
    // Ausgangsrechnungen erzeugt der geprüfte Konverter selbst (EN16931-konform,
    // vor dem Export self-verified) — sie werden NICHT extern per KoSIT validiert.
    // Daher als konform behandeln und GoBD-konform setzen; ein evtl. echtes "rot"
    // (z. B. manuell markiert) bleibt erhalten.
    if ((primary.richtung || '').toLowerCase().startsWith('aus')) {
      if (!/^rot/i.test(primary.konform || '')) primary.konform = 'Gruen';
      primary.gobdArchiviert = true;
    }
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

// Echte Dubletten kennzeichnen: dieselbe Rechnungsnummer beim SELBEN Aussteller im
// selben Werk/Richtung, verteilt auf mehrere Einträge = mögliche Doppelerfassung.
// Gleiche Nummer bei VERSCHIEDENEN Lieferanten ist keine Dublette -> der Aussteller
// ist Teil des Schlüssels. Läuft rein clientseitig über die geladenen Datensätze
// (kein Flow-Schritt, keine Extra-Spalte). Setzt r.dublette + r.dubletteInfo.
function _monMarkDupes(records) {
  const norm = s => String(s || '').trim().toLowerCase().replace(/\s+/g, ' ');
  const groups = new Map();
  for (const r of records) {
    const nr = norm(r.nummer);
    const steller = norm(r.steller);
    if (!nr || !steller) continue;                 // ohne Nummer/Aussteller nicht bewertbar
    const key = [r.werk, r.richtung, nr, steller].join('|');
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(r);
  }
  for (const arr of groups.values()) {
    if (arr.length < 2) continue;
    for (const r of arr) {
      r.dublette = true;
      r.dubletteInfo = `${arr.length}× dieselbe Nummer „${r.nummer}" von „${r.steller}" `
                     + '– mögliche Doppelerfassung, bitte prüfen.';
    }
  }
}

/* ── Filter & Rendering ─────────────────────────────────────────────── */

function _monBuildFilterOptions(libs) {
  const uniq = arr => Array.from(new Set(arr.filter(Boolean))).sort((a, b) => a.localeCompare(b, 'de'));
  _fillSelect('mon-f-werk',    uniq(libs.map(l => l.werk)),              'Alle Werke');
  _fillSelect('mon-f-klass',   uniq(_monRecords.map(r => _monKlass(r))), 'Alle Typen');
  _fillSelect('mon-f-buchung', uniq(_monRecords.map(r => r.buchung)),    'Alle Buchung');
  _fillSelect('mon-f-status',  uniq(_monRecords.map(r => r.status)),     'Alle Status');
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
  // Basis = alle Filter AUSSER dem Schnellfilter (flag). So zeigen die Kacheln die
  // Zahlen im aktuellen Filter-Umfang, ohne dass ein aktiver Schnellfilter sich
  // selbst auf 0 kürzt. Die Tabelle wird zusätzlich per flag eingeengt.
  const base = _monRecords.filter(r => _monMatchBase(r, f, q));
  const rows = f.flag ? base.filter(r => _monMatchFlag(r, f.flag)) : base;
  _monSortRows(rows);
  _monRenderKpis(base);
  _monRenderTable(rows);
  _monRenderChips();
  _monMarkSortHeaders();
}

function _monMatchBase(r, f, q) {
  const d = (r.datum || '').slice(0, 10);
  return (!f.werk     || r.werk === f.werk)
      && (!f.richtung || r.richtung === f.richtung)
      && (!f.klass    || _monKlass(r) === f.klass)
      && (!f.konform  || (r.konform || '').toLowerCase().startsWith(f.konform))
      && (!f.buchung  || r.buchung === f.buchung)
      && (!f.status   || r.status === f.status)
      && (!f.from     || (d && d >= f.from))
      && (!f.to       || (d && d <= f.to))
      && (!q || (r.nummer + ' ' + r.steller + ' ' + r.empf).toLowerCase().includes(q));
}

function _monMatchFlag(r, flag) {
  switch (flag) {
    case 'offen':      return !!r.status && !['Gebucht', 'Archiviert'].includes(r.status);
    case 'fehler':     return r.status === 'Fehler' || /^rot/i.test(r.konform || '') || !!r.fehler;
    case 'dublette':   return !!r.dublette;
    case 'manuell':    return r.manuellePruefung || /manuell/i.test(r.buchung || '');
    case 'rueckfrage': return !!r.rueckfrage;
    case 'zurueck':    return /zur(?:ü|ue)ckgew/i.test(r.buchung || '');
    default:           return true;
  }
}

function _monSortRows(rows) {
  const { key, dir } = _monSort;
  rows.sort((a, b) => {
    const va = _monSortVal(a, key), vb = _monSortVal(b, key);
    if (typeof va === 'number' && typeof vb === 'number') return (va - vb) * dir;
    return String(va).localeCompare(String(vb), 'de') * dir;
  });
}

function _monSortVal(r, key) {
  switch (key) {
    case 'datum':    return (r.datum || '').slice(0, 10);
    case 'werk':     return r.werk || '';
    case 'richtung': return r.richtung || '';
    case 'nummer':   return (r.nummer || '').toLowerCase();
    case 'partner':  return ((r.richtung === 'Eingang' ? r.steller : r.empf) || '').toLowerCase();
    case 'brutto':   return r.brutto == null ? -Infinity : r.brutto;
    case 'format':   return r.format || '';
    case 'klass':    return _monKlass(r) || '';
    case 'status':   return r.status || '';
    case 'buchung':  return r.buchung || '';
    case 'konform':  return r.konform || '';
    default:         return '';
  }
}

function _monRenderKpis(rows) {
  const total = rows.length;
  const eingang = rows.filter(r => r.richtung === 'Eingang').length;
  const ausgang = rows.filter(r => r.richtung === 'Ausgang').length;
  const offen = rows.filter(r => _monMatchFlag(r, 'offen')).length;
  const fehler = rows.filter(r => _monMatchFlag(r, 'fehler')).length;
  const dubletten = rows.filter(r => r.dublette).length;
  // Prüfschritt-Warteschlangen (UStAE/GoBD): manuelle Prüfung, Rückfrage, Zurückweisung.
  const manuell    = rows.filter(r => _monMatchFlag(r, 'manuell')).length;
  const rueckfrage = rows.filter(r => r.rueckfrage).length;
  const zurueck    = rows.filter(r => _monMatchFlag(r, 'zurueck')).length;

  // Klassifizierung (ZUGFeRD / XRechnung / PDF ohne E-Rechnung) als Übersichtsfelder.
  const klassCounts = {};
  rows.forEach(r => { const k = _monKlass(r); if (k) klassCounts[k] = (klassCounts[k] || 0) + 1; });
  const KLASS_ORDER = ['XRechnung', 'ZUGFeRD', 'PDF ohne E-Rechnung'];
  const klassKeys = KLASS_ORDER.filter(k => klassCounts[k])
    .concat(Object.keys(klassCounts).filter(k => !KLASS_ORDER.includes(k)));

  // id kodiert den Filter: '' = Alles zeigen (Reset), r:<Richtung>, flag:<Schnellfilter>, k:<Typ>.
  const tiles = [
    { id: '',                label: 'Rechnungen gesamt',     val: total,      cls: '' },
    { id: 'r:Eingang',       label: 'Eingang',               val: eingang,    cls: 'in' },
    { id: 'r:Ausgang',       label: 'Ausgang',               val: ausgang,    cls: 'out' },
    { id: 'flag:offen',      label: 'Offen (nicht gebucht)', val: offen,      cls: 'warn' },
    { id: 'flag:fehler',     label: 'Fehler / rot',          val: fehler,     cls: 'bad' },
    { id: 'flag:dublette',   label: 'Dubletten',             val: dubletten,  cls: dubletten ? 'bad' : '' },
    { id: 'flag:manuell',    label: 'Manuelle Prüfung',      val: manuell,    cls: manuell ? 'warn' : '' },
    { id: 'flag:rueckfrage', label: 'Zur Rückfrage',         val: rueckfrage, cls: rueckfrage ? 'bad' : '' },
    { id: 'flag:zurueck',    label: 'Zurückgewiesen',        val: zurueck,    cls: zurueck ? 'bad' : '' },
    ...klassKeys.map(k => ({ id: 'k:' + k, label: k, val: klassCounts[k], cls: 'klass' })),
  ];
  document.getElementById('mon-kpis').innerHTML = tiles.map(t => {
    const active = _monTileActive(t.id) ? ' active' : '';
    return `<div class="mon-tile ${t.cls}${active}" data-tile="${_esc(t.id)}" role="button" tabindex="0" title="Klicken zum Filtern">`
      + `<div class="mon-tile-val">${_esc(String(t.val))}</div>`
      + `<div class="mon-tile-label">${_esc(t.label)}</div></div>`;
  }).join('');
}

function _monTileActive(id) {
  const f = _monFilter;
  if (id.startsWith('r:'))    return f.richtung === id.slice(2);
  if (id.startsWith('flag:')) return f.flag === id.slice(5);
  if (id.startsWith('k:'))    return f.klass === id.slice(2);
  return false;
}

function _monTileClick(id) {
  const f = _monFilter;
  if (id === '') { _monResetFilters(); return; }
  if (id.startsWith('r:'))         { const v = id.slice(2); f.richtung = f.richtung === v ? '' : v; }
  else if (id.startsWith('flag:')) { const v = id.slice(5); f.flag = f.flag === v ? '' : v; }
  else if (id.startsWith('k:'))    { const v = id.slice(2); f.klass = f.klass === v ? '' : v; }
  _monSyncControls();
  _monApply();
}

function _monRenderTable(rows) {
  // Sortierung erfolgt zentral in _monSortRows (vor dem Rendern).
  const body = rows.map(r => {
    const betrag = r.brutto == null ? '' :
      r.brutto.toLocaleString('de-DE', { style: 'currency', currency: r.waehrung || 'EUR' });
    const datum = _monDate(r.datum);
    const richtCls = r.richtung === 'Eingang' ? 'pill-in' : 'pill-out';
    const kon = _monKonPill(r);
    const hinweis = _monHinweis(r);
    const konCell = kon + (hinweis
      ? `<div class="mon-hint" title="${_esc(hinweis)}" style="font-size:11px;color:var(--gray-600,#6b7280);margin-top:3px;max-width:100%;line-height:1.3;">${_esc(hinweis)}</div>`
      : '');
    const stat = r.status ? `<span class="pill pill-status">${_esc(r.status)}</span>` : '';
    const gobdBadge = r.gobdArchiviert
      ? `<div title="${_esc(r.complianceTag ? 'Aufbewahrung: ' + r.complianceTag : 'GoBD-Aufbewahrung gesetzt')}" style="display:inline-block;margin-top:3px;font-size:11px;font-weight:600;color:#0a6b2e;background:#e3f5e9;border-radius:3px;padding:1px 6px;">🔒 GoBD</div>`
      : '';
    // Buchungssteuerung + Prüfschritt-Flags (UStAE/GoBD).
    const _flags = [];
    if (r.formatmangel)     _flags.push(['Formatmangel', '#8a5a00', '#fff3d6']);
    if (r.manuellePruefung) _flags.push([r.manuellePruefungGrund ? 'Manuell · ' + r.manuellePruefungGrund : 'Manuell', '#8a3b00', '#ffe6cc']);
    if (r.rueckfrage)       _flags.push(['Rückfrage', '#b40000', '#ffe0e0']);
    if (r.konvertiert)      _flags.push(['techn. konvertiert', '#334155', '#e2e8f0']);
    const _flagBadges = _flags.map(([t, c, bg]) =>
      `<div title="${_esc(t)}" style="display:inline-block;margin:3px 3px 0 0;font-size:11px;font-weight:600;color:${c};background:${bg};border-radius:3px;padding:1px 6px;">${_esc(t.length > 28 ? t.slice(0, 26) + '…' : t)}</div>`).join('');
    const buchungCell = (r.buchung ? `<span class="pill pill-status">${_esc(r.buchung)}</span>` : '')
      + (_flagBadges ? `<div>${_flagBadges}</div>` : '') || '–';
    const extra = (r.dateien || [])
      .map(d => `<a href="${_esc(d.url)}" target="_blank" rel="noopener">${_esc(d.label)} ↗</a>`)
      .join(' · ');
    const origLabel = r.ext ? `Original (${r.ext.toUpperCase()})` : 'Original';
    const link = [
      r.url ? `<a href="${_esc(r.url)}" target="_blank" rel="noopener">${origLabel} ↗</a>` : '',
      extra,
    ].filter(Boolean).join(' · ');
    return `<tr>
      <td style="white-space:nowrap;">${_esc(datum)}</td>
      <td><span class="pill pill-werk">${_esc(r.werk)}</span></td>
      <td><span class="pill ${richtCls}">${_esc(r.richtung)}</span></td>
      <td>${_esc(r.nummer)}${r.dublette
        ? `<div class="mon-dupe" title="${_esc(r.dubletteInfo || '')}" style="display:inline-block;margin-top:2px;font-size:11px;font-weight:600;color:#fff;background:#b40000;border-radius:3px;padding:1px 6px;">⚠ Dublette</div>`
        : ''}</td>
      <td>${_esc(r.richtung === 'Eingang' ? r.steller : r.empf)}</td>
      <td style="text-align:right;white-space:nowrap;">${_esc(betrag)}</td>
      <td>${_esc(r.format)}</td>
      <td>${_esc(_monKlass(r))}</td>
      <td>${stat}${gobdBadge}</td>
      <td>${buchungCell}</td>
      <td>${konCell}</td>
      <td class="mon-err" title="${_esc(r.fehler)}">${_esc(r.fehler.slice(0, 60))}</td>
      <td>${link}</td>
    </tr>`;
  }).join('');

  document.getElementById('mon-tbody').innerHTML = body
    || `<tr><td colspan="13" style="text-align:center;color:var(--gray-500);padding:28px;">Keine Treffer für die aktuellen Filter.</td></tr>`;
  document.getElementById('mon-count').textContent =
    `${rows.length} von ${_monRecords.length} angezeigt`;
}

// Klartext-Hinweis zur Konformität. Nimmt einen bereits fertigen API-Hinweis
// unverändert; enthält der gespeicherte Text noch die rohen KoSIT-Codes
// (BR-*/CII-*), wird daraus ein verständlicher Satz gemacht. Spiegelt
// _hinweisAusBefunden in api/src/kosit.js wider. Leer bei grün/ohne Meldung.
function _monHinweis(r) {
  const s = (r.meldung || '').trim();
  if ((r.konform || '').toLowerCase().startsWith('gr')) return '';
  if (!s) return '';
  if (!/BR-[A-Z0-9]|CII-(SR|DT)-/i.test(s)) return s; // schon Klartext -> so anzeigen
  const regeln = [
    [/BR-CL-18\b/i, 'Positionen ohne USt-Kategorie-Code (BT-151) — Rechnungssteller muss je Position eine USt-Kategorie angeben.'],
    [/BR-CO-1[0-7]\b/i, 'Rechnerische Summen stimmen nicht zusammen (Netto/USt/Brutto).'],
    [/BR-[A-Z]{1,2}-0[6-9]\b/i, 'USt-Aufschlüsselung passt nicht zu den Positionssummen.'],
    [/BR-[A-Z]{1,2}-0[1-5]\b/i, 'USt-Kategorie in der Steueraufschlüsselung unvollständig.'],
    [/BR-DEC-\d/i, 'Beträge mit falscher Anzahl Nachkommastellen.'],
    [/BR-CL-\d/i, 'Ungültiger Code — eine Code-Liste wird nicht eingehalten.'],
    [/CII-(SR|DT)-/i, 'CII-Syntaxfehler (Struktur/Datentyp nicht schemakonform).'],
    [/BR-\d|BR-[A-Z]/i, 'Verstoß gegen EN16931-Geschäftsregeln.'],
  ];
  for (const [re, text] of regeln) if (re.test(s)) return text;
  return 'Nicht konform (siehe KoSIT-Bericht).';
}

// Datum kompakt einzeilig: ISO (YYYY-MM-DD…) -> TT.MM.JJJJ, sonst unverändert.
function _monDate(s) {
  const d = String(s || '').slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(d) ? d.split('-').reverse().join('.') : d;
}

// Klassifizierung aus Format/Endung ableiten (ZUGFeRD | XRechnung | PDF ohne E-Rechnung).
function _monKlass(r) {
  const f = (r.format || '').toLowerCase();
  if (f.includes('zugferd') || f.includes('factur')) return 'ZUGFeRD';
  if (f.includes('xrechnung') || f.includes('ubl') || f.includes('cii')) return 'XRechnung';
  if (f) return r.format;                    // sonstiges Format so anzeigen wie gespeichert
  if (r.ext === 'xml') return 'XRechnung';
  if (r.ext === 'pdf') return 'PDF ohne E-Rechnung';
  return '';
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

/* ── Aktive Filter als Chips (einzeln wegklickbar) ──────────────────── */

function _monRenderChips() {
  const f = _monFilter;
  const KONF = { gr: 'grün', gel: 'gelb', rot: 'rot' };
  const FLAG = { offen: 'Offen', fehler: 'Fehler / rot', dublette: 'Dubletten',
                 manuell: 'Manuelle Prüfung', rueckfrage: 'Zur Rückfrage', zurueck: 'Zurückgewiesen' };
  const deDate = s => s.split('-').reverse().join('.');
  const chips = [];
  if (f.werk)     chips.push(['werk', 'Werk: ' + f.werk]);
  if (f.richtung) chips.push(['richtung', f.richtung]);
  if (f.klass)    chips.push(['klass', 'Typ: ' + f.klass]);
  if (f.konform)  chips.push(['konform', 'Konform.: ' + (KONF[f.konform] || f.konform)]);
  if (f.buchung)  chips.push(['buchung', 'Buchung: ' + f.buchung]);
  if (f.status)   chips.push(['status', 'Status: ' + f.status]);
  if (f.from)     chips.push(['from', 'ab ' + deDate(f.from)]);
  if (f.to)       chips.push(['to', 'bis ' + deDate(f.to)]);
  if (f.q)        chips.push(['q', 'Suche: „' + f.q + '“']);
  if (f.flag)     chips.push(['flag', FLAG[f.flag] || f.flag]);
  const el = document.getElementById('mon-chips');
  if (!el) return;
  el.innerHTML = chips.map(([key, label]) =>
    `<span class="mon-chip">${_esc(label)}<button type="button" data-chip="${_esc(key)}" title="Filter entfernen" aria-label="Filter entfernen">✕</button></span>`).join('');
}

function _monResetFilters() {
  Object.assign(_monFilter, { werk: '', richtung: '', klass: '', konform: '', buchung: '', status: '', from: '', to: '', q: '', flag: '' });
  _monSyncControls();
  _monApply();
}

// Filterzustand zurück in die Steuerelemente schreiben (nach Kachel-/Chip-Klick).
function _monSyncControls() {
  const f = _monFilter;
  const set = (id, v) => { const el = document.getElementById(id); if (el) el.value = v; };
  set('mon-f-werk', f.werk); set('mon-f-richtung', f.richtung); set('mon-f-klass', f.klass);
  set('mon-f-konform', f.konform); set('mon-f-buchung', f.buchung); set('mon-f-status', f.status);
  set('mon-f-from', f.from); set('mon-f-to', f.to); set('mon-f-q', f.q);
}

function _monMarkSortHeaders() {
  document.querySelectorAll('table.mon-table th[data-sort]').forEach(th => {
    const ind = th.querySelector('.sort-ind');
    if (th.getAttribute('data-sort') === _monSort.key) {
      th.classList.add('sorted'); if (ind) ind.textContent = _monSort.dir < 0 ? '▼' : '▲';
    } else {
      th.classList.remove('sorted'); if (ind) ind.textContent = '';
    }
  });
}

/* ── Filter-Events ──────────────────────────────────────────────────── */

function monInitFilterEvents() {
  const bind = (id, key) => {
    const el = document.getElementById(id);
    if (el) el.addEventListener('change', () => { _monFilter[key] = el.value; _monApply(); });
  };
  bind('mon-f-werk', 'werk');
  bind('mon-f-richtung', 'richtung');
  bind('mon-f-klass', 'klass');
  bind('mon-f-konform', 'konform');
  bind('mon-f-buchung', 'buchung');
  bind('mon-f-status', 'status');
  bind('mon-f-from', 'from');
  bind('mon-f-to', 'to');
  const q = document.getElementById('mon-f-q');
  if (q) q.addEventListener('input', () => { _monFilter.q = q.value; _monApply(); });
  const reset = document.getElementById('mon-reset');
  if (reset) reset.addEventListener('click', _monResetFilters);

  // KPI-Kacheln als Schnellfilter (Klick + Tastatur), per Event-Delegation.
  const kpis = document.getElementById('mon-kpis');
  if (kpis) {
    kpis.addEventListener('click', e => {
      const tile = e.target.closest('[data-tile]');
      if (tile) _monTileClick(tile.getAttribute('data-tile'));
    });
    kpis.addEventListener('keydown', e => {
      if (e.key !== 'Enter' && e.key !== ' ') return;
      const tile = e.target.closest('[data-tile]');
      if (tile) { e.preventDefault(); _monTileClick(tile.getAttribute('data-tile')); }
    });
  }

  // Chips einzeln entfernen.
  const chips = document.getElementById('mon-chips');
  if (chips) chips.addEventListener('click', e => {
    const btn = e.target.closest('[data-chip]');
    if (!btn) return;
    _monFilter[btn.getAttribute('data-chip')] = '';
    _monSyncControls();
    _monApply();
  });

  // Spalten sortieren (Klick auf Kopfzeile toggelt Richtung).
  document.querySelectorAll('table.mon-table th[data-sort]').forEach(th => {
    th.addEventListener('click', () => {
      const key = th.getAttribute('data-sort');
      if (_monSort.key === key) _monSort.dir = -_monSort.dir;
      else _monSort = { key, dir: (key === 'datum' || key === 'brutto') ? -1 : 1 };
      _monApply();
    });
  });
}

function _esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

/**
 * Bearbeitung von Eingangsrechnungen im Monitoring
 * ================================================
 * Ersetzt die Eingangsrechnungsliste auf gruppe_wgc: Die Buchhaltung pflegt
 * Varialnummer, Kontierung, Bestellnummer, Bearbeitungsstatus, Genehmigt,
 * GF gesehen und Notiz direkt an der Rechnung in ERAR_<Werk> und fordert von hier
 * die Genehmigung an.
 *
 * Genehmigung: Der Dialog setzt an der Datei GenehmigungAnfordern = Ja, dazu
 * Genehmiger, Kommentar, wer angefordert hat und an wen nach der Genehmigung die
 * Info zum Austragen im abas geht. Der Flow „Genehmigung <Werk>“ reagiert auf den
 * Haken, setzt ihn zurück und schreibt das Ergebnis (Genehmigt, Genehmigt von/am,
 * Genehmigungskommentar). Kein Flow-Link in der Webseite, Rechte regelt SharePoint.
 *
 * Geschrieben wird an EINE Datei je Rechnung (bhZiel): das Original-PDF, bei einer
 * XRechnung das lesbare PDF. Diese Datei bekommt der Genehmiger als Anhang.
 *
 * Die Vorgabe für die abas-Info je Werk liegt in Monitoring/monitoring-einstellungen.json
 * auf der Monitoring-Site, nicht im Code (die Seite ist öffentlich).
 *
 * Spalten: scripts/provision-rechnungsmonitoring.ps1 ($EingangFelder)
 * Flow:    docs/Genehmigung-im-Monitoring.md
 */

// Rechnungsfeld -> interner Spaltenname in ERAR_<Werk>
const BH_FELDER = {
  varial: 'Varialnummer',
  kontierung: 'Kontierung',
  bestellnr: 'Bestellnummer',
  bstatus: 'Bearbeitungsstatus',
  genehmigt: 'Genehmigt',
  genehmigungAn: 'GenehmigungAn',
  genehmigtVon: 'GenehmigtVon',
  genehmigtAm: 'GenehmigtAm',
  kommentar: 'Genehmigungskommentar',
  gfGesehen: 'GFGesehen',
  notiz: 'Notiz',
  anfordern: 'GenehmigungAnfordern',
  anfKommentar: 'AnforderungKommentar',
  angefordertVon: 'AngefordertVon',
  angefordertAm: 'AngefordertAm',
  abasInfoAn: 'AbasInfoAn',
  abasGesendet: 'AbasInfoGesendet',
};
const BH_BOOL = ['gfGesehen', 'anfordern', 'abasGesendet'];
// Was die Buchhaltung im Dialog selbst ändert (der Rest kommt aus Anforderung und Flow)
const BH_MANUELL = ['varial', 'kontierung', 'bestellnr', 'bstatus', 'genehmigt', 'gfGesehen', 'notiz'];
const BH_AUSWAHL = ['bstatus', 'genehmigt'];

// Werte wie in der alten Liste (Genehmigt 1:1, Status: die seit 04/2026 genutzten)
const BH_STATUS = ['Offen', 'In Genehmigung', 'Vorkasse&BE-Obligo', 'Vorkasse erfaßt', 'Keine RG',
  'Gebucht (m. Prüfg rechn & Stammd)', 'Mahnung', 'In Klärung', 'KOPIE'];
const BH_GENEHMIGT = ['Ja', 'Nein', 'Abgelehnt', 'In Prüfung', 'Keine Rechnung', 'Vertrag', 'bezahlt', 'Verkauf', 'XML'];

const BH_EINSTELLUNGEN = 'Monitoring/monitoring-einstellungen.json';

const _bh = { siteId: null, einst: { version: 1, werke: {} }, einstItemId: null, einstETag: null };
let _bhAktuell = null;

function _bhBool(v) {
  return v === true || v === 1 || String(v).toLowerCase() === 'true' || String(v) === '1';
}

/** SharePoint-Felder einer Datei -> Bearbeitungsfelder (leer = '' bzw. null). */
function bhAusFeldern(f) {
  const o = {};
  for (const [k, name] of Object.entries(BH_FELDER)) {
    const v = f ? f[name] : null;
    o[k] = BH_BOOL.includes(k) ? (v == null || v === '' ? null : _bhBool(v)) : (v == null ? '' : String(v));
  }
  return o;
}

/** Die Datei, an die geschrieben wird: Original-PDF, sonst lesbares PDF, sonst Original. */
function bhZiel(arr) {
  return arr.find(r => !r.sidecar && r.ext === 'pdf')
    || arr.find(r => r.sidecar === 'lesbar')
    || arr.find(r => !r.sidecar)
    || arr[0];
}

/** Werte der Rechnung: zuerst die Zieldatei, Lücken aus den anderen Dateien. */
function bhZusammen(arr, ziel) {
  const reihe = [ziel].concat(arr.filter(r => r !== ziel));
  const o = {};
  for (const k of Object.keys(BH_FELDER)) {
    const q = reihe.find(r => r.bh && r.bh[k] !== '' && r.bh[k] != null);
    o[k] = q ? q.bh[k] : (BH_BOOL.includes(k) ? null : '');
  }
  return o;
}

/** Eine oder mehrere Adressen (; oder ,) prüfen und als „a@x.de; b@y.de“ liefern, sonst ''. */
function bhMails(s) {
  const teile = String(s || '').split(/[;,]/).map(t => t.trim()).filter(Boolean);
  if (!teile.length || !teile.every(t => /^[^\s@]+@[^\s@]+\.[A-Za-z]{2,}$/.test(t))) return '';
  return teile.join('; ');
}

/** Geänderte Felder aus dem Dialog als PATCH-Inhalt (nur was sich wirklich ändert). */
function bhAenderungen(alt, neu) {
  const out = {};
  for (const k of BH_MANUELL) {
    if (!(k in neu)) continue;
    let a = alt ? alt[k] : null;
    let n = neu[k];
    if (BH_BOOL.includes(k)) {
      if (!!a === !!n) continue;
      out[BH_FELDER[k]] = !!n;
      continue;
    }
    a = a == null ? '' : String(a);
    n = n == null ? '' : String(n).replace(/\s+$/, '');
    if (k !== 'kontierung' && k !== 'notiz') n = n.trim();
    if (a === n) continue;
    out[BH_FELDER[k]] = (n === '' && BH_AUSWAHL.includes(k)) ? null : n;
  }
  return out;
}

/** Felder für „Genehmigung anfordern“. Der Flow reagiert auf GenehmigungAnfordern = Ja. */
function bhAnforderung(p) {
  const genehmiger = bhMails(p.genehmiger);
  if (!genehmiger) throw new Error('Bitte die Mailadresse des Genehmigers angeben.');
  let abas = '';
  if (p.abasInfo) {
    abas = bhMails(p.abasInfoAn);
    if (!abas) throw new Error('Bitte eine gültige Adresse für die Info zum Austragen im abas angeben.');
  }
  return {
    GenehmigungAnfordern: true,
    GenehmigungAn: genehmiger,
    AnforderungKommentar: String(p.kommentar || '').trim(),
    AbasInfoAn: abas,
    AbasInfoGesendet: false,
    AngefordertVon: String(p.von || ''),
    AngefordertAm: p.jetzt || new Date().toISOString(),
    Genehmigt: 'Nein',
    GenehmigtVon: '',
    Genehmigungskommentar: '',
    Bearbeitungsstatus: 'In Genehmigung',
  };
}

/** Stand der Genehmigung als kurzer Text, '' wenn nie angefordert. */
function bhGenehmigungsStand(b) {
  if (!b) return '';
  if (b.anfordern) return `Angefordert bei ${b.genehmigungAn || '?'}, wartet auf den Flow`;
  if (b.genehmigt === 'Ja' && b.genehmigtVon) return `Genehmigt von ${b.genehmigtVon}${b.genehmigtAm ? ' am ' + _bhDatum(b.genehmigtAm) : ''}`;
  if (b.genehmigt === 'Abgelehnt') return `Abgelehnt${b.genehmigtVon ? ' von ' + b.genehmigtVon : ''}${b.genehmigtAm ? ' am ' + _bhDatum(b.genehmigtAm) : ''}`;
  if (b.genehmigt === 'Nein' && b.genehmigungAn) return `In Genehmigung bei ${b.genehmigungAn}${b.angefordertAm ? ' seit ' + _bhDatum(b.angefordertAm) : ''}`;
  return '';
}

/** Läuft gerade eine Genehmigung (angefordert oder beim Genehmiger)? */
function bhInGenehmigung(b) {
  return !!b && (!!b.anfordern || (b.genehmigt === 'Nein' && !!b.genehmigungAn));
}

function _bhDatum(iso) {
  const d = String(iso || '').slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(d) ? d.split('-').reverse().join('.') : d;
}

/* ── Einstellungen (Vorgabe abas-Info je Werk) ─────────────────────────── */

async function bhLaden(siteId, token) {
  _bh.siteId = siteId;
  try {
    const meta = await fetch(`${SP.graphBase}/sites/${siteId}/drive/root:/${BH_EINSTELLUNGEN}?$select=id,eTag`, {
      headers: { 'Authorization': `Bearer ${token}`, 'Accept': 'application/json' },
    });
    if (meta.status === 404) return;
    if (!meta.ok) throw new Error(`Einstellungen (${meta.status})`);
    const m = await meta.json();
    const inhalt = await fetch(`${SP.graphBase}/sites/${siteId}/drive/items/${m.id}/content`, {
      headers: { 'Authorization': `Bearer ${token}` },
    });
    if (!inhalt.ok) throw new Error(`Einstellungen-Inhalt (${inhalt.status})`);
    const d = await inhalt.json();
    _bh.einst = { version: 1, werke: (d && d.werke) || {} };
    _bh.einstItemId = m.id;
    _bh.einstETag = m.eTag;
  } catch (e) {
    console.warn('[Bearbeitung] Einstellungen nicht lesbar:', e.message || e);
  }
}

/**
 * Einstellungen eines Werks: { abasInfoAn, spalten: [Spalten-IDs], bearbeiten: true|false }.
 * Fehlt etwas, gilt der Standard (alle Standardspalten, Bearbeiten an).
 */
function bhWerkEinst(werk) {
  return _bh.einst.werke[String(werk || '').toUpperCase()] || {};
}

/** Ist die Bearbeitung (Knopf, Spalten, Genehmigung) für das Werk eingeschaltet? */
function bhBearbeitenAn(werk) {
  return bhWerkEinst(werk).bearbeiten !== false;
}

function bhVorgabeAbas(werk) {
  return bhWerkEinst(werk).abasInfoAn || '';
}

/**
 * Teil der Werk-Einstellungen speichern, für ein Werk oder eine Liste von Werken in einem
 * Schritt (mit If-Match, bei Konflikt neu laden und wiederholen).
 */
async function bhEinstSpeichern(werk, teil) {
  const keys = (Array.isArray(werk) ? werk : [werk]).map(w => String(w || '').toUpperCase());
  for (let versuch = 0; versuch < 2; versuch++) {
    const token = await acquireToken(SP.scopes);
    if (!token) throw new Error('Nicht angemeldet.');
    if (versuch > 0) await bhLaden(_bh.siteId, token);
    const werke = Object.assign({}, _bh.einst.werke);
    keys.forEach(k => { werke[k] = Object.assign({}, werke[k], teil); });
    const neu = { version: 1, werke };
    const url = _bh.einstItemId
      ? `${SP.graphBase}/sites/${_bh.siteId}/drive/items/${_bh.einstItemId}/content`
      : `${SP.graphBase}/sites/${_bh.siteId}/drive/root:/${BH_EINSTELLUNGEN}:/content?@microsoft.graph.conflictBehavior=fail`;
    const headers = { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' };
    if (_bh.einstItemId && _bh.einstETag) headers['If-Match'] = _bh.einstETag;
    const resp = await fetch(url, { method: 'PUT', headers, body: JSON.stringify(neu, null, 2) });
    if (resp.ok) {
      const m = await resp.json();
      _bh.einst = neu; _bh.einstItemId = m.id; _bh.einstETag = m.eTag;
      return;
    }
    if ((resp.status === 412 || resp.status === 409) && versuch === 0) continue;
    throw new Error(`Vorgabe nicht gespeichert (${resp.status}).`);
  }
}

/* ── Schreiben an die Rechnung ─────────────────────────────────────────── */

async function bhSchreiben(r, felder) {
  const z = r.bhQuelle || r;
  const token = await acquireToken(SP.scopes);
  if (!token) throw new Error('Nicht angemeldet.');
  const resp = await fetch(`${SP.graphBase}/sites/${_bh.siteId}/lists/${z.listId}/items/${z.itemId}/fields`, {
    method: 'PATCH',
    headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(felder),
  });
  if (resp.ok) return resp.json();
  const text = await resp.text();
  if (resp.status === 401 || resp.status === 403) {
    throw new Error(`Keine Schreibrechte auf ERAR_${r.werk}. Die Buchhaltung braucht dort „Mitwirken“.`);
  }
  if (/not recognized|does not exist|nicht erkannt|existiert nicht/i.test(text)) {
    throw new Error(`In ERAR_${r.werk} fehlen die Spalten für die Bearbeitung. Bitte das Provisionierungsskript ausführen.`);
  }
  if (/record|retention|Datensatz|Aufbewahrung|locked|gesperrt/i.test(text)) {
    throw new Error('Die Aufbewahrungsbezeichnung der Datei erlaubt keine Änderung der Eigenschaften.');
  }
  throw new Error(`Speichern fehlgeschlagen (${resp.status}): ${text.slice(0, 160)}`);
}

// Gespeicherte Felder in den geladenen Daten nachziehen (Zeile und Zieldatei).
function _bhUebernehmen(r, felder) {
  const zurueck = {};
  for (const [k, name] of Object.entries(BH_FELDER)) if (name in felder) zurueck[k] = felder[name];
  for (const ziel of [r, r.bhQuelle]) {
    if (!ziel) continue;
    ziel.bh = Object.assign({}, ziel.bh || bhAusFeldern({}));
    for (const [k, v] of Object.entries(zurueck)) ziel.bh[k] = v == null ? (BH_BOOL.includes(k) ? null : '') : v;
  }
}

/* ── Anzeige in der Tabelle ────────────────────────────────────────────── */

function bhZelle(r) {
  const b = r.bh;
  if (!b) return '';
  const teile = [];
  const stand = bhGenehmigungsStand(b);
  if (bhInGenehmigung(b)) teile.push(['In Genehmigung', 'bh-wartet', stand]);
  else if (b.genehmigt === 'Ja') teile.push(['Genehmigt', 'bh-ja', stand]);
  else if (b.genehmigt === 'Abgelehnt') teile.push(['Abgelehnt', 'bh-nein', stand + (b.kommentar ? ': ' + b.kommentar : '')]);
  else if (b.genehmigt) teile.push([b.genehmigt, 'bh-neutral', 'Genehmigt: ' + b.genehmigt]);
  if (b.bstatus && !(b.bstatus === 'In Genehmigung' && bhInGenehmigung(b))) teile.push([b.bstatus, 'bh-neutral', 'Bearbeitungsstatus']);
  if (b.gfGesehen) teile.push(['GF ✓', 'bh-neutral', 'GF gesehen']);
  return teile.map(([t, cls, tip]) =>
    `<div class="bh-pill ${cls}" title="${_esc(tip)}">${_esc(t.length > 26 ? t.slice(0, 24) + '…' : t)}</div>`).join('');
}

/* ── Dialog ─────────────────────────────────────────────────────────────── */

function bhDialogOeffnen(r, onGespeichert) {
  const dlg = document.getElementById('bh-dialog');
  if (!dlg) return;
  const b = Object.assign(bhAusFeldern({}), r.bh || {});
  const user = (typeof getAuthUser === 'function' && getAuthUser()) || {};
  _bhAktuell = { r, b, onGespeichert, user };
  const opt = (werte, wert) => ['<option value=""></option>']
    .concat(werte.concat(wert && !werte.includes(wert) ? [wert] : [])
      .map(v => `<option${v === wert ? ' selected' : ''}>${_esc(v)}</option>`)).join('');
  const betrag = r.brutto == null ? '' : r.brutto.toLocaleString('de-DE', { style: 'currency', currency: r.waehrung || 'EUR' });
  const partner = typeof _monPartner === 'function' ? _monPartner(r) : (r.steller || '');
  const stand = bhGenehmigungsStand(b);
  const laeuft = bhInGenehmigung(b);
  const abasVorgabe = b.abasInfoAn || bhVorgabeAbas(r.werk);

  dlg.innerHTML = `
    <form method="dialog" class="ug-form">
      <div class="ug-kopf">
        <h3>Rechnung ${_esc(r.nummer)}</h3>
        <button type="button" class="ug-x" data-bh-zu aria-label="Schließen">✕</button>
      </div>
      <p class="ug-regel">${_esc([partner, betrag, r.werk, typeof _monDate === 'function' ? _monDate(r.datum) : ''].filter(Boolean).join(' · '))}</p>
      <div class="bh-raster">
        <label class="ug-lbl">Varialnummer<input id="bh-varial" value="${_esc(b.varial)}" autocomplete="off"></label>
        <label class="ug-lbl">Bestellnummer<input id="bh-bestellnr" value="${_esc(b.bestellnr)}" autocomplete="off"></label>
        <label class="ug-lbl">Bearbeitungsstatus<select id="bh-bstatus">${opt(BH_STATUS, b.bstatus)}</select></label>
      </div>
      <label class="ug-lbl">Kontierung<textarea id="bh-kontierung" rows="3">${_esc(b.kontierung)}</textarea></label>
      <div class="bh-raster">
        <label class="ug-lbl">Genehmigt<select id="bh-genehmigt">${opt(BH_GENEHMIGT, b.genehmigt)}</select></label>
        <label class="bh-check"><input type="checkbox" id="bh-gf"${b.gfGesehen ? ' checked' : ''}> GF gesehen</label>
      </div>
      <label class="ug-lbl">Notiz<textarea id="bh-notiz" rows="3">${_esc(b.notiz)}</textarea></label>

      <div class="bh-box">
        <p class="bh-stand">${stand ? _esc(stand) : 'Noch keine Genehmigung angefordert.'}</p>
        ${b.kommentar ? `<p class="bh-stand">Kommentar des Genehmigers: ${_esc(b.kommentar)}</p>` : ''}
        ${b.abasGesendet ? `<p class="bh-stand">Info zum Austragen im abas ging an ${_esc(b.abasInfoAn)}.</p>` : ''}
        <label class="bh-check"><input type="checkbox" id="bh-anfordern"> ${laeuft ? 'Genehmigung neu anfordern' : 'Genehmigung anfordern'}</label>
        <div id="bh-anf" style="display:none;">
          <div class="ug-lbl bh-such"><label for="bh-genehmiger">Genehmiger (Name oder Mail eintippen, mehrere mit ;)</label>
            <input id="bh-genehmiger" type="text" value="${_esc(laeuft ? '' : b.genehmigungAn)}" autocomplete="off" placeholder="Name oder vorname.nachname@…"
              role="combobox" aria-autocomplete="list" aria-expanded="false" aria-controls="bh-genehmiger-vorschlaege">
            <ul class="bh-vorschlaege" id="bh-genehmiger-vorschlaege" role="listbox" hidden></ul></div>
          <label class="ug-lbl">Kommentar an den Genehmiger<textarea id="bh-anfkommentar" rows="2"></textarea></label>
          <label class="bh-check"><input type="checkbox" id="bh-abas"${abasVorgabe ? ' checked' : ''}> Nach der Genehmigung Info zum Austragen im abas an</label>
          <div class="bh-raster bh-abas">
            <div class="ug-lbl bh-such"><label for="bh-abasan">Adresse (Name oder Mail)</label>
              <input id="bh-abasan" value="${_esc(abasVorgabe)}" autocomplete="off" role="combobox" aria-autocomplete="list" aria-expanded="false" aria-controls="bh-abasan-vorschlaege">
              <ul class="bh-vorschlaege" id="bh-abasan-vorschlaege" role="listbox" hidden></ul></div>
          </div>
        </div>
      </div>

      <p class="ug-meldung" id="bh-meldung" role="status"></p>
      <div class="ug-aktionen">
        <button type="button" class="ug-sek" data-bh-zu>Abbrechen</button>
        <button type="button" class="ug-prim" data-bh-speichern>Speichern</button>
      </div>
    </form>`;

  const anf = dlg.querySelector('#bh-anfordern');
  anf.addEventListener('change', () => {
    dlg.querySelector('#bh-anf').style.display = anf.checked ? '' : 'none';
    dlg.querySelector('[data-bh-speichern]').textContent = anf.checked ? 'Speichern und Genehmigung anfordern' : 'Speichern';
    if (anf.checked) dlg.querySelector('#bh-genehmiger').focus();
  });
  dlg.querySelectorAll('[data-bh-zu]').forEach(x => x.addEventListener('click', () => dlg.close()));
  dlg.querySelector('[data-bh-speichern]').addEventListener('click', _bhSpeichern);
  _bhPersonenFeld(dlg.querySelector('#bh-genehmiger'), dlg.querySelector('#bh-genehmiger-vorschlaege'));
  _bhPersonenFeld(dlg.querySelector('#bh-abasan'), dlg.querySelector('#bh-abasan-vorschlaege'));
  if (typeof dlg.showModal === 'function') dlg.showModal(); else dlg.setAttribute('open', '');
  dlg.querySelector('#bh-varial').focus();
}

/* ── Personen vorschlagen (Genehmiger, abas-Info) ───────────────────────── */
// Vorschläge kommen aus den zuletzt gewählten Personen (Browser), den Genehmigern, die
// im Monitoring schon vorkommen, und, wenn die App das Recht User.ReadBasic.All hat,
// aus dem Firmenverzeichnis (Name, Mail, Anmeldename).

const BH_VERZEICHNIS = 'https://graph.microsoft.com/User.ReadBasic.All';
const _bhSuche = { erlaubt: null, cache: new Map(), token: null, ablauf: 0 };

function _bhZuletzt() {
  try { return JSON.parse(localStorage.getItem('bh-personen') || '[]') || []; } catch (e) { return []; }
}

function _bhZuletztMerken(personen) {
  const alt = _bhZuletzt();
  const gleich = (a, b) => a.mail.toLowerCase() === b.mail.toLowerCase();
  // bekannten Namen behalten, wenn eine Adresse diesmal ohne Namen kommt
  const frisch = personen.map(p => ({ mail: p.mail, name: p.name || ((alt.find(x => gleich(x, p)) || {}).name || '') }));
  const neu = frisch.concat(alt.filter(p => !frisch.some(x => gleich(x, p))));
  try { localStorage.setItem('bh-personen', JSON.stringify(neu.slice(0, 30))); } catch (e) { /* ohne Speicher */ }
}

/** Bekannte Personen: zuletzt gewählt, dann Genehmiger aus den geladenen Rechnungen. */
function _bhBekannte() {
  const liste = _bhZuletzt().slice();
  const recs = typeof _monRecords !== 'undefined' ? _monRecords : [];
  recs.forEach(r => String((r.bh && r.bh.genehmigungAn) || '').split(';').map(x => x.trim()).filter(Boolean)
    .forEach(mail => { if (!liste.some(p => p.mail.toLowerCase() === mail.toLowerCase())) liste.push({ name: '', mail }); }));
  return liste;
}

async function _bhVerzeichnisToken(interaktiv) {
  // Token nach erfolgreicher Freigabe eine Weile merken, sonst fragt jede Suche neu
  if (_bhSuche.token && Date.now() < _bhSuche.ablauf) return _bhSuche.token;
  let token = null;
  if (interaktiv && typeof acquireTokenPopupSafe === 'function') {
    token = await acquireTokenPopupSafe([BH_VERZEICHNIS]);
  } else if (typeof _msal !== 'undefined' && _msal && typeof _account !== 'undefined' && _account) {
    token = (await _msal.acquireTokenSilent({ scopes: [BH_VERZEICHNIS], account: _account })).accessToken;
  }
  if (token) { _bhSuche.token = token; _bhSuche.ablauf = Date.now() + 40 * 60 * 1000; }
  return token;
}

/** Firmenverzeichnis nach Name, Mail oder Anmeldename durchsuchen (höchstens 8 Treffer). */
async function bhPersonenSuchen(text, interaktiv) {
  const q = String(text || '').replace(/["\\]/g, '').trim();
  if (q.length < 2) return [];
  if (_bhSuche.cache.has(q)) return _bhSuche.cache.get(q);
  const token = await _bhVerzeichnisToken(interaktiv);
  if (!token) throw new Error('kein Token');
  const suche = encodeURIComponent(`"displayName:${q}" OR "mail:${q}" OR "userPrincipalName:${q}"`);
  const resp = await fetch(`${SP.graphBase}/users?$search=${suche}&$select=displayName,mail,userPrincipalName&$top=8&$count=true`, {
    headers: { 'Authorization': `Bearer ${token}`, 'ConsistencyLevel': 'eventual', 'Accept': 'application/json' },
  });
  if (!resp.ok) throw new Error(`Verzeichnis (${resp.status})`);
  const daten = await resp.json();
  const treffer = (daten.value || [])
    .map(u => ({ name: u.displayName || '', mail: u.mail || u.userPrincipalName || '' }))
    .filter(p => /@/.test(p.mail) && !/#EXT#/i.test(p.mail));
  _bhSuche.cache.set(q, treffer);
  return treffer;
}

/** Eingabefeld mit Vorschlagsliste: tippt man Name oder Mail, erscheinen passende Personen. */
function _bhPersonenFeld(input, liste) {
  if (!input || !liste) return;
  let treffer = [];
  let aktiv = -1;
  let lauf = 0;
  let zeitgeber = null;

  const teile = () => input.value.split(';');
  const suchtext = () => teile().pop().trim();
  const schliessen = () => { liste.hidden = true; input.setAttribute('aria-expanded', 'false'); aktiv = -1; };
  const zeigen = (eintraege, fuss, kopf) => {
    treffer = eintraege;
    aktiv = -1;
    liste.innerHTML = (kopf && eintraege.length ? `<li class="bh-vorschlag-info">${kopf}</li>` : '') + eintraege.map((p, i) => `<li role="option" id="${liste.id}-${i}" data-i="${i}">
        <strong>${_esc(p.name || p.mail)}</strong>${p.name ? `<span>${_esc(p.mail)}</span>` : ''}</li>`).join('')
      + (fuss || '');
    liste.hidden = !liste.innerHTML;
    input.setAttribute('aria-expanded', String(!liste.hidden));
  };
  const markieren = i => {
    const lis = liste.querySelectorAll('li[data-i]');
    aktiv = Math.max(-1, Math.min(lis.length - 1, i));
    lis.forEach((li, j) => li.classList.toggle('aktiv', j === aktiv));
    if (aktiv >= 0) { lis[aktiv].scrollIntoView({ block: 'nearest' }); input.setAttribute('aria-activedescendant', lis[aktiv].id); }
  };
  const waehlen = p => {
    const vorne = teile().slice(0, -1).map(x => x.trim()).filter(Boolean);
    input.value = vorne.concat([p.mail]).join('; ');
    if (input.id === 'bh-genehmiger') input.value += '; ';
    input.dataset.namen = JSON.stringify(Object.assign(JSON.parse(input.dataset.namen || '{}'), { [p.mail.toLowerCase()]: p.name }));
    _bhZuletztMerken([p]);
    schliessen();
    input.focus();
  };

  const suchen = async interaktiv => {
    const q = suchtext().toLowerCase();
    const nr = ++lauf;
    const bekannt = _bhBekannte().filter(p => !q || p.mail.toLowerCase().includes(q) || p.name.toLowerCase().includes(q)).slice(0, 6);
    if (q.length < 2) { zeigen(bekannt, '', 'Zuletzt verwendet'); return; }
    zeigen(bekannt, '<li class="bh-vorschlag-info">Suche im Firmenverzeichnis…</li>');
    let fuss = '';
    let gefunden = [];
    if (_bhSuche.erlaubt !== false || interaktiv) {
      try {
        gefunden = await bhPersonenSuchen(q, interaktiv);
        _bhSuche.erlaubt = true;
      } catch (e) {
        _bhSuche.erlaubt = false;
      }
    }
    if (nr !== lauf) return;
    if (_bhSuche.erlaubt === false) {
      fuss = '<li class="bh-vorschlag-info"><button type="button" data-verzeichnis>Im Firmenverzeichnis suchen</button>'
        + ' <small>Braucht einmal die Freigabe „Benutzer lesen“.</small></li>';
    } else if (!gefunden.length && !bekannt.length) {
      fuss = '<li class="bh-vorschlag-info">Niemand gefunden. Die Mailadresse geht auch direkt.</li>';
    }
    const alle = bekannt.concat(gefunden.filter(p => !bekannt.some(x => x.mail.toLowerCase() === p.mail.toLowerCase()))).slice(0, 8);
    zeigen(alle, fuss);
  };

  input.addEventListener('input', () => { clearTimeout(zeitgeber); zeitgeber = setTimeout(() => suchen(false), 250); });
  input.addEventListener('focus', () => suchen(false));
  input.addEventListener('blur', () => setTimeout(schliessen, 150));
  input.addEventListener('keydown', e => {
    if (liste.hidden) return;
    if (e.key === 'ArrowDown') { e.preventDefault(); markieren(aktiv + 1); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); markieren(aktiv - 1); }
    else if (e.key === 'Enter' && aktiv >= 0) { e.preventDefault(); waehlen(treffer[aktiv]); }
    else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); schliessen(); }
  });
  // mousedown statt click, damit das Feld den Fokus nicht vorher verliert
  liste.addEventListener('mousedown', e => {
    const li = e.target.closest('li[data-i]');
    if (li) { e.preventDefault(); waehlen(treffer[Number(li.dataset.i)]); return; }
    if (e.target.closest('[data-verzeichnis]')) {
      e.preventDefault();
      suchen(true).catch(() => {});
    }
  });
}

function _bhMeldung(text, art) {
  const el = document.getElementById('bh-meldung');
  if (!el) return;
  el.textContent = text || '';
  el.className = 'ug-meldung' + (art ? ' ' + art : '');
}

async function _bhSpeichern() {
  const a = _bhAktuell;
  const dlg = document.getElementById('bh-dialog');
  const wert = id => dlg.querySelector('#' + id).value;
  const neu = {
    varial: wert('bh-varial'), bestellnr: wert('bh-bestellnr'), bstatus: wert('bh-bstatus'),
    kontierung: wert('bh-kontierung'), genehmigt: wert('bh-genehmigt'),
    gfGesehen: dlg.querySelector('#bh-gf').checked, notiz: wert('bh-notiz'),
  };
  let felder = bhAenderungen(a.b, neu);
  const anfordern = dlg.querySelector('#bh-anfordern').checked;
  try {
    if (anfordern) {
      const abas = dlg.querySelector('#bh-abas').checked;
      felder = Object.assign(felder, bhAnforderung({
        genehmiger: wert('bh-genehmiger'), kommentar: wert('bh-anfkommentar'),
        abasInfo: abas, abasInfoAn: wert('bh-abasan'), von: a.user.username || '',
      }));
      if (bhInGenehmigung(a.b) && !window.confirm(`Es läuft schon eine Genehmigung (${bhGenehmigungsStand(a.b)}). Trotzdem neu anfordern?`)) return;
    }
  } catch (e) {
    _bhMeldung(e.message || String(e), 'nicht');
    return;
  }
  if (!Object.keys(felder).length) { dlg.close(); return; }

  const knopf = dlg.querySelectorAll('.ug-aktionen button');
  knopf.forEach(k => { k.disabled = true; });
  _bhMeldung('Wird gespeichert…');
  try {
    await bhSchreiben(a.r, felder);
    _bhUebernehmen(a.r, felder);
    // Genehmiger und abas-Adresse für die nächsten Vorschläge merken (mit Namen, falls gewählt)
    if (felder.GenehmigungAnfordern) {
      const namen = Object.assign({}, JSON.parse(dlg.querySelector('#bh-genehmiger').dataset.namen || '{}'),
        JSON.parse(dlg.querySelector('#bh-abasan').dataset.namen || '{}'));
      const mails = String(felder.GenehmigungAn || '').split(';').concat([felder.AbasInfoAn || ''])
        .map(m => m.trim()).filter(Boolean);
      _bhZuletztMerken(mails.map(m => ({ name: namen[m.toLowerCase()] || '', mail: m })));
    }
    dlg.close();
    if (typeof a.onGespeichert === 'function') a.onGespeichert();
  } catch (e) {
    _bhMeldung(e.message || String(e), 'nicht');
    knopf.forEach(k => { k.disabled = false; });
  }
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { BH_FELDER, BH_STATUS, BH_GENEHMIGT, bhAusFeldern, bhZiel, bhZusammen, bhMails,
    bhAenderungen, bhAnforderung, bhGenehmigungsStand, bhInGenehmigung };
}

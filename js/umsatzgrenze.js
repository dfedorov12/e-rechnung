/**
 * Umsatzgrenze 800.000 € (Übergangsregel E-Rechnung, § 27 Abs. 38 UStG)
 * =====================================================================
 * Für Leistungen 2027 dürfen nur Lieferanten, deren Gesamtumsatz im Vorjahr
 * höchstens 800.000 € betrug, noch sonstige Rechnungen (Papier/PDF) stellen.
 * Ab 2028 gilt die E-Rechnungspflicht für alle. Den Umsatz des Lieferanten
 * kennen wir nicht, also schätzt die Buchhaltung ihn im Monitoring ein:
 * „vermutlich über 800k“ oder „vermutlich bis 800k“. Je nach Einschätzung und
 * Rechnungsjahr gibt es eine Mailvorlage an den Lieferanten.
 *
 * Die Einschätzungen liegen je Lieferant in einer JSON-Datei auf der
 * Monitoring-Site (Standardbibliothek, Ordner Monitoring). Rechnungen ohne
 * Lieferantennamen (PDF ohne XML) werden über ihren Dateischlüssel zugeordnet.
 *
 * Maßgeblich ist laut Gesetz der Leistungszeitpunkt. Das Monitoring kennt nur
 * das Rechnungsdatum und nimmt es als Näherung.
 */

const UG = {
  grenze: 800000,
  kleinbetrag: 250,
  datei: 'Monitoring/lieferanten-umsatzgrenze.json',
};

const _ug = { siteId: null, itemId: null, eTag: null, daten: { version: 1, lieferanten: {}, rechnungen: {} }, geladen: false, fehler: '' };
const _UG_NL = String.fromCharCode(10);

/* ── Reine Logik (auch in tests/umsatzgrenze.test.js) ────────────────── */

/** Lieferantenname als Schlüssel: klein, nur Buchstaben/Ziffern, Leerraum gestaucht. */
function ugKey(name) {
  return String(name || '').toLowerCase()
    .replace(/[^a-z0-9äöüß]+/g, ' ').trim();
}

/** Schlüssel einer Rechnung, bleibt beim Einsortieren Rechnungseingang -> ERAR_<Werk> gleich. */
function ugRechnungKey(r) {
  return ((r.richtung || '').slice(0, 1) + '|' + (r.baseKey || r.file || r.nummer || '')).toLowerCase();
}

/** Phase nach Rechnungsjahr: 'uebergang' (bis 2026), 'grenze' (2027), 'pflicht' (ab 2028). */
function ugPhase(datumIso, heuteIso) {
  const d = /^\d{4}-\d{2}-\d{2}/.test(String(datumIso || '')) ? String(datumIso).slice(0, 10)
          : String(heuteIso || new Date().toISOString()).slice(0, 10);
  if (d < '2027-01-01') return 'uebergang';
  if (d < '2028-01-01') return 'grenze';
  return 'pflicht';
}

/**
 * Ist die Rechnung eine sonstige Rechnung im Eingang? Der Prüfdienst setzt
 * Formatmangel bei PDF ohne XML und bei fehlendem PDF/A-3 (/api/intake, P1/P2).
 */
function ugSonstige(r) {
  return (r.richtung || '') === 'Eingang' && !!r.formatmangel;
}

/** Kleinbetragsrechnung (§ 33 UStDV): immer als sonstige Rechnung zulässig. */
function ugKleinbetrag(r) {
  return r.brutto != null && Math.abs(r.brutto) <= UG.kleinbetrag;
}

/** Braucht die Rechnung eine Einschätzung (Button anzeigen)? */
function ugBraucht(r) {
  return ugSonstige(r) && !ugKleinbetrag(r);
}

/**
 * Was folgt aus Einschätzung und Phase?
 * @returns {{zulaessig:boolean, folge:string, vorlage:string}}
 */
function ugFolge(vermutung, phase) {
  if (phase === 'pflicht') {
    return { zulaessig: false, vorlage: 'pflicht',
      folge: 'Seit 2028 gilt die E-Rechnungspflicht für alle Lieferanten. E-Rechnung anfordern, bis dahin unter Vorbehalt.' };
  }
  if (phase === 'grenze') {
    return vermutung === 'ueber'
      ? { zulaessig: false, vorlage: 'ueber-anfordern',
          folge: 'Die Rechnung hätte als E-Rechnung kommen müssen. E-Rechnung anfordern, bis dahin unter Vorbehalt.' }
      : { zulaessig: true, vorlage: 'bis-hinweis',
          folge: 'Die sonstige Rechnung ist 2027 zulässig. Der Vorbehalt kann aufgelöst werden. Hinweis auf 2028 an den Lieferanten.' };
  }
  return vermutung === 'ueber'
    ? { zulaessig: true, vorlage: 'ueber-ankuendigen',
        folge: 'Bis Ende 2026 darf jeder Lieferant sonstige Rechnungen stellen. Lieferanten auf die Pflicht ab 2027 hinweisen.' }
    : { zulaessig: true, vorlage: 'bis-hinweis',
        folge: 'Bis Ende 2027 sind sonstige Rechnungen dieses Lieferanten zulässig. Hinweis auf 2028 an den Lieferanten.' };
}

/**
 * Mailvorlage an den Lieferanten.
 * @param {string} art   'ueber-anfordern' | 'ueber-ankuendigen' | 'bis-hinweis' | 'pflicht'
 * @param {object} p     { nummer, datum (TT.MM.JJJJ), jahr, absender }
 * @returns {{betreff:string, text:string}}
 */
function ugVorlage(art, p) {
  const nr = p.nummer ? ' ' + p.nummer : '';
  const vom = p.datum ? ' vom ' + p.datum : '';
  const vorjahr = p.jahr ? String(p.jahr - 1) : 'des Vorjahres';
  const formate = 'XRechnung oder ZUGFeRD/Factur-X (Profil EN 16931 oder höher)';
  const gruss = ['Mit freundlichen Grüßen', p.absender || ''].join(_UG_NL).trim();
  const absaetze = [];
  let betreff;

  switch (art) {
    case 'ueber-anfordern':
      betreff = `Rechnung${nr}${vom}: bitte als E-Rechnung senden`;
      absaetze.push(
        `Ihre Rechnung${nr}${vom} haben wir erhalten, allerdings als PDF bzw. auf Papier und nicht als E-Rechnung.`,
        'Für Leistungen ab dem 1. Januar 2027 dürfen Unternehmen, deren Gesamtumsatz im Vorjahr über 800.000 Euro lag, '
          + 'anderen Unternehmen im Inland nur noch E-Rechnungen stellen (§ 14 und § 27 Abs. 38 UStG). '
          + 'Nach unserer Einschätzung gilt das auch für Sie.',
        `Bitte senden Sie uns die Rechnung noch einmal als ${formate} an die bekannte Rechnungsadresse.`,
        `Lag Ihr Gesamtumsatz ${vorjahr} bei höchstens 800.000 Euro, genügt uns eine kurze Rückmeldung. `
          + 'Dann verarbeiten wir die Rechnung so, wie sie ist.');
      break;
    case 'ueber-ankuendigen':
      betreff = 'Ihre Rechnungen an uns ab 1. Januar 2027 als E-Rechnung';
      absaetze.push(
        `vielen Dank für Ihre Rechnung${nr}${vom}. Wir verarbeiten sie wie gewohnt.`,
        'Ab dem 1. Januar 2027 dürfen Unternehmen, deren Gesamtumsatz im Vorjahr über 800.000 Euro lag, '
          + 'anderen Unternehmen im Inland nur noch E-Rechnungen stellen. Nach unserer Einschätzung betrifft das auch Sie.',
        `Bitte stellen Sie Ihre Rechnungen an uns bis dahin auf ${formate} um. `
          + 'Gern auch früher, wir können E-Rechnungen schon heute empfangen.',
        'Falls Ihr Gesamtumsatz 2026 höchstens 800.000 Euro beträgt, geben Sie uns bitte kurz Bescheid. '
          + 'Dann haben Sie bis Ende 2027 Zeit.');
      break;
    case 'bis-hinweis':
      betreff = 'Ihre Rechnungen an uns ab 1. Januar 2028 als E-Rechnung';
      absaetze.push(
        `vielen Dank für Ihre Rechnung${nr}${vom}. Wir verarbeiten sie wie gewohnt.`,
        'Wir gehen davon aus, dass Ihr Jahresumsatz nicht über 800.000 Euro liegt. '
          + 'Dann dürfen Sie uns bis Ende 2027 noch Rechnungen auf Papier oder als PDF schicken. '
          + 'Ab dem 1. Januar 2028 gilt die E-Rechnungspflicht für alle Unternehmen.',
        `Bitte stellen Sie Ihre Rechnungen an uns bis dahin auf ${formate} um. `
          + 'Gern auch früher, wir können E-Rechnungen schon heute empfangen.');
      break;
    default: // 'pflicht'
      betreff = `Rechnung${nr}${vom}: bitte als E-Rechnung senden`;
      absaetze.push(
        `Ihre Rechnung${nr}${vom} haben wir erhalten, allerdings als PDF bzw. auf Papier und nicht als E-Rechnung.`,
        'Seit dem 1. Januar 2028 müssen Unternehmen anderen Unternehmen im Inland E-Rechnungen stellen. '
          + 'Ausgenommen sind nur Kleinbetragsrechnungen bis 250 Euro und Rechnungen von Kleinunternehmern.',
        `Bitte senden Sie uns die Rechnung noch einmal als ${formate} an die bekannte Rechnungsadresse.`);
  }

  const text = ['Sehr geehrte Damen und Herren,', ...absaetze, gruss].join(_UG_NL + _UG_NL);
  return { betreff, text };
}

/* ── Register lesen/schreiben (Monitoring-Site, Standardbibliothek) ───── */

/** Register laden. Fehlt die Datei, bleibt es leer; Fehler sind nicht fatal. */
async function ugLaden(siteId, token) {
  _ug.siteId = siteId;
  _ug.fehler = '';
  try {
    const meta = await fetch(`${SP.graphBase}/sites/${siteId}/drive/root:/${UG.datei}?$select=id,eTag`, {
      headers: { 'Authorization': `Bearer ${token}`, 'Accept': 'application/json' },
    });
    if (meta.status === 404) { _ug.itemId = null; _ug.eTag = null; _ug.geladen = true; return; }
    if (!meta.ok) throw new Error(`Register (${meta.status})`);
    const m = await meta.json();
    const inhalt = await fetch(`${SP.graphBase}/sites/${siteId}/drive/items/${m.id}/content`, {
      headers: { 'Authorization': `Bearer ${token}` },
    });
    if (!inhalt.ok) throw new Error(`Register-Inhalt (${inhalt.status})`);
    const d = await inhalt.json();
    _ug.daten = { version: 1, lieferanten: d.lieferanten || {}, rechnungen: d.rechnungen || {} };
    _ug.itemId = m.id;
    _ug.eTag = m.eTag;
    _ug.geladen = true;
  } catch (e) {
    _ug.fehler = e.message || String(e);
    console.warn('[Umsatzgrenze] Register nicht lesbar:', _ug.fehler);
  }
}

/** Einschätzung einer Rechnung (über Rechnungsschlüssel, sonst Lieferantenname). */
function ugFuer(r) {
  const d = _ug.daten;
  const zu = d.rechnungen[ugRechnungKey(r)];
  const key = (zu && zu.lieferant) || ugKey(r.steller);
  return key && d.lieferanten[key] ? Object.assign({ key }, d.lieferanten[key]) : null;
}

/** Lieferantenname für Rechnungen, die keinen mitbringen (PDF ohne XML). */
function ugLieferantName(r) {
  if (r.steller) return r.steller;
  const e = ugFuer(r);
  return e ? e.name : '';
}

/**
 * Einschätzung speichern: Eintrag mergen und mit If-Match schreiben. Hat jemand
 * anderes zwischendurch gespeichert (412), neu laden und einmal wiederholen.
 */
async function ugSpeichern(r, name, vermutung) {
  const user = (typeof getAuthUser === 'function' && getAuthUser()) || {};
  const key = ugKey(name);
  if (!key) throw new Error('Bitte den Lieferanten angeben.');
  const eintrag = {
    name: String(name).trim(),
    vermutung,
    am: new Date().toISOString(),
    von: user.username || '',
    vonName: user.name || user.username || '',
    rechnung: r.nummer || '',
  };
  const zuordnung = { lieferant: key, am: eintrag.am, von: eintrag.von };

  for (let versuch = 0; versuch < 2; versuch++) {
    const token = await acquireToken(SP.scopes);
    if (!token) throw new Error('Nicht angemeldet.');
    if (versuch > 0) await ugLaden(_ug.siteId, token);
    const alt = _ug.daten.lieferanten[key];
    const neu = {
      version: 1,
      lieferanten: Object.assign({}, _ug.daten.lieferanten, {
        [key]: Object.assign(eintrag, { verlauf: ((alt && alt.verlauf) || []).concat(alt ? [{
          vermutung: alt.vermutung, am: alt.am, vonName: alt.vonName }] : []).slice(-10) }),
      }),
      rechnungen: Object.assign({}, _ug.daten.rechnungen, { [ugRechnungKey(r)]: zuordnung }),
    };
    const body = new TextEncoder().encode(JSON.stringify(neu, null, 2));
    const url = _ug.itemId
      ? `${SP.graphBase}/sites/${_ug.siteId}/drive/items/${_ug.itemId}/content`
      : `${SP.graphBase}/sites/${_ug.siteId}/drive/root:/${UG.datei}:/content?@microsoft.graph.conflictBehavior=fail`;
    const headers = { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' };
    if (_ug.itemId && _ug.eTag) headers['If-Match'] = _ug.eTag;
    const resp = await fetch(url, { method: 'PUT', headers, body });
    if (resp.ok) {
      const m = await resp.json();
      _ug.daten = neu;
      _ug.itemId = m.id;
      _ug.eTag = m.eTag;
      return neu.lieferanten[key];
    }
    if ((resp.status === 412 || resp.status === 409) && versuch === 0) continue;
    if (resp.status === 403 || resp.status === 401) {
      throw new Error('Keine Schreibrechte auf der Monitoring-Site. Die Vorlage können Sie trotzdem nutzen.');
    }
    const t = await resp.text();
    throw new Error(`Speichern fehlgeschlagen (${resp.status}): ${t.slice(0, 200)}`);
  }
  throw new Error('Speichern fehlgeschlagen: Das Register wurde gleichzeitig geändert. Bitte erneut versuchen.');
}

/* ── Anzeige in der Tabelle ──────────────────────────────────────────── */

const _UG_LABEL = { ueber: 'über 800k', bis: 'bis 800k' };

/** HTML für die Buchungs-Spalte: Button bzw. Badge mit der Einschätzung. */
function ugZelle(r, idx) {
  if (!ugSonstige(r)) return '';
  if (ugKleinbetrag(r)) {
    return `<div title="Kleinbetragsrechnung bis 250 € brutto: als sonstige Rechnung immer zulässig" class="ug-badge ug-klein">Kleinbetrag</div>`;
  }
  const e = ugFuer(r);
  const phase = ugPhase(r.datum);
  if (!e) {
    const label = phase === 'pflicht' ? 'E-Rechnung anfordern' : '800k einschätzen';
    return `<button type="button" class="ug-btn" data-ug="${idx}" title="Lieferant über oder bis 800.000 € Umsatz? Mit Mailvorlage">${label}</button>`;
  }
  const folge = ugFolge(e.vermutung, phase);
  const tip = `${_UG_LABEL[e.vermutung] || e.vermutung} vermutet von ${e.vonName || e.von} am ${_monDate(e.am)}. ${folge.folge}`;
  return `<button type="button" class="ug-badge ug-${e.vermutung}${folge.zulaessig ? '' : ' ug-nicht'}" data-ug="${idx}" title="${_esc(tip)}">`
    + `${_esc(_UG_LABEL[e.vermutung] || e.vermutung)}${folge.zulaessig ? '' : ' · E-Rechnung fehlt'}</button>`;
}

/* ── Dialog ──────────────────────────────────────────────────────────── */

let _ugAktuell = null;

function ugDialogOeffnen(r, onGespeichert) {
  const dlg = document.getElementById('ug-dialog');
  if (!dlg) return;
  const e = ugFuer(r);
  const phase = ugPhase(r.datum);
  const user = (typeof getAuthUser === 'function' && getAuthUser()) || {};
  _ugAktuell = { r, onGespeichert, vermutung: e ? e.vermutung : '', phase, absender: user.name || '' };

  const jahr = Number(String(r.datum || '').slice(0, 4)) || new Date().getFullYear();
  const regel = {
    uebergang: `Rechnung aus ${jahr}: Bis Ende 2026 darf jeder Lieferant noch Papier oder PDF schicken. Die Einschätzung bereitet 2027 vor.`,
    grenze: 'Rechnung aus 2027: Sonstige Rechnungen sind nur zulässig, wenn der Gesamtumsatz des Lieferanten 2026 höchstens 800.000 € betrug.',
    pflicht: `Rechnung aus ${jahr}: Seit 2028 gilt die E-Rechnungspflicht für alle Lieferanten. Eine Einschätzung ist nicht mehr nötig.`,
  }[phase];

  dlg.innerHTML = `
    <form method="dialog" class="ug-form">
      <div class="ug-kopf">
        <h3>${phase === 'pflicht' ? 'E-Rechnung anfordern' : 'Lieferant über oder bis 800.000 € Umsatz?'}</h3>
        <button type="button" class="ug-x" data-ug-zu aria-label="Schließen">✕</button>
      </div>
      <p class="ug-regel">${_esc(regel)}</p>
      <div class="ug-felder">
        <label>Lieferant<input id="ug-name" list="ug-namen" value="${_esc(ugLieferantName(r))}" placeholder="Name wie auf der Rechnung" autocomplete="off"></label>
        <label>Rechnungsnr.<input id="ug-nr" value="${_esc(r.nummer || '')}"></label>
        <label>Datum<input id="ug-datum" value="${_esc(_monDate(r.datum))}"></label>
      </div>
      <datalist id="ug-namen">${Object.values(_ug.daten.lieferanten).map(l => `<option value="${_esc(l.name)}">`).join('')}</datalist>
      ${phase === 'pflicht' ? '' : `
      <div class="ug-wahl" role="radiogroup" aria-label="Einschätzung">
        <button type="button" class="ug-opt" data-ug-v="ueber" role="radio">
          <strong>Vermutlich über 800.000 €</strong>
          <span>Größerer Lieferant, Konzern, bekannte Marke</span>
        </button>
        <button type="button" class="ug-opt" data-ug-v="bis" role="radio">
          <strong>Vermutlich bis 800.000 €</strong>
          <span>Handwerker, kleiner Händler, Einzelunternehmen</span>
        </button>
      </div>`}
      ${e ? `<p class="ug-bisher">Bisher: ${_esc(_UG_LABEL[e.vermutung] || e.vermutung)}, eingeschätzt von ${_esc(e.vonName || e.von)} am ${_esc(_monDate(e.am))}${e.rechnung ? ' (Rechnung ' + _esc(e.rechnung) + ')' : ''}.</p>` : ''}
      <p class="ug-folge" id="ug-folge"></p>
      <div id="ug-vorlage-wrap" style="display:none;">
        <label class="ug-lbl">Betreff<input id="ug-betreff"></label>
        <label class="ug-lbl">Mailtext<textarea id="ug-text" rows="11"></textarea></label>
      </div>
      <p class="ug-hinweis">Kleinbetragsrechnungen bis 250 € brutto und Rechnungen von Kleinunternehmern (§ 19 UStG) sind ausgenommen, dafür ist keine Mail nötig.</p>
      <p class="ug-meldung" id="ug-meldung" role="status"></p>
      <div class="ug-aktionen">
        <button type="button" class="ug-sek" data-ug-kopie disabled>Text kopieren</button>
        ${phase === 'pflicht' ? '' : '<button type="button" class="ug-sek" data-ug-nur disabled>Nur speichern</button>'}
        <button type="button" class="ug-prim" data-ug-mail disabled>${phase === 'pflicht' ? 'In Outlook öffnen' : 'Speichern und Mail öffnen'}</button>
      </div>
    </form>`;

  dlg.querySelectorAll('[data-ug-v]').forEach(b => b.addEventListener('click', () => {
    _ugAktuell.vermutung = b.getAttribute('data-ug-v');
    _ugWahlZeigen();
    _ugVorlageNeu();
  }));
  ['ug-nr', 'ug-datum'].forEach(id => dlg.querySelector('#' + id).addEventListener('input', _ugVorlageNeu));
  dlg.querySelector('#ug-name').addEventListener('input', _ugKnoepfe);
  dlg.querySelector('[data-ug-zu]').addEventListener('click', () => dlg.close());
  dlg.querySelector('[data-ug-kopie]').addEventListener('click', _ugKopieren);
  const nur = dlg.querySelector('[data-ug-nur]');
  if (nur) nur.addEventListener('click', () => _ugAbschliessen(false));
  dlg.querySelector('[data-ug-mail]').addEventListener('click', () => _ugAbschliessen(true));

  _ugWahlZeigen();
  _ugVorlageNeu();
  if (typeof dlg.showModal === 'function') dlg.showModal(); else dlg.setAttribute('open', '');
  const nameEl = dlg.querySelector('#ug-name');
  if (!nameEl.value) nameEl.focus();
}

function _ugWahlZeigen() {
  document.querySelectorAll('#ug-dialog [data-ug-v]').forEach(b => {
    const an = b.getAttribute('data-ug-v') === _ugAktuell.vermutung;
    b.classList.toggle('an', an);
    b.setAttribute('aria-checked', an ? 'true' : 'false');
  });
}

function _ugVorlageNeu() {
  const a = _ugAktuell;
  const dlg = document.getElementById('ug-dialog');
  const wrap = dlg.querySelector('#ug-vorlage-wrap');
  const folgeEl = dlg.querySelector('#ug-folge');
  if (a.phase !== 'pflicht' && !a.vermutung) {
    wrap.style.display = 'none';
    folgeEl.textContent = '';
    _ugKnoepfe();
    return;
  }
  const folge = ugFolge(a.vermutung, a.phase);
  folgeEl.textContent = folge.folge;
  folgeEl.className = 'ug-folge ' + (folge.zulaessig ? 'ok' : 'nicht');
  const datum = dlg.querySelector('#ug-datum').value.trim();
  const jahr = Number((datum.match(/(\d{4})$/) || [])[1]) || Number(String(a.r.datum || '').slice(0, 4)) || null;
  const v = ugVorlage(folge.vorlage, {
    nummer: dlg.querySelector('#ug-nr').value.trim(), datum, jahr, absender: a.absender,
  });
  dlg.querySelector('#ug-betreff').value = v.betreff;
  dlg.querySelector('#ug-text').value = v.text;
  wrap.style.display = '';
  _ugKnoepfe();
}

function _ugKnoepfe() {
  const a = _ugAktuell;
  const dlg = document.getElementById('ug-dialog');
  const hatName = !!ugKey(dlg.querySelector('#ug-name').value);
  const hatWahl = a.phase === 'pflicht' || !!a.vermutung;
  dlg.querySelector('[data-ug-kopie]').disabled = !hatWahl;
  const nur = dlg.querySelector('[data-ug-nur]');
  if (nur) nur.disabled = !(hatWahl && hatName);
  dlg.querySelector('[data-ug-mail]').disabled = !(hatWahl && (hatName || a.phase === 'pflicht'));
}

function _ugMeldung(text, art) {
  const el = document.getElementById('ug-meldung');
  if (!el) return;
  el.textContent = text || '';
  el.className = 'ug-meldung' + (art ? ' ' + art : '');
}

async function _ugKopieren() {
  const dlg = document.getElementById('ug-dialog');
  const t = 'Betreff: ' + dlg.querySelector('#ug-betreff').value + _UG_NL + _UG_NL + dlg.querySelector('#ug-text').value;
  try { await navigator.clipboard.writeText(t); _ugMeldung('Text kopiert.', 'ok'); }
  catch (e) { _ugMeldung('Kopieren nicht möglich, bitte den Text markieren und kopieren.', 'nicht'); }
}

function _ugMailOeffnen() {
  const dlg = document.getElementById('ug-dialog');
  const crlf = String.fromCharCode(13, 10);
  const text = dlg.querySelector('#ug-text').value.split(_UG_NL).join(crlf);
  window.location.href = 'mailto:?subject=' + encodeURIComponent(dlg.querySelector('#ug-betreff').value)
    + '&body=' + encodeURIComponent(text);
}

async function _ugAbschliessen(mitMail) {
  const a = _ugAktuell;
  const dlg = document.getElementById('ug-dialog');
  if (a.phase === 'pflicht') { if (mitMail) _ugMailOeffnen(); return; }
  const name = dlg.querySelector('#ug-name').value.trim();
  dlg.querySelectorAll('.ug-aktionen button').forEach(b => { b.disabled = true; });
  _ugMeldung('Wird gespeichert…');
  try {
    await ugSpeichern(a.r, name, a.vermutung);
    if (mitMail) _ugMailOeffnen();
    dlg.close();
    if (typeof a.onGespeichert === 'function') a.onGespeichert();
  } catch (e) {
    _ugMeldung(e.message || String(e), 'nicht');
    _ugKnoepfe();
    if (mitMail && /Schreibrechte/.test(e.message || '')) _ugMailOeffnen();
  }
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { UG, ugKey, ugRechnungKey, ugPhase, ugSonstige, ugKleinbetrag, ugBraucht, ugFolge, ugVorlage };
}

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
  // Mailaufträge an Lieferanten (Liste auf der Monitoring-Site). Der Flow
  // „Kreditor-Mail senden“ verschickt sie aus dem Postfach des Werks,
  // siehe docs/Kreditor-Mail-Flow.md.
  mailListe: 'KreditorMails',
};

/** Art des Mailauftrags je Vorlage (Spalte Art der Liste KreditorMails). */
const UG_MAIL_ART = {
  'ueber-ruecksendung': '800k Variante 1 Ruecksendung',
  'bis-akzeptanz': '800k Variante 2 Akzeptanz',
  'ueber-ankuendigen': '800k Ankuendigung 2027',
  'bis-hinweis': '800k Hinweis 2028',
  'pflicht': 'E-Rechnungspflicht 2028',
};

/** Plausible Mailadresse? */
function ugMailOk(s) {
  return /^[^\s@,;]+@[^\s@,;]+\.[A-Za-z]{2,}$/.test(String(s || '').trim());
}

/** Mailtext als einfaches HTML für den Flow: maskiert, Absätze und Zeilenumbrüche erhalten. */
function ugMailHtml(text) {
  const esc = s => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  return String(text || '').split(_UG_NL + _UG_NL)
    .map(abs => '<p>' + esc(abs).split(_UG_NL).join('<br>') + '</p>').join('');
}

const _ug = { siteId: null, itemId: null, eTag: null, daten: { version: 1, lieferanten: {}, rechnungen: {} }, geladen: false, fehler: '',
  mailListId: null, mails: {} };
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
      folge: 'Seit 2028 gilt die E-Rechnungspflicht für alle Lieferanten. Die PDF wird nicht als Eingangsrechnung akzeptiert, E-Rechnung anfordern.' };
  }
  if (phase === 'grenze') {
    return vermutung === 'ueber'
      ? { zulaessig: false, vorlage: 'ueber-ruecksendung',
          folge: 'Vorlage Variante 1, Rücksendung der Rechnung: Die PDF wird nicht als Eingangsrechnung akzeptiert. Der Lieferant soll eine E-Rechnung schicken oder seinen Umsatz schriftlich bestätigen.' }
      : { zulaessig: true, vorlage: 'bis-akzeptanz',
          folge: 'Vorlage Variante 2, Akzeptanz der Rechnung: Die Rechnung wird weiterverarbeitet. Der Lieferant soll künftig E-Rechnungen schicken, ab 2028 geht keine PDF mehr.' };
  }
  return vermutung === 'ueber'
    ? { zulaessig: true, vorlage: 'ueber-ankuendigen',
        folge: 'Bis Ende 2026 darf jeder Lieferant noch PDF-Rechnungen stellen. Der Lieferant wird auf die Pflicht ab 2027 hingewiesen.' }
    : { zulaessig: true, vorlage: 'bis-hinweis',
        folge: 'Bis Ende 2027 sind PDF-Rechnungen dieses Lieferanten zulässig. Der Lieferant wird auf 2028 hingewiesen.' };
}

/**
 * Mailvorlage an den Lieferanten. Für Rechnungen aus 2027 gelten die Vorlagen
 * der Buchhaltung (E-Rechnungsprüfung.docx): Variante 1 „Rücksendung der
 * Rechnung“ und Variante 2 „Akzeptanz der Rechnung“, wörtlich übernommen.
 * Für 2026 (Ankündigung) und ab 2028 (Pflicht für alle) gibt es Texte im
 * selben Ton.
 * @param {string} art   'ueber-ruecksendung' | 'bis-akzeptanz' | 'ueber-ankuendigen' | 'bis-hinweis' | 'pflicht'
 * @param {object} p     { nummer, datum (TT.MM.JJJJ), jahr, absender }
 * @returns {{betreff:string, text:string}}
 */
function ugVorlage(art, p) {
  const nr = p.nummer ? ' ' + p.nummer : '';
  const vom = p.datum ? ' vom ' + p.datum : '';
  const formate = 'entweder als XRechnung (XML-Datensatz) oder im ZUGFeRD-Format';
  const gruss = ['Mit freundlichen Grüßen', p.absender || ''].join(_UG_NL).trim();
  const absaetze = [];
  let betreff;

  switch (art) {
    case 'ueber-ruecksendung':      // Variante 1: Rücksendung der Rechnung
      betreff = `Ihre Rechnung${nr}${vom}: bitte als elektronische Rechnung senden`;
      absaetze.push(
        'seit dem 1. Januar 2027 besteht die Pflicht zur Ausstellung einer elektronischen Rechnung. '
          + 'Wir haben von Ihnen eine Rechnung als reines PDF-Dokument erhalten. Dies ist als Übergangslösung '
          + 'nur dann erlaubt, solange Ihre Umsätze die Schwelle von € 800.000 nicht erreichen. In Ihrem Fall '
          + 'müssen wir davon ausgehen, dass diese Voraussetzung nicht erfüllt ist.',
        'Das vorliegende PDF-Dokument können wir aus diesem Grund leider nicht als Eingangsrechnung akzeptieren. '
          + 'Wir hoffen auf Ihr Verständnis und möchten Sie bitten, uns eine elektronische Rechnung '
          + `${formate} zu übersenden.`,
        'Sollten Ihre Vorjahresumsätze die Schwelle von € 800.000 tatsächlich nicht erreichen, bitten wir um '
          + 'entsprechende schriftliche Bestätigung.');
      break;
    case 'bis-akzeptanz':           // Variante 2: Akzeptanz der Rechnung
      betreff = `Ihre Rechnung${nr}${vom}: künftig als elektronische Rechnung`;
      absaetze.push(
        'seit dem 1. Januar 2027 besteht die Pflicht zur Ausstellung einer elektronischen Rechnung. '
          + 'Wir haben von Ihnen eine Rechnung als reines PDF-Dokument erhalten. Dies ist als Übergangslösung '
          + 'erlaubt, solange Ihre Vorjahresumsätze die Schwelle von € 800.000 nicht erreichen. Wir gehen davon '
          + 'aus, dass diese Voraussetzung in Ihrem Fall erfüllt ist. Entsprechend werden wir Ihre Rechnung '
          + 'weiterverarbeiten.',
        'Wir möchten Sie jedoch bitten, uns zukünftig eine elektronische Rechnung '
          + `${formate} zu übersenden, sobald Ihnen dies möglich ist. Vorsorglich weisen wir darauf hin, `
          + 'dass wir reine PDF-Rechnungen ab dem 1. Januar 2028 nicht mehr akzeptieren dürfen.');
      break;
    case 'ueber-ankuendigen':       // 2026, vermutlich über 800.000 €
      betreff = 'Ihre Rechnungen an uns ab 1. Januar 2027 als elektronische Rechnung';
      absaetze.push(
        `vielen Dank für Ihre Rechnung${nr}${vom}, die wir wie gewohnt weiterverarbeiten.`,
        'Ab dem 1. Januar 2027 besteht die Pflicht zur Ausstellung einer elektronischen Rechnung. Reine '
          + 'PDF-Dokumente sind dann nur noch als Übergangslösung erlaubt, solange die Vorjahresumsätze die '
          + 'Schwelle von € 800.000 nicht erreichen. In Ihrem Fall müssen wir davon ausgehen, dass diese '
          + 'Voraussetzung nicht erfüllt ist.',
        `Wir möchten Sie deshalb bitten, uns ab dem 1. Januar 2027 eine elektronische Rechnung ${formate} `
          + 'zu übersenden. Sollten Ihre Vorjahresumsätze die Schwelle von € 800.000 tatsächlich nicht '
          + 'erreichen, bitten wir um entsprechende schriftliche Bestätigung.');
      break;
    case 'bis-hinweis':             // 2026, vermutlich bis 800.000 €
      betreff = 'Ihre Rechnungen an uns als elektronische Rechnung';
      absaetze.push(
        `vielen Dank für Ihre Rechnung${nr}${vom}, die wir wie gewohnt weiterverarbeiten.`,
        'Ab dem 1. Januar 2027 besteht die Pflicht zur Ausstellung einer elektronischen Rechnung. Reine '
          + 'PDF-Dokumente sind als Übergangslösung weiter erlaubt, solange Ihre Vorjahresumsätze die Schwelle '
          + 'von € 800.000 nicht erreichen. Wir gehen davon aus, dass diese Voraussetzung in Ihrem Fall erfüllt ist.',
        `Wir möchten Sie jedoch bitten, uns zukünftig eine elektronische Rechnung ${formate} zu übersenden, `
          + 'sobald Ihnen dies möglich ist. Vorsorglich weisen wir darauf hin, dass wir reine PDF-Rechnungen '
          + 'ab dem 1. Januar 2028 nicht mehr akzeptieren dürfen.');
      break;
    default:                        // 'pflicht', ab 2028
      betreff = `Ihre Rechnung${nr}${vom}: bitte als elektronische Rechnung senden`;
      absaetze.push(
        'seit dem 1. Januar 2028 besteht für alle Unternehmen die Pflicht zur Ausstellung einer elektronischen '
          + 'Rechnung. Wir haben von Ihnen eine Rechnung als reines PDF-Dokument erhalten.',
        'Das vorliegende PDF-Dokument können wir aus diesem Grund leider nicht als Eingangsrechnung akzeptieren. '
          + 'Wir hoffen auf Ihr Verständnis und möchten Sie bitten, uns eine elektronische Rechnung '
          + `${formate} zu übersenden.`,
        'Ausgenommen sind nur Kleinbetragsrechnungen bis € 250 und Rechnungen von Kleinunternehmern.');
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

/** Einschätzung einer Rechnung: über Rechnungsschlüssel, USt-IdNr. oder Lieferantenname. */
function ugFuer(r) {
  const d = _ug.daten;
  const zu = d.rechnungen[ugRechnungKey(r)];
  let key = (zu && zu.lieferant) || '';
  if (!key && r.ustid) key = Object.keys(d.lieferanten).find(k => d.lieferanten[k].vat === r.ustid) || '';
  if (!key) key = ugKey(r.steller);
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
async function ugSpeichern(r, name, vermutung, vat, nummer) {
  const user = (typeof getAuthUser === 'function' && getAuthUser()) || {};
  const key = ugKey(name);
  if (!key) throw new Error('Bitte den Lieferanten angeben.');
  const eintrag = {
    name: String(name).trim(),
    vat: vat || (_ug.daten.lieferanten[key] && _ug.daten.lieferanten[key].vat) || r.ustid || '',
    vermutung,
    am: new Date().toISOString(),
    von: user.username || '',
    vonName: user.name || user.username || '',
    rechnung: nummer || r.nummer || '',
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

/* ── Mailaufträge (Liste KreditorMails, Versand über den Flow) ────────── */

/**
 * Liste KreditorMails finden und ihre Einträge laden. Fehlt die Liste, bleibt
 * der Versand aus dem Werks-Postfach aus und der Dialog öffnet Outlook wie bisher.
 */
async function ugMailsLaden(siteId, token, listen) {
  _ug.mailListId = null;
  _ug.mails = {};
  const l = (listen || []).find(x => x.name === UG.mailListe || x.displayName === UG.mailListe);
  if (!l) return;
  _ug.mailListId = l.id;
  try {
    let url = `${SP.graphBase}/sites/${siteId}/lists/${l.id}/items?$expand=fields($select=Title,An,Werk,Art,Status,GesendetAm,Fehlermeldung,RechnungKey,AngefordertVon,Created)&$top=500`;
    for (let seiten = 0; url && seiten < 10; seiten++) {
      const seite = await _get(url, token);
      for (const it of seite.value || []) {
        const f = it.fields || {};
        if (!f.RechnungKey) continue;
        (_ug.mails[f.RechnungKey] = _ug.mails[f.RechnungKey] || []).push({
          betreff: f.Title || '', an: f.An || '', art: f.Art || '', status: f.Status || '',
          gesendetAm: f.GesendetAm || '', fehler: f.Fehlermeldung || '', von: f.AngefordertVon || '',
          am: f.Created || it.createdDateTime || '',
        });
      }
      url = seite['@odata.nextLink'] || null;
    }
    for (const k of Object.keys(_ug.mails)) _ug.mails[k].sort((a, b) => String(b.am).localeCompare(String(a.am)));
  } catch (e) {
    console.warn('[Umsatzgrenze] Mailaufträge nicht lesbar:', e.message || e);
  }
}

/** Mailaufträge zu einer Rechnung, neueste zuerst. */
function ugMailsFuer(r) {
  return _ug.mails[ugRechnungKey(r)] || [];
}

/** Kann der Dialog aus dem Werks-Postfach senden? (Liste vorhanden, echtes Werk) */
function ugKannSenden(r) {
  return !!_ug.mailListId && /^[A-Z]{2,4}$/.test(String(r.werk || ''));
}

/** Mailauftrag anlegen. Der Flow „Kreditor-Mail senden“ verschickt ihn und setzt den Status. */
async function ugMailBeauftragen(r, m) {
  const user = (typeof getAuthUser === 'function' && getAuthUser()) || {};
  const token = await acquireToken(SP.scopes);
  if (!token) throw new Error('Nicht angemeldet.');
  const fields = {
    Title: String(m.betreff || '').slice(0, 255),
    An: String(m.an || '').trim(),
    Werk: r.werk,
    Art: UG_MAIL_ART[m.vorlage] || m.vorlage || '',
    MailText: m.text,
    MailHtml: ugMailHtml(m.text),
    Rechnung: String(m.nummer || r.nummer || '').slice(0, 255),
    RechnungKey: ugRechnungKey(r),
    Lieferant: String(m.lieferant || '').slice(0, 255),
    RechnungUrl: r.url || '',
    Status: 'Wartet',
    AngefordertVon: user.username || '',
  };
  const resp = await fetch(`${SP.graphBase}/sites/${_ug.siteId}/lists/${_ug.mailListId}/items`, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ fields }),
  });
  if (!resp.ok) {
    if (resp.status === 403 || resp.status === 401) throw new Error('Keine Schreibrechte auf die Liste KreditorMails.');
    const t = await resp.text();
    throw new Error(`Mailauftrag nicht angelegt (${resp.status}): ${t.slice(0, 200)}`);
  }
  const eintrag = { betreff: fields.Title, an: fields.An, art: fields.Art, status: 'Wartet', gesendetAm: '', fehler: '',
    von: fields.AngefordertVon, am: new Date().toISOString() };
  (_ug.mails[fields.RechnungKey] = _ug.mails[fields.RechnungKey] || []).unshift(eintrag);
  return eintrag;
}

/** Kurztext zum letzten Mailauftrag einer Rechnung ('' = keiner). */
function _ugMailStand(m) {
  if (!m) return '';
  if (m.status === 'Gesendet') return `Mail an ${m.an} gesendet${m.gesendetAm ? ' am ' + _monDate(m.gesendetAm) : ''}`;
  if (m.status === 'Fehler') return `Versand an ${m.an} fehlgeschlagen${m.fehler ? ': ' + m.fehler : ''}`;
  return `Mail an ${m.an} wartet auf den Versand (beauftragt am ${_monDate(m.am)})`;
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
  const mail = ugMailsFuer(r)[0];
  const mailBadge = mail
    ? `<div><span class="ug-badge ug-mail-${mail.status === 'Gesendet' ? 'ok' : mail.status === 'Fehler' ? 'fehler' : 'wartet'}" title="${_esc(_ugMailStand(mail))}">`
      + `${mail.status === 'Gesendet' ? 'Mail gesendet' : mail.status === 'Fehler' ? 'Mail fehlgeschlagen' : 'Mail wartet'}</span></div>`
    : '';
  if (!e) {
    const label = phase === 'pflicht' ? 'E-Rechnung anfordern' : '800k einschätzen';
    return `<button type="button" class="ug-btn" data-ug="${idx}" title="Lieferant über oder bis 800.000 € Umsatz? Mit Mailvorlage">${label}</button>${mailBadge}`;
  }
  const folge = ugFolge(e.vermutung, phase);
  const tip = `${_UG_LABEL[e.vermutung] || e.vermutung} vermutet von ${e.vonName || e.von} am ${_monDate(e.am)}. ${folge.folge}`;
  return `<button type="button" class="ug-badge ug-${e.vermutung}${folge.zulaessig ? '' : ' ug-nicht'}" data-ug="${idx}" title="${_esc(tip)}">`
    + `${_esc(_UG_LABEL[e.vermutung] || e.vermutung)}${folge.zulaessig ? '' : ' · E-Rechnung fehlt'}</button>${mailBadge}`;
}

/* ── Dialog ──────────────────────────────────────────────────────────── */

let _ugAktuell = null;

/** TT.MM.JJJJ -> JJJJ-MM-TT (sonst leer). */
function _ugIso(de) {
  const m = /^(\d{1,2})\.(\d{1,2})\.(\d{4})$/.exec(String(de || '').trim());
  return m ? `${m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}` : '';
}

function ugDialogOeffnen(r, onGespeichert) {
  const dlg = document.getElementById('ug-dialog');
  if (!dlg) return;
  const e = ugFuer(r);
  const user = (typeof getAuthUser === 'function' && getAuthUser()) || {};
  _ugAktuell = {
    r, onGespeichert, bisher: e,
    vermutung: e ? e.vermutung : '',
    name: ugLieferantName(r),
    nr: r.nummer || '',
    datum: _monDate(r.datum),
    vat: r.ustid || (e && e.vat) || '',
    phase: ugPhase(r.datum),
    absender: user.name || '',
    an: r.absenderMail || ((ugMailsFuer(r)[0] || {}).an) || '',
    kannSenden: ugKannSenden(r),
    bearbeitet: {},          // Felder, die jemand selbst geändert hat, überschreibt das Lesen nicht
    gelesen: null,           // Ergebnis aus dem PDF-Text
    lesen: '',               // '' | 'laeuft' | 'fertig' | 'scan' | 'fehler'
  };
  _ugRender();
  if (typeof dlg.showModal === 'function') dlg.showModal(); else dlg.setAttribute('open', '');
  const nameEl = dlg.querySelector('#ug-name');
  if (!nameEl.value) nameEl.focus();
  _ugAusRechnungLesen(r);
}

function _ugRender() {
  const a = _ugAktuell;
  const dlg = document.getElementById('ug-dialog');
  const phase = a.phase;
  const jahr = Number((a.datum.match(/(\d{4})$/) || [])[1]) || new Date().getFullYear();
  const regel = {
    uebergang: `Rechnung aus ${jahr}: Bis Ende 2026 darf jeder Lieferant noch Papier oder PDF schicken. Die Einschätzung bereitet 2027 vor.`,
    grenze: 'Rechnung aus 2027: Sonstige Rechnungen sind nur zulässig, wenn der Gesamtumsatz des Lieferanten 2026 höchstens 800.000 € betrug.',
    pflicht: `Rechnung aus ${jahr}: Seit 2028 gilt die E-Rechnungspflicht für alle Lieferanten. Eine Einschätzung ist nicht mehr nötig.`,
  }[phase];
  const e = a.bisher;

  dlg.innerHTML = `
    <form method="dialog" class="ug-form">
      <div class="ug-kopf">
        <h3>${phase === 'pflicht' ? 'E-Rechnung anfordern' : 'Lieferant über oder bis 800.000 € Umsatz?'}</h3>
        <button type="button" class="ug-x" data-ug-zu aria-label="Schließen">✕</button>
      </div>
      <p class="ug-regel">${_esc(regel)}</p>
      <div class="ug-felder">
        <label>Lieferant<input id="ug-name" list="ug-namen" value="${_esc(a.name)}" placeholder="Name wie auf der Rechnung" autocomplete="off"></label>
        <label>Rechnungsnr.<input id="ug-nr" value="${_esc(a.nr)}"></label>
        <label>Datum<input id="ug-datum" value="${_esc(a.datum)}" placeholder="TT.MM.JJJJ"></label>
      </div>
      <datalist id="ug-namen">${Object.values(_ug.daten.lieferanten).map(l => `<option value="${_esc(l.name)}">`).join('')}</datalist>
      <label class="ug-lbl">An (Mailadresse des Lieferanten)<input id="ug-an" type="email" value="${_esc(a.an)}" placeholder="rechnung@lieferant.de" autocomplete="off"></label>
      <p class="ug-mailstand">${a.kannSenden
        ? `Senden geht aus dem Rechnungspostfach des Werks ${_esc(a.r.werk)}.${a.r.absenderMail ? ' Die Adresse ist der Absender der Rechnungsmail, bitte prüfen.' : ''}`
        : 'Der Versand aus dem Werks-Postfach ist hier nicht eingerichtet. Die Mail öffnet sich in Outlook.'}</p>
      ${ugMailsFuer(a.r).length ? `<ul class="ug-mails">${ugMailsFuer(a.r).slice(0, 3).map(m => `<li class="${m.status === 'Fehler' ? 'nicht' : m.status === 'Gesendet' ? 'ok' : ''}">${_esc(_ugMailStand(m))}</li>`).join('')}</ul>` : ''}
      <p class="ug-gelesen" id="ug-gelesen" role="status"></p>
      ${phase === 'pflicht' ? '' : `
      <div class="ug-wahl" role="radiogroup" aria-label="Einschätzung">
        <button type="button" class="ug-opt" data-ug-v="ueber" role="radio">
          <strong>Vermutlich über 800.000 €</strong>
          <span>${phase === 'grenze' ? 'Vorlage Variante 1: Rücksendung der Rechnung' : 'Größerer Lieferant, Konzern, bekannte Marke'}</span>
        </button>
        <button type="button" class="ug-opt" data-ug-v="bis" role="radio">
          <strong>Vermutlich bis 800.000 €</strong>
          <span>${phase === 'grenze' ? 'Vorlage Variante 2: Akzeptanz der Rechnung' : 'Handwerker, kleiner Händler, Einzelunternehmen'}</span>
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
        ${a.kannSenden
          ? `<button type="button" class="ug-sek" data-ug-mail disabled>In Outlook öffnen</button>
             ${phase === 'pflicht' ? '' : '<button type="button" class="ug-sek" data-ug-nur disabled>Nur speichern</button>'}
             <button type="button" class="ug-prim" data-ug-senden disabled>${phase === 'pflicht' ? 'Senden' : 'Speichern und senden'}</button>`
          : `${phase === 'pflicht' ? '' : '<button type="button" class="ug-sek" data-ug-nur disabled>Nur speichern</button>'}
             <button type="button" class="ug-prim" data-ug-mail disabled>${phase === 'pflicht' ? 'In Outlook öffnen' : 'Speichern und Mail öffnen'}</button>`}
      </div>
    </form>`;

  dlg.querySelectorAll('[data-ug-v]').forEach(b => b.addEventListener('click', () => {
    a.vermutung = b.getAttribute('data-ug-v');
    _ugWahlZeigen();
    _ugVorlageNeu();
  }));
  const feld = (id, key, nachher) => dlg.querySelector('#' + id).addEventListener('input', ev => {
    a[key] = ev.target.value;
    a.bearbeitet[key] = true;
    nachher();
  });
  feld('ug-name', 'name', _ugKnoepfe);
  feld('ug-nr', 'nr', _ugVorlageNeu);
  feld('ug-datum', 'datum', _ugVorlageNeu);
  feld('ug-an', 'an', _ugKnoepfe);
  // Ein anderes Rechnungsjahr kann die Regel ändern: dann neu aufbauen
  dlg.querySelector('#ug-datum').addEventListener('change', () => {
    const iso = _ugIso(a.datum);
    if (iso && ugPhase(iso) !== a.phase) { a.phase = ugPhase(iso); _ugRender(); }
  });
  dlg.querySelector('[data-ug-zu]').addEventListener('click', () => dlg.close());
  dlg.querySelector('[data-ug-kopie]').addEventListener('click', _ugKopieren);
  const nur = dlg.querySelector('[data-ug-nur]');
  if (nur) nur.addEventListener('click', () => _ugAbschliessen('nur'));
  dlg.querySelector('[data-ug-mail]').addEventListener('click', () => _ugAbschliessen('outlook'));
  const senden = dlg.querySelector('[data-ug-senden]');
  if (senden) senden.addEventListener('click', () => _ugAbschliessen('senden'));

  _ugGelesenZeigen();
  _ugWahlZeigen();
  _ugVorlageNeu();
}

/**
 * Lieferant, USt-IdNr., Nummer, Datum und Betrag aus dem PDF lesen (js/lieferant.js).
 * Nur wenn etwas fehlt und die Datei ein PDF ist. Was jemand schon selbst
 * eingetragen hat, bleibt stehen.
 */
async function _ugAusRechnungLesen(r) {
  const a = _ugAktuell;
  const fehlt = !r.steller || !r.ustid || r.nummer === r.baseKey || !r.datumAusRechnung || r.brutto == null;
  if (!fehlt || r.ext !== 'pdf' || !r.listId || !r.itemId || !_ug.siteId
      || typeof textAusPdf !== 'function' || typeof lieferantAusText !== 'function' || !window.pdfjsLib) return;
  a.lesen = 'laeuft';
  _ugGelesenZeigen();
  try {
    const token = await acquireToken(SP.scopes);
    if (!token) throw new Error('nicht angemeldet');
    const resp = await fetch(`${SP.graphBase}/sites/${_ug.siteId}/lists/${r.listId}/items/${r.itemId}/driveItem/content`,
      { headers: { 'Authorization': `Bearer ${token}` } });
    if (!resp.ok) throw new Error(`Datei (${resp.status})`);
    const l = lieferantAusText(await textAusPdf(await resp.arrayBuffer()));
    if (_ugAktuell !== a) return;                      // Dialog inzwischen zu oder andere Rechnung
    a.gelesen = l;
    a.lesen = l.lesbar ? 'fertig' : 'scan';
    if (!l.lesbar) { _ugGelesenZeigen(); return; }
    const vorher = a.phase;
    if (l.name && !a.bearbeitet.name && !r.steller) a.name = l.name;
    if (l.vat && !a.vat) a.vat = l.vat;
    if (l.nummer && !a.bearbeitet.nr && r.nummer === r.baseKey) a.nr = l.nummer;
    if (l.datum && !a.bearbeitet.datum && !r.datumAusRechnung) { a.datum = _monDate(l.datum); a.phase = ugPhase(l.datum); }
    if (l.kleinunternehmer && !a.vermutung) a.vermutung = 'bis';
    if (a.phase !== vorher) { _ugRender(); return; }
    const dlg = document.getElementById('ug-dialog');
    const setze = (id, v) => { const el = dlg.querySelector('#' + id); if (el) el.value = v; };
    setze('ug-name', a.name); setze('ug-nr', a.nr); setze('ug-datum', a.datum);
    _ugGelesenZeigen();
    _ugWahlZeigen();
    _ugVorlageNeu();
  } catch (e) {
    if (_ugAktuell !== a) return;
    a.lesen = 'fehler';
    a.lesenFehler = e.message || String(e);
    _ugGelesenZeigen();
  }
}

function _ugGelesenZeigen() {
  const a = _ugAktuell;
  const el = document.getElementById('ug-gelesen');
  if (!el) return;
  el.className = 'ug-gelesen';
  if (a.lesen === 'laeuft') { el.textContent = 'Rechnung wird gelesen…'; return; }
  if (a.lesen === 'scan') { el.textContent = 'Die Rechnung ist ein Scan ohne Text. Bitte den Lieferanten selbst eintragen.'; return; }
  if (a.lesen === 'fehler') { el.textContent = `Rechnung konnte nicht gelesen werden (${a.lesenFehler}). Bitte den Lieferanten selbst eintragen.`; return; }
  const l = a.gelesen;
  if (a.lesen !== 'fertig' || !l) { el.textContent = a.vat ? `USt-IdNr. ${a.vat}` : ''; return; }
  const teile = [];
  if (l.name) teile.push(l.name);
  if (l.vat) teile.push('USt-IdNr. ' + l.vat);
  if (l.nummer) teile.push('Nr. ' + l.nummer);
  if (l.datum) teile.push('vom ' + _monDate(l.datum));
  if (l.brutto != null) teile.push('Betrag ' + l.brutto.toLocaleString('de-DE', { style: 'currency', currency: 'EUR' }));
  let text = teile.length ? 'Aus der Rechnung gelesen: ' + teile.join(', ') + '.' : 'In der Rechnung war kein Lieferant zu finden. Bitte selbst eintragen.';
  if (l.kleinunternehmer) {
    text += ' Die Rechnung verweist auf § 19 UStG (Kleinunternehmer): keine E-Rechnungspflicht, keine Mail nötig.';
    el.className = 'ug-gelesen ok';
  } else if (l.brutto != null && Math.abs(l.brutto) <= UG.kleinbetrag) {
    text += ' Stimmt der Betrag, ist es ein Kleinbetrag bis 250 €: keine E-Rechnungspflicht, keine Mail nötig.';
    el.className = 'ug-gelesen ok';
  }
  el.textContent = text;
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
  const nameOk = hatName || a.phase === 'pflicht';
  dlg.querySelector('[data-ug-mail]').disabled = !(hatWahl && nameOk);
  const senden = dlg.querySelector('[data-ug-senden]');
  if (senden) senden.disabled = !(hatWahl && nameOk && ugMailOk(a.an));
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
  const an = ugMailOk(_ugAktuell.an) ? encodeURIComponent(_ugAktuell.an.trim()) : '';
  window.location.href = 'mailto:' + an + '?subject=' + encodeURIComponent(dlg.querySelector('#ug-betreff').value)
    + '&body=' + encodeURIComponent(text);
}

/**
 * Abschließen: 'nur' speichert die Einschätzung, 'outlook' speichert und öffnet
 * die Mail in Outlook, 'senden' speichert und legt einen Mailauftrag an, den der
 * Flow aus dem Werks-Postfach verschickt. Ab 2028 gibt es nichts zu speichern.
 */
async function _ugAbschliessen(modus) {
  const a = _ugAktuell;
  const dlg = document.getElementById('ug-dialog');
  if (modus === 'senden') {
    const an = String(a.an || '').trim();
    const frueher = ugMailsFuer(a.r).find(m => m.status !== 'Fehler');
    const frage = (frueher ? `Für diese Rechnung gibt es schon eine Mail (${_ugMailStand(frueher)}). ` : '')
      + `Mail an ${an} aus dem Rechnungspostfach des Werks ${a.r.werk} senden?`;
    if (!window.confirm(frage)) return;
  }
  dlg.querySelectorAll('.ug-aktionen button').forEach(b => { b.disabled = true; });
  try {
    if (a.phase !== 'pflicht') {
      _ugMeldung('Wird gespeichert…');
      await ugSpeichern(a.r, dlg.querySelector('#ug-name').value.trim(), a.vermutung, a.vat, a.nr);
    }
    if (modus === 'outlook') _ugMailOeffnen();
    if (modus === 'senden') {
      _ugMeldung('Mailauftrag wird angelegt…');
      await ugMailBeauftragen(a.r, {
        an: a.an, betreff: dlg.querySelector('#ug-betreff').value, text: dlg.querySelector('#ug-text').value,
        vorlage: ugFolge(a.vermutung, a.phase).vorlage, nummer: a.nr, lieferant: dlg.querySelector('#ug-name').value.trim(),
      });
    }
    dlg.close();
    if (typeof a.onGespeichert === 'function') a.onGespeichert();
  } catch (e) {
    _ugMeldung(e.message || String(e), 'nicht');
    _ugKnoepfe();
    if (modus === 'outlook' && /Schreibrechte/.test(e.message || '')) _ugMailOeffnen();
  }
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { UG, UG_MAIL_ART, ugKey, ugRechnungKey, ugPhase, ugSonstige, ugKleinbetrag, ugBraucht, ugFolge, ugVorlage,
    ugMailOk, ugMailHtml };
}

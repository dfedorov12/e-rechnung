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
 * Dieselbe Datei ist das Lieferantenregister: Bei der 800k-Einschätzung und unter
 * „Bearbeiten“ merkt sie sich Name, USt-IdNr., Mailadresse und die Schreibweisen aus
 * dem PDF-Text (aliase). Spätere Rechnungen desselben Lieferanten werden darüber
 * erkannt. Geprüft und bestätigt ist ein Lieferant erst, wenn die Kreditoren-
 * buchhaltung es ausdrücklich tut (Knopf „Bestätigen“ im 800k-Dialog, „Bearbeiten“),
 * dann zeigt das Monitoring ein grünes ✓ als Siegel.
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

/** Bringt die Rechnung eine E-Rechnungs-XML mit (ZUGFeRD, XRechnung)? */
function ugMitXml(r) {
  return /zugferd|factur|xrechnung|ubl|cii/i.test(r.format || '') || r.ext === 'xml'
    || (r.dateien || []).some(d => d.label === 'XML');
}

/**
 * Ist die Rechnung eine sonstige Rechnung im Eingang? Der Prüfdienst setzt
 * Formatmangel bei PDF ohne XML und bei fehlendem PDF/A-3 (/api/intake, P1/P2).
 * Für die 800k-Regel zählt nur die PDF ohne E-Rechnung: Eine ZUGFeRD-Rechnung mit
 * fehlerhafter PDF/A-Hülle bringt die XML mit und braucht keine Einschätzung.
 */
function ugSonstige(r) {
  return (r.richtung || '') === 'Eingang' && !!r.formatmangel && !ugMitXml(r);
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

/**
 * Lieferant einer Rechnung aus dem Register. treffer sagt, woher die Zuordnung kommt:
 * 'rechnung' (an dieser Rechnung bestätigt), 'vat' (gleiche USt-IdNr.), 'name' (gleicher
 * Name) oder 'alias' (Schreibweise aus dem PDF-Text, die schon einmal bestätigt wurde).
 * Name und Alias zählen nicht, wenn beide USt-IdNr. bekannt sind und sich unterscheiden.
 */
function ugLieferantFuer(r) {
  const d = _ug.daten;
  const treffer = (key, art) => key && d.lieferanten[key] ? Object.assign({ key, treffer: art }, d.lieferanten[key]) : null;
  const zu = d.rechnungen[ugRechnungKey(r)];
  if (zu && zu.lieferant && d.lieferanten[zu.lieferant]) return treffer(zu.lieferant, 'rechnung');
  if (r.ustid) {
    const k = Object.keys(d.lieferanten).find(x => d.lieferanten[x].vat === r.ustid);
    if (k) return treffer(k, 'vat');
  }
  const name = ugKey(r.steller);
  if (!name) return null;
  const passt = k => !(r.ustid && d.lieferanten[k].vat && d.lieferanten[k].vat !== r.ustid);
  if (d.lieferanten[name] && passt(name)) return treffer(name, 'name');
  const k = name.length >= 5 && Object.keys(d.lieferanten).find(x => passt(x)
    && (d.lieferanten[x].aliase || []).some(a => ugKey(a) === name));
  return k ? treffer(k, 'alias') : null;
}

/** Einschätzung zur 800k-Grenze: der Lieferant aus dem Register, sofern er eingeschätzt ist. */
function ugFuer(r) {
  const l = ugLieferantFuer(r);
  return l && l.vermutung ? l : null;
}

/**
 * Lieferant informiert? Ja oder Nein hält die Buchhaltung bei der Einschätzung an dieser
 * Rechnung fest (Mail gesendet oder nicht). Automatik: Der Lieferant war schon
 * eingeschätzt, an dieser Rechnung war keine Einschätzung nötig. Eine Mail über den
 * Flow zählt immer als Ja, auch bei E-Rechnungen (Zurückweisung, Hinweis auf
 * Abweichungen aus dem Eingangs-Flow). Leer: noch offen, Kleinbetrag oder E-Rechnung ohne Mail.
 */
function ugInformiert(r) {
  const perMail = ugMailsFuer(r).some(m => m.status !== 'Fehler');
  if (!ugSonstige(r)) return perMail ? 'Ja' : '';
  if (ugKleinbetrag(r)) return '';
  if (perMail) return 'Ja';
  const zu = _ug.daten.rechnungen[ugRechnungKey(r)];
  if (zu) return zu.informiert || '';
  return ugFuer(r) ? 'Automatik' : '';
}

/** Lieferantenname für den 800k-Dialog: bestätigt, aus der XML, aus dem Register, sonst aus dem PDF-Text. */
function ugLieferantName(r) {
  const l = ugLieferantFuer(r);
  if (l && l.treffer === 'rechnung') return l.name;
  if (r.steller && ugMitXml(r)) return r.steller;
  return (l && l.name) || r.steller || '';
}

/**
 * Lieferanten in einen Registereintrag übernehmen: Name und USt-IdNr. Weicht der Name aus
 * der Rechnung (PDF-Text) ab, kommt er zu den aliase, damit die nächste Rechnung mit
 * derselben Schreibweise erkannt wird. Mit opt.bestaetigen setzt die Kreditorenbuchhaltung
 * ihr Siegel (wer und wann). Alles andere bleibt, auch ein früheres Siegel.
 * @param opt  { bestaetigen: boolean, vat: USt-IdNr. aus dem Dialog }
 */
function ugLieferantMerken(alt, name, r, user, jetzt, opt) {
  const o = opt || {};
  const e = Object.assign({}, alt || {});
  e.name = String(name).trim();
  e.vat = e.vat || o.vat || r.ustid || '';
  const gelesen = String(r.steller || '').trim();
  const aliase = (e.aliase || []).filter(a => ugKey(a) !== ugKey(e.name));
  if (gelesen && ugKey(gelesen) !== ugKey(e.name) && !aliase.some(a => ugKey(a) === ugKey(gelesen))) aliase.push(gelesen);
  if (aliase.length) e.aliase = aliase.slice(-10); else delete e.aliase;
  if (o.bestaetigen) {
    e.bestaetigtAm = jetzt;
    e.bestaetigtVon = user.username || '';
    e.bestaetigtVonName = user.name || user.username || '';
  }
  return e;
}

/**
 * Register schreiben: aendern(daten) baut aus dem aktuellen Stand den neuen. Mit If-Match;
 * hat jemand anderes zwischendurch gespeichert (412), neu laden und einmal wiederholen.
 */
async function _ugSchreiben(aendern) {
  for (let versuch = 0; versuch < 2; versuch++) {
    const token = await acquireToken(SP.scopes);
    if (!token) throw new Error('Nicht angemeldet.');
    if (versuch > 0) await ugLaden(_ug.siteId, token);
    const neu = aendern(_ug.daten);
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
      return neu;
    }
    if ((resp.status === 412 || resp.status === 409) && versuch === 0) continue;
    if (resp.status === 403 || resp.status === 401) {
      throw new Error('Keine Schreibrechte auf das Lieferantenregister (Monitoring-Site, Dokumente/Monitoring/'
        + 'lieferanten-umsatzgrenze.json). Die IT muss dort „Mitwirken“ vergeben.');
    }
    const t = await resp.text();
    throw new Error(`Speichern fehlgeschlagen (${resp.status}): ${t.slice(0, 200)}`);
  }
  throw new Error('Speichern fehlgeschlagen: Das Register wurde gleichzeitig geändert. Bitte erneut versuchen.');
}

/**
 * Einschätzung speichern: Lieferant mit Einschätzung merken (der alte Stand geht in den
 * Verlauf) und die Rechnung ihm zuordnen. Mailadresse aus „An“ merken; ohne gültige
 * Eingabe bleibt die bisherige.
 */
async function ugSpeichern(r, name, vermutung, vat, nummer, informiert, mail) {
  const user = (typeof getAuthUser === 'function' && getAuthUser()) || {};
  const key = ugKey(name);
  if (!key) throw new Error('Bitte den Lieferanten angeben.');
  const am = new Date().toISOString();
  const neu = await _ugSchreiben(d => {
    const alt = d.lieferanten[key];
    const e = Object.assign(ugLieferantMerken(alt, name, r, user, am), {
      vat: vat || (alt && alt.vat) || r.ustid || '',
      vermutung, am,
      von: user.username || '',
      vonName: user.name || user.username || '',
      rechnung: nummer || r.nummer || '',
      mail: ugMailOk(mail) ? String(mail).trim() : ((alt && alt.mail) || ''),
      verlauf: ((alt && alt.verlauf) || []).concat(alt && alt.vermutung ? [{
        vermutung: alt.vermutung, am: alt.am, vonName: alt.vonName }] : []).slice(-10),
    });
    const zuordnung = Object.assign({}, d.rechnungen[ugRechnungKey(r)], { lieferant: key, am, von: e.von });
    if (informiert === 'Ja' || informiert === 'Nein') zuordnung.informiert = informiert;
    return { version: 1, lieferanten: Object.assign({}, d.lieferanten, { [key]: e }),
      rechnungen: Object.assign({}, d.rechnungen, { [ugRechnungKey(r)]: zuordnung }) };
  });
  return neu.lieferanten[key];
}

/**
 * Lieferant prüfen und bestätigen (Kreditorenbuchhaltung: Knopf im 800k-Dialog oder
 * „Bearbeiten“) und merken. Eine Einschätzung und die Mailadresse bleiben, die Rechnung
 * wird dem Lieferanten zugeordnet.
 * @param extra  { vat } USt-IdNr., falls der Dialog sie kennt
 */
async function ugBestaetigen(r, name, extra) {
  const user = (typeof getAuthUser === 'function' && getAuthUser()) || {};
  const key = ugKey(name);
  if (!key) throw new Error('Bitte den Lieferanten angeben.');
  const am = new Date().toISOString();
  const neu = await _ugSchreiben(d => ({
    version: 1,
    lieferanten: Object.assign({}, d.lieferanten, { [key]: ugLieferantMerken(d.lieferanten[key], name, r, user, am,
      { bestaetigen: true, vat: extra && extra.vat }) }),
    rechnungen: Object.assign({}, d.rechnungen, { [ugRechnungKey(r)]: Object.assign({}, d.rechnungen[ugRechnungKey(r)],
      { lieferant: key, am, von: user.username || '' }) }),
  }));
  return neu.lieferanten[key];
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

/**
 * Taugt der Absender der Rechnungsmail als Empfänger? Nicht, wenn die Mail von
 * innen kam (Scanner, weitergeleitet von Kollegen) oder nicht zustellbar ist.
 */
function _ugAbsenderOk(mail) {
  const m = String(mail || '').trim().toLowerCase();
  // noreply auch mitten in der Adresse (tuev-sued_noreply@…)
  if (!ugMailOk(m) || /(^|[._-])(no-?reply|do-?not-?reply)([._-]|@)|^(mailer-daemon|postmaster)@/.test(m)) return false;
  if (typeof istEigeneMail === 'function' && istEigeneMail(m)) return false;
  const user = (typeof getAuthUser === 'function' && getAuthUser()) || {};
  const eigen = String(user.username || '').toLowerCase().split('@')[1];
  return !(eigen && m.endsWith('@' + eigen));
}

/** Erste brauchbare Adresse aus der Spalte AbsenderMail (Reply-To kann mehrere enthalten). */
function _ugAbsenderWahl(feld) {
  return String(feld || '').split(/[;,\s]+/).find(_ugAbsenderOk) || '';
}

function ugDialogOeffnen(r, onGespeichert) {
  const dlg = document.getElementById('ug-dialog');
  if (!dlg) return;
  const e = ugFuer(r);
  // gemerkter Lieferant, auch wenn er noch nicht eingeschätzt ist (bestätigt unter „Bearbeiten“)
  const l = ugLieferantFuer(r);
  const user = (typeof getAuthUser === 'function' && getAuthUser()) || {};
  const absender = _ugAbsenderWahl(r.absenderMail);
  _ugAktuell = {
    r, onGespeichert, bisher: e,
    vermutung: e ? e.vermutung : '',
    name: ugLieferantName(r),
    nr: r.nummer || '',
    datum: _monDate(r.datum),
    vat: r.ustid || (l && l.vat) || '',
    phase: ugPhase(r.datum),
    absender: user.name || '',
    // Adresse: Mail an diese Rechnung, sonst beim Lieferanten gemerkt, sonst Absender der
    // Rechnungsmail, sonst aus dem PDF-Text (_ugAusRechnungLesen)
    an: ((ugMailsFuer(r)[0] || {}).an) || (l && l.mail) || absender || '',
    anQuelle: (ugMailsFuer(r)[0] || {}).an ? 'mail' : (l && l.mail) ? 'gemerkt' : absender ? 'absender' : '',
    informiert: ((_ug.daten.rechnungen[ugRechnungKey(r)] || {}).informiert) || 'Nein',
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
        <div class="ug-feld">
          <div class="ug-feldkopf"><label for="ug-name">Lieferant</label><span id="ug-siegel"></span></div>
          <input id="ug-name" list="ug-namen" value="${_esc(a.name)}" placeholder="Name wie auf der Rechnung" autocomplete="off">
        </div>
        <label>Rechnungsnr.<input id="ug-nr" value="${_esc(a.nr)}"></label>
        <label>Datum<input id="ug-datum" value="${_esc(a.datum)}" placeholder="TT.MM.JJJJ"></label>
      </div>
      <datalist id="ug-namen">${Object.values(_ug.daten.lieferanten).map(l => `<option value="${_esc(l.name)}">`).join('')}</datalist>
      <label class="ug-lbl">An (Mailadresse des Lieferanten)<input id="ug-an" type="email" value="${_esc(a.an)}" placeholder="rechnung@lieferant.de" autocomplete="off"></label>
      ${phase === 'pflicht' ? '' : `<label class="ug-lbl ug-inf">Lieferant informiert<select id="ug-informiert">
        ${['Nein', 'Ja'].map(v => `<option${v === a.informiert ? ' selected' : ''}>${v}</option>`).join('')}</select>
        <span class="ug-hinweis">Senden und „In Outlook öffnen“ setzen Ja. „Nur speichern“ nimmt den Wert hier, z. B. Ja nach einem Anruf.</span></label>`}
      <p class="ug-mailstand" id="ug-mailstand">${_esc(_ugMailstand(a))}</p>
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
  feld('ug-name', 'name', () => {
    // Anderer Lieferant gewählt: dessen gemerkte Adresse übernehmen, solange niemand „An“ geändert hat
    const l = _ug.daten.lieferanten[ugKey(a.name)];
    if (!a.bearbeitet.an && l && l.mail && l.mail !== a.an) {
      a.an = l.mail; a.anQuelle = 'gemerkt';
      dlg.querySelector('#ug-an').value = a.an;
    }
    _ugSiegel();
    _ugKnoepfe();
  });
  feld('ug-nr', 'nr', _ugVorlageNeu);
  feld('ug-datum', 'datum', _ugVorlageNeu);
  feld('ug-an', 'an', _ugKnoepfe);
  // Ein anderes Rechnungsjahr kann die Regel ändern: dann neu aufbauen
  dlg.querySelector('#ug-datum').addEventListener('change', () => {
    const iso = _ugIso(a.datum);
    if (iso && ugPhase(iso) !== a.phase) { a.phase = ugPhase(iso); _ugRender(); }
  });
  dlg.querySelector('[data-ug-zu]').addEventListener('click', () => dlg.close());
  dlg.querySelector('#ug-siegel').addEventListener('click', ev => {
    if (ev.target.closest('[data-ug-bestaetigen]')) _ugBestaetigenKlick();
  });
  dlg.querySelector('[data-ug-kopie]').addEventListener('click', _ugKopieren);
  const nur = dlg.querySelector('[data-ug-nur]');
  if (nur) nur.addEventListener('click', () => _ugAbschliessen('nur'));
  dlg.querySelector('[data-ug-mail]').addEventListener('click', () => _ugAbschliessen('outlook'));
  const senden = dlg.querySelector('[data-ug-senden]');
  if (senden) senden.addEventListener('click', () => _ugAbschliessen('senden'));

  _ugGelesenZeigen();
  _ugWahlZeigen();
  _ugVorlageNeu();
  _ugSiegel();
}

/**
 * Neben „Lieferant“: grünes Siegel, wenn die Kreditorenbuchhaltung den Lieferanten mit
 * diesem Namen schon geprüft und bestätigt hat, sonst der Knopf „Bestätigen“.
 */
function _ugSiegel() {
  const el = document.getElementById('ug-siegel');
  const feld = document.getElementById('ug-name');
  if (!el || !feld) return;
  const name = feld.value.trim();
  const l = _ug.daten.lieferanten[ugKey(name)];
  if (l && l.bestaetigtAm) {
    const tip = `Geprüft und bestätigt von ${l.bestaetigtVonName || l.bestaetigtVon || '?'} am ${_monDate(l.bestaetigtAm)}`;
    el.innerHTML = `<span class="ug-siegel" title="${_esc(tip)}">✓ Bestätigt</span>`;
    return;
  }
  el.innerHTML = ugKey(name)
    ? '<button type="button" class="ug-bestaetigen" data-ug-bestaetigen title="Name und USt-IdNr. geprüft: Lieferant bestätigen und für weitere Rechnungen merken">Bestätigen</button>'
    : '';
}

/** Ein Klick: Lieferant mit dem Namen im Feld bestätigen und merken, danach Siegel zeigen. */
async function _ugBestaetigenKlick() {
  const a = _ugAktuell;
  const dlg = document.getElementById('ug-dialog');
  const knopf = dlg.querySelector('[data-ug-bestaetigen]');
  const name = dlg.querySelector('#ug-name').value.trim();
  if (!knopf || !ugKey(name)) return;
  knopf.disabled = true;
  knopf.textContent = 'Wird bestätigt…';
  try {
    await ugBestaetigen(a.r, name, { vat: a.vat });
    _ugMeldung(`${name} ist geprüft und bestätigt.`, 'ok');
    if (typeof a.onGespeichert === 'function') a.onGespeichert();
  } catch (e) {
    _ugMeldung(e.message || String(e), 'nicht');
  }
  if (_ugAktuell === a) _ugSiegel();
}

/**
 * Lieferant, USt-IdNr., Nummer, Datum und Betrag aus dem PDF lesen (js/lieferant.js).
 * Nur wenn etwas fehlt und die Datei ein PDF ist. Was jemand schon selbst
 * eingetragen hat, bleibt stehen.
 */
async function _ugAusRechnungLesen(r) {
  const a = _ugAktuell;
  const fehlt = !r.steller || !r.ustid || r.nummerAusDatei || !r.datumAusRechnung || r.brutto == null || !a.an;
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
    const puffer = await resp.arrayBuffer();
    // Kopie übergeben: pdf.js gibt den Puffer an seinen Worker ab, die Texterkennung braucht ihn noch
    let l = lieferantAusText(await textAusPdf(puffer.slice(0)));
    if (_ugAktuell !== a) return;                      // Dialog inzwischen zu oder andere Rechnung
    // Scan ohne Text: Texterkennung (Tesseract wie im Konverter) über die ersten zwei Seiten
    if (!l.lesbar && typeof ocrCollectItems === 'function' && typeof Tesseract !== 'undefined' && typeof textAusItems === 'function') {
      a.lesen = 'ocr';
      a.ocrStand = '';
      _ugGelesenZeigen();
      const doc = await pdfjsLib.getDocument({ data: new Uint8Array(puffer) }).promise;
      const items = await ocrCollectItems(doc, p => {
        if (_ugAktuell !== a) return;
        a.ocrStand = `Seite ${p.page} von ${p.total}${p.status === 'recognizing text' ? ', ' + Math.round(p.progress * 100) + ' %' : ''}`;
        _ugGelesenZeigen();
      }, { maxSeiten: 2 });
      if (_ugAktuell !== a) return;
      l = Object.assign(lieferantAusText(textAusItems(items)), { ocr: true });
    }
    a.gelesen = l;
    a.lesen = l.lesbar ? 'fertig' : 'scan';
    if (!l.lesbar) { _ugGelesenZeigen(); return; }
    const vorher = a.phase;
    if (l.name && !a.bearbeitet.name && !r.steller) a.name = l.name;
    if (l.vat && !a.vat) a.vat = l.vat;
    if (!a.an && !a.bearbeitet.an) {
      // gemerkte Adresse des gelesenen Lieferanten vor der Adresse aus dem PDF
      const gemerkt = (_ug.daten.lieferanten[ugKey(a.name)] || {}).mail;
      if (gemerkt) { a.an = gemerkt; a.anQuelle = 'gemerkt'; }
      else if (l.mail) { a.an = l.mail; a.anQuelle = 'pdf'; }
    }
    if (l.nummer && !a.bearbeitet.nr && r.nummerAusDatei) a.nr = l.nummer;
    if (l.datum && !a.bearbeitet.datum && !r.datumAusRechnung) { a.datum = _monDate(l.datum); a.phase = ugPhase(l.datum); }
    if (l.kleinunternehmer && !a.vermutung) a.vermutung = 'bis';
    if (a.phase !== vorher) { _ugRender(); return; }
    const dlg = document.getElementById('ug-dialog');
    const setze = (id, v) => { const el = dlg.querySelector('#' + id); if (el) el.value = v; };
    setze('ug-name', a.name); setze('ug-nr', a.nr); setze('ug-datum', a.datum); setze('ug-an', a.an);
    _ugSiegel();
    const stand = dlg.querySelector('#ug-mailstand');
    if (stand) stand.textContent = _ugMailstand(a);
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
  if (a.lesen === 'ocr') {
    el.textContent = `Die Rechnung ist ein Scan. Texterkennung läuft${a.ocrStand ? ' (' + a.ocrStand + ')' : ''}, das dauert einige Sekunden…`;
    return;
  }
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
  let text = teile.length
    ? (l.ocr ? 'Per Texterkennung aus dem Scan gelesen, bitte genau prüfen: ' : 'Aus der Rechnung gelesen: ') + teile.join(', ') + '.'
    : 'In der Rechnung war kein Lieferant zu finden. Bitte selbst eintragen.';
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

/** Woher die Adresse in „An“ stammt, als Satz für unter das Feld. */
function _ugAnHinweis(a) {
  if (a.bearbeitet.an) return '';
  if (a.anQuelle === 'gemerkt') return ' Die Adresse ist für diesen Lieferanten gemerkt, bitte prüfen.';
  if (a.anQuelle === 'absender') return ' Die Adresse ist der Absender der Rechnungsmail, bitte prüfen.';
  if (a.anQuelle === 'pdf') return a.gelesen && a.gelesen.ocr
    ? ' Die Adresse stammt aus der Texterkennung, bitte genau prüfen.' : ' Die Adresse steht in der Rechnung, bitte prüfen.';
  return '';
}

/** Satz unter „An“: über welches Postfach gesendet wird und woher die Adresse stammt. */
function _ugMailstand(a) {
  return a.kannSenden
    ? `Senden geht aus dem Rechnungspostfach des Werks ${a.r.werk}.${_ugAnHinweis(a)}`
    : 'Der Versand aus dem Werks-Postfach ist hier nicht eingerichtet. Die Mail öffnet sich in Outlook.';
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
      const sel = dlg.querySelector('#ug-informiert');
      const informiert = modus === 'nur' ? (sel ? sel.value : 'Nein') : 'Ja';
      await ugSpeichern(a.r, dlg.querySelector('#ug-name').value.trim(), a.vermutung, a.vat, a.nr, informiert, a.an);
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
    ugMailOk, ugMailHtml, ugInformiert, ugSpeichern, ugBestaetigen, ugLieferantFuer, ugLieferantMerken, ugLieferantName,
    ugMitXml, ugFuer, _ugAbsenderOk, _ugAbsenderWahl, _ug };
}

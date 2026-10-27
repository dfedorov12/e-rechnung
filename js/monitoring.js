/**
 * Rechnungsmonitoring
 * ===================
 * Liest ALLE Rechnungsbibliotheken (ERAR_<Werk> = Eingang, AR_<Werk> = Ausgang)
 * einer eigenen SharePoint-Site aus, nacheinander und seitenweise, aggregiert die
 * Positionen und zeigt KPI-Kacheln + filterbare Tabelle (200 Zeilen je Seite).
 * Nutzt die vorhandene Auth/Graph-Infrastruktur
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
  tabelleSeite: 200,             // so viele Zeilen zeichnet die Tabelle auf einmal
};

let _monRecords = [];
let _monRows = [];     // aktuell angezeigte Zeilen (Index fuer Buttons in der Tabelle)
let _monZeigen = MON.tabelleSeite;  // gezeichnete Zeilen, waechst mit „Weitere anzeigen“
let _monAnsicht = '';               // Filter + Sortierung beim letzten Zeichnen
let _monLadeLauf = 0;               // laufender Ladevorgang (ein neuer bricht den alten ab)
let _monLaedt = false;
let _monAufruf = null;               // Argumente des letzten loadMonitoring (für „Aktualisieren“)
let _monSiteId = '';                 // Monitoring-Site (Versionsverlauf)
const _monSpaltenTitel = new Map();  // Liste -> Promise<Map(interner Name -> Anzeigename)>
let _monLibs = [];                  // geladene Bibliotheken (für die Werk-Auswahl)
let _monDateien = [];               // alle geladenen Dateien (neu zusammenfassen nach Einstellungen)
const _monOffen = new Set();        // aufgeklappte Zeilen (Schlüssel: Werk|Richtung|Datei)
let _monBeobachter = null;          // lädt beim Scrollen die nächste Seite der Tabelle
let _monDichte = 'kompakt';         // kompakt | gross (im Browser gemerkt)
let _monAnsichtWerk = '';           // Werk, dessen Reihenfolge und Breiten die Tabelle gerade nutzt
let _monGriffZeit = 0;              // Ende des letzten Ziehens (danach kein Sortier-Klick)
const _monFilter = { werk: '', richtung: '', klass: '', konform: '', buchung: '', status: '', bstatus: '', genehmigt: '', from: '', to: '', q: '', flag: '' };
let _monSort = { key: 'datum', dir: -1 };   // -1 = absteigend (neueste zuerst)

/* ── Laden ──────────────────────────────────────────────────────────── */

async function loadMonitoring(accessList, optionen) {
  _monAufruf = { accessList, optionen };
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
    _monSiteId = siteId;

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
      // Werkzuweisung aus den Einstellungen (leer = alle). Gilt nur fuer Werk-Bibliotheken;
      // die Eingangsstufe ist werkuebergreifend und immer sichtbar (SharePoint-Rechte gaten den Zugriff).
      .filter(l => l.intake || allow.size === 0 || allow.has(l.werk.toLowerCase()));

    if (!libs.length) {
      return _monShowSetup('Keine Rechnungsbibliotheken vorhanden',
        'Auf der Site wurden keine Bibliotheken ERAR_<Werk> / AR_<Werk> gefunden '
        + '(bzw. keine, auf die Sie Zugriff haben). Provisionierungsskript ausführen.');
    }

    // Einschaetzungen zur 800k-Umsatzgrenze (js/umsatzgrenze.js) und Mailaufträge
    // (Liste KreditorMails) zuerst: beide sind klein, und die Zeilen zeigen Badges und
    // Lieferantennamen dann schon beim ersten Zeichnen. Fehler sind nicht fatal.
    if (typeof ugLaden === 'function') await ugLaden(siteId, token);
    if (typeof ugMailsLaden === 'function') await ugMailsLaden(siteId, token, listsRes.value || []);
    // Vorgaben für die Bearbeitung (abas-Info je Werk, js/bearbeitung.js)
    if (typeof bhLaden === 'function') await bhLaden(siteId, token);
    _monLibs = libs;
    // Zugewiesenes Werk vorwählen (Einstellungen), sonst „Alle Werke“
    const standardWerk = String((optionen && optionen.standardWerk) || '').toUpperCase();
    if (standardWerk && libs.some(l => l.werk === standardWerk)) _monFilter.werk = standardWerk;

    // Bibliotheken NACHEINANDER und seitenweise laden, nicht alle parallel. So läuft
    // immer nur ein Abruf, SharePoint drosselt nicht, und die Tabelle füllt sich
    // schon während des Ladens. Eine Bibliothek mit Fehler hält die anderen nicht auf.
    const lauf = ++_monLadeLauf;
    const recs = [];
    _monDateien = recs;
    const fehlerLibs = [];
    _monRecords = [];
    _monLaedt = true;
    _monBuildFilterOptions(libs);
    const setup = document.getElementById('mon-setup');
    if (setup) setup.style.display = 'none';
    document.getElementById('mon-body').style.display = '';
    _monApply();

    for (let i = 0; i < libs.length; i++) {
      const lib = libs[i];
      if (sub) sub.textContent = `Lade ${lib.name} (${i + 1} von ${libs.length}) · ${recs.length} Datei(en) bisher…`;
      try {
        await _monFetchLib(siteId, lib, token, seite => {
          if (lauf !== _monLadeLauf) return false;   // neuer Ladevorgang -> diesen abbrechen
          recs.push(...seite);
          _monUpdate(recs);
          if (sub) sub.textContent = `Lade ${lib.name} (${i + 1} von ${libs.length}) · ${recs.length} Datei(en) bisher…`;
          return true;
        });
      } catch (e) {
        fehlerLibs.push(lib.name);
        console.warn('Monitoring: Bibliothek nicht geladen:', lib.name, e);
      }
      if (lauf !== _monLadeLauf) return;
      // Typ, Buchung und Status kommen erst mit den Daten, Auswahl bleibt erhalten.
      _monBuildFilterOptions(libs);
      _monSyncControls();
    }

    _monLaedt = false;
    if (fehlerLibs.length === libs.length) {
      return _monShowSetup('Fehler beim Laden',
        `Keine Bibliothek ließ sich lesen (${fehlerLibs.join(', ')}). Details in der Browser-Konsole.`);
    }
    _monUpdate(recs);
    if (sub) sub.textContent =
      `${_monRecords.length} Rechnung(en) (${recs.length} Datei(en)) aus ${libs.length - fehlerLibs.length} Bibliothek(en) · Stand ${new Date().toLocaleString('de-DE')}`
      + (fehlerLibs.length ? ` · nicht geladen: ${fehlerLibs.join(', ')}` : '');
  } catch (e) {
    _monLaedt = false;
    _monShowSetup('Fehler beim Laden', e.message || String(e));
  }
}

// Geladene Dateien zu Rechnungen zusammenfassen und neu zeichnen. Läuft nach jeder
// Seite: XML + PDF + KoSIT-Bericht derselben Rechnung werden EINE Zeile, echte
// Dubletten (Nummer + Aussteller) gekennzeichnet.
function _monUpdate(recs) {
  _monRecords = _monGroup(recs);
  _monMarkDupes(_monRecords);
  _monApply();
}

// Graph-GET mit Wiederholung bei Drosselung (429) oder kurzzeitig nicht verfügbar
// (503): wartet Retry-After ab, sonst 2, 4, 8, 16 Sekunden.
async function _monGet(url, token) {
  for (let versuch = 0; ; versuch++) {
    const resp = await fetch(url, {
      headers: { 'Authorization': `Bearer ${token}`, 'Accept': 'application/json' },
    });
    if (resp.ok) return resp.json();
    if ((resp.status === 429 || resp.status === 503) && versuch < 4) {
      const s = Number(resp.headers.get('Retry-After'));
      const warten = (s > 0 ? Math.min(s, 60) : 2 ** (versuch + 1)) * 1000;
      await new Promise(res => setTimeout(res, warten));
      continue;
    }
    const msg = await resp.text();
    throw new Error(`Graph GET (${resp.status}): ${msg.slice(0, 300)}`);
  }
}

// Eine Bibliothek seitenweise abrufen. Sortiert NEUESTE ZUERST (fields/Created
// desc): so liefert das Seitenlimit maxPagesPerLib immer die aktuellsten
// Rechnungen, statt in der Graph-Default-Reihenfolge (ID aufsteigend = älteste
// zuerst) die neuen abzuschneiden. $orderby verlangt jenseits von 5000 Items eine
// indizierte Created-Spalte (Provisioning: provision-rechnungsmonitoring.ps1).
// Wird die Sortierung abgelehnt (noch nicht indiziert), wird ungeordnet geladen.
// Jede Seite geht sofort an onSeite(datensaetze). Gibt onSeite false zurück, endet
// der Abruf (neuer Ladevorgang gestartet).
async function _monFetchLib(siteId, lib, token, onSeite) {
  const base = `${SP.graphBase}/sites/${siteId}/lists/${lib.id}/items?$expand=fields&$top=200`;
  let url = `${base}&$orderby=fields/Created desc`;
  let ordered = true;
  let pages = 0;
  while (url && pages < MON.maxPagesPerLib) {
    let page;
    try {
      page = await _monGet(url, token);
    } catch (e) {
      // Sortierung nicht möglich (unindiziert) -> einmalig ungeordnet neu starten.
      if (ordered && pages === 0) { ordered = false; url = base; continue; }
      throw e;
    }
    const seite = [];
    for (const it of (page.value || [])) {
      const f = it.fields || {};
      if (!f.FileLeafRef && !f.Title) continue;             // Ordner / Leerzeilen überspringen
      seite.push(_monMap(it, f, lib));
    }
    if (onSeite(seite) === false) return;
    url = page['@odata.nextLink'] || null;
    pages++;
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
    // Für den Abruf der Datei (800k-Dialog liest den Lieferanten aus dem PDF)
    listId:   lib.id,
    itemId:   it.id,
    // Spalte RechnungsstellerUStID trug bis zur Flow-Korrektur den Namen: nur echte USt-IdNr. nehmen
    ustid:    /^[A-Z]{2}[0-9A-Z]{8,12}$/.test(String(f.RechnungsstellerUStID || '').replace(/\s+/g, ''))
                ? String(f.RechnungsstellerUStID).replace(/\s+/g, '') : '',
    datumAusRechnung: !!f.Rechnungsdatum,
    // Absender der Rechnungsmail (Eingangs-Flow) = Empfänger einer Kreditor-Mail
    absenderMail: (f.AbsenderMail || '').toString().trim(),
    // Name des Anhangs, bevor der Flow die Datei nach Rechnungsnummer umbenannt hat
    originalName: (f.OriginalPdfName || '').toString().trim(),
    art:      (f.Rechnungsart || '').toString(),
    steller:  (f.Rechnungssteller || '').toString(),
    empf:     (f.Rechnungsempfaenger || '').toString(),
    brutto:   num(f.Bruttobetrag),
    netto:    num(f.Nettobetrag),
    bestellnr: (f.Bestellnummer || '').toString(),
    waehrung: (f.Waehrung || 'EUR').toString(),
    // SharePoint liefert Datumsspalten als UTC (27.10. 00:00 Uhr = 2026-10-26T23:00:00Z),
    // deshalb auf den Kalendertag in Deutschland umrechnen
    datum:    _monTag(f.Rechnungsdatum || f.Eingangszeitpunkt || it.createdDateTime || ''),
    faelligkeit: _monTag(f.Faelligkeitsdatum || ''),
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
    // Bearbeitung durch die Buchhaltung (js/bearbeitung.js): Varialnummer, Kontierung,
    // Genehmigung usw.; ersetzt die Eingangsrechnungsliste auf gruppe_wgc
    bh:       typeof bhAusFeldern === 'function' ? bhAusFeldern(f) : null,
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
    // Kopie: das Zusammenfassen läuft beim Laden nach jeder Seite erneut und darf die
    // Dateien selbst nicht verändern, sonst gewinnt beim nächsten Mal eine andere.
    const best = _monBestPrimary(primaries.length ? primaries : arr);
    const primary = Object.assign({}, best);

    // Verknüpfte Dateien der Rechnung (die anderen Repräsentationen + Bericht).
    primary.dateien = [];
    for (const r of arr) {
      if (r === best || !r.url) continue;
      const label = r.sidecar === 'kosit' ? 'KoSIT-Bericht'
                  : r.sidecar === 'lesbar' ? 'Lesbares PDF'
                  : (r.ext ? r.ext.toUpperCase() : 'Datei');
      primary.dateien.push({ label, url: r.url });
    }
    // Metadaten aus Geschwisterdateien auffüllen, falls die Primärzeile sie nicht hat.
    for (const key of ['steller', 'empf', 'format', 'status', 'konform', 'fehler', 'meldung', 'faelligkeit']) {
      if (!primary[key]) { const s = arr.find(r => r[key]); if (s) primary[key] = s[key]; }
    }
    if (primary.brutto == null) { const s = arr.find(r => r.brutto != null); if (s) primary.brutto = s.brutto; }
    if (primary.netto == null) { const s = arr.find(r => r.netto != null); if (s) primary.netto = s.netto; }
    if (!primary.bestellnr) { const s = arr.find(r => r.bestellnr); if (s) primary.bestellnr = s.bestellnr; }
    // GoBD-archiviert, sobald IRGENDEINE Datei der Rechnung unter Aufbewahrung liegt
    // (Tag) bzw. der Flow es gesetzt hat; Tag-Wert für den Tooltip merken.
    primary.gobdArchiviert = arr.some(r => r.complianceTag || r.gobd);
    primary.complianceTag = (arr.find(r => r.complianceTag) || {}).complianceTag || '';
    // Prüfschritt-Flags: gesetzt, sobald IRGENDEINE Datei der Rechnung sie trägt.
    primary.formatmangel     = arr.some(r => r.formatmangel);
    primary.manuellePruefung = arr.some(r => r.manuellePruefung);
    primary.rueckfrage       = arr.some(r => r.rueckfrage);
    primary.konvertiert      = arr.some(r => r.konvertiert);
    for (const k of ['buchung', 'manuellePruefungGrund', 'kreditorAktion', 'ustid', 'absenderMail']) {
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
    // Bis 10/2026 blieb die Buchung bei gelb und rot auf Automatik. Angezeigt wird die
    // heutige Regel des Prüfdienstes: gelb = Unter Vorbehalt, rot = Zurückgewiesen.
    if (/^automatik$/i.test(primary.buchung || '') && (primary.richtung || '') === 'Eingang') {
      if (/^gel/i.test(primary.konform || '')) { primary.buchungAlt = primary.buchung; primary.buchung = 'Unter Vorbehalt'; }
      else if (/^rot/i.test(primary.konform || '')) { primary.buchungAlt = primary.buchung; primary.buchung = 'Zurueckgewiesen'; }
    }
    // "öffnen" muss immer eine Datei treffen: hat die Primärzeile keine URL,
    // die erste verfügbare Geschwisterdatei nehmen.
    if (!primary.url) { const s = arr.find(r => r.url); if (s) primary.url = s.url; }
    // Bearbeitung: eine Datei je Eingangsrechnung trägt die Felder der Buchhaltung.
    if (typeof bhZiel === 'function' && !primary.intake && primary.richtung === 'Eingang'
        && (typeof bhBearbeitenAn !== 'function' || bhBearbeitenAn(primary.werk))) {
      primary.bhQuelle = bhZiel(arr);
      primary.bh = bhZusammen(arr, primary.bhQuelle);
    } else {
      primary.bh = null;
    }
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
  const buchung = document.getElementById('mon-f-buchung');
  if (buchung) buchung.insertAdjacentHTML('beforeend', '<option value="__klein">Kleinbetrag (bis 250 € brutto)</option>');
  _fillSelect('mon-f-status',  uniq(_monRecords.map(r => r.status)),     'Alle Status');
  _fillSelect('mon-f-bstatus', uniq(_monRecords.map(r => r.bh && r.bh.bstatus)),   'Alle Bearbeitung');
  _fillSelect('mon-f-genehmigt', uniq(_monRecords.map(r => r.bh && r.bh.genehmigt)), 'Alle Genehmigt');
  // Filter der Bearbeitung nur zeigen, wenn ein Werk sie nutzt
  const bh = _monRecords.some(r => r.bh);
  ['mon-f-bstatus', 'mon-f-genehmigt'].forEach(id => { const el = document.getElementById(id); if (el) el.style.display = bh ? '' : 'none'; });
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
  // Neue Filter oder Sortierung: wieder mit der ersten Seite der Tabelle beginnen.
  // Nachladen und Speichern im Dialog lassen „Weitere anzeigen“ stehen.
  const ansicht = JSON.stringify([f, _monSort]);
  if (ansicht !== _monAnsicht) {
    _monAnsicht = ansicht;
    _monZeigen = MON.tabelleSeite;
    const wrap = document.getElementById('mon-wrap');
    if (wrap) wrap.scrollTop = 0;
  }
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
      && (!f.buchung  || (f.buchung === '__klein' ? _monKlein(r) : r.buchung === f.buchung))
      && (!f.status   || r.status === f.status)
      && (!f.bstatus  || (r.bh && r.bh.bstatus) === f.bstatus)
      && (!f.genehmigt || (r.bh && r.bh.genehmigt) === f.genehmigt)
      && (!f.from     || (d && d >= f.from))
      && (!f.to       || (d && d <= f.to))
      && (!q || (r.nummer + ' ' + _monPartner(r) + ' ' + r.steller + ' ' + r.empf + ' ' + (r.absenderMail || '')
                 + (r.bh ? ' ' + r.bh.varial + ' ' + r.bh.kontierung + ' ' + r.bh.notiz + ' ' + r.bh.bestellnr : ''))
                 .toLowerCase().includes(q));
}

function _monMatchFlag(r, flag) {
  switch (flag) {
    case 'offen':      return !!r.status && !['Gebucht', 'Archiviert'].includes(r.status);
    case 'fehler':     return r.status === 'Fehler' || /^rot/i.test(r.konform || '') || !!r.fehler;
    case 'dublette':   return !!r.dublette;
    case 'manuell':    return r.manuellePruefung || /manuell/i.test(r.buchung || '');
    case 'rueckfrage': return !!r.rueckfrage;
    case 'zurueck':    return /zur(?:ü|ue)ckgew/i.test(r.buchung || '');
    case 'umsatz':     return typeof ugBraucht === 'function' && ugBraucht(r) && !ugFuer(r)
                              && ugPhase(r.datum) !== 'pflicht';
    case 'genehmigung': return typeof bhInGenehmigung === 'function' && bhInGenehmigung(r.bh);
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
    case 'partner':  return _monPartner(r).toLowerCase();
    case 'brutto':   return r.brutto == null ? -Infinity : r.brutto;
    case 'netto':    return r.netto == null ? -Infinity : r.netto;
    case 'informiert': return typeof ugInformiert === 'function' ? ugInformiert(r) : '';
    case 'varial':   return (r.bh && r.bh.varial) || '';
    case 'bestellnr': return ((r.bh && r.bh.bestellnr) || r.bestellnr || '').toLowerCase();
    case 'bstatus':  return (r.bh && r.bh.bstatus) || '';
    case 'genehmigt': return (r.bh && r.bh.genehmigt) || '';
    case 'faellig':  return (r.faelligkeit || '').slice(0, 10);
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
  // Sonstige Rechnungen ohne Einschaetzung zur 800k-Umsatzgrenze (js/umsatzgrenze.js).
  const umsatz     = rows.filter(r => _monMatchFlag(r, 'umsatz')).length;
  const genehmigung = rows.filter(r => _monMatchFlag(r, 'genehmigung')).length;

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
    { id: 'flag:umsatz',     label: '800k-Einschätzung offen', val: umsatz,   cls: umsatz ? 'warn' : '' },
    ...(_monRecords.some(r => r.bh) ? [{ id: 'flag:genehmigung', label: 'In Genehmigung', val: genehmigung, cls: genehmigung ? 'warn' : '' }] : []),
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

/* ── Spalten ────────────────────────────────────────────────────────── */
// Welche Spalten ein Werk zeigt, legt ein Admin unter „Spalten“ fest (gespeichert in
// Monitoring/monitoring-einstellungen.json, js/bearbeitung.js). Ohne Festlegung gilt
// MON_STANDARD. Spalten mit bh: true gibt es nur, wenn das Werk die Bearbeitung nutzt.
const MON_SPALTEN = [
  { id: 'datum',       titel: 'Datum',                sort: 'datum',      breite: 10 },
  { id: 'werk',        titel: 'Werk',                 sort: 'werk',       breite: 5 },
  { id: 'richtung',    titel: 'Richtung',             sort: 'richtung',   breite: 7 },
  { id: 'nummer',      titel: 'Rechnungsnr.',         sort: 'nummer',     breite: 10 },
  { id: 'partner',     titel: 'Steller / Empfänger',  sort: 'partner',    breite: 15 },
  { id: 'netto',       titel: 'Netto',                sort: 'netto',      breite: 8 },
  { id: 'brutto',      titel: 'Brutto',               sort: 'brutto',     breite: 8 },
  { id: 'faellig',     titel: 'Fällig am',            sort: 'faellig',    breite: 8 },
  { id: 'klass',       titel: 'Klassifizierung',      sort: 'klass',      breite: 9 },
  { id: 'status',      titel: 'Status',               sort: 'status',     breite: 8 },
  { id: 'buchung',     titel: 'Buchung',              sort: 'buchung',    breite: 11 },
  { id: 'informiert',  titel: 'Lieferant informiert', sort: 'informiert', breite: 8 },
  { id: 'konform',     titel: 'Konform.',             sort: 'konform',    breite: 13 },
  { id: 'fehler',      titel: 'Fehler',                                   breite: 8 },
  { id: 'bestellnr',   titel: 'Bestellnummer',        sort: 'bestellnr',  breite: 9 },
  { id: 'varial',      titel: 'Varialnummer',         sort: 'varial',     breite: 9, bh: true },
  { id: 'kontierung',  titel: 'Kontierung',                               breite: 12, bh: true },
  { id: 'bstatus',     titel: 'Bearbeitung',          sort: 'bstatus',    breite: 9, bh: true },
  { id: 'genehmigung', titel: 'Genehmigung',          sort: 'genehmigt',  breite: 11, bh: true },
  { id: 'notiz',       titel: 'Notiz',                                    breite: 12, bh: true },
  { id: 'links',       titel: '',  name: 'Bearbeiten und Dateien (PDF, XML, Bericht)', breite: 15, fest: true },
];
// Standard-Reihenfolge; „Bearbeiten“ und die Dateien stehen vorn
const MON_STANDARD = ['links', 'datum', 'werk', 'richtung', 'nummer', 'partner', 'netto', 'faellig', 'klass',
  'status', 'buchung', 'informiert', 'konform', 'fehler', 'varial', 'bstatus', 'genehmigung'];

/** Spalten-IDs eines Werks in seiner Reihenfolge ('links' ist immer dabei, sonst vorn). */
function _monWerkSpaltenListe(werk) {
  const e = typeof bhWerkEinst === 'function' ? bhWerkEinst(werk) : {};
  const ids = Array.isArray(e.spalten) && e.spalten.length ? e.spalten : MON_STANDARD;
  const bh = typeof bhBearbeitenAn !== 'function' || bhBearbeitenAn(werk);
  const liste = ids.filter((id, i) => {
    const sp = MON_SPALTEN.find(x => x.id === id);
    return sp && (!sp.bh || bh) && ids.indexOf(id) === i;
  });
  return liste.includes('links') ? liste : ['links'].concat(liste);
}

function _monWerkSpalten(werk) {
  return new Set(_monWerkSpaltenListe(werk));
}

/**
 * Spalten der Tabelle in ihrer Reihenfolge: das gefilterte Werk, sonst alle Werke
 * zusammen. Maßgeblich ist die Reihenfolge des Werks mit den meisten Rechnungen,
 * Spalten der anderen Werke kommen hinter ihren Vorgänger.
 */
function _monSichtbareSpalten() {
  const anzahl = new Map();
  _monRecords.forEach(r => anzahl.set(r.werk, (anzahl.get(r.werk) || 0) + 1));
  const werke = _monFilter.werk ? [_monFilter.werk] : Array.from(anzahl.keys());
  if (!werke.length) werke.push('');
  werke.sort((a, b) => (anzahl.get(b) || 0) - (anzahl.get(a) || 0));
  _monAnsichtWerk = werke[0];
  const ids = [];
  werke.forEach(w => {
    const liste = _monWerkSpaltenListe(w);
    liste.forEach((id, i) => {
      if (ids.includes(id)) return;
      const vorher = liste.slice(0, i).reverse().find(x => ids.includes(x));
      if (vorher) ids.splice(ids.indexOf(vorher) + 1, 0, id); else ids.unshift(id);
    });
  });
  return ids.map(id => MON_SPALTEN.find(sp => sp.id === id)).filter(Boolean);
}

// Spaltenbreiten in Pixeln (Einheit 12 px). Ist der Bereich breiter, verteilt der Browser
// den Rest anteilig; ist er schmaler, scrollt die Tabelle waagerecht.
const MON_EINHEIT = 12;

// Eigene Breiten (per Ziehen, nur in diesem Browser): { <Werk>: { <Spalte>: px } }
function _monEigeneBreiten() {
  try { return JSON.parse(localStorage.getItem('mon-breiten') || '{}') || {}; } catch (e) { return {}; }
}
function _monEigeneBreitenSpeichern(alle) {
  try { localStorage.setItem('mon-breiten', JSON.stringify(alle)); } catch (e) { /* ohne Speicher */ }
}
// Wann die eigenen Breiten eines Werks zuletzt gezogen wurden: { <Werk>: ISO-Zeit }
function _monEigeneBreitenAm() {
  try { return JSON.parse(localStorage.getItem('mon-breiten-am') || '{}') || {}; } catch (e) { return {}; }
}

/**
 * Eigene Breiten, die noch gelten. Speichert ein Admin Standardbreiten, gelten sie für
 * alle: eigene Breiten von davor fallen weg (auch ältere ohne Zeitstempel). Wer danach
 * zieht, behält seine Breiten bis zum nächsten Standard.
 */
function _monEigeneAktiv(w) {
  const eigene = _monEigeneBreiten()[w] || {};
  const std = (typeof bhWerkEinst === 'function' && bhWerkEinst(w)) || {};
  if (!std.breiten || !Object.keys(std.breiten).length) return eigene;
  const am = _monEigeneBreitenAm()[w] || '';
  return am && am > (std.breitenStand || '') ? eigene : {};
}

/**
 * Breite einer Spalte: eigene, sonst Standard des Werks (vom Admin), sonst der Standard
 * eines anderen Werks (ohne Werkfilter zeigt die Tabelle Spalten mehrerer Werke), sonst Vorgabe.
 */
function _monBreite(sp) {
  const w = _monAnsichtWerk || '';
  const eigen = _monEigeneAktiv(w)[sp.id];
  if (eigen) return eigen;
  const std = (typeof bhWerkEinst === 'function' && bhWerkEinst(w).breiten) || {};
  if (std[sp.id]) return std[sp.id];
  const werke = (typeof _bh !== 'undefined' && _bh.einst && _bh.einst.werke) || {};
  const andere = Object.values(werke).find(e => e && e.breiten && e.breiten[sp.id]);
  return andere ? andere.breiten[sp.id] : sp.breite * MON_EINHEIT;
}

/**
 * Breiten, wie die Tabelle sie gerade zeigt, über die übergebenen legen. Spalten in
 * Vorgabebreite fallen heraus, damit eine spätere Änderung der Vorgabe wirkt.
 */
function _monBreitenWieAngezeigt(basis) {
  const breiten = Object.assign({}, basis);
  document.querySelectorAll('#mon-cols col[data-sp]').forEach(c => {
    const sp = MON_SPALTEN.find(x => x.id === c.dataset.sp);
    const px = Math.round(parseFloat(c.style.width) || 0);
    if (!sp || !px) return;
    if (px === sp.breite * MON_EINHEIT) delete breiten[sp.id]; else breiten[sp.id] = px;
  });
  return breiten;
}

function _monTabBreiteSetzen() {
  const summe = Array.from(document.querySelectorAll('#mon-cols col[data-sp]'))
    .reduce((a, c) => a + (parseFloat(c.style.width) || 0), 0);
  const tab = document.querySelector('table.mon-table');
  if (tab) tab.style.minWidth = summe + 'px';
}

// Die letzte, leere Spalte nimmt den restlichen Platz auf. So ändert Ziehen nur die
// gezogene Spalte und verteilt nichts auf die anderen.
function _monRenderKopf(spalten) {
  document.getElementById('mon-cols').innerHTML = spalten
    .map(sp => `<col data-sp="${sp.id}" style="width:${_monBreite(sp)}px">`).join('') + '<col>';
  const griff = sp => `<span class="mon-griff" data-griff="${sp.id}" title="Breite ändern: ziehen. Doppelklick: Standardbreite"></span>`;
  document.getElementById('mon-kopf').innerHTML = spalten.map(sp => sp.sort
    ? `<th data-sort="${sp.sort}">${_esc(sp.titel)}<span class="sort-ind"></span>${griff(sp)}</th>`
    : `<th>${_esc(sp.titel)}${griff(sp)}</th>`).join('') + '<th class="mon-fueller"></th>';
  _monTabBreiteSetzen();
  const zurueck = document.getElementById('mon-breiten-zurueck');
  if (zurueck) zurueck.hidden = !Object.keys(_monEigeneAktiv(_monAnsichtWerk || '')).length;
}

function _monGeld(v, r) {
  return v == null ? '' : v.toLocaleString('de-DE', { style: 'currency', currency: r.waehrung || 'EUR' });
}

function _monKlein(r) {
  return typeof ugKleinbetrag === 'function' ? ugKleinbetrag(r) : (r.brutto != null && Math.abs(r.brutto) <= 250);
}

// Eine Zelle der Tabelle
function _monZelle(id, r, idx) {
  const bh = r.bh;
  switch (id) {
    case 'datum':    return `<td style="white-space:nowrap;">${_esc(_monDate(r.datum))}</td>`;
    case 'werk':     return `<td><span class="pill pill-werk">${_esc(r.werk)}</span></td>`;
    case 'richtung': return `<td><span class="pill ${r.richtung === 'Eingang' ? 'pill-in' : 'pill-out'}">${_esc(r.richtung)}</span></td>`;
    case 'nummer':
      return `<td>${_esc(r.nummer)}${r.dublette
        ? `<div class="mon-dupe" title="${_esc(r.dubletteInfo || '')}" style="display:inline-block;margin-top:2px;font-size:11px;font-weight:600;color:#fff;background:#b40000;border-radius:3px;padding:1px 6px;">⚠ Dublette</div>`
        : ''}</td>`;
    case 'partner':  return `<td>${_monPartnerCell(r)}</td>`;
    case 'netto':    return `<td style="text-align:right;white-space:nowrap;">${_esc(_monGeld(r.netto, r))}</td>`;
    case 'brutto':   return `<td style="text-align:right;white-space:nowrap;">${_esc(_monGeld(r.brutto, r))}</td>`;
    case 'faellig': {
      // überfällige, noch nicht gebuchte Rechnungen rot + ⚠
      const faellig = _monDate(r.faelligkeit);
      const fDate = String(r.faelligkeit || '').slice(0, 10);
      const overdue = /^\d{4}-\d{2}-\d{2}$/.test(fDate) && fDate < _monTodayIso()
                      && !['Gebucht', 'Archiviert'].includes(r.status);
      return `<td>${faellig
        ? `<span style="white-space:nowrap;${overdue ? 'color:#b40000;font-weight:600;' : ''}">${_esc(faellig)}${overdue ? ' ⚠' : ''}</span>`
        : '<span style="color:#9ca3af;">–</span>'}</td>`;
    }
    case 'klass':    return `<td>${_esc(_monKlass(r))}</td>`;
    case 'status': {
      // Kein GoBD-Abzeichen mehr: alles, was gespeichert wird, liegt unter Aufbewahrung.
      // Der Stand steht in der Detailansicht unter „Aufbewahrung“.
      return `<td>${r.status ? `<span class="pill pill-status">${_esc(r.status)}</span>` : ''}</td>`;
    }
    case 'buchung': {
      // Buchungssteuerung + Prüfschritt-Flags (UStAE/GoBD) + 800k-Einschätzung
      const flags = [];
      if (r.formatmangel)     flags.push(['Formatmangel', '#8a5a00', '#fff3d6']);
      if (r.manuellePruefung) flags.push([r.manuellePruefungGrund ? 'Manuell · ' + r.manuellePruefungGrund : 'Manuell', '#8a3b00', '#ffe6cc']);
      if (r.rueckfrage)       flags.push(['Rückfrage', '#b40000', '#ffe0e0']);
      if (r.konvertiert)      flags.push(['techn. konvertiert', '#334155', '#e2e8f0']);
      const badges = flags.map(([t, c, bgc]) =>
        `<div title="${_esc(t)}" style="display:inline-block;margin:3px 3px 0 0;font-size:11px;font-weight:600;color:${c};background:${bgc};border-radius:3px;padding:1px 6px;">${_esc(t.length > 28 ? t.slice(0, 26) + '…' : t)}</div>`).join('');
      const ug = typeof ugZelle === 'function' ? ugZelle(r, idx) : '';
      const tipBuchung = r.buchungAlt ? ` title="Gespeichert ist ${_esc(r.buchungAlt)}. Nach dem Prüfergebnis gilt ${_esc(r.buchung)}."` : '';
      return `<td>${(r.buchung ? `<span class="pill pill-status"${tipBuchung}>${_esc(r.buchung)}</span>` : '')
        + (badges ? `<div>${badges}</div>` : '') + (ug ? `<div>${ug}</div>` : '') || '–'}</td>`;
    }
    case 'informiert': {
      const v = typeof ugInformiert === 'function' ? ugInformiert(r) : '';
      const cls = { Ja: 'bh-ja', Nein: 'bh-wartet', Automatik: 'bh-neutral' }[v] || '';
      const tip = { Ja: 'Lieferant per Mail informiert', Nein: 'Eingeschätzt, Lieferant nicht informiert',
        Automatik: 'Lieferant war schon eingeschätzt, keine Einschätzung an dieser Rechnung nötig' }[v] || '';
      return `<td>${v ? `<span class="bh-pill ${cls}" title="${_esc(tip)}">${_esc(v)}</span>` : ''}</td>`;
    }
    case 'konform': {
      const hinweis = _monHinweis(r);
      return `<td>${_monKonPill(r)}${hinweis
        ? `<div class="mon-hint" title="${_esc(hinweis)}" style="font-size:11px;color:var(--gray-600,#6b7280);margin-top:3px;max-width:100%;line-height:1.3;">${_esc(hinweis)}</div>`
        : ''}</td>`;
    }
    case 'fehler':   return `<td class="mon-err" title="${_esc(r.fehler)}">${_esc(r.fehler.slice(0, 60))}</td>`;
    case 'bestellnr': return `<td>${_esc((bh && bh.bestellnr) || r.bestellnr || '')}</td>`;
    case 'varial':   return `<td>${_esc(bh ? bh.varial : '')}</td>`;
    case 'kontierung': return `<td class="mon-mehrzeilig">${_esc(bh ? bh.kontierung : '')}</td>`;
    case 'bstatus':  return `<td>${bh && bh.bstatus ? `<span class="pill pill-status">${_esc(bh.bstatus)}</span>` : ''}</td>`;
    case 'genehmigung': return `<td>${typeof bhZelle === 'function' ? bhZelle(r) : ''}</td>`;
    case 'notiz':    return `<td class="mon-mehrzeilig">${_esc(bh ? bh.notiz : '')}</td>`;
    case 'links': {
      const kurz = { 'KoSIT-Bericht': 'Bericht', 'Lesbares PDF': 'Lesbar' };
      const chip = (url, text, tip) => `<a class="mon-datei" href="${_esc(url)}" target="_blank" rel="noopener" title="${_esc(tip)}">${_esc(text)}</a>`;
      const dateien = [r.url ? chip(r.url, r.ext ? r.ext.toUpperCase() : 'Datei', 'Original öffnen') : '']
        .concat((r.dateien || []).map(d => chip(d.url, kurz[d.label] || d.label, d.label + ' öffnen'))).join('');
      return `<td>${bh ? `<button type="button" class="bh-btn" data-bh="${idx}" title="Varialnummer, Kontierung, Genehmigung">Bearbeiten</button>` : ''}${dateien}</td>`;
    }
    default: return '<td></td>';
  }
}

function _monRenderTable(rows) {
  // Sortierung erfolgt zentral in _monSortRows (vor dem Rendern). Gezeichnet werden
  // nur die ersten _monZeigen Zeilen, der Index bleibt der in _monRows.
  _monRows = rows;
  const spalten = _monSichtbareSpalten();
  _monRenderKopf(spalten);
  const jeWerk = new Map();
  const sicht = rows.slice(0, _monZeigen);
  const body = sicht.map((r, idx) => {
    if (!jeWerk.has(r.werk)) jeWerk.set(r.werk, _monWerkSpalten(r.werk));
    const ids = jeWerk.get(r.werk);
    const offen = _monOffen.has(_monKey(r));
    const zellen = spalten.map(sp => ids.has(sp.id) ? _monZelle(sp.id, r, idx) : '<td></td>');
    if (zellen.length) zellen[0] = zellen[0].replace(/^<td([^>]*)>/, '<td$1><span class="mon-auf" aria-hidden="true"></span>');
    return `<tr class="mon-zeile${idx % 2 ? ' z' : ''}${offen ? ' offen' : ''}" data-zeile="${idx}" tabindex="0" aria-expanded="${offen}">`
      + zellen.join('') + '<td class="mon-fueller"></td></tr>'
      + (offen ? _monDetailZeile(r, idx, spalten.length + 1) : '');
  }).join('');

  const rest = rows.length - sicht.length;
  const mehr = rest > 0
    ? `<tr><td colspan="${spalten.length + 1}" class="mon-mehr"><button type="button" data-mehr>Weitere ${Math.min(rest, MON.tabelleSeite)} anzeigen</button>`
      + `<span>noch ${rest} Treffer</span></td></tr>`
    : '';
  const leer = _monLaedt ? 'Rechnungen werden geladen…' : 'Keine Treffer für die aktuellen Filter.';
  document.getElementById('mon-tbody').innerHTML = (body + mehr)
    || `<tr><td colspan="${spalten.length + 1}" style="text-align:center;color:var(--gray-500);padding:28px;">${leer}</td></tr>`;
  document.getElementById('mon-count').textContent =
    (rest > 0 ? `${sicht.length} von ${rows.length} Treffern angezeigt (${_monRecords.length} gesamt)`
              : `${rows.length} von ${_monRecords.length} angezeigt`)
    + (_monLaedt ? ' · lädt…' : '');
  _monNachTabelle(sicht);
}

/* ── Ansicht: Details, Dichte, Vollbild, Scrollen ───────────────────── */

function _monKey(r) {
  return [r.werk, r.richtung, r.baseKey || r.file || r.nummer].join('|');
}

// Nach jedem Zeichnen: Breite für die Details, Knopf „Alle aufklappen“, Nachladen beim Scrollen
function _monNachTabelle(sicht) {
  const wrap = document.getElementById('mon-wrap');
  if (wrap) wrap.style.setProperty('--mon-wrap-breite', wrap.clientWidth + 'px');
  _monScrollObenAbgleichen();
  const alle = document.getElementById('mon-alle-auf');
  if (alle) {
    const alleOffen = sicht.length > 0 && sicht.every(r => _monOffen.has(_monKey(r)));
    alle.textContent = alleOffen ? 'Alle zuklappen' : 'Alle aufklappen';
    alle.disabled = !sicht.length;
  }
  if (_monBeobachter) _monBeobachter.disconnect();
  const mehr = document.querySelector('#mon-tbody [data-mehr]');
  if (mehr && wrap && 'IntersectionObserver' in window) {
    _monBeobachter = new IntersectionObserver(eintraege => {
      if (!eintraege.some(e => e.isIntersecting)) return;
      _monBeobachter.disconnect();
      _monZeigen += MON.tabelleSeite;
      _monRenderTable(_monRows);
    }, { root: wrap, rootMargin: '400px 0px' });
    _monBeobachter.observe(mehr);
  }
}

// Zweite waagerechte Bildlaufleiste über der Tabelle, läuft mit der unteren mit
function _monScrollObenAbgleichen() {
  const wrap = document.getElementById('mon-wrap');
  const oben = document.getElementById('mon-scroll-oben');
  if (!wrap || !oben) return;
  const breiter = wrap.scrollWidth > wrap.clientWidth + 1;
  oben.hidden = !breiter;
  if (!breiter) return;
  oben.style.width = wrap.clientWidth + 'px';
  oben.firstElementChild.style.width = wrap.scrollWidth + 'px';
  oben.scrollLeft = wrap.scrollLeft;
}

function _monDetailZeile(r, idx, spaltenAnzahl) {
  return `<tr class="mon-detail" data-detail="${idx}"><td colspan="${spaltenAnzahl}">${_monDetail(r, idx)}</td></tr>`;
}

// Alle Angaben zu einer Rechnung, auch aus Spalten, die gerade nicht angezeigt werden
function _monDetail(r, idx) {
  const block = (titel, paare) => {
    const inhalt = paare.filter(([, v]) => v != null && v !== '')
      .map(([k, v]) => `<dt>${_esc(k)}</dt><dd>${v}</dd>`).join('');
    return inhalt ? `<section><h4>${_esc(titel)}</h4><dl>${inhalt}</dl></section>` : '';
  };
  const t = v => (v == null || v === '' ? '' : _esc(v));
  const p = _monPartnerSicher(r);
  const flags = [r.formatmangel && 'Formatmangel', r.manuellePruefung && ('Manuelle Prüfung' + (r.manuellePruefungGrund ? ': ' + r.manuellePruefungGrund : '')),
    r.rueckfrage && 'Rückfrage beim Lieferanten', r.konvertiert && 'technisch konvertiertes PDF', r.dublette && r.dubletteInfo].filter(Boolean);
  const sonstige = typeof ugSonstige === 'function' && ugSonstige(r);
  const e = sonstige && typeof ugFuer === 'function' ? ugFuer(r) : null;
  const mails = sonstige && typeof ugMailsFuer === 'function' ? ugMailsFuer(r).slice(0, 3).map(m => _ugMailStand(m)) : [];
  const b = r.bh;
  const dateien = [r.url ? `<a href="${_esc(r.url)}" target="_blank" rel="noopener">${r.ext ? 'Original (' + _esc(r.ext.toUpperCase()) + ')' : 'Original'} ↗</a>` : '']
    .concat((r.dateien || []).map(d => `<a href="${_esc(d.url)}" target="_blank" rel="noopener">${_esc(d.label)} ↗</a>`))
    .filter(Boolean).join('<br>');
  const aktionen = (b ? `<button type="button" class="bh-btn" data-bh="${idx}">Bearbeiten</button>` : '')
    + (sonstige && typeof ugZelle === 'function' ? ugZelle(r, idx) : '');
  return `<div class="mon-det">`
    + block('Rechnung', [['Nummer', t(r.nummer)], ['Datum', t(_monDate(r.datum))], ['Fällig am', t(_monDate(r.faelligkeit))],
        ['Werk', t(r.werk)], ['Richtung', t(r.richtung)], ['Typ', t(_monKlass(r))], ['Rechnungsart', t(r.art)]])
    + block(r.richtung === 'Eingang' ? 'Lieferant' : 'Kunde', [
        ['Name', p.name ? t(p.name) + (p.quelle === 'einschaetzung' ? ' (bei der 800k-Einschätzung bestätigt)' : '') : ''],
        ['Rechnungsmail von', t(r.absenderMail)], ['USt-IdNr.', t(r.ustid)]])
    + block('Beträge', [['Netto', t(_monGeld(r.netto, r))], ['Brutto', t(_monGeld(r.brutto, r))], ['Bestellnummer', t((b && b.bestellnr) || r.bestellnr)]])
    + block('Prüfung', [['Ergebnis', t(r.konform)], ['Hinweis', t(_monHinweis(r))], ['Status', t(r.status)],
        ['Buchung', t(r.buchung) + (r.buchungAlt ? ` (gespeichert: ${t(r.buchungAlt)})` : '')], ['Prüfschritte', t(flags.join('\n'))],
        ['Fehler', t(r.fehler)], ['Aufbewahrung', r.gobdArchiviert ? t(r.complianceTag || 'GoBD-Aufbewahrung gesetzt') : ''],
        ['Mails', !sonstige && typeof ugMailsFuer === 'function' ? t(ugMailsFuer(r).slice(0, 3).map(m => _ugMailStand(m)).join(String.fromCharCode(10))) : '']])
    + (sonstige ? block('800.000 €', [
        ['Einschätzung', e ? t(`${(typeof _UG_LABEL !== 'undefined' && _UG_LABEL[e.vermutung]) || e.vermutung}, ${e.vonName || e.von || ''} am ${_monDate(e.am)}`) : 'noch offen'],
        ['Lieferant informiert', t(typeof ugInformiert === 'function' ? ugInformiert(r) : '')], ['Mails', t(mails.join('\n'))]]) : '')
    + (b ? block('Bearbeitung', [['Varialnummer', t(b.varial)], ['Kontierung', t(b.kontierung)], ['Bearbeitungsstatus', t(b.bstatus)],
        ['Genehmigung', t([typeof bhGenehmigungsStand === 'function' ? bhGenehmigungsStand(b) : '', b.genehmigt && 'Genehmigt: ' + b.genehmigt,
          b.kommentar && 'Kommentar: ' + b.kommentar].filter(Boolean).join('\n'))],
        ['GF gesehen', b.gfGesehen ? 'Ja' : ''], ['Notiz', t(b.notiz)]]) : '')
    + (dateien ? `<section><h4>Dateien</h4><div>${dateien}</div>${r.originalName && r.originalName !== r.file
        ? `<p class="mon-det-klein">Dateiname beim Eingang: ${_esc(r.originalName)}</p>` : ''}</section>` : '')
    + (r.listId && r.itemId ? `<section class="mon-ver"><h4>Versionsverlauf ${r.ext ? '(' + _esc(r.ext.toUpperCase()) + ')' : ''}</h4>
        <button type="button" class="mon-reset" data-versionen="${idx}">Versionsverlauf anzeigen</button>
        <div class="mon-ver-liste"></div></section>` : '')
    + (aktionen ? `<div class="mon-det-aktionen">${aktionen}</div>` : '')
    + `</div>`;
}

/* ── Versionsverlauf einer Datei ───────────────────────────────────── */

// Felder, die SharePoint selbst pflegt: nicht als Änderung zeigen
const MON_VER_OHNE = /^(@|_|id$|Created|Modified|Author|Editor|ContentType|Edit$|LinkTitle|LinkFilename|DocIcon|ItemChildCount|FolderChildCount|AppAuthor|AppEditor|FileSizeDisplay|File_x0020_Size|SMTotal|ParentVersionString|ParentLeafName|ComplianceAssetId|Attachments)/;

function _monSpaltenTitelLaden(listId, token) {
  if (!_monSpaltenTitel.has(listId)) {
    _monSpaltenTitel.set(listId,
      _monGet(`${SP.graphBase}/sites/${_monSiteId}/lists/${listId}/columns?$select=name,displayName,hidden`, token)
        .then(d => new Map((d.value || []).filter(c => !c.hidden).map(c => [c.name, c.displayName])))
        .catch(() => new Map()));
  }
  return _monSpaltenTitel.get(listId);
}

/** Feldwert einer Version lesbar machen. */
function _monVerWert(v) {
  if (v == null || v === '') return '–';
  if (typeof v === 'boolean') return v ? 'Ja' : 'Nein';
  if (Array.isArray(v)) return v.map(_monVerWert).join(', ');
  if (typeof v === 'object') return String(v.LookupValue || v.displayName || v.Email || JSON.stringify(v));
  const s = String(v);
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}.*Z$/.test(s)) {
    const zeit = new Date(s).toLocaleTimeString('de-DE', { timeZone: 'Europe/Berlin', hour: '2-digit', minute: '2-digit' });
    return _monDate(s) + (zeit === '00:00' ? '' : ' ' + zeit);
  }
  return s;
}

/**
 * Versionen einer Datei als aufklappbare Liste, neueste oben. Jede Zeile nennt Zeit,
 * Person und die geänderten Spalten. Aufgeklappt zeigt sie alle Werte dieser Version
 * und öffnet die Datei, wie sie in dieser Version war.
 */
function _monVersionenHtml(versionen, titel) {
  if (!versionen.length) return '<p class="mon-det-klein">Keine Versionen gefunden.</p>';
  const alt = versionen.slice().sort((a, b) => parseFloat(a.id) - parseFloat(b.id));
  const kurz = s => (s.length > 70 ? s.slice(0, 68) + '…' : s);
  const groesse = f => f.FileSizeDisplay || f.File_x0020_Size || f.SMTotalFileStreamSize || '';
  const zeilen = alt.map((v, i) => {
    const f = v.fields || {};
    const vorher = i > 0 ? (alt[i - 1].fields || {}) : null;
    const sichtbar = k => !MON_VER_OHNE.test(k) && titel.has(k);
    const aend = [];
    if (vorher) {
      if (groesse(f) && groesse(vorher) && String(groesse(f)) !== String(groesse(vorher))) aend.push('Datei ersetzt');
      Array.from(new Set(Object.keys(f).concat(Object.keys(vorher)))).filter(sichtbar).forEach(k => {
        // leer, fehlend und „Nein“ gelten als gleich (SharePoint lässt leere Felder weg)
        const norm = x => (x === false || x === '' || x == null ? null : x);
        if (JSON.stringify(norm(f[k])) !== JSON.stringify(norm(vorher[k]))) {
          aend.push(`${titel.get(k)}: ${kurz(_monVerWert(vorher[k]))} → ${kurz(_monVerWert(f[k]))}`);
        }
      });
    }
    const wer = v.lastModifiedBy ? ((v.lastModifiedBy.user || v.lastModifiedBy.application || {}).displayName || '') : '';
    const was = !vorher ? 'angelegt' : aend.length ? aend.join('; ') : 'ohne sichtbare Änderung';
    const werte = Object.keys(f).filter(sichtbar).filter(k => f[k] != null && f[k] !== '')
      .sort((a, b) => titel.get(a).localeCompare(titel.get(b), 'de'))
      .map(k => `<dt>${_esc(titel.get(k))}</dt><dd>${_esc(_monVerWert(f[k]))}</dd>`).join('');
    const neueste = i === alt.length - 1;
    return `<details class="mon-ver-v">
      <summary><b>Version ${_esc(v.id)}</b> · ${_esc(_monVerWert(v.lastModifiedDateTime))}${wer ? ' · ' + _esc(wer) : ''}
        <span class="mon-ver-was">${_esc(was)}</span></summary>
      <dl>${werte}</dl>
      <button type="button" class="mon-reset" data-ver-datei="${_esc(v.id)}"${neueste ? ' data-ver-neu' : ''}>Datei dieser Version öffnen</button>
    </details>`;
  });
  return zeilen.reverse().join('');
}

async function _monVersionenZeigen(knopf) {
  const r = _monRows[Number(knopf.getAttribute('data-versionen'))];
  const ziel = knopf.parentElement.querySelector('.mon-ver-liste');
  if (!r || !ziel) return;
  knopf.disabled = true;
  knopf.textContent = 'Wird geladen…';
  try {
    const token = await acquireToken(SP.scopes);
    const url = `${SP.graphBase}/sites/${_monSiteId}/lists/${r.listId}/items/${r.itemId}/versions`;
    const [d, titel] = await Promise.all([_monGet(url, token), _monSpaltenTitelLaden(r.listId, token)]);
    ziel.innerHTML = _monVersionenHtml(d.value || [], titel);
    knopf.textContent = 'Neu laden';
  } catch (e) {
    ziel.innerHTML = `<p class="mon-det-klein">Versionen nicht lesbar: ${_esc(e.message || String(e))}</p>`;
    knopf.textContent = 'Versionsverlauf anzeigen';
  }
  knopf.disabled = false;
}

/** Datei so öffnen, wie sie in einer Version war (neueste: aktuelle Datei). */
async function _monVersionDateiOeffnen(r, versionId, neueste) {
  const fenster = window.open('', '_blank');
  try {
    const token = await acquireToken(SP.scopes);
    const basis = `${SP.graphBase}/sites/${_monSiteId}/lists/${r.listId}/items/${r.itemId}/driveItem`;
    const resp = await fetch(neueste ? `${basis}/content` : `${basis}/versions/${encodeURIComponent(versionId)}/content`,
      { headers: { 'Authorization': `Bearer ${token}` } });
    if (!resp.ok) throw new Error(`Datei (${resp.status})`);
    const typ = { xml: 'text/xml', pdf: 'application/pdf' }[r.ext] || '';
    const blob = await resp.blob();
    const url = URL.createObjectURL(typ ? new Blob([blob], { type: typ }) : blob);
    if (fenster) fenster.location = url; else window.open(url, '_blank');
    setTimeout(() => URL.revokeObjectURL(url), 60000);
  } catch (e) {
    if (fenster) fenster.close();
    window.alert(`Version ${versionId} ließ sich nicht öffnen: ${e.message || e}`);
  }
}

function _monZeileUmschalten(tr) {
  const idx = Number(tr.getAttribute('data-zeile'));
  const r = _monRows[idx];
  if (!r) return;
  const key = _monKey(r);
  const naechste = tr.nextElementSibling;
  if (_monOffen.has(key)) {
    _monOffen.delete(key);
    if (naechste && naechste.classList.contains('mon-detail')) naechste.remove();
  } else {
    _monOffen.add(key);
    tr.insertAdjacentHTML('afterend', _monDetailZeile(r, idx, tr.children.length));
  }
  const offen = _monOffen.has(key);
  tr.classList.toggle('offen', offen);
  tr.setAttribute('aria-expanded', String(offen));
  _monNachTabelle(_monRows.slice(0, _monZeigen));
}

function _monDichteSetzen(d) {
  _monDichte = d === 'gross' ? 'gross' : 'kompakt';
  const wrap = document.getElementById('mon-wrap');
  if (wrap) wrap.className = 'mon-table-wrap dichte-' + _monDichte;
  document.querySelectorAll('[data-dichte]').forEach(b =>
    b.setAttribute('aria-pressed', String(b.getAttribute('data-dichte') === _monDichte)));
  try { localStorage.setItem('mon-dichte', _monDichte); } catch (e) { /* ohne Speicher */ }
}

function _monVollbild(an) {
  const bereich = document.getElementById('mon-tabelle');
  if (!bereich) return;
  const jetzt = typeof an === 'boolean' ? an : !bereich.classList.contains('vollbild');
  bereich.classList.toggle('vollbild', jetzt);
  document.body.classList.toggle('mon-vollbild-an', jetzt);
  const knopf = document.getElementById('mon-vollbild');
  if (knopf) knopf.textContent = jetzt ? '✕ Vollbild beenden' : '⛶ Vollbild';
  const wrap = document.getElementById('mon-wrap');
  if (wrap) wrap.style.setProperty('--mon-wrap-breite', wrap.clientWidth + 'px');
  _monScrollObenAbgleichen();
}

function _monAnsichtEvents() {
  let d = 'normal';
  try { d = localStorage.getItem('mon-dichte') || 'kompakt'; } catch (e) { /* ohne Speicher */ }
  _monDichteSetzen(d);
  document.querySelectorAll('[data-dichte]').forEach(b =>
    b.addEventListener('click', () => _monDichteSetzen(b.getAttribute('data-dichte'))));

  const alle = document.getElementById('mon-alle-auf');
  if (alle) alle.addEventListener('click', () => {
    const sicht = _monRows.slice(0, _monZeigen);
    const alleOffen = sicht.every(r => _monOffen.has(_monKey(r)));
    sicht.forEach(r => (alleOffen ? _monOffen.delete(_monKey(r)) : _monOffen.add(_monKey(r))));
    _monRenderTable(_monRows);
  });

  const voll = document.getElementById('mon-vollbild');
  if (voll) voll.addEventListener('click', () => _monVollbild());
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape' && document.body.classList.contains('mon-vollbild-an') && !document.querySelector('dialog[open]')) {
      _monVollbild(false);
    }
  });

  const wrap = document.getElementById('mon-wrap');
  const hoch = document.getElementById('mon-nachoben');
  if (wrap && hoch) {
    wrap.addEventListener('scroll', () => { hoch.hidden = wrap.scrollTop < 400; }, { passive: true });
    hoch.addEventListener('click', () => wrap.scrollTo({ top: 0, behavior: 'smooth' }));
  }
  window.addEventListener('resize', () => {
    if (wrap) wrap.style.setProperty('--mon-wrap-breite', wrap.clientWidth + 'px');
    _monScrollObenAbgleichen();
  });

  // obere und untere Bildlaufleiste koppeln
  const oben = document.getElementById('mon-scroll-oben');
  if (wrap && oben) {
    let quelle = null;
    oben.addEventListener('scroll', () => {
      if (quelle === wrap) { quelle = null; return; }
      quelle = oben; wrap.scrollLeft = oben.scrollLeft;
    }, { passive: true });
    wrap.addEventListener('scroll', () => {
      if (quelle === oben) { quelle = null; return; }
      if (oben.scrollLeft !== wrap.scrollLeft) { quelle = wrap; oben.scrollLeft = wrap.scrollLeft; }
    }, { passive: true });
  }

  // Spaltenbreite per Ziehen am rechten Rand der Kopfzelle, Doppelklick = Standard
  const kopfBereich = document.querySelector('table.mon-table thead');
  let zug = null;
  if (kopfBereich) {
    kopfBereich.addEventListener('pointerdown', e => {
      const g = e.target.closest('[data-griff]');
      if (!g) return;
      e.preventDefault();
      const col = document.querySelector(`#mon-cols col[data-sp="${g.dataset.griff}"]`);
      if (!col) return;
      zug = { id: g.dataset.griff, col, start: e.clientX, breite: parseFloat(col.style.width) || 100, neu: 0 };
      try { g.setPointerCapture(e.pointerId); } catch (_) { /* ohne Capture weiter */ }
      document.body.classList.add('mon-zieht');
    });
    kopfBereich.addEventListener('pointermove', e => {
      if (!zug) return;
      zug.neu = Math.max(48, Math.min(900, Math.round(zug.breite + e.clientX - zug.start)));
      zug.col.style.width = zug.neu + 'px';
      _monTabBreiteSetzen();
    });
    const ende = () => {
      if (!zug) return;
      if (zug.neu) {
        const alle = _monEigeneBreiten();
        const w = _monAnsichtWerk || '';
        // Breiten von vor dem letzten Standard gelten nicht mehr: mit dieser einen neu anfangen
        alle[w] = Object.assign({}, _monEigeneAktiv(w), { [zug.id]: zug.neu });
        _monEigeneBreitenSpeichern(alle);
        const am = _monEigeneBreitenAm();
        am[w] = new Date().toISOString();
        try { localStorage.setItem('mon-breiten-am', JSON.stringify(am)); } catch (e) { /* ohne Speicher */ }
        _monGriffZeit = Date.now();
        const zurueck = document.getElementById('mon-breiten-zurueck');
        if (zurueck) zurueck.hidden = false;
      }
      zug = null;
      document.body.classList.remove('mon-zieht');
      _monScrollObenAbgleichen();
      if (wrap) wrap.style.setProperty('--mon-wrap-breite', wrap.clientWidth + 'px');
    };
    kopfBereich.addEventListener('pointerup', ende);
    kopfBereich.addEventListener('pointercancel', ende);
    kopfBereich.addEventListener('dblclick', e => {
      const g = e.target.closest('[data-griff]');
      if (!g) return;
      const alle = _monEigeneBreiten();
      const w = _monAnsichtWerk || '';
      if (alle[w]) { delete alle[w][g.dataset.griff]; _monEigeneBreitenSpeichern(alle); }
      _monGriffZeit = Date.now();
      _monRenderTable(_monRows);
    });
  }
  const breitenZurueck = document.getElementById('mon-breiten-zurueck');
  if (breitenZurueck) breitenZurueck.addEventListener('click', () => {
    const alle = _monEigeneBreiten();
    delete alle[_monAnsichtWerk || ''];
    _monEigeneBreitenSpeichern(alle);
    _monRenderTable(_monRows);
  });

  // Zeile per Tastatur auf- und zuklappen
  const tbody = document.getElementById('mon-tbody');
  if (tbody) tbody.addEventListener('keydown', e => {
    if ((e.key === 'Enter' || e.key === ' ') && e.target.matches('tr.mon-zeile')) {
      e.preventDefault();
      _monZeileUmschalten(e.target);
    }
  });
}

/* ── Spalten je Werk festlegen (Admin) ──────────────────────────────── */

function _monSpaltenDialog(werk) {
  const dlg = document.getElementById('sp-dialog');
  if (!dlg || typeof bhEinstSpeichern !== 'function') return;
  const werke = Array.from(new Set(_monLibs.map(l => l.werk).filter(Boolean))).sort();
  let w = werk && werke.includes(werk) ? werk : werke[0];
  const zeichnen = () => {
    const e = bhWerkEinst(w);
    const gewaehlt = Array.isArray(e.spalten) && e.spalten.length ? e.spalten : MON_STANDARD;
    const ids = gewaehlt.includes('links') ? gewaehlt : ['links'].concat(gewaehlt);
    // erst die gewählten in ihrer Reihenfolge, dahinter die übrigen
    const reihe = ids.filter(id => MON_SPALTEN.some(sp => sp.id === id))
      .concat(MON_SPALTEN.map(sp => sp.id).filter(id => !ids.includes(id)));
    const bh = bhBearbeitenAn(w);
    // Maßgeblich ist, was die Tabelle gerade zeigt (_monBreitenWieAngezeigt). Für Spalten,
    // die dort nicht zu sehen sind, gelten die eigenen Breiten des Werks, sonst die der
    // Ansicht oder eines anderen Werks (gespeichert wird je Werk der Ansicht beim Ziehen).
    const alleEigenen = _monEigeneBreiten();
    const breitenQuelle = [w, _monAnsichtWerk || ''].concat(Object.keys(alleEigenen))
      .find(k => Object.keys(_monEigeneAktiv(k)).length);
    dlg.innerHTML = `
      <form method="dialog" class="ug-form">
        <div class="ug-kopf"><h3>Spalten je Werk</h3><button type="button" class="ug-x" data-sp-zu aria-label="Schließen">✕</button></div>
        <label class="ug-lbl">Werk<select id="sp-werk">${werke.map(x => `<option${x === w ? ' selected' : ''}>${_esc(x)}</option>`).join('')}</select></label>
        <label class="bh-check"><input type="checkbox" id="sp-bh"${bh ? ' checked' : ''}> Bearbeiten-Funktion (Varialnummer, Kontierung, Genehmigung)</label>
        <p class="ug-hinweis">Haken = Spalte wird angezeigt. Reihenfolge per Ziehen am ☰ oder mit den Pfeilen.</p>
        <ul class="sp-liste" id="sp-liste">${reihe.map(id => {
          const sp = MON_SPALTEN.find(x => x.id === id);
          return `<li class="sp-zeile${sp.bh ? ' sp-bh' : ''}" draggable="true" data-sp-li="${sp.id}">
            <span class="sp-griff" aria-hidden="true">☰</span>
            <label class="bh-check"><input type="checkbox" data-sp="${sp.id}"${ids.includes(sp.id) ? ' checked' : ''}${sp.fest ? ' checked disabled' : ''}${sp.bh && !bh ? ' disabled' : ''}> ${_esc(sp.name || sp.titel)}${sp.fest ? ' <small>(immer)</small>' : ''}</label>
            <button type="button" class="sp-pfeil" data-sp-hoch title="nach oben" aria-label="${_esc(sp.name || sp.titel)} nach oben">▲</button>
            <button type="button" class="sp-pfeil" data-sp-runter title="nach unten" aria-label="${_esc(sp.name || sp.titel)} nach unten">▼</button>
          </li>`;
        }).join('')}</ul>
        <label class="ug-lbl">Speichern für<select id="sp-umfang">
          <option value="werk">nur ${_esc(w)}</option>
          <option value="alle">alle Werke (${_esc(werke.join(', '))})</option></select></label>
        <label class="bh-check"><input type="checkbox" id="sp-breiten"> Meine Spaltenbreiten als Standard für alle übernehmen <small>(wie die Tabelle sie gerade zeigt)</small></label>
        <p class="ug-hinweis">Die Einstellungen gelten für alle, die das Monitoring nutzen. Eigene Breiten, die jemand selbst zieht, gehen vor. Ist kein Werk gefiltert, zeigt die Tabelle die Spalten aller Werke, Zellen eines Werks ohne die Spalte bleiben leer.</p>
        <p class="ug-meldung" id="sp-meldung" role="status"></p>
        <div class="ug-aktionen">
          <button type="button" class="ug-sek" data-sp-standard>Standard</button>
          <button type="button" class="ug-sek" data-sp-zu>Abbrechen</button>
          <button type="button" class="ug-prim" data-sp-speichern>Speichern</button>
        </div>
      </form>`;
    dlg.querySelector('#sp-werk').addEventListener('change', ev => { w = ev.target.value; zeichnen(); });
    dlg.querySelector('#sp-bh').addEventListener('change', ev => {
      dlg.querySelectorAll('.sp-bh input').forEach(i => { i.disabled = !ev.target.checked; });
    });
    // Reihenfolge: Pfeile und Ziehen
    const liste = dlg.querySelector('#sp-liste');
    liste.addEventListener('click', ev => {
      const li = ev.target.closest('li');
      if (!li) return;
      if (ev.target.closest('[data-sp-hoch]') && li.previousElementSibling) li.parentNode.insertBefore(li, li.previousElementSibling);
      if (ev.target.closest('[data-sp-runter]') && li.nextElementSibling) li.parentNode.insertBefore(li.nextElementSibling, li);
    });
    let gezogen = null;
    liste.addEventListener('dragstart', ev => {
      gezogen = ev.target.closest('li');
      if (gezogen) { gezogen.classList.add('zieht'); ev.dataTransfer.effectAllowed = 'move'; ev.dataTransfer.setData('text/plain', gezogen.dataset.spLi); }
    });
    liste.addEventListener('dragend', () => { if (gezogen) gezogen.classList.remove('zieht'); gezogen = null; });
    liste.addEventListener('dragover', ev => {
      if (!gezogen) return;
      ev.preventDefault();
      const ziel = ev.target.closest('li');
      if (!ziel || ziel === gezogen) return;
      const r = ziel.getBoundingClientRect();
      liste.insertBefore(gezogen, ev.clientY > r.top + r.height / 2 ? ziel.nextElementSibling : ziel);
    });
    dlg.querySelectorAll('[data-sp-zu]').forEach(x => x.addEventListener('click', () => dlg.close()));
    dlg.querySelector('[data-sp-standard]').addEventListener('click', () => {
      const ordnung = MON_STANDARD.concat(MON_SPALTEN.map(sp => sp.id).filter(id => !MON_STANDARD.includes(id)));
      ordnung.forEach(id => { const li = liste.querySelector(`[data-sp-li="${id}"]`); if (li) liste.appendChild(li); });
      dlg.querySelectorAll('[data-sp]').forEach(i => { if (!i.disabled || i.getAttribute('data-sp') !== 'links') i.checked = MON_STANDARD.includes(i.getAttribute('data-sp')); });
    });
    dlg.querySelector('[data-sp-speichern]').addEventListener('click', async () => {
      const spalten = Array.from(liste.querySelectorAll('[data-sp]'))
        .filter(i => i.checked || i.getAttribute('data-sp') === 'links').map(i => i.getAttribute('data-sp'));
      const meldung = dlg.querySelector('#sp-meldung');
      dlg.querySelectorAll('.ug-aktionen button').forEach(b => { b.disabled = true; });
      meldung.textContent = 'Wird gespeichert…';
      try {
        const teil = { spalten, bearbeiten: dlg.querySelector('#sp-bh').checked };
        const breitenWahl = dlg.querySelector('#sp-breiten');
        if (breitenWahl && breitenWahl.checked) {
          teil.breiten = _monBreitenWieAngezeigt(Object.assign({}, bhWerkEinst(w).breiten, _monEigeneAktiv(breitenQuelle)));
          // ab jetzt gilt der Standard für alle, auch für die, die vorher selbst gezogen haben
          teil.breitenStand = new Date().toISOString();
        }
        await bhEinstSpeichern(dlg.querySelector('#sp-umfang').value === 'alle' ? werke : w, teil);
        dlg.close();
        _monUpdate(_monDateien);
        _monBuildFilterOptions(_monLibs);
        _monSyncControls();
        _monApply();
      } catch (err) {
        meldung.textContent = err.message || String(err);
        meldung.className = 'ug-meldung nicht';
        dlg.querySelectorAll('.ug-aktionen button').forEach(b => { b.disabled = false; });
      }
    });
  };
  zeichnen();
  if (typeof dlg.showModal === 'function') dlg.showModal(); else dlg.setAttribute('open', '');
}

// Geschaeftspartner der Zeile: Eingang = Steller, Ausgang = Empfaenger. Angezeigt
// wird nur, was sicher ist: der Name aus der E-Rechnung (XML) oder der Name, den die
// Buchhaltung bei der 800k-Einschaetzung bestaetigt hat (js/umsatzgrenze.js). Den
// Namen, den der Pruefdienst aus dem PDF-Text gelesen hat, zeigt die Tabelle nicht.

/** Stammen die Kopfdaten aus einer XML (ZUGFeRD, XRechnung) statt aus dem PDF-Text? */
function _monAusXml(r) {
  return ['ZUGFeRD', 'XRechnung'].includes(_monKlass(r)) || r.ext === 'xml'
    || (r.dateien || []).some(d => d.label === 'XML');
}

/** Sicherer Name und seine Quelle: { name, quelle: 'xml' | 'einschaetzung' | '' }. */
function _monPartnerSicher(r) {
  if (r.richtung !== 'Eingang') return { name: r.empf || '', quelle: 'xml' };
  if (r.steller && _monAusXml(r)) return { name: r.steller, quelle: 'xml' };
  const e = typeof ugFuer === 'function' ? ugFuer(r) : null;
  return e && e.name ? { name: e.name, quelle: 'einschaetzung' } : { name: '', quelle: '' };
}

function _monPartner(r) {
  return _monPartnerSicher(r).name;
}

function _monPartnerCell(r) {
  const p = _monPartnerSicher(r);
  const name = p.quelle === 'einschaetzung'
    ? `<span title="Bei der 800k-Einschätzung bestätigt, nicht aus der Rechnung gelesen" style="font-style:italic;">${_esc(p.name)}</span>`
    : _esc(p.name);
  // Absender der Rechnungsmail (vom Eingangs-Flow, also sicher)
  const mail = r.richtung === 'Eingang' && r.absenderMail
    ? `<div class="mon-mail" title="Absender der Rechnungsmail">✉ ${_esc(r.absenderMail)}</div>` : '';
  return (name + mail) || '<span style="color:#9ca3af;">–</span>';
}

// Klartext-Hinweis zur Konformität. Nimmt einen bereits fertigen API-Hinweis
// unverändert; enthält der gespeicherte Text noch die rohen KoSIT-Codes
// (BR-*/CII-*), wird daraus ein verständlicher Satz gemacht. Spiegelt
// _hinweisAusBefunden in api/src/kosit.js wider. Leer bei grün/ohne Meldung.
function _monHinweis(r) {
  const s = (r.meldung || '').trim();
  const k = (r.konform || '').toLowerCase();
  if (k.startsWith('gr')) return '';
  // Bis 10/2026 schrieb die Prüfung bei Warnungen (und manchen Fehlern) keinen Text.
  if (!s && k.startsWith('gel')) return 'Nur Warnungen, die Rechnung ist gültig. Details im Prüfbericht.';
  if (!s && k.startsWith('rot')) return 'Nicht konform. Details im Prüfbericht.';
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
/**
 * Kalendertag (JJJJ-MM-TT) in Deutschland. Zeitpunkte mit Uhrzeit und Zeitzone
 * (SharePoint: UTC) werden umgerechnet, reine Tage bleiben, wie sie sind.
 */
function _monTag(s) {
  const t = String(s || '').trim();
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}.*(Z|[+-]\d{2}:?\d{2})$/.test(t)) return t;
  const d = new Date(t);
  if (isNaN(d)) return t;
  return new Intl.DateTimeFormat('sv-SE', { timeZone: 'Europe/Berlin', year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);
}

function _monDate(s) {
  const d = _monTag(s).slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(d) ? d.split('-').reverse().join('.') : d;
}

// Heutiges Datum als ISO (lokal), für den Überfälligkeits-Vergleich.
function _monTodayIso() {
  const d = new Date(); d.setMinutes(d.getMinutes() - d.getTimezoneOffset());
  return d.toISOString().slice(0, 10);
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
                 manuell: 'Manuelle Prüfung', rueckfrage: 'Zur Rückfrage', zurueck: 'Zurückgewiesen',
                 umsatz: '800k-Einschätzung offen', genehmigung: 'In Genehmigung' };
  const deDate = s => s.split('-').reverse().join('.');
  const chips = [];
  if (f.werk)     chips.push(['werk', 'Werk: ' + f.werk]);
  if (f.richtung) chips.push(['richtung', f.richtung]);
  if (f.klass)    chips.push(['klass', 'Typ: ' + f.klass]);
  if (f.konform)  chips.push(['konform', 'Konform.: ' + (KONF[f.konform] || f.konform)]);
  if (f.buchung)  chips.push(['buchung', f.buchung === '__klein' ? 'Kleinbetrag' : 'Buchung: ' + f.buchung]);
  if (f.status)   chips.push(['status', 'Status: ' + f.status]);
  if (f.bstatus)  chips.push(['bstatus', 'Bearbeitung: ' + f.bstatus]);
  if (f.genehmigt) chips.push(['genehmigt', 'Genehmigt: ' + f.genehmigt]);
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
  Object.assign(_monFilter, { werk: '', richtung: '', klass: '', konform: '', buchung: '', status: '', bstatus: '', genehmigt: '', from: '', to: '', q: '', flag: '' });
  _monSyncControls();
  _monApply();
}

// Filterzustand zurück in die Steuerelemente schreiben (nach Kachel-/Chip-Klick).
function _monSyncControls() {
  const f = _monFilter;
  const set = (id, v) => { const el = document.getElementById(id); if (el) el.value = v; };
  set('mon-f-werk', f.werk); set('mon-f-richtung', f.richtung); set('mon-f-klass', f.klass);
  set('mon-f-konform', f.konform); set('mon-f-buchung', f.buchung); set('mon-f-status', f.status);
  set('mon-f-bstatus', f.bstatus); set('mon-f-genehmigt', f.genehmigt);
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
  bind('mon-f-bstatus', 'bstatus');
  bind('mon-f-genehmigt', 'genehmigt');
  bind('mon-f-from', 'from');
  bind('mon-f-to', 'to');
  const q = document.getElementById('mon-f-q');
  if (q) q.addEventListener('input', () => { _monFilter.q = q.value; _monApply(); });
  const reset = document.getElementById('mon-reset');
  if (reset) reset.addEventListener('click', _monResetFilters);
  // Neu laden ohne Seitenwechsel. Filter, Sortierung und das gewählte Werk bleiben.
  const neu = document.getElementById('mon-aktualisieren');
  if (neu) neu.addEventListener('click', () => {
    if (!_monAufruf) return;
    loadMonitoring(_monAufruf.accessList, Object.assign({}, _monAufruf.optionen, { standardWerk: '' }));
  });

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

  // 800k-Einschaetzung: Button/Badge in der Buchungs-Spalte oeffnet den Dialog.
  const tbody = document.getElementById('mon-tbody');
  if (tbody) tbody.addEventListener('click', e => {
    // Nächste Seite der Tabelle zeichnen (die Daten sind schon geladen).
    if (e.target.closest('[data-mehr]')) {
      _monZeigen += MON.tabelleSeite;
      _monRenderTable(_monRows);
      return;
    }
    const bh = e.target.closest('[data-bh]');
    if (bh && typeof bhDialogOeffnen === 'function') {
      const r = _monRows[Number(bh.getAttribute('data-bh'))];
      if (r) bhDialogOeffnen(r, () => { _monBuildFilterOptions(_monLibs); _monSyncControls(); _monApply(); });
      return;
    }
    const btn = e.target.closest('[data-ug]');
    if (btn && typeof ugDialogOeffnen === 'function') {
      const r = _monRows[Number(btn.getAttribute('data-ug'))];
      if (r) ugDialogOeffnen(r, () => _monApply());
      return;
    }
    const ver = e.target.closest('[data-versionen]');
    if (ver) { _monVersionenZeigen(ver); return; }
    const verDatei = e.target.closest('[data-ver-datei]');
    if (verDatei) {
      const r = _monRows[Number(verDatei.closest('.mon-ver').querySelector('[data-versionen]').getAttribute('data-versionen'))];
      if (r) _monVersionDateiOeffnen(r, verDatei.getAttribute('data-ver-datei'), verDatei.hasAttribute('data-ver-neu'));
      return;
    }
    if (e.target.closest('a, button, input, select, textarea, label, summary')) return;
    if (String(window.getSelection ? window.getSelection() : '').trim()) return;
    const tr = e.target.closest('tr.mon-zeile');
    if (tr) _monZeileUmschalten(tr);
  });
  _monAnsichtEvents();

  // Spalten sortieren (Klick auf Kopfzeile toggelt Richtung). Die Kopfzeile wird je
  // nach Spaltenauswahl neu gezeichnet, deshalb per Delegation.
  const kopf = document.querySelector('table.mon-table thead');
  if (kopf) kopf.addEventListener('click', e => {
    if (e.target.closest('[data-griff]') || Date.now() - _monGriffZeit < 400) return;
    const th = e.target.closest('th[data-sort]');
    if (!th) return;
    const key = th.getAttribute('data-sort');
    if (_monSort.key === key) _monSort.dir = -_monSort.dir;
    else _monSort = { key, dir: ['datum', 'brutto', 'netto'].includes(key) ? -1 : 1 };
    _monApply();
  });

  // Spalten je Werk festlegen (nur Admins)
  const spaltenKnopf = document.getElementById('mon-spalten');
  if (spaltenKnopf) {
    spaltenKnopf.style.display = typeof isCurrentUserAdmin === 'function' && isCurrentUserAdmin() ? '' : 'none';
    spaltenKnopf.addEventListener('click', () => _monSpaltenDialog(_monFilter.werk || _monAnsichtWerk));
  }
}

function _esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

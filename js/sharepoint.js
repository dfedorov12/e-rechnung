/**
 * SharePoint / Microsoft Graph API Integration
 * Liste: https://dihag.sharepoint.com/sites/IT/Lists/ERechnung
 * Dateien: Dokumente-Bibliothek / E-Rechnung/
 */

const SP = {
  graphBase: 'https://graph.microsoft.com/v1.0',
  siteHost:  'dihag.sharepoint.com:/sites/IT',
  listName:  'E-Rechnung',
  folder:    'E-Rechnung',
  scopes: [
    'https://graph.microsoft.com/Sites.ReadWrite.All',
    'https://graph.microsoft.com/Files.ReadWrite.All',
  ],
};

// Cached IDs nach erster Initialisierung
// availableFields: nur Felder schreiben, die wirklich in der Liste existieren
const _sp = { siteId: null, listId: null, driveId: null, ready: false, availableFields: new Set(['Title']) };

/* ═══════════════════════════════════════════════════
   Öffentliche API
═══════════════════════════════════════════════════ */

/** Audit-Kurzstatus für die SharePoint-Spalte „Pruefstatus". */
function _auditStatus(audit) {
  if (!audit) return '';
  const parts = [];
  if (audit.manuelleAenderungen && audit.manuelleAenderungen.length) parts.push('Manuell geaendert');
  if (audit.stammdatenEntsperrt) parts.push('Stammdaten entsperrt');
  if (audit.quellViaOcr) parts.push('OCR-Quelle');
  return (parts.length ? parts.join(', ') : 'Automatisch').slice(0, 255);
}

/**
 * Exportierten Datensatz in SharePoint speichern.
 * Lädt XML + PDF hoch, schreibt List-Item mit Metadaten.
 */
async function spSaveExport({ invoiceData, xml, pdfBytes, format }) {
  const token = await acquireToken(SP.scopes);
  if (!token) return null;
  await _spInit(token);

  const safeNr   = _safe(invoiceData.rechnungsnummer);
  const dateStr  = (invoiceData.rechnungsdatum || '').replace(/-/g, '');

  let xmlUrl = '', pdfUrl = '';

  if (xml) {
    const res = await _uploadFile(
      token,
      `${SP.folder}/${safeNr}_${dateStr}_xrechnung.xml`,
      new TextEncoder().encode('﻿' + xml),
      'text/xml'
    );
    xmlUrl = res.webUrl || '';
  }

  if (pdfBytes) {
    const res = await _uploadFile(
      token,
      `${SP.folder}/${safeNr}_${dateStr}_zugferd.pdf`,
      pdfBytes instanceof Uint8Array ? pdfBytes : new Uint8Array(pdfBytes),
      'application/pdf'
    );
    pdfUrl = res.webUrl || '';
  }

  const allFields = {
    Title:               (invoiceData.rechnungsnummer || '').slice(0, 255),
    Rechnungsdatum:      invoiceData.rechnungsdatum || new Date().toISOString().slice(0, 10),
    Rechnungssteller:    (invoiceData.verkaeufer || '').slice(0, 255),
    Rechnungsempfaenger: (invoiceData.kaeufer || '').slice(0, 255),
    Nettobetrag:         Number((invoiceData.netTotal   || 0).toFixed(2)),
    MwStBetrag:          Number((invoiceData.vatTotal   || 0).toFixed(2)),
    Bruttobetrag:        Number((invoiceData.grossTotal || 0).toFixed(2)),
    Format:              format === 'zugferd' ? 'ZUGFeRD' : 'XRechnung',
    Gesellschaft:        (invoiceData.gesellschaft || 'WGC').toUpperCase().slice(0, 10),
    XMLDateiUrl:         xmlUrl,
    ZUGFeRDPdfUrl:       pdfUrl,
    OriginalPdfName:     (invoiceData.originalPdfName || '').slice(0, 255),
    // Prüfpfad / Audit (#7) — werden nur geschrieben, wenn die Liste die Spalten hat
    Pruefstatus:         _auditStatus(invoiceData.audit),
    ManuelleAenderungen: invoiceData.audit ? JSON.stringify(invoiceData.audit.manuelleAenderungen || []).slice(0, 255) : '',
    QuellPdfHash:        invoiceData.audit ? (invoiceData.audit.quellPdfHash || '').slice(0, 255) : '',
    GeprueftVon:         invoiceData.audit ? (invoiceData.audit.geprueftVon || '').slice(0, 255) : '',
    StammdatenEntsperrt: invoiceData.audit ? (invoiceData.audit.stammdatenEntsperrt ? 'Ja' : 'Nein') : '',
  };

  // Nur Felder senden, die in der Liste vorhanden sind (verhindert 400-Fehler bei fehlenden Spalten)
  const fields = Object.fromEntries(
    Object.entries(allFields).filter(([k]) => _sp.availableFields.has(k))
  );

  // Diagnose Prüfpfad-Spalten (#7): interner Spaltenname muss exakt passen.
  const _auditCols = ['Pruefstatus', 'ManuelleAenderungen', 'QuellPdfHash', 'GeprueftVon', 'StammdatenEntsperrt'];
  const _missingCols = _auditCols.filter(c => !_sp.availableFields.has(c));
  if (_missingCols.length) {
    console.warn(
      '[SharePoint] Prüfpfad-Spalten NICHT gefunden (interner Name muss exakt passen): ' + _missingCols.join(', ') +
      '\nVorhandene Spalten: ' + Array.from(_sp.availableFields).sort().join(', ')
    );
  } else {
    console.info('[SharePoint] Alle ' + _auditCols.length + ' Prüfpfad-Spalten erkannt – Audit wird geschrieben.');
  }

  return await _post(
    `${SP.graphBase}/sites/${_sp.siteId}/lists/${_sp.listId}/items`,
    token, { fields }
  );
}

/**
 * Alle Einträge aus der SharePoint-Liste laden.
 */
async function spGetExports() {
  const token = await acquireToken(SP.scopes);
  if (!token) return [];
  await _spInit(token);

  const resp = await _get(
    `${SP.graphBase}/sites/${_sp.siteId}/lists/${_sp.listId}/items` +
    `?$expand=fields&$orderby=createdDateTime%20desc&$top=200`,
    token
  );

  return (resp.value || []).map(item => {
    const verkaeufer = item.fields.Rechnungssteller || '';
    // Gesellschaft: gespeicherter Wert hat Vorrang; bei fehlenden Alteinträgen
    // wird die Gesellschaft aus dem Ausstellernamen erkannt.
    const gesellschaft = item.fields.Gesellschaft || _detectGesellschaft(verkaeufer);
    return {
      id:              item.id,
      createdAt:       item.createdDateTime,
      rechnungsnummer: item.fields.Title               || '',
      rechnungsdatum:  item.fields.Rechnungsdatum      || '',
      verkaeufer,
      kaeufer:         item.fields.Rechnungsempfaenger || '',
      netTotal:        item.fields.Nettobetrag         || 0,
      vatTotal:        item.fields.MwStBetrag          || 0,
      grossTotal:      item.fields.Bruttobetrag        || 0,
      format:          item.fields.Format              || 'XRechnung',
      gesellschaft,
      xmlUrl:          item.fields.XMLDateiUrl         || '',
      pdfUrl:          item.fields.ZUGFeRDPdfUrl       || '',
      originalPdf:     item.fields.OriginalPdfName     || '',
    };
  });
}

/**
 * Gesellschaft aus dem Ausstellernamen ableiten (Fallback für Alteinträge).
 * WGC  → enthält "Coswig" oder "walzen" oder "WGC"
 * SHB  → enthält "Bösdorf", "Boesdorf", "Hartguss" oder "SHB"
 * Default: WGC
 */
function _detectGesellschaft(verkaeufer) {
  const v = (verkaeufer || '').toLowerCase();
  if (v.includes('bösdorf') || v.includes('boesdorf') ||
      v.includes('hartguss') || /\bshb\b/.test(v))   return 'SHB';
  if (v.includes('coswig')  || v.includes('walzen')  ||
      /\bwgc\b/.test(v))                             return 'WGC';
  return '';
}

/**
 * Zugriffs-Config aus SharePoint laden.
 * Datei: Dokumente/E-Rechnung/access-config.json
 * @returns {object|null}
 */
async function spLoadAccessConfig() {
  const token = await acquireToken(SP.scopes);
  if (!token) return null;
  await _spInit(token);
  if (!_sp.driveId) return null;

  const url = `${SP.graphBase}/drives/${_sp.driveId}/root:/${SP.folder}/access-config.json:/content`;
  const resp = await fetch(url, {
    headers: { 'Authorization': `Bearer ${token}`, 'Accept': 'application/json' },
  });
  if (!resp.ok) return null; // 404 = noch keine Config angelegt
  return resp.json();
}

/**
 * Zugriffs-Config in SharePoint speichern.
 * @param {object} config  z.B. { wgc: ['user@dihag.com'], shb: [] }
 */
async function spSaveAccessConfig(config) {
  const token = await acquireToken(SP.scopes);
  if (!token) throw new Error('Nicht angemeldet');
  await _spInit(token);
  if (!_sp.driveId) throw new Error('Keine Dokument-Bibliothek gefunden.');

  const json = JSON.stringify(config, null, 2);
  await _uploadFile(
    token,
    `${SP.folder}/access-config.json`,
    new TextEncoder().encode(json),
    'application/json'
  );
}

/**
 * Fehler-Benachrichtigungs-Config laden (E-Mail je Werk).
 * Datei: Dokumente/E-Rechnung/fehler-mail-config.json
 * @returns {object|null}  z.B. { WGC: 'wgc-team@dihag.com', SHB: '' }
 */
async function spLoadFehlerConfig() {
  const token = await acquireToken(SP.scopes);
  if (!token) return null;
  await _spInit(token);
  if (!_sp.driveId) return null;

  const url = `${SP.graphBase}/drives/${_sp.driveId}/root:/${SP.folder}/fehler-mail-config.json:/content`;
  const resp = await fetch(url, {
    headers: { 'Authorization': `Bearer ${token}`, 'Accept': 'application/json' },
  });
  if (!resp.ok) return null; // 404 = noch nicht angelegt
  return resp.json();
}

/**
 * Fehler-Benachrichtigungs-Config speichern.
 * @param {object} config  z.B. { WGC: 'wgc-team@dihag.com', SHB: 'shb@dihag.com' }
 */
async function spSaveFehlerConfig(config) {
  const token = await acquireToken(SP.scopes);
  if (!token) throw new Error('Nicht angemeldet');
  await _spInit(token);
  if (!_sp.driveId) throw new Error('Keine Dokument-Bibliothek gefunden.');

  await _uploadFile(
    token,
    `${SP.folder}/fehler-mail-config.json`,
    new TextEncoder().encode(JSON.stringify(config, null, 2)),
    'application/json'
  );
}

/**
 * Eintrag aus der SharePoint-Liste löschen.
 */
async function spDeleteItem(itemId) {
  const token = await acquireToken(SP.scopes);
  if (!token) return;
  await _spInit(token);
  await _del(
    `${SP.graphBase}/sites/${_sp.siteId}/lists/${_sp.listId}/items/${itemId}`,
    token
  );
}

/* ═══════════════════════════════════════════════════
   Rechnungsmonitoring – Export in Bibliothek AR_<Werk>
   Konverter-Ausgaben (Ausgangsrechnungen) landen direkt in der
   Monitoring-Site, damit der Reiter „Monitoring" alles zeigt.
   Bibliotheken: scripts/provision-rechnungsmonitoring.ps1
═══════════════════════════════════════════════════ */

const MON_SP = { siteHost: 'dihag.sharepoint.com:/sites/Rechnungsmonitoring' };
const _mon = { siteId: null, lists: null, drives: null, cols: {} };

const _RA_LABELS = {
  '380': '380 - Rechnung', '381': '381 - Kaufmaennische Gutschrift',
  '383': '383 - Belastungsanzeige', '384': '384 - Rechnungskorrektur',
  '386': '386 - Vorauszahlung', '389': '389 - Gutschrift (Selbstfakturierung)',
  '326': '326 - Teilrechnung',
};

async function _monInit(token) {
  if (_mon.siteId) return;
  const site = await _get(`${SP.graphBase}/sites/${MON_SP.siteHost}`, token);
  _mon.siteId = site.id;

  const lists = await _get(
    `${SP.graphBase}/sites/${_mon.siteId}/lists?$select=id,name,displayName,list&$top=200`, token);
  _mon.lists = {};
  (lists.value || []).forEach(l => {
    const n = l.name || l.displayName;
    if (n) _mon.lists[n.toUpperCase()] = l.id;
  });

  const drives = await _get(`${SP.graphBase}/sites/${_mon.siteId}/drives?$top=200`, token);
  _mon.drives = {};
  (drives.value || []).forEach(d => { if (d.name) _mon.drives[d.name.toUpperCase()] = d.id; });
}

async function _monCols(token, listId, key) {
  if (_mon.cols[key]) return _mon.cols[key];
  const set = new Set(['Title']);
  try {
    const cols = await _get(`${SP.graphBase}/sites/${_mon.siteId}/lists/${listId}/columns`, token);
    (cols.value || []).forEach(c => set.add(c.name));
  } catch (e) { console.warn('[Monitoring] Spalten nicht lesbar:', e.message); }
  _mon.cols[key] = set;
  return set;
}

/**
 * Konverter-Export in die Monitoring-Bibliothek AR_<Werk> schreiben:
 * lädt die Datei (ZUGFeRD-PDF bzw. XRechnung-XML) hoch und setzt die
 * Metadaten-Spalten direkt am Datei-Item (eine Zeile pro Rechnung).
 */
async function spSaveToMonitoring({ invoiceData, xml, pdfBytes, format }) {
  const token = await acquireToken(SP.scopes);
  if (!token) return null;
  await _monInit(token);

  // Werk am Firmennamen des Rechnungsstellers erkennen (WGC=Coswig/Walzen,
  // SHB=Boesdorf/Hartguss). Das Dropdown ist nur Fallback, falls der Name nicht
  // eindeutig ist.
  const werk    = (_detectGesellschaft(invoiceData.verkaeufer)
                    || invoiceData.gesellschaft || 'WGC').toUpperCase();
  const libName = `AR_${werk}`;                       // Konverter = Ausgangsrechnung
  const key     = libName.toUpperCase();
  const listId  = _mon.lists[key];
  const driveId = _mon.drives[key];
  if (!listId || !driveId) {
    throw new Error(`Monitoring-Bibliothek "${libName}" nicht gefunden. `
      + `Bitte provision-rechnungsmonitoring.ps1 mit -Werke ${werk} ausfuehren.`);
  }
  const available = await _monCols(token, listId, key);

  const safeNr  = _safe(invoiceData.rechnungsnummer);
  const dateStr = (invoiceData.rechnungsdatum || '').replace(/-/g, '');
  const isZ     = format === 'zugferd';
  const fileName = isZ ? `${safeNr}_${dateStr}.pdf` : `${safeNr}_${dateStr}.xml`;
  const bytes = isZ
    ? (pdfBytes instanceof Uint8Array ? pdfBytes : new Uint8Array(pdfBytes))
    : new TextEncoder().encode(String.fromCharCode(0xFEFF) + xml);   // BOM
  const ctype = isZ ? 'application/pdf' : 'text/xml';

  const up = await _monUpload(token, driveId, fileName, bytes, ctype);
  const fileUrl = up.webUrl || '';

  const nowIso = new Date().toISOString();
  const a = invoiceData.audit;

  // USt-IdNr-Bestätigung (aus /api/vat, falls im Tool geprüft) → Monitoring-Spalten.
  const u = invoiceData.ustPruefung;
  const ustStatus = !u ? 'Nicht geprueft'
    : (u.moeglich === false ? 'entfaellt (Inland)'
    : (u.gueltig ? (u.qualifiziert ? 'Qualifiziert bestaetigt' : 'Gueltig (einfach)') : 'Nicht gueltig'));
  const ustBericht = (u && u.bericht && u.bericht.zeilen)
    ? u.bericht.zeilen.map(z => z[0] + ': ' + z[1]).join('\n').slice(0, 2000) : '';

  const allFields = {
    Title:               (invoiceData.rechnungsnummer || '').slice(0, 255),
    Rechnungsart:        _RA_LABELS[String(invoiceData.rechnungsart || '380')] || String(invoiceData.rechnungsart || '380'),
    Rechnungsdatum:      invoiceData.rechnungsdatum || nowIso.slice(0, 10),
    Faelligkeitsdatum:   invoiceData.faelligkeitsdatum || '',
    Rechnungssteller:    (invoiceData.verkaeufer || '').slice(0, 255),
    Rechnungsempfaenger: (invoiceData.kaeufer || '').slice(0, 255),
    Waehrung:            (invoiceData.waehrung || 'EUR').slice(0, 10),
    Nettobetrag:         Number((invoiceData.netTotal   || 0).toFixed(2)),
    MwStBetrag:          Number((invoiceData.vatTotal   || 0).toFixed(2)),
    Bruttobetrag:        Number((invoiceData.grossTotal || 0).toFixed(2)),
    Kaeuferreferenz:     (invoiceData.leitwegid || '').slice(0, 255),
    Bestellnummer:       (invoiceData.bestellnummer || '').slice(0, 255),
    Lieferscheinnummer:  (invoiceData.lieferscheinnummer || '').slice(0, 255),
    Zahlungsreferenz:    (invoiceData.zahlungsreferenz || '').slice(0, 255),
    Richtung:            'Ausgang',
    Gesellschaft:        werk,
    Format:              isZ ? 'ZUGFeRD' : 'XRechnung',
    Verarbeitungsstatus: 'Konvertiert',
    Konformitaet:        'Ungeprueft',
    Eingangszeitpunkt:   nowIso,
    Konvertiertam:       nowIso,
    OriginalPdfName:     (invoiceData.originalPdfName || '').slice(0, 255),
    XMLDateiUrl:         isZ ? '' : fileUrl,
    ZUGFeRDPdfUrl:       isZ ? fileUrl : '',
    Pruefstatus:         _auditStatus(a),
    ManuelleAenderungen: a ? JSON.stringify(a.manuelleAenderungen || []).slice(0, 255) : '',
    QuellPdfHash:        a ? (a.quellPdfHash || '').slice(0, 255) : '',
    GeprueftVon:         a ? (a.geprueftVon || '').slice(0, 255) : '',
    StammdatenEntsperrt: a ? (a.stammdatenEntsperrt ? 'Ja' : 'Nein') : 'Nein',
    // USt-IdNr-Bestätigung
    UStIdStatus:         ustStatus,
    UStIdAnfrageId:      u ? (u.anfrageId || '').slice(0, 255) : '',
    UStIdPruefzeitpunkt: u ? (u.zeitpunkt || '') : '',
    UStIdBericht:        ustBericht,
  };

  // leere Werte weglassen + nur real vorhandene Spalten senden
  const fields = {};
  for (const [k, val] of Object.entries(allFields)) {
    if (val === '' || val == null) continue;
    if (!available.has(k)) continue;
    fields[k] = val;
  }

  await _patch(`${SP.graphBase}/drives/${driveId}/items/${up.id}/listItem/fields`, token, fields);
  return { webUrl: fileUrl, lib: libName };
}

async function _monUpload(token, driveId, name, bytes, contentType) {
  const url = `${SP.graphBase}/drives/${driveId}/root:/${encodeURIComponent(name)}:/content`;
  const resp = await fetch(url, {
    method: 'PUT',
    headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': contentType },
    body: bytes,
  });
  if (!resp.ok) { const m = await resp.text(); throw new Error(`Upload ${resp.status}: ${m.slice(0, 200)}`); }
  return resp.json();
}

async function _patch(url, token, body) {
  const resp = await fetch(url, {
    method: 'PATCH',
    headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!resp.ok) { const m = await resp.text(); throw new Error(`Graph PATCH (${resp.status}): ${m.slice(0, 300)}`); }
  return resp.json();
}

/* ═══════════════════════════════════════════════════
   Initialisierung & Spalten-Setup
═══════════════════════════════════════════════════ */

async function _spInit(token) {
  if (_sp.ready) return;

  // Site-ID ermitteln
  const site = await _get(`${SP.graphBase}/sites/${SP.siteHost}`, token);
  _sp.siteId = site.id;

  // Liste suchen
  const lists = await _get(
    `${SP.graphBase}/sites/${_sp.siteId}/lists?$filter=displayName eq '${SP.listName}'`,
    token
  );
  if (!lists.value?.length) {
    throw new Error(`SharePoint-Liste "${SP.listName}" nicht gefunden.\nBitte die Liste unter sites/IT anlegen.`);
  }
  _sp.listId = lists.value[0].id;

  // Dokument-Bibliothek für Datei-Uploads suchen
  const drives = await _get(`${SP.graphBase}/sites/${_sp.siteId}/drives`, token);
  const docDrive = drives.value?.find(d =>
    ['Dokumente', 'Documents', 'Freigegebene Dokumente', 'Shared Documents'].includes(d.name)
  ) || drives.value?.[0];
  if (docDrive) _sp.driveId = docDrive.id;

  // Vorhandene Spalten ermitteln — nur verfügbare Felder werden beim Schreiben gesendet.
  // Schlägt das Lesen fehl (z. B. 403), werden nur Title-Einträge gespeichert.
  try {
    const cols = await _get(
      `${SP.graphBase}/sites/${_sp.siteId}/lists/${_sp.listId}/columns`, token
    );
    (cols.value || []).forEach(c => _sp.availableFields.add(c.name));
  } catch (e) {
    console.warn('Spalten konnten nicht gelesen werden – nur "Title" wird geschrieben:', e.message);
  }

  _sp.ready = true;
}

/* ═══════════════════════════════════════════════════
   Datei-Upload
═══════════════════════════════════════════════════ */

async function _uploadFile(token, path, bytes, contentType) {
  if (!_sp.driveId) throw new Error('Keine Dokument-Bibliothek gefunden.');

  const url = `${SP.graphBase}/drives/${_sp.driveId}/root:/${path}:/content`;
  const resp = await fetch(url, {
    method: 'PUT',
    headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': contentType },
    body: bytes,
  });
  if (!resp.ok) {
    const msg = await resp.text();
    throw new Error(`Upload ${resp.status}: ${msg.slice(0, 200)}`);
  }
  return resp.json();
}

/* ═══════════════════════════════════════════════════
   Graph API Helpers
═══════════════════════════════════════════════════ */

async function _get(url, token) {
  const resp = await fetch(url, {
    headers: { 'Authorization': `Bearer ${token}`, 'Accept': 'application/json' },
  });
  if (!resp.ok) {
    const msg = await resp.text();
    throw new Error(`Graph GET (${resp.status}): ${msg.slice(0, 300)}`);
  }
  return resp.json();
}

async function _post(url, token, body) {
  const resp = await fetch(url, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!resp.ok) {
    const msg = await resp.text();
    throw new Error(`Graph POST (${resp.status}): ${msg.slice(0, 300)}`);
  }
  return resp.json();
}

async function _del(url, token) {
  const resp = await fetch(url, {
    method: 'DELETE',
    headers: { 'Authorization': `Bearer ${token}` },
  });
  if (!resp.ok && resp.status !== 204) {
    const msg = await resp.text();
    throw new Error(`Graph DELETE (${resp.status}): ${msg.slice(0, 200)}`);
  }
}

function _safe(s) {
  return String(s || 'rechnung').replace(/[^a-zA-Z0-9\-_]/g, '_').slice(0, 60);
}

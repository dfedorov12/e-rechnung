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
  };

  // Nur Felder senden, die in der Liste vorhanden sind (verhindert 400-Fehler bei fehlenden Spalten)
  const fields = Object.fromEntries(
    Object.entries(allFields).filter(([k]) => _sp.availableFields.has(k))
  );

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
      v.includes('hartguss') || v.includes(' shb'))  return 'SHB';
  if (v.includes('coswig')  || v.includes('walzen')  ||
      v.includes(' wgc'))                             return 'WGC';
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

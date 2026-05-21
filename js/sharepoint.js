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
const _sp = { siteId: null, listId: null, driveId: null, ready: false };

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

  const fields = {
    Title:               (invoiceData.rechnungsnummer || '').slice(0, 255),
    Rechnungsdatum:      invoiceData.rechnungsdatum || new Date().toISOString().slice(0, 10),
    Rechnungssteller:    (invoiceData.verkaeufer || '').slice(0, 255),
    Rechnungsempfaenger: (invoiceData.kaeufer || '').slice(0, 255),
    Nettobetrag:         Number((invoiceData.netTotal   || 0).toFixed(2)),
    MwStBetrag:          Number((invoiceData.vatTotal   || 0).toFixed(2)),
    Bruttobetrag:        Number((invoiceData.grossTotal || 0).toFixed(2)),
    Format:              format === 'zugferd' ? 'ZUGFeRD' : 'XRechnung',
    XMLDateiUrl:         xmlUrl,
    ZUGFeRDPdfUrl:       pdfUrl,
    OriginalPdfName:     (invoiceData.originalPdfName || '').slice(0, 255),
  };

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

  return (resp.value || []).map(item => ({
    id:             item.id,
    createdAt:      item.createdDateTime,
    rechnungsnummer: item.fields.Title               || '',
    rechnungsdatum:  item.fields.Rechnungsdatum      || '',
    verkaeufer:      item.fields.Rechnungssteller    || '',
    kaeufer:         item.fields.Rechnungsempfaenger || '',
    netTotal:        item.fields.Nettobetrag         || 0,
    vatTotal:        item.fields.MwStBetrag          || 0,
    grossTotal:      item.fields.Bruttobetrag        || 0,
    format:          item.fields.Format              || 'XRechnung',
    xmlUrl:          item.fields.XMLDateiUrl         || '',
    pdfUrl:          item.fields.ZUGFeRDPdfUrl       || '',
    originalPdf:     item.fields.OriginalPdfName     || '',
  }));
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

  // Pflicht-Spalten anlegen (falls noch nicht vorhanden)
  await _ensureColumns(token);

  _sp.ready = true;
}

async function _ensureColumns(token) {
  const existing = await _get(
    `${SP.graphBase}/sites/${_sp.siteId}/lists/${_sp.listId}/columns`, token
  );
  const have = new Set((existing.value || []).map(c => c.name));

  const cols = [
    { name: 'Rechnungsdatum',     dateTime: { displayAs: 'default', format: 'dateOnly' } },
    { name: 'Rechnungssteller',   text: {} },
    { name: 'Rechnungsempfaenger', text: {} },
    { name: 'Nettobetrag',        number: { decimalPlaces: 'two' } },
    { name: 'MwStBetrag',         number: { decimalPlaces: 'two' } },
    { name: 'Bruttobetrag',       number: { decimalPlaces: 'two' } },
    { name: 'Format',             choice: { choices: ['XRechnung', 'ZUGFeRD', 'Beide'], displayType: 'dropDown', allowTextEntry: false } },
    { name: 'XMLDateiUrl',        text: { maxLength: 1000 } },
    { name: 'ZUGFeRDPdfUrl',      text: { maxLength: 1000 } },
    { name: 'OriginalPdfName',    text: {} },
  ];

  for (const col of cols) {
    if (have.has(col.name)) continue;
    try {
      await _post(
        `${SP.graphBase}/sites/${_sp.siteId}/lists/${_sp.listId}/columns`,
        token, col
      );
    } catch (e) {
      console.warn(`Spalte "${col.name}" nicht angelegt:`, e.message);
    }
  }
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

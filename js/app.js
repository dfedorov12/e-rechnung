/* ── State ── */
let uploadedPdfBytes = null;
let uploadedFileName = '';
let currentPage = 1;
let totalPages = 1;
let pdfDocument = null;
let rowCounter = 0;
let zoomFactor = 1.0;
const ZOOM_STEPS = [0.5, 0.75, 1.0, 1.25, 1.5, 2.0, 2.5, 3.0];

/* ── PDF.js setup ── */
pdfjsLib.GlobalWorkerOptions.workerSrc = 'js/vendor/pdf.worker.min.js';

/* ── Init ── */
document.addEventListener('DOMContentLoaded', () => {
  setupUploadZone();
  setupPdfNav();
  addPositionRow();
  setupFormCalculations();
  setupDateDefaults();
  setupBuyerEmailToggle();
  setupRequiredFieldToggles();
  document.getElementById('btn-add-row').addEventListener('click', addPositionRow);
  document.getElementById('btn-export-xrechnung').addEventListener('click', () => exportInvoice('xrechnung'));
  document.getElementById('btn-export-zugferd').addEventListener('click', () => exportInvoice('zugferd'));
  document.getElementById('btn-mail').addEventListener('click', () => createInvoiceMail());

  // Runtime-Config laden, dann Selector + Admin-Nav initialisieren
  onAuthReady(async () => {
    await loadRuntimeAccessConfig();
    initAdminNav();
    setupGesellschaftSelector();
  });
});

/**
 * Gesellschaft-Dropdown dynamisch nach Zugriffskonfiguration befüllen.
 * Nur die Gesellschaften anzeigen, auf die der User Zugriff hat.
 */
function setupGesellschaftSelector() {
  const sel = document.getElementById('gesellschaft');
  if (!sel) return;
  const access = typeof getCurrentUserAccess === 'function' ? getCurrentUserAccess() : [];
  sel.innerHTML = '';
  if (access.length === 0) {
    // Fallback: beide anzeigen (z.B. wenn access.js nicht geladen)
    sel.innerHTML = '<option value="WGC">WGC</option><option value="SHB">SHB</option>';
    return;
  }
  access.forEach(g => {
    const opt = document.createElement('option');
    opt.value = g.toUpperCase();
    opt.textContent = (typeof GESELLSCHAFT_LABELS !== 'undefined' ? GESELLSCHAFT_LABELS[g] : null) || g.toUpperCase();
    sel.appendChild(opt);
  });
}

/* ── Pflichtfeld-Toggles für "mind. eines von zwei" ── */
function setupBuyerEmailToggle() {
  _mutualRequiredToggle('leitwegid', 'kaeufer-email-label', 'kaeufer-email', null);
}

function setupRequiredFieldToggles() {
  // BR-DE-2: Verkäufer Telefon ↔ E-Mail (mind. eines)
  _mutualRequiredToggle('verkaeufer-tel', 'verkaeufer-email-seller-label',
                        'verkaeufer-email', 'verkaeufer-tel-label');
  // USt-IdNr. ↔ Steuernummer (mind. eines)
  _mutualRequiredToggle('verkaeufer-vat', 'verkaeufer-steuernr-label',
                        'verkaeufer-steuernr', 'verkaeufer-vat-label');
}

/**
 * Wenn inputA einen Wert hat → * auf labelB ausblenden (und umgekehrt).
 * inputA / labelA = erstes Feld, inputB / labelB = zweites Feld.
 * labelA kann null sein (dann nur einseitig).
 */
function _mutualRequiredToggle(inputAId, labelBId, inputBId, labelAId) {
  const inputA  = document.getElementById(inputAId);
  const inputB  = document.getElementById(inputBId);
  const labelB  = document.getElementById(labelBId);
  const labelA  = labelAId ? document.getElementById(labelAId) : null;
  if (!inputA || !inputB) return;

  function update() {
    const aFilled = inputA.value.trim() !== '';
    const bFilled = inputB.value.trim() !== '';
    const markA = labelA ? labelA.querySelector('.required') : null;
    const markB = labelB ? labelB.querySelector('.required') : null;
    if (markB) markB.style.display = aFilled ? 'none' : '';
    if (markA) markA.style.display = bFilled ? 'none' : '';
  }

  inputA.addEventListener('input', update);
  inputB.addEventListener('input', update);
  update();
}

/* ── Upload Zone ── */
function setupUploadZone() {
  const zone = document.getElementById('upload-zone');
  const input = document.getElementById('pdf-input');
  const btnChange = document.getElementById('btn-change-file');

  zone.addEventListener('click', (e) => {
    if (e.target === btnChange) return;
    input.click();
  });

  btnChange.addEventListener('click', (e) => {
    e.stopPropagation();
    input.click();
  });

  input.addEventListener('change', () => {
    if (input.files[0]) handleFileUpload(input.files[0]);
  });

  zone.addEventListener('dragover', (e) => {
    e.preventDefault();
    zone.classList.add('drag-over');
  });

  zone.addEventListener('dragleave', () => zone.classList.remove('drag-over'));

  zone.addEventListener('drop', (e) => {
    e.preventDefault();
    zone.classList.remove('drag-over');
    const file = e.dataTransfer.files[0];
    if (file && file.type === 'application/pdf') {
      handleFileUpload(file);
    } else {
      showToast('Bitte eine PDF-Datei hochladen.', 'error');
    }
  });
}

async function handleFileUpload(file) {
  uploadedFileName = file.name;
  const reader = new FileReader();
  reader.onload = async (e) => {
    uploadedPdfBytes = new Uint8Array(e.target.result);
    updateUploadUI(file);
    // PDF.js transferiert den ArrayBuffer zum Worker (zero-copy) → Original würde genullt.
    // Deshalb eine Kopie übergeben, damit uploadedPdfBytes für pdf-lib intakt bleibt.
    await renderPDF(uploadedPdfBytes.slice(0));
    // Auto-fill form after PDF is loaded and pdfDocument is set
    await autoFillFromPDF();
  };
  reader.readAsArrayBuffer(file);
}

/* ── Auto-Fill ── */
async function autoFillFromPDF() {
  if (!pdfDocument) return;
  showLoading(true, 'Rechnungsdaten werden erkannt...');
  try {
    // 1) Text aus der PDF-Textebene sammeln
    let items   = await collectPdfItems(pdfDocument);
    const txtLen = items.reduce((n, it) => n + it.text.trim().length, 0);
    let viaOcr  = false;

    // 2) Kaum Text vorhanden → gescanntes PDF → OCR-Texterkennung
    if (txtLen < 40) {
      if (typeof ocrCollectItems !== 'function') {
        showLoading(false);
        showToast('Gescanntes PDF erkannt — Texterkennung nicht verfügbar. Bitte Felder manuell ausfüllen.', 'info');
        return;
      }
      showLoading(true, 'Gescanntes PDF — Texterkennung (OCR) läuft…');
      items = await ocrCollectItems(pdfDocument, prog => {
        const pct = prog.status === 'recognizing' ? ` ${Math.round(prog.progress * 100)} %` : '';
        showLoading(true, `Texterkennung (OCR) – Seite ${prog.page}/${prog.total}${pct}`);
      });
      viaOcr = true;
    }

    // 3) Aus den Items (PDF oder OCR) Rechnungsdaten extrahieren
    const data  = extractInvoiceDataFromItems(items);
    const count = fillFormFromExtracted(data);
    showLoading(false);
    if (count > 0) {
      showAutofillBanner(count);
      showToast(
        `${count} Felder automatisch erkannt${viaOcr ? ' (per OCR)' : ''}. Bitte prüfen und ergänzen.`,
        'success'
      );
    } else {
      showToast('Keine Daten automatisch erkannt — bitte manuell ausfüllen.', 'info');
    }
  } catch (err) {
    showLoading(false);
    console.error('Parser error:', err);
    showToast('Automatische Erkennung fehlgeschlagen: ' + err.message, 'error');
  }
}

function fillFormFromExtracted(data) {
  let count = 0;
  const map = {
    'verkaeufer':          data.verkaeufer,
    'verkaeufer-strasse':  data.verkaeufstrasse,
    'verkaeufer-plz':      data.verkaeufplz,
    'verkaeufer-stadt':    data.verkaeufstadt,
    'verkaeufer-land':     data.verkaeufland,
    'verkaeufer-vat':      data.verkaeufervat,
    'verkaeufer-steuernr': data.verkaeufersteuernr,
    'verkaeufer-kontakt':  data.verkaeufkontakt,
    'verkaeufer-tel':      data.verkaeuftel,
    'verkaeufer-email':    data.verkaeuferemail,
    'iban':                data.iban,
    'bic':                 data.bic,
    'kaeufer':             data.kaeufer,
    'kaeufer-strasse':     data.kaeuferstrasse,
    'kaeufer-plz':         data.kaeuferplz,
    'kaeufer-stadt':       data.kaeuferstadt,
    'kaeufer-land':        data.kaeuferland,
    'leitwegid':           data.leitwegid,
    'kaeufer-email':       data.kaeufermail,
    'rechnungsnummer':     data.rechnungsnummer,
    'rechnungsdatum':      data.rechnungsdatum,
    'lieferdatum':         data.lieferdatum,
    'faelligkeitsdatum':   data.faelligkeitsdatum,
    'zahlungsreferenz':    data.zahlungsreferenz || data.rechnungsnummer,
    'notiz':               data.notiz,
  };

  for (const [id, val] of Object.entries(map)) {
    if (val) {
      const el = document.getElementById(id);
      if (el) {
        el.value = val;
        el.classList.add('autofilled');
        el.addEventListener('input', () => el.classList.remove('autofilled'), { once: true });
        count++;
      }
    }
  }

  if (data.positionen && data.positionen.length > 0) {
    document.getElementById('positions-body').innerHTML = '';
    rowCounter = 0;
    data.positionen.forEach(p => addPositionRow(p));
    count += data.positionen.length;
    renumberRows();
  }

  updateTotals();
  return count;
}

function showAutofillBanner(count) {
  const banner = document.getElementById('autofill-banner');
  if (!banner) return;
  document.getElementById('autofill-count').textContent = count;
  banner.style.display = 'flex';
}

function updateUploadUI(file) {
  const zone = document.getElementById('upload-zone');
  zone.classList.add('has-file');
  document.getElementById('file-name-display').textContent = file.name;
  document.getElementById('file-size-display').textContent = formatFileSize(file.size);
}

function formatFileSize(bytes) {
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
  return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
}

/* ── PDF Viewer ── */
async function renderPDF(pdfBytes) {
  try {
    const loadingTask = pdfjsLib.getDocument({ data: pdfBytes });
    pdfDocument = await loadingTask.promise;
    totalPages = pdfDocument.numPages;
    currentPage = 1;
    zoomFactor = 1.0;   // Zoom bei neuer PDF zurücksetzen
    updatePageNav();
    await renderPage(currentPage);
  } catch (err) {
    showToast('PDF konnte nicht geladen werden: ' + err.message, 'error');
  }
}

async function renderPage(pageNum) {
  if (!pdfDocument) return;
  const page = await pdfDocument.getPage(pageNum);
  const wrapper = document.getElementById('pdf-canvas-wrapper');
  const canvas = document.getElementById('pdf-canvas');
  const ctx = canvas.getContext('2d');

  const dpr = Math.min(window.devicePixelRatio || 1, 3);
  const viewportRaw = page.getViewport({ scale: 1 });
  const maxWidth = wrapper.clientWidth - 32;

  // Fit-to-width × Zoom-Faktor × DPR
  const cssScale = (maxWidth / viewportRaw.width) * zoomFactor;
  const viewport = page.getViewport({ scale: cssScale * dpr });

  canvas.width  = viewport.width;
  canvas.height = viewport.height;
  canvas.style.width   = (viewport.width  / dpr) + 'px';
  canvas.style.height  = (viewport.height / dpr) + 'px';
  canvas.style.display = 'block';
  document.getElementById('pdf-placeholder').style.display = 'none';

  await page.render({ canvasContext: ctx, viewport }).promise;
  _updateZoomUI();
}

/* ── Zoom ── */
function _updateZoomUI() {
  const pct = Math.round(zoomFactor * 100);
  const el = document.getElementById('zoom-level');
  if (el) el.textContent = pct + '%';
  const btnOut = document.getElementById('btn-zoom-out');
  const btnIn  = document.getElementById('btn-zoom-in');
  const btnFit = document.getElementById('btn-zoom-fit');
  if (btnOut) btnOut.disabled = !pdfDocument || zoomFactor <= ZOOM_STEPS[0];
  if (btnIn)  btnIn.disabled  = !pdfDocument || zoomFactor >= ZOOM_STEPS[ZOOM_STEPS.length - 1];
  if (btnFit) btnFit.disabled = !pdfDocument;
}

function zoomIn() {
  if (!pdfDocument) return;
  const next = ZOOM_STEPS.find(z => z > zoomFactor + 0.01);
  if (next) { zoomFactor = next; renderPage(currentPage); }
}

function zoomOut() {
  if (!pdfDocument) return;
  const prev = [...ZOOM_STEPS].reverse().find(z => z < zoomFactor - 0.01);
  if (prev !== undefined) { zoomFactor = prev; renderPage(currentPage); }
}

function zoomReset() {
  if (!pdfDocument) return;
  zoomFactor = 1.0;
  renderPage(currentPage);
}

function setupPdfNav() {
  document.getElementById('btn-prev-page').addEventListener('click', async () => {
    if (currentPage > 1) { currentPage--; updatePageNav(); await renderPage(currentPage); }
  });
  document.getElementById('btn-next-page').addEventListener('click', async () => {
    if (currentPage < totalPages) { currentPage++; updatePageNav(); await renderPage(currentPage); }
  });

  // Zoom-Buttons
  document.getElementById('btn-zoom-in') .addEventListener('click', zoomIn);
  document.getElementById('btn-zoom-out').addEventListener('click', zoomOut);
  document.getElementById('btn-zoom-fit').addEventListener('click', zoomReset);

  // Ctrl+Scroll zum Zoomen im PDF-Panel
  document.getElementById('pdf-canvas-wrapper').addEventListener('wheel', e => {
    if (!e.ctrlKey && !e.metaKey) return;
    e.preventDefault();
    e.deltaY < 0 ? zoomIn() : zoomOut();
  }, { passive: false });

  // Tastenkürzel: Strg+Plus / Strg+Minus / Strg+0
  document.addEventListener('keydown', e => {
    if (!e.ctrlKey && !e.metaKey) return;
    if (e.key === '+' || e.key === '=' || e.key === 'Add') { e.preventDefault(); zoomIn(); }
    else if (e.key === '-' || e.key === '_' || e.key === 'Subtract') { e.preventDefault(); zoomOut(); }
    else if (e.key === '0') { e.preventDefault(); zoomReset(); }
  });
}

function updatePageNav() {
  document.getElementById('page-info').textContent = `Seite ${currentPage} / ${totalPages}`;
  document.getElementById('btn-prev-page').disabled = currentPage <= 1;
  document.getElementById('btn-next-page').disabled = currentPage >= totalPages;
}

/* ── Positions (Line Items) ── */
function addPositionRow(data = {}) {
  rowCounter++;
  const tbody = document.getElementById('positions-body');
  const tr = document.createElement('tr');
  tr.dataset.row = rowCounter;

  tr.innerHTML = `
    <td style="width:40px; text-align:center; color:var(--gray-400); font-size:12px;">${tbody.children.length + 1}</td>
    <td style="min-width:200px;"><input type="text" class="pos-beschreibung" placeholder="Leistungsbeschreibung" value="${escHTML(data.beschreibung || '')}"></td>
    <td style="width:80px;"><input type="number" class="pos-menge" placeholder="1" min="0" step="0.001" value="${data.menge || 1}"></td>
    <td style="width:90px;">
      <select class="pos-einheit">
        ${['Stk','h','Tag','Monat','m','m²','m³','kg','l','km','Pausch.'].map(u =>
          `<option value="${u}" ${u === (data.einheit || 'Stk') ? 'selected' : ''}>${u}</option>`
        ).join('')}
      </select>
    </td>
    <td style="width:110px;"><input type="number" class="pos-einzelpreis" placeholder="0,00" min="0" step="0.01" value="${data.einzelpreis || ''}"></td>
    <td style="width:90px;">
      <select class="pos-mwst">
        <option value="19" ${(data.mwst == 19 || !data.mwst) ? 'selected' : ''}>19 %</option>
        <option value="7" ${data.mwst == 7 ? 'selected' : ''}>7 %</option>
        <option value="0" ${data.mwst == 0 ? 'selected' : ''}>0 %</option>
      </select>
    </td>
    <td class="td-readonly" style="width:110px;" data-total>–</td>
    <td class="td-actions"><button class="btn-remove-row" title="Zeile entfernen">✕</button></td>`;

  tbody.appendChild(tr);

  tr.querySelector('.btn-remove-row').addEventListener('click', () => {
    if (tbody.children.length > 1) {
      tr.remove();
      renumberRows();
      updateTotals();
    } else {
      showToast('Mindestens eine Position erforderlich.', 'info');
    }
  });

  ['pos-menge', 'pos-einzelpreis', 'pos-mwst'].forEach(cls => {
    tr.querySelector('.' + cls).addEventListener('input', updateTotals);
    tr.querySelector('.' + cls).addEventListener('change', updateTotals);
  });

  updateTotals();
}

function renumberRows() {
  document.querySelectorAll('#positions-body tr').forEach((tr, i) => {
    tr.querySelector('td:first-child').textContent = i + 1;
  });
}

function collectPositionen() {
  return Array.from(document.querySelectorAll('#positions-body tr')).map(tr => ({
    beschreibung: tr.querySelector('.pos-beschreibung').value.trim(),
    menge: parseFloat(tr.querySelector('.pos-menge').value) || 0,
    einheit: tr.querySelector('.pos-einheit').value,
    einzelpreis: parseFloat(tr.querySelector('.pos-einzelpreis').value) || 0,
    mwst: parseFloat(tr.querySelector('.pos-mwst').value),
  }));
}

function updateTotals() {
  document.querySelectorAll('#positions-body tr').forEach(tr => {
    const menge = parseFloat(tr.querySelector('.pos-menge').value) || 0;
    const preis = parseFloat(tr.querySelector('.pos-einzelpreis').value) || 0;
    const net = menge * preis;
    const cell = tr.querySelector('[data-total]');
    cell.textContent = net > 0 ? formatDE(net) + ' €' : '–';
  });

  const positionen = collectPositionen();
  const { netTotal, vatTotal, grossTotal, vatGroups } = calcTotals(positionen);

  document.getElementById('total-netto').textContent = formatDE(netTotal) + ' €';

  const vatContainer = document.getElementById('total-vat-container');
  vatContainer.innerHTML = '';
  Object.values(vatGroups).sort((a, b) => b.rate - a.rate).forEach(g => {
    const row = document.createElement('div');
    row.className = 'totals-row';
    row.innerHTML = `<span>MwSt. ${g.rate.toFixed(0)} %</span><span class="amount">${formatDE(g.amount)} €</span>`;
    vatContainer.appendChild(row);
  });

  document.getElementById('total-brutto').textContent = formatDE(grossTotal) + ' €';
}

/* ── Form Setup ── */
function setupFormCalculations() {
  document.querySelectorAll('.pos-menge, .pos-einzelpreis, .pos-mwst').forEach(el => {
    el.addEventListener('input', updateTotals);
  });
}

function setupDateDefaults() {
  const today = new Date().toISOString().slice(0, 10);
  document.getElementById('rechnungsdatum').value = today;

  const due = new Date();
  due.setDate(due.getDate() + 30);
  document.getElementById('faelligkeitsdatum').value = due.toISOString().slice(0, 10);
}

/* ── Form Data Collection ── */
function collectFormData() {
  return {
    // Verkäufer
    verkaeufer:        v('verkaeufer'),
    verkaeufstrasse:   v('verkaeufer-strasse'),
    verkaeufplz:       v('verkaeufer-plz'),
    verkaeufstadt:     v('verkaeufer-stadt'),
    verkaeufland:      v('verkaeufer-land') || 'DE',
    verkaeufervat:     v('verkaeufer-vat'),
    verkaeufersteuernr: v('verkaeufer-steuernr'),
    verkaeufkontakt:   v('verkaeufer-kontakt'),
    verkaeuftel:       v('verkaeufer-tel'),
    verkaeuferemail:   v('verkaeufer-email'),
    iban:              v('iban'),
    bic:               v('bic'),
    // Käufer
    kaeufer:           v('kaeufer'),
    kaeuferstrasse:    v('kaeufer-strasse'),
    kaeuferplz:        v('kaeufer-plz'),
    kaeuferstadt:      v('kaeufer-stadt'),
    kaeuferland:       v('kaeufer-land') || 'DE',
    leitwegid:         v('leitwegid'),
    kaeufermail:       v('kaeufer-email'),
    // Rechnung
    rechnungsnummer:   v('rechnungsnummer'),
    rechnungsdatum:    v('rechnungsdatum'),
    lieferdatum:       v('lieferdatum'),
    faelligkeitsdatum: v('faelligkeitsdatum'),
    zahlungsreferenz:  v('zahlungsreferenz'),
    notiz:             v('notiz'),
    gesellschaft:      v('gesellschaft') || 'WGC',
    // Positionen
    positionen:        collectPositionen(),
  };
}

function v(id) {
  const el = document.getElementById(id);
  return el ? el.value.trim() : '';
}

/* ── Validation ── */
function validateForm(data) {
  const errors = [];

  // Rechnungssteller
  if (!data.verkaeufer)       errors.push('Rechnungssteller: Name');
  if (!data.verkaeufstrasse)  errors.push('Rechnungssteller: Straße & Hausnummer');
  if (!data.verkaeufplz)      errors.push('Rechnungssteller: PLZ');
  if (!data.verkaeufstadt)    errors.push('Rechnungssteller: Ort');
  if (!data.verkaeufervat && !data.verkaeufersteuernr)
    errors.push('Rechnungssteller: USt-IdNr. oder Steuernummer');
  // BR-DE-5: Ansprechpartner Pflicht
  if (!data.verkaeufkontakt)  errors.push('Rechnungssteller: Ansprechpartner');
  // BR-DE-2: mind. Telefon oder E-Mail
  if (!data.verkaeuftel && !data.verkaeuferemail)
    errors.push('Rechnungssteller: Telefon oder E-Mail (mind. eines)');

  // Rechnungsempfänger
  if (!data.kaeufer)          errors.push('Rechnungsempfänger: Name');
  if (!data.kaeuferstrasse)   errors.push('Rechnungsempfänger: Straße & Hausnummer');
  if (!data.kaeuferplz)       errors.push('Rechnungsempfänger: PLZ');
  if (!data.kaeuferstadt)     errors.push('Rechnungsempfänger: Ort');
  // PEPPOL-R010: BT-49 — Leitweg-ID oder E-Mail
  if (!data.leitwegid && !data.kaeufermail)
    errors.push('Rechnungsempfänger: Leitweg-ID oder E-Mail (elektronische Adresse)');

  // Rechnungsdaten
  if (!data.rechnungsnummer)  errors.push('Rechnungsnummer');
  if (!data.rechnungsdatum)   errors.push('Rechnungsdatum');

  // Positionen
  if (data.positionen.length === 0) errors.push('Mindestens eine Position');
  if (data.positionen.some(p => !p.beschreibung)) errors.push('Beschreibung für alle Positionen');

  return errors;
}

/* ── Export ── */
async function exportInvoice(format) {
  const data = collectFormData();
  const errors = validateForm(data);

  if (errors.length > 0) {
    showToast('Pflichtfelder fehlen: ' + errors.slice(0, 3).join(', ') + (errors.length > 3 ? ' ...' : ''), 'error');
    highlightErrors(data);
    return;
  }

  showLoading(true, format === 'zugferd' ? 'ZUGFeRD PDF wird erstellt...' : 'XRechnung XML wird erstellt...');

  try {
    const xml = buildXML(data, format);
    const { netTotal, vatTotal, grossTotal } = calcTotals(data.positionen);
    const safeNr = sanitizeFilename(data.rechnungsnummer);
    let pdfBytes = null;

    if (format === 'zugferd') {
      if (!uploadedPdfBytes) {
        showLoading(false);
        showToast('Für ZUGFeRD bitte zuerst eine PDF-Datei hochladen.', 'error');
        return;
      }
      pdfBytes = await embedXMLIntoPDF(uploadedPdfBytes, xml, 'zugferd');
      downloadBlob(pdfBytes, `${safeNr}_zugferd.pdf`, 'application/pdf');
    } else {
      downloadText(xml, `${safeNr}_xrechnung.xml`);
    }

    // Lokaler Cache (localStorage)
    saveToHistory({
      rechnungsnummer: data.rechnungsnummer,
      rechnungsdatum: data.rechnungsdatum,
      verkaeufer: data.verkaeufer,
      kaeufer: data.kaeufer,
      netTotal, vatTotal, grossTotal,
      formate: format === 'zugferd' ? ['ZUGFeRD'] : ['XRechnung'],
      xml,
      zugferdPdf: pdfBytes ? bytesToBase64(pdfBytes) : null,
      originalPdfName: uploadedFileName,
    });

    // SharePoint-Upload
    showLoading(true, 'Wird in SharePoint gespeichert...');
    try {
      await spSaveExport({
        invoiceData: { ...data, netTotal, vatTotal, grossTotal, originalPdfName: uploadedFileName },
        xml,
        pdfBytes,
        format,
      });
      showLoading(false);
      showToast(
        format === 'zugferd'
          ? `ZUGFeRD PDF exportiert & in SharePoint gespeichert. (${safeNr})`
          : `XRechnung XML exportiert & in SharePoint gespeichert. (${safeNr})`,
        'success'
      );
    } catch (spErr) {
      showLoading(false);
      console.warn('SharePoint save failed:', spErr);
      showToast(
        `Exportiert (lokal) · SharePoint-Fehler: ${spErr.message}`,
        'info'
      );
    }

  } catch (err) {
    showLoading(false);
    console.error(err);
    showToast('Fehler beim Erstellen: ' + err.message, 'error');
  }
}

/* ── Mail erstellen (.eml mit angehängter Rechnung) ── */
async function createInvoiceMail() {
  const data = collectFormData();
  const errors = validateForm(data);
  if (errors.length > 0) {
    showToast('Pflichtfelder fehlen: ' + errors.slice(0, 3).join(', ') + (errors.length > 3 ? ' ...' : ''), 'error');
    highlightErrors(data);
    return;
  }

  // Format: ZUGFeRD wenn ein PDF vorliegt (lesbar + eingebettetes XML), sonst XRechnung-XML
  const useZugferd = !!uploadedPdfBytes;
  showLoading(true, useZugferd ? 'ZUGFeRD wird erstellt …' : 'XRechnung wird erstellt …');

  try {
    const xml = buildXML(data, useZugferd ? 'zugferd' : 'xrechnung');
    const { grossTotal } = calcTotals(data.positionen);
    const safeNr = sanitizeFilename(data.rechnungsnummer);

    const attachments = [];
    if (useZugferd) {
      const pdfBytes = await embedXMLIntoPDF(uploadedPdfBytes, xml, 'zugferd');
      attachments.push({ filename: `${safeNr}_zugferd.pdf`, mime: 'application/pdf', base64: bytesToBase64(pdfBytes) });
    } else {
      attachments.push({ filename: `${safeNr}_xrechnung.xml`, mime: 'application/xml', base64: _utf8ToBase64('﻿' + xml) });
    }

    const eml = _buildInvoiceEml(data, grossTotal, useZugferd, attachments);
    downloadBlob(new TextEncoder().encode(eml), `${safeNr}_mail.eml`, 'message/rfc822');

    showLoading(false);
    const empf = data.kaeufermail || '(kein Empfänger hinterlegt — bitte in Outlook ergänzen)';
    showToast(`E-Mail-Vorlage erstellt → ${empf}. Die .eml-Datei öffnet sich in Outlook.`, 'success');
  } catch (err) {
    showLoading(false);
    console.error(err);
    showToast('Fehler beim Erstellen der Mail: ' + err.message, 'error');
  }
}

/**
 * Baut eine RFC822-.eml-Datei. "X-Unsent: 1" sorgt dafür, dass Outlook
 * die Datei als bearbeitbaren Entwurf (mit Anhang) öffnet statt als Eingang.
 */
function _buildInvoiceEml(data, grossTotal, useZugferd, attachments) {
  const datum  = data.rechnungsdatum ? new Date(data.rechnungsdatum).toLocaleDateString('de-DE') : '';
  const betrag = (grossTotal || 0).toLocaleString('de-DE', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const formatLabel = useZugferd ? 'ZUGFeRD (PDF mit eingebettetem XML)' : 'XRechnung (XML)';

  const subject = `Rechnung ${data.rechnungsnummer} – ${data.verkaeufer}`;
  const body =
`Sehr geehrte Damen und Herren,

anbei erhalten Sie unsere Rechnung ${data.rechnungsnummer}${datum ? ' vom ' + datum : ''} über ${betrag} €.

Die Rechnung liegt als ${formatLabel} gemäß EN 16931 bei.

Mit freundlichen Grüßen
${data.verkaeufkontakt || ''}
${data.verkaeufer}${data.verkaeuftel ? '\nTel.: ' + data.verkaeuftel : ''}${data.verkaeuferemail ? '\n' + data.verkaeuferemail : ''}`;

  const b    = 'BND_' + Date.now().toString(36);
  const wrap = s => s.replace(/.{1,76}/g, '$&\r\n').trimEnd();

  const lines = [];
  // Kein From: → Outlook nutzt das Standardkonto des Benutzers
  lines.push(`To: ${data.kaeufermail ? _emlAddr(data.kaeufer, data.kaeufermail) : ''}`);
  lines.push(`Subject: =?UTF-8?B?${_utf8ToBase64(subject)}?=`);
  lines.push('X-Unsent: 1');
  lines.push('MIME-Version: 1.0');
  lines.push(`Content-Type: multipart/mixed; boundary="${b}"`);
  lines.push('');
  // Textteil
  lines.push(`--${b}`);
  lines.push('Content-Type: text/plain; charset="utf-8"');
  lines.push('Content-Transfer-Encoding: base64');
  lines.push('');
  lines.push(wrap(_utf8ToBase64(body.replace(/\n/g, '\r\n'))));
  // Anhänge
  for (const att of attachments) {
    lines.push(`--${b}`);
    lines.push(`Content-Type: ${att.mime}; name="${att.filename}"`);
    lines.push('Content-Transfer-Encoding: base64');
    lines.push(`Content-Disposition: attachment; filename="${att.filename}"`);
    lines.push('');
    lines.push(wrap(att.base64));
  }
  lines.push(`--${b}--`);
  return lines.join('\r\n');
}

/** Adressfeld "Name <mail>" – Anzeigename bei Sonderzeichen RFC2047-kodiert. */
function _emlAddr(name, email) {
  if (!name) return email;
  const ascii = /^[\x20-\x7E]*$/.test(name);
  const disp  = ascii ? `"${name.replace(/"/g, '')}"` : `=?UTF-8?B?${_utf8ToBase64(name)}?=`;
  return `${disp} <${email}>`;
}

/** UTF-8-sicheres Base64 (für Umlaute in Betreff/Adressen/XML). */
function _utf8ToBase64(str) {
  return btoa(unescape(encodeURIComponent(str)));
}

function highlightErrors(data) {
  const fields = ['verkaeufer', 'verkaeufer-kontakt', 'kaeufer', 'rechnungsnummer', 'rechnungsdatum'];
  fields.forEach(id => {
    const el = document.getElementById(id);
    if (el && !el.value.trim()) {
      el.classList.add('error');
      el.addEventListener('input', () => el.classList.remove('error'), { once: true });
    }
  });
}

/* ── UI Helpers ── */
function showLoading(visible, msg = 'Verarbeitung...') {
  const overlay = document.getElementById('loading-overlay');
  const text = document.getElementById('loading-text');
  if (text) text.textContent = msg;
  overlay.style.display = visible ? 'flex' : 'none';
}

function showToast(message, type = 'info') {
  const container = document.getElementById('toast-container');
  const toast = document.createElement('div');
  toast.className = `toast ${type}`;
  const icons = { success: '✅', error: '❌', info: 'ℹ️' };
  toast.innerHTML = `<span class="toast-icon">${icons[type] || 'ℹ️'}</span><span>${message}</span>`;
  container.appendChild(toast);
  setTimeout(() => {
    toast.classList.add('fade-out');
    toast.addEventListener('animationend', () => toast.remove());
  }, 4000);
}

function formatDE(n) {
  return parseFloat(n || 0).toLocaleString('de-DE', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function escHTML(s) {
  return String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

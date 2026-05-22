/* ── State ── */
let uploadedPdfBytes = null;
let uploadedFileName = '';
let currentPage = 1;
let totalPages = 1;
let pdfDocument = null;
let rowCounter = 0;

/* ── PDF.js setup ── */
pdfjsLib.GlobalWorkerOptions.workerSrc = 'js/vendor/pdf.worker.min.js';

/* ── Init ── */
document.addEventListener('DOMContentLoaded', () => {
  setupUploadZone();
  setupPdfNav();
  addPositionRow();
  setupFormCalculations();
  setupDateDefaults();
  document.getElementById('btn-add-row').addEventListener('click', addPositionRow);
  document.getElementById('btn-export-xrechnung').addEventListener('click', () => exportInvoice('xrechnung'));
  document.getElementById('btn-export-zugferd').addEventListener('click', () => exportInvoice('zugferd'));
});

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
    const data  = await extractInvoiceData(pdfDocument);
    const count = fillFormFromExtracted(data);
    showLoading(false);
    if (count > 0) {
      showAutofillBanner(count);
      showToast(`${count} Felder automatisch erkannt. Bitte prüfen und ergänzen.`, 'success');
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

  const viewportRaw = page.getViewport({ scale: 1 });
  const maxWidth = wrapper.clientWidth - 32;
  const scale = Math.min(1.5, maxWidth / viewportRaw.width);
  const viewport = page.getViewport({ scale });

  canvas.width = viewport.width;
  canvas.height = viewport.height;
  canvas.style.display = 'block';
  document.getElementById('pdf-placeholder').style.display = 'none';

  await page.render({ canvasContext: ctx, viewport }).promise;
}

function setupPdfNav() {
  document.getElementById('btn-prev-page').addEventListener('click', async () => {
    if (currentPage > 1) { currentPage--; updatePageNav(); await renderPage(currentPage); }
  });
  document.getElementById('btn-next-page').addEventListener('click', async () => {
    if (currentPage < totalPages) { currentPage++; updatePageNav(); await renderPage(currentPage); }
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
    // Rechnung
    rechnungsnummer:   v('rechnungsnummer'),
    rechnungsdatum:    v('rechnungsdatum'),
    lieferdatum:       v('lieferdatum'),
    faelligkeitsdatum: v('faelligkeitsdatum'),
    zahlungsreferenz:  v('zahlungsreferenz'),
    notiz:             v('notiz'),
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
  if (!data.verkaeufer) errors.push('Rechnungssteller Name');
  if (!data.kaeufer) errors.push('Rechnungsempfänger Name');
  if (!data.rechnungsnummer) errors.push('Rechnungsnummer');
  if (!data.rechnungsdatum) errors.push('Rechnungsdatum');
  if (data.positionen.length === 0) errors.push('Mindestens eine Position');
  if (data.positionen.some(p => !p.beschreibung)) errors.push('Beschreibung für alle Positionen');

  if (!data.verkaeufervat && !data.verkaeufersteuernr) {
    errors.push('USt-IdNr. oder Steuernummer des Rechnungsstellers');
  }
  // XRechnung BR-DE-2: SELLER CONTACT (BG-6) ist Pflicht
  if (!data.verkaeufkontakt && !data.verkaeuftel && !data.verkaeuferemail) {
    errors.push('Kontaktdaten des Rechnungsstellers (Telefon oder E-Mail)');
  }

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

function highlightErrors(data) {
  const fields = ['verkaeufer', 'kaeufer', 'rechnungsnummer', 'rechnungsdatum'];
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

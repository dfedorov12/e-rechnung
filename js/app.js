/* ── State ── */
let uploadedPdfBytes = null;
let uploadedFileName = '';
let currentPage = 1;
let totalPages = 1;
let pdfDocument = null;
let rowCounter = 0;
let zoomFactor = 1.0;
const ZOOM_STEPS = [0.5, 0.75, 1.0, 1.25, 1.5, 2.0, 2.5, 3.0];

/* ── Prüf-/Audit-Zustand (Risikominimierung) ── */
let _extractedSnapshot = null;   // ursprünglich extrahierte Daten (für Manuell-Änderungs-Diff)
let _sourcePdfText     = '';     // Textebene des Quell-PDF (für PDF↔XML-Abgleich)
let _sourceViaOcr      = false;  // Quelle war OCR (kein echter Textlayer)
let _sellerLocked      = false;  // Verkäufer-Stammdaten gesperrt?
let _sellerUnlocked    = false;  // wurde in dieser Sitzung entsperrt? (Audit)
const _SELLER_MASTER_IDS = [
  'verkaeufer', 'iban', 'bic', 'verkaeufer-vat', 'verkaeufer-steuernr',
  'verkaeufer-handelsregister', 'verkaeufer-registernr', 'verkaeufer-gf',
];

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
  const lockBtn = document.getElementById('btn-seller-lock');
  if (lockBtn) lockBtn.addEventListener('click', toggleSellerLock);

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

    // Prüf-/Audit-Grundlage sichern: Ausgangsstand + Quelltext für spätere Kontrollen
    _extractedSnapshot = JSON.parse(JSON.stringify(data));
    _sourcePdfText     = items.map(it => (it && it.text) ? it.text : '').join(' ');
    _sourceViaOcr      = viaOcr;

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
    'verkaeufer-handelsregister': data.handelsregister,
    'verkaeufer-registernr':      data.registernr,
    'verkaeufer-gf':              data.geschaeftsfuehrung,
    'kaeufer':             data.kaeufer,
    'kaeufer-strasse':     data.kaeuferstrasse,
    'kaeufer-plz':         data.kaeuferplz,
    'kaeufer-stadt':       data.kaeuferstadt,
    'kaeufer-land':        data.kaeuferland,
    'leitwegid':           data.leitwegid,
    'kaeufer-email':       data.kaeufermail,
    'kaeufer-vat':         data.kaeufervat,
    'liefer-name':         data.lieferName,
    'liefer-strasse':      data.lieferStrasse,
    'liefer-plz':          data.lieferPlz,
    'liefer-stadt':        data.lieferStadt,
    'liefer-land':         data.lieferLand,
    'steuerkategorie':     data.steuerkategorie,
    'befreiungsgrund':     data.befreiungsgrund,
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
  lockSellerMaster();   // #1: Verkäufer-Stammdaten gegen versehentliche/böswillige Änderung sperren
  return count;
}

/* ── #1: Verkäufer-Stammdaten sperren/entsperren ──
 * Aus Stammdaten befüllte Verkäufer-Kernfelder (Name, IBAN, USt-IdNr.,
 * Register …) werden schreibgeschützt. Das verhindert genau das Szenario
 * „falsche IBAN einsetzen". Bewusstes Entsperren wird protokolliert (#7). */
function lockSellerMaster() {
  let anyLocked = false;
  _SELLER_MASTER_IDS.forEach(id => {
    const el = document.getElementById(id);
    if (el && el.value.trim() !== '') {
      el.readOnly = true;
      el.classList.add('locked');
      el.title = 'Stammdaten – gegen versehentliche Änderung gesperrt. Über „Stammdaten gesperrt" entsperren.';
      anyLocked = true;
    }
  });
  _sellerLocked = anyLocked;
  const btn = document.getElementById('btn-seller-lock');
  if (btn) {
    btn.style.display = anyLocked ? '' : 'none';
    btn.textContent = '🔒 Stammdaten gesperrt';
    btn.classList.remove('unlocked');
  }
}

function toggleSellerLock() {
  const btn = document.getElementById('btn-seller-lock');
  if (_sellerLocked) {
    const ok = window.confirm(
      'Verkäufer-Stammdaten (u. a. IBAN, USt-IdNr.) entsperren?\n\n' +
      'Manuelle Änderungen an diesen Feldern werden im Prüfpfad protokolliert.'
    );
    if (!ok) return;
    _SELLER_MASTER_IDS.forEach(id => {
      const el = document.getElementById(id);
      if (el) { el.readOnly = false; el.classList.remove('locked'); el.title = ''; }
    });
    _sellerLocked = false;
    _sellerUnlocked = true;
    if (btn) { btn.textContent = '🔓 entsperrt (wird protokolliert)'; btn.classList.add('unlocked'); }
  } else {
    lockSellerMaster();
  }
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
    <td style="width:68px;"><input type="text" class="pos-nr" placeholder="${tbody.children.length + 1}" value="${escHTML(data.posnr || '')}" title="Positionsnummer (z. B. 1, 1.1, 1.2.1)"></td>
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
    <td style="width:80px;"><input type="number" class="pos-rabatt" placeholder="0" step="0.01" value="${data.rabatt || ''}" title="Positiv = Rabatt, negativ = Zuschlag"></td>
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

  ['pos-menge', 'pos-einzelpreis', 'pos-rabatt', 'pos-mwst'].forEach(cls => {
    tr.querySelector('.' + cls).addEventListener('input', updateTotals);
    tr.querySelector('.' + cls).addEventListener('change', updateTotals);
  });

  updateTotals();
}

function renumberRows() {
  // Nur den Platzhalter (fortlaufende Nr.) aktualisieren — den erkannten
  // Positionsnummern-Wert nicht überschreiben.
  document.querySelectorAll('#positions-body tr').forEach((tr, i) => {
    const nr = tr.querySelector('.pos-nr');
    if (nr) nr.placeholder = i + 1;
  });
}

function collectPositionen() {
  return Array.from(document.querySelectorAll('#positions-body tr')).map((tr, i) => ({
    posnr: tr.querySelector('.pos-nr').value.trim() || String(i + 1),
    beschreibung: tr.querySelector('.pos-beschreibung').value.trim(),
    menge: parseFloat(tr.querySelector('.pos-menge').value) || 0,
    einheit: tr.querySelector('.pos-einheit').value,
    einzelpreis: parseFloat(tr.querySelector('.pos-einzelpreis').value) || 0,
    rabatt: parseFloat(tr.querySelector('.pos-rabatt').value) || 0,
    mwst: parseFloat(tr.querySelector('.pos-mwst').value),
  }));
}

function updateTotals() {
  document.querySelectorAll('#positions-body tr').forEach(tr => {
    const menge  = parseFloat(tr.querySelector('.pos-menge').value) || 0;
    const preis  = parseFloat(tr.querySelector('.pos-einzelpreis').value) || 0;
    const rabatt = parseFloat(tr.querySelector('.pos-rabatt').value) || 0;
    const net = menge * preis * (1 - rabatt / 100);
    const cell = tr.querySelector('[data-total]');
    cell.textContent = net !== 0 ? formatDE(net) + ' €' : '–';
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
  document.querySelectorAll('.pos-menge, .pos-einzelpreis, .pos-rabatt, .pos-mwst').forEach(el => {
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
    // Registerangaben (BT-30 / BT-33)
    handelsregister:   v('verkaeufer-handelsregister'),
    registernr:        v('verkaeufer-registernr'),
    geschaeftsfuehrung: v('verkaeufer-gf'),
    // Käufer
    kaeufer:           v('kaeufer'),
    kaeuferstrasse:    v('kaeufer-strasse'),
    kaeuferplz:        v('kaeufer-plz'),
    kaeuferstadt:      v('kaeufer-stadt'),
    kaeuferland:       v('kaeufer-land') || 'DE',
    leitwegid:         v('leitwegid'),
    kaeufermail:       v('kaeufer-email'),
    kaeufervat:        v('kaeufer-vat'),
    // Lieferanschrift (optional, BG-13)
    lieferName:        v('liefer-name'),
    lieferStrasse:     v('liefer-strasse'),
    lieferPlz:         v('liefer-plz'),
    lieferStadt:       v('liefer-stadt'),
    lieferLand:        v('liefer-land'),
    // Rechnung
    rechnungsnummer:   v('rechnungsnummer'),
    rechnungsdatum:    v('rechnungsdatum'),
    lieferdatum:       v('lieferdatum'),
    faelligkeitsdatum: v('faelligkeitsdatum'),
    zahlungsreferenz:  v('zahlungsreferenz'),
    notiz:             v('notiz'),
    gesellschaft:      v('gesellschaft') || 'WGC',
    // Steuerbefreiung (bei 0%-Positionen): UNTDID 5305 + BT-120
    steuerkategorie:   v('steuerkategorie') || 'Z',
    befreiungsgrund:   v('befreiungsgrund'),
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

  // Innergemeinschaftliche Lieferung (K): EN-16931-Pflichten BR-IC-2/3/11
  const hasZeroRate = data.positionen.some(p => parseFloat(p.mwst) === 0);
  if (hasZeroRate && data.steuerkategorie === 'K') {
    if (!data.verkaeufervat) errors.push('USt-IdNr. Rechnungssteller (Pflicht bei innergemeinschaftl. Lieferung)');
    if (!data.kaeufervat)    errors.push('USt-IdNr. Empfänger (Pflicht bei innergemeinschaftl. Lieferung)');
    if (!data.lieferdatum)   errors.push('Lieferdatum (Pflicht bei innergemeinschaftl. Lieferung)');
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

  // #2/#3/#4: Plausibilitäts- und PDF↔XML-Prüfung vor dem Erstellen
  const totals = calcTotals(data.positionen);
  if (!_preflightChecks(data, totals)) return;

  showLoading(true, format === 'zugferd' ? 'ZUGFeRD PDF wird erstellt...' : 'XRechnung XML wird erstellt...');

  try {
    const { netTotal, vatTotal, grossTotal } = totals;
    const xml = buildXML(data, format);

    // #5: Selbstverifikation — erzeugtes XML zurücklesen und gegen Anzeige prüfen
    const rt = _verifyEmbeddedXml(xml, data, totals);
    if (rt.length) {
      showLoading(false);
      showToast('Selbstprüfung fehlgeschlagen — XML weicht von den angezeigten Werten ab: ' + rt.join(', '), 'error');
      return;
    }

    const safeNr = sanitizeFilename(data.rechnungsnummer);
    let pdfBytes = null;

    if (format === 'zugferd') {
      try {
        pdfBytes = await _buildZugferdPdf(data, totals, xml);   // #6: Original einbetten ODER aus Daten rendern
      } catch (e) {
        showLoading(false);
        showToast(e.message === 'NO_PDF'
          ? 'Für ZUGFeRD bitte zuerst eine PDF-Datei hochladen — oder „PDF aus Rechnungsdaten erzeugen" aktivieren.'
          : 'ZUGFeRD-Erstellung fehlgeschlagen: ' + e.message, 'error');
        return;
      }
      downloadBlob(pdfBytes, `${safeNr}_zugferd.pdf`, 'application/pdf');
    } else {
      downloadText(xml, `${safeNr}_xrechnung.xml`);
    }

    // #7: Prüfpfad (Hash, manuelle Änderungen, Prüfer)
    const audit = await _buildAudit(data);

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
      audit,
    });

    // SharePoint-Upload
    showLoading(true, 'Wird in SharePoint gespeichert...');
    try {
      await spSaveExport({
        invoiceData: { ...data, netTotal, vatTotal, grossTotal, originalPdfName: uploadedFileName, audit },
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

/* ── Mail erstellen ── */
async function createInvoiceMail() {
  const data = collectFormData();
  const errors = validateForm(data);
  if (errors.length > 0) {
    showToast('Pflichtfelder fehlen: ' + errors.slice(0, 3).join(', ') + (errors.length > 3 ? ' ...' : ''), 'error');
    highlightErrors(data);
    return;
  }

  // Mail-Token möglichst früh holen (frische Nutzer-Geste fürs Consent-Popup).
  // Schlägt fehl, wenn Mail.ReadWrite nicht freigegeben → später .eml-Fallback.
  let mailToken = null;
  try {
    mailToken = await acquireTokenPopupSafe(['https://graph.microsoft.com/Mail.ReadWrite']);
  } catch (e) {
    console.warn('Mail.ReadWrite nicht verfügbar — .eml-Fallback:', e);
  }

  // Format: ZUGFeRD wenn ein PDF vorliegt ODER aus Daten gerendert wird (#6), sonst XRechnung-XML
  const renderFromData = !!(document.getElementById('opt-render-pdf') || {}).checked;
  const useZugferd = !!uploadedPdfBytes || renderFromData;

  // #2/#3/#4: gleiche Prüfungen wie beim Export
  const totals = calcTotals(data.positionen);
  if (!_preflightChecks(data, totals)) return;

  showLoading(true, useZugferd ? 'ZUGFeRD wird erstellt …' : 'XRechnung wird erstellt …');

  try {
    const xml = buildXML(data, useZugferd ? 'zugferd' : 'xrechnung');

    // #5: Selbstverifikation
    const rt = _verifyEmbeddedXml(xml, data, totals);
    if (rt.length) {
      showLoading(false);
      showToast('Selbstprüfung fehlgeschlagen — XML weicht von den angezeigten Werten ab: ' + rt.join(', '), 'error');
      return;
    }

    const { grossTotal } = totals;
    const safeNr = sanitizeFilename(data.rechnungsnummer);

    const attachments = [];
    if (useZugferd) {
      const pdfBytes = await _buildZugferdPdf(data, totals, xml);   // #6
      attachments.push({ filename: `${safeNr}_zugferd.pdf`, mime: 'application/pdf', base64: bytesToBase64(pdfBytes) });
    } else {
      attachments.push({ filename: `${safeNr}_xrechnung.xml`, mime: 'application/xml', base64: _utf8ToBase64('﻿' + xml) });
    }

    const { subject, body } = _mailSubjectBody(data, grossTotal, useZugferd);

    // 1) Direkt in Outlook als Entwurf anlegen (Microsoft Graph, kein Download)
    if (mailToken) {
      showLoading(true, 'Entwurf wird in Outlook erstellt …');
      try {
        const draft = await _createOutlookDraft(mailToken, data, subject, body, attachments);
        showLoading(false);
        if (draft.webLink) window.open(draft.webLink, '_blank', 'noopener');
        showToast(
          `E-Mail-Entwurf in Outlook erstellt (Ordner „Entwürfe").` +
          (data.kaeufermail ? '' : ' Bitte Empfänger ergänzen.'),
          'success'
        );
        return;
      } catch (gErr) {
        console.warn('Outlook-Direktanlage fehlgeschlagen — .eml-Fallback:', gErr);
        // weiter zum .eml-Fallback
      }
    }

    // 2) Fallback: .eml-Datei (öffnet sich per Doppelklick in Outlook)
    const eml = _buildInvoiceEml(data, subject, body, attachments);
    downloadBlob(new TextEncoder().encode(eml), `${safeNr}_mail.eml`, 'message/rfc822');
    showLoading(false);
    showToast(
      mailToken
        ? 'Outlook-Direktanlage nicht möglich — .eml-Datei erstellt (per Doppelklick in Outlook öffnen).'
        : 'E-Mail-Vorlage als .eml erstellt — per Doppelklick in Outlook öffnen (Anhang inklusive).',
      'info'
    );
  } catch (err) {
    showLoading(false);
    console.error(err);
    showToast('Fehler beim Erstellen der Mail: ' + err.message, 'error');
  }
}

/** Erstellt einen Outlook-Entwurf mit Anhang direkt im Postfach (Graph). */
async function _createOutlookDraft(token, data, subject, body, attachments) {
  const message = {
    subject,
    body: { contentType: 'Text', content: body },
    toRecipients: data.kaeufermail
      ? [{ emailAddress: { address: data.kaeufermail, name: data.kaeufer || undefined } }]
      : [],
    attachments: attachments.map(a => ({
      '@odata.type': '#microsoft.graph.fileAttachment',
      name:         a.filename,
      contentType:  a.mime,
      contentBytes: a.base64,
    })),
  };
  const resp = await fetch('https://graph.microsoft.com/v1.0/me/messages', {
    method:  'POST',
    headers: { 'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json' },
    body:    JSON.stringify(message),
  });
  if (!resp.ok) {
    const msg = await resp.text();
    throw new Error(`Graph ${resp.status}: ${msg.slice(0, 200)}`);
  }
  return resp.json();
}

/** Betreff + Textvorlage für die Rechnungsmail. */
function _mailSubjectBody(data, grossTotal, useZugferd) {
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

  return { subject, body };
}

/**
 * Baut eine RFC822-.eml-Datei. "X-Unsent: 1" sorgt dafür, dass Outlook
 * die Datei als bearbeitbaren Entwurf (mit Anhang) öffnet statt als Eingang.
 */
function _buildInvoiceEml(data, subject, body, attachments) {
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

/* ══════════════════════════════════════════════════════════════════════
   Risikominimierung: Prüfungen, Selbstverifikation, Render-Modus, Audit
══════════════════════════════════════════════════════════════════════ */

/**
 * #2/#3/#4: Vor-Export-Prüfungen.
 * Harte Fehler (ungültige IBAN, unplausible Summe) blocken den Export.
 * Weiche Warnungen (USt-IdNr.-Format, Wert nicht im Quell-PDF) fragen per
 * Bestätigungsdialog nach. Gibt true zurück, wenn fortgefahren werden darf.
 */
function _preflightChecks(data, totals) {
  const hard = [];
  if (data.iban && typeof ibanChecksumValid === 'function' && !ibanChecksumValid(data.iban)) {
    hard.push('IBAN ungültig (Prüfziffer stimmt nicht): ' + data.iban);
  }
  if (!Number.isFinite(totals.grossTotal) || totals.grossTotal <= 0) {
    hard.push('Gesamtbetrag nicht plausibel (0 € oder nicht berechenbar)');
  }
  // Interne Summenkonsistenz (Netto + MwSt = Brutto)
  if (Math.abs((totals.netTotal + totals.vatTotal) - totals.grossTotal) > 0.02) {
    hard.push('Summen inkonsistent (Netto + MwSt ≠ Brutto)');
  }
  if (hard.length) {
    showToast('Prüfung fehlgeschlagen: ' + hard.join(' · '), 'error');
    return false;
  }

  const soft = [];
  if (typeof vatIdLooksValid === 'function') {
    if (data.verkaeufervat && !vatIdLooksValid(data.verkaeufervat))
      soft.push('USt-IdNr. Rechnungssteller: Format ungewöhnlich (' + data.verkaeufervat + ')');
    if (data.kaeufervat && !vatIdLooksValid(data.kaeufervat))
      soft.push('USt-IdNr. Empfänger: Format ungewöhnlich (' + data.kaeufervat + ')');
  }
  if (typeof crossCheckSource === 'function') {
    const missing = crossCheckSource(data, totals, _sourcePdfText, _extractedSnapshot);
    if (missing && missing.length) {
      soft.push('Nicht im hochgeladenen PDF gefunden: ' + missing.join('; ')
        + (_sourceViaOcr ? ' (Quelle war OCR – Textlage evtl. ungenau)' : ''));
    }
  }
  if (soft.length) {
    const proceed = window.confirm(
      '⚠ Warnungen der Rechnungsprüfung:\n\n• ' + soft.join('\n• ') +
      '\n\nDas kann auf abweichende PDF/XML-Daten hindeuten.\nTrotzdem fortfahren und exportieren?'
    );
    if (!proceed) return false;
  }
  return true;
}

/**
 * #5: Selbstverifikation. Liest das erzeugte XML zurück und vergleicht die
 * Schlüsselwerte mit den angezeigten Formulardaten ("was drin ist = was du
 * gesehen hast"). Gibt Liste der Abweichungen zurück (leer = ok).
 */
function _verifyEmbeddedXml(xml, data, totals) {
  if (typeof parseInvoiceXML !== 'function') return [];   // xmlinvoice.js nicht geladen → überspringen
  let back;
  try { back = parseInvoiceXML(xml); }
  catch (e) { return ['XML nicht lesbar (' + e.message + ')']; }
  const norm = s => String(s == null ? '' : s).toLowerCase().replace(/[^a-z0-9]/g, '');
  const diffs = [];
  if (data.rechnungsnummer && norm(back.rechnungsnummer) !== norm(data.rechnungsnummer)) diffs.push('Rechnungsnummer');
  if (data.iban && norm(back.iban) !== norm(data.iban)) diffs.push('IBAN');
  if (data.kaeufervat && norm(back.kaeufervat) !== norm(data.kaeufervat)) diffs.push('USt-IdNr. Empfänger');
  if (totals && Math.abs((back.grossTotal || 0) - (totals.grossTotal || 0)) > 0.01) diffs.push('Gesamtbetrag');
  return diffs;
}

/**
 * #6: ZUGFeRD-PDF bauen. Standard = Original-PDF + XML einbetten.
 * Bei aktiver Option „PDF aus Rechnungsdaten erzeugen" wird das PDF aus
 * denselben Daten wie das XML gerendert → PDF ≡ XML per Konstruktion.
 */
async function _buildZugferdPdf(data, totals, xml) {
  const renderFromData = !!(document.getElementById('opt-render-pdf') || {}).checked;
  let basePdf;
  if (renderFromData) {
    if (typeof buildInvoicePdf !== 'function') throw new Error('PDF-Renderer nicht geladen (xml2pdf.js).');
    const pdfData = {
      ...data,
      netTotal: totals.netTotal, vatTotal: totals.vatTotal, grossTotal: totals.grossTotal,
      positionen: (data.positionen || []).map(p => ({
        ...p,
        gesamt: (parseFloat(p.menge) || 0) * (parseFloat(p.einzelpreis) || 0) * (1 - (parseFloat(p.rabatt) || 0) / 100),
      })),
    };
    basePdf = await buildInvoicePdf(pdfData);
  } else {
    if (!uploadedPdfBytes) throw new Error('NO_PDF');
    basePdf = uploadedPdfBytes;
  }
  return await embedXMLIntoPDF(basePdf, xml, 'zugferd');
}

/** #7: SHA-256 des Quell-PDF (Hex) für den Prüfpfad. */
async function _sha256Hex(bytes) {
  if (!bytes || !(crypto && crypto.subtle)) return '';
  const buf = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('');
}

/** #7: Diff kritischer Felder zwischen extrahiertem Stand und finalem Formular. */
function _manualChanges(data) {
  const snap = _extractedSnapshot;
  if (!snap) return [];
  const fields = [
    ['iban', 'IBAN'], ['bic', 'BIC'], ['verkaeufer', 'Rechnungssteller'],
    ['verkaeufervat', 'USt-IdNr. Steller'], ['verkaeufersteuernr', 'Steuernummer'],
    ['registernr', 'Registernr.'], ['kaeufer', 'Empfänger'],
    ['kaeufervat', 'USt-IdNr. Empfänger'], ['rechnungsnummer', 'Rechnungsnummer'],
  ];
  const out = [];
  for (const [k, label] of fields) {
    const a = String(snap[k] || '').trim();
    const b = String(data[k] || '').trim();
    if (a !== b && (a || b)) out.push({ feld: label, von: a, zu: b });
  }
  return out;
}

/** #7: Prüfpfad-Objekt zusammenstellen (Hash, manuelle Änderungen, Prüfer). */
async function _buildAudit(data) {
  let hash = '';
  try { if (uploadedPdfBytes) hash = await _sha256Hex(uploadedPdfBytes); } catch (e) { /* egal */ }
  const user = (typeof getAuthUser === 'function' && getAuthUser()) ? getAuthUser() : null;
  const changes = _manualChanges(data);
  return {
    quellPdfName:        uploadedFileName || '',
    quellPdfHash:        hash,
    quellViaOcr:         !!_sourceViaOcr,
    stammdatenEntsperrt: !!_sellerUnlocked,
    manuelleAenderungen: changes,
    geprueftVon:         user ? (user.username || user.name || '') : '',
    geprueftAm:          new Date().toISOString(),
  };
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

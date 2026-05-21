const HISTORY_KEY = 'erechnung_verlauf';
const MAX_ENTRIES = 100;

function saveToHistory(entry) {
  const history = getHistory();
  const newEntry = {
    id: Date.now(),
    savedAt: new Date().toISOString(),
    ...entry,
  };
  history.unshift(newEntry);
  if (history.length > MAX_ENTRIES) history.pop();
  try {
    localStorage.setItem(HISTORY_KEY, JSON.stringify(history));
  } catch (e) {
    console.warn('Verlauf konnte nicht gespeichert werden:', e);
  }
  return newEntry;
}

function getHistory() {
  try {
    return JSON.parse(localStorage.getItem(HISTORY_KEY) || '[]');
  } catch {
    return [];
  }
}

function deleteFromHistory(id) {
  const history = getHistory().filter(e => e.id !== id);
  localStorage.setItem(HISTORY_KEY, JSON.stringify(history));
}

function clearHistory() {
  localStorage.removeItem(HISTORY_KEY);
}

function getHistoryEntry(id) {
  return getHistory().find(e => e.id === id) || null;
}

function renderVerlauf() {
  const history = getHistory();
  const container = document.getElementById('verlauf-container');
  if (!container) return;

  if (history.length === 0) {
    container.innerHTML = `
      <div class="verlauf-empty">
        <span class="ve-icon">📂</span>
        <h3>Noch kein Verlauf</h3>
        <p>Exportierte Rechnungen erscheinen hier automatisch.</p>
      </div>`;
    document.getElementById('btn-clear-all').style.display = 'none';
    return;
  }

  document.getElementById('btn-clear-all').style.display = 'flex';

  container.innerHTML = `
    <div class="verlauf-table-wrapper">
      <table class="verlauf-table">
        <thead>
          <tr>
            <th>Datum</th>
            <th>Rechnungs-Nr.</th>
            <th>Aussteller</th>
            <th>Empfänger</th>
            <th>Format</th>
            <th class="text-right">Brutto</th>
            <th>Aktionen</th>
          </tr>
        </thead>
        <tbody>
          ${history.map(e => renderVerlaufRow(e)).join('')}
        </tbody>
      </table>
    </div>`;

  container.querySelectorAll('[data-action="download-xml"]').forEach(btn => {
    btn.addEventListener('click', () => {
      const entry = getHistoryEntry(parseInt(btn.dataset.id));
      if (entry && entry.xml) {
        const name = sanitizeFilename(entry.rechnungsnummer);
        downloadText(entry.xml, `${name}_xrechnung.xml`);
      }
    });
  });

  container.querySelectorAll('[data-action="download-pdf"]').forEach(btn => {
    btn.addEventListener('click', async () => {
      const entry = getHistoryEntry(parseInt(btn.dataset.id));
      if (entry && entry.zugferdPdf) {
        const name = sanitizeFilename(entry.rechnungsnummer);
        const bytes = base64ToBytes(entry.zugferdPdf);
        downloadBlob(bytes, `${name}_zugferd.pdf`, 'application/pdf');
      } else if (entry && entry.xml) {
        showToast('Kein ZUGFeRD-PDF gespeichert für diesen Eintrag.', 'info');
      }
    });
  });

  container.querySelectorAll('[data-action="delete"]').forEach(btn => {
    btn.addEventListener('click', () => {
      if (confirm('Diesen Verlaufseintrag löschen?')) {
        deleteFromHistory(parseInt(btn.dataset.id));
        renderVerlauf();
        showToast('Eintrag gelöscht.', 'info');
      }
    });
  });
}

function renderVerlaufRow(e) {
  const date = formatDateDisplay(e.savedAt);
  const gross = formatCurrency(e.grossTotal || 0);
  const hasPdf = !!e.zugferdPdf;
  const formatTag = e.formate
    ? e.formate.map(f => `<span class="format-tag ${f.toLowerCase()}">${f}</span>`).join(' ')
    : `<span class="format-tag xrechnung">XRechnung</span>`;

  return `
    <tr>
      <td>${date}</td>
      <td class="invoice-nr">${escHTML(e.rechnungsnummer)}</td>
      <td>${escHTML(e.verkaeufer)}</td>
      <td>${escHTML(e.kaeufer)}</td>
      <td>${formatTag}</td>
      <td class="amount-cell">${gross} €</td>
      <td>
        <div class="actions-cell">
          ${e.xml ? `<button class="btn btn-secondary btn-sm" data-action="download-xml" data-id="${e.id}" title="XRechnung XML herunterladen">📄 XML</button>` : ''}
          ${hasPdf ? `<button class="btn btn-secondary btn-sm" data-action="download-pdf" data-id="${e.id}" title="ZUGFeRD PDF herunterladen">📎 PDF</button>` : ''}
          <button class="btn btn-danger btn-sm" data-action="delete" data-id="${e.id}" title="Löschen">🗑</button>
        </div>
      </td>
    </tr>`;
}

function formatDateDisplay(isoString) {
  try {
    const d = new Date(isoString);
    return d.toLocaleDateString('de-DE', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' });
  } catch { return isoString; }
}

function formatCurrency(n) {
  return parseFloat(n || 0).toLocaleString('de-DE', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function sanitizeFilename(s) {
  return String(s || 'Rechnung').replace(/[^a-zA-Z0-9\-_\.]/g, '_');
}

function escHTML(s) {
  return String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function bytesToBase64(bytes) {
  let binary = '';
  const chunk = 8192;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

function base64ToBytes(b64) {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

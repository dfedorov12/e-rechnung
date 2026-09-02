/**
 * Rechnungsprüfung / Plausibilität (reine Funktionen, kein DOM)
 * =============================================================
 * Härtet den Konverter gegen falsche/abweichende Rechnungsdaten:
 *   - IBAN-Prüfziffer (ISO 7064 mod-97)
 *   - USt-IdNr.-Formatprüfung (EU + CH)
 *   - Abgleich Schlüsselwerte gegen den Text des Quell-PDF (PDF ↔ XML)
 *
 * Diese Datei ist bewusst frei von DOM/Globals, damit sie per Node-Harness
 * getestet werden kann.
 */

/* ── IBAN: ISO 7064 mod-97 Prüfziffer ──────────────────────────────────── */
function ibanChecksumValid(iban) {
  const s = String(iban || '').replace(/\s+/g, '').toUpperCase();
  // Grobformat: 2 Länderbuchstaben, 2 Prüfziffern, 6–30 alphanumerisch
  if (!/^[A-Z]{2}[0-9]{2}[A-Z0-9]{6,30}$/.test(s)) return false;
  const rearranged = s.slice(4) + s.slice(0, 4);
  let rem = 0;
  for (const ch of rearranged) {
    if (ch >= '0' && ch <= '9') {
      rem = (rem * 10 + (ch.charCodeAt(0) - 48)) % 97;
    } else {
      // Buchstabe → zweistelliger Wert (A=10 … Z=35)
      rem = (rem * 100 + (ch.charCodeAt(0) - 55)) % 97;
    }
  }
  return rem === 1;
}

/* ── USt-IdNr.: Formatprüfung je Land ──────────────────────────────────── */
const _VAT_PATTERNS = {
  DE: /^DE[0-9]{9}$/,
  AT: /^ATU[0-9]{8}$/,
  BE: /^BE0[0-9]{9}$/,
  BG: /^BG[0-9]{9,10}$/,
  CY: /^CY[0-9]{8}[A-Z]$/,
  CZ: /^CZ[0-9]{8,10}$/,
  DK: /^DK[0-9]{8}$/,
  EE: /^EE[0-9]{9}$/,
  EL: /^EL[0-9]{9}$/,
  ES: /^ES[A-Z0-9][0-9]{7}[A-Z0-9]$/,
  FI: /^FI[0-9]{8}$/,
  FR: /^FR[A-Z0-9]{2}[0-9]{9}$/,
  HR: /^HR[0-9]{11}$/,
  HU: /^HU[0-9]{8}$/,
  IE: /^IE[A-Z0-9]{8,9}$/,
  IT: /^IT[0-9]{11}$/,
  LT: /^LT([0-9]{9}|[0-9]{12})$/,
  LU: /^LU[0-9]{8}$/,
  LV: /^LV[0-9]{11}$/,
  MT: /^MT[0-9]{8}$/,
  NL: /^NL[A-Z0-9]{12}$/,
  PL: /^PL[0-9]{10}$/,
  PT: /^PT[0-9]{9}$/,
  RO: /^RO[0-9]{2,10}$/,
  SE: /^SE[0-9]{12}$/,
  SI: /^SI[0-9]{8}$/,
  SK: /^SK[0-9]{10}$/,
  CH: /^CHE[0-9]{9}(MWST|TVA|IVA)?$/,   // Schweiz (kein EU, aber vom Tool unterstützt)
};

/**
 * true, wenn die USt-IdNr. plausibel aussieht (oder leer ist).
 * Unbekannte Länderpräfixe werden locker akzeptiert (nur grobe Struktur).
 */
function vatIdLooksValid(vat) {
  const s = String(vat || '').replace(/[\s.\-\/]/g, '').toUpperCase();
  if (!s) return true;
  const cc = s.slice(0, 2);
  const pat = _VAT_PATTERNS[cc] || (cc === 'CH' ? _VAT_PATTERNS.CH : null);
  if (!pat) return /^[A-Z]{2}[A-Z0-9]{2,15}$/.test(s);
  return pat.test(s);
}

/* ── Abgleich gegen Quell-PDF-Text ─────────────────────────────────────── */
function _normForSearch(s) {
  return String(s == null ? '' : s).toLowerCase().replace(/[^a-z0-9]/g, '');
}

function _eur(n) {
  return (parseFloat(n) || 0).toLocaleString('de-DE', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + ' €';
}

/** Suchformen eines Geldbetrags (deutsche + englische Schreibweise, normalisiert). */
function _amountForms(n) {
  const val = Math.round((parseFloat(n) || 0) * 100) / 100;
  const de = val.toLocaleString('de-DE', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const en = val.toFixed(2);
  return Array.from(new Set([_normForSearch(de), _normForSearch(en)])).filter(Boolean);
}

/**
 * Prüft, ob Schlüsselwerte der Rechnung im Text des Quell-PDF vorkommen.
 * Gibt ein Array mit Klartext-Labels der NICHT gefundenen Werte zurück
 * (leer = alles gefunden, null = kein nutzbarer Text vorhanden).
 *
 * IBAN wird nur geprüft, wenn sie gegenüber dem extrahierten Stand geändert
 * wurde (verhindert Fehlalarme bei Firmen mit Grafik-Fußzeile).
 *
 * @param {object} data      finale Formulardaten
 * @param {object} totals    { grossTotal, ... }
 * @param {string} sourceText Text des hochgeladenen PDF (oder OCR)
 * @param {object} [snapshot] ursprünglich extrahierte Daten (für "geändert?")
 */
function crossCheckSource(data, totals, sourceText, snapshot) {
  const hay = _normForSearch(sourceText);
  if (hay.length < 20) return null;   // kein verwertbarer Textlayer (z. B. reiner Scan)
  const missing = [];
  const present = forms => forms.some(f => f && hay.includes(f));

  if (data.rechnungsnummer && !present([_normForSearch(data.rechnungsnummer)])) {
    missing.push('Rechnungsnummer ' + data.rechnungsnummer);
  }
  if (totals && totals.grossTotal && !present(_amountForms(totals.grossTotal))) {
    missing.push('Gesamtbetrag ' + _eur(totals.grossTotal));
  }
  if (data.iban) {
    const changed = !snapshot || _normForSearch(snapshot.iban) !== _normForSearch(data.iban);
    if (changed && !present([_normForSearch(data.iban)])) {
      missing.push('IBAN ' + data.iban);
    }
  }
  return missing;
}

/* ── Node-Export (nur für Tests; im Browser ignoriert) ─────────────────── */
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { ibanChecksumValid, vatIdLooksValid, crossCheckSource, _normForSearch, _amountForms };
}

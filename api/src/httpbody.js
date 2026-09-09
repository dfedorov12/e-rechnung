'use strict';
/**
 * Request-Body robust zu rohen Datei-Bytes normalisieren
 * ======================================================
 * Power Automate / SharePoint schicken den Dateiinhalt je nach Aktion/Mapping
 * nicht immer als rohe Bytes, sondern u. U. als
 *   - base64-Wrapper-Objekt  {"$content-type":"…","$content":"JVBERi0…"}  oder
 *   - reinen base64-String    "JVBERi0…"
 * Diese Funktion erkennt rohe PDF/XML sowie beide Verpackungen und liefert die
 * echten Bytes + ob es ein PDF ist. Gibt null zurück, wenn nichts davon passt.
 *
 * @param {Buffer} raw
 * @returns {{ buf: Buffer, isPdf: boolean } | null}
 */
function normalizeBody(raw) {
  if (!raw || !raw.length) return null;

  // 1) Rohes PDF (%PDF- irgendwo im Kopf)
  const head = raw.subarray(0, 1024).toString('latin1');
  if (head.includes('%PDF-')) return { buf: raw, isPdf: true };

  // 2) Rohe XML (nach optionalem BOM/Whitespace beginnt mit '<')
  const text = raw.toString('utf8').replace(/^﻿/, '');
  const trimmed = text.trimStart();
  if (trimmed.startsWith('<')) return { buf: Buffer.from(trimmed, 'utf8'), isPdf: false };

  // 3) Power-Automate/SharePoint-Wrapper {"$content":"<base64>", …}
  if (trimmed.startsWith('{')) {
    try {
      const obj = JSON.parse(trimmed);
      const b64 = obj && (obj['$content'] || obj.content);
      if (typeof b64 === 'string' && b64) {
        const inner = _fromBase64(b64);
        if (inner) return normalizeBody(inner); // auf entpackte Bytes erneut anwenden
      }
    } catch { /* kein JSON -> weiter */ }
  }

  // 4) Reiner base64-String, der zu PDF/XML dekodiert
  const compact = trimmed.replace(/\s+/g, '');
  if (compact.length > 16 && /^[A-Za-z0-9+/=]+$/.test(compact)) {
    const dec = _fromBase64(compact);
    if (dec) {
      const dHead = dec.subarray(0, 1024).toString('latin1');
      if (dHead.includes('%PDF-')) return { buf: dec, isPdf: true };
      const dTrim = dec.toString('utf8').replace(/^﻿/, '').trimStart();
      if (dTrim.startsWith('<')) return { buf: Buffer.from(dTrim, 'utf8'), isPdf: false };
    }
  }

  return null;
}

function _fromBase64(s) {
  try {
    const b = Buffer.from(String(s).replace(/\s+/g, ''), 'base64');
    return b.length ? b : null;
  } catch { return null; }
}

module.exports = { normalizeBody };

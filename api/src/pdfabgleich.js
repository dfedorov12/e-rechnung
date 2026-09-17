'use strict';
/**
 * Sichtbild ↔ eingebettete XML abgleichen (ZUGFeRD/Factur-X)
 * =========================================================
 * ZUGFeRD verlangt, dass das visuell lesbare PDF und die eingebettete XML
 * DIESELBE Rechnung zeigen. Ein abweichender Betrag/Nummer im Bild ist ein
 * Betrugs- oder Fehlerindikator, den KEINE Schema-/Schematron-Prüfung findet
 * (KoSIT/Mustang sehen nur die XML, nicht das gedruckte Bild).
 *
 * Wir extrahieren den PDF-Text (pdf-parse) und prüfen, ob die XML-Kernwerte
 * (Rechnungsnummer + Bruttobetrag) im Sichtbild vorkommen. BEWUSST KONSERVATIV:
 * ohne verlässlich lesbaren Text (Scan/reines Glyph-Subset ohne ToUnicode) ->
 * Status "nicht-pruefbar" statt Fehlalarm. Eine echte Abweichung meldet der
 * Aufrufer als Warnung (gelb) mit Klartext-Hinweis, nicht als harte Ablehnung.
 */
const pdfParse = require('pdf-parse');

/**
 * @param {Buffer} pdfBuf  Das ZUGFeRD/Factur-X-PDF (Sichtbild + eingebettete XML).
 * @param {object} daten   Geparste XML-Kopfdaten (mapDaten): nummer, brutto, …
 * @returns {Promise<{status:'ok'|'abweichung'|'nicht-pruefbar', pruefbar:boolean,
 *                     nummerOk?:boolean, betragOk?:boolean, hinweis:string, fehler?:string}>}
 */
async function pdfXmlAbgleich(pdfBuf, daten) {
  daten = daten || {};

  let text = '';
  try {
    const r = await pdfParse(pdfBuf);
    text = String(r.text || '');
  } catch (e) {
    return { status: 'nicht-pruefbar', pruefbar: false, hinweis: '', fehler: e && e.message ? e.message : String(e) };
  }

  const flat = text.replace(/\s+/g, ' ');
  const alnum = (flat.match(/[A-Za-z0-9]/g) || []).length;
  // Zu wenig lesbarer Text (Scan/Bild oder Glyph-Subset ohne ToUnicode) -> nicht bewertbar.
  if (alnum < 120) {
    return {
      status: 'nicht-pruefbar', pruefbar: false,
      hinweis: 'Sichtprüfung PDF↔XML nicht möglich (PDF ohne extrahierbaren Text — evtl. Scan). '
             + 'Übereinstimmung von Betrag/Nummer bitte manuell prüfen.',
    };
  }

  // Normalisierung: Leerzeichen + Tausenderpunkte/NBSP raus, kleinschreiben.
  const norm = s => String(s == null ? '' : s).replace(/[\s. ]/g, '').toLowerCase();
  const flatN = norm(flat);

  // Rechnungsnummer im Sichtbild?
  const nr = String(daten.nummer || daten.rechnungsnummer || '').trim();
  const nummerOk = !nr || flat.includes(nr) || flatN.includes(norm(nr));

  // Bruttobetrag im Sichtbild? (verschiedene Schreibweisen tolerieren)
  const g = Number(daten.brutto != null ? daten.brutto : daten.grossTotal);
  let betragOk = true, betragGeprueft = false;
  if (Number.isFinite(g) && g > 0) {
    betragGeprueft = true;
    const fmts = [
      g.toLocaleString('de-DE', { minimumFractionDigits: 2 }),   // 15.452,50
      g.toFixed(2).replace('.', ','),                            // 15452,50
      g.toLocaleString('en-US', { minimumFractionDigits: 2 }),   // 15,452.50
      g.toFixed(2),                                              // 15452.50
    ];
    betragOk = fmts.some(x => flat.includes(x)) || fmts.some(x => flatN.includes(norm(x)));
  }

  const abw = [];
  if (!nummerOk) abw.push(`Rechnungsnummer „${nr}" steht nicht im Sichtbild`);
  if (betragGeprueft && !betragOk) {
    abw.push(`Bruttobetrag ${g.toLocaleString('de-DE', { style: 'currency', currency: 'EUR' })} steht nicht im Sichtbild`);
  }

  if (abw.length) {
    return {
      status: 'abweichung', pruefbar: true, nummerOk, betragOk,
      hinweis: 'Sichtbild ↔ XML weichen ab: ' + abw.join('; ')
             + '. ZUGFeRD verlangt Übereinstimmung — bitte manuell prüfen (Betrugs-/Fehlerverdacht).',
    };
  }
  return { status: 'ok', pruefbar: true, nummerOk: true, betragOk: true, hinweis: '' };
}

module.exports = { pdfXmlAbgleich };

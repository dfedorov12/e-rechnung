'use strict';
/**
 * Sichtbild ↔ eingebettete XML abgleichen (ZUGFeRD/Factur-X)
 * =========================================================
 * Umsatzsteuerlich ist die XML der Beleg, der PDF-Bildteil nur Visualisierung
 * (UStAE 14.4 Abs. 3; GoBD-Leitfaden Kap. 9). Es wird daher NICHT abgelehnt und
 * IMMER aus der XML gebucht. Eine automatische Rueckfrage an den Lieferanten
 * erfolgt NUR bei MATERIELLEN Abweichungen — solchen, die den Steuerbetrag oder
 * die Belegidentitaet veraendern — nicht bei Rundungs-/Darstellungsdifferenzen
 * (vgl. UStAE 14c.1 Abs. 4a).
 *
 * Wir extrahieren den PDF-Text (pdf-parse), lesen die dort gedruckten Betraege
 * und vergleichen sie mit den XML-Werten (Steuerbetrag, Bruttobetrag) mit einer
 * Rundungstoleranz. Konservativ: ohne verlaesslich lesbaren Text/Betrag -> Status
 * "nicht-pruefbar" statt Fehlalarm.
 */
const pdfParse = require('pdf-parse');

const TOLERANZ = 0.02;   // Cent-Rundung tolerieren (keine materielle Abweichung)

/**
 * @param {Buffer} pdfBuf  Das ZUGFeRD/Factur-X-PDF (Sichtbild + eingebettete XML).
 * @param {object} daten   Geparste XML-Kopfdaten (mapDaten): nummer, mwst, brutto, …
 * @returns {Promise<{status:'ok'|'abweichung'|'nicht-pruefbar', pruefbar:boolean,
 *                     materiell:boolean, hinweis:string, fehler?:string}>}
 */
async function pdfXmlAbgleich(pdfBuf, daten) {
  daten = daten || {};

  let text = '';
  try {
    const r = await pdfParse(pdfBuf);
    text = String(r.text || '');
  } catch (e) {
    return { status: 'nicht-pruefbar', pruefbar: false, materiell: false, hinweis: '',
             fehler: e && e.message ? e.message : String(e) };
  }

  const flat = text.replace(/\s+/g, ' ');
  const alnum = (flat.match(/[A-Za-z0-9]/g) || []).length;
  if (alnum < 120) {
    return {
      status: 'nicht-pruefbar', pruefbar: false, materiell: false,
      hinweis: 'Sichtprüfung PDF↔XML nicht möglich (PDF ohne extrahierbaren Text — evtl. Scan). '
             + 'Übereinstimmung von Steuerbetrag/Belegnummer bitte manuell prüfen.',
    };
  }

  const amounts = _amounts(flat);
  // Keine lesbaren Betraege -> Betragsvergleich nicht moeglich.
  if (!amounts.size) {
    return {
      status: 'nicht-pruefbar', pruefbar: false, materiell: false,
      hinweis: 'Sichtprüfung PDF↔XML nicht möglich (keine lesbaren Beträge im Bild). '
             + 'Steuerbetrag bitte manuell abgleichen.',
    };
  }
  const near = target => {
    for (const a of amounts) if (Math.abs(a - target) <= TOLERANZ) return true;
    return false;
  };
  const eur = v => v.toLocaleString('de-DE', { style: 'currency', currency: 'EUR' });

  const abw = [];

  // Belegidentitaet: Rechnungsnummer (unterschiedliche Nummer = anderer Beleg, materiell).
  const nr = String(daten.nummer || daten.rechnungsnummer || '').trim();
  const nummerOk = !nr || nr.length < 5
    || flat.includes(nr) || flat.replace(/[\s.]/g, '').toLowerCase().includes(nr.replace(/[\s.]/g, '').toLowerCase());
  if (!nummerOk) abw.push(`Rechnungsnummer „${nr}" steht nicht im Sichtbild`);

  // Steuerbetrag (MATERIELL): muss im Bild stehen (Rundung toleriert).
  const vat = Number(daten.mwst != null ? daten.mwst : daten.vatTotal);
  if (Number.isFinite(vat) && vat > 0 && !near(vat)) {
    abw.push(`Steuerbetrag ${eur(vat)} steht nicht im Sichtbild`);
  }

  // Bruttobetrag (MATERIELL, sofern nicht nur Rundung): muss im Bild stehen.
  const gross = Number(daten.brutto != null ? daten.brutto : daten.grossTotal);
  if (Number.isFinite(gross) && gross > 0 && !near(gross)) {
    abw.push(`Bruttobetrag ${eur(gross)} steht nicht im Sichtbild`);
  }

  if (abw.length) {
    return {
      status: 'abweichung', pruefbar: true, materiell: true,
      hinweis: 'Materielle Abweichung Sichtbild ↔ XML: ' + abw.join('; ')
             + '. Gebucht wird aus der XML (bindend); automatische Rückfrage an den Lieferanten.',
    };
  }
  return { status: 'ok', pruefbar: true, materiell: false, hinweis: '' };
}

/** Alle gedruckten Geldbetraege aus dem Text als Zahlenmenge (auf 2 NK gerundet). */
function _amounts(text) {
  const set = new Set();
  const re = /-?\d{1,3}(?:[.\s]\d{3})+[.,]\d{2}|-?\d+[.,]\d{2}/g;
  let m;
  while ((m = re.exec(text))) {
    const v = _num(m[0]);
    if (v != null) set.add(Math.round(v * 100) / 100);
  }
  return set;
}

/** Betragsstring -> Zahl. Letztes ,/. = Dezimaltrenner; Rest = Tausendertrenner. */
function _num(t) {
  t = String(t).replace(/\s/g, '');
  const lc = t.lastIndexOf(','), ld = t.lastIndexOf('.');
  const dec = lc > ld ? ',' : '.';
  const s = dec === ',' ? t.replace(/\./g, '').replace(',', '.') : t.replace(/,/g, '');
  const v = parseFloat(s);
  return Number.isFinite(v) ? v : null;
}

module.exports = { pdfXmlAbgleich };

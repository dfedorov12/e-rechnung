'use strict';
/**
 * Mail an den Lieferanten bei Zurückweisung und bei Abweichungen
 * ==============================================================
 * /api/intake liefert die Mail fertig in kreditorAktion.mail. Der Eingangs-Flow
 * legt damit einen Auftrag in der Liste KreditorMails an, „Kreditor-Mail senden“
 * verschickt ihn aus dem Werks-Postfach (docs/Kreditor-Mail-Flow.md, 4a).
 *
 *   rot bzw. MINIMUM/BASIC-WL  -> Zurückweisung, nicht gebucht
 *   gelb (nur Warnungen)       -> Hinweis auf Abweichungen, gebucht unter Vorbehalt
 *
 * Sonstige Rechnungen (PDF ohne XML, PDF/A-3 fehlt) bekommen hier keine Mail. Für
 * sie entscheidet die 800k-Einschätzung im Monitoring über den Text.
 *
 * Die Absätze sind die Vorlagen der Buchhaltung (Oktober 2026), wörtlich. Dazu
 * kommen Rechnungsnummer und die Befunde aus der Prüfung, damit der Lieferant
 * weiß, was er ändern muss.
 */

const ANREDE = 'Sehr geehrte Damen und Herren,';
const GRUSS = 'Mit freundlichen Grüßen';

const VORLAGEN = {
  zurueckweisung: {
    art: 'Zurueckweisung',
    betreff: 'Zurückweisung Ihrer E-Rechnung',
    befunde: 'Festgestellte Mängel',
    absaetze: [
      'vielen Dank für die Übermittlung Ihrer E-Rechnung.',
      'Bei der Prüfung Ihrer Rechnung haben wir festgestellt, dass diese erhebliche Mängel aufweist und in '
        + 'der vorliegenden Form nicht verarbeitet werden kann.',
      'Aufgrund dessen müssen wir die eingereichte E-Rechnung zurückweisen und bitten Sie, eine vollständig '
        + 'korrigierte E-Rechnung auszustellen und erneut zu übermitteln.',
      'Bitte achten Sie bei der Neuausstellung darauf, dass sowohl die erforderlichen Rechnungsangaben als '
        + 'auch die technischen Anforderungen an das verwendete E-Rechnungsformat erfüllt sind.',
    ],
    schluss: ['Für Rückfragen stehen wir Ihnen gerne zur Verfügung.', 'Vielen Dank für Ihre Unterstützung.'],
  },
  abweichung: {
    art: 'Abweichung',
    betreff: 'Hinweis zu Ihrer E-Rechnung',
    befunde: 'Festgestellte Abweichungen',
    absaetze: [
      'bei der Prüfung Ihrer übermittelten E-Rechnung haben wir geringfügige Abweichungen festgestellt.',
      'Die Rechnung wird dennoch verarbeitet. Wir bitten Sie, die geltenden Anforderungen an die Erstellung '
        + 'und Übermittlung von E-Rechnungen zu beachten und entsprechende Abweichungen möglichst zu vermeiden.',
    ],
    schluss: ['Vielen Dank für Ihre Unterstützung.'],
  },
};

const MAX_BEFUNDE = 10;

function _esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/** 2026-10-27 -> 27.10.2026, anderes bleibt. */
function _datum(s) {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(s || ''));
  return m ? `${m[3]}.${m[2]}.${m[1]}` : String(s || '');
}

function _betrag(n, waehrung) {
  if (!n) return '';
  return Number(n).toLocaleString('de-DE', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + ' ' + (waehrung || 'EUR');
}

/** „Rechnung 4711 vom 27.10.2026 über 1.234,56 EUR“ oder '' ohne Nummer und Datum. */
function _rechnungZeile(d) {
  if (!d || (!d.nummer && !d.datum)) return '';
  return 'Rechnung' + (d.nummer ? ' ' + d.nummer : '') + (d.datum ? ' vom ' + _datum(d.datum) : '')
    + (d.brutto ? ' über ' + _betrag(d.brutto, d.waehrung) : '');
}

/** Befunde aus der Prüfung: Fehler bei Zurückweisung, Warnungen bei Abweichung. */
function _befunde(res, art) {
  if (art === 'zurueckweisung' && res.zurueckweisung && res.zurueckweisung.grund === 'MINIMUM/BASIC-WL') {
    return [res.zurueckweisung.text];
  }
  const level = art === 'zurueckweisung' ? 'error' : 'warning';
  const texte = Array.from(new Set((res.meldungen || [])
    .filter(m => m && m.level === level).map(m => String(m.text || '').trim()).filter(Boolean)));
  if (!texte.length && art === 'zurueckweisung') {
    // KoSIT lehnt ohne einzelne Fehler ab: dann der Klartext-Hinweis (ohne interne Zusätze)
    const h = String(res.hinweis || '').split(' | ')[0].trim();
    return h ? [h] : [];
  }
  if (texte.length > MAX_BEFUNDE) {
    return texte.slice(0, MAX_BEFUNDE).concat(`(und ${texte.length - MAX_BEFUNDE} weitere, siehe Prüfbericht)`);
  }
  return texte;
}

/**
 * @param {object} res  Antwort von /api/intake (vor feldGrenzen), mit kreditorAktion
 * @returns {{art:string, betreff:string, html:string, text:string}|null}
 *          art = Wert für die Spalte Art in KreditorMails
 */
function kreditorMail(res) {
  const aktion = res && res.kreditorAktion;
  const v = aktion && VORLAGEN[aktion.art];
  if (!v || res.richtung === 'Ausgang') return null;

  const d = res.daten || {};
  const zeile = _rechnungZeile(d);
  const befunde = _befunde(res, aktion.art);
  const absender = res.richtung === 'Eingang' && d.empfaenger ? d.empfaenger : '';

  // Text: Absätze durch Leerzeile getrennt
  const block = [zeile, befunde.length ? v.befunde + ':' : ''].filter(Boolean).join('\n')
    + (befunde.length ? '\n' + befunde.map(b => '- ' + b).join('\n') : '');
  const text = [ANREDE, ...v.absaetze, block, ...v.schluss, [GRUSS, absender].filter(Boolean).join('\n')]
    .filter(Boolean).join('\n\n');

  // HTML: dieselben Absätze, Befunde als Liste
  const p = s => `<p>${_esc(s)}</p>`;
  const kopf = [zeile, befunde.length ? v.befunde + ':' : ''].filter(Boolean).map(_esc).join('<br>');
  const html = [p(ANREDE), ...v.absaetze.map(p),
    kopf ? `<p>${kopf}</p>` : '',
    befunde.length ? `<ul>${befunde.map(b => `<li>${_esc(b)}</li>`).join('')}</ul>` : '',
    ...v.schluss.map(p), `<p>${[GRUSS, absender].filter(Boolean).map(_esc).join('<br>')}</p>`].join('');

  return { art: v.art, betreff: v.betreff + (d.nummer ? ' ' + d.nummer : ''), html, text };
}

module.exports = { kreditorMail, VORLAGEN };

'use strict';
/**
 * Mail an den Lieferanten bei Zurückweisung und bei Abweichungen
 * ==============================================================
 * /api/intake liefert die Mail fertig in kreditorAktion.mail. Der Eingangs-Flow
 * sendet sie aus dem Werks-Postfach und hält sie in der Liste KreditorMails fest
 * (docs/Kreditor-Mail-Flow.md, 4a).
 *
 *   rot bzw. MINIMUM/BASIC-WL  -> Zurückweisung, nicht gebucht
 *   gelb (nur Warnungen)       -> Hinweis auf Abweichungen, gebucht unter Vorbehalt
 *
 * Sonstige Rechnungen (PDF ohne XML, PDF/A-3 fehlt) bekommen hier keine Mail. Für
 * sie entscheidet die 800k-Einschätzung im Monitoring über den Text.
 *
 * Die Absätze sind die Vorlagen der Buchhaltung (Oktober 2026), wörtlich. Die Mail
 * nennt dazu nur die Rechnung. Die Befunde stehen im Anhang, einem Prüfbericht im
 * selben Layout für XRechnung (KoSIT) und ZUGFeRD (Mustang), mit Rechnungsinhalt.
 * Absender im Gruß ist die Gesellschaft des Postfachs (Werk), nicht der Empfänger
 * aus der Rechnung: Der steht bei fehlerhaften Rechnungen oft falsch oder gar nicht drin.
 *
 * Empfänger: mail.an ist die Mailadresse, die der Lieferant in der E-Rechnung als
 * Kommunikationsweg angibt (BT-43 Ansprechpartner, sonst BT-34 elektronische Adresse).
 * Fehlt sie, ist mail.an null und der Flow schreibt an den Absender der Rechnungsmail.
 */

const { DOMParser } = require('@xmldom/xmldom');

const ANREDE = 'Sehr geehrte Damen und Herren,';
const GRUSS = 'Mit freundlichen Grüßen';

// DIHAG-Farben, Schrift ohne Webfont (Outlook)
const F = { navy: '#1A2644', azur: '#17509E', text: '#424241', licht: '#99B7CD', box: '#F3F6FA', rand: '#E3E8EF', grund: '#F4F6F9', grau: '#6B7280' };
const SCHRIFT = "'Segoe UI', Arial, Helvetica, sans-serif";

const VORLAGEN = {
  zurueckweisung: {
    art: 'Zurueckweisung',
    betreff: 'Zurückweisung Ihrer E-Rechnung',
    titel: 'E-Rechnung zurückgewiesen',
    akzent: '#B42318',
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
    titel: 'Geringfügige Abweichungen, die Rechnung wird verarbeitet',
    akzent: '#F08300',
    absaetze: [
      'bei der Prüfung Ihrer übermittelten E-Rechnung haben wir geringfügige Abweichungen festgestellt.',
      'Die Rechnung wird dennoch verarbeitet. Wir bitten Sie, die geltenden Anforderungen an die Erstellung '
        + 'und Übermittlung von E-Rechnungen zu beachten und entsprechende Abweichungen möglichst zu vermeiden.',
    ],
    schluss: ['Vielen Dank für Ihre Unterstützung.'],
  },
};

const MAX_BEFUNDE = 50;
const MAX_INHALT = 3000;     // Elemente im Rechnungsinhalt, darüber wird gekürzt

// Gesellschaft je Werk für Kopf und Gruß (wie WERKE_ALLE in js/access.js)
const GESELLSCHAFT = {
  WGC: 'Walzengießerei Coswig GmbH',
  SHB: 'Stahl- und Hartgusswerk Bösdorf GmbH',
  ZAI: 'Dihag Zaigler GmbH',
  EIS: 'DIHAG Gienanth GmbH',
  LEG: 'Lintorfer Eisengießerei GmbH',
  EWA: 'Eisenwerk Arnstadt GmbH',
  HOL: 'DIHAG Holding GmbH',
};

/** Taugt die Adresse als Empfänger? Keine noreply-Adressen. */
function mailOk(m) {
  const s = String(m || '').trim().toLowerCase();
  return /^[^\s@,;]+@[^\s@,;]+\.[a-z]{2,}$/.test(s)
    && !/(^|[._-])(no-?reply|do-?not-?reply)([._-]|@)|^(mailer-daemon|postmaster)@/.test(s);
}

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

/** Angaben zur Rechnung als [Bezeichnung, Wert], leere fallen weg. */
function _angaben(d) {
  return [['Rechnungsnummer', d.nummer], ['Rechnungsdatum', _datum(d.datum)], ['Betrag', _betrag(d.brutto, d.waehrung)]]
    .filter(([, w]) => w);
}

/** Befunde für den eigenen Bericht: Fehler zuerst, dann Warnungen. */
function _befunde(res, art) {
  const liste = [];
  // Bei MINIMUM/BASIC-WL ist das Profil der Grund, das steht in keiner Meldung
  if (art === 'zurueckweisung' && res.zurueckweisung && res.zurueckweisung.grund === 'MINIMUM/BASIC-WL') {
    liste.push({ level: 'error', text: res.zurueckweisung.text });
  }
  const gesehen = new Set(liste.map(b => b.text));
  for (const level of ['error', 'warning']) {
    for (const m of res.meldungen || []) {
      const t = String((m && m.text) || '').trim();
      if (m && m.level === level && t && !gesehen.has(t)) { gesehen.add(t); liste.push({ level, text: t }); }
    }
  }
  if (!liste.length && res.hinweis) liste.push({ level: art === 'zurueckweisung' ? 'error' : 'warning', text: String(res.hinweis).split(' | ')[0] });
  return liste.slice(0, MAX_BEFUNDE);
}

function _jetzt() {
  return new Intl.DateTimeFormat('de-DE', { timeZone: 'Europe/Berlin', dateStyle: 'medium', timeStyle: 'short' }).format(new Date());
}

/**
 * Rechnungsinhalt wie im KoSIT-Bericht: jedes Element mit Tiefe, Name, Wert und
 * Attributen (ohne Namensräume). Leer, wenn die XML fehlt oder nicht lesbar ist.
 */
function _inhalt(xml) {
  if (!xml) return [];
  let wurzel = null;
  try {
    const leise = { warning() {}, error() {}, fatalError() {} };
    wurzel = new DOMParser({ errorHandler: leise }).parseFromString(String(xml), 'text/xml').documentElement;
  } catch (e) { return []; }
  const zeilen = [];
  const lauf = (el, tiefe) => {
    if (zeilen.length >= MAX_INHALT) return;
    const kinder = Array.from(el.childNodes || []).filter(k => k.nodeType === 1);
    const attr = Array.from(el.attributes || []).filter(a => !/^xmlns(:|$)/.test(a.name)).map(a => [a.localName || a.name, a.value]);
    zeilen.push({ tiefe, name: el.localName || el.nodeName, wert: kinder.length ? '' : String(el.textContent || '').trim(), attr });
    for (const k of kinder) lauf(k, tiefe + 1);
  };
  if (wurzel) lauf(wurzel, 0);
  return zeilen;
}

function _inhaltHtml(xml) {
  const zeilen = _inhalt(xml);
  if (!zeilen.length) return '';
  const td = 'padding:2px 8px;border-bottom:1px solid ' + F.rand + ';vertical-align:top;';
  return `<h2 style="font-size:16px;color:${F.navy};margin:26px 0 8px;">Inhalt der Rechnung</h2>`
    + `<table style="border-collapse:collapse;width:100%;font-size:13px;">`
    + zeilen.map((z, i) => `<tr><td style="${td}width:44px;color:${F.grau};">${String(i + 1).padStart(4, '0')}</td>`
      + `<td style="${td}padding-left:${8 + z.tiefe * 16}px;">`
      + `<span style="color:${F.grau};">${_esc(z.name)}</span>`
      + (z.wert ? ` <strong style="color:${F.navy};">${_esc(z.wert)}</strong>` : '')
      + z.attr.map(([k, w]) => ` <span style="font-size:12px;color:${F.grau};">${_esc(k)}: ${_esc(w)}</span>`).join('')
      + '</td></tr>').join('')
    + (zeilen.length >= MAX_INHALT ? `<tr><td></td><td style="${td}color:${F.grau};">(gekürzt nach ${MAX_INHALT} Elementen)</td></tr>` : '')
    + '</table>';
}

/** Prüfbericht, wenn kein KoSIT-HTML da ist (ZUGFeRD über Mustang). */
function _eigenerBericht(res, v, d) {
  const zeilen = [
    ..._angaben(d),
    ['Rechnungssteller', d.steller], ['Rechnungsempfänger', d.empfaenger],
    ['Prüfung', res.pruefwerkzeug], ['Geprüft am', _jetzt()], ['Ergebnis', v.titel],
  ].filter(([, w]) => w);
  const befunde = _befunde(res, v.art === 'Zurueckweisung' ? 'zurueckweisung' : 'abweichung');
  const td = 'padding:6px 10px;border-bottom:1px solid ' + F.rand + ';vertical-align:top;';
  return '<!DOCTYPE html><html lang="de"><head><meta charset="utf-8"><title>Prüfbericht</title></head>'
    + `<body style="margin:0;padding:24px;font:14px/1.5 ${SCHRIFT};color:${F.text};background:#fff;">`
    + `<div style="max-width:820px;margin:0 auto;">`
    + `<div style="border-bottom:4px solid ${v.akzent};padding-bottom:10px;margin-bottom:18px;">`
    + `<div style="font-size:12px;letter-spacing:.5px;text-transform:uppercase;color:${F.azur};">Prüfbericht</div>`
    + `<h1 style="margin:2px 0 0;font-size:22px;color:${F.navy};">E-Rechnung${d.nummer ? ' ' + _esc(d.nummer) : ''}</h1></div>`
    + `<table style="border-collapse:collapse;width:100%;margin-bottom:22px;">`
    + zeilen.map(([k, w]) => `<tr><td style="${td}width:190px;color:${F.grau};">${_esc(k)}</td><td style="${td}">${_esc(w)}</td></tr>`).join('')
    + '</table>'
    + `<h2 style="font-size:16px;color:${F.navy};margin:0 0 8px;">Befunde (${befunde.length})</h2>`
    + `<table style="border-collapse:collapse;width:100%;">`
    + `<tr><th style="${td}text-align:left;width:90px;background:${F.box};">Art</th><th style="${td}text-align:left;background:${F.box};">Meldung</th></tr>`
    + befunde.map(b => `<tr><td style="${td}font-weight:600;color:${b.level === 'error' ? '#B42318' : '#B45309'};">${b.level === 'error' ? 'Fehler' : 'Warnung'}</td><td style="${td}">${_esc(b.text)}</td></tr>`).join('')
    + '</table>' + _inhaltHtml(res.xml) + '</div></body></html>';
}

function _anhang(res, v, d) {
  const name = 'Pruefbericht_' + (String(d.nummer || 'E-Rechnung').replace(/[^A-Za-z0-9._-]+/g, '-').slice(0, 60) || 'E-Rechnung') + '.html';
  // Immer der eigene Bericht, gleiches Layout für KoSIT und Mustang (der KoSIT-Bericht bleibt im Archiv)
  const html = _eigenerBericht(res, v, d);
  return { name, contentType: 'text/html', base64: Buffer.from(html, 'utf8').toString('base64') };
}

/** Mail als HTML für Outlook: Tabellen und Inline-Stile, 600 px breit. */
function _mailHtml(v, angaben, firma) {
  const p = s => `<p style="margin:0 0 14px;">${_esc(s)}</p>`;
  const zeile = ([k, w]) => `<tr><td style="padding:3px 16px 3px 0;color:${F.grau};white-space:nowrap;">${_esc(k)}</td>`
    + `<td style="padding:3px 0;color:${F.navy};font-weight:600;">${_esc(w)}</td></tr>`;
  const box = `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:6px 0 20px;background:${F.box};border-left:4px solid ${v.akzent};">`
    + `<tr><td style="padding:14px 18px;font:14px/1.5 ${SCHRIFT};color:${F.text};">`
    + `<div style="font-weight:600;color:${F.navy};margin-bottom:6px;">${_esc(v.titel)}</div>`
    + `<table role="presentation" cellpadding="0" cellspacing="0" style="font:14px/1.5 ${SCHRIFT};">`
    + angaben.map(zeile).join('') + '</table></td></tr></table>';
  return '<!DOCTYPE html><html lang="de"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"></head>'
    + `<body style="margin:0;padding:0;background:${F.grund};">`
    + `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${F.grund};"><tr><td align="center" style="padding:24px 12px;">`
    + `<table role="presentation" width="600" cellpadding="0" cellspacing="0" style="width:100%;max-width:600px;background:#ffffff;border:1px solid ${F.rand};">`
    + `<tr><td style="background:${F.navy};padding:18px 28px;">`
    + `<div style="font:600 12px ${SCHRIFT};color:${F.licht};letter-spacing:.5px;text-transform:uppercase;">Rechnungsprüfung</div>`
    + (firma ? `<div style="font:600 18px ${SCHRIFT};color:#ffffff;margin-top:3px;">${_esc(firma)}</div>` : '')
    + '</td></tr>'
    + `<tr><td style="height:4px;line-height:4px;font-size:0;background:${v.akzent};">&nbsp;</td></tr>`
    + `<tr><td style="padding:26px 28px 24px;font:15px/1.6 ${SCHRIFT};color:${F.text};">`
    + p(ANREDE) + v.absaetze.map(p).join('') + box + v.schluss.map(p).join('')
    + `<p style="margin:0;">${_esc(GRUSS)}${firma ? `<br><strong style="color:${F.navy};">${_esc(firma)}</strong>` : ''}</p>`
    + '</td></tr></table></td></tr></table></body></html>';
}

/**
 * @param {object} res  Antwort von /api/intake (vor feldGrenzen), mit kreditorAktion
 * @returns {{art:string, betreff:string, html:string, text:string,
 *            anhang:{name:string, contentType:string, base64:string}}|null}
 *          art = Wert für die Spalte Art in KreditorMails
 */
function kreditorMail(res) {
  const aktion = res && res.kreditorAktion;
  const v = aktion && VORLAGEN[aktion.art];
  if (!v || res.richtung === 'Ausgang') return null;

  const d = res.daten || {};
  const firma = GESELLSCHAFT[String(res.werk || '').toUpperCase()] || '';
  const anhang = _anhang(res, v, d);
  const angaben = [..._angaben(d), ['Prüfbericht', 'im Anhang (' + anhang.name + ')']];

  const text = [ANREDE, ...v.absaetze,
    [v.titel, ...angaben.map(([k, w]) => `${k}: ${w}`)].join('\n'),
    ...v.schluss, [GRUSS, firma].filter(Boolean).join('\n')].join('\n\n');

  // Empfänger aus der E-Rechnung (Kommunikationsweg des Lieferanten), sonst entscheidet der Flow
  const an = mailOk(d.stellerMail) ? String(d.stellerMail).trim() : null;
  return { art: v.art, betreff: v.betreff + (d.nummer ? ' ' + d.nummer : ''), html: _mailHtml(v, angaben, firma), text, anhang,
    an, anQuelle: an ? 'rechnung' : '' };
}

module.exports = { kreditorMail, mailOk, VORLAGEN };

'use strict';
/**
 * BPMN-Generator: E-Rechnungs-Prozesse der DIHAG
 * ==============================================
 * Quelle der Wahrheit für die Prozessdiagramme auf prozess.html.
 * Erzeugt BPMN 2.0 inklusive Layout (DI) und Farben (bioc/color). Die Dateien
 * lassen sich im Camunda Modeler, auf bpmn.io und in Signavio öffnen.
 * Unterprozesse sind zugeklappt und haben ein eigenes Diagramm (Drill-down).
 *
 * Aufruf:  node scripts/bpmn/generate-bpmn.js
 * Ausgabe: docs/bpmn/*.bpmn
 *
 * Prozess ändern: unten in PROZESSE anpassen und neu erzeugen.
 * Raster: c = Spalte (von links), r = Zeile innerhalb der Bahn bzw. Ebene.
 */
const fs = require('fs');
const path = require('path');

/* ── Raster & Maße ─────────────────────────────────────────────────────── */
const COL_W = 170, ROW_H = 120;
const TASK_W = 132, TASK_H = 84, EV = 36, GW = 50;
const POOL_X = 100, POOL_HEAD = 30, LANE_HEAD = 30, POOL_GAP = 70, TOP = 60;
const CONTENT_X = POOL_X + POOL_HEAD + LANE_HEAD + 20;
const PLANE_X = 60, PLANE_Y = 40;

/* ── Farben (identisch zur Legende auf prozess.html) ───────────────────── */
const ACTOR = {
  extern: { lane: '#F6F7F9', fill: '#E9ECF0', stroke: '#5B6472' },  // Lieferant, Kunde, Bank
  auto:   { lane: '#F3F8FE', fill: '#D8E8F8', stroke: '#17509E' },  // Postfach & Power Automate
  api:    { lane: '#F8F5FD', fill: '#E6DDF7', stroke: '#5B3FA8' },  // Prüfdienst (Azure)
  archiv: { lane: '#F1FAF8', fill: '#D2EEE8', stroke: '#0F766E' },  // SharePoint, Monitoring, GoBD
  mensch: { lane: '#FFF8F1', fill: '#FFE3C8', stroke: '#C2410C' },  // Buchhaltung, Vertrieb, Treasury
  app:    { lane: '#F3F6FB', fill: '#DCE5F2', stroke: '#1A2644' },  // Browser-Apps (Konverter, MC-Converter)
  erp:    { lane: '#F7F7F6', fill: '#E6E6E4', stroke: '#424241' },  // ERP, MultiCash, Versand
};
const TONE = {
  ok:   { fill: '#DDF3E4', stroke: '#1E7B3A' },
  warn: { fill: '#FFF1CC', stroke: '#A65F00' },
  err:  { fill: '#FDE2E1', stroke: '#B42318' },
  gate: { fill: '#FFF8DB', stroke: '#8A6100' },
  plan: { fill: '#F1F1F3', stroke: '#8A8F98' },
};

/* ── Elementarten ──────────────────────────────────────────────────────── */
const KIND = {
  start:       { tag: 'startEvent',             size: 'ev' },
  msgStart:    { tag: 'startEvent',             size: 'ev', def: 'message' },
  end:         { tag: 'endEvent',               size: 'ev' },
  errEnd:      { tag: 'endEvent',               size: 'ev', def: 'error' },
  linkThrow:   { tag: 'intermediateThrowEvent', size: 'ev', def: 'link' },
  linkCatch:   { tag: 'intermediateCatchEvent', size: 'ev', def: 'link' },
  boundaryErr: { tag: 'boundaryEvent',          size: 'ev', def: 'error' },
  task:        { tag: 'task',        size: 'task' },
  service:     { tag: 'serviceTask', size: 'task' },
  user:        { tag: 'userTask',    size: 'task' },
  manual:      { tag: 'manualTask',  size: 'task' },
  send:        { tag: 'sendTask',    size: 'task' },
  sub:         { tag: 'subProcess',  size: 'task' },
  gw:          { tag: 'exclusiveGateway', size: 'gw' },
  gwInc:       { tag: 'inclusiveGateway', size: 'gw' },
  gwPar:       { tag: 'parallelGateway',  size: 'gw' },
};

const R = b => b.x + b.w, B = b => b.y + b.h, CX = b => b.x + b.w / 2, CY = b => b.y + b.h / 2;
const rnd = v => Math.round(v);
const isGw = n => KIND[n.k].size === 'gw';
const sizeOf = k => (KIND[k].size === 'ev' ? [EV, EV] : KIND[k].size === 'gw' ? [GW, GW] : [TASK_W, TASK_H]);
const esc = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

function colorOf(n, actor) {
  if (n.tone) return TONE[n.tone];
  if (n.k === 'start' || n.k === 'msgStart' || n.k === 'end') return TONE.ok;
  if (n.k === 'errEnd' || n.k === 'boundaryErr') return TONE.err;
  if (isGw(n)) return TONE.gate;
  const a = ACTOR[actor] || ACTOR.app;
  return { fill: a.fill, stroke: a.stroke };
}
const colorAttrs = c => (c
  ? ` bioc:stroke="${c.stroke}" bioc:fill="${c.fill}" color:background-color="${c.fill}" color:border-color="${c.stroke}"`
  : '');

/* Kurzschreibweise für Sequenzflüsse: F(von, nach, Beschriftung, Optionen) */
const F = (from, to, name, o) => ({ from, to, name: name || '', o: o || {} });

/* ═════════════════════════════════════════════════════════════════════════
 *  PROZESSE
 * ═════════════════════════════════════════════════════════════════════════ */

const EINGANG = {
  file: '01-rechnungseingang.bpmn',
  id: 'Eingang',
  pools: [
    {
      id: 'P_Lief', name: 'Lieferant', actor: 'extern',
      nodes: [
        { id: 'L_start', k: 'start', n: 'Rechnung ist fertig', c: 0, r: 0 },
        { id: 'L_send', k: 'send', n: 'Rechnung per E-Mail an das Werks-Postfach senden', c: 1, r: 0 },
        { id: 'L_end', k: 'end', n: 'Rechnung versendet', c: 2, r: 0 },
      ],
      flows: [F('L_start', 'L_send'), F('L_send', 'L_end')],
    },
    {
      id: 'P_Ein', name: 'DIHAG · Rechnungseingang (je Werk)',
      lanes: [
        { id: 'LA', name: 'Werks-Postfach & Power Automate', actor: 'auto' },
        { id: 'LB', name: 'Prüfdienst (Azure)', actor: 'api' },
        { id: 'LC', name: 'SharePoint & Monitoring', actor: 'archiv' },
        { id: 'LD', name: 'Kreditorenbuchhaltung', actor: 'mensch' },
      ],
      nodes: [
        { id: 'A_start', k: 'msgStart', n: 'Neue Mail mit Anhang im Werks-Postfach', lane: 'LA', c: 1, r: 0 },
        { id: 'A_gw', k: 'gw', n: 'Vom eigenen Postfach gesendet (Archiv-Mail)?', lane: 'LA', c: 2, r: 0 },
        { id: 'A_move', k: 'service', n: 'Archiv-Mail in den Unterordner „Verarbeitet“ verschieben', lane: 'LA', c: 3, r: 1 },
        { id: 'A_endArch', k: 'end', n: 'archiviert', lane: 'LA', c: 4, r: 1 },
        { id: 'A_att', k: 'service', n: 'Anhänge filtern: nur PDF und XML', lane: 'LA', c: 5, r: 0 },
        { id: 'B_intake', k: 'sub', n: 'Eingangsprüfung (/api/intake)', lane: 'LB', c: 6, r: 0 },
        { id: 'C_orig', k: 'service', n: 'Original in ERAR_<Werk> ablegen (Name: Nummer_USt-IdNr)', lane: 'LC', c: 7, r: 0 },
        { id: 'C_meta', k: 'service', n: 'Metadaten setzen: Typ, Konformität, Buchung, Prüf-Flags, Fälligkeit', lane: 'LC', c: 8, r: 0 },
        { id: 'C_side', k: 'sub', n: 'Nebendateien ablegen', lane: 'LC', c: 9, r: 0 },
        { id: 'A_gwErr', k: 'gw', n: 'Ergebnis rot oder falsches Werk?', lane: 'LA', c: 10, r: 0 },
        { id: 'A_errMail', k: 'send', n: 'Fehler-Mail an die Werks-Adresse', lane: 'LA', c: 11, r: 1 },
        { id: 'A_archSend', k: 'send', n: 'Archiv-Mail mit lesbarem PDF an das eigene Postfach senden', lane: 'LA', c: 12, r: 0 },
        { id: 'A_moveOrig', k: 'service', n: 'Original-Mail nach „Verarbeitet“ verschieben', lane: 'LA', c: 13, r: 0 },
        { id: 'D_gw', k: 'gw', n: 'Buchungsweg laut Prüfergebnis?', lane: 'LD', c: 14, r: 0, lp: 'below' },
        { id: 'D_book', k: 'manual', n: 'Aus der XML im ERP erfassen und buchen', lane: 'LD', c: 15, r: 0 },
        { id: 'D_4eyes', k: 'user', n: 'Vier-Augen-Prüfung (Reverse-Charge, innergem., steuerfrei)', lane: 'LD', c: 15, r: 1, tone: 'warn' },
        { id: 'D_vorb', k: 'manual', n: 'Unter Vorbehalt buchen (sonstige Rechnung)', lane: 'LD', c: 15, r: 2, tone: 'warn' },
        { id: 'D_rej', k: 'user', n: 'Nicht buchen, Zurückweisung vorbereiten', lane: 'LD', c: 15, r: 3, tone: 'err' },
        { id: 'D_gwRf', k: 'gw', n: 'Rückfrage-Flag gesetzt?', lane: 'LD', c: 16, r: 0 },
        { id: 'D_join', k: 'gw', n: '', lane: 'LD', c: 16, r: 2 },
        { id: 'D_kred', k: 'send', n: 'Kreditor-Mail an den Lieferanten (Text aus „Kreditor-Aktion“)', lane: 'LD', c: 17, r: 2 },
        { id: 'E_ok', k: 'end', n: 'gebucht', lane: 'LD', c: 18, r: 0 },
        { id: 'E_kred', k: 'end', n: 'Lieferant informiert', lane: 'LD', c: 18, r: 2, tone: 'warn' },
      ],
      flows: [
        F('A_start', 'A_gw'),
        F('A_gw', 'A_move', 'ja'),
        F('A_move', 'A_endArch'),
        F('A_gw', 'A_att', 'nein'),
        F('A_att', 'B_intake'),
        F('B_intake', 'C_orig'),
        F('C_orig', 'C_meta'),
        F('C_meta', 'C_side'),
        F('C_side', 'A_gwErr'),
        F('A_gwErr', 'A_errMail', 'ja'),
        F('A_gwErr', 'A_archSend', 'nein'),
        F('A_errMail', 'A_archSend', '', { in: 'bottom' }),
        F('A_archSend', 'A_moveOrig'),
        F('A_moveOrig', 'D_gw'),
        F('D_gw', 'D_book', 'Automatik'),
        F('D_gw', 'D_4eyes', 'manuell'),
        F('D_gw', 'D_vorb', 'unter Vorbehalt'),
        F('D_gw', 'D_rej', 'zurückgewiesen'),
        F('D_4eyes', 'D_book', 'freigegeben'),
        F('D_book', 'D_gwRf'),
        F('D_gwRf', 'E_ok', 'nein'),
        F('D_gwRf', 'D_join', 'ja: Rückfrage'),
        F('D_vorb', 'D_join', 'Berichtigung'),
        F('D_rej', 'D_join', 'Zurückweisung'),
        F('D_join', 'D_kred'),
        F('D_kred', 'E_kred'),
      ],
      annotations: [
        { id: 'N_arch', of: 'A_move', lane: 'LA', c: 3, r: 2, w: 300, h: 62,
          text: 'Schleifenschutz: Die Archiv-Mail mit dem lesbaren PDF kommt selbst wieder hier an. Absender ist das eigene Postfach, darum wird sie nur einsortiert.' },
        { id: 'N_err', of: 'A_errMail', lane: 'LA', c: 11, r: 2, w: 250, h: 56,
          text: 'Eigener Flow „Fehler melden“. Die Adresse je Werk steht unter Einstellungen.' },
        { id: 'N_kred', of: 'D_kred', lane: 'LD', c: 17, r: 3, w: 250, h: 56, tone: 'plan',
          text: 'Automatischer Versand ist geplant. Bis dahin schickt die Buchhaltung die Mail selbst.' },
      ],
      groups: [
        { id: 'G_anhang', label: 'wiederholt sich je Anhang (PDF oder XML)',
          members: ['A_att', 'B_intake', 'C_orig', 'C_meta', 'C_side', 'A_gwErr', 'A_errMail', 'A_archSend', 'N_err'] },
      ],
      subs: {
        B_intake: {
          actor: 'api',
          nodes: [
            // Band 1: Art erkennen und validieren
            { id: 'I_start', k: 'start', n: 'Anhang vom Flow', c: 0, r: 2 },
            { id: 'I_norm', k: 'service', n: 'Inhalt erkennen: PDF, XML, base64 oder Flow-Hülle', c: 1, r: 2 },
            { id: 'I_gwTyp', k: 'gw', n: 'PDF oder XML?', c: 2, r: 2 },
            { id: 'I_pdfa', k: 'service', n: 'veraPDF prüft die PDF/A-Hülle', c: 3, r: 2 },
            { id: 'I_extract', k: 'service', n: 'Eingebettete XML suchen', c: 4, r: 2 },
            { id: 'I_gwEinv', k: 'gw', n: 'Echte E-Rechnung (CII oder UBL) eingebettet?', c: 5, r: 2 },
            { id: 'I_sonst', k: 'service', n: 'Sonstige Rechnung: unter Vorbehalt, Berichtigung anfordern', c: 6, r: 1, tone: 'warn' },
            { id: 'I_endSonst', k: 'end', n: 'Ergebnis: sonstige Rechnung', c: 7, r: 1, tone: 'warn' },
            { id: 'I_zf', k: 'service', n: 'Typ: ZUGFeRD', c: 6, r: 2 },
            { id: 'I_mustang', k: 'service', n: 'Mustang prüft das tatsächliche Profil (mit Prüfbericht)', c: 7, r: 2 },
            { id: 'I_gwMin', k: 'gw', n: 'Profil MINIMUM oder BASIC-WL?', c: 8, r: 2 },
            { id: 'I_rej', k: 'service', n: 'Harter Stopp: keine E-Rechnung, Zurückweisung', c: 9, r: 1, tone: 'err' },
            { id: 'I_endRej', k: 'end', n: 'Ergebnis: zurückgewiesen', c: 10, r: 1, tone: 'err' },
            { id: 'I_gwPdfa', k: 'gw', n: 'PDF/A-3 in Ordnung?', c: 9, r: 2 },
            { id: 'I_fm', k: 'service', n: 'Formatmangel: unter Vorbehalt, Berichtigung anfordern', c: 10, r: 3, tone: 'warn' },
            { id: 'I_join1', k: 'gw', n: '', c: 11, r: 2 },
            { id: 'I_xr', k: 'service', n: 'Typ: XRechnung (reine XML)', c: 3, r: 4 },
            { id: 'I_kosit', k: 'service', n: 'KoSIT prüft XRechnung / EN 16931 (mit Prüfbericht)', c: 4, r: 4 },
            { id: 'I_linkOut', k: 'linkThrow', n: 'weiter: Regelwerk', link: 'Regelwerk', c: 12, r: 2 },
            // Band 2: Kopfdaten und Regelwerk
            { id: 'I_linkIn', k: 'linkCatch', n: 'weiter: Regelwerk', link: 'Regelwerk', c: 0, r: 8 },
            { id: 'I_daten', k: 'service', n: 'Kopfdaten lesen: Nummer, Datum, Beträge, Steuerkategorie', c: 1, r: 8 },
            { id: 'I_werk', k: 'service', n: 'Richtung und Werk bestimmen, Empfänger-Gegenprobe', c: 2, r: 8 },
            { id: 'I_gwSt', k: 'gw', n: 'Steuerkategorie AE, K, G, E oder O?', c: 3, r: 8 },
            { id: 'I_man', k: 'service', n: 'Manuelle Prüfung nötig (Vier-Augen), Buchung „manuell“', c: 4, r: 9, tone: 'warn' },
            { id: 'I_join2', k: 'gw', n: '', c: 5, r: 8 },
            { id: 'I_gwZf', k: 'gw', n: 'Quelle ZUGFeRD?', c: 6, r: 8 },
            { id: 'I_abgl', k: 'service', n: 'PDF und XML abgleichen: Nummer, Steuer, Brutto (rundungstolerant)', c: 7, r: 8 },
            { id: 'I_gwMat', k: 'gw', n: 'Materielle Abweichung?', c: 8, r: 8 },
            { id: 'I_rf', k: 'service', n: 'Rückfrage beim Lieferanten, die XML bleibt maßgeblich', c: 9, r: 9, tone: 'warn' },
            { id: 'I_join3', k: 'gw', n: '', c: 10, r: 8 },
            { id: 'I_gwRend', k: 'gw', n: 'XRechnung-XML oder Formatmangel?', c: 11, r: 8 },
            { id: 'I_render', k: 'service', n: 'Lesbares PDF/A-3b aus der XML erzeugen', c: 12, r: 9 },
            { id: 'I_join4', k: 'gw', n: '', c: 13, r: 8 },
            { id: 'I_end', k: 'end', n: 'Prüfergebnis an den Flow (JSON)', c: 14, r: 8 },
          ],
          flows: [
            F('I_start', 'I_norm'), F('I_norm', 'I_gwTyp'),
            F('I_gwTyp', 'I_pdfa', 'PDF'), F('I_gwTyp', 'I_xr', 'XML'),
            F('I_pdfa', 'I_extract'), F('I_extract', 'I_gwEinv'),
            F('I_gwEinv', 'I_zf', 'ja'), F('I_gwEinv', 'I_sonst', 'nein oder fremde XML'),
            F('I_sonst', 'I_endSonst'),
            F('I_zf', 'I_mustang'), F('I_mustang', 'I_gwMin'),
            F('I_gwMin', 'I_rej', 'ja'), F('I_rej', 'I_endRej'),
            F('I_gwMin', 'I_gwPdfa', 'nein'),
            F('I_gwPdfa', 'I_join1', 'ja'), F('I_gwPdfa', 'I_fm', 'nein'),
            F('I_fm', 'I_join1'),
            F('I_xr', 'I_kosit'), F('I_kosit', 'I_join1'),
            F('I_join1', 'I_linkOut'),
            F('I_linkIn', 'I_daten'), F('I_daten', 'I_werk'), F('I_werk', 'I_gwSt'),
            F('I_gwSt', 'I_man', 'ja'), F('I_gwSt', 'I_join2', 'nein'), F('I_man', 'I_join2'),
            F('I_join2', 'I_gwZf'),
            F('I_gwZf', 'I_abgl', 'ja'), F('I_gwZf', 'I_join3', 'nein', { via: 'above', gap: 72 }),
            F('I_abgl', 'I_gwMat'),
            F('I_gwMat', 'I_rf', 'ja'), F('I_gwMat', 'I_join3', 'nein'), F('I_rf', 'I_join3'),
            F('I_join3', 'I_gwRend'),
            F('I_gwRend', 'I_render', 'ja'), F('I_gwRend', 'I_join4', 'nein'), F('I_render', 'I_join4'),
            F('I_join4', 'I_end'),
          ],
          annotations: [
            { id: 'IN_sonst', of: 'I_sonst', c: 6, r: 0, w: 330, h: 72,
              text: 'Auch fremde XML (z. B. openTRANS) zählt nicht als E-Rechnung. Übergang: sonstige Rechnungen sind bis 31.12.2026 zulässig, bei Vorjahresumsatz bis 800.000 € bis 31.12.2027.' },
            { id: 'IN_kosit', of: 'I_kosit', c: 3, r: 5, w: 320, h: 56,
              text: 'Nur formale Verstöße (Leitweg-ID, elektronische Adresse) sind Hinweise und werten nicht ab.' },
            { id: 'IN_werk', of: 'I_werk', c: 1, r: 7, w: 300, h: 56,
              text: 'Ist eine DIHAG-Gesellschaft Verkäufer, gilt die Rechnung als Ausgang (Ablage in AR_<Werk>).' },
          ],
        },
        C_side: {
          actor: 'archiv',
          nodes: [
            { id: 'S_start', k: 'start', n: 'Prüfergebnis liegt vor', c: 0, r: 2 },
            { id: 'S_split', k: 'gwInc', n: 'Was liegt vor?', c: 1, r: 2 },
            { id: 'S_lesbar', k: 'service', n: 'Lesbares PDF als _lesbar.pdf ablegen', c: 2, r: 1 },
            { id: 'S_kosit', k: 'service', n: 'Prüfbericht als _KoSIT-Bericht.xml ablegen', c: 2, r: 2 },
            { id: 'S_xml', k: 'service', n: 'XML separat ablegen', c: 2, r: 3 },
            { id: 'S_join', k: 'gwInc', n: '', c: 3, r: 2 },
            { id: 'S_end', k: 'end', n: 'Nebendateien abgelegt', c: 4, r: 2 },
          ],
          flows: [
            F('S_start', 'S_split'),
            F('S_split', 'S_lesbar', 'lesbares PDF'), F('S_split', 'S_kosit', 'Prüfbericht'), F('S_split', 'S_xml', 'nur ZUGFeRD'),
            F('S_lesbar', 'S_join'), F('S_kosit', 'S_join'), F('S_xml', 'S_join'),
            F('S_join', 'S_end'),
          ],
          annotations: [
            { id: 'SN_lesbar', of: 'S_lesbar', c: 2, r: 0, w: 280, h: 56,
              text: 'Entsteht bei XRechnung-XML und bei ZUGFeRD mit Formatmangel. Das Original bleibt immer erhalten.' },
            { id: 'SN_xml', of: 'S_xml', c: 2, r: 4, w: 280, h: 56,
              text: 'Bei reiner XRechnung ist das Original schon die XML, darum keine zweite Datei.' },
          ],
        },
      },
    },
  ],
  messages: [
    { from: 'L_send', to: 'A_start', name: 'Rechnung (PDF oder XML)' },
    { from: 'D_kred', to: 'P_Lief', name: 'Berichtigung, Rückfrage oder Zurückweisung' },
  ],
};

const AUSGANG = {
  file: '02-rechnungsausgang.bpmn',
  id: 'Ausgang',
  pools: [
    {
      id: 'P_Kunde', name: 'Kunde', actor: 'extern',
      nodes: [
        { id: 'Ku_recv', k: 'msgStart', n: 'E-Rechnung empfangen', c: 10, r: 0, lp: 'above' },
        { id: 'Ku_end', k: 'end', n: 'Rechnung liegt beim Kunden', c: 11, r: 0 },
      ],
      flows: [F('Ku_recv', 'Ku_end')],
    },
    {
      id: 'P_Aus', name: 'DIHAG · Rechnungsausgang (je Werk)',
      lanes: [
        { id: 'LV', name: 'Versand / Lager', actor: 'erp' },
        { id: 'LF', name: 'Vertrieb / Fakturierung', actor: 'mensch', rows: 2 },
        { id: 'LK', name: 'Konverter (Browser-App)', actor: 'app', rows: 2 },
        { id: 'LS', name: 'SharePoint & Monitoring', actor: 'archiv' },
      ],
      nodes: [
        { id: 'V_start', k: 'start', n: 'Ware ist versandbereit', lane: 'LV', c: 0, r: 0 },
        { id: 'V_wa', k: 'manual', n: 'Warenausgang buchen', lane: 'LV', c: 1, r: 0 },
        { id: 'F_fakt', k: 'user', n: 'Faktura im ERP anlegen und PDF erzeugen', lane: 'LF', c: 2, r: 0 },
        { id: 'F_gwSap', k: 'gw', n: 'SAP-Werk?', lane: 'LF', c: 3, r: 0 },
        { id: 'F_edi', k: 'service', n: 'E-Rechnung über EDIzone (eigener SAP-Prozess)', lane: 'LF', c: 4, r: 0, tone: 'plan' },
        { id: 'F_endEdi', k: 'end', n: 'über SAP versendet', lane: 'LF', c: 5, r: 0 },
        { id: 'K_upload', k: 'user', n: 'PDF in den Konverter laden', lane: 'LK', c: 4, r: 0 },
        { id: 'K_erk', k: 'sub', n: 'Erkennen und erfassen', lane: 'LK', c: 5, r: 0 },
        { id: 'K_exp', k: 'sub', n: 'Prüfen und E-Rechnung erzeugen', lane: 'LK', c: 6, r: 0 },
        { id: 'K_bErr', k: 'boundaryErr', n: 'Prüfung nicht bestanden', lane: 'LK', attachedTo: 'K_exp' },
        { id: 'K_fix', k: 'user', n: 'Daten korrigieren', lane: 'LK', c: 5, r: 1, tone: 'warn' },
        { id: 'S_abl', k: 'service', n: 'In AR_<Werk> ablegen: E-Rechnung, lesbares PDF, Prüfpfad', lane: 'LS', c: 7, r: 0 },
        { id: 'S_meta', k: 'service', n: 'Metadaten setzen: Ausgang, Format, konform, GoBD', lane: 'LS', c: 8, r: 0 },
        { id: 'K_mail', k: 'user', n: 'Mail-Entwurf mit Anhang erstellen (Outlook oder .eml)', lane: 'LK', c: 9, r: 0 },
        { id: 'F_send', k: 'send', n: 'Rechnung an den Kunden senden', lane: 'LF', c: 10, r: 0 },
        { id: 'F_end', k: 'end', n: 'versendet', lane: 'LF', c: 11, r: 0 },
      ],
      flows: [
        F('V_start', 'V_wa'),
        F('V_wa', 'F_fakt'),
        F('F_fakt', 'F_gwSap'),
        F('F_gwSap', 'F_edi', 'ja'),
        F('F_edi', 'F_endEdi'),
        F('F_gwSap', 'K_upload', 'nein'),
        F('K_upload', 'K_erk'),
        F('K_erk', 'K_exp'),
        F('K_bErr', 'K_fix'),
        F('K_fix', 'K_erk', 'erneut'),
        F('K_exp', 'S_abl'),
        F('S_abl', 'S_meta'),
        F('S_meta', 'K_mail'),
        F('K_mail', 'F_send'),
        F('F_send', 'F_end'),
      ],
      annotations: [
        { id: 'N_edi', of: 'F_edi', lane: 'LF', c: 4, r: 1, w: 250, h: 56, tone: 'plan',
          text: 'SAP-Werke laufen über EDIzone, nicht über dieses Tool.' },
        { id: 'N_mail', of: 'K_mail', lane: 'LK', c: 9, r: 1, w: 260, h: 56,
          text: 'Alternativ Datei herunterladen und über das Kundenportal hochladen.' },
      ],
      subs: {
        K_erk: {
          actor: 'app',
          nodes: [
            { id: 'E_start', k: 'start', n: 'PDF hochgeladen', c: 0, r: 1 },
            { id: 'E_gwText', k: 'gw', n: 'Textebene vorhanden?', c: 1, r: 1 },
            { id: 'E_ocr', k: 'service', n: 'Texterkennung (OCR)', c: 2, r: 2 },
            { id: 'E_join1', k: 'gw', n: '', c: 3, r: 1 },
            { id: 'E_werk', k: 'service', n: 'Werk erkennen, passenden Rechnungs-Parser wählen', c: 4, r: 1 },
            { id: 'E_fill', k: 'service', n: 'Felder vorbefüllen, Verkäufer-Stammdaten sperren', c: 5, r: 1 },
            { id: 'E_check', k: 'user', n: 'Daten prüfen und ergänzen (Belegart, Leitweg-ID, Lieferschein)', c: 6, r: 1 },
            { id: 'E_gwEU', k: 'gw', n: 'Kunde im EU-Ausland mit USt-IdNr?', c: 7, r: 1 },
            { id: 'E_vat', k: 'service', n: 'Qualifizierte USt-IdNr-Prüfung (BZSt / VIES), Nachweis sichern', c: 8, r: 2 },
            { id: 'E_join2', k: 'gw', n: '', c: 9, r: 1 },
            { id: 'E_fmt', k: 'user', n: 'Format wählen: ZUGFeRD (Standard) oder XRechnung', c: 10, r: 1 },
            { id: 'E_end', k: 'end', n: 'Daten vollständig', c: 11, r: 1 },
          ],
          flows: [
            F('E_start', 'E_gwText'),
            F('E_gwText', 'E_join1', 'ja'), F('E_gwText', 'E_ocr', 'nein, Scan'), F('E_ocr', 'E_join1'),
            F('E_join1', 'E_werk'), F('E_werk', 'E_fill'), F('E_fill', 'E_check'), F('E_check', 'E_gwEU'),
            F('E_gwEU', 'E_join2', 'nein'), F('E_gwEU', 'E_vat', 'ja'), F('E_vat', 'E_join2'),
            F('E_join2', 'E_fmt'), F('E_fmt', 'E_end'),
          ],
          annotations: [
            { id: 'EN_werk', of: 'E_werk', c: 4, r: 0, w: 160, h: 62,
              text: 'Eigene Parser: WGC, SHB, ZAI. Weitere Werke folgen.' },
            { id: 'EN_fill', of: 'E_fill', c: 5, r: 0, w: 160, h: 62,
              text: 'Entsperren nur bewusst, es landet im Prüfpfad.' },
            { id: 'EN_fmt', of: 'E_fmt', c: 10, r: 0, w: 170, h: 72,
              text: 'Standard ist ZUGFeRD. XRechnung z. B. für öffentliche Auftraggeber mit Leitweg-ID.' },
          ],
        },
        K_exp: {
          actor: 'app',
          nodes: [
            { id: 'X_start', k: 'start', n: 'Export angestoßen', c: 0, r: 1 },
            { id: 'X_pflicht', k: 'service', n: 'Pflichtfelder prüfen', c: 1, r: 1 },
            { id: 'X_pre', k: 'service', n: 'Vorabprüfung: IBAN-Prüfziffer, Summen, USt-IdNr-Format', c: 2, r: 1 },
            { id: 'X_gwHard', k: 'gw', n: 'Harter Fehler?', c: 3, r: 1 },
            { id: 'X_err1', k: 'errEnd', n: 'Prüfung nicht bestanden', c: 4, r: 0 },
            { id: 'X_gwSoft', k: 'gw', n: 'Abweichung zum Original-PDF?', c: 4, r: 1 },
            { id: 'X_confirm', k: 'user', n: 'Warnung ansehen: fortfahren oder abbrechen', c: 5, r: 2, tone: 'warn' },
            { id: 'X_join1', k: 'gw', n: '', c: 6, r: 1 },
            { id: 'X_xml', k: 'service', n: 'XML nach EN 16931 erzeugen', c: 7, r: 1 },
            { id: 'X_self', k: 'service', n: 'Selbstprüfung: XML zurücklesen und vergleichen', c: 8, r: 1 },
            { id: 'X_gwSelf', k: 'gw', n: 'Abweichung?', c: 9, r: 1 },
            { id: 'X_err2', k: 'errEnd', n: 'Selbstprüfung fehlgeschlagen', c: 10, r: 0 },
            { id: 'X_gwFmt', k: 'gw', n: 'Format?', c: 10, r: 1 },
            { id: 'X_zf', k: 'service', n: 'ZUGFeRD: PDF/A-3b mit eingebetteter XML', c: 11, r: 1 },
            { id: 'X_xr', k: 'service', n: 'XRechnung-XML plus lesbares PDF', c: 11, r: 2 },
            { id: 'X_join2', k: 'gw', n: '', c: 12, r: 1 },
            { id: 'X_audit', k: 'service', n: 'Prüfpfad: Hash, manuelle Änderungen, Prüfer', c: 13, r: 1 },
            { id: 'X_dl', k: 'service', n: 'Dateien herunterladen', c: 14, r: 1 },
            { id: 'X_end', k: 'end', n: 'E-Rechnung erstellt', c: 15, r: 1 },
          ],
          flows: [
            F('X_start', 'X_pflicht'), F('X_pflicht', 'X_pre'), F('X_pre', 'X_gwHard'),
            F('X_gwHard', 'X_err1', 'ja'), F('X_gwHard', 'X_gwSoft', 'nein'),
            F('X_gwSoft', 'X_join1', 'nein'), F('X_gwSoft', 'X_confirm', 'ja'), F('X_confirm', 'X_join1', 'fortfahren'),
            F('X_join1', 'X_xml'), F('X_xml', 'X_self'), F('X_self', 'X_gwSelf'),
            F('X_gwSelf', 'X_err2', 'ja'), F('X_gwSelf', 'X_gwFmt', 'nein'),
            F('X_gwFmt', 'X_zf', 'ZUGFeRD'), F('X_gwFmt', 'X_xr', 'XRechnung'),
            F('X_zf', 'X_join2'), F('X_xr', 'X_join2'),
            F('X_join2', 'X_audit'), F('X_audit', 'X_dl'), F('X_dl', 'X_end'),
          ],
          annotations: [
            { id: 'XN_pre', of: 'X_pre', c: 2, r: 0, w: 160, h: 72,
              text: 'Harte Fehler: IBAN-Prüfziffer falsch, Summe nicht plausibel, Netto + MwSt ≠ Brutto.' },
            { id: 'XN_confirm', of: 'X_confirm', c: 5, r: 3, w: 260, h: 56,
              text: '„Abbrechen“ beendet den Export, es entsteht keine Datei.' },
            { id: 'XN_zf', of: 'X_zf', c: 11, r: 0, w: 170, h: 72,
              text: 'Standard: Das PDF wird aus den Rechnungsdaten erzeugt, PDF und XML sind identisch.' },
          ],
        },
      },
    },
  ],
  messages: [
    { from: 'F_send', to: 'Ku_recv', name: 'E-Rechnung (ZUGFeRD oder XRechnung)' },
  ],
};

const ZAHLUNG = {
  file: '03-zahlungsausgang-mc-converter.bpmn',
  id: 'Zahlung',
  pools: [
    {
      id: 'P_Zahl', name: 'DIHAG · Zahlungslauf (je Werk)',
      lanes: [
        { id: 'LE', name: 'ERP / MultiCash', actor: 'erp' },
        { id: 'LM', name: 'MC-Converter (Browser-App)', actor: 'app', rows: 2 },
        { id: 'LT', name: 'Treasury / Buchhaltung', actor: 'mensch' },
      ],
      nodes: [
        { id: 'Z_start', k: 'start', n: 'Zahllauf ist fällig', lane: 'LE', c: 0, r: 0 },
        { id: 'Z_vor', k: 'user', n: 'Zahlungsvorschlag erstellen und freigeben', lane: 'LE', c: 1, r: 0 },
        { id: 'Z_exp', k: 'service', n: 'SEPA-Datei exportieren (pain.001.003.03 oder 001.001.03)', lane: 'LE', c: 2, r: 0 },
        { id: 'M_load', k: 'user', n: 'Datei in den MC-Converter laden (Endung egal)', lane: 'LM', c: 3, r: 0 },
        { id: 'M_conv', k: 'sub', n: 'Auf pain.001.001.09 umstellen', lane: 'LM', c: 4, r: 0 },
        { id: 'M_pre', k: 'sub', n: 'SEPA-Preflight', lane: 'LM', c: 5, r: 0 },
        { id: 'M_gw', k: 'gw', n: 'Preflight grün?', lane: 'LM', c: 6, r: 0 },
        { id: 'T_fix', k: 'user', n: 'Ursache im ERP oder in MultiCash korrigieren', lane: 'LT', c: 6, r: 0, tone: 'warn' },
        { id: 'M_dl', k: 'service', n: 'pain.001.001.09 herunterladen', lane: 'LM', c: 7, r: 0 },
        { id: 'T_up', k: 'user', n: 'Im Banking-Portal oder per EBICS hochladen, Vier-Augen-Freigabe', lane: 'LT', c: 8, r: 0 },
        { id: 'T_end', k: 'end', n: 'Zahlung beauftragt', lane: 'LT', c: 9, r: 0 },
      ],
      flows: [
        F('Z_start', 'Z_vor'), F('Z_vor', 'Z_exp'),
        F('Z_exp', 'M_load'),
        F('M_load', 'M_conv'), F('M_conv', 'M_pre'), F('M_pre', 'M_gw'),
        F('M_gw', 'M_dl', 'ja'),
        F('M_gw', 'T_fix', 'nein'),
        F('T_fix', 'Z_exp', 'neu exportieren', { via: 'left' }),
        F('M_dl', 'T_up'),
        F('T_up', 'T_end'),
      ],
      annotations: [
        { id: 'N_local', of: 'M_load', lane: 'LM', c: 3, r: 1, w: 280, h: 56,
          text: 'Läuft komplett im Browser. Die Zahldatei verlässt den Rechner nicht.' },
      ],
      subs: {
        M_conv: {
          actor: 'app',
          nodes: [
            { id: 'U_start', k: 'start', n: 'Datei geladen', c: 0, r: 1 },
            { id: 'U_ns', k: 'service', n: 'Nachrichtentyp erkennen (Namespace)', c: 1, r: 1 },
            { id: 'U_gw', k: 'gw', n: 'SEPA-Überweisung (pain.001)?', c: 2, r: 1 },
            { id: 'U_stop', k: 'end', n: 'Abbruch: keine Überweisung, z. B. Lastschrift pain.008', c: 3, r: 0, tone: 'err' },
            { id: 'U_struct', k: 'service', n: 'Struktur umstellen: Datum als <Dt>, BIC als <BICFI>, Sammelbuchung', c: 3, r: 1 },
            { id: 'U_strip', k: 'service', n: 'Adressen und Konto-Währung entfernen (IBAN genügt)', c: 4, r: 1 },
            { id: 'U_sum', k: 'service', n: 'Anzahl und Kontrollsumme aus den Posten neu berechnen', c: 5, r: 1 },
            { id: 'U_clean', k: 'service', n: 'SEPA-Zeichensatz erzwingen, Verwendungszweck max. 140 Zeichen', c: 6, r: 1 },
            { id: 'U_end', k: 'end', n: 'pain.001.001.09 erzeugt', c: 7, r: 1 },
          ],
          flows: [
            F('U_start', 'U_ns'), F('U_ns', 'U_gw'),
            F('U_gw', 'U_stop', 'nein'), F('U_gw', 'U_struct', 'ja'),
            F('U_struct', 'U_strip'), F('U_strip', 'U_sum'), F('U_sum', 'U_clean'), F('U_clean', 'U_end'),
          ],
          annotations: [
            { id: 'UN_ns', of: 'U_ns', c: 1, r: 2, w: 160, h: 72,
              text: 'Liest über die Elementnamen, egal ob 001.003.03 oder 001.001.03.' },
            { id: 'UN_struct', of: 'U_struct', c: 3, r: 2, w: 280, h: 56,
              text: 'Im Reiter umschaltbar: Sammelbuchung, InstrId übernehmen, Zeichensatz.' },
          ],
        },
        M_pre: {
          actor: 'app',
          nodes: [
            { id: 'P_start', k: 'start', n: 'umgestellte Datei', c: 0, r: 2 },
            { id: 'P_split', k: 'gwPar', n: '', c: 1, r: 2 },
            { id: 'P_iban', k: 'service', n: 'IBAN-Prüfziffer (Mod-97) je Konto', c: 2, r: 0 },
            { id: 'P_bic', k: 'service', n: 'BIC-Format', c: 2, r: 1 },
            { id: 'P_sum', k: 'service', n: 'Anzahl und Kontrollsumme gleich den Posten', c: 2, r: 2 },
            { id: 'P_txt', k: 'service', n: 'EUR, SEPA-Zeichensatz, Feldlängen', c: 2, r: 3 },
            { id: 'P_date', k: 'service', n: 'Ausführungsdatum', c: 2, r: 4 },
            { id: 'P_join', k: 'gwPar', n: '', c: 3, r: 2 },
            { id: 'P_gw', k: 'gw', n: 'Fehler gefunden?', c: 4, r: 2 },
            { id: 'P_green', k: 'end', n: 'grün: bankfertig', c: 5, r: 2 },
            { id: 'P_red', k: 'end', n: 'rot: nicht bankfertig', c: 5, r: 3, tone: 'err' },
          ],
          flows: [
            F('P_start', 'P_split'),
            F('P_split', 'P_iban'), F('P_split', 'P_bic'), F('P_split', 'P_sum'), F('P_split', 'P_txt'), F('P_split', 'P_date'),
            F('P_iban', 'P_join'), F('P_bic', 'P_join'), F('P_sum', 'P_join'), F('P_txt', 'P_join'), F('P_date', 'P_join'),
            F('P_join', 'P_gw'),
            F('P_gw', 'P_green', 'nein'), F('P_gw', 'P_red', 'ja'),
          ],
          annotations: [
            { id: 'PN_date', of: 'P_date', c: 2, r: 5, w: 300, h: 56,
              text: 'Ein Datum in der Vergangenheit ist nur ein Hinweis. Die Bank bucht am nächsten Bankarbeitstag.' },
          ],
        },
      },
    },
    {
      id: 'P_Bank', name: 'Hausbank', actor: 'extern',
      nodes: [
        { id: 'H_recv', k: 'msgStart', n: 'Zahlungsauftrag erhalten', c: 8, r: 0 },
        { id: 'H_exec', k: 'service', n: 'Überweisungen ausführen', c: 9, r: 0 },
        { id: 'H_end', k: 'end', n: 'ausgeführt', c: 10, r: 0 },
      ],
      flows: [F('H_recv', 'H_exec'), F('H_exec', 'H_end')],
    },
  ],
  messages: [
    { from: 'T_up', to: 'H_recv', name: 'pain.001.001.09' },
  ],
};

const PROZESSE = [EINGANG, AUSGANG, ZAHLUNG];

/* ═════════════════════════════════════════════════════════════════════════
 *  LAYOUT
 * ═════════════════════════════════════════════════════════════════════════ */

function placeNode(n, cx, cy) {
  const [w, h] = sizeOf(n.k);
  n.b = { x: rnd(cx - w / 2), y: rnd(cy - h / 2), w, h };
}

/** Pools/Bahnen des Hauptdiagramms anordnen und Knoten platzieren. */
function layoutMain(spec) {
  const N = {};
  let maxCol = 0;
  for (const p of spec.pools) {
    for (const n of p.nodes) if (n.c != null) maxCol = Math.max(maxCol, n.c);
    for (const a of p.annotations || []) maxCol = Math.max(maxCol, a.c + Math.ceil((a.w || 160) / COL_W) - 1);
  }
  const width = (CONTENT_X - POOL_X) + (maxCol + 1) * COL_W + 30;
  let y = TOP;
  for (const p of spec.pools) {
    p.x = POOL_X; p.y = y; p.w = width; p.laneGeo = [];
    const defs = p.lanes || [{ id: null, actor: p.actor }];
    for (const ld of defs) {
      const inLane = o => (p.lanes ? o.lane === ld.id : true);
      let rows = ld.rows || 1;
      for (const n of p.nodes) if (inLane(n) && n.r != null) rows = Math.max(rows, n.r + 1);
      for (const a of p.annotations || []) if (inLane(a)) rows = Math.max(rows, a.r + 1);
      const h = rows * ROW_H + 20;
      p.laneGeo.push({ ...ld, x: POOL_X + POOL_HEAD, y, w: width - POOL_HEAD, h });
      y += h;
    }
    p.h = y - p.y;
    y += POOL_GAP;
    const laneOf = o => (p.lanes ? p.laneGeo.find(l => l.id === o.lane) : p.laneGeo[0]);
    p.colLeft = c => CONTENT_X + c * COL_W;
    p.rowTop = (o, r) => laneOf(o).y + 10 + r * ROW_H;
    for (const n of p.nodes) {
      if (n.k === 'boundaryErr') continue;
      const lane = laneOf(n);
      if (!lane) throw new Error(`Bahn "${n.lane}" für ${n.id} fehlt`);
      n.pool = p; n.actor = lane.actor || p.actor;
      placeNode(n, CONTENT_X + n.c * COL_W + COL_W / 2, lane.y + 10 + n.r * ROW_H + ROW_H / 2);
      N[n.id] = n;
    }
    for (const n of p.nodes.filter(x => x.k === 'boundaryErr')) {
      const h = N[n.attachedTo];
      n.pool = p; n.actor = h.actor;
      placeNode(n, R(h.b) - 28, B(h.b));
      N[n.id] = n;
    }
  }
  return N;
}

/** Ebene eines zugeklappten Unterprozesses: nur Raster, keine Bahnen. */
function layoutPlane(sub) {
  const N = {};
  sub.colLeft = c => PLANE_X + c * COL_W;
  sub.rowTop = (o, r) => PLANE_Y + r * ROW_H;
  for (const n of sub.nodes) {
    n.actor = sub.actor;
    placeNode(n, PLANE_X + n.c * COL_W + COL_W / 2, PLANE_Y + n.r * ROW_H + ROW_H / 2);
    N[n.id] = n;
  }
  return N;
}

function checkOverlaps(nodes, where) {
  const seen = new Map();
  for (const n of nodes) {
    if (n.k === 'boundaryErr') continue;
    const key = `${n.lane || ''}|${n.c}|${n.r}`;
    if (seen.has(key)) throw new Error(`${where}: ${n.id} liegt auf demselben Rasterplatz wie ${seen.get(key)}`);
    seen.set(key, n.id);
  }
}

/* ── Kanten führen (orthogonal) ───────────────────────────────────────── */

function route(f, N, inCnt, outCnt) {
  const s = N[f.from], t = N[f.to];
  if (!s || !t) throw new Error(`Fluss ${f.from} -> ${f.to}: Knoten fehlt`);
  const sb = s.b, tb = t.b, o = f.o;
  const sx = CX(sb), sy = CY(sb), tx = CX(tb), ty = CY(tb);
  if (o.via === 'above' || o.via === 'below') {
    const up = o.via === 'above';
    const g = o.gap || 28;
    const yv = up ? Math.min(sb.y, tb.y) - g : Math.max(B(sb), B(tb)) + g;
    return [[sx, up ? sb.y : B(sb)], [sx, yv], [tx, yv], [tx, up ? tb.y : B(tb)]];
  }
  if (o.via === 'left') return [[sb.x, sy], [tx, sy], [tx, ty < sy ? B(tb) : tb.y]];
  if (s.k === 'boundaryErr') return [[sx, B(sb)], [sx, ty], [tx < sx ? R(tb) : tb.x, ty]];

  const sameRow = Math.abs(sy - ty) < 1, sameCol = Math.abs(sx - tx) < 1;
  if (sameRow) {
    if (tx > sx) return [[R(sb), sy], [tb.x, ty]];
    const yv = Math.max(B(sb), B(tb)) + 28;
    return [[sx, B(sb)], [sx, yv], [tx, yv], [tx, B(tb)]];
  }
  if (sameCol) return ty > sy ? [[sx, B(sb)], [tx, tb.y]] : [[sx, sb.y], [tx, B(tb)]];

  const split = isGw(s) && outCnt[s.id] > 1;
  const join = isGw(t) && inCnt[t.id] > 1;
  if (tx > sx) {
    if (split) return [[sx, ty < sy ? sb.y : B(sb)], [sx, ty], [tb.x, ty]];
    if (o.in || join) {
      const fromBelow = o.in ? o.in === 'bottom' : ty < sy;
      return [[R(sb), sy], [tx, sy], [tx, fromBelow ? B(tb) : tb.y]];
    }
    const mx = rnd((R(sb) + tb.x) / 2);
    return [[R(sb), sy], [mx, sy], [mx, ty], [tb.x, ty]];
  }
  // Rücksprung nach links in eine andere Zeile: außen herum
  const yv = ty > sy ? Math.max(B(sb), B(tb)) + 28 : Math.min(sb.y, tb.y) - 28;
  return ty > sy
    ? [[sx, B(sb)], [sx, yv], [tx, yv], [tx, B(tb)]]
    : [[sx, sb.y], [sx, yv], [tx, yv], [tx, tb.y]];
}

function labelLines(text, perLine) {
  return Math.max(1, Math.ceil(String(text).length / perLine));
}

function flowLabel(wp, name) {
  const lines = name.length > 16 ? 2 : 1;
  const w = Math.min(112, Math.max(24, rnd(name.length * 6.4 / lines) + 12));
  const h = lines === 2 ? 27 : 14;
  const [a, b] = wp;
  if (wp.length >= 3 && Math.abs(a[0] - b[0]) < 1 && Math.abs(wp[1][1] - wp[2][1]) < 1) {
    const c = wp[2];
    return { x: c[0] > b[0] ? b[0] + 8 : b[0] - w - 8, y: b[1] - h - 3, w, h };
  }
  if (Math.abs(a[1] - b[1]) < 1) return { x: b[0] > a[0] ? a[0] + 6 : a[0] - w - 6, y: a[1] - h - 3, w, h };
  return { x: a[0] + 6, y: rnd((a[1] + b[1]) / 2 - h / 2), w, h };
}

function nodeLabel(n, flows, N) {
  const b = n.b;
  if (!n.n || KIND[n.k].size === 'task') return null;
  if (isGw(n)) {
    const lines = labelLines(n.n, 16);
    const h = lines * 13 + 2, w = 96;
    let below = n.lp === 'below';
    if (!n.lp) below = flows.some(f => f.to === n.id && CY(N[f.from].b) < CY(b) - 1);
    return { x: rnd(CX(b) - 100), y: below ? B(b) + 4 : b.y - h - 4, w, h };
  }
  if (n.k === 'boundaryErr') return { x: b.x - 112, y: B(b) - 2, w: 108, h: 27 };
  const lines = labelLines(n.n, 20);
  const h = lines * 13 + 2;
  if (n.lp === 'above') return { x: rnd(CX(b) - 60), y: b.y - h - 5, w: 120, h };
  return { x: rnd(CX(b) - 60), y: B(b) + 5, w: 120, h };
}

/* ── Anmerkungen, Gruppen ─────────────────────────────────────────────── */

function placeAnnotation(a, host) {
  const w = a.w || 160, h = a.h || 56;
  a.b = { x: host.colLeft(a.c) + 10, y: rnd(host.rowTop(a, a.r) + (ROW_H - h) / 2), w, h };
}

function assocPath(nb, ab) {
  const cl = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
  const ncx = CX(nb), ncy = CY(nb);
  if (ab.y >= B(nb)) return [[ncx, B(nb)], [cl(ncx, ab.x + 12, R(ab) - 12), ab.y]];
  if (B(ab) <= nb.y) return [[ncx, nb.y], [cl(ncx, ab.x + 12, R(ab) - 12), B(ab)]];
  if (ab.x >= R(nb)) return [[R(nb), ncy], [ab.x, cl(ncy, ab.y + 8, B(ab) - 8)]];
  return [[nb.x, ncy], [R(ab), cl(ncy, ab.y + 8, B(ab) - 8)]];
}

function groupBounds(g, byId) {
  const bs = g.members.map(id => {
    const o = byId[id];
    if (!o || !o.b) throw new Error(`Gruppe ${g.id}: Mitglied ${id} fehlt`);
    return o.b;
  });
  const x = Math.min(...bs.map(b => b.x)) - 18, y = Math.min(...bs.map(b => b.y)) - 24;
  const r = Math.max(...bs.map(R)) + 18, bo = Math.max(...bs.map(B)) + 16;
  return { x, y, w: r - x, h: bo - y };
}

/* ═════════════════════════════════════════════════════════════════════════
 *  XML
 * ═════════════════════════════════════════════════════════════════════════ */

const fmtB = b => `<dc:Bounds x="${rnd(b.x)}" y="${rnd(b.y)}" width="${rnd(b.w)}" height="${rnd(b.h)}" />`;
const fmtWp = wp => wp.map(([x, y]) => `<di:waypoint x="${rnd(x)}" y="${rnd(y)}" />`).join('');
const labelXml = lb => (lb ? `<bpmndi:BPMNLabel>${fmtB(lb)}</bpmndi:BPMNLabel>` : '');

function counts(flows) {
  const inCnt = {}, outCnt = {};
  for (const f of flows) {
    outCnt[f.from] = (outCnt[f.from] || 0) + 1;
    inCnt[f.to] = (inCnt[f.to] || 0) + 1;
  }
  return { inCnt, outCnt };
}

function flowId(f) { return `Flow_${f.from}_${f.to}`; }

/** Semantik eines Knotens (inkl. eingeschachteltem Unterprozess). */
function nodeSem(n, flows, inner) {
  const K = KIND[n.k];
  const attrs = [`id="${n.id}"`];
  if (n.n) attrs.push(`name="${esc(n.n)}"`);
  if (n.k === 'boundaryErr') attrs.push(`attachedToRef="${n.attachedTo}"`, 'cancelActivity="true"');
  let body = '';
  for (const f of flows) if (f.to === n.id) body += `<bpmn:incoming>${flowId(f)}</bpmn:incoming>`;
  for (const f of flows) if (f.from === n.id) body += `<bpmn:outgoing>${flowId(f)}</bpmn:outgoing>`;
  if (K.def === 'message') body += `<bpmn:messageEventDefinition id="${n.id}_def" />`;
  if (K.def === 'error') body += `<bpmn:errorEventDefinition id="${n.id}_def" errorRef="Error_Pruefung" />`;
  if (K.def === 'link') body += `<bpmn:linkEventDefinition id="${n.id}_def" name="${esc(n.link || n.n)}" />`;
  if (inner) body += inner;
  return `      <bpmn:${K.tag} ${attrs.join(' ')}>${body}</bpmn:${K.tag}>\n`;
}

function flowsSem(flows) {
  return flows.map(f => `      <bpmn:sequenceFlow id="${flowId(f)}" sourceRef="${f.from}" targetRef="${f.to}"${f.name ? ` name="${esc(f.name)}"` : ''} />\n`).join('');
}

function artifactsSem(annotations, groups) {
  let x = '';
  for (const a of annotations || []) {
    x += `      <bpmn:textAnnotation id="${a.id}"><bpmn:text>${esc(a.text)}</bpmn:text></bpmn:textAnnotation>\n`;
    x += `      <bpmn:association id="Assoc_${a.id}" associationDirection="None" sourceRef="${a.of}" targetRef="${a.id}" />\n`;
  }
  for (const g of groups || []) x += `      <bpmn:group id="${g.id}" categoryValueRef="CV_${g.id}" />\n`;
  return x;
}

/** DI-Formen und -Kanten für eine Menge Knoten/Flüsse/Anmerkungen. */
function planeDi(nodes, flows, N, annotations, groups, byId) {
  const { inCnt, outCnt } = counts(flows);
  let x = '';
  for (const n of nodes) {
    const c = colorOf(n, n.actor);
    const extra = (n.k === 'sub' ? ' isExpanded="false"' : '') + (isGw(n) ? ' isMarkerVisible="true"' : '');
    x += `      <bpmndi:BPMNShape id="${n.id}_di" bpmnElement="${n.id}"${extra}${colorAttrs(c)}>${fmtB(n.b)}${labelXml(nodeLabel(n, flows, N))}</bpmndi:BPMNShape>\n`;
  }
  for (const f of flows) {
    const wp = route(f, N, inCnt, outCnt);
    const lb = f.name ? flowLabel(wp, f.name) : null;
    x += `      <bpmndi:BPMNEdge id="${flowId(f)}_di" bpmnElement="${flowId(f)}">${fmtWp(wp)}${labelXml(lb)}</bpmndi:BPMNEdge>\n`;
  }
  for (const a of annotations || []) {
    const c = a.tone ? TONE[a.tone] : { fill: '#FFFFFF', stroke: '#6B7280' };
    x += `      <bpmndi:BPMNShape id="${a.id}_di" bpmnElement="${a.id}"${colorAttrs(c)}>${fmtB(a.b)}</bpmndi:BPMNShape>\n`;
    x += `      <bpmndi:BPMNEdge id="Assoc_${a.id}_di" bpmnElement="Assoc_${a.id}">${fmtWp(assocPath(N[a.of].b, a.b))}</bpmndi:BPMNEdge>\n`;
  }
  for (const g of groups || []) {
    const gb = groupBounds(g, byId);
    x += `      <bpmndi:BPMNShape id="${g.id}_di" bpmnElement="${g.id}" bioc:stroke="#17509E" color:border-color="#17509E">${fmtB(gb)}`
       + `${labelXml({ x: gb.x + 10, y: gb.y + 6, w: 260, h: 14 })}</bpmndi:BPMNShape>\n`;
  }
  return x;
}

function build(spec) {
  const N = layoutMain(spec);
  const allFlows = [];
  const planes = [];
  let usesError = false;
  const categories = [];

  for (const p of spec.pools) {
    checkOverlaps(p.nodes, p.id);
    for (const a of p.annotations || []) placeAnnotation(a, p);
    for (const [subId, sub] of Object.entries(p.subs || {})) {
      const SN = layoutPlane(sub);
      checkOverlaps(sub.nodes, subId);
      for (const a of sub.annotations || []) placeAnnotation(a, sub);
      planes.push({ subId, sub, SN });
    }
  }

  // Semantik
  let collab = `  <bpmn:collaboration id="Collab_${spec.id}">\n`;
  for (const p of spec.pools) collab += `    <bpmn:participant id="${p.id}" name="${esc(p.name)}" processRef="Proc_${p.id}" />\n`;
  for (const m of spec.messages) collab += `    <bpmn:messageFlow id="Msg_${m.from}_${m.to}" name="${esc(m.name)}" sourceRef="${m.from}" targetRef="${m.to}" />\n`;
  collab += '  </bpmn:collaboration>\n';

  let procs = '';
  for (const p of spec.pools) {
    let x = `  <bpmn:process id="Proc_${p.id}" name="${esc(p.name)}" isExecutable="false">\n`;
    if (p.lanes) {
      x += `    <bpmn:laneSet id="LaneSet_${p.id}">\n`;
      for (const l of p.lanes) {
        x += `      <bpmn:lane id="${l.id}" name="${esc(l.name)}">`;
        for (const n of p.nodes.filter(n => n.lane === l.id)) x += `<bpmn:flowNodeRef>${n.id}</bpmn:flowNodeRef>`;
        x += '</bpmn:lane>\n';
      }
      x += '    </bpmn:laneSet>\n';
    }
    for (const n of p.nodes) {
      let inner = '';
      if (n.k === 'sub') {
        const sub = p.subs[n.id];
        inner = '\n' + sub.nodes.map(sn => nodeSem(sn, sub.flows)).join('') + flowsSem(sub.flows) + artifactsSem(sub.annotations) + '      ';
        if (sub.nodes.some(sn => KIND[sn.k].def === 'error')) usesError = true;
      }
      if (KIND[n.k].def === 'error') usesError = true;
      x += nodeSem(n, p.flows, inner);
    }
    x += flowsSem(p.flows);
    x += artifactsSem(p.annotations, p.groups);
    for (const g of p.groups || []) categories.push(g);
    x += '  </bpmn:process>\n';
    procs += x;
    allFlows.push(...p.flows);
  }

  // DI Hauptdiagramm
  let di = `  <bpmndi:BPMNDiagram id="Diagram_${spec.id}">\n    <bpmndi:BPMNPlane id="Plane_${spec.id}" bpmnElement="Collab_${spec.id}">\n`;
  const byId = { ...N };
  for (const p of spec.pools) for (const a of p.annotations || []) byId[a.id] = a;
  for (const p of spec.pools) {
    const a = ACTOR[p.actor] || null;
    const pc = p.lanes ? { fill: '#FFFFFF', stroke: '#1A2644' } : { fill: a.lane, stroke: a.stroke };
    di += `      <bpmndi:BPMNShape id="${p.id}_di" bpmnElement="${p.id}" isHorizontal="true"${colorAttrs(pc)}>${fmtB(p)}</bpmndi:BPMNShape>\n`;
    if (p.lanes) {
      for (const l of p.laneGeo) {
        const ac = ACTOR[l.actor];
        di += `      <bpmndi:BPMNShape id="${l.id}_di" bpmnElement="${l.id}" isHorizontal="true"${colorAttrs({ fill: ac.lane, stroke: ac.stroke })}>${fmtB(l)}</bpmndi:BPMNShape>\n`;
      }
    }
  }
  for (const p of spec.pools) di += planeDi(p.nodes, p.flows, N, p.annotations, p.groups, byId);
  // Nachrichtenflüsse
  const poolById = Object.fromEntries(spec.pools.map(p => [p.id, p]));
  for (const m of spec.messages) {
    const s = N[m.from], sb = s.b, sx = CX(sb);
    const tNode = N[m.to], tPool = poolById[m.to];
    const sp = s.pool;
    const tp = tPool || tNode.pool;
    const down = tp.y > sp.y;
    const gapMid = down ? (sp.y + sp.h + tp.y) / 2 : (tp.y + tp.h + sp.y) / 2;
    let wp;
    if (tPool) wp = [[sx, down ? B(sb) : sb.y], [sx, down ? tPool.y : tPool.y + tPool.h]];
    else {
      const tb = tNode.b, tx = CX(tb);
      const y1 = down ? B(sb) : sb.y, y2 = down ? tb.y : B(tb);
      wp = Math.abs(sx - tx) < 1 ? [[sx, y1], [tx, y2]] : [[sx, y1], [sx, gapMid], [tx, gapMid], [tx, y2]];
    }
    const lb = { x: sx + 8, y: rnd(gapMid - 14), w: 170, h: 27 };
    di += `      <bpmndi:BPMNEdge id="Msg_${m.from}_${m.to}_di" bpmnElement="Msg_${m.from}_${m.to}">${fmtWp(wp)}${labelXml(lb)}</bpmndi:BPMNEdge>\n`;
  }
  di += '    </bpmndi:BPMNPlane>\n  </bpmndi:BPMNDiagram>\n';

  // DI der Unterprozess-Ebenen
  for (const { subId, sub, SN } of planes) {
    const sById = { ...SN };
    for (const a of sub.annotations || []) sById[a.id] = a;
    di += `  <bpmndi:BPMNDiagram id="Diagram_${subId}">\n    <bpmndi:BPMNPlane id="Plane_${subId}" bpmnElement="${subId}">\n`;
    di += planeDi(sub.nodes, sub.flows, SN, sub.annotations, [], sById);
    di += '    </bpmndi:BPMNPlane>\n  </bpmndi:BPMNDiagram>\n';
  }

  let defs = '';
  if (usesError) defs += '  <bpmn:error id="Error_Pruefung" name="Prüfung nicht bestanden" errorCode="PRUEFUNG" />\n';
  for (const g of categories) defs += `  <bpmn:category id="Cat_${g.id}"><bpmn:categoryValue id="CV_${g.id}" value="${esc(g.label)}" /></bpmn:category>\n`;

  return '<?xml version="1.0" encoding="UTF-8"?>\n'
    + '<bpmn:definitions xmlns:bpmn="http://www.omg.org/spec/BPMN/20100524/MODEL" '
    + 'xmlns:bpmndi="http://www.omg.org/spec/BPMN/20100524/DI" xmlns:dc="http://www.omg.org/spec/DD/20100524/DC" '
    + 'xmlns:di="http://www.omg.org/spec/DD/20100524/DI" xmlns:bioc="http://bpmn.io/schema/bpmn/biocolor/1.0" '
    + 'xmlns:color="http://www.omg.org/spec/BPMN/non-normative/color/1.0" '
    + `id="Definitions_${spec.id}" targetNamespace="https://e-rechnung.dihag-extern.com/bpmn" `
    + 'exporter="DIHAG BPMN-Generator (scripts/bpmn/generate-bpmn.js)" exporterVersion="1.0">\n'
    + defs + collab + procs + di
    + '</bpmn:definitions>\n';
}

/* ── Ausgabe ──────────────────────────────────────────────────────────── */
const outDir = path.join(__dirname, '..', '..', 'docs', 'bpmn');
fs.mkdirSync(outDir, { recursive: true });
for (const spec of PROZESSE) {
  const xml = build(spec);
  fs.writeFileSync(path.join(outDir, spec.file), xml, 'utf8');
  console.log(`geschrieben: docs/bpmn/${spec.file} (${(xml.length / 1024).toFixed(1)} KB)`);
}

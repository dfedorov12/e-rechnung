'use strict';
/**
 * MC-Converter — SEPA-Ueberweisung  pain.001.003.03  ->  pain.001.001.09
 * =====================================================================
 * Wandelt die alte DK-/MultiCash-Version (pain.001.003.03) in die seit
 * November 2023 von den Banken verlangte ISO-20022-Version pain.001.001.09.
 *
 * Alles laeuft im Browser (kein Upload, keine API) — die Zahldatei verlaesst
 * den Rechner nicht.
 *
 * Strukturelle Unterschiede (003.03 -> 001.09):
 *   - Namespace  ...pain.001.003.03  ->  ...pain.001.001.09
 *   - <ReqdExctnDt>DATUM</>          ->  <ReqdExctnDt><Dt>DATUM</Dt></>
 *   - <BIC>                          ->  <BICFI>            (Dbtr- + CdtrAgt)
 *   - <BtchBookg>true</>             ->  ergaenzt (Sammelbuchung)
 *   - <DbtrAcct>...<Ccy>EUR</Ccy>    ->  entfaellt
 *   - <PstlAdr> bei Dbtr/Cdtr        ->  entfaellt (IBAN genuegt; vermeidet die
 *                                        strengen 001.09-Adressregeln)
 *
 * Zusaetzliche Sicherheiten (typische Ablehnungsgruende):
 *   - NbOfTxs + CtrlSum werden aus den echten Posten NEU berechnet
 *   - Ustrd auf 140 Zeichen begrenzt
 *   - optionale SEPA-Zeichensatz-Bereinigung (Umlaute -> ae/oe/ue, & -> +)
 *   - Warnung bei fehlendem BIC (-> NOTPROVIDED), Nicht-EUR, Datum in der
 *     Vergangenheit, Kopf-Summen != berechnete Summen
 *
 * Einstieg:  convertPain001(xmlText, { batchBooking, keepInstrId, sepaClean })
 *            -> { xml, stats, warnings, txns }
 *
 * Zweiter Weg: DTAZV-Auslandszahlung (*.AZV) -> pain.001.001.09 AXZ,
 *            siehe convertDtazv() weiter unten.
 */
(function (global) {

  const NS_DST = 'urn:iso:std:iso:20022:tech:xsd:pain.001.001.09';

  /* ── DOM-Helfer (namespace-agnostisch ueber localName) ── */
  const _kids = el => (el ? Array.from(el.children) : []);
  const _child = (el, name) => _kids(el).find(c => c.localName === name) || null;
  const _children = (el, name) => _kids(el).filter(c => c.localName === name);
  const _txt = (el, name) => { const c = _child(el, name); return c ? c.textContent.trim() : ''; };
  function _deepTxt(el, path) {          // z. B. ['Id','IBAN']
    let cur = el;
    for (const p of path) { cur = _child(cur, p); if (!cur) return ''; }
    return cur.textContent.trim();
  }

  /* ── XML-Escape fuer die Ausgabe ── */
  const _esc = s => String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

  /* ── Betraege ganzzahlig in Cent rechnen (keine Float-Fehler) ── */
  const _cents = s => { const n = Math.round(parseFloat(String(s).replace(',', '.')) * 100); return isNaN(n) ? 0 : n; };
  const _euro  = c => (c / 100).toFixed(2);

  /* ── Preflight-Helfer: IBAN-Pruefziffer (ISO 13616 Mod-97), BIC, SEPA-Zeichen ── */
  function _ibanValid(iban) {
    const s = String(iban || '').replace(/\s+/g, '').toUpperCase();
    if (!/^[A-Z]{2}[0-9]{2}[A-Z0-9]{8,30}$/.test(s)) return false;
    const r = s.slice(4) + s.slice(0, 4);
    const num = r.replace(/[A-Z]/g, c => (c.charCodeAt(0) - 55).toString());
    let rem = 0;
    for (let i = 0; i < num.length; i++) rem = (rem * 10 + (num.charCodeAt(i) - 48)) % 97;
    return rem === 1;
  }
  const _bicOk = b => /^[A-Z]{6}[A-Z0-9]{2}([A-Z0-9]{3})?$/.test(String(b || '').toUpperCase());
  const _badSepa = s => [...new Set(String(s || '').match(/[^A-Za-z0-9/?:().,'+ -]/g) || [])];

  /* ── SEPA-Zeichensatz: Umlaute/Akzente umschreiben, Rest auf den erlaubten
        Zeichenvorrat begrenzen  a-z A-Z 0-9 / - ? : ( ) . , ' +  und Leerzeichen ── */
  const _TRANS = {
    'ä':'ae','ö':'oe','ü':'ue','Ä':'Ae','Ö':'Oe','Ü':'Ue','ß':'ss',
    'é':'e','è':'e','ê':'e','ë':'e','á':'a','à':'a','â':'a','ã':'a','å':'a',
    'ó':'o','ò':'o','ô':'o','õ':'o','ú':'u','ù':'u','û':'u','í':'i','ì':'i','î':'i',
    'ñ':'n','ç':'c','ø':'o','æ':'ae','œ':'oe','ý':'y','š':'s','ž':'z',
    '&':'+','@':' at ','_':'-','–':'-','—':'-','„':' ','“':' ','”':' ','´':'', '`':''
  };
  function _sepa(s) {
    let out = String(s == null ? '' : s);
    out = out.replace(/[^\x00-\x7F]|[&@_]/g, ch => (_TRANS[ch] !== undefined ? _TRANS[ch] : ' '));
    out = out.replace(/[^A-Za-z0-9/?:().,'+ -]/g, ' ');   // '-' steht bewusst am Ende (literal)
    return out.replace(/\s+/g, ' ').trim();
  }

  /* Ausfuehrungsdatum aus <ReqdExctnDt> holen — egal ob direkt als Text
     (003.03) oder bereits als <Dt> (001.09). */
  function _execDate(pmtInf) {
    const r = _child(pmtInf, 'ReqdExctnDt');
    if (!r) return '';
    const dt = _child(r, 'Dt');
    return (dt ? dt.textContent : r.textContent).trim();
  }

  /* Finanzinstitut: BIC -> <BICFI>, sonst SEPA-Konvention <Othr><Id>NOTPROVIDED</Id> */
  function _agent(bic, indent) {
    const p = ' '.repeat(indent);
    if (bic) {
      return [`${p}<FinInstnId>`, `${p}    <BICFI>${_esc(bic)}</BICFI>`, `${p}</FinInstnId>`];
    }
    return [`${p}<FinInstnId>`, `${p}    <Othr>`, `${p}        <Id>NOTPROVIDED</Id>`, `${p}    </Othr>`, `${p}</FinInstnId>`];
  }

  /**
   * Hauptfunktion.
   * @param {string} xmlText  Inhalt der pain.001.003.03-Datei
   * @param {object} opts     { batchBooking=true, keepInstrId=true, sepaClean=true }
   * @returns {{xml:string, stats:object, warnings:string[], txns:object[]}}
   */
  function convertPain001(xmlText, opts) {
    opts = opts || {};
    const optBatch = opts.batchBooking !== false;
    const optInstr = opts.keepInstrId  !== false;
    const optClean = opts.sepaClean     !== false;
    const clean = s => (optClean ? _sepa(s) : s);

    const warnings = [];

    const doc = new DOMParser().parseFromString(xmlText, 'application/xml');
    const perr = doc.querySelector('parsererror');
    if (perr) throw new Error('XML ist nicht lesbar: ' + perr.textContent.trim().split('\n')[0]);

    const root = doc.documentElement;
    if (!root || root.localName !== 'Document') throw new Error('Kein pain.001-Dokument (Wurzelelement <Document> fehlt).');

    const srcNs = root.namespaceURI || '';
    if (/pain\.008/i.test(srcNs)) throw new Error('Das ist eine SEPA-Lastschrift (pain.008), keine Ueberweisung (pain.001). Der MC-Converter wandelt nur Ueberweisungen.');
    const srcVerMatch = srcNs.match(/pain\.001\.\d{3}\.\d{2}/i);
    const srcVersion = srcVerMatch ? srcVerMatch[0] : (srcNs || 'unbekannt');
    if (/pain\.001\.001\.09/i.test(srcNs)) warnings.push('Die Datei ist bereits pain.001.001.09 — es wird nur neu formatiert und geprueft.');
    else if (!srcVerMatch) warnings.push('Namespace nicht als pain.001 erkannt (' + srcVersion + ') — es wird trotzdem versucht, die Ueberweisung zu uebernehmen.');

    const cti = _child(root, 'CstmrCdtTrfInitn');
    if (!cti) throw new Error('Kein <CstmrCdtTrfInitn> gefunden — ist das eine SEPA-Ueberweisungsdatei (pain.001)?');

    const grpHdr = _child(cti, 'GrpHdr');
    const msgId    = _txt(grpHdr, 'MsgId');
    let   creDtTm  = _txt(grpHdr, 'CreDtTm');
    const initgNm  = clean(_deepTxt(_child(grpHdr, 'InitgPty') || grpHdr, ['Nm']) || _txt(_child(grpHdr, 'InitgPty'), 'Nm'));
    if (!creDtTm) creDtTm = new Date().toISOString().replace(/\.\d+Z$/, '');

    const pmtInfs = _children(cti, 'PmtInf');
    if (!pmtInfs.length) throw new Error('Keine <PmtInf> (Zahlungssammler) in der Datei.');

    const txns = [];                       // fuer die Vorschau-Tabelle
    let grpNb = 0, grpSum = 0;             // Kopf-Summen ueber ALLE PmtInf
    const pmtBlocks = [];

    let debtorFirst = '', debtorIbanFirst = '', execFirst = '';

    for (const pmt of pmtInfs) {
      const pmtInfId = _txt(pmt, 'PmtInfId');
      const dbtrNm   = clean(_txt(_child(pmt, 'Dbtr'), 'Nm'));
      const dbtrIban = _deepTxt(_child(pmt, 'DbtrAcct'), ['Id', 'IBAN']);
      const dbtrBic  = _deepTxt(_child(pmt, 'DbtrAgt'), ['FinInstnId', 'BIC']) || _deepTxt(_child(pmt, 'DbtrAgt'), ['FinInstnId', 'BICFI']);
      const chrgBr   = _txt(pmt, 'ChrgBr') || 'SLEV';
      const svcLvl   = _deepTxt(_child(pmt, 'PmtTpInf'), ['SvcLvl', 'Cd']) || 'SEPA';
      const execDate = _execDate(pmt);
      const hadBatch = _txt(pmt, 'BtchBookg');

      if (!debtorFirst) { debtorFirst = dbtrNm; debtorIbanFirst = dbtrIban; execFirst = execDate; }
      if (!dbtrBic) warnings.push(`Auftraggeber "${dbtrNm || pmtInfId}" ohne BIC — im Ziel als NOTPROVIDED gesetzt (IBAN-only, bei SEPA zulaessig).`);

      const txInfs = _children(pmt, 'CdtTrfTxInf');
      let pmtNb = 0, pmtSum = 0;
      const txLines = [];

      for (const tx of txInfs) {
        const instrId  = _txt(_child(tx, 'PmtId'), 'InstrId');
        const e2e      = _txt(_child(tx, 'PmtId'), 'EndToEndId') || 'NOTPROVIDED';
        const instdAmt = _child(_child(tx, 'Amt'), 'InstdAmt');
        const amtTxt   = instdAmt ? instdAmt.textContent.trim() : '0';
        const ccy      = (instdAmt && instdAmt.getAttribute('Ccy')) || 'EUR';
        const cdtrNm   = clean(_txt(_child(tx, 'Cdtr'), 'Nm'));
        const cdtrIban = _deepTxt(_child(tx, 'CdtrAcct'), ['Id', 'IBAN']);
        const cdtrBic  = _deepTxt(_child(tx, 'CdtrAgt'), ['FinInstnId', 'BIC']) || _deepTxt(_child(tx, 'CdtrAgt'), ['FinInstnId', 'BICFI']);
        let   ustrd    = _txt(_child(tx, 'RmtInf'), 'Ustrd');

        if (!cdtrBic) warnings.push(`Empfaenger "${cdtrNm}" ohne BIC — im Ziel als NOTPROVIDED gesetzt (IBAN-only).`);

        ustrd = clean(ustrd);
        if (ustrd.length > 140) { warnings.push(`Verwendungszweck bei "${cdtrNm}" war ${ustrd.length} Zeichen — auf 140 gekuerzt.`); ustrd = ustrd.slice(0, 140); }

        const cents = _cents(amtTxt);
        pmtNb++; pmtSum += cents;
        txns.push({ e2e, amount: _euro(cents), ccy, cdtrNm, cdtrIban, cdtrBic, ustrd });

        // ── CdtTrfTxInf (12 Leerzeichen Basis) ──
        txLines.push('            <CdtTrfTxInf>');
        txLines.push('                <PmtId>');
        if (optInstr && instrId) txLines.push(`                    <InstrId>${_esc(instrId)}</InstrId>`);
        txLines.push(`                    <EndToEndId>${_esc(e2e)}</EndToEndId>`);
        txLines.push('                </PmtId>');
        txLines.push('                <Amt>');
        txLines.push(`                    <InstdAmt Ccy="${_esc(ccy)}">${_euro(cents)}</InstdAmt>`);
        txLines.push('                </Amt>');
        txLines.push('                <CdtrAgt>');
        txLines.push(..._agent(cdtrBic, 20));
        txLines.push('                </CdtrAgt>');
        txLines.push('                <Cdtr>');
        txLines.push(`                    <Nm>${_esc(cdtrNm)}</Nm>`);
        txLines.push('                </Cdtr>');
        txLines.push('                <CdtrAcct>');
        txLines.push('                    <Id>');
        txLines.push(`                        <IBAN>${_esc(cdtrIban)}</IBAN>`);
        txLines.push('                    </Id>');
        txLines.push('                </CdtrAcct>');
        if (ustrd) {
          txLines.push('                <RmtInf>');
          txLines.push(`                    <Ustrd>${_esc(ustrd)}</Ustrd>`);
          txLines.push('                </RmtInf>');
        }
        txLines.push('            </CdtTrfTxInf>');
      }

      // Kopf-Summen des Zahlungssammlers gegen die Ist-Werte pruefen
      const hdrNb  = _txt(pmt, 'NbOfTxs');
      const hdrSum = _txt(pmt, 'CtrlSum');
      if (hdrNb && parseInt(hdrNb, 10) !== pmtNb) warnings.push(`PmtInf "${pmtInfId}": NbOfTxs im Kopf (${hdrNb}) != tatsaechliche Posten (${pmtNb}) — es wird ${pmtNb} verwendet.`);
      if (hdrSum && _cents(hdrSum) !== pmtSum) warnings.push(`PmtInf "${pmtInfId}": CtrlSum im Kopf (${hdrSum}) != Summe der Posten (${_euro(pmtSum)}) — es wird ${_euro(pmtSum)} verwendet.`);

      grpNb += pmtNb; grpSum += pmtSum;

      // ── PmtInf (8 Leerzeichen Basis) ──
      const p = [];
      p.push('        <PmtInf>');
      p.push(`            <PmtInfId>${_esc(pmtInfId)}</PmtInfId>`);
      p.push('            <PmtMtd>TRF</PmtMtd>');
      if (optBatch || /^true$/i.test(hadBatch)) p.push('            <BtchBookg>true</BtchBookg>');
      p.push(`            <NbOfTxs>${pmtNb}</NbOfTxs>`);
      p.push(`            <CtrlSum>${_euro(pmtSum)}</CtrlSum>`);
      p.push('            <PmtTpInf>');
      p.push('                <SvcLvl>');
      p.push(`                    <Cd>${_esc(svcLvl)}</Cd>`);
      p.push('                </SvcLvl>');
      p.push('            </PmtTpInf>');
      p.push('            <ReqdExctnDt>');
      p.push(`                <Dt>${_esc(execDate)}</Dt>`);
      p.push('            </ReqdExctnDt>');
      p.push('            <Dbtr>');
      p.push(`                <Nm>${_esc(dbtrNm)}</Nm>`);
      p.push('            </Dbtr>');
      p.push('            <DbtrAcct>');
      p.push('                <Id>');
      p.push(`                    <IBAN>${_esc(dbtrIban)}</IBAN>`);
      p.push('                </Id>');
      p.push('            </DbtrAcct>');
      p.push('            <DbtrAgt>');
      p.push(..._agent(dbtrBic, 16));
      p.push('            </DbtrAgt>');
      p.push(`            <ChrgBr>${_esc(chrgBr)}</ChrgBr>`);
      p.push(...txLines);
      p.push('        </PmtInf>');
      pmtBlocks.push(p.join('\n'));
    }

    // ── Gesamtdokument zusammensetzen ──
    const out = [];
    out.push('<?xml version="1.0" encoding="UTF-8" standalone="yes"?>');
    out.push(`<Document xsi:schemaLocation="${NS_DST} pain.001.001.09.xsd" xmlns="${NS_DST}" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">`);
    out.push('    <CstmrCdtTrfInitn>');
    out.push('        <GrpHdr>');
    out.push(`            <MsgId>${_esc(msgId)}</MsgId>`);
    out.push(`            <CreDtTm>${_esc(creDtTm)}</CreDtTm>`);
    out.push(`            <NbOfTxs>${grpNb}</NbOfTxs>`);
    out.push(`            <CtrlSum>${_euro(grpSum)}</CtrlSum>`);
    out.push('            <InitgPty>');
    out.push(`                <Nm>${_esc(initgNm)}</Nm>`);
    out.push('            </InitgPty>');
    out.push('        </GrpHdr>');
    out.push(...pmtBlocks);
    out.push('    </CstmrCdtTrfInitn>');
    out.push('</Document>');

    const stats = {
      srcVersion,
      dstVersion: 'pain.001.001.09',
      msgId, creDtTm,
      initgParty: initgNm,
      debtor: debtorFirst,
      debtorIban: debtorIbanFirst,
      execDate: execFirst,
      nbOfTxs: grpNb,
      ctrlSum: _euro(grpSum),
      pmtInfCount: pmtInfs.length,
    };

    const xml = out.join('\n');
    return { xml, stats, warnings, txns, preflight: preflightPain009(xml) };
  }

  /**
   * SEPA-Preflight auf die FERTIGE pain.001.001.09 — prueft genau die Dinge, an
   * denen eine Bank eine Datei ablehnt. Strenger als eine reine XSD-Pruefung
   * (die weder IBAN-Pruefziffer noch "CtrlSum == Summe der Posten" kontrolliert).
   * @returns {{errors:string[], notes:string[], nbOfTxs:number, ctrlSum:string}}
   */
  function preflightPain009(xmlText) {
    const errors = [], notes = [];
    const doc = new DOMParser().parseFromString(xmlText, 'application/xml');
    const root = doc.documentElement;
    if (!root || !/pain\.001\.001\.09/.test(root.namespaceURI || '')) errors.push('Namespace ist nicht pain.001.001.09.');

    const cti = _child(root, 'CstmrCdtTrfInitn');
    const grp = _child(cti, 'GrpHdr');
    if (!_txt(grp, 'MsgId')) errors.push('GrpHdr/MsgId fehlt.');
    if (!_txt(grp, 'CreDtTm')) errors.push('GrpHdr/CreDtTm fehlt.');
    const grpNb = parseInt(_txt(grp, 'NbOfTxs'), 10);
    const grpSum = _cents(_txt(grp, 'CtrlSum'));

    const today = new Date(); today.setHours(0, 0, 0, 0);
    let totalNb = 0, totalSum = 0, idx = 0;

    for (const pmt of _children(cti, 'PmtInf')) {
      const pid = _txt(pmt, 'PmtInfId');
      const exec = _deepTxt(pmt, ['ReqdExctnDt', 'Dt']) || _txt(pmt, 'ReqdExctnDt');
      if (!/^\d{4}-\d{2}-\d{2}$/.test(exec)) errors.push(`PmtInf ${pid}: ReqdExctnDt/Dt fehlt oder ungueltig.`);
      else if (new Date(exec + 'T00:00:00') < today) notes.push(`Ausfuehrungsdatum ${exec} liegt in der Vergangenheit — die Bank bucht i. d. R. am naechsten Bankarbeitstag.`);
      const dIban = _deepTxt(pmt, ['DbtrAcct', 'Id', 'IBAN']);
      if (!_ibanValid(dIban)) errors.push(`PmtInf ${pid}: Auftraggeber-IBAN ungueltig (${dIban}).`);
      const dBic = _deepTxt(pmt, ['DbtrAgt', 'FinInstnId', 'BICFI']);
      if (dBic && !_bicOk(dBic)) errors.push(`PmtInf ${pid}: Auftraggeber-BIC ungueltig (${dBic}).`);

      let pNb = 0, pSum = 0;
      for (const tx of _children(pmt, 'CdtTrfTxInf')) {
        idx++;
        const nm = _txt(_child(tx, 'Cdtr'), 'Nm');
        const iban = _deepTxt(tx, ['CdtrAcct', 'Id', 'IBAN']);
        const bic = _deepTxt(tx, ['CdtrAgt', 'FinInstnId', 'BICFI']);
        const amtEl = _child(_child(tx, 'Amt'), 'InstdAmt');
        const amt = amtEl ? amtEl.textContent.trim() : '';
        const ccy = amtEl ? (amtEl.getAttribute('Ccy') || '') : '';
        const e2e = _txt(_child(tx, 'PmtId'), 'EndToEndId');
        const ustrd = _txt(_child(tx, 'RmtInf'), 'Ustrd');
        const who = `#${idx} ${nm}`;

        if (!_ibanValid(iban)) errors.push(`${who}: Empfaenger-IBAN Pruefziffer falsch (${iban}).`);
        if (bic && !_bicOk(bic)) errors.push(`${who}: BIC-Format ungueltig (${bic}).`);
        if (!/^\d+\.\d{2}$/.test(amt)) errors.push(`${who}: Betrag nicht im Format 0.00 (${amt}).`);
        else if (_cents(amt) <= 0) errors.push(`${who}: Betrag <= 0.`);
        if (ccy.toUpperCase() !== 'EUR') errors.push(`${who}: Waehrung != EUR (${ccy}).`);
        if (nm.length > 70) errors.push(`${who}: Empfaengername > 70 Zeichen.`);
        if (ustrd.length > 140) errors.push(`${who}: Verwendungszweck > 140 Zeichen.`);
        if (e2e.length > 35) errors.push(`${who}: EndToEndId > 35 Zeichen.`);
        const bc = [..._badSepa(nm), ..._badSepa(ustrd)];
        if (bc.length) errors.push(`${who}: unerlaubte SEPA-Zeichen: ${[...new Set(bc)].join(' ')}`);

        pNb++; pSum += _cents(amt);
      }
      const hNb = parseInt(_txt(pmt, 'NbOfTxs'), 10);
      const hSum = _cents(_txt(pmt, 'CtrlSum'));
      if (hNb !== pNb) errors.push(`PmtInf ${pid}: NbOfTxs (${hNb}) != Posten (${pNb}).`);
      if (hSum !== pSum) errors.push(`PmtInf ${pid}: CtrlSum (${_euro(hSum)}) != Summe der Posten (${_euro(pSum)}).`);
      totalNb += pNb; totalSum += pSum;
    }
    if (!isNaN(grpNb) && grpNb !== totalNb) errors.push(`GrpHdr/NbOfTxs (${grpNb}) != Posten gesamt (${totalNb}).`);
    if (grpSum !== totalSum) errors.push(`GrpHdr/CtrlSum (${_euro(grpSum)}) != Gesamtsumme (${_euro(totalSum)}).`);

    return { errors, notes, nbOfTxs: totalNb, ctrlSum: _euro(totalSum) };
  }

  /* ══════════════════════════════════════════════════════════════════════
   * DTAZV (Auslandszahlung, *.AZV)  ->  pain.001.001.09 AXZ
   * ══════════════════════════════════════════════════════════════════════
   * Ab 14.11.2026 nehmen die Banken keine DTAZV-Dateien mehr an. Nachfolger
   * ist pain.001.001.09 mit EBICS-Auftragsart AXZ, geprueft gegen das
   * DK-Schema pain.001.001.09_AXZ_GBIC_5 (DFUe-Abkommen Anlage 3, Kap. 3).
   *
   * DTAZV besteht aus Saetzen fester Laenge (4 Stellen Laenge + Satzart):
   *   Q (256)   Vorsatz: Auftraggeber, Erstellungs- und Ausfuehrungsdatum
   *   T (768)   eine Zahlung
   *   V/W (256) Meldedaten zur vorigen Zahlung (optional)
   *   Z (256)   Nachsatz: Summe der Betraege (ganzzahlig), Anzahl T-Saetze
   *
   * AXZ-Regeln, die hier umgesetzt sind:
   *   - PmtTpInf/SvcLvl (NURG/URGP) und ChrgBr stehen je Zahlung, nicht im PmtInf
   *   - DbtrAcct/Ccy ist Pflicht
   *   - Adressen hybrid: TwnNm + Ctry strukturiert, Strasse in max. 2 AdrLine
   *   - ohne Auftraggeber-Adresse wird CtryOfRes gesetzt (so im DK-Beispiel)
   */

  /* Feldpositionen [Start (1-basiert), Laenge, Anzahl Zeilen] */
  const _AZV_Q = { blz: [6, 8], kto: [14, 10], adr: [24, 35, 4], created: [164, 6], seq: [170, 2], exec: [172, 6] };
  const _AZV_T = {
    blz: [6, 8], ccy: [14, 3], kto: [17, 10], exec: [27, 6],
    feeBlz: [33, 8], feeCcy: [41, 3], feeKto: [44, 10],
    bic: [54, 11], bankCtry: [65, 3], bank: [68, 35, 4],
    cdtrCtry: [208, 3], cdtr: [211, 35, 4], order: [351, 35, 2],
    acct: [421, 35], amtCcy: [456, 3], amtInt: [459, 14], amtDec: [473, 3],
    vz: [476, 35, 4], w: [616, 2, 4], wInfo: [624, 25],
    fee: [649, 2], kind: [651, 2], ref: [653, 27], ext: [767, 2],
  };
  const _AZV_Z = { sum: [6, 15], count: [21, 15] };

  function _fx(rec, def) {
    const [pos, len, n] = def;
    if (!n) return rec.substr(pos - 1, len).trim();
    const out = [];
    for (let i = 0; i < n; i++) out.push(rec.substr(pos - 1 + i * len, len).trim());
    return out;
  }

  /* DTAZV-Entgeltregelung -> ISO ChrgBr */
  const _AZV_FEE = { '00': 'DEBT', '01': 'CRED', '02': 'SHAR' };
  const _FEE_TXT = { DEBT: 'OUR, Auftraggeber traegt alle Entgelte', CRED: 'BEN, Empfaenger traegt alle Entgelte', SHAR: 'SHA, Entgelte geteilt' };
  /* DTAZV-Zahlungsart -> AXZ-Service-Level. Nur die eindeutigen Werte werden
     umgesetzt, alles andere (z. B. Scheckziehung) bleibt ein Preflight-Fehler. */
  const _AZV_KIND = { '00': 'NURG', '13': 'NURG', '10': 'URGP' };

  /* Nachkommastellen je Waehrung (ISO 4217) */
  const _CCY0 = new Set(['BIF', 'CLP', 'DJF', 'GNF', 'ISK', 'JPY', 'KMF', 'KRW', 'PYG', 'RWF', 'UGX', 'VND', 'VUV', 'XAF', 'XOF', 'XPF']);
  const _CCY3 = new Set(['BHD', 'IQD', 'JOD', 'KWD', 'LYD', 'OMR', 'TND']);
  const _ccyDigits = c => (_CCY0.has(c) ? 0 : _CCY3.has(c) ? 3 : 2);

  /* Betraege in Tausendsteln rechnen (DTAZV hat 3 Nachkommastellen) */
  function _milli(s) {
    const m = /^(\d+)(?:\.(\d{1,3}))?$/.exec(String(s == null ? '' : s).trim());
    return m ? parseInt(m[1], 10) * 1000 + parseInt((m[2] || '').padEnd(3, '0'), 10) : NaN;
  }
  function _fmtMilli(v, digits) {
    const i = Math.floor(v / 1000), f = String(v % 1000).padStart(3, '0');
    return digits ? `${i}.${f.slice(0, digits)}` : String(i);
  }
  const _fmtSum = v => _fmtMilli(v, v % 10 ? 3 : 2);

  /* Deutsche IBAN aus BLZ und Kontonummer (Standardregel, Pruefziffer Mod-97) */
  function _deIban(blz, kto) {
    const bban = String(blz).replace(/\D/g, '').padStart(8, '0') + String(kto).replace(/\D/g, '').padStart(10, '0');
    let rem = 0;
    for (const ch of bban + '131400') rem = (rem * 10 + (ch.charCodeAt(0) - 48)) % 97;
    return 'DE' + String(98 - rem).padStart(2, '0') + bban;
  }

  /* Alte DTA-Dateien schreiben Umlaute nach DIN 66003 ([ \ ] { | } ~).
     Diese Zeichen sind im SWIFT-Zeichensatz ohnehin verboten. */
  const _din66003 = s => String(s)
    .replace(/\[/g, 'AE').replace(/\\/g, 'OE').replace(/\]/g, 'UE').replace(/~/g, 'SS')
    .replace(/\{/g, 'ae').replace(/\|/g, 'oe').replace(/\}/g, 'ue');

  const _azvDate = s => (/^\d{6}$/.test(s) && s !== '000000') ? `20${s.slice(0, 2)}-${s.slice(2, 4)}-${s.slice(4, 6)}` : '';

  /* Ortszeile zerlegen: "RS-11000 BEOGRAD", "11000 BEOGRAD", "BEOGRAD", "RS-" */
  function _azvTown(line, ctry) {
    let s = String(line || '').trim();
    const pre = /^([A-Z]{2})\s*-\s*/.exec(s);
    if (pre && (!ctry || pre[1] === ctry)) s = s.slice(pre[0].length);
    const m = /^(\S*\d\S*)(?:\s+(.*))?$/.exec(s);
    if (m) return { pstCd: m[1], town: (m[2] || '').trim() };
    return { pstCd: '', town: s };
  }

  /** Erkennt eine DTAZV-Datei am ersten Satz ("0256Q..."). */
  function isDtazv(text) {
    return /^﻿?\s*\d{4}Q/.test(String(text || '').slice(0, 16));
  }

  /* Saetze einlesen: am Stueck (Standard) oder zeilenweise (manche Exporte
     haengen hinter jeden Satz einen Zeilenumbruch und kuerzen Leerzeichen). */
  function _azvRecords(text) {
    const s = String(text).replace(/^﻿/, '').replace(/\x1A+\s*$/, '');
    const lines = s.split(/\r\n|\n|\r/).filter(l => l.trim());
    const recs = [];
    if (lines.length > 1 && lines.every(l => /^\d{4}[QTVWZ]/.test(l))) {
      for (const l of lines) recs.push({ type: l[4], rec: l.padEnd(parseInt(l.slice(0, 4), 10), ' ') });
      return recs;
    }
    let i = 0;
    while (i < s.length) {
      const head = s.substr(i, 5);
      const m = /^(\d{4})([QTVWZ])$/.exec(head);
      if (!m) {
        if (/\s/.test(s[i])) { i++; continue; }
        throw new Error(`DTAZV: Satz ab Zeichen ${i + 1} nicht lesbar ("${head}").`);
      }
      const len = parseInt(m[1], 10);
      if (len < 5) throw new Error(`DTAZV: Satzlaenge ${m[1]} ab Zeichen ${i + 1} ungueltig.`);
      recs.push({ type: m[2], rec: s.substr(i, len).padEnd(len, ' ') });
      i += len;
    }
    return recs;
  }

  function _pstlAdrLines(a, indent) {
    const p = ' '.repeat(indent);
    const out = [`${p}<PstlAdr>`];
    if (a.pstCd) out.push(`${p}    <PstCd>${_esc(a.pstCd)}</PstCd>`);
    out.push(`${p}    <TwnNm>${_esc(a.town)}</TwnNm>`);
    out.push(`${p}    <Ctry>${_esc(a.ctry)}</Ctry>`);
    for (const l of a.lines || []) out.push(`${p}    <AdrLine>${_esc(l)}</AdrLine>`);
    out.push(`${p}</PstlAdr>`);
    return out;
  }

  /**
   * DTAZV -> pain.001.001.09 AXZ.
   * @param {string} text  Inhalt der .AZV-Datei
   * @param {object} opts  { sepaClean=true,
   *                         accounts: { 'BLZ/KTO': { iban, bic } }  (Belastungskonto ueberschreiben),
   *                         towns:    { <Posten-Index>: 'Ort' } }    (fehlenden Empfaenger-Ort ergaenzen)
   * @returns {{xml, stats, warnings, txns, accounts, preflight}}
   */
  function convertDtazv(text, opts) {
    opts = opts || {};
    const optClean = opts.sepaClean !== false;
    const accOver = opts.accounts || {};
    const townOver = opts.towns || {};
    const clean = s => { const t = _din66003(s); return optClean ? _sepa(t) : t.replace(/\s+/g, ' ').trim(); };
    const warnings = [], convErrors = [];

    const recs = _azvRecords(text);
    const qRec = recs.find(r => r.type === 'Q');
    if (!qRec) throw new Error('DTAZV: Vorsatz (Q-Satz) fehlt.');
    const zRec = recs.find(r => r.type === 'Z');
    const tRecs = recs.filter(r => r.type === 'T');
    if (!tRecs.length) throw new Error('DTAZV: keine Zahlung (T-Satz) in der Datei.');
    if (!zRec) warnings.push('DTAZV-Nachsatz (Z-Satz) fehlt, die Datei ist evtl. unvollstaendig.');
    const vwCount = recs.filter(r => r.type === 'V' || r.type === 'W').length;
    if (vwCount) warnings.push(`${vwCount} Meldesatz/-saetze (V/W) nicht uebernommen. AWV-Meldungen gehen direkt ueber das Meldeportal der Bundesbank, nicht ueber die Zahldatei.`);

    const q = qRec.rec;
    const qAdr = _fx(q, _AZV_Q.adr);
    const dbtrNm = clean([qAdr[0], qAdr[1]].filter(Boolean).join(' '));
    const qTown = _azvTown(qAdr[3], 'DE');
    const dbtrAdr = qTown.town
      ? { pstCd: clean(qTown.pstCd), town: clean(qTown.town).slice(0, 35), ctry: 'DE', lines: qAdr[2] ? [clean(qAdr[2]).slice(0, 70)] : [] }
      : null;
    const created = _azvDate(_fx(q, _AZV_Q.created));
    const qExec = _azvDate(_fx(q, _AZV_Q.exec));
    const seq = _fx(q, _AZV_Q.seq);

    const now = new Date();
    const p2 = n => String(n).padStart(2, '0');
    const creDtTm = `${now.getFullYear()}-${p2(now.getMonth() + 1)}-${p2(now.getDate())}T${p2(now.getHours())}:${p2(now.getMinutes())}:${p2(now.getSeconds())}`;
    const msgId = `DTAZV-${(created || '').replace(/-/g, '') || 'X'}-${seq || '0'}-${now.getTime().toString(36).toUpperCase()}`.slice(0, 35);

    const accounts = new Map();   // Belastungskonten fuer die Oberflaeche
    const groups = new Map();     // PmtInf je Konto + Ausfuehrungstag + Entgeltkonto
    const txns = [];
    let intSum = 0;

    tRecs.forEach((r, idx) => {
      const t = r.rec;
      const blz = _fx(t, _AZV_T.blz), kto = _fx(t, _AZV_T.kto);
      const acctCcy = (_fx(t, _AZV_T.ccy) || 'EUR').toUpperCase();
      const accKey = `${blz}/${kto}`;
      if (!accounts.has(accKey)) {
        const calc = _deIban(blz, kto);
        const ov = accOver[accKey] || {};
        const ovIban = String(ov.iban || '').replace(/\s+/g, '').toUpperCase();
        accounts.set(accKey, {
          key: accKey, blz, kto, ccy: acctCcy, ibanCalc: calc,
          iban: ovIban || calc, ibanOverridden: !!ovIban && ovIban !== calc,
          bic: String(ov.bic || '').replace(/\s+/g, '').toUpperCase(),
        });
      }
      const acc = accounts.get(accKey);

      const exec = _azvDate(_fx(t, _AZV_T.exec)) || qExec || creDtTm.slice(0, 10);
      const feeBlz = _fx(t, _AZV_T.feeBlz), feeKto = _fx(t, _AZV_T.feeKto);
      const fee = (/^0*$/.test(feeBlz) || /^0*$/.test(feeKto)) ? null
        : { iban: _deIban(feeBlz, feeKto), ccy: (_fx(t, _AZV_T.feeCcy) || acctCcy).toUpperCase() };

      // Empfaenger
      const cdtrCtry = _fx(t, _AZV_T.cdtrCtry).slice(0, 2).toUpperCase();
      const cl = _fx(t, _AZV_T.cdtr);
      const cdtrNm = clean([cl[0], cl[1]].filter(Boolean).join(' ')).slice(0, 140);
      const tw = _azvTown(cl[3], cdtrCtry);
      const who = `#${idx + 1} ${cdtrNm}`;
      let town = clean(tw.town);
      const townFromUser = !town && townOver[idx] ? clean(townOver[idx]) : '';
      if (townFromUser) town = townFromUser;
      if (town.length > 35) { warnings.push(`${who}: Ort auf 35 Zeichen gekuerzt.`); town = town.slice(0, 35); }
      const cdtrAdr = { pstCd: clean(tw.pstCd).slice(0, 16), town, ctry: cdtrCtry, lines: cl[2] ? [clean(cl[2]).slice(0, 70)] : [] };

      // Empfaengerbank
      const bic = _fx(t, _AZV_T.bic).replace(/\s+/g, '').toUpperCase();
      const bl = _fx(t, _AZV_T.bank);
      const bankCtry = _fx(t, _AZV_T.bankCtry).slice(0, 2).toUpperCase() || cdtrCtry;
      const bankTown = _azvTown(bl[3], bankCtry);
      const bank = bic ? null : {
        nm: clean([bl[0], bl[1]].filter(Boolean).join(' ')).slice(0, 140),
        adr: { pstCd: clean(bankTown.pstCd).slice(0, 16), town: clean(bankTown.town).slice(0, 35), ctry: bankCtry, lines: bl[2] ? [clean(bl[2]).slice(0, 70)] : [] },
      };

      // Konto des Empfaengers: IBAN (mit oder ohne fuehrenden "/") oder Kontonummer
      const acctRaw = _fx(t, _AZV_T.acct).replace(/^\/+/, '').replace(/\s+/g, '').toUpperCase();
      const isIban = _ibanValid(acctRaw);
      if (!isIban && /^[A-Z]{2}\d{2}/.test(acctRaw)) warnings.push(`${who}: "${acctRaw}" sieht wie eine IBAN aus, die Pruefziffer stimmt aber nicht. Uebernommen als Kontonummer.`);

      // Betrag
      const ccy = (_fx(t, _AZV_T.amtCcy) || 'EUR').toUpperCase();
      const mInt = parseInt(_fx(t, _AZV_T.amtInt) || '0', 10);
      const mDec = parseInt((_fx(t, _AZV_T.amtDec) || '0').padEnd(3, '0'), 10);
      const milli = mInt * 1000 + mDec;
      intSum += mInt;
      // zu viele Nachkommastellen fuer die Waehrung bleiben sichtbar, der Preflight meldet sie
      const digits = _ccyDigits(ccy);
      const amount = _fmtMilli(milli, milli % Math.pow(10, 3 - digits) ? 3 : digits);

      // Entgelt, Zahlungsart, Weisungen
      const feeCode = _fx(t, _AZV_T.fee) || '00';
      const chrgBr = _AZV_FEE[feeCode] || 'SHAR';
      if (!_AZV_FEE[feeCode]) convErrors.push(`${who}: Entgeltregelung "${feeCode}" unbekannt. Bitte in MultiCash pruefen (00 = OUR, 01 = BEN, 02 = SHA).`);
      const kind = _fx(t, _AZV_T.kind) || '00';
      const svcLvl = _AZV_KIND[kind] || 'NURG';
      if (!_AZV_KIND[kind]) convErrors.push(`${who}: Zahlungsart "${kind}" wird nicht umgesetzt (nur Standard 00/13 und Eilzahlung 10). Bitte mit der Bank klaeren.`);
      if (svcLvl === 'URGP') warnings.push(`${who}: als Eilzahlung (URGP) uebernommen.`);
      const wKeys = _fx(t, _AZV_T.w).filter(k => k && k !== '00');
      const wInfo = clean(_fx(t, _AZV_T.wInfo));
      const instrDbtr = wKeys.length ? clean(`DTAZV-Weisung ${wKeys.join(' ')} ${wInfo}`).slice(0, 140) : '';
      if (instrDbtr) warnings.push(`${who}: Weisungsschluessel ${wKeys.join(', ')} als Hinweis an die eigene Bank uebernommen (InstrForDbtrAgt). Bitte mit der Bank abstimmen.`);
      const order = clean(_fx(t, _AZV_T.order).join(' ')).slice(0, 140);
      if (order) warnings.push(`${who}: Ordervermerk "${order}" als Hinweis an die Empfaengerbank uebernommen.`);

      // Referenzen: EndToEndId nach SWIFT-Regel (kein "/" am Rand, kein "//")
      let e2e = clean(_fx(t, _AZV_T.ref)).replace(/\/{2,}/g, '/').replace(/^\/+|\/+$/g, '').replace(/\s+/g, '').slice(0, 35);
      if (!e2e) e2e = 'NOTPROVIDED';
      let ustrd = clean(_fx(t, _AZV_T.vz).join(' '));
      if (ustrd.length > 140) { warnings.push(`${who}: Verwendungszweck auf 140 Zeichen gekuerzt.`); ustrd = ustrd.slice(0, 140); }

      const gKey = `${accKey}|${exec}|${fee ? fee.iban : ''}`;
      if (!groups.has(gKey)) groups.set(gKey, { acc, exec, fee, tx: [] });
      const uetr = (typeof crypto !== 'undefined' && crypto.randomUUID) ? crypto.randomUUID() : '';

      const L = [];
      L.push('            <CdtTrfTxInf>');
      L.push('                <PmtId>');
      L.push(`                    <EndToEndId>${_esc(e2e)}</EndToEndId>`);
      if (uetr) L.push(`                    <UETR>${uetr}</UETR>`);
      L.push('                </PmtId>');
      L.push('                <PmtTpInf>');
      L.push('                    <SvcLvl>');
      L.push(`                        <Cd>${svcLvl}</Cd>`);
      L.push('                    </SvcLvl>');
      L.push('                </PmtTpInf>');
      L.push('                <Amt>');
      L.push(`                    <InstdAmt Ccy="${_esc(ccy)}">${amount}</InstdAmt>`);
      L.push('                </Amt>');
      L.push(`                <ChrgBr>${chrgBr}</ChrgBr>`);
      if (bic || (bank && bank.nm)) {
        L.push('                <CdtrAgt>');
        L.push('                    <FinInstnId>');
        if (bic) L.push(`                        <BICFI>${_esc(bic)}</BICFI>`);
        else {
          L.push(`                        <Nm>${_esc(bank.nm)}</Nm>`);
          if (bank.adr.town && bank.adr.ctry) L.push(..._pstlAdrLines(bank.adr, 24));
        }
        L.push('                    </FinInstnId>');
        L.push('                </CdtrAgt>');
      }
      L.push('                <Cdtr>');
      L.push(`                    <Nm>${_esc(cdtrNm)}</Nm>`);
      if (cdtrAdr.town && cdtrAdr.ctry) L.push(..._pstlAdrLines(cdtrAdr, 20));
      else if (cdtrCtry) L.push(`                    <CtryOfRes>${_esc(cdtrCtry)}</CtryOfRes>`);
      L.push('                </Cdtr>');
      if (acctRaw) {
        L.push('                <CdtrAcct>');
        L.push('                    <Id>');
        if (isIban) L.push(`                        <IBAN>${_esc(acctRaw)}</IBAN>`);
        else {
          L.push('                        <Othr>');
          L.push(`                            <Id>${_esc(acctRaw.slice(0, 34))}</Id>`);
          L.push('                        </Othr>');
        }
        L.push('                    </Id>');
        L.push('                </CdtrAcct>');
      }
      if (order) {
        L.push('                <InstrForCdtrAgt>');
        L.push(`                    <InstrInf>${_esc(order)}</InstrInf>`);
        L.push('                </InstrForCdtrAgt>');
      }
      if (instrDbtr) L.push(`                <InstrForDbtrAgt>${_esc(instrDbtr)}</InstrForDbtrAgt>`);
      if (ustrd) {
        L.push('                <RmtInf>');
        L.push(`                    <Ustrd>${_esc(ustrd)}</Ustrd>`);
        L.push('                </RmtInf>');
      }
      L.push('            </CdtTrfTxInf>');

      groups.get(gKey).tx.push({ milli, lines: L });
      txns.push({
        idx, e2e, amount, ccy, cdtrNm, cdtrIban: acctRaw, cdtrBic: bic || (bank && bank.nm) || '',
        ustrd, chrgBr, chrgTxt: _FEE_TXT[chrgBr], svcLvl, ctry: cdtrCtry, pstCd: cdtrAdr.pstCd,
        town: cdtrAdr.town, townMissing: !tw.town, townFromUser: !!townFromUser, accKey,
      });
    });

    // Nachsatz gegenpruefen
    if (zRec) {
      const zCount = parseInt(_fx(zRec.rec, _AZV_Z.count) || '0', 10);
      const zSum = parseInt(_fx(zRec.rec, _AZV_Z.sum) || '0', 10);
      if (zCount !== tRecs.length) warnings.push(`Nachsatz meldet ${zCount} Zahlung(en), gefunden wurden ${tRecs.length}.`);
      if (zSum !== intSum) warnings.push(`Nachsatz meldet Betragssumme ${zSum}, die Zahlungen ergeben ${intSum} (ganzzahliger Teil).`);
    }

    // PmtInf-Bloecke
    let grpNb = 0, grpSum = 0, n = 0;
    const pmtBlocks = [];
    for (const g of groups.values()) {
      n++;
      const pNb = g.tx.length, pSum = g.tx.reduce((a, x) => a + x.milli, 0);
      grpNb += pNb; grpSum += pSum;
      const P = [];
      P.push('        <PmtInf>');
      P.push(`            <PmtInfId>${_esc(`${msgId}-${n}`.slice(-35))}</PmtInfId>`);
      P.push('            <PmtMtd>TRF</PmtMtd>');
      P.push('            <BtchBookg>false</BtchBookg>');
      P.push(`            <NbOfTxs>${pNb}</NbOfTxs>`);
      P.push(`            <CtrlSum>${_fmtSum(pSum)}</CtrlSum>`);
      P.push('            <ReqdExctnDt>');
      P.push(`                <Dt>${g.exec}</Dt>`);
      P.push('            </ReqdExctnDt>');
      P.push('            <Dbtr>');
      P.push(`                <Nm>${_esc(dbtrNm)}</Nm>`);
      if (dbtrAdr) P.push(..._pstlAdrLines(dbtrAdr, 16));
      else P.push('                <CtryOfRes>DE</CtryOfRes>');
      P.push('            </Dbtr>');
      P.push('            <DbtrAcct>');
      P.push('                <Id>');
      P.push(`                    <IBAN>${_esc(g.acc.iban)}</IBAN>`);
      P.push('                </Id>');
      P.push(`                <Ccy>${_esc(g.acc.ccy)}</Ccy>`);
      P.push('            </DbtrAcct>');
      P.push('            <DbtrAgt>');
      P.push(..._agent(g.acc.bic, 16));
      P.push('            </DbtrAgt>');
      if (g.fee) {
        P.push('            <ChrgsAcct>');
        P.push('                <Id>');
        P.push(`                    <IBAN>${_esc(g.fee.iban)}</IBAN>`);
        P.push('                </Id>');
        P.push(`                <Ccy>${_esc(g.fee.ccy)}</Ccy>`);
        P.push('            </ChrgsAcct>');
      }
      for (const x of g.tx) P.push(...x.lines);
      P.push('        </PmtInf>');
      pmtBlocks.push(P.join('\n'));
    }

    const out = [];
    out.push('<?xml version="1.0" encoding="UTF-8" standalone="yes"?>');
    out.push(`<Document xsi:schemaLocation="${NS_DST} pain.001.001.09.xsd" xmlns="${NS_DST}" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">`);
    out.push('    <CstmrCdtTrfInitn>');
    out.push('        <GrpHdr>');
    out.push(`            <MsgId>${_esc(msgId)}</MsgId>`);
    out.push(`            <CreDtTm>${creDtTm}</CreDtTm>`);
    out.push(`            <NbOfTxs>${grpNb}</NbOfTxs>`);
    out.push(`            <CtrlSum>${_fmtSum(grpSum)}</CtrlSum>`);
    out.push('            <InitgPty>');
    out.push(`                <Nm>${_esc(dbtrNm)}</Nm>`);
    out.push('            </InitgPty>');
    out.push('        </GrpHdr>');
    out.push(...pmtBlocks);
    out.push('    </CstmrCdtTrfInitn>');
    out.push('</Document>');
    const xml = out.join('\n');

    // Summen je Waehrung fuer die Anzeige
    const sums = {};
    for (const t of txns) sums[t.ccy] = (sums[t.ccy] || 0) + _milli(t.amount);
    Object.keys(sums).forEach(c => { sums[c] = _fmtMilli(sums[c], _ccyDigits(c)); });

    const accList = [...accounts.values()];
    accList.forEach(a => {
      if (!a.ibanOverridden) warnings.push(`Belastungskonto ${a.blz} / ${a.kto}: IBAN ${a.iban} aus BLZ und Kontonummer berechnet. Bitte einmal mit dem Kontoauszug abgleichen.`);
    });

    const firstGroup = groups.values().next().value;
    const stats = {
      srcVersion: 'DTAZV (Auslandszahlung)',
      dstVersion: 'pain.001.001.09 AXZ',
      msgId, creDtTm,
      initgParty: dbtrNm,
      debtor: dbtrNm,
      debtorIban: accList.map(a => a.iban).join(', '),
      execDate: firstGroup ? firstGroup.exec : '',
      nbOfTxs: grpNb,
      ctrlSum: _fmtSum(grpSum),
      sums,
      pmtInfCount: groups.size,
    };

    const preflight = preflightAxz(xml);
    preflight.errors.unshift(...convErrors);
    return { xml, stats, warnings, txns, accounts: accList, preflight, kind: 'axz' };
  }

  /**
   * Preflight fuer pain.001.001.09 AXZ (Auslandszahlung). Prueft die Punkte,
   * an denen Banken AXZ-Dateien ablehnen, zusaetzlich zur Schema-Struktur.
   * @returns {{errors:string[], notes:string[], nbOfTxs:number, ctrlSum:string}}
   */
  function preflightAxz(xmlText) {
    const errors = [], notes = [];
    const doc = new DOMParser().parseFromString(xmlText, 'application/xml');
    const root = doc.documentElement;
    if (!root || !/pain\.001\.001\.09/.test(root.namespaceURI || '')) errors.push('Namespace ist nicht pain.001.001.09.');

    const cti = _child(root, 'CstmrCdtTrfInitn');
    const grp = _child(cti, 'GrpHdr');
    const msgId = _txt(grp, 'MsgId');
    if (!msgId || msgId.length > 35) errors.push('GrpHdr/MsgId fehlt oder ist laenger als 35 Zeichen.');
    if (!_txt(grp, 'CreDtTm')) errors.push('GrpHdr/CreDtTm fehlt.');
    const grpNb = parseInt(_txt(grp, 'NbOfTxs'), 10);
    const grpSum = _milli(_txt(grp, 'CtrlSum'));

    const today = new Date(); today.setHours(0, 0, 0, 0);
    const chk = (who, label, s) => {
      const bad = _badSepa(s);
      if (bad.length) errors.push(`${who}: ${label} enthaelt Zeichen ausserhalb des SWIFT-Zeichensatzes: ${bad.join(' ')}`);
    };
    const chkAdr = (who, label, adr, required) => {
      if (!adr) { if (required) errors.push(`${who}: ${label} fehlt. Fuer AXZ sind mindestens Ort (TwnNm) und Land (Ctry) Pflicht.`); return; }
      const town = _txt(adr, 'TwnNm'), ctry = _txt(adr, 'Ctry');
      if (!town) errors.push(`${who}: Ort (TwnNm) fehlt in ${label}. Ohne Ort lehnt die Bank die AXZ-Datei ab.`);
      else if (town.length > 35) errors.push(`${who}: Ort in ${label} laenger als 35 Zeichen.`);
      if (!/^[A-Z]{2}$/.test(ctry)) errors.push(`${who}: Land (Ctry) fehlt oder ungueltig in ${label}.`);
      const lines = _children(adr, 'AdrLine');
      if (lines.length > 2) errors.push(`${who}: mehr als 2 Adresszeilen in ${label} (AXZ erlaubt hoechstens 2).`);
      lines.forEach(l => { if (l.textContent.trim().length > 70) errors.push(`${who}: Adresszeile in ${label} laenger als 70 Zeichen.`); chk(who, label, l.textContent); });
      chk(who, label, town);
    };

    let totalNb = 0, totalSum = 0, idx = 0;
    for (const pmt of _children(cti, 'PmtInf')) {
      const pid = _txt(pmt, 'PmtInfId');
      if (!/^(TRF|CHK)$/.test(_txt(pmt, 'PmtMtd'))) errors.push(`PmtInf ${pid}: PmtMtd muss TRF oder CHK sein.`);
      if (_child(pmt, 'PmtTpInf')) errors.push(`PmtInf ${pid}: PmtTpInf gehoert bei AXZ in jede Zahlung, nicht in den PmtInf-Block.`);
      if (_child(pmt, 'ChrgBr')) errors.push(`PmtInf ${pid}: ChrgBr gehoert bei AXZ in jede Zahlung, nicht in den PmtInf-Block.`);
      const exec = _deepTxt(pmt, ['ReqdExctnDt', 'Dt']);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(exec)) errors.push(`PmtInf ${pid}: ReqdExctnDt/Dt fehlt oder ungueltig.`);
      else if (new Date(exec + 'T00:00:00') < today) notes.push(`Ausfuehrungsdatum ${exec.split('-').reverse().join('.')} liegt in der Vergangenheit. Die Bank fuehrt am naechsten Bankarbeitstag aus.`);

      const dbtr = _child(pmt, 'Dbtr');
      const dNm = _txt(dbtr, 'Nm');
      if (!dNm) errors.push(`PmtInf ${pid}: Name des Auftraggebers fehlt.`);
      chk('Auftraggeber', 'Name', dNm);
      const dAdr = _child(dbtr, 'PstlAdr');
      if (dAdr) chkAdr('Auftraggeber', 'Adresse', dAdr, true);
      else if (!/^[A-Z]{2}$/.test(_txt(dbtr, 'CtryOfRes'))) errors.push('Auftraggeber: ohne Adresse ist das Sitzland (CtryOfRes) Pflicht.');

      const dIban = _deepTxt(pmt, ['DbtrAcct', 'Id', 'IBAN']);
      if (!_ibanValid(dIban)) errors.push(`PmtInf ${pid}: Auftraggeber-IBAN ungueltig (${dIban || 'leer'}).`);
      if (!/^[A-Z]{3}$/.test(_txt(_child(pmt, 'DbtrAcct'), 'Ccy'))) errors.push(`PmtInf ${pid}: Kontowaehrung (DbtrAcct/Ccy) fehlt, bei AXZ Pflicht.`);
      const dBic = _deepTxt(pmt, ['DbtrAgt', 'FinInstnId', 'BICFI']);
      if (dBic && !_bicOk(dBic)) errors.push(`PmtInf ${pid}: Auftraggeber-BIC ungueltig (${dBic}).`);

      let pNb = 0, pSum = 0;
      for (const tx of _children(pmt, 'CdtTrfTxInf')) {
        idx++;
        const cdtr = _child(tx, 'Cdtr');
        const nm = _txt(cdtr, 'Nm');
        const who = `#${idx} ${nm}`;
        const e2e = _txt(_child(tx, 'PmtId'), 'EndToEndId');
        if (!e2e || e2e.length > 35) errors.push(`${who}: EndToEndId fehlt oder ist laenger als 35 Zeichen.`);
        else if (/^\/|\/$|\/\//.test(e2e)) errors.push(`${who}: EndToEndId darf nicht mit "/" beginnen oder enden und kein "//" enthalten.`);
        chk(who, 'EndToEndId', e2e);

        const svc = _deepTxt(tx, ['PmtTpInf', 'SvcLvl', 'Cd']);
        if (!/^(NURG|URGP|SDVA)$/.test(svc)) errors.push(`${who}: Service Level (PmtTpInf/SvcLvl) muss NURG, URGP oder SDVA sein.`);
        const chrg = _txt(tx, 'ChrgBr');
        if (!/^(DEBT|CRED|SHAR)$/.test(chrg)) errors.push(`${who}: Entgeltregelung (ChrgBr) muss DEBT, CRED oder SHAR sein${chrg ? ` (ist ${chrg})` : ''}.`);

        const amtEl = _child(_child(tx, 'Amt'), 'InstdAmt');
        const amt = amtEl ? amtEl.textContent.trim() : '';
        const ccy = amtEl ? (amtEl.getAttribute('Ccy') || '').toUpperCase() : '';
        const m = _milli(amt);
        if (!/^[A-Z]{3}$/.test(ccy)) errors.push(`${who}: Waehrung fehlt oder ungueltig.`);
        if (isNaN(m)) errors.push(`${who}: Betrag nicht lesbar (${amt}).`);
        else if (m <= 0) errors.push(`${who}: Betrag <= 0.`);
        else {
          const dec = (amt.split('.')[1] || '').length;
          if (dec > _ccyDigits(ccy)) errors.push(`${who}: ${ccy} erlaubt hoechstens ${_ccyDigits(ccy)} Nachkommastellen (${amt}).`);
          if (ccy === 'EUR' && m > 50000000) notes.push(`${who}: ueber 50.000 EUR ins Ausland. AWV-Meldung (Z4) bis zum 7. Geschaeftstag des Folgemonats im Meldeportal der Bundesbank abgeben, die Zahldatei ersetzt sie nicht.`);
        }

        const bic = _deepTxt(tx, ['CdtrAgt', 'FinInstnId', 'BICFI']);
        const bankNm = _deepTxt(tx, ['CdtrAgt', 'FinInstnId', 'Nm']);
        const iban = _deepTxt(tx, ['CdtrAcct', 'Id', 'IBAN']);
        const othr = _deepTxt(tx, ['CdtrAcct', 'Id', 'Othr', 'Id']);
        if (bic && !_bicOk(bic)) errors.push(`${who}: BIC der Empfaengerbank ungueltig (${bic}).`);
        if (!bic && !bankNm) {
          if (iban) notes.push(`${who}: ohne BIC der Empfaengerbank. Die Bank leitet sie aus der IBAN ab, wenn das Land das zulaesst.`);
          else errors.push(`${who}: Empfaengerbank fehlt (weder BIC noch Name).`);
        }
        if (!bic && bankNm) chkAdr(who, 'Adresse der Empfaengerbank', _child(_deepEl(tx, ['CdtrAgt', 'FinInstnId']), 'PstlAdr'), true);
        if (iban && !_ibanValid(iban)) errors.push(`${who}: Empfaenger-IBAN Pruefziffer falsch (${iban}).`);
        if (!iban && !othr) errors.push(`${who}: Konto des Empfaengers fehlt.`);

        if (!nm) errors.push(`#${idx}: Name des Empfaengers fehlt.`);
        else if (nm.length > 140) errors.push(`${who}: Empfaengername laenger als 140 Zeichen.`);
        chk(who, 'Name', nm);
        chkAdr(who, 'Adresse des Empfaengers', _child(cdtr, 'PstlAdr'), true);

        const ustrd = _txt(_child(tx, 'RmtInf'), 'Ustrd');
        if (ustrd.length > 140) errors.push(`${who}: Verwendungszweck laenger als 140 Zeichen.`);
        chk(who, 'Verwendungszweck', ustrd);

        pNb++; if (!isNaN(m)) pSum += m;
      }
      const hNb = parseInt(_txt(pmt, 'NbOfTxs'), 10);
      const hSum = _milli(_txt(pmt, 'CtrlSum'));
      if (hNb !== pNb) errors.push(`PmtInf ${pid}: NbOfTxs (${hNb}) != Posten (${pNb}).`);
      if (hSum !== pSum) errors.push(`PmtInf ${pid}: CtrlSum (${_txt(pmt, 'CtrlSum')}) != Summe der Posten (${_fmtSum(pSum)}).`);
      totalNb += pNb; totalSum += pSum;
    }
    if (!isNaN(grpNb) && grpNb !== totalNb) errors.push(`GrpHdr/NbOfTxs (${grpNb}) != Posten gesamt (${totalNb}).`);
    if (grpSum !== totalSum) errors.push(`GrpHdr/CtrlSum (${_txt(grp, 'CtrlSum')}) != Gesamtsumme (${_fmtSum(totalSum)}).`);

    return { errors, notes, nbOfTxs: totalNb, ctrlSum: _fmtSum(totalSum) };
  }

  function _deepEl(el, path) {
    let cur = el;
    for (const p of path) { cur = _child(cur, p); if (!cur) return null; }
    return cur;
  }

  global.convertPain001 = convertPain001;
  global.preflightPain009 = preflightPain009;
  global.convertDtazv = convertDtazv;
  global.preflightAxz = preflightAxz;
  global.isDtazv = isDtazv;
  global._sepaClean = _sepa;   // fuer Tests

})(typeof window !== 'undefined' ? window : globalThis);

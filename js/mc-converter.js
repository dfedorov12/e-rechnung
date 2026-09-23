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

    const today = new Date(); today.setHours(0, 0, 0, 0);
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
      if (execDate && /^\d{4}-\d{2}-\d{2}$/.test(execDate)) {
        const d = new Date(execDate + 'T00:00:00');
        if (d < today) warnings.push(`Ausfuehrungsdatum ${execDate} liegt in der Vergangenheit — die Bank setzt es i. d. R. auf den naechsten Bankarbeitstag.`);
      }

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

        if (ccy.toUpperCase() !== 'EUR') warnings.push(`Zahlung an "${cdtrNm}" in ${ccy} — SEPA-Ueberweisungen sind EUR; bitte pruefen.`);
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

    return { xml: out.join('\n'), stats, warnings, txns };
  }

  global.convertPain001 = convertPain001;
  global._sepaClean = _sepa;   // fuer Tests

})(typeof window !== 'undefined' ? window : globalThis);

// node tests/pruefbericht.test.js
// Auswertung der Prüfberichte (KoSIT-Daemon und Mustang) und Hinweistexte
const assert = require('assert');
const { parseReport } = require('../api/src/kosit.js');
const { parseMustangReport } = require('../api/src/mustang.js');
const { hinweisWarnungen } = require('../api/src/hinweis.js');

let n = 0;
const gleich = (ist, soll, m) => { assert.deepStrictEqual(ist, soll, m + ': ' + JSON.stringify(ist)); n++; };
const wahr = (b, m) => { assert.ok(b, m); n++; };
const msg = (lvl, code, text) => `<rep:message id="x" level="${lvl}" xpathLocation="/Invoice" code="${code}">${text}</rep:message>`;

// 1) KoSIT: abgelehnt mit 2 Warnungen und 3 Fehlern (wie R707497DQS)
let r = parseReport('<rep:report>' + msg('warning', 'UBL-CR-157', '[UBL-CR-157]-A UBL invoice should not include Department')
  + msg('warning', 'UBL-CR-220', '[UBL-CR-220]-A UBL invoice should not include Department')
  + [1, 2, 3].map(() => msg('error', 'PEPPOL-EN16931-R008', 'Document MUST not contain empty elements.')).join('')
  + '<rep:reject/></rep:report>', true);
gleich(r.konform, 'rot', 'abgelehnt');
gleich(r.errorCount, 3, 'nur echte Fehler');
gleich(r.warningCount, 2, 'Warnungen bleiben Warnungen');
wahr(/leere XML-Elemente/.test(r.hinweis), 'Hinweis zu R008: ' + r.hinweis);

// 2) KoSIT: angenommen mit Warnung -> gelb mit Hinweis, information zählt nicht
r = parseReport('<rep:report>' + msg('warning', 'BR-DE-21', 'Spezifikationskennung &amp; Profil')
  + msg('information', 'INFO-1', 'nur Info') + '<rep:accept/></rep:report>');
gleich(r.konform, 'gelb', 'gelb statt grün');
gleich(r.warningCount, 1, 'information nicht gezählt');
gleich(r.hinweis, 'Nur Warnungen, die Rechnung ist gültig: [BR-DE-21] Spezifikationskennung & Profil', 'Hinweis gelb');

// 3) KoSIT: unbekannter Fehler -> erster Fehler als Text, Warnung steuert die Regel nicht
r = parseReport('<rep:report>' + msg('warning', 'BR-CO-10', 'Summen-Warnung') + msg('error', 'BR-DE-99', 'Etwas Neues fehlt')
  + '<rep:reject/></rep:report>', true);
gleich(r.hinweis, 'Fehler laut Prüfbericht: [BR-DE-99] Etwas Neues fehlt', 'unbekannte Regel');

// 4) KoSIT: nur formale Leitweg-Regel -> grün mit Hinweis
r = parseReport('<rep:report>' + msg('error', 'BR-DE-15', 'Leitweg fehlt') + '<rep:reject/></rep:report>', true);
gleich(r.konform, 'gruen', 'formal ist kein Prüfgrund');
wahr(/formale XRechnung-Regeln/.test(r.hinweis), 'Hinweis formal');

// 5) KoSIT: alter SVRL-Weg funktioniert weiter
r = parseReport('<svrl:failed-assert flag="warning"><svrl:text>[BR-DE-21] SVRL-Warnung</svrl:text></svrl:failed-assert>');
gleich(r.konform, 'gelb', 'SVRL-Warnung');

// 6) Mustang: nur Warnungen -> gelb mit Hinweis
const must = w => `<validation><xml><summary status="valid"/><messages>${w}</messages></xml></validation>`;
r = parseMustangReport(must('<notice type="1">[BR-DE-21] Kennung</notice><notice>[BR-DE-21] Kennung</notice><warning>Zweite</warning>'), {});
gleich(r.konform, 'gelb', 'Mustang gelb');
gleich(r.hinweis, 'Nur Warnungen, die Rechnung ist gültig: [BR-DE-21] Kennung (und 1 weitere)', 'Mustang Hinweis');
r = parseMustangReport(must(''), {});
gleich([r.konform, r.hinweis], ['gruen', ''], 'Mustang grün ohne Hinweis');

// 7) Hinweistext
gleich(hinweisWarnungen([]), 'Nur Warnungen, die Rechnung ist gültig.', 'ohne Text');
wahr(hinweisWarnungen(['x'.repeat(300)]).length < 220, 'lange Warnung gekürzt');

console.log(`pruefbericht: ${n} Prüfungen grün`);

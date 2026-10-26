/**
 * Rechnungsadresse je Kunde (BT-49)
 * =================================
 * Die XRechnung braucht eine elektronische Adresse des Rechnungsempfängers. Das ist das
 * Rechnungspostfach des Kunden (z. B. rechnung@kunde.de), nicht die Adresse dessen, der
 * die Rechnung erstellt. Die App merkt sich die Adresse je Werk und Kunde und schlägt sie
 * beim nächsten Mal vor. Gespeichert wird in SharePoint (E-Rechnung/kunden-rechnungsmail.json,
 * js/sharepoint.js), nicht im Code, weil die Seite öffentlich ist.
 *
 * Eintrag: { werk, kundennummer, vat, name, mail, am, von }
 * Gesucht wird nach Kunden-Nr., dann USt-IdNr., dann Name, jeweils im selben Werk.
 */

function _kmNorm(s) {
  return String(s || '').trim().toLowerCase().replace(/\s+/g, ' ');
}

/** Passenden Eintrag zu einer Rechnung finden, sonst null. */
function kundenMailFinden(eintraege, d) {
  const werk = _kmNorm(d.gesellschaft || d.werk);
  const imWerk = e => !e.werk || !werk || _kmNorm(e.werk) === werk;
  const liste = (eintraege || []).filter(e => e && e.mail && imWerk(e));
  const gleich = (a, b) => a && b && _kmNorm(a) === _kmNorm(b);
  return liste.find(e => gleich(e.kundennummer, d.kundennummer))
    || liste.find(e => gleich(String(e.vat || '').replace(/\s+/g, ''), String(d.kaeufervat || '').replace(/\s+/g, '')))
    || liste.find(e => gleich(e.name, d.kaeufer))
    || null;
}

/** Gehört die Adresse zur eigenen Firma (gleiche Domain wie die Verkäufer-Mail)? */
function kundenMailIstEigen(mail, verkaeuferemail) {
  const domain = String(verkaeuferemail || '').split('@')[1];
  const m = String(mail || '').trim().toLowerCase();
  return !!(domain && m.endsWith('@' + domain.trim().toLowerCase()));
}

/**
 * Eintrag für eine exportierte Rechnung übernehmen. Gibt die neue Liste zurück, oder
 * null, wenn sich nichts ändert (Adresse schon bekannt, eigene Adresse, Leitweg-ID).
 */
function kundenMailUebernehmen(eintraege, d, von, jetzt) {
  const mail = String(d.kaeufermail || '').trim();
  if (!mail || d.leitwegid || kundenMailIstEigen(mail, d.verkaeuferemail)) return null;
  if (!d.kundennummer && !d.kaeufervat && !d.kaeufer) return null;
  const liste = (eintraege || []).slice();
  const alt = kundenMailFinden(liste, d);
  if (alt && _kmNorm(alt.mail) === _kmNorm(mail)) return null;
  const neu = {
    werk: String(d.gesellschaft || '').toUpperCase(),
    kundennummer: d.kundennummer || (alt && alt.kundennummer) || '',
    vat: String(d.kaeufervat || (alt && alt.vat) || '').replace(/\s+/g, ''),
    name: d.kaeufer || (alt && alt.name) || '',
    mail,
    am: jetzt || new Date().toISOString(),
    von: von || '',
  };
  if (alt) liste[liste.indexOf(alt)] = neu; else liste.push(neu);
  return liste;
}

/**
 * Zeilen „Werk;Kunden-Nr.;Kunde;Mail“ (auch mit Tab oder Komma getrennt) einlesen.
 * Ungültige Zeilen werden gezählt, nicht übernommen.
 */
function kundenMailZeilen(text) {
  const eintraege = [];
  let fehler = 0;
  for (const roh of String(text || '').split(/\r?\n/)) {
    const z = roh.trim();
    if (!z || /^werk\s*[;\t,]/i.test(z)) continue;
    const t = z.split(/\s*[;\t]\s*/).length >= 4 ? z.split(/\s*[;\t]\s*/) : z.split(/\s*,\s*/);
    const [werk, kundennummer, name, mail] = t;
    if (!mail || !/^[^\s@]+@[^\s@]+\.[A-Za-z]{2,}$/.test(mail.trim())) { fehler++; continue; }
    eintraege.push({ werk: String(werk || '').trim().toUpperCase(), kundennummer: String(kundennummer || '').trim(),
      vat: '', name: String(name || '').trim(), mail: mail.trim() });
  }
  return { eintraege, fehler };
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { kundenMailFinden, kundenMailIstEigen, kundenMailUebernehmen, kundenMailZeilen };
}

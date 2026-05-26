/**
 * Zugriffskonfiguration – Exportverlauf nach Gesellschaft
 * =========================================================
 * Pflege: UPNs hier eintragen und per Git pushen.
 * UPNs sind die Microsoft-Login-E-Mail-Adressen (Groß-/Kleinschreibung egal).
 * Ein UPN darf in mehreren Gesellschaften stehen.
 */
const ACCESS_CONFIG = {

  /** WGC – Walzengiesserei Coswig GmbH */
  wgc: [
    'fedorov@dihag.com',
    // weitere UPNs hier hinzufügen:
    // 'max.mustermann@dihag.com',
  ],

  /** SHB – Schmiedewerk Harkort Böcking GmbH */
  shb: [
    'fedorov@dihag.com',
    // weitere UPNs hier hinzufügen:
    // 'erika.musterfrau@dihag.com',
  ],

};

/* Labels für Dropdown & Tabellen-Badge */
const GESELLSCHAFT_LABELS = {
  wgc: 'WGC',
  shb: 'SHB',
};

/* ─────────────────────────────────────────── */

/**
 * Gibt zurück, auf welche Gesellschaften der UPN Zugriff hat.
 * @param   {string}   upn   Microsoft-Login-UPN (account.username)
 * @returns {string[]}       z.B. ['wgc'], ['shb'], ['wgc','shb'] oder []
 */
function getAccessFor(upn) {
  const u = (upn || '').toLowerCase().trim();
  return Object.keys(ACCESS_CONFIG).filter(g =>
    (ACCESS_CONFIG[g] || []).some(x => x.toLowerCase().trim() === u)
  );
}

/**
 * Zugriff des aktuell eingeloggten Users ermitteln.
 * Setzt getAuthUser() aus auth.js voraus.
 * @returns {string[]}
 */
function getCurrentUserAccess() {
  const account = typeof getAuthUser === 'function' ? getAuthUser() : null;
  return account ? getAccessFor(account.username) : [];
}

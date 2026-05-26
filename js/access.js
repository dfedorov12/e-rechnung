/**
 * Zugriffskonfiguration – Exportverlauf nach Gesellschaft
 * =========================================================
 * Standard-Fallback (greift wenn SP-Datei noch nicht existiert).
 * Laufende Konfiguration wird in SharePoint als JSON gespeichert
 * und per Admin-UI (einstellungen.html) gepflegt.
 */
const ACCESS_CONFIG_DEFAULT = {
  /** WGC – Walzengießerei Coswig GmbH */
  wgc: ['fedorov@dihag.com'],
  /** SHB – Stahl- und Hartgusswerk Bösdorf GmbH */
  shb: ['fedorov@dihag.com'],
};

/* Vollständige Firmenbezeichnungen */
const GESELLSCHAFT_NAMES = {
  wgc: 'Walzengießerei Coswig GmbH',
  shb: 'Stahl- und Hartgusswerk Bösdorf GmbH',
};

/* Kurz-Labels für Badges & Tabs */
const GESELLSCHAFT_LABELS = {
  wgc: 'WGC',
  shb: 'SHB',
};

/* Admin-UPNs – dürfen die Einstellungen-Seite sehen */
const ADMIN_UPNS = ['administrator@dihag.com'];

/* ── Laufzeit-Config (wird aus SharePoint geladen) ── */
let _runtimeConfig = null; // null = noch nicht geladen

function _activeConfig() {
  return _runtimeConfig || ACCESS_CONFIG_DEFAULT;
}

/**
 * Laufzeit-Config aus SharePoint laden.
 * Wird einmalig nach Login aufgerufen; bei Fehler greift der Default.
 * Abhängig von spLoadAccessConfig() aus sharepoint.js.
 */
async function loadRuntimeAccessConfig() {
  if (_runtimeConfig) return; // bereits geladen
  try {
    const cfg = await spLoadAccessConfig();
    if (cfg && typeof cfg === 'object') {
      _runtimeConfig = cfg;
    }
  } catch (e) {
    // Kein JSON in SharePoint → Fallback auf Default (kein Fehler)
    console.info('[access] Keine SP-Config gefunden, nutze Default.');
  }
}

/* ── Zugriffs-Checks ── */

/**
 * Gibt zurück, auf welche Gesellschaften der UPN Zugriff hat.
 * @param   {string}   upn
 * @returns {string[]}  z.B. ['wgc'], ['shb'], ['wgc','shb'] oder []
 */
function getAccessFor(upn) {
  const u = (upn || '').toLowerCase().trim();
  const cfg = _activeConfig();
  return Object.keys(cfg).filter(g =>
    (cfg[g] || []).some(x => x.toLowerCase().trim() === u)
  );
}

/**
 * Zugriff des aktuell eingeloggten Users ermitteln.
 * @returns {string[]}
 */
function getCurrentUserAccess() {
  const account = typeof getAuthUser === 'function' ? getAuthUser() : null;
  return account ? getAccessFor(account.username) : [];
}

/**
 * Prüft ob der UPN Admin ist.
 * @param {string} upn
 * @returns {boolean}
 */
function isAdmin(upn) {
  const u = (upn || '').toLowerCase().trim();
  return ADMIN_UPNS.some(x => x.toLowerCase().trim() === u);
}

/**
 * Prüft ob der aktuell eingeloggte User Admin ist.
 * @returns {boolean}
 */
function isCurrentUserAdmin() {
  const account = typeof getAuthUser === 'function' ? getAuthUser() : null;
  return account ? isAdmin(account.username) : false;
}

/**
 * Einstellungen-Tab in der Navigation ein-/ausblenden.
 * Muss nach Auth aufgerufen werden.
 */
function initAdminNav() {
  const link = document.getElementById('nav-einstellungen');
  if (!link) return;
  link.style.display = isCurrentUserAdmin() ? '' : 'none';
}

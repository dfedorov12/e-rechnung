/**
 * Microsoft Entra ID (Azure AD) Authentication Guard
 * MSAL.js 3.x — Single-Tenant: nur DIHAG-Konten
 */

const _AUTH = {
  clientId:    '50389599-4d5d-4267-8fef-38ff29080669',
  tenantId:    'fdb70646-023a-403b-a4b9-1f474a935123',
  redirectUri: 'https://dfedorov12.github.io/e-rechnung/',
};

let _msal = null;
let _account = null;

async function authInit() {
  _msal = new msal.PublicClientApplication({
    auth: {
      clientId:                _AUTH.clientId,
      authority:               `https://login.microsoftonline.com/${_AUTH.tenantId}`,
      redirectUri:             _AUTH.redirectUri,
      postLogoutRedirectUri:   _AUTH.redirectUri,
    },
    cache: {
      cacheLocation:        'sessionStorage',
      storeAuthStateInCookie: true,
    },
  });

  await _msal.initialize();

  // Redirect-Response verarbeiten (Rückkehr vom Login)
  let response = null;
  try {
    response = await _msal.handleRedirectPromise();
  } catch (err) {
    _showAuthError(err);
    return;
  }

  if (response) _account = response.account;

  const accounts = _msal.getAllAccounts();

  if (!_account && accounts.length === 0) {
    // Nicht angemeldet → Microsoft-Login starten
    await _msal.loginRedirect({ scopes: ['User.Read'], prompt: 'select_account' });
    return;
  }

  if (!_account) _account = accounts[0];
  _msal.setActiveAccount(_account);

  // Seite einblenden
  document.body.classList.remove('auth-guard');

  // User-Info in Header rendern
  _renderUser(_account);
}

function _renderUser(account) {
  const nameEl     = document.getElementById('auth-name');
  const initEl     = document.getElementById('auth-initials');
  const emailEl    = document.getElementById('auth-email');
  if (!nameEl) return;

  const display = account.name || account.username || '';
  const emailOnly = account.username || '';
  nameEl.textContent  = display;
  if (emailEl) emailEl.textContent = emailOnly;

  if (initEl) {
    const parts = display.trim().split(/\s+/).filter(Boolean);
    initEl.textContent = parts.length >= 2
      ? (parts[0][0] + parts[parts.length - 1][0]).toUpperCase()
      : display.slice(0, 2).toUpperCase();
  }
}

function authLogout() {
  if (_msal) _msal.logoutRedirect({ account: _account });
}

function getAuthUser() { return _account; }

function _showAuthError(err) {
  document.body.classList.remove('auth-guard');
  document.body.innerHTML = `
    <div style="min-height:100vh;display:flex;align-items:center;justify-content:center;
                font-family:'Segoe UI',sans-serif;background:#f9fafb;">
      <div style="background:#fff;border-radius:12px;padding:40px;max-width:440px;width:90%;
                  box-shadow:0 4px 24px rgba(0,0,0,.12);text-align:center;">
        <div style="font-size:48px;margin-bottom:16px;">⚠️</div>
        <h2 style="color:#1f2937;margin-bottom:8px;">Anmeldefehler</h2>
        <p style="color:#6b7280;font-size:14px;margin-bottom:20px;">${err.message || err}</p>
        <button onclick="location.reload()"
          style="padding:10px 24px;background:#1a56a0;color:#fff;border:none;
                 border-radius:6px;font-size:14px;font-weight:600;cursor:pointer;">
          Erneut versuchen
        </button>
      </div>
    </div>`;
}

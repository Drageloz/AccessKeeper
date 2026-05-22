// Detecta si la página actual es una pantalla de login (SSO, OAuth, form clásico)

const SSO_HOSTNAMES = [
  'login.microsoftonline.com',
  'accounts.google.com',
  'login.live.com',
  'account.microsoft.com',
  'login.windows.net',
  'sts.windows.net',
  'login.okta.com',
  'auth0.com',
  'sso.google.com',
  'adfs.',
  'ping.',
];

const LOGIN_URL_PATTERNS = [
  '/login',
  '/signin',
  '/sign-in',
  '/auth',
  '/sso',
  '/saml',
  '/oauth',
  '/openid',
  'returnurl=',
  'returnUrl=',
  '?next=',
];

function isLoginPage() {
  const url = window.location.href.toLowerCase();
  const hostname = window.location.hostname.toLowerCase();

  if (SSO_HOSTNAMES.some(h => hostname.includes(h))) return true;
  if (LOGIN_URL_PATTERNS.some(p => url.includes(p.toLowerCase()))) return true;
  if (document.querySelector('input[type="password"]')) return true;

  return false;
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message.action === 'getLoginState') {
    sendResponse({
      isLoginPage: isLoginPage(),
      url: window.location.href,
    });
  }
});

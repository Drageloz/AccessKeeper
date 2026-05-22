// Detecta si la página actual es una pantalla de login y auto-rellena credenciales

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

// Dispara eventos nativos para que frameworks como React/Angular reconozcan el cambio
function setNativeValue(el, value) {
  const descriptor = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value');
  descriptor.set.call(el, value);
  el.dispatchEvent(new Event('input', { bubbles: true }));
  el.dispatchEvent(new Event('change', { bubbles: true }));
}

function findVisibleField(selectors) {
  for (const sel of selectors) {
    const el = document.querySelector(sel);
    if (el && el.offsetParent !== null) return el;
  }
  return null;
}

function fillLoginForm(username, password) {
  const usernameField = findVisibleField([
    'input[type="email"]',
    'input[type="text"][name*="user" i]',
    'input[type="text"][name*="email" i]',
    'input[type="text"][name*="login" i]',
    'input[type="text"][id*="user" i]',
    'input[type="text"][id*="email" i]',
    'input[type="text"][id*="login" i]',
    'input[type="text"][autocomplete*="username" i]',
    'input[type="text"]',
  ]);

  const passwordField = document.querySelector('input[type="password"]');

  if (usernameField) {
    usernameField.focus();
    setNativeValue(usernameField, username);
  }

  if (passwordField) {
    setNativeValue(passwordField, password);
    passwordField.focus();
  }

  if (!usernameField && !passwordField) return;

  const submitBtn =
    document.querySelector('button[type="submit"]') ||
    document.querySelector('input[type="submit"]') ||
    document.querySelector('button[id*="submit" i]') ||
    document.querySelector('button[name*="submit" i]') ||
    document.querySelector('form button:not([type="button"])');

  if (submitBtn) {
    submitBtn.click();
  } else {
    (passwordField?.form || usernameField?.form)?.submit();
  }
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message.action === 'getLoginState') {
    sendResponse({ isLoginPage: isLoginPage(), url: window.location.href });
    return;
  }
  if (message.action === 'fillCredentials') {
    fillLoginForm(message.username, message.password);
    sendResponse({ ok: true });
  }
});

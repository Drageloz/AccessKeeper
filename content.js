// Detects login state and handles all auth strategies: normal, SSO, and PAM multi-step

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
  '/login', '/signin', '/sign-in', '/auth',
  '/sso', '/saml', '/oauth', '/openid',
  'returnurl=', 'returnUrl=', '?next=',
];

function isLoginPage() {
  const url = window.location.href.toLowerCase();
  const hostname = window.location.hostname.toLowerCase();
  if (SSO_HOSTNAMES.some(h => hostname.includes(h))) return true;
  if (LOGIN_URL_PATTERNS.some(p => url.includes(p.toLowerCase()))) return true;
  if (document.querySelector('input[type="password"]')) return true;
  return false;
}

// Fires native input/change events so React/Angular forms detect the value change
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

function findUsernameField() {
  return findVisibleField([
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
}

function findSubmitButton() {
  return (
    document.querySelector('button[type="submit"]') ||
    document.querySelector('input[type="submit"]') ||
    document.querySelector('button[id*="submit" i]') ||
    document.querySelector('button[name*="submit" i]') ||
    document.querySelector('form button:not([type="button"])')
  );
}

function findNextButton() {
  const nextKeywords = ['next', 'continue'];
  const buttons = document.querySelectorAll('button, input[type="submit"], input[type="button"]');
  for (const btn of buttons) {
    const text = (btn.textContent || btn.value || '').toLowerCase().trim();
    if (nextKeywords.some(kw => text === kw || text.startsWith(kw))) return btn;
  }
  return findSubmitButton();
}

function findSSOButton() {
  // Check button/link text
  const clickable = document.querySelectorAll('button, a, input[type="button"], input[type="submit"]');
  for (const el of clickable) {
    const text = (el.textContent || el.value || '').toLowerCase().trim();
    if (text === 'sso' || text.includes(' sso') || text.startsWith('sso ') ||
        text.includes('single sign-on') || text.includes('sign in with sso')) {
      return el;
    }
  }
  // Check by attribute
  return document.querySelector(
    '[id*="sso" i]:is(button,a), [class*="sso" i]:is(button,a), [name*="sso" i]:is(button,a)'
  );
}

function findOTPField() {
  return findVisibleField([
    'input[autocomplete="one-time-code"]',
    'input[name*="otp" i]',
    'input[name*="totp" i]',
    'input[name*="token" i]',
    'input[name*="mfa" i]',
    'input[name*="code" i]',
    'input[id*="otp" i]',
    'input[id*="token" i]',
    'input[id*="mfa" i]',
    'input[placeholder*="otp" i]',
    'input[placeholder*="token" i]',
    'input[placeholder*="code" i]',
  ]) || (() => {
    // Fallback: short numeric input (OTP fields are typically 6-8 digits)
    const inputs = document.querySelectorAll('input[type="text"], input[type="number"], input[inputmode="numeric"]');
    for (const el of inputs) {
      if (el.maxLength >= 4 && el.maxLength <= 8 && el.offsetParent !== null) return el;
    }
    return null;
  })();
}

// --- Normal login: fill username + password and submit ---
function fillCredentials(username, password) {
  const usernameField = findUsernameField();
  const passwordField = document.querySelector('input[type="password"]');

  if (usernameField) { usernameField.focus(); setNativeValue(usernameField, username); }
  if (passwordField) { setNativeValue(passwordField, password); passwordField.focus(); }
  if (!usernameField && !passwordField) return;

  const btn = findSubmitButton();
  if (btn) btn.click();
  else (passwordField?.form || usernameField?.form)?.submit();
}

// --- PAM step 1: fill username and click Next ---
function fillUsernameAndNext(username) {
  const usernameField = findUsernameField();
  if (!usernameField) return;
  usernameField.focus();
  setNativeValue(usernameField, username);
  const btn = findNextButton();
  if (btn) btn.click();
  else usernameField.form?.submit();
}

// --- PAM step 2: fill password and submit ---
function fillPassword(password) {
  const passwordField = document.querySelector('input[type="password"]');
  if (!passwordField) return;
  setNativeValue(passwordField, password);
  passwordField.focus();
  const btn = findSubmitButton();
  if (btn) btn.click();
  else passwordField.form?.submit();
}

// --- PAM step 3: fill OTP and submit ---
function fillOTP(otp) {
  const otpField = findOTPField();
  if (!otpField) return;
  otpField.focus();
  setNativeValue(otpField, otp);
  const btn = findSubmitButton();
  if (btn) btn.click();
  else otpField.form?.submit();
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  switch (message.action) {
    case 'getLoginState':
      sendResponse({ isLoginPage: isLoginPage(), url: window.location.href });
      break;
    case 'fillCredentials':
      fillCredentials(message.username, message.password);
      sendResponse({ ok: true });
      break;
    case 'fillUsernameAndNext':
      fillUsernameAndNext(message.username);
      sendResponse({ ok: true });
      break;
    case 'fillPassword':
      fillPassword(message.password);
      sendResponse({ ok: true });
      break;
    case 'fillOTP':
      fillOTP(message.otp);
      sendResponse({ ok: true });
      break;
    case 'clickSSO': {
      const btn = findSSOButton();
      if (btn) btn.click();
      sendResponse({ clicked: !!btn });
      break;
    }
  }
});

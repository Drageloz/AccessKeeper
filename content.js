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
  // SSO-only pages (no password field, just a BNS/SSO button)
  if (findSSOButton() !== null) return true;
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
    'input[placeholder*="Scotia ID" i]', // PAM-specific field
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
  const keywords = ['sso', 'bns', 'single sign-on', 'sign in with sso', 'sign in with bns'];
  const clickable = document.querySelectorAll('button, a, input[type="button"], input[type="submit"]');
  for (const el of clickable) {
    const text = (el.textContent || el.value || '').toLowerCase().trim();
    if (keywords.some(kw => text === kw || text.includes(kw))) return el;
  }
  return document.querySelector(
    '[id*="sso" i]:is(button,a), [class*="sso" i]:is(button,a), [name*="sso" i]:is(button,a),' +
    '[id*="bns" i]:is(button,a), [class*="bns" i]:is(button,a)'
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

// Checks all common patterns a page might use to mark a button as non-interactive
function isButtonClickable(btn) {
  if (!btn) return false;
  if (btn.disabled) return false;
  if (btn.getAttribute('aria-disabled') === 'true') return false;
  if (/\bdisabled\b/i.test(btn.className)) return false;
  if (btn.offsetParent === null) return false; // not visible
  return true;
}

// Polls until the button is clickable, or until timeout.
// On timeout returns the button anyway — better to try than to give up.
function waitForEnabledButton(finderFn, timeoutMs = 10000) {
  return new Promise(resolve => {
    const deadline = Date.now() + timeoutMs;
    const check = () => {
      const btn = finderFn();
      if (isButtonClickable(btn)) return resolve(btn);
      if (Date.now() >= deadline) return resolve(finderFn() || null); // try anyway
      setTimeout(check, 400);
    };
    check();
  });
}

// --- PAM step 1: fill Scotia ID (username) and click Next ---
// Dispatches blur to trigger the form validation that activates the Next button,
// then polls until the button is actually clickable (can take a few seconds).
async function fillUsernameAndNext(username) {
  const usernameField = findUsernameField();
  if (!usernameField) return;
  usernameField.focus();
  setNativeValue(usernameField, username);
  usernameField.dispatchEvent(new Event('blur', { bubbles: true }));
  const btn = await waitForEnabledButton(findNextButton, 10000);
  if (btn) btn.click();
  else usernameField.form?.submit();
}

// --- PAM step 2: fill password + OTP together and submit ---
// Authentication Method is left untouched (already has its default value).
function fillPasswordAndOTP(password, otp) {
  const passwordField = document.querySelector('input[type="password"]');
  const otpField = findOTPField();

  if (passwordField) { setNativeValue(passwordField, password); passwordField.focus(); }
  if (otpField)      { setNativeValue(otpField, otp); }

  if (!passwordField && !otpField) return;
  const btn = findSubmitButton();
  if (btn) btn.click();
  else (passwordField?.form || otpField?.form)?.submit();
}

// --- Standalone OTP fill (fallback) ---
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
    case 'hasLoginForm':
      sendResponse({ hasLoginForm: !!(findUsernameField() || document.querySelector('input[type="password"]')) });
      break;
    case 'fillCredentials':
      fillCredentials(message.username, message.password);
      sendResponse({ ok: true });
      break;
    case 'fillUsernameAndNext':
      fillUsernameAndNext(message.username); // async — respond immediately, polling runs in background
      sendResponse({ ok: true });
      break;
    case 'fillPasswordAndOTP':
      fillPasswordAndOTP(message.password, message.otp);
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

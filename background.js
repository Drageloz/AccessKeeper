importScripts('./sites.js');

// --- Pending checks ---
// Structure: { "tabId": { siteId, hadLoginPage, step } }
// Steps: 'initial' | 'normal_attempted' | 'sso_attempted' |
//        'pam_password' | 'pam_otp' | 'pam_otp_submitted'

async function getPending() {
  const data = await chrome.storage.session.get('pendingChecks');
  return data.pendingChecks || {};
}

async function setPending(tabId, siteId, hadLoginPage = false, step = 'initial') {
  const checks = await getPending();
  checks[String(tabId)] = { siteId, hadLoginPage, step };
  await chrome.storage.session.set({ pendingChecks: checks });
}

async function removePending(tabId) {
  const checks = await getPending();
  delete checks[String(tabId)];
  await chrome.storage.session.set({ pendingChecks: checks });
}

// --- Site status ---

async function getStatuses() {
  const data = await chrome.storage.local.get('siteStatuses');
  return data.siteStatuses || {};
}

async function updateSiteStatus(siteId, status) {
  const statuses = await getStatuses();
  const prev = statuses[siteId] || {};
  statuses[siteId] = {
    status,
    lastChecked: Date.now(),
    lastActive: status === 'active' ? Date.now() : (prev.lastActive || null),
  };
  await chrome.storage.local.set({ siteStatuses: statuses });
  await updateBadge(statuses);
}

async function updateBadge(statuses) {
  if (!statuses) statuses = await getStatuses();
  const vals = Object.values(statuses);
  const otpCount     = vals.filter(s => s.status === 'otp').length;
  const expiredCount = vals.filter(s => s.status === 'expired').length;

  if (otpCount > 0) {
    await chrome.action.setBadgeText({ text: 'OTP' });
    await chrome.action.setBadgeBackgroundColor({ color: '#7c3aed' });
  } else if (expiredCount > 0) {
    await chrome.action.setBadgeText({ text: String(expiredCount) });
    await chrome.action.setBadgeBackgroundColor({ color: '#ef4444' });
  } else {
    await chrome.action.setBadgeText({ text: '' });
  }
}

// --- Auth strategy dispatcher ---

async function performCheck(tabId, entry) {
  const { siteId, hadLoginPage, step } = entry;

  let response;
  try {
    response = await chrome.tabs.sendMessage(tabId, { action: 'getLoginState' });
  } catch {
    await updateSiteStatus(siteId, 'unknown');
    await removePending(tabId);
    return;
  }

  // Not a login page = successfully authenticated
  if (!response?.isLoginPage) {
    await updateSiteStatus(siteId, 'active');
    await removePending(tabId);
    if (!hadLoginPage) {
      // Session was already valid: close the background tab
      setTimeout(() => chrome.tabs.remove(tabId).catch(() => {}), 1200);
    }
    return;
  }

  const credData = await chrome.storage.local.get('credentials');
  const creds = credData.credentials;
  const hasCreds = !!(creds?.username && creds?.password);
  const isPAMPage = (response.url || '').toLowerCase().includes('pam');

  // --- PAM multi-step flow ---
  if (isPAMPage) {
    if (!hasCreds) {
      await updateSiteStatus(siteId, 'expired');
      await removePending(tabId);
      return;
    }

    if (step === 'pam_otp_submitted') {
      // OTP was tried and the page is still a login page: nothing left to do
      await updateSiteStatus(siteId, 'expired');
      await removePending(tabId);
      return;
    }

    if (step === 'pam_otp') {
      // Page 2: Password + Authentication Method (default) + OTP are all visible.
      // Request OTP from the user — password and OTP will be submitted together.
      await updateSiteStatus(siteId, 'otp');
      await chrome.storage.local.set({ pendingOTP: { tabId, siteId } });
      return;
    }

    // Step 1: fill Scotia ID (username) and click Next.
    // Page 2 will show Password + Auth Method + OTP fields together.
    // The content script polls until the Next button is enabled before clicking.
    await setPending(tabId, siteId, true, 'pam_otp');
    setTimeout(async () => {
      try {
        await chrome.tabs.sendMessage(tabId, { action: 'fillUsernameAndNext', username: creds.username });
      } catch {}
    }, 1000);
    return;
  }

  // --- Step 1: try normal login (skip if SSO-only page with no form fields) ---
  if (step === 'initial' && hasCreds) {
    let hasForm = false;
    try {
      const formCheck = await chrome.tabs.sendMessage(tabId, { action: 'hasLoginForm' });
      hasForm = !!formCheck?.hasLoginForm;
    } catch {}

    if (hasForm) {
      await setPending(tabId, siteId, true, 'normal_attempted');
      setTimeout(async () => {
        try {
          await chrome.tabs.sendMessage(tabId, {
            action: 'fillCredentials',
            username: creds.username,
            password: creds.password,
          });
        } catch {}
      }, 400);
      return;
    }
    // SSO-only page — fall through to click the SSO button immediately
  }

  // --- Step 2: click SSO/BNS button ---
  // Runs for: SSO-only pages at 'initial' step, OR after a failed normal login attempt
  if (step === 'initial' || step === 'normal_attempted') {
    try {
      const result = await chrome.tabs.sendMessage(tabId, { action: 'clickSSO' });
      if (result?.clicked) {
        await setPending(tabId, siteId, true, 'sso_attempted');
        return; // wait for SSO redirect chain to settle
      }
    } catch {}
    // No SSO/BNS button found — fall through to expired
  }

  // --- Steps 3-5: try credentials after SSO redirect, up to 3 times ---
  // Each attempt handles one step of a multi-step SSO form (e.g. email → Next → password).
  const POST_SSO_STEPS = { 'sso_attempted': 'post_sso_1', 'post_sso_1': 'post_sso_2', 'post_sso_2': 'post_sso_3' };
  if (POST_SSO_STEPS[step] && hasCreds) {
    await setPending(tabId, siteId, true, POST_SSO_STEPS[step]);
    setTimeout(async () => {
      try {
        await chrome.tabs.sendMessage(tabId, {
          action: 'fillCredentials',
          username: creds.username,
          password: creds.password,
        });
      } catch {}
    }, 400);
    return;
  }

  // All strategies exhausted
  await updateSiteStatus(siteId, 'expired');
  await removePending(tabId);
}

// --- Tab tracking with debounce ---

const debounceTimers = {};

chrome.tabs.onUpdated.addListener(async (tabId, changeInfo) => {
  if (changeInfo.status !== 'complete') return;

  const checks = await getPending();
  if (!checks[String(tabId)]) return;

  // Reset timer on each 'complete' to wait for the full redirect chain to settle
  clearTimeout(debounceTimers[tabId]);
  debounceTimers[tabId] = setTimeout(async () => {
    delete debounceTimers[tabId];
    // Read entry fresh — it may have been updated since the listener fired
    const freshChecks = await getPending();
    const freshEntry = freshChecks[String(tabId)];
    if (freshEntry) await performCheck(tabId, freshEntry);
  }, 2000);
});

chrome.tabs.onRemoved.addListener(async (tabId) => {
  clearTimeout(debounceTimers[tabId]);
  delete debounceTimers[tabId];
  await chrome.storage.local.remove('pendingOTP');
  const checks = await getPending();
  if (checks[String(tabId)]) await removePending(tabId);
});

// --- Messages from popup ---

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  (async () => {
    if (message.action === 'checkSite') {
      await checkSite(message.siteId);
    } else if (message.action === 'checkAll') {
      checkAllSites();
    } else if (message.action === 'openSite') {
      const site = SITES.find(s => s.id === message.siteId);
      if (site) await chrome.tabs.create({ url: site.url, active: true });
    } else if (message.action === 'submitOTP') {
      const { tabId, siteId, otp } = message;
      await chrome.storage.local.remove('pendingOTP');
      await setPending(Number(tabId), siteId, true, 'pam_otp_submitted');
      const credData = await chrome.storage.local.get('credentials');
      setTimeout(async () => {
        try {
          await chrome.tabs.sendMessage(Number(tabId), {
            action: 'fillPasswordAndOTP',
            password: credData.credentials?.password,
            otp,
          });
        } catch {}
      }, 300);
    } else if (message.action === 'cancelOTP') {
      await chrome.storage.local.remove('pendingOTP');
      await updateSiteStatus(message.siteId, 'expired');
      await removePending(message.tabId);
    }
    sendResponse({ ok: true });
  })();
  return true;
});

// --- Site check logic ---

async function checkSite(siteId) {
  const site = SITES.find(s => s.id === siteId);
  if (!site) return;
  await updateSiteStatus(siteId, 'checking');
  const tab = await chrome.tabs.create({ url: site.url, active: false });
  await setPending(tab.id, siteId);
}

async function checkAllSites() {
  for (const site of SITES) {
    await checkSite(site.id);
    await new Promise(r => setTimeout(r, 700));
  }
}

// --- Auto-check alarm (twice a month) ---

async function initAlarm() {
  const alarm = await chrome.alarms.get('autoCheck');
  if (!alarm) chrome.alarms.create('autoCheck', { periodInMinutes: 21600 }); // every 15 days
}

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === 'autoCheck') checkAllSites();
});

initAlarm();
updateBadge();

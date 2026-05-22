importScripts('./sites.js');

// --- Pending checks (chrome.storage.session survives service worker restarts) ---
// Structure: { "tabId": { siteId, hadLoginPage, autoFillAttempted } }

async function getPending() {
  const data = await chrome.storage.session.get('pendingChecks');
  return data.pendingChecks || {};
}

async function setPending(tabId, siteId, hadLoginPage = false, autoFillAttempted = false) {
  const checks = await getPending();
  checks[String(tabId)] = { siteId, hadLoginPage, autoFillAttempted };
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
  const expired = Object.values(statuses).filter(s => s.status === 'expired').length;

  if (expired > 0) {
    await chrome.action.setBadgeText({ text: String(expired) });
    await chrome.action.setBadgeBackgroundColor({ color: '#ef4444' });
  } else {
    await chrome.action.setBadgeText({ text: '' });
  }
}

// --- Check logic ---

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

// --- Tab tracking ---

// Per-tab debounce: fires only after redirects have settled
const debounceTimers = {};

async function performCheck(tabId, siteId, hadLoginPage, autoFillAttempted) {
  try {
    const response = await chrome.tabs.sendMessage(tabId, { action: 'getLoginState' });

    if (response?.isLoginPage) {
      const credData = await chrome.storage.session.get('credentials');
      const hasCreds = !!(credData.credentials?.username && credData.credentials?.password);

      if (hasCreds && !autoFillAttempted) {
        // Credentials available and not yet tried: stay 'checking', attempt auto-fill.
        // The post-login redirect chain will trigger a new debounce cycle.
        await setPending(tabId, siteId, true, true);
        setTimeout(async () => {
          try {
            await chrome.tabs.sendMessage(tabId, {
              action: 'fillCredentials',
              username: credData.credentials.username,
              password: credData.credentials.password,
            });
          } catch {}
        }, 400);
      } else {
        // No credentials stored, or auto-fill already attempted and failed.
        await updateSiteStatus(siteId, 'expired');
        await setPending(tabId, siteId, true, autoFillAttempted);
      }
    } else {
      await updateSiteStatus(siteId, 'active');
      await removePending(tabId);

      if (!hadLoginPage) {
        // Session was already active: auto-close the tab
        setTimeout(() => chrome.tabs.remove(tabId).catch(() => {}), 1200);
      }
      // hadLoginPage=true means user just completed login — keep the tab open
    }
  } catch {
    // Content script did not respond (PDF, chrome://, etc.)
    await updateSiteStatus(siteId, 'unknown');
    await removePending(tabId);
  }
}

chrome.tabs.onUpdated.addListener(async (tabId, changeInfo) => {
  if (changeInfo.status !== 'complete') return;

  const checks = await getPending();
  const entry = checks[String(tabId)];
  if (!entry) return;

  // Reset timer on each 'complete' event to wait for the final page
  // after all redirects (including JS-based ones) have settled.
  clearTimeout(debounceTimers[tabId]);
  debounceTimers[tabId] = setTimeout(() => {
    delete debounceTimers[tabId];
    performCheck(tabId, entry.siteId, entry.hadLoginPage, entry.autoFillAttempted || false);
  }, 2000);
});

chrome.tabs.onRemoved.addListener(async (tabId) => {
  clearTimeout(debounceTimers[tabId]);
  delete debounceTimers[tabId];
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
    }
    sendResponse({ ok: true });
  })();
  return true;
});

// --- Auto-check alarm (every 4 hours) ---

async function initAlarm() {
  const alarm = await chrome.alarms.get('autoCheck');
  if (!alarm) chrome.alarms.create('autoCheck', { periodInMinutes: 240 });
}

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === 'autoCheck') checkAllSites();
});

initAlarm();
updateBadge();

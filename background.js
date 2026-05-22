import { SITES } from './sites.js';

// --- Pending checks (chrome.storage.session sobrevive reinicios del SW) ---
// Estructura: { "tabId": { siteId: string, hadLoginPage: boolean } }

async function getPending() {
  const data = await chrome.storage.session.get('pendingChecks');
  return data.pendingChecks || {};
}

async function setPending(tabId, siteId, hadLoginPage = false) {
  const checks = await getPending();
  checks[String(tabId)] = { siteId, hadLoginPage };
  await chrome.storage.session.set({ pendingChecks: checks });
}

async function removePending(tabId) {
  const checks = await getPending();
  delete checks[String(tabId)];
  await chrome.storage.session.set({ pendingChecks: checks });
}

// --- Estado de los sitios ---

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

// --- Lógica de verificación ---

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

// --- Seguimiento de tabs ---

chrome.tabs.onUpdated.addListener(async (tabId, changeInfo) => {
  if (changeInfo.status !== 'complete') return;

  const checks = await getPending();
  const entry = checks[String(tabId)];
  if (!entry) return;

  const { siteId, hadLoginPage } = entry;

  try {
    const response = await chrome.tabs.sendMessage(tabId, { action: 'getLoginState' });

    if (response?.isLoginPage) {
      await updateSiteStatus(siteId, 'expired');
      await setPending(tabId, siteId, true);

      // Auto-rellenar si el usuario tiene credenciales guardadas en sesión
      const credData = await chrome.storage.session.get('credentials');
      if (credData.credentials?.username && credData.credentials?.password) {
        setTimeout(async () => {
          try {
            await chrome.tabs.sendMessage(tabId, {
              action: 'fillCredentials',
              username: credData.credentials.username,
              password: credData.credentials.password,
            });
          } catch {}
        }, 900);
      }
    } else {
      await updateSiteStatus(siteId, 'active');
      await removePending(tabId);

      if (!hadLoginPage) {
        // Sesión ya estaba activa: cerrar tab automáticamente
        setTimeout(() => chrome.tabs.remove(tabId).catch(() => {}), 1200);
      }
      // Si hadLoginPage=true: el usuario acaba de loguearse, dejar el tab abierto
    }
  } catch {
    // El content script no respondió (PDF, chrome://, etc.)
    await updateSiteStatus(siteId, 'unknown');
    await removePending(tabId);
  }
});

chrome.tabs.onRemoved.addListener(async (tabId) => {
  const checks = await getPending();
  if (checks[String(tabId)]) {
    await removePending(tabId);
  }
});

// --- Mensajes desde el popup ---

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  (async () => {
    if (message.action === 'checkSite') {
      await checkSite(message.siteId);
    } else if (message.action === 'checkAll') {
      checkAllSites(); // no await: responde inmediatamente al popup
    } else if (message.action === 'openSite') {
      const site = SITES.find(s => s.id === message.siteId);
      if (site) await chrome.tabs.create({ url: site.url, active: true });
    }
    sendResponse({ ok: true });
  })();
  return true;
});

// --- Auto-verificación cada 4 horas ---

async function initAlarm() {
  const alarm = await chrome.alarms.get('autoCheck');
  if (!alarm) {
    chrome.alarms.create('autoCheck', { periodInMinutes: 240 });
  }
}

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === 'autoCheck') checkAllSites();
});

// Inicialización
initAlarm();
updateBadge();

const STATUS_CONFIG = {
  active:   { label: 'Active',         cssClass: 'status-active',   cardClass: 'card-active' },
  expired:  { label: 'Expired',        cssClass: 'status-expired',  cardClass: 'card-expired' },
  checking: { label: 'Checking',       cssClass: 'status-checking', cardClass: 'card-checking' },
  otp:      { label: 'OTP Required',   cssClass: 'status-otp',      cardClass: 'card-otp' },
  unknown:  { label: 'Unchecked',      cssClass: 'status-unknown',  cardClass: 'card-unknown' },
};

function formatTimeAgo(ts) {
  if (!ts) return null;
  const diff = Date.now() - ts;
  const mins  = Math.floor(diff / 60_000);
  const hours = Math.floor(mins / 60);
  const days  = Math.floor(hours / 24);
  if (mins < 1)   return 'just now';
  if (mins < 60)  return `${mins}m ago`;
  if (hours < 24) return `${hours}h ago`;
  return `${days}d ago`;
}

function buildMeta(siteStatus) {
  const parts = [];
  if (siteStatus.lastChecked) parts.push(`Checked ${formatTimeAgo(siteStatus.lastChecked)}`);
  if (siteStatus.lastActive)  parts.push(`Active ${formatTimeAgo(siteStatus.lastActive)}`);
  return parts.join(' · ') || 'Never checked';
}

function renderSites(statuses) {
  const list = document.getElementById('siteList');
  list.innerHTML = SITES.map(site => {
    const siteStatus = statuses[site.id] || { status: 'unknown' };
    const cfg = STATUS_CONFIG[siteStatus.status] || STATUS_CONFIG.unknown;
    const isChecking = siteStatus.status === 'checking' || siteStatus.status === 'otp';

    return `
      <div class="site-card ${cfg.cardClass}">
        <div class="site-info">
          <div class="site-row">
            <span class="site-name">${escapeHtml(site.name)}</span>
            <span class="status-badge ${cfg.cssClass}">
              <span class="status-dot"></span>
              ${cfg.label}
            </span>
          </div>
          <span class="site-description">${escapeHtml(site.description)}</span>
          <span class="site-meta">${buildMeta(siteStatus)}</span>
        </div>
        <div class="site-actions">
          <button class="btn btn-secondary btn-sm visit-btn" data-id="${site.id}" title="Open in new tab">Visit</button>
          <button class="btn btn-primary btn-sm check-btn" data-id="${site.id}" ${isChecking ? 'disabled' : ''}>
            ${isChecking ? '···' : 'Check'}
          </button>
        </div>
      </div>
    `;
  }).join('');

  list.querySelectorAll('.check-btn').forEach(btn => {
    btn.addEventListener('click', () => chrome.runtime.sendMessage({ action: 'checkSite', siteId: btn.dataset.id }));
  });
  list.querySelectorAll('.visit-btn').forEach(btn => {
    btn.addEventListener('click', () => chrome.runtime.sendMessage({ action: 'openSite', siteId: btn.dataset.id }));
  });
}

function escapeHtml(str) {
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

async function loadAndRender() {
  const data = await chrome.storage.local.get('siteStatuses');
  renderSites(data.siteStatuses || {});
}

loadAndRender();

document.getElementById('checkAllBtn').addEventListener('click', () => {
  chrome.runtime.sendMessage({ action: 'checkAll' });
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local') return;
  if (changes.siteStatuses) renderSites(changes.siteStatuses.newValue || {});
  if (changes.pendingOTP)   handlePendingOTPChange(changes.pendingOTP.newValue);
});

// --- Credentials ---

async function loadCredentialStatus() {
  const data = await chrome.storage.session.get('credentials');
  const creds = data.credentials;
  const statusEl = document.getElementById('credStatus');
  if (creds?.username && creds?.password) {
    statusEl.textContent = creds.username;
    statusEl.className = 'cred-status cred-set';
    document.getElementById('credUsername').value = creds.username;
  } else {
    statusEl.textContent = 'Not configured';
    statusEl.className = 'cred-status cred-not-set';
  }
}

document.getElementById('saveCredBtn').addEventListener('click', async () => {
  const username = document.getElementById('credUsername').value.trim();
  const password = document.getElementById('credPassword').value;
  if (!username || !password) return;
  await chrome.storage.session.set({ credentials: { username, password } });
  document.getElementById('credPassword').value = '';
  await loadCredentialStatus();
});

document.getElementById('clearCredBtn').addEventListener('click', async () => {
  await chrome.storage.session.remove('credentials');
  document.getElementById('credUsername').value = '';
  document.getElementById('credPassword').value = '';
  await loadCredentialStatus();
});

document.getElementById('credentialsToggle').addEventListener('click', () => {
  document.getElementById('credentialsBody').classList.toggle('expanded');
  document.getElementById('chevronIcon').classList.toggle('open');
});

loadCredentialStatus();

// --- OTP overlay ---

let currentOTPData = null;

function showOTPOverlay(otpData) {
  currentOTPData = otpData;
  const site = SITES.find(s => s.id === otpData.siteId);
  document.getElementById('otpSiteName').textContent = site ? site.name : otpData.siteId;
  document.getElementById('otpInput').value = '';
  document.getElementById('otpOverlay').classList.add('visible');
  setTimeout(() => document.getElementById('otpInput').focus(), 50);
}

function hideOTPOverlay() {
  currentOTPData = null;
  document.getElementById('otpOverlay').classList.remove('visible');
}

function handlePendingOTPChange(newValue) {
  if (newValue) showOTPOverlay(newValue);
  else hideOTPOverlay();
}

document.getElementById('otpSubmitBtn').addEventListener('click', () => {
  const otp = document.getElementById('otpInput').value.trim();
  if (!otp || !currentOTPData) return;
  chrome.runtime.sendMessage({ action: 'submitOTP', ...currentOTPData, otp });
  hideOTPOverlay();
});

document.getElementById('otpInput').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') document.getElementById('otpSubmitBtn').click();
});

document.getElementById('otpCancelBtn').addEventListener('click', () => {
  if (currentOTPData) {
    chrome.runtime.sendMessage({ action: 'cancelOTP', ...currentOTPData });
  }
  hideOTPOverlay();
});

// Check for a pending OTP request when popup opens
chrome.storage.local.get('pendingOTP').then(data => {
  if (data.pendingOTP) showOTPOverlay(data.pendingOTP);
});

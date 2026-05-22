import { SITES } from './sites.js';

const STATUS_CONFIG = {
  active:   { label: 'Activo',       cssClass: 'status-active',   cardClass: 'card-active' },
  expired:  { label: 'Expirado',     cssClass: 'status-expired',  cardClass: 'card-expired' },
  checking: { label: 'Verificando',  cssClass: 'status-checking', cardClass: 'card-checking' },
  unknown:  { label: 'Sin verificar',cssClass: 'status-unknown',  cardClass: 'card-unknown' },
};

function formatTimeAgo(ts) {
  if (!ts) return null;
  const diff = Date.now() - ts;
  const mins = Math.floor(diff / 60_000);
  const hours = Math.floor(mins / 60);
  const days = Math.floor(hours / 24);

  if (mins < 1)  return 'ahora mismo';
  if (mins < 60) return `hace ${mins}m`;
  if (hours < 24) return `hace ${hours}h`;
  return `hace ${days}d`;
}

function buildMeta(siteStatus) {
  const parts = [];
  if (siteStatus.lastChecked) parts.push(`Verificado ${formatTimeAgo(siteStatus.lastChecked)}`);
  if (siteStatus.lastActive)  parts.push(`Activo ${formatTimeAgo(siteStatus.lastActive)}`);
  return parts.join(' · ') || 'No verificado aún';
}

function renderSites(statuses) {
  const list = document.getElementById('siteList');

  list.innerHTML = SITES.map(site => {
    const siteStatus = statuses[site.id] || { status: 'unknown' };
    const cfg = STATUS_CONFIG[siteStatus.status] || STATUS_CONFIG.unknown;
    const isChecking = siteStatus.status === 'checking';

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
          <button class="btn btn-secondary btn-sm visit-btn" data-id="${site.id}" title="Abrir en nueva pestaña">
            Visitar
          </button>
          <button class="btn btn-primary btn-sm check-btn" data-id="${site.id}" ${isChecking ? 'disabled' : ''}>
            ${isChecking ? '···' : 'Verificar'}
          </button>
        </div>
      </div>
    `;
  }).join('');

  list.querySelectorAll('.check-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      chrome.runtime.sendMessage({ action: 'checkSite', siteId: btn.dataset.id });
    });
  });

  list.querySelectorAll('.visit-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      chrome.runtime.sendMessage({ action: 'openSite', siteId: btn.dataset.id });
    });
  });
}

function escapeHtml(str) {
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

async function loadAndRender() {
  const data = await chrome.storage.local.get('siteStatuses');
  renderSites(data.siteStatuses || {});
}

// Render inicial
loadAndRender();

// Botón "Verificar Todo"
document.getElementById('checkAllBtn').addEventListener('click', () => {
  chrome.runtime.sendMessage({ action: 'checkAll' });
});

// Actualización en tiempo real cuando cambia el storage
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes.siteStatuses) {
    renderSites(changes.siteStatuses.newValue || {});
  }
});

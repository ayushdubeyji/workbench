/**
 * Smart Electronics Workbench Hub Frontend Application
 * State-of-the-Art Vanilla JS - Zero runtime external framework dependency
 * Features: Dynamic Light/Dark Theme, Real-time WebSocket Mirror, MCP Telemetry,
 * Inventory Manager, Lab Notebook & Logs, Toast Notifications.
 */

// ============================================================================
// 1. THEME SWITCHER (Light / Dark Mode)
// ============================================================================
const THEME_KEY = 'workbench_theme';

function initTheme() {
  const savedTheme = localStorage.getItem(THEME_KEY);
  const systemPrefersLight = window.matchMedia && window.matchMedia('(prefers-color-scheme: light)').matches;
  const initialTheme = savedTheme || (systemPrefersLight ? 'light' : 'dark');
  applyTheme(initialTheme, false);

  const themeBtn = document.getElementById('theme-toggle-btn');
  if (themeBtn) {
    themeBtn.addEventListener('click', () => {
      const currentTheme = document.documentElement.getAttribute('data-theme') || 'dark';
      const newTheme = currentTheme === 'dark' ? 'light' : 'dark';
      applyTheme(newTheme, true);
    });
  }
}

function applyTheme(theme, notify = false) {
  document.body.classList.add('theme-transition');
  document.documentElement.setAttribute('data-theme', theme);
  localStorage.setItem(THEME_KEY, theme);

  const sunIcon = document.getElementById('theme-icon-sun');
  const moonIcon = document.getElementById('theme-icon-moon');
  const themeLabel = document.getElementById('theme-label');

  if (theme === 'light') {
    if (sunIcon) sunIcon.style.display = 'block';
    if (moonIcon) moonIcon.style.display = 'none';
    if (themeLabel) themeLabel.textContent = 'Light';
  } else {
    if (sunIcon) sunIcon.style.display = 'none';
    if (moonIcon) moonIcon.style.display = 'block';
    if (themeLabel) themeLabel.textContent = 'Dark';
  }

  if (notify) {
    showToast(`Switched to ${theme.toUpperCase()} theme`, 'info');
  }
  setTimeout(() => {
    document.body.classList.remove('theme-transition');
  }, 300);
}

// ============================================================================
// 2. TOAST NOTIFICATION SYSTEM
// ============================================================================
function showToast(message, type = 'info', duration = 3200) {
  const container = document.getElementById('toast-container');
  if (!container) return;

  const toast = document.createElement('div');
  toast.className = `toast toast-${type}`;
  
  const icon = type === 'success' ? '✓' : type === 'error' ? '✕' : 'ℹ';
  toast.innerHTML = `<span style="font-weight: 800; font-size: 14px; color: var(--accent);">${icon}</span><span>${escapeHtml(message)}</span>`;

  container.appendChild(toast);

  setTimeout(() => {
    toast.style.opacity = '0';
    toast.style.transform = 'translateY(10px) scale(0.95)';
    toast.style.transition = 'all 0.25s ease';
    setTimeout(() => {
      if (toast.parentNode) toast.parentNode.removeChild(toast);
    }, 260);
  }, duration);
}

// ============================================================================
// 3. GLOBAL APPLICATION STATE & ROUTING
// ============================================================================
const urlParams = new URLSearchParams(window.location.search);
const isKioskMode = urlParams.get('mode') === 'kiosk';

let kioskWs = null;
let reconnectAttempts = 0;
let reconnectTimer = null;
const MAX_RECONNECT_DELAY = 30000;
let lastKioskPayload = null;

// DOM Elements
const statusBadge = document.getElementById('connection-status');
const statusText = document.getElementById('status-text');
const modeToggleLink = document.getElementById('mode-toggle-link');

// Setup UI Mode
if (isKioskMode) {
  document.body.classList.add('kiosk-mode');
  if (modeToggleLink) {
    modeToggleLink.href = '/';
    modeToggleLink.innerHTML = `
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
        <rect x="3" y="3" width="18" height="18" rx="2"></rect>
      </svg>
      <span>Switch to Dashboard</span>
    `;
  }
} else {
  if (modeToggleLink) {
    modeToggleLink.href = '/?mode=kiosk';
  }
}

// ============================================================================
// 4. REAL-TIME CLOCK
// ============================================================================
function updateClock() {
  const now = new Date();
  const timeStr = now.toLocaleTimeString();
  const kioskClock = document.getElementById('kiosk-clock');
  if (kioskClock) kioskClock.textContent = timeStr;
  const kioskTs = document.getElementById('kiosk-footer-ts');
  if (kioskTs) kioskTs.textContent = now.toISOString().replace('T', ' ').substring(0, 19) + ' UTC';
}
setInterval(updateClock, 1000);
updateClock();

// ============================================================================
// 5. MARKDOWN / CONTENT RENDERER
// ============================================================================
function renderContent(type, content) {
  if (!content) return "<p><em>No content provided</em></p>";

  // Handle marked rendering
  if (window.marked && typeof window.marked.parse === 'function') {
    if (type === 'code') {
      return `<pre class="code-block"><code>${escapeHtml(content)}</code></pre>`;
    } else if (type === 'schematic' || type === 'pinout') {
      if (content.includes('|') || content.includes('```')) {
        return window.marked.parse(content);
      } else {
        return `<pre class="code-block" style="color: #7dd3fc;"><code>${escapeHtml(content)}</code></pre>`;
      }
    } else if (type === 'image') {
      return `<img src="${content}" class="workbench-img" alt="Workbench Schematic" style="max-width: 100%; border-radius: 8px;" />`;
    }
    return window.marked.parse(content);
  }

  // Plain text fallback
  return `<pre class="code-block"><code>${escapeHtml(content)}</code></pre>`;
}

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// ============================================================================
// 6. WEBSOCKET CONNECTION TO /ws/kiosk
// ============================================================================
function initKioskWebSocket() {
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  const wsUrl = `${protocol}//${window.location.host}/ws/kiosk`;

  setConnectionState(false, 'Connecting...');

  try {
    kioskWs = new WebSocket(wsUrl);

    kioskWs.onopen = () => {
      console.log('[WS] Connected to /ws/kiosk');
      if (reconnectTimer) {
        clearTimeout(reconnectTimer);
        reconnectTimer = null;
      }
      reconnectAttempts = 0;
      setConnectionState(true, 'Live Connected');
      showToast('Connected to Smart Workbench Daemon', 'success', 2000);
    };

    kioskWs.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data);
        if (data.type === 'ping') {
          kioskWs.send(JSON.stringify({ type: 'pong' }));
          return;
        }
        handleKioskPayload(data);
      } catch (err) {
        console.error('[WS] Payload error:', err);
      }
    };

    kioskWs.onclose = () => {
      setConnectionState(false, 'Disconnected (Reconnecting...)');
      scheduleReconnect();
    };

    kioskWs.onerror = (err) => {
      console.error('[WS] Error:', err);
      kioskWs.close();
    };
  } catch (e) {
    scheduleReconnect();
  }
}

function scheduleReconnect() {
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
  }
  reconnectAttempts++;
  const delay = Math.min(1000 * Math.pow(2, reconnectAttempts - 1), MAX_RECONNECT_DELAY);
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    initKioskWebSocket();
  }, delay);
}

function setConnectionState(connected, text) {
  if (statusBadge && statusText) {
    if (connected) {
      statusBadge.classList.remove('disconnected');
    } else {
      statusBadge.classList.add('disconnected');
    }
    statusText.textContent = text;
  }
}

function handleKioskPayload(payload) {
  lastKioskPayload = payload;
  const title = payload.title || 'Smart Workbench Notice';
  const type = payload.type || 'markdown';
  const content = payload.content || '';
  const html = renderContent(type, content);

  // Update Kiosk View elements
  const kioskTitle = document.getElementById('kiosk-display-title');
  const kioskType = document.getElementById('kiosk-display-type');
  const kioskBody = document.getElementById('kiosk-display-body');

  if (kioskTitle) kioskTitle.textContent = title;
  if (kioskType) kioskType.textContent = type.toUpperCase();
  if (kioskBody) kioskBody.innerHTML = html;

  // Update Dashboard Mirror Preview elements
  const mirrorTitle = document.getElementById('mirror-title');
  const mirrorBody = document.getElementById('mirror-body');
  const mirrorTs = document.getElementById('mirror-timestamp');
  const mirrorType = document.getElementById('mirror-screen-type');

  if (mirrorTitle) mirrorTitle.textContent = title;
  if (mirrorBody) mirrorBody.innerHTML = html;
  if (mirrorType) mirrorType.textContent = type.toUpperCase();
  if (mirrorTs) mirrorTs.textContent = 'Synced ' + (payload.timestamp ? payload.timestamp.substring(11, 19) : 'Just now');
}

// ============================================================================
// 7. MCP TELEMETRY & SYSTEM STATUS
// ============================================================================
async function fetchSystemStatus() {
  try {
    const res = await fetch('/api/status');
    if (!res.ok) return;
    const data = await res.json();

    const metricGroq = document.getElementById('metric-groq');
    const metricGemini = document.getElementById('metric-gemini');
    const metricTunnel = document.getElementById('metric-tunnel');
    const metricXiaozhi = document.getElementById('metric-xiaozhi');

    if (metricGroq) {
      metricGroq.innerHTML = `<span class="metric-pill ${data.groq_configured ? 'online' : 'offline'}"></span> Groq Active`;
    }
    if (metricGemini) {
      metricGemini.innerHTML = `<span class="metric-pill ${data.gemini_configured ? 'online' : 'offline'}"></span> Gemini 3.6`;
    }
    if (metricTunnel) {
      metricTunnel.innerHTML = `<span class="metric-pill ${data.cloudflare_tunnel_id ? 'online' : 'offline'}"></span> Connected`;
    }
    if (metricXiaozhi) {
      metricXiaozhi.innerHTML = `<span class="metric-pill online"></span> /ws/xiaozhi`;
    }
  } catch (e) {
    console.warn('[Status] Polling warning:', e);
  }
}

// ============================================================================
// 8. DASHBOARD INTERACTIONS
// ============================================================================
if (!isKioskMode) {
  // A. Segmented Tab Navigation
  const tabBtns = document.querySelectorAll('.tab-btn');
  const tabContents = document.querySelectorAll('.tab-content');

  tabBtns.forEach(btn => {
    btn.addEventListener('click', () => {
      const target = btn.getAttribute('data-tab');
      tabBtns.forEach(b => b.classList.remove('active'));
      tabContents.forEach(c => c.classList.remove('active'));
      btn.classList.add('active');
      const activeContent = document.getElementById(target);
      if (activeContent) activeContent.classList.add('active');

      if (target === 'tab-inventory') loadInventory();
      if (target === 'tab-logs') loadLogs();
    });
  });

  // B. Tab 1: Live Workbench & AI Copilot
  const btnSendPrompt = document.getElementById('btn-send-prompt');
  const promptInput = document.getElementById('prompt-input');

  async function sendPrompt(text) {
    if (!text || !text.trim()) return;
    btnSendPrompt.disabled = true;
    const originalText = btnSendPrompt.innerHTML;
    btnSendPrompt.innerHTML = `
      <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" class="status-dot">
        <circle cx="12" cy="12" r="10"></circle>
      </svg>
      <span>Copilot Processing...</span>
    `;

    try {
      const res = await fetch('/api/llm/prompt', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prompt: text.trim() })
      });
      const data = await res.json();
      promptInput.value = '';
      showToast(`Processed: ${data.title || 'Command executed'}`, 'success');
    } catch (e) {
      showToast(`Error: ${e}`, 'error');
    } finally {
      btnSendPrompt.disabled = false;
      btnSendPrompt.innerHTML = originalText;
    }
  }

  btnSendPrompt.addEventListener('click', () => sendPrompt(promptInput.value));
  promptInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
      sendPrompt(promptInput.value);
    }
  });

  // Quick Action Chips
  document.querySelectorAll('.chip').forEach(chip => {
    chip.addEventListener('click', () => {
      const promptText = chip.getAttribute('data-quick');
      promptInput.value = promptText;
      sendPrompt(promptText);
    });
  });

  // Direct Kiosk Push
  const btnDirectPush = document.getElementById('btn-direct-push');
  btnDirectPush.addEventListener('click', async () => {
    const title = document.getElementById('direct-title').value.trim() || 'Workbench Notice';
    const type = document.getElementById('direct-type').value;
    const content = document.getElementById('direct-content').value.trim();

    if (!content) {
      showToast('Please enter content to broadcast to the display.', 'error');
      return;
    }

    try {
      await fetch('/api/kiosk/show', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title, type, content })
      });
      document.getElementById('direct-content').value = '';
      showToast('Broadcast sent to benchtop kiosk', 'success');
    } catch (e) {
      showToast('Direct push failed: ' + e, 'error');
    }
  });

  // Mirror Action Buttons (Copy / Clear)
  const btnCopyMirror = document.getElementById('btn-copy-mirror');
  if (btnCopyMirror) {
    btnCopyMirror.addEventListener('click', () => {
      if (lastKioskPayload && lastKioskPayload.content) {
        navigator.clipboard.writeText(lastKioskPayload.content).then(() => {
          showToast('Display content copied to clipboard!', 'success');
        });
      } else {
        showToast('No display content to copy', 'info');
      }
    });
  }

  const btnClearMirror = document.getElementById('btn-clear-mirror');
  if (btnClearMirror) {
    btnClearMirror.addEventListener('click', () => {
      const mirrorBody = document.getElementById('mirror-body');
      const mirrorTitle = document.getElementById('mirror-title');
      if (mirrorBody) mirrorBody.innerHTML = '<p><em>Display mirror cleared.</em></p>';
      if (mirrorTitle) mirrorTitle.textContent = 'Display Idle';
      showToast('Display mirror cleared', 'info');
    });
  }

  // C. Tab 2: Inventory Catalog
  const invTbody = document.getElementById('inventory-tbody');
  const invSearch = document.getElementById('inv-search');
  const invCategoryFilter = document.getElementById('inv-category-filter');
  const btnRefreshInv = document.getElementById('btn-refresh-inv');
  const formAddInv = document.getElementById('form-add-inventory');

  async function loadInventory() {
    invTbody.innerHTML = '<tr><td colspan="6" style="text-align: center; color: var(--text-muted); padding: 24px;">Loading components...</td></tr>';
    const q = invSearch.value.trim();
    const cat = invCategoryFilter.value;
    const params = new URLSearchParams();
    if (q) params.append('q', q);
    if (cat && cat !== 'All') params.append('category', cat);

    try {
      const res = await fetch('/api/inventory?' + params.toString());
      const items = await res.json();

      // Update badge and stats
      const invBadge = document.getElementById('tab-inv-badge');
      if (invBadge) invBadge.textContent = items.length;

      const statTotal = document.getElementById('stat-total-parts');
      const statInStock = document.getElementById('stat-in-stock');
      const statLowStock = document.getElementById('stat-low-stock');
      const statCategories = document.getElementById('stat-categories');

      const inStockCount = items.filter(i => i.quantity > 0).length;
      const lowStockCount = items.filter(i => i.quantity <= 2).length;
      const uniqueCats = new Set(items.map(i => i.category || 'General')).size;

      if (statTotal) statTotal.textContent = items.length;
      if (statInStock) statInStock.textContent = inStockCount;
      if (statLowStock) statLowStock.textContent = lowStockCount;
      if (statCategories) statCategories.textContent = uniqueCats;

      if (!items.length) {
        invTbody.innerHTML = '<tr><td colspan="6" style="text-align: center; color: var(--text-muted); padding: 24px;">No components found. Click "+ Add New Component" above.</td></tr>';
        return;
      }

      invTbody.innerHTML = items.map(item => `
        <tr data-id="${item.id}">
          <td style="font-weight: 700; color: var(--text-bright);">${escapeHtml(item.component_name)}</td>
          <td>
            <div class="qty-control">
              <button class="qty-btn" onclick="adjustQty(${item.id}, -1)">-</button>
              <span style="font-weight: 800; min-width: 32px; text-align: center; color: ${item.quantity <= 2 ? 'var(--warning)' : 'var(--text-bright)'}">${item.quantity}</span>
              <button class="qty-btn" onclick="adjustQty(${item.id}, 1)">+</button>
            </div>
          </td>
          <td><span class="category-tag">${escapeHtml(item.category || 'General')}</span></td>
          <td style="color: var(--text-muted); font-size: 13px;">${escapeHtml(item.storage_location || 'Unassigned')}</td>
          <td style="font-size: 13px; color: var(--text-main);">${escapeHtml(item.notes || '-')}</td>
          <td>
            <button class="btn btn-danger btn-sm" onclick="deleteItem(${item.id})">Delete</button>
          </td>
        </tr>
      `).join('');
    } catch (e) {
      invTbody.innerHTML = `<tr><td colspan="6" style="color: var(--danger); padding: 24px;">Failed to load inventory: ${e}</td></tr>`;
    }
  }

  window.adjustQty = async function(id, delta) {
    try {
      await fetch(`/api/inventory/${id}/adjust`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ delta })
      });
      loadInventory();
    } catch (e) {
      showToast('Error updating quantity: ' + e, 'error');
    }
  };

  window.deleteItem = async function(id) {
    if (!confirm('Are you sure you want to remove this component from stock?')) return;
    try {
      await fetch(`/api/inventory/${id}`, { method: 'DELETE' });
      showToast('Component removed', 'info');
      loadInventory();
    } catch (e) {
      showToast('Error deleting item: ' + e, 'error');
    }
  };

  btnRefreshInv.addEventListener('click', () => {
    loadInventory();
    showToast('Inventory reloaded', 'info');
  });
  invSearch.addEventListener('input', debounce(loadInventory, 300));
  invCategoryFilter.addEventListener('change', loadInventory);

  formAddInv.addEventListener('submit', async (e) => {
    e.preventDefault();
    const component_name = document.getElementById('inv-name').value.trim();
    const quantity = parseInt(document.getElementById('inv-qty').value) || 0;
    const category = document.getElementById('inv-category').value;
    const storage_location = document.getElementById('inv-location').value.trim();
    const notes = document.getElementById('inv-notes').value.trim();

    try {
      await fetch('/api/inventory', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ component_name, quantity, category, storage_location, notes })
      });
      formAddInv.reset();
      showToast(`Added ${component_name} to catalog!`, 'success');
      loadInventory();
    } catch (err) {
      showToast('Failed to save component: ' + err, 'error');
    }
  });

  // D. Tab 3: Lab Notebook & Logs
  const formAddLog = document.getElementById('form-add-log');
  const logList = document.getElementById('log-list');
  const logSearch = document.getElementById('log-search');
  const logTypeFilter = document.getElementById('log-type-filter');
  const btnExportLogs = document.getElementById('btn-export-logs');

  async function loadLogs() {
    logList.innerHTML = '<div style="color: var(--text-muted); text-align: center; padding: 24px;">Loading lab notes...</div>';
    const q = logSearch.value.trim();
    const entry_type = logTypeFilter.value;
    const params = new URLSearchParams();
    if (q) params.append('q', q);
    if (entry_type && entry_type !== 'All') params.append('entry_type', entry_type);

    try {
      const res = await fetch('/api/logs?' + params.toString());
      const logs = await res.json();

      const logsBadge = document.getElementById('tab-logs-badge');
      if (logsBadge) logsBadge.textContent = logs.length;

      if (!logs.length) {
        logList.innerHTML = '<div style="color: var(--text-muted); text-align: center; padding: 24px;">No lab notes recorded yet.</div>';
        return;
      }

      logList.innerHTML = logs.map(l => `
        <div class="log-item ${l.entry_type || 'text'}">
          <div class="log-meta">
            <span class="log-type-tag">${escapeHtml(l.entry_type || 'note')}</span>
            <span>${escapeHtml(l.timestamp ? l.timestamp.substring(0, 19).replace('T', ' ') : '')}</span>
          </div>
          <div class="log-content">${renderContent('markdown', l.content)}</div>
          ${l.tags ? `<div style="margin-top: 8px; font-size: 11.5px; color: var(--text-muted);">Tags: <span style="color: var(--accent);">${escapeHtml(l.tags)}</span></div>` : ''}
        </div>
      `).join('');
    } catch (e) {
      logList.innerHTML = `<div style="color: var(--danger); padding: 24px;">Failed to load logs: ${e}</div>`;
    }
  }

  formAddLog.addEventListener('submit', async (e) => {
    e.preventDefault();
    const entry_type = document.getElementById('log-type').value;
    const content = document.getElementById('log-content').value.trim();
    const tags = document.getElementById('log-tags').value.trim();

    try {
      await fetch('/api/logs', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ entry_type, content, tags })
      });
      document.getElementById('log-content').value = '';
      document.getElementById('log-tags').value = '';
      showToast('Bench note recorded!', 'success');
      loadLogs();
    } catch (err) {
      showToast('Error recording log: ' + err, 'error');
    }
  });

  btnExportLogs.addEventListener('click', () => {
    window.open('/api/logs/export', '_blank');
  });

  logSearch.addEventListener('input', debounce(loadLogs, 300));
  logTypeFilter.addEventListener('change', loadLogs);

  // Initial Data Preload
  loadInventory();
  loadLogs();
  fetchSystemStatus();
  setInterval(fetchSystemStatus, 15000);
}

// Debounce helper
function debounce(fn, delay) {
  let timer = null;
  return function(...args) {
    clearTimeout(timer);
    timer = setTimeout(() => fn.apply(this, args), delay);
  };
}

// Initialize Theme & WebSocket
initTheme();
initKioskWebSocket();

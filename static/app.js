/**
 * Smart Electronics Workbench Hub Frontend Application
 * State-of-the-Art Vanilla JS - Zero runtime external framework dependency
 * Features:
 * - Accurate Xiaozhi WebSocket listener telemetry (listening vs connected)
 * - Dedicated Push-To-Talk (PTT) Web Voice Chatbot with SpeechSynthesis (TTS)
 * - Full Conversation Memory Continuity & Token Compaction
 * - Dynamic Contextual AI Suggestions based on live bench telemetry
 * - Full Projects & BOM Management Tab
 * - Inventory Overhaul with Quick Filter Tabs, Steppers & Stock Level Indicators
 * - Lab Notebook with Auto-highlighted Measurement Chips (V, A, Hz, GPIO)
 * - Real-time WebSocket Kiosk Mirror with zero-latency dispatch
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

let currentSessionId = 'workbench_default';
let kioskWs = null;
let reconnectAttempts = 0;
let reconnectTimer = null;
const MAX_RECONNECT_DELAY = 30000;
let lastKioskPayload = null;

// DOM Elements
const statusBadge = document.getElementById('connection-status');
const statusText = document.getElementById('status-text');
const modeToggleLink = document.getElementById('mode-toggle-link');
const deviceBadgeXiaozhi = document.getElementById('device-badge-xiaozhi');
const xiaozhiBadgeText = document.getElementById('xiaozhi-badge-text');

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
// 5. MARKDOWN / CONTENT RENDERER & MEASUREMENT CHIP HIGHLIGHTER
// ============================================================================
function renderContent(type, content) {
  if (!content) return "<p><em>No content provided</em></p>";

  // Highlight technical measurement tokens in content
  const highlighted = highlightMeasurementChips(content);

  // Handle marked rendering
  if (window.marked && typeof window.marked.parse === 'function') {
    if (type === 'code') {
      return `<pre class="code-block"><code>${escapeHtml(content)}</code></pre>`;
    } else if (type === 'schematic' || type === 'pinout') {
      if (content.includes('|') || content.includes('```')) {
        return window.marked.parse(highlighted);
      } else {
        return `<pre class="code-block" style="color: #7dd3fc;"><code>${escapeHtml(content)}</code></pre>`;
      }
    } else if (type === 'image') {
      return `<img src="${content}" class="workbench-img" alt="Workbench Schematic" style="max-width: 100%; border-radius: 8px;" />`;
    }
    return window.marked.parse(highlighted);
  }

  // Plain text fallback
  return `<pre class="code-block"><code>${escapeHtml(content)}</code></pre>`;
}

function highlightMeasurementChips(text) {
  if (!text) return "";
  // Don't modify code blocks directly
  return text
    // Voltages: e.g. 3.3V, 5.0V, 12V, 2.8V, 500mV
    .replace(/\b(\d+(?:\.\d+)?\s*(?:V|volts|mV))\b/gi, '<span class="meas-chip meas-volt">$1</span>')
    // Currents: e.g. 100mA, 250mA, 1.5A
    .replace(/\b(\d+(?:\.\d+)?\s*(?:mA|uA|A|amps))\b/gi, '<span class="meas-chip meas-curr">$1</span>')
    // Frequencies: e.g. 100kHz, 16MHz, 1kHz, 44.1kHz
    .replace(/\b(\d+(?:\.\d+)?\s*(?:kHz|MHz|GHz|Hz))\b/gi, '<span class="meas-chip meas-freq">$1</span>')
    // GPIO and Pinouts: e.g. GPIO4, Pin 6, Pin 9, Pin 14
    .replace(/\b(Pin\s*\d+|GPIO\s*\d+|[D]\d+|3V3|5V|GND|SDA|SCL|MOSI|MISO|SCK)\b/gi, '<span class="meas-chip meas-pin">$1</span>');
}

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// ============================================================================
// 6. WEBSOCKET CONNECTION TO /ws/kiosk (Zero-Latency Desk Mirror)
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
      showToast('Connected to Smart Workbench Hub', 'success', 2000);
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

  // Update Dashboard Mirror Preview elements (Full Kiosk View)
  const mirrorTitle = document.getElementById('mirror-title');
  const mirrorBody = document.getElementById('mirror-body');
  const mirrorTs = document.getElementById('mirror-timestamp');
  const mirrorType = document.getElementById('mirror-screen-type');

  if (mirrorTitle) mirrorTitle.textContent = title;
  if (mirrorBody) mirrorBody.innerHTML = html;
  if (mirrorType) mirrorType.textContent = type.toUpperCase();
  if (mirrorTs) mirrorTs.textContent = 'Synced ' + (payload.timestamp ? payload.timestamp.substring(11, 19) : 'Just now');

  // Update Dedicated 2.8" Soldering Station Display Mirror (Top Left)
  const solderingBody = document.getElementById('soldering-mirror-body');
  const solderingTitle = document.getElementById('soldering-mirror-title');
  const solderingTs = document.getElementById('soldering-mirror-timestamp');
  const solderingContent = payload.soldering_content || payload.content || '';

  if (solderingBody && solderingContent) {
    solderingBody.innerHTML = renderContent('markdown', solderingContent);
  }
  if (solderingTitle && title) {
    solderingTitle.textContent = title.toUpperCase();
  }
  if (solderingTs && payload.timestamp) {
    solderingTs.textContent = 'SPI0 Synced ' + payload.timestamp.substring(11, 19);
  }
}

// ============================================================================
// 7. SYSTEM STATUS & ACCURATE XIAOZHI COUNT (Objective 1)
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

    // Objective 1: Do NOT display green/online if count is 0!
    const clientCount = data.xiaozhi_clients || 0;
    if (deviceBadgeXiaozhi && xiaozhiBadgeText) {
      if (clientCount > 0) {
        deviceBadgeXiaozhi.className = 'device-badge connected';
        xiaozhiBadgeText.textContent = `Xiaozhi Active (${clientCount} Connected)`;
        deviceBadgeXiaozhi.title = `${clientCount} connected Xiaozhi edge device(s) active on /ws/xiaozhi`;
      } else {
        deviceBadgeXiaozhi.className = 'device-badge listening';
        xiaozhiBadgeText.textContent = 'Listening for Devices (0)';
        deviceBadgeXiaozhi.title = '0 connected Xiaozhi WebSocket devices. Flash ESP32-S3 or P4 firmware to connect.';
      }
    }

    if (metricXiaozhi) {
      if (clientCount > 0) {
        metricXiaozhi.innerHTML = `<span class="metric-pill online"></span> ${clientCount} Connected`;
      } else {
        metricXiaozhi.innerHTML = `<span class="metric-pill listening"></span> Listening (0 devices)`;
      }
    }
  } catch (e) {
    console.warn('[Status] Polling warning:', e);
  }
}

// ============================================================================
// 8. CONTEXTUAL AI SUGGESTIONS ENGINE (Objective 4)
// ============================================================================
async function loadContextualSuggestions() {
  const container = document.getElementById('dynamic-suggestions-bar');
  if (!container) return;

  try {
    const res = await fetch('/api/ai/suggestions');
    if (!res.ok) return;
    const data = await res.json();
    const suggestions = data.suggestions || [];

    if (!suggestions.length) {
      container.innerHTML = '<span style="font-size: 12px; color: var(--text-muted);">No suggestions available. Record notes or add projects.</span>';
      return;
    }

    container.innerHTML = suggestions.map(s => `
      <span class="suggestion-chip" data-prompt="${escapeHtml(s.prompt)}" title="${escapeHtml(s.prompt)}">
        <span>${escapeHtml(s.label)}</span>
      </span>
    `).join('');

    // Attach click listeners to auto-fill and dispatch
    container.querySelectorAll('.suggestion-chip').forEach(chip => {
      chip.addEventListener('click', () => {
        const promptText = chip.getAttribute('data-prompt');
        const promptInput = document.getElementById('prompt-input');
        if (promptInput) {
          promptInput.value = promptText;
          sendPrompt(promptText);
        }
      });
    });
  } catch (err) {
    console.warn('[Suggestions] Error loading:', err);
  }
}

// ============================================================================
// 9. DEDICATED PUSH-TO-TALK (PTT) WEB CHATBOT (Objective 7)
// ============================================================================
let isRecordingPTT = false;
let speechRecognition = null;
let mediaRecorder = null;
let audioChunks = [];

function initPushToTalk() {
  const btnPtt = document.getElementById('btn-ptt-mic');
  const pttStatus = document.getElementById('ptt-status');
  const pttTranscript = document.getElementById('ptt-transcript');
  const toggleTts = document.getElementById('toggle-tts-speech');
  const btnClearChat = document.getElementById('btn-clear-chat');

  if (!btnPtt) return;

  // Initialize Web Speech API if supported in browser
  const SpeechRecognitionAPI = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (SpeechRecognitionAPI) {
    speechRecognition = new SpeechRecognitionAPI();
    speechRecognition.continuous = false;
    speechRecognition.interimResults = true;
    speechRecognition.lang = 'en-US';

    speechRecognition.onstart = () => {
      isRecordingPTT = true;
      btnPtt.classList.add('recording');
      if (pttStatus) pttStatus.textContent = 'Listening to speech...';
      if (pttTranscript) pttTranscript.textContent = 'Speak your question or electronics command...';
    };

    speechRecognition.onresult = (event) => {
      let interim = '';
      let finalTranscript = '';
      for (let i = event.resultIndex; i < event.results.length; ++i) {
        if (event.results[i].isFinal) {
          finalTranscript += event.results[i][0].transcript;
        } else {
          interim += event.results[i][0].transcript;
        }
      }
      if (pttTranscript) {
        pttTranscript.textContent = finalTranscript || interim || 'Listening...';
      }
      if (finalTranscript) {
        handleVoiceQuery(finalTranscript.trim());
      }
    };

    speechRecognition.onerror = (event) => {
      console.warn('[PTT Speech Error]:', event.error);
      stopPTT();
      if (pttStatus) pttStatus.textContent = 'Voice Error';
      if (pttTranscript) pttTranscript.textContent = `Mic error: ${event.error}. Click mic to retry.`;
    };

    speechRecognition.onend = () => {
      stopPTT();
    };
  }

  function startPTT() {
    if (isRecordingPTT) return;
    if (speechRecognition) {
      try {
        speechRecognition.start();
      } catch (e) {
        console.warn('SpeechRecognition start error:', e);
      }
    } else {
      // Fallback: MediaRecorder audio capture
      navigator.mediaDevices.getUserMedia({ audio: true }).then(stream => {
        mediaRecorder = new MediaRecorder(stream);
        audioChunks = [];
        mediaRecorder.ondataavailable = e => audioChunks.push(e.data);
        mediaRecorder.onstop = async () => {
          const audioBlob = new Blob(audioChunks, { type: 'audio/webm' });
          await sendAudioBlobToBackend(audioBlob);
        };
        mediaRecorder.start();
        isRecordingPTT = true;
        btnPtt.classList.add('recording');
        if (pttStatus) pttStatus.textContent = 'Recording Audio...';
      }).catch(err => {
        showToast('Microphone access denied: ' + err, 'error');
      });
    }
  }

  function stopPTT() {
    isRecordingPTT = false;
    btnPtt.classList.remove('recording');
    if (speechRecognition) {
      try { speechRecognition.stop(); } catch (e) {}
    }
    if (mediaRecorder && mediaRecorder.state !== 'inactive') {
      mediaRecorder.stop();
    }
  }

  // Mouse & Touch Push-To-Talk events
  btnPtt.addEventListener('mousedown', startPTT);
  btnPtt.addEventListener('mouseup', stopPTT);
  btnPtt.addEventListener('touchstart', (e) => { e.preventDefault(); startPTT(); });
  btnPtt.addEventListener('touchend', (e) => { e.preventDefault(); stopPTT(); });

  // Keyboard shortcut: Spacebar (when not typing in an input)
  window.addEventListener('keydown', (e) => {
    if (e.code === 'Space' && !isRecordingPTT) {
      const activeTag = document.activeElement ? document.activeElement.tagName.toLowerCase() : '';
      if (activeTag !== 'input' && activeTag !== 'textarea') {
        e.preventDefault();
        startPTT();
      }
    }
  });

  window.addEventListener('keyup', (e) => {
    if (e.code === 'Space' && isRecordingPTT) {
      stopPTT();
    }
  });

  // Handle Voice Query to Backend with Full Context Continuity
  async function handleVoiceQuery(text) {
    if (!text) return;
    if (pttStatus) pttStatus.textContent = 'Copilot Reasoning...';
    if (pttTranscript) pttTranscript.textContent = `"${text}"`;

    try {
      const res = await fetch('/api/llm/prompt', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prompt: text, session_id: currentSessionId })
      });
      const data = await res.json();
      
      if (pttStatus) pttStatus.textContent = data.title || 'Response Synthesized';
      if (pttTranscript) pttTranscript.textContent = data.content ? data.content.substring(0, 160) + '...' : 'Response broadcast to display.';

      // TTS Voice Audio Output
      if (toggleTts && toggleTts.checked && window.speechSynthesis) {
        speakResponse(data.content || data.title);
      }

      showToast(`Copilot: ${data.title || 'Answer ready'}`, 'success');
      loadContextualSuggestions(); // Refresh suggestions with new context
    } catch (e) {
      if (pttStatus) pttStatus.textContent = 'Error';
      if (pttTranscript) pttTranscript.textContent = 'Query failed: ' + e;
    }
  }

  async function sendAudioBlobToBackend(blob) {
    if (pttStatus) pttStatus.textContent = 'Transcribing Voice with Whisper...';
    const formData = new FormData();
    formData.append('audio', blob, 'ptt_voice.webm');
    formData.append('session_id', currentSessionId);

    try {
      const res = await fetch('/api/chat/voice', {
        method: 'POST',
        body: formData
      });
      const data = await res.json();
      if (pttStatus) pttStatus.textContent = data.title || 'Response Synthesized';
      if (pttTranscript) pttTranscript.textContent = `"${data.transcript}" → ${data.response ? data.response.substring(0, 140) : ''}...`;

      if (toggleTts && toggleTts.checked && window.speechSynthesis && data.response) {
        speakResponse(data.response);
      }
      showToast('Voice command processed', 'success');
      loadContextualSuggestions();
    } catch (e) {
      if (pttStatus) pttStatus.textContent = 'Transcription Error';
      if (pttTranscript) pttTranscript.textContent = 'Failed to transcribe: ' + e;
    }
  }

  function speakResponse(fullText) {
    if (!fullText) return;
    window.speechSynthesis.cancel();
    // Clean markdown chars for cleaner voice
    const cleanSpeech = fullText
      .replace(/[#*`_~\[\]\(\)\|\{\}]/g, ' ')
      .replace(/<[^>]*>/g, ' ')
      .substring(0, 320);

    const utterance = new SpeechSynthesisUtterance(cleanSpeech);
    utterance.rate = 1.05;
    utterance.pitch = 1.0;
    window.speechSynthesis.speak(utterance);
  }

  // Clear Context & Start New Topic (Fixes real-world context confusion)
  if (btnClearChat) {
    btnClearChat.addEventListener('click', async () => {
      try {
        await fetch('/api/chat/clear', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ session_id: currentSessionId })
        });
        showToast('Topic context cleared! Started fresh conversation session.', 'info');
        if (pttStatus) pttStatus.textContent = 'Fresh Topic Ready';
        if (pttTranscript) pttTranscript.textContent = 'Context memory cleared. Ask any electronics question.';
        loadContextualSuggestions();
      } catch (err) {
        showToast('Failed to clear session: ' + err, 'error');
      }
    });
  }
}

// ============================================================================
// 10. PROJECTS & BOM MANAGEMENT (Objective 8)
// ============================================================================
async function loadProjects(statusFilter = 'All') {
  const container = document.getElementById('projects-grid');
  if (!container) return;

  container.innerHTML = '<div style="text-align: center; color: var(--text-muted); padding: 32px;">Loading engineering projects...</div>';

  try {
    const params = new URLSearchParams();
    if (statusFilter && statusFilter !== 'All') {
      params.append('status', statusFilter);
    }
    const res = await fetch('/api/projects?' + params.toString());
    const projects = await res.json();

    // Update Project Stats
    const statTotal = document.getElementById('stat-total-projects');
    const statProg = document.getElementById('stat-prog-projects');
    const statPlan = document.getElementById('stat-plan-projects');
    const statDone = document.getElementById('stat-done-projects');
    const projBadge = document.getElementById('tab-projects-badge');

    if (projBadge) projBadge.textContent = projects.length;
    if (statTotal) statTotal.textContent = projects.length;
    if (statProg) statProg.textContent = projects.filter(p => p.status === 'in_progress').length;
    if (statPlan) statPlan.textContent = projects.filter(p => p.status === 'planning').length;
    if (statDone) statDone.textContent = projects.filter(p => p.status === 'completed').length;

    if (!projects.length) {
      container.innerHTML = '<div style="text-align: center; color: var(--text-muted); padding: 32px;">No projects found. Click "+ Create New Engineering Project" above.</div>';
      return;
    }

    // Also fetch inventory to cross-reference BOM stock
    const invRes = await fetch('/api/inventory');
    const invItems = await invRes.json();
    const invMap = {};
    invItems.forEach(item => {
      invMap[item.component_name.toLowerCase()] = item.quantity;
    });

    container.innerHTML = projects.map(proj => {
      let bom = [];
      try {
        bom = JSON.parse(proj.bom_json || '[]');
      } catch (e) {
        bom = [];
      }

      const bomHtml = bom.length ? bom.map(b => {
        const inStockQty = invMap[b.component_name.toLowerCase()] || 0;
        const isCovered = inStockQty >= b.quantity_needed;
        return `
          <div class="project-bom-item">
            <span><strong>${escapeHtml(b.component_name)}</strong> (Need: ${b.quantity_needed})</span>
            <span class="stock-badge ${isCovered ? 'abundant' : 'low'}">
              ${isCovered ? `✓ Stock: ${inStockQty}` : `⚠️ Stock: ${inStockQty}`}
            </span>
          </div>
        `;
      }).join('') : '<span style="color: var(--text-muted); font-size: 11.5px;">No BOM parts added yet.</span>';

      const statusLabels = {
        'in_progress': '⚡ In Progress',
        'planning': '📋 Planning',
        'completed': '✓ Completed'
      };

      return `
        <div class="project-card" data-id="${proj.id}">
          <div class="project-card-header">
            <div>
              <div class="project-card-title">${escapeHtml(proj.name)}</div>
              <span class="project-hw-pill">📟 ${escapeHtml(proj.target_hardware || 'ESP32')}</span>
            </div>
            <span class="project-status-badge ${escapeHtml(proj.status || 'in_progress')}">
              ${statusLabels[proj.status] || escapeHtml(proj.status)}
            </span>
          </div>

          <div style="font-size: 13px; color: var(--text-main); line-height: 1.4;">
            ${escapeHtml(proj.description || 'No description provided.')}
          </div>

          <!-- Bill of Materials (BOM) -->
          <div class="project-bom-box">
            <div class="project-bom-title">
              <span>Bill of Materials (BOM)</span>
              <button class="btn-icon-link" onclick="promptAddBOM(${proj.id})">+ Add Part</button>
            </div>
            <div class="project-bom-list">
              ${bomHtml}
            </div>
          </div>

          ${proj.notes ? `
            <div style="font-size: 12px; color: var(--text-muted); background: var(--bg-surface); padding: 8px 12px; border-radius: var(--radius-sm);">
              <strong>Technical Specs:</strong> ${escapeHtml(proj.notes)}
            </div>
          ` : ''}

          <div class="project-card-actions">
            <button class="btn btn-secondary btn-sm" onclick="askCopilotAboutProject('${escapeHtml(proj.name)}', '${escapeHtml(proj.target_hardware)}')">
              Ask Copilot
            </button>
            <button class="btn btn-secondary btn-sm" onclick="showProjectOnDesk(${proj.id}, '${escapeHtml(proj.name)}')">
              Push to Desk
            </button>
            <button class="btn btn-danger btn-sm" style="margin-left: auto;" onclick="deleteProject(${proj.id})">
              Delete
            </button>
          </div>
        </div>
      `;
    }).join('');
  } catch (err) {
    container.innerHTML = `<div style="color: var(--danger); padding: 24px;">Failed to load projects: ${err}</div>`;
  }
}

window.promptAddBOM = async function(projectId) {
  const partName = prompt('Enter component name to add to BOM (e.g., INMP441 I2S Microphone, 10k Resistor):');
  if (!partName || !partName.trim()) return;
  const qtyStr = prompt('Quantity needed:', '1');
  const qty = parseInt(qtyStr) || 1;

  try {
    await fetch(`/api/projects/${projectId}/bom`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ component_name: partName.trim(), quantity_needed: qty })
    });
    showToast(`Added ${partName} to BOM!`, 'success');
    loadProjects();
  } catch (err) {
    showToast('Failed to add BOM item: ' + err, 'error');
  }
};

window.askCopilotAboutProject = function(projectName, hardware) {
  const promptInput = document.getElementById('prompt-input');
  const workbenchTabBtn = document.querySelector('[data-tab="tab-workbench"]');
  if (workbenchTabBtn) workbenchTabBtn.click();
  if (promptInput) {
    promptInput.value = `Provide detailed circuit design guidelines, pinouts, and test procedures for project '${projectName}' using ${hardware}`;
    sendPrompt(promptInput.value);
  }
};

window.showProjectOnDesk = async function(projectId, projectName) {
  try {
    const res = await fetch(`/api/projects/${projectId}`);
    const proj = await res.json();
    const bom = JSON.parse(proj.bom_json || '[]');
    const bomSummary = bom.map(b => `- **${b.component_name}**: ${b.quantity_needed} pcs`).join('\n') || '*No parts assigned*';

    const content = (
      `# Project: ${proj.name}\n\n` +
      `**Target Hardware:** ${proj.target_hardware} | **Status:** ${proj.status.toUpperCase()}\n\n` +
      `### Overview\n${proj.description || '-'}\n\n` +
      `### Bill of Materials\n${bomSummary}\n\n` +
      `### Technical Notes\n${proj.notes || 'No notes specified.'}`
    );

    await fetch('/api/kiosk/show', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: `Project: ${projectName}`, type: 'markdown', content })
    });
    showToast(`Project '${projectName}' broadcast to desk screen!`, 'success');
  } catch (e) {
    showToast('Failed to push project to desk: ' + e, 'error');
  }
};

window.deleteProject = async function(projectId) {
  if (!confirm('Are you sure you want to delete this project?')) return;
  try {
    await fetch(`/api/projects/${projectId}`, { method: 'DELETE' });
    showToast('Project removed', 'info');
    loadProjects();
  } catch (err) {
    showToast('Failed to delete project: ' + err, 'error');
  }
};

// ============================================================================
// 11. INVENTORY CATALOG OVERHAUL (Objective 2: Badges, Indicators, Steppers)
// ============================================================================
let currentInvCategory = 'All';

async function loadInventory() {
  const invTbody = document.getElementById('inventory-tbody');
  const invSearch = document.getElementById('inv-search');
  if (!invTbody) return;

  invTbody.innerHTML = '<tr><td colspan="7" style="text-align: center; color: var(--text-muted); padding: 24px;">Loading components...</td></tr>';
  const q = invSearch ? invSearch.value.trim() : '';
  const params = new URLSearchParams();
  if (q) params.append('q', q);
  if (currentInvCategory && currentInvCategory !== 'All') params.append('category', currentInvCategory);

  try {
    const res = await fetch('/api/inventory?' + params.toString());
    const items = await res.json();

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
      invTbody.innerHTML = '<tr><td colspan="7" style="text-align: center; color: var(--text-muted); padding: 24px;">No components match the selected filter. Click "+ Add New Component" above.</td></tr>';
      return;
    }

    // Category badge color classes
    const catClassMap = {
      'microcontrollers': 'cat-microcontrollers',
      'sensors': 'cat-sensors',
      'power': 'cat-power',
      'audio': 'cat-audio',
      'displays': 'cat-displays',
      'passive': 'cat-passive',
      'semiconductors': 'cat-semiconductors',
      'connectors': 'cat-connectors'
    };

    invTbody.innerHTML = items.map(item => {
      const catKey = (item.category || 'general').toLowerCase();
      const catClass = catClassMap[catKey] || 'cat-general';

      // Stock Level Badge (Objective 2)
      let stockBadgeHtml = '';
      if (item.quantity === 0) {
        stockBadgeHtml = '<span class="stock-badge out">OUT OF STOCK</span>';
      } else if (item.quantity <= 2) {
        stockBadgeHtml = `<span class="stock-badge low">LOW STOCK (${item.quantity})</span>`;
      } else if (item.quantity >= 10) {
        stockBadgeHtml = `<span class="stock-badge abundant">ABUNDANT (${item.quantity})</span>`;
      } else {
        stockBadgeHtml = `<span class="stock-badge in_stock">IN STOCK (${item.quantity})</span>`;
      }

      return `
        <tr data-id="${item.id}">
          <td style="font-weight: 700; color: var(--text-bright); font-size: 13.5px;">
            ${escapeHtml(item.component_name)}
          </td>
          <td>
            <!-- Interactive Stepper (Objective 2) -->
            <div class="qty-stepper">
              <button class="qty-stepper-btn" onclick="adjustQty(${item.id}, -1)">-</button>
              <span class="qty-stepper-val">${item.quantity}</span>
              <button class="qty-stepper-btn" onclick="adjustQty(${item.id}, 1)">+</button>
            </div>
          </td>
          <td>${stockBadgeHtml}</td>
          <td>
            <span class="category-badge-pill ${catClass}">${escapeHtml(item.category || 'General')}</span>
          </td>
          <td style="color: var(--text-muted); font-size: 12.5px;">
            ${item.storage_location ? `📍 ${escapeHtml(item.storage_location)}` : 'Unassigned'}
          </td>
          <td style="font-size: 12.5px; color: var(--text-main);">
            ${highlightMeasurementChips(escapeHtml(item.notes || '-'))}
          </td>
          <td>
            <button class="btn btn-danger btn-sm" onclick="deleteItem(${item.id})">Delete</button>
          </td>
        </tr>
      `;
    }).join('');
  } catch (e) {
    invTbody.innerHTML = `<tr><td colspan="7" style="color: var(--danger); padding: 24px;">Failed to load inventory: ${e}</td></tr>`;
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

// ============================================================================
// 12. LAB NOTEBOOK & LOGS (Objective 2: Measurement Chips & Filters)
// ============================================================================
let currentLogTypeFilter = 'All';

async function loadLogs() {
  const logList = document.getElementById('log-list');
  const logSearch = document.getElementById('log-search');
  if (!logList) return;

  logList.innerHTML = '<div style="color: var(--text-muted); text-align: center; padding: 24px;">Loading lab notes...</div>';
  const q = logSearch ? logSearch.value.trim() : '';
  const params = new URLSearchParams();
  if (q) params.append('q', q);
  if (currentLogTypeFilter && currentLogTypeFilter !== 'All') params.append('entry_type', currentLogTypeFilter);

  try {
    const res = await fetch('/api/logs?' + params.toString());
    const logs = await res.json();

    const logsBadge = document.getElementById('tab-logs-badge');
    if (logsBadge) logsBadge.textContent = logs.length;

    if (!logs.length) {
      logList.innerHTML = '<div style="color: var(--text-muted); text-align: center; padding: 24px;">No lab notes match the current filter.</div>';
      return;
    }

    const typeIcons = {
      'reading': '⚡ READING',
      'oscilloscope': '📈 OSCILLOSCOPE',
      'schematic': '🔬 SCHEMATIC',
      'issue': '⚠️ BUG / FAILURE',
      'text': '📝 NOTE'
    };

    logList.innerHTML = logs.map(l => `
      <div class="log-item ${l.entry_type || 'text'}">
        <div class="log-meta">
          <span class="log-type-tag">${typeIcons[l.entry_type] || escapeHtml(l.entry_type || 'NOTE')}</span>
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

// ============================================================================
// 13. DASHBOARD INTERACTIONS & EVENT LISTENERS
// ============================================================================
if (!isKioskMode) {
  // A. Segmented Tab Navigation
  const tabBtns = document.querySelectorAll('.tab-nav .tab-btn');
  const tabContents = document.querySelectorAll('.tab-content');

  tabBtns.forEach(btn => {
    btn.addEventListener('click', () => {
      const target = btn.getAttribute('data-tab');
      tabBtns.forEach(b => b.classList.remove('active'));
      tabContents.forEach(c => c.classList.remove('active'));
      btn.classList.add('active');
      const activeContent = document.getElementById(target);
      if (activeContent) activeContent.classList.add('active');

      if (target === 'tab-workbench') loadContextualSuggestions();
      if (target === 'tab-projects') loadProjects();
      if (target === 'tab-inventory') loadInventory();
      if (target === 'tab-logs') loadLogs();
    });
  });

  // B. AI Prompt Dispatching with Context Continuity (Fixes Raspberry Pi / Ground Pins Bug)
  const btnSendPrompt = document.getElementById('btn-send-prompt');
  const promptInput = document.getElementById('prompt-input');

  async function sendPrompt(text) {
    if (!text || !text.trim()) return;
    if (btnSendPrompt) btnSendPrompt.disabled = true;

    showToast('Copilot reasoning with bench telemetry...', 'info', 1800);

    try {
      const res = await fetch('/api/llm/prompt', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prompt: text.trim(), session_id: currentSessionId })
      });
      const data = await res.json();
      if (promptInput) promptInput.value = '';
      showToast(`Processed: ${data.title || 'Command executed'}`, 'success');
      loadContextualSuggestions();
    } catch (e) {
      showToast(`Error: ${e}`, 'error');
    } finally {
      if (btnSendPrompt) btnSendPrompt.disabled = false;
    }
  }

  if (btnSendPrompt) {
    btnSendPrompt.addEventListener('click', () => sendPrompt(promptInput.value));
  }
  if (promptInput) {
    promptInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
        sendPrompt(promptInput.value);
      }
    });
  }

  // Refresh Suggestions Button
  const btnRefreshSug = document.getElementById('btn-refresh-suggestions');
  if (btnRefreshSug) {
    btnRefreshSug.addEventListener('click', () => {
      loadContextualSuggestions();
      showToast('Refreshed contextual suggestions', 'info');
    });
  }

  // Direct Kiosk Push
  const btnDirectPush = document.getElementById('btn-direct-push');
  if (btnDirectPush) {
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
  }

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

  // C. Projects Form & Filters
  const formAddProject = document.getElementById('form-add-project');
  if (formAddProject) {
    formAddProject.addEventListener('submit', async (e) => {
      e.preventDefault();
      const name = document.getElementById('proj-name').value.trim();
      const target_hardware = document.getElementById('proj-hw').value;
      const status = document.getElementById('proj-status').value;
      const description = document.getElementById('proj-desc').value.trim();
      const notes = document.getElementById('proj-notes').value.trim();

      try {
        await fetch('/api/projects', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name, target_hardware, status, description, notes })
        });
        formAddProject.reset();
        const details = document.getElementById('details-new-project');
        if (details) details.removeAttribute('open');
        showToast(`Created project '${name}'!`, 'success');
        loadProjects();
        loadContextualSuggestions();
      } catch (err) {
        showToast('Failed to create project: ' + err, 'error');
      }
    });
  }

  const projFilterBar = document.getElementById('proj-filter-bar');
  if (projFilterBar) {
    projFilterBar.querySelectorAll('.filter-pill').forEach(btn => {
      btn.addEventListener('click', () => {
        projFilterBar.querySelectorAll('.filter-pill').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        const status = btn.getAttribute('data-status');
        loadProjects(status);
      });
    });
  }

  const btnRefreshProjects = document.getElementById('btn-refresh-projects');
  if (btnRefreshProjects) {
    btnRefreshProjects.addEventListener('click', () => {
      loadProjects();
      showToast('Projects refreshed', 'info');
    });
  }

  // D. Inventory Filters & Form
  const invQuickFilters = document.getElementById('inv-quick-filters');
  if (invQuickFilters) {
    invQuickFilters.querySelectorAll('.inv-tab-pill').forEach(pill => {
      pill.addEventListener('click', () => {
        invQuickFilters.querySelectorAll('.inv-tab-pill').forEach(p => p.classList.remove('active'));
        pill.classList.add('active');
        currentInvCategory = pill.getAttribute('data-cat');
        loadInventory();
      });
    });
  }

  const invSearch = document.getElementById('inv-search');
  if (invSearch) {
    invSearch.addEventListener('input', debounce(loadInventory, 300));
  }

  const btnRefreshInv = document.getElementById('btn-refresh-inv');
  if (btnRefreshInv) {
    btnRefreshInv.addEventListener('click', () => {
      loadInventory();
      showToast('Inventory catalog refreshed', 'info');
    });
  }

  const formAddInv = document.getElementById('form-add-inventory');
  if (formAddInv) {
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
        showToast(`Saved component '${component_name}'!`, 'success');
        loadInventory();
        loadContextualSuggestions();
      } catch (err) {
        showToast('Failed to save component: ' + err, 'error');
      }
    });
  }

  // E. Lab Logs Filters & Form
  const logFilterTabs = document.getElementById('log-filter-tabs');
  if (logFilterTabs) {
    logFilterTabs.querySelectorAll('.inv-tab-pill').forEach(pill => {
      pill.addEventListener('click', () => {
        logFilterTabs.querySelectorAll('.inv-tab-pill').forEach(p => p.classList.remove('active'));
        pill.classList.add('active');
        currentLogTypeFilter = pill.getAttribute('data-type');
        loadLogs();
      });
    });
  }

  const logSearch = document.getElementById('log-search');
  if (logSearch) {
    logSearch.addEventListener('input', debounce(loadLogs, 300));
  }

  const formAddLog = document.getElementById('form-add-log');
  if (formAddLog) {
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
        loadContextualSuggestions();
      } catch (err) {
        showToast('Error recording log: ' + err, 'error');
      }
    });
  }

  const btnExportLogs = document.getElementById('btn-export-logs');
  if (btnExportLogs) {
    btnExportLogs.addEventListener('click', () => {
      window.open('/api/logs/export', '_blank');
    });
  }

  // Initialize PTT, Soldering Station Controls and Preload Initial Data
  initPushToTalk();
  initSolderingStationControls();
  loadContextualSuggestions();
  loadProjects();
  loadInventory();
  loadLogs();
  fetchSystemStatus();
  fetchSolderingStatus();
  setInterval(fetchSystemStatus, 10000);
}

// ----------------------------------------------------------------------------
// 2.8" SPI TFT Soldering Station Controls & Live Sync
// ----------------------------------------------------------------------------
async function fetchSolderingStatus() {
  try {
    const res = await fetch('/api/soldering/current');
    if (!res.ok) return;
    const data = await res.json();
    const solderingBody = document.getElementById('soldering-mirror-body');
    const solderingTitle = document.getElementById('soldering-mirror-title');
    const solderingTs = document.getElementById('soldering-mirror-timestamp');
    if (solderingBody && data.content) {
      solderingBody.innerHTML = renderContent('markdown', data.content);
    }
    if (solderingTitle && data.title) {
      solderingTitle.textContent = data.title.toUpperCase();
    }
    if (solderingTs && data.timestamp) {
      solderingTs.textContent = 'SPI0 Synced ' + data.timestamp.substring(11, 19);
    }
  } catch (e) {
    console.warn('[Soldering Status Fetch Error]:', e);
  }
}

function initSolderingStationControls() {
  const btnShowWiring = document.getElementById('btn-show-wiring-guide');
  const modalWiring = document.getElementById('modal-wiring-guide');
  const btnCloseWiring = document.getElementById('btn-close-wiring-guide');
  const btnDoneWiring = document.getElementById('btn-done-wiring-guide');
  const btnCopySoldering = document.getElementById('btn-copy-soldering');
  const btnResetSoldering = document.getElementById('btn-reset-soldering');

  if (btnShowWiring && modalWiring) {
    btnShowWiring.addEventListener('click', () => {
      modalWiring.style.display = 'flex';
    });
  }

  const hideModal = () => {
    if (modalWiring) modalWiring.style.display = 'none';
  };

  if (btnCloseWiring) btnCloseWiring.addEventListener('click', hideModal);
  if (btnDoneWiring) btnDoneWiring.addEventListener('click', hideModal);
  if (modalWiring) {
    modalWiring.addEventListener('click', (e) => {
      if (e.target === modalWiring) hideModal();
    });
  }

  if (btnCopySoldering) {
    btnCopySoldering.addEventListener('click', () => {
      const solderingBody = document.getElementById('soldering-mirror-body');
      if (solderingBody && solderingBody.innerText) {
        navigator.clipboard.writeText(solderingBody.innerText).then(() => {
          showToast('Soldering station notes copied to clipboard!', 'success');
        });
      } else {
        showToast('No soldering notes to copy', 'info');
      }
    });
  }

  if (btnResetSoldering) {
    btnResetSoldering.addEventListener('click', () => {
      const solderingBody = document.getElementById('soldering-mirror-body');
      const solderingTitle = document.getElementById('soldering-mirror-title');
      if (solderingBody) {
        solderingBody.innerHTML = '<div class="tft-bullet-line">• <strong>STATION STANDBY</strong>: Waiting for technical prompt.</div><div class="tft-bullet-line">• <strong>SOLDER TEMP</strong>: 320°C (60/40) | 350°C (SAC305)</div>';
      }
      if (solderingTitle) {
        solderingTitle.textContent = 'SOLDERING STATION STANDBY';
      }
      showToast('Soldering screen reset to standby', 'info');
    });
  }
}

// Debounce helper
function debounce(fn, delay) {
  let timer = null;
  return function(...args) {
    clearTimeout(timer);
    timer = setTimeout(() => fn.apply(this, args), delay);
  };
}

// ============================================================================
// MOBILE RESPONSIVE MENU
// ============================================================================
function initMobileMenu() {
  const toggle = document.getElementById('mobile-menu-toggle');
  const navControls = document.getElementById('nav-controls');
  if (!toggle || !navControls) return;

  toggle.addEventListener('click', () => {
    toggle.classList.toggle('active');
    navControls.classList.toggle('mobile-open');
  });

  // Close mobile menu when clicking a link inside it
  navControls.querySelectorAll('a, button').forEach(el => {
    el.addEventListener('click', () => {
      if (window.innerWidth <= 768) {
        toggle.classList.remove('active');
        navControls.classList.remove('mobile-open');
      }
    });
  });

  // Close on outside click
  document.addEventListener('click', (e) => {
    if (window.innerWidth <= 768 && !toggle.contains(e.target) && !navControls.contains(e.target)) {
      toggle.classList.remove('active');
      navControls.classList.remove('mobile-open');
    }
  });
}

// Initialize Theme, WebSocket & Mobile Menu
initTheme();
initKioskWebSocket();
initMobileMenu();

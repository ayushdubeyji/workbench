// ============================================================================
// WORKSTATION LIVE ADAFRUIT TELEMETRY WIDGET BAR CONTROLLER
// Graceful offline standby & origin-aware remote endpoint resolution
// ============================================================================

(function () {
  const POLLING_INTERVAL_MS = 5000;
  let isUpdating = false;

  const isLocalOrigin = window.location.hostname === '127.0.0.1' || 
                        window.location.hostname === 'localhost' || 
                        window.location.hostname === '192.168.0.111';
  const WORKBENCH_BASE = isLocalOrigin ? '' : 'https://workbench.ayushdubey.tech';

  async function fetchTelemetry() {
    if (isUpdating) return;
    isUpdating = true;
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 4000);
      const res = await fetch(`${WORKBENCH_BASE}/api/workstation/telemetry`, {
        signal: controller.signal
      });
      clearTimeout(timeoutId);
      if (!res.ok) {
        showStandbyUI();
        return;
      }
      const data = await res.json();
      updateWorkstationUI(data);
    } catch (e) {
      showStandbyUI();
    } finally {
      isUpdating = false;
    }
  }

  function showStandbyUI() {
    const radarEl = document.getElementById('ws-radar-status');
    const radarText = document.getElementById('ws-radar-text');
    if (radarEl && radarText) {
      radarEl.className = 'ws-radar-badge idle';
      radarText.textContent = 'HARDWARE STANDBY (PC SLEEPING 🔌)';
    }
    const ironEl = document.getElementById('ws-iron-chip');
    const ironState = document.getElementById('ws-iron-state');
    if (ironEl && ironState) {
      ironEl.className = 'ws-tool-chip soldering cold';
      ironState.textContent = 'OFF';
    }
    const glueEl = document.getElementById('ws-glue-chip');
    const glueState = document.getElementById('ws-glue-state');
    if (glueEl && glueState) {
      glueEl.className = 'ws-tool-chip gluegun cold';
      glueState.textContent = 'OFF';
    }
    const tempEl = document.getElementById('ws-val-temp');
    if (tempEl) tempEl.textContent = '--°C';
    const humEl = document.getElementById('ws-val-hum');
    if (humEl) humEl.textContent = '--%';
    const gasEl = document.getElementById('ws-val-gas');
    if (gasEl) gasEl.textContent = 'STANDBY';
  }

  function updateWorkstationUI(data) {
    // 1. Radar Presence
    const radarEl = document.getElementById('ws-radar-status');
    const radarText = document.getElementById('ws-radar-text');
    if (radarEl && radarText) {
      const isMobile = window.innerWidth <= 700;
      if (data.radar_presence === 1) {
        radarEl.className = 'ws-radar-badge active';
        radarText.textContent = isMobile ? 'BENCH ACTIVE ⚡' : 'AYUSH AT BENCH ⚡';
      } else {
        radarEl.className = 'ws-radar-badge idle';
        radarText.textContent = isMobile ? 'BENCH IDLE 💭' : 'BENCH IDLE (STANDBY 💭)';
      }
    }

    // 2. Relay 1: Soldering Iron
    const ironEl = document.getElementById('ws-iron-chip');
    const ironState = document.getElementById('ws-iron-state');
    if (ironEl && ironState) {
      if (data.relay_1_soldering === 1) {
        ironEl.className = 'ws-tool-chip soldering hot';
        ironState.textContent = 'ON 🔥';
      } else {
        ironEl.className = 'ws-tool-chip soldering cold';
        ironState.textContent = 'OFF';
      }
    }

    // 3. Relay 2: Glue Gun
    const glueEl = document.getElementById('ws-glue-chip');
    const glueState = document.getElementById('ws-glue-state');
    if (glueEl && glueState) {
      if (data.relay_2_gluegun === 1) {
        glueEl.className = 'ws-tool-chip gluegun hot';
        glueState.textContent = 'ON 🌡️';
      } else {
        glueEl.className = 'ws-tool-chip gluegun cold';
        glueState.textContent = 'OFF';
      }
    }

    // 4. Sensors
    const tempEl = document.getElementById('ws-val-temp');
    if (tempEl && data.temperature !== undefined) {
      tempEl.textContent = data.temperature.toFixed(1) + '°C';
    }
    const humEl = document.getElementById('ws-val-hum');
    if (humEl && data.humidity !== undefined) {
      humEl.textContent = data.humidity.toFixed(0) + '%';
    }
    const gasEl = document.getElementById('ws-val-gas');
    if (gasEl && data.gas_level !== undefined) {
      gasEl.textContent = data.gas_level === 0 ? 'CLEAN' : 'NORMAL';
    }

    // Pulse sync dot
    
    const tempGlass = document.getElementById('ws-val-temp-glass');
    if (tempGlass && data.temperature !== undefined) tempGlass.textContent = data.temperature.toFixed(1) + '°C';
    const humGlass = document.getElementById('ws-val-hum-glass');
    if (humGlass && data.humidity !== undefined) humGlass.textContent = data.humidity.toFixed(0) + '%';
    const gasGlass = document.getElementById('ws-val-gas-glass');
    if (gasGlass && data.gas_level !== undefined) gasGlass.textContent = data.gas_level === 0 ? 'CLEAN' : 'NORMAL';

    
    // Secondary HUD Deck Sync
    if (data.temperature !== undefined) {
      const cmdBench = document.getElementById('cmd-bench-env');
      if (cmdBench) cmdBench.textContent = data.temperature.toFixed(1) + '°C • NOMINAL';
      const deckTemp = document.getElementById('deck-val-temp');
      if (deckTemp) deckTemp.textContent = data.temperature.toFixed(1) + '°C';
    }
    if (data.humidity !== undefined) {
      const deckHum = document.getElementById('deck-val-hum');
      if (deckHum) deckHum.textContent = data.humidity.toFixed(0) + '%';
    }
    if (data.radar_presence !== undefined) {
      const deckRadar = document.getElementById('hud-radar-status-text');
      if (deckRadar) deckRadar.textContent = data.radar_presence === 1 ? 'AYUSH AT BENCH ⚡' : 'STANDBY 💭';
    }
    
    const syncDot = document.getElementById('ws-sync-dot');
    if (syncDot) {
      syncDot.classList.add('pulsing');
      setTimeout(() => syncDot.classList.remove('pulsing'), 600);
    }
  }

  // Relay toggle handler
  window.toggleWorkstationRelay = async function (relayId, event) {
    if (event) event.stopPropagation();
    const chip = relayId === 1 ? document.getElementById('ws-iron-chip') : document.getElementById('ws-glue-chip');
    if (chip) chip.style.opacity = '0.6';

    try {
      const res = await fetch(`${WORKBENCH_BASE}/api/workstation/relay/${relayId}/toggle`, { method: 'POST' });
      const data = await res.json();
      if (data && data.success) {
        setTimeout(fetchTelemetry, 300);
      }
    } catch (e) {
      console.warn('Workbench hardware unreachable (offline):', e);
    } finally {
      if (chip) chip.style.opacity = '1';
    }
  };

  // Initial fetch and start polling
  document.addEventListener('DOMContentLoaded', () => {
    fetchTelemetry();
    setInterval(fetchTelemetry, POLLING_INTERVAL_MS);
  });
})();

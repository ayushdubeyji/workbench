# Comprehensive Xiaozhi (ESP32-S3 & ESP32-P4) MCP & Smart Workbench Integration Guide

> **Target Audience:** Autonomous Coding Agents, Claude Desktop / OpenClaw Operators, and Hardware Engineers configuring Xiaozhi AI on ESP32-S3 and ESP32-P4 edge devices with the Smart Workbench Hub and Cloudflare Tunnel infrastructure.

---

## 1. System Architecture Overview

```
   +-----------------------------------------------------------------------+
   |                        Hardware Edge Devices                          |
   |                                                                       |
   |   [ESP32-S3 / Waveshare Zero]             [ESP32-P4 / EV-Board]       |
   |   - INMP441 Microphone (I2S)              - High-Res MIPI-CSI / Audio |
   |   - MAX98357A / DAC (I2S)                 - Brookesia OS / ESP-IDF    |
   |   - GC9A01 LCD / ST7789 Display           - Fast Vector DSP           |
   |   - Rotary Encoder (GPIO Dial)            - MIPI-DSI LCD Display      |
   +-----------------------+-------------------------------+---------------+
                           |                               |
                   WebSocket (Opus/JSON)           WebSocket (Opus/JSON)
                           |                               |
                           v                               v
   +-----------------------------------------------------------------------+
   |                     Network Ingress Layer                             |
   |                                                                       |
   |   LAN Direct:  ws://192.168.0.110:8000/ws/xiaozhi                     |
   |   Public WAN:  wss://ayushdubey.tech/ws/xiaozhi                       |
   |   Cloudflare Tunnel: [ID: f521d45d-0510-40c3-b59b-a9a6526ec5f8]      |
   +-----------------------------------+-----------------------------------+
                                       |
                                       v
   +-----------------------------------------------------------------------+
   |              Target Host: Smart Workbench Hub Daemon                  |
   |              (ayush@192.168.0.110 | /home/ayush/workbench_hub)       |
   |                                                                       |
   |   * FastAPI Application (Port 8000) & Nginx Reverse Proxy (Port 80)   |
   |   * Native MCP JSON-RPC 2.0 Server: /mcp and /api/mcp                 |
   |   * /ws/xiaozhi: Voice transcription ingress & device telemetry       |
   |   * /ws/kiosk: Real-time broadcast to benchtop display                |
   |   * AI Intent Router:                                                 |
   |       - Fast Intent Classification: Groq (openai/gpt-oss-120b)        |
   |       - Deep Technical Synthesis: Gemini (gemini-3.6-flash)           |
   |   * Local SQLite DB: workbench.db (WAL mode, concurrent safe)         |
   |   * Local Logs & Markdown: notes/workbench_log.md                     |
   |   * OpenClaw Gateway Bridge (Port 18789): WhatsApp / Multi-Agent      |
   +-----------------------------------------------------------------------+
                                       ^
                                       | Stdio / JSON-RPC
   +-----------------------------------+-----------------------------------+
   |             AI Agent MCP Interface (Desktop / Host)                   |
   |                                                                       |
   |   * C:\Users\dell\Desktop\workbench_mcp_server.py                     |
   |   * C:\Users\dell\Desktop\claude_desktop_config.json                 |
   |   * C:\Users\dell\Desktop\workbench_agent_manifest.json               |
   |   * C:\Users\dell\Desktop\test_mcp_endpoints.py                      |
   +-----------------------------------------------------------------------+
```

---

## 2. Hardware Pinout & Wiring Specifications

### 2.1 ESP32-S3 (Waveshare ESP32-S3-Zero / DevKit)

#### A. INMP441 Digital Microphone (I2S Input)
| INMP441 Pin | ESP32-S3 GPIO | Function / Notes |
|:------------|:--------------|:-----------------|
| **VDD**     | **3.3V**      | ⚠️ DO NOT CONNECT TO 5V (3.3V rail only) |
| **GND**     | **GND**       | Common system ground |
| **SD**      | **GPIO 10**   | Serial Data Out (I2S Data In) |
| **SCK**     | **GPIO 4**    | Serial Clock (BCLK) |
| **WS**      | **GPIO 5**    | Word Select (LRCK / Left-Right Clock) |
| **L/R**     | **GND**       | Selects Left channel (required by firmware) |

*Decoupling Note: Place a 0.1µF (104) ceramic capacitor between VDD and GND near the mic module to prevent high-frequency RF ripple.*

#### B. Audio DAC & Amplifier (MAX98357A / PCM5102A)
| DAC Pin | ESP32-S3 GPIO | Function / Notes |
|:--------|:--------------|:-----------------|
| **VCC** | **5V or 3.3V**| Connect to 5V for maximum speaker output |
| **GND** | **GND**       | Common ground |
| **DIN** | **GPIO 7**    | Digital Audio Data In |
| **BCK** | **GPIO 1**    | Bit Clock |
| **WS**  | **GPIO 2**    | Word Select (LRCK) |
| **SD**  | **VCC**       | Shutdown / Mode (pull high to enable amplifier) |
| **MC**  | **GND**       | Master Clock (tie to GND for auto-PLL) |

#### C. GC9A01 Round LCD Display (SPI)
| Display Pin | ESP32-S3 GPIO | Function / Notes |
|:------------|:--------------|:-----------------|
| **VCC**     | **3.3V**      | Logic and LED supply |
| **GND**     | **GND**       | Common ground |
| **SCL/CLK** | **GPIO 11**   | SPI Clock |
| **SDA/MOSI**| **GPIO 12**   | SPI Data |
| **DC**      | **GPIO 43**   | Data / Command control line |
| **RES/RST** | **3.3V**      | Reset (tied to 3.3V to save GPIO) |
| **CS**      | **GND**       | Chip Select (tied to GND for single device) |
| **BLK**     | **3.3V**      | Backlight power (or PWM GPIO for dimming) |

#### D. Rotary Encoder (UI Navigation Dial)
| Encoder Pin | ESP32-S3 GPIO | Function / Notes |
|:------------|:--------------|:-----------------|
| **+ (VCC)** | **3.3V**      | Logic supply |
| **GND**     | **GND**       | Common ground |
| **CLK (A)** | **GPIO 8**    | Quadrature Phase A |
| **DT (B)**  | **GPIO 9**    | Quadrature Phase B |
| **SW**      | **GPIO 3**    | Pushbutton Switch (active LOW, internal pullup) |

---

### 2.2 ESP32-P4 (High Performance / Brookesia & EV-Board)

The ESP32-P4 features dual RISC-V cores at 400MHz, hardware H.264/JPEG acceleration, MIPI-CSI/DSI, and dedicated audio codecs.

#### A. Audio Configuration (ES8311 / ES7210 Codec via I2C/I2S)
| Codec Pin | ESP32-P4 Function | ESP-IDF Driver Name |
|:----------|:------------------|:-------------------|
| **I2C SDA**| GPIO 7            | Control Bus Data    |
| **I2C SCL**| GPIO 8            | Control Bus Clock   |
| **I2S MCLK**| GPIO 13          | Master Audio Clock  |
| **I2S BCLK**| GPIO 12          | Audio Bit Clock     |
| **I2S WS**  | GPIO 10          | Word Select (LRCK)  |
| **I2S DOUT**| GPIO 9           | Audio to Speaker    |
| **I2S DIN** | GPIO 11          | Audio from Mic      |

#### B. Display Configuration (MIPI-DSI / ST7701S High-Res Screen)
- Standard `esp_lcd_mipi_dsi` driver under ESP-IDF v5.3+ / v6.0+.
- Supports 480x480 or 800x480 IPS display with capacitive touch panel (GT911 on I2C GPIO 7/8).

---

## 3. Xiaozhi Firmware WebSocket & Audio Protocol

Xiaozhi communicates via a bidirectional WebSocket protocol with Opus compressed audio or JSON text commands.

### 3.1 Connection Endpoints
- **Local Network (Zero Latency):**
  `ws://192.168.0.110:8000/ws/xiaozhi`
- **Cloudflare Tunnel (Remote Secure):**
  `wss://ayushdubey.tech/ws/xiaozhi`

### 3.2 Handshake Protocol (Client Connect)
Upon WebSocket connection, the hub automatically transmits the capability greeting:
```json
{
  "type": "hello",
  "version": 1,
  "transport": "websocket",
  "audio_params": {
    "format": "opus",
    "sample_rate": 16000,
    "channels": 1,
    "frame_duration_ms": 60
  }
}
```

Client responds with:
```json
{"type": "hello"}
```
Hub acknowledges with:
```json
{"type": "hello_ack", "status": "ready"}
```

### 3.3 ESP32 Voice Transcript & Command Ingress
When the on-board wake-word triggers and transcribes speech:
```json
{
  "type": "listen",
  "state": "detect",
  "text": "Show pinout for ESP32 and check stock of 10k resistors"
}
```

### 3.4 Hub TTS & Action Response
The hub runs the intent through Groq / Gemini and responds back to Xiaozhi for speaker playback:
```json
{
  "type": "tts",
  "state": "start",
  "text": "Workbench processed: Circuit & Pinout Guide"
}
```

### 3.5 Heartbeat Keep-Alive
- Client or Server sends: `{"type": "ping"}`
- Peer responds: `{"type": "pong"}`
- Recommended ping interval: 20 seconds.

---

## 4. Model Context Protocol (MCP) Server & AI Agent Tools

The Smart Workbench Hub natively implements the official **Model Context Protocol (MCP)** JSON-RPC 2.0 specification on `/mcp` and `/api/mcp`.

### 4.1 Native MCP Endpoint
- **URL:** `http://192.168.0.110/mcp` (or `http://localhost:8000/mcp` or `https://ayushdubey.tech/mcp`)
- **Protocol:** JSON-RPC 2.0 over HTTP POST
- **Supported RPC Methods:**
  * `initialize`: Handshake returning protocol version `2024-11-05` and server metadata.
  * `tools/list`: Returns all 8 registered tools and their complete JSON Schema definitions.
  * `tools/call`: Executes a tool with provided arguments and returns formatted content blocks.
  * `ping`: Heartbeat keepalive.

### 4.2 Available MCP Tools Reference

| Tool Name | Purpose | Key Arguments |
|:----------|:--------|:--------------|
| **`display_on_desk`** | Push rich technical content to bench display mirror | `content` (str), `title` (str), `type` (`markdown` \| `pinout` \| `schematic` \| `code` \| `image`) |
| **`get_kiosk_state`** | Read current content active on bench display | *(none)* |
| **`log_note`** | Record measurement, oscilloscope trace, or note | `content` (str), `entry_type` (`text` \| `reading` \| `oscilloscope` \| `schematic` \| `issue`), `tags` (str) |
| **`get_logs`** | Query recent lab notebook entries with filters | `q` (str), `entry_type` (str), `limit` (int) |
| **`manage_inventory`** | Full inventory management (list, add, adjust, delete) | `action` (`list` \| `add` \| `adjust` \| `delete`), `component_name`, `quantity`, `delta`, `item_id` |
| **`route_llm_prompt`** | Query Groq/Gemini electronics intelligence engine | `prompt` (str) |
| **`get_system_status`** | Real-time system telemetry and tunnel status | *(none)* |
| **`xiaozhi_send_command`**| Broadcast TTS audio prompt to connected ESP32 devices | `text` (str) |

### 4.3 Claude Desktop / AI Agent Integration
To connect Claude Desktop or any MCP-compatible agent to the Smart Workbench, point it to `workbench_mcp_server.py` placed on your Desktop:

**Claude Desktop Configuration (`%APPDATA%\Claude\claude_desktop_config.json`):**
```json
{
  "mcpServers": {
    "smart-workbench": {
      "command": "python",
      "args": [
        "C:\\Users\\dell\\Desktop\\workbench_mcp_server.py"
      ],
      "env": {
        "WORKBENCH_URL": "http://192.168.0.110"
      }
    }
  }
}
```

### 4.4 Running MCP Automated Tests
To test all 8 MCP tools from the command line:
```bash
python C:\Users\dell\Desktop\workbench_mcp_server.py --test
# OR
python C:\Users\dell\Desktop\test_mcp_endpoints.py
```

---

## 5. Cloudflare Tunnel & Domain Architecture

### 5.1 Active Tunnel Parameters
- **Tunnel Name / ID:** `f521d45d-0510-40c3-b59b-a9a6526ec5f8`
- **Account ID:** `63d2037b32639a96b7f27a86c7fc98ed`
- **Domain:** `ayushdubey.tech`
- **Tunnel Domain:** `f521d45d-0510-40c3-b59b-a9a6526ec5f8.cfargotunnel.com`
- **Service Status:** `cloudflared.service` is actively connected to Cloudflare Edge in Delhi (`del01`, `del03`, `del05`) via QUIC.
- **Local Ingress Config:** `/home/ayush/.cloudflared/config.yml` (routing `ayushdubey.tech` and `*.ayushdubey.tech` -> `http://127.0.0.1:80`).

### 5.2 Public Hostname Routing Setup in Cloudflare Zero Trust
Because the provided Cloudflare API Token has `#access:edit`, `#access:read`, `#zone:read` scopes (which lack automated DNS/Tunnel write permissions), complete the final one-click route in the dashboard:

1. Open Cloudflare Zero Trust Dashboard: [https://one.dash.cloudflare.com](https://one.dash.cloudflare.com)
2. Navigate to: **Networks** -> **Tunnels**.
3. Select tunnel: `f521d45d-0510-40c3-b59b-a9a6526ec5f8`.
4. Click **Configure** -> **Public Hostnames** tab -> **Add a public hostname**:
   - **Subdomain:** `@` (or leave blank for root domain) OR `workbench`
   - **Domain:** `ayushdubey.tech`
   - **Type:** `HTTP`
   - **URL:** `localhost:80` (or `localhost:8000`)
5. Click **Save hostname**.

*Alternative via Cloudflare DNS Dashboard:*
If preferred, go to [https://dash.cloudflare.com](https://dash.cloudflare.com) -> Select `ayushdubey.tech` -> **DNS** -> **Records** -> Add Record:
- **Type:** `CNAME`
- **Name:** `@` (or `workbench`)
- **Target:** `f521d45d-0510-40c3-b59b-a9a6526ec5f8.cfargotunnel.com`
- **Proxy status:** Proxied (Orange cloud ON)

Once saved, `https://ayushdubey.tech` instantly routes to your Workbench Hub with automatic SSL!

---

## 6. Target Host Services & Verification Commands

### Target Host Credentials & Paths
- **SSH Host:** `ayush@192.168.0.110` (SSH key active from Windows)
- **Target Directory:** `/home/ayush/workbench_hub`
- **FastAPI Daemon:** `workbench-hub.service` (Port 8000, multi-worker Uvicorn)
- **Reverse Proxy:** `nginx.service` (Port 80 -> Port 8000)
- **Cloudflare Tunnel:** `cloudflared.service`

### Live Health Checks
```bash
# Test MCP Overview
curl -s http://192.168.0.110/mcp

# Test System Status
curl -s http://192.168.0.110/api/status

# Test Inventory Catalog
curl -s http://192.168.0.110/api/inventory

# Test LLM Dual-Tier Synthesis
curl -s -X POST http://192.168.0.110/api/llm/prompt \
  -H "Content-Type: application/json" \
  -d '{"prompt": "Show pinout for ESP32"}'
```

---

## 7. OpenClaw Multi-Agent Gateway Integration

OpenClaw runs alongside the Workbench Hub on port 18789:
- **User systemd unit:** `systemctl --user status openclaw-gateway.service`
- **Configuration file:** `/home/ayush/.openclaw/openclaw.json`
- **Configured Providers:** Google Gemini 3.6 Flash (`AQ.Ab8RN6...`), OpenRouter, and Local LLM.
- **Autonomous Agent Access:** Connects via WebSocket to `ws://127.0.0.1:18789` for cross-device multi-agent routing.

import os
import json
import sqlite3
import asyncio
from pathlib import Path
from datetime import datetime, timezone
from typing import List, Optional, Dict, Any
from contextlib import asynccontextmanager

from fastapi import FastAPI, WebSocket, WebSocketDisconnect, HTTPException, Depends, Body, Request, UploadFile, File, Form
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from fastapi.responses import FileResponse, PlainTextResponse, JSONResponse
from pydantic import BaseModel, Field
from dotenv import load_dotenv

BASE_DIR = Path(__file__).resolve().parent
ENV_PATH = BASE_DIR / ".env"
load_dotenv(dotenv_path=ENV_PATH)

DB_PATH = BASE_DIR / "workbench.db"
NOTES_LOG_PATH = BASE_DIR / "notes" / "workbench_log.md"
PERSONAS_PATH = BASE_DIR / "personas.json"

def get_device_persona(device_id: str = "default") -> dict:
    if PERSONAS_PATH.exists():
        try:
            with open(PERSONAS_PATH, "r", encoding="utf-8") as f:
                data = json.load(f)
                return data.get(device_id, data.get("default", {}))
        except Exception as e:
            print(f"[Persona Load Error]: {e}")
    return {
        "name": "Smart Workbench Hub",
        "role": "general",
        "avatar": "default",
        "tts_voice": "alloy",
        "system_prompt": "You are the Smart Electronics Workbench assistant. Provide clear, high-contrast, technical responses."
    }

GEMINI_API_KEY = os.getenv("GEMINI_API_KEY", "")
GROQ_API_KEY = os.getenv("GROQ_API_KEY", "")
CLOUDFLARE_TUNNEL_ID = os.getenv("CLOUDFLARE_TUNNEL_ID", "f521d45d-0510-40c3-b59b-a9a6526ec5f8")
CLOUDFLARE_DOMAIN = os.getenv("CLOUDFLARE_DOMAIN", "workbench.ayushdubey.tech")

# -----------------------------------------------------------------------------
# Database Management
# -----------------------------------------------------------------------------
def get_db():
    conn = sqlite3.connect(str(DB_PATH), timeout=10.0)
    conn.row_factory = sqlite3.Row
    return conn

def init_database():
    with get_db() as conn:
        # 1. Inventory
        conn.execute("""
            CREATE TABLE IF NOT EXISTS inventory (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                component_name TEXT NOT NULL,
                quantity INTEGER NOT NULL DEFAULT 0,
                storage_location TEXT,
                category TEXT DEFAULT 'General',
                notes TEXT,
                updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
            );
        """)
        # 2. Logs
        conn.execute("""
            CREATE TABLE IF NOT EXISTS logs (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
                entry_type TEXT DEFAULT 'text',
                content TEXT NOT NULL,
                tags TEXT
            );
        """)
        # 3. Kiosk History
        conn.execute("""
            CREATE TABLE IF NOT EXISTS kiosk_history (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
                display_payload TEXT NOT NULL
            );
        """)
        # 4. Projects & BOM (Objective 8)
        conn.execute("""
            CREATE TABLE IF NOT EXISTS projects (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                name TEXT NOT NULL,
                description TEXT,
                status TEXT DEFAULT 'in_progress',
                target_hardware TEXT DEFAULT 'ESP32-S3',
                bom_json TEXT DEFAULT '[]',
                notes TEXT DEFAULT '',
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
            );
        """)
        # 5. Conversations History (Objective 5 & Context Continuity)
        conn.execute("""
            CREATE TABLE IF NOT EXISTS conversations (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                session_id TEXT DEFAULT 'workbench_default',
                role TEXT NOT NULL,
                content TEXT NOT NULL,
                timestamp DATETIME DEFAULT CURRENT_TIMESTAMP
            );
        """)
        # 6. Compacted Summaries for Token Saving
        conn.execute("""
            CREATE TABLE IF NOT EXISTS conversation_summaries (
                session_id TEXT PRIMARY KEY,
                summary_text TEXT NOT NULL,
                updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
            );
        """)
        conn.commit()

init_database()

# -----------------------------------------------------------------------------
# Models
# -----------------------------------------------------------------------------
class InventoryItem(BaseModel):
    component_name: str
    quantity: int = 0
    storage_location: Optional[str] = None
    category: Optional[str] = "General"
    notes: Optional[str] = None

class LogEntry(BaseModel):
    entry_type: str = "text"
    content: str
    tags: Optional[str] = ""

class KioskPayload(BaseModel):
    type: str = "markdown"
    title: str = "Smart Workbench"
    content: str

class PromptRequest(BaseModel):
    prompt: str
    session_id: Optional[str] = "workbench_default"

class XiaozhiBroadcastRequest(BaseModel):
    text: str

class ProjectItem(BaseModel):
    name: str
    description: Optional[str] = ""
    status: Optional[str] = "in_progress" # planning, in_progress, completed, archived
    target_hardware: Optional[str] = "ESP32-S3"
    bom_json: Optional[str] = "[]"
    notes: Optional[str] = ""

class ProjectBOMUpdate(BaseModel):
    component_name: str
    quantity_needed: int = 1
    item_id: Optional[int] = None
    notes: Optional[str] = ""

# -----------------------------------------------------------------------------
# WebSocket Connection Managers (Zero-Latency Direct Broadcast)
# -----------------------------------------------------------------------------
class KioskConnectionManager:
    def __init__(self):
        self.active_connections: List[WebSocket] = []
        self._lock = asyncio.Lock()

    async def connect(self, websocket: WebSocket):
        await websocket.accept()
        async with self._lock:
            self.active_connections.append(websocket)
        print(f"[WS/kiosk] Client connected. Total active: {len(self.active_connections)}")

    async def disconnect(self, websocket: WebSocket):
        async with self._lock:
            if websocket in self.active_connections:
                self.active_connections.remove(websocket)
        print(f"[WS/kiosk] Client disconnected. Total active: {len(self.active_connections)}")

    async def broadcast(self, message: dict):
        """Zero-latency concurrent broadcast."""
        async with self._lock:
            if not self.active_connections:
                return
            dead = []
            for ws in list(self.active_connections):
                try:
                    await ws.send_json(message)
                except Exception:
                    dead.append(ws)
            for d in dead:
                if d in self.active_connections:
                    self.active_connections.remove(d)

kiosk_manager = KioskConnectionManager()

class XiaozhiConnectionManager:
    def __init__(self):
        self.active_connections: List[WebSocket] = []
        self._lock = asyncio.Lock()

    async def connect(self, websocket: WebSocket):
        async with self._lock:
            self.active_connections.append(websocket)
        print(f"[WS/xiaozhi] Edge device connected. Active count: {len(self.active_connections)}")

    async def disconnect(self, websocket: WebSocket):
        async with self._lock:
            if websocket in self.active_connections:
                self.active_connections.remove(websocket)
        print(f"[WS/xiaozhi] Edge device disconnected. Active count: {len(self.active_connections)}")

    async def broadcast(self, message: dict):
        """Zero-latency concurrent broadcast to Xiaozhi hardware."""
        async with self._lock:
            if not self.active_connections:
                return
            dead = []
            for ws in list(self.active_connections):
                try:
                    await ws.send_json(message)
                except Exception:
                    dead.append(ws)
            for d in dead:
                if d in self.active_connections:
                    self.active_connections.remove(d)

xiaozhi_manager = XiaozhiConnectionManager()

# -----------------------------------------------------------------------------
# Lifespan: Zero Redundant Polling Loops (Objective 3)
# -----------------------------------------------------------------------------
@asynccontextmanager
async def lifespan(app: FastAPI):
    try:
        with get_db() as conn:
            conn.execute("PRAGMA journal_mode=WAL;")
    except Exception as e:
        print(f"[Lifespan Init Error]: {e}")
    # Redundant 300ms SQLite polling loop removed!
    yield

app = FastAPI(
    title="Smart Workbench Hub",
    description="AI-powered smart electronics workbench hub with Xiaozhi ESP32-S3/P4 telemetry, PTT Chatbot, Projects, and MCP endpoints",
    version="2.0.0",
    lifespan=lifespan
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# -----------------------------------------------------------------------------
# Tool & Telemetry Implementations
# -----------------------------------------------------------------------------
latest_soldering_state = {
    "title": "Soldering Station Standby",
    "content": "• STATION READY: 3.3V SPI0 Mode\n• LEADED (60/40): 300°C – 320°C\n• LEAD-FREE (SAC305): 350°C – 370°C\n• Ask Feynman copilot for pinouts, thermal tips, or science wonders!",
    "full_content": "Soldering station online. Ready for technical prompts.",
    "type": "markdown",
    "timestamp": datetime.now(timezone.utc).isoformat()
}

async def display_on_desk(type: str, content: str, title: str = "Smart Workbench", soldering_content: Optional[str] = None) -> dict:
    """Instant in-memory broadcast to kiosk + soldering station + non-blocking background DB log."""
    now_iso = datetime.now(timezone.utc).isoformat()
    
    # Auto-generate compact soldering view if not explicitly provided
    if not soldering_content:
        lines = [line.strip() for line in content.split("\n") if line.strip() and not line.strip().startswith("#")]
        soldering_content = "\n".join([f"• {l}" if not l.startswith("•") and not l.startswith("-") and not l.startswith("|") else l for l in lines[:7]])
        if not soldering_content:
            soldering_content = f"• {title}\n• {content[:180]}"

    global latest_soldering_state
    latest_soldering_state = {
        "title": title,
        "content": soldering_content,
        "full_content": content,
        "type": type,
        "timestamp": now_iso
    }

    payload = {
        "type": type,
        "title": title,
        "content": content,
        "soldering_content": soldering_content,
        "timestamp": now_iso
    }
    # 1. Instant in-memory broadcast to all connected WebSocket displays
    await kiosk_manager.broadcast(payload)
    
    # 2. Asynchronous non-blocking DB persistence
    def _save():
        try:
            with get_db() as conn:
                conn.execute(
                    "INSERT INTO kiosk_history (timestamp, display_payload) VALUES (CURRENT_TIMESTAMP, ?)",
                    (json.dumps(payload),)
                )
                conn.commit()
        except Exception as e:
            print(f"[DB Error in kiosk save]: {e}")

    asyncio.get_event_loop().run_in_executor(None, _save)
    return {"status": "success", "payload": payload}

def log_note(content: str, entry_type: str = "text", tags: str = "") -> dict:
    utc_now = datetime.now(timezone.utc)
    utc_str = utc_now.strftime("%Y-%m-%d %H:%M:%S UTC")
    local_str = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    ts_display = f"{utc_str} / Local: {local_str}"
    
    new_id = None
    try:
        with get_db() as conn:
            cur = conn.execute(
                "INSERT INTO logs (timestamp, entry_type, content, tags) VALUES (CURRENT_TIMESTAMP, ?, ?, ?)",
                (entry_type, content, tags)
            )
            conn.commit()
            new_id = cur.lastrowid
    except Exception as e:
        print(f"[DB Error in log_note]: {e}")

    try:
        NOTES_LOG_PATH.parent.mkdir(parents=True, exist_ok=True)
        md_entry = (
            f"\n\n### [{ts_display}] ({entry_type.upper()})\n"
            f"{content.strip()}\n"
        )
        if tags:
            md_entry += f"\n*Tags: {tags}*\n"
        md_entry += "\n---\n"
        
        with open(NOTES_LOG_PATH, "a", encoding="utf-8") as f:
            f.write(md_entry)
    except Exception as e:
        print(f"[File Error in log_note]: {e}")

    return {"status": "success", "id": new_id, "timestamp": utc_str, "entry_type": entry_type}

# -----------------------------------------------------------------------------
# Conversation Storage, Context Continuity & Token Compaction (Objective 5)
# -----------------------------------------------------------------------------
def save_conversation_turn(session_id: str, role: str, content: str):
    with get_db() as conn:
        conn.execute(
            "INSERT INTO conversations (session_id, role, content) VALUES (?, ?, ?)",
            (session_id, role, content)
        )
        conn.commit()

def get_conversation_history(session_id: str = "workbench_default", limit: int = 10) -> List[Dict[str, Any]]:
    with get_db() as conn:
        rows = conn.execute(
            "SELECT id, session_id, role, content, timestamp FROM conversations WHERE session_id = ? ORDER BY id DESC LIMIT ?",
            (session_id, limit)
        ).fetchall()
        # Return chronologically ascending
        return [dict(r) for r in reversed(rows)]

def get_session_summary(session_id: str = "workbench_default") -> str:
    with get_db() as conn:
        row = conn.execute("SELECT summary_text FROM conversation_summaries WHERE session_id = ?", (session_id,)).fetchone()
        return row["summary_text"] if row else ""

async def compact_conversation_if_needed(session_id: str = "workbench_default", threshold: int = 12):
    """Compacts conversation turns when count exceeds threshold, summarizing older turns."""
    with get_db() as conn:
        total_count = conn.execute("SELECT COUNT(*) FROM conversations WHERE session_id = ?", (session_id,)).fetchone()[0]
        if total_count < threshold:
            return False

        # Retrieve all turns
        all_turns = conn.execute(
            "SELECT id, role, content FROM conversations WHERE session_id = ? ORDER BY id ASC",
            (session_id,)
        ).fetchall()

    # Retain the last 6 turns for immediate direct context
    to_compact = all_turns[:-6]
    if not to_compact:
        return False

    ids_to_remove = [t["id"] for t in to_compact]
    existing_summary = get_session_summary(session_id)
    text_to_compress = "\n".join([f"{t['role'].upper()}: {t['content']}" for t in to_compact])

    prompt = (
        "You are an expert electronics engineering copilot memory compressor. "
        "Summarize the following prior conversation turns into a dense technical summary paragraph. "
        "CRITICAL: Retain all hardware names (e.g. Raspberry Pi, ESP32-S3, ESP32-P4), pin numbers (e.g. GND pins 6, 9, 14, 20, 25, 30, 34, 39), "
        "voltages, test measurements, circuit requirements, and design decisions. "
        "Eliminate pleasantries and conversational filler. Max 120 words.\n\n"
        f"Prior Summary (if any): {existing_summary}\n\n"
        f"Conversation turns to merge:\n{text_to_compress}"
    )

    new_summary = ""
    # Try Groq first with qwen/qwen3.8-27b
    if GROQ_API_KEY and GROQ_API_KEY != "your_groq_api_key_here":
        try:
            from groq import Groq
            client = Groq(api_key=GROQ_API_KEY)
            for m in ["qwen/qwen3.8-27b", "openai/gpt-oss-20b"]:
                try:
                    resp = client.chat.completions.create(
                        messages=[{"role": "user", "content": prompt}],
                        model=m,
                        max_tokens=180,
                        temperature=0.0
                    )
                    new_summary = resp.choices[0].message.content.strip()
                    if new_summary:
                        break
                except Exception:
                    continue
        except Exception as e:
            print(f"[Groq Compaction Error]: {e}")

    if not new_summary and GEMINI_API_KEY and GEMINI_API_KEY != "your_gemini_api_key_here":
        try:
            import google.generativeai as genai
            genai.configure(api_key=GEMINI_API_KEY)
            model = genai.GenerativeModel("gemini-3.6-flash")
            resp = model.generate_content(prompt)
            new_summary = resp.text.strip()
        except Exception as e:
            print(f"[Gemini Compaction Error]: {e}")

    if not new_summary:
        user_queries = [t["content"][:50] for t in to_compact if t["role"] == "user"]
        new_summary = f"Prior topics: {'; '.join(user_queries)}."

    # Update summary and prune compacted turns
    with get_db() as conn:
        conn.execute("""
            INSERT INTO conversation_summaries (session_id, summary_text, updated_at)
            VALUES (?, ?, CURRENT_TIMESTAMP)
            ON CONFLICT(session_id) DO UPDATE SET
                summary_text = excluded.summary_text,
                updated_at = CURRENT_TIMESTAMP
        """, (session_id, new_summary))

        placeholders = ",".join("?" for _ in ids_to_remove)
        conn.execute(f"DELETE FROM conversations WHERE id IN ({placeholders})", ids_to_remove)
        conn.commit()

    print(f"[Compaction] Pruned {len(ids_to_remove)} older turns for session '{session_id}'. Summary updated.")
    return True

# -----------------------------------------------------------------------------
# Workbench Context & Intelligent Suggestion Engine (Objective 4)
# -----------------------------------------------------------------------------
def get_workbench_ai_context() -> Dict[str, Any]:
    """Inspects recent lab readings, active projects, inventory parts, and telemetry."""
    with get_db() as conn:
        recent_logs = conn.execute("SELECT * FROM logs ORDER BY id DESC LIMIT 5").fetchall()
        projects = conn.execute("SELECT * FROM projects WHERE status != 'archived' ORDER BY updated_at DESC LIMIT 5").fetchall()
        low_stock = conn.execute("SELECT * FROM inventory WHERE quantity <= 2 ORDER BY quantity ASC LIMIT 6").fetchall()
        inv_count = conn.execute("SELECT COUNT(*), SUM(quantity) FROM inventory").fetchone()
        hardware_items = conn.execute("SELECT component_name, category, storage_location FROM inventory WHERE category IN ('Microcontrollers', 'Sensors', 'Audio', 'Displays') LIMIT 10").fetchall()

    return {
        "recent_logs": [dict(r) for r in recent_logs],
        "active_projects": [dict(r) for r in projects],
        "low_stock": [dict(r) for r in low_stock],
        "total_parts": inv_count[0] if inv_count else 0,
        "total_units": inv_count[1] if inv_count else 0,
        "featured_hardware": [dict(r) for r in hardware_items],
        "xiaozhi_active_count": len(xiaozhi_manager.active_connections),
        "kiosk_active_count": len(kiosk_manager.active_connections)
    }

def generate_contextual_suggestions() -> List[Dict[str, str]]:
    """Proposes high-value next steps, pinouts, and calculations based on bench state."""
    ctx = get_workbench_ai_context()
    suggestions = []

    # 1. Project-driven suggestions
    for p in ctx["active_projects"]:
        hw = p.get("target_hardware") or "ESP32-S3"
        p_name = p.get("name", "Project")
        if "P4" in hw.upper():
            suggestions.append({
                "id": f"s-p4-{p['id']}",
                "category": "Pinout",
                "label": f"📟 {hw} I2S Audio Pinout",
                "prompt": f"Show complete pinout for {hw} with ES8311 I2S audio codec for {p_name}"
            })
        elif "S3" in hw.upper():
            suggestions.append({
                "id": f"s-s3-{p['id']}",
                "category": "Hardware",
                "label": f"⚡ {hw} USB & Boot Strapping",
                "prompt": f"Explain {hw} native USB CDC/JTAG vs UART flashing strapping pins for {p_name}"
            })
        else:
            suggestions.append({
                "id": f"s-proj-{p['id']}",
                "category": "Project",
                "label": f"📋 {p_name} BOM Check",
                "prompt": f"Check bill of materials and component compatibility for project '{p_name}'"
            })

    # 2. Reading/Log-driven suggestions
    for log in ctx["recent_logs"]:
        content = log.get("content", "")
        e_type = log.get("entry_type", "")
        if any(v in content.lower() for v in ["3.3v", "5v", "rail", "voltage", "reading"]):
            suggestions.append({
                "id": f"s-volt-{log['id']}",
                "category": "Calculation",
                "label": "⚡ Rail Ripple & LDO Dropout",
                "prompt": "Calculate LDO dropout margin and power dissipation for 3.3V rail under 250mA load"
            })
            break
        elif e_type == "oscilloscope" or "pwm" in content.lower() or "hz" in content.lower():
            suggestions.append({
                "id": f"s-scope-{log['id']}",
                "category": "RF / Scope",
                "label": "📈 Scope Ringing & RC Snubber",
                "prompt": "Calculate RC snubber filter values to dampen ringing on high-frequency PWM switching signal"
            })
            break

    # 3. Low-stock driven suggestions
    if ctx["low_stock"]:
        first_low = ctx["low_stock"][0]["component_name"]
        suggestions.append({
            "id": "s-stock-low",
            "category": "Inventory",
            "label": f"⚠️ Low Stock: {first_low[:18]}",
            "prompt": f"Find pin-compatible substitutes and drop-in replacements for low-stock part '{first_low}'"
        })

    # 4. Standard Electronics Bench Essentials
    suggestions.append({
        "id": "s-rpi-pinout",
        "category": "Pinout",
        "label": "📟 Raspberry Pi 40-Pin Header",
        "prompt": "Show complete 40-pin GPIO pinout for Raspberry Pi including all physical GND and 3.3V/5V pins"
    })
    suggestions.append({
        "id": "s-esp32-devkit",
        "category": "Pinout",
        "label": "📟 ESP32 DevKit V1 Pinout",
        "prompt": "Show ESP32 DevKit V1 standard GPIO, I2C, SPI, and ADC pinout diagram"
    })
    suggestions.append({
        "id": "s-i2c-calc",
        "category": "Calculation",
        "label": "〰️ I2C Bus Pullup Calculator",
        "prompt": "Calculate optimal I2C pull-up resistor values for 400kHz Fast-mode bus with 150pF capacitance"
    })

    return suggestions[:6]

# -----------------------------------------------------------------------------
# Dual-Tier Feynman LLM Routing (2.8" SPI Soldering Station + Full Kiosk)
# -----------------------------------------------------------------------------
def parse_dual_display_sections(raw_text: str, default_title: str = "Workbench Intel") -> tuple[str, str, str]:
    """
    Parses LLM output that contains:
    ### [SOLDERING STATION - 2.8" SPI]
    ...
    ### [FULL KIOSK - RICHARD FEYNMAN]
    ...
    Returns (soldering_content, full_content, title)
    """
    soldering_content = ""
    full_content = ""
    title = default_title

    if '### [SOLDERING STATION - 2.8" SPI]' in raw_text or '### [SOLDERING STATION' in raw_text:
        parts = raw_text.split('### [FULL KIOSK')
        if len(parts) >= 2:
            soldering_part = parts[0].replace('### [SOLDERING STATION - 2.8" SPI]', '').replace('### [SOLDERING STATION]', '').strip()
            full_part = parts[1]
            if full_part.startswith(' - RICHARD FEYNMAN]'):
                full_part = full_part[len(' - RICHARD FEYNMAN]'):].strip()
            elif full_part.startswith(']'):
                full_part = full_part[1:].strip()
            soldering_content = soldering_part
            full_content = full_part
        else:
            soldering_content = raw_text[:350]
            full_content = raw_text
    elif '### [FULL KIOSK' in raw_text:
        parts = raw_text.split('### [FULL KIOSK')
        soldering_content = parts[0].strip()
        full_content = parts[1].strip()
        if full_content.startswith(']'):
            full_content = full_content[1:].strip()
        elif full_content.startswith(' - RICHARD FEYNMAN]'):
            full_content = full_content[len(' - RICHARD FEYNMAN]'):].strip()
    else:
        full_content = raw_text.strip()
        lines = [l.strip() for l in full_content.split('\n') if l.strip() and not l.strip().startswith('#')]
        soldering_content = "\n".join([f"• {l}" if not l.startswith("•") and not l.startswith("-") and not l.startswith("|") else l for l in lines[:7]])
        if not soldering_content:
            soldering_content = f"• {default_title}\n• {full_content[:180]}"

    return soldering_content.strip(), full_content.strip(), title


async def route_llm_intent(user_prompt: str, device_id: str = "default", session_id: str = "workbench_default") -> dict:
    persona = get_device_persona(device_id)
    user_prompt_clean = user_prompt.strip()

    # 1. Fetch prior conversation history & summary BEFORE saving current turn
    history = get_conversation_history(session_id=session_id, limit=8)
    summary_text = get_session_summary(session_id=session_id)
    wb_context = get_workbench_ai_context()

    # Format workbench context concisely
    active_projects_str = ", ".join([f"{p['name']} ({p.get('target_hardware', 'MCU')})" for p in wb_context["active_projects"]]) or "None"
    recent_readings_str = "; ".join([f"{l.get('entry_type')}: {l.get('content')[:40]}" for l in wb_context["recent_logs"][:2]]) or "None"
    low_stock_str = ", ".join([f"{i['component_name']}" for i in wb_context["low_stock"][:3]]) or "None"

    bench_intel_header = (
        f"Workbench Hardware State: Active Projects: {active_projects_str} | Recent Readings: {recent_readings_str} | Low Stock: {low_stock_str}"
    )

    feynman_system_prompt = (
        "You are Richard Feynman—cheerful, wonderfully curious, enthusiastic, and bursting with the joy of finding things out! "
        "You are a brilliant physicist and hands-on tinkerer at the workbench.\n"
        "You talk with boundless enthusiasm and warmth about EVERYTHING: astrophysics, quantum mechanics, biology ('how bees are the sex organs of the flower world!'), "
        "nature, everyday wonders, lockpicking, bongo drums, and hands-on electronics.\n"
        "When the user asks you anything, explain with vivid physical intuition, warmth, humor, and clarity—never in dry robotic jargon.\n\n"
        "CONVERSATIONAL CONTINUITY:\n"
        "Always maintain conversation context! If the user asks a follow-up (e.g. 'raspberry pi pins' followed by 'physical ground pins'), "
        "resolve it in the exact context of what was previously discussed (e.g. Raspberry Pi 40-pin header ground pins: pins 6, 9, 14, 20, 25, 30, 34, 39).\n\n"
        "TWO DISTINCT VIEWS REQUIRED IN EVERY ANSWER:\n"
        "Structure your response with these exact two markdown section headers:\n\n"
        "### [SOLDERING STATION - 2.8\" SPI]\n"
        "(Ultra-clean, high-contrast, compact summary for a 2.8-inch 320x240 LCD mounted right at the soldering iron.\n"
        "Include:\n"
        "• Solder temperatures: e.g. 60/40 Leaded @ 310°C | Lead-Free SAC305 @ 350°C\n"
        "• Exact pin numbers (e.g. GND: Pins 6, 9, 14, 20, 25, 30, 34, 39)\n"
        "• Polarity/orientation tips\n"
        "• Step-by-step soldering bullets without filler words!\n"
        "If the question is about general science, biology, or astrophysics [e.g. bees or stars], provide a 3-bullet concise summary of the core scientific insight and note 'Soldering Iron Standby'.)\n\n"
        "### [FULL KIOSK - RICHARD FEYNMAN]\n"
        "(The complete, cheerful, Feynman-style explanation with vivid analogies, intuition, diagrams, and conversational joy for the big kiosk screen.)\n\n"
        f"{bench_intel_header}"
    )

    # Build message chain with prior history
    chat_messages_chain = [{"role": "system", "content": feynman_system_prompt}]
    if summary_text:
        chat_messages_chain.append({"role": "system", "content": f"[Previous Session Context Summary: {summary_text}]"})
    for m in history:
        chat_messages_chain.append({"role": m["role"], "content": m["content"]})
    chat_messages_chain.append({"role": "user", "content": user_prompt_clean})

    raw_response = ""
    title = "Feynman Workbench Intel"
    display_type = "markdown"

    # Fast Single-Pass generation: Try Groq first (~1s latency)
    if GROQ_API_KEY and GROQ_API_KEY != "your_groq_api_key_here":
        try:
            from groq import Groq
            client = Groq(api_key=GROQ_API_KEY)
            for m in ["qwen/qwen3.8-27b", "openai/gpt-oss-20b"]:
                try:
                    chat_resp = client.chat.completions.create(
                        messages=chat_messages_chain,
                        model=m,
                        max_tokens=900,
                        temperature=0.3
                    )
                    raw_response = chat_resp.choices[0].message.content.strip()
                    if raw_response:
                        break
                except Exception as e:
                    print(f"[Groq Generation Error on {m}]: {e}")
                    continue
        except Exception as e:
            print(f"[Groq Init Error]: {e}")

    # Fallback to Gemini if Groq was unavailable
    if not raw_response and GEMINI_API_KEY and GEMINI_API_KEY != "your_gemini_api_key_here":
        try:
            import google.generativeai as genai
            genai.configure(api_key=GEMINI_API_KEY)
            for m_name in ["gemini-3.6-flash", "gemini-flash-latest"]:
                try:
                    model = genai.GenerativeModel(m_name)
                    convo_text = ""
                    if summary_text:
                        convo_text += f"[Prior Summary: {summary_text}]\n\n"
                    for m in history:
                        label = "User" if m["role"] == "user" else "Richard Feynman"
                        convo_text += f"{label}: {m['content']}\n\n"
                    gemini_full_prompt = (
                        f"{feynman_system_prompt}\n\n"
                        f"CONVERSATION HISTORY:\n{convo_text}\n"
                        f"CURRENT USER QUERY: {user_prompt_clean}\n\n"
                        f"Provide the exact answer with both [SOLDERING STATION - 2.8\" SPI] and [FULL KIOSK - RICHARD FEYNMAN] sections:"
                    )
                    resp = model.generate_content(gemini_full_prompt)
                    raw_response = resp.text.strip()
                    if raw_response:
                        break
                except Exception as e:
                    print(f"[Gemini Generation Error on {m_name}]: {e}")
                    continue
        except Exception as e:
            print(f"[Gemini Error]: {e}")

    # Instant Heuristic Fallback if offline
    if not raw_response:
        low_query = user_prompt_clean.lower()
        prev_context = " ".join([m["content"].lower() for m in history])
        
        if "ground" in low_query and ("raspberry" in low_query or "raspberry" in prev_context or "rpi" in prev_context):
            title = "Raspberry Pi Physical Ground Pins"
            display_type = "pinout"
            raw_response = (
                "### [SOLDERING STATION - 2.8\" SPI]\n"
                "• TARGET: RASPBERRY PI 40-PIN HEADER\n"
                "• GND PINS: 6, 9, 14, 20, 25, 30, 34, 39 (8 Total)\n"
                "• SOLDER TIP: 330°C (60/40) | 360°C (Lead-Free)\n"
                "• NOTE: Large thermal mass! Pin is tied directly to internal copper ground plane.\n\n"
                "### [FULL KIOSK - RICHARD FEYNMAN]\n"
                "Isn't it wonderful how grounds work? On the standard 40-pin Raspberry Pi header (Pi 2, 3, 4, 5, Zero), you have **8 physical Ground (GND) pins** all tied to one massive copper plane on the PCB!\n\n"
                "| Physical Pin | Column | Adjacent Signal |\n"
                "|---|---|---|\n"
                "| **Pin 6** | Outer (Right) | Right next to +5V (Pin 4) |\n"
                "| **Pin 9** | Inner (Left) | Between GPIO 4 & GPIO 17 |\n"
                "| **Pin 14** | Outer (Right) | Adjacent to UART0 TXD |\n"
                "| **Pin 20** | Outer (Right) | Adjacent to PCM CLK |\n"
                "| **Pin 25** | Inner (Left) | Adjacent to GPIO 22 |\n"
                "| **Pin 30** | Outer (Right) | Adjacent to GPIO 5 |\n"
                "| **Pin 34** | Outer (Right) | Adjacent to GPIO 6 |\n"
                "| **Pin 39** | Inner (Left) | Adjacent to GPIO 21 |\n\n"
                "*Feynman Tip:* Because that internal copper ground plane sucks away heat like a sponge in water, keep your iron tip nice and tinned when soldering ground pins to maintain good thermal conduction!"
            )
        elif "bee" in low_query or "flower" in low_query:
            title = "The Wondrous Sex Life of Flowers & Bees"
            raw_response = (
                "### [SOLDERING STATION - 2.8\" SPI]\n"
                "• TOPIC: Floral Biology & Pollinator Symbiosis\n"
                "• CORE INSIGHT: Flowers are rooted; bees act as flying gamete couriers!\n"
                "• SOLDER BENCH: Standby (Room Temp). Ready for electronics.\n\n"
                "### [FULL KIOSK - RICHARD FEYNMAN]\n"
                "Haha! You want to know about flowers and bees? Think about it—it is one of the most delightful, clever tricks in all of evolutionary biology!\n\n"
                "A plant is stuck in the dirt. It cannot get up, put on a fancy tuxedo, and go looking for a mate across the field. So what does it do? It invents external flying sex organs! It produces sugary nectar, gorgeous ultraviolet runway patterns on its petals, and intoxicating fragrant molecules. The bee flies in for a free snack, gets dusted with golden pollen grains (which are literally plant sperm cells), and buzzes over to the next blossom, rubbing off on the sticky stigma!\n\n"
                "The bee thinks it is just running a private sugar business, the flower is orchestrating planetary reproduction across miles of open air, and both are dancing to the laws of thermodynamics and evolution. Nature doesn't care about our neat little categories—it just finds ways that work!"
            )
        else:
            title = "Richard Feynman Workbench Intel"
            raw_response = (
                f"### [SOLDERING STATION - 2.8\" SPI]\n"
                f"• QUERY: {user_prompt_clean[:40]}\n"
                f"• STATUS: Processed by Feynman Copilot\n"
                f"• SOLDER BENCH: 320°C standard\n\n"
                f"### [FULL KIOSK - RICHARD FEYNMAN]\n"
                f"Well, hello! You asked about: **{user_prompt_clean}**.\n\n"
                f"There is always something deeply fascinating hidden just beneath the surface of any physical question. Let's explore the mechanism, the connections, and how we can make it work right here at the bench!"
            )

    # Parse both views
    soldering_content, response_content, determined_title = parse_dual_display_sections(raw_response, default_title=title)
    if determined_title:
        title = determined_title

    # Determine intent tag
    low_query = user_prompt_clean.lower()
    if any(k in low_query for k in ["pin", "pins", "gpio", "wiring", "schematic", "ground", "gnd"]):
        intent = "schematic"
        display_type = "pinout"
    elif any(k in low_query for k in ["reading", "multimeter", "volts", "log"]):
        intent = "log"
        display_type = "markdown"
    elif any(k in low_query for k in ["project", "bom"]):
        intent = "project"
        display_type = "markdown"
    else:
        intent = "general"
        display_type = "markdown"

    # Save to SQLite conversations table
    save_conversation_turn(session_id, "user", user_prompt_clean)
    save_conversation_turn(session_id, "assistant", response_content)

    # Trigger auto-compaction asynchronously if turns exceed threshold
    asyncio.create_task(compact_conversation_if_needed(session_id))

    # Push to both desk kiosk and soldering station mirror!
    await display_on_desk(type=display_type, content=response_content, title=title, soldering_content=soldering_content)

    return {
        "intent": intent,
        "displayed": True,
        "title": title,
        "content": response_content,
        "soldering_content": soldering_content
    }

# -----------------------------------------------------------------------------
# MODEL CONTEXT PROTOCOL (MCP JSON-RPC 2.0) SPECIFICATION & EXECUTION
# -----------------------------------------------------------------------------
MCP_TOOLS = [
    {
        "name": "display_on_desk",
        "description": "Pushes technical documentation, schematics, pinout tables, or status notices to the benchtop kiosk display.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "type": {
                    "type": "string",
                    "enum": ["markdown", "pinout", "schematic", "code", "image"],
                    "description": "Payload rendering format",
                    "default": "markdown"
                },
                "title": {
                    "type": "string",
                    "description": "Title displayed at top of the bench screen",
                    "default": "Workbench Notice"
                },
                "content": {
                    "type": "string",
                    "description": "The Markdown or ASCII content to render on screen"
                }
            },
            "required": ["content"]
        }
    },
    {
        "name": "get_kiosk_state",
        "description": "Retrieves the currently displayed payload and title on the benchtop kiosk display.",
        "inputSchema": {
            "type": "object",
            "properties": {}
        }
    },
    {
        "name": "log_note",
        "description": "Records technical observations, multimeter/sensor readings, oscilloscope traces, or circuit notes into the database and notes/workbench_log.md.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "content": {"type": "string", "description": "Detailed text or Markdown content of the measurement or note"},
                "entry_type": {"type": "string", "enum": ["text", "reading", "oscilloscope", "schematic", "issue"], "default": "text"},
                "tags": {"type": "string", "description": "Comma-separated search tags (e.g., 'esp32-s3, i2s, 3v3')", "default": ""}
            },
            "required": ["content"]
        }
    },
    {
        "name": "get_logs",
        "description": "Retrieves recent lab notebook records, test measurements, or technical notes with optional query filter.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "q": {"type": "string", "description": "Search keyword for content or tags"},
                "entry_type": {"type": "string", "description": "Filter by entry type (text, reading, oscilloscope, schematic, issue)"},
                "limit": {"type": "integer", "description": "Maximum entries to return (default 20)", "default": 20}
            }
        }
    },
    {
        "name": "manage_inventory",
        "description": "Manages bench component stock: list, add, update, adjust quantity, or delete components.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "action": {"type": "string", "enum": ["list", "add", "adjust", "delete"]},
                "q": {"type": "string", "description": "Search query for action='list'"},
                "category": {"type": "string", "description": "Category filter for action='list'"},
                "item_id": {"type": "integer", "description": "Component ID for action='adjust' or action='delete'"},
                "delta": {"type": "integer", "description": "Quantity change (+1, -1, etc.) for action='adjust'"},
                "component_name": {"type": "string", "description": "Component name for action='add'"},
                "quantity": {"type": "integer", "description": "Initial quantity for action='add'", "default": 1},
                "storage_location": {"type": "string", "description": "Storage bin / drawer for action='add'", "default": ""},
                "notes": {"type": "string", "description": "Technical notes / specs for action='add'", "default": ""}
            },
            "required": ["action"]
        }
    },
    {
        "name": "manage_projects",
        "description": "Manages engineering projects, hardware builds, and Bill of Materials (BOM) on the workbench.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "action": {"type": "string", "enum": ["list", "get", "create", "update", "delete"]},
                "project_id": {"type": "integer"},
                "name": {"type": "string"},
                "description": {"type": "string"},
                "status": {"type": "string"},
                "target_hardware": {"type": "string"},
                "bom_json": {"type": "string"},
                "notes": {"type": "string"}
            },
            "required": ["action"]
        }
    },
    {
        "name": "route_llm_prompt",
        "description": "Queries the dual-tier Groq/Gemini intelligence engine for electronics design, pinouts, calculations, or circuit troubleshooting.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "prompt": {"type": "string", "description": "Electronics or technical question/command"}
            },
            "required": ["prompt"]
        }
    },
    {
        "name": "get_system_status",
        "description": "Returns operational telemetry: active Xiaozhi hardware clients, kiosk clients, Groq/Gemini config, and Cloudflare tunnel status.",
        "inputSchema": {
            "type": "object",
            "properties": {}
        }
    },
    {
        "name": "xiaozhi_send_command",
        "description": "Broadcasts a text or TTS voice prompt to all connected Xiaozhi edge devices (ESP32-S3 / ESP32-P4) over WebSocket.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "text": {"type": "string", "description": "The message or voice prompt text to send to Xiaozhi hardware"}
            },
            "required": ["text"]
        }
    }
]

async def execute_mcp_tool(tool_name: str, args: dict) -> Any:
    if tool_name == "display_on_desk":
        content = args.get("content", "")
        title = args.get("title", "Workbench Notice")
        t_type = args.get("type", "markdown")
        return await display_on_desk(type=t_type, content=content, title=title)

    elif tool_name == "get_kiosk_state":
        with get_db() as conn:
            last = conn.execute("SELECT * FROM kiosk_history ORDER BY id DESC LIMIT 1").fetchone()
            if last:
                try:
                    payload = json.loads(last["display_payload"])
                except Exception:
                    payload = {"content": last["display_payload"]}
                return {"id": last["id"], "timestamp": last["timestamp"], "payload": payload}
            return {"status": "empty", "message": "No kiosk history recorded"}

    elif tool_name == "log_note":
        content = args.get("content", "")
        entry_type = args.get("entry_type", "text")
        tags = args.get("tags", "")
        res = log_note(content=content, entry_type=entry_type, tags=tags)
        return res

    elif tool_name == "get_logs":
        q = args.get("q")
        entry_type = args.get("entry_type")
        limit = args.get("limit", 20)
        with get_db() as conn:
            query = "SELECT * FROM logs WHERE 1=1"
            params = []
            if q:
                query += " AND (content LIKE ? OR tags LIKE ?)"
                wildcard = f"%{q}%"
                params.extend([wildcard, wildcard])
            if entry_type and entry_type != "All":
                query += " AND entry_type = ?"
                params.append(entry_type)
            query += " ORDER BY id DESC LIMIT ?"
            params.append(limit)
            rows = conn.execute(query, params).fetchall()
            return [dict(r) for r in rows]

    elif tool_name == "manage_inventory":
        action = args.get("action", "list")
        if action == "list":
            q = args.get("q")
            category = args.get("category")
            with get_db() as conn:
                query = "SELECT * FROM inventory WHERE 1=1"
                params = []
                if q:
                    query += " AND (component_name LIKE ? OR notes LIKE ? OR storage_location LIKE ?)"
                    wildcard = f"%{q}%"
                    params.extend([wildcard, wildcard, wildcard])
                if category and category != "All":
                    query += " AND category = ?"
                    params.append(category)
                query += " ORDER BY component_name ASC"
                rows = conn.execute(query, params).fetchall()
                return [dict(r) for r in rows]

        elif action == "add":
            comp_name = args.get("component_name", "").strip()
            if not comp_name:
                raise ValueError("component_name is required for action='add'")
            qty = int(args.get("quantity", 1))
            loc = args.get("storage_location", "")
            cat = args.get("category", "General")
            notes = args.get("notes", "")
            with get_db() as conn:
                cur = conn.execute(
                    "INSERT INTO inventory (component_name, quantity, storage_location, category, notes) VALUES (?, ?, ?, ?, ?)",
                    (comp_name, qty, loc, cat, notes)
                )
                conn.commit()
                return {"status": "success", "id": cur.lastrowid, "component_name": comp_name}

        elif action == "adjust":
            item_id = args.get("item_id")
            delta = int(args.get("delta", 0))
            if not item_id:
                raise ValueError("item_id is required for action='adjust'")
            with get_db() as conn:
                conn.execute(
                    "UPDATE inventory SET quantity = MAX(0, quantity + ?), updated_at = CURRENT_TIMESTAMP WHERE id = ?",
                    (delta, item_id)
                )
                conn.commit()
                row = conn.execute("SELECT * FROM inventory WHERE id = ?", (item_id,)).fetchone()
                return dict(row) if row else {"error": "Item not found"}

        elif action == "delete":
            item_id = args.get("item_id")
            if not item_id:
                raise ValueError("item_id is required for action='delete'")
            with get_db() as conn:
                conn.execute("DELETE FROM inventory WHERE id = ?", (item_id,))
                conn.commit()
                return {"status": "success", "deleted_id": item_id}

    elif tool_name == "manage_projects":
        action = args.get("action", "list")
        if action == "list":
            with get_db() as conn:
                rows = conn.execute("SELECT * FROM projects ORDER BY updated_at DESC").fetchall()
                return [dict(r) for r in rows]
        elif action == "get":
            p_id = args.get("project_id")
            with get_db() as conn:
                row = conn.execute("SELECT * FROM projects WHERE id = ?", (p_id,)).fetchone()
                return dict(row) if row else {"error": "Project not found"}
        elif action == "create":
            name = args.get("name")
            desc = args.get("description", "")
            status = args.get("status", "in_progress")
            hw = args.get("target_hardware", "ESP32-S3")
            bom = args.get("bom_json", "[]")
            notes = args.get("notes", "")
            with get_db() as conn:
                cur = conn.execute(
                    "INSERT INTO projects (name, description, status, target_hardware, bom_json, notes) VALUES (?, ?, ?, ?, ?, ?)",
                    (name, desc, status, hw, bom, notes)
                )
                conn.commit()
                return {"status": "success", "id": cur.lastrowid}
        elif action == "delete":
            p_id = args.get("project_id")
            with get_db() as conn:
                conn.execute("DELETE FROM projects WHERE id = ?", (p_id,))
                conn.commit()
                return {"status": "success", "deleted_id": p_id}

    elif tool_name == "route_llm_prompt":
        prompt = args.get("prompt", "")
        return await route_llm_intent(prompt)

    elif tool_name == "get_system_status":
        return get_system_status()

    elif tool_name == "xiaozhi_send_command":
        text = args.get("text", "")
        await xiaozhi_manager.broadcast({
            "type": "tts",
            "state": "start",
            "text": text
        })
        return {"status": "success", "broadcast_text": text}

    raise ValueError(f"Unknown MCP tool: {tool_name}")

async def handle_mcp_rpc(request_data: dict) -> dict:
    if not isinstance(request_data, dict):
        return {"jsonrpc": "2.0", "error": {"code": -32600, "message": "Invalid Request"}, "id": None}

    req_id = request_data.get("id")
    method = request_data.get("method")
    params = request_data.get("params", {})

    if method == "initialize":
        return {
            "jsonrpc": "2.0",
            "id": req_id,
            "result": {
                "protocolVersion": "2024-11-05",
                "capabilities": {
                    "tools": {"listChanged": False}
                },
                "serverInfo": {
                    "name": "Smart Workbench Hub MCP Gateway",
                    "version": "2.0.0"
                }
            }
        }
    elif method == "tools/list":
        return {
            "jsonrpc": "2.0",
            "id": req_id,
            "result": {
                "tools": MCP_TOOLS
            }
        }
    elif method == "tools/call":
        tool_name = params.get("name")
        arguments = params.get("arguments", {})
        try:
            tool_res = await execute_mcp_tool(tool_name, arguments)
            return {
                "jsonrpc": "2.0",
                "id": req_id,
                "result": {
                    "content": [
                        {
                            "type": "text",
                            "text": json.dumps(tool_res, default=str) if not isinstance(tool_res, str) else tool_res
                        }
                    ],
                    "isError": False
                }
            }
        except Exception as e:
            return {
                "jsonrpc": "2.0",
                "id": req_id,
                "error": {
                    "code": -32000,
                    "message": str(e)
                }
            }
    elif method == "ping":
        return {"jsonrpc": "2.0", "id": req_id, "result": {}}
    else:
        return {
            "jsonrpc": "2.0",
            "id": req_id,
            "error": {"code": -32601, "message": f"Method not found: {method}"}
        }

@app.post("/mcp")
@app.post("/api/mcp")
async def mcp_rpc_endpoint(req: Request):
    try:
        data = await req.json()
    except Exception:
        return JSONResponse(status_code=400, content={"jsonrpc": "2.0", "error": {"code": -32700, "message": "Parse error"}, "id": None})
    response = await handle_mcp_rpc(data)
    return JSONResponse(content=response)

@app.get("/mcp")
@app.get("/api/mcp")
def mcp_get_overview():
    return {
        "status": "online",
        "service": "Smart Workbench Hub MCP Gateway",
        "version": "2.0.0",
        "mcp_endpoint": "/mcp",
        "tools_available": len(MCP_TOOLS),
        "active_xiaozhi_clients": len(xiaozhi_manager.active_connections),
        "active_kiosk_clients": len(kiosk_manager.active_connections)
    }

# -----------------------------------------------------------------------------
# REST API: System Status (Objective 1: Accurate WebSocket Count & State)
# -----------------------------------------------------------------------------
@app.get("/api/status")
def get_system_status():
    xiaozhi_count = len(xiaozhi_manager.active_connections)
    kiosk_count = len(kiosk_manager.active_connections)
    return {
        "status": "online",
        "groq_configured": bool(GROQ_API_KEY and GROQ_API_KEY != "your_groq_api_key_here"),
        "gemini_configured": bool(GEMINI_API_KEY and GEMINI_API_KEY != "your_gemini_api_key_here"),
        "cloudflare_tunnel_id": CLOUDFLARE_TUNNEL_ID,
        "domain": CLOUDFLARE_DOMAIN,
        "kiosk_clients": kiosk_count,
        "xiaozhi_clients": xiaozhi_count,
        "xiaozhi_active": xiaozhi_count > 0,
        "xiaozhi_status": "connected" if xiaozhi_count > 0 else "listening",
        "xiaozhi_badge_label": f"Xiaozhi Active ({xiaozhi_count} Connected)" if xiaozhi_count > 0 else "Listening for Devices (0)",
        "xiaozhi_endpoint": "/ws/xiaozhi",
        "kiosk_endpoint": "/ws/kiosk",
        "mcp_endpoint": "/mcp",
        "timestamp": datetime.now(timezone.utc).isoformat()
    }

# -----------------------------------------------------------------------------
# REST API: Inventory CRUD
# -----------------------------------------------------------------------------
@app.get("/api/inventory", response_model=List[Dict[str, Any]])
def get_inventory(q: Optional[str] = None, category: Optional[str] = None):
    with get_db() as conn:
        query = "SELECT * FROM inventory WHERE 1=1"
        params = []
        if q:
            query += " AND (component_name LIKE ? OR notes LIKE ? OR storage_location LIKE ?)"
            wildcard = f"%{q}%"
            params.extend([wildcard, wildcard, wildcard])
        if category and category != "All":
            if category == "LowStock":
                query += " AND quantity <= 2"
            elif category == "Abundant":
                query += " AND quantity >= 10"
            else:
                query += " AND category = ?"
                params.append(category)
        query += " ORDER BY component_name ASC"
        rows = conn.execute(query, params).fetchall()
        return [dict(r) for r in rows]

@app.post("/api/inventory")
def create_or_update_inventory(item: InventoryItem):
    with get_db() as conn:
        existing = conn.execute(
            "SELECT id FROM inventory WHERE LOWER(component_name) = LOWER(?)",
            (item.component_name.strip(),)
        ).fetchone()

        if existing:
            conn.execute(
                """UPDATE inventory 
                   SET quantity = quantity + ?, 
                       storage_location = COALESCE(?, storage_location), 
                       category = COALESCE(?, category),
                       notes = COALESCE(?, notes),
                       updated_at = CURRENT_TIMESTAMP
                   WHERE id = ?""",
                (item.quantity, item.storage_location, item.category, item.notes, existing["id"])
            )
            conn.commit()
            return {"status": "updated", "id": existing["id"], "component_name": item.component_name}
        else:
            cur = conn.execute(
                """INSERT INTO inventory (component_name, quantity, storage_location, category, notes)
                   VALUES (?, ?, ?, ?, ?)""",
                (item.component_name.strip(), item.quantity, item.storage_location, item.category, item.notes)
            )
            conn.commit()
            return {"status": "created", "id": cur.lastrowid, "component_name": item.component_name}

@app.post("/api/inventory/{item_id}/adjust")
def adjust_inventory_quantity(item_id: int, delta: int = Body(..., embed=True)):
    with get_db() as conn:
        conn.execute(
            "UPDATE inventory SET quantity = MAX(0, quantity + ?), updated_at = CURRENT_TIMESTAMP WHERE id = ?",
            (delta, item_id)
        )
        conn.commit()
        row = conn.execute("SELECT * FROM inventory WHERE id = ?", (item_id,)).fetchone()
        if not row:
            raise HTTPException(status_code=404, detail="Item not found")
        return dict(row)

@app.delete("/api/inventory/{item_id}")
def delete_inventory_item(item_id: int):
    with get_db() as conn:
        conn.execute("DELETE FROM inventory WHERE id = ?", (item_id,))
        conn.commit()
        return {"status": "deleted", "id": item_id}

# -----------------------------------------------------------------------------
# REST API: Lab Notebook & Logs CRUD
# -----------------------------------------------------------------------------
@app.get("/api/logs", response_model=List[Dict[str, Any]])
def get_logs(q: Optional[str] = None, entry_type: Optional[str] = None, limit: int = 50):
    with get_db() as conn:
        query = "SELECT * FROM logs WHERE 1=1"
        params = []
        if q:
            query += " AND (content LIKE ? OR tags LIKE ?)"
            wildcard = f"%{q}%"
            params.extend([wildcard, wildcard])
        if entry_type and entry_type != "All":
            query += " AND entry_type = ?"
            params.append(entry_type)
        query += " ORDER BY id DESC LIMIT ?"
        params.append(limit)
        rows = conn.execute(query, params).fetchall()
        return [dict(r) for r in rows]

@app.post("/api/logs")
def create_log(entry: LogEntry):
    res = log_note(content=entry.content, entry_type=entry.entry_type, tags=entry.tags or "")
    return res

@app.get("/api/logs/export", response_class=PlainTextResponse)
def export_notes():
    if NOTES_LOG_PATH.exists():
        return NOTES_LOG_PATH.read_text(encoding="utf-8")
    return "# Workbench Notes Log\n*No notes recorded yet.*\n"

# -----------------------------------------------------------------------------
# REST API: Projects & BOM Management (Objective 8)
# -----------------------------------------------------------------------------
@app.get("/api/projects", response_model=List[Dict[str, Any]])
def get_projects(q: Optional[str] = None, status: Optional[str] = None):
    with get_db() as conn:
        query = "SELECT * FROM projects WHERE 1=1"
        params = []
        if q:
            query += " AND (name LIKE ? OR description LIKE ? OR target_hardware LIKE ? OR notes LIKE ?)"
            wildcard = f"%{q}%"
            params.extend([wildcard, wildcard, wildcard, wildcard])
        if status and status != "All":
            query += " AND status = ?"
            params.append(status)
        query += " ORDER BY updated_at DESC"
        rows = conn.execute(query, params).fetchall()
        return [dict(r) for r in rows]

@app.get("/api/projects/{project_id}")
def get_project_by_id(project_id: int):
    with get_db() as conn:
        row = conn.execute("SELECT * FROM projects WHERE id = ?", (project_id,)).fetchone()
        if not row:
            raise HTTPException(status_code=404, detail="Project not found")
        return dict(row)

@app.post("/api/projects")
def create_project(item: ProjectItem):
    with get_db() as conn:
        cur = conn.execute(
            """INSERT INTO projects (name, description, status, target_hardware, bom_json, notes)
               VALUES (?, ?, ?, ?, ?, ?)""",
            (item.name.strip(), item.description, item.status, item.target_hardware, item.bom_json, item.notes)
        )
        conn.commit()
        return {"status": "created", "id": cur.lastrowid, "name": item.name}

@app.put("/api/projects/{project_id}")
def update_project(project_id: int, item: ProjectItem):
    with get_db() as conn:
        cur = conn.execute(
            """UPDATE projects
               SET name = ?, description = ?, status = ?, target_hardware = ?, bom_json = ?, notes = ?, updated_at = CURRENT_TIMESTAMP
               WHERE id = ?""",
            (item.name.strip(), item.description, item.status, item.target_hardware, item.bom_json, item.notes, project_id)
        )
        conn.commit()
        if cur.rowcount == 0:
            raise HTTPException(status_code=404, detail="Project not found")
        row = conn.execute("SELECT * FROM projects WHERE id = ?", (project_id,)).fetchone()
        return dict(row)

@app.delete("/api/projects/{project_id}")
def delete_project(project_id: int):
    with get_db() as conn:
        conn.execute("DELETE FROM projects WHERE id = ?", (project_id,))
        conn.commit()
        return {"status": "deleted", "id": project_id}

@app.post("/api/projects/{project_id}/bom")
def add_project_bom_item(project_id: int, item: ProjectBOMUpdate):
    with get_db() as conn:
        row = conn.execute("SELECT bom_json FROM projects WHERE id = ?", (project_id,)).fetchone()
        if not row:
            raise HTTPException(status_code=404, detail="Project not found")
        try:
            bom = json.loads(row["bom_json"] or "[]")
        except Exception:
            bom = []

        matched = False
        for b in bom:
            if b.get("component_name", "").lower() == item.component_name.lower():
                b["quantity_needed"] += item.quantity_needed
                matched = True
                break
        if not matched:
            bom.append({
                "component_name": item.component_name,
                "quantity_needed": item.quantity_needed,
                "item_id": item.item_id,
                "notes": item.notes
            })

        new_bom_str = json.dumps(bom)
        conn.execute("UPDATE projects SET bom_json = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?", (new_bom_str, project_id))
        conn.commit()
        return {"status": "success", "bom": bom}

# -----------------------------------------------------------------------------
# REST API: Contextual Suggestions Engine (Objective 4)
# -----------------------------------------------------------------------------
@app.get("/api/ai/suggestions")
def get_ai_suggestions():
    return {"suggestions": generate_contextual_suggestions()}

# -----------------------------------------------------------------------------
# REST API: Conversations & Token Compaction (Objective 5 & Real-world Bug Fix)
# -----------------------------------------------------------------------------
@app.get("/api/chat/history")
def get_chat_history_endpoint(session_id: str = "workbench_default"):
    history = get_conversation_history(session_id=session_id, limit=30)
    summary = get_session_summary(session_id=session_id)
    return {
        "session_id": session_id,
        "summary": summary,
        "history": history,
        "total_messages": len(history)
    }

@app.post("/api/chat/compact")
async def force_chat_compact(session_id: str = Body("workbench_default", embed=True)):
    compacted = await compact_conversation_if_needed(session_id=session_id, threshold=2)
    summary = get_session_summary(session_id=session_id)
    return {"status": "compacted" if compacted else "no_compaction_needed", "summary": summary}

@app.post("/api/chat/clear")
def clear_chat_history(session_id: str = Body("workbench_default", embed=True)):
    with get_db() as conn:
        conn.execute("DELETE FROM conversations WHERE session_id = ?", (session_id,))
        conn.execute("DELETE FROM conversation_summaries WHERE session_id = ?", (session_id,))
        conn.commit()
    return {"status": "cleared", "session_id": session_id}

# -----------------------------------------------------------------------------
# REST API: Dedicated Push-To-Talk (PTT) Web Voice Chatbot (Objective 7)
# -----------------------------------------------------------------------------
@app.post("/api/chat/voice")
async def handle_ptt_voice(
    prompt: Optional[str] = Form(None),
    session_id: Optional[str] = Form("workbench_default"),
    audio: Optional[UploadFile] = File(None)
):
    """Voice ingestion endpoint for in-browser Push-To-Talk with full bench state access."""
    transcript = ""

    # If audio file is provided and Groq Whisper is configured, transcribe
    if audio and GROQ_API_KEY and GROQ_API_KEY != "your_groq_api_key_here":
        try:
            from groq import Groq
            client = Groq(api_key=GROQ_API_KEY)
            audio_bytes = await audio.read()
            res = client.audio.transcriptions.create(
                file=(audio.filename or "recording.webm", audio_bytes),
                model="whisper-large-v3",
                language="en",
                response_format="json"
            )
            transcript = res.text
            print(f"[PTT/Whisper] Transcribed: {transcript}")
        except Exception as e:
            print(f"[PTT/Whisper Error]: {e}")

    if not transcript and prompt:
        transcript = prompt.strip()

    if not transcript:
        raise HTTPException(status_code=400, detail="No speech transcript or audio provided.")

    # Process prompt through intent router with full bench context and conversation continuity
    llm_result = await route_llm_intent(user_prompt=transcript, device_id="default", session_id=session_id or "workbench_default")
    
    return {
        "transcript": transcript,
        "title": llm_result.get("title", "Workbench Voice Response"),
        "response": llm_result.get("content", ""),
        "intent": llm_result.get("intent", "general"),
        "tts_text": llm_result.get("content", "")[:300]
    }

# -----------------------------------------------------------------------------
# REST API: Kiosk Show & History
# -----------------------------------------------------------------------------
@app.post("/api/kiosk/show")
async def show_on_kiosk(payload: KioskPayload):
    res = await display_on_desk(type=payload.type, content=payload.content, title=payload.title)
    return res

@app.get("/api/kiosk/history")
def get_kiosk_history(limit: int = 20):
    with get_db() as conn:
        rows = conn.execute("SELECT * FROM kiosk_history ORDER BY id DESC LIMIT ?", (limit,)).fetchall()
        result = []
        for r in rows:
            try:
                parsed = json.loads(r["display_payload"])
            except Exception:
                parsed = {"content": r["display_payload"]}
            result.append({
                "id": r["id"],
                "timestamp": r["timestamp"],
                "payload": parsed
            })
        return result

@app.get("/api/soldering/current")
def get_soldering_current():
    """Returns the current state for 2.8-inch SPI TFT display clients."""
    return latest_soldering_state

# -----------------------------------------------------------------------------
# REST API: Prompt / Intent Routing Hook
# -----------------------------------------------------------------------------
@app.post("/api/llm/prompt")
async def process_prompt(req: PromptRequest):
    result = await route_llm_intent(req.prompt, session_id=req.session_id or "workbench_default")
    return result

# -----------------------------------------------------------------------------
# REST API: Xiaozhi Broadcast
# -----------------------------------------------------------------------------
@app.post("/api/xiaozhi/broadcast")
async def broadcast_to_xiaozhi(req: XiaozhiBroadcastRequest):
    await xiaozhi_manager.broadcast({
        "type": "tts",
        "state": "start",
        "text": req.text
    })
    return {"status": "success", "clients_count": len(xiaozhi_manager.active_connections), "text": req.text}

# -----------------------------------------------------------------------------
# WebSockets: /ws/kiosk and /ws/xiaozhi
# -----------------------------------------------------------------------------
@app.websocket("/ws/kiosk")
async def ws_kiosk_endpoint(websocket: WebSocket):
    await kiosk_manager.connect(websocket)
    try:
        with get_db() as conn:
            last = conn.execute("SELECT display_payload FROM kiosk_history ORDER BY id DESC LIMIT 1").fetchone()
            if last:
                try:
                    init_payload = json.loads(last["display_payload"])
                    await websocket.send_json(init_payload)
                except Exception:
                    pass
    except Exception as e:
        print(f"[WS/kiosk init send error]: {e}")

    async def ping_loop():
        try:
            while True:
                await asyncio.sleep(20)
                await websocket.send_json({"type": "ping", "timestamp": datetime.now(timezone.utc).isoformat()})
        except asyncio.CancelledError:
            pass
        except Exception:
            pass

    ping_task = asyncio.create_task(ping_loop())
    try:
        while True:
            data = await websocket.receive_text()
            try:
                msg = json.loads(data)
                if msg.get("type") == "pong":
                    continue
                elif msg.get("type") == "request_refresh":
                    with get_db() as conn:
                        last = conn.execute("SELECT display_payload FROM kiosk_history ORDER BY id DESC LIMIT 1").fetchone()
                        if last:
                            await websocket.send_json(json.loads(last["display_payload"]))
            except Exception:
                pass
    except WebSocketDisconnect:
        pass
    except Exception:
        pass
    finally:
        ping_task.cancel()
        await kiosk_manager.disconnect(websocket)

@app.websocket("/ws/xiaozhi")
async def ws_xiaozhi_endpoint(websocket: WebSocket):
    """Audio/command ingress channel for ESP32 and Pi devices with per-device avatar personas."""
    device_id = websocket.query_params.get("device") or websocket.query_params.get("role") or "default"
    await websocket.accept()
    await xiaozhi_manager.connect(websocket)
    persona = get_device_persona(device_id)
    try:
        # Initial greeting handshake with device role
        await websocket.send_json({
            "type": "hello",
            "version": 1,
            "transport": "websocket",
            "device_id": device_id,
            "persona": persona.get("name"),
            "avatar": persona.get("avatar", "default"),
            "audio_params": {"format": "opus", "sample_rate": 16000, "channels": 1, "frame_duration_ms": 60}
        })
        while True:
            try:
                msg = await websocket.receive()
            except RuntimeError:
                break
            if msg.get("type") == "websocket.disconnect":
                break
            if "text" in msg and msg["text"]:
                try:
                    parsed = json.loads(msg["text"])
                    event_type = parsed.get("type", "")
                    if event_type == "hello":
                        if "device_id" in parsed:
                            device_id = parsed["device_id"]
                            persona = get_device_persona(device_id)
                        await websocket.send_json({
                            "type": "hello_ack",
                            "status": "ready",
                            "device_id": device_id,
                            "persona": persona.get("name"),
                            "avatar": persona.get("avatar", "default")
                        })
                    elif event_type == "listen" and "text" in parsed:
                        cmd_text = parsed.get("text", "")
                        print(f"[WS/xiaozhi:{device_id}] Voice transcript: {cmd_text}")
                        res = await route_llm_intent(cmd_text, device_id=device_id, session_id="xiaozhi_voice")
                        await websocket.send_json({
                            "type": "tts",
                            "state": "start",
                            "text": f"{persona.get('name')}: {res.get('title', 'Command executed')}",
                            "voice": persona.get("tts_voice", "alloy"),
                            "avatar": persona.get("avatar", "default")
                        })
                    elif event_type == "ping":
                        await websocket.send_json({"type": "pong"})
                    elif event_type == "abort":
                        print("[WS/xiaozhi] Abort signal received")
                except Exception as e:
                    print(f"[WS/xiaozhi text error]: {e}")
            elif "bytes" in msg and msg["bytes"]:
                pass
    except WebSocketDisconnect:
        pass
    except Exception as e:
        print(f"[WS/xiaozhi error]: {e}")
    finally:
        await xiaozhi_manager.disconnect(websocket)

# -----------------------------------------------------------------------------
# Device Avatar Personas API
# -----------------------------------------------------------------------------
@app.get("/api/personas")
def get_personas():
    """Retrieve all device avatar personas (Pi 4B+, P4 Pico, S3 Handheld)."""
    if PERSONAS_PATH.exists():
        with open(PERSONAS_PATH, "r", encoding="utf-8") as f:
            return json.load(f)
    return {}

@app.post("/api/personas/{device_id}")
async def update_persona(device_id: str, payload: dict = Body(...)):
    """Update or customize the personality and system prompt for a specific device."""
    data = {}
    if PERSONAS_PATH.exists():
        with open(PERSONAS_PATH, "r", encoding="utf-8") as f:
            data = json.load(f)
    data[device_id] = payload
    with open(PERSONAS_PATH, "w", encoding="utf-8") as f:
        json.dump(data, f, indent=2)
    return {"status": "success", "device_id": device_id, "persona": payload}

# -----------------------------------------------------------------------------
# Static Frontend Serving
# -----------------------------------------------------------------------------
STATIC_DIR = BASE_DIR / "static"
if not STATIC_DIR.exists():
    STATIC_DIR.mkdir(parents=True, exist_ok=True)

app.mount("/static", StaticFiles(directory=str(STATIC_DIR)), name="static")

@app.get("/playground")
def serve_playground():
    playground_file = STATIC_DIR / "playground.html"
    if playground_file.exists():
        return FileResponse(str(playground_file))
    return FileResponse(str(STATIC_DIR / "index.html"))

@app.post("/api/copilot")
async def copilot_endpoint(req: PromptRequest):
    """AI Copilot endpoint for the circuit playground and general queries."""
    result = await route_llm_intent(req.prompt, session_id=req.session_id or "playground_circuit")
    return result

@app.get("/")
def serve_index():
    index_file = STATIC_DIR / "index.html"
    if index_file.exists():
        return FileResponse(str(index_file))
    return {"status": "Workbench API online. Static frontend not yet compiled."}

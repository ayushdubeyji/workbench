# 2.8-Inch SPI TFT Soldering Station Display Wiring & Setup Guide

This guide details how to wire, test, and drive a **2.8-inch SPI TFT LCD** (typically **ILI9341** or **ST7789**, 320x240 or 240x320 resolution) for the **Dedicated Soldering Station View**.

---

## 1. Overview & Purpose
- **Role**: Mounted right above your soldering iron, fume extractor, or PCB holder.
- **Display Output**: Clean, ultra-concise, high-contrast operational data:
  - Soldering iron temperatures (e.g. `60/40 Leaded: 300°C–320°C`, `Lead-Free SAC305: 350°C–370°C`)
  - Target pin numbers (e.g. `Pin 6, 9, 14, 20, 25, 30, 34, 39: GND`)
  - Polarity and orientation warnings (Diodes, IC notch, electrolytic capacitors)
  - Quick step-by-step soldering bullets without distracting conversational filler
- **Companion**: The **Main Kiosk** (Pi 4B+ HDMI or 10" display) receives the complete, joyful, deep-dive Richard Feynman explanation and full schematics simultaneously.

---

## 2. Raspberry Pi 4B+ GPIO (40-Pin Header) SPI Wiring

Standard 2.8" SPI TFT modules have 8 to 14 pins. The table below lists the exact pin mapping to the Raspberry Pi 40-pin header:

| TFT Display Pin | Pin Name | Raspberry Pi Physical Pin | Raspberry Pi GPIO / Function | Notes |
|:---|:---|:---|:---|:---|
| **VCC** | Power | **Pin 1** (or Pin 2) | **3.3V** (or 5V if module has 3.3V LDO) | Check if your module has an onboard regulator (e.g. AMS1117). |
| **GND** | Ground | **Pin 6** (or 9, 14, 20, 25, 30, 34, 39) | **GND** | Connect to any physical ground pin. |
| **CS / SS** | Chip Select | **Pin 24** | **GPIO 8** (SPI0 CE0) | Active LOW. |
| **RESET / RST** | Reset | **Pin 18** | **GPIO 24** | Hardware reset line. |
| **DC / RS** | Data / Command | **Pin 22** | **GPIO 25** | LOW = Command, HIGH = Data. |
| **SDI / MOSI** | Master Out Slave In | **Pin 19** | **GPIO 10** (SPI0 MOSI) | Carries pixel and configuration data. |
| **SCK / SCLK** | SPI Clock | **Pin 23** | **GPIO 11** (SPI0 SCLK) | Hardware SPI clock line. |
| **LED / BL** | Backlight | **Pin 17** (or Pin 12) | **3.3V** (or GPIO 18 for PWM dimming) | Tie to 3.3V for 100% brightness or GPIO 18 for software dimming. |
| **SDO / MISO** | Master In Slave Out | **Pin 21** | **GPIO 9** (SPI0 MISO) | Optional for display; required if using resistive touch (XPT2046). |

### Visual Pinout Map on Pi 4 Header (Top View):
```text
           3.3V PWR  [01] [02]  5V PWR
          (SDA) GP2  [03] [04]  5V PWR
          (SCL) GP3  [05] [06]  GND <------------------ TFT GND
                GP4  [07] [08]  GP14 (UART TX)
                GND  [09] [10]  GP15 (UART RX)
               GP17  [11] [12]  GP18 (PWM / Backlight Option)
               GP27  [13] [14]  GND
               GP22  [15] [16]  GP23
       TFT VCC 3.3V  [17] [18]  GP24 <------------------ TFT RESET (RST)
      TFT MOSI GP10  [19] [20]  GND
      TFT MISO GP9   [21] [22]  GP25 <------------------ TFT DATA/CMD (DC)
      TFT SCLK GP11  [23] [24]  GP8 (SPI0 CE0) <-------- TFT CHIP SELECT (CS)
                GND  [25] [26]  GP7 (SPI0 CE1)
```

---

## 3. Waveshare ESP32-P4 / ESP32-S3 Wiring Option

If driving the 2.8" SPI display directly from an **ESP32-P4** or **ESP32-S3** microcontroller over Wi-Fi:

| TFT Pin | ESP32-S3 GPIO | ESP32-P4 GPIO | Description |
|:---|:---|:---|:---|
| **VCC** | 3.3V | 3.3V | Logic Power |
| **GND** | GND | GND | Common Ground |
| **CS** | GPIO 10 | GPIO 20 | SPI Chip Select |
| **DC** | GPIO 9 | GPIO 21 | Data/Command |
| **RST** | GPIO 14 | GPIO 22 | Hardware Reset |
| **MOSI**| GPIO 11 | GPIO 23 | Master Out Slave In |
| **SCLK**| GPIO 12 | GPIO 24 | SPI Clock |
| **BL**  | GPIO 13 | GPIO 25 | Backlight PWM |

The ESP32 firmware connects via WebSocket to `ws://192.168.0.110:8000/ws/kiosk` (or via Cloudflare `wss://workbench.ayushdubey.tech/ws/kiosk`), receives the JSON payload, and renders `payload.soldering_content` in high-contrast 320x240 bitmaps.

---

## 4. Raspberry Pi Software Driver Script (`soldering_tft_daemon.py`)

A lightweight Python client can run on the Raspberry Pi to receive the live WebSocket events and draw them onto the 2.8" TFT via `luma.lcd` or `ST7789` / `ILI9341` Python drivers:

```bash
# Install SPI and display libraries on Raspberry Pi:
sudo apt-get install -y python3-pil python3-spidev
pip install luma.lcd websockets requests
```

Daemon script example (`soldering_tft_daemon.py`):
```python
import asyncio
import json
import websockets
from PIL import Image, ImageDraw, ImageFont

# Initialize ST7789 or ILI9341 device via luma.lcd:
# from luma.core.interface.serial import spi
# from luma.lcd.device import ili9341
# serial = spi(port=0, device=0, gpio_DC=25, gpio_RST=24)
# device = ili9341(serial, width=320, height=240)

HUB_WS_URL = "ws://127.0.0.1:8000/ws/kiosk"

async def listen_soldering_events():
    while True:
        try:
            async with websockets.connect(HUB_WS_URL) as ws:
                print("Connected to Workbench Hub for Soldering Screen updates.")
                while True:
                    msg = await ws.recv()
                    data = json.loads(msg)
                    soldering_text = data.get("soldering_content") or data.get("content", "")
                    title = data.get("title", "Soldering Station")
                    print(f"[{title}] New soldering prompt received!")
                    # Draw high-contrast text on 320x240 framebuffer
        except Exception as e:
            print(f"Connection lost, retrying in 3s: {e}")
            await asyncio.sleep(3)

if __name__ == "__main__":
    asyncio.run(listen_soldering_events())
```

---

## 5. Web Dashboard Live Mirror
The web dashboard at `https://workbench.ayushdubey.tech` features a **live software mirror** of this 2.8" screen directly on the top-left of the workbench interface. As you talk or type to the Feynman copilot, the 2.8" mirror updates in real-time alongside the main kiosk view.

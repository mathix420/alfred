# companion — scope

> Alfred's pocket companion: a battery-powered, push-to-talk hardware surface
> running on a Waveshare **ESP32-S3-Touch-AMOLED-1.8**. The device is a thin
> client; all assistant behaviour lives in `@alfred/core`.

## 1. What it is

An ambient-first, voice-capable pocket device. Its resting state is a
glanceable face (clock, next reminder, status). Holding a button lets you talk
to Alfred — to **ask** (answered aloud), **capture** a thought (filed into the
memory graph), or issue a **command** (e.g. set a reminder). It looks like a
Victorian gentleman's study with a cyberpunk holographic interface.

## 2. Hardware (confirmed)

|         |                                                               |
| ------- | ------------------------------------------------------------- |
| MCU     | ESP32-S3R8 — dual-core LX7 @240MHz, 16MB flash, **8MB PSRAM** |
| Radio   | WiFi 2.4GHz (b/g/n) + BLE 5                                   |
| Display | 1.8" AMOLED, 368×448, QSPI. **V1: SH8601 / V2: CO5300**       |
| Touch   | **V1: FT3168 / V2: CST816** (I2C)                             |
| Audio   | ES8311 codec + onboard mic **and** speaker (I2S)              |
| IMU     | QMI8658 (6-axis)                                              |
| RTC     | PCF85063 (battery-backed)                                     |
| Power   | AXP2101 PMIC, MX1.25 Li-battery connector                     |
| Storage | TF (microSD) card slot                                        |
| I/O     | USB-C, PWR + BOOT buttons, 7 GPIO, 1× I2C, 1× UART            |

> ⚠️ **Identify the board revision** before firmware work — V1 and V2 differ in
> the display and touch drivers.

## 3. Architecture

The ESP32 cannot run `@alfred/core` or an LLM, so `companion` is two halves.
This maps onto the monorepo rule: _surfaces are thin I/O; behaviour lives in
core._

```
device (firmware)  ──WebSocket/WiFi──►  apps/companion (bridge)  ──►  @alfred/core
   presentation                          I/O + transport               the brain
                                          @alfred/core/memory           the memory
```

### `apps/companion/` — the bridge (Bun workspace `@alfred/companion`)

- Bun WebSocket server; device pairing/registry; session state.
- Audio in: receive one utterance per PTT press → **Whisper** STT (local).
- Runs the `Assistant` from core, with memory tools (capture / `recall()`)
  wired in. The **Alfred persona** (formal butler, dry wit) lives here as the
  system prompt + TTS voice.
- TTS (**Piper**, local — see open questions) → stream audio back.
- Pushes semantic state to the device: `state`, `transcript`, `reminders`,
  `battery`, ambient-face data. It never ships pixels — the look is 100%
  firmware + assets.
- Standard workspace setup: `"name": "@alfred/companion"`, `tsconfig.json`
  extending `../../tsconfig.base.json`, depends on `@alfred/core`. Defines
  `dev`/`build` so the root fan-out reaches it.

### `apps/companion/firmware/` — the device (PlatformIO + ESP-IDF)

Not a Bun workspace (no `package.json`, so workspace globs ignore it).

- `platformio.ini` with `framework = espidf`; LVGL for UI.
- Drivers: AMOLED (SH8601/CO5300), touch (FT3168/CST816), ES8311 audio,
  QMI8658, PCF85063, AXP2101.
- Audio: I2S record-on-PTT + playback; Opus encode optional to save bandwidth.
- Connectivity: WiFi, WebSocket client, reconnect, **offline capture queue on
  the TF card** → sync on reconnect.
- Power: light/deep sleep, wake on PWR button / touch / IMU raise; battery
  gauge from AXP2101.
- BLE used only for first-run WiFi provisioning + pairing.

## 4. Locked decisions

| Decision           | Choice                                                         | Consequence                                                                 |
| ------------------ | -------------------------------------------------------------- | --------------------------------------------------------------------------- |
| Primary emphasis   | **Ambient companion**, with capture + conversation layered in  | Home = glanceable face; voice is initiated, not the home state              |
| Interaction        | **Push-to-talk only — never a wake word**                      | No ESP-SR; mic live only while held; aggressive sleep; clean privacy story  |
| STT                | **Local Whisper** (whisper.cpp / faster-whisper) in the bridge | One utterance per press; no streaming-STT complexity                        |
| TTS                | **Piper** (local), Kokoro as alternative — _to confirm_        | Runs next to whisper on the host                                            |
| Firmware framework | **ESP-IDF via PlatformIO** + LVGL                              | Best audio/power control; pull drivers from Waveshare's ESP-IDF demos       |
| Intent routing     | Core's `Assistant` decides ask / capture / command             | No mode-switch on the device                                                |
| Reminders          | RTC-backed on-device                                           | Fire even if the bridge is unreachable; bridge owns the list and syncs down |
| UI fidelity        | **Static cinematic backplate + light foreground animation**    | ~90% of the reference look; smooth + battery-friendly on the S3             |
| Asset pipeline     | **Aseprite → TF card**, loaded via LVGL filesystem             | Update art without reflashing                                               |

## 5. Feature tiers

**Tier 0 — walking skeleton:** BLE WiFi provisioning → pair → PTT → Whisper →
`Assistant` → Piper → playback + on-screen transcript + ambient face + battery.

**Tier 1 — actual companion:** streaming TTS + barge-in; raise/tap-to-wake +
sleep; memory **capture** ("remember…") and **recall** ("what did I say about
X") via the temporal graph; RTC reminders/timers; settings screen.

**Tier 2 — ambient second brain:** always-on clock/status face; push
notifications + daily digest; **offline capture queue on TF card** → sync;
daily journal/summary into the memory graph; step/activity from IMU; OTA.

**Tier 3 — stretch:** custom TTS voice; multi-device handoff; button-macro
shortcuts.

## 6. UI / visual direction

**Aesthetic:** Victorian gentleman's study × cyberpunk hologram. Dark
wood-panelled chrome, a refined Edwardian butler, neon holographic panels, a
**raven crest** motif (Alfred + memory-keeper), warm lantern glow, pixel art.

**Metaphor — chrome is the study, content is the hologram.** The physical world
(wood panels, frame, raven crest, lantern) is a _baked, full-fidelity static
backplate_. Live data (cyan holographic panels, terminal-style text) is the only
animated layer. AMOLED true black renders the dark study for free — the
on-brand look is also the most power-efficient.

**Palette (AMOLED-tuned):**

- Background `#000000` · chrome wood-brown `#2A211A` / dark-green `#16221C`
- Hologram cyan `#3FE0FF` · magenta/violet `#C84BFF`
- Lantern amber `#FFB454` (alerts/reminders) · text `#DCEFF5`

**State machine (Alfred sprite):**
| State | Scene |
|---|---|
| Ambient/idle | Dim study; large holographic clock; raven crest faint behind; lantern flicker. Only colon blink + glow pulse animate. |
| Listening (PTT) | Alfred leans toward a brightening cyan panel; reactive mic waveform; magenta ring pulses. |
| Thinking | Scanline shimmer; Alfred strokes moustache; a small raven circles as the spinner. |
| Speaking (TTS) | Alfred gestures at the panel; answer streams as cyan monospace terminal text; subtle hand/mouth anim. |
| Capture | Note text collapses into the raven crest; brief amber _"Noted, sir."_ |

**Type & effects:** bitmap/pixel fonts (elegant labels + monospace holographic
terminal text); scanline/flicker as a cheap translucent overlay; glows baked
into sprites, not real-time blur.

**Layout:** portrait 368×448 — top status bar (battery, WiFi, small raven
crest), central holographic content, wood-panel chrome at the edges, lantern
glow in a corner.

**Constraint:** the reference is a static render. On the S3 we target a baked
backplate + selective animation (sprite ~8–12 fps, glow pulse, streaming text).
A live 30 fps full-screen scene is out of scope.

## 7. Open questions / deferred

- **TTS engine:** Piper (recommended) vs Kokoro.
- **Board revision:** confirm V1 vs V2 for the correct display/touch drivers.
- **Audio transport:** raw PCM vs Opus over the WebSocket (bandwidth vs CPU).
- **Pairing/auth:** how the device authenticates to the bridge.
- **Persona prompt + voice:** author the butler system prompt and pick the
  matching TTS voice.

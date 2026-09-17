# companion firmware

Firmware for the Alfred **pocket companion** — a battery-powered, push-to-talk
hardware surface running on a **Waveshare ESP32-S3-Touch-AMOLED-1.8**.

The current firmware uses the [pocket backend](../../pocket/README.md) and protocol 2.
The V1 hardware uses SH8601 display, FT3168 touch, ES8311 audio and AXP2101 power.
It renders the interface locally with LVGL; the backend supplies tasks and assistant replies.

## Interface

- Tap the focus task to complete it. The live bridge acknowledges the saved change
  before the green flower/check animation reveals the next task.
- Swipe up from Focus for Today; swipe down for Memo.
- Scroll within Today or Memo. Tap its title/handle to return, or reverse the
  opening gesture from the header. Content swipes return only when starting at
  the appropriate boundary: Today at the top, Memo at the bottom.
- BOOT: hold to record, release to send. PWR short press: Today/back.
- The on-screen Hold to talk footer appears only on Focus, including All clear.
  Voice screens show their own contextual controls.

## Protocol

A WebSocket carries JSON controls and mono PCM16 audio. The device sends
`hello` with protocol 2, `complete_task`, `refresh`, `ptt_down`, binary 16 kHz
recording chunks, `ptt_up`, and `cancel`. The backend sends `hello`, `focus`,
`task_completed`, `state`, `transcript`, `reply`, `tts_start`, binary speaker
audio, `tts_end`, and `error`.

The implementation lives in `src/net/protocol.c` and `apps/pocket/src/server.ts`.
The pocket wire tests compile the actual C parser against real backend frames.
Matrix credentials are never stored on the device; use its scoped device token
and `wss://` for a remote backend.

## Board revisions — V1 vs V2

Waveshare ships two revisions of this board that differ in **two drivers**:

| Peripheral | V1     | V2     |
| ---------- | ------ | ------ |
| AMOLED     | SH8601 | CO5300 |
| Touch      | FT3168 | CST816 |

Everything else (ES8311 audio codec, QMI8658 IMU, PCF85063 RTC, AXP2101 PMIC,
microSD) is common to both. **Identify your board before flashing.**

Selection is a compile-time switch, `BOARD_VERSION`, defined in
`platformio.ini` via a build flag:

```ini
; -- in the [env] you build --
build_flags =
  -D BOARD_VERSION=1   ; SH8601 + FT3168
; build_flags =
;   -D BOARD_VERSION=2   ; CO5300 + CST816
```

The display and touch drivers `#if BOARD_VERSION == 1 / == 2` on this macro and
pull in the matching chip driver; no other code is version-aware. Pick the
right value and the correct drivers compile in. There is no runtime probe —
flashing a V2 image to a V1 board (or vice versa) yields a blank panel or a dead
touch layer.

## Prerequisites

Install on the _workstation_ that drives the board (not needed in this repo's
container):

- **[PlatformIO](https://platformio.org/)** — `pip install platformio`, or the
  PlatformIO IDE / VS Code extension. PlatformIO downloads the ESP-IDF
  toolchain and the Xtensa cross-compiler for you on first build.
- A **USB-C** cable and the board. The ESP32-S3 enumerates as a serial port
  over USB; on Linux make sure your user is in the `dialout` group.
- ESP-IDF version is pinned by the `platform = espressif32` version in
  `platformio.ini`; let PlatformIO manage it rather than installing IDF
  globally.

## Build & flash

All commands run from this `firmware/` directory.

```sh
pio run                      # compile (default env)
pio run -t upload            # compile + flash over USB-C
pio device monitor           # open the serial console (esp_log output)
pio run -t upload -t monitor # flash then immediately monitor
pio run -t clean             # wipe build artifacts
```

If `pio` can't find the board, list ports with `pio device list` and pass it
explicitly: `pio run -t upload --upload-port /dev/ttyACM0`. To force the chip
into the ROM bootloader, hold **BOOT**, tap **RST/PWR**, release **BOOT**.

The serial monitor runs at **115200** baud (set by `monitor_speed` in
`platformio.ini`). Logs use ESP-IDF's `esp_log`; raise verbosity with the
`CONFIG_LOG_DEFAULT_LEVEL` sdkconfig option or a per-tag
`esp_log_level_set(TAG, ESP_LOG_DEBUG)`.

## Configuration — WiFi & bridge URL

Credentials are **not** compiled in. The device is provisioned at first run and
the settings persist in **NVS** (non-volatile storage), so they survive reboots
and OTA but not a full flash erase.

1. **First-run provisioning over BLE.** With no stored credentials the device
   advertises a BLE GATT service. A companion app (or `nRF Connect` for manual
   bring-up) writes the WiFi SSID/passphrase and the **bridge WebSocket URL**
   (e.g. `ws://192.168.1.10:9191` or `wss://…`), plus the `deviceId` used in the
   `hello` frame. BLE is used **only** for provisioning and pairing — it is not
   a data path.
2. The values are committed to the `alfred` NVS namespace and the device
   reboots into normal operation: connect WiFi → open the WebSocket → send
   `hello{deviceId, protocol, firmware}` → await `welcome`.
3. **Re-provisioning.** Hold **BOOT** during power-on (or trigger the settings
   screen, Tier 1) to clear the WiFi/bridge keys from NVS and re-advertise.

> For bench bring-up before BLE provisioning exists you may temporarily seed NVS
> from build flags — see the `// TODO(hw):` markers in the provisioning module.
> Never commit real credentials.

NVS keys (namespace `alfred`):

| Key          | Meaning                                   |
| ------------ | ----------------------------------------- |
| `wifi_ssid`  | WiFi SSID                                 |
| `wifi_pass`  | WiFi passphrase                           |
| `bridge_url` | bridge WebSocket URL (`ws://` / `wss://`) |
| `device_id`  | stable device identifier sent in `hello`  |

## Assets (microSD)

The UI is a **baked static backplate + light foreground animation**. The art is
**not** compiled into the firmware and **not** committed to this repo — it lives
on the **microSD card** and is loaded at runtime via LVGL's filesystem driver.
The on-card layout, file list, palette and authoring pipeline are documented in
**[`assets/README.md`](assets/README.md)**. Provision a card per that doc before
expecting anything but a black screen.

## Layout

```
firmware/
  platformio.ini      # build config, board, BOARD_VERSION flag (owned elsewhere)
  src/                # ESP-IDF C sources: drivers, WS client, LVGL UI, audio (owned elsewhere)
  assets/             # microSD asset spec + pipeline (see assets/README.md)
  README.md           # this file
```

## See also

- [`../SCOPE.md`](../SCOPE.md) — product scope, hardware table, locked decisions,
  full visual direction.
- [`../src/protocol.ts`](../src/protocol.ts) — the canonical wire protocol the C
  side mirrors.
- [`assets/README.md`](assets/README.md) — the microSD asset pipeline.

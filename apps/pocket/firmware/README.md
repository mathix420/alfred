# Pocket firmware

Native LVGL app for the **Waveshare ESP32-S3-Touch-AMOLED-1.8**, with a
368 × 448 AMOLED touchscreen and two physical buttons. Tasks come from the
[pocket backend](../README.md); recorded voice messages go to Hermes through
Matrix. The device does not transcribe, display replies, or play spoken replies.

## Interface

- Tap the focus task to complete it. The backend acknowledges the saved change
  before the flower/check animation reveals the next task. Completed task
  flowers keep their category color in Focus and Today.
- Swipe up from Focus for Today; swipe down for Memo.
- Scroll within Today or Memo. Tap its title/handle to return, or reverse the
  opening gesture from the header. Content swipes return only when starting at
  the appropriate boundary: Today at the top, Memo at the bottom.
- Hold **BOOT** or the Focus screen's **Hold to talk** footer to record; release
  to send. Recording is limited to 30 seconds.
- **Sending** remains visible while delivery is pending. After Matrix acknowledges
  the message, a green checked flower and **Sent!** appear for one second before
  returning to Focus. A failed send does not show the success confirmation.
- **PWR** short press opens Today from Focus and returns from other pages.

The task, flower, fonts, and animations render locally. No microSD artwork is
required. Without configuration, the device shows a clearly labeled local demo.

## Build and flash

Install [PlatformIO](https://platformio.org/) on the workstation connected to the
device. From this directory:

```sh
pio run -e companion_v1
pio run -e companion_v1 -t upload --upload-port /dev/ttyACM0
```

`companion_v1` is the default and matches the tested V1 board: SH8601 display,
FT3168 touch, ES8311 microphone codec, and AXP2101 power management. The
`companion` environment selects the V2 CO5300/CST816 drivers; use the environment
matching your physical hardware. Logs use 115200 baud.

## Wi-Fi and backend configuration

The firmware first reads existing settings from the `alfred` NVS namespace.
When those settings are incomplete, it reads `setup/setup.txt` from a FAT microSD
card. Add these literal `KEY=value` lines, with your actual values, to the card:

```text
SSID=your-network
PASSWORD=your-network-password
WS_URI=wss://pocket.example.com/ws
DEVICE_ID=alfred-pocket
DEVICE_TOKEN=the-same-value-as-ALFRED_DEVICE_TOKEN
TIMEZONE=CET-1CEST,M3.5.0,M10.5.0/3
```

`TIMEZONE` is an optional POSIX timezone string. If `DEVICE_ID` is omitted, the
firmware derives a stable identifier from the device MAC. The token authenticates
the WebSocket upgrade. Matrix credentials stay on the server.

The SD settings are read at boot and are not written back to NVS. Existing NVS
settings take precedence. BLE provisioning is not implemented.

| NVS key        | Meaning                               |
| -------------- | ------------------------------------- |
| `wifi_ssid`    | Wi-Fi SSID                            |
| `wifi_pass`    | Wi-Fi password                        |
| `ws_uri`       | Backend WebSocket URL including `/ws` |
| `device_id`    | Stable device identifier              |
| `device_token` | Shared backend device token           |
| `timezone`     | Optional POSIX timezone string        |

## Protocol and source

Protocol 2 uses WebSocket JSON controls and outbound 16 kHz mono PCM16 audio.
The device sends `hello`, `complete_task`, `refresh`, `ptt_down`, binary recording
chunks, `ptt_up`, and `cancel`. The backend supplies `hello`, `focus`,
`task_completed`, `state`, and `error` messages. The voice sequence is
`listening` → `thinking` (displayed as Sending) → `sent` → `idle`.

The C decoder retains legacy message definitions for compatibility, but the app
has no transcript, reply, or TTS callbacks. Optional backend `voice_job` updates
are ignored by the device.

- [`src/ui/ui.c`](src/ui/ui.c): screens, gestures, and animation.
- [`src/net/protocol.c`](src/net/protocol.c): protocol decoder.
- [`src/main.c`](src/main.c): configuration, microphone capture, and app events.
- [`../src/server.ts`](../src/server.ts): backend wire contract.

Backend wire tests compile the actual C parser against server-generated frames.

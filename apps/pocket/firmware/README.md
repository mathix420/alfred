# Pocket firmware

Native LVGL app for the **Waveshare ESP32-S3-Touch-AMOLED-1.8**, with a
368 × 448 AMOLED touchscreen and two physical buttons. Tasks come from the
[pocket backend](../README.md); recorded voice messages go to Hermes through
Matrix. The device does not transcribe, display replies, or play spoken replies.

## Interface

- Task groups use your TodoMate list names, colors, and order. Today hides lists
  without displayed tasks. Completed flowers keep their list's color.
- Tap the focus task to complete it. The backend acknowledges the saved change
  before the flower/check animation reveals the next task. Completed task
  flowers keep their category color in Focus and Today.
- Swipe up from Focus for Today; swipe down for Memo.
- Select an unfinished task in Today to keep it in Focus until completed,
  replaced by another selection, or removed from TodoMate. The task ID is saved
  on the device, so refreshes, list reordering, reconnects, and restarts keep
  your choice. A failed completion keeps the selected task ready to retry.
- Select a completed task in Today to inspect its checked flower in Focus.
  Tap it to reopen the task; it becomes unchecked after the backend confirms,
  and remains your selected focus.
- Swipe left from the right edge of Focus to open the translucent timer dock;
  swipe right to close it. Start/resume, Pause, and Stop control TodoMate's timer.
  Elapsed time appears beside the flower while the timer is enabled. **Stop
  saves elapsed time and completes the task.** Completing with the flower also
  saves a running or paused timer. Reopen a checked task before starting again.
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
required. Production firmware starts with a setup or connection screen and only
displays tasks received from the backend. It never substitutes sample tasks when
configuration is missing or the connection fails. Real tasks already received
remain visible during a reconnect, with completion disabled while offline.

## Build and flash

Install [PlatformIO](https://platformio.org/) on the workstation connected to the
device. From this directory:

```sh
pio run -e companion_v1
pio run -e companion_v1 -t upload --upload-port /dev/ttyACM0
```

`companion_v1` is the default **production** build and matches the tested V1 board: SH8601 display,
FT3168 touch, ES8311 microphone codec, and AXP2101 power management. The
`companion` environment selects the V2 CO5300/CST816 drivers; use the environment
matching your physical hardware. Logs use 115200 baud.

V1 startup resets the FT3168 through TCA9554 expander pin P2 (EXIO2), waits
100 ms after releasing its 20 ms reset pulse, and retries initialization up to
three times. It preserves the display's reset/power pins and other expander
settings. This also reinitializes touch after a warm ESP32 reset; persistent
failures are reported as `touch: reset/probe attempt … failed` in the USB log.

The optional `companion_v1_demo` environment explicitly enables local sample
tasks for development. It is not used by the normal build/flash commands.

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

The primary network stays in `wifi_ssid` / `wifi_pass`. Up to five secondary
profiles can be supplied as paired NVS strings `wifi_ssid_1` / `wifi_pass_1`
through `wifi_ssid_5` / `wifi_pass_5`. Missing slots are skipped; identical
SSID/password pairs are tried once. For SD configuration, the equivalent
optional pairs are `SSID_1` / `PASSWORD_1` through `SSID_5` / `PASSWORD_5`.

At startup the primary is tried first. A failed attempt is retried once on the
same profile, then the device moves through the remaining profiles in order.
Retries are two seconds apart, with a 30-second pause after a complete failed
cycle. Once connected, the device keeps that network; after a connection drops,
it retries that profile before trying others. Backend unavailability alone does
not switch Wi-Fi networks. Changing profiles does not overwrite saved settings.

SSIDs can contain up to 32 bytes. Passwords accept 8–63-byte WPA passphrases or a
64-character hexadecimal PSK. An explicitly empty password selects an open
network. Invalid or incomplete secondary profiles are skipped. This ESP32-S3
supports 2.4 GHz Wi-Fi; a network name does not determine which radio bands its
access point provides. Credentials belong in private provisioning data or the
SD file, never in source code or build flags. Connection logs show profile
numbers and error codes without SSIDs or passwords.

| NVS key                       | Meaning                               |
| ----------------------------- | ------------------------------------- |
| `wifi_ssid`                   | Wi-Fi SSID                            |
| `wifi_pass`                   | Wi-Fi password                        |
| `wifi_ssid_1` … `wifi_ssid_5` | Optional secondary SSIDs, in order    |
| `wifi_pass_1` … `wifi_pass_5` | Corresponding secondary passwords     |
| `ws_uri`                      | Backend WebSocket URL including `/ws` |
| `device_id`                   | Stable device identifier              |
| `device_token`                | Shared backend device token           |
| `timezone`                    | Optional POSIX timezone string        |

## Protocol and source

Protocol 2 uses WebSocket JSON controls and outbound 16 kHz mono PCM16 audio.
The ES8311 microphone uses the left I2S receive slot explicitly. On ESP32-S3,
mono capture with both slots duplicates samples and makes a 16 kHz recording
play at half speed; see [Espressif's I2S validation notes](https://github.com/espressif/arduino-esp32/blob/master/tests/validation/i2s/README.md).
After each recording, the USB log reports captured sample count, capture time,
and PCM duration. For a recording of several seconds, PCM duration should be
close to the time held, with about 16,000 samples per second.

The device sends `hello`, `complete_task`, `reopen_task`, `task_timer`, `refresh`,
`ptt_down`, binary recording chunks, `ptt_up`, and `cancel`. The backend supplies
`welcome`, `focus`, `task_completed`, `task_reopened`, `task_timer_updated`,
`state`, and `error` messages. Mutation acknowledgements match the task, action,
and request ID; timer controls also wait for an authoritative focus snapshot.
The voice sequence is
`listening` → `thinking` (displayed as Sending) → `sent` → `idle`.

The C decoder retains legacy message definitions for compatibility, but the app
has no transcript, reply, or TTS callbacks. Optional backend `voice_job` updates
are ignored by the device.

- [`src/ui/ui.c`](src/ui/ui.c): screens, gestures, and animation.
- [`src/net/protocol.c`](src/net/protocol.c): protocol decoder.
- [`src/main.c`](src/main.c): configuration, microphone capture, and app events.
- [`../src/server.ts`](../src/server.ts): backend wire contract.

Backend wire tests compile the actual C parser against server-generated frames.

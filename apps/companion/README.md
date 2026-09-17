# `@alfred/companion`

Alfred's pocket companion — a battery-powered, push-to-talk voice surface on a
**Waveshare ESP32-S3-Touch-AMOLED-1.8**. See [`SCOPE.md`](./SCOPE.md) for the
full feature scope, hardware, and visual direction.

The device cannot run an LLM, so `companion` is **two halves**:

| Path        | What                                                                                                                               | Built by                                                  |
| ----------- | ---------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------- |
| `src/`      | the **bridge** — a Bun WebSocket server (`@alfred/companion`) that does STT → `@alfred/core` `Assistant` → TTS and optional memory | `bun` (this workspace)                                    |
| `firmware/` | the **device** — an ESP-IDF/PlatformIO + LVGL thin client                                                                          | PlatformIO (separate toolchain; _not_ built by `bun run`) |

```
device (firmware) ──WebSocket/WiFi──► src/ (bridge) ──► @alfred/core (+ /memory)
   presentation                        I/O + transport      the brain / second brain
```

## The bridge (`src/`)

Push-to-talk turn loop, one `Session` per connection:

```
idle ──ptt_down──► listening ──(mic audio, binary frames)──► [ptt_up]
     ──► thinking (Whisper STT → recall → Assistant + tools) ──► speaking (Piper TTS) ──► idle
```

Turns are **superseding and cancellable**: a new `ptt_down` (or a disconnect)
bumps an epoch and aborts the in-flight turn — the signal propagates into
STT/LLM/TTS, so the provider request and Piper subprocess are torn down promptly
(true barge-in). TTS audio is paced against socket backpressure (await-on-drain).

- **`protocol.ts`** — the wire format (control plane = JSON frames, audio plane =
  binary frames). Pure + heavily tested; the firmware mirrors it in C. Bump
  `PROTOCOL_VERSION` on any change and update both sides.
- **`session.ts`** — the turn state machine. All IO is injected, so a full turn
  is unit-tested with fakes. Never throws: failures report and return to idle.
- **`server.ts`** — the Bun WebSocket transport. Dependencies are injectable via
  `ServerOverrides` (used by the integration test).
- **`tools.ts`** — the model's tools: `remember` / `recall` (memory capture +
  GraphRAG) and `set_reminder`. This is how ask/capture/command intent routing
  happens — Alfred decides mid-turn.
- **`reminders.ts`** — per-session `ReminderService`; the bridge owns the list,
  pushes it down, and the device RTC fires it.
- **`stt/`, `tts/`** — local Whisper / Piper adapters; the subprocess call is
  behind an injectable engine so the logic is testable without the binaries.
- **`persona.ts`** — Alfred's butler system prompt (the voice half of the
  character whose visual half is the device sprite).
- **`ports.ts`** — the `SpeechToText` / `TextToSpeech` / `AssistantLike` /
  `MemoryLike` boundaries. Memory is optional: with no Neo4j the bridge runs
  stateless (Tier 0).

### Run it

```sh
bun run --filter '@alfred/companion' dev     # watch mode
# or from the workspace dir:
bun run dev
```

Requires (for a real, non-test run): a Whisper build (`whisper-cli` + a ggml
model), Piper (+ a voice `.onnx`), and an `ANTHROPIC_API_KEY` (or any
`@alfred/core` model). Memory is optional — set `ALFRED_NEO4J_URI` to enable it.
See the `ALFRED_COMPANION_*` / `ALFRED_STT_*` / `ALFRED_TTS_*` keys in the repo
root `.env.example`.

### Test

```sh
bun test apps/companion/        # protocol, config, persona, stt, tts, tools, reminders, session, server
```

The server integration test starts the bridge on an ephemeral port with injected
fakes and drives a full turn over a real WebSocket — no providers or binaries
needed.

## The firmware (`firmware/`)

A scaffolded ESP-IDF skeleton (drivers, LVGL UI, WebSocket client, the C mirror
of `protocol.ts`) with `// TODO(hw):` markers where Waveshare V1/V2 board
specifics plug in. It is **not** compiled by this repo's `bun run` checks or the
Stop hook. See [`firmware/README.md`](./firmware/README.md) to build and flash.

## Status

**Bridge:** Tier 0 (the walking skeleton) plus much of Tier 1 is implemented —
memory **capture + recall as model tools**, **reminders** (set via voice, synced
down for the RTC to fire), **ambient face** pushed from telemetry, true
**barge-in / disconnect cancellation**, and backpressure pacing. Remaining
`TODO(tier-N)` in code: fact extraction beyond explicit `remember`, reminder
persistence across reconnects, and Opus mic transport.

**Firmware:** scaffolded (drivers, LVGL UI, WebSocket client, C protocol mirror)
with `// TODO(hw):` markers; the new bridge features need no protocol change, so
the existing `reminders`/`ambient`/`tts` wire messages already cover them.

The full tier map lives in [`SCOPE.md`](./SCOPE.md).

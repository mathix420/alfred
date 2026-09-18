# Alfred pocket assistant

A native 368 × 448 touch interface, browser preview and small Bun backend for the
Waveshare ESP32-S3-Touch-AMOLED-1.8 V1. Task data comes directly from the TodoMate
REST API. Voice goes through a dedicated encrypted Matrix session on your account
so recordings appear as you in the existing Beeper conversation with Hermes.
After Matrix confirms delivery, Alfred shows **Sent!** and returns to the task.
It does not transcribe, synthesize speech, wait for a reply or read incoming chat.

```text
ESP32 / browser ── authenticated HTTPS or WSS ── Alfred
                                                 ├─ REST → todomate-mcp → TodoMate
                                                 └─ encrypted Matrix → Beeper chat → Hermes
```

No Hermes API key is needed for this setup. The backend retains Matrix credentials
and encryption keys; the ESP32 only receives its scoped device token.

## Try it locally

```sh
bun install --frozen-lockfile
bun run dev
```

Open http://127.0.0.1:9191. Blank TodoMate and Matrix configuration starts a clearly
labelled demo. Demo task completion persists in `apps/pocket/.data/tasks.json`.
The demo recording animation sends no microphone audio anywhere.

Tap the task to complete it, swipe up for Today, or down for Memo. Memo and Today
scroll. Tap their title or top handle to return. Browser page drags begin outside
the scrollable content so ordinary reading gestures keep native browser momentum.
Hold the side button or Space to talk; Escape cancels the current interaction.
The native device uses BOOT for push-to-talk and PWR short press for Today/back.

## Add Alfred to an existing Docker stack

The published image is `ghcr.io/mathix420/alfred:latest` (AMD64 and ARM64).
For the **Portainer stack editor**, follow the [setup commands](../../deploy/PORTAINER.md).
Add the service and volume from [deploy/compose.stack.yaml](../../deploy/compose.stack.yaml)
to your existing stack and load the generated private environment file.

With Docker Compose CLI, the same file works as an override:

```sh
docker compose -f /path/to/stack.yaml -f deploy/compose.stack.yaml pull alfred todomate-mcp
docker compose -f /path/to/stack.yaml -f deploy/compose.stack.yaml up -d alfred todomate-mcp
```

It adds the Alfred service and persistent `alfred_data` volume. It does not change
the Hermes gateway or require its HTTP API. The TodoMate image must include the
new `/api/tasks` REST routes; older images that only expose `/mcp` will not work.

For a standalone local build, use:

```sh
docker compose -f compose.pocket.yaml up -d --build
```

Both examples bind the published port to localhost by default. Set
`ALFRED_POCKET_BIND` to a LAN/VPN address when connecting a device directly, or put
Alfred behind your existing HTTPS reverse proxy with WebSocket upgrade support.
For a proxy, set `ALFRED_POCKET_PUBLIC_ORIGIN` to the exact public origin, for example
`https://alfred.example.org`. The browser asks for its device token; it is kept in
memory and never put into a URL or embedded in public HTML.

## Environment to prepare

Your stack already has `TODOMATE_MCP_ACCESS_TOKEN`; pass the same value to Alfred.
Only `todomate-mcp` needs Firebase credentials. Only Hermes needs the model and
voice-provider credentials it already uses.

| Variable                        | Value                                                                       |
| ------------------------------- | --------------------------------------------------------------------------- |
| `TODOMATE_MCP_ACCESS_TOKEN`     | Existing TodoMate service access token.                                     |
| `ALFRED_TODOMATE_API_URL`       | `http://todomate-mcp:8000` in this stack; set by the override.              |
| `ALFRED_DEVICE_TOKEN`           | New random secret shared with the device/browser.                           |
| `ALFRED_MATRIX_ENABLED`         | `true` after the remaining Matrix values are ready; default `false`.        |
| `ALFRED_MATRIX_HOMESERVER`      | Your account's HTTPS Matrix homeserver. It need not be Hermes's homeserver. |
| `ALFRED_MATRIX_USER_ID`         | Your Matrix user ID, e.g. `@you:example.org`.                               |
| `ALFRED_MATRIX_ACCESS_TOKEN`    | Token for a new dedicated Matrix session on your account.                   |
| `ALFRED_MATRIX_DEVICE_ID`       | Device ID belonging to that exact token/session.                            |
| `ALFRED_MATRIX_HERMES_USER_ID`  | Hermes's Matrix user ID, a different account from yours.                    |
| `ALFRED_MATRIX_ROOM_ID`         | Existing encrypted room containing you and Hermes.                          |
| `ALFRED_MATRIX_PICKLE_KEY`      | New stable random secret protecting Alfred's crypto store.                  |
| `ALFRED_MATRIX_TRUSTED_DEVICES` | JSON array of independently verified public device fingerprints.            |
| `ALFRED_POCKET_PUBLIC_ORIGIN`   | Exact HTTPS browser origin when using a reverse proxy.                      |
| `ALFRED_POCKET_BIND`            | Optional host LAN/VPN address; localhost is the Compose default.            |

Generate the device token and pickle key independently, for example with
`openssl rand -hex 32`. Retain the pickle key with the crypto-store backup. Do not
reuse Hermes's own access token: that would send the recording as the bot.

The committed [.env.example](../../.env.example) contains blank credentials. Do not
commit filled configuration, recordings or encryption stores.

## Provision a Matrix session

The stdlib-only setup helper keeps passwords and tokens out of terminal output.
First discover which login methods your homeserver supports:

```sh
python3 apps/pocket/matrix/provision.py flows --homeserver https://your-homeserver.example
```

If it advertises password login, create a dedicated Alfred device:

```sh
python3 apps/pocket/matrix/provision.py password-login \
  --homeserver https://your-homeserver.example \
  --user '@you:example.org' --hermes-user '@hermes:example.org' \
  --room '!your-room:example.org' --output /private/path/alfred-matrix.env
```

The password is entered through a hidden prompt. The new session is saved with
mode `0600` before subsequent setup requests. Existing output files are never
overwritten. The helper asks you to compare each device fingerprint with a trusted
source before including it. It generates a device token and pickle key unless
already supplied in the environment. Merge those values into your deployment's
environment, retaining any existing device token or crypto-store key.

For SSO/OAuth-only providers, create a dedicated session using the provider's
supported flow, then inspect it with a hidden access-token prompt:

```sh
python3 apps/pocket/matrix/provision.py inspect \
  --homeserver https://your-homeserver.example \
  --hermes-user '@hermes:example.org' --room '!your-room:example.org' \
  --output /private/path/alfred-matrix.env
```

The helper does not automate Beeper login, send messages, join rooms, or upload
crypto keys. It leaves Matrix disabled until the room, secrets and a verified
Hermes device are supplied. Alfred's own public fingerprint becomes available in
its authenticated `/api/status` response when the worker starts, for reciprocal
verification with your existing clients.

## Matrix encryption and device trust

Use a newly provisioned Matrix device/session. Copying an existing Beeper device's
access token without its matching encryption store is unsupported: Alfred refuses
to overwrite a device's existing public encryption identity. The homeserver must
allow provisioning a session for your account; a Beeper desktop API token is not
necessarily a Matrix access token.

`ALFRED_MATRIX_TRUSTED_DEVICES` has this shape:

```json
[
  {
    "userId": "@hermes:example.org",
    "deviceId": "HERMES_DEVICE",
    "ed25519": "VERIFIED_BASE64_KEY"
  },
  {
    "userId": "@you:example.org",
    "deviceId": "YOUR_BEEPER_DEVICE",
    "ed25519": "VERIFIED_BASE64_KEY"
  }
]
```

Replace the example fingerprints with verified Ed25519 public keys (43 base64
characters, without spaces). Include Hermes's active device and each of your
clients that should decrypt the recording. Unlisted devices receive no attachment
or message encryption keys; their clients may show an undecryptable message until
trust and session sharing are configured. Discovering a key from a server does not
verify it: compare it through an existing trusted client or the device owner.

If Hermes receives a recording but Beeper shows **Encrypted message**, check
whether the trust list contains only Hermes. Add the verified device entries for
your Beeper phone and desktop, then update/restart Alfred with that environment.
Alfred's own sender device is not a recipient to add. The next recording uses a
new encryption session shared with the newly trusted clients. Existing recordings
may need a key request from Beeper; changing the list does not guarantee recovery
of old messages. Keep the current Matrix token, device ID, pickle key and volume.

The attachment is WAV containing 16 kHz mono PCM16, with Matrix `m.audio` and
voice-message metadata. An encrypted-message placeholder occurs before audio
playback; adding a codec conversion does not resolve missing message keys.

Keep one Alfred replica for each Matrix crypto identity. Back up the entire
`alfred_data` volume, including the Matrix store and voice job journals, along with
the pickle key. For your Duplicacy service, add:

```yaml
- alfred_data:/backup/alfred_data:ro
```

Hermes must already be connected to the room with encryption enabled and permit
your user/room. Alfred sends a structured mention so Hermes's mention requirement
can remain enabled. The Python client uses persistent encryption state and manual
fingerprint trust; it does not provide Matrix cross-signing or key-backup recovery.
See [Hermes Matrix setup](https://hermes-agent.nousresearch.com/docs/user-guide/messaging/matrix).

## Task sync

Alfred polls `GET /api/tasks?include_unscheduled=true` and completes exactly the
upstream task through `POST /api/tasks/{id}/complete` with `{ "completed": true }`.
TodoMate's server timezone determines today. Set `TZ=Europe/Paris` on both services.
Memos and native reminder timestamps come from TodoMate; a date without a reminder
does not become an invented deadline. Pending tasks with the earliest reminder
come first, followed by TodoMate order. Up to 16 tasks fit the device snapshot.
Long titles and memos are shortened at UTF-8 boundaries for the display buffers.
Task IDs stay stable across restarts, including hashed IDs for unusually long keys.

The task service acknowledges the upstream write before the completion animation.
A task reopened in TodoMate appears again on the next sync. A failed sync retains
the last snapshot and marks the connection offline.

## Voice upload API

The ESP32 streams 16 kHz mono PCM16 over its authenticated `/ws` connection. The
backend places the completed recording into the same durable queue used by HTTP:

```http
POST /device/voice
Authorization: Bearer <ALFRED_DEVICE_TOKEN>
X-Device-Id: pocket-1
Idempotency-Key: <unique-recording-id>
Content-Type: audio/wav

<16 kHz mono PCM16 WAV bytes>
```

The response is `202` with `{job,statusUrl}`. Poll that status URL with the same
Bearer token and `X-Device-Id`, or listen for `voice_job` updates on `/ws` after
`hello` with the matching device ID. A repeated key with identical recording bytes
returns the existing job; changed bytes return `409`. Recordings are limited to
30 seconds. IDs use 1–63 ASCII letters/digits, `_`, `-`, `.`, or `:` and begin with
a letter/digit.

The backend encrypts the media attachment and sends an encrypted `m.audio` voice
event into the configured room. Alfred confirms the Matrix send and returns to
Focus; the conversation continues in Beeper. There is no speech processing or
incoming-reply forwarding in this server.

Cancelling on the device stops recording or waiting for delivery. A recording
already queued still sends to Matrix; an existing message stays in Beeper. Matrix credentials are still required to
verify the complete live route; local tests use isolated fake transports and never
send a message to an external account.

## Build and checks

```sh
bun run typecheck           # native TypeScript 7, --checkers 4
bun test
bun run lint
bun run build
bun run firmware:build     # PlatformIO ESP-IDF / LVGL, V1 board
```

[GitHub Actions](../../.github/workflows/docker.yml) tests the source and actual C
wire parser, builds the image, checks its browser assets/WebSocket/persistence,
and publishes GHCR images on the default branch and `v*` tags. Pull requests only
build and test. The runtime runs as UID 1000 and stores mutable data under `/data`.

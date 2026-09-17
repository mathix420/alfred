# Alfred

Alfred contains the ESP32 pocket app and its Bun server.

- `apps/pocket/web`: browser preview, 368 × 448 touch UI.
- `apps/pocket/firmware`: ESP-IDF/LVGL firmware for Waveshare ESP32-S3-Touch-AMOLED-1.8 V1.
- `apps/pocket/src`: authenticated task API and device WebSocket; direct TodoMate REST task sync.
- `apps/pocket/matrix`: encrypted outgoing Matrix voice uploads and setup helpers.
- `deploy`: Docker/Portainer configuration and public-settings inspector.

Voice is one-way: capture PCM16, encrypt and upload to the existing Matrix room, acknowledge Sent!, return to Focus. No STT, TTS, model calls, incoming chat processing or assistant replies belong in this server. Tasks are read and completed directly through TodoMate, not Hermes.

Use `bunx` rather than `npx`. Typecheck with `tsc7` or `tsc` and always pass `--checkers 4` (the workspace script uses `scripts/tsc7`).

Checks: `bun run typecheck`, `bun test`, `bun run lint`, `bun run format:check`, `bun run build`. Build firmware with `bun run firmware:build`. Keep credentials, audio recordings, Matrix stores and private deployment files out of Git and image build contexts. Never modify design.pen directly; use Pencil MCP.

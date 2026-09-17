# Alfred

A pocket assistant for the Waveshare **ESP32-S3-Touch-AMOLED-1.8**: a clean
368 × 448 task display with touch completion, scrolling memos and push-to-talk
to a cloud-hosted Hermes agent.

The [pocket app](apps/pocket/README.md) includes a browser preview, Bun backend,
a persistent encrypted Matrix voice bridge, and [native firmware](apps/companion/firmware/README.md).
Cloud credentials stay on the backend. With no credentials, it runs an interactive demo.

| Focus                                                                                      | Today                                                                                        | Memo                                                                           | Voice                                                                            |
| ------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------ | -------------------------------------------------------------------------------- |
| <img src="docs/screenshots/focus.png" width="184" alt="Focus task with flower checkbox" /> | <img src="docs/screenshots/today.png" width="184" alt="Today’s tasks grouped by category" /> | <img src="docs/screenshots/memo.png" width="184" alt="Scrollable task memo" /> | <img src="docs/screenshots/voice.png" width="184" alt="Push-to-talk waveform" /> |

Actual app preview at the device’s 368 × 448 layout, using demo data.

```sh
bun install --frozen-lockfile
bun run dev                 # http://127.0.0.1:9191
bun run firmware:build      # PlatformIO, board V1
bun run firmware:flash      # connected ESP32
```

The Docker workflow tests changes and publishes `ghcr.io/mathix420/alfred` from
the default branch and version tags. See [deployment and Matrix setup](apps/pocket/README.md).
Local `.env` files, recordings, crypto stores and design references are excluded from Git.

The workspace also contains the original provider-agnostic assistant engine and memory layer:

The assistant engine lives in [`packages/core`](./packages/core) and is
provider-agnostic: models are addressed as `"<provider>/<model>"` and resolved
to the right backend (Anthropic, Mistral, or a local OpenAI-compatible server)
at runtime. User-facing surfaces (web, CLI, API, …) live under [`apps/`](./apps)
and consume `@alfred/core`.

Alfred remembers. The
[**memory layer**](./packages/core/src/memory/README.md) is a Neo4j-backed
temporal knowledge graph — a self-hosted "second brain" that stores
conversations, deduplicated entities, and time-scoped facts, and recalls them
with GraphRAG (vector search → graph traversal).

## Quick start

```sh
bun install
cp .env.example .env   # fill in provider keys
bun test
```

To enable memory, also bring up Neo4j (single-user, home-server friendly):

```sh
docker compose up -d   # Neo4j at bolt://localhost:7687, browser at :7474
```

See the [memory README](./packages/core/src/memory/README.md) for the data
model, API, and operations, and [CLAUDE.md](./CLAUDE.md) for overall
architecture and conventions.

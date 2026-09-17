# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

Alfred is a personal AI assistant, structured as a **Bun-workspaces monorepo**.
The assistant logic is provider-agnostic and lives in one shared package; the
ways you talk to Alfred (web, CLI, API, …) are thin surfaces under `apps/` that
consume it. As of now only `packages/core` exists — `apps/` is an empty
skeleton awaiting its first surface.

## Commands

Run from the repo root. Bun executes TypeScript directly — there is no build/
transpile step for `packages/core`; surfaces import it as source.

```sh
bun install              # install all workspaces
bun test                 # run every *.test.ts in the repo (Bun's test runner)
bun test packages/core/test/registry.test.ts   # a single test file
bun test -t "rejects unknown providers"        # a single test by name
bun run typecheck        # tsc --noEmit across all workspaces
bun run lint             # oxlint            (.oxlintrc.json)
bun run lint:fix         # oxlint --fix      (apply autofixes)
bun run format           # oxfmt             (formats in place, .oxfmtrc.json)
bun run format:check     # oxfmt --check     (CI-friendly, writes nothing)
bun run dev              # fan out `dev` to every workspace that defines it
bun run build            # fan out `build` to every workspace that defines it
```

Root scripts that fan out use `bun run --filter '*' <script>`; a workspace only
participates if it defines that script.

## Architecture

**`@alfred/core` (`packages/core`) is the only place that knows about LLM
providers.** Surfaces never import provider SDKs directly — they construct an
`Assistant` and pass messages.

The load-bearing convention is the **model id string `"<provider>/<model>"`**:

- `"anthropic/claude-opus-4-8"`
- `"mistral/mistral-large-latest"`
- `"local/llama3.1:8b"` — any OpenAI-compatible server (Ollama, LM Studio,
  llama.cpp, vLLM); base URL from `ALFRED_LOCAL_BASE_URL`

Flow of a request:

1. `src/models/registry.ts` — `parseModelId()` splits the string and validates
   the provider against `PROVIDERS`. Pure, dependency-free, and the most
   heavily unit-tested piece.
2. `src/models/providers.ts` — `resolveLanguageModel()` switches on the provider
   and **lazily `import()`s** the matching `@ai-sdk/*` package, returning a
   Vercel AI SDK `LanguageModel`. Lazy import means an app only loads (and only
   needs credentials for) the providers it actually calls.
3. `src/assistant.ts` — `Assistant` wraps the resolved model with the AI SDK's
   `generateText` / `streamText`. Switching model or provider is just a
   different `model` string; no app code changes.

**Adding a provider** is a two-line change in `src/models/`: add the name to
`PROVIDERS` (registry.ts) and a `case` to the switch (providers.ts). Nothing
else in the codebase distinguishes providers — keep it that way.

### Memory ("second brain")

`@alfred/core` is also the only place that knows about the **persistence/memory
backend**, behind the same lazy-resolver shape as models. Memory lives in
`src/memory/` (exported as `@alfred/core/memory`):

- A store is addressed by a **`"<backend>/<database>"`** id; embeddings reuse the
  **`"<provider>/<model>"`** grammar. `src/memory/registry.ts` is the pure,
  dependency-free, unit-tested piece (the `parseModelId` analogue).
- `src/memory/providers.ts` — `resolveMemoryStore()` switches on the backend and
  **lazily `import()`s** `src/memory/neo4j.ts`, which is the **only** file that
  names `neo4j-driver`. An app that never uses memory never loads the driver
  (verify: `grep -rn "neo4j-driver" packages/core/src` hits only `neo4j.ts`).
- `src/memory/embedder.ts` — `resolveEmbedder()` is the embedding analogue of
  `resolveLanguageModel`; the declared `dimensions` is asserted against every
  vector so a model/index mismatch fails loudly.
- The data model is a **temporal knowledge graph**: `Message`/`Thread` (verbatim
  conversation), `Entity` (deduplicated things), `Fact` (reified, bi-temporal
  observations with embeddings). `recall()` is GraphRAG — vector seed → graph
  expansion. Facts are **invalidated, never deleted** (`expiredAt`/`invalidAt`).
- Neo4j runs in Docker (`docker-compose.yml`, bound to loopback). Connect via
  **`bolt://` only — never `neo4j://`** (the routing scheme hangs under Bun).
  Data is backed up offline by `scripts/neo4j-backup.sh`.

**Adding a surface**: create `apps/<name>/` as its own workspace
(`"name": "@alfred/<name>"`), with a `tsconfig.json` extending
`../../tsconfig.base.json`, depending on `@alfred/core`. Define `dev`/`build`
scripts if it should be reachable from the root fan-out scripts. Keep surfaces
to I/O, transport, and presentation — assistant behaviour belongs in core.

## Conventions

- **TypeScript** is strict, ESM-only, with `noUncheckedIndexedAccess`. All
  packages extend `tsconfig.base.json`; nothing emits JS (`noEmit`).
- **Tooling is the Oxc stack:** [oxlint](https://oxc.rs) lints (`.oxlintrc.json`,
  `correctness` rules as errors) and [oxfmt](https://oxc.rs) formats
  (`.oxfmtrc.json`: 2-space indent, 100-col, double quotes, semicolons). oxfmt
  also formats JSON and **reorders object keys** (e.g. `package.json`
  dependencies) — expect that. Run `bun run format` before committing.
- **Provider credentials** live in `.env` (see `.env.example`):
  `ANTHROPIC_API_KEY`, `MISTRAL_API_KEY`, `ALFRED_LOCAL_BASE_URL`. Memory adds
  `NEO4J_AUTH` (Docker), `ALFRED_NEO4J_*` (connection), and `ALFRED_EMBEDDING_*`
  (model + dimensions for the vector index).
- **`bun.lock` is committed** — keep it in sync when changing dependencies.

## Git hooks via Claude Code

`.claude/settings.json` registers a **Stop hook** (`.claude/hooks/verify.sh`)
that runs `format → lint → typecheck → test` whenever Claude finishes a turn. If
any check fails it blocks the stop and feeds the output back so Claude fixes it
before finishing; it self-disarms via `stop_hook_active` to avoid loops. Edit or
remove that file to change the behaviour.

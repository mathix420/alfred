# Alfred

A personal AI assistant, built as a Bun-workspaces monorepo.

The assistant engine lives in [`packages/core`](./packages/core) and is
provider-agnostic: models are addressed as `"<provider>/<model>"` and resolved
to the right backend (Anthropic, Mistral, or a local OpenAI-compatible server)
at runtime. User-facing surfaces (web, CLI, API, …) live under [`apps/`](./apps)
and consume `@alfred/core`.

## Quick start

```sh
bun install
cp .env.example .env   # fill in provider keys
bun test
```

See [CLAUDE.md](./CLAUDE.md) for architecture and conventions.

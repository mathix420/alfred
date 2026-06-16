# apps/

User-facing surfaces for Alfred. Each subdirectory is its own Bun workspace and
depends on `@alfred/core` for the assistant logic — surfaces stay thin (I/O,
transport, presentation) and never talk to LLM providers directly.

Add a surface as `apps/<name>/` with its own `package.json`
(`"name": "@alfred/<name>"`) and a `tsconfig.json` extending
`../../tsconfig.base.json`. Suggested first targets: `web` (Next.js chat UI),
`cli` (terminal), `api` (HTTP service).

A surface that should run under `bun run dev` / `bun run build` should define
matching `dev` / `build` scripts; the root scripts fan out to every workspace.

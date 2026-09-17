# `@alfred/core/memory` — the second brain

A Neo4j-backed memory layer for Alfred: a **temporal knowledge graph** that
stores conversations, deduplicated entities, and time-scoped facts, and recalls
them with **GraphRAG** (vector search → graph traversal).

It follows the same shape as the model layer: a store is addressed by a
**`"<backend>/<database>"`** id, embeddings by a **`"<provider>/<model>"`** id,
and the concrete driver is resolved lazily. `@alfred/core` is the only place
that imports `neo4j-driver`; surfaces under `apps/` only ever see the
`GraphStore` interface.

---

## Quick start

```sh
cp .env.example .env                 # set NEO4J_AUTH + ALFRED_NEO4J_PASSWORD
docker compose up -d                 # Neo4j: bolt://localhost:7687, browser :7474
ollama pull nomic-embed-text         # the default 768-dim embedder (or use OpenAI/Mistral)
```

```ts
import { resolveMemoryStore } from "@alfred/core/memory";

const store = await resolveMemoryStore({
  backend: "neo4j",
  uri: process.env.ALFRED_NEO4J_URI!, // bolt:// only — see caveats
  username: process.env.ALFRED_NEO4J_USER!,
  password: process.env.ALFRED_NEO4J_PASSWORD!,
  embeddingModel: "local/nomic-embed-text",
  dimensions: 768, // MUST equal the model's output width
});

// Append a conversation turn.
const threadId = await store.ensureThread({ title: "groceries" });
await store.appendMessage({ threadId, role: "user", content: "I'm allergic to peanuts" });

// Remember a durable fact (entities are embedded + deduplicated automatically).
await store.remember({
  predicate: "allergic_to",
  content: "Arnaud is allergic to peanuts",
  subject: { name: "Arnaud", entityType: "person" },
  object: { name: "peanuts", entityType: "concept" },
  sourceMessageUuids: [
    /* the message uuid above */
  ],
});

// Recall: vector seed → graph expansion.
const hits = await store.recall({ text: "what foods should I avoid?" });

await store.close(); // drain the pool on shutdown
```

`resolveMemoryStore` calls `init()` for you (idempotent schema bootstrap), so the
store is ready to use the moment it resolves.

---

## Architecture

The module mirrors `src/models/`: one pure, dependency-free, heavily-unit-tested
core, and one lazily-importing resolver. **Only `neo4j.ts` names
`neo4j-driver`** (type-only `import type` + a runtime `await import(...)`), and
the barrel deliberately does not re-export it — so an app that never touches
memory never loads the driver.

| File           | Imports the driver?       | Pure? | Contents                                                                             |
| -------------- | ------------------------- | ----- | ------------------------------------------------------------------------------------ |
| `types.ts`     | no                        | yes   | Domain types, config types, error classes                                            |
| `registry.ts`  | no                        | yes   | `parseEmbeddingModelId` / `parseStoreId` / `dimensionsFor` + provider/backend tuples |
| `temporal.ts`  | no                        | yes   | `now`, `isLive`, `isCurrentlyTrue`, `normalizeName`, `dedupKeyOf`                    |
| `cypher.ts`    | no                        | yes   | Cypher builders (`{ cypher, params }`), schema DDL, allowlists, RRF                  |
| `mappers.ts`   | no                        | yes   | record → domain mappers                                                              |
| `embedder.ts`  | no (lazy `@ai-sdk/*`)     | no    | `Embedder` + `resolveEmbedder` (the `resolveLanguageModel` analogue)                 |
| `store.ts`     | no                        | —     | the `GraphStore` interface                                                           |
| `neo4j.ts`     | **yes (lazy, only here)** | no    | `Neo4jMemoryStore` — sessions, transactions, all live Cypher                         |
| `providers.ts` | no                        | no    | `resolveMemoryStore` — switches on backend, lazy-imports `neo4j.ts`                  |

---

## Data model

A reified, bi-temporal knowledge graph. Four node labels:

- **`Message`** — a verbatim conversational turn. Append-only, never mutated.
- **`Thread`** — a conversation/session.
- **`Entity`** — a deduplicated "thing" (person, project, concept, …). One node
  per `groupId | entityType | normalizedName` (the `dedupKey`).
- **`Fact`** — a reified observation (exposed in the API as `Observation`): a
  predicate + natural-language content, embedded for recall, scoped in time.

Relationships:

```
(Message)-[:IN_THREAD]->(Thread)
(Fact)-[:SUBJECT]->(Entity)        the thing the fact is about
(Fact)-[:OBJECT]->(Entity)         the thing it relates the subject to
(Fact)-[:MENTIONS]->(Entity)       other entities named in the fact
(Fact)-[:DERIVED_FROM]->(Message)  provenance: which turn(s) produced it
(Fact)-[:SUPERSEDES]->(Fact)       a newer fact that replaced an older one
```

### Temporal model

Facts are **invalidated, never deleted**, so history is preserved and "as-of"
queries work. Four epoch-ms fields on every `Fact`:

| Field       | Clock       | Meaning                                     |
| ----------- | ----------- | ------------------------------------------- |
| `createdAt` | transaction | when Alfred learned it (always set)         |
| `expiredAt` | transaction | when it was superseded (null = **live**)    |
| `validAt`   | event       | when it became true in the world (optional) |
| `invalidAt` | event       | when it stopped being true (optional)       |

A fact is **currently true** at instant `asOf` iff it is live
(`expiredAt IS NULL`) _and_ `validAt ≤ asOf < invalidAt`. The pure
`isCurrentlyTrue()` helper encodes this; `recall()` applies the same filter in
Cypher. `invalidate({ oldUuid, newUuid })` stamps `expiredAt` and wires a
`SUPERSEDES` edge — the old fact stays in the graph.

### Partitioning: `groupId`

Every node carries a `groupId` (default `"default"`). It's a hard partition key
— entity dedup includes it, and recall filters on it — so you can keep separate
"brains" (per persona, per project) in one database without bleed-through.

---

## API — `GraphStore`

```ts
init(): Promise<void>
```

Idempotent schema bootstrap (constraints + range/fulltext/vector indexes). Safe
to call on every boot; `resolveMemoryStore` calls it for you.

```ts
ensureThread(input: ThreadInput): Promise<string>          // → thread uuid
appendMessage(input: MessageInput): Promise<string>        // → message uuid
loadThread(threadId, opts?): Promise<{ thread, messages }> // messages in seq order
```

`appendMessage` is idempotent on `uuid`, auto-assigns `seq` (max+1 in the
thread), and creates the thread if it doesn't exist yet.

```ts
upsertEntity(input: EntityInput): Promise<string>          // → entity uuid
```

MERGE on the normalized `dedupKey`; embeds the name; updates `summary`/`updatedAt`
on a match. Idempotent.

```ts
remember(input: ObservationInput): Promise<string>         // → fact uuid
```

The main write path. Embeds `content`, upserts `subject` (required) + optional
`object`/`mentions`, then writes the `Fact` and its `SUBJECT`/`OBJECT`/
`MENTIONS`/`DERIVED_FROM` edges. **All embedding and entity upserts happen before
the fact transaction opens**, so the transaction body is pure `tx.run` and is
safe to auto-retry.

```ts
invalidate({ oldUuid, newUuid?, groupId?, expiredAt?, invalidAt? }): Promise<void>
recall(query: RecallQuery): Promise<RecallResult[]>
close(): Promise<void>
```

### Recall (GraphRAG)

```ts
const hits = await store.recall({
  text: "what foods should I avoid?",
  k: 50, // ANN candidates to pull from the vector index (default 50)
  finalK: 10, // results to return after scoring (default 10)
  minScore: 0.7, // min cosine score [0,1] to keep a seed (default 0.7)
  asOf: Date.now(), // temporal "as-of" instant (default now)
  hybrid: false, // also run fulltext recall and fuse with RRF (default false)
});
```

The default path:

1. **Seed** — `db.index.vector.queryNodes` over `Fact.embedding`, filtered to
   currently-true facts in the `groupId`.
2. **Expand** — from each seed `Fact`, hop to its `Entity`s, then collect other
   live facts about those entities.

Each `RecallResult` is `{ observation, score, entities, relatedObservations }`.
With `hybrid: true`, a fulltext pass over `Fact.content` runs in parallel and the
two rankings are fused with reciprocal-rank fusion.

---

## What `init()` creates

- **Uniqueness constraints** on `Message/Thread/Entity/Fact.uuid` and on
  `Entity.dedupKey`.
- **Range indexes** for the hot lookups (thread/seq, entity name/type, fact
  group + temporal fields).
- **Fulltext indexes** `fact_content_ft`, `entity_name_ft`.
- **Vector indexes** `fact_embedding`, `entity_name_embedding`
  (`vector.dimensions` = your `dimensions`, `vector.similarity_function` =
  `similarity`, default `cosine`).

Existence constraints (Enterprise-only) are attempted in a try/catch so a
**Community** instance boots cleanly. After issuing index creates, `init()`
waits on `db.awaitIndexes` so the first `recall()` doesn't hit a populating
index.

---

## Configuration

`.env` keys (see [`.env.example`](../../../../.env.example)):

| Key                                           | Purpose                                                    |
| --------------------------------------------- | ---------------------------------------------------------- |
| `NEO4J_AUTH`                                  | `neo4j/<password>` — seeds the DB on **first** Docker boot |
| `ALFRED_NEO4J_URI`                            | `bolt://localhost:7687` (**bolt only**)                    |
| `ALFRED_NEO4J_USER` / `ALFRED_NEO4J_PASSWORD` | driver credentials                                         |
| `ALFRED_NEO4J_DATABASE`                       | database name (default `neo4j`)                            |
| `ALFRED_EMBEDDING_MODEL`                      | `"<provider>/<model>"`                                     |
| `ALFRED_EMBEDDING_DIMENSIONS`                 | must equal the model's output width                        |
| `ALFRED_EMBEDDING_SIMILARITY`                 | `cosine` (default) or `euclidean`                          |

Embedding models the registry knows the width of (you can use any other model by
passing `dimensions` explicitly):

| Embedding model id              | Dimensions |
| ------------------------------- | ---------- |
| `local/nomic-embed-text`        | 768        |
| `local/mxbai-embed-large`       | 1024       |
| `mistral/mistral-embed`         | 1024       |
| `openai/text-embedding-3-small` | 1536       |
| `openai/text-embedding-3-large` | 3072       |

> **The dimension contract.** `dimensions` feeds both the vector index DDL and the
> `Embedder`, which asserts every vector to that width before it reaches the DB.
> A model/index mismatch throws `EmbeddingDimensionMismatchError` immediately —
> it can't silently corrupt recall. **Changing embedding model means changing
> `dimensions` and re-indexing**; never mix two models in one index.

---

## Operations

Neo4j runs in [`docker-compose.yml`](../../../../docker-compose.yml) (repo root),
bound to **loopback only** — Community ships no wire encryption, so reach it over
an SSH tunnel / VPN / TLS reverse proxy and never publish 7474/7687 to the
internet. The Neo4j Browser at `http://localhost:7474` lets you _visualize_ the
brain.

**Backups** — `scripts/neo4j-backup.sh` does an offline dump (Community can't do
online backups, so it stops the container, dumps `neo4j` + `system`, restarts,
and rotates). Schedule it nightly with a systemd timer or cron, and **push the
dumps off-box** — this is your brain, treat it like photos.

```sh
./scripts/neo4j-backup.sh                 # dump + rotate into ./scripts
# restore into a stopped DB / fresh volume:
docker compose stop neo4j
docker run --rm --volumes-from alfred-neo4j -v "$(pwd)/scripts:/backups" neo4j:5 \
  neo4j-admin database load neo4j --from-path=/backups --overwrite-destination=true
docker compose start neo4j                # init() recreates indexes if restored fresh
```

---

## Testing

Pure logic is unit-tested without a database (`bun test`): id parsing, Cypher
builders + injection guards, temporal predicates, mappers, RRF, the dimension
assertion. The live round-trip is **gated** so `bun test` stays green with no DB:

```sh
docker compose up -d
ALFRED_NEO4J_TEST_URI=bolt://localhost:7687 \
ALFRED_NEO4J_TEST_PASSWORD=<password> \
ALFRED_LOCAL_BASE_URL=http://localhost:11434/v1 \
  bun test packages/core/test/memory-neo4j.integration.test.ts
```

---

## Extending

**Add an embedding provider** — add it to `EMBEDDING_PROVIDERS` (registry.ts) and
a `case` to `resolveEmbedder` (embedder.ts). Two lines, exactly like the model
layer.

**Add a store backend** — add it to `STORE_BACKENDS` (registry.ts), give it a
`GraphStore` implementation, and add a `case` to `resolveMemoryStore`
(providers.ts) that lazy-imports it. Keep the driver behind the lazy import.

---

## Caveats

- **`bolt://` only.** The `neo4j://` routing scheme hangs ~60s under Bun;
  `createDriver` rejects any non-`bolt` URI with a clear message. A single Docker
  node needs no routing.
- **One embedding model per index.** See the dimension contract above.
- **`seq` is best-effort ordering.** `appendMessage` assigns `seq = max+1` within
  the write transaction; it's correct for a single-user assistant but not a
  guard against high-concurrency interleaving. Order by `createdAt` if you need
  a wall-clock tiebreak.
- **Integers come back native.** The driver runs with
  `disableLosslessIntegers: true`, so timestamps/counts are plain JS `number`s
  (epoch-ms fits well inside `2^53`). Only `LIMIT`/`k` are wrapped with
  `neo4j.int(...)`.

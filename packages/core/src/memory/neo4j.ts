/**
 * The Neo4j-backed `GraphStore`. This is the ONLY file that names
 * `neo4j-driver`: type-only via `import type` (erased at runtime under
 * `verbatimModuleSyntax`) and the runtime value via a lazy `await import(...)`.
 * `src/memory/index.ts` deliberately does not re-export this module, so an app
 * that never touches memory never loads the driver.
 *
 * Concurrency & correctness invariants (see the spec's "Pitfalls"):
 *   - One Driver per process (it is the pool); the init promise is memoized.
 *   - Every session is closed in `finally` via `readWork`/`writeWork`.
 *   - All embedding happens BEFORE a write transaction opens — tx bodies only
 *     `tx.run`, and are idempotent (MERGE + pre-generated uuids) so managed
 *     transaction retries are safe.
 *   - bolt:// only; `neo4j://` routing hangs under Bun.
 */

import type { Driver, ManagedTransaction, Node } from "neo4j-driver";
import * as cy from "./cypher";
import { Embedder, resolveEmbedder } from "./embedder";
import { mapMessageProps, mapRecallRow, mapThreadProps } from "./mappers";
import { dedupKeyOf, normalizeName, now } from "./temporal";
import type { GraphStore } from "./store";
import type {
  EntityInput,
  MemoryStoreConfig,
  Message,
  MessageInput,
  ObservationInput,
  RecallQuery,
  RecallResult,
  Thread,
  ThreadInput,
} from "./types";

type Neo4jLib = (typeof import("neo4j-driver"))["default"];

let neo4jLib: Neo4jLib | undefined;
async function getNeo4j(): Promise<Neo4jLib> {
  neo4jLib ??= (await import("neo4j-driver")).default;
  return neo4jLib;
}

/**
 * One Driver per uri (the driver IS the connection pool — thread-safe, meant to
 * be shared). We memoize the *promise* so concurrent first-callers share a
 * single init. Keyed by uri so distinct DBs don't collide in tests.
 */
const driverPromises = new Map<string, Promise<Driver>>();

function getDriver(config: MemoryStoreConfig): Promise<Driver> {
  let p = driverPromises.get(config.uri);
  if (!p) {
    p = createDriver(config);
    driverPromises.set(config.uri, p);
  }
  return p;
}

async function createDriver(config: MemoryStoreConfig): Promise<Driver> {
  if (!config.uri.startsWith("bolt")) {
    // Require bolt:// (or bolt+s:// / bolt+ssc:// for TLS). The neo4j:// routing
    // scheme hangs ~60s under Bun, and any other scheme (http://, a typo, ...)
    // can't speak Bolt — fail loudly here with a clear message instead of a
    // cryptic verifyConnectivity() error later. A single Docker node needs no
    // routing, so bolt:// is always correct. Do NOT "upgrade" this to neo4j://.
    throw new Error(
      `Invalid Neo4j URI "${config.uri}" — must start with bolt:// ` +
        `(bolt+s:// or bolt+ssc:// for TLS). The neo4j:// routing scheme hangs under Bun.`,
    );
  }
  const neo4j = await getNeo4j();
  const driver = neo4j.driver(config.uri, neo4j.auth.basic(config.username, config.password), {
    maxConnectionPoolSize: 50,
    connectionAcquisitionTimeout: 60_000,
    connectionTimeout: 30_000,
    maxConnectionLifetime: 3_600_000,
    maxTransactionRetryTime: 30_000,
    disableLosslessIntegers: true, // integers come back as plain JS number
  });
  await driver.verifyConnectivity();
  return driver;
}

function readWork<T>(
  driver: Driver,
  database: string,
  work: (tx: ManagedTransaction) => Promise<T>,
): Promise<T> {
  const session = driver.session({ database });
  return session.executeRead(work, { metadata: { app: "alfred" } }).finally(() => session.close());
}

function writeWork<T>(
  driver: Driver,
  database: string,
  work: (tx: ManagedTransaction) => Promise<T>,
): Promise<T> {
  const session = driver.session({ database });
  return session.executeWrite(work, { metadata: { app: "alfred" } }).finally(() => session.close());
}

export class Neo4jMemoryStore implements GraphStore {
  private constructor(
    private readonly driver: Driver,
    private readonly embedder: Embedder,
    private readonly config: MemoryStoreConfig,
  ) {}

  static async connect(config: MemoryStoreConfig): Promise<Neo4jMemoryStore> {
    const driver = await getDriver(config);
    const embedder = await resolveEmbedder(config.embeddingModel, config.dimensions);
    const store = new Neo4jMemoryStore(driver, embedder, config);
    await store.init();
    return store;
  }

  private get db(): string {
    return this.config.database ?? "neo4j";
  }

  private get group(): string {
    return this.config.groupId ?? "default";
  }

  async init(): Promise<void> {
    const session = this.driver.session({ database: this.db });
    try {
      const similarity = this.config.similarity ?? "cosine";
      for (const stmt of cy.SCHEMA_STATEMENTS(this.config.dimensions, similarity)) {
        await session.run(stmt);
      }
      for (const stmt of cy.ENTERPRISE_SCHEMA_STATEMENTS()) {
        try {
          await session.run(stmt);
        } catch {
          // Enterprise-only (existence constraints). On Community these are
          // enforced app-side, so swallow the failure and keep booting.
        }
      }
      await session.run("CALL db.awaitIndexes($timeout)", { timeout: 300 });
    } finally {
      await session.close();
    }
  }

  async ensureThread(input: ThreadInput): Promise<string> {
    const uuid = input.uuid ?? crypto.randomUUID();
    const { cypher, params } = cy.ensureThread({
      uuid,
      groupId: input.groupId ?? this.group,
      title: input.title ?? null,
      summary: input.summary ?? null,
      now: now(),
    });
    return writeWork(this.driver, this.db, async (tx) => {
      const r = await tx.run(cypher, params);
      return r.records[0]?.get("uuid") as string;
    });
  }

  async appendMessage(input: MessageInput): Promise<string> {
    const uuid = input.uuid ?? crypto.randomUUID();
    const createdAt = input.createdAt ?? now();
    const groupId = input.groupId ?? this.group;
    return writeWork(this.driver, this.db, async (tx) => {
      let seq = input.seq;
      if (seq === undefined) {
        const sq = cy.nextSeq({ threadId: input.threadId });
        const sr = await tx.run(sq.cypher, sq.params);
        seq = (sr.records[0]?.get("seq") as number | null) ?? 0;
      }
      const { cypher, params } = cy.appendMessage({
        uuid,
        groupId,
        threadId: input.threadId,
        role: input.role,
        content: input.content,
        seq,
        createdAt,
        tokenCount: input.tokenCount ?? null,
      });
      const r = await tx.run(cypher, params);
      return r.records[0]?.get("uuid") as string;
    });
  }

  async loadThread(
    threadId: string,
    opts?: { groupId?: string; limit?: number },
  ): Promise<{ thread: Thread | undefined; messages: Message[] }> {
    const neo4j = await getNeo4j();
    const groupId = opts?.groupId ?? this.group;
    const limit = neo4j.int(opts?.limit ?? 1000);
    const tq = cy.getThread({ threadId, groupId });
    const mq = cy.threadMessages({ threadId, groupId, limit });
    return readWork(this.driver, this.db, async (tx) => {
      const tr = await tx.run(tq.cypher, tq.params);
      const mr = await tx.run(mq.cypher, mq.params);
      const threadNode = tr.records[0]?.get("t") as Node | undefined;
      return {
        thread: threadNode
          ? mapThreadProps(threadNode.properties as Record<string, unknown>)
          : undefined,
        messages: mr.records.map((rec) =>
          mapMessageProps((rec.get("m") as Node).properties as Record<string, unknown>),
        ),
      };
    });
  }

  async upsertEntity(input: EntityInput): Promise<string> {
    const groupId = input.groupId ?? this.group;
    const normalizedName = normalizeName(input.name);
    const dedupKey = dedupKeyOf(groupId, input.entityType, normalizedName);
    const uuid = input.uuid ?? crypto.randomUUID();
    const nameEmbedding = await this.embedder.embedOne(input.name);
    const { cypher, params } = cy.upsertEntity({
      dedupKey,
      uuid,
      groupId,
      name: input.name,
      normalizedName,
      entityType: input.entityType,
      summary: input.summary ?? null,
      nameEmbedding,
      embeddingModel: this.embedder.modelId,
      now: now(),
    });
    return writeWork(this.driver, this.db, async (tx) => {
      const r = await tx.run(cypher, params);
      return r.records[0]?.get("uuid") as string;
    });
  }

  async remember(input: ObservationInput): Promise<string> {
    const groupId = input.groupId ?? this.group;
    const uuid = input.uuid ?? crypto.randomUUID();
    const ts = now();

    // All embeds + entity upserts happen OUTSIDE the fact transaction so the tx
    // body only runs `tx.run` (idempotent, retry-safe — see Pitfalls #7/#8).
    const embedding = await this.embedder.embedOne(input.content);
    const subjectUuid = await this.upsertEntity({ ...input.subject, groupId });
    const objectUuid = input.object ? await this.upsertEntity({ ...input.object, groupId }) : null;
    const mentionUuids: string[] = [];
    for (const mention of input.mentions ?? []) {
      mentionUuids.push(await this.upsertEntity({ ...mention, groupId }));
    }
    const sourceMessageUuids = input.sourceMessageUuids ?? [];

    return writeWork(this.driver, this.db, async (tx) => {
      const f = cy.createFact({
        uuid,
        groupId,
        predicate: input.predicate,
        content: input.content,
        embedding,
        embeddingModel: this.embedder.modelId,
        confidence: input.confidence ?? null,
        now: ts,
        validAt: input.validAt ?? null,
        invalidAt: input.invalidAt ?? null,
      });
      await tx.run(f.cypher, f.params);

      const s = cy.linkFactSubject({ uuid, subjectUuid });
      await tx.run(s.cypher, s.params);

      if (objectUuid) {
        const o = cy.linkFactObject({ uuid, objectUuid });
        await tx.run(o.cypher, o.params);
      }
      if (sourceMessageUuids.length > 0) {
        const d = cy.linkFactSources({ uuid, sourceMessageUuids });
        await tx.run(d.cypher, d.params);
      }
      if (mentionUuids.length > 0) {
        const m = cy.linkFactMentions({ uuid, mentionUuids });
        await tx.run(m.cypher, m.params);
      }
      return uuid;
    });
  }

  async invalidate(args: {
    oldUuid: string;
    newUuid?: string;
    groupId?: string;
    expiredAt?: number;
    invalidAt?: number;
  }): Promise<void> {
    const groupId = args.groupId ?? this.group;
    const expiredAt = args.expiredAt ?? now();
    const invalidAt = args.invalidAt ?? null;
    const q = args.newUuid
      ? cy.invalidateAndSupersede({
          oldUuid: args.oldUuid,
          newUuid: args.newUuid,
          groupId,
          expiredAt,
          invalidAt,
        })
      : cy.invalidateFact({ oldUuid: args.oldUuid, groupId, expiredAt, invalidAt });
    await writeWork(this.driver, this.db, (tx) => tx.run(q.cypher, q.params).then(() => undefined));
  }

  async recall(query: RecallQuery): Promise<RecallResult[]> {
    const neo4j = await getNeo4j();
    const groupId = query.groupId ?? this.group;
    const asOf = query.asOf ?? now();
    const k = query.k ?? 50;
    const finalK = query.finalK ?? 10;
    const minScore = query.minScore ?? 0.7;
    const queryEmbedding = await this.embedder.embedOne(query.text);

    const vq = cy.recallVector({
      indexName: cy.FACT_EMBEDDING_INDEX,
      k: neo4j.int(k),
      queryEmbedding,
      groupId,
      asOf,
      minScore,
    });
    const vectorSeeds = await readWork(this.driver, this.db, async (tx) => {
      const r = await tx.run(vq.cypher, vq.params);
      return r.records.map((rec) => mapRecallRow((key) => rec.get(key)));
    });

    if (!query.hybrid) {
      return vectorSeeds.slice(0, finalK);
    }

    // Hybrid: fuse vector + fulltext rankings with reciprocal-rank fusion.
    const fq = cy.recallFulltext({
      indexName: cy.FACT_CONTENT_FT_INDEX,
      query: query.text,
      k: neo4j.int(k),
      groupId,
      asOf,
    });
    const ftSeeds = await readWork(this.driver, this.db, async (tx) => {
      const r = await tx.run(fq.cypher, fq.params);
      return r.records.map((rec) => mapRecallRow((key) => rec.get(key)));
    });

    const byUuid = new Map<string, RecallResult>();
    for (const seed of [...vectorSeeds, ...ftSeeds]) {
      byUuid.set(seed.observation.uuid, seed);
    }
    const fused = cy.rrf([
      vectorSeeds.map((s) => s.observation.uuid),
      ftSeeds.map((s) => s.observation.uuid),
    ]);
    return fused
      .map(({ id }) => byUuid.get(id))
      .filter((seed): seed is RecallResult => seed !== undefined)
      .slice(0, finalK);
  }

  async close(): Promise<void> {
    const p = driverPromises.get(this.config.uri);
    if (p) {
      driverPromises.delete(this.config.uri);
      await (await p).close();
    }
  }
}

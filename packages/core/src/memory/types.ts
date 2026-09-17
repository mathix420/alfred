/**
 * Domain types for Alfred's Neo4j-backed "second brain" memory layer.
 *
 * This file is intentionally dependency-free (no `neo4j-driver` import, not even
 * type-only) so any surface can import the shapes without pulling the driver.
 *
 * Timestamps are epoch milliseconds (number). Combined with the driver's
 * `disableLosslessIntegers: true` they round-trip as plain JS numbers.
 */

export type Role = "user" | "assistant" | "system" | "tool";

/** Open vocabulary, but constrained app-side to this set (mirrors PROVIDERS). */
export type EntityType = "person" | "project" | "concept" | "organization" | "place" | "other";

/** A raw conversational turn. Append-only, never mutated. */
export interface Message {
  uuid: string;
  groupId: string;
  threadId: string;
  role: Role;
  content: string;
  seq: number;
  createdAt: number;
  tokenCount?: number;
}

/** Input to append a message; uuid/seq/createdAt are filled by the store if absent. */
export interface MessageInput {
  threadId: string;
  role: Role;
  content: string;
  groupId?: string;
  uuid?: string;
  seq?: number;
  createdAt?: number;
  tokenCount?: number;
}

/** A conversation / session. */
export interface Thread {
  uuid: string;
  groupId: string;
  title?: string;
  summary?: string;
  createdAt: number;
  lastMessageAt: number;
}

export interface ThreadInput {
  uuid?: string;
  groupId?: string;
  title?: string;
  summary?: string;
}

/** A deduplicated "thing": person, project, concept, ... */
export interface Entity {
  uuid: string;
  groupId: string;
  name: string;
  normalizedName: string;
  entityType: EntityType;
  dedupKey: string;
  summary?: string;
  embeddingModel?: string;
  createdAt: number;
  updatedAt: number;
}

/** Input to upsert an entity. The store computes the name embedding + dedup key. */
export interface EntityInput {
  name: string;
  entityType: EntityType;
  groupId?: string;
  uuid?: string;
  summary?: string;
}

/**
 * A discrete, temporally-scoped observation — the reified fact node (`:Fact`).
 * Exposed publicly as "Observation"; stored under the Neo4j label `Fact`.
 */
export interface Observation {
  uuid: string;
  groupId: string;
  predicate: string;
  content: string;
  embeddingModel: string;
  confidence?: number;
  /** transaction time: when Alfred learned this */
  createdAt: number;
  /** transaction time: when it was superseded/invalidated (null = live) */
  expiredAt?: number;
  /** event time: when the fact became true in the world */
  validAt?: number;
  /** event time: when the fact stopped being true */
  invalidAt?: number;
}

/**
 * Input to remember an observation. The store embeds `content`, resolves/creates
 * subject + object + mention entities, and wires provenance to source messages.
 */
export interface ObservationInput {
  predicate: string;
  content: string;
  subject: EntityInput;
  object?: EntityInput;
  mentions?: EntityInput[];
  sourceMessageUuids?: string[];
  groupId?: string;
  uuid?: string;
  confidence?: number;
  validAt?: number;
  invalidAt?: number;
}

export interface RecallQuery {
  text: string;
  groupId?: string;
  /** ANN candidate count over the vector index (fetch wide, trim post-filter). */
  k?: number;
  /** Final number of seed observations to return after scoring. */
  finalK?: number;
  /** Minimum normalized cosine score [0,1] to keep a seed. */
  minScore?: number;
  /** Opt-in: also run fulltext recall and fuse with RRF. Default false. */
  hybrid?: boolean;
  /** "as-of" epoch ms for temporal filtering; defaults to now(). */
  asOf?: number;
}

/** One recalled seed observation plus its graph-expanded context. */
export interface RecallResult {
  observation: Observation;
  score: number;
  entities: Array<Pick<Entity, "uuid" | "name" | "entityType">>;
  relatedObservations: Array<Pick<Observation, "uuid" | "content" | "predicate">>;
}

/** Connection + behavior config for the Neo4j backend. */
export interface Neo4jConfig {
  /** MUST be bolt:// / bolt+s:// / bolt+ssc:// — never neo4j:// (Bun routing bug). */
  uri: string;
  username: string;
  password: string;
  /** defaults to "neo4j" */
  database?: string;
  /** Embedding model id, "<provider>/<model>", e.g. "local/nomic-embed-text". */
  embeddingModel: string;
  /** Vector index dimension; MUST equal the embedder's output width. */
  dimensions: number;
  /** "cosine" (default) | "euclidean". */
  similarity?: "cosine" | "euclidean";
  /** Default partition key for writes/reads. Defaults to "default". */
  groupId?: string;
}

/** Backend-tagged store config: parsed from a "<backend>/<database>" store id. */
export interface MemoryStoreConfig extends Neo4jConfig {
  backend: "neo4j";
}

/* ---- Error classes (typed, catchable at surface boundaries) ---- */

export class EmbeddingDimensionMismatchError extends Error {
  constructor(
    readonly expected: number,
    readonly actual: number,
    readonly modelId: string,
  ) {
    super(
      `Embedding dimension mismatch for "${modelId}": index expects ${expected}, got ${actual}.`,
    );
    this.name = "EmbeddingDimensionMismatchError";
  }
}

export class UnknownBackendError extends Error {
  constructor(readonly backend: string) {
    super(`Unknown memory backend "${backend}".`);
    this.name = "UnknownBackendError";
  }
}

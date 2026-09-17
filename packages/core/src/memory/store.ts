/**
 * The provider-agnostic memory backend. The concrete Neo4j implementation is
 * resolved lazily by `resolveMemoryStore` (mirrors `resolveLanguageModel`), so
 * no surface ever imports `neo4j-driver`.
 */

import type {
  Message,
  MessageInput,
  Observation,
  ObservationInput,
  RecallQuery,
  RecallResult,
  Thread,
  ThreadInput,
  EntityInput,
} from "./types";

export interface GraphStore {
  /** Idempotent schema bootstrap: constraints + indexes + vector index. */
  init(): Promise<void>;

  /** Create or fetch a thread; returns its uuid. */
  ensureThread(input: ThreadInput): Promise<string>;

  /** Append a verbatim message; returns its uuid. Idempotent on uuid. */
  appendMessage(input: MessageInput): Promise<string>;

  /** Load a thread's messages in `seq` order. */
  loadThread(
    threadId: string,
    opts?: { groupId?: string; limit?: number },
  ): Promise<{ thread: Thread | undefined; messages: Message[] }>;

  /** Upsert an entity, deduplicating on its normalized identity. Returns uuid. */
  upsertEntity(input: EntityInput): Promise<string>;

  /**
   * Persist one observation: embed its content, upsert subject/object/mention
   * entities, wire SUBJECT/OBJECT/MENTIONS + DERIVED_FROM provenance edges.
   * Returns the observation uuid.
   */
  remember(input: ObservationInput): Promise<string>;

  /**
   * Temporally invalidate `oldUuid` (set expiredAt; optionally invalidAt) and,
   * if `newUuid` is given, link (new)-[:SUPERSEDES]->(old). Never deletes.
   */
  invalidate(args: {
    oldUuid: string;
    newUuid?: string;
    groupId?: string;
    expiredAt?: number;
    invalidAt?: number;
  }): Promise<void>;

  /** Hybrid GraphRAG recall: vector seed → graph expansion. */
  recall(query: RecallQuery): Promise<RecallResult[]>;

  /** Drain the connection pool. Call on SIGINT/SIGTERM. Idempotent. */
  close(): Promise<void>;
}

/** Friendlier public alias. */
export type MemoryStore = GraphStore;

export type {
  EntityInput,
  Message,
  MessageInput,
  Observation,
  ObservationInput,
  RecallQuery,
  RecallResult,
  Thread,
  ThreadInput,
};

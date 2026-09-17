/**
 * Pure, dependency-free identity layer for the memory subsystem — the analogue
 * of `src/models/registry.ts`.
 *
 * Two id grammars, both "<head>/<tail>":
 *   - embedding model id  "<provider>/<model>"   e.g. "local/nomic-embed-text"
 *   - store id            "<backend>/<database>" e.g. "neo4j/neo4j"
 *
 * Everything here is synchronous, side-effect-free and heavily unit-tested.
 */

export const EMBEDDING_PROVIDERS = ["openai", "mistral", "local"] as const;
export type EmbeddingProvider = (typeof EMBEDDING_PROVIDERS)[number];

export const STORE_BACKENDS = ["neo4j"] as const;
export type StoreBackend = (typeof STORE_BACKENDS)[number];

/** Known output widths so an index can be created from a constant. */
export const EMBEDDING_DIMENSIONS: Record<string, number> = {
  "openai/text-embedding-3-small": 1536,
  "openai/text-embedding-3-large": 3072,
  "mistral/mistral-embed": 1024,
  "local/nomic-embed-text": 768,
  "local/mxbai-embed-large": 1024,
};

export interface ParsedEmbeddingModelId {
  provider: EmbeddingProvider;
  /** Provider-specific model name; may itself contain slashes (e.g. local). */
  model: string;
}

export interface ParsedStoreId {
  backend: StoreBackend;
  /** The part after the slash; defaults to "neo4j" when empty. */
  database: string;
}

export function isEmbeddingProvider(value: string): value is EmbeddingProvider {
  return (EMBEDDING_PROVIDERS as readonly string[]).includes(value);
}

export function parseEmbeddingModelId(id: string): ParsedEmbeddingModelId {
  const slash = id.indexOf("/");
  if (slash === -1) {
    throw new Error(`Invalid embedding model id "${id}": expected "<provider>/<model>".`);
  }

  const provider = id.slice(0, slash);
  const model = id.slice(slash + 1);

  if (!isEmbeddingProvider(provider)) {
    throw new Error(
      `Unknown embedding provider "${provider}" in "${id}". Known: ${EMBEDDING_PROVIDERS.join(", ")}.`,
    );
  }
  if (model.length === 0) {
    throw new Error(`Missing model name in "${id}".`);
  }

  return { provider, model };
}

/** Registry-known output width for an embedding model id; throws if unknown. */
export function dimensionsFor(id: string): number {
  const dims = EMBEDDING_DIMENSIONS[id];
  if (dims === undefined) {
    throw new Error(`Unknown embedding dimensions for "${id}"; pass dimensions explicitly.`);
  }
  return dims;
}

export function parseStoreId(id: string): ParsedStoreId {
  const slash = id.indexOf("/");
  const backend = slash === -1 ? id : id.slice(0, slash);
  const database = slash === -1 ? "neo4j" : id.slice(slash + 1) || "neo4j";

  if (!(STORE_BACKENDS as readonly string[]).includes(backend)) {
    throw new Error(`Unknown store backend "${backend}". Known: ${STORE_BACKENDS.join(", ")}.`);
  }

  return { backend: backend as StoreBackend, database };
}

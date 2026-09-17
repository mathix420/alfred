/**
 * Resolve a memory backend to a live `GraphStore`. The Neo4j implementation —
 * and therefore `neo4j-driver` — is imported lazily, so an app that never uses
 * memory never loads the driver. Mirrors `resolveLanguageModel`.
 */

import type { GraphStore } from "./store";
import type { MemoryStoreConfig, Neo4jConfig } from "./types";
import { parseStoreId } from "./registry";
import { UnknownBackendError } from "./types";

export async function resolveMemoryStore(config: MemoryStoreConfig): Promise<GraphStore> {
  switch (config.backend) {
    case "neo4j": {
      const { Neo4jMemoryStore } = await import("./neo4j");
      return Neo4jMemoryStore.connect(config);
    }
    default:
      throw new UnknownBackendError(config.backend);
  }
}

/** Build a `MemoryStoreConfig` from a "<backend>/<database>" id + connection. */
export function memoryStoreConfig(
  storeId: string,
  conn: Omit<Neo4jConfig, "database">,
): MemoryStoreConfig {
  const { backend, database } = parseStoreId(storeId);
  return { ...conn, backend, database };
}

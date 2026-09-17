import { describe, expect, it } from "bun:test";

/**
 * Live round-trip against a real Neo4j. Gated on `ALFRED_NEO4J_TEST_URI` so a
 * plain `bun test` (and the Stop hook) skips it entirely — no DB, no driver
 * loaded. To run it:
 *
 *   docker compose up -d
 *   ALFRED_NEO4J_TEST_URI=bolt://localhost:7687 \
 *   ALFRED_NEO4J_TEST_PASSWORD=<password> \
 *   ALFRED_LOCAL_BASE_URL=http://localhost:11434/v1 \
 *   bun test packages/core/test/memory-neo4j.integration.test.ts
 */
const URI = process.env.ALFRED_NEO4J_TEST_URI;

describe.skipIf(!URI)("Neo4jMemoryStore (live)", () => {
  it("init → ensureThread → appendMessage → loadThread round-trips", async () => {
    const { resolveMemoryStore } = await import("../src/memory");
    const store = await resolveMemoryStore({
      backend: "neo4j",
      uri: URI!,
      username: process.env.ALFRED_NEO4J_TEST_USER ?? "neo4j",
      password: process.env.ALFRED_NEO4J_TEST_PASSWORD ?? "password",
      embeddingModel: process.env.ALFRED_EMBEDDING_MODEL ?? "local/nomic-embed-text",
      dimensions: Number(process.env.ALFRED_EMBEDDING_DIMENSIONS ?? 768),
      groupId: `test-${crypto.randomUUID()}`,
    });
    try {
      const threadId = await store.ensureThread({ title: "t" });
      await store.appendMessage({ threadId, role: "user", content: "hi" });
      const { thread, messages } = await store.loadThread(threadId);
      expect(thread?.uuid).toBe(threadId);
      expect(messages).toHaveLength(1);
      expect(messages[0]?.content).toBe("hi");
    } finally {
      await store.close();
    }
  });
});

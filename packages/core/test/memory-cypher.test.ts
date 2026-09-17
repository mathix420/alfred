import { describe, expect, it } from "bun:test";
import * as cy from "../src/memory/cypher";

describe("identifier safety", () => {
  it("allows known labels and rejects unknown ones", () => {
    expect(() => cy.assertLabel("Fact")).not.toThrow();
    expect(() => cy.assertLabel("Robert'); DROP")).toThrow();
  });

  it("allows known relationship types and rejects unknown ones", () => {
    expect(() => cy.assertRelType("SUBJECT")).not.toThrow();
    expect(() => cy.assertRelType("EVIL")).toThrow();
  });

  it("backtick-escapes identifiers, doubling embedded backticks", () => {
    expect(cy.escapeId("simple")).toBe("`simple`");
    expect(cy.escapeId("a`b")).toBe("`a``b`");
  });
});

describe("SCHEMA_STATEMENTS", () => {
  it("emits constraints, range/fulltext/vector indexes with the configured dims", () => {
    const stmts = cy.SCHEMA_STATEMENTS(768, "cosine");
    const all = stmts.join("\n");
    expect(all).toContain("CREATE CONSTRAINT entity_dedup");
    expect(all).toContain("CREATE FULLTEXT INDEX fact_content_ft");
    expect(all).toContain("CREATE VECTOR INDEX fact_embedding");
    expect(all).toContain("`vector.dimensions`: 768");
    expect(all).toContain("`vector.similarity_function`: 'cosine'");
  });

  it("validates dimensions and similarity (config can never inject)", () => {
    expect(() => cy.SCHEMA_STATEMENTS(0, "cosine")).toThrow();
    expect(() => cy.SCHEMA_STATEMENTS(5000, "cosine")).toThrow();
    expect(() => cy.SCHEMA_STATEMENTS(768.5, "cosine")).toThrow();
    expect(() => cy.SCHEMA_STATEMENTS(768, "manhattan" as "cosine")).toThrow();
  });
});

describe("write builders parameterize all domain values", () => {
  it("appendMessage keeps content/uuid out of the query text", () => {
    const { cypher, params } = cy.appendMessage({
      uuid: "uuid-secret-123",
      groupId: "g",
      threadId: "t",
      role: "user",
      content: "leak me if you can",
      seq: 3,
      createdAt: 1000,
      tokenCount: null,
    });
    expect(cypher).toContain("$uuid");
    expect(cypher).toContain("$content");
    expect(cypher).not.toContain("uuid-secret-123");
    expect(cypher).not.toContain("leak me if you can");
    expect(params.content).toBe("leak me if you can");
  });

  it("upsertEntity passes name + embedding as params", () => {
    const { cypher, params } = cy.upsertEntity({
      dedupKey: "g|person|ada",
      uuid: "u",
      groupId: "g",
      name: "Ada",
      normalizedName: "ada",
      entityType: "person",
      summary: null,
      nameEmbedding: [0.1, 0.2],
      embeddingModel: "local/nomic-embed-text",
      now: 1,
    });
    expect(cypher).toContain("MERGE (e:Entity {dedupKey: $dedupKey})");
    expect(cypher).toContain("setNodeVectorProperty(e, 'nameEmbedding', $nameEmbedding)");
    expect(cypher).not.toContain("0.1");
    expect(params.nameEmbedding).toEqual([0.1, 0.2]);
  });

  it("linkFactSources uses UNWIND over a list param, never string-built ids", () => {
    const { cypher, params } = cy.linkFactSources({
      uuid: "f",
      sourceMessageUuids: ["m1", "m2"],
    });
    expect(cypher).toContain("UNWIND $sourceMessageUuids AS mid");
    expect(cypher).not.toContain("m1");
    expect(params.sourceMessageUuids).toEqual(["m1", "m2"]);
  });
});

describe("recall builders", () => {
  it("recallVector binds the index name and query vector as params", () => {
    const { cypher, params } = cy.recallVector({
      indexName: cy.FACT_EMBEDDING_INDEX,
      k: 50,
      queryEmbedding: [0.1],
      groupId: "g",
      asOf: 1000,
      minScore: 0.7,
    });
    expect(cypher).toContain("db.index.vector.queryNodes($indexName, $k, $queryEmbedding)");
    expect(cypher).toContain("f.expiredAt IS NULL");
    expect(params.indexName).toBe("fact_embedding");
  });
});

describe("rrf", () => {
  it("fuses ranked lists by reciprocal rank", () => {
    const fused = cy.rrf([
      ["a", "b", "c"],
      ["b", "c", "a"],
    ]);
    expect(fused[0]?.id).toBe("b");
    expect(fused.map((f) => f.id)).toEqual(["b", "a", "c"]);
  });

  it("returns an empty array for no rankings", () => {
    expect(cy.rrf([])).toEqual([]);
  });
});

import { describe, expect, it } from "bun:test";
import {
  dimensionsFor,
  isEmbeddingProvider,
  parseEmbeddingModelId,
  parseStoreId,
} from "../src/memory/registry";

describe("parseEmbeddingModelId", () => {
  it("parses provider/model", () => {
    expect(parseEmbeddingModelId("openai/text-embedding-3-small")).toEqual({
      provider: "openai",
      model: "text-embedding-3-small",
    });
  });

  it("keeps slashes in the model name (local tags)", () => {
    expect(parseEmbeddingModelId("local/library/nomic-embed-text").model).toBe(
      "library/nomic-embed-text",
    );
  });

  it("rejects unknown providers", () => {
    expect(() => parseEmbeddingModelId("cohere/embed-v3")).toThrow();
  });

  it("rejects ids without a provider", () => {
    expect(() => parseEmbeddingModelId("text-embedding-3-small")).toThrow();
  });

  it("rejects ids with an empty model", () => {
    expect(() => parseEmbeddingModelId("openai/")).toThrow();
  });
});

describe("isEmbeddingProvider", () => {
  it("narrows known providers", () => {
    expect(isEmbeddingProvider("local")).toBe(true);
    expect(isEmbeddingProvider("anthropic")).toBe(false);
  });
});

describe("parseStoreId", () => {
  it("parses backend/database", () => {
    expect(parseStoreId("neo4j/brain")).toEqual({ backend: "neo4j", database: "brain" });
  });

  it("defaults the database to neo4j", () => {
    expect(parseStoreId("neo4j")).toEqual({ backend: "neo4j", database: "neo4j" });
    expect(parseStoreId("neo4j/")).toEqual({ backend: "neo4j", database: "neo4j" });
  });

  it("rejects unknown backends", () => {
    expect(() => parseStoreId("postgres/main")).toThrow();
  });
});

describe("dimensionsFor", () => {
  it("returns known widths", () => {
    expect(dimensionsFor("local/nomic-embed-text")).toBe(768);
    expect(dimensionsFor("openai/text-embedding-3-small")).toBe(1536);
  });

  it("throws on unknown models", () => {
    expect(() => dimensionsFor("local/unknown-model")).toThrow();
  });
});

import { describe, expect, it } from "bun:test";
import { Embedder, resolveEmbedder } from "../src/memory/embedder";
import { EmbeddingDimensionMismatchError } from "../src/memory/types";

// `EmbeddingModel` accepts a bare string id, so we can build an Embedder without
// a live provider to exercise the pure dimension guard.
const fakeModel = "fake-model";

describe("Embedder.assertDims", () => {
  it("passes a vector of the declared width", () => {
    const embedder = new Embedder(fakeModel, "local/x", 3);
    expect(() => embedder.assertDims([1, 2, 3])).not.toThrow();
  });

  it("throws a typed error on a mismatch", () => {
    const embedder = new Embedder(fakeModel, "local/x", 3);
    expect(() => embedder.assertDims([1, 2])).toThrow(EmbeddingDimensionMismatchError);
  });
});

describe("resolveEmbedder", () => {
  it("rejects unknown providers before importing anything", async () => {
    await expect(resolveEmbedder("cohere/embed-v3", 1024)).rejects.toThrow();
  });

  it("rejects invalid declared dimensions", async () => {
    await expect(resolveEmbedder("local/nomic-embed-text", 0)).rejects.toThrow();
    await expect(resolveEmbedder("local/nomic-embed-text", 9000)).rejects.toThrow();
  });
});

/**
 * Provider-agnostic embeddings — the `resolveLanguageModel` analogue for the
 * vector side. An embedding model id is "<provider>/<model>"; the matching
 * `@ai-sdk/*` package is imported lazily so an app only loads what it uses.
 *
 * The declared `dimensions` is the contract that MUST equal the Neo4j vector
 * index config. Every produced vector is asserted to that width before it can
 * be persisted or queried, so a model/index mismatch fails loudly here rather
 * than silently corrupting recall.
 */

import type { EmbeddingModel } from "ai";
import { embed, embedMany } from "ai";
import { dimensionsFor, parseEmbeddingModelId } from "./registry";
import { EmbeddingDimensionMismatchError } from "./types";

export class Embedder {
  constructor(
    private readonly model: EmbeddingModel,
    readonly modelId: string,
    readonly dimensions: number,
  ) {}

  async embedOne(value: string): Promise<number[]> {
    const { embedding } = await embed({ model: this.model, value });
    this.assertDims(embedding);
    return embedding;
  }

  async embedBatch(values: string[]): Promise<number[][]> {
    if (values.length === 0) return [];
    const { embeddings } = await embedMany({ model: this.model, values });
    for (const e of embeddings) this.assertDims(e);
    return embeddings;
  }

  /** Throw `EmbeddingDimensionMismatchError` unless `vector` has the declared width. */
  assertDims(vector: number[]): void {
    if (vector.length !== this.dimensions) {
      throw new EmbeddingDimensionMismatchError(this.dimensions, vector.length, this.modelId);
    }
  }
}

/**
 * Resolve "<provider>/<model>" to an `Embedder`. `declaredDimensions` (from
 * config) wins; otherwise we fall back to the registry's known width. The
 * matching provider package is imported lazily (mirrors `resolveLanguageModel`).
 */
export async function resolveEmbedder(id: string, declaredDimensions?: number): Promise<Embedder> {
  const { provider, model } = parseEmbeddingModelId(id);
  const dimensions = declaredDimensions ?? dimensionsFor(id);
  if (!Number.isInteger(dimensions) || dimensions < 1 || dimensions > 4096) {
    throw new Error(`Invalid embedding dimensions ${dimensions} for "${id}" (must be 1..4096).`);
  }

  switch (provider) {
    case "openai": {
      const { openai } = await import("@ai-sdk/openai");
      return new Embedder(openai.textEmbeddingModel(model), id, dimensions);
    }
    case "mistral": {
      const { mistral } = await import("@ai-sdk/mistral");
      return new Embedder(mistral.textEmbeddingModel(model), id, dimensions);
    }
    case "local": {
      // Any OpenAI-compatible server: Ollama, LM Studio, llama.cpp, vLLM, ...
      const { createOpenAICompatible } = await import("@ai-sdk/openai-compatible");
      const local = createOpenAICompatible({
        name: "local",
        baseURL: process.env.ALFRED_LOCAL_BASE_URL ?? "http://localhost:11434/v1",
      });
      return new Embedder(local.textEmbeddingModel(model), id, dimensions);
    }
  }
}

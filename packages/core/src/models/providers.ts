import type { LanguageModel } from "ai";
import { parseModelId } from "./registry";

/**
 * Resolve a `"<provider>/<model>"` id to a Vercel AI SDK language model.
 *
 * Provider packages are imported lazily so an app only pays for (and only needs
 * the credentials of) the providers it actually uses.
 */
export async function resolveLanguageModel(id: string): Promise<LanguageModel> {
  const { provider, model } = parseModelId(id);

  switch (provider) {
    case "anthropic": {
      const { anthropic } = await import("@ai-sdk/anthropic");
      return anthropic(model);
    }
    case "mistral": {
      const { mistral } = await import("@ai-sdk/mistral");
      return mistral(model);
    }
    case "local": {
      // Any OpenAI-compatible server: Ollama, LM Studio, llama.cpp, vLLM, ...
      const { createOpenAICompatible } = await import("@ai-sdk/openai-compatible");
      const local = createOpenAICompatible({
        name: "local",
        baseURL: process.env.ALFRED_LOCAL_BASE_URL ?? "http://localhost:11434/v1",
      });
      return local(model);
    }
  }
}

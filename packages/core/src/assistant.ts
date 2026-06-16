import { generateText, type ModelMessage, streamText } from "ai";
import { resolveLanguageModel } from "./models/providers";

export interface AssistantConfig {
  /** `"<provider>/<model>"`, e.g. "anthropic/claude-opus-4-8". */
  model: string;
  /** System prompt that defines Alfred's persona and ground rules. */
  system?: string;
}

/**
 * The provider-agnostic assistant engine. Surfaces under `apps/` construct an
 * `Assistant` and feed it a conversation; swapping models/providers is just a
 * different `model` string — no app code changes.
 */
export class Assistant {
  constructor(private readonly config: AssistantConfig) {}

  async send(messages: ModelMessage[]) {
    const model = await resolveLanguageModel(this.config.model);
    return generateText({ model, system: this.config.system, messages });
  }

  async stream(messages: ModelMessage[]) {
    const model = await resolveLanguageModel(this.config.model);
    return streamText({ model, system: this.config.system, messages });
  }
}

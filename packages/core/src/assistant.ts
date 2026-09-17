import { generateText, type ModelMessage, stepCountIs, streamText, type ToolSet } from "ai";
import { resolveLanguageModel } from "./models/providers";

export interface AssistantConfig {
  /** `"<provider>/<model>"`, e.g. "anthropic/claude-opus-4-8". */
  model: string;
  /** System prompt that defines Alfred's persona and ground rules. */
  system?: string;
}

/** Per-call knobs: tools the model may invoke, and an abort signal. */
export interface AssistantCallOptions {
  /**
   * Tools the model may call this turn. When present, the model runs a bounded
   * tool loop (up to `maxSteps` steps) before producing its final answer.
   */
  tools?: ToolSet;
  /** Aborts the underlying provider request (and any tool loop). */
  abortSignal?: AbortSignal;
  /** Max generation steps when tools are present. Defaults to 8. */
  maxSteps?: number;
}

const DEFAULT_MAX_STEPS = 8;

/**
 * The provider-agnostic assistant engine. Surfaces under `apps/` construct an
 * `Assistant` and feed it a conversation; swapping models/providers is just a
 * different `model` string — no app code changes. Tools and cancellation are
 * passed per call so a surface can scope them to a single request.
 */
export class Assistant {
  constructor(private readonly config: AssistantConfig) {}

  async send(messages: ModelMessage[], options: AssistantCallOptions = {}) {
    const model = await resolveLanguageModel(this.config.model);
    const { system } = this.config;
    const tools = activeTools(options);
    if (tools) {
      return generateText({
        model,
        system,
        messages,
        tools,
        stopWhen: stepCountIs(options.maxSteps ?? DEFAULT_MAX_STEPS),
        abortSignal: options.abortSignal,
      });
    }
    return generateText({ model, system, messages, abortSignal: options.abortSignal });
  }

  async stream(messages: ModelMessage[], options: AssistantCallOptions = {}) {
    const model = await resolveLanguageModel(this.config.model);
    const { system } = this.config;
    const tools = activeTools(options);
    if (tools) {
      return streamText({
        model,
        system,
        messages,
        tools,
        stopWhen: stepCountIs(options.maxSteps ?? DEFAULT_MAX_STEPS),
        abortSignal: options.abortSignal,
      });
    }
    return streamText({ model, system, messages, abortSignal: options.abortSignal });
  }
}

/** The tool set if it is non-empty, else undefined (so no tool loop is started). */
function activeTools(options: AssistantCallOptions): ToolSet | undefined {
  return options.tools && Object.keys(options.tools).length > 0 ? options.tools : undefined;
}

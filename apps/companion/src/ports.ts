/**
 * The bridge's outbound boundaries ("ports", hexagonal-architecture style).
 *
 * Everything the orchestration depends on — speech-to-text, text-to-speech, the
 * assistant, and memory — is expressed as a narrow interface here so the core
 * logic (`session.ts`) can be unit-tested with fakes and the heavy/IO-bound
 * implementations stay swappable. Concrete adapters live in `stt/`, `tts/`, and
 * `@alfred/core`.
 */

import type { ModelMessage, ToolSet } from "ai";
import type {
  MessageInput,
  ObservationInput,
  RecallQuery,
  RecallResult,
  ThreadInput,
} from "@alfred/core/memory";
import type { AudioFormat } from "./protocol";

/* ------------------------------- speech in -------------------------------- */

export interface TranscribeOptions {
  /** PCM sample rate of `audio`, e.g. 16000. */
  sampleRate: number;
  channels: number;
  /** ISO-639-1 hint, e.g. "en". Omit to let the engine auto-detect. */
  language?: string;
  /** Abort a long transcription when the turn is superseded or the socket closes. */
  signal?: AbortSignal;
}

export interface TranscriptResult {
  text: string;
  language?: string;
  durationMs?: number;
}

/** Speech-to-text boundary. Implemented by `stt/whisper.ts`. */
export interface SpeechToText {
  transcribe(audio: Uint8Array, opts: TranscribeOptions): Promise<TranscriptResult>;
}

/* ------------------------------- speech out ------------------------------- */

export interface SynthesizeOptions {
  voice?: string;
  /** Abort synthesis when the turn is superseded or the socket closes. */
  signal?: AbortSignal;
}

/** Text-to-speech boundary. Streams audio chunks. Implemented by `tts/piper.ts`. */
export interface TextToSpeech {
  /** The wire format of every chunk this engine yields. */
  readonly format: AudioFormat;
  synthesize(text: string, opts?: SynthesizeOptions): AsyncIterable<Uint8Array>;
}

/* ----------------------------- the assistant ------------------------------ */

/** The streamed reply shape we consume — structurally satisfied by the AI SDK. */
export interface AssistantReply {
  /** Incremental text deltas. */
  textStream: AsyncIterable<string>;
  /** Resolves to the full text once the stream completes. `PromiseLike` (a
   * thenable) so the AI SDK's `StreamTextResult` satisfies this structurally. */
  text: PromiseLike<string>;
}

/** Per-call knobs the bridge passes to the assistant (mirrors core's). */
export interface AssistantCallOptions {
  /** Tools the model may call this turn (memory capture/recall, reminders). */
  tools?: ToolSet;
  /** Aborts the underlying provider request and tool loop. */
  abortSignal?: AbortSignal;
}

/**
 * The slice of `@alfred/core`'s `Assistant` the bridge uses. Declared as an
 * interface (not an import of the class) so tests can inject a fake without a
 * provider or network. A real `Assistant` satisfies it structurally.
 */
export interface AssistantLike {
  stream(messages: ModelMessage[], options?: AssistantCallOptions): Promise<AssistantReply>;
}

/* -------------------------------- memory ---------------------------------- */

/**
 * The slice of `@alfred/core/memory`'s `GraphStore` the bridge uses. A real
 * store satisfies it; memory is optional, so the bridge runs (Tier 0) without
 * one and degrades to a stateless assistant.
 */
export interface MemoryLike {
  ensureThread(input: ThreadInput): Promise<string>;
  appendMessage(input: MessageInput): Promise<string>;
  remember(input: ObservationInput): Promise<string>;
  recall(query: RecallQuery): Promise<RecallResult[]>;
}

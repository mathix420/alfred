/**
 * One device connection's conversation + push-to-talk turn machine.
 *
 *   idle --ptt_down--> listening --(mic audio…)--> [ptt_up]
 *        --> thinking (STT → recall → LLM + tools) --> speaking (TTS) --> idle
 *
 * Pure orchestration: every dependency (assistant, STT, TTS, memory, reminders,
 * the outbound sinks, the clock) is injected, so a whole turn is unit-testable
 * with fakes and no network. The transport (`server.ts`) feeds it parsed events.
 *
 * Turns are **superseding and cancellable**. Each `pttDown` bumps an epoch and
 * aborts the in-flight turn; a turn whose epoch is stale (a newer press, or a
 * closed socket) stops emitting. The abort propagates into STT/LLM/TTS so the
 * provider request and Piper subprocess are torn down promptly — enabling true
 * barge-in and clean disconnects.
 */

import type { ModelMessage, ToolSet } from "ai";
import type { RecallResult } from "@alfred/core/memory";
import { buildContextMessage } from "./persona";
import type { AssistantLike, MemoryLike, SpeechToText, TextToSpeech } from "./ports";
import type { AmbientFace, AudioFormat, DeviceState, ServerMessage } from "./protocol";
import type { ReminderService } from "./reminders";
import { buildMemoryTools, buildReminderTool } from "./tools";

export interface SessionDeps {
  assistant: AssistantLike;
  stt: SpeechToText;
  tts: TextToSpeech;
  memory?: MemoryLike;
  reminders?: ReminderService;
  /** Outbound control-plane sink (JSON frames). */
  send: (message: ServerMessage) => void;
  /** Outbound audio-plane sink. May return a promise that resolves on drain
   * (backpressure); the turn awaits it before sending the next chunk. */
  sendAudio: (chunk: Uint8Array) => void | Promise<void>;
  /** Mic PCM format the device streams during PTT. */
  micFormat?: AudioFormat;
  /** Hard cap on one utterance's buffered mic bytes; overflow aborts capture. */
  maxUtteranceBytes?: number;
  /** Memory partition key. */
  groupId?: string;
  /** Injectable clock for deterministic tests. */
  now?: () => Date;
  /** Non-fatal error sink (memory hiccups, turn failures). Defaults to console.error. */
  onError?: (context: string, error: unknown) => void;
}

type Phase = "stt" | "llm" | "tts";

const DEFAULT_MIC_FORMAT: AudioFormat = { encoding: "pcm_s16le", sampleRate: 16000, channels: 1 };
const DEFAULT_MAX_UTTERANCE_BYTES = 16_000 * 2 * 30; // ~30s of 16 kHz mono s16le
const MAX_HISTORY = 12; // recent turns kept in RAM; durable context comes from recall()
const FALLBACK_REPLY = "I'm not sure how to answer that, sir."; // when the model returns no text

function concat(chunks: Uint8Array[]): Uint8Array {
  let total = 0;
  for (const chunk of chunks) total += chunk.byteLength;
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

export class Session {
  private state: DeviceState = "idle";
  private readonly history: ModelMessage[] = [];
  private audioChunks: Uint8Array[] = [];
  private audioBytes = 0;
  private overflowed = false;
  private threadId: string | undefined;
  /** Bumped on every ptt_down; a turn whose captured epoch is stale must hush. */
  private epoch = 0;
  private closed = false;
  private inflight: AbortController | undefined;
  private battery: number | undefined;
  private charging: boolean | undefined;
  private readonly maxUtteranceBytes: number;

  constructor(private readonly deps: SessionDeps) {
    this.maxUtteranceBytes = deps.maxUtteranceBytes ?? DEFAULT_MAX_UTTERANCE_BYTES;
    if (deps.reminders) deps.reminders.onChange = () => this.onRemindersChanged();
  }

  get currentState(): DeviceState {
    return this.state;
  }

  private setState(state: DeviceState): void {
    this.state = state;
    this.deps.send({ type: "state", state });
  }

  private reportError(context: string, error: unknown): void {
    const sink = this.deps.onError ?? ((c, e) => console.error(`[companion:${c}]`, e));
    sink(context, error);
  }

  /** A turn is "current" only while its epoch is live and the socket is open. */
  private isCurrent(epoch: number): boolean {
    return !this.closed && this.epoch === epoch;
  }

  private nowDate(): Date {
    return (this.deps.now ?? (() => new Date()))();
  }

  /** PTT pressed: supersede + abort any in-flight turn, start a fresh capture. */
  pttDown(): void {
    this.inflight?.abort();
    this.epoch++;
    this.audioChunks = [];
    this.audioBytes = 0;
    this.overflowed = false;
    this.setState("listening");
  }

  /** A mic audio frame arrived (binary). Ignored unless listening; capped to
   * bound memory against a device that never releases PTT. */
  pushAudio(chunk: Uint8Array): void {
    if (this.state !== "listening" || this.overflowed) return;
    this.audioBytes += chunk.byteLength;
    if (this.audioBytes > this.maxUtteranceBytes) {
      this.overflowed = true;
      this.audioChunks = [];
      this.deps.send({
        type: "error",
        code: "utterance_too_long",
        message: "That ran rather long, sir; let us try again.",
      });
      this.setState("idle");
      return;
    }
    this.audioChunks.push(chunk);
  }

  /** The connection closed: cancel the in-flight turn and drop buffers. */
  close(): void {
    this.closed = true;
    this.inflight?.abort();
    if (this.deps.reminders) this.deps.reminders.onChange = undefined;
    this.audioChunks = [];
    this.audioBytes = 0;
  }

  /** Fold device telemetry into the ambient face and push it. */
  applyTelemetry(telemetry: { battery?: number; charging?: boolean }): void {
    if (telemetry.battery !== undefined) this.battery = telemetry.battery;
    if (telemetry.charging !== undefined) this.charging = telemetry.charging;
    this.pushAmbient();
  }

  /** Push the current reminder list + ambient face (e.g. right after welcome). */
  syncDevice(): void {
    this.pushReminders();
    this.pushAmbient();
  }

  private onRemindersChanged(): void {
    this.pushReminders();
    this.pushAmbient();
  }

  private pushReminders(): void {
    if (!this.deps.reminders) return;
    this.deps.send({ type: "reminders", items: this.deps.reminders.list() });
  }

  private pushAmbient(): void {
    const now = this.nowDate().getTime();
    const next = this.deps.reminders?.next(now);
    const face: AmbientFace = {
      now,
      ...(next ? { nextReminder: next } : {}),
      ...(this.battery !== undefined ? { battery: this.battery } : {}),
      ...(this.charging !== undefined ? { charging: this.charging } : {}),
    };
    this.deps.send({ type: "ambient", face });
  }

  /** PTT released: transcribe, think (with tools), and speak. Never throws —
   * failures report and the machine returns to idle so the device is never
   * stranded. */
  async pttUp(): Promise<void> {
    if (this.state !== "listening") return;
    const epoch = this.epoch;
    const ac = new AbortController();
    this.inflight = ac;
    this.setState("thinking");

    const audio = concat(this.audioChunks);
    this.audioChunks = [];
    this.audioBytes = 0;

    let phase: Phase = "stt";
    try {
      const mic = this.deps.micFormat ?? DEFAULT_MIC_FORMAT;
      const { text } = await this.deps.stt.transcribe(audio, {
        sampleRate: mic.sampleRate,
        channels: mic.channels,
        signal: ac.signal,
      });
      if (!this.isCurrent(epoch)) return;

      const userText = text.trim();
      this.deps.send({ type: "transcript", text: userText, final: true });
      if (userText.length === 0) {
        this.setState("idle");
        return;
      }

      phase = "llm";
      const recalled = await this.recall(userText);
      if (!this.isCurrent(epoch)) return;

      const messages: ModelMessage[] = [
        {
          role: "system",
          content: buildContextMessage({ now: this.nowDate(), ...(recalled ? { recalled } : {}) }),
        },
        ...this.history,
        { role: "user", content: userText },
      ];
      const tools = this.turnTools();
      const reply = await this.deps.assistant.stream(messages, {
        ...(tools ? { tools } : {}),
        abortSignal: ac.signal,
      });
      let full = "";
      for await (const delta of reply.textStream) {
        if (!this.isCurrent(epoch)) return;
        full += delta;
        if (delta.length > 0) this.deps.send({ type: "reply", text: delta, final: false });
      }
      if (!this.isCurrent(epoch)) return;
      // The model can end on a tool step (or hit the step cap) with no text;
      // speak a fallback rather than an empty reply + silent TTS bracket.
      if (full.trim().length === 0) {
        full = FALLBACK_REPLY;
        this.deps.send({ type: "reply", text: full, final: false });
      }
      this.deps.send({ type: "reply", text: "", final: true });

      phase = "tts";
      this.setState("speaking");
      this.deps.send({ type: "tts_begin", format: this.deps.tts.format });
      try {
        for await (const chunk of this.deps.tts.synthesize(full, { signal: ac.signal })) {
          if (!this.isCurrent(epoch)) break; // break unwinds the engine, reaping Piper
          await this.sendChunk(chunk, ac.signal); // awaits drain, but wakes on abort
        }
      } finally {
        // Always close a bracket we opened, so the device never hangs waiting
        // for the terminator — unless the turn was superseded (then it hushes).
        if (this.isCurrent(epoch)) this.deps.send({ type: "tts_end" });
      }
      if (!this.isCurrent(epoch)) return;

      this.appendHistory(userText, full);
      await this.persist(userText, full);
      this.setState("idle");
    } catch (error) {
      if (!this.isCurrent(epoch)) return; // superseded/closed mid-flight: stay quiet
      this.reportError(phase, error);
      this.deps.send({
        type: "error",
        code: `${phase}_failed`,
        message: "I'm afraid something went wrong, sir.",
      });
      this.setState("idle");
    }
  }

  /** Memory capture/recall + reminder tools available to the model this turn. */
  private turnTools(): ToolSet | undefined {
    const report = (context: string, error: unknown) => this.reportError(context, error);
    let tools: ToolSet = {};
    if (this.deps.memory) {
      tools = { ...tools, ...buildMemoryTools(this.deps.memory, this.deps.groupId, report) };
    }
    if (this.deps.reminders) {
      tools = { ...tools, ...buildReminderTool(this.deps.reminders, () => this.nowDate(), report) };
    }
    return Object.keys(tools).length > 0 ? tools : undefined;
  }

  /** Send one audio chunk, awaiting backpressure drain — but wake immediately if
   * the turn is aborted (barge-in / disconnect) so the loop can break and reap
   * the TTS subprocess instead of stalling until the OS socket buffer drains. */
  private async sendChunk(chunk: Uint8Array, signal: AbortSignal): Promise<void> {
    const pending = this.deps.sendAudio(chunk);
    if (!pending || signal.aborted) return;
    await new Promise<void>((resolve) => {
      const done = (): void => {
        signal.removeEventListener("abort", done);
        resolve();
      };
      signal.addEventListener("abort", done, { once: true });
      pending.then(done, done);
    });
  }

  /** Append the turn to the short-term context window, bounded. */
  private appendHistory(userText: string, assistantText: string): void {
    this.history.push(
      { role: "user", content: userText },
      { role: "assistant", content: assistantText },
    );
    if (this.history.length > MAX_HISTORY) {
      this.history.splice(0, this.history.length - MAX_HISTORY);
    }
  }

  /** GraphRAG recall, best-effort: a memory outage must not break the turn. */
  private async recall(userText: string): Promise<RecallResult[] | undefined> {
    const memory = this.deps.memory;
    if (!memory) return undefined;
    try {
      return await memory.recall({
        text: userText,
        ...(this.deps.groupId ? { groupId: this.deps.groupId } : {}),
      });
    } catch (error) {
      this.reportError("recall", error);
      return undefined;
    }
  }

  /** Append the verbatim turn to the graph, best-effort. */
  private async persist(userText: string, assistantText: string): Promise<void> {
    const memory = this.deps.memory;
    if (!memory) return;
    const groupId = this.deps.groupId;
    try {
      if (this.threadId === undefined) {
        this.threadId = await memory.ensureThread({
          title: "companion",
          ...(groupId ? { groupId } : {}),
        });
      }
      await memory.appendMessage({
        threadId: this.threadId,
        role: "user",
        content: userText,
        ...(groupId ? { groupId } : {}),
      });
      await memory.appendMessage({
        threadId: this.threadId,
        role: "assistant",
        content: assistantText,
        ...(groupId ? { groupId } : {}),
      });
    } catch (error) {
      this.reportError("persist", error);
    }
  }
}

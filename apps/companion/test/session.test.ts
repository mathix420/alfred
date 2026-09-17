import { describe, expect, it } from "bun:test";
import type {
  AssistantLike,
  AssistantReply,
  MemoryLike,
  SpeechToText,
  TextToSpeech,
} from "../src/ports";
import type { ServerMessage } from "../src/protocol";
import { ReminderService } from "../src/reminders";
import { Session, type SessionDeps } from "../src/session";

function fakeAssistant(text: string): AssistantLike {
  return {
    stream: async (): Promise<AssistantReply> => ({
      textStream: (async function* deltas() {
        for (const word of text.split(" ")) yield `${word} `;
      })(),
      text: Promise.resolve(text),
    }),
  };
}

/** An assistant whose first delta is withheld until `release()` is called. */
function gatedAssistant(): { assistant: AssistantLike; release: () => void } {
  let release: (() => void) | undefined;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const assistant: AssistantLike = {
    stream: async (): Promise<AssistantReply> => ({
      textStream: (async function* deltas() {
        await gate;
        yield "hello sir";
      })(),
      text: Promise.resolve("hello sir"),
    }),
  };
  return { assistant, release: () => release?.() };
}

const fakeStt = (text: string): SpeechToText => ({
  transcribe: async () => ({ text }),
});

const fakeTts: TextToSpeech = {
  format: { encoding: "pcm_s16le", sampleRate: 22050, channels: 1 },
  synthesize: async function* one() {
    yield new Uint8Array([1, 2, 3]);
  },
};

function harness(over: Partial<SessionDeps> = {}) {
  const sent: ServerMessage[] = [];
  const audio: Uint8Array[] = [];
  const deps: SessionDeps = {
    assistant: fakeAssistant("Good evening sir"),
    stt: fakeStt("what time is it"),
    tts: fakeTts,
    send: (message) => sent.push(message),
    sendAudio: (chunk) => {
      audio.push(chunk);
    },
    now: () => new Date("2026-06-16T00:00:00.000Z"),
    ...over,
  };
  return { session: new Session(deps), sent, audio };
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("Session push-to-talk turn", () => {
  it("runs idle → listening → thinking → speaking → idle", async () => {
    const { session, sent, audio } = harness();

    session.pttDown();
    expect(session.currentState).toBe("listening");
    session.pushAudio(new Uint8Array([0, 0]));
    await session.pttUp();

    expect(session.currentState).toBe("idle");

    const states = sent.flatMap((m) => (m.type === "state" ? [m.state] : []));
    expect(states).toEqual(["listening", "thinking", "speaking", "idle"]);

    expect(sent.some((m) => m.type === "transcript")).toBe(true);
    expect(sent.some((m) => m.type === "tts_begin")).toBe(true);
    expect(sent.some((m) => m.type === "tts_end")).toBe(true);
    expect(sent.filter((m) => m.type === "reply" && m.final)).toHaveLength(1);
    expect(audio).toHaveLength(1);
  });

  it("short-circuits an empty transcript without answering", async () => {
    const { session, sent } = harness({ stt: fakeStt("   ") });

    session.pttDown();
    await session.pttUp();

    expect(session.currentState).toBe("idle");
    expect(sent.some((m) => m.type === "transcript")).toBe(true);
    expect(sent.some((m) => m.type === "reply")).toBe(false);
    expect(sent.some((m) => m.type === "tts_begin")).toBe(false);
  });

  it("ignores ptt_up when not listening", async () => {
    const { session, sent } = harness();
    await session.pttUp();
    expect(sent).toHaveLength(0);
    expect(session.currentState).toBe("idle");
  });

  it("buffers only listening-window audio and concatenates it in order", async () => {
    let captured: Uint8Array | undefined;
    const stt: SpeechToText = {
      transcribe: async (audio) => {
        captured = audio;
        return { text: "x" };
      },
    };
    const { session } = harness({ stt });

    session.pushAudio(new Uint8Array([9])); // before listening → dropped
    session.pttDown();
    session.pushAudio(new Uint8Array([1, 2]));
    session.pushAudio(new Uint8Array([3]));
    await session.pttUp();

    expect(captured ? Array.from(captured) : []).toEqual([1, 2, 3]);
  });

  it("caps the mic buffer and aborts an over-long utterance", () => {
    const { session, sent } = harness({ maxUtteranceBytes: 8 });

    session.pttDown();
    session.pushAudio(new Uint8Array(5));
    session.pushAudio(new Uint8Array(5)); // 10 > 8 → overflow

    expect(session.currentState).toBe("idle");
    expect(sent.some((m) => m.type === "error" && m.code === "utterance_too_long")).toBe(true);

    const before = sent.length;
    session.pushAudio(new Uint8Array(5)); // ignored after overflow
    expect(sent.length).toBe(before);
  });

  it("awaits a backpressured audio sink before finishing the turn", async () => {
    const tts: TextToSpeech = {
      format: { encoding: "pcm_s16le", sampleRate: 22050, channels: 1 },
      synthesize: async function* two() {
        yield new Uint8Array([1]);
        yield new Uint8Array([2]);
      },
    };
    let delivered = 0;
    const { session, sent } = harness({
      tts,
      sendAudio: () => {
        delivered++;
        return Promise.resolve();
      },
    });

    session.pttDown();
    session.pushAudio(new Uint8Array([0]));
    await session.pttUp();

    expect(delivered).toBe(2);
    expect(sent.some((m) => m.type === "tts_end")).toBe(true);
  });
});

describe("Session failure handling", () => {
  it("recovers to idle with an stt-tagged error when STT fails", async () => {
    const errors: string[] = [];
    const stt: SpeechToText = {
      transcribe: async () => {
        throw new Error("stt boom");
      },
    };
    const { session, sent } = harness({ stt, onError: (context) => errors.push(context) });

    session.pttDown();
    session.pushAudio(new Uint8Array([0]));
    await session.pttUp();

    expect(session.currentState).toBe("idle");
    expect(errors).toContain("stt");
    expect(sent.some((m) => m.type === "error" && m.code === "stt_failed")).toBe(true);
    expect(sent.some((m) => m.type === "tts_begin")).toBe(false);
  });

  it("closes the tts bracket and tags the error when TTS fails mid-stream", async () => {
    const errors: string[] = [];
    const tts: TextToSpeech = {
      format: { encoding: "pcm_s16le", sampleRate: 22050, channels: 1 },
      synthesize: async function* boom() {
        yield new Uint8Array([1]);
        throw new Error("piper boom");
      },
    };
    const { session, sent } = harness({ tts, onError: (context) => errors.push(context) });

    session.pttDown();
    session.pushAudio(new Uint8Array([0]));
    await session.pttUp();

    expect(session.currentState).toBe("idle");
    expect(errors).toContain("tts");
    expect(sent.some((m) => m.type === "tts_begin")).toBe(true);
    expect(sent.some((m) => m.type === "tts_end")).toBe(true); // bracket closed despite failure
    expect(sent.some((m) => m.type === "error" && m.code === "tts_failed")).toBe(true);
  });
});

describe("Session supersession & cancellation", () => {
  it("supersedes an in-flight turn on a new ptt_down without stranding state", async () => {
    const { assistant, release } = gatedAssistant();
    const { session, sent } = harness({ assistant });

    session.pttDown();
    session.pushAudio(new Uint8Array([0]));
    const turn = session.pttUp();
    await tick(); // let turn 1 park awaiting the assistant gate

    session.pttDown(); // barge in: supersede turn 1
    expect(session.currentState).toBe("listening");
    release();
    await turn;

    expect(session.currentState).toBe("listening"); // turn 1 did not clobber back to idle
    expect(sent.some((m) => m.type === "tts_begin")).toBe(false);
    expect(sent.some((m) => m.type === "reply")).toBe(false);
  });

  it("aborts the in-flight STT signal when superseded", async () => {
    let captured: AbortSignal | undefined;
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const stt: SpeechToText = {
      transcribe: async (_audio, opts) => {
        captured = opts.signal;
        await gate;
        return { text: "" };
      },
    };
    const { session } = harness({ stt });

    session.pttDown();
    session.pushAudio(new Uint8Array([0]));
    const turn = session.pttUp();
    await tick();

    expect(captured?.aborted).toBe(false);
    session.pttDown(); // supersede → aborts the in-flight signal
    expect(captured?.aborted).toBe(true);

    release?.();
    await turn;
  });

  it("cancels the in-flight turn on close without emitting further", async () => {
    const { assistant, release } = gatedAssistant();
    const { session, sent } = harness({ assistant });

    session.pttDown();
    session.pushAudio(new Uint8Array([0]));
    const turn = session.pttUp();
    await tick();

    session.close();
    release();
    await turn;

    expect(sent.some((m) => m.type === "tts_begin")).toBe(false);
    expect(sent.some((m) => m.type === "reply" && m.final)).toBe(false);
  });

  it("parks the turn on a backpressured audio sink until it drains", async () => {
    let releaseSink: (() => void) | undefined;
    const tts: TextToSpeech = {
      format: { encoding: "pcm_s16le", sampleRate: 22050, channels: 1 },
      synthesize: async function* one() {
        yield new Uint8Array([1]);
      },
    };
    const { session, sent } = harness({
      tts,
      sendAudio: () =>
        new Promise<void>((resolve) => {
          releaseSink = resolve;
        }),
    });

    session.pttDown();
    session.pushAudio(new Uint8Array([0]));
    const turn = session.pttUp();
    await tick();

    expect(session.currentState).toBe("speaking"); // parked mid-send, not finished
    expect(sent.some((m) => m.type === "tts_end")).toBe(false);

    releaseSink?.();
    await turn;

    expect(session.currentState).toBe("idle");
    expect(sent.some((m) => m.type === "tts_end")).toBe(true);
  });

  it("aborts TTS synthesis on barge-in mid-stream without closing the bracket", async () => {
    let capturedSignal: AbortSignal | undefined;
    let releaseSynth: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      releaseSynth = resolve;
    });
    const tts: TextToSpeech = {
      format: { encoding: "pcm_s16le", sampleRate: 22050, channels: 1 },
      synthesize: (_text, opts) =>
        (async function* gated() {
          capturedSignal = opts?.signal;
          yield new Uint8Array([1]);
          await gate;
          yield new Uint8Array([2]);
        })(),
    };
    const { session, sent } = harness({ tts });

    session.pttDown();
    session.pushAudio(new Uint8Array([0]));
    const turn = session.pttUp();
    await tick(); // reach speaking; first chunk sent; parked at the synth gate

    expect(session.currentState).toBe("speaking");
    session.pttDown(); // barge in
    expect(capturedSignal?.aborted).toBe(true);

    releaseSynth?.();
    await turn;

    expect(session.currentState).toBe("listening");
    expect(sent.some((m) => m.type === "tts_end")).toBe(false); // superseded turn hushes
  });
});

describe("Session tools, telemetry & reminders", () => {
  it("offers memory + reminder tools to the model", async () => {
    let seenTools: Record<string, unknown> | undefined;
    const assistant: AssistantLike = {
      stream: async (_messages, options): Promise<AssistantReply> => {
        seenTools = options?.tools;
        return {
          textStream: (async function* one() {
            yield "ok";
          })(),
          text: Promise.resolve("ok"),
        };
      },
    };
    const memory: MemoryLike = {
      recall: async () => [],
      ensureThread: async () => "t",
      appendMessage: async () => "m",
      remember: async () => "o",
    };
    const { session } = harness({ assistant, memory, reminders: new ReminderService() });

    session.pttDown();
    session.pushAudio(new Uint8Array([0]));
    await session.pttUp();

    expect(Object.keys(seenTools ?? {}).sort()).toEqual(["recall", "remember", "set_reminder"]);
  });

  it("pushes an ambient face reflecting telemetry", () => {
    const { session, sent } = harness();
    session.applyTelemetry({ battery: 80, charging: false });

    const ambient = sent.find((m) => m.type === "ambient");
    expect(ambient).toBeDefined();
    if (ambient && ambient.type === "ambient") {
      expect(ambient.face.battery).toBe(80);
      expect(ambient.face.charging).toBe(false);
    }
  });

  it("syncDevice pushes the reminder list and ambient face", () => {
    const reminders = new ReminderService();
    reminders.add("tea", 1000);
    const { session, sent } = harness({ reminders });

    session.syncDevice();
    expect(sent.some((m) => m.type === "reminders")).toBe(true);
    expect(sent.some((m) => m.type === "ambient")).toBe(true);
  });

  it("resyncs the device when a reminder is added via the service", () => {
    const reminders = new ReminderService();
    const { sent } = harness({ reminders }); // session wires reminders.onChange

    reminders.add("call mum", 5000);
    expect(sent.some((m) => m.type === "reminders")).toBe(true);
    expect(sent.some((m) => m.type === "ambient")).toBe(true);
  });
});

describe("Session memory integration", () => {
  it("recalls before answering and persists the turn after", async () => {
    const calls: string[] = [];
    const memory: MemoryLike = {
      recall: async () => {
        calls.push("recall");
        return [];
      },
      ensureThread: async () => {
        calls.push("ensureThread");
        return "t1";
      },
      appendMessage: async () => {
        calls.push("appendMessage");
        return "m";
      },
      remember: async () => {
        calls.push("remember");
        return "o";
      },
    };

    const { session } = harness({ memory });
    session.pttDown();
    await session.pttUp();

    expect(calls[0]).toBe("recall");
    expect(calls).toContain("ensureThread");
    expect(calls.filter((c) => c === "appendMessage")).toHaveLength(2);
  });

  it("survives a memory outage without stranding the device", async () => {
    const errors: string[] = [];
    const memory: MemoryLike = {
      recall: async () => {
        throw new Error("neo4j down");
      },
      ensureThread: async () => {
        throw new Error("neo4j down");
      },
      appendMessage: async () => "m",
      remember: async () => "o",
    };

    const { session, sent } = harness({ memory, onError: (context) => errors.push(context) });
    session.pttDown();
    await session.pttUp();

    expect(session.currentState).toBe("idle");
    expect(errors).toContain("recall");
    expect(errors).toContain("persist");
    expect(sent.some((m) => m.type === "tts_end")).toBe(true);
  });
});

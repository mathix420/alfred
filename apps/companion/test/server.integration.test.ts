import { afterAll, describe, expect, it } from "bun:test";
import { loadConfig } from "../src/config";
import type { AssistantLike, AssistantReply, SpeechToText, TextToSpeech } from "../src/ports";
import { encodeDeviceMessage, type ParsedServerFrame, parseServerMessage } from "../src/protocol";
import { createCompanionServer, type ServerOverrides } from "../src/server";

const assistant: AssistantLike = {
  stream: async (): Promise<AssistantReply> => ({
    textStream: (async function* deltas() {
      yield "Good ";
      yield "evening.";
    })(),
    text: Promise.resolve("Good evening."),
  }),
};

const stt: SpeechToText = { transcribe: async () => ({ text: "hello alfred" }) };

const tts: TextToSpeech = {
  format: { encoding: "pcm_s16le", sampleRate: 22050, channels: 1 },
  synthesize: async function* one() {
    yield new Uint8Array([1, 2, 3, 4]);
  },
};

const overrides: ServerOverrides = { assistant, stt, tts, memory: null };
const config = { ...loadConfig({}), port: 0 };
const server = await createCompanionServer(config, overrides);
const url = `ws://127.0.0.1:${server.port}`;

afterAll(() => {
  server.stop(true);
});

interface Conn {
  ws: WebSocket;
  control: ParsedServerFrame[];
  frames: () => number;
  waitFor: (pred: () => boolean) => Promise<void>;
}

async function connect(): Promise<Conn> {
  const ws = new WebSocket(url);
  ws.binaryType = "arraybuffer";
  const control: ParsedServerFrame[] = [];
  let binaryFrames = 0;
  const waiters: Array<() => void> = [];

  ws.addEventListener("message", (ev) => {
    if (typeof ev.data === "string") control.push(parseServerMessage(ev.data));
    else binaryFrames++;
    for (const notify of waiters.splice(0)) notify();
  });

  await new Promise<void>((resolve, reject) => {
    ws.addEventListener("open", () => resolve());
    ws.addEventListener("error", () => reject(new Error("websocket error")));
  });

  const waitFor = (pred: () => boolean): Promise<void> =>
    new Promise((resolve) => {
      const check = (): void => {
        if (pred()) resolve();
        else waiters.push(check);
      };
      check();
    });

  return { ws, control, frames: () => binaryFrames, waitFor };
}

const hello = (protocol = 1) => encodeDeviceMessage({ type: "hello", deviceId: "dev1", protocol });

describe("companion server", () => {
  it("greets, replies to ping, and runs a full PTT turn over the wire", async () => {
    const c = await connect();

    c.ws.send(hello());
    c.ws.send(encodeDeviceMessage({ type: "ping" }));
    c.ws.send(encodeDeviceMessage({ type: "ptt_down" }));
    c.ws.send(new Uint8Array([0, 0, 0, 0]));
    c.ws.send(encodeDeviceMessage({ type: "ptt_up" }));

    await c.waitFor(() => c.control.some((m) => m.type === "state" && m.state === "idle"));
    c.ws.close();

    const kinds = c.control.map((m) => m.type);
    expect(kinds).toContain("welcome");
    expect(kinds).toContain("pong");
    expect(kinds).toContain("transcript");
    expect(kinds).toContain("tts_begin");
    expect(kinds).toContain("tts_end");
    expect(c.frames()).toBe(1);
  });

  it("rejects a malformed frame but keeps the connection alive", async () => {
    const c = await connect();
    c.ws.send(hello());
    await c.waitFor(() => c.control.some((m) => m.type === "welcome"));

    c.ws.send("this is not json");
    await c.waitFor(() => c.control.some((m) => m.type === "error" && m.code === "protocol"));

    // The socket survives a protocol error: a subsequent valid frame still works.
    c.ws.send(encodeDeviceMessage({ type: "ping" }));
    await c.waitFor(() => c.control.some((m) => m.type === "pong"));
    c.ws.close();
  });

  it("refuses an unsupported protocol version and does not welcome", async () => {
    const c = await connect();
    c.ws.send(hello(999));

    await c.waitFor(() =>
      c.control.some((m) => m.type === "error" && m.code === "protocol_version"),
    );
    expect(c.control.some((m) => m.type === "welcome")).toBe(false);
    c.ws.close();
  });

  it("requires a hello handshake before honouring ptt frames", async () => {
    const c = await connect();
    c.ws.send(encodeDeviceMessage({ type: "ptt_down" })); // no hello yet

    await c.waitFor(() =>
      c.control.some((m) => m.type === "error" && m.code === "handshake_required"),
    );
    c.ws.close();
  });

  it("gives concurrent connections distinct session ids", async () => {
    const a = await connect();
    const b = await connect();
    a.ws.send(hello());
    b.ws.send(hello());

    await a.waitFor(() => a.control.some((m) => m.type === "welcome"));
    await b.waitFor(() => b.control.some((m) => m.type === "welcome"));

    const idA = a.control.find((m) => m.type === "welcome")?.sessionId;
    const idB = b.control.find((m) => m.type === "welcome")?.sessionId;
    expect(idA).toBeDefined();
    expect(idA).not.toBe(idB);

    a.ws.close();
    b.ws.close();
  });

  it("pushes an ambient face reflecting telemetry", async () => {
    const c = await connect();
    c.ws.send(hello());
    await c.waitFor(() => c.control.some((m) => m.type === "welcome"));

    c.ws.send(encodeDeviceMessage({ type: "telemetry", battery: 77, charging: true }));
    await c.waitFor(() =>
      c.control.some((m) => {
        const face = m.face as { battery?: number } | undefined;
        return m.type === "ambient" && face?.battery === 77;
      }),
    );
    c.ws.close();
  });
});

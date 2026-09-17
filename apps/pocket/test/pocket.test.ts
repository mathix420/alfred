import { afterEach, describe, expect, it } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadPocketConfig } from "../src/config";
import { HttpHermesAdapter, type HermesAdapter, type HermesFetch } from "../src/hermes";
import { createPocketServer, type PocketApplication } from "../src/server";
import { demoTasks, TaskStore } from "../src/tasks";
import { parseTaskList, type TaskList } from "../src/types";

const config = () => ({ ...loadPocketConfig({}), port: 0, dataFile: null });
const applications: PocketApplication[] = [];
const temporary: string[] = [];

afterEach(async () => {
  for (const app of applications.splice(0)) await app.stop();
  for (const path of temporary.splice(0)) await rm(path, { recursive: true, force: true });
});

async function start(
  overrides: Parameters<typeof createPocketServer>[1] = {},
): Promise<PocketApplication> {
  const app = await createPocketServer(config(), { poll: false, ...overrides });
  applications.push(app);
  return app;
}

function fakeAdapter(overrides: Partial<HermesAdapter> = {}): HermesAdapter {
  return {
    readTasks: async () => demoTasks(),
    completeTask: async (task) => {
      const list = demoTasks();
      list.tasks = list.tasks.map((item) =>
        item.id === task.id ? { ...item, completed: true } : item,
      );
      list.focusId = list.tasks.find((item) => !item.completed)?.id ?? null;
      return list;
    },
    chat: async () => "A real reply from the test adapter.",
    ...overrides,
  };
}

const base = (app: PocketApplication) => `http://127.0.0.1:${app.server.port}`;

describe("pocket configuration and validation", () => {
  it("starts in demo with no API keys and only exposes configuration booleans", async () => {
    const app = await start();
    const status = await (await fetch(`${base(app)}/api/status`)).json();
    expect(status).toEqual({
      mode: "demo",
      requestTimeoutMs: 60000,
      voiceTransport: "demo",
      configured: { hermes: false, todomate: false, speechToText: false, textToSpeech: false },
    });
    const snapshot = await (await fetch(`${base(app)}/api/focus`)).json();
    expect(snapshot.mode).toBe("demo");
    expect(snapshot.connection).toBe("unconfigured");
    expect(snapshot.focusId).toBe("investor-demo");
  });

  it("rejects malformed ports, credential-bearing URLs, and invalid focus references", () => {
    expect(() => loadPocketConfig({ ALFRED_POCKET_PORT: "2e3" })).toThrow();
    expect(() =>
      loadPocketConfig({ ALFRED_HERMES_BASE_URL: "https://user:secret@example.com" }),
    ).toThrow();
    expect(() => parseTaskList({ ...demoTasks(), focusId: "not-a-task" })).toThrow();
    const duplicate = demoTasks();
    duplicate.tasks.push(duplicate.tasks[0]!);
    expect(() => parseTaskList(duplicate)).toThrow();
  });

  it("rejects cross-origin mutations and does not leak unknown upstream errors", async () => {
    const app = await start({
      adapter: fakeAdapter({
        chat: async () => {
          throw new Error("Bearer secret-should-not-leak");
        },
      }),
    });
    const rejected = await fetch(`${base(app)}/api/chat`, {
      method: "POST",
      headers: { Origin: "https://evil.example" },
      body: JSON.stringify({ text: "hello" }),
    });
    expect(rejected.status).toBe(403);
    const failed = await fetch(`${base(app)}/api/chat`, {
      method: "POST",
      body: JSON.stringify({ text: "hello" }),
    });
    expect(failed.status).toBe(503);
    expect(await failed.text()).not.toContain("secret-should-not-leak");
  });
});

describe("task completion and persistence", () => {
  it("persists demo completion across restarts and rejects request ID reuse", async () => {
    const directory = await mkdtemp(join(tmpdir(), "alfred-pocket-"));
    temporary.push(directory);
    const path = join(directory, "tasks.json");
    const first = new TaskStore(null, path);
    await first.initialize();
    await first.complete("investor-demo", "request-1");
    const restored = new TaskStore(null, path);
    await restored.initialize();
    const revision = restored.snapshot().revision;
    await restored.complete("investor-demo", "request-1");
    expect(restored.snapshot().revision).toBe(revision);
    expect(restored.snapshot().focusId).toBe("walk");
    await expect(restored.complete("term-sheet", "request-1")).rejects.toThrow("another task");
  });

  it("advances the demo in canvas focus order and ends with no task", async () => {
    const store = new TaskStore(null, null);
    const ids = ["investor-demo", "walk", "term-sheet", "notary"];
    for (const id of ids) {
      expect(store.snapshot().focusId).toBe(id);
      await store.complete(id, `complete-${id}`);
    }
    expect(store.snapshot().focusId).toBeNull();
    expect(store.snapshot().tasks.every((task) => task.completed)).toBe(true);
  });

  it("serializes in-flight polling and completion, preventing stale reads from restoring completed tasks", async () => {
    let release: ((list: TaskList) => void) | undefined;
    let reads = 0;
    let completions = 0;
    const adapter = fakeAdapter({
      readTasks: async () => {
        reads++;
        if (reads === 2)
          return new Promise<TaskList>((resolve) => {
            release = resolve;
          });
        return demoTasks();
      },
      completeTask: async (task) => {
        completions++;
        return fakeAdapter().completeTask(task, "test");
      },
    });
    const store = new TaskStore(adapter, null);
    await store.refresh();
    const polling = store.refresh();
    await Promise.resolve();
    const completion = store.complete("investor-demo", "req-a");
    const duplicate = store.complete("investor-demo", "req-a");
    release!(demoTasks());
    await Promise.all([polling, completion, duplicate]);
    await store.refresh();
    expect(completions).toBe(1);
    expect(store.snapshot().tasks.find((task) => task.id === "investor-demo")?.completed).toBe(
      true,
    );
    expect(store.snapshot().focusId).toBe("term-sheet");
  });

  it("keeps tasks when Hermes completion fails", async () => {
    const store = new TaskStore(
      fakeAdapter({
        completeTask: async () => {
          throw new Error("upstream failure");
        },
      }),
      null,
    );
    await store.refresh();
    await expect(store.complete("investor-demo", "req-fail")).rejects.toThrow();
    expect(store.snapshot().focusId).toBe("investor-demo");
    expect(store.snapshot().tasks[0]?.completed).toBe(false);
    expect(store.snapshot().connection).toBe("offline");
  });

  it("does not count a failed disk write as a successful completion", async () => {
    const directory = await mkdtemp(join(tmpdir(), "alfred-pocket-"));
    temporary.push(directory);
    const store = new TaskStore(null, directory);
    await expect(store.complete("investor-demo", "disk-fail")).rejects.toThrow("save");
    expect(store.snapshot().tasks[0]?.completed).toBe(false);
  });
});

describe("Hermes adapter", () => {
  it("uses the official authenticated chat endpoint and validates persisted completion", async () => {
    const requests: Request[] = [];
    let payload: unknown = demoTasks();
    const fetcher = (async (url: string | URL | Request, init?: RequestInit) => {
      requests.push(new Request(url, init));
      return Response.json({ choices: [{ message: { content: JSON.stringify(payload) } }] });
    }) as HermesFetch;
    const adapter = new HttpHermesAdapter(
      { ...config(), hermesBaseUrl: "https://hermes.example/v1", hermesApiKey: "test-secret" },
      fetcher,
    );
    await adapter.readTasks();
    expect(requests[0]?.url).toBe("https://hermes.example/v1/chat/completions");
    expect(requests[0]?.headers.get("authorization")).toBe("Bearer test-secret");
    await expect(adapter.completeTask(demoTasks().tasks[0]!, "request-1")).rejects.toThrow(
      "confirm",
    );
    const list = await fakeAdapter().completeTask(demoTasks().tasks[0]!, "request-1");
    payload = { ...list, persisted: true, completedTaskId: "investor-demo" };
    expect(
      (await adapter.completeTask(demoTasks().tasks[0]!, "request-1")).tasks[0]?.completed,
    ).toBe(true);
  });

  it("sanitizes provider error bodies and cancels HTTP work", async () => {
    const failing = new HttpHermesAdapter(
      { ...config(), hermesBaseUrl: "https://hermes.example", hermesApiKey: "test-secret" },
      (async () => new Response("secret provider trace", { status: 500 })) as HermesFetch,
    );
    await expect(failing.chat("hello")).rejects.toThrow("Hermes is unavailable");
    let aborted = false;
    const cancellable = new HttpHermesAdapter(
      { ...config(), hermesBaseUrl: "https://hermes.example", hermesApiKey: "test-secret" },
      (async (_url: unknown, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => {
            aborted = true;
            reject(new Error("aborted"));
          });
        })) as HermesFetch,
    );
    const controller = new AbortController();
    const pending = cancellable.chat("hello", controller.signal);
    controller.abort();
    await expect(pending).rejects.toThrow("cancelled");
    expect(aborted).toBe(true);
  });
});

interface Connection {
  ws: WebSocket;
  messages: Record<string, unknown>[];
  audio: Uint8Array[];
  waitFor(predicate: (messages: Record<string, unknown>[]) => boolean): Promise<void>;
}

async function connect(app: PocketApplication): Promise<Connection> {
  const ws = new WebSocket(`${base(app).replace("http", "ws")}/ws`);
  ws.binaryType = "arraybuffer";
  const messages: Record<string, unknown>[] = [];
  const audio: Uint8Array[] = [];
  ws.addEventListener("message", (event) => {
    if (typeof event.data === "string") messages.push(JSON.parse(event.data));
    else if (event.data instanceof ArrayBuffer) audio.push(new Uint8Array(event.data));
  });
  await new Promise<void>((resolve, reject) => {
    ws.addEventListener("open", () => resolve(), { once: true });
    ws.addEventListener("error", () => reject(new Error("socket failed")), { once: true });
  });
  return {
    ws,
    messages,
    audio,
    async waitFor(predicate) {
      const deadline = Date.now() + 2500;
      while (!predicate(messages)) {
        if (Date.now() > deadline) throw new Error(`Socket timed out: ${JSON.stringify(messages)}`);
        await Bun.sleep(5);
      }
    },
  };
}

const send = (connection: Connection, message: unknown) =>
  connection.ws.send(JSON.stringify(message));

describe("pocket WebSocket", () => {
  it("requires a handshake and acknowledges completion before publishing the next focus", async () => {
    const app = await start();
    const client = await connect(app);
    send(client, { type: "complete_task", id: "investor-demo", requestId: "a" });
    await client.waitFor((frames) => frames.some((frame) => frame.code === "handshake_required"));
    send(client, { type: "hello", protocol: 2, deviceId: "test-device" });
    await client.waitFor((frames) => frames.some((frame) => frame.type === "focus"));
    client.messages.length = 0;
    send(client, { type: "complete_task", id: "investor-demo", requestId: "a" });
    await client.waitFor((frames) => frames.some((frame) => frame.type === "focus"));
    expect(client.messages[0]?.type).toBe("task_completed");
    expect(client.messages[0]?.requestId).toBe("a");
    expect((client.messages[1]!.snapshot as { focusId: string }).focusId).toBe("walk");
    client.ws.close();
  });

  it("cancel aborts active transcription without emitting a late reply", async () => {
    let started = false;
    let aborted = false;
    const app = await start({
      adapter: fakeAdapter(),
      stt: {
        transcribe: async (_audio, options) => {
          started = true;
          return new Promise((_resolve, reject) =>
            options.signal?.addEventListener("abort", () => {
              aborted = true;
              reject(new Error("aborted"));
            }),
          );
        },
      },
    });
    const client = await connect(app);
    send(client, { type: "hello", protocol: 2, deviceId: "test-device" });
    send(client, { type: "ptt_down", sampleRate: 16000, channels: 1 });
    client.ws.send(new Uint8Array([0, 0, 0, 0]));
    send(client, { type: "ptt_up" });
    await client.waitFor(() => started);
    send(client, { type: "cancel" });
    await client.waitFor(() => aborted);
    expect(client.messages.some((frame) => frame.type === "reply")).toBe(false);
    expect(client.messages.at(-1)?.state).toBe("idle");
    client.ws.close();
  });

  it("keeps a successful live text-only voice reply visible until cancelled", async () => {
    const app = await start({
      adapter: fakeAdapter(),
      stt: { transcribe: async () => ({ text: "What should I do next?" }) },
    });
    const client = await connect(app);
    send(client, { type: "hello", protocol: 2, deviceId: "text-only-device" });
    send(client, { type: "ptt_down", sampleRate: 16000, channels: 1 });
    client.ws.send(new Uint8Array([0, 0, 0, 0]));
    send(client, { type: "ptt_up" });
    await client.waitFor((frames) => frames.some((frame) => frame.state === "speaking"));
    await Bun.sleep(75);
    expect(
      client.messages.some(
        (frame) =>
          frame.type === "reply" &&
          frame.final === true &&
          frame.text === "A real reply from the test adapter.",
      ),
    ).toBe(true);
    expect(client.messages.some((frame) => frame.type === "error")).toBe(false);
    expect(client.messages.some((frame) => frame.state === "idle")).toBe(false);
    send(client, { type: "cancel" });
    await client.waitFor((frames) => frames.some((frame) => frame.state === "idle"));
    expect(client.messages.at(-1)?.state).toBe("idle");
    client.ws.close();
  });

  it("preserves PCM16 samples across arbitrary TTS subprocess chunks", async () => {
    const app = await start({
      adapter: fakeAdapter(),
      stt: { transcribe: async () => ({ text: "hello" }) },
      tts: {
        format: { encoding: "pcm_s16le", sampleRate: 22050, channels: 1 },
        synthesize: async function* () {
          yield new Uint8Array([1]);
          yield new Uint8Array([2, 3, 4]);
        },
      },
    });
    const client = await connect(app);
    send(client, { type: "hello", protocol: 2, deviceId: "audio-device" });
    send(client, { type: "ptt_down", sampleRate: 16000, channels: 1 });
    client.ws.send(new Uint8Array([0, 0]));
    send(client, { type: "ptt_up" });
    await client.waitFor((frames) => frames.some((frame) => frame.type === "tts_end"));
    expect(client.audio.map((chunk) => [...chunk])).toEqual([[1, 2, 3, 4]]);
    expect(client.messages.find((frame) => frame.type === "tts_start")?.format).toEqual({
      codec: "pcm_s16le",
      sampleRate: 22050,
      channels: 1,
    });
    expect(client.messages.some((frame) => frame.type === "error")).toBe(false);
    client.ws.close();
  });

  it("caps recording length and returns to idle", async () => {
    const app = await start();
    const client = await connect(app);
    send(client, { type: "hello", protocol: 2, deviceId: "test-device" });
    send(client, { type: "ptt_down", sampleRate: 16000, channels: 1 });
    client.ws.send(new Uint8Array(960002));
    await client.waitFor((frames) => frames.some((frame) => frame.code === "utterance_too_long"));
    expect(client.messages.some((frame) => frame.state === "idle")).toBe(true);
    client.ws.close();
  });
});

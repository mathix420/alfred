import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { loadPocketConfig } from "../src/config";
import { createPocketServer, type PocketApplication } from "../src/server";
import { demoTasks } from "../src/tasks";
import { fitDeviceText, parseTaskList } from "../src/types";

// Firmware tests remain optional for contributors without the ESP-IDF toolchain.
// CI can set CJSON_SOURCE_DIR to any official cJSON source checkout.
const candidates = [
  process.env.CJSON_SOURCE_DIR,
  process.env.IDF_PATH && join(process.env.IDF_PATH, "components/json/cJSON"),
  join(
    process.env.PLATFORMIO_CORE_DIR || join(homedir(), ".platformio"),
    "packages/framework-espidf/components/json/cJSON",
  ),
].filter((path): path is string => Boolean(path));
const cjson = candidates.find(
  (path) => existsSync(join(path, "cJSON.c")) && existsSync(join(path, "cJSON.h")),
);
const compiler = Bun.which("cc") ?? Bun.which("clang") ?? Bun.which("gcc");
const available = Boolean(cjson && compiler);
const contract = available ? describe : describe.skip;

contract("Bun ↔ ESP32 C wire contract (requires cc and official cJSON source)", () => {
  let directory = "";
  let binary = "";
  let app: PocketApplication | undefined;

  beforeAll(async () => {
    directory = await mkdtemp(join(tmpdir(), "pocket-protocol-"));
    binary = join(directory, "protocol-harness");
    const protocol = resolve(import.meta.dir, "../../companion/firmware/src/net");
    const process = Bun.spawn(
      [
        compiler!,
        "-std=gnu11",
        "-Wall",
        "-Wextra",
        "-Werror",
        "-I",
        protocol,
        "-I",
        cjson!,
        resolve(import.meta.dir, "fixtures/protocol-harness.c"),
        join(protocol, "protocol.c"),
        join(cjson!, "cJSON.c"),
        "-lm",
        "-o",
        binary,
      ],
      { stdout: "pipe", stderr: "pipe" },
    );
    const [code, stderr] = await Promise.all([process.exited, new Response(process.stderr).text()]);
    if (code !== 0) throw new Error(`Firmware protocol harness failed to compile: ${stderr}`);
  });

  afterAll(async () => {
    await app?.stop();
    if (directory) await rm(directory, { recursive: true, force: true });
  });

  async function parse(frame: unknown, raw = false): Promise<Record<string, unknown>> {
    const process = Bun.spawn([binary], {
      stdin: new Blob([raw ? String(frame) : JSON.stringify(frame)]),
      stdout: "pipe",
      stderr: "pipe",
    });
    const [code, output, stderr] = await Promise.all([
      process.exited,
      new Response(process.stdout).text(),
      new Response(process.stderr).text(),
    ]);
    if (code !== 0) throw new Error(`Firmware parser exited ${code}: ${stderr}`);
    return JSON.parse(output) as Record<string, unknown>;
  }

  it("parses actual Bun hello, task snapshot, acknowledgement, voice and error frames", async () => {
    app = await createPocketServer(
      { ...loadPocketConfig({}), port: 0, dataFile: null },
      {
        poll: false,
        adapter: {
          readTasks: async () => demoTasks(),
          completeTask: async (task) => {
            const list = demoTasks();
            list.tasks = list.tasks.map((item) =>
              item.id === task.id ? { ...item, completed: true } : item,
            );
            list.focusId = "walk";
            return list;
          },
          chat: async () => "Léa, focus on your investor demo.",
        },
        stt: { transcribe: async () => ({ text: "What should I do?" }) },
        tts: {
          format: { encoding: "pcm_s16le", sampleRate: 22050, channels: 1 },
          synthesize: async function* () {
            yield new Uint8Array([0, 0]);
          },
        },
      },
    );
    await app.store.refresh();
    const ws = new WebSocket(`ws://127.0.0.1:${app.server.port}/ws`);
    const frames: Record<string, unknown>[] = [];
    ws.onmessage = (event) => {
      if (typeof event.data === "string") frames.push(JSON.parse(event.data));
    };
    await new Promise<void>((resolve, reject) => {
      ws.onopen = () => resolve();
      ws.onerror = () => reject(new Error("socket failed"));
    });
    const send = (value: unknown) => ws.send(JSON.stringify(value));
    const wait = async (predicate: () => boolean) => {
      const deadline = Date.now() + 2000;
      while (!predicate()) {
        if (Date.now() > deadline) throw new Error("Wire contract socket timed out");
        await Bun.sleep(5);
      }
    };
    try {
      send({ type: "hello", protocol: 2, deviceId: "contract-device" });
      await wait(() => frames.some((frame) => frame.type === "focus"));
      const hello = frames.find((frame) => frame.type === "hello")!;
      expect(await parse(hello)).toEqual({
        result: "ok",
        type: "hello",
        protocol: 2,
        sessionId: hello.sessionId,
      });
      const focus = frames.find((frame) => frame.type === "focus")!;
      const snapshot = app.store.snapshot();
      expect(await parse(focus)).toEqual({
        result: "ok",
        type: "focus",
        focusId: snapshot.focusId,
        revision: snapshot.revision,
        demo: false,
        online: true,
        configured: true,
        tasks: snapshot.tasks.map((task) => ({ ...task, dueAt: task.dueAt ?? "" })),
      });
      send({ type: "complete_task", id: "investor-demo", requestId: "contract-complete" });
      await wait(() => frames.some((frame) => frame.type === "task_completed"));
      expect(await parse(frames.find((frame) => frame.type === "task_completed"))).toEqual({
        result: "ok",
        type: "task_completed",
        id: "investor-demo",
        requestId: "contract-complete",
      });
      send({ type: "ptt_down", sampleRate: 16000, channels: 1 });
      ws.send(new Uint8Array([0, 0]));
      send({ type: "ptt_up" });
      await wait(() => frames.some((frame) => frame.type === "tts_end"));
      expect(await parse(frames.find((frame) => frame.type === "tts_start"))).toEqual({
        result: "ok",
        type: "tts_start",
        codec: "pcm_s16le",
        sampleRate: 22050,
        channels: 1,
      });
      expect(await parse(frames.find((frame) => frame.type === "reply"))).toEqual({
        result: "ok",
        type: "reply",
        text: "Léa, focus on your investor demo.",
        final: true,
      });
      send({ type: "complete_task", id: "unknown-task", requestId: "contract-error" });
      await wait(() => frames.some((frame) => frame.type === "error"));
      const error = frames.find((frame) => frame.type === "error")!;
      expect(await parse(error)).toEqual({ result: "ok", ...error });
    } finally {
      ws.close();
    }
  });

  it("preserves maximum-size Unicode fields, all 16 tasks, and empty focus snapshots", async () => {
    const tasks = Array.from({ length: 16 }, (_, index) => ({
      id: `task-${index}-${"a".repeat(50)}`,
      title: `${"é".repeat(95)}x`,
      category: "work" as const,
      memo: "é".repeat(600),
      dueAt: "2026-09-17T16:15:00.000+02:00",
      completed: false,
    }));
    const list = parseTaskList({ tasks, focusId: tasks[0]!.id });
    const frame = {
      type: "focus",
      snapshot: { ...list, revision: 42, mode: "demo", connection: "unconfigured" },
    };
    const parsed = await parse(frame);
    expect(parsed.result).toBe("ok");
    expect(parsed.tasks).toEqual(tasks);
    expect(parsed.demo).toBe(true);
    expect(parsed.configured).toBe(false);
    const empty = await parse({
      type: "focus",
      snapshot: { tasks: [], focusId: null, revision: 43, mode: "live", connection: "offline" },
    });
    expect(empty.tasks).toEqual([]);
    expect(empty.focusId).toBe("");
    expect(empty.online).toBe(false);
    const reply = fitDeviceText("é🙂".repeat(1000));
    expect(new TextEncoder().encode(reply).length).toBeLessThanOrEqual(3071);
    expect(await parse({ type: "reply", text: reply, final: true })).toEqual({
      result: "ok",
      type: "reply",
      text: reply,
      final: true,
    });
  });

  it("rejects malformed controls and snapshots over the firmware task limit", async () => {
    expect((await parse("not json", true)).result).toBe("bad_json");
    expect((await parse({ type: "state", state: "unknown" })).result).toBe("bad_field");
    expect(
      (await parse({ type: "tts_start", format: { codec: "mp3", sampleRate: 22050, channels: 1 } }))
        .result,
    ).toBe("bad_field");
    const tasks = Array.from({ length: 17 }, (_, index) => ({
      ...demoTasks().tasks[0]!,
      id: `task-${index}`,
    }));
    expect(
      (
        await parse({
          type: "focus",
          snapshot: {
            tasks,
            focusId: "task-0",
            revision: 0,
            mode: "demo",
            connection: "unconfigured",
          },
        })
      ).result,
    ).toBe("bad_field");
  });
});

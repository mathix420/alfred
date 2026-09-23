import { afterEach, describe, expect, it } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TaskStore, demoTasks } from "../src/tasks";
import { TodoMateApiAdapter } from "../src/todomate";
import { parseTaskList, type TaskList } from "../src/types";
import { loadPocketConfig } from "../src/config";
import { createPocketServer, type PocketApplication } from "../src/server";
import { authenticatedSocket } from "./fixtures/matrix-transport";
const temporary: string[] = [];
const apps: PocketApplication[] = [];
afterEach(async () => {
  for (const app of apps.splice(0)) await app.stop();
  for (const path of temporary.splice(0)) await rm(path, { recursive: true, force: true });
});
async function dataFile() {
  const directory = await mkdtemp(join(tmpdir(), "alfred-actions-"));
  temporary.push(directory);
  return join(directory, "tasks.json");
}
const upstreamTask = (extra: object = {}) => ({
  id: "todo",
  title: "Fixture task",
  goalId: "g",
  memo: "",
  dueAt: null,
  completed: false,
  timer: null,
  spentTimeSeconds: null,
  ...extra,
});
const goals = [{ id: "g", title: "Fixture list", color: 0xffaabbcc }];
const apiConfig = { baseUrl: "http://fixture.invalid", accessToken: "fixture-token" };

describe("reopen and timer task actions", () => {
  it("confirms each new complete/reopen request upstream even when stale cache already has its target state", async () => {
    let upstreamDone = false;
    let writes = 0;
    const adapter = new TodoMateApiAdapter(apiConfig, async (_url, init) => {
      if (init.method === "POST") {
        upstreamDone = JSON.parse(String(init.body)).completed;
        writes++;
        return Response.json({ task: upstreamTask({ completed: upstreamDone }) });
      }
      return Response.json({ goals, tasks: [upstreamTask({ completed: upstreamDone })] });
    });
    const store = new TaskStore(adapter, null);
    await store.refresh();
    upstreamDone = true; // Another client completed it after Alfred's pending snapshot.
    await store.reopen("todo", "new-reopen");
    expect(upstreamDone).toBe(false);
    expect(writes).toBe(1);
    await store.complete("todo", "first-complete");
    upstreamDone = false; // Another client reopened it after Alfred's completed snapshot.
    await store.complete("todo", "new-complete");
    expect(upstreamDone).toBe(true);
    expect(writes).toBe(3);
    await store.complete("todo", "new-complete");
    expect(writes).toBe(3);
  });
  it("preserves connection and checked state on sanitized upstream conflicts", async () => {
    const adapter = new TodoMateApiAdapter(apiConfig, async (_url, init) =>
      init.method === "POST"
        ? new Response("private upstream details", { status: 409 })
        : Response.json({ goals, tasks: [upstreamTask({ completed: true })] }),
    );
    const store = new TaskStore(adapter, null);
    await store.refresh();
    await expect(store.reopen("todo", "conflict")).rejects.toMatchObject({
      code: "task_conflict",
      status: 409,
      message: "Task changed or action unavailable. Refresh and try again.",
    });
    expect(store.snapshot().connection).toBe("online");
    expect(store.snapshot().tasks[0]?.completed).toBe(true);
  });

  it("bounds imported accumulated time for display without changing upstream values", async () => {
    const source = upstreamTask({
      timer: { startedAt: null, elapsedSeconds: 80000 },
      spentTimeSeconds: 90000,
    });
    const adapter = new TodoMateApiAdapter(apiConfig, async () =>
      Response.json({ goals, tasks: [source] }),
    );
    const result = await adapter.readTasks();
    expect(result.tasks[0]).toMatchObject({
      timer: { startedAt: null, elapsedSeconds: 72000 },
      spentTimeSeconds: 72000,
    });
    expect(source).toMatchObject({ timer: { elapsedSeconds: 80000 } });
  });
  it("durably reopens a default completed demo task and rejects IDs reused across actions", async () => {
    const file = await dataFile();
    const store = new TaskStore(null, file);
    await store.reopen("eat-fruit", "reopen-once");
    await store.complete("eat-fruit", "complete-once");
    const revision = store.snapshot().revision;
    await store.reopen("eat-fruit", "reopen-once");
    expect(store.snapshot().revision).toBe(revision);
    expect(store.snapshot().tasks.find((t) => t.id === "eat-fruit")?.completed).toBe(true);
    await expect(store.complete("eat-fruit", "reopen-once")).rejects.toMatchObject({
      code: "request_conflict",
    });
    await store.reopen("eat-fruit", "reopen-again");
    const restored = new TaskStore(null, file);
    await restored.initialize();
    expect(restored.snapshot().tasks.find((t) => t.id === "eat-fruit")?.completed).toBe(false);
    await expect(restored.updateTimer("eat-fruit", "reopen-again", "start")).rejects.toMatchObject({
      code: "request_conflict",
    });
    await restored.complete("eat-fruit", "new-completion");
    expect(restored.snapshot().tasks.find((t) => t.id === "eat-fruit")?.completed).toBe(true);
  });

  it("migrates legacy completion request tuples without replaying their writes", async () => {
    const file = await dataFile();
    const store = new TaskStore(null, file);
    await store.complete("investor-demo", "old-request");
    const saved = JSON.parse(await readFile(file, "utf8"));
    saved.requests = [["old-request", "investor-demo"]];
    await Bun.write(file, JSON.stringify(saved));
    const restored = new TaskStore(null, file);
    await restored.initialize();
    const before = restored.snapshot().revision;
    await restored.complete("investor-demo", "old-request");
    expect(restored.snapshot().revision).toBe(before);
    await expect(restored.reopen("investor-demo", "old-request")).rejects.toMatchObject({
      code: "request_conflict",
    });
  });

  it("persists start/pause/resume/stop and never restarts a paused timer for a replayed start ID", async () => {
    const file = await dataFile();
    let store = new TaskStore(null, file);
    await store.updateTimer("investor-demo", "start-once", "start");
    const startedAt = store.snapshot().tasks[0]!.timer!.startedAt;
    expect(startedAt).toBeString();
    await store.updateTimer("investor-demo", "pause-once", "pause");
    await store.updateTimer("investor-demo", "start-once", "start");
    expect(store.snapshot().tasks[0]!.timer?.startedAt).toBeNull();
    store = new TaskStore(null, file);
    await store.initialize();
    expect(store.snapshot().tasks[0]!.timer?.startedAt).toBeNull();
    await expect(store.updateTimer("investor-demo", "pause-once", "stop")).rejects.toMatchObject({
      code: "request_conflict",
    });
    await store.updateTimer("investor-demo", "resume-once", "start");
    expect(store.snapshot().tasks[0]!.timer?.startedAt).toBeString();
    await store.updateTimer("investor-demo", "stop-once", "stop");
    const completed = store.snapshot().tasks[0]!;
    expect(completed.completed).toBe(true);
    expect(completed.timer).toBeNull();
    expect(completed.spentTimeSeconds).toBeNumber();
    const revision = store.snapshot().revision;
    await store.updateTimer("investor-demo", "stop-once", "stop");
    expect(store.snapshot().revision).toBe(revision);
    await expect(
      store.updateTimer("investor-demo", "invalid-start", "start"),
    ).rejects.toMatchObject({ code: "task_completed" });
    await expect(store.updateTimer("walk", "invalid-stop", "stop")).rejects.toMatchObject({
      code: "timer_missing",
    });
  });

  it("only unticks after a matching confirmed upstream write, preserving checked state on errors", async () => {
    let succeed = false,
      listOffline = false;
    const calls: unknown[] = [];
    const adapter = new TodoMateApiAdapter(apiConfig, async (url, init) => {
      if (init.method === "POST") {
        expect(url).toBe("http://fixture.invalid/api/tasks/todo/complete");
        expect(JSON.parse(String(init.body))).toEqual({ completed: false });
        calls.push(new Headers(init.headers).get("Idempotency-Key"));
        if (!succeed) return Response.json({ task: upstreamTask({ completed: true }) });
        listOffline = true;
        return Response.json({ task: upstreamTask({ completed: false }) });
      }
      if (listOffline) throw new Error("fixture list offline");
      return Response.json({ goals, tasks: [upstreamTask({ completed: true })] });
    });
    const store = new TaskStore(adapter, await dataFile());
    await store.refresh();
    let acknowledgements = 0;
    await expect(store.reopen("todo", "first", () => acknowledgements++)).rejects.toThrow(
      "could not confirm",
    );
    expect(acknowledgements).toBe(0);
    expect(store.snapshot().tasks[0]?.completed).toBe(true);
    succeed = true;
    await store.reopen("todo", "second", () => acknowledgements++);
    await store.reopen("todo", "second", () => acknowledgements++);
    expect(acknowledgements).toBe(2);
    expect(calls).toEqual(["first", "second"]);
    expect(store.snapshot().tasks[0]?.completed).toBe(false);
    expect(store.snapshot().categories?.[0]?.id).toBe("g");
  });

  it("maps timer REST actions and honors confirmed time when the follow-up read is stale", async () => {
    let post = 0;
    const adapter = new TodoMateApiAdapter(apiConfig, async (url, init) => {
      if (init.method !== "POST") return Response.json({ goals, tasks: [upstreamTask()] });
      expect(url).toBe("http://fixture.invalid/api/tasks/todo/timer");
      const action = JSON.parse(String(init.body)).action;
      expect(new Headers(init.headers).get("Idempotency-Key")).toBe(`timer-${++post}`);
      return Response.json({
        task: upstreamTask(
          action === "stop"
            ? { completed: true, timer: null, spentTimeSeconds: 49 }
            : {
                timer: {
                  startedAt: action === "start" ? "2026-09-23T14:00:00+02:00" : null,
                  elapsedSeconds: action === "start" ? 42 : 49,
                },
              },
        ),
      });
    });
    const store = new TaskStore(adapter, null);
    await store.refresh();
    await store.updateTimer("todo", "timer-1", "start");
    expect(store.snapshot().tasks[0]!.timer).toEqual({
      startedAt: "2026-09-23T12:00:00.000Z",
      elapsedSeconds: 42,
    });
    await store.updateTimer("todo", "timer-2", "pause");
    expect(store.snapshot().tasks[0]!.timer).toEqual({ startedAt: null, elapsedSeconds: 49 });
    await store.updateTimer("todo", "timer-3", "stop");
    expect(store.snapshot().tasks[0]).toMatchObject({
      completed: true,
      timer: null,
      spentTimeSeconds: 49,
    });
    await store.updateTimer("todo", "timer-3", "stop");
    expect(post).toBe(3);
  });

  it("does not acknowledge a successful upstream reopen until the local state is durable", async () => {
    const file = await dataFile();
    const store = new TaskStore(null, file);
    await Bun.write(file, "blocked");
    await rm(file);
    const { mkdir } = await import("node:fs/promises");
    await mkdir(file);
    let acknowledged = false;
    await expect(
      store.reopen("eat-fruit", "disk-failure", () => {
        acknowledged = true;
      }),
    ).rejects.toMatchObject({ code: "storage_unavailable" });
    expect(acknowledged).toBe(false);
    expect(store.snapshot().tasks.find((t) => t.id === "eat-fruit")?.completed).toBe(true);
  });

  it("serializes a delayed poll before reopening so the old completion cannot win that race", async () => {
    let release: ((list: TaskList) => void) | undefined;
    let reads = 0;
    const list = demoTasks();
    const store = new TaskStore(
      {
        authoritativeCompletions: true,
        readTasks: async () =>
          ++reads === 1
            ? list
            : new Promise<TaskList>((resolve) => {
                release = resolve;
              }),
        completeTask: async () => list,
        reopenTask: async (task) => ({
          ...list,
          tasks: list.tasks.map((item) =>
            item.id === task.id ? { ...item, completed: false } : item,
          ),
        }),
      },
      null,
    );
    await store.refresh();
    const poll = store.refresh();
    await Promise.resolve();
    const reopen = store.reopen("eat-fruit", "after-poll");
    release!(list);
    await Promise.all([poll, reopen]);
    expect(store.snapshot().tasks.find((t) => t.id === "eat-fruit")?.completed).toBe(false);
  });

  it("validates optional timer metadata and retains compatibility with old snapshots", () => {
    const initial = demoTasks();
    expect(parseTaskList(initial).tasks[0]?.timer).toBeUndefined();
    for (const timer of [
      { startedAt: null, elapsedSeconds: -1 },
      { startedAt: null, elapsedSeconds: 72001 },
      { startedAt: "bad", elapsedSeconds: 1 },
      { elapsedSeconds: 0 },
      { startedAt: null, elapsedSeconds: 1.5 },
    ])
      expect(() =>
        parseTaskList({ ...initial, tasks: [{ ...initial.tasks[0], timer }] }),
      ).toThrow();
    expect(
      parseTaskList({
        ...initial,
        tasks: [
          {
            ...initial.tasks[0],
            timer: { startedAt: null, elapsedSeconds: 72000 },
            spentTimeSeconds: 0,
          },
        ],
      }).tasks[0],
    ).toMatchObject({ timer: { startedAt: null, elapsedSeconds: 72000 }, spentTimeSeconds: 0 });
  });

  it("authenticates new HTTP routes and sends distinct mutation ACKs before focus updates", async () => {
    const app = await createPocketServer(
      { ...loadPocketConfig({}), port: 0, dataFile: null, deviceToken: "test-token" },
      { poll: false },
    );
    apps.push(app);
    const base = `http://127.0.0.1:${app.server.port}`;
    for (const action of ["reopen", "timer"]) {
      expect(
        (
          await fetch(`${base}/api/tasks/eat-fruit/${action}`, {
            method: "POST",
            body: JSON.stringify({ requestId: "unauthorized", action: "start" }),
          })
        ).status,
      ).toBe(401);
    }
    const reopened = await fetch(`${base}/api/tasks/eat-fruit/reopen`, {
      method: "POST",
      headers: { Authorization: "Bearer test-token" },
      body: JSON.stringify({ requestId: "http-reopen" }),
    });
    expect(reopened.status).toBe(200);
    const ws = authenticatedSocket(`${base.replace("http", "ws")}/ws`, "test-token");
    const frames: Record<string, unknown>[] = [];
    ws.onmessage = (event) => {
      if (typeof event.data === "string") frames.push(JSON.parse(event.data));
    };
    await new Promise<void>((resolve, reject) => {
      ws.onopen = () => resolve();
      ws.onerror = () => reject(new Error("fixture websocket"));
    });
    const send = (value: unknown) => ws.send(JSON.stringify(value));
    const wait = async (predicate: () => boolean) => {
      const deadline = Date.now() + 2000;
      while (!predicate()) {
        if (Date.now() > deadline) throw new Error("fixture timeout");
        await Bun.sleep(5);
      }
    };
    try {
      send({ type: "hello", protocol: 2, deviceId: "test-actions" });
      await wait(() => frames.some((frame) => frame.type === "focus"));
      frames.length = 0;
      send({ type: "reopen_task", id: "eat-fruit", requestId: "ws-reopen" });
      await wait(() => frames.some((frame) => frame.type === "focus"));
      expect(frames[0]).toEqual({ type: "task_reopened", id: "eat-fruit", requestId: "ws-reopen" });
      frames.length = 0;
      send({ type: "task_timer", id: "eat-fruit", requestId: "ws-start", action: "start" });
      await wait(() => frames.some((frame) => frame.type === "focus"));
      expect(frames[0]).toEqual({
        type: "task_timer_updated",
        id: "eat-fruit",
        requestId: "ws-start",
        action: "start",
      });
      expect(
        (frames[1]!.snapshot as TaskList).tasks.find((task) => task.id === "eat-fruit")?.timer
          ?.startedAt,
      ).toBeString();
      frames.length = 0;
      send({ type: "task_timer", id: "eat-fruit", requestId: "invalid-timer", action: "erase" });
      await wait(() => frames.some((frame) => frame.type === "error"));
      expect(frames[0]?.code).toBe("invalid_request");
    } finally {
      ws.close();
    }
  });
});

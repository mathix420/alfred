import { describe, expect, it } from "bun:test";
import { TodoMateApiAdapter } from "../src/todomate";
import { TaskStore } from "../src/tasks";
const config = { baseUrl: "http://todomate:8000", accessToken: "test-access-token" };
const task = (id: string, extra: object = {}) => ({
  id,
  title: "Prepare demo",
  goalId: "g",
  memo: "Read this",
  dueAt: null,
  completed: false,
  ...extra,
});
const goals = [{ id: "g", title: "Work" }];

describe("direct TodoMate REST adapter", () => {
  it("reads real tasks with authenticated REST and prioritizes due tasks", async () => {
    const adapter = new TodoMateApiAdapter(config, async (url, init) => {
      expect(url).toBe("http://todomate:8000/api/tasks?include_unscheduled=true");
      expect(new Headers(init.headers).get("Authorization")).toBe("Bearer test-access-token");
      expect(init.redirect).toBe("error");
      return Response.json({
        goals,
        tasks: [
          task("later"),
          task("due", {
            dueAt: "2026-09-17T12:00:00+02:00",
            memo: "A long memo\n\nSecond paragraph",
          }),
          task("done", { completed: true }),
        ],
      });
    });
    const result = await adapter.readTasks();
    expect(result.focusId).toBe("due");
    expect(result.tasks[0]).toEqual({
      id: "due",
      title: "Prepare demo",
      category: "work",
      memo: "A long memo\n\nSecond paragraph",
      dueAt: "2026-09-17T10:00:00.000Z",
      completed: false,
    });
    expect(result.tasks[1]?.dueAt).toBeNull();
  });

  it("maps long external IDs deterministically and completes exactly the source task after restart", async () => {
    const sourceId = "very long external tâche ".repeat(4);
    let completed = false;
    const fetcher = async (url: string, init: RequestInit) => {
      if (init.method === "POST") {
        expect(url).toBe(`http://todomate:8000/api/tasks/${encodeURIComponent(sourceId)}/complete`);
        expect(JSON.parse(String(init.body))).toEqual({ completed: true });
        expect(new Headers(init.headers).get("Idempotency-Key")).toBe("once");
        completed = true;
        return Response.json({ task: task(sourceId, { completed }) });
      }
      return Response.json({ goals, tasks: [task(sourceId, { completed }), task("next")] });
    };
    const first = new TodoMateApiAdapter(config, fetcher);
    const snapshot = await first.readTasks();
    expect(snapshot.tasks[0]!.id.length).toBeLessThanOrEqual(63);
    const restarted = new TodoMateApiAdapter(config, fetcher);
    const next = await restarted.completeTask(snapshot.tasks[0]!, "once");
    expect(next.tasks.find((t) => t.id === snapshot.focusId)?.completed).toBe(true);
    expect(next.focusId).toBe("next");
  });

  it("accepts confirmed writes even if the following list read fails", async () => {
    let calls = 0;
    const adapter = new TodoMateApiAdapter(config, async (_url, init) => {
      if (init.method === "POST") return Response.json({ task: task("t", { completed: true }) });
      if (++calls > 1) return new Response("upstream offline", { status: 502 });
      return Response.json({ goals, tasks: [task("t"), task("next")] });
    });
    const list = await adapter.readTasks();
    const completed = await adapter.completeTask(list.tasks[0]!, "save");
    expect(completed.tasks.find((t) => t.id === "t")?.completed).toBe(true);
    expect(completed.focusId).toBe("next");
  });

  it("reflects external reopen and lets a new tap complete the reopened task", async () => {
    let done = false,
      writes = 0;
    const adapter = new TodoMateApiAdapter(config, async (_url, init) => {
      if (init.method === "POST") {
        writes++;
        done = true;
        return Response.json({ task: task("t", { completed: true }) });
      }
      return Response.json({ goals, tasks: [task("t", { completed: done })] });
    });
    const store = new TaskStore(adapter, null);
    await store.refresh();
    await store.complete("t", "first-tap");
    done = false;
    await store.refresh();
    expect(store.snapshot().focusId).toBe("t");
    expect(store.snapshot().tasks[0]?.completed).toBe(false);
    await store.complete("t", "second-tap");
    expect(writes).toBe(2);
    await store.complete("t", "second-tap");
    expect(writes).toBe(2);
  });

  it("fits multilingual tasks within device buffers and prioritizes incomplete slots", async () => {
    const adapter = new TodoMateApiAdapter(config, async () =>
      Response.json({
        goals,
        tasks: [
          task("done", { completed: true }),
          ...Array.from({ length: 19 }, (_, i) =>
            task(`t${i}`, { title: "🦋".repeat(200), memo: "é".repeat(1000) }),
          ),
        ],
      }),
    );
    const result = await adapter.readTasks();
    expect(result.tasks).toHaveLength(16);
    expect(result.tasks.every((t) => !t.completed)).toBe(true);
    expect(new TextEncoder().encode(result.tasks[0]!.title).length).toBeLessThanOrEqual(191);
    expect(new TextEncoder().encode(result.tasks[0]!.memo).length).toBeLessThanOrEqual(1200);
    expect(result.tasks[0]!.title).not.toContain("�");
  });

  it("rejects malformed data and unconfirmed completion without exposing upstream errors", async () => {
    const adapter = new TodoMateApiAdapter(config, async (_url, init) =>
      Response.json(init.method === "POST" ? { task: task("t") } : { goals, tasks: [task("t")] }),
    );
    const list = await adapter.readTasks();
    await expect(adapter.completeTask(list.tasks[0]!, "bad")).rejects.toThrow("could not confirm");
    const malformed = new TodoMateApiAdapter(config, async () =>
      Response.json({ goals, tasks: [task("t", { completed: "yes" })] }),
    );
    await expect(malformed.readTasks()).rejects.toThrow("unreadable task list");
    const denied = new TodoMateApiAdapter(
      config,
      async () => new Response("private internal upstream details", { status: 401 }),
    );
    await expect(denied.readTasks()).rejects.toThrow("did not accept");
  });
});

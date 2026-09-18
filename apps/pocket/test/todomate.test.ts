import { describe, expect, it } from "bun:test";
import { TodoMateApiAdapter } from "../src/todomate";
import { TaskStore } from "../src/tasks";
import { LEGACY_CATEGORIES, parseTaskList } from "../src/types";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
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
      categoryId: "g",
      memo: "A long memo\n\nSecond paragraph",
      dueAt: "2026-09-17T10:00:00.000Z",
      completed: false,
    });
    expect(result.tasks[1]?.dueAt).toBeNull();
    expect(result.categories).toEqual([{ id: "g", title: "Work", color: "#8f8f98" }]);
  });

  it("preserves actual TodoMate lists, order, and ARGB colors while hiding empty groups", async () => {
    const actualGoals = [
      { id: "health-list", title: "health", color: 0xffff80ab, status: "active" },
      { id: "personal-list", title: "personal", color: 0xff66bb6a, status: "active" },
      { id: "contract-list", title: "contrat IA", color: 0xff42a5f5, status: "active" },
      { id: "community-list", title: "communityfix", color: 0xffffca28, status: "active" },
      { id: "adaptyv-list", title: "adaptyv", color: 0xff26c6da, status: "active" },
      { id: "old-list", title: "Archived", color: 0xff000000, status: "done" },
    ];
    const adapter = new TodoMateApiAdapter(config, async () =>
      Response.json({
        goals: actualGoals,
        tasks: [task("one", { goalId: "contract-list" }), task("two", { goalId: "adaptyv-list" })],
      }),
    );
    const result = await adapter.readTasks();
    expect(result.categories).toEqual(
      actualGoals
        .filter((goal) => ["contract-list", "adaptyv-list"].includes(goal.id))
        .map((goal) => ({
          id: goal.id,
          title: goal.title,
          color: `#${(goal.color & 0xffffff).toString(16)}`,
        })),
    );
    expect(result.tasks.map((entry) => entry.categoryId)).toEqual([
      "contract-list",
      "adaptyv-list",
    ]);
    // The deployed older firmware can still parse its legacy fallback field.
    expect(
      result.tasks.every((entry) => ["work", "health", "personal"].includes(entry.category)),
    ).toBe(true);
  });

  it("keeps equally named groups separate and reflects rename/color changes", async () => {
    const listGoals = [
      { id: "one", title: "Research", color: 0xff0000ff },
      { id: "two", title: "Research", color: 0xff00ff00 },
    ];
    const adapter = new TodoMateApiAdapter(config, async () =>
      Response.json({
        goals: listGoals,
        tasks: [task("a", { goalId: "one" }), task("b", { goalId: "two" })],
      }),
    );
    await adapter.readTasks();
    listGoals[1] = { id: "two", title: "New label", color: 0xffabcdef };
    const next = await adapter.readTasks();
    expect(next.categories).toEqual([
      { id: "one", title: "Research", color: "#0000ff" },
      { id: "two", title: "New label", color: "#abcdef" },
    ]);
    expect(next.tasks.map((entry) => entry.categoryId)).toEqual(["one", "two"]);
  });

  it("keeps a visible task's closed Unicode group without including empty groups", async () => {
    const sourceId = "long goal é ".repeat(20);
    const sourceTitle = "研究🦋".repeat(30);
    const listGoals = [
      ...Array.from({ length: 40 }, (_, index) => ({
        id: `empty-${index}`,
        title: `Empty ${index}`,
        status: "active",
        color: null,
      })),
      { id: sourceId, title: sourceTitle, status: "done", color: 0xff123456 },
    ];
    const adapter = new TodoMateApiAdapter(config, async () =>
      Response.json({
        goals: listGoals,
        tasks: [task("visible", { goalId: sourceId })],
      }),
    );
    const result = await adapter.readTasks();
    expect(result.categories).toHaveLength(1);
    const category = result.categories!.find((entry) => entry.id === result.tasks[0]!.categoryId)!;
    expect(category.id).toMatch(/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,62}$/);
    expect(new TextEncoder().encode(category.title).length).toBeLessThanOrEqual(63);
    expect(category.title).not.toContain("�");
    expect(category.color).toBe("#123456");
    expect(result.categories!.at(-1)?.id).toBe(category.id);
    expect((await adapter.readTasks()).tasks[0]!.categoryId).toBe(category.id);
  });

  it("preserves catalog through completion, failed refresh, and cached restart", async () => {
    const directory = await mkdtemp(join(tmpdir(), "alfred-categories-"));
    try {
      let offline = false;
      const adapter = new TodoMateApiAdapter(config, async (_url, init) => {
        if (init.method === "POST") {
          offline = true;
          return Response.json({ task: task("t", { goalId: "custom", completed: true }) });
        }
        if (offline) return new Response("unavailable", { status: 502 });
        return Response.json({
          goals: [{ id: "custom", title: "My custom list", color: 0xffaabbcc }],
          tasks: [task("t", { goalId: "custom" })],
        });
      });
      const file = join(directory, "tasks.json");
      const store = new TaskStore(adapter, file);
      await store.refresh();
      await store.complete("t", "complete-once");
      const restarted = new TaskStore(adapter, file);
      await restarted.initialize();
      expect(restarted.snapshot().categories).toEqual([
        { id: "custom", title: "My custom list", color: "#aabbcc" },
      ]);
      expect(restarted.snapshot().tasks[0]).toMatchObject({
        categoryId: "custom",
        completed: true,
      });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("retains the completed task category when TodoMate omits the task on follow-up", async () => {
    let done = false;
    const adapter = new TodoMateApiAdapter(config, async (_url, init) => {
      if (init.method === "POST") {
        done = true;
        return Response.json({ task: task("t", { goalId: "closed", completed: true }) });
      }
      return Response.json({
        goals: [{ id: "closed", title: "Closed", status: "done", color: 0xffaabbcc }],
        tasks: done ? [] : [task("t", { goalId: "closed" })],
      });
    });
    const initial = await adapter.readTasks();
    const next = await adapter.completeTask(initial.tasks[0]!, "once");
    expect(next.tasks[0]).toMatchObject({ categoryId: "closed", completed: true });
    expect(next.categories).toEqual(initial.categories);
  });

  it("removes a category when its only task loses a device slot after completion", async () => {
    let done = false;
    const adapter = new TodoMateApiAdapter(config, async (_url, init) => {
      if (init.method === "POST") {
        done = true;
        return Response.json({
          task: task("original", { goalId: "original-group", completed: true }),
        });
      }
      return Response.json({
        goals: ["original-group", "next-group", "last-group"].map((id) => ({ id, title: id })),
        tasks: done
          ? Array.from({ length: 16 }, (_, index) =>
              task(`next-${index}`, { goalId: index === 15 ? "last-group" : "next-group" }),
            )
          : [task("original", { goalId: "original-group" })],
      });
    });
    const initial = await adapter.readTasks();
    const next = await adapter.completeTask(initial.tasks[0]!, "once");
    expect(next.tasks).toHaveLength(16);
    expect(next.categories?.map((category) => category.id)).toEqual([
      "original-group",
      "next-group",
    ]);
  });

  it("validates catalog bounds and uses demo metadata for old cached snapshots", () => {
    const legacy = {
      tasks: [
        {
          id: "t",
          title: "Old cached task",
          category: "work",
          memo: "",
          dueAt: null,
          completed: false,
        },
      ],
      focusId: "t",
    };
    expect(parseTaskList(legacy).categories).toEqual([...LEGACY_CATEGORIES]);
    const category = { id: "g", title: "Actual list", color: "#abcdef" };
    for (const categories of [
      null,
      [category, category],
      [{ ...category, title: "🦋".repeat(16) }],
      [{ ...category, color: "red;bad" }],
      Array.from({ length: 33 }, (_, i) => ({ ...category, id: `g${i}` })),
    ])
      expect(() => parseTaskList({ ...legacy, categories })).toThrow();
    expect(() =>
      parseTaskList({
        ...legacy,
        categories: [category],
        tasks: [{ ...legacy.tasks[0], categoryId: "missing" }],
      }),
    ).toThrow();
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

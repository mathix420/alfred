import { mkdir, rename, readFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { HermesAdapter } from "./hermes";
import {
  identifier,
  parseTaskList,
  PocketError,
  type FocusSnapshot,
  type FocusTask,
  type TaskList,
} from "./types";

export function demoTasks(now = new Date()): TaskList {
  const due = new Date(now);
  due.setHours(16, 15, 0, 0);
  const tasks: FocusTask[] = [
    {
      id: "investor-demo",
      title: "Prep Friday's investor demo",
      category: "work",
      memo: "Storyboard the recall demo, export the deck to the iPad, and rehearse the pitch end to end.\n\nCheck the demo account has fresh data and clear the browser profile before going on stage.\n\nOpen with the memory question: ask Hermes what changed since Monday and let it answer live on screen.\n\nIf the venue wifi drops, switch to the phone hotspot; the local fallback model is already pulled on the laptop.\n\nClose with the roadmap slide and hand the iPad to Léa for the numbers.",
      dueAt: due.toISOString(),
      completed: false,
    },
    {
      id: "term-sheet",
      title: "Reply to the term sheet",
      category: "work",
      memo: "Take your time. Note the questions you want to ask.",
      dueAt: due.toISOString(),
      completed: false,
    },
    {
      id: "eat-fruit",
      title: "Eat a fruit",
      category: "health",
      memo: "A small moment to look after yourself.",
      dueAt: null,
      completed: true,
    },
    {
      id: "walk",
      title: "Walk 20 min after lunch",
      category: "health",
      memo: "Step outside. Leave your phone in your pocket.",
      dueAt: null,
      completed: false,
    },
    {
      id: "notary",
      title: "Call the notary",
      category: "personal",
      memo: "Find a quiet moment to make the call.",
      dueAt: null,
      completed: false,
    },
  ];
  return { tasks, focusId: tasks[0]!.id };
}

function demoFocus(tasks: FocusTask[]): string | null {
  return (
    ["investor-demo", "walk", "term-sheet", "notary"].find((id) =>
      tasks.some((task) => task.id === id && !task.completed),
    ) ?? null
  );
}

interface SavedState {
  mode: "demo" | "live";
  revision: number;
  tasks: FocusTask[];
  focusId: string | null;
  completedIds: string[];
  requests: [string, string][];
}

export class TaskStore {
  private current: FocusSnapshot;
  private queue: Promise<unknown> = Promise.resolve();
  private refreshPending: Promise<FocusSnapshot> | undefined;
  private readonly completedIds = new Set<string>();
  private readonly requests = new Map<string, string>();
  private readonly listeners = new Set<(snapshot: FocusSnapshot) => void>();

  constructor(
    private readonly adapter: HermesAdapter | null,
    private readonly dataFile: string | null,
    initialMode: "demo" | "live" = adapter ? "live" : "demo",
  ) {
    this.current = {
      ...(initialMode === "live" ? { tasks: [], focusId: null } : demoTasks()),
      revision: 0,
      mode: initialMode,
      connection: initialMode === "live" ? "offline" : "unconfigured",
    };
  }

  async initialize(): Promise<void> {
    if (!this.dataFile) return;
    let raw: string;
    try {
      raw = await readFile(this.dataFile, "utf8");
    } catch (error) {
      if ((error as { code?: string }).code === "ENOENT") return;
      throw new PocketError("storage_unavailable", "Cannot read pocket task storage.", 503);
    }
    try {
      if (raw.length > 128000) throw new Error("oversized");
      const saved = JSON.parse(raw) as SavedState;
      if (saved.mode !== this.current.mode) return;
      const list = parseTaskList(saved);
      if (
        !Number.isSafeInteger(saved.revision) ||
        saved.revision < 0 ||
        !Array.isArray(saved.completedIds) ||
        !saved.completedIds.every(identifier) ||
        !Array.isArray(saved.requests) ||
        saved.requests.length > 256 ||
        !saved.requests.every(
          (pair) => Array.isArray(pair) && pair.length === 2 && pair.every(identifier),
        )
      )
        throw new Error("invalid");
      if (saved.mode === "demo") {
        // Refresh fixture copy/date after an app update, keeping completed tasks.
        list.tasks = demoTasks().tasks.map((task) => ({
          ...task,
          completed:
            task.completed ||
            list.tasks.some((savedTask) => savedTask.id === task.id && savedTask.completed),
        }));
        list.focusId = demoFocus(list.tasks);
      }
      this.current = { ...this.current, ...list, revision: saved.revision };
      for (const id of saved.completedIds) this.completedIds.add(id);
      for (const [requestId, taskId] of saved.requests) this.requests.set(requestId, taskId);
    } catch {
      throw new PocketError(
        "storage_invalid",
        "Pocket task storage is unreadable. Preserve the file before resetting it.",
        503,
      );
    }
  }

  snapshot(): FocusSnapshot {
    return structuredClone(this.current);
  }

  subscribe(listener: (snapshot: FocusSnapshot) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  refresh(signal?: AbortSignal): Promise<FocusSnapshot> {
    if (this.refreshPending) return this.refreshPending;
    const pending = this.serialize(async () => {
      if (!this.adapter) return this.snapshot();
      try {
        const list = this.preserveCompletions(await this.adapter.readTasks(signal));
        const next: FocusSnapshot = {
          ...this.current,
          ...list,
          revision: this.current.revision + 1,
          connection: "online",
        };
        await this.persist(next);
        this.current = next;
        this.publish();
        return this.snapshot();
      } catch (error) {
        this.markOffline();
        throw error;
      }
    });
    this.refreshPending = pending;
    void pending
      .finally(() => {
        if (this.refreshPending === pending) this.refreshPending = undefined;
      })
      .catch(() => undefined);
    return pending;
  }

  complete(id: string, requestId: string, acknowledge?: () => void): Promise<FocusSnapshot> {
    if (!identifier(id) || !identifier(requestId))
      return Promise.reject(
        new PocketError("invalid_request", "A valid task and request ID are required."),
      );
    return this.serialize(async () => {
      const previous = this.requests.get(requestId);
      if (previous && previous !== id)
        throw new PocketError("request_conflict", "That request ID belongs to another task.", 409);
      if (
        previous === id ||
        (!this.adapter?.authoritativeCompletions && this.completedIds.has(id))
      ) {
        acknowledge?.();
        return this.snapshot();
      }
      const task = this.current.tasks.find((item) => item.id === id);
      if (!task)
        throw new PocketError("task_missing", "This task has changed. Refresh your list.", 404);
      let list: TaskList;
      try {
        list =
          this.adapter && !task.completed
            ? await this.adapter.completeTask(task, requestId)
            : {
                tasks: this.current.tasks.map((item) =>
                  item.id === id ? { ...item, completed: true } : item,
                ),
                focusId: null,
              };
      } catch (error) {
        if (this.adapter) this.markOffline();
        throw error;
      }
      if (!this.adapter) list.focusId = demoFocus(list.tasks);
      // Keep all previously acknowledged completions across delayed cloud reads.
      list = this.preserveCompletions(list);
      if (!list.tasks.some((item) => item.id === id && item.completed)) {
        throw new PocketError(
          "completion_unconfirmed",
          "The task service has not confirmed completion. Please try again.",
          502,
        );
      }
      if (!list.focusId) list.focusId = list.tasks.find((item) => !item.completed)?.id ?? null;
      const next: FocusSnapshot = {
        ...this.current,
        ...list,
        revision: this.current.revision + 1,
        connection: this.adapter ? "online" : "unconfigured",
      };
      const nextRequests = new Map(this.requests);
      nextRequests.set(requestId, id);
      while (nextRequests.size > 256) nextRequests.delete(nextRequests.keys().next().value!);
      const nextCompleted = new Set(this.completedIds).add(id);
      await this.persist(next, nextCompleted, nextRequests);
      this.current = next;
      this.completedIds.add(id);
      this.requests.clear();
      for (const [request, taskId] of nextRequests) this.requests.set(request, taskId);
      acknowledge?.();
      this.publish();
      return this.snapshot();
    });
  }

  private preserveCompletions(list: TaskList): TaskList {
    const validated = parseTaskList(list);
    if (this.adapter?.authoritativeCompletions) return validated;
    const tasks = validated.tasks.map((item) =>
      this.completedIds.has(item.id) ? { ...item, completed: true } : item,
    );
    const focusId = tasks.some((item) => item.id === validated.focusId && !item.completed)
      ? validated.focusId
      : (tasks.find((item) => !item.completed)?.id ?? null);
    return { tasks, focusId };
  }

  private markOffline(): void {
    if (this.current.connection !== "offline") {
      this.current = {
        ...this.current,
        connection: "offline",
        revision: this.current.revision + 1,
      };
      this.publish();
    }
  }

  private serialize<T>(operation: () => Promise<T>): Promise<T> {
    const pending = this.queue.then(operation, operation);
    this.queue = pending.catch(() => undefined);
    return pending;
  }

  private publish(): void {
    for (const listener of this.listeners) listener(this.snapshot());
  }

  private async persist(
    snapshot: FocusSnapshot,
    completedIds = this.completedIds,
    requests = this.requests,
  ): Promise<void> {
    if (!this.dataFile) return;
    try {
      await mkdir(dirname(this.dataFile), { recursive: true });
      const temporary = `${this.dataFile}.${crypto.randomUUID()}.tmp`;
      const state: SavedState = {
        ...snapshot,
        completedIds: [...completedIds],
        requests: [...requests],
      };
      await Bun.write(temporary, JSON.stringify(state));
      await rename(temporary, this.dataFile);
    } catch {
      throw new PocketError(
        "storage_unavailable",
        "Could not save your task. Please try again.",
        503,
      );
    }
  }
}

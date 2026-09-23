import { mkdir, rename, readFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { TaskAdapter } from "./types";
import {
  identifier,
  LEGACY_CATEGORIES,
  parseTaskList,
  PocketError,
  type FocusSnapshot,
  type FocusTask,
  type TaskList,
  type TaskCategory,
  type TaskMutation,
  type TaskTimerAction,
  taskTimerAction,
  MAX_TIMER_SECONDS,
  mutationConfirmed,
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
  return {
    tasks,
    focusId: tasks[0]!.id,
    categories: LEGACY_CATEGORIES.map((category) => ({ ...category })),
  };
}

function demoFocus(tasks: FocusTask[]): string | null {
  return (
    ["investor-demo", "walk", "term-sheet", "notary"].find((id) =>
      tasks.some((task) => task.id === id && !task.completed),
    ) ??
    tasks.find((task) => !task.completed)?.id ??
    null
  );
}

interface SavedState {
  mode: "demo" | "live";
  revision: number;
  tasks: FocusTask[];
  focusId: string | null;
  categories?: TaskCategory[];
  completedIds: string[];
  requests: [string, string, (TaskMutation | boolean)?][];
}

export class TaskStore {
  private current: FocusSnapshot;
  private queue: Promise<unknown> = Promise.resolve();
  private refreshPending: Promise<FocusSnapshot> | undefined;
  private readonly completedIds = new Set<string>();
  private readonly requests = new Map<string, { id: string; action: TaskMutation }>();
  private readonly listeners = new Set<(snapshot: FocusSnapshot) => void>();

  constructor(
    private readonly adapter: TaskAdapter | null,
    private readonly dataFile: string | null,
    initialMode: "demo" | "live" = adapter ? "live" : "demo",
  ) {
    this.current = {
      ...(initialMode === "live" ? { tasks: [], focusId: null, categories: [] } : demoTasks()),
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
          (pair) =>
            Array.isArray(pair) &&
            (pair.length === 2 || pair.length === 3) &&
            identifier(pair[0]) &&
            identifier(pair[1]) &&
            (pair.length === 2 ||
              typeof pair[2] === "boolean" ||
              pair[2] === "complete" ||
              pair[2] === "reopen" ||
              taskTimerAction(pair[2])),
        )
      )
        throw new Error("invalid");
      if (saved.mode === "demo") {
        // Refresh fixture copy/date after an app update, keeping completed tasks.
        list.tasks = demoTasks().tasks.map((task) => ({
          ...task,
          completed:
            list.tasks.find((savedTask) => savedTask.id === task.id)?.completed ?? task.completed,
          ...(list.tasks.find((savedTask) => savedTask.id === task.id)?.timer !== undefined
            ? { timer: list.tasks.find((savedTask) => savedTask.id === task.id)!.timer }
            : {}),
          ...(list.tasks.find((savedTask) => savedTask.id === task.id)?.spentTimeSeconds !==
          undefined
            ? {
                spentTimeSeconds: list.tasks.find((savedTask) => savedTask.id === task.id)!
                  .spentTimeSeconds,
              }
            : {}),
        }));
        list.focusId = demoFocus(list.tasks);
      }
      this.current = { ...this.current, ...list, revision: saved.revision };
      for (const id of saved.completedIds) this.completedIds.add(id);
      for (const [requestId, taskId, action = "complete"] of saved.requests)
        this.requests.set(requestId, {
          id: taskId,
          action: typeof action === "boolean" ? (action ? "complete" : "reopen") : action,
        });
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
    return this.mutate(id, requestId, "complete", acknowledge);
  }

  reopen(id: string, requestId: string, acknowledge?: () => void): Promise<FocusSnapshot> {
    return this.mutate(id, requestId, "reopen", acknowledge);
  }

  updateTimer(
    id: string,
    requestId: string,
    action: TaskTimerAction,
    acknowledge?: () => void,
  ): Promise<FocusSnapshot> {
    if (!taskTimerAction(action))
      return Promise.reject(new PocketError("invalid_request", "Choose start, pause or stop."));
    return this.mutate(id, requestId, action, acknowledge);
  }

  private mutate(
    id: string,
    requestId: string,
    action: TaskMutation,
    acknowledge?: () => void,
  ): Promise<FocusSnapshot> {
    if (!identifier(id) || !identifier(requestId))
      return Promise.reject(
        new PocketError("invalid_request", "A valid task and request ID are required."),
      );
    return this.serialize(async () => {
      const previous = this.requests.get(requestId);
      if (previous && (previous.id !== id || previous.action !== action))
        throw new PocketError(
          "request_conflict",
          "That request ID belongs to another task or action.",
          409,
        );
      if (previous) {
        acknowledge?.();
        return this.snapshot();
      }
      const task = this.current.tasks.find((item) => item.id === id);
      if (!task)
        throw new PocketError("task_missing", "This task has changed. Refresh your list.", 404);
      if (action === "start" && task.completed)
        throw new PocketError("task_completed", "Reopen this task before starting its timer.", 409);
      if ((action === "pause" || (action === "stop" && !task.completed)) && !task.timer)
        throw new PocketError("timer_missing", "Start this task's timer first.", 409);
      let list: TaskList;
      try {
        if (this.adapter && taskTimerAction(action)) {
          if (!this.adapter.updateTimer)
            throw new PocketError(
              "timer_unavailable",
              "The task service does not support timers.",
              503,
            );
          list = await this.adapter.updateTimer(task, action, requestId);
        } else if (this.adapter) {
          if (action === "complete") list = await this.adapter.completeTask(task, requestId);
          else if (this.adapter.reopenTask) list = await this.adapter.reopenTask(task, requestId);
          else
            throw new PocketError(
              "reopen_unavailable",
              "The task service does not support reopening tasks.",
              503,
            );
        } else {
          list = {
            tasks: this.current.tasks.map((item) =>
              item.id === id ? localMutation(item, action) : item,
            ),
            focusId: null,
            categories: this.current.categories,
          };
        }
      } catch (error) {
        if (this.adapter && !(error instanceof PocketError && error.status === 409))
          this.markOffline();
        throw error;
      }
      if (!this.adapter) list.focusId = demoFocus(list.tasks);
      list = parseTaskList(list);
      const confirmed = list.tasks.find((item) => item.id === id);
      if (!confirmed || !mutationConfirmed(confirmed, action))
        throw new PocketError(
          "task_change_unconfirmed",
          "The task service has not confirmed this change. Please try again.",
          502,
        );
      const nextCompleted = new Set(this.completedIds);
      if (confirmed.completed) nextCompleted.add(id);
      else nextCompleted.delete(id);
      list = this.preserveCompletions(list, nextCompleted);
      if (!list.focusId) list.focusId = list.tasks.find((item) => !item.completed)?.id ?? null;
      const next: FocusSnapshot = {
        ...this.current,
        ...list,
        revision: this.current.revision + 1,
        connection: this.adapter ? "online" : "unconfigured",
      };
      const nextRequests = new Map(this.requests);
      nextRequests.set(requestId, { id, action });
      while (nextRequests.size > 256) nextRequests.delete(nextRequests.keys().next().value!);
      await this.persist(next, nextCompleted, nextRequests);
      this.current = next;
      this.completedIds.clear();
      for (const taskId of nextCompleted) this.completedIds.add(taskId);
      this.requests.clear();
      for (const [request, operation] of nextRequests) this.requests.set(request, operation);
      acknowledge?.();
      this.publish();
      return this.snapshot();
    });
  }

  private preserveCompletions(list: TaskList, completedIds = this.completedIds): TaskList {
    const validated = parseTaskList(list);
    if (this.adapter?.authoritativeCompletions) return validated;
    const tasks = validated.tasks.map((item) =>
      completedIds.has(item.id) ? { ...item, completed: true } : item,
    );
    const focusId = tasks.some((item) => item.id === validated.focusId && !item.completed)
      ? validated.focusId
      : (tasks.find((item) => !item.completed)?.id ?? null);
    return { ...validated, tasks, focusId };
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
        requests: [...requests].map(([requestId, operation]) => [
          requestId,
          operation.id,
          operation.action,
        ]),
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

function localMutation(task: FocusTask, action: TaskMutation): FocusTask {
  const timer = task.timer;
  const seconds = Math.min(
    MAX_TIMER_SECONDS,
    (timer?.elapsedSeconds ?? task.spentTimeSeconds ?? 0) +
      (timer?.startedAt
        ? Math.max(0, Math.floor((Date.now() - Date.parse(timer.startedAt)) / 1000))
        : 0),
  );
  if (action === "start")
    return {
      ...task,
      timer: timer?.startedAt
        ? timer
        : { startedAt: new Date().toISOString(), elapsedSeconds: seconds },
    };
  if (action === "pause") return { ...task, timer: { startedAt: null, elapsedSeconds: seconds } };
  if (action === "reopen") return { ...task, completed: false };
  return {
    ...task,
    completed: true,
    ...(timer || action === "stop" ? { timer: null, spentTimeSeconds: seconds } : {}),
  };
}

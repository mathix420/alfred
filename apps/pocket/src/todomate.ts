import { createHash } from "node:crypto";
import type { TaskAdapter, TaskCategory } from "./types";
import { identifier, parseTaskList, PocketError, type FocusTask, type TaskList } from "./types";

export interface TodoMateApiConfig {
  baseUrl: string;
  accessToken: string;
  timeoutMs?: number;
}
interface ApiTask {
  id: string;
  title: string;
  goalId: string | null;
  memo: string | null;
  dueAt: string | null;
  completed: boolean;
}
interface ApiGoal {
  category: TaskCategory;
}
type Fetcher = (url: string, init: RequestInit) => Promise<Response>;

/** TodoMate is authoritative, including tasks reopened from another client. */
export class TodoMateApiAdapter implements TaskAdapter {
  readonly authoritativeCompletions = true;
  private readonly upstreamIds = new Map<string, string>();
  private categoryOrder = new Map<string, number>();
  private latest: TaskList = { tasks: [], focusId: null };
  constructor(
    private readonly config: TodoMateApiConfig,
    private readonly fetcher: Fetcher = fetch,
  ) {}

  async readTasks(signal?: AbortSignal): Promise<TaskList> {
    const raw = await this.request(
      "/api/tasks?include_unscheduled=true",
      { method: "GET" },
      signal,
    );
    if (
      !isObject(raw) ||
      !Array.isArray(raw.tasks) ||
      !Array.isArray(raw.goals) ||
      raw.tasks.length > 10000 ||
      raw.goals.length > 10000
    )
      throw invalidResponse();
    const goals = new Map<string, ApiGoal>();
    const categoryIds = new Set<string>();
    for (const goal of raw.goals as unknown[]) {
      if (
        !isObject(goal) ||
        typeof goal.id !== "string" ||
        !goal.id ||
        goal.id.length > 1024 ||
        goals.has(goal.id) ||
        typeof goal.title !== "string" ||
        (goal.status !== undefined && typeof goal.status !== "string") ||
        (goal.color !== undefined &&
          goal.color !== null &&
          (typeof goal.color !== "number" ||
            !Number.isInteger(goal.color) ||
            goal.color < 0 ||
            goal.color > 0xffffffff))
      )
        throw invalidResponse();
      const id = deviceId(goal.id);
      if (categoryIds.has(id)) throw invalidResponse();
      categoryIds.add(id);
      goals.set(goal.id, {
        category: {
          id,
          title: fit(goal.title.trim() || "Untitled list", 60),
          color:
            typeof goal.color === "number"
              ? `#${(goal.color & 0xffffff).toString(16).padStart(6, "0")}`
              : "#8f8f98",
        },
      });
    }
    const seen = new Set<string>();
    const tasks = raw.tasks.map(parseTask).map((task) => {
      if (seen.has(task.id)) throw invalidResponse();
      seen.add(task.id);
      const id = deviceId(task.id);
      this.upstreamIds.set(id, task.id);
      return toFocusTask(task, goals);
    });
    // Earliest reminder first, then the API's stable TodoMate order. Incomplete tasks
    // take the limited device slots before completed tasks.
    tasks.sort(
      (a, b) =>
        Number(a.completed) - Number(b.completed) ||
        (a.dueAt ? Date.parse(a.dueAt) : Infinity) - (b.dueAt ? Date.parse(b.dueAt) : Infinity),
    );
    const visible = tasks.slice(0, 16);
    this.latest = parseTaskList({
      tasks: visible,
      focusId: visible.find((task) => !task.completed)?.id ?? null,
      categories: visibleCategories(goals, visible),
    });
    this.categoryOrder = new Map(
      [...goals.values()].map((goal, index) => [goal.category.id, index]),
    );
    return structuredClone(this.latest);
  }

  async completeTask(task: FocusTask, requestId: string, signal?: AbortSignal): Promise<TaskList> {
    // A persisted pocket snapshot can outlive this adapter's in-memory ID map.
    if (!this.upstreamIds.has(task.id)) await this.readTasks(signal);
    const upstreamId = this.upstreamIds.get(task.id);
    if (!upstreamId)
      throw new PocketError("task_missing", "This task has changed. Refresh your list.", 404);
    const response = await this.request(
      `/api/tasks/${encodeURIComponent(upstreamId)}/complete`,
      {
        method: "POST",
        headers: { "Idempotency-Key": requestId },
        body: JSON.stringify({ completed: true }),
      },
      signal,
    );
    if (!isObject(response) || !isObject(response.task)) throw invalidResponse();
    const confirmed = parseTask(response.task);
    if (confirmed.id !== upstreamId || !confirmed.completed)
      throw new PocketError(
        "completion_unconfirmed",
        "TodoMate could not confirm this task was saved.",
        502,
      );
    // The confirmed write is sufficient to acknowledge completion. A failed follow-up
    // list read must not make a successful upstream write look like a failed tap.
    const previousCategory = this.latest.categories?.find(
      (category) => category.id === task.categoryId,
    );
    let next: TaskList;
    try {
      next = await this.readTasks(signal);
    } catch {
      next = structuredClone(this.latest);
    }
    const completed = {
      ...(next.tasks.find((item) => item.id === task.id) ?? task),
      completed: true,
    };
    const completedCategory = completed.categoryId;
    if (
      completedCategory &&
      !next.categories?.some((category) => category.id === completedCategory)
    ) {
      if (previousCategory) {
        next.categories = [...(next.categories ?? []), previousCategory];
      }
    }
    next.tasks = next.tasks.filter((item) => item.id !== task.id).slice(0, 15);
    next.tasks.push(completed);
    const visibleGroups = new Set(next.tasks.map((item) => item.categoryId));
    next.categories = next.categories
      ?.filter((category) => visibleGroups.has(category.id))
      .sort(
        (a, b) =>
          (this.categoryOrder.get(a.id) ?? Infinity) - (this.categoryOrder.get(b.id) ?? Infinity),
      );
    next.focusId = next.tasks.find((item) => !item.completed)?.id ?? null;
    this.latest = parseTaskList(next);
    return structuredClone(this.latest);
  }

  private async request(path: string, init: RequestInit, signal?: AbortSignal): Promise<unknown> {
    const timeout = AbortSignal.timeout(this.config.timeoutMs ?? 15000);
    const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
    try {
      const headers = new Headers(init.headers);
      headers.set("Authorization", `Bearer ${this.config.accessToken}`);
      headers.set("Accept", "application/json");
      if (init.body) headers.set("Content-Type", "application/json");
      const response = await this.fetcher(`${this.config.baseUrl.replace(/\/+$/, "")}${path}`, {
        ...init,
        headers,
        signal: combined,
        redirect: "error",
      });
      if (!response.ok)
        throw new PocketError(
          response.status === 401 ? "todomate_authentication" : "todomate_unavailable",
          response.status === 401
            ? "TodoMate did not accept the backend token."
            : "Cannot reach TodoMate. Your current tasks are safe.",
          502,
        );
      if (Number(response.headers.get("Content-Length")) > 2000000) throw invalidResponse();
      const reader = response.body?.getReader();
      if (!reader) throw invalidResponse();
      const decoder = new TextDecoder();
      let bytes = 0,
        text = "";
      try {
        while (true) {
          const chunk = await reader.read();
          if (chunk.done) break;
          bytes += chunk.value.byteLength;
          if (bytes > 2000000) throw invalidResponse();
          text += decoder.decode(chunk.value, { stream: true });
        }
        text += decoder.decode();
      } finally {
        await reader.cancel().catch(() => undefined);
      }
      return JSON.parse(text);
    } catch (error) {
      if (signal?.aborted) throw new PocketError("cancelled", "Task sync cancelled.", 499);
      if (timeout.aborted)
        throw new PocketError("timeout", "TodoMate took too long to respond.", 504);
      if (error instanceof PocketError) throw error;
      throw new PocketError(
        "todomate_unavailable",
        "Cannot reach TodoMate. Your current tasks are safe.",
        502,
      );
    }
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
function invalidResponse(): PocketError {
  return new PocketError(
    "invalid_tasks",
    "TodoMate returned an unreadable task list. Your current tasks are safe.",
    502,
  );
}
function deviceId(id: string): string {
  return identifier(id) ? id : `tm-${createHash("sha256").update(id).digest("hex").slice(0, 56)}`;
}
function fit(text: string, bytes: number, characters = Infinity): string {
  const points = Array.from(text);
  let result = "",
    length = 0;
  for (const point of points) {
    const size = new TextEncoder().encode(point).length;
    if (length + size > bytes || result.length + point.length > characters)
      return result.replace(/.{0,1}$/u, "") + "…";
    result += point;
    length += size;
  }
  return result;
}
function parseTask(value: unknown): ApiTask {
  if (
    !isObject(value) ||
    typeof value.id !== "string" ||
    !value.id ||
    value.id.length > 1024 ||
    typeof value.title !== "string" ||
    !value.title.trim() ||
    typeof value.completed !== "boolean" ||
    !(value.goalId === null || typeof value.goalId === "string") ||
    !(value.memo === null || typeof value.memo === "string") ||
    !(
      value.dueAt === null ||
      (typeof value.dueAt === "string" &&
        /^\d{4}-\d{2}-\d{2}T/.test(value.dueAt) &&
        Number.isFinite(Date.parse(value.dueAt)))
    )
  )
    throw invalidResponse();
  return value as unknown as ApiTask;
}
function toFocusTask(task: ApiTask, goals: Map<string, ApiGoal>): FocusTask {
  const label = (goals.get(task.goalId ?? "")?.category.title ?? "").toLowerCase();
  const category = /work|travail|boulot|profession|business/.test(label)
    ? "work"
    : /health|santé|sante|sport|fitness|wellness/.test(label)
      ? "health"
      : "personal";
  return {
    id: deviceId(task.id),
    title: fit(task.title.trim(), 188, 157),
    category,
    categoryId: task.goalId ? deviceId(task.goalId) : deviceId("\0alfred-uncategorized"),
    memo: fit(task.memo ?? "", 1197),
    dueAt: task.dueAt ? new Date(task.dueAt).toISOString() : null,
    completed: task.completed,
  };
}

function visibleCategories(goals: Map<string, ApiGoal>, tasks: FocusTask[]): TaskCategory[] {
  const required = new Set(tasks.map((task) => task.categoryId!));
  const categories = [...goals.values()]
    .filter((goal) => required.has(goal.category.id))
    .map((goal) => goal.category);
  const known = new Set(categories.map((category) => category.id));
  for (const id of required) {
    if (!known.has(id)) categories.push({ id, title: "Uncategorized", color: "#8f8f98" });
  }
  return categories;
}

export interface FocusTask {
  id: string;
  title: string;
  category: "work" | "health" | "personal";
  /** Actual TodoMate list membership; category remains a legacy firmware fallback. */
  categoryId?: string;
  memo: string;
  dueAt: string | null;
  completed: boolean;
}

export interface TaskCategory {
  id: string;
  title: string;
  color: string;
}

export const LEGACY_CATEGORIES: readonly TaskCategory[] = [
  { id: "work", title: "Work", color: "#a78bfa" },
  { id: "health", title: "Health", color: "#35d97f" },
  { id: "personal", title: "Personal", color: "#8b9cea" },
];

export interface TaskList {
  tasks: FocusTask[];
  focusId: string | null;
  /** Optional on old snapshots; parseTaskList supplies the legacy catalog. */
  categories?: TaskCategory[];
}

export interface TaskAdapter {
  readonly authoritativeCompletions?: boolean;
  readTasks(signal?: AbortSignal): Promise<TaskList>;
  completeTask(task: FocusTask, requestId: string, signal?: AbortSignal): Promise<TaskList>;
}

export interface FocusSnapshot extends TaskList {
  revision: number;
  mode: "demo" | "live";
  connection: "online" | "offline" | "unconfigured";
}

export class PocketError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status = 400,
  ) {
    super(message);
    this.name = "PocketError";
  }
}

export function publicError(error: unknown): PocketError {
  return error instanceof PocketError
    ? error
    : new PocketError("unavailable", "Something went wrong. Please try again.", 503);
}

export function identifier(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,62}$/.test(value);
}

export function parseTaskList(input: unknown): TaskList {
  if (!input || typeof input !== "object") throw invalidTasks();
  const value = input as Record<string, unknown>;
  if (!Array.isArray(value.tasks) || value.tasks.length > 16) throw invalidTasks();
  const rawCategories = value.categories === undefined ? LEGACY_CATEGORIES : value.categories;
  if (!Array.isArray(rawCategories) || rawCategories.length > 32) throw invalidTasks();
  const categoryIds = new Set<string>();
  const categories = rawCategories.map((raw: unknown): TaskCategory => {
    if (!raw || typeof raw !== "object") throw invalidTasks();
    const category = raw as Record<string, unknown>;
    if (
      !identifier(category.id) ||
      categoryIds.has(category.id) ||
      typeof category.title !== "string" ||
      !category.title.trim() ||
      new TextEncoder().encode(category.title).length > 63 ||
      typeof category.color !== "string" ||
      !/^#[0-9a-fA-F]{6}$/.test(category.color)
    )
      throw invalidTasks();
    categoryIds.add(category.id);
    return { id: category.id, title: category.title.trim(), color: category.color.toLowerCase() };
  });
  const seen = new Set<string>();
  const tasks = value.tasks.map((raw: unknown): FocusTask => {
    if (!raw || typeof raw !== "object") throw invalidTasks();
    const task = raw as Record<string, unknown>;
    if (
      !identifier(task.id) ||
      seen.has(task.id) ||
      typeof task.title !== "string" ||
      !task.title.trim() ||
      task.title.length > 160 ||
      new TextEncoder().encode(task.title).length > 191 ||
      !["work", "health", "personal"].includes(String(task.category)) ||
      (task.categoryId !== undefined &&
        (!identifier(task.categoryId) || !categoryIds.has(task.categoryId))) ||
      typeof task.memo !== "string" ||
      new TextEncoder().encode(task.memo).length > 1200 ||
      typeof task.completed !== "boolean" ||
      !(
        task.dueAt === null ||
        (typeof task.dueAt === "string" &&
          task.dueAt.length <= 39 &&
          /^\d{4}-\d{2}-\d{2}T/.test(task.dueAt) &&
          Number.isFinite(Date.parse(task.dueAt)))
      )
    )
      throw invalidTasks();
    seen.add(task.id);
    return {
      id: task.id,
      title: task.title.trim(),
      category: task.category as FocusTask["category"],
      ...(task.categoryId !== undefined ? { categoryId: task.categoryId as string } : {}),
      memo: task.memo,
      dueAt: task.dueAt as string | null,
      completed: task.completed,
    };
  });
  if (
    !(
      value.focusId === null ||
      (typeof value.focusId === "string" &&
        tasks.some((task) => task.id === value.focusId && !task.completed))
    )
  )
    throw invalidTasks();
  return { tasks, focusId: value.focusId as string | null, categories };
}

function invalidTasks(): PocketError {
  return new PocketError(
    "invalid_tasks",
    "The task service returned an invalid task list. Your current tasks are safe.",
    502,
  );
}

/** Preserve UTF-8 code points within the firmware's 3072-byte text buffer. */
export function fitDeviceText(text: string): string {
  const bytes = new TextEncoder().encode(text);
  if (bytes.length <= 3071) return text;
  let end = 3068; // Reserve three bytes for the ellipsis.
  while ((bytes[end]! & 0xc0) === 0x80) end--;
  return `${new TextDecoder().decode(bytes.subarray(0, end))}…`;
}

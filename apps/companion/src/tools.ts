/**
 * The tools Alfred may call mid-turn — this is how "ask / capture / command"
 * intent routing actually happens (SCOPE §3): the model decides whether to
 * answer, remember a fact, recall one, or set a reminder.
 *
 * Each tool's behaviour is also exported as a plain function so it is unit-
 * testable without constructing AI-SDK tool options; the `tool()` wrappers just
 * delegate. Tool bodies NEVER throw — the AI SDK would swallow a thrown error
 * into a tool-error part the bridge never sees, so the model would cheerfully
 * tell the user "Saved, sir." after a failed write. Instead they catch, report
 * via `onError`, and return a truthful message the model can relay.
 */

import { jsonSchema, tool, type ToolSet } from "ai";
import type { MemoryLike } from "./ports";
import type { ReminderService } from "./reminders";

export type ToolErrorReporter = (context: string, error: unknown) => void;

export interface RememberInput {
  fact: string;
  about?: string;
}

export interface RecallInput {
  query: string;
}

export interface SetReminderInput {
  text: string;
  inSeconds?: number;
  atIso?: string;
}

export async function rememberFact(
  memory: MemoryLike,
  groupId: string | undefined,
  input: RememberInput,
  onError?: ToolErrorReporter,
): Promise<string> {
  try {
    await memory.remember({
      predicate: "noted",
      content: input.fact,
      subject: input.about
        ? { name: input.about, entityType: "concept" }
        : { name: "user", entityType: "person" },
      ...(groupId ? { groupId } : {}),
    });
    return "Saved.";
  } catch (error) {
    onError?.("tool:remember", error);
    return "I'm afraid I couldn't save that just now, sir.";
  }
}

export async function recallFacts(
  memory: MemoryLike,
  groupId: string | undefined,
  input: RecallInput,
  onError?: ToolErrorReporter,
): Promise<string> {
  try {
    const results = await memory.recall({
      text: input.query,
      ...(groupId ? { groupId } : {}),
    });
    if (results.length === 0) return "No relevant memories.";
    return results.map((r) => `- ${r.observation.content}`).join("\n");
  } catch (error) {
    onError?.("tool:recall", error);
    return "I couldn't search my memory just now, sir.";
  }
}

export function scheduleReminder(
  reminders: ReminderService,
  now: () => Date,
  input: SetReminderInput,
  onError?: ToolErrorReporter,
): string {
  // Require an actual future time; a bare {text} must not silently land "now".
  if (!input.atIso && (input.inSeconds === undefined || input.inSeconds <= 0)) {
    return "For when shall I set that, sir?";
  }
  const base = now().getTime();
  const dueAt = input.atIso ? Date.parse(input.atIso) : base + (input.inSeconds ?? 0) * 1000;
  if (Number.isNaN(dueAt)) return "I couldn't make sense of that time, sir.";
  if (dueAt <= base) return "That time has already passed, sir.";
  try {
    reminders.add(input.text, dueAt);
  } catch (error) {
    onError?.("tool:set_reminder", error);
    return "I couldn't set that reminder just now, sir.";
  }
  return "Reminder set.";
}

/** Memory capture + recall tools, bound to a store and partition. */
export function buildMemoryTools(
  memory: MemoryLike,
  groupId?: string,
  onError?: ToolErrorReporter,
): ToolSet {
  return {
    remember: tool({
      description:
        "Save a durable fact the user told you for later recall — preferences, " +
        "facts about people or projects, things to remember. Acknowledge briefly after.",
      inputSchema: jsonSchema<RememberInput>({
        type: "object",
        additionalProperties: false,
        required: ["fact"],
        properties: {
          fact: { type: "string", description: "The fact, as a clear standalone statement." },
          about: {
            type: "string",
            description: "Optional subject (a person, project, or topic). Defaults to the user.",
          },
        },
      }),
      execute: (input) => rememberFact(memory, groupId, input, onError),
    }),
    recall: tool({
      description: "Search your long-term memory for facts relevant to a query.",
      inputSchema: jsonSchema<RecallInput>({
        type: "object",
        additionalProperties: false,
        required: ["query"],
        properties: { query: { type: "string", description: "What to look up." } },
      }),
      execute: (input) => recallFacts(memory, groupId, input, onError),
    }),
  };
}

/** A tool to set a future reminder, bound to a session's reminder list. */
export function buildReminderTool(
  reminders: ReminderService,
  now: () => Date,
  onError?: ToolErrorReporter,
): ToolSet {
  return {
    set_reminder: tool({
      description: "Set a reminder for the user at a future time (give inSeconds or an ISO time).",
      inputSchema: jsonSchema<SetReminderInput>({
        type: "object",
        additionalProperties: false,
        required: ["text"],
        properties: {
          text: { type: "string", description: "What to remind the user about." },
          inSeconds: { type: "number", description: "Fire this many seconds from now (> 0)." },
          atIso: { type: "string", description: "Absolute ISO-8601 time to fire at." },
        },
      }),
      execute: (input) => scheduleReminder(reminders, now, input, onError),
    }),
  };
}

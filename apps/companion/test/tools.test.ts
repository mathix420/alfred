import { describe, expect, it } from "bun:test";
import type { ObservationInput } from "@alfred/core/memory";
import type { MemoryLike } from "../src/ports";
import { ReminderService } from "../src/reminders";
import {
  buildMemoryTools,
  buildReminderTool,
  recallFacts,
  rememberFact,
  scheduleReminder,
} from "../src/tools";

function fakeMemory(over: Partial<MemoryLike> = {}): MemoryLike {
  return {
    recall: async () => [],
    ensureThread: async () => "t",
    appendMessage: async () => "m",
    remember: async () => "o",
    ...over,
  };
}

describe("rememberFact", () => {
  it("maps a fact to an observation with the user as default subject", async () => {
    let captured: ObservationInput | undefined;
    const memory = fakeMemory({
      remember: async (input) => {
        captured = input;
        return "o1";
      },
    });

    const result = await rememberFact(memory, "g", { fact: "Sir takes Earl Grey" });
    expect(result).toBe("Saved.");
    expect(captured?.content).toBe("Sir takes Earl Grey");
    expect(captured?.subject).toEqual({ name: "user", entityType: "person" });
    expect(captured?.groupId).toBe("g");
  });

  it("uses `about` as the subject when given", async () => {
    let captured: ObservationInput | undefined;
    const memory = fakeMemory({
      remember: async (input) => {
        captured = input;
        return "o";
      },
    });

    await rememberFact(memory, undefined, { fact: "ships on Fridays", about: "the project" });
    expect(captured?.subject.name).toBe("the project");
    expect(captured?.subject.entityType).toBe("concept");
  });
});

describe("recallFacts", () => {
  it("says so when nothing is found", async () => {
    expect(await recallFacts(fakeMemory(), undefined, { query: "tea" })).toBe(
      "No relevant memories.",
    );
  });

  it("formats recalled observation content", async () => {
    const memory = fakeMemory({
      recall: async () => [
        {
          observation: {
            uuid: "o",
            groupId: "default",
            predicate: "noted",
            content: "Sir likes tea.",
            embeddingModel: "m",
            createdAt: 0,
          },
          score: 1,
          entities: [],
          relatedObservations: [],
        },
      ],
    });
    expect(await recallFacts(memory, undefined, { query: "tea" })).toContain("Sir likes tea.");
  });
});

describe("scheduleReminder", () => {
  const now = () => new Date("2026-06-16T00:00:00.000Z");

  it("computes dueAt from inSeconds", () => {
    const reminders = new ReminderService();
    expect(scheduleReminder(reminders, now, { text: "tea", inSeconds: 60 })).toBe("Reminder set.");
    expect(reminders.list()[0]?.dueAt).toBe(Date.parse("2026-06-16T00:01:00.000Z"));
  });

  it("computes dueAt from an absolute ISO time", () => {
    const reminders = new ReminderService();
    scheduleReminder(reminders, now, { text: "call", atIso: "2026-06-16T09:00:00.000Z" });
    expect(reminders.list()[0]?.dueAt).toBe(Date.parse("2026-06-16T09:00:00.000Z"));
  });

  it("rejects an unparseable time without adding anything", () => {
    const reminders = new ReminderService();
    expect(scheduleReminder(reminders, now, { text: "x", atIso: "not a time" })).toContain(
      "couldn't",
    );
    expect(reminders.list()).toHaveLength(0);
  });

  it("asks for a time when neither inSeconds nor atIso is given", () => {
    const reminders = new ReminderService();
    expect(scheduleReminder(reminders, now, { text: "call mum" })).toContain("when");
    expect(reminders.list()).toHaveLength(0);
  });

  it("rejects a non-positive inSeconds", () => {
    const reminders = new ReminderService();
    expect(scheduleReminder(reminders, now, { text: "x", inSeconds: 0 })).toContain("when");
    expect(reminders.list()).toHaveLength(0);
  });

  it("rejects a past absolute time", () => {
    const reminders = new ReminderService();
    expect(
      scheduleReminder(reminders, now, { text: "x", atIso: "2020-01-01T00:00:00.000Z" }),
    ).toContain("passed");
    expect(reminders.list()).toHaveLength(0);
  });
});

describe("tool failures are truthful, not silent", () => {
  it("reports and admits failure when remember throws", async () => {
    const errors: string[] = [];
    const memory = fakeMemory({
      remember: async () => {
        throw new Error("neo4j down");
      },
    });
    const result = await rememberFact(memory, undefined, { fact: "x" }, (c) => errors.push(c));
    expect(result).not.toBe("Saved.");
    expect(errors).toContain("tool:remember");
  });

  it("reports and degrades when recall throws", async () => {
    const errors: string[] = [];
    const memory = fakeMemory({
      recall: async () => {
        throw new Error("neo4j down");
      },
    });
    const result = await recallFacts(memory, undefined, { query: "x" }, (c) => errors.push(c));
    expect(result).toContain("couldn't");
    expect(errors).toContain("tool:recall");
  });
});

describe("tool builders", () => {
  it("expose the expected tool names", () => {
    expect(Object.keys(buildMemoryTools(fakeMemory())).sort()).toEqual(["recall", "remember"]);
    expect(Object.keys(buildReminderTool(new ReminderService(), () => new Date()))).toEqual([
      "set_reminder",
    ]);
  });
});

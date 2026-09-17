import { describe, expect, it } from "bun:test";
import type { RecallResult } from "@alfred/core/memory";
import { ALFRED_PERSONA, buildContextMessage } from "../src/persona";

const NOW = new Date("2026-06-16T12:00:00.000Z");

describe("ALFRED_PERSONA", () => {
  it("names Alfred and pushes for spoken brevity", () => {
    expect(ALFRED_PERSONA).toContain("Alfred");
    expect(ALFRED_PERSONA.toLowerCase()).toContain("brief");
  });
});

describe("buildContextMessage", () => {
  it("always includes the current time", () => {
    expect(buildContextMessage({ now: NOW })).toContain("2026-06-16T12:00:00.000Z");
  });

  it("omits the recollection block when nothing is recalled", () => {
    expect(buildContextMessage({ now: NOW, recalled: [] })).not.toContain("recollections");
  });

  it("lists recalled observation content", () => {
    const recalled: RecallResult[] = [
      {
        observation: {
          uuid: "o1",
          groupId: "default",
          predicate: "prefers",
          content: "Sir prefers Earl Grey tea.",
          embeddingModel: "local/nomic-embed-text",
          createdAt: 0,
        },
        score: 0.9,
        entities: [],
        relatedObservations: [],
      },
    ];
    const ctx = buildContextMessage({ now: NOW, recalled });
    expect(ctx).toContain("Earl Grey");
    expect(ctx).toContain("recollections");
  });
});

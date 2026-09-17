import { describe, expect, it } from "bun:test";
import {
  mapMessageProps,
  mapObservationProps,
  mapRecallRow,
  mapThreadProps,
} from "../src/memory/mappers";

describe("mapMessageProps", () => {
  it("maps a property bag, coercing null tokenCount to undefined", () => {
    expect(
      mapMessageProps({
        uuid: "u",
        groupId: "g",
        threadId: "t",
        role: "assistant",
        content: "hi",
        seq: 2,
        createdAt: 123,
        tokenCount: null,
      }),
    ).toEqual({
      uuid: "u",
      groupId: "g",
      threadId: "t",
      role: "assistant",
      content: "hi",
      seq: 2,
      createdAt: 123,
      tokenCount: undefined,
    });
  });
});

describe("mapThreadProps", () => {
  it("coerces absent title/summary to undefined", () => {
    const t = mapThreadProps({
      uuid: "t",
      groupId: "g",
      title: null,
      summary: null,
      createdAt: 1,
      lastMessageAt: 2,
    });
    expect(t.title).toBeUndefined();
    expect(t.lastMessageAt).toBe(2);
  });
});

describe("mapObservationProps", () => {
  it("maps temporal fields, nulls becoming undefined", () => {
    const o = mapObservationProps({
      uuid: "f",
      groupId: "g",
      predicate: "likes",
      content: "Ada likes graphs",
      embeddingModel: "local/nomic-embed-text",
      confidence: null,
      createdAt: 10,
      expiredAt: null,
      validAt: 5,
      invalidAt: null,
    });
    expect(o.expiredAt).toBeUndefined();
    expect(o.validAt).toBe(5);
    expect(o.confidence).toBeUndefined();
  });
});

describe("mapRecallRow", () => {
  it("reads through a get accessor", () => {
    const row: Record<string, unknown> = {
      observation: {
        uuid: "f",
        groupId: "g",
        predicate: "p",
        content: "c",
        embeddingModel: "local/nomic-embed-text",
        confidence: 0.9,
        createdAt: 1,
        expiredAt: null,
        validAt: null,
        invalidAt: null,
      },
      score: 0.82,
      entities: [{ uuid: "e", name: "Ada", entityType: "person" }],
      relatedObservations: [],
    };
    const result = mapRecallRow((key) => row[key]);
    expect(result.score).toBe(0.82);
    expect(result.observation.uuid).toBe("f");
    expect(result.entities[0]?.name).toBe("Ada");
  });
});

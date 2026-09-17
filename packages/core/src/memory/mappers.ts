/**
 * Pure record → domain mappers. They take only plain property bags or a `get`
 * accessor (never a tx-bound driver object), so they are unit-testable with
 * fakes and never import `neo4j-driver`.
 *
 * With the driver's `disableLosslessIntegers: true`, integer properties already
 * arrive as plain JS `number`s, so mapping is a straight field copy.
 */

import type { Message, Observation, RecallResult, Thread } from "./types";

export function mapMessageProps(p: Record<string, unknown>): Message {
  return {
    uuid: p.uuid as string,
    groupId: p.groupId as string,
    threadId: p.threadId as string,
    role: p.role as Message["role"],
    content: p.content as string,
    seq: p.seq as number,
    createdAt: p.createdAt as number,
    tokenCount: (p.tokenCount as number | null) ?? undefined,
  };
}

export function mapThreadProps(p: Record<string, unknown>): Thread {
  return {
    uuid: p.uuid as string,
    groupId: p.groupId as string,
    title: (p.title as string | null) ?? undefined,
    summary: (p.summary as string | null) ?? undefined,
    createdAt: p.createdAt as number,
    lastMessageAt: p.lastMessageAt as number,
  };
}

export function mapObservationProps(p: Record<string, unknown>): Observation {
  return {
    uuid: p.uuid as string,
    groupId: p.groupId as string,
    predicate: p.predicate as string,
    content: p.content as string,
    embeddingModel: p.embeddingModel as string,
    confidence: (p.confidence as number | null) ?? undefined,
    createdAt: p.createdAt as number,
    expiredAt: (p.expiredAt as number | null) ?? undefined,
    validAt: (p.validAt as number | null) ?? undefined,
    invalidAt: (p.invalidAt as number | null) ?? undefined,
  };
}

/** Map one recall row, addressed through a `get(key)` accessor. */
export function mapRecallRow(get: (key: string) => unknown): RecallResult {
  return {
    observation: mapObservationProps(get("observation") as Record<string, unknown>),
    score: get("score") as number,
    entities: get("entities") as RecallResult["entities"],
    relatedObservations: get("relatedObservations") as RecallResult["relatedObservations"],
  };
}

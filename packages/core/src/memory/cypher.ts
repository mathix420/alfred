/**
 * Pure Cypher builders. Every exported builder returns `{ cypher, params }` and
 * never inlines a domain value — all data flows through `$params`. The only
 * identifiers ever inlined are labels / relationship types / index names, and
 * only after `assertLabel` / `assertRelType` + `escapeId`. No driver, no I/O.
 *
 * This file is the second heavily unit-tested piece (the `parseModelId`
 * analogue): tests assert each builder parameterizes its inputs and that the
 * schema DDL validates its dimensions/similarity.
 */

export interface CypherQuery {
  cypher: string;
  params: Record<string, unknown>;
}

/* ---- Identifier allowlists (Cypher-injection defense) ---- */

export const LABELS = ["Message", "Thread", "Entity", "Fact"] as const;
export const REL_TYPES = [
  "IN_THREAD",
  "DERIVED_FROM",
  "SUBJECT",
  "OBJECT",
  "MENTIONS",
  "SUPERSEDES",
] as const;
export type Label = (typeof LABELS)[number];
export type RelType = (typeof REL_TYPES)[number];

/** Fixed index names — referenced as string constants, never user input. */
export const FACT_EMBEDDING_INDEX = "fact_embedding";
export const ENTITY_EMBEDDING_INDEX = "entity_name_embedding";
export const FACT_CONTENT_FT_INDEX = "fact_content_ft";
export const ENTITY_NAME_FT_INDEX = "entity_name_ft";

export function assertLabel(value: string): asserts value is Label {
  if (!(LABELS as readonly string[]).includes(value)) {
    throw new Error(`Unknown label "${value}". Allowed: ${LABELS.join(", ")}.`);
  }
}

export function assertRelType(value: string): asserts value is RelType {
  if (!(REL_TYPES as readonly string[]).includes(value)) {
    throw new Error(`Unknown relationship type "${value}". Allowed: ${REL_TYPES.join(", ")}.`);
  }
}

/** Backtick-escape an identifier (a backtick inside doubles). Defense in depth. */
export function escapeId(id: string): string {
  return `\`${id.replaceAll("`", "``")}\``;
}

/* ---- Schema DDL ---- */

export type Similarity = "cosine" | "euclidean";

const MAX_DIMENSIONS = 4096;

function assertDimensions(dims: number): void {
  if (!Number.isInteger(dims) || dims < 1 || dims > MAX_DIMENSIONS) {
    throw new Error(
      `Invalid vector dimensions ${dims} (must be an integer in 1..${MAX_DIMENSIONS}).`,
    );
  }
}

function assertSimilarity(similarity: string): asserts similarity is Similarity {
  if (similarity !== "cosine" && similarity !== "euclidean") {
    throw new Error(`Invalid similarity "${similarity}" (must be "cosine" or "euclidean").`);
  }
}

/**
 * Ordered, Community-safe schema statements (each a single DDL command). `dims`
 * and `similarity` are config, but are still validated before interpolation so
 * the vector-index DDL can never carry an injected value.
 */
export function SCHEMA_STATEMENTS(dims: number, similarity: Similarity): string[] {
  assertDimensions(dims);
  assertSimilarity(similarity);

  const vectorIndex = (name: string, label: Label, prop: string): string =>
    `CREATE VECTOR INDEX ${name} IF NOT EXISTS\n` +
    `FOR (n:${label}) ON (n.${prop})\n` +
    `OPTIONS { indexConfig: { \`vector.dimensions\`: ${dims}, ` +
    `\`vector.similarity_function\`: '${similarity}' } }`;

  return [
    "CREATE CONSTRAINT message_uuid IF NOT EXISTS FOR (m:Message) REQUIRE m.uuid IS UNIQUE",
    "CREATE CONSTRAINT thread_uuid IF NOT EXISTS FOR (t:Thread) REQUIRE t.uuid IS UNIQUE",
    "CREATE CONSTRAINT entity_uuid IF NOT EXISTS FOR (e:Entity) REQUIRE e.uuid IS UNIQUE",
    "CREATE CONSTRAINT fact_uuid IF NOT EXISTS FOR (f:Fact) REQUIRE f.uuid IS UNIQUE",
    "CREATE CONSTRAINT entity_dedup IF NOT EXISTS FOR (e:Entity) REQUIRE e.dedupKey IS UNIQUE",

    "CREATE RANGE INDEX message_thread IF NOT EXISTS FOR (m:Message) ON (m.threadId)",
    "CREATE RANGE INDEX message_thread_seq IF NOT EXISTS FOR (m:Message) ON (m.threadId, m.seq)",
    "CREATE RANGE INDEX thread_group IF NOT EXISTS FOR (t:Thread) ON (t.groupId, t.lastMessageAt)",
    "CREATE RANGE INDEX entity_norm IF NOT EXISTS FOR (e:Entity) ON (e.groupId, e.normalizedName)",
    "CREATE RANGE INDEX entity_type IF NOT EXISTS FOR (e:Entity) ON (e.groupId, e.entityType)",
    "CREATE RANGE INDEX fact_group IF NOT EXISTS FOR (f:Fact) ON (f.groupId)",
    "CREATE RANGE INDEX fact_expired IF NOT EXISTS FOR (f:Fact) ON (f.expiredAt)",
    "CREATE RANGE INDEX fact_validity IF NOT EXISTS FOR (f:Fact) ON (f.validAt, f.invalidAt)",

    "CREATE FULLTEXT INDEX fact_content_ft IF NOT EXISTS FOR (f:Fact) ON EACH [f.content]",
    "CREATE FULLTEXT INDEX entity_name_ft IF NOT EXISTS FOR (e:Entity) ON EACH [e.name, e.summary]",

    vectorIndex(FACT_EMBEDDING_INDEX, "Fact", "embedding"),
    vectorIndex(ENTITY_EMBEDDING_INDEX, "Entity", "nameEmbedding"),
  ];
}

/** Enterprise-only statements; run in try/catch so Community boots cleanly. */
export function ENTERPRISE_SCHEMA_STATEMENTS(): string[] {
  return [
    "CREATE CONSTRAINT fact_group_exists IF NOT EXISTS FOR (f:Fact) REQUIRE f.groupId IS NOT NULL",
    "CREATE CONSTRAINT fact_created_exists IF NOT EXISTS FOR (f:Fact) REQUIRE f.createdAt IS NOT NULL",
    "CREATE CONSTRAINT msg_thread_exists IF NOT EXISTS FOR (m:Message) REQUIRE m.threadId IS NOT NULL",
  ];
}

/* ---- Write builders ---- */

export function ensureThread(args: {
  uuid: string;
  groupId: string;
  title: string | null;
  summary: string | null;
  now: number;
}): CypherQuery {
  return {
    cypher: `
MERGE (t:Thread {uuid: $uuid})
ON CREATE SET t.groupId = $groupId, t.title = $title, t.summary = $summary,
              t.createdAt = $now, t.lastMessageAt = $now
RETURN t.uuid AS uuid`.trim(),
    params: args,
  };
}

export function nextSeq(args: { threadId: string }): CypherQuery {
  return {
    cypher: `
MATCH (m:Message {threadId: $threadId})
RETURN coalesce(max(m.seq), -1) + 1 AS seq`.trim(),
    params: args,
  };
}

export function appendMessage(args: {
  uuid: string;
  groupId: string;
  threadId: string;
  role: string;
  content: string;
  seq: number;
  createdAt: number;
  tokenCount: number | null;
}): CypherQuery {
  return {
    cypher: `
MERGE (m:Message {uuid: $uuid})
ON CREATE SET
  m.groupId = $groupId, m.threadId = $threadId, m.role = $role,
  m.content = $content, m.seq = $seq, m.createdAt = $createdAt,
  m.tokenCount = $tokenCount
WITH m
MERGE (t:Thread {uuid: $threadId})
ON CREATE SET t.groupId = $groupId, t.createdAt = $createdAt, t.lastMessageAt = $createdAt
MERGE (m)-[:IN_THREAD]->(t)
SET t.lastMessageAt = $createdAt
RETURN m.uuid AS uuid`.trim(),
    params: args,
  };
}

export function getThread(args: { threadId: string; groupId: string }): CypherQuery {
  return {
    cypher: "MATCH (t:Thread {uuid: $threadId, groupId: $groupId}) RETURN t",
    params: args,
  };
}

export function threadMessages(args: {
  threadId: string;
  groupId: string;
  limit: unknown;
}): CypherQuery {
  return {
    cypher: `
MATCH (m:Message {threadId: $threadId, groupId: $groupId})
RETURN m ORDER BY m.seq ASC LIMIT $limit`.trim(),
    params: args,
  };
}

export function upsertEntity(args: {
  dedupKey: string;
  uuid: string;
  groupId: string;
  name: string;
  normalizedName: string;
  entityType: string;
  summary: string | null;
  nameEmbedding: number[];
  embeddingModel: string;
  now: number;
}): CypherQuery {
  return {
    cypher: `
MERGE (e:Entity {dedupKey: $dedupKey})
ON CREATE SET
  e.uuid = $uuid, e.groupId = $groupId, e.name = $name,
  e.normalizedName = $normalizedName, e.entityType = $entityType,
  e.summary = $summary, e.embeddingModel = $embeddingModel,
  e.createdAt = $now, e.updatedAt = $now
ON MATCH SET
  e.summary = coalesce($summary, e.summary), e.updatedAt = $now
WITH e
CALL db.create.setNodeVectorProperty(e, 'nameEmbedding', $nameEmbedding)
RETURN e.uuid AS uuid`.trim(),
    params: args,
  };
}

export function createFact(args: {
  uuid: string;
  groupId: string;
  predicate: string;
  content: string;
  embedding: number[];
  embeddingModel: string;
  confidence: number | null;
  now: number;
  validAt: number | null;
  invalidAt: number | null;
}): CypherQuery {
  return {
    cypher: `
MERGE (f:Fact {uuid: $uuid})
ON CREATE SET
  f.groupId = $groupId, f.predicate = $predicate, f.content = $content,
  f.embeddingModel = $embeddingModel, f.confidence = $confidence,
  f.createdAt = $now, f.validAt = $validAt, f.invalidAt = $invalidAt
WITH f
CALL db.create.setNodeVectorProperty(f, 'embedding', $embedding)
RETURN f.uuid AS uuid`.trim(),
    params: args,
  };
}

export function linkFactSubject(args: { uuid: string; subjectUuid: string }): CypherQuery {
  return {
    cypher: `
MATCH (f:Fact {uuid: $uuid}), (s:Entity {uuid: $subjectUuid})
MERGE (f)-[:SUBJECT]->(s)`.trim(),
    params: args,
  };
}

export function linkFactObject(args: { uuid: string; objectUuid: string }): CypherQuery {
  return {
    cypher: `
MATCH (f:Fact {uuid: $uuid}), (o:Entity {uuid: $objectUuid})
MERGE (f)-[:OBJECT]->(o)`.trim(),
    params: args,
  };
}

export function linkFactSources(args: { uuid: string; sourceMessageUuids: string[] }): CypherQuery {
  return {
    cypher: `
MATCH (f:Fact {uuid: $uuid})
UNWIND $sourceMessageUuids AS mid
  MATCH (msg:Message {uuid: mid})
  MERGE (f)-[:DERIVED_FROM]->(msg)`.trim(),
    params: args,
  };
}

export function linkFactMentions(args: { uuid: string; mentionUuids: string[] }): CypherQuery {
  return {
    cypher: `
MATCH (f:Fact {uuid: $uuid})
UNWIND $mentionUuids AS ent
  MATCH (me:Entity {uuid: ent})
  MERGE (f)-[:MENTIONS]->(me)`.trim(),
    params: args,
  };
}

export function invalidateFact(args: {
  oldUuid: string;
  groupId: string;
  expiredAt: number;
  invalidAt: number | null;
}): CypherQuery {
  return {
    cypher: `
MATCH (old:Fact {uuid: $oldUuid, groupId: $groupId})
SET old.expiredAt = $expiredAt,
    old.invalidAt = coalesce(old.invalidAt, $invalidAt)`.trim(),
    params: args,
  };
}

export function invalidateAndSupersede(args: {
  oldUuid: string;
  newUuid: string;
  groupId: string;
  expiredAt: number;
  invalidAt: number | null;
}): CypherQuery {
  return {
    cypher: `
MATCH (old:Fact {uuid: $oldUuid, groupId: $groupId})
MATCH (new:Fact {uuid: $newUuid, groupId: $groupId})
SET old.expiredAt = $expiredAt,
    old.invalidAt = coalesce(old.invalidAt, $invalidAt)
MERGE (new)-[:SUPERSEDES]->(old)`.trim(),
    params: args,
  };
}

/* ---- Recall builders ---- */

/**
 * Vector seed → graph expansion in one statement. `$indexName` is a bound
 * parameter because `db.index.vector.queryNodes` takes the index name as a
 * STRING argument; the value still comes from a fixed allowlist constant.
 */
export function recallVector(args: {
  indexName: string;
  k: unknown;
  queryEmbedding: number[];
  groupId: string;
  asOf: number;
  minScore: number;
}): CypherQuery {
  return {
    cypher: `
CALL db.index.vector.queryNodes($indexName, $k, $queryEmbedding)
YIELD node AS f, score
WHERE f.groupId = $groupId
  AND score >= $minScore
  AND f.expiredAt IS NULL
  AND (f.validAt IS NULL OR f.validAt <= $asOf)
  AND (f.invalidAt IS NULL OR f.invalidAt > $asOf)
OPTIONAL MATCH (f)-[:SUBJECT|OBJECT|MENTIONS]->(e:Entity)
OPTIONAL MATCH (e)<-[:SUBJECT]-(related:Fact)
  WHERE related.expiredAt IS NULL
    AND (related.invalidAt IS NULL OR related.invalidAt > $asOf)
    AND related.uuid <> f.uuid
WITH f, score,
     collect(DISTINCT e {uuid: e.uuid, name: e.name, entityType: e.entityType}) AS entities,
     collect(DISTINCT related {uuid: related.uuid, content: related.content,
                               predicate: related.predicate})[0..5] AS relatedObservations
RETURN f {.uuid, .groupId, .predicate, .content, .embeddingModel, .confidence,
          .createdAt, .expiredAt, .validAt, .invalidAt} AS observation,
       score, entities, relatedObservations
ORDER BY score DESC`.trim(),
    params: args,
  };
}

/** Fulltext recall over Fact.content, same projection as `recallVector`. */
export function recallFulltext(args: {
  indexName: string;
  query: string;
  k: unknown;
  groupId: string;
  asOf: number;
}): CypherQuery {
  return {
    cypher: `
CALL db.index.fulltext.queryNodes($indexName, $query)
YIELD node AS f, score
WHERE f.groupId = $groupId
  AND f.expiredAt IS NULL
  AND (f.validAt IS NULL OR f.validAt <= $asOf)
  AND (f.invalidAt IS NULL OR f.invalidAt > $asOf)
WITH f, score ORDER BY score DESC LIMIT $k
OPTIONAL MATCH (f)-[:SUBJECT|OBJECT|MENTIONS]->(e:Entity)
OPTIONAL MATCH (e)<-[:SUBJECT]-(related:Fact)
  WHERE related.expiredAt IS NULL
    AND (related.invalidAt IS NULL OR related.invalidAt > $asOf)
    AND related.uuid <> f.uuid
WITH f, score,
     collect(DISTINCT e {uuid: e.uuid, name: e.name, entityType: e.entityType}) AS entities,
     collect(DISTINCT related {uuid: related.uuid, content: related.content,
                               predicate: related.predicate})[0..5] AS relatedObservations
RETURN f {.uuid, .groupId, .predicate, .content, .embeddingModel, .confidence,
          .createdAt, .expiredAt, .validAt, .invalidAt} AS observation,
       score, entities, relatedObservations
ORDER BY score DESC`.trim(),
    params: args,
  };
}

/**
 * Reciprocal-rank fusion. Each input is an ordered list of ids (best first);
 * returns ids sorted by fused score. Pure — unit-tested independently.
 */
export function rrf(rankings: string[][], k = 60): Array<{ id: string; score: number }> {
  const scores = new Map<string, number>();
  for (const ranking of rankings) {
    ranking.forEach((id, index) => {
      scores.set(id, (scores.get(id) ?? 0) + 1 / (k + index + 1));
    });
  }
  return [...scores.entries()]
    .map(([id, score]) => ({ id, score }))
    .sort((a, b) => b.score - a.score);
}

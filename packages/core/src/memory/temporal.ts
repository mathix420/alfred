/**
 * Pure helpers for the bi-temporal state machine and entity identity. No I/O,
 * no driver — trivially unit-testable.
 *
 * Timestamps are epoch milliseconds. A fact is "live" while `expiredAt` is unset
 * (transaction time); it is "currently true" if, in addition, the event-time
 * window [validAt, invalidAt) contains the as-of instant.
 */

/** Current wall-clock time as epoch milliseconds. */
export function now(): number {
  return Date.now();
}

/** A fact is live until its transaction-time `expiredAt` is stamped. */
export function isLive(fact: { expiredAt?: number | null }): boolean {
  return fact.expiredAt === undefined || fact.expiredAt === null;
}

/** True iff the fact is live AND its event-time window contains `asOf`. */
export function isCurrentlyTrue(
  fact: { expiredAt?: number | null; validAt?: number | null; invalidAt?: number | null },
  asOf: number,
): boolean {
  if (!isLive(fact)) return false;
  if (typeof fact.validAt === "number" && fact.validAt > asOf) return false;
  if (typeof fact.invalidAt === "number" && fact.invalidAt <= asOf) return false;
  return true;
}

/**
 * Canonical form of an entity name for exact dedup: trimmed, lower-cased,
 * whitespace-collapsed, punctuation-stripped (Unicode letters/numbers kept).
 */
export function normalizeName(name: string): string {
  return name
    .normalize("NFKC")
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, "")
    .replace(/\s+/gu, " ")
    .trim();
}

/** Stable dedup key for the `Entity.dedupKey` uniqueness constraint. */
export function dedupKeyOf(groupId: string, entityType: string, normalizedName: string): string {
  return `${groupId}|${entityType}|${normalizedName}`;
}

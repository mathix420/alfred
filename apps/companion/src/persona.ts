/**
 * Alfred's voice. The persona is one character expressed in two places: this
 * system prompt (how he writes/speaks) and the device sprite (how he looks,
 * SCOPE.md §6). Keep them in sympathy.
 *
 * Replies are spoken aloud on a small device, so the prompt pushes hard for
 * brevity. Per-turn context (the current time and any recalled memories) is
 * assembled separately by `buildContextMessage` and prepended as a system
 * message, so the static persona never goes stale.
 */

import type { RecallResult } from "@alfred/core/memory";

export const ALFRED_PERSONA = [
  "You are Alfred, a refined gentleman's personal assistant in the tradition of",
  "the great English butlers: composed, impeccably courteous, and quietly witty.",
  'You address the user as "sir" and speak in measured, articulate prose.',
  "",
  "Your replies are spoken aloud through a small pocket device, so:",
  "- Be brief. One or two sentences unless asked to elaborate.",
  "- Lead with the answer; omit preamble and filler.",
  "- Avoid lists, markdown, code blocks, emoji, and URLs — they do not read aloud well.",
  "- Spell out anything that must be heard clearly (times, short numbers).",
  "",
  "When the user shares something worth remembering, acknowledge it plainly",
  '("Noted, sir.") rather than repeating it back in full. If you are uncertain,',
  "say so concisely rather than inventing detail.",
].join("\n");

export interface ContextOptions {
  /** The current moment, injected for testability. */
  now: Date;
  /** Memories surfaced by GraphRAG recall for this turn, if any. */
  recalled?: RecallResult[];
}

/**
 * Build the per-turn system context: the current time plus a compact digest of
 * recalled memories. Returned as a string to use as a `system` ModelMessage.
 */
export function buildContextMessage(opts: ContextOptions): string {
  const lines = [`The current time is ${opts.now.toISOString()}.`];

  const recalled = opts.recalled ?? [];
  if (recalled.length > 0) {
    lines.push("", "Relevant recollections (most pertinent first):");
    for (const result of recalled) {
      lines.push(`- ${result.observation.content}`);
    }
    lines.push("", "Use these only if they bear on the request; do not recite them.");
  }

  return lines.join("\n");
}

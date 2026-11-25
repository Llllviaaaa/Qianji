/**
 * Non-destructive context pruning (ADR 0024): records compact replacement text
 * for oversized historical `tool-result` blocks under a `custom` event so
 * `deriveState()` shrinks the model prompt without altering `.jsonl` transcripts.
 */
import type { ToolResultContent } from "@qianji/llm";
import type { SessionEvent } from "./types.ts";

export const PRUNE_NAMESPACE = "qianji-context-prune";

export interface ContextPruneEventData {
  replacements: Record<string, string>;
}

/**
 * Collect merged `callId -> prunedText` replacements from `PRUNE_NAMESPACE`
 * events on `branch` strictly after `afterSeq` (e.g. `compaction.throughSeq`).
 */
export function collectPruneReplacements(branch: readonly SessionEvent[], afterSeq = 0): Map<string, string> {
  const merged = new Map<string, string>();
  for (const event of branch) {
    if (event.seq <= afterSeq || event.type !== "custom" || event.data.ns !== PRUNE_NAMESPACE) continue;
    const raw = event.data.data;
    if (typeof raw !== "object" || raw === null) continue;
    const replacements = (raw as { replacements?: unknown }).replacements;
    if (typeof replacements !== "object" || replacements === null) continue;
    for (const [callId, text] of Object.entries(replacements)) {
      if (typeof text === "string") merged.set(callId, text);
    }
  }
  return merged;
}

/** Replace text blocks of a `tool-result` with `prunedText` while preserving non-text blocks. */
export function applyPrunedToolContent(content: readonly ToolResultContent[], prunedText: string): ToolResultContent[] {
  const nonText = content.filter((block) => block.type !== "text");
  return nonText.length > 0 ? [{ type: "text", text: prunedText }, ...nonText] : [{ type: "text", text: prunedText }];
}

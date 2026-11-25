/**
 * Stage 1 non-destructive tool-result pruner and branch token estimator (ADR 0024):
 * trims oversized historical `tool-result` payloads outside the recent step window
 * via `PRUNE_NAMESPACE` shadow events before Stage 2 LLM summarization.
 */
import {
  COMPACTION_PREFIX, PRUNE_NAMESPACE, charTokens, collectPruneReplacements,
  currentBranch, estimateEventTokens, slidingCompactionPoint,
  type EventOf, type Session, type SessionEvent,
} from "@qianji/session";

export const PRUNE_MIN_CHARS = 8_192;
export const PRUNE_HEAD_CHARS = 2_048;
export const PRUNE_TAIL_CHARS = 1_024;
export const PRUNE_IDLE_TTL_MS = 5 * 60_000;
export const PRUNE_IDLE_RATIO = 0.5;
export const PRUNE_HYSTERESIS_RATIO = 0.65;

/** Format middle-omitted replacement text for an oversized `tool-result`. */
export function formatPrunedToolResult(rawText: string): string {
  if (rawText.length <= PRUNE_MIN_CHARS) return rawText;
  const omitted = rawText.length - PRUNE_HEAD_CHARS - PRUNE_TAIL_CHARS;
  return `${rawText.slice(0, PRUNE_HEAD_CHARS)}\n\n[... ${omitted} characters pruned to relieve context pressure ...]\n\n${rawText.slice(rawText.length - PRUNE_TAIL_CHARS)}`;
}

function prunableCutoffSeq(events: readonly SessionEvent[], keepRecentTokens: number): number | undefined {
  const branch = currentBranch(events);
  const tipSeq = branch.at(-1)?.seq;
  if (tipSeq === undefined) return undefined;
  if (keepRecentTokens <= 0) return tipSeq;

  const slidingCut = slidingCompactionPoint(events, keepRecentTokens);
  if (slidingCut !== undefined && slidingCut < tipSeq) return slidingCut;

  const lastCompactionThrough = branch.findLast((ev) => ev.type === "compaction")?.data.throughSeq ?? 0;
  const post = branch.filter((ev) => ev.seq > lastCompactionThrough);
  const unitEndSeqs: number[] = [];
  let hasTurn = false;
  let hasAssistant = false;
  let lastSeqInUnit: number | undefined;
  const openCalls = new Set<string>();

  for (const ev of post) {
    const startsNewUnit = openCalls.size === 0 && (
      (ev.type === "user" && hasTurn)
      || (ev.type === "assistant" && hasAssistant)
    );
    if (startsNewUnit && lastSeqInUnit !== undefined) {
      unitEndSeqs.push(lastSeqInUnit);
      hasTurn = false;
      hasAssistant = false;
    }
    lastSeqInUnit = ev.seq;
    if (ev.type === "user") hasTurn = true;
    else if (ev.type === "assistant") {
      hasTurn = true;
      hasAssistant = true;
      for (const block of ev.data.content) if (block.type === "tool-call") openCalls.add(block.id);
    } else if (ev.type === "tool-call") openCalls.add(ev.data.callId);
    else if (ev.type === "tool-result") openCalls.delete(ev.data.callId);
  }
  return unitEndSeqs.at(-1);
}

/**
 * Append a `PRUNE_NAMESPACE` shadow event replacing unpruned `tool-result` texts
 * (`> 8,192` chars) strictly before the kept recent window.
 */
export function pruneOldToolResults(session: Session, keepRecentTokens = 12_000): EventOf<"custom"> | undefined {
  const cutoffSeq = prunableCutoffSeq(session.events, keepRecentTokens);
  if (cutoffSeq === undefined) return undefined;
  const branch = currentBranch(session.events);
  const lastCompactionThrough = branch.findLast((ev) => ev.type === "compaction")?.data.throughSeq ?? 0;
  const alreadyPruned = collectPruneReplacements(branch, lastCompactionThrough);
  const replacements: Record<string, string> = {};

  for (const event of branch) {
    if (event.seq <= lastCompactionThrough || event.seq > cutoffSeq) continue;
    if (event.type !== "tool-result" || alreadyPruned.has(event.data.callId)) continue;
    const rawText = event.data.content.flatMap((block) => (block.type === "text" ? [block.text] : [])).join("\n");
    if (rawText.length > PRUNE_MIN_CHARS) {
      replacements[event.data.callId] = formatPrunedToolResult(rawText);
    }
  }
  if (Object.keys(replacements).length === 0) return undefined;
  return session.append("custom", { ns: PRUNE_NAMESPACE, data: { replacements } });
}

function estimateToolResultTokens(event: Extract<SessionEvent, { type: "tool-result" }>, prunedText: string | undefined): number {
  if (prunedText === undefined) return estimateEventTokens(event);
  const imageCount = event.data.content.filter((b) => b.type !== "text").length;
  return Math.ceil(charTokens(prunedText) + imageCount * 256);
}

/** Estimate active branch context tokens accounting for `PRUNE_NAMESPACE` shadow replacements. */
export function estimateBranchContextTokens(events: readonly SessionEvent[]): {
  used: number;
  lastAssistant: Extract<SessionEvent, { type: "assistant" }> | undefined;
} {
  const branch = currentBranch(events);
  const lastCompaction = branch.findLast((ev) => ev.type === "compaction");
  const afterSeq = lastCompaction?.data.throughSeq ?? 0;
  const post = branch.filter((ev) => ev.seq > afterSeq);
  const prunedAll = collectPruneReplacements(post, afterSeq);
  const lastAssistant = post.findLast((ev): ev is Extract<SessionEvent, { type: "assistant" }> => ev.type === "assistant");

  if (lastAssistant !== undefined) {
    const u = lastAssistant.data.usage;
    const base = u.inputTokens + u.outputTokens + u.cacheReadTokens + u.cacheWriteTokens;
    const prunedAtLast = collectPruneReplacements(post.filter((ev) => ev.seq <= lastAssistant.seq), afterSeq);
    let savedFromBase = 0;
    let trailing = 0;
    for (const ev of post) {
      if (ev.seq < lastAssistant.seq && ev.type === "tool-result" && !prunedAtLast.has(ev.data.callId)) {
        const replacement = prunedAll.get(ev.data.callId);
        if (replacement !== undefined) {
          savedFromBase += Math.max(0, estimateEventTokens(ev) - estimateToolResultTokens(ev, replacement));
        }
      } else if (ev.seq > lastAssistant.seq) {
        trailing += ev.type === "tool-result"
          ? estimateToolResultTokens(ev, prunedAll.get(ev.data.callId))
          : estimateEventTokens(ev);
      }
    }
    return { used: Math.max(0, base - savedFromBase) + trailing, lastAssistant };
  }

  let total = lastCompaction === undefined ? 0 : Math.ceil(charTokens(COMPACTION_PREFIX + lastCompaction.data.summary));
  for (const ev of post) {
    total += ev.type === "tool-result"
      ? estimateToolResultTokens(ev, prunedAll.get(ev.data.callId))
      : estimateEventTokens(ev);
  }
  return { used: total, lastAssistant: undefined };
}

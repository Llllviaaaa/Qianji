/**
 * Derivation rules of ADR 0004 (extended with ADR 0022 branch summaries &
 * sliding-window compaction). Everything here is a pure function of the
 * event list, so tests can assert on JSONL fixtures directly.
 */
import type { AssistantContent, AssistantMessage, Effort, Message, ToolResultMessage } from "@qianji/llm";
import { estimateEventTokens } from "./tokens.ts";
import type { ModelRef, SessionEvent, SessionHeader, SessionModelUsage, SessionSummary } from "./types.ts";

/** The note a compaction summary is sent to the model under. */
export const COMPACTION_PREFIX = "The conversation so far was compacted. Summary of the earlier part:\n\n";
/** Appended when mid-run compaction swallowed the active prompt so the model continues working. */
export const COMPACTION_CONTINUE_SUFFIX =
  "\n\nContinue the active user task from this state using your tools as needed. Do not ask the user to repeat their request.";
/** The note a discarded-branch rewind summary is sent to the model under. */
export const BRANCH_SUMMARY_PREFIX =
  "Summary of an earlier discarded branch from this point (avoid repeating dead ends):\n\n";
export const CONTINUATION_NAMESPACE = "qianji-continuation";
export interface ContinuationEventData {
  reason: "length" | "empty" | "before-stop";
  text: string;
}
export const INTERRUPTED_TOOL_RESULT = "The tool call was interrupted before it returned a result.";

export interface BranchSummaryNote {
  atSeq: number;
  summary: string;
  rewindSeq: number;
  ts: string;
}

/** Active `branchSummary` notes surviving the sequence of rewinds in `events`. */
export function activeBranchSummaries(events: readonly SessionEvent[]): BranchSummaryNote[] {
  let notes: BranchSummaryNote[] = [];
  for (const event of events) {
    if (event.type !== "rewind") continue;
    notes = notes.filter((note) => note.atSeq <= event.data.toSeq);
    const summary = event.data.branchSummary?.trim();
    if (summary !== undefined && summary !== "") {
      notes.push({ atSeq: event.data.toSeq, summary, rewindSeq: event.seq, ts: event.ts });
    }
  }
  return notes;
}

/**
 * The events on the current branch, in order: each `rewind` drops the
 * branch's events after its `toSeq`. `rewind` events themselves are left out.
 */
export function currentBranch(events: readonly SessionEvent[]): SessionEvent[] {
  let branch: SessionEvent[] = [];
  for (const event of events) {
    if (event.type === "rewind") {
      const { toSeq } = event.data;
      branch = branch.filter((kept) => kept.seq <= toSeq);
    } else {
      branch.push(event);
    }
  }
  return branch;
}

export interface SessionState {
  messages: Message[];
  model?: ModelRef;
  effort?: Effort;
  title?: string;
  archived: boolean;
  /** Seq of the latest compaction on the branch, if any. */
  compactedThrough?: number;
}

function closeDanglingCalls(messages: Message[], pending: Map<string, string>): void {
  // A call without a result (the host died mid-tool) would make the next
  // request invalid at every provider, so it gets an error result.
  for (const [callId] of pending) {
    messages.push({ role: "tool-result", callId, content: [{ type: "text", text: INTERRUPTED_TOOL_RESULT }], isError: true });
  }
  pending.clear();
}

function pushUserNote(messages: Message[], text: string): void {
  messages.push({ role: "user", content: [{ type: "text", text }] });
}

function inferSignatureProvider(model: ModelRef | undefined): "gemini" | "anthropic" | undefined {
  if (model === undefined) return undefined;
  if (/gemini/i.test(model.model) || /gemini|google/i.test(model.provider)) return "gemini";
  if (/claude/i.test(model.model) || /anthropic/i.test(model.provider)) return "anthropic";
  return undefined;
}

function isBrokenOrphanToolCall(block: AssistantContent, recordedToolResults: ReadonlySet<string>): boolean {
  return (
    block.type === "tool-call"
    && typeof block.arguments === "object"
    && block.arguments !== null
    && "__invalidJson" in block.arguments
    && !recordedToolResults.has(block.id)
  );
}

/**
 * Clean historical assistant content: drop orphan broken `__invalidJson` tool calls
 * from errored turns and infer `signatureProvider` on unlabelled thinking signatures.
 */
function normalizeAssistantContent(
  content: readonly AssistantContent[],
  model: ModelRef | undefined,
  stop: string,
  recordedToolResults: ReadonlySet<string>,
): AssistantContent[] {
  const inferred = inferSignatureProvider(model);
  let changed = false;
  const out: AssistantContent[] = [];
  for (const block of content) {
    if (stop === "error" && isBrokenOrphanToolCall(block, recordedToolResults)) {
      changed = true;
      continue;
    }
    if (
      block.type === "thinking"
      && block.signature !== undefined
      && block.signatureProvider === undefined
      && inferred !== undefined
    ) {
      changed = true;
      out.push({ ...block, signatureProvider: inferred });
      continue;
    }
    out.push(block);
  }
  return changed ? out : (content as AssistantContent[]);
}

/** The LLM context and session settings on the current branch. */
export function deriveState(events: readonly SessionEvent[]): SessionState {
  const branch = currentBranch(events);
  const state: SessionState = { messages: [], archived: false };

  let compaction: { throughSeq: number; summary: string; seq: number } | undefined;
  for (const event of branch) {
    if (event.type === "compaction") compaction = { ...event.data, seq: event.seq };
    else if (event.type === "model") state.model = { provider: event.data.provider, model: event.data.model };
    else if (event.type === "effort") state.effort = event.data.effort;
    else if (event.type === "label") {
      if (event.data.title !== undefined) state.title = event.data.title;
      if (event.data.archived !== undefined) state.archived = event.data.archived;
    }
  }

  const recordedToolResults = new Set<string>();
  for (const event of branch) {
    if (event.type === "tool-result" && (compaction === undefined || event.seq > compaction.throughSeq)) {
      recordedToolResults.add(event.data.callId);
    }
  }

  const messages: Message[] = [];
  if (compaction !== undefined) {
    state.compactedThrough = compaction.seq;
    const hasUserAfterCompaction = branch.some(
      (event) => event.seq > compaction.throughSeq && event.type === "user",
    );
    const compactionText = hasUserAfterCompaction
      ? COMPACTION_PREFIX + compaction.summary
      : COMPACTION_PREFIX + compaction.summary + COMPACTION_CONTINUE_SUFFIX;
    pushUserNote(messages, compactionText);
  }

  const notes = activeBranchSummaries(events)
    .filter((note) => compaction === undefined || note.atSeq > compaction.throughSeq);
  let noteCursor = 0;
  const flushReadyNotes = (upToSeq: number, openCalls: number) => {
    if (openCalls > 0) return;
    while (noteCursor < notes.length && (notes[noteCursor]?.atSeq ?? Infinity) <= upToSeq) {
      const note = notes[noteCursor];
      if (note !== undefined) pushUserNote(messages, BRANCH_SUMMARY_PREFIX + note.summary);
      noteCursor += 1;
    }
  };
  if (compaction === undefined) flushReadyNotes(0, 0);

  const pending = new Map<string, string>();
  for (const event of branch) {
    if (compaction !== undefined && event.seq <= compaction.throughSeq) continue;
    if (event.type === "user") {
      closeDanglingCalls(messages, pending);
      flushReadyNotes(event.seq - 1, 0);
      messages.push({ role: "user", content: event.data.content });
    } else if (event.type === "assistant") {
      closeDanglingCalls(messages, pending);
      flushReadyNotes(event.seq - 1, 0);
      const content = normalizeAssistantContent(event.data.content, event.data.model, event.data.stop, recordedToolResults);
      const hasToolCall = content.some((block) => block.type === "tool-call");
      const hasVisibleText = content.some((block) => block.type === "text" && block.text.trim() !== "");
      // Skip empty, whitespace-only, thinking-only non-tool turns, and errored partial non-tool turns.
      if (content.length > 0 && (hasToolCall || (event.data.stop !== "error" && hasVisibleText))) {
        const message: AssistantMessage = { role: "assistant", content };
        messages.push(message);
        for (const block of content) if (block.type === "tool-call") pending.set(block.id, block.name);
      }
    } else if (event.type === "tool-result") {
      if (pending.delete(event.data.callId)) {
        const result: ToolResultMessage = { role: "tool-result", callId: event.data.callId, content: event.data.content, isError: event.data.isError };
        messages.push(result);
      }
    } else if (event.type === "custom" && event.data.ns === CONTINUATION_NAMESPACE) {
      const rawText = (event.data.data as { text?: unknown } | null)?.text;
      if (typeof rawText === "string" && rawText.trim() !== "") {
        closeDanglingCalls(messages, pending);
        flushReadyNotes(event.seq - 1, 0);
        const trimmed = rawText.trim();
        const prev = messages.at(-1);
        if (prev?.role === "user") {
          messages[messages.length - 1] = {
            role: "user",
            content: [...prev.content, { type: "text", text: `\n\n${trimmed}` }],
          };
        } else {
          pushUserNote(messages, trimmed);
        }
      }
    }
    flushReadyNotes(event.seq, pending.size);
  }
  closeDanglingCalls(messages, pending);
  flushReadyNotes(Infinity, 0);
  state.messages = messages;
  return state;
}

const FIRST_MESSAGE_CHARS = 200;

function isActivityEvent(event: SessionEvent): boolean {
  return event.type !== "label" && event.type !== "model" && event.type !== "effort";
}

export function summarize(header: SessionHeader, events: readonly SessionEvent[]): SessionSummary {
  let title: string | undefined;
  let archived = false;
  let firstMessage: string | undefined;
  let messageCount = 0;
  const usage: SessionSummary["usage"] = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };
  let reasoningTokens = 0;
  const byModel = new Map<string, SessionModelUsage>();
  for (const event of events) {
    if (event.type === "user") {
      messageCount += 1;
    } else if (event.type === "assistant") {
      messageCount += 1;
      const evUsage = event.data.usage;
      usage.inputTokens += evUsage.inputTokens ?? 0;
      usage.outputTokens += evUsage.outputTokens ?? 0;
      usage.cacheReadTokens += evUsage.cacheReadTokens ?? 0;
      usage.cacheWriteTokens += evUsage.cacheWriteTokens ?? 0;
      if (typeof evUsage.reasoningTokens === "number" && evUsage.reasoningTokens > 0) {
        reasoningTokens += evUsage.reasoningTokens;
      }
      const modelKey = `${event.data.model.provider}/${event.data.model.model}`;
      let bucket = byModel.get(modelKey);
      if (bucket === undefined) {
        bucket = {
          provider: event.data.model.provider,
          model: event.data.model.model,
          usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
        };
        byModel.set(modelKey, bucket);
      }
      bucket.usage.inputTokens += evUsage.inputTokens ?? 0;
      bucket.usage.outputTokens += evUsage.outputTokens ?? 0;
      bucket.usage.cacheReadTokens += evUsage.cacheReadTokens ?? 0;
      bucket.usage.cacheWriteTokens += evUsage.cacheWriteTokens ?? 0;
      if (typeof evUsage.reasoningTokens === "number" && evUsage.reasoningTokens > 0) {
        bucket.usage.reasoningTokens = (bucket.usage.reasoningTokens ?? 0) + evUsage.reasoningTokens;
      }
    }
  }
  if (reasoningTokens > 0) usage.reasoningTokens = reasoningTokens;
  for (const event of currentBranch(events)) {
    if (event.type === "user" && firstMessage === undefined) {
      const text = event.data.content.flatMap((block) => (block.type === "text" ? [block.text] : [])).join(" ").replace(/\s+/g, " ").trim();
      if (text !== "") firstMessage = text.slice(0, FIRST_MESSAGE_CHARS);
    } else if (event.type === "label") {
      if (event.data.title !== undefined) title = event.data.title;
      if (event.data.archived !== undefined) archived = event.data.archived;
    }
  }
  const last = events.at(-1);
  const lastActivity = events.findLast(isActivityEvent);
  return {
    id: header.id,
    cwd: header.cwd,
    createdAt: header.createdAt,
    updatedAt: lastActivity?.ts ?? header.createdAt,
    ...(title === undefined ? {} : { title }),
    ...(firstMessage === undefined ? {} : { firstMessage }),
    archived,
    lastSeq: last?.seq ?? 0,
    messageCount,
    usage,
    ...(byModel.size > 0 ? { modelUsage: [...byModel.values()] } : {}),
    ...(header.forkedFrom === undefined ? {} : { forkedFrom: header.forkedFrom }),
    ...(header.parent === undefined ? {} : { parent: header.parent }),
    ...(header.side === true ? { side: true as const } : {}),
  };
}

/**
 * The latest seq at or before `atSeq` on the current branch where no tool
 * call is waiting for its result: where a side chat of a running session can
 * start without a dangling call.
 */
export function settledSeq(events: readonly SessionEvent[], atSeq: number): number {
  const open = new Set<string>();
  let settled = 0;
  for (const event of currentBranch(events)) {
    if (event.seq > atSeq) break;
    if (event.type === "tool-call") open.add(event.data.callId);
    else if (event.type === "tool-result") open.delete(event.data.callId);
    if (open.size === 0) settled = event.seq;
  }
  return settled;
}

/**
 * The branch up to `atSeq`, renumbered from 1, for a fork. A compaction's
 * `throughSeq` moves to the new number of the last copied event at or before it;
 * active `branchSummary` rewind notes are preserved at their anchor positions.
 */
export function forkEvents(events: readonly SessionEvent[], atSeq: number): SessionEvent[] {
  const copied = currentBranch(events).filter((event) => event.seq <= atSeq);
  const notes = activeBranchSummaries(events).filter((note) => note.atSeq <= atSeq);
  const combined: Array<{ oldSeq?: number; event: SessionEvent }> = [];
  let noteIdx = 0;
  const emitNotesUpTo = (seqLimit: number) => {
    while (noteIdx < notes.length && (notes[noteIdx]?.atSeq ?? Infinity) <= seqLimit) {
      const note = notes[noteIdx];
      if (note !== undefined) {
        combined.push({
          event: { seq: 0, ts: note.ts, type: "rewind", data: { toSeq: note.atSeq, branchSummary: note.summary } },
        });
      }
      noteIdx += 1;
    }
  };
  emitNotesUpTo(0);
  for (const event of copied) {
    emitNotesUpTo(event.seq - 1);
    combined.push({ oldSeq: event.seq, event });
    emitNotesUpTo(event.seq);
  }
  emitNotesUpTo(atSeq);

  const renumbered = new Map<number, number>();
  combined.forEach((item, index) => {
    if (item.oldSeq !== undefined) renumbered.set(item.oldSeq, index + 1);
  });
  const newSeqAtOrBefore = (seq: number): number => {
    let found = 0;
    for (const [oldSeq, newSeq] of renumbered) if (oldSeq <= seq) found = newSeq;
    return found;
  };
  return combined.map((item, index) => {
    const seq = index + 1;
    const event = item.event;
    if (event.type === "compaction") {
      return { ...event, seq, data: { ...event.data, throughSeq: newSeqAtOrBefore(event.data.throughSeq) } };
    }
    if (event.type === "rewind") {
      return { ...event, seq, data: { ...event.data, toSeq: newSeqAtOrBefore(event.data.toSeq) } };
    }
    return { ...event, seq };
  });
}

/**
 * The `throughSeq` of a compaction: the end of the branch, or with
 * `keepLatestTurn` the event before the latest user message (the whole branch
 * when that message is the only turn).
 */
export function compactionPoint(events: readonly SessionEvent[], keepLatestTurn = false): number | undefined {
  const branch = currentBranch(events);
  const lastUser = keepLatestTurn ? branch.findLastIndex((event) => event.type === "user") : -1;
  const earlierTurn = branch.slice(0, Math.max(0, lastUser)).some((event) => event.type === "user");
  if (!earlierTurn) return branch.at(-1)?.seq;
  return branch[lastUser - 1]?.seq;
}

/**
 * Compute a `throughSeq` cut point for mid-run sliding-window compaction that
 * preserves up to `keepRecentTokens` of the newest complete assistant/tool
 * steps verbatim while summarizing older history. Falls back to full-branch
 * compaction when there is no summarizable prefix before the kept window.
 */
export function slidingCompactionPoint(events: readonly SessionEvent[], keepRecentTokens: number): number | undefined {
  const branch = currentBranch(events);
  if (branch.length === 0) return undefined;
  if (!(keepRecentTokens > 0)) return compactionPoint(events, false);

  const lastCompactionSeq = branch.findLast((event) => event.type === "compaction")?.data.throughSeq ?? 0;
  const post = branch.filter((event) => event.seq > lastCompactionSeq);
  if (post.length === 0) return branch.at(-1)?.seq;

  interface StepUnit {
    events: SessionEvent[];
    tokens: number;
    hasTurn: boolean;
    hasAssistant: boolean;
  }
  const units: StepUnit[] = [];
  let current: StepUnit = { events: [], tokens: 0, hasTurn: false, hasAssistant: false };
  const openCalls = new Set<string>();
  const flushUnit = () => {
    if (current.events.length > 0) units.push(current);
    current = { events: [], tokens: 0, hasTurn: false, hasAssistant: false };
  };

  for (const event of post) {
    const startsNewUnit = openCalls.size === 0 && (
      (event.type === "user" && current.hasTurn)
      || (event.type === "assistant" && current.hasAssistant)
    );
    if (startsNewUnit) flushUnit();
    current.events.push(event);
    current.tokens += estimateEventTokens(event);
    if (event.type === "user") current.hasTurn = true;
    else if (event.type === "assistant") {
      current.hasTurn = true;
      current.hasAssistant = true;
      for (const block of event.data.content) if (block.type === "tool-call") openCalls.add(block.id);
    } else if (event.type === "tool-call") {
      openCalls.add(event.data.callId);
    } else if (event.type === "tool-result") {
      openCalls.delete(event.data.callId);
    }
  }
  flushUnit();

  if (units.length <= 1) return compactionPoint(events, false);

  let keptTokens = 0;
  let cutIndex = units.length;
  for (let i = units.length - 1; i >= 1; i -= 1) {
    const unit = units[i];
    if (unit === undefined) break;
    if (keptTokens + unit.tokens > keepRecentTokens) break;
    keptTokens += unit.tokens;
    cutIndex = i;
  }

  if (cutIndex === units.length || cutIndex === 0) return compactionPoint(events, false);
  const firstKeptSeq = units[cutIndex]?.events[0]?.seq;
  if (firstKeptSeq === undefined) return compactionPoint(events, false);

  const beforeKept = branch.filter((event) => event.seq < firstKeptSeq);
  const hasPrefixTurn = beforeKept.some((event) => event.seq > lastCompactionSeq && (event.type === "user" || event.type === "assistant"));
  if (!hasPrefixTurn) return compactionPoint(events, false);
  return beforeKept.at(-1)?.seq;
}

/** The data of the latest `custom` event of `ns` (or any in `ns`) on the current branch: a plugin's session state. */
export function latestCustom<T = unknown>(events: readonly SessionEvent[], ns: string | readonly string[]): T | undefined {
  const allowed = typeof ns === "string" ? new Set([ns]) : new Set(ns);
  const branch = currentBranch(events);
  for (let index = branch.length - 1; index >= 0; index -= 1) {
    const event = branch[index];
    if (event?.type === "custom" && allowed.has(event.data.ns)) return event.data.data as T;
  }
  return undefined;
}

/** Every `custom` event of `ns` (or any in `ns`) on the current branch, oldest first. */
export function customEvents(events: readonly SessionEvent[], ns: string | readonly string[]): Array<Extract<SessionEvent, { type: "custom" }>> {
  const allowed = typeof ns === "string" ? new Set([ns]) : new Set(ns);
  return currentBranch(events).filter((event): event is Extract<SessionEvent, { type: "custom" }> => event.type === "custom" && allowed.has(event.data.ns));
}

/**
 * The current branch as Markdown: each user and assistant message's text
 * under a heading, the format the desktop has always exported.
 */
export function sessionMarkdown(events: readonly SessionEvent[]): string {
  let output = "# Qianji conversation\n\n";
  for (const event of currentBranch(events)) {
    if (event.type !== "user" && event.type !== "assistant") continue;
    const text = event.data.content.flatMap((block) => (block.type === "text" ? [block.text] : [])).join("").trim();
    if (text !== "") output += `## ${event.type === "user" ? "User" : "Assistant"}\n\n${text}\n\n`;
  }
  return output;
}

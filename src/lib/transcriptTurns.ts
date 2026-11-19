import type { UiMessage, UiToolCall, WorkStep } from "../types";
import { extractInlineThinking, foldThinking } from "./thinkingDisplay";

function mergeToolCalls(messages: UiMessage[]): UiToolCall[] | undefined {
  // A Map keeps first-insertion order even when a later update replaces the value,
  // which is the order calls were first seen in.
  const byId = new Map<string, UiToolCall>();
  for (const message of messages) {
    for (const call of message.toolCalls ?? []) {
      byId.set(call.id, { ...byId.get(call.id), ...call });
    }
  }
  if (!byId.size) return undefined;
  return [...byId.values()];
}

function normalizedMessages(messages: UiMessage[]): UiMessage[] {
  return messages.map((message) => {
    if (message.role !== "assistant") return message;
    const split = extractInlineThinking(message.content, message.thinking);
    if (split.content === message.content && split.thinking === message.thinking) return message;
    return { ...message, content: split.content, thinking: split.thinking };
  });
}

function findFinalContentIndex(messages: UiMessage[]): number {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (/```(?:qianji-rich|pidesktop-rich)/.test(messages[index].content || "")) return index;
  }
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    // Any text on or before a tool-calling message is narration that preceded those tool calls.
    if ((messages[index].toolCalls?.length ?? 0) > 0) return -1;
    if (messages[index].content?.trim()) return index;
  }
  return -1;
}

function turnDurationMs(messages: UiMessage[]): number | undefined {
  const explicit = messages[messages.length - 1]?.durationMs;
  if (typeof explicit === "number" && explicit > 0) return explicit;
  const timestamps = messages.map((message) => message.timestamp).filter((value) => value > 0);
  if (timestamps.length < 2) return messages.find((message) => (message.durationMs ?? 0) > 0)?.durationMs;
  return Math.max(0, timestamps[timestamps.length - 1] - timestamps[0]);
}

export function workStepsFromMessages(
  messages: UiMessage[],
  finalContent: string,
  finalContentIndex?: number,
): WorkStep[] {
  const normalized = normalizedMessages(messages);
  const final = finalContent.trim();
  const steps: WorkStep[] = [];
  for (let index = 0; index < normalized.length; index += 1) {
    const message = normalized[index];
    const thinking = foldThinking(message.thinking, finalContent);
    if (thinking) steps.push({ kind: "thinking", text: thinking });
    const note = message.content.trim();
    const isFinalMessage = finalContentIndex !== undefined ? index === finalContentIndex : note === final;
    if (note && !isFinalMessage) steps.push({ kind: "note", text: note });
    for (const call of message.toolCalls ?? []) steps.push({ kind: "tool", call });
  }
  return steps;
}

const turnMergeCache = new WeakMap<UiMessage, { inputs: readonly UiMessage[]; merged: UiMessage }>();
const groupedTranscriptCache = new WeakMap<readonly UiMessage[], UiMessage[]>();

interface TranscriptPrefixCacheEntry {
  settledMsgCount: number;
  prefix: readonly UiMessage[];
  settledTurns: readonly UiMessage[];
}

const MAX_PREFIX_CACHE_ENTRIES = 4;
const transcriptPrefixCache: TranscriptPrefixCacheEntry[] = [];

function findMatchingPrefixEntry(messages: readonly UiMessage[]): TranscriptPrefixCacheEntry | null {
  for (let entryIdx = transcriptPrefixCache.length - 1; entryIdx >= 0; entryIdx -= 1) {
    const entry = transcriptPrefixCache[entryIdx];
    if (messages.length < entry.settledMsgCount || messages[0] !== entry.prefix[0]) continue;
    let matched = true;
    for (let index = 1; index < entry.settledMsgCount; index += 1) {
      if (messages[index] !== entry.prefix[index]) {
        matched = false;
        break;
      }
    }
    if (!matched) continue;
    if (entryIdx !== transcriptPrefixCache.length - 1) {
      transcriptPrefixCache.splice(entryIdx, 1);
      transcriptPrefixCache.push(entry);
    }
    return entry;
  }
  return null;
}

function updatePrefixCache(
  messages: readonly UiMessage[],
  settledMsgCount: number,
  out: readonly UiMessage[],
  settledTurnCount: number,
): void {
  const firstMessage = messages[0];
  if (!firstMessage) return;
  const existingIdx = transcriptPrefixCache.findIndex((entry) => entry.prefix[0] === firstMessage);
  if (settledMsgCount <= 0) {
    if (existingIdx >= 0) transcriptPrefixCache.splice(existingIdx, 1);
    return;
  }
  const nextEntry: TranscriptPrefixCacheEntry = {
    settledMsgCount,
    prefix: messages.slice(0, settledMsgCount),
    settledTurns: out.slice(0, settledTurnCount),
  };
  if (existingIdx >= 0) {
    transcriptPrefixCache.splice(existingIdx, 1);
  } else if (transcriptPrefixCache.length >= MAX_PREFIX_CACHE_ENTRIES) {
    transcriptPrefixCache.shift();
  }
  transcriptPrefixCache.push(nextEntry);
}

export function mergeAssistantTurn(messages: UiMessage[]): UiMessage {
  const firstRaw = messages[0];
  if (firstRaw) {
    const cached = turnMergeCache.get(firstRaw);
    if (
      cached
      && cached.inputs.length === messages.length
      && cached.inputs.every((item, index) => item === messages[index])
    ) {
      return cached.merged;
    }
  }
  const normalized = normalizedMessages(messages);
  const last = normalized[normalized.length - 1];
  const lastErrorMessage = [...normalized].reverse().find((message) => message.isError === true || message.error !== undefined);
  const turnError = lastErrorMessage?.error;
  const finalIndex = findFinalContentIndex(normalized);
  const preserveLastError = finalIndex < 0 && last?.isError === true && last.content.trim() !== "";
  const effectiveFinalIndex = preserveLastError ? normalized.length - 1 : finalIndex;
  const rawFinalContent = effectiveFinalIndex >= 0 ? normalized[effectiveFinalIndex].content : "";
  const content = rawFinalContent || (last?.isError === true ? (turnError?.message ?? lastErrorMessage?.content ?? "") : "");
  const steps = workStepsFromMessages(normalized, content, effectiveFinalIndex);
  const thinking = steps.filter((step) => step.kind === "thinking").map((step) => step.text).join("\n\n") || undefined;
  const merged: UiMessage = {
    ...last,
    id: normalized[0].id,
    content,
    thinking,
    workSteps: steps,
    toolCalls: mergeToolCalls(normalized),
    isStreaming: normalized.some((message) => message.isStreaming),
    isError: normalized.some((message) => message.isError),
    ...(turnError === undefined ? {} : { error: turnError }),
    isAborted: normalized.some((message) => message.isAborted),
    stopReason: last.stopReason,
    durationMs: turnDurationMs(normalized),
    timestamp: last.timestamp || normalized[0].timestamp,
  };
  if (firstRaw) {
    turnMergeCache.set(firstRaw, { inputs: [...messages], merged });
  }
  return merged;
}

/** Collapse consecutive assistant messages from one user turn into a single display row. */
export function groupTranscriptMessages(messages: UiMessage[]): UiMessage[] {
  const cached = groupedTranscriptCache.get(messages);
  if (cached) return cached;

  const matchedEntry = findMatchingPrefixEntry(messages);
  const out: UiMessage[] = matchedEntry ? matchedEntry.settledTurns.slice() : [];
  const startIndex = matchedEntry ? matchedEntry.settledMsgCount : 0;
  let settledMsgCount = startIndex;
  let settledTurnCount = out.length;

  let bucket: UiMessage[] = [];
  const flush = () => {
    if (!bucket.length) return;
    out.push(mergeAssistantTurn(bucket));
    bucket = [];
  };
  for (let index = startIndex; index < messages.length; index += 1) {
    const message = messages[index];
    if (message.role === "assistant") {
      bucket.push(message);
      continue;
    }
    flush();
    out.push(message);
    settledMsgCount = index + 1;
    settledTurnCount = out.length;
  }
  flush();

  if (!matchedEntry || settledMsgCount > matchedEntry.settledMsgCount) {
    updatePrefixCache(messages, settledMsgCount, out, settledTurnCount);
  }
  groupedTranscriptCache.set(messages, out);
  return out;
}

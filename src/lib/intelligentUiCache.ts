import type { UiMessage } from "../types";
import type { SessionIntelligentUiSummary } from "./intelligentUi";
import { normalizedToolName } from "./toolPresentation";

export const INTELLIGENT_UI_FENCE_LANGUAGE = "intelligent-ui";

interface IntelligentUiPrefixEntry {
  messages: readonly UiMessage[];
  summary: SessionIntelligentUiSummary;
}

const MAX_RECENT_SUMMARIES = 4;
const summaryByArrayCache = new WeakMap<readonly UiMessage[], SessionIntelligentUiSummary>();
const recentSummaries: IntelligentUiPrefixEntry[] = [];

export function messageMayContainIntelligentUi(message: UiMessage | undefined): boolean {
  if (!message || message.role !== "assistant") return false;
  if (message.content && message.content.includes(INTELLIGENT_UI_FENCE_LANGUAGE)) return true;
  if (message.toolCalls) {
    for (const call of message.toolCalls) {
      const normalized = normalizedToolName(call.name);
      if (normalized === "render_ui" || normalized === "update_ui") return true;
    }
  }
  return false;
}

function prefixMatches(
  next: readonly UiMessage[],
  prev: readonly UiMessage[],
  count: number,
): boolean {
  for (let index = 0; index < count; index += 1) {
    if (next[index] !== prev[index]) return false;
  }
  return true;
}

function tailContainsNoIntelligentUi(messages: readonly UiMessage[], fromIndex: number): boolean {
  for (let index = fromIndex; index < messages.length; index += 1) {
    if (messageMayContainIntelligentUi(messages[index])) return false;
  }
  return true;
}

function canReuseCachedSummary(
  messages: readonly UiMessage[],
  prev: readonly UiMessage[],
): boolean {
  const prevLen = prev.length;
  const nextLen = messages.length;
  if (nextLen < prevLen) return false;
  if (prevLen === 0) return tailContainsNoIntelligentUi(messages, 0);
  if (!prefixMatches(messages, prev, prevLen - 1)) return false;

  if (messages[prevLen - 1] === prev[prevLen - 1]) {
    return tailContainsNoIntelligentUi(messages, prevLen);
  }
  if (messageMayContainIntelligentUi(prev[prevLen - 1])) return false;
  return tailContainsNoIntelligentUi(messages, prevLen - 1);
}

export function getCachedSessionIntelligentUi(
  messages: readonly UiMessage[],
): SessionIntelligentUiSummary | undefined {
  const exact = summaryByArrayCache.get(messages);
  if (exact) return exact;

  for (let entryIdx = recentSummaries.length - 1; entryIdx >= 0; entryIdx -= 1) {
    const entry = recentSummaries[entryIdx];
    if (!canReuseCachedSummary(messages, entry.messages)) continue;
    entry.messages = messages;
    if (entryIdx !== recentSummaries.length - 1) {
      recentSummaries.splice(entryIdx, 1);
      recentSummaries.push(entry);
    }
    summaryByArrayCache.set(messages, entry.summary);
    return entry.summary;
  }
  return undefined;
}

export function setCachedSessionIntelligentUi(
  messages: readonly UiMessage[],
  summary: SessionIntelligentUiSummary,
): void {
  summaryByArrayCache.set(messages, summary);
  const firstMsg = messages[0];
  const existingIdx = recentSummaries.findIndex((entry) =>
    firstMsg ? entry.messages[0] === firstMsg : entry.messages.length === 0,
  );
  if (existingIdx >= 0) {
    recentSummaries.splice(existingIdx, 1);
  } else if (recentSummaries.length >= MAX_RECENT_SUMMARIES) {
    recentSummaries.shift();
  }
  recentSummaries.push({ messages, summary });
}

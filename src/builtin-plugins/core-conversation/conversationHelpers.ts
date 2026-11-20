/**
 * Pure transcript, turn grouping, live plan, code-fence splitting, and
 * approval dialog helpers for the built-in `core-conversation` plugin (ADR 0023).
 */
import type { UiMessage, UiToolCall } from "@qianji/client";

type WorkStep = NonNullable<UiMessage["workSteps"]>[number];

export interface ConversationTurnGroup {
  readonly key: string;
  readonly turnIndex: number;
  readonly userMessage?: UiMessage;
  readonly assistantMessages: readonly UiMessage[];
  readonly isLastTurn: boolean;
}

export interface LivePlanStep {
  readonly id: string;
  readonly text: string;
  readonly status: "pending" | "in_progress" | "completed";
}

export interface LivePlanSummary {
  readonly steps: readonly LivePlanStep[];
  readonly completed: number;
  readonly explanation?: string;
}

export type MarkdownSegment =
  | { readonly kind: "prose"; readonly text: string }
  | { readonly kind: "code"; readonly language: string; readonly code: string; readonly rawFence: string };

const LEADING_THINK_OPEN = /^\s*<think>(?:\r?\n)?/i;
const THINK_CLOSE = /<\/think>\s*/i;
const DRAFT_OPENER = /(?:^|\n)(?:好的[，, ]*)?(?:我来(?:给你)?(?:整理|总结|说明|回答)|下面是|以下是)/;
const INCOMPLETE_TAIL = /\n+(?:#{1,6}\s*)?(?:\d+\.|[-*])\s*$/;
const CODE_FENCE_RE = /```([a-zA-Z0-9_+#.-]*)[ \t]*\r?\n([\s\S]*?)```/g;

function isAnswerDraft(text: string, content?: string): boolean {
  const heading = text.match(/^#{1,6}\s+(.+)$/m)?.[1]?.trim();
  if (heading !== undefined && heading !== "" && content?.includes(heading) === true) return true;
  if (/^(?:好的[，,]?)?我来(?:给你)?(?:整理|总结|说明|回答)/.test(text)) return true;
  if (/^(?:下面是|以下是)/.test(text) && (content ?? "").trim().length > 40) return true;
  return false;
}

export function extractInlineThinking(
  content: string,
  explicitThinking?: string,
): { readonly content: string; readonly thinking: string } {
  let remaining = content;
  const extracted: string[] = [];

  while (LEADING_THINK_OPEN.test(remaining)) {
    remaining = remaining.replace(LEADING_THINK_OPEN, "");
    const closeMatch = THINK_CLOSE.exec(remaining);
    if (closeMatch === null) {
      const partial = remaining.trim();
      if (partial !== "") extracted.push(partial);
      remaining = "";
      break;
    }
    const block = remaining.slice(0, closeMatch.index).trim();
    if (block !== "") extracted.push(block);
    remaining = remaining.slice(closeMatch.index + closeMatch[0].length);
  }

  const base = (explicitThinking ?? "").trim();
  const inlineText = extracted.join("\n\n").trim();
  const merged =
    base !== "" && inlineText !== ""
      ? base.includes(inlineText)
        ? base
        : `${base}\n\n${inlineText}`
      : base || inlineText;

  return {
    content: remaining,
    thinking: merged,
  };
}

export function foldThinking(thinking: string | undefined, content?: string): string {
  let text = (thinking ?? "").replace(/\r\n/g, "\n").trim();
  if (text === "") return "";

  const headingAt = text.search(/\n#{1,6}\s+\S/);
  if (headingAt > 0) text = text.slice(0, headingAt).trim();

  const draft = text.match(DRAFT_OPENER);
  if (draft !== null && draft.index !== undefined && draft.index > 24) {
    text = text.slice(0, draft.index).trim();
  }

  text = text.replace(INCOMPLETE_TAIL, "").trim();
  if (text === "" || isAnswerDraft(text, content)) return "";
  return text;
}

function mergeToolCalls(messages: readonly UiMessage[]): UiToolCall[] | undefined {
  const byId = new Map<string, UiToolCall>();
  for (const message of messages) {
    for (const call of message.toolCalls ?? []) {
      byId.set(call.id, { ...byId.get(call.id), ...call });
    }
  }
  if (byId.size === 0) return undefined;
  return [...byId.values()];
}

function normalizedAssistantMessages(messages: readonly UiMessage[]): UiMessage[] {
  return messages.map((message) => {
    if (message.role !== "assistant") return message;
    const split = extractInlineThinking(message.content, message.thinking);
    const nextThinking = split.thinking === "" ? undefined : split.thinking;
    if (split.content === message.content && nextThinking === message.thinking) return message;
    return { ...message, content: split.content, thinking: nextThinking };
  });
}

function findFinalContentIndex(messages: readonly UiMessage[]): number {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const msg = messages[index];
    if (msg !== undefined && /```(?:qianji-rich|pidesktop-rich)/.test(msg.content)) return index;
  }
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const msg = messages[index];
    if (msg === undefined) continue;
    // Any text on or before a tool-calling message is narration that preceded those tool calls.
    if ((msg.toolCalls?.length ?? 0) > 0) return -1;
    if (msg.content.trim() !== "") return index;
  }
  return -1;
}

function turnDurationMs(messages: readonly UiMessage[]): number | undefined {
  const last = messages[messages.length - 1];
  const explicit = last?.durationMs;
  if (typeof explicit === "number" && explicit > 0) return explicit;
  const timestamps = messages.map((message) => message.timestamp).filter((value) => value > 0);
  if (timestamps.length < 2) {
    return messages.find((message) => (message.durationMs ?? 0) > 0)?.durationMs;
  }
  const firstTs = timestamps[0] ?? 0;
  const lastTs = timestamps[timestamps.length - 1] ?? firstTs;
  return Math.max(0, lastTs - firstTs);
}

function buildWorkSteps(
  normalized: readonly UiMessage[],
  finalContent: string,
  finalContentIndex: number,
): WorkStep[] {
  const steps: WorkStep[] = [];
  for (let index = 0; index < normalized.length; index += 1) {
    const message = normalized[index];
    if (message === undefined) continue;
    const thinking = foldThinking(message.thinking, finalContent);
    if (thinking !== "") steps.push({ kind: "thinking", text: thinking });
    const note = message.content.trim();
    if (note !== "" && index !== finalContentIndex) {
      steps.push({ kind: "note", text: note });
    }
    for (const call of message.toolCalls ?? []) {
      steps.push({ kind: "tool", call });
    }
  }
  return steps;
}

export function mergeAssistantTurn(messages: readonly UiMessage[]): UiMessage {
  const normalized = normalizedAssistantMessages(messages);
  const first = normalized[0];
  const last = normalized[normalized.length - 1];
  if (first === undefined || last === undefined) {
    return { id: "empty", role: "assistant", content: "", timestamp: 0 };
  }
  const lastErrorMessage = [...normalized]
    .reverse()
    .find((message) => message.isError === true || message.error !== undefined);
  const turnError = lastErrorMessage?.error;
  const finalIndex = findFinalContentIndex(normalized);
  const preserveLastError = finalIndex < 0 && last.isError === true && last.content.trim() !== "";
  const effectiveFinalIndex = preserveLastError ? normalized.length - 1 : finalIndex;
  const rawFinalContent =
    effectiveFinalIndex >= 0 ? (normalized[effectiveFinalIndex]?.content ?? "") : "";
  const content =
    rawFinalContent ||
    (last.isError === true ? (turnError?.message ?? lastErrorMessage?.content ?? "") : "");
  const steps = buildWorkSteps(normalized, content, effectiveFinalIndex);
  const thinking =
    steps
      .filter((step): step is { kind: "thinking"; text: string } => step.kind === "thinking")
      .map((step) => step.text)
      .join("\n\n") || undefined;

  return {
    ...last,
    id: first.id,
    content,
    thinking,
    workSteps: steps,
    toolCalls: mergeToolCalls(normalized),
    isStreaming: normalized.some((message) => message.isStreaming === true),
    isError: normalized.some((message) => message.isError === true),
    ...(turnError === undefined ? {} : { error: turnError }),
    isAborted: normalized.some((message) => message.isAborted === true),
    stopReason: last.stopReason,
    durationMs: turnDurationMs(normalized),
    timestamp: last.timestamp || first.timestamp,
  };
}

/** Collapse consecutive assistant messages from one agent turn into a single display message. */
export function collapseConsecutiveAssistantMessages(messages: readonly UiMessage[]): UiMessage[] {
  const out: UiMessage[] = [];
  let bucket: UiMessage[] = [];
  const flush = () => {
    if (bucket.length === 0) return;
    out.push(mergeAssistantTurn(bucket));
    bucket = [];
  };
  for (const message of messages) {
    if (message.role === "assistant") {
      bucket.push(message);
      continue;
    }
    flush();
    out.push(message);
  }
  flush();
  return out;
}

export function splitMarkdownCodeBlocks(markdown: string): readonly MarkdownSegment[] {
  const segments: MarkdownSegment[] = [];
  let cursor = 0;
  CODE_FENCE_RE.lastIndex = 0;

  for (;;) {
    const match = CODE_FENCE_RE.exec(markdown);
    if (match === null) break;
    const matchIndex = match.index;
    if (matchIndex > cursor) {
      const prose = markdown.slice(cursor, matchIndex);
      if (prose.trim() !== "") {
        segments.push({ kind: "prose", text: prose });
      }
    }
    const language = (match[1] ?? "").trim().toLowerCase() || "text";
    const code = (match[2] ?? "").replace(/\r\n/g, "\n").replace(/\n$/, "");
    segments.push({
      kind: "code",
      language,
      code,
      rawFence: match[0],
    });
    cursor = matchIndex + match[0].length;
  }

  if (cursor < markdown.length) {
    const tail = markdown.slice(cursor);
    if (tail.trim() !== "") {
      segments.push({ kind: "prose", text: tail });
    }
  }

  return segments;
}

export function groupMessagesIntoTurns(messages: readonly UiMessage[]): readonly ConversationTurnGroup[] {
  const displayMessages = collapseConsecutiveAssistantMessages(messages);
  const rawTurns: Array<{
    key: string;
    userMessage?: UiMessage;
    assistantMessages: UiMessage[];
  }> = [];

  for (const message of displayMessages) {
    if (message.role === "user") {
      rawTurns.push({
        key: `turn-${message.id}`,
        userMessage: message,
        assistantMessages: [],
      });
      continue;
    }
    const current = rawTurns[rawTurns.length - 1];
    if (current === undefined) {
      rawTurns.push({
        key: `turn-leading-${message.id}`,
        assistantMessages: [message],
      });
    } else {
      current.assistantMessages.push(message);
    }
  }

  return rawTurns.map((turn, index) => ({
    key: turn.key,
    turnIndex: index,
    ...(turn.userMessage === undefined ? {} : { userMessage: turn.userMessage }),
    assistantMessages: turn.assistantMessages,
    isLastTurn: index === rawTurns.length - 1,
  }));
}

export function singleLineExcerpt(text: string, maxLen = 46): string {
  const clean = text.replace(/\s+/g, " ").trim();
  if (clean === "") return "（图片或附件）";
  return clean.length > maxLen ? `${clean.slice(0, maxLen - 1)}…` : clean;
}

export function formatMessageClock(timestamp: number): string {
  if (!Number.isFinite(timestamp) || timestamp <= 0) return "";
  const date = new Date(timestamp);
  const hours = String(date.getHours()).padStart(2, "0");
  const minutes = String(date.getMinutes()).padStart(2, "0");
  return `${hours}:${minutes}`;
}

export function formatRunDuration(durationMs: number): string {
  const totalSeconds = Math.max(1, Math.round(durationMs / 1000));
  if (totalSeconds < 60) return `${totalSeconds} 秒`;
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return seconds > 0 ? `${minutes} 分 ${seconds} 秒` : `${minutes} 分`;
}

function normalizePlanStatus(raw: unknown): LivePlanStep["status"] {
  if (raw === "completed" || raw === "done") return "completed";
  if (raw === "in_progress" || raw === "in-progress" || raw === "running") return "in_progress";
  return "pending";
}

function toolNameTail(name: string): string {
  const segments = name.toLowerCase().split(/__|[.:/]/).filter(Boolean);
  return segments[segments.length - 1] ?? name.toLowerCase();
}

function parsePlanFromToolCall(call: UiToolCall): LivePlanSummary | null {
  if (call.isError === true) return null;
  const normalized = toolNameTail(call.name);
  if (
    normalized !== "update_plan" &&
    normalized !== "todo_write" &&
    normalized !== "todowrite" &&
    normalized !== "task_plan"
  ) {
    return null;
  }
  const detailItems = Array.isArray(call.details?.items) ? call.details.items : null;
  const rawList =
    detailItems ??
    (Array.isArray(call.args.items)
      ? call.args.items
      : Array.isArray(call.args.plan)
        ? call.args.plan
        : Array.isArray(call.args.todos)
          ? call.args.todos
          : Array.isArray(call.args.steps)
            ? call.args.steps
            : null);
  if (rawList === null || rawList.length === 0) return null;

  const steps: LivePlanStep[] = [];
  for (let idx = 0; idx < rawList.length; idx += 1) {
    const item = rawList[idx];
    if (typeof item !== "object" || item === null) continue;
    const record = item as Record<string, unknown>;
    const textCandidate = record.step ?? record.content ?? record.text ?? record.title;
    if (typeof textCandidate !== "string" || textCandidate.trim() === "") continue;
    steps.push({
      id: typeof record.id === "string" && record.id.trim() !== "" ? record.id : `step-${idx}`,
      text: textCandidate.trim(),
      status: normalizePlanStatus(record.status),
    });
  }
  if (steps.length === 0) return null;
  const completed = steps.filter((step) => step.status === "completed").length;
  const rawExplanation =
    typeof call.details?.explanation === "string"
      ? call.details.explanation
      : typeof call.args.explanation === "string"
        ? call.args.explanation
        : "";
  const explanation = rawExplanation.trim() !== "" ? rawExplanation.trim() : undefined;
  return {
    steps,
    completed,
    ...(explanation === undefined ? {} : { explanation }),
  };
}

export function deriveLivePlan(messages: readonly UiMessage[]): LivePlanSummary | null {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const msg = messages[i];
    if (msg === undefined || msg.toolCalls === undefined) continue;
    for (let j = msg.toolCalls.length - 1; j >= 0; j -= 1) {
      const call = msg.toolCalls[j];
      if (call === undefined) continue;
      const parsed = parsePlanFromToolCall(call);
      if (parsed !== null) return parsed;
    }
  }
  return null;
}

export function currentPlanStepIndex(plan: LivePlanSummary): number {
  const activeIdx = plan.steps.findIndex((step) => step.status === "in_progress");
  if (activeIdx >= 0) return activeIdx;
  const pendingIdx = plan.steps.findIndex((step) => step.status === "pending");
  if (pendingIdx >= 0) return pendingIdx;
  return Math.max(0, plan.steps.length - 1);
}

export function parseConfirmDiffMessage(message: string): {
  readonly before: string;
  readonly diffLines: readonly string[] | null;
  readonly after: string;
} {
  const lfStart = message.indexOf("```diff\n");
  const crlfStart = lfStart < 0 ? message.indexOf("```diff\r\n") : -1;
  const start = lfStart >= 0 ? lfStart : crlfStart;
  if (start < 0) return { before: message, diffLines: null, after: "" };
  const bodyStart = start + (lfStart >= 0 ? "```diff\n".length : "```diff\r\n".length);
  const fenceEnd = message.indexOf("\n```", bodyStart);
  if (fenceEnd < 0) return { before: message, diffLines: null, after: "" };
  return {
    before: message.slice(0, start).trim(),
    diffLines: message.slice(bodyStart, fenceEnd).replace(/\r\n/g, "\n").split("\n"),
    after: message.slice(fenceEnd + "\n```".length).trim(),
  };
}

export function diffLineClass(line: string): string {
  if (line.startsWith("--- ") || line.startsWith("+++ ") || line.startsWith("@@")) {
    return "diff-line diff-meta";
  }
  if (line.startsWith("+")) return "diff-line diff-add";
  if (line.startsWith("-")) return "diff-line diff-del";
  return "diff-line";
}

export function summarizeToolArgs(args: Record<string, unknown>): string {
  const entries = Object.entries(args);
  if (entries.length === 0) return "";
  const primaryKeys = ["path", "file", "filePath", "command", "cmd", "query", "pattern", "url"];
  for (const key of primaryKeys) {
    const val = args[key];
    if (typeof val === "string" && val.trim() !== "") {
      return singleLineExcerpt(val, 72);
    }
  }
  try {
    return singleLineExcerpt(JSON.stringify(args), 72);
  } catch {
    return "";
  }
}

export function extractToolFilePath(args: Record<string, unknown>): string | null {
  for (const key of ["path", "file", "filePath", "target_file"]) {
    const val = args[key];
    if (typeof val === "string" && val.trim() !== "") return val.trim();
  }
  return null;
}

export function fileBaseName(path: string): string {
  return path.split(/[\\/]/).pop() || path;
}

export function fileFolderOf(path: string): string {
  const normalized = path.replace(/\\/g, "/");
  return normalized.includes("/") ? normalized.slice(0, normalized.lastIndexOf("/")) : "";
}

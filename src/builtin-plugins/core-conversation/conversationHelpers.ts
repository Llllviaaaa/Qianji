/**
 * Pure transcript, turn grouping, live plan, code-fence splitting, and
 * approval dialog helpers for the built-in `core-conversation` plugin (ADR 0023).
 */
import type { UiMessage, UiToolCall } from "@qianji/client";

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

const THINK_BLOCK_RE = /<think>([\s\S]*?)<\/think>/gi;
const CODE_FENCE_RE = /```([a-zA-Z0-9_+#.-]*)[ \t]*\r?\n([\s\S]*?)```/g;

export function extractInlineThinking(
  content: string,
  explicitThinking?: string,
): { readonly content: string; readonly thinking: string } {
  const extracted: string[] = [];
  if (typeof explicitThinking === "string" && explicitThinking.trim() !== "") {
    extracted.push(explicitThinking.trim());
  }
  const cleaned = content
    .replace(THINK_BLOCK_RE, (_match, inner: string) => {
      const trimmed = inner.trim();
      if (trimmed !== "") extracted.push(trimmed);
      return "";
    })
    .trim();
  return {
    content: cleaned,
    thinking: extracted.join("\n\n"),
  };
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
  const rawTurns: Array<{
    key: string;
    userMessage?: UiMessage;
    assistantMessages: UiMessage[];
  }> = [];

  for (const message of messages) {
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

function parsePlanFromToolCall(call: UiToolCall): LivePlanSummary | null {
  const normalized = call.name.toLowerCase();
  if (
    normalized !== "update_plan" &&
    normalized !== "todo_write" &&
    normalized !== "todowrite" &&
    normalized !== "task_plan"
  ) {
    return null;
  }
  const rawList = Array.isArray(call.args.plan)
    ? call.args.plan
    : Array.isArray(call.args.todos)
      ? call.args.todos
      : Array.isArray(call.args.steps)
        ? call.args.steps
        : null;
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
  const explanation =
    typeof call.args.explanation === "string" && call.args.explanation.trim() !== ""
      ? call.args.explanation.trim()
      : undefined;
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

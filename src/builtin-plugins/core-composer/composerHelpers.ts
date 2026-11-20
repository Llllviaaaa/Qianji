/**
 * Pure composer helpers, option tables, enter-key resolution, and slash-command
 * filtering for the built-in `core-composer` plugin (ADR 0023 Wave 2B).
 */
import type { AppSettings } from "@qianji/protocol";
import type { SessionStats } from "@qianji/client";

export const PERMISSION_OPTIONS: ReadonlyArray<{
  readonly value: AppSettings["permissionMode"];
  readonly label: string;
  readonly description: string;
}> = [
  { value: "read-only", label: "只读", description: "可检查文件，不能修改或执行交互操作" },
  { value: "ask", label: "先询问", description: "写入文件和执行命令前请求确认" },
  { value: "workspace-write", label: "工作区写入", description: "可修改当前工作区，命令仍按规则确认" },
  { value: "full-access", label: "完全访问", description: "允许修改文件并执行命令，不再逐项确认" },
];

export const STREAMING_BEHAVIOR_OPTIONS: ReadonlyArray<{
  readonly value: "steer" | "followUp";
  readonly chip: string;
  readonly label: string;
  readonly description: string;
}> = [
  { value: "steer", chip: "调整", label: "调整当前任务", description: "插进正在进行的任务" },
  { value: "followUp", chip: "排队", label: "排队到下一轮", description: "等这一轮做完再发送" },
];

export const AGENT_MODE_OPTIONS: ReadonlyArray<{
  readonly value: AppSettings["agentMode"];
  readonly label: string;
  readonly description: string;
}> = [
  { value: "agent", label: "执行", description: "可以修改代码、运行命令" },
  { value: "plan", label: "计划", description: "只读梳理方案，不改文件" },
  { value: "ask", label: "问答", description: "只读回答问题，不改文件" },
];

export interface ContextUsageMetrics {
  readonly normalizedContextPercent: number | null;
  readonly contextUsedThousands: number | null;
  readonly contextWindowThousands: number | null;
  readonly remainingContextPercent: number | null;
}

export function computeContextUsageMetrics(
  contextUsage: SessionStats["contextUsage"] | undefined,
): ContextUsageMetrics {
  const normalizedContextPercent =
    typeof contextUsage?.percent === "number" && Number.isFinite(contextUsage.percent)
      ? Math.min(100, Math.max(0, Math.round(contextUsage.percent)))
      : null;
  const contextUsedTokens =
    typeof contextUsage?.tokens === "number" && Number.isFinite(contextUsage.tokens)
      ? Math.max(0, contextUsage.tokens)
      : null;
  const contextWindow =
    typeof contextUsage?.contextWindow === "number" &&
    Number.isFinite(contextUsage.contextWindow) &&
    contextUsage.contextWindow > 0
      ? contextUsage.contextWindow
      : null;
  return {
    normalizedContextPercent,
    contextUsedThousands: contextUsedTokens === null ? null : Math.round(contextUsedTokens / 1_000),
    contextWindowThousands: contextWindow === null ? null : Math.round(contextWindow / 1_000),
    remainingContextPercent:
      normalizedContextPercent === null ? null : Math.max(0, 100 - normalizedContextPercent),
  };
}

export function buildComposerPlaceholder(options: {
  readonly disabled?: boolean;
  readonly isStreaming: boolean;
  readonly streamingBehavior: "steer" | "followUp";
  readonly variant: "task-start" | "follow-up";
  readonly requireCtrlEnter: boolean;
}): string {
  const { disabled, isStreaming, streamingBehavior, variant, requireCtrlEnter } = options;
  const idleTail = requireCtrlEnter ? "，Ctrl+Enter 发送…" : "…";
  const streamingTail = requireCtrlEnter ? "（Ctrl+Enter 发送）…" : "…";
  if (disabled === true) return "正在准备…";
  if (isStreaming) {
    return streamingBehavior === "steer"
      ? `补充指示，会插入正在进行的任务${streamingTail}`
      : `写下一条消息，这一轮结束后发送${streamingTail}`;
  }
  return variant === "task-start"
    ? `描述要做的事，用 / 调用命令${idleTail}`
    : `继续对话，用 / 调用命令${idleTail}`;
}

export function formatSendShortcutHint(requireCtrlEnter: boolean): string {
  return requireCtrlEnter ? "Ctrl+Enter" : "Enter";
}

export function resolveChatEnterAction(
  event: {
    readonly key: string;
    readonly ctrlKey: boolean;
    readonly metaKey: boolean;
    readonly shiftKey: boolean;
    readonly altKey: boolean;
    readonly isComposing?: boolean;
    readonly keyCode?: number;
    readonly defaultPrevented?: boolean;
  },
  options: {
    readonly requireCtrlEnter: boolean;
    readonly hasActiveSuggestion?: boolean;
  },
): "none" | "submit" | "insert-newline" | "accept-suggestion" {
  if (event.defaultPrevented === true || event.isComposing === true || event.keyCode === 229) {
    return "none";
  }
  if (event.key === "Tab" && options.hasActiveSuggestion === true) {
    return "accept-suggestion";
  }
  if (event.key !== "Enter") return "none";
  if (options.hasActiveSuggestion === true && !event.shiftKey && !event.ctrlKey && !event.metaKey) {
    return "accept-suggestion";
  }
  if (options.requireCtrlEnter) {
    return event.ctrlKey || event.metaKey ? "submit" : "none";
  }
  if (event.shiftKey || event.altKey) {
    return "insert-newline";
  }
  return "submit";
}

export function insertNewlineAtSelection(
  value: string,
  selectionStart: number | null,
  selectionEnd: number | null,
): { readonly value: string; readonly caret: number } {
  const start = selectionStart ?? value.length;
  const end = selectionEnd ?? start;
  const nextValue = `${value.slice(0, start)}\n${value.slice(end)}`;
  return { value: nextValue, caret: start + 1 };
}

export function extractLeadingSlashQuery(text: string): string | null {
  const match = /^\/([a-zA-Z0-9:_-]*)$/.exec(text);
  return match !== null ? (match[1] ?? "") : null;
}

export function parseSubmittedSlashCommand(text: string): { readonly name: string; readonly rawArgs: string } | null {
  const trimmed = text.trim();
  const match = /^\/([a-zA-Z0-9][a-zA-Z0-9:_-]*)(?:\s+([\s\S]*))?$/.exec(trimmed);
  if (match === null || match[1] === undefined) return null;
  return {
    name: match[1],
    rawArgs: (match[2] ?? "").trim(),
  };
}

export function formatWorkspaceName(workspace: string): string {
  const trimmed = workspace.trim();
  if (trimmed === "") return "默认工作区";
  return trimmed.split(/[\\/]/).filter(Boolean).pop() || "默认工作区";
}

export function resolveComposerSessionKey(
  explicitKey: string | undefined,
  scopeSessionId: string | null,
  sessionFile: string | null | undefined,
): string {
  if (explicitKey !== undefined && explicitKey.trim() !== "") return explicitKey.trim();
  if (scopeSessionId !== null && scopeSessionId.trim() !== "") return scopeSessionId.trim();
  if (sessionFile !== undefined && sessionFile !== null && sessionFile.trim() !== "") return sessionFile.trim();
  return "__draft__";
}

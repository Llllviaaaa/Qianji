/**
 * Shared `SessionHandle` types, active-session pool adapter, and Fiber-bound
 * handle wrapper for `SessionService.retain()`.
 */
import type { Context } from "@deepseek-ai/cordis";
import { describeError } from "../../lib/errors";
import { clientContributions } from "../../lib/clientContributions";
import {
  buildPromptPayload,
  harnessRuntimes,
  parseLeadingSlashCommand,
  type PromptInput,
  type RewindExecutionResult,
  type RewindMode,
} from "../../lib/harnessRuntime";
import { requestOpenSettings } from "../../lib/shellBridge";
import { appendNotice } from "../../lib/transcript";
import { useAppStore } from "../../store";
import type {
  AppSettings,
  AttachmentPayload,
  ModelInfo,
  SessionStats,
  SlashCommand,
  UiMessage,
} from "../../types";
import { ServiceEmitter, shallowEqualObject, trackContextEffect } from "./shared";

export interface SessionHandleSnapshot {
  readonly sessionId: string | null;
  readonly sessionFile: string | null;
  readonly sessionName: string | null;
  readonly cwd: string;
  readonly runtimeId: string | null;
  readonly isolated: boolean;
  readonly phase: "idle" | "starting" | "ready" | "error";
  readonly error: string | null;
  readonly messages: readonly UiMessage[];
  readonly isStreaming: boolean;
  readonly isCompacting: boolean;
  readonly retryStatus: string | null;
  readonly stats: SessionStats | null;
  readonly model: ModelInfo | null;
  readonly thinkingLevel: string;
  readonly availableModels: readonly ModelInfo[];
  readonly availableThinkingLevels: readonly string[];
  readonly commands: readonly SlashCommand[];
  readonly permissionMode: AppSettings["permissionMode"];
  readonly agentMode: AppSettings["agentMode"];
}

export interface RetainSessionOptions {
  /** Workspace directory used when starting an isolated runtime. */
  cwd?: string;
  /** Parent session file to fork from when creating a side-chat session. */
  parentSessionFile?: string;
  /** Force an isolated runtime/transcript separate from the active main session. */
  isolated?: boolean;
  /** Start an isolated Harness runtime immediately on first retain when `cwd` is present. */
  autoStart?: boolean;
  /** Optional initial transcript messages for isolated or hydrated sessions. */
  initialMessages?: readonly UiMessage[];
  model?: ModelInfo | null;
  thinkingLevel?: string;
  permissionMode?: AppSettings["permissionMode"];
  agentMode?: AppSettings["agentMode"];
}

export interface SessionHandle {
  readonly sessionId: string;
  readonly isolated: boolean;
  readonly released: boolean;
  getSnapshot(): SessionHandleSnapshot;
  subscribe(listener: () => void): () => void;
  sendMessage(
    text: string,
    attachments?: AttachmentPayload[],
    behavior?: "steer" | "followUp",
  ): Promise<boolean>;
  abort(): Promise<void>;
  steer(text: string, attachments?: AttachmentPayload[]): Promise<boolean>;
  followUp(text: string, attachments?: AttachmentPayload[]): Promise<boolean>;
  editAndResend(entryId: string, text: string, attachments?: AttachmentPayload[]): Promise<boolean>;
  rewind(entryId: string, mode?: RewindMode): Promise<RewindExecutionResult | null>;
  fork(entryId?: string): Promise<void>;
  clone(): Promise<void>;
  setModel(model: ModelInfo): Promise<void>;
  setThinkingLevel(level: string): Promise<void>;
  setPermissionMode(mode: AppSettings["permissionMode"]): Promise<void>;
  setAgentMode(mode: AppSettings["agentMode"]): Promise<void>;
  compact(): Promise<void>;
  exportMarkdown(destination: string): Promise<string>;
  release(): void;
}

export interface SessionPoolEntry {
  readonly key: string;
  readonly sessionId: string;
  readonly isolated: boolean;
  refCount: number;
  activate?(options?: RetainSessionOptions): void;
  getSnapshot(): SessionHandleSnapshot;
  subscribe(listener: () => void): () => void;
  sendMessage(
    text: string,
    attachments?: AttachmentPayload[],
    behavior?: "steer" | "followUp",
  ): Promise<boolean>;
  abort(): Promise<void>;
  editAndResend(entryId: string, text: string, attachments?: AttachmentPayload[]): Promise<boolean>;
  rewind(entryId: string, mode?: RewindMode): Promise<RewindExecutionResult | null>;
  fork(entryId?: string): Promise<void>;
  clone(): Promise<void>;
  setModel(model: ModelInfo): Promise<void>;
  setThinkingLevel(level: string): Promise<void>;
  setPermissionMode(mode: AppSettings["permissionMode"]): Promise<void>;
  setAgentMode(mode: AppSettings["agentMode"]): Promise<void>;
  compact(): Promise<void>;
  exportMarkdown(destination: string): Promise<string>;
  dispose(): void;
}

function describeSessionActionError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export type IsolatedSlashOutcome =
  | { readonly kind: "passthrough"; readonly payload: PromptInput }
  | { readonly kind: "handled-silent" }
  | { readonly kind: "clear" }
  | { readonly kind: "compact" }
  | {
      readonly kind: "direct-reply";
      readonly userMessage: UiMessage;
      readonly assistantMessage?: UiMessage;
      readonly noticeMessage?: UiMessage;
    };

export async function resolveIsolatedSlashCommand(options: {
  readonly runtimeId: string;
  readonly cwd: string;
  readonly sessionFile: string | null;
  readonly wasStreaming: boolean;
  readonly payload: PromptInput;
}): Promise<IsolatedSlashOutcome> {
  const { runtimeId, cwd, sessionFile, wasStreaming, payload } = options;
  if (payload.images.length > 0) {
    return { kind: "passthrough", payload };
  }
  const slash = parseLeadingSlashCommand(payload.message);
  if (slash === null || (wasStreaming && slash.name !== "goal")) {
    return { kind: "passthrough", payload };
  }
  if (slash.rawArgs.trim() === "" && (slash.name === "mcp" || slash.name === "skills")) {
    if (requestOpenSettings(slash.name)) return { kind: "handled-silent" };
  }
  const handledByClient = await clientContributions.tryHandleSlashCommand(slash.name, slash.rawArgs, {
    cwd,
    sessionFile,
  });
  if (handledByClient) return { kind: "handled-silent" };

  const commandResult = await harnessRuntimes.runCommand(runtimeId, slash.name, slash.rawArgs);
  if (!commandResult.handled) {
    return { kind: "passthrough", payload };
  }
  if (commandResult.clientAction === "clear") return { kind: "clear" };
  if (commandResult.clientAction === "compact") return { kind: "compact" };
  if (commandResult.prompt !== undefined && commandResult.prompt.trim() !== "") {
    return {
      kind: "passthrough",
      payload: {
        message: payload.message,
        metaPrompt: commandResult.prompt,
        images: payload.images,
      },
    };
  }
  const now = Date.now();
  const nonce = `${now}-${Math.random().toString(36).slice(2, 7)}`;
  const outputText = commandResult.output ?? `已执行 \`/${slash.name}\`。`;
  if (slash.name === "goal") {
    return {
      kind: "direct-reply",
      userMessage: { id: `iso-slash-u-${nonce}`, role: "user", content: payload.message, timestamp: now },
      noticeMessage: {
        id: `iso-slash-notice-${nonce}`,
        role: "notice",
        content: outputText,
        ...(commandResult.isError ? { isError: true } : {}),
        timestamp: now,
      },
    };
  }
  return {
    kind: "direct-reply",
    userMessage: {
      id: `iso-slash-user-${nonce}`,
      role: "user",
      content: payload.message,
      timestamp: now,
    },
    assistantMessage: {
      id: `iso-slash-assistant-${nonce}`,
      role: "assistant",
      content: outputText,
      ...(commandResult.isError ? { isError: true } : {}),
      timestamp: now,
    },
  };
}

export async function dispatchIsolatedSessionPrompt(options: {
  readonly text: string;
  readonly attachments: AttachmentPayload[];
  readonly behavior?: "steer" | "followUp";
  readonly runtimeId: string;
  readonly snapshot: SessionHandleSnapshot;
  readonly patch: (next: Partial<SessionHandleSnapshot>) => void;
  readonly compact: () => Promise<void>;
  readonly onTurnStart: (ts: number) => void;
}): Promise<boolean> {
  const { text, attachments, behavior, runtimeId, snapshot, patch, compact, onTurnStart } = options;
  const payload = buildPromptPayload(text, attachments);
  if (!payload.message && payload.images.length === 0) return false;

  const wasStreaming = snapshot.isStreaming;
  let effectivePayload: typeof payload;
  try {
    const slashOutcome = await resolveIsolatedSlashCommand({
      runtimeId,
      cwd: snapshot.cwd,
      sessionFile: snapshot.sessionFile,
      wasStreaming,
      payload,
    });
    if (slashOutcome.kind === "handled-silent") return true;
    if (slashOutcome.kind === "clear") {
      patch({ messages: [], error: null, retryStatus: null });
      return true;
    }
    if (slashOutcome.kind === "compact") {
      await compact();
      return true;
    }
    if (slashOutcome.kind === "direct-reply") {
      const nextMsgs = slashOutcome.noticeMessage
        ? appendNotice([...snapshot.messages], slashOutcome.noticeMessage)
        : [
            ...snapshot.messages,
            slashOutcome.userMessage,
            ...(slashOutcome.assistantMessage ? [slashOutcome.assistantMessage] : []),
          ];
      patch({ messages: nextMsgs });
      return true;
    }
    effectivePayload = slashOutcome.payload;
  } catch (error) {
    patch({ error: describeError(error) });
    return false;
  }

  if (!wasStreaming) {
    const now = Date.now();
    onTurnStart(now);
    patch({
      isStreaming: true,
      messages: [
        ...snapshot.messages,
        {
          id: `iso-user-${now}-${Math.random().toString(36).slice(2, 7)}`,
          role: "user",
          content: effectivePayload.message,
          images:
            effectivePayload.images.length > 0
              ? effectivePayload.images.map(({ data, mimeType }) => ({ type: "image", data, mimeType }))
              : undefined,
          timestamp: now,
        },
      ],
    });
  }
  try {
    if (wasStreaming) {
      await harnessRuntimes.queue(runtimeId, behavior === "followUp" ? "followUp" : "steer", effectivePayload);
    } else {
      await harnessRuntimes.prompt(runtimeId, effectivePayload);
    }
    return true;
  } catch (error) {
    patch({ isStreaming: wasStreaming, error: describeError(error) });
    return false;
  }
}

export async function applyMainPermissionMode(mode: AppSettings["permissionMode"]): Promise<void> {
  const current = useAppStore.getState();
  if (current.settings !== null && current.settings.permissionMode === mode) return;
  if (current.isStreaming) {
    current.showToast("请等待当前回复完成后再切换权限", "warning");
    return;
  }
  const previous = current.settings?.permissionMode;
  try {
    await current.setRuntimePermissionMode(mode);
    if (current.settings !== null) {
      await current.saveSettings({ ...current.settings, permissionMode: mode });
      useAppStore.getState().showToast("权限模式已更新", "info");
    }
  } catch (error) {
    if (previous !== undefined) {
      await useAppStore.getState().setRuntimePermissionMode(previous).catch(() => undefined);
    }
    useAppStore.getState().showToast(`切换权限失败：${describeSessionActionError(error)}`, "error");
  }
}

export async function applyMainAgentMode(mode: AppSettings["agentMode"]): Promise<void> {
  const current = useAppStore.getState();
  if (current.settings !== null && current.settings.agentMode === mode) return;
  if (current.isStreaming) {
    current.showToast("请等待当前回复完成后再切换工作模式", "warning");
    return;
  }
  const previous = current.settings?.agentMode;
  try {
    await current.setRuntimeAgentMode(mode);
    if (current.settings !== null) {
      await current.saveSettings({ ...current.settings, agentMode: mode });
      const label = mode === "agent" ? "执行" : mode === "plan" ? "计划" : "问答";
      useAppStore.getState().showToast(`已切换到${label}模式`, "info");
    }
  } catch (error) {
    if (previous !== undefined) {
      await useAppStore.getState().setRuntimeAgentMode(previous).catch(() => undefined);
    }
    useAppStore.getState().showToast(`切换工作模式失败：${describeSessionActionError(error)}`, "error");
  }
}

export function buildActiveHandleSnapshot(): SessionHandleSnapshot {
  const s = useAppStore.getState();
  return {
    sessionId: s.sessionId,
    sessionFile: s.sessionFile,
    sessionName: s.sessionName,
    cwd: s.cwd,
    runtimeId: s.runtimeId,
    isolated: false,
    phase: s.connection === "running" ? "ready" : s.connection === "starting" ? "starting" : "idle",
    error: s.lastError,
    messages: s.messages,
    isStreaming: s.isStreaming,
    isCompacting: s.isCompacting,
    retryStatus: s.retryStatus,
    stats: s.stats,
    model: s.model,
    thinkingLevel: s.thinkingLevel,
    availableModels: s.availableModels,
    availableThinkingLevels: s.availableThinkingLevels,
    commands: s.commands,
    permissionMode: s.settings?.permissionMode ?? "ask",
    agentMode: s.settings?.agentMode ?? "agent",
  };
}

export function createActivePoolEntry(key: string, sessionId: string): SessionPoolEntry {
  const emitter = new ServiceEmitter(`session-handle:${key}`);
  let snapshot = buildActiveHandleSnapshot();

  const offStore = useAppStore.subscribe(() => {
    const next = buildActiveHandleSnapshot();
    if (!shallowEqualObject(snapshot, next)) {
      snapshot = next;
      emitter.emit();
    }
  });

  return {
    key,
    sessionId,
    isolated: false,
    refCount: 0,
    getSnapshot: () => snapshot,
    subscribe: (listener) => emitter.add(listener),
    sendMessage: (text, attachments, behavior) =>
      useAppStore.getState().sendMessage(text, attachments, behavior),
    abort: () => useAppStore.getState().abort(),
    editAndResend: (entryId, text, attachments) =>
      useAppStore.getState().editAndResend(entryId, text, attachments),
    rewind: (entryId, mode = "both") =>
      useAppStore.getState().rewindMessageWithMode(entryId, mode),
    fork: async (entryId) => {
      const store = useAppStore.getState();
      if (entryId !== undefined && entryId.trim() !== "") {
        await store.continueFromTreeNode(entryId);
      } else {
        await store.forkLatest();
      }
    },
    clone: () => useAppStore.getState().cloneSession(),
    setModel: (model) => useAppStore.getState().setModel(model),
    setThinkingLevel: (level) => useAppStore.getState().setThinkingLevel(level),
    setPermissionMode: (mode) => applyMainPermissionMode(mode),
    setAgentMode: (mode) => applyMainAgentMode(mode),
    compact: () => useAppStore.getState().compact(),
    exportMarkdown: (destination) => useAppStore.getState().exportSession(destination),
    dispose: () => {
      offStore();
      emitter.clear();
    },
  };
}

export function createBoundSessionHandle(
  callerCtx: Context,
  entry: SessionPoolEntry,
  onReleaseEntry: () => void,
): SessionHandle {
  let released = false;
  const handleUnsubscribers = new Set<() => void>();

  const releaseOnce = () => {
    if (released) return;
    released = true;
    for (const unsub of [...handleUnsubscribers]) unsub();
    handleUnsubscribers.clear();
    onReleaseEntry();
  };

  const detachEffect = trackContextEffect(callerCtx, releaseOnce);

  return {
    sessionId: entry.sessionId,
    isolated: entry.isolated,
    get released() {
      return released;
    },
    getSnapshot: () => entry.getSnapshot(),
    subscribe(listener) {
      if (released) return () => undefined;
      const rawUnsub = entry.subscribe(listener);
      const tracked = trackContextEffect(callerCtx, () => {
        handleUnsubscribers.delete(tracked);
        rawUnsub();
      });
      handleUnsubscribers.add(tracked);
      return tracked;
    },
    sendMessage: (text, attachments, behavior) => entry.sendMessage(text, attachments, behavior),
    abort: () => entry.abort(),
    steer: (text, attachments) => entry.sendMessage(text, attachments, "steer"),
    followUp: (text, attachments) => entry.sendMessage(text, attachments, "followUp"),
    editAndResend: (entryId, text, attachments) => entry.editAndResend(entryId, text, attachments),
    rewind: (entryId, mode) => entry.rewind(entryId, mode),
    fork: (entryId) => entry.fork(entryId),
    clone: () => entry.clone(),
    setModel: (model) => entry.setModel(model),
    setThinkingLevel: (level) => entry.setThinkingLevel(level),
    setPermissionMode: (mode) => entry.setPermissionMode(mode),
    setAgentMode: (mode) => entry.setAgentMode(mode),
    compact: () => entry.compact(),
    exportMarkdown: (destination) => entry.exportMarkdown(destination),
    release: () => {
      detachEffect();
    },
  };
}

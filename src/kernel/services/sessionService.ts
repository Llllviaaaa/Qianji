/**
 * Frontend Cordis `sessionService` (ADR 0023 Phase 2).
 *
 * Exposes active session state (including full `messages: UiMessage[]`),
 * session catalog / tree navigation, and ref-counted multi-session `retain()`
 * handles for both the main conversation and isolated side-chat / split panes.
 */
import { Context, Service } from "@deepseek-ai/cordis";
import { agent } from "../../lib/agent";
import {
  HARNESS_SESSION_PREFIX,
  isHarnessSessionFile,
  type RewindExecutionResult,
  type RewindMode,
} from "../../lib/harnessRuntime";
import { sameLocalPath } from "../../lib/pathIdentity";
import { useAppStore } from "../../store";
import type {
  AppSettings,
  AttachmentPayload,
  ConnectionState,
  ModelInfo,
  SessionInfo,
  SessionSearchMatch,
  SessionStats,
  SessionTreeNodeView,
  SlashCommand,
  UiMessage,
} from "../../types";
import {
  applyMainAgentMode,
  applyMainPermissionMode,
} from "./sessionHandleBase";
import {
  createActivePoolEntry,
  createBoundSessionHandle,
  createIsolatedPoolEntry,
  type RetainSessionOptions,
  type SessionHandle,
  type SessionHandleSnapshot,
  type SessionPoolEntry,
} from "./sessionHandle";
import { ServiceEmitter, shallowEqualObject, trackContextEffect } from "./shared";

export type { RetainSessionOptions, SessionHandle, SessionHandleSnapshot };

declare module "@deepseek-ai/cordis" {
  interface Context {
    sessionService: SessionService;
  }
}

export interface SessionServiceSnapshot {
  readonly sessionId: string | null;
  readonly sessionFile: string | null;
  readonly sessionName: string | null;
  readonly cwd: string;
  readonly runtimeId: string | null;
  readonly connection: ConnectionState;
  readonly messages: readonly UiMessage[];
  readonly isStreaming: boolean;
  readonly isCompacting: boolean;
  readonly isSwitchingModel: boolean;
  readonly retryStatus: string | null;
  readonly stats: SessionStats | null;
  readonly model: ModelInfo | null;
  readonly thinkingLevel: string;
  readonly availableModels: readonly ModelInfo[];
  readonly availableThinkingLevels: readonly string[];
  readonly commands: readonly SlashCommand[];
  readonly permissionMode: AppSettings["permissionMode"];
  readonly agentMode: AppSettings["agentMode"];
  readonly sessions: readonly SessionInfo[];
  readonly runningSessionFiles: readonly string[];
  readonly approvalSessionFiles: readonly string[];
  readonly sessionTree: readonly SessionTreeNodeView[];
  readonly sessionTreeLeafId: string | null;
  readonly sessionTreeLoading: boolean;
  readonly sessionTreeError: string | null;
  readonly lastError: string | null;
}

const EMPTY_STRING_LIST: readonly string[] = [];
let cachedRunningFiles: readonly string[] = EMPTY_STRING_LIST;
let cachedApprovalFiles: readonly string[] = EMPTY_STRING_LIST;

function stableStringList(next: string[], prev: readonly string[]): readonly string[] {
  if (next.length === 0) return EMPTY_STRING_LIST;
  if (next.length === prev.length && next.every((item, idx) => item === prev[idx])) {
    return prev;
  }
  return next;
}

function buildSessionServiceSnapshot(): SessionServiceSnapshot {
  const s = useAppStore.getState();
  const runningSet = new Set<string>();
  const approvalSet = new Set<string>();
  for (const rt of Object.values(s.runtimes)) {
    if (rt.sessionFile !== null && rt.sessionFile !== "") {
      if (rt.isStreaming) runningSet.add(rt.sessionFile);
      if (rt.extensionRequest !== null) approvalSet.add(rt.sessionFile);
    }
  }
  if (s.sessionFile !== null && s.sessionFile !== "") {
    if (s.isStreaming) runningSet.add(s.sessionFile);
    if (s.extensionRequest !== null) approvalSet.add(s.sessionFile);
  }
  cachedRunningFiles = stableStringList([...runningSet], cachedRunningFiles);
  cachedApprovalFiles = stableStringList([...approvalSet], cachedApprovalFiles);

  return {
    sessionId: s.sessionId,
    sessionFile: s.sessionFile,
    sessionName: s.sessionName,
    cwd: s.cwd,
    runtimeId: s.runtimeId,
    connection: s.connection,
    messages: s.messages,
    isStreaming: s.isStreaming,
    isCompacting: s.isCompacting,
    isSwitchingModel: s.isSwitchingModel,
    retryStatus: s.retryStatus,
    stats: s.stats,
    model: s.model,
    thinkingLevel: s.thinkingLevel,
    availableModels: s.availableModels,
    availableThinkingLevels: s.availableThinkingLevels,
    commands: s.commands,
    permissionMode: s.settings?.permissionMode ?? "ask",
    agentMode: s.settings?.agentMode ?? "agent",
    sessions: s.sessions,
    runningSessionFiles: cachedRunningFiles,
    approvalSessionFiles: cachedApprovalFiles,
    sessionTree: s.sessionTree,
    sessionTreeLeafId: s.sessionTreeLeafId,
    sessionTreeLoading: s.sessionTreeLoading,
    sessionTreeError: s.sessionTreeError,
    lastError: s.lastError,
  };
}

function normalizeSessionId(raw: string): string {
  const trimmed = raw.trim();
  if (isHarnessSessionFile(trimmed)) {
    return trimmed.slice(HARNESS_SESSION_PREFIX.length);
  }
  return trimmed;
}

function isMainSessionTarget(sessionId: string, options?: RetainSessionOptions): boolean {
  if (options?.isolated === true || Boolean(options?.parentSessionFile)) return false;
  const normalized = normalizeSessionId(sessionId);
  if (normalized === "" || normalized === "active") return true;
  const state = useAppStore.getState();
  if (state.sessionId !== null && normalizeSessionId(state.sessionId) === normalized) return true;
  if (state.sessionFile !== null && normalizeSessionId(state.sessionFile) === normalized) return true;
  return false;
}

function resolvePoolKey(sessionId: string, options?: RetainSessionOptions): {
  key: string;
  normalizedId: string;
  useMain: boolean;
} {
  const useMain = isMainSessionTarget(sessionId, options);
  const normalizedId = normalizeSessionId(sessionId) || "active";
  if (useMain) {
    return { key: "main:active", normalizedId, useMain: true };
  }
  const scopePrefix = options?.isolated === true || Boolean(options?.parentSessionFile) ? "isolated:" : "session:";
  return { key: `${scopePrefix}${normalizedId}`, normalizedId, useMain: false };
}

interface SessionServiceInternalState {
  snapshot: SessionServiceSnapshot;
  readonly emitter: ServiceEmitter;
  readonly pool: Map<string, SessionPoolEntry>;
}

export class SessionService extends Service {
  static provide = "sessionService";
  private readonly internal: SessionServiceInternalState;

  constructor(ctx: Context) {
    super(ctx, "sessionService");
    this.internal = {
      snapshot: buildSessionServiceSnapshot(),
      emitter: new ServiceEmitter("sessionService"),
      pool: new Map(),
    };

    const offStore = useAppStore.subscribe(() => {
      const next = buildSessionServiceSnapshot();
      if (!shallowEqualObject(this.internal.snapshot, next)) {
        this.internal.snapshot = next;
        this.internal.emitter.emit();
      }
    });

    ctx.effect(() => () => {
      offStore();
      for (const entry of [...this.internal.pool.values()]) {
        entry.dispose();
      }
      this.internal.pool.clear();
      this.internal.emitter.clear();
    });
  }

  getSnapshot(): SessionServiceSnapshot {
    return this.internal.snapshot;
  }

  subscribe(listener: () => void): () => void {
    const rawUnsub = this.internal.emitter.add(listener);
    return trackContextEffect(this.ctx, rawUnsub);
  }

  /**
   * Retain a ref-counted `SessionHandle` for either the active main session
   * or an isolated side-chat / split-pane session. Automatically released when
   * the calling plugin's Cordis Fiber unmounts or when `handle.release()` runs.
   */
  retain(sessionId: string, options?: RetainSessionOptions): SessionHandle {
    const { key, normalizedId, useMain } = resolvePoolKey(sessionId, options);
    let entry = this.internal.pool.get(key);
    if (entry === undefined) {
      entry = useMain
        ? createActivePoolEntry(key, normalizedId)
        : createIsolatedPoolEntry(key, normalizedId, options);
      this.internal.pool.set(key, entry);
    }
    entry.refCount += 1;

    const targetEntry = entry;
    return createBoundSessionHandle(this.ctx, targetEntry, () => {
      targetEntry.refCount = Math.max(0, targetEntry.refCount - 1);
      if (targetEntry.refCount === 0 && this.internal.pool.get(key) === targetEntry) {
        this.internal.pool.delete(key);
        targetEntry.dispose();
      }
    });
  }

  /** Current reference count for a retained session pool key (useful for diagnostics & tests). */
  getRetainCount(sessionId: string, options?: RetainSessionOptions): number {
    const { key } = resolvePoolKey(sessionId, options);
    return this.internal.pool.get(key)?.refCount ?? 0;
  }

  listSessions(): readonly SessionInfo[] {
    return this.internal.snapshot.sessions;
  }

  async refreshSessions(): Promise<void> {
    await useAppStore.getState().refreshSessions();
  }

  async listArchivedSessions(): Promise<SessionInfo[]> {
    return agent.listArchivedSessions();
  }

  async searchSessions(
    query: string,
    options?: { cwd?: string; includeArchived?: boolean; limit?: number },
  ): Promise<SessionSearchMatch[]> {
    return agent.searchSessions(query, options);
  }

  async connect(cwd: string, sessionFile?: string): Promise<void> {
    await useAppStore.getState().connect(cwd, sessionFile);
  }

  async disconnect(): Promise<void> {
    await useAppStore.getState().disconnect();
  }

  prepareNewTask(): void {
    useAppStore.getState().prepareNewTask();
  }

  async newSession(): Promise<void> {
    await useAppStore.getState().newSession();
  }

  async switchSession(cwd: string, sessionFile: string): Promise<void> {
    await useAppStore.getState().switchSession(cwd, sessionFile);
  }

  async renameSession(name: string, sessionFile?: string): Promise<void> {
    const trimmed = name.trim();
    if (trimmed === "") return;
    const state = useAppStore.getState();
    if (sessionFile !== undefined && !sameLocalPath(sessionFile, state.sessionFile)) {
      await agent.renameSession(sessionFile, trimmed);
      await state.refreshSessions();
      return;
    }
    await state.setSessionName(trimmed);
  }

  async archiveSession(sessionFile: string): Promise<void> {
    await agent.archiveSession(sessionFile);
    const state = useAppStore.getState();
    if (state.sessionFile !== null && sameLocalPath(state.sessionFile, sessionFile)) {
      await state.disconnect().catch(() => undefined);
    }
    await state.refreshSessions();
  }

  async restoreSession(sessionFile: string): Promise<void> {
    await agent.restoreSession(sessionFile);
    await useAppStore.getState().refreshSessions();
  }

  async deleteSession(sessionFile: string): Promise<void> {
    const state = useAppStore.getState();
    if (state.sessionFile !== null && sameLocalPath(state.sessionFile, sessionFile)) {
      await state.abort().catch(() => undefined);
      await state.disconnect().catch(() => undefined);
    }
    await agent.deleteSession(sessionFile);
    await state.refreshSessions();
  }

  async loadSessionTree(): Promise<void> {
    await useAppStore.getState().loadSessionTree();
  }

  async continueFromTreeNode(entryId: string): Promise<void> {
    await useAppStore.getState().continueFromTreeNode(entryId);
  }

  async sendMessage(
    text: string,
    attachments?: AttachmentPayload[],
    behavior?: "steer" | "followUp",
  ): Promise<boolean> {
    return useAppStore.getState().sendMessage(text, attachments, behavior);
  }

  async abort(): Promise<void> {
    await useAppStore.getState().abort();
  }

  async steer(text: string, attachments?: AttachmentPayload[]): Promise<boolean> {
    return useAppStore.getState().sendMessage(text, attachments, "steer");
  }

  async followUp(text: string, attachments?: AttachmentPayload[]): Promise<boolean> {
    return useAppStore.getState().sendMessage(text, attachments, "followUp");
  }

  async editAndResend(
    entryId: string,
    text: string,
    attachments?: AttachmentPayload[],
  ): Promise<boolean> {
    return useAppStore.getState().editAndResend(entryId, text, attachments);
  }

  async rewind(entryId: string, mode: RewindMode = "both"): Promise<RewindExecutionResult | null> {
    return useAppStore.getState().rewindMessageWithMode(entryId, mode);
  }

  async fork(entryId?: string): Promise<void> {
    const state = useAppStore.getState();
    if (entryId !== undefined && entryId.trim() !== "") {
      await state.continueFromTreeNode(entryId);
    } else {
      await state.forkLatest();
    }
  }

  async clone(): Promise<void> {
    await useAppStore.getState().cloneSession();
  }

  async setModel(model: ModelInfo): Promise<void> {
    await useAppStore.getState().setModel(model);
  }

  async setThinkingLevel(level: string): Promise<void> {
    await useAppStore.getState().setThinkingLevel(level);
  }

  async setPermissionMode(mode: AppSettings["permissionMode"]): Promise<void> {
    await applyMainPermissionMode(mode);
  }

  async setAgentMode(mode: AppSettings["agentMode"]): Promise<void> {
    await applyMainAgentMode(mode);
  }

  async compact(): Promise<void> {
    await useAppStore.getState().compact();
  }

  async exportMarkdown(destination: string): Promise<string> {
    return useAppStore.getState().exportSession(destination);
  }
}

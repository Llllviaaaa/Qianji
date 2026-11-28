/**
 * Isolated multi-session `SessionPoolEntry` backing side-chat and split-pane
 * sessions retained via `SessionService.retain()`.
 */
import { agent } from "../../lib/agent";
import { describeError } from "../../lib/errors";
import {
  HARNESS_SESSION_PREFIX,
  harnessRuntimes,
  isHarnessSessionFile,
} from "../../lib/harnessRuntime";
import {
  appendNotice,
  completeAssistant,
  endToolCall,
  interruptTurn,
  progressToolCall,
  replaceOrAppend,
  resetStreamingAssistant,
  settleStoppedTurn,
  startAssistant,
  startToolCall,
  streamAssistant,
  type TranscriptEvent,
} from "../../lib/transcript";
import { useAppStore } from "../../store";
import type { ModelInfo, SlashCommand } from "../../types";
import {
  buildActiveHandleSnapshot,
  createActivePoolEntry,
  createBoundSessionHandle,
  dispatchIsolatedSessionPrompt,
  type RetainSessionOptions,
  type SessionHandle,
  type SessionHandleSnapshot,
  type SessionPoolEntry,
} from "./sessionHandleBase";
import { ServiceEmitter, shallowEqualObject } from "./shared";

export {
  buildActiveHandleSnapshot,
  createActivePoolEntry,
  createBoundSessionHandle,
  type RetainSessionOptions,
  type SessionHandle,
  type SessionHandleSnapshot,
  type SessionPoolEntry,
};

function toSessionFile(sessionId: string): string {
  return isHarnessSessionFile(sessionId) ? sessionId : `${HARNESS_SESSION_PREFIX}${sessionId}`;
}

function pickFallbackModel(explicit: ModelInfo | null, available: readonly ModelInfo[]): ModelInfo | null {
  if (explicit !== null) return explicit;
  const app = useAppStore.getState();
  if (app.model !== null) return app.model;
  const prefProvider = app.settings?.provider?.trim() ?? "";
  const prefModel = app.settings?.model?.trim() ?? "";
  if (prefProvider !== "" && prefModel !== "") {
    const matched = available.find((m) => m.provider === prefProvider && m.id === prefModel);
    if (matched !== undefined) return matched;
  }
  return available[0] ?? null;
}

export function createIsolatedPoolEntry(
  key: string,
  sessionId: string,
  options: RetainSessionOptions = {},
): SessionPoolEntry {
  const emitter = new ServiceEmitter(`session-handle:${key}`);
  const appState = useAppStore.getState();
  const initialModel = options.model ?? appState.model;
  const initialCwd = options.cwd ?? appState.cwd;
  const sideFork = options.isolated === true || Boolean(options.parentSessionFile);
  let disposed = false;
  let autoStartWanted = options.autoStart === true;
  let pendingExplicitModel: ModelInfo | null = options.model ?? null;
  let startPromise: Promise<string | null> | null = null;
  let activeTurnStartedAt: number | null = null;

  let snapshot: SessionHandleSnapshot = {
    sessionId,
    sessionFile: options.parentSessionFile ? null : toSessionFile(sessionId),
    sessionName: null,
    cwd: initialCwd,
    runtimeId: null,
    isolated: true,
    phase: "idle",
    error: null,
    messages: options.initialMessages ? [...options.initialMessages] : [],
    isStreaming: false,
    isCompacting: false,
    retryStatus: null,
    stats: null,
    model: initialModel,
    thinkingLevel: options.thinkingLevel ?? appState.thinkingLevel ?? "medium",
    availableModels: appState.availableModels,
    availableThinkingLevels: harnessRuntimes.thinkingLevels(initialModel),
    commands: appState.commands,
    permissionMode: options.permissionMode ?? (sideFork ? "read-only" : appState.settings?.permissionMode ?? "ask"),
    agentMode: options.agentMode ?? (sideFork ? "ask" : appState.settings?.agentMode ?? "agent"),
  };

  const patch = (next: Partial<SessionHandleSnapshot>): void => {
    if (disposed) return;
    const merged: SessionHandleSnapshot = { ...snapshot, ...next };
    if (!shallowEqualObject(snapshot, merged)) {
      snapshot = merged;
      emitter.emit();
    }
  };

  const applyEvent = (event: TranscriptEvent): void => {
    switch (event.type) {
      case "turn-start":
        activeTurnStartedAt = Date.now();
        patch({ isStreaming: true, retryStatus: null });
        return;
      case "turn-end": {
        activeTurnStartedAt = null;
        patch({
          isStreaming: false,
          isCompacting: false,
          retryStatus: null,
          messages: settleStoppedTurn([...snapshot.messages], Date.now(), event.outcome),
        });
        const rid = snapshot.runtimeId;
        if (rid) {
          void harnessRuntimes.stats(rid).then((stats) => patch({ stats })).catch(() => undefined);
        }
        return;
      }
      case "turn-interrupted":
        activeTurnStartedAt = null;
        patch({ isStreaming: false, retryStatus: null, messages: interruptTurn([...snapshot.messages]) });
        return;
      case "user": {
        const current = [...snapshot.messages];
        const lastUser = [...current].reverse().find((m) => m.role === "user");
        const pendingId = lastUser && !lastUser.entryId && lastUser.content === event.message.content ? lastUser.id : undefined;
        patch({ messages: replaceOrAppend(current, pendingId, event.message) });
        return;
      }
      case "notice":
        patch({ messages: appendNotice([...snapshot.messages], event.message) });
        return;
      case "assistant-start":
        patch({ retryStatus: null, messages: startAssistant([...snapshot.messages]) });
        return;
      case "assistant-delta":
        patch({
          retryStatus: null,
          messages: streamAssistant([...snapshot.messages], {
            ...(event.text ? { text: event.text } : {}),
            ...(event.thinking ? { thinking: event.thinking } : {}),
          }),
        });
        return;
      case "assistant-tool-calls":
        patch({ retryStatus: null, messages: streamAssistant([...snapshot.messages], { toolCalls: event.calls }) });
        return;
      case "assistant": {
        const durationMs = activeTurnStartedAt === null ? undefined : Date.now() - activeTurnStartedAt;
        patch({ retryStatus: null, messages: completeAssistant([...snapshot.messages], { ...event.message, durationMs }) });
        return;
      }
      case "model-changed": {
        const matched = snapshot.availableModels.find(
          (m) => m.provider === event.provider && m.id === event.model,
        );
        const nextModel: ModelInfo = matched ?? {
          id: event.model,
          name: event.model,
          provider: event.provider,
        };
        patch({
          model: nextModel,
          availableThinkingLevels: harnessRuntimes.thinkingLevels(nextModel),
        });
        return;
      }
      case "retry-status":
        patch({ retryStatus: event.text, messages: resetStreamingAssistant([...snapshot.messages]) });
        return;
      case "tool-start":
        patch({ messages: startToolCall([...snapshot.messages], event.callId, event.name, event.args) });
        return;
      case "tool-progress":
        patch({ messages: progressToolCall([...snapshot.messages], event.callId, event.name, event.text) });
        return;
      case "tool-end":
        patch({ messages: endToolCall([...snapshot.messages], event.callId, event.name, event.result) });
        return;
      case "compaction-start":
        patch({ isCompacting: true });
        return;
      case "compaction-end":
        patch({ isCompacting: false });
        return;
      default:
        return;
    }
  };

  const offRuntime = harnessRuntimes.subscribe((runtimeId, event) => {
    if (snapshot.runtimeId !== null && runtimeId === snapshot.runtimeId) {
      applyEvent(event);
    }
  });

  const ensureRuntime = async (): Promise<string | null> => {
    if (disposed) return null;
    if (snapshot.runtimeId !== null) return snapshot.runtimeId;
    if (startPromise !== null) return startPromise;
    if (!snapshot.cwd) return null;

    patch({ phase: "starting", error: null });
    const seedFile = options.parentSessionFile ?? snapshot.sessionFile ?? undefined;
    startPromise = (async () => {
      try {
        const started = await harnessRuntimes.start(snapshot.cwd, seedFile, sideFork);
        if (disposed) {
          void harnessRuntimes.stop(started.runtimeId).catch(() => undefined);
          return null;
        }
        const stateInfo = await harnessRuntimes.state(started.runtimeId).catch(() => null);
        const [models, cmds, initialHistory] = await Promise.all([
          harnessRuntimes.models().catch(() => snapshot.availableModels as ModelInfo[]),
          harnessRuntimes.commands(snapshot.cwd).catch(() => snapshot.commands as SlashCommand[]),
          snapshot.messages.length === 0
            ? harnessRuntimes.messages(started.runtimeId).catch(() => snapshot.messages)
            : Promise.resolve(snapshot.messages),
        ]);
        let resolvedModel = stateInfo?.model ?? null;
        if (pendingExplicitModel !== null) {
          const desired = pendingExplicitModel;
          pendingExplicitModel = null;
          if (
            resolvedModel === null ||
            resolvedModel.provider !== desired.provider ||
            resolvedModel.id !== desired.id
          ) {
            resolvedModel = await harnessRuntimes
              .setModel(started.runtimeId, desired.provider, desired.id)
              .catch(() => resolvedModel ?? desired);
          }
        } else if (resolvedModel === null) {
          const fallback = pickFallbackModel(snapshot.model, models);
          if (fallback !== null) {
            resolvedModel = await harnessRuntimes
              .setModel(started.runtimeId, fallback.provider, fallback.id)
              .catch(() => fallback);
          }
        }
        patch({
          runtimeId: started.runtimeId,
          sessionFile: stateInfo?.sessionFile ?? harnessRuntimes.sessionFileOf(started.runtimeId) ?? snapshot.sessionFile,
          sessionId: stateInfo?.sessionId ?? snapshot.sessionId,
          sessionName: stateInfo?.sessionName ?? snapshot.sessionName,
          messages: snapshot.messages.length === 0 ? initialHistory : snapshot.messages,
          isStreaming: stateInfo?.isStreaming === true || snapshot.isStreaming,
          isCompacting: stateInfo?.isCompacting === true || snapshot.isCompacting,
          model: resolvedModel,
          thinkingLevel: stateInfo?.thinkingLevel ?? snapshot.thinkingLevel,
          availableModels: models,
          availableThinkingLevels: harnessRuntimes.thinkingLevels(resolvedModel),
          commands: cmds,
          phase: "ready",
          error: null,
        });
        await harnessRuntimes
          .setPermission(started.runtimeId, { permission: snapshot.permissionMode, agentMode: snapshot.agentMode })
          .catch(() => undefined);
        return started.runtimeId;
      } catch (error) {
        patch({ phase: "error", error: describeError(error) });
        return null;
      } finally {
        startPromise = null;
      }
    })();
    return startPromise;
  };

  const offHostStatus = harnessRuntimes.onHostStatus((status) => {
    if (status === "connected" && autoStartWanted && snapshot.runtimeId === null && snapshot.cwd) {
      void ensureRuntime();
    }
  });

  if (autoStartWanted && snapshot.cwd) {
    void ensureRuntime();
  }

  return {
    key,
    sessionId,
    isolated: true,
    refCount: 0,
    activate(nextOptions) {
      if (disposed || nextOptions === undefined) return;
      if (!snapshot.cwd && nextOptions.cwd) {
        patch({ cwd: nextOptions.cwd });
      }
      if (snapshot.runtimeId === null && nextOptions.model) {
        pendingExplicitModel = nextOptions.model;
        patch({
          model: nextOptions.model,
          availableThinkingLevels: harnessRuntimes.thinkingLevels(nextOptions.model),
        });
      }
      if (nextOptions.autoStart === true) {
        autoStartWanted = true;
        if (snapshot.runtimeId === null && snapshot.cwd) {
          void ensureRuntime();
        }
      }
    },
    getSnapshot: () => snapshot,
    subscribe: (listener) => emitter.add(listener),

    async sendMessage(text, attachments = [], behavior) {
      if (!text.trim() && attachments.length === 0) return false;
      const runtimeId = await ensureRuntime();
      if (!runtimeId) return false;
      if (snapshot.model === null) {
        const latestModels =
          snapshot.availableModels.length > 0
            ? snapshot.availableModels
            : await harnessRuntimes.models().catch(() => [] as ModelInfo[]);
        const fallback = pickFallbackModel(null, latestModels);
        if (fallback !== null) {
          const confirmed = await harnessRuntimes
            .setModel(runtimeId, fallback.provider, fallback.id)
            .catch(() => fallback);
          patch({ model: confirmed, availableModels: latestModels });
        }
      }
      return dispatchIsolatedSessionPrompt({
        text,
        attachments,
        behavior,
        runtimeId,
        snapshot,
        patch,
        compact: () => this.compact(),
        onTurnStart: (ts) => {
          activeTurnStartedAt = ts;
        },
      });
    },

    async abort() {
      const runtimeId = snapshot.runtimeId;
      if (runtimeId) await harnessRuntimes.abort(runtimeId);
      activeTurnStartedAt = null;
      patch({
        isStreaming: false,
        isCompacting: false,
        retryStatus: null,
        messages: settleStoppedTurn([...snapshot.messages]),
      });
    },

    async editAndResend(entryId, text, attachments = []) {
      const runtimeId = snapshot.runtimeId;
      if (!runtimeId || snapshot.isStreaming) return false;
      const ok = await harnessRuntimes.rewind(runtimeId, entryId);
      if (!ok) return false;
      const refreshed = await harnessRuntimes.messages(runtimeId).catch(() => [...snapshot.messages]);
      patch({ messages: refreshed });
      return this.sendMessage(text, attachments);
    },

    async rewind(entryId, mode = "both") {
      const runtimeId = snapshot.runtimeId;
      if (!runtimeId || snapshot.isStreaming) return null;
      const result = await harnessRuntimes.executeRewind(runtimeId, entryId, mode);
      if (result.ok) {
        const refreshed = await harnessRuntimes.messages(runtimeId).catch(() => [...snapshot.messages]);
        patch({ messages: refreshed });
      }
      return result;
    },

    async fork(entryId) {
      const runtimeId = snapshot.runtimeId;
      if (!runtimeId) throw new Error("会话尚未启动");
      const targetEntryId = entryId ?? (await harnessRuntimes.forkPoints(runtimeId)).at(-1)?.entryId;
      if (!targetEntryId) throw new Error("当前会话没有可分叉的检查点");
      await harnessRuntimes.fork(runtimeId, targetEntryId);
      const refreshed = await harnessRuntimes.messages(runtimeId).catch(() => [...snapshot.messages]);
      patch({
        sessionFile: harnessRuntimes.sessionFileOf(runtimeId) ?? snapshot.sessionFile,
        messages: refreshed,
      });
    },

    async clone() {
      const runtimeId = snapshot.runtimeId;
      if (!runtimeId) throw new Error("会话尚未启动");
      await harnessRuntimes.clone(runtimeId);
      const refreshed = await harnessRuntimes.messages(runtimeId).catch(() => [...snapshot.messages]);
      patch({
        sessionFile: harnessRuntimes.sessionFileOf(runtimeId) ?? snapshot.sessionFile,
        messages: refreshed,
      });
    },

    async setModel(model) {
      pendingExplicitModel = model;
      patch({ model, availableThinkingLevels: harnessRuntimes.thinkingLevels(model) });
      const runtimeId = snapshot.runtimeId ?? (startPromise !== null ? await startPromise : null);
      if (runtimeId) {
        pendingExplicitModel = null;
        const confirmed = await harnessRuntimes.setModel(runtimeId, model.provider, model.id);
        patch({ model: confirmed, availableThinkingLevels: harnessRuntimes.thinkingLevels(confirmed) });
      }
    },

    async setThinkingLevel(level) {
      patch({ thinkingLevel: level });
      const runtimeId = snapshot.runtimeId;
      if (runtimeId) await harnessRuntimes.setThinkingLevel(runtimeId, level);
    },

    async setPermissionMode(mode) {
      patch({ permissionMode: mode });
      const runtimeId = snapshot.runtimeId;
      if (runtimeId) await harnessRuntimes.setPermission(runtimeId, { permission: mode });
    },

    async setAgentMode(mode) {
      patch({ agentMode: mode });
      const runtimeId = snapshot.runtimeId;
      if (runtimeId) await harnessRuntimes.setPermission(runtimeId, { agentMode: mode });
    },

    async compact() {
      const runtimeId = snapshot.runtimeId;
      if (!runtimeId) return;
      patch({ isCompacting: true });
      try {
        await harnessRuntimes.compact(runtimeId);
        const stats = await harnessRuntimes.stats(runtimeId).catch(() => snapshot.stats);
        patch({ stats });
      } finally {
        patch({ isCompacting: false });
      }
    },

    async exportMarkdown(destination) {
      const file = snapshot.sessionFile;
      if (!file) throw new Error("当前会话还没有可导出的文件");
      return agent.exportSessionMarkdown(file, destination);
    },

    dispose() {
      disposed = true;
      offHostStatus();
      offRuntime();
      emitter.clear();
      const runtimeId = snapshot.runtimeId;
      if (runtimeId !== null) {
        void harnessRuntimes.stop(runtimeId).catch(() => undefined);
      }
    },
  };
}

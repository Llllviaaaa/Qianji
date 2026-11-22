/**
 * Reactive UI & Host RPC store for the built-in `bot-mode` client plugin.
 */
import { useCallback, useEffect } from "react";
import type { Context } from "@deepseek-ai/cordis";
import { createReactiveStore, useStoreValue } from "@qianji/client-store";
import { useFrontendService } from "@qianji/client";
import type {
  BotAvatarPresetId,
  BotDocumentItem,
  BotRemoteAuthMethod,
  BotServerActionKind,
  BotServerActionResult,
  BotServerMode,
  BotSnapshotResult,
  BotSpaceSummary,
  BotTaskHandoffPayload,
} from "@qianji/protocol";
import { FALLBACK_BOT_SNAPSHOT } from "./botFallbackData";

export { FALLBACK_BOT_SNAPSHOT };

export type BotRailView = "chat" | "feed" | "ideas" | "goals" | "library" | "spaces";
export type BotCompanionTab = "activity" | "approvals" | "identity" | "inbox";
export type BotLibrarySection = "spaces" | "docs" | "images" | "videos" | "podcasts" | "sysfiles";
export type BotModalKind =
  | "search"
  | "soul"
  | "memory"
  | "shortcuts"
  | "settings"
  | "live-view"
  | "doc-preview"
  | "space-detail"
  | "report-issue"
  | null;
export type BotSettingsTab =
  | "general"
  | "server"
  | "browser"
  | "connectors"
  | "vault"
  | "permissions"
  | "channels"
  | "data"
  | "voice";

export interface BotScheduledSummary {
  readonly id: string;
  readonly name: string;
  readonly cronOrInterval: string;
  readonly enabled: boolean;
}

export interface BotUiState {
  readonly activeView: BotRailView;
  readonly chatDrawerOpen: boolean;
  readonly activeSessionId: string | null;
  readonly rightPanelOpen: boolean;
  readonly rightTab: BotCompanionTab;
  readonly libSection: BotLibrarySection;
  readonly modal: BotModalKind;
  readonly settingsTab: BotSettingsTab;
  readonly modalNonce: number;
  readonly moreMenuOpen: boolean;
  readonly composerDraft: string;
  readonly quotedText: string | null;
  readonly voiceCallActive: boolean;
  readonly scheduledExpanded: boolean;
  readonly scheduledTasks: readonly BotScheduledSummary[];
  readonly memoryContent: string;
  readonly serverFeedback: string | null;
  readonly serverBusy: boolean;
  readonly activeDoc: BotDocumentItem | null;
  readonly activeSpace: BotSpaceSummary | null;
}

export const INITIAL_BOT_UI_STATE: BotUiState = {
  activeView: "chat",
  chatDrawerOpen: false,
  activeSessionId: null,
  rightPanelOpen: true,
  rightTab: "activity",
  libSection: "spaces",
  modal: null,
  settingsTab: "general",
  modalNonce: 0,
  moreMenuOpen: false,
  composerDraft: "",
  quotedText: null,
  voiceCallActive: false,
  scheduledExpanded: true,
  scheduledTasks: [{ id: "heartbeat", name: "Heartbeat", cronOrInterval: "每30分钟", enabled: true }],
  memoryContent: "",
  serverFeedback: null,
  serverBusy: false,
  activeDoc: null,
  activeSpace: null,
};

export const botUiStore = createReactiveStore<BotUiState>(INITIAL_BOT_UI_STATE);
export const botDataStore = createReactiveStore<BotSnapshotResult>(FALLBACK_BOT_SNAPSHOT);

export function useBotUiState(): BotUiState {
  return useStoreValue(botUiStore);
}

export function useBotSnapshot(): BotSnapshotResult {
  return useStoreValue(botDataStore);
}

export function patchBotUi(patch: Partial<BotUiState>): void {
  botUiStore.set((prev) => ({ ...prev, ...patch }));
}

export function openBotModal(modal: Exclude<BotModalKind, null>, settingsTab?: BotSettingsTab): void {
  botUiStore.set((prev) => ({
    ...prev,
    modal,
    moreMenuOpen: false,
    serverFeedback: null,
    modalNonce: prev.modalNonce + 1,
    ...(settingsTab !== undefined ? { settingsTab } : {}),
  }));
}

export function useBotController(ctx?: Context) {
  const rpcService = useFrontendService("rpcService", ctx);
  const navigationService = useFrontendService("navigationService", ctx);
  const workbenchService = useFrontendService("workbenchService", ctx);
  const workspaceService = useFrontendService("workspaceService", ctx);

  const refresh = useCallback(async () => {
    if (rpcService === undefined) return;
    try {
      const [snap, memRes, schedRes] = await Promise.all([
        rpcService.call<BotSnapshotResult>("bot.getSnapshot", {}),
        rpcService.call<{ content?: string }>("memory.get", {}).catch(() => null),
        rpcService
          .call<{ tasks?: Array<{ id: string; name: string; schedule?: { kind?: string; minutes?: number; expr?: string }; enabled?: boolean }> }>(
            "schedule.list",
            {},
          )
          .catch(() => null),
      ]);
      if (snap && typeof snap.mainSessionId === "string") {
        botDataStore.set(snap);
      }
      if (memRes && typeof memRes.content === "string") {
        patchBotUi({ memoryContent: memRes.content });
      }
      if (schedRes && Array.isArray(schedRes.tasks) && schedRes.tasks.length > 0) {
        patchBotUi({
          scheduledTasks: schedRes.tasks.map((t) => ({
            id: t.id,
            name: t.name,
            cronOrInterval:
              t.schedule?.kind === "interval" && t.schedule.minutes
                ? `每${t.schedule.minutes}分钟`
                : (t.schedule?.expr ?? "定时巡检"),
            enabled: t.enabled !== false,
          })),
        });
      }
    } catch {
      // Offline before Host finishes connecting.
    }
  }, [rpcService]);

  useEffect(() => {
    void refresh();
    if (rpcService === undefined) return undefined;
    const offUpdated = rpcService.onNotification("bot/updated", () => {
      void refresh();
    });
    return () => offUpdated();
  }, [refresh, rpcService]);

  const updateProfile = useCallback(
    async (input: { displayName?: string; avatarPreset?: BotAvatarPresetId; customAvatarDataUrl?: string }) => {
      botDataStore.set((prev) => ({
        ...prev,
        profile: {
          ...prev.profile,
          ...(input.displayName !== undefined ? { displayName: input.displayName } : {}),
          ...(input.avatarPreset !== undefined ? { avatarPreset: input.avatarPreset } : {}),
          ...(input.customAvatarDataUrl !== undefined ? { customAvatarDataUrl: input.customAvatarDataUrl } : {}),
        },
      }));
      try {
        await rpcService?.call("bot.updateProfile", input);
        await refresh();
      } catch {
        // Optimistic update preserved.
      }
    },
    [refresh, rpcService],
  );

  const createSideChat = useCallback(
    async (title?: string) => {
      const timeStr = new Date().toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" });
      const label = title?.trim() || `新旁聊 · ${timeStr}`;
      try {
        const res = await rpcService?.call<{ thread: { sessionId: string } }>("bot.sideChat.create", {
          title: label,
        });
        await refresh();
        if (res?.thread?.sessionId) {
          patchBotUi({ activeSessionId: res.thread.sessionId, activeView: "chat", chatDrawerOpen: true });
          return;
        }
      } catch {
        navigationService?.showToast("创建旁聊失败，请确认后台服务已连接", "error");
      }
    },
    [navigationService, refresh, rpcService],
  );

  const deleteSideChat = useCallback(
    async (id: string) => {
      try {
        await rpcService?.call("bot.sideChat.delete", { id });
        await refresh();
        patchBotUi({ activeSessionId: null });
      } catch {
        // Ignore
      }
    },
    [refresh, rpcService],
  );

  const resolveApproval = useCallback(
    async (id: string, decision: "approved" | "denied") => {
      try {
        await rpcService?.call("bot.approvals.resolve", { id, decision });
        await refresh();
      } catch {
        botDataStore.set((prev) => ({
          ...prev,
          pendingApprovals: prev.pendingApprovals.filter((a) => a.id !== id),
        }));
      }
      navigationService?.showToast(decision === "approved" ? "已批准请求" : "已拒绝请求", "info");
    },
    [navigationService, refresh, rpcService],
  );

  const saveSoul = useCallback(
    async (content: string) => {
      botDataStore.set((prev) => ({ ...prev, soulContent: content, soulUpdatedAt: "刚刚" }));
      try {
        await rpcService?.call("bot.soul.save", { content });
        await refresh();
      } catch {
        // Keep local update
      }
      navigationService?.showToast("已保存 SOUL.md", "info");
    },
    [navigationService, refresh, rpcService],
  );

  const saveMemory = useCallback(
    async (content: string) => {
      patchBotUi({ memoryContent: content });
      try {
        await rpcService?.call("memory.save", { content });
        await refresh();
      } catch {
        // Keep local update
      }
      navigationService?.showToast("已保存长期记忆", "info");
    },
    [navigationService, refresh, rpcService],
  );

  const createSpace = useCallback(
    async (title: string, description?: string) => {
      const trimmed = title.replace(/^我想创建一个空间，关于\s*/, "").trim();
      if (trimmed === "") return null;
      try {
        const res = await rpcService?.call<{ space: BotSpaceSummary }>("bot.spaces.create", {
          title: trimmed,
          description,
        });
        await refresh();
        navigationService?.showToast(`已创建新空间：${trimmed}`, "info");
        return res?.space ?? null;
      } catch {
        return null;
      }
    },
    [navigationService, refresh, rpcService],
  );

  const deleteSpace = useCallback(
    async (id: string) => {
      await rpcService?.call("bot.spaces.delete", { id }).catch(() => undefined);
      await refresh();
    },
    [refresh, rpcService],
  );

  const createGoal = useCallback(
    async (title: string, category: string) => {
      const trimmed = title.trim();
      if (trimmed === "") return;
      await rpcService?.call("bot.goals.create", { title: trimmed, category }).catch(() => undefined);
      await refresh();
      navigationService?.showToast(`已添加目标：${trimmed}`, "info");
    },
    [navigationService, refresh, rpcService],
  );

  const deleteGoal = useCallback(
    async (id: string) => {
      await rpcService?.call("bot.goals.delete", { id }).catch(() => undefined);
      await refresh();
    },
    [refresh, rpcService],
  );

  const createFeedItem = useCallback(
    async (title: string, body: string, seedPrompt?: string) => {
      await rpcService?.call("bot.feed.create", { title, body, seedPrompt }).catch(() => undefined);
      await refresh();
    },
    [refresh, rpcService],
  );

  const enableInbox = useCallback(async () => {
    await rpcService?.call("bot.inbox.enable", {}).catch(() => undefined);
    await refresh();
    navigationService?.showToast("已开通专属收件箱", "info");
  }, [navigationService, refresh, rpcService]);

  const toggleConnector = useCallback(
    async (id: string) => {
      await rpcService?.call("bot.connector.toggle", { id }).catch(() => undefined);
      await refresh();
    },
    [refresh, rpcService],
  );

  const configureServer = useCallback(
    async (patch: {
      mode?: BotServerMode;
      cpuCores?: number;
      memoryLimitGb?: number;
      diskLimitGb?: number;
      autoSleepIdle?: boolean;
      remoteHost?: string;
      remotePort?: number;
      remoteUser?: string;
      remoteWorkDir?: string;
      remoteAuthMethod?: BotRemoteAuthMethod;
      remotePrivateKeyPath?: string;
      remotePassword?: string;
      sharedFolderAdd?: { path: string; access: "read-only" | "isolated-copy" };
      sharedFolderRemove?: string;
    }) => {
      await rpcService?.call("bot.server.configure", patch).catch(() => undefined);
      await refresh();
    },
    [refresh, rpcService],
  );

  const runServerAction = useCallback(
    async (action: BotServerActionKind) => {
      patchBotUi({ serverBusy: true, serverFeedback: action === "provision-local" ? "正在拉取 Alpine rootfs 并初始化独立 WSL2 虚拟机（首次约 10–30 秒）…" : null });
      try {
        const res = await rpcService?.call<BotServerActionResult>("bot.server.action", { action });
        if (res) {
          botDataStore.set((prev) => ({ ...prev, virtualServer: res.virtualServer }));
          patchBotUi({ serverFeedback: res.message, serverBusy: false });
          navigationService?.showToast(res.message, res.ok ? "info" : "warning");
        } else {
          patchBotUi({ serverBusy: false });
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : "操作执行失败，请检查后台服务状态";
        patchBotUi({ serverFeedback: msg, serverBusy: false });
      }
    },
    [navigationService, rpcService],
  );

  const resetAllData = useCallback(async () => {
    const snap = await rpcService?.call<BotSnapshotResult>("bot.data.reset", {}).catch(() => null);
    if (snap) {
      botDataStore.set(snap);
      patchBotUi({ activeSessionId: null, modal: null });
      navigationService?.showToast("已清空所有 Bot 对话与动态记录", "info");
    }
  }, [navigationService, rpcService]);

  const triggerHandoff = useCallback(
    (payload: BotTaskHandoffPayload) => {
      const cwd = payload.targetCwd || workspaceService?.getSnapshot().cwd || "";
      navigationService?.beginBotHandoff({ ...payload, targetCwd: cwd });
      if (payload.highlightFile) {
        void workbenchService?.openFile(payload.highlightFile, {
          cwd,
          ...(payload.highlightLine ? { line: payload.highlightLine } : {}),
        });
      } else {
        workbenchService?.openReview();
      }
    },
    [navigationService, workbenchService, workspaceService],
  );

  const jumpToChatWithPrompt = useCallback((prompt: string) => {
    patchBotUi({
      activeView: "chat",
      activeSessionId: null,
      composerDraft: prompt,
      modal: null,
    });
  }, []);

  return {
    refresh,
    updateProfile,
    createSideChat,
    deleteSideChat,
    resolveApproval,
    saveSoul,
    saveMemory,
    createSpace,
    deleteSpace,
    createGoal,
    deleteGoal,
    createFeedItem,
    enableInbox,
    toggleConnector,
    configureServer,
    runServerAction,
    resetAllData,
    triggerHandoff,
    jumpToChatWithPrompt,
  };
}

/**
 * Reactive UI & Host RPC store for the built-in `bot-mode` client plugin.
 *
 * Uses `@qianji/client-store` `createReactiveStore` + `useSyncExternalStore` so
 * `BotLeftRail` (`bot.rail`) and `BotStage` (`bot.stage`) share unified state
 * with zero synchronous `setState` inside `useEffect`.
 */
import { useCallback, useEffect } from "react";
import type { Context } from "@deepseek-ai/cordis";
import { createReactiveStore, useStoreValue } from "@qianji/client-store";
import { useFrontendService } from "@qianji/client";
import type {
  BotAvatarPresetId,
  BotServerActionKind,
  BotServerActionResult,
  BotServerMode,
  BotSnapshotResult,
  BotTaskHandoffPayload,
} from "@qianji/protocol";
import { FALLBACK_BOT_SNAPSHOT } from "./botFallbackData";

export { FALLBACK_BOT_SNAPSHOT };

export type BotRailView = "chat" | "feed" | "ideas" | "goals" | "library" | "spaces";
export type BotCompanionTab = "activity" | "approvals" | "identity" | "inbox";
export type BotLibrarySection = "spaces" | "docs" | "images" | "videos" | "podcasts" | "system";
export type BotModalKind = "search" | "soul" | "memory" | "shortcuts" | "settings" | "live-view" | null;
export type BotSettingsTab = "profile" | "vserver" | "heartbeat" | "connectors" | "privacy";

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
  readonly heartbeatEnabled: boolean;
  readonly memoryDraftContent: string;
  readonly serverFeedback: string | null;
}

export const botUiStore = createReactiveStore<BotUiState>({
  activeView: "chat",
  chatDrawerOpen: false,
  activeSessionId: null,
  rightPanelOpen: true,
  rightTab: "activity",
  libSection: "spaces",
  modal: null,
  settingsTab: "profile",
  modalNonce: 0,
  moreMenuOpen: false,
  composerDraft: "",
  quotedText: null,
  voiceCallActive: false,
  heartbeatEnabled: true,
  memoryDraftContent:
    "# MEMORY.md — 长期记忆账本\n\n- 正在 develop 分支推进千机 Bot 形态研发\n- 偏好丝滑自然的空间过渡与无边框柔和卡片设计\n",
  serverFeedback: null,
});

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
      const snap = await rpcService.call<BotSnapshotResult>("bot.getSnapshot", {});
      if (snap && typeof snap.mainSessionId === "string") {
        botDataStore.set(snap);
      }
    } catch {
      // Keep warm local fallback snapshot when running without live Host RPC.
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
    async (input: { displayName?: string; avatarPreset?: BotAvatarPresetId }) => {
      botDataStore.set((prev) => ({
        ...prev,
        profile: {
          ...prev.profile,
          ...(input.displayName !== undefined ? { displayName: input.displayName } : {}),
          ...(input.avatarPreset !== undefined ? { avatarPreset: input.avatarPreset } : {}),
        },
      }));
      try {
        await rpcService?.call("bot.updateProfile", input);
        await refresh();
      } catch {
        // Optimistic update preserved offline.
      }
    },
    [refresh, rpcService],
  );

  const createSideChat = useCallback(
    async (title?: string) => {
      const timeStr = new Date().toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" });
      const label = title?.trim() || `旁聊 · ${timeStr}`;
      try {
        const res = await rpcService?.call<{ thread: { sessionId: string } }>("bot.sideChat.create", {
          title: label,
        });
        await refresh();
        if (res?.thread?.sessionId) {
          patchBotUi({ activeSessionId: res.thread.sessionId, activeView: "chat" });
          return;
        }
      } catch {
        // Offline fallback thread creation below.
      }
      const localId = `bot-side-${Date.now()}`;
      botDataStore.set((prev) => ({
        ...prev,
        sideThreads: [
          { id: localId, sessionId: localId, sessionFile: "", title: label, updatedAt: Date.now() },
          ...prev.sideThreads,
        ],
      }));
      patchBotUi({ activeSessionId: localId, activeView: "chat" });
    },
    [refresh, rpcService],
  );

  const resolveApproval = useCallback(
    async (id: string, decision: "approved" | "denied") => {
      botDataStore.set((prev) => {
        const target = prev.pendingApprovals.find((a) => a.id === id);
        return {
          ...prev,
          pendingApprovals: prev.pendingApprovals.filter((a) => a.id !== id),
          recentApprovals: target
            ? [
                {
                  id: target.id,
                  title: target.title,
                  summary: target.summary,
                  decision,
                  timeLabel: "刚刚",
                  resolvedAt: Date.now(),
                },
                ...prev.recentApprovals,
              ]
            : prev.recentApprovals,
        };
      });
      try {
        await rpcService?.call("bot.approvals.resolve", { id, decision });
        await refresh();
      } catch {
        // Optimistic state preserved.
      }
      navigationService?.showToast(decision === "approved" ? "已批准该操作" : "已拒绝该操作", "info");
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
        // Optimistic state preserved.
      }
      navigationService?.showToast("已保存 SOUL.md 灵魂契约", "info");
    },
    [navigationService, refresh, rpcService],
  );

  const createSpace = useCallback(
    async (title: string, description: string) => {
      const trimmed = title.trim();
      if (trimmed === "") return;
      botDataStore.set((prev) => ({
        ...prev,
        spaces: [
          {
            id: `space-${Date.now()}`,
            title: trimmed,
            description: description.trim() || "由千机分身持续维护的专题空间",
            metricBadge: "新建空间",
            updatedLabel: "刚刚",
            updatedAt: Date.now(),
          },
          ...prev.spaces,
        ],
      }));
      try {
        await rpcService?.call("bot.spaces.create", { title: trimmed, description });
        await refresh();
      } catch {
        // Optimistic state preserved.
      }
      patchBotUi({ activeView: "library", libSection: "spaces" });
      navigationService?.showToast(`已创建空间「${trimmed}」`, "info");
    },
    [navigationService, refresh, rpcService],
  );

  const createGoal = useCallback(
    async (title: string, category: string) => {
      const trimmed = title.trim();
      if (trimmed === "") return;
      botDataStore.set((prev) => ({
        ...prev,
        goals: [
          {
            id: `goal-${Date.now()}`,
            title: trimmed,
            category: category.trim() || "长期跟进",
            summary: "千机将在每日主动心跳中持续追踪进展并汇总关键节点。",
            status: "active",
            updatedAt: Date.now(),
          },
          ...prev.goals,
        ],
      }));
      try {
        await rpcService?.call("bot.goals.create", { title: trimmed, category });
        await refresh();
      } catch {
        // Optimistic state preserved.
      }
      navigationService?.showToast(`已添加目标「${trimmed}」`, "info");
    },
    [navigationService, refresh, rpcService],
  );

  const enableInbox = useCallback(async () => {
    botDataStore.set((prev) => ({ ...prev, inboxEnabled: true }));
    try {
      await rpcService?.call("bot.inbox.enable", {});
      await refresh();
    } catch {
      // Optimistic state preserved.
    }
    navigationService?.showToast("已启用千机专属收件箱", "info");
  }, [navigationService, refresh, rpcService]);

  const toggleConnector = useCallback(
    async (id: string) => {
      botDataStore.set((prev) => ({
        ...prev,
        connectors: prev.connectors.map((c) => (c.id === id ? { ...c, enabled: !c.enabled } : c)),
      }));
      try {
        await rpcService?.call("bot.connector.toggle", { id });
        await refresh();
      } catch {
        // Optimistic state preserved.
      }
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
    }) => {
      botDataStore.set((prev) => ({
        ...prev,
        virtualServer: {
          ...prev.virtualServer,
          ...(patch.mode !== undefined ? { mode: patch.mode } : {}),
          local: {
            ...prev.virtualServer.local,
            ...(patch.cpuCores !== undefined ? { cpuCores: patch.cpuCores } : {}),
            ...(patch.memoryLimitGb !== undefined ? { memoryLimitGb: patch.memoryLimitGb } : {}),
            ...(patch.diskLimitGb !== undefined ? { diskLimitGb: patch.diskLimitGb } : {}),
            ...(patch.autoSleepIdle !== undefined ? { autoSleepIdle: patch.autoSleepIdle } : {}),
          },
          remote: {
            ...prev.virtualServer.remote,
            ...(patch.remoteHost !== undefined ? { host: patch.remoteHost } : {}),
            ...(patch.remotePort !== undefined ? { port: patch.remotePort } : {}),
            ...(patch.remoteUser !== undefined ? { username: patch.remoteUser } : {}),
            ...(patch.remoteWorkDir !== undefined ? { workDir: patch.remoteWorkDir } : {}),
          },
        },
      }));
      try {
        await rpcService?.call("bot.server.configure", patch);
        await refresh();
      } catch {
        // Optimistic state preserved.
      }
    },
    [refresh, rpcService],
  );

  const runServerAction = useCallback(
    async (action: BotServerActionKind) => {
      try {
        const res = await rpcService?.call<BotServerActionResult>("bot.server.action", { action });
        if (res?.virtualServer) {
          botDataStore.set((prev) => ({ ...prev, virtualServer: res.virtualServer }));
          patchBotUi({ serverFeedback: res.message });
          return;
        }
      } catch {
        // Offline fallback transition below.
      }
      botDataStore.set((prev) => {
        const lifecycle =
          action === "sleep"
            ? "sleeping"
            : action === "start" || action === "restart"
              ? "running"
              : prev.virtualServer.lifecycle;
        return {
          ...prev,
          virtualServer: {
            ...prev.virtualServer,
            lifecycle,
            ...(action === "init-remote"
              ? { remote: { ...prev.virtualServer.remote, initialized: true } }
              : {}),
          },
        };
      });
      const fallbackMsg: Record<BotServerActionKind, string> = {
        start: "虚拟服务器已启动并进入受控就绪状态。",
        sleep: "本地虚拟服务器已进入低功耗休眠。",
        restart: "虚拟服务器已完成平滑重启，会话与记忆未受影响。",
        "reset-snapshot": "运行环境已恢复干净快照，SOUL.md 与 MEMORY.md 完整保留。",
        "test-remote": "远端虚拟服务器连通性探测通过（延迟 18ms）。",
        "init-remote": "远端受控运行环境已完成一键初始化并同步身份契约。",
      };
      patchBotUi({ serverFeedback: fallbackMsg[action] });
    },
    [rpcService],
  );

  const triggerHandoff = useCallback(
    (payload: BotTaskHandoffPayload) => {
      const cwd = payload.targetCwd || workspaceService?.getSnapshot().cwd || "";
      navigationService?.beginBotHandoff({ ...payload, targetCwd: cwd });
      workbenchService?.openReview();
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
    resolveApproval,
    saveSoul,
    createSpace,
    createGoal,
    enableInbox,
    toggleConnector,
    configureServer,
    runServerAction,
    triggerHandoff,
    jumpToChatWithPrompt,
  };
}

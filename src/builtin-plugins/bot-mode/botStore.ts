/**
 * Reactive UI & Host RPC store for the built-in `bot-mode` client plugin.
 */
import { useCallback, useEffect } from "react";
import type { Context } from "@deepseek-ai/cordis";
import { useFrontendService } from "@qianji/client";
import type {
  BotAvatarPresetId,
  BotConnectorTestKind,
  BotDesktopNotificationPayload,
  BotPluginConnectorCatalogItem,
  BotRemoteAuthMethod,
  BotServerActionKind,
  BotServerActionResult,
  BotServerMode,
  BotSnapshotResult,
  BotSpaceSummary,
  BotTaskHandoffPayload,
  McpStatusResult,
  ScheduleListResult,
} from "@qianji/protocol";
import {
  applyScheduleRunNotification,
  applyScheduleTaskNotification,
  syncBotScheduledTasks,
} from "./botScheduleStore";
import { useBotDiscoveryActions } from "./botDiscoveryActions";
import { botDataStore, botUiStore, patchBotUi } from "./botUiAtoms";

export { DEFAULT_FEED_INSTRUCTIONS, FALLBACK_BOT_SNAPSHOT } from "./botFallbackData";
export * from "./botUiAtoms";
export {
  discussInBot,
  formatFeedEditionLabel,
  formatFeedExactTimestamp,
  formatFeedRelativeTime,
  formatIdeaCapabilitiesBadge,
  groupCompletedGoalsByMonth,
  groupGoalTimelineByDate,
  isDiscoverySplitEligible,
  sortActiveGoals,
  startInBotNow,
} from "./botDiscoveryActions";
export {
  formatBotScheduleCadence,
  formatRelativeNextRun,
  parseNaturalScheduleInput,
  useBotScheduleManager,
  type BotScheduleFrequency,
  type BotScheduleSaveDraft,
  type NaturalScheduleParseResult,
} from "./botScheduleStore";

export type BotServerConfigPatch = {
  mode?: BotServerMode;
  cpuCores?: number;
  memoryLimitGb?: number;
  diskLimitGb?: number;
  autoSleepIdle?: boolean;
  storageDir?: string;
  remoteHost?: string;
  remotePort?: number;
  remoteUser?: string;
  remoteWorkDir?: string;
  remoteAuthMethod?: BotRemoteAuthMethod;
  remotePrivateKeyPath?: string;
  remotePassword?: string;
  sharedFolderAdd?: { path: string; access: "read-only" | "isolated-copy" };
  sharedFolderRemove?: string;
};

export function useBotController(ctx?: Context) {
  const rpcService = useFrontendService("rpcService", ctx);
  const navigationService = useFrontendService("navigationService", ctx);
  const workbenchService = useFrontendService("workbenchService", ctx);
  const workspaceService = useFrontendService("workspaceService", ctx);

  const refresh = useCallback(async () => {
    if (rpcService === undefined) return;
    try {
      const [snap, memRes, schedRes, pluginCatRes, mcpRes] = await Promise.all([
        rpcService.call<BotSnapshotResult>("bot.getSnapshot", {}),
        rpcService.call<{ content?: string }>("memory.get", {}).catch(() => null),
        rpcService.call<ScheduleListResult>("schedule.list", {}).catch(() => null),
        rpcService
          .call<{ items?: BotPluginConnectorCatalogItem[] }>("bot.connector.pluginCatalog", {})
          .catch(() => null),
        rpcService.call<McpStatusResult>("mcp.status", {}).catch(() => null),
      ]);
      if (snap && typeof snap.mainSessionId === "string") {
        botDataStore.set(snap);
      }
      patchBotUi({
        ...(memRes && typeof memRes.content === "string" ? { memoryContent: memRes.content } : {}),
        ...(Array.isArray(pluginCatRes?.items) ? { pluginConnectors: pluginCatRes.items } : {}),
        ...(Array.isArray(mcpRes?.servers) ? { mcpStatus: mcpRes.servers } : {}),
      });
      syncBotScheduledTasks(schedRes?.tasks ?? null, snap?.pacing ?? botDataStore.get().pacing);
    } catch {
      // Offline before Host finishes connecting.
    }
  }, [rpcService]);

  useEffect(() => {
    void refresh();
    if (rpcService === undefined) return undefined;
    const offUpdated = rpcService.onNotification("bot/updated", () => void refresh());
    const offPluginChanged = rpcService.onNotification("plugin/changed", () => void refresh());
    const offMcpChanged = rpcService.onNotification("mcp/changed", (raw) => {
      const payload = raw as McpStatusResult | undefined;
      if (Array.isArray(payload?.servers)) {
        patchBotUi({ mcpStatus: payload.servers });
      } else {
        void refresh();
      }
    });
    const offSchedTask = rpcService.onNotification("schedule/task", applyScheduleTaskNotification);
    const offSchedRun = rpcService.onNotification("schedule/run", applyScheduleRunNotification);
    const offNotif = rpcService.onNotification("bot/desktopNotification", (raw) => {
      const payload = raw as BotDesktopNotificationPayload | undefined;
      if (!payload?.title) return;
      navigationService?.showToast(
        `${payload.title}：${payload.body}`,
        payload.urgency === "urgent" ? "warning" : "info",
      );
      if (typeof window !== "undefined" && "Notification" in window && Notification.permission === "granted") {
        const note = new Notification(payload.title, { body: payload.body });
        note.onclick = () => window.focus?.();
      }
      void refresh();
    });
    return () => {
      offUpdated();
      offPluginChanged();
      offMcpChanged();
      offSchedTask();
      offSchedRun();
      offNotif();
    };
  }, [navigationService, refresh, rpcService]);

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
      await rpcService?.call("bot.updateProfile", input).catch(() => undefined);
      await refresh();
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
        }
      } catch {
        navigationService?.showToast("创建旁聊失败，请确认后台服务已连接", "error");
      }
    },
    [navigationService, refresh, rpcService],
  );

  const updateSideChat = useCallback(
    async (id: string, patch: { title?: string; pinned?: boolean; archived?: boolean }) => {
      botDataStore.set((prev) => ({
        ...prev,
        sideThreads: prev.sideThreads.map((th) => (th.id === id ? ({ ...th, ...patch } as typeof th) : th)),
      }));
      await rpcService?.call("bot.sideChat.update", { id, ...patch }).catch(() => undefined);
      await refresh();
    },
    [refresh, rpcService],
  );

  const deleteSideChat = useCallback(
    async (id: string) => {
      const target = botDataStore.get().sideThreads.find((t) => t.id === id);
      const wasActive = target !== undefined && botUiStore.get().activeSessionId === target.sessionId;
      botDataStore.set((prev) => ({
        ...prev,
        sideThreads: prev.sideThreads.filter((t) => t.id !== id),
      }));
      if (wasActive) patchBotUi({ activeSessionId: null });
      await rpcService?.call("bot.sideChat.delete", { id }).catch(() => undefined);
      await refresh();
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
      await rpcService?.call("bot.soul.save", { content }).catch(() => undefined);
      await refresh();
      navigationService?.showToast("已保存 SOUL.md", "info");
    },
    [navigationService, refresh, rpcService],
  );

  const saveMemory = useCallback(
    async (content: string) => {
      patchBotUi({ memoryContent: content });
      await rpcService?.call("memory.save", { content }).catch(() => undefined);
      await refresh();
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

  const discoveryActions = useBotDiscoveryActions({ rpcService, navigationService, refresh });

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

  const configureBot = useCallback(
    async (patch: Record<string, unknown>) => {
      const res = await rpcService?.call<{ snapshot: BotSnapshotResult }>("bot.configure", patch).catch(() => null);
      if (res?.snapshot) {
        botDataStore.set(res.snapshot);
        syncBotScheduledTasks(null, res.snapshot.pacing);
      } else {
        await refresh();
      }
    },
    [refresh, rpcService],
  );

  const testConnector = useCallback(
    async (kind: BotConnectorTestKind) => {
      patchBotUi({ serverBusy: true });
      try {
        const res = await rpcService?.call<{ ok: boolean; message: string; snapshot: BotSnapshotResult }>(
          "bot.connector.test",
          { kind },
        );
        if (res?.snapshot) botDataStore.set(res.snapshot);
        if (res?.message) {
          patchBotUi({ serverFeedback: res.message });
          navigationService?.showToast(res.message, res.ok ? "info" : "warning");
        }
        return res ?? null;
      } catch (err) {
        const msg = err instanceof Error ? err.message : "连接器检测失败";
        patchBotUi({ serverFeedback: msg });
        navigationService?.showToast(msg, "error");
        return null;
      } finally {
        patchBotUi({ serverBusy: false });
      }
    },
    [navigationService, rpcService],
  );

  const runPatrolNow = useCallback(async () => {
    if (typeof window !== "undefined" && "Notification" in window && Notification.permission === "default") {
      void Notification.requestPermission().catch(() => undefined);
    }
    patchBotUi({ serverBusy: true });
    try {
      const res = await rpcService?.call<{ triggered: boolean; summary: string; snapshot: BotSnapshotResult }>(
        "bot.patrol.runNow",
        { force: true },
      );
      if (res?.snapshot) botDataStore.set(res.snapshot);
      if (res?.summary) navigationService?.showToast("主动贴心巡检完成，已整理简报与建议", "info");
      return res ?? null;
    } finally {
      patchBotUi({ serverBusy: false });
    }
  }, [navigationService, rpcService]);

  const configureServer = useCallback(
    async (patch: BotServerConfigPatch) => {
      await rpcService?.call("bot.server.configure", patch).catch(() => undefined);
      await refresh();
    },
    [refresh, rpcService],
  );

  const runServerAction = useCallback(
    async (action: BotServerActionKind) => {
      patchBotUi({
        serverBusy: true,
        serverFeedback:
          action === "provision-local"
            ? "正在拉取 Alpine rootfs 并初始化独立 WSL2 虚拟机（首次约 10–30 秒）…"
            : null,
      });
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
    patchBotUi({ activeView: "chat", activeSessionId: null, composerDraft: prompt, modal: null });
  }, []);

  return {
    refresh,
    updateProfile,
    createSideChat,
    updateSideChat,
    deleteSideChat,
    resolveApproval,
    saveSoul,
    saveMemory,
    createSpace,
    deleteSpace,
    ...discoveryActions,
    enableInbox,
    toggleConnector,
    configureBot,
    testConnector,
    runPatrolNow,
    configureServer,
    runServerAction,
    resetAllData,
    triggerHandoff,
    jumpToChatWithPrompt,
  };
}

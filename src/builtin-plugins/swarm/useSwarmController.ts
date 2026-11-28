/**
 * Typed JSON-RPC action controller for the built-in `swarm` feature plugin
 * (`src/builtin-plugins/swarm/useSwarmController.ts`).
 */
import { useCallback, useEffect, useMemo } from "react";
import type { Context } from "@deepseek-ai/cordis";
import { useFrontendService, useSessionState, useWorkspaceState } from "@qianji/client";
import {
  SWARM_RPC_METHODS,
  type SwarmBoardPostResult, type SwarmBoardReadResult, type SwarmConfigGetResult,
  type SwarmConfigUpdateParams, type SwarmConfigUpdateResult, type SwarmCreateParams,
  type SwarmCreateResult, type SwarmGetResult, type SwarmListResult,
  type SwarmMemberControlAction, type SwarmMemberControlParams, type SwarmMemberControlResult,
  type SwarmRunControlAction, type SwarmRunControlResult, type SwarmTasksMutateParams,
  type SwarmTasksMutateResult, type SwarmWorktreeDiffResult,
} from "@qianji/protocol";
import {
  applySwarmBoardReadResult, applySwarmConfigPayload, applySwarmListResult,
  applySwarmSnapshot, applyWorktreeDiff, findSwarmSummaryForSession,
  patchSwarmUi, swarmDataStore, swarmUiStore,
} from "./swarmStore";

function notifyToast(
  nav: { showToast(message: string, kind?: "info" | "warning" | "error"): void } | undefined,
  message: string,
  kind: "info" | "warning" | "error" = "info",
): void {
  if (typeof window !== "undefined") nav?.showToast(message, kind);
}

export async function syncSwarmsFromRpc(
  ctx: Context | undefined,
  options?: { readonly cwd?: string; readonly sessionId?: string | null; readonly targetSwarmId?: string },
): Promise<void> {
  const rpc = ctx?.rpcService;
  if (rpc === undefined) return;
  const cwd = options?.cwd ?? ctx?.workspaceService?.getSnapshot().cwd ?? "";
  const sessionId = options?.sessionId ?? ctx?.sessionService?.getSnapshot().sessionId ?? undefined;

  try {
    const listRes = await rpc.call<SwarmListResult>(SWARM_RPC_METHODS.list, {
      ...(cwd !== "" ? { cwd } : {}),
      includeStopped: true,
    });
    const swarms = Array.isArray(listRes?.swarms) ? listRes.swarms : [];
    applySwarmListResult(swarms, sessionId, cwd);

    const bound = findSwarmSummaryForSession(swarms, sessionId);
    const activeId = options?.targetSwarmId ?? bound?.run.id ?? swarmUiStore.get().activeSwarmId;
    if (activeId !== null && activeId !== undefined) {
      const snap = await rpc.call<SwarmGetResult>(SWARM_RPC_METHODS.get, { swarmId: activeId }).catch(() => null);
      if (snap && snap.run && typeof snap.run.id === "string") applySwarmSnapshot(snap);
    }

    const cfg = await rpc
      .call<SwarmConfigGetResult>(SWARM_RPC_METHODS.configGet, activeId ? { swarmId: activeId } : {})
      .catch(() => null);
    if (cfg && cfg.globalConfig) {
      applySwarmConfigPayload({
        globalConfig: cfg.globalConfig,
        ...(activeId ? { swarmId: activeId, sessionOverrides: cfg.sessionOverrides ?? {} } : {}),
        ...(Array.isArray(cfg.availableModels) ? { availableModels: cfg.availableModels } : {}),
      });
    }
  } catch {
    // Ignore transient offline errors before Host finishes connecting.
  }
}

export function useSwarmController(ctx?: Context) {
  const rpcService = useFrontendService("rpcService", ctx);
  const navigationService = useFrontendService("navigationService", ctx);
  const sessionSnap = useSessionState(ctx);
  const workspaceSnap = useWorkspaceState(ctx);

  const cwd = workspaceSnap?.cwd ?? sessionSnap?.cwd ?? "";
  const sessionId = sessionSnap?.sessionId ?? null;

  const refresh = useCallback(
    async (targetSwarmId?: string) => {
      if (rpcService === undefined) return;
      try {
        const listRes = await rpcService.call<SwarmListResult>(SWARM_RPC_METHODS.list, {
          ...(cwd !== "" ? { cwd } : {}),
          includeStopped: true,
        });
        const swarms = Array.isArray(listRes?.swarms) ? listRes.swarms : [];
        applySwarmListResult(swarms, sessionId, cwd);
        const bound = findSwarmSummaryForSession(swarms, sessionId);
        const chosenId = targetSwarmId ?? bound?.run.id ?? swarmUiStore.get().activeSwarmId;
        if (chosenId !== null && chosenId !== undefined) {
          const snap = await rpcService.call<SwarmGetResult>(SWARM_RPC_METHODS.get, { swarmId: chosenId }).catch(() => null);
          if (snap && snap.run && typeof snap.run.id === "string") applySwarmSnapshot(snap);
        }
      } catch {
        // Offline / pre-connect fallback.
      }
    },
    [cwd, rpcService, sessionId],
  );

  useEffect(() => {
    if (rpcService === undefined) return undefined;
    if (swarmDataStore.get().summaries.length === 0) void refresh();
    return undefined;
  }, [refresh, rpcService]);

  const loadConfig = useCallback(
    async (swarmId?: string | null): Promise<SwarmConfigGetResult | null> => {
      if (rpcService === undefined) return null;
      try {
        const res = await rpcService.call<SwarmConfigGetResult>(SWARM_RPC_METHODS.configGet, swarmId ? { swarmId } : {});
        if (res && res.globalConfig) {
          applySwarmConfigPayload({
            globalConfig: res.globalConfig,
            ...(swarmId ? { swarmId, sessionOverrides: res.sessionOverrides ?? {} } : {}),
            ...(Array.isArray(res.availableModels) ? { availableModels: res.availableModels } : {}),
          });
          return res;
        }
        return null;
      } catch {
        return null;
      }
    },
    [rpcService],
  );

  const updateConfig = useCallback(
    async (params: SwarmConfigUpdateParams): Promise<SwarmConfigUpdateResult | null> => {
      if (rpcService === undefined) return null;
      patchSwarmUi({ busyAction: "config:update" });
      try {
        const res = await rpcService.call<SwarmConfigUpdateResult>(SWARM_RPC_METHODS.configUpdate, {
          ...(params.globalConfig !== undefined ? { globalConfig: params.globalConfig } : {}),
          ...(params.swarmId !== undefined ? { swarmId: params.swarmId } : {}),
          ...(params.sessionOverrides !== undefined ? { sessionOverrides: params.sessionOverrides } : {}),
          ...(params.applyToWaitingMembers !== undefined ? { applyToWaitingMembers: params.applyToWaitingMembers } : {}),
        });
        if (res && res.globalConfig) {
          const shouldSyncOverrides =
            params.swarmId !== undefined &&
            params.swarmId !== "" &&
            (params.sessionOverrides !== undefined || res.sessionOverrides !== undefined || res.snapshot !== undefined);
          applySwarmConfigPayload({
            globalConfig: res.globalConfig,
            ...(shouldSyncOverrides
              ? {
                  swarmId: params.swarmId,
                  sessionOverrides: res.sessionOverrides ?? res.snapshot?.run.roleModels ?? {},
                }
              : {}),
            ...(res.snapshot !== undefined ? { snapshot: res.snapshot } : {}),
          });
          notifyToast(navigationService, "已保存蜂群角色模型配置", "info");
          return res;
        }
        return null;
      } catch (err) {
        notifyToast(navigationService, err instanceof Error ? err.message : "保存蜂群模型配置失败", "error");
        return null;
      } finally {
        patchSwarmUi({ busyAction: null });
      }
    },
    [navigationService, rpcService],
  );

  const selectSwarm = useCallback(
    async (swarmId: string) => {
      patchSwarmUi({ activeSwarmId: swarmId, selectedMemberName: null, activeChannel: "main" });
      if (rpcService === undefined) return;
      try {
        const snap = await rpcService.call<SwarmGetResult>(SWARM_RPC_METHODS.get, { swarmId });
        if (snap && snap.run) applySwarmSnapshot(snap);
      } catch (err) {
        notifyToast(navigationService, err instanceof Error ? err.message : "加载蜂群详情失败", "error");
      }
    },
    [navigationService, rpcService],
  );

  const createSwarm = useCallback(
    async (input: SwarmCreateParams): Promise<SwarmCreateResult | null> => {
      if (rpcService === undefined) return null;
      const goal = input.goal.trim();
      if (goal === "") {
        notifyToast(navigationService, "请输入蜂群任务目标", "warning");
        return null;
      }
      patchSwarmUi({ busyAction: "create" });
      try {
        const res = await rpcService.call<SwarmCreateResult>(SWARM_RPC_METHODS.create, {
          goal,
          ...(input.title !== undefined && input.title.trim() !== "" ? { title: input.title.trim() } : {}),
          cwd: input.cwd ?? cwd,
          ...(input.coordinatorSessionId !== undefined
            ? { coordinatorSessionId: input.coordinatorSessionId }
            : sessionId !== null
              ? { coordinatorSessionId: sessionId }
              : {}),
          ...(input.stallTimeoutMs !== undefined ? { stallTimeoutMs: input.stallTimeoutMs } : {}),
          ...(input.roleModels !== undefined ? { roleModels: input.roleModels } : {}),
        });
        if (res && res.run) {
          applySwarmSnapshot(res);
          patchSwarmUi({ activeSwarmId: res.run.id, selectedMemberName: null });
          notifyToast(navigationService, `已启动蜂群：${res.run.title}`, "info");
          return res;
        }
        return null;
      } catch (err) {
        notifyToast(navigationService, err instanceof Error ? err.message : "创建蜂群失败", "error");
        return null;
      } finally {
        patchSwarmUi({ busyAction: null });
      }
    },
    [cwd, navigationService, rpcService, sessionId],
  );

  const controlRun = useCallback(
    async (
      swarmId: string,
      action: SwarmRunControlAction,
      extra?: { readonly title?: string; readonly alertId?: string; readonly forceStopUnmerged?: boolean },
    ): Promise<SwarmRunControlResult | null> => {
      if (rpcService === undefined) return null;
      patchSwarmUi({ busyAction: `run:${action}` });
      try {
        const res = await rpcService.call<SwarmRunControlResult>(SWARM_RPC_METHODS.runControl, {
          swarmId,
          action,
          ...(extra?.title !== undefined ? { title: extra.title } : {}),
          ...(extra?.alertId !== undefined ? { alertId: extra.alertId } : {}),
          ...(extra?.forceStopUnmerged !== undefined ? { forceStopUnmerged: extra.forceStopUnmerged } : {}),
        });
        const existing = swarmDataStore.get().snapshotsById[swarmId];
        if (res && res.run && existing !== undefined) {
          applySwarmSnapshot({ ...existing, run: res.run, alerts: Array.isArray(res.alerts) ? res.alerts : existing.alerts });
        } else {
          await refresh(swarmId);
        }
        if (action === "pause") notifyToast(navigationService, "已暂停蜂群调度", "info");
        if (action === "resume") notifyToast(navigationService, "已恢复蜂群执行", "info");
        if (action === "stop") notifyToast(navigationService, "已停止蜂群", "info");
        return res ?? null;
      } catch (err) {
        notifyToast(navigationService, err instanceof Error ? err.message : "蜂群控制操作失败", "error");
        return null;
      } finally {
        patchSwarmUi({ busyAction: null });
      }
    },
    [navigationService, refresh, rpcService],
  );

  const postBoardMessage = useCallback(
    async (
      swarmId: string,
      text: string,
      options?: { readonly channel?: string; readonly replyToSeq?: number; readonly sender?: string },
    ): Promise<SwarmBoardPostResult | null> => {
      const trimmed = text.trim();
      if (trimmed === "" || rpcService === undefined) return null;
      patchSwarmUi({ busyAction: "board:post" });
      try {
        const channel = options?.channel ?? swarmUiStore.get().activeChannel;
        const res = await rpcService.call<SwarmBoardPostResult>(SWARM_RPC_METHODS.boardPost, {
          swarmId,
          text: trimmed,
          channel,
          sender: options?.sender ?? "user",
          ...(options?.replyToSeq !== undefined ? { replyToSeq: options.replyToSeq } : {}),
        });
        if (res && res.message) {
          applySwarmBoardReadResult(swarmId, res.message.channel || channel, [res.message]);
          if (res.wokenMembers.length > 0) {
            notifyToast(navigationService, `已发送并唤醒：${res.wokenMembers.map((n) => `@${n}`).join(" ")}`, "info");
          }
        }
        return res ?? null;
      } catch (err) {
        notifyToast(navigationService, err instanceof Error ? err.message : "消息发送失败", "error");
        return null;
      } finally {
        patchSwarmUi({ busyAction: null });
      }
    },
    [navigationService, rpcService],
  );

  const loadBoardChannel = useCallback(
    async (swarmId: string, channel: string) => {
      patchSwarmUi({ activeChannel: channel });
      if (rpcService === undefined) return;
      try {
        const res = await rpcService.call<SwarmBoardReadResult>(SWARM_RPC_METHODS.boardRead, { swarmId, channel, limit: 120 });
        if (res && Array.isArray(res.messages)) applySwarmBoardReadResult(swarmId, channel, res.messages);
      } catch {
        // Keep cached channel messages.
      }
    },
    [rpcService],
  );

  const mutateTask = useCallback(
    async (swarmId: string, params: Omit<SwarmTasksMutateParams, "swarmId">): Promise<SwarmTasksMutateResult | null> => {
      if (rpcService === undefined) return null;
      patchSwarmUi({ busyAction: `task:${params.action}` });
      try {
        const res = await rpcService.call<SwarmTasksMutateResult>(SWARM_RPC_METHODS.tasksMutate, { swarmId, ...params });
        const existing = swarmDataStore.get().snapshotsById[swarmId];
        if (res && Array.isArray(res.tasks) && existing !== undefined) {
          applySwarmSnapshot({ ...existing, tasks: res.tasks });
        } else {
          await refresh(swarmId);
        }
        return res ?? null;
      } catch (err) {
        notifyToast(navigationService, err instanceof Error ? err.message : "更新任务失败", "error");
        return null;
      } finally {
        patchSwarmUi({ busyAction: null });
      }
    },
    [navigationService, refresh, rpcService],
  );

  const controlMember = useCallback(
    async (
      swarmId: string,
      name: string,
      action: SwarmMemberControlAction,
      extra?: Omit<SwarmMemberControlParams, "swarmId" | "name" | "action">,
    ): Promise<SwarmMemberControlResult | null> => {
      if (rpcService === undefined) return null;
      patchSwarmUi({ busyAction: `member:${name}:${action}` });
      try {
        const res = await rpcService.call<SwarmMemberControlResult>(SWARM_RPC_METHODS.memberControl, { swarmId, name, action, ...extra });
        if (res?.message) {
          notifyToast(navigationService, res.message, res.ok ? "info" : "warning");
        } else if (res?.ok) {
          const toastCopy =
            action === "switchModel" ? `已为 @${name} 原地切换模型`
            : action === "mergeWorktree" ? `已合并 @${name} 的代码变更`
            : action === "kill" ? `已退役成员 @${name}`
            : action === "abort" ? `已中断 @${name} 当前回合`
            : `已唤醒 @${name}`;
          notifyToast(navigationService, toastCopy, "info");
        }
        await refresh(swarmId);
        return res ?? null;
      } catch (err) {
        notifyToast(navigationService, err instanceof Error ? err.message : "成员控制操作失败", "error");
        return null;
      } finally {
        patchSwarmUi({ busyAction: null });
      }
    },
    [navigationService, refresh, rpcService],
  );

  const loadWorktreeDiff = useCallback(
    async (swarmId: string, name: string): Promise<SwarmWorktreeDiffResult | null> => {
      if (rpcService === undefined) return null;
      patchSwarmUi({ busyAction: `diff:${name}` });
      try {
        const diff = await rpcService.call<SwarmWorktreeDiffResult>(SWARM_RPC_METHODS.worktreeDiff, { swarmId, name });
        if (diff && typeof diff.swarmId === "string") {
          applyWorktreeDiff(diff);
          return diff;
        }
        return null;
      } catch (err) {
        notifyToast(navigationService, err instanceof Error ? err.message : "读取代码变更失败", "error");
        return null;
      } finally {
        patchSwarmUi({ busyAction: null });
      }
    },
    [navigationService, rpcService],
  );

  return useMemo(
    () => ({
      refresh, loadConfig, updateConfig, selectSwarm, createSwarm,
      controlRun, postBoardMessage, loadBoardChannel, mutateTask, controlMember, loadWorktreeDiff,
    }),
    [controlMember, controlRun, createSwarm, loadBoardChannel, loadConfig, loadWorktreeDiff, mutateTask, postBoardMessage, refresh, selectSwarm, updateConfig],
  );
}

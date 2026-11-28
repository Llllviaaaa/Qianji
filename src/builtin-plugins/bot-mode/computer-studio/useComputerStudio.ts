/**
 * Reactive controller hook & notification bridge for 「千机的电脑」 Studio (`bot.computer.*`).
 */
import { useCallback, useEffect } from "react";
import type { Context } from "@deepseek-ai/cordis";
import { useFrontendService } from "@qianji/client";
import type {
  BotComputerEngineActionParams,
  BotComputerEngineActionResult,
  BotComputerEngineId,
  BotComputerEventNotification,
  BotComputerFilesListResult,
  BotComputerFilesReadResult,
  BotComputerInputEvent,
  BotComputerPtySessionInfo,
  BotComputerRemoteNodeUpsertParams,
  BotComputerSelectParams,
  BotComputerStreamFrame,
  BotComputerStudioSnapshot,
  BotComputerTakeoverActionParams,
  BotComputerTakeoverState,
  BotRemoteComputerNode,
} from "@qianji/protocol";
import { botDataStore } from "../botUiAtoms";
import {
  applyComputerEventNotification,
  applyComputerStudioSnapshot,
  computerStudioSnapshotStore,
  computerStudioUiStore,
  patchComputerStudioUi,
  setComputerScrubIndex,
  syncComputerStudioFromBotSnapshot,
  useComputerStudioSnapshot,
  useComputerStudioUi,
} from "./computerStudioStore";

function syncPtyInfoToStores(pty: BotComputerPtySessionInfo): void {
  computerStudioSnapshotStore.set((prev) => ({ ...prev, pty }));
  if (pty.outputTail !== "") {
    computerStudioUiStore.set((prev) => ({
      ...prev,
      ptyBufferByEngine: { ...prev.ptyBufferByEngine, [pty.engine]: pty.outputTail },
    }));
  }
}

export function useComputerStudioRuntimeSync(ctx?: Context): void {
  const rpcService = useFrontendService("rpcService", ctx);
  const studioUi = useComputerStudioUi();
  const studioSnap = useComputerStudioSnapshot();

  useEffect(() => {
    syncComputerStudioFromBotSnapshot(botDataStore.get());
    if (rpcService === undefined) return undefined;

    void rpcService
      .call<BotComputerStudioSnapshot>("bot.computer.getSnapshot", { includeFrame: true })
      .then((res) => {
        if (res && typeof res.activeEngine === "string") applyComputerStudioSnapshot(res);
      })
      .catch(() => undefined);

    const offComputer = rpcService.onNotification("bot/computer", (raw) => {
      applyComputerEventNotification(raw as BotComputerEventNotification);
    });
    return () => offComputer();
  }, [rpcService]);

  const shouldStream =
    studioUi.studioOpen &&
    studioUi.scrubIndex === null &&
    (studioSnap.activeTab === "desktop" || studioSnap.activeTab === "browser");

  useEffect(() => {
    if (rpcService === undefined || !shouldStream) return undefined;
    const tab = studioSnap.activeTab === "desktop" ? "desktop" : "browser";
    const engine = studioSnap.activeEngine;
    void rpcService.call("bot.computer.stream", { active: true, engine, tab, fps: 2 }).catch(() => undefined);
    return () => {
      void rpcService.call("bot.computer.stream", { active: false, engine, tab }).catch(() => undefined);
    };
  }, [rpcService, shouldStream, studioSnap.activeEngine, studioSnap.activeTab]);
}

export function useComputerStudio(ctx?: Context) {
  const rpcService = useFrontendService("rpcService", ctx);
  const navigationService = useFrontendService("navigationService", ctx);
  const snapshot = useComputerStudioSnapshot();
  const ui = useComputerStudioUi();

  const refreshSnapshot = useCallback(
    async (includeFrame = true) => {
      if (rpcService === undefined) return computerStudioSnapshotStore.get();
      try {
        const res = await rpcService.call<BotComputerStudioSnapshot>("bot.computer.getSnapshot", { includeFrame });
        if (res && typeof res.activeEngine === "string") {
          applyComputerStudioSnapshot(res);
          return res;
        }
      } catch {
        // Ignore offline error.
      }
      return computerStudioSnapshotStore.get();
    },
    [rpcService],
  );

  const selectStudio = useCallback(
    async (params: BotComputerSelectParams) => {
      computerStudioSnapshotStore.set((prev) => ({
        ...prev,
        ...(params.engine !== undefined ? { activeEngine: params.engine } : {}),
        ...(params.tab !== undefined ? { activeTab: params.tab } : {}),
        ...(params.autoFollow !== undefined ? { autoFollow: params.autoFollow } : {}),
        ...(params.activeRemoteNodeId !== undefined ? { activeRemoteNodeId: params.activeRemoteNodeId } : {}),
      }));
      if (params.autoFollow === true) setComputerScrubIndex(null);
      if (rpcService === undefined) return;
      try {
        const res = await rpcService.call<BotComputerStudioSnapshot>("bot.computer.select", { ...params });
        if (res && typeof res.activeEngine === "string") applyComputerStudioSnapshot(res);
      } catch {
        // Optimistic update already applied.
      }
    },
    [rpcService],
  );

  const runEngineAction = useCallback(
    async (params: BotComputerEngineActionParams): Promise<BotComputerEngineActionResult | null> => {
      patchComputerStudioUi({ busyAction: params.action, feedbackMessage: null });
      try {
        const res = await rpcService?.call<BotComputerEngineActionResult>("bot.computer.action", { ...params });
        if (res?.snapshot) applyComputerStudioSnapshot(res.snapshot);
        if (res?.message) {
          patchComputerStudioUi({ feedbackMessage: res.message });
          navigationService?.showToast(res.message, res.ok ? "info" : "warning");
        }
        return res ?? null;
      } catch (err) {
        const msg = err instanceof Error ? err.message : "操作执行失败";
        patchComputerStudioUi({ feedbackMessage: msg });
        navigationService?.showToast(msg, "error");
        return null;
      } finally {
        patchComputerStudioUi({ busyAction: null });
      }
    },
    [navigationService, rpcService],
  );

  const upsertRemoteNode = useCallback(
    async (params: BotComputerRemoteNodeUpsertParams) => {
      patchComputerStudioUi({ busyAction: "remoteNode.upsert" });
      try {
        const res = await rpcService?.call<{ node: BotRemoteComputerNode; snapshot: BotComputerStudioSnapshot }>(
          "bot.computer.remoteNode.upsert",
          { ...params },
        );
        if (res?.snapshot) applyComputerStudioSnapshot(res.snapshot);
        if (res?.node) navigationService?.showToast(`已保存节点：${res.node.alias}`, "info");
        return res?.node ?? null;
      } catch (err) {
        navigationService?.showToast(err instanceof Error ? err.message : "保存远程节点失败", "error");
        return null;
      } finally {
        patchComputerStudioUi({ busyAction: null });
      }
    },
    [navigationService, rpcService],
  );

  const deleteRemoteNode = useCallback(
    async (id: string) => {
      computerStudioSnapshotStore.set((prev) => ({
        ...prev,
        remoteNodes: prev.remoteNodes.filter((n) => n.id !== id),
      }));
      try {
        const res = await rpcService?.call<{ ok: true; snapshot: BotComputerStudioSnapshot }>(
          "bot.computer.remoteNode.delete",
          { id },
        );
        if (res?.snapshot) applyComputerStudioSnapshot(res.snapshot);
      } catch {
        // Optimistic removal kept.
      }
    },
    [rpcService],
  );

  const sendInput = useCallback(
    async (event: BotComputerInputEvent) => {
      const cur = computerStudioSnapshotStore.get();
      const payload: BotComputerInputEvent = {
        engine: event.engine ?? cur.activeEngine,
        tab: event.tab ?? cur.activeTab,
        ...event,
      };
      if (rpcService === undefined) return;
      try {
        const res = await rpcService.call<{ ok: boolean; frame?: BotComputerStreamFrame }>("bot.computer.input", { ...payload });
        if (res?.frame !== undefined) {
          computerStudioSnapshotStore.set((prev) => ({ ...prev, latestFrame: res.frame }));
        }
      } catch {
        // Ignore transient input error.
      }
    },
    [rpcService],
  );

  const navigateUrl = useCallback(
    async (url: string, engine?: BotComputerEngineId) => {
      const cleanUrl = url.trim();
      if (cleanUrl === "" || rpcService === undefined) return;
      patchComputerStudioUi({ busyAction: "navigate" });
      try {
        const res = await rpcService.call<{
          ok: boolean;
          frame?: BotComputerStreamFrame;
          snapshot?: BotComputerStudioSnapshot;
        }>("bot.computer.navigate", {
          url: cleanUrl,
          engine: engine ?? computerStudioSnapshotStore.get().activeEngine,
        });
        if (res?.snapshot) applyComputerStudioSnapshot(res.snapshot);
        else if (res?.frame) computerStudioSnapshotStore.set((prev) => ({ ...prev, latestFrame: res.frame }));
      } catch (err) {
        patchComputerStudioUi({ feedbackMessage: err instanceof Error ? err.message : "导航失败" });
      } finally {
        patchComputerStudioUi({ busyAction: null });
      }
    },
    [rpcService],
  );

  const triggerTakeover = useCallback(
    async (params: BotComputerTakeoverActionParams) => {
      const cur = computerStudioSnapshotStore.get();
      const optimisticStatus: BotComputerTakeoverState["status"] =
        params.action === "start" ? "active" : params.action === "request" ? "requested" : "idle";
      computerStudioSnapshotStore.set((prev) => ({
        ...prev,
        takeover: {
          ...prev.takeover,
          status: optimisticStatus,
          ...(params.reason !== undefined ? { reason: params.reason } : {}),
          ...(params.targetUrlOrApp !== undefined ? { targetUrlOrApp: params.targetUrlOrApp } : {}),
        },
      }));
      if (params.action === "start") setComputerScrubIndex(null);
      if (rpcService === undefined) return;
      try {
        const res = await rpcService.call<{ takeover: BotComputerTakeoverState; snapshot: BotComputerStudioSnapshot }>(
          "bot.computer.takeover",
          { engine: cur.activeEngine, tab: cur.activeTab, ...params },
        );
        if (res?.snapshot) applyComputerStudioSnapshot(res.snapshot);
        else if (res?.takeover) computerStudioSnapshotStore.set((prev) => ({ ...prev, takeover: res.takeover }));
      } catch {
        // Optimistic transition retained.
      }
    },
    [rpcService],
  );

  const openPty = useCallback(
    async (cwd?: string) => {
      const engine = computerStudioSnapshotStore.get().activeEngine;
      if (rpcService === undefined) return null;
      try {
        const res = await rpcService.call<{ pty: BotComputerPtySessionInfo }>("bot.computer.pty.open", {
          engine,
          ...(cwd !== undefined ? { cwd } : {}),
          cols: 100,
          rows: 28,
        });
        if (res?.pty) {
          syncPtyInfoToStores(res.pty);
          return res.pty;
        }
      } catch {
        // Ignore offline PTY open.
      }
      return null;
    },
    [rpcService],
  );

  const writePty = useCallback(
    async (data: string) => {
      const cur = computerStudioSnapshotStore.get();
      if (rpcService === undefined) return;
      try {
        const res = await rpcService.call<{ pty: BotComputerPtySessionInfo }>("bot.computer.pty.write", {
          engine: cur.activeEngine,
          ...(cur.pty?.sessionId !== undefined ? { sessionId: cur.pty.sessionId } : {}),
          data,
        });
        if (res?.pty) syncPtyInfoToStores(res.pty);
      } catch (err) {
        patchComputerStudioUi({ feedbackMessage: err instanceof Error ? err.message : "终端命令发送失败" });
      }
    },
    [rpcService],
  );

  const clearPtyLocal = useCallback((engineOverride?: BotComputerEngineId) => {
    const engine = engineOverride ?? computerStudioSnapshotStore.get().activeEngine;
    computerStudioUiStore.set((prev) => ({
      ...prev,
      ptyBufferByEngine: { ...prev.ptyBufferByEngine, [engine]: "" },
    }));
  }, []);

  const listFiles = useCallback(
    async (path?: string) => {
      const engine = computerStudioSnapshotStore.get().activeEngine;
      const targetPath = path ?? computerStudioUiStore.get().filesCwd ?? "/workspace";
      if (rpcService === undefined) return;
      patchComputerStudioUi({ busyAction: "files.list" });
      try {
        const res = await rpcService.call<BotComputerFilesListResult>("bot.computer.files.list", {
          engine,
          path: targetPath,
        });
        if (res) patchComputerStudioUi({ filesCwd: res.cwd || targetPath, filesEntries: res.entries });
      } catch (err) {
        patchComputerStudioUi({ feedbackMessage: err instanceof Error ? err.message : "读取目录失败" });
      } finally {
        patchComputerStudioUi({ busyAction: null });
      }
    },
    [rpcService],
  );

  const readFile = useCallback(
    async (path: string) => {
      const engine = computerStudioSnapshotStore.get().activeEngine;
      patchComputerStudioUi({ selectedFilePath: path, busyAction: "files.read" });
      if (rpcService === undefined) {
        patchComputerStudioUi({ busyAction: null });
        return;
      }
      try {
        const res = await rpcService.call<BotComputerFilesReadResult>("bot.computer.files.read", { engine, path });
        if (res) patchComputerStudioUi({ selectedFileRead: res });
      } catch (err) {
        patchComputerStudioUi({ feedbackMessage: err instanceof Error ? err.message : "读取文件失败" });
      } finally {
        patchComputerStudioUi({ busyAction: null });
      }
    },
    [rpcService],
  );

  return {
    snapshot, ui, refreshSnapshot, selectStudio, runEngineAction, upsertRemoteNode, deleteRemoteNode,
    sendInput, navigateUrl, triggerTakeover, openPty, writePty, clearPtyLocal, listFiles, readFile,
  };
}

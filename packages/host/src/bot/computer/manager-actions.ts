/**
 * Engine action & Bot tool routing helpers for `VirtualComputerManager`
 * (`packages/host/src/bot/computer/manager-actions.ts`).
 */
import type {
  BotComputerEngineActionParams,
  BotComputerEngineActionResult,
  BotComputerEngineId,
  BotComputerEventNotification,
  BotComputerStreamFrame,
  BotComputerStudioSnapshot,
  BotLocalLinuxDesktopStatus,
  BotLocalWinPipStatus,
} from "@qianji/protocol";
import type { ToolCall, ToolEnv, ToolOutput } from "@qianji/tools";
import type { PersistedBotState } from "../defaults.ts";
import { BOT_BROWSER_TOOLS, type BotLiveViewController } from "../live-view.ts";
import type { SshRemoteRuntime } from "../ssh-runtime.ts";
import type { BotSecretVault } from "../store-proactive.ts";
import { executeBotToolInVm, VM_BRIDGED_TOOLS } from "../vm-tool-bridge.ts";
import type { WslContainerRuntime } from "../wsl-runtime.ts";
import type { CdpScreencastController } from "./cdp-screencast.ts";
import { executeFencedHostTool } from "./fenced-tool-bridge.ts";
import type { LocalLinuxComputerEngine } from "./local-linux-engine.ts";
import { nodeToSshEndpoint, type RemoteNodesEngine } from "./remote-nodes-engine.ts";
import { ensureComputerStudioState, type TimelineAndTakeoverTracker } from "./timeline-and-takeover.ts";
import type { WinPipComputerEngine } from "./win-pip-engine.ts";

export interface ComputerActionContext {
  st: PersistedBotState;
  localLinux: LocalLinuxComputerEngine;
  winPip: WinPipComputerEngine;
  remoteNodes: RemoteNodesEngine;
  cdpScreencast: CdpScreencastController;
  tracker: TimelineAndTakeoverTracker;
  wsl: WslContainerRuntime;
  ssh: SshRemoteRuntime;
  liveView: BotLiveViewController;
  vault: BotSecretVault;
  getBotWorkspaceDir: () => string;
  persist: () => void;
  nextFrameSeq: () => number;
  setLatestFrame: (frame: BotComputerStreamFrame) => void;
  setLocalLinuxStatus: (status: BotLocalLinuxDesktopStatus) => void;
  setWinPipStatus: (status: BotLocalWinPipStatus) => void;
  emitComputerEvent: (ev: BotComputerEventNotification) => void;
  getSnapshot: (opts?: { engine?: BotComputerEngineId }) => Promise<BotComputerStudioSnapshot>;
  navigate: (opts: { url: string; engine?: BotComputerEngineId }) => Promise<{ ok: boolean; snapshot: BotComputerStudioSnapshot }>;
}

export async function runComputerEngineAction(
  ctx: ComputerActionContext,
  params: BotComputerEngineActionParams,
): Promise<BotComputerEngineActionResult> {
  const { st } = ctx;
  const cs = ensureComputerStudioState(st);
  cs.remoteNodes = await ctx.remoteNodes.syncLegacyRemoteWithNodes(st.virtualServer, cs.remoteNodes);
  const { engine, action } = params;

  if (action === "provision-linux-gui") {
    const res = await ctx.localLinux.provisionGui(ctx.wsl, st.virtualServer);
    ctx.setLocalLinuxStatus(res.status);
    ctx.persist();
    const snapshot = await ctx.getSnapshot({ engine: "local-linux" });
    ctx.emitComputerEvent({ kind: "snapshot", snapshot });
    return { ok: res.ok, message: res.message, snapshot };
  }

  if (action === "enable-win-child-session") {
    const res = await ctx.winPip.enableChildSession();
    ctx.setWinPipStatus(res.status);
    const snapshot = await ctx.getSnapshot({ engine: "local-win-pip" });
    ctx.emitComputerEvent({ kind: "snapshot", snapshot });
    return {
      ok: res.ok,
      message: res.message,
      ...(res.elevationRequired ? { elevationRequired: true } : {}),
      snapshot,
    };
  }

  if (action === "open-native-desktop") {
    if (engine === "local-win-pip") {
      const res = await ctx.winPip.openNativeViewer({ forceOpen: params.forceOpen });
      ctx.setWinPipStatus(res.status);
      const snapshot = await ctx.getSnapshot({ engine: "local-win-pip" });
      ctx.emitComputerEvent({ kind: "snapshot", snapshot });
      return {
        ok: res.ok,
        message: res.message,
        ...(res.elevationRequired ? { elevationRequired: true } : {}),
        snapshot,
      };
    }
    if (engine === "local-linux") {
      const cur = await ctx.localLinux.inspectStatus(ctx.wsl, st.virtualServer);
      const res = cur.vncReady ? { ok: true, message: "Linux 完整桌面视图已就绪", status: cur } : await ctx.localLinux.provisionGui(ctx.wsl, st.virtualServer);
      ctx.setLocalLinuxStatus(res.status);
      const snapshot = await ctx.getSnapshot({ engine: "local-linux" });
      ctx.emitComputerEvent({ kind: "snapshot", snapshot });
      return { ok: res.ok, message: res.message, snapshot };
    }
    const snapshot = await ctx.getSnapshot({ engine });
    ctx.emitComputerEvent({ kind: "snapshot", snapshot });
    return { ok: true, message: "远程桌面视图已就绪", snapshot };
  }

  if (action === "launch-app") {
    if (engine === "local-win-pip") {
      const res = await ctx.winPip.launch({ launchKind: params.launchKind, appOrUrl: params.appOrUrl });
      ctx.setWinPipStatus(res.status);
      const frame = await ctx.winPip.captureFrame(ctx.nextFrameSeq(), ctx.tracker.currentPointer);
      ctx.setLatestFrame(frame);
      ctx.emitComputerEvent({ kind: "frame", frame });
      ctx.tracker.appendStep(st, {
        engine: "local-win-pip",
        tab: "desktop",
        title: params.launchKind === "browser" ? "启动独立配置浏览器" : "启动独立桌面应用",
        subtitle: params.appOrUrl ?? "",
        urlOrApp: params.appOrUrl,
        thumbnailBase64: frame.dataBase64,
      });
      ctx.persist();
      const snapshot = await ctx.getSnapshot({ engine: "local-win-pip" });
      return { ok: res.ok, message: res.message, snapshot };
    }
    const targetUrl = params.appOrUrl?.trim() || "https://example.com";
    const nav = await ctx.navigate({ url: targetUrl, engine });
    return { ok: nav.ok, message: `已在隔离浏览器打开 ${targetUrl}`, snapshot: nav.snapshot };
  }

  if (action === "close-window") {
    ctx.setWinPipStatus(await ctx.winPip.closeWindow(params.hwnd, !params.hwnd));
    const frame = await ctx.winPip.captureFrame(ctx.nextFrameSeq(), ctx.tracker.currentPointer);
    ctx.setLatestFrame(frame);
    ctx.emitComputerEvent({ kind: "frame", frame });
    const snapshot = await ctx.getSnapshot({ engine: "local-win-pip" });
    return { ok: true, message: "已关闭独立桌面窗口", snapshot };
  }

  if (action === "connect-remote" || action === "disconnect-remote" || action === "sync-autonomy-lease") {
    const node = ctx.remoteNodes.resolveNodeForEngine(engine, cs.remoteNodes, params.remoteNodeId ?? cs.activeRemoteNodeId);
    if (!node) {
      const snapshot = await ctx.getSnapshot({ engine });
      return { ok: false, message: "请先添加并配置远程电脑节点", snapshot };
    }
    cs.activeRemoteNodeId = node.id;
    let res: { ok: boolean; message: string };
    if (action === "connect-remote") {
      res = await ctx.remoteNodes.connectNode(node, st.virtualServer);
    } else if (action === "disconnect-remote") {
      res = ctx.remoteNodes.disconnectNode(node, st.virtualServer);
    } else {
      const synced = await ctx.remoteNodes.syncAutonomyLease(node, engine, st.virtualServer);
      if (synced.replayedSteps.length > 0) ctx.tracker.appendReplayedSteps(st, synced.replayedSteps);
      res = { ok: synced.ok, message: synced.message };
    }
    ctx.persist();
    const snapshot = await ctx.getSnapshot({ engine });
    ctx.emitComputerEvent({ kind: "snapshot", snapshot });
    return { ok: res.ok, message: res.message, snapshot };
  }

  if (action === "stop" && cs.takeover.status !== "idle") {
    ctx.tracker.transitionTakeover(st, { action: "release", engine });
  }

  if (engine === "local-linux") {
    if (action === "stop") {
      await ctx.localLinux.stop(ctx.wsl);
      await ctx.wsl.sleep();
      st.virtualServer.lifecycle = "sleeping";
    } else if (action === "restart") {
      await ctx.localLinux.stop(ctx.wsl);
      await ctx.wsl.sleep();
      if (ctx.wsl.isSupported()) await ctx.wsl.wake();
      st.virtualServer.lifecycle = "running";
    } else {
      if (ctx.wsl.isSupported()) await ctx.wsl.wake();
      st.virtualServer.lifecycle = "running";
    }
    ctx.setLocalLinuxStatus(await ctx.localLinux.inspectStatus(ctx.wsl, st.virtualServer));
    ctx.persist();
    const snapshot = await ctx.getSnapshot({ engine: "local-linux" });
    ctx.emitComputerEvent({ kind: "snapshot", snapshot });
    return { ok: true, message: `Linux 虚拟电脑已执行 ${action}`, snapshot };
  }

  if (engine === "local-win-pip") {
    ctx.setWinPipStatus(
      action === "stop" ? await ctx.winPip.sleepDesktop() : await ctx.winPip.inspectStatus(),
    );
    ctx.persist();
    const snapshot = await ctx.getSnapshot({ engine: "local-win-pip" });
    ctx.emitComputerEvent({ kind: "snapshot", snapshot });
    return { ok: true, message: `Windows 独立子会话桌面已执行 ${action}`, snapshot };
  }

  const node = ctx.remoteNodes.resolveNodeForEngine(engine, cs.remoteNodes, params.remoteNodeId ?? cs.activeRemoteNodeId);
  if (node) {
    const res =
      action === "stop"
        ? ctx.remoteNodes.disconnectNode(node, st.virtualServer)
        : await ctx.remoteNodes.connectNode(node, st.virtualServer);
    ctx.persist();
    const snapshot = await ctx.getSnapshot({ engine });
    ctx.emitComputerEvent({ kind: "snapshot", snapshot });
    return { ok: res.ok, message: res.message, snapshot };
  }
  const snapshot = await ctx.getSnapshot({ engine });
  if (action === "stop") {
    ctx.emitComputerEvent({ kind: "snapshot", snapshot });
    return { ok: true, message: "远程电脑当前处于休眠待命状态", snapshot };
  }
  return { ok: false, message: "未找到可用的远程节点配置", snapshot };
}

export async function routeBotToolThroughComputer(
  call: ToolCall,
  env: ToolEnv,
  ctx: Omit<
    ComputerActionContext,
    "nextFrameSeq" | "setLatestFrame" | "setLocalLinuxStatus" | "setWinPipStatus" | "emitComputerEvent" | "getSnapshot" | "navigate"
  >,
): Promise<ToolOutput | undefined> {
  const { st } = ctx;
  const cs = ensureComputerStudioState(st);

  if (BOT_BROWSER_TOOLS.has(call.name)) {
    const browser = ctx.liveView.getBrowserSessionForInput();
    await browser.ensureStarted(true).catch(() => undefined);
    await ctx.cdpScreencast.ensureViewport(browser);
    const out = await ctx.liveView.executeBrowserTool(call);
    ctx.tracker.recordToolCall(st, call, out);
    ctx.persist();
    return out;
  }

  if (!VM_BRIDGED_TOOLS.has(call.name)) return undefined;

  if (cs.activeEngine === "local-win-pip") {
    const out = await executeFencedHostTool(call, ctx.getBotWorkspaceDir(), st.virtualServer.local.sharedFolders);
    ctx.tracker.recordToolCall(st, call, out);
    ctx.persist();
    return out;
  }

  if (cs.activeEngine === "remote-vm" || cs.activeEngine === "remote-pc" || st.virtualServer.mode === "remote") {
    cs.remoteNodes = await ctx.remoteNodes.syncLegacyRemoteWithNodes(st.virtualServer, cs.remoteNodes);
    const node = ctx.remoteNodes.resolveNodeForEngine(cs.activeEngine, cs.remoteNodes, cs.activeRemoteNodeId);
    if (node && node.host.trim() !== "") {
      if (!node.connected && node.autonomyLease.active) {
        ctx.remoteNodes.enqueueOfflineEvent(node, {
          title: `离线自治执行 ${call.name}`,
          subtitle: String(call.args.command ?? call.args.path ?? "").slice(0, 60),
          toolName: call.name,
        });
      } else if (node.connected) {
        node.autonomyLease.lastSeq += 1;
        node.autonomyLease.updatedAt = Date.now();
      }
      const remoteStatus = {
        ...st.virtualServer,
        mode: "remote" as const,
        remote: { ...st.virtualServer.remote, ...nodeToSshEndpoint(node), alias: node.alias, initialized: node.connected },
      };
      const out = await executeBotToolInVm(call, env, {
        status: remoteStatus,
        hostWorkspaceDir: ctx.getBotWorkspaceDir(),
        wsl: ctx.wsl,
        ssh: ctx.ssh,
        getRemotePassword: () => ctx.remoteNodes.getNodePassword(node),
      });
      ctx.tracker.recordToolCall(st, call, out);
      ctx.persist();
      return out;
    }
  }

  if (!ctx.wsl.isSupported()) return undefined;

  const out = await executeBotToolInVm(call, env, {
    status: st.virtualServer,
    hostWorkspaceDir: ctx.getBotWorkspaceDir(),
    wsl: ctx.wsl,
    ssh: ctx.ssh,
    getRemotePassword: () => ctx.vault.get("bot/remote-ssh-password"),
  });
  ctx.tracker.recordToolCall(st, call, out);
  ctx.persist();
  return out;
}

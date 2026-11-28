/**
 * Unified `2x2` Virtual Computer 2.0 Coordinator (`packages/host/src/bot/computer/manager.ts`).
 */
import type {
  BotComputerEngineActionParams, BotComputerEngineActionResult, BotComputerEngineId,
  BotComputerEventNotification, BotComputerFilesListParams, BotComputerFilesListResult,
  BotComputerFilesReadParams, BotComputerFilesReadResult, BotComputerInputEvent,
  BotComputerPointerAction, BotComputerPtySessionInfo, BotComputerPtyWriteParams,
  BotComputerRemoteNodeUpsertParams, BotComputerSelectParams, BotComputerStreamControlParams,
  BotComputerStreamFrame, BotComputerStreamTab, BotComputerStudioSnapshot,
  BotComputerTakeoverActionParams, BotComputerTakeoverState, BotLocalLinuxDesktopStatus,
  BotLocalWinPipStatus, BotRemoteComputerNode,
} from "@qianji/protocol";
import type { ToolCall, ToolEnv, ToolOutput } from "@qianji/tools";
import type { PersistedBotState } from "../defaults.ts";
import type { BotLiveViewController } from "../live-view.ts";
import type { SshRemoteRuntime } from "../ssh-runtime.ts";
import type { BotSecretVault } from "../store-proactive.ts";
import type { WslContainerRuntime } from "../wsl-runtime.ts";
import { LocalLinuxComputerEngine } from "./local-linux-engine.ts";
import { routeBotToolThroughComputer, runComputerEngineAction } from "./manager-actions.ts";
import { PtySessionManager } from "./pty-manager.ts";
import { RemoteNodesEngine } from "./remote-nodes-engine.ts";
import { computeFencedRoots } from "./sentinel-fence.ts";
import { ensureComputerStudioState, TimelineAndTakeoverTracker } from "./timeline-and-takeover.ts";
import { createSubprocessHelperInvoker, WinPipComputerEngine, type ComputerHelperInvoke } from "./win-pip-engine.ts";

export interface VirtualComputerDeps {
  ensureLoaded: () => Promise<PersistedBotState>;
  persist: () => void;
  getBotStorageDir: () => string;
  getBotWorkspaceDir: () => string;
  getComputerHelperPath: () => string | undefined;
  customHelperInvoker?: ComputerHelperInvoke;
  wsl: WslContainerRuntime;
  ssh: SshRemoteRuntime;
  liveView: BotLiveViewController;
  vault: BotSecretVault;
  getSoul: () => string;
  getMemory: () => string;
}

function mapInputToPointerAction(ev: BotComputerInputEvent): BotComputerPointerAction {
  if (ev.kind === "wheel") return "scroll";
  if (ev.kind === "key" || ev.kind === "text" || ev.kind === "paste") return "type";
  if (ev.mouseAction === "double-click") return "double-click";
  if (ev.mouseAction === "move") return "move";
  return "click";
}

export class VirtualComputerManager {
  readonly localLinux: LocalLinuxComputerEngine;
  readonly winPip: WinPipComputerEngine;
  readonly remoteNodes: RemoteNodesEngine;
  readonly pty: PtySessionManager;
  readonly tracker: TimelineAndTakeoverTracker;

  private latestFrame: BotComputerStreamFrame | undefined;
  private lastLocalLinuxStatus: BotLocalLinuxDesktopStatus | undefined;
  private lastWinPipStatus: BotLocalWinPipStatus | undefined;
  private frameSeq = 1;
  private streamTimer: ReturnType<typeof setInterval> | null = null;
  private rpcBroadcaster: ((channel: string, payload: unknown) => void) | undefined;
  private currentStateRef: PersistedBotState | undefined;

  constructor(private readonly deps: VirtualComputerDeps) {
    this.localLinux = new LocalLinuxComputerEngine();
    const invokeHelper = deps.customHelperInvoker ?? createSubprocessHelperInvoker(() => deps.getComputerHelperPath());
    this.winPip = new WinPipComputerEngine({
      getBotStorageDir: () => deps.getBotStorageDir(),
      getBotWorkspaceDir: () => deps.getBotWorkspaceDir(),
      getSharedFolders: () => this.currentStateRef?.virtualServer.local.sharedFolders ?? [],
      invokeHelper,
    });
    this.remoteNodes = new RemoteNodesEngine({
      ssh: deps.ssh,
      vault: deps.vault,
      getSoul: () => deps.getSoul(),
      getMemory: () => deps.getMemory(),
    });
    this.tracker = new TimelineAndTakeoverTracker({
      emitEvent: (ev) => this.emitComputerEvent(ev),
      emitDesktopNotification: (notif) => this.rpcBroadcaster?.("bot/desktopNotification", notif),
      onFrameCaptured: (frame) => {
        this.latestFrame = frame;
        this.emitComputerEvent({ kind: "frame", frame });
      },
    });
    this.pty = new PtySessionManager({
      getBotWorkspaceDir: () => deps.getBotWorkspaceDir(),
      getSharedFolders: () => this.currentStateRef?.virtualServer.local.sharedFolders ?? [],
      wsl: deps.wsl,
      remoteEngine: this.remoteNodes,
      resolveRemoteNode: (engine) => {
        const st = this.currentStateRef;
        const cs = st ? ensureComputerStudioState(st) : undefined;
        return cs ? this.remoteNodes.resolveNodeForEngine(engine, cs.remoteNodes, cs.activeRemoteNodeId) : undefined;
      },
      emitEvent: (ev) => this.emitComputerEvent(ev),
    });
  }

  attachBroadcaster(fn: ((channel: string, payload: unknown) => void) | undefined): void {
    this.rpcBroadcaster = fn;
  }

  private emitComputerEvent(ev: BotComputerEventNotification): void {
    this.rpcBroadcaster?.("bot/computer", ev);
  }

  buildEmbeddedSnapshot(st: PersistedBotState): BotComputerStudioSnapshot {
    this.currentStateRef = st;
    const cs = ensureComputerStudioState(st);
    const fencedRoots = computeFencedRoots(this.deps.getBotWorkspaceDir(), st.virtualServer.local.sharedFolders);
    const localWinPip: BotLocalWinPipStatus = this.lastWinPipStatus
      ? { ...this.lastWinPipStatus, fencedRoots, isolatedProfileDir: this.winPip.isolatedProfileDir }
      : {
          accountMode: "current-user", backend: process.platform === "win32" ? "win32-secondary-desktop" : "unavailable",
          proSupported: process.platform === "win32", childSessionEnabled: false, desktopName: "QianjiBotDesktop",
          isolatedProfileDir: this.winPip.isolatedProfileDir, fencedRoots, openWindows: [], resolution: "1280x800",
        };
    const localLinux: BotLocalLinuxDesktopStatus = this.lastLocalLinuxStatus ?? {
      distro: st.virtualServer.local.distroName ?? this.deps.wsl.distroName,
      guiReady: false, display: ":99", resolution: "1280x800", chromiumReady: true,
    };
    const ptyInfo = this.pty.getActiveInfo(cs.activeEngine);
    return {
      activeEngine: cs.activeEngine, activeTab: cs.activeTab, autoFollow: cs.autoFollow,
      localLinux, localWinPip, remoteNodes: [...cs.remoteNodes],
      ...(cs.activeRemoteNodeId ? { activeRemoteNodeId: cs.activeRemoteNodeId } : {}),
      ...(this.latestFrame ? { latestFrame: this.latestFrame } : {}),
      takeover: { ...cs.takeover }, timeline: [...cs.timeline],
      ...(ptyInfo ? { pty: ptyInfo } : {}),
    };
  }

  async getSnapshot(params: { engine?: BotComputerEngineId; includeFrame?: boolean } = {}): Promise<BotComputerStudioSnapshot> {
    const st = await this.deps.ensureLoaded();
    this.currentStateRef = st;
    const cs = ensureComputerStudioState(st);
    const targetEngine = params.engine ?? cs.activeEngine;
    cs.remoteNodes = await this.remoteNodes.syncLegacyRemoteWithNodes(st.virtualServer, cs.remoteNodes);

    if (targetEngine === "local-linux" || this.lastLocalLinuxStatus === undefined) {
      this.lastLocalLinuxStatus = await this.localLinux.inspectStatus(this.deps.wsl, st.virtualServer);
    }
    if (targetEngine === "local-win-pip" || this.lastWinPipStatus === undefined) {
      this.lastWinPipStatus = await this.winPip.inspectStatus();
    }
    if (params.includeFrame) {
      const streamTab: BotComputerStreamTab = cs.activeTab === "browser" ? "browser" : "desktop";
      this.latestFrame = await this.captureEngineFrame(st, targetEngine, streamTab);
    }
    const snap = this.buildEmbeddedSnapshot(st);
    st.virtualServer.computerStudio = snap;
    return snap;
  }

  async select(params: BotComputerSelectParams): Promise<BotComputerStudioSnapshot> {
    const st = await this.deps.ensureLoaded();
    this.currentStateRef = st;
    const cs = ensureComputerStudioState(st);
    if (params.engine !== undefined) {
      cs.activeEngine = params.engine;
      st.virtualServer.mode = params.engine === "remote-vm" || params.engine === "remote-pc" ? "remote" : "local";
    }
    if (params.tab !== undefined) cs.activeTab = params.tab;
    if (typeof params.autoFollow === "boolean") cs.autoFollow = params.autoFollow;
    if (params.activeRemoteNodeId !== undefined) cs.activeRemoteNodeId = params.activeRemoteNodeId || undefined;
    this.deps.persist();
    const snapshot = await this.getSnapshot({ engine: cs.activeEngine });
    this.emitComputerEvent({ kind: "snapshot", snapshot });
    return snapshot;
  }

  async performAction(params: BotComputerEngineActionParams): Promise<BotComputerEngineActionResult> {
    const st = await this.deps.ensureLoaded();
    this.currentStateRef = st;
    return runComputerEngineAction(
      {
        st, localLinux: this.localLinux, winPip: this.winPip, remoteNodes: this.remoteNodes,
        tracker: this.tracker, wsl: this.deps.wsl, ssh: this.deps.ssh, liveView: this.deps.liveView,
        vault: this.deps.vault, getBotWorkspaceDir: () => this.deps.getBotWorkspaceDir(), persist: () => this.deps.persist(),
        nextFrameSeq: () => this.frameSeq++,
        setLatestFrame: (f) => { this.latestFrame = f; },
        setLocalLinuxStatus: (s) => { this.lastLocalLinuxStatus = s; },
        setWinPipStatus: (s) => { this.lastWinPipStatus = s; },
        emitComputerEvent: (ev) => this.emitComputerEvent(ev),
        getSnapshot: (opts) => this.getSnapshot(opts),
        navigate: (opts) => this.navigate(opts),
      },
      params,
    );
  }

  async upsertRemoteNode(params: BotComputerRemoteNodeUpsertParams): Promise<{ node: BotRemoteComputerNode; snapshot: BotComputerStudioSnapshot }> {
    const st = await this.deps.ensureLoaded();
    this.currentStateRef = st;
    const cs = ensureComputerStudioState(st);
    cs.remoteNodes = await this.remoteNodes.syncLegacyRemoteWithNodes(st.virtualServer, cs.remoteNodes);
    const node = await this.remoteNodes.upsertNode(params, cs.remoteNodes, st.virtualServer);
    cs.activeRemoteNodeId = node.id;
    this.deps.persist();
    const snapshot = await this.getSnapshot();
    this.emitComputerEvent({ kind: "snapshot", snapshot });
    return { node, snapshot };
  }

  async deleteRemoteNode(id: string): Promise<{ ok: true; snapshot: BotComputerStudioSnapshot }> {
    const st = await this.deps.ensureLoaded();
    this.currentStateRef = st;
    const cs = ensureComputerStudioState(st);
    await this.remoteNodes.deleteNode(id, cs.remoteNodes, st.virtualServer);
    if (cs.activeRemoteNodeId === id) cs.activeRemoteNodeId = cs.remoteNodes[0]?.id;
    this.deps.persist();
    const snapshot = await this.getSnapshot();
    this.emitComputerEvent({ kind: "snapshot", snapshot });
    return { ok: true, snapshot };
  }

  private async captureEngineFrame(st: PersistedBotState, engine: BotComputerEngineId, tab: BotComputerStreamTab): Promise<BotComputerStreamFrame> {
    const seq = this.frameSeq++;
    const cursor = this.tracker.currentPointer;
    if (engine === "local-win-pip") return this.winPip.captureFrame(seq, cursor);
    if (engine === "local-linux" || tab === "browser") {
      const frame = await this.localLinux.captureFrame(tab, this.deps.liveView, this.deps.wsl, st.virtualServer, seq, cursor);
      return { ...frame, engine };
    }
    const cs = ensureComputerStudioState(st);
    const node = this.remoteNodes.resolveNodeForEngine(engine, cs.remoteNodes, cs.activeRemoteNodeId);
    return this.remoteNodes.captureFrame(engine, node, seq, cursor);
  }

  async controlStream(params: BotComputerStreamControlParams): Promise<{ ok: true }> {
    if (this.streamTimer !== null) {
      clearInterval(this.streamTimer);
      this.streamTimer = null;
    }
    if (!params.active) return { ok: true };
    const st = await this.deps.ensureLoaded();
    this.currentStateRef = st;
    const cs = ensureComputerStudioState(st);
    const engine = params.engine ?? cs.activeEngine;
    const tab: BotComputerStreamTab = params.tab ?? (cs.activeTab === "browser" ? "browser" : "desktop");
    const fps = Math.min(8, Math.max(1, Math.round(params.fps ?? 2)));
    const pushFrame = async () => {
      const curSt = await this.deps.ensureLoaded();
      const frame = await this.captureEngineFrame(curSt, engine, tab);
      this.latestFrame = frame;
      this.emitComputerEvent({ kind: "frame", frame });
    };
    await pushFrame();
    this.streamTimer = setInterval(() => { void pushFrame().catch(() => undefined); }, Math.round(1000 / fps));
    this.streamTimer.unref?.();
    return { ok: true };
  }

  async dispatchInput(event: BotComputerInputEvent): Promise<{ ok: boolean; frame?: BotComputerStreamFrame }> {
    const st = await this.deps.ensureLoaded();
    this.currentStateRef = st;
    const cs = ensureComputerStudioState(st);
    const engine = event.engine ?? cs.activeEngine;
    const viewTab = event.tab ?? cs.activeTab;
    const cursor = this.tracker.updatePointer({
      action: mapInputToPointerAction(event),
      ...(typeof event.x === "number" ? { x: event.x } : {}), ...(typeof event.y === "number" ? { y: event.y } : {}),
      ...(typeof event.viewportWidth === "number" ? { viewportWidth: event.viewportWidth } : {}),
      ...(typeof event.viewportHeight === "number" ? { viewportHeight: event.viewportHeight } : {}),
      ...(event.key ? { label: event.key } : {}),
    }, engine, viewTab);
    const seq = this.frameSeq++;
    const rawFrame = engine === "local-win-pip" && viewTab !== "browser"
      ? await this.winPip.dispatchInput(event, seq, cursor)
      : await this.localLinux.dispatchBrowserInput(event, this.deps.liveView, this.deps.wsl, st.virtualServer, seq, cursor);
    const taggedFrame: BotComputerStreamFrame = { ...rawFrame, engine };
    this.latestFrame = taggedFrame;
    this.emitComputerEvent({ kind: "frame", frame: taggedFrame });
    return { ok: true, frame: taggedFrame };
  }

  async navigate(params: { url: string; engine?: BotComputerEngineId }): Promise<{ ok: boolean; frame?: BotComputerStreamFrame; snapshot: BotComputerStudioSnapshot }> {
    const st = await this.deps.ensureLoaded();
    this.currentStateRef = st;
    const cs = ensureComputerStudioState(st);
    const engine = params.engine ?? cs.activeEngine;
    let frame: BotComputerStreamFrame;
    if (engine === "local-win-pip" && cs.activeTab === "desktop") {
      await this.winPip.launch({ launchKind: "browser", appOrUrl: params.url });
      frame = await this.winPip.captureFrame(this.frameSeq++, this.tracker.currentPointer);
    } else {
      const snap = await this.deps.liveView.navigate(params.url, st.virtualServer);
      frame = {
        engine, tab: "browser", mimeType: "image/png", dataBase64: snap.screenshotBase64,
        width: snap.viewport.width, height: snap.viewport.height, seq: this.frameSeq++, ts: Date.now(),
        url: snap.url, title: snap.title, cursor: this.tracker.currentPointer,
      };
    }
    this.latestFrame = frame;
    this.emitComputerEvent({ kind: "frame", frame });
    this.tracker.appendStep(st, { engine, tab: frame.tab, title: "导航至网页", subtitle: params.url, urlOrApp: params.url, thumbnailBase64: frame.dataBase64 });
    this.deps.persist();
    const snapshot = await this.getSnapshot({ engine });
    return { ok: true, frame, snapshot };
  }

  async takeover(params: BotComputerTakeoverActionParams): Promise<{ takeover: BotComputerTakeoverState; snapshot: BotComputerStudioSnapshot }> {
    const st = await this.deps.ensureLoaded();
    this.currentStateRef = st;
    const takeover = this.tracker.transitionTakeover(st, params);
    this.deps.persist();
    const snapshot = await this.getSnapshot();
    this.emitComputerEvent({ kind: "snapshot", snapshot });
    return { takeover, snapshot };
  }

  async ptyOpen(params: { engine?: BotComputerEngineId; cwd?: string; cols?: number; rows?: number }): Promise<{ pty: BotComputerPtySessionInfo }> {
    const st = await this.deps.ensureLoaded();
    this.currentStateRef = st;
    const cs = ensureComputerStudioState(st);
    cs.remoteNodes = await this.remoteNodes.syncLegacyRemoteWithNodes(st.virtualServer, cs.remoteNodes);
    return { pty: await this.pty.open({ engine: params.engine ?? cs.activeEngine, cwd: params.cwd, cols: params.cols, rows: params.rows }) };
  }

  async ptyWrite(params: BotComputerPtyWriteParams): Promise<{ pty: BotComputerPtySessionInfo }> {
    const st = await this.deps.ensureLoaded();
    this.currentStateRef = st;
    const cs = ensureComputerStudioState(st);
    cs.remoteNodes = await this.remoteNodes.syncLegacyRemoteWithNodes(st.virtualServer, cs.remoteNodes);
    return { pty: await this.pty.write({ sessionId: params.sessionId, engine: params.engine ?? cs.activeEngine, data: params.data }) };
  }

  ptyResize(params: { sessionId?: string; engine?: BotComputerEngineId; cols: number; rows: number }): { ok: true } {
    this.pty.resize(params);
    return { ok: true };
  }

  async ptyClose(params: { sessionId?: string; engine?: BotComputerEngineId }): Promise<{ ok: true }> {
    await this.pty.close(params);
    return { ok: true };
  }

  async filesList(params: BotComputerFilesListParams): Promise<BotComputerFilesListResult> {
    const st = await this.deps.ensureLoaded();
    this.currentStateRef = st;
    const cs = ensureComputerStudioState(st);
    const engine = params.engine ?? cs.activeEngine;
    if (engine === "local-win-pip") return this.winPip.listFiles(params.path);
    if (engine === "local-linux") return this.localLinux.listWorkspaceFiles(params.path, this.deps.getBotWorkspaceDir(), st.virtualServer.local.sharedFolders);
    cs.remoteNodes = await this.remoteNodes.syncLegacyRemoteWithNodes(st.virtualServer, cs.remoteNodes);
    const node = this.remoteNodes.resolveNodeForEngine(engine, cs.remoteNodes, cs.activeRemoteNodeId);
    return this.remoteNodes.listFiles(engine, node, params.path);
  }

  async filesRead(params: BotComputerFilesReadParams): Promise<BotComputerFilesReadResult> {
    const st = await this.deps.ensureLoaded();
    this.currentStateRef = st;
    const cs = ensureComputerStudioState(st);
    const engine = params.engine ?? cs.activeEngine;
    if (engine === "local-win-pip") return this.winPip.readFile(params.path, params.maxBytes);
    if (engine === "local-linux") return this.localLinux.readWorkspaceFile(params.path, params.maxBytes, this.deps.getBotWorkspaceDir(), st.virtualServer.local.sharedFolders);
    cs.remoteNodes = await this.remoteNodes.syncLegacyRemoteWithNodes(st.virtualServer, cs.remoteNodes);
    const node = this.remoteNodes.resolveNodeForEngine(engine, cs.remoteNodes, cs.activeRemoteNodeId);
    return this.remoteNodes.readFile(node, params.path, params.maxBytes);
  }

  executeBotTool(call: ToolCall, env: ToolEnv, st: PersistedBotState): Promise<ToolOutput | undefined> {
    this.currentStateRef = st;
    return routeBotToolThroughComputer(call, env, {
      st, localLinux: this.localLinux, winPip: this.winPip, remoteNodes: this.remoteNodes,
      tracker: this.tracker, wsl: this.deps.wsl, ssh: this.deps.ssh, liveView: this.deps.liveView,
      vault: this.deps.vault, getBotWorkspaceDir: () => this.deps.getBotWorkspaceDir(), persist: () => this.deps.persist(),
    });
  }

  async dispose(): Promise<void> {
    if (this.streamTimer !== null) {
      clearInterval(this.streamTimer);
      this.streamTimer = null;
    }
    await this.pty.closeAll();
  }
}

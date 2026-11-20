/**
 * Unit tests for ADR 0023 Phase 2 Frontend Cordis Service Mesh (`src/kernel/services/`).
 *
 * Covers:
 * - Service mounting and discovery via `registerFrontendServices(root)`
 * - Multi-session `sessionService.retain()` ref-counting, isolation, and streaming updates
 * - Reactive subscriptions across workspace, composer, workbench, navigation, theme,
 *   shortcut, menu, rpc, locale, and resources services
 * - Guarded predicates/callbacks, Safe Mode chord exclusion, and automatic Cordis Fiber disposal
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Context } from "@deepseek-ai/cordis";
import {
  FRONTEND_SERVICE_NAMES,
  RESERVED_SAFE_MODE_CHORD,
  isReservedShortcutChord,
  registerFrontendServices,
  type HostStatus,
  type RpcTransport,
} from "../src/kernel/services";
import { agent } from "../src/lib/agent";
import { ClientContributionRegistry } from "../src/lib/clientContributions";
import {
  clearClientRenderError,
  getClientRenderErrors,
  tagFiberPluginId,
} from "../src/lib/clientPluginRuntime";
import { harnessRuntimes } from "../src/lib/harnessRuntime";
import { pluginClient } from "../src/lib/pluginClient";
import { useAppStore } from "../src/store";
import { useWorkbenchLayoutStore } from "../src/stores/workbenchLayoutStore";
import { useWorkbenchStore } from "../src/stores/workbenchStore";
import type { AttachmentPayload, ModelInfo, UiMessage } from "../src/types";

function makeKeyEvent(
  init: {
    key: string;
    code?: string;
    ctrlKey?: boolean;
    metaKey?: boolean;
    altKey?: boolean;
    shiftKey?: boolean;
    inEditable?: boolean;
    inTerminal?: boolean;
    inRecorder?: boolean;
  },
): KeyboardEvent {
  const event = new Event("keydown", { cancelable: true }) as KeyboardEvent;
  const target = {
    closest(selector: string) {
      if (init.inRecorder && selector.includes("data-shortcut-recorder")) return {};
      if (init.inTerminal && selector.includes(".xterm")) return {};
      if (init.inEditable && selector.includes("input")) return {};
      return null;
    },
  };
  Object.defineProperty(event, "target", { value: target, configurable: true });
  Object.assign(event, {
    key: init.key,
    code: init.code ?? "",
    ctrlKey: init.ctrlKey ?? false,
    metaKey: init.metaKey ?? false,
    altKey: init.altKey ?? false,
    shiftKey: init.shiftKey ?? false,
    isComposing: false,
  });
  return event;
}

function createMockRpcTransport(): {
  transport: RpcTransport;
  emitNotification: (method: string, params: unknown) => void;
  setStatus: (status: HostStatus) => void;
  reconnectCalls: number;
  callSpy: ReturnType<typeof vi.fn>;
} {
  let currentStatus: HostStatus = "connected";
  const statusListeners = new Set<(status: HostStatus) => void>();
  const notifListeners = new Map<string, Set<(params: unknown) => void>>();
  const callSpy = vi.fn(async (method: string, params?: Record<string, unknown>) => ({
    method,
    params: params ?? {},
  }));
  const state = {
    reconnectCalls: 0,
    callSpy,
    transport: {
      call<T>(method: string, params?: Record<string, unknown>) {
        return callSpy(method, params) as Promise<T>;
      },
      onNotification(method: string, listener: (params: unknown) => void) {
        const set = notifListeners.get(method) ?? new Set<(params: unknown) => void>();
        notifListeners.set(method, set);
        set.add(listener);
        return () => {
          set.delete(listener);
        };
      },
      onHostStatus(listener: (status: HostStatus) => void) {
        statusListeners.add(listener);
        listener(currentStatus);
        return () => {
          statusListeners.delete(listener);
        };
      },
      reconnectNow() {
        state.reconnectCalls += 1;
      },
    } satisfies RpcTransport,
    emitNotification(method: string, params: unknown) {
      for (const listener of [...(notifListeners.get(method) ?? [])]) {
        listener(params);
      }
    },
    setStatus(status: HostStatus) {
      currentStatus = status;
      for (const listener of [...statusListeners]) {
        listener(status);
      }
    },
  };
  return state;
}

function resetStores(): void {
  useAppStore.setState({
    runtimeId: null,
    runtimes: {},
    connection: "disconnected",
    hostStatus: "connected",
    cwd: "",
    sessionFile: null,
    sessionId: null,
    sessionName: null,
    messages: [],
    isStreaming: false,
    isCompacting: false,
    isSwitchingModel: false,
    retryStatus: null,
    stats: null,
    model: null,
    thinkingLevel: "medium",
    availableModels: [],
    availableThinkingLevels: [],
    commands: [],
    settings: null,
    git: null,
    sessions: [],
    sessionTree: [],
    sessionTreeLeafId: null,
    sessionTreeError: null,
    sessionTreeLoading: false,
    lastError: null,
    composerPrefill: null,
    managedFollowUpQueue: [],
    steeringQueue: [],
    followUpQueue: [],
    toasts: [],
    notifications: [],
    extensionRequest: null,
    extensionWidgets: {},
  });
  useWorkbenchStore.getState().resetForTest();
  useWorkbenchLayoutStore.getState().resetLayoutForTest();
  for (const id of Object.keys(getClientRenderErrors())) {
    clearClientRenderError(id, false);
  }
}

describe("ADR 0023 Phase 2: Frontend Cordis Service Mesh", () => {
  let root: Context;
  let contributionRegistry: ClientContributionRegistry;
  let mockRpc: ReturnType<typeof createMockRpcTransport>;

  beforeEach(async () => {
    resetStores();
    root = new Context();
    contributionRegistry = new ClientContributionRegistry();
    mockRpc = createMockRpcTransport();
    await registerFrontendServices(root, {
      contributionRegistry,
      shortcutTarget: null,
      rpcTransport: mockRpc.transport,
      onSwitchSession: () => undefined,
    });
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await root.fiber.dispose();
    resetStores();
  });

  it("mounts all frontend Cordis services and exposes clean non-Zustand APIs", async () => {
    let injectedAll = false;
    const consumer = await root.plugin({
      name: "mesh-consumer",
      inject: [...FRONTEND_SERVICE_NAMES],
      apply(ctx: Context) {
        for (const name of FRONTEND_SERVICE_NAMES) {
          const service = ctx.get(name) as Record<string, unknown> | undefined;
          expect(service).toBeDefined();
          // Ensure raw Zustand store methods are never exposed.
          expect(service?.setState).toBeUndefined();
          expect(service?.getState).toBeUndefined();
        }
        injectedAll = true;
      },
    });
    expect(injectedAll).toBe(true);
    await consumer.dispose();
  });

  it("supports sessionService active snapshots, multi-session retain ref-counting, isolation, and Fiber auto-release", async () => {
    const mainMsg: UiMessage = {
      id: "m-1",
      role: "user",
      content: "Main conversation message",
      timestamp: 1000,
    };
    const sideMsg: UiMessage = {
      id: "s-1",
      role: "user",
      content: "Side chat message",
      timestamp: 2000,
    };
    const modelA: ModelInfo = { id: "claude-sonnet", name: "Claude Sonnet", provider: "anthropic", reasoning: true };
    const modelB: ModelInfo = { id: "deepseek-r1", name: "DeepSeek R1", provider: "deepseek", reasoning: true };

    useAppStore.setState({
      cwd: "/repo/main",
      sessionId: "main-session",
      sessionFile: "harness:main-session",
      messages: [mainMsg],
      model: modelA,
      thinkingLevel: "high",
    });

    const serviceEvents: number[] = [];
    const subFiber = await root.plugin({
      name: "session-subscriber",
      inject: ["sessionService"],
      apply(ctx: Context) {
        ctx.sessionService.subscribe(() => {
          serviceEvents.push(ctx.sessionService.getSnapshot().messages.length);
        });
      },
    });

    expect(root.sessionService.getSnapshot().messages).toHaveLength(1);
    expect(root.sessionService.getSnapshot().permissionMode).toBe("ask");

    // Retain an isolated side-chat session from two separate plugin fibers.
    let sideHandle1: ReturnType<typeof root.sessionService.retain> | undefined;
    let sideHandle2: ReturnType<typeof root.sessionService.retain> | undefined;
    const sideUpdates: string[] = [];

    const sideFiber1 = await root.plugin({
      name: "side-panel-1",
      inject: ["sessionService"],
      apply(ctx: Context) {
        sideHandle1 = ctx.sessionService.retain("side-alpha", {
          isolated: true,
          cwd: "/repo/main",
          initialMessages: [sideMsg],
          permissionMode: "read-only",
          agentMode: "ask",
        });
        sideHandle1.subscribe(() => {
          sideUpdates.push(sideHandle1?.getSnapshot().model?.id ?? "none");
        });
      },
    });

    const sideFiber2 = await root.plugin({
      name: "side-panel-2",
      inject: ["sessionService"],
      apply(ctx: Context) {
        sideHandle2 = ctx.sessionService.retain("side-alpha", { isolated: true });
      },
    });

    expect(root.sessionService.getRetainCount("side-alpha", { isolated: true })).toBe(2);
    expect(sideHandle1?.getSnapshot().messages).toHaveLength(1);
    expect(sideHandle1?.getSnapshot().messages[0]?.content).toBe("Side chat message");
    expect(sideHandle2?.getSnapshot().messages[0]?.content).toBe("Side chat message");

    // Mutate isolated handle model & thinking level: must NOT affect main session or another isolated session.
    const otherSide = root.sessionService.retain("side-beta", { isolated: true, cwd: "/repo/main" });
    await sideHandle1?.setModel(modelB);
    await sideHandle1?.setThinkingLevel("xhigh");

    expect(sideHandle1?.getSnapshot().model?.id).toBe("deepseek-r1");
    expect(sideHandle2?.getSnapshot().model?.id).toBe("deepseek-r1");
    expect(sideHandle2?.getSnapshot().thinkingLevel).toBe("xhigh");
    expect(sideUpdates).toContain("deepseek-r1");
    expect(root.sessionService.getSnapshot().model?.id).toBe("claude-sonnet");
    expect(root.sessionService.getSnapshot().thinkingLevel).toBe("high");
    expect(otherSide.getSnapshot().model?.id).toBe("claude-sonnet");
    otherSide.release();

    // Disposing sideFiber1 drops refCount 2 -> 1; sideHandle2 stays alive.
    await sideFiber1.dispose();
    expect(sideHandle1?.released).toBe(true);
    expect(sideHandle2?.released).toBe(false);
    expect(root.sessionService.getRetainCount("side-alpha", { isolated: true })).toBe(1);

    // Disposing sideFiber2 drops refCount 1 -> 0 and cleans up pool entry.
    await sideFiber2.dispose();
    expect(sideHandle2?.released).toBe(true);
    expect(root.sessionService.getRetainCount("side-alpha", { isolated: true })).toBe(0);

    // Verify reactive subscription on main session and automatic disposal on Fiber unmount.
    useAppStore.setState({
      messages: [...useAppStore.getState().messages, { id: "m-2", role: "assistant", content: "hi", timestamp: 1100 }],
    });
    expect(serviceEvents).toEqual([2]);

    await subFiber.dispose();
    useAppStore.setState({
      messages: [...useAppStore.getState().messages, { id: "m-3", role: "user", content: "after dispose", timestamp: 1200 }],
    });
    expect(serviceEvents).toEqual([2]);
  });

  it("streams isolated session runtime events without polluting main session state", async () => {
    let runtimeListener: ((runtimeId: string, event: import("../src/lib/transcript").TranscriptEvent) => void) | undefined;
    vi.spyOn(harnessRuntimes, "subscribe").mockImplementation((listener) => {
      runtimeListener = listener;
      return () => {
        if (runtimeListener === listener) runtimeListener = undefined;
      };
    });
    const startSpy = vi.spyOn(harnessRuntimes, "start").mockResolvedValue({
      runtimeId: "harness:iso-rt-1",
      sessionLoaded: true,
      sessionForked: true,
    });
    const stateSpy = vi.spyOn(harnessRuntimes, "state").mockResolvedValue({
      sessionId: "iso-sid-1",
      sessionFile: "harness:iso-sid-1",
      isStreaming: false,
      isCompacting: false,
    });
    const modelsSpy = vi.spyOn(harnessRuntimes, "models").mockResolvedValue([]);
    const commandsSpy = vi.spyOn(harnessRuntimes, "commands").mockResolvedValue([]);
    const permSpy = vi.spyOn(harnessRuntimes, "setPermission").mockResolvedValue(undefined);
    const promptSpy = vi.spyOn(harnessRuntimes, "prompt").mockResolvedValue(undefined);
    const statsSpy = vi.spyOn(harnessRuntimes, "stats").mockResolvedValue({
      sessionId: "iso-sid-1",
      userMessages: 1,
      assistantMessages: 1,
      toolCalls: 1,
      toolResults: 1,
      totalMessages: 2,
      tokens: { input: 10, output: 20, cacheRead: 0, cacheWrite: 0, total: 30 },
      cost: 0,
    });
    const stopSpy = vi.spyOn(harnessRuntimes, "stop").mockResolvedValue(undefined);

    const handle = root.sessionService.retain("split-pane-1", {
      isolated: true,
      cwd: "/repo/split",
      parentSessionFile: "harness:parent-1",
    });

    const sent = await handle.sendMessage("Inspect this module");
    expect(sent).toBe(true);
    expect(startSpy).toHaveBeenCalledWith("/repo/split", "harness:parent-1", true);
    expect(stateSpy).toHaveBeenCalledWith("harness:iso-rt-1");
    expect(modelsSpy).toHaveBeenCalled();
    expect(commandsSpy).toHaveBeenCalledWith("/repo/split");
    expect(permSpy).toHaveBeenCalled();
    expect(promptSpy).toHaveBeenCalled();
    expect(handle.getSnapshot().messages).toHaveLength(1);
    expect(handle.getSnapshot().isStreaming).toBe(true);

    // Deliver live TranscriptEvents to the isolated runtime and verify real reducer behavior.
    runtimeListener?.("harness:iso-rt-1", { type: "turn-start" });
    runtimeListener?.("harness:iso-rt-1", { type: "assistant-start" });
    runtimeListener?.("harness:iso-rt-1", { type: "assistant-delta", text: "Hello ", thinking: "thinking..." });
    runtimeListener?.("harness:iso-rt-1", { type: "assistant-delta", text: "world", thinking: "" });
    runtimeListener?.("harness:iso-rt-1", {
      type: "tool-start",
      callId: "call-1",
      name: "read_file",
      args: { path: "src/index.ts" },
    });
    runtimeListener?.("harness:iso-rt-1", {
      type: "tool-end",
      callId: "call-1",
      name: "read_file",
      result: { text: "ok", isError: false, finishedAt: 1234 },
    });
    runtimeListener?.("harness:iso-rt-1", { type: "turn-end" });

    // Events for another runtime must be ignored by this isolated handle.
    runtimeListener?.("harness:other-rt", { type: "assistant-delta", text: "wrong", thinking: "" });

    const isoSnap = handle.getSnapshot();
    expect(isoSnap.isStreaming).toBe(false);
    expect(isoSnap.messages).toHaveLength(2);
    expect(isoSnap.messages[1]?.content).toBe("Hello world");
    expect(isoSnap.messages[1]?.thinking).toBe("thinking...");
    expect(isoSnap.messages[1]?.toolCalls?.[0]?.result).toBe("ok");
    expect(statsSpy).toHaveBeenCalledWith("harness:iso-rt-1");

    // Main session remains completely untouched.
    expect(root.sessionService.getSnapshot().messages).toHaveLength(0);
    expect(root.sessionService.getSnapshot().isStreaming).toBe(false);

    handle.release();
    expect(stopSpy).toHaveBeenCalledWith("harness:iso-rt-1");
  });

  it("delegates sessionService catalog operations (rename, archive, delete, refreshSessions)", async () => {
    const listSpy = vi.spyOn(agent, "listSessions").mockResolvedValue([
      { file: "harness:s-1", sessionId: "s-1", cwd: "/repo", name: "First", messageCount: 2 },
    ]);
    const renameSpy = vi.spyOn(agent, "renameSession").mockResolvedValue(undefined);
    const archiveSpy = vi.spyOn(agent, "archiveSession").mockResolvedValue(undefined);
    const deleteSpy = vi.spyOn(agent, "deleteSession").mockResolvedValue(undefined);

    await root.sessionService.refreshSessions();
    expect(listSpy).toHaveBeenCalled();
    expect(root.sessionService.listSessions()).toHaveLength(1);

    await root.sessionService.renameSession("Renamed", "harness:s-1");
    expect(renameSpy).toHaveBeenCalledWith("harness:s-1", "Renamed");

    await root.sessionService.archiveSession("harness:s-1");
    expect(archiveSpy).toHaveBeenCalledWith("harness:s-1");

    await root.sessionService.deleteSession("harness:s-1");
    expect(deleteSpy).toHaveBeenCalledWith("harness:s-1");
  });

  it("handles workspaceService selection, options deduplication, trust, git, and file operations", async () => {
    const snapshots: string[] = [];
    const unsub = root.workspaceService.subscribe(() => {
      snapshots.push(root.workspaceService.getSnapshot().cwd);
    });

    root.workspaceService.selectWorkspace("/repo/alpha");
    expect(root.workspaceService.getSnapshot().cwd).toBe("/repo/alpha");
    expect(root.workspaceService.getSnapshot().workspaceOptions).toEqual(["/repo/alpha"]);
    expect(snapshots).toEqual(["/repo/alpha"]);

    vi.spyOn(pluginClient, "trustList").mockResolvedValue({
      trusted: [{ path: "/repo/alpha", trustedAt: "2026-11-20T00:00:00Z" }],
      current: {
        workspace: "/repo/alpha",
        trusted: true,
        hasProjectPlugins: true,
        hasProjectConfig: false,
        pluginIds: ["local-ext"],
      },
    });
    const trust = await root.workspaceService.refreshTrust("/repo/alpha");
    expect(trust.trusted).toBe(true);
    expect(trust.pluginIds).toEqual(["local-ext"]);

    // Preserve trust banner metadata when Host canonicalizes symlinks or Windows 8.3 short paths.
    root.workspaceService.selectWorkspace("C:\\Users\\RUNNER~1\\AppData\\Local\\Temp\\ws");
    vi.spyOn(pluginClient, "trustList").mockResolvedValueOnce({
      trusted: [],
      current: {
        workspace: "C:\\Users\\runneradmin\\AppData\\Local\\Temp\\ws",
        trusted: false,
        hasProjectPlugins: true,
        hasProjectConfig: false,
        pluginIds: ["repo-local-ui"],
      },
    });
    await root.workspaceService.refreshTrust("C:\\Users\\RUNNER~1\\AppData\\Local\\Temp\\ws");
    expect(root.workspaceService.getSnapshot().trust.hasProjectPlugins).toBe(true);
    expect(root.workspaceService.getSnapshot().trust.pluginIds).toEqual(["repo-local-ui"]);
    root.workspaceService.selectWorkspace("/repo/alpha");

    const gitSnap = { isRepository: true, branch: "main", files: [], diff: "" };
    const gitSpy = vi.spyOn(agent, "gitSnapshot").mockResolvedValue(gitSnap);
    const restoreSpy = vi.spyOn(agent, "gitRestoreFiles").mockResolvedValue(undefined);
    const listSpy = vi.spyOn(agent, "listWorkspaceDir").mockResolvedValue([
      { name: "README.md", path: "README.md", isDir: false },
    ]);
    const readSpy = vi.spyOn(agent, "readWorkspaceFile").mockResolvedValue({
      path: "README.md",
      fileName: "README.md",
      text: "# Hello",
      truncated: false,
      isBinary: false,
      size: 7,
    });
    const fmSpy = vi.spyOn(agent, "openWorkspaceInFileManager").mockResolvedValue(undefined);

    await root.workspaceService.restoreGitFiles(["src/a.ts"], "/repo/alpha");
    expect(restoreSpy).toHaveBeenCalledWith("/repo/alpha", ["src/a.ts"]);
    expect(gitSpy).toHaveBeenCalledWith("/repo/alpha");
    expect(root.workspaceService.getSnapshot().git?.branch).toBe("main");

    expect(await root.workspaceService.listDir()).toHaveLength(1);
    expect(listSpy).toHaveBeenCalledWith("/repo/alpha", undefined);
    expect((await root.workspaceService.readFile("README.md")).text).toBe("# Hello");
    expect(readSpy).toHaveBeenCalledWith("/repo/alpha", "README.md");

    await root.workspaceService.openInFileManager();
    expect(fmSpy).toHaveBeenCalledWith("/repo/alpha");
    unsub();
  });

  it("manages per-session composer drafts, attachments, prefills, and Fiber-scoped slash/rewind registries", async () => {
    const updates: string[] = [];
    const unsub = root.composerService.subscribe(() => {
      updates.push(root.composerService.getSnapshot().draft);
    });

    root.composerService.setDraft("Main draft");
    root.composerService.setDraft("Side draft", "side-1");
    expect(root.composerService.getSnapshot().draft).toBe("Main draft");
    expect(root.composerService.getSnapshot("side-1").draft).toBe("Side draft");
    expect(updates).toContain("Main draft");

    root.composerService.prefill("Prefilled prompt");
    expect(root.composerService.getSnapshot().prefill).toBe("Prefilled prompt");
    expect(root.composerService.consumePrefill()).toBe("Prefilled prompt");
    expect(root.composerService.getSnapshot().prefill).toBeNull();

    root.composerService.prefill("Side prefill", "side-1");
    expect(root.composerService.getSnapshot().prefill).toBeNull();
    expect(root.composerService.consumePrefill("side-1")).toBe("Side prefill");

    const fileA: AttachmentPayload = {
      path: "/repo/a.ts",
      fileName: "a.ts",
      mimeType: "text/plain",
      size: 12,
      kind: "text",
      text: "const a = 1;",
    };
    root.composerService.addAttachments([fileA, fileA]);
    expect(root.composerService.getSnapshot().attachments).toHaveLength(1);
    root.composerService.removeAttachment("/repo/a.ts");
    expect(root.composerService.getSnapshot().attachments).toHaveLength(0);
    root.composerService.addAttachments([fileA]);
    root.composerService.clearAttachments();
    expect(root.composerService.getSnapshot().attachments).toHaveLength(0);

    // Slash interceptor & rewind handler auto-disposal on Fiber unmount.
    const pluginFiber = await root.plugin({
      name: "composer-ext",
      inject: ["composerService"],
      apply(ctx: Context) {
        ctx.composerService.registerSlashInterceptor({
          id: "hello-slash",
          onSlashCommand: (name) => name === "hello",
        });
        ctx.composerService.registerRewindHandler({
          id: "custom-rewind",
          onRewindMessage: (msg) => msg.id === "target-msg",
        });
      },
    });

    expect(await root.composerService.tryHandleSlashCommand("hello", "")).toBe(true);
    expect(await root.composerService.tryHandleSlashCommand("other", "")).toBe(false);
    expect(
      await root.composerService.tryHandleRewind({ id: "target-msg", role: "user", content: "hi", timestamp: 1 }),
    ).toBe(true);

    await pluginFiber.dispose();
    expect(await root.composerService.tryHandleSlashCommand("hello", "")).toBe(false);
    expect(root.composerService.hasRewindHandler()).toBe(false);
    unsub();
  });

  it("wraps workbenchService panes, tiling layout, inspector, bottom panel, terminal nonce, and openFile", async () => {
    const notifications: number[] = [];
    const unsub = root.workbenchService.subscribe(() => {
      notifications.push(root.workbenchService.getSnapshot().openPanes.length);
    });

    root.workbenchService.openPane("files");
    root.workbenchService.openPane("review");
    expect(root.workbenchService.getSnapshot().openPanes).toEqual(["files", "review"]);
    expect(root.workbenchService.getSnapshot().rightOpen).toBe(true);

    root.workbenchService.setTwoPaneDirection("horizontal");
    expect(root.workbenchService.getSnapshot().twoPaneDirection).toBe("horizontal");

    const tree = root.workbenchService.getSnapshot().layoutTree;
    expect(tree?.type).toBe("split");
    if (tree?.type === "split") {
      root.workbenchService.setSplitNodeRatio(tree.id, 0.35);
      const updated = root.workbenchService.getSnapshot().layoutTree;
      expect(updated?.type === "split" ? updated.ratio : null).toBeCloseTo(0.35, 2);
    }

    root.workbenchService.swapOrDockPanes("files", "review", "swap");
    expect(root.workbenchService.getSnapshot().openPanes).toEqual(["review", "files"]);

    root.workbenchService.toggleMaximizePane("review");
    expect(root.workbenchService.getSnapshot().maximizedPaneId).toBe("review");
    expect(root.workbenchService.getSnapshot().rightMaximized).toBe(true);

    root.workbenchService.toggleInspector();
    expect(root.workbenchService.getSnapshot().inspectorOpen).toBe(true);

    root.workbenchService.toggleBottom();
    expect(root.workbenchService.getSnapshot().bottomOpen).toBe(true);

    root.workbenchService.bumpTerminalCreateNonce();
    expect(root.workbenchService.getSnapshot().terminalCreateNonce).toBe(1);

    root.workbenchService.toggleFileDrawer();
    expect(root.workbenchService.getSnapshot().fileDrawerOpen).toBe(false);

    vi.spyOn(agent, "readWorkspaceFile").mockResolvedValue({
      path: "src/index.ts",
      fileName: "index.ts",
      text: "export {};",
      truncated: false,
      isBinary: false,
      size: 10,
    });
    await root.workbenchService.openFile("src/index.ts", { cwd: "/repo" });
    expect(root.workbenchService.getSnapshot().activeFile?.path).toBe("src/index.ts");
    expect(root.workbenchService.getSnapshot().activeFile?.content).toBe("export {};");

    root.workbenchService.closePane("review");
    expect(root.workbenchService.getSnapshot().openPanes).not.toContain("review");
    expect(notifications.length).toBeGreaterThan(0);
    unsub();
  });

  it("handles navigationService routes, history back/forward, settings, sidebar, toasts, and notifications", () => {
    const routes: string[] = [];
    const unsub = root.navigationService.subscribe(() => {
      routes.push(root.navigationService.getSnapshot().activeRoute.kind);
    });

    expect(root.navigationService.getSnapshot().activeRoute.kind).toBe("home");
    expect(root.navigationService.getSnapshot().draftMode).toBe(true);
    expect(root.navigationService.getSnapshot().canGoBack).toBe(false);

    root.navigationService.setHubView("plugins");
    expect(root.navigationService.getSnapshot().activeRoute).toEqual({ kind: "hub", view: "plugins" });
    expect(root.navigationService.getSnapshot().canGoBack).toBe(true);

    root.navigationService.openPluginPage("my-analytics");
    expect(root.navigationService.getSnapshot().activeRoute).toEqual({
      kind: "plugin-page",
      pageId: "my-analytics",
    });
    expect(root.navigationService.getSnapshot().hubView).toBe("plugin:my-analytics");

    expect(root.navigationService.goBack()).toBe(true);
    expect(root.navigationService.getSnapshot().activeRoute).toEqual({ kind: "hub", view: "plugins" });
    expect(root.navigationService.getSnapshot().canGoForward).toBe(true);

    expect(root.navigationService.goForward()).toBe(true);
    expect(root.navigationService.getSnapshot().activeRoute).toEqual({
      kind: "plugin-page",
      pageId: "my-analytics",
    });

    root.navigationService.openSettings("appearance");
    expect(root.navigationService.getSnapshot().settingsOpen).toBe(true);
    expect(root.navigationService.getSnapshot().settingsPage).toBe("appearance");

    // Re-opening the same active plugin page while Settings is open must close Settings and emit.
    const countBeforeSamePage = routes.length;
    expect(root.navigationService.openPluginPage("my-analytics")).toBe(true);
    expect(root.navigationService.getSnapshot().settingsOpen).toBe(false);
    expect(routes.length).toBe(countBeforeSamePage + 1);

    root.navigationService.openSettings("appearance");
    expect(root.navigationService.getSnapshot().settingsOpen).toBe(true);
    root.navigationService.closeSettings();
    expect(root.navigationService.getSnapshot().settingsOpen).toBe(false);

    root.navigationService.setSidebarWidth(300);
    expect(root.navigationService.getSnapshot().sidebarWidth).toBe(300);
    const prevVisible = root.navigationService.getSnapshot().sidebarVisible;
    root.navigationService.toggleSidebar();
    expect(root.navigationService.getSnapshot().sidebarVisible).toBe(!prevVisible);

    const prevWindow = (globalThis as Record<string, unknown>).window;
    const storageMap = new Map<string, string>();
    (globalThis as Record<string, unknown>).window = {
      setTimeout: globalThis.setTimeout.bind(globalThis),
      clearTimeout: globalThis.clearTimeout.bind(globalThis),
      localStorage: {
        getItem: (key: string) => storageMap.get(key) ?? null,
        setItem: (key: string, value: string) => { storageMap.set(key, value); },
        removeItem: (key: string) => { storageMap.delete(key); },
      },
    };
    try {
      root.navigationService.showToast("Saved", "success");
      expect(root.navigationService.getSnapshot().toasts).toHaveLength(1);
      const toastId = root.navigationService.getSnapshot().toasts[0]?.id ?? "";
      root.navigationService.dismissToast(toastId);
      expect(root.navigationService.getSnapshot().toasts).toHaveLength(0);

      useAppStore.getState().addNotification({
        id: "n-1",
        kind: "completion",
        title: "Done",
        body: "Task complete",
        cwd: "/repo",
        sessionFile: null,
      });
      expect(root.navigationService.getSnapshot().notifications).toHaveLength(1);
      root.navigationService.markAllNotificationsRead();
      expect(root.navigationService.getSnapshot().notifications).toHaveLength(0);
      expect(routes.length).toBeGreaterThan(0);
    } finally {
      if (prevWindow === undefined) delete (globalThis as Record<string, unknown>).window;
      else (globalThis as Record<string, unknown>).window = prevWindow;
    }
    unsub();
  });

  it("manages themeService catalog, custom plugin themes with Fiber disposal, density cycling, and UI scale", async () => {
    const schemeEvents: string[] = [];
    const unsub = root.themeService.subscribe(() => {
      schemeEvents.push(root.themeService.getSnapshot().resolvedScheme);
    });

    const themeFiber = await root.plugin({
      name: "ocean-theme",
      inject: ["themeService"],
      apply(ctx: Context) {
        ctx.themeService.registerTheme({
          id: "ocean-dark",
          label: "Ocean Dark",
          mode: "dark",
        });
      },
    });

    expect(root.themeService.getSnapshot().catalog.themes.some((t) => t.id === "ocean-dark")).toBe(true);
    await root.themeService.setTheme("ocean-dark");
    expect(root.themeService.getSnapshot().themeId).toBe("ocean-dark");
    expect(root.themeService.getSnapshot().resolvedScheme).toBe("dark");
    expect(schemeEvents).toContain("dark");

    expect(root.themeService.getSnapshot().transcriptDensity).toBe("normal");
    expect(await root.themeService.cycleTranscriptDensity()).toBe("verbose");
    expect(await root.themeService.cycleTranscriptDensity()).toBe("summary");

    await root.themeService.setUiScale(125);
    expect(root.themeService.getSnapshot().uiScale).toBe(125);
    expect(root.themeService.getSnapshot().resolvedScale).toBe(1.25);

    await root.themeService.setUiScale(999);
    expect(root.themeService.getSnapshot().uiScale).toBe(150);

    // Disposing plugin Fiber automatically unregisters its theme.
    await themeFiber.dispose();
    expect(root.themeService.getSnapshot().catalog.themes.some((t) => t.id === "ocean-dark")).toBe(false);
    unsub();
  });

  it("ignores legacy persisted settings.accentColor when applying palette tokens, applies font settings, and honors explicit setAccentColor", async () => {
    const styleProps = new Map<string, string>();
    const fakeRoot = {
      dataset: {} as Record<string, string>,
      style: {
        fontFamily: "",
        color: "",
        background: "",
        setProperty(name: string, value: string) {
          styleProps.set(name, value);
        },
        removeProperty(name: string) {
          styleProps.delete(name);
        },
      },
    };
    const originalDocument = globalThis.document;
    Object.defineProperty(globalThis, "document", {
      configurable: true,
      value: {
        documentElement: fakeRoot,
        getElementById: () => null,
      },
    });
    try {
      const currentSettings = useAppStore.getState().settings;
      useAppStore.setState({
        settings: {
          ...(currentSettings ?? {}),
          theme: "light",
          accentColor: "#111111",
          messageFontSize: 16,
          uiFont: "TestUI, sans-serif",
          codeFont: "TestMono, monospace",
        } as NonNullable<ReturnType<typeof useAppStore.getState>["settings"]>,
      });

      root.themeService.applyToDocument();
      expect(fakeRoot.dataset.theme).toBe("light");
      expect(styleProps.get("--qj-brand-primary")).toBe("#006ee4");
      expect(styleProps.get("--accent")).toBe("#006ee4");
      expect(styleProps.get("--accent-custom")).toBe("#006ee4");
      expect(styleProps.get("--qj-brand-contrast")).toBe("#ffffff");
      expect(styleProps.get("--dsh-content-font-size")).toBe("16px");
      expect(styleProps.get("--code-font")).toBe("TestMono, monospace");
      expect(fakeRoot.style.fontFamily).toBe("TestUI, sans-serif");

      await root.themeService.setAccentColor("#7c5cff");
      expect(styleProps.get("--qj-brand-primary")).toBe("#7c5cff");
      expect(styleProps.get("--accent")).toBe("#7c5cff");
      expect(styleProps.get("--accent-custom")).toBe("#7c5cff");

      await root.themeService.setAccentColor("");
      expect(styleProps.get("--qj-brand-primary")).toBe("#006ee4");
      expect(styleProps.get("--accent")).toBe("#006ee4");
    } finally {
      Object.defineProperty(globalThis, "document", {
        configurable: true,
        value: originalDocument,
      });
    }
  });

  it("enforces shortcutService priority, allowInEditable, when matcher, Safe Mode exclusion, and Fiber disposal", async () => {
    expect(isReservedShortcutChord("Ctrl+Shift+Alt+R")).toBe(true);
    expect(isReservedShortcutChord("Cmd+Alt+Shift+R")).toBe(true);
    expect(RESERVED_SAFE_MODE_CHORD).toBe("ctrl+alt+shift+r");

    const fired: string[] = [];
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);

    root.on("internal/plugin", (fiber: object) => {
      if ((fiber as { runtime?: { name?: string } }).runtime?.name === "shortcut-plugin") {
        tagFiberPluginId(fiber, "shortcut-plugin");
      }
    });

    const shortcutFiber = await root.plugin({
      name: "shortcut-plugin",
      inject: ["shortcutService"],
      apply(ctx: Context) {
        // Attempting to hijack Safe Mode chord must be refused.
        ctx.shortcutService.register({
          id: "hijack-safe-mode",
          key: "Ctrl+Shift+Alt+R",
          run: () => {
            fired.push("hijack");
          },
        });
        ctx.shortcutService.register({
          id: "low-prio",
          key: "Ctrl+K",
          priority: 1,
          allowInEditable: true,
          run: () => {
            fired.push("low");
          },
        });
        ctx.shortcutService.register({
          id: "high-prio-guarded",
          key: "Ctrl+K",
          priority: 10,
          allowInEditable: false,
          when: (sc) => sc.cwd === "/repo/allowed",
          run: () => {
            fired.push("high");
          },
        });
        ctx.shortcutService.register({
          id: "throwing-when",
          key: "Ctrl+K",
          priority: 20,
          when: () => {
            throw new Error("boom in when");
          },
          run: () => {
            fired.push("boom");
          },
        });
      },
    });

    expect(warnSpy).toHaveBeenCalled();
    expect(root.shortcutService.getSnapshot().shortcuts.some((s) => s.id === "hijack-safe-mode")).toBe(false);

    // Reserved Safe Mode event is never intercepted.
    const safeModeEvent = makeKeyEvent({ key: "r", code: "KeyR", ctrlKey: true, altKey: true, shiftKey: true });
    expect(root.shortcutService.dispatch(safeModeEvent)).toBe(false);
    expect(safeModeEvent.defaultPrevented).toBe(false);

    // Higher priority with matching context wins (throwing-when fails closed and falls through).
    useAppStore.setState({ cwd: "/repo/allowed" });
    const kEvent = makeKeyEvent({ key: "k", code: "KeyK", ctrlKey: true });
    expect(root.shortcutService.dispatch(kEvent)).toBe(true);
    expect(kEvent.defaultPrevented).toBe(true);
    expect(fired).toEqual(["high"]);
    expect(getClientRenderErrors()["shortcut-plugin"]?.failedSlots["shortcut:throwing-when"]).toBe("boom in when");

    // Inside editable element, high-prio (`allowInEditable: false`) is skipped and low-prio (`allowInEditable: true`) runs.
    const editableEvent = makeKeyEvent({ key: "k", code: "KeyK", ctrlKey: true, inEditable: true });
    expect(root.shortcutService.dispatch(editableEvent)).toBe(true);
    expect(fired).toEqual(["high", "low"]);

    // Fiber disposal removes all registered shortcuts.
    await shortcutFiber.dispose();
    expect(root.shortcutService.getSnapshot().shortcuts).toHaveLength(0);
    expect(root.shortcutService.dispatch(makeKeyEvent({ key: "k", code: "KeyK", ctrlKey: true }))).toBe(false);
    expect(errSpy).toHaveBeenCalled();
  });

  it("registers and guards menuService items across locations with Fiber auto-disposal", async () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const selected: string[] = [];

    root.on("internal/plugin", (fiber: object) => {
      if ((fiber as { runtime?: { name?: string } }).runtime?.name === "menu-plugin") {
        tagFiberPluginId(fiber, "menu-plugin");
      }
    });

    const menuFiber = await root.plugin({
      name: "menu-plugin",
      inject: ["menuService"],
      apply(ctx: Context) {
        ctx.menuService.register({
          id: "tools-good",
          location: "menubar.tools",
          label: "Run Lint",
          order: 10,
          onSelect: () => {
            selected.push("tools-good");
          },
        });
        ctx.menuService.register({
          id: "tools-throw-when",
          location: "menubar.tools",
          label: "Hidden Throw",
          when: () => {
            throw new Error("bad when");
          },
          onSelect: () => {
            selected.push("never");
          },
        });
        ctx.menuService.register({
          id: "tools-throw-disabled",
          location: "menubar.tools",
          label: "Disabled Throw",
          disabled: () => {
            throw new Error("bad disabled");
          },
          onSelect: () => {
            selected.push("never-disabled");
          },
        });
        ctx.menuService.register({
          id: "file-throw-select",
          location: "file.context",
          label: "Exploding Select",
          onSelect: async () => {
            throw new Error("bad select");
          },
        });
      },
    });

    expect(root.menuService.hasItems("menubar.tools")).toBe(true);
    expect(root.menuService.hasItems("menubar.file")).toBe(false);

    const wbCtx = { cwd: "/repo", sessionFile: null };
    const toolItems = root.menuService.getItems("menubar.tools", wbCtx);
    expect(toolItems.map((i) => i.id)).toEqual(["tools-good", "tools-throw-disabled"]);
    expect(toolItems[0]?.disabled).toBe(false);
    expect(toolItems[1]?.disabled).toBe(true);

    toolItems[0]?.select();
    toolItems[1]?.select(); // disabled -> no-op
    expect(selected).toEqual(["tools-good"]);

    const fileItems = root.menuService.getItems("file.context", {
      cwd: "/repo",
      sessionFile: null,
      path: "src/a.ts",
      absolutePath: "/repo/src/a.ts",
    });
    expect(fileItems).toHaveLength(1);
    const ok = await root.menuService.executeItem(fileItems[0].item, {
      cwd: "/repo",
      sessionFile: null,
      path: "src/a.ts",
      absolutePath: "/repo/src/a.ts",
    });
    expect(ok).toBe(false);
    expect(getClientRenderErrors()["menu-plugin"]?.failedSlots["menu:file-throw-select"]).toBe("bad select");
    expect(errSpy).toHaveBeenCalled();

    await menuFiber.dispose();
    expect(root.menuService.hasItems("menubar.tools")).toBe(false);
    expect(root.menuService.hasItems("file.context")).toBe(false);
  });

  it("handles rpcService calls, notifications, hostStatus updates, reconnects, and Fiber disposal", async () => {
    const res = await root.rpcService.call<{ method: string; params: Record<string, unknown> }>(
      "plugin.list",
      { workspace: "/repo" },
    );
    expect(res).toEqual({ method: "plugin.list", params: { workspace: "/repo" } });

    const received: unknown[] = [];
    let reconnectEvents = 0;

    const rpcFiber = await root.plugin({
      name: "rpc-listener",
      inject: ["rpcService"],
      apply(ctx: Context) {
        ctx.rpcService.onNotification("custom/ping", (payload) => {
          received.push(payload);
        });
        ctx.rpcService.onReconnect(() => {
          reconnectEvents += 1;
        });
      },
    });

    mockRpc.emitNotification("custom/ping", { n: 1 });
    expect(received).toEqual([{ n: 1 }]);

    mockRpc.setStatus("reconnecting");
    expect(root.rpcService.getSnapshot().hostStatus).toBe("reconnecting");
    expect(root.rpcService.getSnapshot().connected).toBe(false);

    mockRpc.setStatus("connected");
    expect(root.rpcService.getSnapshot().connected).toBe(true);
    expect(root.rpcService.getSnapshot().reconnectCount).toBe(1);
    expect(reconnectEvents).toBe(1);

    root.rpcService.reconnect();
    expect(mockRpc.reconnectCalls).toBe(1);

    await rpcFiber.dispose();
    mockRpc.emitNotification("custom/ping", { n: 2 });
    mockRpc.setStatus("reconnecting");
    mockRpc.setStatus("connected");
    expect(received).toEqual([{ n: 1 }]);
    expect(reconnectEvents).toBe(1);
  });

  it("supports localeService namespace fallback chains and resourcesService URI protocols with Fiber disposal", async () => {
    // LocaleService
    root.localeService.setLocale("zh-CN");
    root.localeService.registerNamespace("common", {
      "zh-CN": { save: "保存", greeting: "你好，{name}" },
      en: { save: "Save", cancel: "Cancel" },
    });

    const i18nFiber = await root.plugin({
      name: "i18n-plugin",
      inject: ["localeService"],
      apply(ctx: Context) {
        ctx.localeService.registerNamespace("editor", {
          "zh-CN": { title: "编辑器 ({{count}})" },
          en: { title: "Editor ({{count}})", onlyEn: "English Only" },
        });
      },
    });

    const t = root.localeService.bind("editor");
    expect(t("title", { count: 3 })).toBe("编辑器 (3)");
    expect(t("onlyEn")).toBe("English Only"); // fallback to fallbackLocale ("en") in namespace
    expect(t("save")).toBe("保存"); // fallback to "common" in current locale
    expect(t("cancel")).toBe("Cancel"); // fallback to "common" in fallbackLocale
    expect(t("missing.key")).toBe("missing.key"); // final fallback to key

    root.localeService.setLocale("en");
    expect(t("title", { count: 2 })).toBe("Editor (2)");
    expect(t("save")).toBe("Save");

    await i18nFiber.dispose();
    expect(t("title")).toBe("title"); // namespace disposed cleanly

    // ResourcesService
    let emitResource: ((value: string) => void) | undefined;
    const protocolFiber = await root.plugin({
      name: "resource-provider",
      inject: ["resourcesService"],
      apply(ctx: Context) {
        ctx.resourcesService.registerProtocol<string>("mem", {
          read: (_uri, parsed) => `read:${parsed.path}:${parsed.query.rev ?? "0"}`,
          subscribe: (_uri, listener) => {
            emitResource = listener;
            listener("initial");
            return () => {
              emitResource = undefined;
            };
          },
        });
      },
    });

    expect(root.resourcesService.hasProtocol("mem")).toBe(true);
    expect(await root.resourcesService.read<string>("mem://notes/a.md?rev=7")).toBe("read:notes/a.md:7");

    const observed: string[] = [];
    const subFiber = await root.plugin({
      name: "resource-subscriber",
      inject: ["resourcesService"],
      apply(ctx: Context) {
        ctx.resourcesService.subscribe<string>("mem://notes/a.md", (value) => {
          observed.push(value);
        });
      },
    });

    expect(observed).toEqual(["initial"]);
    emitResource?.("updated");
    expect(observed).toEqual(["initial", "updated"]);

    await subFiber.dispose();
    expect(emitResource).toBeUndefined();

    await protocolFiber.dispose();
    expect(root.resourcesService.hasProtocol("mem")).toBe(false);
    await expect(root.resourcesService.read("mem://notes/a.md")).rejects.toThrow(/未注册的资源协议/);
  });
});

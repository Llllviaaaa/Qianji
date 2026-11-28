/**
 * Comprehensive Frontend Microkernel & Studio UI Tests for Qianji Swarm v3
 * (`tests/test-swarm-dashboard.test.tsx`).
 */
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { Context } from "@deepseek-ai/cordis";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SwarmConfigGetResult, SwarmSnapshotResult, SwarmWorktreeDiffResult } from "@qianji/protocol";
import { ClientSlotsService, SessionArea, SlotHost, SlotKernelProvider, SlotRegistry, SlotRoot } from "@qianji/client-slots";
import { coreComposerPlugin } from "../src/builtin-plugins/core-composer";
import { coreConversationPlugin } from "../src/builtin-plugins/core-conversation";
import { coreHubsPlugin } from "../src/builtin-plugins/core-hubs";
import { coreSettingsPlugin } from "../src/builtin-plugins/core-settings";
import { coreShellPlugin } from "../src/builtin-plugins/core-shell";
import { coreSidebarPlugin } from "../src/builtin-plugins/core-sidebar";
import { coreWorkbenchPlugin, listRegisteredExtensionPaneIds, resolvePaneTitle } from "../src/builtin-plugins/core-workbench";
import { ComposerQueuedDrawer } from "../src/components/composer/ComposerBreadcrumbAndMenus";
import {
  applySwarmAlertNotification, applySwarmBoardNotification, applySwarmConfigPayload,
  applySwarmMemberDeltaNotification, applySwarmSnapshot, applyWorktreeDiff, jumpToBoardSeq,
  patchSwarmUi, resetSwarmStores, selectSwarmMember, SWARM_PLUGIN_ID, swarmBuiltinPlugin,
  swarmDataStore, SwarmMessageBoard, useSwarmController,
} from "../src/builtin-plugins/swarm";
import {
  extractBoardSeqRefs, isMilestoneDoneMessage, isMilestoneStallMessage,
  prepareBoardMarkdownBody, stripLeadingRecipientMentions, tokenizeBoardMessageText,
} from "../src/builtin-plugins/swarm/swarmLabels";
import { DEFAULT_BUILTIN_FEATURE_PLUGINS } from "../src/kernel/runtime/registerDefaultBuiltinPlugins";
import { installSessionScopeAdapter, registerFrontendServices, type HostStatus, type RpcTransport } from "../src/kernel/services";
import { ClientContributionRegistry } from "../src/lib/clientContributions";
import { bindClientRootContext } from "../src/sdk/rootContext";
import { useAppStore } from "../src/store";
import { useWorkbenchLayoutStore } from "../src/stores/workbenchLayoutStore";
import { useWorkbenchStore } from "../src/stores/workbenchStore";

function buildFixtureSnapshot(): SwarmSnapshotResult {
  const zeroUsage = { inputTokens: 8_000, outputTokens: 2_000, cacheReadTokens: 4_000, cacheWriteTokens: 1_000, totalTokens: 10_000 };
  return {
    run: {
      id: "swarm-alpha",
      title: "多智能体全栈重构",
      goal: "并行完成协议层、引擎层与蜂巢侧栏",
      cwd: "/workspace/qianji",
      coordinatorSessionId: "sess-coord-1",
      status: "running",
      stallTimeoutMs: 60_000,
      roleModels: { verifier: { provider: "openai", model: "gpt-5", effort: "high" } },
      plan: {
        goalTitle: "多智能体全栈重构",
        goalLine: "以最小四工具内核与结果主线替代繁琐看板",
        tasks: {
          "protocol-spec": "升级 swarm-methods 协议定义",
          "engine-worker": "实现门铃与主线合成引擎",
          "qa-verifier": "独立执行全量门禁验收",
        },
        threads: [
          { id: "th-proto", title: "协议契约收敛", goal: "冻结前后端共享 DTO 类型", members: ["protocol-spec"] },
          { id: "th-engine", title: "引擎与验收闭环", goal: "完成运行时状态推导并通过测试", members: ["engine-worker", "qa-verifier"] },
        ],
      },
      channels: [
        { name: "main", topic: "主频道", createdBy: "coordinator", archived: false, subscriberNames: ["coordinator", "protocol-spec", "engine-worker", "qa-verifier"], createdAt: 1_700_000_000_000 },
      ],
      totalUsage: { inputTokens: 48_000, outputTokens: 12_500, cacheReadTokens: 30_000, cacheWriteTokens: 4_000, totalTokens: 60_500 },
      totalCostUsd: 0.42,
      headSeq: 3,
      createdAt: 1_700_000_000_000,
      updatedAt: 1_700_000_050_000,
    },
    members: [
      {
        name: "coordinator", role: "coordinator", brief: "负责整体拆解与收敛", addedBy: "user", sessionId: "sess-coord-1",
        provider: "anthropic", model: "claude-opus-4-6", effort: "high", state: "working", killed: false, workspaceMode: "inherit",
        changedFileCount: 0, channels: ["main"], lastReadSeq: 3, lastActivityAt: 1_700_000_045_000, currentStep: "审阅主线进展并调度质检",
        usage: zeroUsage, estimatedCostUsd: 0.11,
      },
      {
        name: "protocol-spec", role: "planner", brief: "升级协议层契约", addedBy: "coordinator", sessionId: "sess-proto-1",
        provider: "anthropic", model: "inherit", state: "waiting", killed: false, workspaceMode: "inherit",
        changedFileCount: 0, channels: ["main"], lastReadSeq: 2, lastPostSeq: 1, completedAt: 1_700_000_020_000, lastActivityAt: 1_700_000_020_000,
        usage: zeroUsage, estimatedCostUsd: 0.05,
      },
      {
        name: "engine-worker", role: "worker", brief: "负责核心引擎与 Worktree 编码", addedBy: "coordinator", sessionId: "sess-worker-1",
        provider: "anthropic", model: "claude-sonnet-4-6", state: "working", killed: false, workspaceMode: "share",
        worktreePath: "/tmp/swarms/swarm-alpha/worktrees/engine-worker", branchName: "swarm/swarm-alpha/engine-worker",
        changedFileCount: 2, channels: ["main"], lastReadSeq: 2, lastPostSeq: 2, lastActivityAt: 1_700_000_048_000,
        currentTool: "edit_file", currentStep: "编辑 packages/swarm/src/service.ts",
        usage: { ...zeroUsage, totalTokens: 35_500 }, estimatedCostUsd: 0.24,
      },
      {
        name: "qa-verifier", role: "verifier", brief: "负责独立门禁验收", addedBy: "coordinator", sessionId: "sess-verifier-1",
        provider: "openai", model: "gpt-5", effort: "high", state: "waiting", killed: false, workspaceMode: "inherit",
        changedFileCount: 0, channels: ["main"], lastReadSeq: 3, parkedSinceSeq: 3, waitingOn: "engine-worker", lastActivityAt: 1_700_000_030_000,
        usage: zeroUsage, estimatedCostUsd: 0.07,
      },
      {
        name: "old-helper", role: "explorer", brief: "早期代码扫描", addedBy: "coordinator", sessionId: "sess-old-1",
        provider: "anthropic", model: "claude-haiku-4-5", state: "killed", killed: true, workspaceMode: "inherit",
        changedFileCount: 0, channels: ["main"], lastReadSeq: 1, lastActivityAt: 1_700_000_010_000,
        usage: zeroUsage, estimatedCostUsd: 0.01,
      },
    ],
    tasks: [],
    recentMessages: [
      {
        seq: 1, swarmId: "swarm-alpha", channel: "main", sender: "protocol-spec",
        text: "@coordinator [done] ### 协议层收敛汇报\n- 已冻结 `SwarmSnapshotResult` 契约\n- 保留 `@all` 字面示例\n```ts\nexport const READY = true;\n```",
        mentions: ["coordinator"], channelMentions: [], mentionAll: false, isDone: true, isStall: false, createdAt: 1_700_000_015_000,
      },
      {
        seq: 2, swarmId: "swarm-alpha", channel: "main", sender: "engine-worker",
        text: "@qa-verifier 核心主线即将完成，详见 #1 说明\n第一行\n第二行\n第三行\n第四行\n第五行\n第六行\n第七行长消息折叠验证",
        mentions: ["qa-verifier"], channelMentions: [], mentionAll: false, isDone: false, isStall: false, replyToSeq: 1, createdAt: 1_700_000_025_000,
      },
      {
        seq: 3, swarmId: "swarm-alpha", channel: "main", sender: "qa-verifier",
        text: "@engine-worker Worktree 分支可以开始跑单测了吗？",
        mentions: ["engine-worker"], channelMentions: [], mentionAll: false, isDone: false, isStall: false, createdAt: 1_700_000_035_000,
      },
      Object.assign(
        {
          seq: 5, swarmId: "swarm-alpha", channel: "main", sender: "coordinator",
          text: "@engine-worker 请在独立 Worktree 完成实现，验收通过后发送 @coordinator [done]",
          mentions: ["engine-worker"], channelMentions: [], mentionAll: false, isDone: true, isStall: false, createdAt: 1_700_000_038_000,
        },
        { kind: "brief" as const },
      ),
    ],
    alerts: [],
  };
}

function buildFixtureConfigResult(): SwarmConfigGetResult {
  return {
    globalConfig: {
      defaultWorkerModel: { provider: "anthropic", model: "claude-sonnet-4-6" },
      roleModels: {
        coordinator: { provider: "anthropic", model: "claude-opus-4-6", effort: "high" },
        explorer: { provider: "anthropic", model: "claude-haiku-4-5" },
        monitor: { provider: "anthropic", model: "claude-haiku-4-5" },
      },
    },
    sessionOverrides: { verifier: { provider: "openai", model: "gpt-5", effort: "high" } },
    availableModels: [
      { provider: "anthropic", providerName: "Anthropic", id: "claude-opus-4-6", name: "Claude Opus 4.6", reasoning: true },
      { provider: "anthropic", providerName: "Anthropic", id: "claude-sonnet-4-6", name: "Claude Sonnet 4.6", reasoning: true },
      { provider: "anthropic", providerName: "Anthropic", id: "claude-haiku-4-5", name: "Claude Haiku 4.5", reasoning: false },
      { provider: "openai", providerName: "OpenAI", id: "gpt-5", name: "GPT-5", reasoning: true },
    ],
  };
}

function createMockSwarmTransport(snapshot: SwarmSnapshotResult) {
  const notifListeners = new Map<string, Set<(params: unknown) => void>>();
  const fixtureCfg = buildFixtureConfigResult();
  const callSpy = vi.fn(async (method: string, params?: unknown) => {
    if (method === "swarm.list") return { swarms: [] };
    if (method === "swarm.get") return snapshot;
    if (method === "swarm.config.get") return fixtureCfg;
    if (method === "swarm.config.update") {
      const p = (params ?? {}) as { globalConfig?: SwarmConfigGetResult["globalConfig"]; sessionOverrides?: SwarmConfigGetResult["sessionOverrides"] };
      const hasOverrides = p.sessionOverrides !== undefined;
      const cleaned = hasOverrides && Object.keys(p.sessionOverrides ?? {}).length === 0 ? undefined : (hasOverrides ? p.sessionOverrides : fixtureCfg.sessionOverrides);
      return {
        globalConfig: p.globalConfig ?? fixtureCfg.globalConfig,
        ...(cleaned !== undefined ? { sessionOverrides: cleaned } : {}),
        snapshot: { ...snapshot, run: { ...snapshot.run, roleModels: cleaned } },
      };
    }
    return {};
  });
  const transport: RpcTransport = {
    call: <T,>(method: string, params?: unknown) => callSpy(method, params) as Promise<T>,
    onNotification(method: string, listener: (params: unknown) => void) {
      const set = notifListeners.get(method) ?? new Set<(params: unknown) => void>();
      notifListeners.set(method, set);
      set.add(listener);
      return () => set.delete(listener);
    },
    onHostStatus(listener: (status: HostStatus) => void) {
      listener("connected");
      return () => undefined;
    },
    reconnectNow() {},
  };
  return {
    transport, callSpy, fixtureCfg,
    emit(method: string, payload: unknown) { for (const fn of notifListeners.get(method) ?? []) fn(payload); },
  };
}

async function createSwarmTestHarness() {
  const snapshot = buildFixtureSnapshot();
  const mockRpc = createMockSwarmTransport(snapshot);
  const root = new Context();
  const registry = new SlotRegistry();
  const contribRegistry = new ClientContributionRegistry();

  await root.plugin(ClientSlotsService, registry);
  await registerFrontendServices(root, { shortcutTarget: null, rpcTransport: mockRpc.transport, contributionRegistry: contribRegistry });
  installSessionScopeAdapter(root);
  bindClientRootContext(root);

  const fibers = await Promise.all([
    root.plugin(coreShellPlugin), root.plugin(coreSidebarPlugin), root.plugin(coreHubsPlugin),
    root.plugin(coreWorkbenchPlugin), root.plugin(coreConversationPlugin), root.plugin(coreComposerPlugin),
    root.plugin(coreSettingsPlugin), root.plugin(swarmBuiltinPlugin),
  ]);

  return {
    root, registry, mockRpc, snapshot,
    renderShell: () => renderToStaticMarkup(createElement(SlotRoot, { registry, ctx: root })),
    dispose: async () => {
      for (const fiber of fibers.reverse()) await fiber.dispose();
      bindClientRootContext(undefined);
    },
  };
}

describe("Qianji Swarm v3 — Pure Shell Chrome, Unified Workbench Nav, Markdown Board & Honeycomb Studio UI", () => {
  const cleanups: Array<() => Promise<void>> = [];

  afterEach(async () => {
    resetSwarmStores();
    useWorkbenchLayoutStore.getState().resetLayoutForTest();
    useWorkbenchStore.getState().resetForTest();
    useAppStore.setState({ sessionId: null, sessionFile: null, cwd: "", sessions: [], messages: [], managedFollowUpQueue: [] });
    while (cleanups.length > 0) {
      const fn = cleanups.pop();
      if (fn) await fn();
    }
  });

  it("removes sidebar.sessionRow sub-chips, composer.toolbar 蜂群 button, and composer-queue 条待处理 bar", async () => {
    const found = DEFAULT_BUILTIN_FEATURE_PLUGINS.find((p) => p.id === SWARM_PLUGIN_ID);
    expect(found?.defaultEnabled).toBe(true);
    expect(resolvePaneTitle("swarm", [])).toBe("蜂群");

    // Legacy ComposerQueuedDrawer must also render nothing
    const legacyQueueHtml = renderToStaticMarkup(
      createElement(ComposerQueuedDrawer, {
        pendingCount: 2,
        queuedMessages: [{ id: "q1", text: "待处理指令", attachments: [], createdAt: 1 }],
        queueOpen: true,
        setQueueOpen: () => undefined,
      }),
    );
    expect(legacyQueueHtml).toBe("");

    const harness = await createSwarmTestHarness();
    cleanups.push(harness.dispose);

    for (const slot of [
      "hub.pages", "sidebar.nav", "sidebar.sessionRow", "composer.toolbar",
      "workbench.topbarControls", "conversation.header", "shell.statusbar", "composer.status",
    ] as const) {
      expect(harness.registry.getEntries(slot).some((e) => e.pluginId === SWARM_PLUGIN_ID)).toBe(false);
    }
    expect(harness.registry.getWrappers("sidebar.sessionRow").some((w) => w.pluginId === SWARM_PLUGIN_ID)).toBe(false);
    expect(listRegisteredExtensionPaneIds(harness.registry)).not.toContain("swarm");

    applySwarmSnapshot(harness.snapshot);
    useAppStore.setState({
      cwd: "/workspace/qianji", sessionId: "sess-coord-1", sessionFile: "harness:sess-coord-1",
      sessions: [
        { file: "harness:sess-coord-1", sessionId: "sess-coord-1", cwd: "/workspace/qianji", name: "蜂群会话", messageCount: 2 },
        { file: "harness:sess-normal-2", sessionId: "sess-normal-2", cwd: "/workspace/qianji", name: "普通对话", messageCount: 1 },
      ],
      messages: [{ id: "m1", role: "user", content: "/swarm 启动重构", timestamp: 1 }],
      managedFollowUpQueue: [{ id: "q1", text: "补充一条队列消息", attachments: [], createdAt: 1 }],
    });
    harness.root.navigationService.navigate({ kind: "session", cwd: "/workspace/qianji", file: "harness:sess-coord-1" }, { syncStore: false });

    const html = harness.renderShell();
    expect(html).not.toContain("swarm-session-chip-");
    expect(html).not.toContain('data-testid="swarm-composer-mode-toggle"');
    expect(html).not.toContain("composer-queue");
    expect(html).not.toContain("条待处理");
  });

  it("renders concentric SwarmLiveCapsule, native SwarmToolCallCard, and Right 摘要 card opening the swarm pane", async () => {
    const harness = await createSwarmTestHarness();
    cleanups.push(harness.dispose);

    useAppStore.setState({
      cwd: "/workspace/qianji", sessionId: "sess-coord-1", sessionFile: "harness:sess-coord-1",
      sessions: [
        { file: "harness:sess-coord-1", sessionId: "sess-coord-1", cwd: "/workspace/qianji", name: "主协调会话", messageCount: 2 },
        { file: "harness:sess-plain", sessionId: "sess-plain", cwd: "/workspace/qianji", name: "普通会话", messageCount: 1 },
      ],
      messages: [
        { id: "m-user-1", role: "user", content: "/swarm 启动重构", timestamp: 1_700_000_000_000 },
        { id: "m-asst-1", role: "assistant", content: "已派生专职工蜂并行推进。", timestamp: 1_700_000_010_000 },
      ],
    });
    applySwarmSnapshot(harness.snapshot);
    applySwarmConfigPayload(harness.mockRpc.fixtureCfg);
    harness.root.navigationService.navigate({ kind: "session", cwd: "/workspace/qianji", file: "harness:sess-coord-1" }, { syncStore: false });
    harness.root.workbenchService.openSummary("overview");

    const swarmHtml = harness.renderShell();
    expect(swarmHtml).toContain('data-testid="swarm-live-capsule"');
    expect(swarmHtml).toContain('data-queen="true"');
    expect(swarmHtml).toContain("1 名专职成员并行推进中，已完成 1/3 项");
    expect(swarmHtml).toContain("查看面板");
    expect(swarmHtml).not.toContain("查看蜂群 ›");
    expect(swarmHtml).toContain('data-testid="swarm-inspector-summary"');
    expect(swarmHtml).toContain('data-testid="swarm-open-pane-btn"');
    expect(swarmHtml).toContain('data-testid="swarm-summary-models-btn"');
    expect(swarmHtml).toContain("质检员: gpt-5 (high)");

    const readBoardCardHtml = renderToStaticMarkup(
      createElement(
        SlotKernelProvider,
        { registry: harness.registry, ctx: harness.root },
        createElement(
          SessionArea,
          { sessionId: "sess-coord-1" },
          createElement(SlotHost, {
            slotKey: "conversation.toolCall", kind: "keyed", scope: "session", routeKey: "read_board",
            props: { cwd: "/workspace/qianji", sessionFile: "harness:sess-coord-1", call: { id: "tc-rb", name: "read_board", args: { since: 3 } }, state: "ok" },
            registry: harness.registry, rootCtx: harness.root,
          }),
        ),
      ),
    );
    expect(readBoardCardHtml).toContain('data-testid="swarm-tool-call-read_board"');
    expect(readBoardCardHtml).toContain("读取消息板");
    expect(readBoardCardHtml).toContain("#3 之后");
    expect(readBoardCardHtml).toContain("打开面板");
    expect(readBoardCardHtml).not.toContain("dshc-file-link");

    harness.root.workbenchService.openPane("swarm");
    expect(harness.root.workbenchService.getSnapshot().openPanes).toContain("swarm");
    useAppStore.setState({ sessionId: "sess-plain", sessionFile: "harness:sess-plain" });
    expect(harness.root.workbenchService.getSnapshot().openPanes).not.toContain("swarm");
  });

  it("preserves 6-role Swarm Model Configuration in 设置 -> 模型与密钥 and In-Session Modal", async () => {
    const harness = await createSwarmTestHarness();
    cleanups.push(harness.dispose);
    applySwarmSnapshot(harness.snapshot);
    applySwarmConfigPayload({ ...harness.mockRpc.fixtureCfg, swarmId: "swarm-alpha" });

    const providersHtml = renderToStaticMarkup(
      createElement(
        SlotKernelProvider,
        { registry: harness.registry, ctx: harness.root },
        createElement(SlotHost, {
          slotKey: "settings.sections", kind: "list", scope: "root",
          props: { cwd: "/workspace/qianji", sessionFile: null, page: "providers", closeSettings: () => undefined },
          registry: harness.registry, rootCtx: harness.root,
        }),
      ),
    );
    expect(providersHtml).toContain('data-testid="swarm-settings-models-section"');
    for (const role of ["coordinator", "planner", "worker", "explorer", "verifier", "monitor"]) {
      expect(providersHtml).toContain(`data-testid="swarm-role-row-${role}"`);
    }

    useAppStore.setState({ cwd: "/workspace/qianji", sessionId: "sess-coord-1", sessionFile: "harness:sess-coord-1" });
    patchSwarmUi({ activeSwarmId: "swarm-alpha", roleModelsModalOpen: true, roleModelsModalScope: "session" });
    expect(harness.renderShell()).toContain('data-testid="swarm-role-models-modal"');

    let capturedCtrl: ReturnType<typeof useSwarmController> | null = null;
    function Probe() { capturedCtrl = useSwarmController(harness.root); return null; }
    renderToStaticMarkup(createElement(SlotKernelProvider, { registry: harness.registry, ctx: harness.root }, createElement(Probe)));
    if (capturedCtrl !== null) {
      const ctrl: ReturnType<typeof useSwarmController> = capturedCtrl;
      await ctrl.updateConfig({ swarmId: "swarm-alpha", sessionOverrides: {} });
      expect(swarmDataStore.get().sessionRoleOverridesBySwarmId["swarm-alpha"]).toEqual({});
    }
  });

  it("renders Unified Nav Bar, live coordinator/worker Overview, Markdown Board, Members Diff, and Honeycomb Hex Detail Card", async () => {
    expect(stripLeadingRecipientMentions("@qa-verifier [done] 契约就绪", ["qa-verifier"], false)).toBe("[done] 契约就绪");
    expect(prepareBoardMarkdownBody("@coordinator [done] ### 标题\n正文", ["coordinator"], false)).toBe("### 标题\n正文");
    expect(extractBoardSeqRefs("参见 #12 说明，忽略 `#99` 代码块", 2)).toEqual([12]);
    expect(
      isMilestoneDoneMessage({
        seq: 1, swarmId: "s", channel: "main", sender: "w", text: "@coordinator [done] 完成",
        mentions: ["coordinator"], channelMentions: [], mentionAll: false, isDone: true, isStall: false, createdAt: 1,
      }),
    ).toBe(true);
    expect(
      isMilestoneDoneMessage({
        seq: 2, swarmId: "s", channel: "main", sender: "coordinator", text: "@w 完成后回报 @coordinator [done]",
        mentions: ["w"], channelMentions: [], mentionAll: false, isDone: true, isStall: false, createdAt: 1, kind: "brief",
      }),
    ).toBe(false);
    expect(
      isMilestoneStallMessage({
        seq: 3, swarmId: "s", channel: "main", sender: "monitor", text: "@w [stall] #1 超时",
        mentions: ["w"], channelMentions: [], mentionAll: false, isDone: false, isStall: true, createdAt: 1,
      }),
    ).toBe(true);
    const segs = tokenizeBoardMessageText("[done] 请核验 #12 与 @qianji/protocol，通知 @qa-verifier，字面 `@coordinator` 不解析为唤醒");
    expect(segs.some((s) => s.kind === "seq" && s.seq === 12)).toBe(true);
    expect(segs.some((s) => s.kind === "mention" && s.target === "qa-verifier")).toBe(true);
    expect(segs.some((s) => s.kind === "mention" && s.target === "qianji")).toBe(false);

    const harness = await createSwarmTestHarness();
    cleanups.push(harness.dispose);
    useAppStore.setState({ cwd: "/workspace/qianji", sessionId: "sess-coord-1", sessionFile: "harness:sess-coord-1" });

    // Verify Coordinator-only early stage ALWAYS surfaces live @coordinator activity in 总览
    const coordOnlySnap: SwarmSnapshotResult = {
      ...harness.snapshot,
      run: { ...harness.snapshot.run, plan: undefined },
      members: [harness.snapshot.members[0] ?? {
        name: "coordinator", role: "coordinator", brief: "拆解", addedBy: "user", sessionId: "sess-coord-1",
        model: "claude-opus-4-6", state: "working", killed: false, workspaceMode: "inherit",
        changedFileCount: 0, channels: ["main"], lastReadSeq: 0, lastActivityAt: 1, currentStep: "正在扫描仓库结构与边界",
        usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, totalTokens: 0 }, estimatedCostUsd: 0,
      }],
    };
    applySwarmSnapshot(coordOnlySnap);
    harness.mockRpc.emit("swarm/open", { swarmId: "swarm-alpha", surface: "hub" });
    const earlyOverviewHtml = harness.renderShell();
    expect(earlyOverviewHtml).toContain('data-testid="swarm-workbench-navbar"');
    expect(earlyOverviewHtml).toContain('data-testid="swarm-running-row-coordinator"');
    expect(earlyOverviewHtml).toContain("审阅主线进展并调度质检");
    expect(earlyOverviewHtml).toContain('data-testid="swarm-starting-empty"');
    expect(earlyOverviewHtml).not.toContain(">GOAL<");

    // Full multi-worker snapshot
    applySwarmSnapshot(harness.snapshot);
    applySwarmConfigPayload(harness.mockRpc.fixtureCfg);
    const overviewHtml = harness.renderShell();
    expect(overviewHtml).toContain('data-testid="swarm-workbench-pane"');
    expect(overviewHtml).toContain('data-testid="swarm-status-capsule"');
    expect(overviewHtml).not.toContain("qj-swarm-pane-title-row");
    expect(overviewHtml).toContain('data-testid="swarm-masthead-ratio"');
    expect(overviewHtml).toContain("以最小四工具内核与结果主线替代繁琐看板");
    expect(overviewHtml).toContain('data-testid="swarm-dirty-worktree-bar"');
    expect(overviewHtml).toContain("2 处独立工作区变更待合并");
    expect(overviewHtml).toContain('data-testid="swarm-review-changes-btn"');
    expect(overviewHtml).toContain("编辑 packages/swarm/src/service.ts");
    expect(overviewHtml).toContain("已完成 1 / 3 项");
    expect(overviewHtml.indexOf('data-testid="swarm-outcome-thread-th-engine"')).toBeLessThan(
      overviewHtml.indexOf('data-testid="swarm-outcome-thread-th-proto"'),
    );
    expect(overviewHtml).toContain('data-testid="swarm-bee-filter-strip"');

    applySwarmAlertNotification({
      swarmId: "swarm-alpha",
      alert: { id: "a1", swarmId: "swarm-alpha", kind: "stall", severity: "warning", memberName: "engine-worker", message: "响应超时 #2", resolved: false, createdAt: 10 },
    });
    expect(harness.renderShell()).toContain('data-testid="swarm-alert-banner"');

    // Tab 2: Rich Markdown Board + Timeline Spine + #seq Jump + Smart Collapse
    const handledBoard = await harness.root.composerService.tryHandleSlashCommand("swarm", "board", { cwd: "/workspace/qianji", sessionFile: "harness:sess-coord-1" });
    expect(handledBoard).toBe(true);
    patchSwarmUi({ highlightedSeq: null });
    const boardHtml = harness.renderShell();
    expect(boardHtml).toContain('data-testid="swarm-message-board"');
    expect(boardHtml).toContain("qj-swarm-msg-spine");
    expect(boardHtml).toContain('data-testid="swarm-msg-done-1"');
    expect(boardHtml).not.toContain('data-testid="swarm-msg-done-5"');
    expect(boardHtml).toContain("<h3>协议层收敛汇报</h3>");
    expect(boardHtml).toContain('data-testid="swarm-seq-jump-1"');
    expect(boardHtml).toContain('data-testid="swarm-msg-expand-2"');
    expect(boardHtml).toContain("展开完整内容");
    expect(boardHtml).not.toContain('data-testid="swarm-board-mention-bar"');
    expect(boardHtml).toContain("向成员发送协调指令…");

    // Verify contextual @mention autocomplete chips when typing `@en`
    const mentionAutocompleteHtml = renderToStaticMarkup(
      createElement(
        SlotKernelProvider,
        { registry: harness.registry, ctx: harness.root },
        createElement(SwarmMessageBoard, { snapshot: harness.snapshot, ctx: harness.root, initialDraft: "@en" }),
      ),
    );
    expect(mentionAutocompleteHtml).toContain('data-testid="swarm-board-mention-bar"');
    expect(mentionAutocompleteHtml).toContain('data-testid="swarm-mention-chip-engine-worker"');
    expect(mentionAutocompleteHtml).not.toContain('data-testid="swarm-mention-chip-qa-verifier"');

    jumpToBoardSeq(2, "main");
    expect(harness.renderShell()).toContain('data-highlighted="true"');

    // Tab 3: Members + Line-Numbered Unified Diff
    patchSwarmUi({ workbenchTab: "members", selectedMemberName: null });
    const membersHtml = harness.renderShell();
    expect(membersHtml).toContain('data-testid="swarm-members-tab"');
    expect(membersHtml).toContain("待命休眠");
    expect(membersHtml).toContain("0 Token");
    expect(membersHtml).toContain("已退役 1");
    expect(membersHtml).not.toContain(">inherit<");
    expect(membersHtml).toContain("+2 变更");

    selectSwarmMember("engine-worker", { inspectorTab: "diff" });
    const diffFixture: SwarmWorktreeDiffResult = {
      swarmId: "swarm-alpha", memberName: "engine-worker", workspaceMode: "share",
      worktreePath: "/tmp/swarms/swarm-alpha/worktrees/engine-worker", branchName: "swarm/swarm-alpha/engine-worker",
      empty: false, changedFiles: ["packages/swarm/src/service.ts"], diffText: "@@ -10,2 +10,3 @@\n-const oldVal = 1;\n+const newVal = 2;",
    };
    applyWorktreeDiff(diffFixture);
    const detailHtml = harness.renderShell();
    expect(detailHtml).toContain('data-testid="swarm-member-detail"');
    expect(detailHtml).toContain('data-testid="swarm-member-back-btn"');
    expect(detailHtml).toContain('data-testid="swarm-member-model-select"');
    expect(detailHtml).toContain("合并变更 (2)");
    expect(detailHtml).toContain("qj-swarm-diff-gutter");

    // Tab 4: Honeycomb Hex Map + Selected Hex Workstream Detail Card + Step-Back/Forward Scrubber
    const targetWorker = harness.snapshot.members[2];
    if (targetWorker !== undefined) {
      applySwarmMemberDeltaNotification({ swarmId: "swarm-alpha", member: { ...targetWorker, changedFileCount: 3 } });
    }
    applySwarmBoardNotification({
      swarmId: "swarm-alpha", headSeq: 4, wokenMembers: ["coordinator"],
      message: { seq: 4, swarmId: "swarm-alpha", channel: "main", sender: "qa-verifier", text: "@coordinator [done] 全部门禁通过", mentions: ["coordinator"], channelMentions: [], mentionAll: false, isDone: true, isStall: false, createdAt: 1_700_000_060_000 },
    });
    patchSwarmUi({ workbenchTab: "hive", selectedMemberName: null, hiveMode: "hex", selectedHexThreadId: "th-engine" });
    const hiveHexHtml = harness.renderShell();
    expect(hiveHexHtml).toContain('data-testid="swarm-hive-tab"');
    expect(hiveHexHtml).toContain('data-testid="swarm-honeycomb-svg-wrap"');
    expect(hiveHexHtml).toContain('data-testid="swarm-hive-step-back"');
    expect(hiveHexHtml).toContain('data-testid="swarm-hive-step-forward"');
    expect(hiveHexHtml).toContain('data-testid="swarm-hex-detail-card"');
    expect(hiveHexHtml).toContain('data-testid="swarm-hex-member-engine-worker"');
    expect(hiveHexHtml).toContain('data-testid="swarm-hex-member-qa-verifier"');
    expect(hiveHexHtml).toContain("+3 变更");
    expect(hiveHexHtml).toContain('data-testid="swarm-hive-seq-caption"');
    expect(hiveHexHtml).not.toContain("@engine-worker 请在独立 Worktree");

    patchSwarmUi({ hiveMode: "mentions" });
    expect(harness.renderShell()).toContain('data-testid="swarm-mentions-graph"');
  });
});

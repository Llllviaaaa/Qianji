import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { Context } from "@deepseek-ai/cordis";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  CORE_HOME_PLUGIN_ID,
  coreHomePlugin,
} from "../src/builtin-plugins/core-home";
import {
  CORE_HUBS_PLUGIN_ID,
  coreHubsPlugin,
} from "../src/builtin-plugins/core-hubs";
import {
  CORE_SHELL_PLUGIN_ID,
  coreShellPlugin,
} from "../src/builtin-plugins/core-shell";
import {
  CORE_SIDEBAR_PLUGIN_ID,
  coreSidebarPlugin,
} from "../src/builtin-plugins/core-sidebar";
import {
  registerFrontendServices,
  type HostStatus,
  type RpcTransport,
} from "../src/kernel/services";
import {
  AbdicationTracker,
  ClientSlotsService,
  SlotKernelErrorBoundary,
  SlotRegistry,
  SlotRoot,
} from "../src/kernel/slots";
import { SlotStoreRegistry } from "../src/kernel/store";
import { clientContributions } from "../src/lib/clientContributions";
import { useAppStore } from "../src/store";
import { useWorkbenchLayoutStore } from "../src/stores/workbenchLayoutStore";
import { useWorkbenchStore } from "../src/stores/workbenchStore";
import type { SessionInfo } from "../src/types";

function createMockRpcTransport() {
  let status: HostStatus = "connected";
  const statusListeners = new Set<(next: HostStatus) => void>();
  const notifListeners = new Map<string, Set<(params: unknown) => void>>();
  const callSpy = vi.fn(async (method: string) => {
    if (method === "schedule.list") return { tasks: [] };
    if (method === "schedule.runs") return { runs: [] };
    if (method === "plugin.list") return { plugins: [] };
    return {};
  });

  const transport: RpcTransport = {
    call<T>(method: string) {
      return callSpy(method) as Promise<T>;
    },
    onNotification(method: string, listener: (params: unknown) => void) {
      const set = notifListeners.get(method) ?? new Set<(params: unknown) => void>();
      notifListeners.set(method, set);
      set.add(listener);
      return () => {
        set.delete(listener);
      };
    },
    onHostStatus(listener: (next: HostStatus) => void) {
      statusListeners.add(listener);
      listener(status);
      return () => {
        statusListeners.delete(listener);
      };
    },
    reconnectNow() {
      // No-op in unit tests.
    },
  };

  return {
    transport,
    callSpy,
    setStatus(next: HostStatus) {
      status = next;
      for (const listener of [...statusListeners]) listener(next);
    },
  };
}

function makeKeyEvent(init: {
  key: string;
  ctrlKey?: boolean;
  altKey?: boolean;
  shiftKey?: boolean;
}): KeyboardEvent {
  const event = new Event("keydown", { cancelable: true }) as KeyboardEvent;
  const target = { closest: () => null };
  Object.defineProperty(event, "target", { value: target, configurable: true });
  Object.assign(event, {
    key: init.key,
    code: "",
    ctrlKey: init.ctrlKey ?? false,
    metaKey: false,
    altKey: init.altKey ?? false,
    shiftKey: init.shiftKey ?? false,
    isComposing: false,
  });
  return event;
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
    thinkingLevel: "off",
    availableModels: [],
    availableThinkingLevels: [],
    commands: [],
    sessions: [],
    sessionTree: [],
    sessionTreeLeafId: null,
    sessionTreeLoading: false,
    sessionTreeError: null,
    lastError: null,
    git: null,
    settings: null,
    toasts: [],
    notifications: [],
    extensionRequest: null,
    extensionWidgets: {},
    composerPrefill: null,
    managedFollowUpQueue: [],
    steeringQueue: [],
    followUpQueue: [],
  });
  useWorkbenchStore.setState({
    rightOpen: false,
    rightMaximized: false,
    bottomOpen: false,
    activeBottomTab: "terminal",
    activeTab: "files",
    openFiles: [],
    activeFilePath: null,
    activeFileCwd: null,
  });
  useWorkbenchLayoutStore.setState({
    inspectorOpen: false,
    openPanes: [],
    layoutTree: null,
    maximizedPaneId: null,
    fileDrawerOpen: false,
  });
}

async function mountCoreShellNavStack() {
  const root = new Context();
  const abdication = new AbdicationTracker({
    getCycle: () => ({ etag: "test-etag", configKey: "{}", reloadEpoch: 0 }),
    recordError: () => undefined,
    getLockout: () => ({ locked: false }),
    subscribeErrors: () => () => undefined,
  });
  const registry = new SlotRegistry({
    abdication,
    stores: new SlotStoreRegistry(),
  });
  const rpc = createMockRpcTransport();

  await root.plugin(ClientSlotsService, registry);
  await registerFrontendServices(root, {
    shortcutTarget: null,
    rpcTransport: rpc.transport,
    onSwitchSession: () => undefined,
  });

  const shellFiber = root.plugin(coreShellPlugin);
  const sidebarFiber = root.plugin(coreSidebarPlugin);
  const homeFiber = root.plugin(coreHomePlugin);
  const hubsFiber = root.plugin(coreHubsPlugin);
  await Promise.all([shellFiber, sidebarFiber, homeFiber, hubsFiber]);

  const renderApp = (props?: Record<string, unknown>) =>
    renderToStaticMarkup(createElement(SlotRoot, { registry, ctx: root, props }));

  return {
    root,
    registry,
    abdication,
    rpc,
    fibers: { shellFiber, sidebarFiber, homeFiber, hubsFiber },
    renderApp,
    async dispose() {
      await Promise.all([
        hubsFiber.dispose(),
        homeFiber.dispose(),
        sidebarFiber.dispose(),
        shellFiber.dispose(),
      ]);
      registry.dispose();
    },
  };
}

describe("ADR 0023 Wave 2B built-in core-shell / core-sidebar / core-home / core-hubs", () => {
  const cleanups: Array<() => Promise<void> | void> = [];
  const prevWindow = globalThis.window;

  beforeEach(() => {
    const storage = new Map<string, string>();
    const pendingTimers: ReturnType<typeof setTimeout>[] = [];
    const mockWindow = {
      innerWidth: 1440,
      setTimeout: (fn: () => void, ms?: number) => {
        const timer = globalThis.setTimeout(fn, ms);
        pendingTimers.push(timer);
        return timer as unknown as number;
      },
      clearTimeout: (id: number) => {
        globalThis.clearTimeout(id as unknown as ReturnType<typeof setTimeout>);
      },
      localStorage: {
        getItem: (key: string) => storage.get(key) ?? null,
        setItem: (key: string, value: string) => {
          storage.set(key, value);
        },
        removeItem: (key: string) => {
          storage.delete(key);
        },
      },
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
      dispatchEvent: () => true,
    };
    (globalThis as Record<string, unknown>).window = mockWindow;
    cleanups.push(() => {
      for (const timer of pendingTimers) globalThis.clearTimeout(timer);
    });
    resetStores();
  });

  afterEach(async () => {
    while (cleanups.length > 0) {
      const fn = cleanups.pop();
      if (fn !== undefined) await fn();
    }
    if (prevWindow === undefined) {
      delete (globalThis as Record<string, unknown>).window;
    } else {
      globalThis.window = prevWindow;
    }
    resetStores();
  });

  it("mounts all 4 core plugins onto a real Cordis root and renders full desktop shell, sidebar, and home", async () => {
    const stack = await mountCoreShellNavStack();
    cleanups.push(() => stack.dispose());

    expect(CORE_SHELL_PLUGIN_ID).toBe("core-shell");
    expect(CORE_SIDEBAR_PLUGIN_ID).toBe("core-sidebar");
    expect(CORE_HOME_PLUGIN_ID).toBe("core-home");
    expect(CORE_HUBS_PLUGIN_ID).toBe("core-hubs");

    const html = stack.renderApp();
    // Shell chrome & structural classes
    expect(html).toContain('class="app-shell codex-shot"');
    expect(html).toContain('class="window-menubar"');
    expect(html).toContain('class="workspace-shell"');
    expect(html).toContain('class="sidebar-resizer"');
    expect(html).toContain('class="work-surface"');
    expect(html).toContain('class="work-body"');
    expect(html).toContain('class="main-stage"');
    expect(html).toContain('class="client-plugin-overlay-slot"');
    expect(html).toContain("pointer-events:none");
    expect(html).toContain('class="toast-stack"');

    // Sidebar chrome
    expect(html).toContain('class="sidebar codex-sidebar"');
    expect(html).toContain('data-slot="sidebar"');
    expect(html).toContain("千机");
    expect(html).toContain("新会话");
    expect(html).toContain("定时任务");
    expect(html).toContain("扩展插件");
    expect(html).toContain("设置");

    // Home view default
    expect(html).toContain("new-task-screen");
    expect(html).toContain("接下来聊些什么？");
    expect(html).toContain("dsh-claude-home-composer-wrap");

    // Workspace-specific headline when cwd is selected
    stack.root.workspaceService.selectWorkspace("/projects/alpha-repo");
    const withWorkspaceHtml = stack.renderApp();
    expect(withWorkspaceHtml).toContain("接下来在 alpha-repo 做什么？");

    // Inspect declared core slot tree
    const slotKeys = new Set(stack.registry.inspectAllSlots().map((item) => item.slotKey));
    for (const expectedSlot of [
      "root",
      "shell.menubar",
      "shell.sidebar",
      "shell.topbar",
      "shell.stage",
      "shell.workbench.right",
      "shell.workbench.bottom",
      "shell.statusbar",
      "shell.overlays",
      "shell.modals",
      "sidebar.header",
      "sidebar.nav",
      "sidebar.threads",
      "sidebar.sessionRow",
      "sidebar.sections",
      "sidebar.footer",
      "home.hero",
      "home.quickActions",
      "home.sections",
      "hub.pages",
      "workbench.topbarControls",
    ]) {
      expect(slotKeys.has(expectedSlot)).toBe(true);
    }
  });

  it("renders sidebar threads, plugin nav overflow, leftSidebar sections, and home quickActions/composer.main", async () => {
    const stack = await mountCoreShellNavStack();
    cleanups.push(() => stack.dispose());

    const sampleSessions: SessionInfo[] = [
      {
        file: "harness:s1",
        sessionId: "s1",
        cwd: "/work/qianji",
        name: "重构前端微内核",
        firstMessage: "重构前端微内核",
        messageCount: 4,
        updatedAt: Date.now(),
      },
      {
        file: "harness:s2",
        sessionId: "s2",
        cwd: "/work/docs",
        name: "撰写 ADR 0023",
        firstMessage: "撰写 ADR 0023",
        messageCount: 2,
        updatedAt: Date.now() - 60_000,
      },
    ];
    useAppStore.setState({ sessions: sampleSessions, cwd: "/work/qianji" });

    // Register 4 legacy plugin pages to verify SidebarPluginNavItems overflow collapse ("更多扩展 (2)")
    const disposePages = [1, 2, 3, 4].map((num) =>
      clientContributions.registerPage({
        id: `ext-page-${num}`,
        pluginId: `ext-${num}`,
        label: `扩展页 ${num}`,
        render: () => createElement("div", null, `Legacy Page ${num}`),
      }),
    );
    const disposeLegacySidebar = clientContributions.registerLeftSidebar({
      id: "legacy-sidebar-widget",
      pluginId: "demo-plugin",
      render: () => createElement("div", null, "Legacy Sidebar Widget"),
    });
    const disposeLegacyQuick = clientContributions.registerHomeQuickAction({
      id: "legacy-quick-starter",
      pluginId: "demo-plugin",
      label: "运行巡检脚本",
      prompt: "/audit",
    });
    cleanups.push(() => {
      for (const off of disposePages) off();
      disposeLegacySidebar();
      disposeLegacyQuick();
    });

    // Register typed slots onto sidebar.sections, home.quickActions, home.sections, composer.main
    const offTypedSection = stack.registry.register("sidebar.sections", {
      id: "typed-sidebar-sec",
      pluginId: "typed-ext",
      tier: "user",
      component: () => createElement("div", null, "Typed Sidebar Section"),
    });
    const offTypedQuick = stack.registry.register("home.quickActions", {
      id: "typed-quick-action",
      pluginId: "typed-ext",
      tier: "user",
      component: () => createElement("button", { type: "button" }, "Typed Quick Starter"),
    });
    const offTypedHomeSec = stack.registry.register("home.sections", {
      id: "typed-home-sec",
      pluginId: "typed-ext",
      tier: "user",
      component: () => createElement("section", null, "Typed Home Extra Section"),
    });
    const offComposer = stack.registry.register("composer.main", {
      id: "test-composer-main",
      pluginId: "core-composer",
      tier: "builtin",
      select: () => true,
      component: ({ variant }) => createElement("div", { "data-testid": "composer-outlet" }, `composer:${String(variant)}`),
    });
    cleanups.push(() => {
      offTypedSection();
      offTypedQuick();
      offTypedHomeSec();
      offComposer();
    });

    const html = stack.renderApp();
    expect(html).toContain("重构前端微内核");
    expect(html).toContain("撰写 ADR 0023");
    expect(html).toContain("扩展页 1");
    expect(html).toContain("扩展页 2");
    expect(html).toContain("更多扩展 (2)");
    expect(html).toContain('data-slot="sidebar-plugins"');
    expect(html).toContain("Typed Sidebar Section");
    expect(html).toContain("Legacy Sidebar Widget");
    expect(html).toContain("dsh-home-starters");
    expect(html).toContain("运行巡检脚本");
    expect(html).toContain("Typed Quick Starter");
    expect(html).toContain("Typed Home Extra Section");
    expect(html).toContain("composer:task-start");
  });

  it("routes hub views (scheduled, plugins, keyed hub.pages, legacy plugin pages) and active thread topbar/statusbar/overlays", async () => {
    const stack = await mountCoreShellNavStack();
    cleanups.push(() => stack.dispose());

    // Scheduled hub
    stack.root.navigationService.setHubView("scheduled");
    const scheduledHtml = stack.renderApp();
    expect(scheduledHtml).toContain('data-hub-page="scheduled"');
    expect(scheduledHtml).toContain("新建定时任务");
    expect(scheduledHtml).not.toContain("new-task-screen");

    // Plugins hub
    stack.root.navigationService.setHubView("plugins");
    const pluginsHtml = stack.renderApp();
    expect(pluginsHtml).toContain('class="plugins-hub-page"');
    expect(pluginsHtml).toContain("槽位接管");

    // Keyed hub.pages plugin page
    const offCustomHub = stack.registry.register("hub.pages", {
      id: "custom-analytics-page",
      pluginId: "analytics-plugin",
      tier: "user",
      key: "analytics",
      component: ({ pageId }) => createElement("article", null, `Analytics Hub:${pageId}`),
    });
    cleanups.push(offCustomHub);

    stack.root.navigationService.openPluginPage("analytics");
    const keyedPageHtml = stack.renderApp();
    expect(keyedPageHtml).toContain('class="pid-plugin-page-stage"');
    expect(keyedPageHtml).toContain("Analytics Hub:analytics");

    // Legacy contributions.pages resolution
    const offLegacyPage = clientContributions.registerPage({
      id: "legacy-notes",
      pluginId: "notes-plugin",
      label: "笔记",
      render: ({ cwd }) => createElement("section", null, `Legacy Notes Page (${cwd})`),
    });
    cleanups.push(offLegacyPage);

    useAppStore.setState({ cwd: "/repo/notes" });
    stack.root.navigationService.openPluginPage("legacy-notes");
    const legacyPageHtml = stack.renderApp();
    expect(legacyPageHtml).toContain("Legacy Notes Page (/repo/notes)");

    // Active session view + topbar + workbench.topbarControls + statusbar + overlays + modals + host banner + toast
    const offStatus = stack.registry.register("shell.statusbar", {
      id: "test-status",
      pluginId: "status-ext",
      tier: "user",
      component: () => createElement("span", null, "Status: Healthy"),
    });
    const offOverlay = stack.registry.register("shell.overlays", {
      id: "test-overlay",
      pluginId: "pet-ext",
      tier: "user",
      component: () => createElement("div", { style: { pointerEvents: "auto" } }, "Floating Pet"),
    });
    const offModal = stack.registry.register("shell.modals", {
      id: "test-modal",
      pluginId: "modal-ext",
      tier: "user",
      component: () => createElement("div", { role: "dialog" }, "Test Modal Content"),
    });
    const offTopbarCtrl = stack.registry.register("workbench.topbarControls", {
      id: "test-wb-toggle",
      pluginId: "core-workbench",
      tier: "builtin",
      component: () => createElement("button", { type: "button" }, "Toggle Files"),
    });
    cleanups.push(() => {
      offStatus();
      offOverlay();
      offModal();
      offTopbarCtrl();
    });

    useAppStore.setState({
      connection: "running",
      cwd: "/repo/notes",
      sessionFile: "harness:s99",
      sessionId: "s99",
      sessionName: "Fix Bug #42",
    });
    stack.root.navigationService.navigate(
      { kind: "session", cwd: "/repo/notes", file: "harness:s99" },
      { syncStore: false },
    );
    stack.root.navigationService.showToast("已同步工作区", "info");
    stack.rpc.setStatus("failed");

    const sessionHtml = stack.renderApp();
    expect(sessionHtml).toContain("Fix Bug #42");
    expect(sessionHtml).toContain("Toggle Files");
    expect(sessionHtml).toContain('class="qj-workspace-statusbar"');
    expect(sessionHtml).toContain("Status: Healthy");
    expect(sessionHtml).toContain("Floating Pet");
    expect(sessionHtml).toContain("Test Modal Content");
    expect(sessionHtml).toContain("已同步工作区");
    expect(sessionHtml).toContain("Harness 多次崩溃，已停止自动重启");
    expect(sessionHtml).not.toContain("new-task-screen");
  });

  it("allows higher-priority plugins to replace shell.sidebar and home.hero, and restores builtins on dispose", async () => {
    const stack = await mountCoreShellNavStack();
    cleanups.push(() => stack.dispose());

    // Replace shell.sidebar with a user-tier plugin
    const customSidebarFiber = stack.root.plugin({
      name: "custom-sidebar-plugin",
      inject: ["slots"],
      apply(ctx: Context) {
        ctx.slots.register("shell.sidebar", {
          id: "custom-sidebar-entry",
          pluginId: "custom-sidebar-plugin",
          tier: "user",
          priority: 10,
          component: () => createElement("aside", { "data-custom": "sidebar" }, "Custom Pro Sidebar"),
        });
      },
    });
    await customSidebarFiber;

    const overriddenSidebarHtml = stack.renderApp();
    expect(overriddenSidebarHtml).toContain("Custom Pro Sidebar");
    expect(overriddenSidebarHtml).not.toContain('data-core-plugin="core-sidebar"');

    // Disposing the override restores core-sidebar
    await customSidebarFiber.dispose();
    const restoredSidebarHtml = stack.renderApp();
    expect(restoredSidebarHtml).toContain('data-core-plugin="core-sidebar"');
    expect(restoredSidebarHtml).not.toContain("Custom Pro Sidebar");

    // Replace home.hero with a higher-priority plugin
    const customHeroFiber = stack.root.plugin({
      name: "custom-hero-plugin",
      inject: ["slots"],
      apply(ctx: Context) {
        ctx.slots.register("home.hero", {
          id: "custom-hero-entry",
          pluginId: "custom-hero-plugin",
          tier: "user",
          priority: 20,
          component: () => createElement("h1", { className: "custom-hero" }, "Welcome Custom Hero"),
        });
      },
    });
    await customHeroFiber;

    const overriddenHeroHtml = stack.renderApp();
    expect(overriddenHeroHtml).toContain("Welcome Custom Hero");
    expect(overriddenHeroHtml).not.toContain("接下来聊些什么？");

    await customHeroFiber.dispose();
    const restoredHeroHtml = stack.renderApp();
    expect(restoredHeroHtml).toContain("接下来聊些什么？");
    expect(restoredHeroHtml).not.toContain("Welcome Custom Hero");
  });

  it("abdicates crashing shell.sidebar, home.hero, and shell.stage overrides back to builtin core plugins", async () => {
    const stack = await mountCoreShellNavStack();
    cleanups.push(() => stack.dispose());

    // 1. Crashing user override on shell.sidebar
    const offBadSidebar = stack.registry.register("shell.sidebar", {
      id: "broken-sidebar-entry",
      pluginId: "broken-sidebar-plugin",
      tier: "user",
      priority: 50,
      component: () => {
        throw new Error("sidebar boom");
      },
    });
    cleanups.push(offBadSidebar);

    expect(stack.registry.inspectSlot("shell.sidebar").winner?.pluginId).toBe("broken-sidebar-plugin");

    // Trigger SlotKernelErrorBoundary crash capture as React does on render error
    const sidebarBoundary = new SlotKernelErrorBoundary({
      pluginId: "broken-sidebar-plugin",
      entryId: "broken-sidebar-entry",
      slotKey: "shell.sidebar",
      hasFallbackCandidate: true,
      onCrash: (error) => {
        stack.abdication.abdicate({
          slotKey: "shell.sidebar",
          entryId: "broken-sidebar-entry",
          pluginId: "broken-sidebar-plugin",
          error,
          fallbackEntryId: `${CORE_SIDEBAR_PLUGIN_ID}:sidebar`,
          fallbackPluginId: CORE_SIDEBAR_PLUGIN_ID,
        });
      },
      children: null,
    });
    const sidebarCrash = new Error("sidebar boom");
    sidebarBoundary.state = SlotKernelErrorBoundary.getDerivedStateFromError(sidebarCrash);
    sidebarBoundary.componentDidCatch(sidebarCrash, { componentStack: "" });

    expect(stack.abdication.isAbdicated("shell.sidebar", "broken-sidebar-entry", "broken-sidebar-plugin")).toBe(true);
    const afterSidebarAbdicateHtml = stack.renderApp();
    expect(afterSidebarAbdicateHtml).toContain('data-core-plugin="core-sidebar"');
    expect(afterSidebarAbdicateHtml).toContain("千机");
    // Core shell's onAbdicate toast notifies user non-blockingly
    expect(
      stack.root.navigationService.getSnapshot().toasts.some((toast) =>
        toast.message.includes("broken-sidebar-plugin") && toast.message.includes("shell.sidebar"),
      ),
    ).toBe(true);

    // 2. Crashing user override on home.hero
    const offBadHero = stack.registry.register("home.hero", {
      id: "broken-hero-entry",
      pluginId: "broken-hero-plugin",
      tier: "user",
      priority: 50,
      component: () => {
        throw new Error("hero boom");
      },
    });
    cleanups.push(offBadHero);

    const heroBoundary = new SlotKernelErrorBoundary({
      pluginId: "broken-hero-plugin",
      entryId: "broken-hero-entry",
      slotKey: "home.hero",
      hasFallbackCandidate: true,
      onCrash: (error) => {
        stack.abdication.abdicate({
          slotKey: "home.hero",
          entryId: "broken-hero-entry",
          pluginId: "broken-hero-plugin",
          error,
          fallbackEntryId: `${CORE_HOME_PLUGIN_ID}:hero`,
          fallbackPluginId: CORE_HOME_PLUGIN_ID,
        });
      },
      children: null,
    });
    const heroCrash = new Error("hero boom");
    heroBoundary.state = SlotKernelErrorBoundary.getDerivedStateFromError(heroCrash);
    heroBoundary.componentDidCatch(heroCrash, { componentStack: "" });

    expect(stack.abdication.isAbdicated("home.hero", "broken-hero-entry", "broken-hero-plugin")).toBe(true);
    const afterHeroAbdicateHtml = stack.renderApp();
    expect(afterHeroAbdicateHtml).toContain("接下来聊些什么？");

    // 3. Throwing chain selector on shell.stage abdicates immediately during render back to core-home
    const offBadStage = stack.registry.register("shell.stage", {
      id: "broken-stage-chain",
      pluginId: "broken-stage-plugin",
      tier: "user",
      priority: 99,
      select: () => {
        throw new Error("stage select exploded");
      },
      component: () => createElement("div", null, "never rendered"),
    });
    cleanups.push(offBadStage);

    const afterStageAbdicateHtml = stack.renderApp();
    expect(stack.abdication.isAbdicated("shell.stage", "broken-stage-chain", "broken-stage-plugin")).toBe(true);
    expect(afterStageAbdicateHtml).toContain("new-task-screen");
    expect(afterStageAbdicateHtml).toContain("接下来聊些什么？");
  });

  it("wires core shell shortcuts via shortcutService and disposes all registrations cleanly on Fiber teardown", async () => {
    const stack = await mountCoreShellNavStack();
    cleanups.push(() => stack.dispose());

    const initialSidebar = stack.root.navigationService.getSnapshot().sidebarVisible;
    expect(stack.root.shortcutService.dispatch(makeKeyEvent({ key: "b", ctrlKey: true }))).toBe(true);
    expect(stack.root.navigationService.getSnapshot().sidebarVisible).toBe(!initialSidebar);

    expect(stack.root.shortcutService.dispatch(makeKeyEvent({ key: ",", ctrlKey: true }))).toBe(true);
    expect(stack.root.navigationService.getSnapshot().settingsOpen).toBe(true);

    // Tear down all 4 plugin fibers and verify zero leftover entries or shortcuts
    await stack.fibers.hubsFiber.dispose();
    await stack.fibers.homeFiber.dispose();
    await stack.fibers.sidebarFiber.dispose();
    await stack.fibers.shellFiber.dispose();

    expect(stack.registry.getEntries("root")).toHaveLength(0);
    expect(stack.registry.getEntries("shell.sidebar")).toHaveLength(0);
    expect(stack.registry.getEntries("shell.stage")).toHaveLength(0);
    expect(stack.registry.getEntries("hub.pages")).toHaveLength(0);
    expect(stack.root.shortcutService.getSnapshot().shortcuts).toHaveLength(0);
  });
});

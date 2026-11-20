/**
 * Integration tests for ADR 0023 Wave 2B:
 * `core-workbench` + the 5 true built-in feature client plugins
 * (`code-review`, `web-preview`, `side-chat`, `diagram-viewer`, `intelligent-ui`).
 *
 * Verifies:
 * 1. Mounting `coreWorkbenchPlugin` + all 5 feature plugins via
 *    `BuiltinCorePluginCoordinator` + `SlotRegistry` + `registerFrontendServices`
 *    renders core panes (`files`/`editor`/`code`, `terminal`), bottom drawer,
 *    inspector sections, topbar controls, and all 5 feature panes/viewers.
 * 2. Disabling each feature plugin via `BuiltinCorePluginCoordinator` genuinely
 *    unmounts its Cordis Fiber and removes its `workbench.panes`,
 *    `workbench.topbarControls`, `conversation.markdown.codeBlock`, and
 *    `workbench.fileViewer` registrations — dynamically updating both the
 *    tiling grid and topbar/inspector controls with zero hardcoded gates.
 * 3. `diagram-viewer` config (`enableMermaid` / `enablePlantUml`) selectively
 *    controls Mermaid vs PlantUML codeBlock and fileViewer slots.
 * 4. Mounting a user-tier plugin with the same ID (e.g. `id: "code-review"`)
 *    replaces the builtin pane with the user plugin's custom UI, and
 *    removing/disabling or entering Safe Mode restores the builtin plugin.
 */
import { act, createElement, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Context, type Plugin } from "@deepseek-ai/cordis";
import type {
  PluginChangedNotification,
  PluginClientBundleParams,
  PluginClientBundleResult,
  PluginInfo,
} from "@qianji/protocol";
import {
  ClientSlotsService,
  CORE_SLOT_SPECS,
  SessionArea,
  SlotHost,
  SlotKernelProvider,
  SlotRegistry,
} from "@qianji/client-slots";
import {
  CORE_WORKBENCH_PLUGIN_ID,
  CoreTopbarControls,
  coreWorkbenchPlugin,
} from "../src/builtin-plugins/core-workbench";
import {
  CODE_REVIEW_PLUGIN_ID,
  codeReviewPlugin,
} from "../src/builtin-plugins/code-review";
import {
  WEB_PREVIEW_PLUGIN_ID,
  webPreviewPlugin,
} from "../src/builtin-plugins/web-preview";
import {
  SIDE_CHAT_PLUGIN_ID,
  sideChatPlugin,
} from "../src/builtin-plugins/side-chat";
import {
  DIAGRAM_VIEWER_PLUGIN_ID,
  diagramViewerPlugin,
} from "../src/builtin-plugins/diagram-viewer";
import {
  INTELLIGENT_UI_CANVAS_PANE_ID,
  INTELLIGENT_UI_PLUGIN_ID,
  intelligentUiPlugin,
} from "../src/builtin-plugins/intelligent-ui";
import {
  clearPluginTiers,
  createBuiltinCorePluginCoordinator,
  createSafeModeController,
  createSafeModeGatedTransport,
  setPluginTier,
  type BuiltinCorePluginDescriptor,
} from "../src/kernel/runtime";
import {
  installSessionScopeAdapter,
  registerFrontendServices,
} from "../src/kernel/services";
import { ClientContributionRegistry } from "../src/lib/clientContributions";
import {
  createClientPluginRuntime,
  type ClientPluginTransport,
  type ModuleLoaderGlobal,
} from "../src/lib/clientPluginRuntime";
import { bindClientRootContext } from "../src/sdk/rootContext";
import { useAppStore } from "../src/store";
import { useWorkbenchLayoutStore } from "../src/stores/workbenchLayoutStore";
import { useWorkbenchStore } from "../src/stores/workbenchStore";

function createMemoryStorage() {
  const data = new Map<string, string>();
  return {
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => {
      data.set(key, value);
    },
    removeItem: (key: string) => {
      data.delete(key);
    },
  };
}

function makePluginInfo(overrides: Partial<PluginInfo> & { id: string }): PluginInfo {
  return {
    name: overrides.id,
    version: "1.0.0",
    tier: "builtin",
    enabled: true,
    status: "active",
    overridesBuiltin: false,
    removable: overrides.tier !== "builtin",
    watch: false,
    hasHost: false,
    hasClient: true,
    canDisable: overrides.id !== CORE_WORKBENCH_PLUGIN_ID,
    ...overrides,
  };
}

function allFeatureDescriptors(): BuiltinCorePluginDescriptor[] {
  return [
    { id: CORE_WORKBENCH_PLUGIN_ID, plugin: coreWorkbenchPlugin, canDisable: false },
    { id: CODE_REVIEW_PLUGIN_ID, plugin: codeReviewPlugin, canDisable: true },
    { id: WEB_PREVIEW_PLUGIN_ID, plugin: webPreviewPlugin, canDisable: true },
    { id: SIDE_CHAT_PLUGIN_ID, plugin: sideChatPlugin, canDisable: true },
    {
      id: DIAGRAM_VIEWER_PLUGIN_ID,
      plugin: diagramViewerPlugin,
      canDisable: true,
      defaultConfig: { enableMermaid: true, enablePlantUml: true },
    },
    { id: INTELLIGENT_UI_PLUGIN_ID, plugin: intelligentUiPlugin, canDisable: true },
  ];
}

/* ── Minimal DOM harness for React 19 createRoot live reactivity assertions ── */

class MiniNode {
  readonly nodeType: number;
  readonly nodeName: string;
  ownerDocument: MiniDoc | null;
  parentNode: MiniNode | null = null;
  readonly childNodes: MiniNode[] = [];
  protected textValue = "";
  constructor(nodeType: number, nodeName: string, ownerDocument: MiniDoc | null) {
    this.nodeType = nodeType;
    this.nodeName = nodeName;
    this.ownerDocument = ownerDocument;
  }
  get firstChild(): MiniNode | null { return this.childNodes[0] ?? null; }
  get nextSibling(): MiniNode | null {
    const idx = this.parentNode?.childNodes.indexOf(this) ?? -1;
    return idx >= 0 ? (this.parentNode?.childNodes[idx + 1] ?? null) : null;
  }
  get nodeValue(): string | null { return this.nodeType === 3 || this.nodeType === 8 ? this.textValue : null; }
  set nodeValue(v: string | null) { this.textValue = v ?? ""; }
  get data(): string { return this.textValue; }
  set data(v: string) { this.textValue = v; }
  get textContent(): string {
    if (this.nodeType === 3) return this.textValue;
    if (this.nodeType === 8) return "";
    return this.childNodes.map((c) => c.textContent).join("");
  }
  set textContent(v: string) {
    if (this.nodeType === 3 || this.nodeType === 8) { this.textValue = v; return; }
    for (const c of [...this.childNodes]) this.removeChild(c);
    if (v !== "" && this.ownerDocument !== null) this.appendChild(this.ownerDocument.createTextNode(v));
  }
  appendChild<T extends MiniNode>(child: T): T {
    if (child.parentNode !== null) child.parentNode.removeChild(child);
    child.parentNode = this;
    this.childNodes.push(child);
    return child;
  }
  insertBefore<T extends MiniNode>(child: T, ref: MiniNode | null): T {
    if (ref === null) return this.appendChild(child);
    if (child.parentNode !== null) child.parentNode.removeChild(child);
    const idx = this.childNodes.indexOf(ref);
    if (idx < 0) return this.appendChild(child);
    child.parentNode = this;
    this.childNodes.splice(idx, 0, child);
    return child;
  }
  removeChild<T extends MiniNode>(child: T): T {
    const idx = this.childNodes.indexOf(child);
    if (idx >= 0) { this.childNodes.splice(idx, 1); child.parentNode = null; }
    return child;
  }
  addEventListener(): void {}
  removeEventListener(): void {}
}

class MiniEl extends MiniNode {
  readonly tagName: string;
  readonly attributes = new Map<string, string>();
  readonly style: Record<string, string> = {};
  readonly dataset: Record<string, string> = {};
  readonly classList = {
    add: (): void => undefined,
    remove: (): void => undefined,
  };
  hidden = false;
  constructor(tag: string, ownerDocument: MiniDoc) {
    super(1, tag.toUpperCase(), ownerDocument);
    this.tagName = tag.toUpperCase();
  }
  get className(): string { return this.attributes.get("class") ?? ""; }
  set className(v: string) { this.attributes.set("class", v); }
  setAttribute(k: string, v: string): void {
    const lower = k.toLowerCase();
    this.attributes.set(lower, String(v));
    if (lower.startsWith("data-")) {
      const camel = lower.slice(5).replace(/-([a-z])/g, (_, ch: string) => ch.toUpperCase());
      this.dataset[camel] = String(v);
    }
  }
  getAttribute(k: string): string | null { return this.attributes.get(k.toLowerCase()) ?? null; }
  removeAttribute(k: string): void { this.attributes.delete(k.toLowerCase()); }
  hasAttribute(k: string): boolean { return this.attributes.has(k.toLowerCase()); }
  querySelectorAll(attrSelector: string): MiniEl[] {
    const match = /^\[([a-z0-9-]+)(?:="([^"]*)")?\]$/i.exec(attrSelector);
    if (match === null || match[1] === undefined) return [];
    const attrName = match[1].toLowerCase();
    const expected = match[2];
    const results: MiniEl[] = [];
    const visit = (node: MiniNode) => {
      if (node instanceof MiniEl) {
        const val = node.getAttribute(attrName);
        if (val !== null && (expected === undefined || val === expected)) {
          results.push(node);
        }
      }
      for (const child of node.childNodes) visit(child);
    };
    visit(this);
    return results;
  }
}

class MiniIframe extends MiniEl {}

class MiniDoc extends MiniNode {
  readonly documentElement: MiniEl;
  readonly body: MiniEl;
  activeElement: MiniEl | null = null;
  readonly defaultView = {
    addEventListener(): void {},
    removeEventListener(): void {},
    navigator: { userAgent: "node" },
    location: { origin: "http://qianji.local", href: "http://qianji.local/" },
    HTMLIFrameElement: MiniIframe,
    HTMLElement: MiniEl,
    Element: MiniEl,
    Node: MiniNode,
  };
  constructor() {
    super(9, "#document", null);
    this.documentElement = new MiniEl("html", this);
    this.body = new MiniEl("body", this);
    this.documentElement.appendChild(this.body);
    this.appendChild(this.documentElement);
  }
  createElement(tag: string): MiniEl { return new MiniEl(tag, this); }
  createElementNS(_ns: string, tag: string): MiniEl { return new MiniEl(tag, this); }
  createTextNode(text: string): MiniNode {
    const n = new MiniNode(3, "#text", this);
    n.nodeValue = text;
    return n;
  }
  createComment(text: string): MiniNode {
    const n = new MiniNode(8, "#comment", this);
    n.nodeValue = text;
    return n;
  }
}

const activeCleanups: Array<() => void | Promise<void>> = [];

function mountMiniDom(node: ReactNode): { container: MiniEl; rerender: (next: ReactNode) => void; unmount: () => void } {
  const g = globalThis as Record<string, unknown>;
  const keys = ["window", "document", "Node", "Element", "HTMLElement", "HTMLIFrameElement", "IS_REACT_ACT_ENVIRONMENT"] as const;
  const saved: Record<string, unknown> = {};
  for (const k of keys) saved[k] = g[k];

  const doc = new MiniDoc();
  const container = doc.createElement("div");
  doc.body.appendChild(container);
  Object.assign(g, {
    window: doc.defaultView,
    document: doc,
    Node: MiniNode,
    Element: MiniEl,
    HTMLElement: MiniEl,
    HTMLIFrameElement: MiniIframe,
    IS_REACT_ACT_ENVIRONMENT: true,
  });

  let root: Root | null = null;
  act(() => {
    root = createRoot(container as unknown as HTMLElement);
    root.render(node);
  });

  let disposed = false;
  const unmount = () => {
    if (disposed) return;
    disposed = true;
    act(() => { root?.unmount(); });
    for (const k of keys) {
      if (saved[k] === undefined) delete g[k];
      else g[k] = saved[k];
    }
  };
  activeCleanups.push(unmount);
  return {
    container,
    rerender: (next) => {
      act(() => { root?.render(next); });
    },
    unmount,
  };
}

async function createWorkbenchHarness(initialPlugins?: PluginInfo[]) {
  const root = new Context();
  const registry = new SlotRegistry();
  const contributions = new ClientContributionRegistry(registry);
  await root.plugin(ClientSlotsService, registry);
  await registerFrontendServices(root, { contributionRegistry: contributions, shortcutTarget: null });
  const disposeScope = installSessionScopeAdapter(root);
  bindClientRootContext(root);

  // Define parent slots `core-shell` / `core-conversation` normally own when mounted standalone
  registry.defineSlot("shell.workbench.right", CORE_SLOT_SPECS["shell.workbench.right"]);
  registry.defineSlot("shell.workbench.bottom", CORE_SLOT_SPECS["shell.workbench.bottom"]);
  registry.defineSlot("conversation.markdown.codeBlock", CORE_SLOT_SPECS["conversation.markdown.codeBlock"]);

  let hostPlugins: PluginInfo[] = initialPlugins ?? [
    makePluginInfo({ id: CORE_WORKBENCH_PLUGIN_ID, tier: "builtin", canDisable: false }),
    makePluginInfo({ id: CODE_REVIEW_PLUGIN_ID, tier: "builtin" }),
    makePluginInfo({ id: WEB_PREVIEW_PLUGIN_ID, tier: "builtin" }),
    makePluginInfo({ id: SIDE_CHAT_PLUGIN_ID, tier: "builtin" }),
    makePluginInfo({
      id: DIAGRAM_VIEWER_PLUGIN_ID,
      tier: "builtin",
      config: { enableMermaid: true, enablePlantUml: true },
    }),
    makePluginInfo({ id: INTELLIGENT_UI_PLUGIN_ID, tier: "builtin" }),
  ];

  const bundles = new Map<string, { etag: string; code: string }>();
  const targetGlobal: { __ModuleLoader__?: ModuleLoaderGlobal } = {};
  const changeListeners = new Set<(payload?: PluginChangedNotification) => void>();

  const rawTransport: ClientPluginTransport = {
    async list() {
      return hostPlugins;
    },
    async clientBundle(params: PluginClientBundleParams): Promise<PluginClientBundleResult> {
      const entry = bundles.get(params.id);
      if (entry === undefined) throw new Error(`missing bundle for ${params.id}`);
      return { etag: entry.etag, code: entry.code, notModified: false };
    },
    onChanged(listener) {
      changeListeners.add(listener);
      return () => changeListeners.delete(listener);
    },
    onTrustChanged: () => () => undefined,
  };

  const safeMode = createSafeModeController({ windowLike: null, storage: createMemoryStorage() });
  const gatedTransport = createSafeModeGatedTransport(rawTransport, safeMode, (items) => {
    for (const item of items) setPluginTier(item.id, item.tier);
  });

  const externalRuntime = createClientPluginRuntime<Plugin>(root, {
    transport: gatedTransport,
    modules: {
      react: async () => ({ createElement }),
    },
    targetGlobal,
    async executeScript(code) {
      const fn = new Function("window", code);
      fn(targetGlobal);
    },
  });

  const coordinator = createBuiltinCorePluginCoordinator(root, {
    transport: rawTransport,
    safeMode,
    descriptors: allFeatureDescriptors(),
  });

  const syncAll = async () => {
    await Promise.all([externalRuntime.sync(), coordinator.sync()]);
  };

  const setHostPlugins = (next: PluginInfo[]) => {
    hostPlugins = next;
    for (const listener of [...changeListeners]) listener(undefined);
  };

  await syncAll();

  activeCleanups.push(async () => {
    await coordinator.dispose();
    await externalRuntime.dispose();
    disposeScope();
    registry.dispose();
    bindClientRootContext(undefined);
  });

  return {
    root,
    registry,
    coordinator,
    externalRuntime,
    safeMode,
    bundles,
    syncAll,
    setHostPlugins,
  };
}

describe("ADR 0023 Wave 2B: core-workbench + 5 built-in feature client plugins", () => {
  beforeEach(() => {
    useWorkbenchLayoutStore.getState().resetLayoutForTest();
    useWorkbenchStore.setState({
      rightOpen: false,
      rightMaximized: false,
      bottomOpen: false,
      activeBottomTab: "terminal",
      activeTab: "summary",
      openFiles: [],
      activeFilePath: null,
      previewUrl: "",
      summaryFocus: "overview",
    });
    useAppStore.setState({
      cwd: "/repo/demo",
      sessionId: "sess-main-1",
      sessionFile: "harness://sess-main-1",
      messages: [
        {
          id: "m-assist-1",
          role: "assistant",
          content: "Created widget and updated file.",
          timestamp: Date.now(),
          toolCalls: [
            {
              id: "tc-write-1",
              name: "write",
              args: { path: "src/app.ts" },
              running: false,
            },
            {
              id: "tc-iui-1",
              name: "render_ui",
              args: {
                id: "budget-sim",
                title: "预算模拟器",
                engine: "declarative",
                spec: {
                  state: { amount: 1200 },
                  blocks: [
                    { type: "stats", items: [{ label: "预算总额", value: "{amount}", suffix: " 元" }] },
                  ],
                },
              },
              running: false,
            },
          ],
        },
      ],
      git: {
        isRepository: true,
        branch: "feat/microkernel",
        files: [
          { path: "src/app.ts", status: "M", unstaged: true, staged: false },
        ],
        diff: [
          "diff --git a/src/app.ts b/src/app.ts",
          "--- a/src/app.ts",
          "+++ b/src/app.ts",
          "@@ -1,2 +1,2 @@",
          "-const version = 1;",
          "+const version = 2;",
        ].join("\n"),
      },
    });
  });

  afterEach(async () => {
    while (activeCleanups.length > 0) {
      await activeCleanups.pop()?.();
    }
    clearPluginTiers();
  });

  it("mounts core-workbench + all 5 feature plugins and renders every pane, topbar toggle, inspector section, codeBlock, and fileViewer", async () => {
    const h = await createWorkbenchHarness();

    expect(h.coordinator.isMounted(CORE_WORKBENCH_PLUGIN_ID)).toBe(true);
    expect(h.coordinator.isMounted(CODE_REVIEW_PLUGIN_ID)).toBe(true);
    expect(h.coordinator.isMounted(WEB_PREVIEW_PLUGIN_ID)).toBe(true);
    expect(h.coordinator.isMounted(SIDE_CHAT_PLUGIN_ID)).toBe(true);
    expect(h.coordinator.isMounted(DIAGRAM_VIEWER_PLUGIN_ID)).toBe(true);
    expect(h.coordinator.isMounted(INTELLIGENT_UI_PLUGIN_ID)).toBe(true);

    // Open inspector + all panes (`files`, `terminal`, `review`, `preview`, `side-chat`, `intelligent-ui-canvas`)
    const wbSvc = h.root.get("workbenchService");
    wbSvc?.setInspectorOpen(true);
    wbSvc?.openPane("files");
    wbSvc?.openPane("terminal");
    wbSvc?.openPane("review");
    wbSvc?.openPane("preview");
    wbSvc?.openPane("side-chat");
    wbSvc?.openPane(INTELLIGENT_UI_CANVAS_PANE_ID);
    wbSvc?.setBottomOpen(true);

    // Also open a `.mmd` file so `core-workbench`'s `"files"` pane delegates to `diagram-viewer` via `workbench.fileViewer`
    useWorkbenchStore.setState({
      openFiles: [
        {
          cwd: "/repo/demo",
          path: "docs/arch.mmd",
          content: "graph TD; A-->B;",
          savedContent: "graph TD; A-->B;",
          isBinary: false,
          size: 16,
          truncated: false,
          loading: false,
        },
      ],
      activeFilePath: "docs/arch.mmd",
    });

    // Register a probe `conversation.transcript` slot to verify `side-chat` binds `<SessionArea>` with isolated sessionId
    let observedSideScope: string | null = null;
    h.registry.defineSlot("conversation.transcript", CORE_SLOT_SPECS["conversation.transcript"]);
    const disposeTranscriptProbe = h.registry.register("conversation.transcript", {
      id: "probe:transcript",
      pluginId: "probe",
      component: ({ sessionId }) => {
        observedSideScope = sessionId;
        return createElement("div", { "data-probe-transcript": sessionId }, `scope:${sessionId}`);
      },
    });
    activeCleanups.push(disposeTranscriptProbe);

    const html = renderToStaticMarkup(
      createElement(
        SlotKernelProvider,
        { registry: h.registry, ctx: h.root },
        createElement(
          "div",
          null,
          createElement(CoreTopbarControls, { cwd: "/repo/demo", sessionFile: "harness://sess-main-1" }),
          createElement(SlotHost, { slotKey: "shell.workbench.right", registry: h.registry, rootCtx: h.root }),
          createElement(SlotHost, { slotKey: "shell.workbench.bottom", registry: h.registry, rootCtx: h.root }),
          createElement(
            SessionArea,
            { sessionId: "sess-main-1" },
            createElement(SlotHost, {
              slotKey: "conversation.markdown.codeBlock",
              routeKey: "mermaid",
              props: { language: "mermaid", code: "graph LR; X-->Y;" },
              registry: h.registry,
              rootCtx: h.root,
            }),
            createElement(SlotHost, {
              slotKey: "conversation.markdown.codeBlock",
              routeKey: "plantuml",
              props: { language: "plantuml", code: "@startuml\nA -> B\n@enduml" },
              registry: h.registry,
              rootCtx: h.root,
            }),
          ),
          createElement(SlotHost, {
            slotKey: "workbench.fileViewer",
            routeKey: ".puml",
            props: { path: "docs/seq.puml", content: "@startuml\nA->B\n@enduml", isBinary: false, size: 22 },
            registry: h.registry,
            rootCtx: h.root,
          }),
        ),
      ),
    );

    // Core workbench + inspector sections + bottom terminal
    expect(html).toContain('data-core-workbench="right"');
    expect(html).toContain('data-core-workbench="bottom"');
    expect(html).toContain('data-inspector-section="env"');
    expect(html).toContain('data-inspector-section="context"');
    expect(html).toContain('data-inspector-section="outputs"');
    expect(html).toContain('data-inspector-section="extensions"');
    expect(html).toContain('data-inspector-section="diagnostics"');
    expect(html).toContain('data-core-workbench-pane="files"');
    expect(html).toContain('data-core-workbench-pane="terminal"');

    // Feature 1: code-review pane + diff content + topbar toggle
    expect(html).toContain('data-feature-pane="code-review"');
    expect(html).toContain('data-plugin-topbar="code-review"');
    expect(html).toContain("src/app.ts");
    expect(html).toContain("feat/microkernel");

    // Feature 2: web-preview pane + topbar toggle
    expect(html).toContain('data-feature-pane="web-preview"');
    expect(html).toContain('data-plugin-topbar="web-preview"');

    // Feature 3: side-chat pane wrapped in isolated <SessionArea> + topbar toggle
    expect(html).toContain('data-feature-pane="side-chat"');
    expect(html).toContain('data-plugin-topbar="side-chat"');
    expect(observedSideScope).toBe("side:harness://sess-main-1");
    expect(html).toContain("scope:side:harness://sess-main-1");

    // Feature 4: diagram-viewer codeBlock (mermaid + plantuml) & fileViewer (.mmd inside files pane + .puml)
    expect(html).toContain('data-feature-diagram="mermaid"');
    expect(html).toContain('data-feature-diagram="plantuml"');
    expect(html).toContain('data-feature-file-viewer="diagram-mermaid"');
    expect(html).toContain('data-feature-file-viewer="diagram-plantuml"');

    // Feature 5: intelligent-ui canvas pane rendering derived widget
    expect(html).toContain('data-feature-pane="intelligent-ui"');
    expect(html).toContain("预算模拟器");
    expect(html).toContain("1200");

    // Alias check: `"editor"` and `"code"` resolve to `core-workbench`'s `"files"` pane
    expect(h.registry.getKeyedCandidates("workbench.panes", "editor")[0]?.pluginId).toBe(CORE_WORKBENCH_PLUGIN_ID);
    expect(h.registry.getKeyedCandidates("workbench.panes", "code")[0]?.pluginId).toBe(CORE_WORKBENCH_PLUGIN_ID);
  });

  it("genuinely unmounts Cordis Fibers and removes panes, topbar buttons, codeBlocks, and fileViewers when disabling each of the 5 feature plugins", async () => {
    const h = await createWorkbenchHarness();

    const wbSvc = h.root.get("workbenchService");
    wbSvc?.setInspectorOpen(true);
    wbSvc?.openPane("review");
    wbSvc?.openPane("preview");
    wbSvc?.openPane("side-chat");
    wbSvc?.openPane(INTELLIGENT_UI_CANVAS_PANE_ID);

    // Mount live React tree to verify reactive DOM removal (including persistent side-chat!)
    const mounted = mountMiniDom(
      createElement(
        SlotKernelProvider,
        { registry: h.registry, ctx: h.root },
        createElement(
          "div",
          null,
          createElement(CoreTopbarControls, { cwd: "/repo/demo", sessionFile: "harness://sess-main-1" }),
          createElement(SlotHost, { slotKey: "shell.workbench.right", registry: h.registry, rootCtx: h.root }),
        ),
      ),
    );

    expect(mounted.container.querySelectorAll('[data-feature-pane="code-review"]').length).toBe(1);
    expect(mounted.container.querySelectorAll('[data-feature-pane="web-preview"]').length).toBe(1);
    expect(mounted.container.querySelectorAll('[data-feature-pane="side-chat"]').length).toBe(1);
    expect(mounted.container.querySelectorAll('[data-feature-pane="intelligent-ui"]').length).toBe(1);
    expect(mounted.container.querySelectorAll('[data-plugin-topbar="code-review"]').length).toBe(1);
    expect(mounted.container.querySelectorAll('[data-plugin-topbar="web-preview"]').length).toBe(1);
    expect(mounted.container.querySelectorAll('[data-plugin-topbar="side-chat"]').length).toBe(1);

    // 1. Disable `code-review` -> Fiber unmounted, pane & topbar toggle removed immediately
    await act(async () => {
      h.setHostPlugins([
        makePluginInfo({ id: CORE_WORKBENCH_PLUGIN_ID, tier: "builtin", canDisable: false }),
        makePluginInfo({ id: CODE_REVIEW_PLUGIN_ID, tier: "builtin", enabled: false, status: "disabled" }),
        makePluginInfo({ id: WEB_PREVIEW_PLUGIN_ID, tier: "builtin" }),
        makePluginInfo({ id: SIDE_CHAT_PLUGIN_ID, tier: "builtin" }),
        makePluginInfo({ id: DIAGRAM_VIEWER_PLUGIN_ID, tier: "builtin", config: { enableMermaid: true, enablePlantUml: false } }),
        makePluginInfo({ id: INTELLIGENT_UI_PLUGIN_ID, tier: "builtin" }),
      ]);
      await h.syncAll();
    });

    expect(h.coordinator.isMounted(CODE_REVIEW_PLUGIN_ID)).toBe(false);
    expect(h.registry.getKeyedCandidates("workbench.panes", "review")).toEqual([]);
    expect(mounted.container.querySelectorAll('[data-feature-pane="code-review"]').length).toBe(0);
    expect(mounted.container.querySelectorAll('[data-plugin-topbar="code-review"]').length).toBe(0);

    // Config hot-reload check on `diagram-viewer`: Mermaid remains registered, PlantUML removed!
    expect(h.registry.getKeyedCandidates("conversation.markdown.codeBlock", "mermaid").length).toBe(1);
    expect(h.registry.getKeyedCandidates("conversation.markdown.codeBlock", "plantuml")).toEqual([]);
    expect(h.registry.getKeyedCandidates("workbench.fileViewer", ".mmd").length).toBe(1);
    expect(h.registry.getKeyedCandidates("workbench.fileViewer", ".puml")).toEqual([]);

    // 2. Disable remaining 4 feature plugins (`web-preview`, `side-chat`, `diagram-viewer`, `intelligent-ui`)
    await act(async () => {
      h.setHostPlugins([
        makePluginInfo({ id: CORE_WORKBENCH_PLUGIN_ID, tier: "builtin", canDisable: false }),
        makePluginInfo({ id: CODE_REVIEW_PLUGIN_ID, tier: "builtin", enabled: false, status: "disabled" }),
        makePluginInfo({ id: WEB_PREVIEW_PLUGIN_ID, tier: "builtin", enabled: false, status: "disabled" }),
        makePluginInfo({ id: SIDE_CHAT_PLUGIN_ID, tier: "builtin", enabled: false, status: "disabled" }),
        makePluginInfo({ id: DIAGRAM_VIEWER_PLUGIN_ID, tier: "builtin", enabled: false, status: "disabled" }),
        makePluginInfo({ id: INTELLIGENT_UI_PLUGIN_ID, tier: "builtin", enabled: false, status: "disabled" }),
      ]);
      await h.syncAll();
    });

    expect(h.coordinator.isMounted(WEB_PREVIEW_PLUGIN_ID)).toBe(false);
    expect(h.coordinator.isMounted(SIDE_CHAT_PLUGIN_ID)).toBe(false);
    expect(h.coordinator.isMounted(DIAGRAM_VIEWER_PLUGIN_ID)).toBe(false);
    expect(h.coordinator.isMounted(INTELLIGENT_UI_PLUGIN_ID)).toBe(false);

    expect(h.registry.getKeyedCandidates("workbench.panes", "preview")).toEqual([]);
    expect(h.registry.getKeyedCandidates("workbench.panes", "side-chat")).toEqual([]);
    expect(h.registry.getKeyedCandidates("workbench.panes", INTELLIGENT_UI_CANVAS_PANE_ID)).toEqual([]);
    expect(h.registry.getKeyedCandidates("conversation.markdown.codeBlock", "mermaid")).toEqual([]);
    expect(h.registry.getKeyedCandidates("conversation.markdown.codeBlock", "plantuml")).toEqual([]);
    expect(h.registry.getKeyedCandidates("workbench.fileViewer", ".mmd")).toEqual([]);
    expect(h.registry.getKeyedCandidates("workbench.fileViewer", ".mermaid")).toEqual([]);
    expect(h.registry.getKeyedCandidates("workbench.fileViewer", ".puml")).toEqual([]);
    expect(h.registry.getKeyedCandidates("workbench.fileViewer", ".plantuml")).toEqual([]);

    // Live DOM: all disabled feature panes, topbar buttons, and inspector extension entries are gone!
    expect(mounted.container.querySelectorAll('[data-feature-pane="web-preview"]').length).toBe(0);
    expect(mounted.container.querySelectorAll('[data-feature-pane="side-chat"]').length).toBe(0);
    expect(mounted.container.querySelectorAll('[data-feature-pane="intelligent-ui"]').length).toBe(0);
    expect(mounted.container.querySelectorAll('[data-plugin-topbar="web-preview"]').length).toBe(0);
    expect(mounted.container.querySelectorAll('[data-plugin-topbar="side-chat"]').length).toBe(0);
    expect(mounted.container.querySelectorAll('[data-inspector-section="extensions"]').length).toBe(0);
  });

  it("replaces a builtin feature plugin with a same-ID user-tier plugin and restores the builtin plugin on removal or Safe Mode", async () => {
    const h = await createWorkbenchHarness();
    h.root.get("workbenchService")?.openPane("review");

    const renderRightAndTopbar = () =>
      renderToStaticMarkup(
        createElement(
          SlotKernelProvider,
          { registry: h.registry, ctx: h.root },
          createElement(
            "div",
            null,
            createElement(CoreTopbarControls, { cwd: "/repo/demo", sessionFile: "harness://sess-main-1" }),
            createElement(SlotHost, { slotKey: "shell.workbench.right", registry: h.registry, rootCtx: h.root }),
          ),
        ),
      );

    // Baseline: builtin `code-review` renders
    const beforeHtml = renderRightAndTopbar();
    expect(beforeHtml).toContain('data-feature-pane="code-review"');
    expect(beforeHtml).toContain("feat/microkernel");
    expect(beforeHtml).not.toContain("USER_CUSTOM_CODE_REVIEW_V1");

    // Mount a `tier: "user"` plugin with the EXACT same ID (`id: "code-review"`)
    h.bundles.set(CODE_REVIEW_PLUGIN_ID, {
      etag: "user-cr-v1",
      code: `window.__ModuleLoader__.load({
        id: "code-review",
        factory: (req) => {
          const React = req("react");
          return {
            name: "code-review",
            inject: ["slots"],
            apply(ctx) {
              ctx.slots.register("workbench.panes", {
                id: "user-code-review:pane",
                key: "review",
                component: () => React.createElement("div", { "data-user-review": "true" }, "USER_CUSTOM_CODE_REVIEW_V1"),
              });
              ctx.slots.register("workbench.topbarControls", {
                id: "user-code-review:topbar",
                order: 10,
                component: () => React.createElement("button", { type: "button", "data-user-topbar": "true" }, "Custom Review"),
              });
            },
          };
        },
      });`,
    });

    h.setHostPlugins([
      makePluginInfo({ id: CORE_WORKBENCH_PLUGIN_ID, tier: "builtin", canDisable: false }),
      makePluginInfo({
        id: CODE_REVIEW_PLUGIN_ID,
        tier: "user",
        enabled: true,
        status: "active",
        overridesBuiltin: true,
        clientEtag: "user-cr-v1",
      }),
      makePluginInfo({ id: WEB_PREVIEW_PLUGIN_ID, tier: "builtin" }),
      makePluginInfo({ id: SIDE_CHAT_PLUGIN_ID, tier: "builtin" }),
      makePluginInfo({ id: DIAGRAM_VIEWER_PLUGIN_ID, tier: "builtin" }),
      makePluginInfo({ id: INTELLIGENT_UI_PLUGIN_ID, tier: "builtin" }),
    ]);
    await h.syncAll();

    expect(h.coordinator.isMounted(CODE_REVIEW_PLUGIN_ID)).toBe(false);
    expect(h.coordinator.getSnapshot().plugins.find((p) => p.id === CODE_REVIEW_PLUGIN_ID)).toEqual({
      id: CODE_REVIEW_PLUGIN_ID,
      canDisable: true,
      status: "overridden",
      overrideTier: "user",
    });

    const overrideHtml = renderRightAndTopbar();
    expect(overrideHtml).toContain("USER_CUSTOM_CODE_REVIEW_V1");
    expect(overrideHtml).toContain("Custom Review");
    expect(overrideHtml).not.toContain('data-feature-pane="code-review"');

    // Entering Safe Mode unmounts the user override and immediately restores the builtin `code-review` pane
    h.safeMode.enable("hotkey");
    await h.syncAll();
    expect(h.coordinator.isMounted(CODE_REVIEW_PLUGIN_ID)).toBe(true);
    const safeModeHtml = renderRightAndTopbar();
    expect(safeModeHtml).toContain('data-feature-pane="code-review"');
    expect(safeModeHtml).not.toContain("USER_CUSTOM_CODE_REVIEW_V1");

    // Exiting Safe Mode re-applies the healthy user override
    h.safeMode.disable();
    await h.syncAll();
    expect(h.coordinator.isMounted(CODE_REVIEW_PLUGIN_ID)).toBe(false);
    expect(renderRightAndTopbar()).toContain("USER_CUSTOM_CODE_REVIEW_V1");

    // Disabling the user override unmounts it cleanly
    h.setHostPlugins([
      makePluginInfo({ id: CORE_WORKBENCH_PLUGIN_ID, tier: "builtin", canDisable: false }),
      makePluginInfo({
        id: CODE_REVIEW_PLUGIN_ID,
        tier: "user",
        enabled: false,
        status: "disabled",
        overridesBuiltin: true,
        clientEtag: "user-cr-v1",
      }),
      makePluginInfo({ id: WEB_PREVIEW_PLUGIN_ID, tier: "builtin" }),
      makePluginInfo({ id: SIDE_CHAT_PLUGIN_ID, tier: "builtin" }),
      makePluginInfo({ id: DIAGRAM_VIEWER_PLUGIN_ID, tier: "builtin" }),
      makePluginInfo({ id: INTELLIGENT_UI_PLUGIN_ID, tier: "builtin" }),
    ]);
    await h.syncAll();
    expect(h.registry.getKeyedCandidates("workbench.panes", "review")).toEqual([]);
    expect(renderRightAndTopbar()).not.toContain("USER_CUSTOM_CODE_REVIEW_V1");

    // Removing the user override (returning to active builtin entry) restores builtin `code-review`!
    h.setHostPlugins([
      makePluginInfo({ id: CORE_WORKBENCH_PLUGIN_ID, tier: "builtin", canDisable: false }),
      makePluginInfo({ id: CODE_REVIEW_PLUGIN_ID, tier: "builtin", enabled: true, status: "active" }),
      makePluginInfo({ id: WEB_PREVIEW_PLUGIN_ID, tier: "builtin" }),
      makePluginInfo({ id: SIDE_CHAT_PLUGIN_ID, tier: "builtin" }),
      makePluginInfo({ id: DIAGRAM_VIEWER_PLUGIN_ID, tier: "builtin" }),
      makePluginInfo({ id: INTELLIGENT_UI_PLUGIN_ID, tier: "builtin" }),
    ]);
    await h.syncAll();

    expect(h.coordinator.isMounted(CODE_REVIEW_PLUGIN_ID)).toBe(true);
    const restoredHtml = renderRightAndTopbar();
    expect(restoredHtml).toContain('data-feature-pane="code-review"');
    expect(restoredHtml).not.toContain("USER_CUSTOM_CODE_REVIEW_V1");
  });
});

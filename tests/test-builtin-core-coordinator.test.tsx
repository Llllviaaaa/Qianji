/**
 * Unit tests for ADR 0023 Wave 2A:
 * - Canonical `CoreSlotMap` (`src/kernel/slots/coreSlotMap.ts`) & `CORE_SLOT_SPECS`
 * - `BuiltinCorePluginCoordinator` (`src/kernel/runtime/builtinCorePlugins.ts`)
 *   working end-to-end with `createClientPluginRuntime` and `SafeModeController`
 * - `SafeModeBanner` (`src/kernel/runtime/SafeModeBanner.tsx`)
 */
import { act, createElement, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
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
  SlotHost,
  SlotKernelProvider,
  SlotRegistry,
  SlotRoot,
  type CoreSlotKey,
} from "@qianji/client-slots";
import {
  clearPluginTiers,
  createBuiltinCorePluginCoordinator,
  createSafeModeController,
  createSafeModeGatedTransport,
  SafeModeBanner,
  setPluginTier,
  type BuiltinCorePluginDescriptor,
} from "../src/kernel/runtime";
import {
  createClientPluginRuntime,
  type ClientPluginTransport,
  type ModuleLoaderGlobal,
} from "../src/lib/clientPluginRuntime";
import {
  ensureClientPluginRuntime,
  getBuiltinCorePluginCoordinator,
  registerBuiltinCorePlugins,
} from "../src/lib/clientPluginBootstrap";

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
    ...overrides,
  };
}

/* ── Minimal DOM harness for SafeModeBanner button click assertions ── */

class MiniEvent {
  readonly type: string;
  readonly bubbles: boolean;
  readonly cancelable: boolean;
  target: MiniNode | null = null;
  currentTarget: MiniNode | null = null;
  defaultPrevented = false;
  constructor(type: string, bubbles = true, cancelable = true) {
    this.type = type;
    this.bubbles = bubbles;
    this.cancelable = cancelable;
  }
  preventDefault(): void {
    if (this.cancelable) this.defaultPrevented = true;
  }
  stopPropagation(): void {}
}

class MiniNode {
  readonly nodeType: number;
  readonly nodeName: string;
  ownerDocument: MiniDoc | null;
  parentNode: MiniNode | null = null;
  readonly childNodes: MiniNode[] = [];
  protected textValue = "";
  private readonly listeners = new Map<string, Array<(e: MiniEvent) => void>>();
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
  addEventListener(type: string, fn: ((e: MiniEvent) => void) | null): void {
    if (fn === null) return;
    const list = this.listeners.get(type) ?? [];
    if (!list.includes(fn)) { list.push(fn); this.listeners.set(type, list); }
  }
  removeEventListener(type: string, fn: ((e: MiniEvent) => void) | null): void {
    if (fn === null) return;
    const list = this.listeners.get(type);
    if (list !== undefined) this.listeners.set(type, list.filter((i) => i !== fn));
  }
  dispatchEvent(ev: MiniEvent): boolean {
    ev.target = this;
    for (let cur: MiniNode | null = ev.target; cur !== null; cur = cur.parentNode) {
      ev.currentTarget = cur;
      for (const fn of [...(cur.listeners.get(ev.type) ?? [])]) fn(ev);
      if (!ev.bubbles) break;
    }
    return !ev.defaultPrevented;
  }
}

class MiniEl extends MiniNode {
  readonly tagName: string;
  readonly attributes = new Map<string, string>();
  readonly style: Record<string, string> = {};
  constructor(tag: string, ownerDocument: MiniDoc) {
    super(1, tag.toUpperCase(), ownerDocument);
    this.tagName = tag.toUpperCase();
  }
  setAttribute(k: string, v: string): void { this.attributes.set(k.toLowerCase(), String(v)); }
  getAttribute(k: string): string | null { return this.attributes.get(k.toLowerCase()) ?? null; }
  removeAttribute(k: string): void { this.attributes.delete(k.toLowerCase()); }
  querySelector(selector: string): MiniEl | null {
    const match = /^\[data-testid="([^"]+)"\]$/.exec(selector);
    if (match === null) return null;
    const targetId = match[1];
    const visit = (node: MiniNode): MiniEl | null => {
      if (node instanceof MiniEl && node.getAttribute("data-testid") === targetId) return node;
      for (const child of node.childNodes) {
        const found = visit(child);
        if (found !== null) return found;
      }
      return null;
    };
    return visit(this);
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

const activeUnmounts: Array<() => void> = [];

function mountMiniDom(node: ReactNode): { container: MiniEl; unmount: () => void } {
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
  activeUnmounts.push(unmount);
  return { container, unmount };
}

describe("ADR 0023 Wave 2A: CoreSlotMap, BuiltinCorePluginCoordinator & SafeModeBanner", () => {
  afterEach(() => {
    while (activeUnmounts.length > 0) activeUnmounts.pop()?.();
    clearPluginTiers();
  });

  it("declares all 46 canonical ADR 0023 §3 core slots with expected kind and scope", () => {
    const expectedKeys: CoreSlotKey[] = [
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
      "conversation.header",
      "conversation.transcript",
      "conversation.turn",
      "conversation.message",
      "conversation.message.actions",
      "conversation.thinking",
      "conversation.toolCall",
      "conversation.markdown.codeBlock",
      "conversation.turnFooter",
      "conversation.composerDock",
      "conversation.approvalDialog",
      "composer.main",
      "composer.banners",
      "composer.attachments",
      "composer.input",
      "composer.toolbar",
      "composer.status",
      "workbench.topbarControls",
      "workbench.tilingGrid",
      "workbench.panes",
      "workbench.fileViewer",
      "workbench.inspector.sections",
      "workbench.bottom.tabs",
      "settings.shell",
      "settings.pages",
      "settings.sections",
      "hub.pages",
    ];
    expect(Object.keys(CORE_SLOT_SPECS).sort()).toEqual([...expectedKeys].sort());
    expect(CORE_SLOT_SPECS.root).toEqual({ kind: "single", scope: "root" });
    expect(CORE_SLOT_SPECS["shell.stage"]).toEqual({ kind: "chain", scope: "session-maybe" });
    expect(CORE_SLOT_SPECS["conversation.message"]).toEqual({ kind: "chain", scope: "session" });
    expect(CORE_SLOT_SPECS["conversation.composerDock"]).toEqual({ kind: "single", scope: "session-maybe" });
    expect(CORE_SLOT_SPECS["composer.main"]).toEqual({ kind: "chain", scope: "session-maybe" });
    expect(CORE_SLOT_SPECS["workbench.panes"]).toEqual({ kind: "keyed", scope: "session-maybe" });
    expect(CORE_SLOT_SPECS["hub.pages"]).toEqual({ kind: "keyed", scope: "root" });
  });

  it("mounts builtin core plugins by default, hot-swaps to user override, restores on error/disable/removal/SafeMode, and respects canDisable", async () => {
    const root = new Context();
    const registry = new SlotRegistry();
    await root.plugin(ClientSlotsService, registry);

    let builtinShellMounts = 0;
    let builtinShellDisposals = 0;
    let builtinReviewMounts = 0;
    let builtinReviewDisposals = 0;

    const coreShellPlugin: Plugin = {
      name: "core-shell",
      inject: ["slots"],
      apply(ctx: Context) {
        builtinShellMounts += 1;
        ctx.slots.register("root", {
          id: "builtin-root",
          component: () => createElement("div", null, "builtin-core-shell"),
        });
        ctx.effect(() => () => {
          builtinShellDisposals += 1;
        });
      },
    };

    const codeReviewPlugin: Plugin = {
      name: "code-review",
      inject: ["slots"],
      apply(ctx: Context) {
        builtinReviewMounts += 1;
        ctx.slots.register("workbench.panes", {
          id: "builtin-review-pane",
          key: "review",
          component: () => createElement("div", null, "builtin-code-review"),
        });
        ctx.effect(() => () => {
          builtinReviewDisposals += 1;
        });
      },
    };

    const descriptors: BuiltinCorePluginDescriptor[] = [
      { id: "core-shell", plugin: coreShellPlugin, canDisable: false },
      { id: "code-review", plugin: codeReviewPlugin, canDisable: true },
    ];

    let hostPlugins: PluginInfo[] = [
      makePluginInfo({ id: "core-shell", tier: "builtin", enabled: true, status: "active" }),
      makePluginInfo({ id: "code-review", tier: "builtin", enabled: true, status: "active" }),
    ];
    const changeListeners = new Set<(payload?: PluginChangedNotification) => void>();
    const emitChanged = () => {
      for (const listener of [...changeListeners]) listener(undefined);
    };

    const bundles = new Map<string, { etag: string; code: string }>();
    const targetGlobal: { __ModuleLoader__?: ModuleLoaderGlobal } = {};
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
      descriptors,
    });

    await Promise.all([externalRuntime.sync(), coordinator.sync()]);

    // 1. Both builtin plugins mounted with proper pluginId & builtin tier
    expect(coordinator.isMounted("core-shell")).toBe(true);
    expect(coordinator.isMounted("code-review")).toBe(true);
    expect(builtinShellMounts).toBe(1);
    expect(builtinReviewMounts).toBe(1);
    expect(registry.getEntries("root")[0]?.pluginId).toBe("core-shell");
    expect(registry.getEntries("root")[0]?.tier).toBe("builtin");
    expect(renderToStaticMarkup(createElement(SlotRoot, { registry, ctx: root }))).toContain("builtin-core-shell");
    expect(
      renderToStaticMarkup(
        createElement(
          SlotKernelProvider,
          { registry, ctx: root },
          createElement(SlotHost, { slotKey: "workbench.panes", routeKey: "review", registry, rootCtx: root }),
        ),
      ),
    ).toContain("builtin-code-review");

    // 2. Active user-tier override with same id ("core-shell") unmounts builtin Fiber & mounts user override
    bundles.set("core-shell", {
      etag: "etag-user-v1",
      code: `window.__ModuleLoader__.load({
        id: "core-shell",
        factory: (req) => {
          const React = req("react");
          return {
            name: "core-shell",
            inject: ["slots"],
            apply(ctx) {
              ctx.slots.register("root", {
                id: "user-root",
                component: () => React.createElement("div", null, "user-custom-shell"),
              });
            },
          };
        },
      });`,
    });
    hostPlugins = [
      makePluginInfo({
        id: "core-shell",
        tier: "user",
        enabled: true,
        status: "active",
        overridesBuiltin: true,
        clientEtag: "etag-user-v1",
      }),
      makePluginInfo({ id: "code-review", tier: "builtin", enabled: true, status: "active" }),
    ];
    emitChanged();
    await Promise.all([externalRuntime.sync(), coordinator.sync()]);

    expect(coordinator.isMounted("core-shell")).toBe(false);
    expect(builtinShellDisposals).toBe(1);
    expect(coordinator.getSnapshot().plugins.find((p) => p.id === "core-shell")).toEqual({
      id: "core-shell",
      canDisable: false,
      status: "overridden",
      overrideTier: "user",
    });
    expect(renderToStaticMarkup(createElement(SlotRoot, { registry, ctx: root }))).toContain("user-custom-shell");

    // 3. Safe Mode unmounts user override and immediately restores builtin layer
    safeMode.enable("hotkey");
    await Promise.all([externalRuntime.sync(), coordinator.sync()]);

    expect(coordinator.isMounted("core-shell")).toBe(true);
    expect(renderToStaticMarkup(createElement(SlotRoot, { registry, ctx: root }))).toContain("builtin-core-shell");

    // Exiting Safe Mode re-activates the healthy user override
    safeMode.disable();
    await Promise.all([externalRuntime.sync(), coordinator.sync()]);

    expect(coordinator.isMounted("core-shell")).toBe(false);
    expect(renderToStaticMarkup(createElement(SlotRoot, { registry, ctx: root }))).toContain("user-custom-shell");

    // 4a. Removing user override restores builtin immediately
    hostPlugins = [
      makePluginInfo({ id: "core-shell", tier: "builtin", enabled: true, status: "active" }),
      makePluginInfo({ id: "code-review", tier: "builtin", enabled: true, status: "active" }),
    ];
    emitChanged();
    await Promise.all([externalRuntime.sync(), coordinator.sync()]);
    expect(coordinator.isMounted("core-shell")).toBe(true);
    expect(renderToStaticMarkup(createElement(SlotRoot, { registry, ctx: root }))).toContain("builtin-core-shell");

    // 4b. Installing a broken user override whose apply() throws immediately falls back to builtin Fiber
    bundles.set("core-shell", {
      etag: "etag-user-broken",
      code: `window.__ModuleLoader__.load({
        id: "core-shell",
        factory: () => ({
          name: "core-shell",
          apply() {
            throw new Error("broken user shell apply()");
          },
        }),
      });`,
    });
    hostPlugins = [
      makePluginInfo({
        id: "core-shell",
        tier: "user",
        enabled: true,
        status: "active",
        overridesBuiltin: true,
        clientEtag: "etag-user-broken",
      }),
      makePluginInfo({ id: "code-review", tier: "builtin", enabled: true, status: "active" }),
    ];
    emitChanged();
    await externalRuntime.sync();
    await coordinator.sync({ fetchList: false });

    expect(coordinator.isMounted("core-shell")).toBe(true);
    expect(renderToStaticMarkup(createElement(SlotRoot, { registry, ctx: root }))).toContain("builtin-core-shell");

    // 5. Disabling user override restores/keeps builtin for canDisable: false,
    //    while disabling a canDisable: true feature plugin ("code-review") unmounts its builtin Fiber
    hostPlugins = [
      makePluginInfo({
        id: "core-shell",
        tier: "user",
        enabled: false,
        status: "disabled",
        overridesBuiltin: true,
        clientEtag: "etag-user-v1",
      }),
      makePluginInfo({ id: "code-review", tier: "builtin", enabled: false, status: "disabled" }),
    ];
    emitChanged();
    await Promise.all([externalRuntime.sync(), coordinator.sync()]);

    expect(coordinator.isMounted("core-shell")).toBe(true);
    expect(coordinator.isMounted("code-review")).toBe(false);
    expect(builtinReviewDisposals).toBe(1);
    expect(coordinator.getSnapshot().plugins.find((p) => p.id === "code-review")?.status).toBe("disabled");
    expect(
      renderToStaticMarkup(
        createElement(
          SlotKernelProvider,
          { registry, ctx: root },
          createElement(SlotHost, { slotKey: "workbench.panes", routeKey: "review", registry, rootCtx: root }),
        ),
      ),
    ).toBe("");

    await coordinator.dispose();
    await externalRuntime.dispose();
    registry.dispose();
  });

  it("renders SafeModeBanner outside <SlotRoot /> when useSafeMode().active is true with both recovery actions", () => {
    const controller = createSafeModeController({ windowLike: null, storage: createMemoryStorage() });
    const onOpenPlugins = vi.fn();
    const onExitSafeMode = vi.fn();

    expect(controller.getSnapshot().active).toBe(false);
    expect(
      renderToStaticMarkup(createElement(SafeModeBanner, { controller, onOpenPlugins, onExitSafeMode })),
    ).toBe("");

    controller.enable("hotkey");
    expect(controller.getSnapshot().active).toBe(true);

    const mounted = mountMiniDom(
      createElement(SafeModeBanner, { controller, onOpenPlugins }),
    );
    expect(mounted.container.textContent).toContain("安全模式已启用");
    expect(mounted.container.textContent).toContain("Ctrl+Shift+Alt+R");
    expect(mounted.container.textContent).toContain("打开插件管理排查");
    expect(mounted.container.textContent).toContain("退出安全模式恢复外部插件");

    const openBtn = mounted.container.querySelector('[data-testid="safe-mode-open-plugins"]');
    expect(openBtn).not.toBeNull();
    act(() => {
      openBtn?.dispatchEvent(new MiniEvent("click"));
    });
    expect(onOpenPlugins).toHaveBeenCalledTimes(1);

    const exitBtn = mounted.container.querySelector('[data-testid="safe-mode-exit"]');
    expect(exitBtn).not.toBeNull();
    act(() => {
      exitBtn?.dispatchEvent(new MiniEvent("click"));
    });
    expect(controller.getSnapshot().active).toBe(false);
    expect(mounted.container.querySelector('[data-testid="safe-mode-banner"]')).toBeNull();
  });

  it("wires registerBuiltinCorePlugins() cleanly into ensureClientPluginRuntime()", async () => {
    let mounted = false;
    const unregister = registerBuiltinCorePlugins([
      {
        id: "wave2a-smoke-core",
        canDisable: false,
        plugin: {
          name: "wave2a-smoke-core",
          apply(ctx: Context) {
            mounted = true;
            ctx.effect(() => () => {
              mounted = false;
            });
          },
        },
      },
    ]);

    ensureClientPluginRuntime();
    const coordinator = getBuiltinCorePluginCoordinator();
    expect(coordinator).toBeDefined();
    await coordinator?.sync({ fetchList: false });
    expect(mounted).toBe(true);
    expect(coordinator?.isMounted("wave2a-smoke-core")).toBe(true);

    unregister();
    await coordinator?.sync({ fetchList: false });
    expect(mounted).toBe(false);
  });
});

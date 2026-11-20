import { join, resolve } from "node:path";
import { createElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { Context } from "@deepseek-ai/cordis";
import { ESLint } from "eslint";
import type { PluginChangedNotification, PluginClientBundleResult, PluginInfo } from "@qianji/protocol";
import { afterEach, describe, expect, it } from "vitest";
import {
  ClientContributionRegistry,
  ClientContributionService,
  ClientStylesService,
} from "../src/lib/clientContributions";
import { CLIENT_MODULES } from "../src/lib/clientPluginBootstrap";
import {
  createClientPluginRuntime,
  tagFiberPluginId,
  type ModuleLoaderGlobal,
} from "../src/lib/clientPluginRuntime";
import {
  clearPluginTiers,
  createSafeModeController,
  createSafeModeGatedTransport,
  createSlotOverridesStore,
  currentStyleSeq,
  injectPluginGlobalStyle,
  injectPluginScopedStyle,
  isSafeModeHotkeyEvent,
  pruneStaleBundleStyles,
  removeAllPluginStyles,
  rollbackBundleStyles,
  SAFE_MODE_STORAGE_KEY,
  setPluginTier,
  SLOT_OVERRIDES_STORAGE_KEY,
  snapshotBundleStyles,
  wrapPluginGlobalCss,
  type SafeModeKeyEventLike,
  type SafeModeWindowLike,
} from "../src/kernel/runtime";
import {
  AbdicationTracker,
  ClientSlotsService,
  createBoundRenderers,
  createResourceCell,
  resolveChainItems,
  SessionArea,
  SlotFactoryHost,
  SlotHost,
  SlotKernelErrorBoundary,
  SlotKernelProvider,
  SlotOwnershipError,
  SlotRegistry,
  SlotRoot,
  StaleAuthorizationError,
  useResource,
  WrapperErrorBoundary,
  type AbdicationCycle,
  type AbdicationRecord,
  type SlotScopeAdapter,
} from "../src/kernel/slots";
import {
  createReactiveStore,
  SlotStoreRegistry,
  type StoreDecl,
} from "../src/kernel/store";

const REPO_ROOT = resolve(__dirname, "..");

function createMemoryStorage() {
  const data = new Map<string, string>();
  return {
    data,
    getItem(key: string): string | null {
      return data.get(key) ?? null;
    },
    setItem(key: string, value: string): void {
      data.set(key, value);
    },
    removeItem(key: string): void {
      data.delete(key);
    },
  };
}

interface MockStyleNode {
  attrs: Map<string, string>;
  textContent: string;
  isConnected: boolean;
  setAttribute(k: string, v: string): void;
  getAttribute(k: string): string | null;
  remove(): void;
}

function installMockHeadDocument() {
  const styles: MockStyleNode[] = [];
  const mockDoc = {
    head: {
      appendChild(node: MockStyleNode) {
        node.isConnected = true;
        if (!styles.includes(node)) styles.push(node);
        return node;
      },
    },
    createElement(): MockStyleNode {
      const attrs = new Map<string, string>();
      const node: MockStyleNode = {
        attrs,
        textContent: "",
        isConnected: false,
        setAttribute(k: string, v: string) {
          attrs.set(k, v);
        },
        getAttribute(k: string) {
          return attrs.get(k) ?? null;
        },
        remove() {
          node.isConnected = false;
          const idx = styles.indexOf(node);
          if (idx >= 0) styles.splice(idx, 1);
        },
      };
      return node;
    },
    querySelectorAll(selector: string) {
      const match = /^style\[data-qj-plugin-style="([^"]+)"\]$/.exec(selector);
      if (match === null) return [];
      return styles.filter((node) => node.attrs.get("data-qj-plugin-style") === match[1]);
    },
  };
  const prevDoc = globalThis.document;
  (globalThis as Record<string, unknown>).document = mockDoc;
  return {
    styles,
    restore() {
      if (prevDoc === undefined) {
        delete (globalThis as Record<string, unknown>).document;
      } else {
        globalThis.document = prevDoc;
      }
    },
  };
}

describe("ADR 0023 Phase 1: Typed Client Slot Kernel, Store, Runtime & Guardrails", () => {
  afterEach(() => {
    clearPluginTiers();
  });

  it("supports single, list, keyed, chain (with overlay display:none preservation), and onion wrap decorators", () => {
    const overrides = createSlotOverridesStore({ storage: createMemoryStorage() });
    const registry = new SlotRegistry({ overrides, stores: new SlotStoreRegistry() });

    // 1. Single conflict election: override > tier (workspace > user > builtin) > priority > registration order
    registry.defineSlot("shell.header", { kind: "single", scope: "root" });
    registry.register("shell.header", {
      id: "builtin-header",
      pluginId: "core-shell",
      tier: "builtin",
      priority: 100,
      component: () => createElement("header", null, "builtin-header"),
    });
    registry.register("shell.header", {
      id: "user-low",
      pluginId: "user-a",
      tier: "user",
      priority: 10,
      component: () => createElement("header", null, "user-low"),
    });
    registry.register("shell.header", {
      id: "user-high",
      pluginId: "user-b",
      tier: "user",
      priority: 50,
      component: () => createElement("header", null, "user-high"),
    });
    registry.register("shell.header", {
      id: "ws-header",
      pluginId: "ws-plugin",
      tier: "workspace",
      priority: 1,
      component: () => createElement("header", null, "ws-header"),
    });

    // Workspace tier beats user & builtin regardless of numeric priority
    expect(renderToStaticMarkup(createElement(SlotHost, { slotKey: "shell.header", registry }))).toContain("ws-header");

    // User slotOverrides pins builtin above workspace!
    overrides.set("shell.header", "core-shell");
    expect(renderToStaticMarkup(createElement(SlotHost, { slotKey: "shell.header", registry }))).toContain("builtin-header");

    // Exact entryId override pins user-low above user-high and workspace!
    overrides.set("shell.header", "user-low");
    expect(renderToStaticMarkup(createElement(SlotHost, { slotKey: "shell.header", registry }))).toContain("user-low");

    // Clearing override returns to workspace winner
    overrides.clear("shell.header");
    expect(renderToStaticMarkup(createElement(SlotHost, { slotKey: "shell.header", registry }))).toContain("ws-header");

    // 2. List slot ordering by order asc then registration sequence
    registry.defineSlot("status.items", { kind: "list", scope: "root" });
    registry.register("status.items", {
      id: "item-b",
      order: 20,
      component: () => createElement("span", null, "[B]"),
    });
    registry.register("status.items", {
      id: "item-a",
      order: 10,
      component: () => createElement("span", null, "[A]"),
    });
    const listHtml = renderToStaticMarkup(createElement(SlotHost, { slotKey: "status.items", registry }));
    expect(listHtml.indexOf("[A]")).toBeLessThan(listHtml.indexOf("[B]"));

    // 3. Keyed slot routing (exact + prefix wildcard + fallback)
    registry.defineSlot("tool.card", { kind: "keyed", scope: "root" });
    registry.register("tool.card", {
      id: "sqlite-card",
      key: ["sqlite_*"],
      tier: "user",
      component: (p) => createElement("div", null, `SQLite:${String(p.toolName)}`),
    });
    registry.register("tool.card", {
      id: "default-card",
      key: "*",
      tier: "builtin",
      component: (p) => createElement("div", null, `Default:${String(p.toolName)}`),
    });
    expect(
      renderToStaticMarkup(
        createElement(SlotHost, {
          slotKey: "tool.card",
          routeKey: "sqlite_query",
          props: { toolName: "sqlite_query" },
          registry,
        }),
      ),
    ).toContain("SQLite:sqlite_query");
    expect(
      renderToStaticMarkup(
        createElement(SlotHost, {
          slotKey: "tool.card",
          routeKey: "bash",
          props: { toolName: "bash" },
          registry,
        }),
      ),
    ).toContain("Default:bash");

    // 4. Chain slot with pure select() and overlay: true preserving fallback under display:none
    registry.defineSlot("composer.main", { kind: "chain", scope: "root" });
    registry.register("composer.main", {
      id: "builtin-composer",
      pluginId: "core-composer",
      tier: "builtin",
      component: () => createElement("textarea", { defaultValue: "draft-preserved" }),
    });
    registry.register("composer.main", {
      id: "approval-overlay",
      pluginId: "approval-plugin",
      tier: "user",
      priority: 10,
      overlay: true,
      select: (ownerProps) => (ownerProps.pendingApproval === true ? { prompt: "Approve?" } : null),
      component: (p) => createElement("div", { className: "approval-bar" }, String((p.selected as { prompt: string }).prompt)),
    });

    const overlayActiveHtml = renderToStaticMarkup(
      createElement(SlotHost, {
        slotKey: "composer.main",
        props: { pendingApproval: true },
        registry,
      }),
    );
    expect(overlayActiveHtml).toContain("Approve?");
    expect(overlayActiveHtml).toContain("draft-preserved");
    expect(overlayActiveHtml).toContain('data-qj-chain-hidden="true"');
    expect(overlayActiveHtml).toContain("display:none");

    // Verify stable bottom-to-top ordering so base fallback stays mounted when overlay disappears
    const activeItems = resolveChainItems(
      "composer.main",
      registry.getRankedCandidates("composer.main"),
      { pendingApproval: true },
      registry,
    );
    const idleItems = resolveChainItems(
      "composer.main",
      registry.getRankedCandidates("composer.main"),
      { pendingApproval: false },
      registry,
    );
    expect(activeItems.map((i) => ({ id: i.entry.id, hidden: i.hidden }))).toEqual([
      { id: "builtin-composer", hidden: true },
      { id: "approval-overlay", hidden: false },
    ]);
    expect(idleItems.map((i) => ({ id: i.entry.id, hidden: i.hidden }))).toEqual([
      { id: "builtin-composer", hidden: false },
    ]);

    // 5. Onion decorators via wrap() and fault-skipping WrapperErrorBoundary
    registry.wrap("shell.header", {
      id: "outer-wrap",
      pluginId: "wrap-a",
      priority: 20,
      component: ({ children }) => createElement("section", { "data-wrap": "outer" }, children),
    });
    registry.wrap("shell.header", {
      id: "inner-wrap",
      pluginId: "wrap-b",
      priority: 10,
      component: ({ children }) => createElement("article", { "data-wrap": "inner" }, children),
    });
    const wrappedHtml = renderToStaticMarkup(createElement(SlotHost, { slotKey: "shell.header", registry }));
    expect(wrappedHtml.indexOf('data-wrap="outer"')).toBeLessThan(wrappedHtml.indexOf('data-wrap="inner"'));
    expect(wrappedHtml.indexOf('data-wrap="inner"')).toBeLessThan(wrappedHtml.indexOf("ws-header"));

    // Verify WrapperErrorBoundary catches a throwing wrapper and renders inner content untouched
    const crashes: Error[] = [];
    const innerContent = createElement("span", null, "inner-intact");
    const wrapperBoundary = new WrapperErrorBoundary({
      wrapperId: "bad-wrap",
      pluginId: "rogue-wrapper",
      slotKey: "shell.header",
      fallback: innerContent,
      onCrash: (err) => crashes.push(err),
      children: createElement("div", null, "never-reached"),
    });
    wrapperBoundary.state = WrapperErrorBoundary.getDerivedStateFromError();
    wrapperBoundary.componentDidCatch(new Error("wrapper exploded"), { componentStack: "" });
    expect(crashes).toHaveLength(1);
    expect(renderToStaticMarkup(createElement("div", null, wrapperBoundary.render()))).toContain("inner-intact");

    // Once a wrapper is abdicated, SlotHost skips it automatically without calling it
    let badWrapperCalls = 0;
    registry.wrap("shell.header", {
      id: "broken-wrap",
      pluginId: "bad-wrap-plugin",
      priority: 30,
      component: ({ children }) => {
        badWrapperCalls += 1;
        return createElement("div", null, children);
      },
    });
    registry.abdication.abdicate({
      slotKey: "wrap:shell.header",
      entryId: "broken-wrap",
      pluginId: "bad-wrap-plugin",
      error: new Error("wrap boom"),
    });
    const postSkipHtml = renderToStaticMarkup(createElement(SlotHost, { slotKey: "shell.header", registry }));
    expect(badWrapperCalls).toBe(0);
    expect(postSkipHtml).toContain('data-wrap="outer"');
    expect(postSkipHtml).toContain("ws-header");

    registry.dispose();
  });

  it("enforces ChildrenDecl ownership (SlotOwnershipError) and Fiber liveness (StaleAuthorizationError)", async () => {
    const root = new Context();
    const registry = new SlotRegistry({ stores: new SlotStoreRegistry() });
    await root.plugin(ClientSlotsService, registry);

    let capturedRenderSlot: ((slotKey: string, props?: Record<string, unknown>) => ReactNode) | undefined;
    let capturedRenderChain: ((slotKey: string, props?: Record<string, unknown>) => ReactNode) | undefined;
    let capturedRenderFactory: ((factoryKey: string, props?: Record<string, unknown>) => ReactNode) | undefined;

    const shellFiber = await root.plugin({
      name: "core-shell",
      inject: ["slots"],
      apply(ctx: Context) {
        ctx.slots.register("root", {
          id: "core-shell-root",
          tier: "builtin",
          children: {
            "shell.sidebar": { kind: "single", scope: "root" },
            "composer.main": { kind: "chain", scope: "root" },
          },
          component: ({ renderSlot, renderSlotChain, renderFactory }) => {
            capturedRenderSlot = renderSlot as typeof capturedRenderSlot;
            capturedRenderChain = renderSlotChain as typeof capturedRenderChain;
            capturedRenderFactory = renderFactory as typeof capturedRenderFactory;
            return createElement(
              "main",
              null,
              renderSlot("shell.sidebar"),
              renderSlotChain("composer.main"),
            );
          },
        });
        ctx.slots.register("shell.sidebar", {
          id: "builtin-sidebar",
          tier: "builtin",
          component: () => createElement("aside", null, "sidebar-ok"),
        });
        ctx.slots.register("composer.main", {
          id: "builtin-composer",
          tier: "builtin",
          component: () => createElement("div", null, "composer-ok"),
        });
      },
    });

    const html = renderToStaticMarkup(createElement(SlotRoot, { registry, ctx: root }));
    expect(html).toContain("sidebar-ok");
    expect(html).toContain("composer-ok");
    expect(capturedRenderSlot).toBeDefined();
    expect(capturedRenderChain).toBeDefined();
    expect(capturedRenderFactory).toBeDefined();

    // Unowned child slot throws SlotOwnershipError
    expect(() => capturedRenderSlot?.("shell.secret")).toThrow(SlotOwnershipError);
    // Calling renderSlotChain on a non-chain child throws SlotOwnershipError
    expect(() => capturedRenderChain?.("shell.sidebar")).toThrow(SlotOwnershipError);

    // Cross-parent child ownership claim throws SlotOwnershipError
    expect(() =>
      registry.register("other.parent", {
        id: "stealer",
        children: { "shell.sidebar": { kind: "single", scope: "root" } },
        component: () => null,
      }),
    ).toThrow(SlotOwnershipError);

    // Competing override in the SAME parent slot ("root") IS permitted to claim the same children
    const disposeOverride = registry.register("root", {
      id: "custom-shell-root",
      pluginId: "custom-shell",
      tier: "user",
      children: { "shell.sidebar": { kind: "single", scope: "root" } },
      component: ({ renderSlot }) => createElement("div", null, "custom:", renderSlot("shell.sidebar")),
    });
    const customShellHtml = renderToStaticMarkup(createElement(SlotRoot, { registry, ctx: root }));
    expect(customShellHtml).toContain("custom:");
    expect(customShellHtml).toContain("sidebar-ok");
    expect(customShellHtml).toContain('data-qj-plugin="custom-shell"');
    disposeOverride();

    // Disposing the Fiber invalidates captured handles -> StaleAuthorizationError
    await shellFiber.dispose();
    expect(() => capturedRenderSlot?.("shell.sidebar")).toThrow(StaleAuthorizationError);
    expect(() => capturedRenderChain?.("composer.main")).toThrow(StaleAuthorizationError);
    expect(() => capturedRenderFactory?.("any.factory")).toThrow(StaleAuthorizationError);

    // Also verify same-entryId HMR re-registration replaces the old authorization cleanly
    // while bumping registeredSeq so EntryInvokeBody refreshes its memoized bound renderers
    let hmrBoundV1: ((slotKey: string) => ReactNode) | undefined;
    let hmrBoundV2: ((slotKey: string) => ReactNode) | undefined;
    const disposeChild = registry.register("hmr.child", {
      id: "hmr-child-impl",
      component: () => createElement("span", null, "hmr-child-ok"),
    });
    const disposeV1 = registry.register("root", {
      id: "hmr-shell",
      children: { "hmr.child": { kind: "single", scope: "root" } },
      component: ({ renderSlot }) => {
        hmrBoundV1 = renderSlot as (slotKey: string) => ReactNode;
        return createElement("div", null, "v1:", renderSlot("hmr.child"));
      },
    });
    const seqV1 = registry.getEntries("root").find((e) => e.id === "hmr-shell")?.registeredSeq ?? 0;
    expect(renderToStaticMarkup(createElement(SlotRoot, { registry, ctx: root }))).toContain("hmr-child-ok");

    // Re-register with the EXACT SAME entryId (simulating hot-swap without prior explicit dispose)
    const disposeV2 = registry.register("root", {
      id: "hmr-shell",
      children: { "hmr.child": { kind: "single", scope: "root" } },
      component: ({ renderSlot }) => {
        hmrBoundV2 = renderSlot as (slotKey: string) => ReactNode;
        return createElement("div", null, "v2:", renderSlot("hmr.child"));
      },
    });
    const seqV2 = registry.getEntries("root").find((e) => e.id === "hmr-shell")?.registeredSeq ?? 0;
    expect(seqV2).toBeGreaterThan(seqV1);
    // Prior handle from v1 is now stale
    expect(() => hmrBoundV1?.("hmr.child")).toThrow(StaleAuthorizationError);
    // Live v2 renders cleanly with a fresh authorization handle
    const v2Html = renderToStaticMarkup(createElement(SlotRoot, { registry, ctx: root }));
    expect(v2Html).toContain("v2:");
    expect(v2Html).toContain("hmr-child-ok");
    expect(hmrBoundV2).toBeDefined();
    expect(hmrBoundV2).not.toBe(hmrBoundV1);
    disposeV1();
    // Disposing the superseded v1 disposer must NOT tear down live v2
    expect(renderToStaticMarkup(createElement(SlotRoot, { registry, ctx: root }))).toContain("v2:");
    disposeV2();
    disposeChild();

    // Also verify createBoundRenderers directly on a live then disposed authorization
    const directDispose = registry.register("root", {
      id: "direct-auth-check",
      children: { "direct.child": { kind: "single", scope: "root" } },
      component: () => null,
    });
    const directAuth = registry.getAuthorization("direct-auth-check");
    expect(directAuth).toBeDefined();
    if (directAuth !== undefined) {
      const bound = createBoundRenderers(registry, directAuth, root);
      expect(bound.renderSlot("direct.child")).toBeDefined();
      directDispose();
      expect(() => bound.renderSlot("direct.child")).toThrow(StaleAuthorizationError);
    }
    registry.dispose();
  });

  it("binds SlotScope (root / session-maybe / session) via <SessionArea> and SlotScopeAdapter", () => {
    let activeSession: string | null = "s-active";
    const sessionListeners = new Set<() => void>();
    const adapter: SlotScopeAdapter = {
      getActiveSessionId: () => activeSession,
      subscribeActiveSession: (listener) => {
        sessionListeners.add(listener);
        return () => sessionListeners.delete(listener);
      },
    };
    const registry = new SlotRegistry({ scopeAdapter: adapter, stores: new SlotStoreRegistry() });
    registry.defineSlot("thread.view", { kind: "single", scope: "session" });
    registry.defineSlot("status.session", { kind: "single", scope: "session-maybe" });

    registry.register("thread.view", {
      id: "thread-impl",
      component: (p) => createElement("div", null, `session=${String(p.sessionId)}`),
    });
    registry.register("status.session", {
      id: "status-impl",
      component: (p) => createElement("span", null, `maybe=${String(p.sessionId)}`),
    });

    // Multi-session side-by-side isolation via <SessionArea>
    const dualHtml = renderToStaticMarkup(
      createElement(
        SlotKernelProvider,
        { registry },
        createElement(
          SessionArea,
          { sessionId: "s-main" },
          createElement(SlotHost, { slotKey: "thread.view" }),
        ),
        createElement(
          SessionArea,
          { sessionId: "s-side" },
          createElement(SlotHost, { slotKey: "thread.view" }),
        ),
      ),
    );
    expect(dualHtml).toContain("session=s-main");
    expect(dualHtml).toContain("session=s-side");

    // Falls back to SlotScopeAdapter when no <SessionArea> wraps the slot
    const adapterHtml = renderToStaticMarkup(
      createElement(SlotKernelProvider, { registry }, createElement(SlotHost, { slotKey: "thread.view" })),
    );
    expect(adapterHtml).toContain("session=s-active");

    // When active session is null: "session" renders fallback, "session-maybe" renders with null
    activeSession = null;
    const noSessionHtml = renderToStaticMarkup(
      createElement(
        SlotKernelProvider,
        { registry },
        createElement(SlotHost, {
          slotKey: "thread.view",
          fallback: createElement("em", null, "no-session-fallback"),
        }),
        createElement(SlotHost, { slotKey: "status.session" }),
      ),
    );
    expect(noSessionHtml).toContain("no-session-fallback");
    expect(noSessionHtml).toContain("maybe=null");

    registry.dispose();
  });

  it("manages per-slot and per-factory-occurrence Store seats with automatic teardown", async () => {
    const stores = new SlotStoreRegistry();
    const registry = new SlotRegistry({ stores });
    const disposedLog: string[] = [];

    const counterDecl: StoreDecl<{ count: ReturnType<typeof createReactiveStore<number>>; tag: string }> = {
      create(ctx) {
        const count = createReactiveStore(0);
        const tag = `${ctx.entryId}@${ctx.scopeKey}${ctx.occurrenceKey === undefined ? "" : `#${ctx.occurrenceKey}`}`;
        ctx.onDispose(() => {
          disposedLog.push(`onDispose:${tag}`);
        });
        return { count, tag };
      },
      dispose(store) {
        disposedLog.push(`declDispose:${store.tag}`);
      },
    };

    const root = new Context();
    await root.plugin(ClientSlotsService, registry);

    const fiber = await root.plugin({
      name: "stateful-plugin",
      inject: ["slots"],
      apply(ctx: Context) {
        ctx.slots.defineSlot("panel.counter", { kind: "single", scope: "session" });
        ctx.slots.register("panel.counter", {
          id: "counter-entry",
          store: counterDecl,
          component: ({ store }) => createElement("div", null, `seat=${store.tag}`),
        });
        ctx.slots.registerFactory("card.item", {
          id: "card-factory",
          scope: "root",
          store: counterDecl,
          component: ({ store, label }: { store: { tag: string }; label?: string }) =>
            createElement("div", null, `${String(label)}:${store.tag}`),
        });
      },
    });

    // Separate scopes get isolated Store seats
    const html = renderToStaticMarkup(
      createElement(
        SlotKernelProvider,
        { registry, ctx: root },
        createElement(SessionArea, { sessionId: "s1" }, createElement(SlotHost, { slotKey: "panel.counter" })),
        createElement(SessionArea, { sessionId: "s2" }, createElement(SlotHost, { slotKey: "panel.counter" })),
      ),
    );
    expect(html).toContain("seat=counter-entry@session:s1");
    expect(html).toContain("seat=counter-entry@session:s2");

    const s1Store = stores.storeOf<{ count: ReturnType<typeof createReactiveStore<number>>; tag: string }>(
      "counter-entry",
      "session:s1",
    );
    const s2Store = stores.storeOf<{ count: ReturnType<typeof createReactiveStore<number>>; tag: string }>(
      "counter-entry",
      "session:s2",
    );
    s1Store.count.set(7);
    expect(s1Store.count.get()).toBe(7);
    expect(s2Store.count.get()).toBe(0);

    // Scope disposal tears down ONLY session:s1
    stores.disposeScope("session:s1");
    expect(stores.peekStoreOf("counter-entry", "session:s1")).toBeUndefined();
    expect(stores.peekStoreOf("counter-entry", "session:s2")).toBe(s2Store);
    expect(disposedLog).toContain("onDispose:counter-entry@session:s1");
    expect(disposedLog).toContain("declDispose:counter-entry@session:s1");

    // Factory occurrences get isolated per-occurrence seats & ref-counted retention
    const factoryHtml = renderToStaticMarkup(
      createElement(
        SlotKernelProvider,
        { registry, ctx: root },
        createElement(SlotFactoryHost, { factoryKey: "card.item", occurrenceKey: "occ-1", props: { label: "One" } }),
        createElement(SlotFactoryHost, { factoryKey: "card.item", occurrenceKey: "occ-2", props: { label: "Two" } }),
      ),
    );
    expect(factoryHtml).toContain("One:card-factory@root#occ-1");
    expect(factoryHtml).toContain("Two:card-factory@root#occ-2");

    // Direct retainFactoryOccurrence ref-counting & factoryStoreOf lookup
    const disposeDirect = stores.registerFactoryStore("direct.widget", counterDecl);
    const r1 = stores.retainFactoryOccurrence<{ tag: string }>("direct.widget", "k1", "root");
    const r2 = stores.retainFactoryOccurrence<{ tag: string }>("direct.widget", "k1", "root");
    expect(r1.store).toBe(r2.store);
    expect(stores.factoryStoreOf("direct.widget", "k1", "root")).toBe(r1.store);
    r1.release();
    // Still retained by r2
    expect(stores.factoryStoreOf("direct.widget", "k1", "root")).toBe(r1.store);
    r2.release();
    // Ref-count hit 0 -> automatically disposed
    expect(stores.factoryStoreOf("direct.widget", "k1", "root")).toBeUndefined();
    expect(disposedLog).toContain("onDispose:direct.widget@root#k1");
    disposeDirect();

    // Disposing the Cordis Fiber tears down remaining slot & factory seats automatically
    await fiber.dispose();
    expect(stores.getActiveSeatCount()).toBe(0);
    expect(disposedLog).toContain("onDispose:counter-entry@session:s2");
    expect(disposedLog).toContain("onDispose:card-factory@root#occ-1");
    expect(disposedLog).toContain("onDispose:card-factory@root#occ-2");

    registry.dispose();
  });

  it("abdicates crashing or locked-out single/chain entries to fallback and unlocks on (etag, configKey, reloadEpoch) change", () => {
    const cycles = new Map<string, AbdicationCycle>([
      ["rogue-composer", { etag: "v1", configKey: "{}", reloadEpoch: 0 }],
    ]);
    const recordedErrors: Array<{ pluginId: string | undefined; slotId: string; message: string }> = [];
    const abdications: AbdicationRecord[] = [];
    let lockedOut = false;

    const abdication = new AbdicationTracker({
      getCycle: (id) => cycles.get(id) ?? { etag: "", configKey: "{}", reloadEpoch: 0 },
      recordError: (pluginId, slotId, error) => {
        recordedErrors.push({
          pluginId,
          slotId,
          message: error instanceof Error ? error.message : String(error),
        });
      },
      getLockout: (pluginId, slotId) =>
        lockedOut && pluginId === "rogue-composer" && slotId === "composer.main:rogue-entry"
          ? { locked: true, message: "previously crashed" }
          : { locked: false },
      subscribeErrors: () => () => undefined,
    });
    abdication.onAbdicate((record) => abdications.push(record));

    const registry = new SlotRegistry({ abdication, stores: new SlotStoreRegistry() });
    registry.defineSlot("composer.main", { kind: "single", scope: "root" });
    registry.register("composer.main", {
      id: "builtin-entry",
      pluginId: "core-composer",
      tier: "builtin",
      component: () => createElement("div", null, "builtin-safe-composer"),
    });
    registry.register("composer.main", {
      id: "rogue-entry",
      pluginId: "rogue-composer",
      tier: "user",
      component: () => createElement("div", null, "rogue-custom-composer"),
    });

    // Initially user entry wins
    expect(renderToStaticMarkup(createElement(SlotHost, { slotKey: "composer.main", registry }))).toContain(
      "rogue-custom-composer",
    );

    // Simulate ErrorBoundary catching a render crash from rogue-entry
    const boundary = new SlotKernelErrorBoundary({
      pluginId: "rogue-composer",
      entryId: "rogue-entry",
      slotKey: "composer.main",
      hasFallbackCandidate: true,
      onCrash: (err) => {
        abdication.abdicate({
          slotKey: "composer.main",
          entryId: "rogue-entry",
          pluginId: "rogue-composer",
          error: err,
          fallbackEntryId: "builtin-entry",
          fallbackPluginId: "core-composer",
        });
      },
      children: null,
    });
    const boom = new Error("composer exploded");
    boundary.state = SlotKernelErrorBoundary.getDerivedStateFromError(boom);
    boundary.componentDidCatch(boom, { componentStack: "" });

    expect(abdications).toHaveLength(1);
    expect(abdications[0]).toMatchObject({
      slotKey: "composer.main",
      entryId: "rogue-entry",
      pluginId: "rogue-composer",
      fallbackEntryId: "builtin-entry",
      fallbackPluginId: "core-composer",
    });
    expect(recordedErrors[0]).toMatchObject({
      pluginId: "rogue-composer",
      slotId: "composer.main:rogue-entry",
      message: "composer exploded",
    });

    // Next render immediately falls back to builtin-safe-composer!
    expect(renderToStaticMarkup(createElement(SlotHost, { slotKey: "composer.main", registry }))).toContain(
      "builtin-safe-composer",
    );

    // Updating etag unlocks rogue-entry automatically
    cycles.set("rogue-composer", { etag: "v2-fixed", configKey: "{}", reloadEpoch: 0 });
    expect(renderToStaticMarkup(createElement(SlotHost, { slotKey: "composer.main", registry }))).toContain(
      "rogue-custom-composer",
    );

    // External lockout also triggers automatic abdication fallback
    lockedOut = true;
    expect(renderToStaticMarkup(createElement(SlotHost, { slotKey: "composer.main", registry }))).toContain(
      "builtin-safe-composer",
    );
    expect(abdications).toHaveLength(2);
    lockedOut = false;

    // Chain select() throw abdicates automatically to next candidate
    registry.defineSlot("chain.test", { kind: "chain", scope: "root" });
    registry.register("chain.test", {
      id: "chain-fallback",
      pluginId: "core-chain",
      tier: "builtin",
      component: () => createElement("span", null, "chain-builtin-fallback"),
    });
    registry.register("chain.test", {
      id: "chain-thrower",
      pluginId: "bad-chain",
      tier: "user",
      select: () => {
        throw new Error("selector crashed");
      },
      component: () => createElement("span", null, "never"),
    });
    expect(renderToStaticMarkup(createElement(SlotHost, { slotKey: "chain.test", registry }))).toContain(
      "chain-builtin-fallback",
    );
    expect(abdication.isAbdicated("chain.test", "chain-thrower", "bad-chain")).toBe(true);

    registry.dispose();
  });

  it("persists slotOverrides in localStorage and hydrates cleanly", () => {
    const storage = createMemoryStorage();
    const store1 = createSlotOverridesStore({ storage });
    let notifications = 0;
    const off = store1.subscribe(() => {
      notifications += 1;
    });

    store1.set("shell.sidebar", "my-sidebar-plugin");
    expect(notifications).toBe(1);
    expect(JSON.parse(storage.getItem(SLOT_OVERRIDES_STORAGE_KEY) ?? "{}")).toEqual({
      "shell.sidebar": "my-sidebar-plugin",
    });

    // Fresh store hydrates persisted pins
    const store2 = createSlotOverridesStore({ storage });
    expect(store2.get("shell.sidebar")).toBe("my-sidebar-plugin");

    store2.clear("shell.sidebar");
    expect(storage.getItem(SLOT_OVERRIDES_STORAGE_KEY)).toBeNull();
    off();
  });

  it("activates Safe Mode via query/window/sessionStorage/hotkey and gates external client plugins while keeping builtins", async () => {
    // 1. Detection sources
    const storage1 = createMemoryStorage();
    const fromQuery = createSafeModeController({ windowLike: null, storage: storage1, search: "?safeMode=1" });
    expect(fromQuery.getSnapshot()).toMatchObject({ enabled: true, reason: "query" });

    const fromWindow = createSafeModeController({
      windowLike: {
        __QIANJI_SAFE_MODE__: true,
        addEventListener() {},
        removeEventListener() {},
      },
      storage: createMemoryStorage(),
    });
    expect(fromWindow.getSnapshot()).toMatchObject({ enabled: true, reason: "window-flag" });

    const storage2 = createMemoryStorage();
    storage2.setItem(SAFE_MODE_STORAGE_KEY, "1");
    const fromStorage = createSafeModeController({ windowLike: null, storage: storage2 });
    expect(fromStorage.getSnapshot()).toMatchObject({ enabled: true, reason: "session-storage" });

    // 2. Un-overridable window capture hotkey listener (Windows Ctrl+Shift+Alt+R and macOS Cmd+Shift+Alt+R)
    const captureListeners: Array<(ev: SafeModeKeyEventLike) => void> = [];
    const storage3 = createMemoryStorage();
    const fakeWin: SafeModeWindowLike = {
      addEventListener(type, listener, options) {
        const capture = typeof options === "boolean" ? options : options?.capture === true;
        if (type === "keydown" && capture) captureListeners.push(listener);
      },
      removeEventListener(type, listener) {
        if (type === "keydown") {
          const idx = captureListeners.indexOf(listener);
          if (idx >= 0) captureListeners.splice(idx, 1);
        }
      },
    };
    const ctrl = createSafeModeController({ windowLike: fakeWin, storage: storage3, isMac: false });
    const uninstall = ctrl.install();
    expect(captureListeners).toHaveLength(1);
    expect(ctrl.isEnabled()).toBe(false);

    let prevented = false;
    let stoppedImmediate = false;
    captureListeners[0]?.({
      key: "R",
      code: "KeyR",
      ctrlKey: true,
      metaKey: false,
      shiftKey: true,
      altKey: true,
      preventDefault() {
        prevented = true;
      },
      stopImmediatePropagation() {
        stoppedImmediate = true;
      },
    });
    expect(prevented).toBe(true);
    expect(stoppedImmediate).toBe(true);
    expect(ctrl.isEnabled()).toBe(true);
    expect(storage3.getItem(SAFE_MODE_STORAGE_KEY)).toBe("1");

    // macOS Cmd+Shift+Alt+R matcher check
    expect(
      isSafeModeHotkeyEvent(
        { key: "r", code: "KeyR", ctrlKey: false, metaKey: true, shiftKey: true, altKey: true, preventDefault() {} },
        true,
      ),
    ).toBe(true);
    expect(
      isSafeModeHotkeyEvent(
        { key: "r", code: "KeyR", ctrlKey: true, metaKey: false, shiftKey: true, altKey: true, repeat: true, preventDefault() {} },
        false,
      ),
    ).toBe(false);

    // 3. Safe Mode gating into createClientPluginRuntime pauses external user/workspace plugins while keeping builtins
    const root = new Context();
    const targetGlobal: { __ModuleLoader__?: ModuleLoaderGlobal } = {};
    const mountedIds = new Set<string>();
    const plugins: PluginInfo[] = [
      {
        id: "core-builtin-ui",
        name: "Core Builtin",
        version: "1.0.0",
        tier: "builtin",
        enabled: true,
        status: "active",
        overridesBuiltin: false,
        removable: false,
        watch: false,
        hasHost: false,
        hasClient: true,
        clientEtag: "b-1",
        config: {},
      },
      {
        id: "ext-user-ui",
        name: "External User",
        version: "1.0.0",
        tier: "user",
        enabled: true,
        status: "active",
        overridesBuiltin: false,
        removable: true,
        watch: false,
        hasHost: false,
        hasClient: true,
        clientEtag: "u-1",
        config: {},
      },
    ];
    const changeListeners = new Set<(payload?: PluginChangedNotification) => void>();
    const makeBundle = (id: string): string => `
      window.__ModuleLoader__.load({
        id: "${id}",
        factory() {
          return {
            apply(ctx) {
              mountedIds.add("${id}");
              ctx.effect(() => () => { mountedIds.delete("${id}"); });
            },
          };
        },
      });
    `;

    // Start with Safe Mode disabled
    ctrl.disable();
    const gatedTransport = createSafeModeGatedTransport(
      {
        list: async () => plugins,
        clientBundle: async (params: { id: string }): Promise<PluginClientBundleResult> => ({
          notModified: false,
          etag: params.id === "core-builtin-ui" ? "b-1" : "u-1",
          code: makeBundle(params.id),
        }),
        onChanged: (listener) => {
          changeListeners.add(listener);
          return () => changeListeners.delete(listener);
        },
        onTrustChanged: () => () => undefined,
      },
      ctrl,
      (list) => {
        for (const item of list) setPluginTier(item.id, item.tier);
      },
    );

    const runtime = createClientPluginRuntime(root, {
      targetGlobal,
      executeScript: async (code) => {
        const fn = new Function("window", "mountedIds", code);
        fn(targetGlobal, mountedIds);
      },
      modules: {},
      transport: gatedTransport,
    });

    await runtime.sync();
    expect(mountedIds.has("core-builtin-ui")).toBe(true);
    expect(mountedIds.has("ext-user-ui")).toBe(true);

    // Enable Safe Mode -> external user plugin unmounts immediately while builtin remains active!
    ctrl.enable("hotkey");
    await runtime.sync();
    expect(mountedIds.has("core-builtin-ui")).toBe(true);
    expect(mountedIds.has("ext-user-ui")).toBe(false);

    // Disable Safe Mode -> external user plugin remounts!
    ctrl.disable();
    await runtime.sync();
    expect(mountedIds.has("core-builtin-ui")).toBe(true);
    expect(mountedIds.has("ext-user-ui")).toBe(true);

    await runtime.dispose();
    uninstall();
  });

  it("injects @layer plugin-skin global styles with sanitization, Cordis Fiber disposal, and HMR rollback", async () => {
    const env = installMockHeadDocument();
    try {
      // Global CSS sanitization preserves :root while neutralizing breakout braces / unclosed comments / strings
      const wrapped = wrapPluginGlobalCss(':root { --qj-bg-app: #111; } }} .bad { content: "unclosed');
      expect(wrapped).toContain("@layer plugin-skin {");
      expect(wrapped).toContain(":root { --qj-bg-app: #111; }");
      expect(wrapped).not.toContain("@scope");
      expect(wrapped).not.toContain("}}");
      expect(wrapped.endsWith("}")).toBe(true);

      // globalThis.__qianjiInjectPluginGlobalStyle is exposed
      const globalHost = globalThis as unknown as {
        __qianjiInjectPluginGlobalStyle?: (pluginId: string, css: string, styleKey?: string) => () => void;
      };
      expect(typeof globalHost.__qianjiInjectPluginGlobalStyle).toBe("function");

      // ctx.styles.injectGlobal() binds to Cordis Fiber lifecycle
      const root = new Context();
      await root.plugin(ClientStylesService);
      root.on("internal/plugin", (fiber: object) => {
        tagFiberPluginId(fiber, "skin-plugin");
      });
      const skinFiber = await root.plugin({
        name: "skin-plugin",
        inject: ["styles"],
        apply(ctx: Context) {
          ctx.styles.injectGlobal(":root { --qj-brand-primary: #ff6b00; }");
        },
      });
      expect(env.styles).toHaveLength(1);
      expect(env.styles[0]?.getAttribute("data-qj-style-scope")).toBe("global");
      expect(env.styles[0]?.textContent).toContain("@layer plugin-skin");
      expect(env.styles[0]?.textContent).toContain("--qj-brand-primary: #ff6b00");

      await skinFiber.dispose();
      expect(env.styles).toHaveLength(0);

      // HMR snapshot + prune + rollback covers BOTH scoped and global bundle styles
      injectPluginScopedStyle("hmr-skin", ".widget { color: blue; }", "widget.css");
      injectPluginGlobalStyle("hmr-skin", ":root { --skin-v: 1; }", "theme.global.css");
      const snap = snapshotBundleStyles("hmr-skin");
      const seqBefore = currentStyleSeq();

      // Simulate broken v2 reload modifying global style + adding extra global style
      injectPluginGlobalStyle("hmr-skin", ":root { --skin-v: 2-broken; }", "theme.global.css");
      injectPluginGlobalStyle("hmr-skin", "body { opacity: 0; }", "extra.global.css");
      rollbackBundleStyles("hmr-skin", snap, seqBefore);

      expect(env.styles).toHaveLength(2);
      const restoredGlobal = env.styles.find((s) => s.getAttribute("data-qj-style-key") === "theme.global.css");
      expect(restoredGlobal?.textContent).toContain("--skin-v: 1");
      expect(restoredGlobal?.textContent).not.toContain("2-broken");
      expect(env.styles.some((s) => s.getAttribute("data-qj-style-key") === "extra.global.css")).toBe(false);

      // Simulate successful v3 reload pruning stale bundle styles
      const seqBeforeV3 = currentStyleSeq();
      injectPluginGlobalStyle("hmr-skin", ":root { --skin-v: 3; }", "theme.global.css");
      pruneStaleBundleStyles("hmr-skin", seqBeforeV3);
      expect(env.styles).toHaveLength(1);
      expect(env.styles[0]?.textContent).toContain("--skin-v: 3");

      removeAllPluginStyles("hmr-skin");
      expect(env.styles).toHaveLength(0);
    } finally {
      env.restore();
    }
  });

  it("bridges legacy ctx.contributions with SlotRegistry, registers CLIENT_MODULES, and enforces builtin-plugin ESLint boundaries", async () => {
    // 1. CLIENT_MODULES exposes @qianji/client-slots & @qianji/client-store
    expect(typeof CLIENT_MODULES["@qianji/client-slots"]).toBe("function");
    expect(typeof CLIENT_MODULES["@qianji/client-store"]).toBe("function");
    const slotsMod = (await CLIENT_MODULES["@qianji/client-slots"]?.()) as Record<string, unknown>;
    const storeMod = (await CLIENT_MODULES["@qianji/client-store"]?.()) as Record<string, unknown>;
    expect(typeof slotsMod.ClientSlotsService).toBe("function");
    expect(typeof storeMod.SlotStoreRegistry).toBe("function");

    // 2. Legacy contribution mirroring into SlotRegistry
    const slotRegistry = new SlotRegistry({ stores: new SlotStoreRegistry() });
    const contribRegistry = new ClientContributionRegistry(slotRegistry);
    const root = new Context();
    await root.plugin(ClientContributionService, contribRegistry);

    const fiber = await root.plugin({
      name: "legacy-plugin",
      inject: ["contributions"],
      apply(ctx: Context) {
        ctx.contributions.registerTopbarAction({
          id: "legacy-btn",
          render: () => createElement("button", null, "Legacy"),
        });
      },
    });
    expect(slotRegistry.getEntries("legacy.topbarActions")).toHaveLength(1);
    expect(slotRegistry.getEntries("legacy.topbarActions")[0]?.id).toBe("legacy:topbarActions:legacy-btn");
    await fiber.dispose();
    expect(slotRegistry.getEntries("legacy.topbarActions")).toHaveLength(0);
    slotRegistry.dispose();

    // 3. ESLint mechanical boundary enforcement for src/ and src/builtin-plugins/**
    const eslint = new ESLint({ cwd: REPO_ROOT });

    const validBuiltinCode = [
      'import type { Context } from "@deepseek-ai/cordis";',
      'import type { SlotMap } from "@qianji/client-slots";',
      'import type { StoreDecl } from "@qianji/client-store";',
      'import type { ActiveSessionSnapshot } from "@qianji/client";',
      'import type { PluginInfo } from "@qianji/protocol";',
      "export function ok(_a: Context, _b: SlotMap, _c: StoreDecl, _d: ActiveSessionSnapshot, _e: PluginInfo) {",
      "  return true;",
      "}",
      "",
    ].join("\n");
    const [validRes] = await eslint.lintText(validBuiltinCode, {
      filePath: join(REPO_ROOT, "src/builtin-plugins/core-shell/index.ts"),
    });
    expect(validRes?.messages ?? []).toEqual([]);

    const forbiddenImports = [
      'import { useAppStore } from "../../store"; export const x = useAppStore;',
      'import { useWorkbenchStore } from "../../stores/workbenchStore"; export const x = useWorkbenchStore;',
      'import { agent } from "../../lib/agent"; export const x = agent;',
      'import { SessionService } from "../../kernel/services/sessionService"; export const x = SessionService;',
      'import { sibling } from "../core-sidebar"; export const x = sibling;',
      'import { Host } from "@qianji/host"; export const x = Host;',
    ];
    for (const snippet of forbiddenImports) {
      const [res] = await eslint.lintText(`${snippet}\n`, {
        filePath: join(REPO_ROOT, "src/builtin-plugins/core-shell/index.ts"),
      });
      expect(
        res?.messages.some((m) => m.ruleId === "no-restricted-imports"),
        `Expected ESLint no-restricted-imports error for snippet: ${snippet}`,
      ).toBe(true);
    }
  });

  it("handles async read(uri) and value-pushing subscribe(uri, cb) safely in useResource / createResourceCell", async () => {
    // 1. Async read(uri) only: getSnapshot never returns a Promise, caches cleanly, and updates once settled
    let resolveRead: ((val: unknown) => void) | undefined;
    const asyncOnlyService = {
      read: () =>
        new Promise((resolve) => {
          resolveRead = resolve;
        }),
    };
    const asyncCell = createResourceCell(asyncOnlyService, "doc://readme");
    expect(asyncCell.getSnapshot()).toBeUndefined();
    let asyncChangeCount = 0;
    const offAsync = asyncCell.subscribe(() => {
      asyncChangeCount += 1;
    });
    // Still undefined while pending (never a Promise!)
    expect(asyncCell.getSnapshot()).toBeUndefined();
    const payload = { title: "Hello ADR 0023" };
    resolveRead?.(payload);
    await Promise.resolve();
    await Promise.resolve();
    expect(asyncChangeCount).toBe(1);
    expect(asyncCell.getSnapshot()).toBe(payload);
    // Repeated getSnapshot calls return identical cached reference
    expect(asyncCell.getSnapshot()).toBe(asyncCell.getSnapshot());
    offAsync();

    // 2. Value-pushing subscribe(uri, (value) => void) + slower async read(uri):
    // pushed values win and stale async read never clobbers newer pushed state
    const pushedListeners = new Set<(val: unknown) => void>();
    let resolveSlowRead: ((val: unknown) => void) | undefined;
    let subDisposed = false;
    const liveService = {
      read: () =>
        new Promise((resolve) => {
          resolveSlowRead = resolve;
        }),
      subscribe: (_uri: string, listener: (val: unknown) => void) => {
        pushedListeners.add(listener);
        return () => {
          subDisposed = true;
          pushedListeners.delete(listener);
        };
      },
    };
    const liveCell = createResourceCell(liveService, "git://status");
    let liveChanges = 0;
    const offLive = liveCell.subscribe(() => {
      liveChanges += 1;
    });
    for (const cb of pushedListeners) cb("dirty");
    expect(liveCell.getSnapshot()).toBe("dirty");
    expect(liveChanges).toBe(1);

    // Duplicate value does not notify redundantly
    for (const cb of pushedListeners) cb("dirty");
    expect(liveChanges).toBe(1);

    // Stale async read resolving later MUST NOT overwrite fresher pushed value
    resolveSlowRead?.("stale-clean");
    await Promise.resolve();
    await Promise.resolve();
    expect(liveCell.getSnapshot()).toBe("dirty");
    expect(liveChanges).toBe(1);

    // Subsequent push updates snapshot
    for (const cb of pushedListeners) cb("clean");
    expect(liveCell.getSnapshot()).toBe("clean");
    expect(liveChanges).toBe(2);

    // Unsubscribe disposes underlying subscription and ignores further pushes
    offLive();
    expect(subDisposed).toBe(true);

    // 3. Rendering useResource inside React with an async resourcesService never returns a Promise or throws
    const root = new Context();
    root.provide("resourcesService" as never, liveService as never);
    function ResourceConsumer() {
      const val = useResource<string>("git://status");
      return createElement("span", null, val === undefined ? "pending" : String(val));
    }
    const html = renderToStaticMarkup(
      createElement(SlotKernelProvider, { ctx: root }, createElement(ResourceConsumer)),
    );
    expect(html).toBe("<span>pending</span>");
  });
});

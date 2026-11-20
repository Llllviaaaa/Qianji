/**
 * End-to-end Wave 1 integration suite for ADR 0023 Phase 1 + Phase 2:
 * - `CLIENT_MODULES` shared externals (`@qianji/client`, `@qianji/client-slots`,
 *   `@qianji/client-store`, `@qianji/client-primitives`)
 * - `registerFrontendServices(root)` + `SessionScopeAdapter` bridging `sessionService`
 *   into `ClientSlotsService` (`SlotScope: "session" | "session-maybe"`)
 * - `@qianji/client` frontend service hooks (`useFrontendService`, `useSessionState`,
 *   `useSessionHandle`, etc.)
 * - `SlotFactoryMap` declaration merging + `registerCorePrimitiveFactories` + abdication fallback
 * - `ensureClientPluginRuntime()` singleton bootstrap wiring
 * - Offline `plugin-types` compilation across all 4 client packages
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { act, createElement, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import ts from "typescript";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Context } from "@deepseek-ai/cordis";
import {
  useClientContext,
  useComposerState,
  useFrontendService,
  useLocaleState,
  useMenusState,
  useNavigationState,
  useResourcesState,
  useRpcState,
  useSafeMode,
  useSessionHandle,
  useSessionState,
  useShortcutsState,
  useSlotOverrides,
  useThemeState,
  useWorkbenchState,
  useWorkspaceState,
} from "@qianji/client";
import {
  ClientSlotsService,
  SessionArea,
  SlotFactoryHost,
  SlotHost,
  SlotKernelProvider,
  SlotRegistry,
  useResource,
  type SlotSpec,
} from "@qianji/client-slots";

declare module "@qianji/client-slots" {
  interface SlotMap {
    "wave1.stage.maybe": SlotSpec<Record<string, never>, "single", "session-maybe">;
    "wave1.stage.strict": SlotSpec<Record<string, never>, "single", "session">;
  }
}
import { CLIENT_PRIMITIVES_EXPORTS } from "@qianji/client-primitives";
import {
  CORE_PRIMITIVE_FACTORY_KEYS,
  registerCorePrimitiveFactories,
} from "../src/kernel/primitives/factories";
import {
  createSessionScopeAdapter,
  FRONTEND_SERVICE_NAMES,
  installSessionScopeAdapter,
  registerFrontendServices,
} from "../src/kernel/services";
import {
  CLIENT_MODULES,
  ensureClientPluginRuntime,
  getClientRootContext,
  whenClientPluginServicesReady,
} from "../src/lib/clientPluginBootstrap";
import { ClientContributionRegistry } from "../src/lib/clientContributions";
import { clientSlotsRegistry } from "../src/kernel/slots";
import { bindClientRootContext } from "../src/sdk/rootContext";
import { useAppStore } from "../src/store";
import { generatePluginTypes } from "../scripts/generate-plugin-types.mjs";

/* ── Minimal DOM harness for React 19 `createRoot` lifecycle assertions ── */

class TinyNode {
  readonly nodeType: number;
  readonly nodeName: string;
  ownerDocument: TinyDocument | null;
  parentNode: TinyNode | null = null;
  readonly childNodes: TinyNode[] = [];
  protected textValue = "";
  constructor(nodeType: number, nodeName: string, ownerDocument: TinyDocument | null) {
    this.nodeType = nodeType;
    this.nodeName = nodeName;
    this.ownerDocument = ownerDocument;
  }
  get firstChild(): TinyNode | null { return this.childNodes[0] ?? null; }
  get nextSibling(): TinyNode | null {
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
  appendChild<T extends TinyNode>(child: T): T {
    if (child.parentNode !== null) child.parentNode.removeChild(child);
    child.parentNode = this;
    this.childNodes.push(child);
    return child;
  }
  insertBefore<T extends TinyNode>(child: T, refNode: TinyNode | null): T {
    if (refNode === null) return this.appendChild(child);
    if (child.parentNode !== null) child.parentNode.removeChild(child);
    const idx = this.childNodes.indexOf(refNode);
    if (idx < 0) return this.appendChild(child);
    child.parentNode = this;
    this.childNodes.splice(idx, 0, child);
    return child;
  }
  removeChild<T extends TinyNode>(child: T): T {
    const idx = this.childNodes.indexOf(child);
    if (idx >= 0) { this.childNodes.splice(idx, 1); child.parentNode = null; }
    return child;
  }
  addEventListener(): void {}
  removeEventListener(): void {}
}

class TinyElement extends TinyNode {
  readonly tagName: string;
  readonly attributes = new Map<string, string>();
  readonly style: Record<string, string> = {};
  constructor(tag: string, ownerDocument: TinyDocument) {
    super(1, tag.toUpperCase(), ownerDocument);
    this.tagName = tag.toUpperCase();
  }
  get className(): string { return this.attributes.get("class") ?? ""; }
  set className(v: string) { this.attributes.set("class", v); }
  setAttribute(k: string, v: string): void { this.attributes.set(k.toLowerCase(), String(v)); }
  getAttribute(k: string): string | null { return this.attributes.get(k.toLowerCase()) ?? null; }
  removeAttribute(k: string): void { this.attributes.delete(k.toLowerCase()); }
  hasAttribute(k: string): boolean { return this.attributes.has(k.toLowerCase()); }
}

class TinyIframeElement extends TinyElement {}

class TinyDocument extends TinyNode {
  readonly documentElement: TinyElement;
  readonly body: TinyElement;
  readonly defaultView = {
    addEventListener(): void {},
    removeEventListener(): void {},
    navigator: { userAgent: "node" },
    HTMLIFrameElement: TinyIframeElement,
    HTMLElement: TinyElement,
    Element: TinyElement,
    Node: TinyNode,
  };
  activeElement: TinyElement | null = null;
  constructor() {
    super(9, "#document", null);
    this.documentElement = new TinyElement("html", this);
    this.body = new TinyElement("body", this);
    this.documentElement.appendChild(this.body);
    this.appendChild(this.documentElement);
  }
  createElement(tag: string): TinyElement { return new TinyElement(tag, this); }
  createTextNode(text: string): TinyNode {
    const node = new TinyNode(3, "#text", this);
    node.nodeValue = text;
    return node;
  }
  createComment(text: string): TinyNode {
    const node = new TinyNode(8, "#comment", this);
    node.nodeValue = text;
    return node;
  }
}

const activeUnmounts: Array<() => void> = [];

function mountTinyDom(node: ReactNode): { container: TinyElement; rerender: (next: ReactNode) => void; unmount: () => void } {
  const g = globalThis as Record<string, unknown>;
  const keys = ["window", "document", "Node", "Element", "HTMLElement", "HTMLIFrameElement", "IS_REACT_ACT_ENVIRONMENT"] as const;
  const saved: Record<string, unknown> = {};
  for (const k of keys) saved[k] = g[k];

  const doc = new TinyDocument();
  const container = doc.createElement("div");
  doc.body.appendChild(container);
  Object.assign(g, {
    window: doc.defaultView,
    document: doc,
    Node: TinyNode,
    Element: TinyElement,
    HTMLElement: TinyElement,
    HTMLIFrameElement: TinyIframeElement,
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

  return {
    container,
    rerender(next: ReactNode) {
      act(() => { root?.render(next); });
    },
    unmount,
  };
}

describe("ADR 0023 Wave 1 Integration: slots + store + services + primitives + SDK + bootstrap", () => {
  beforeEach(() => {
    useAppStore.setState({
      cwd: "/repo/wave1",
      sessionId: null,
      sessionFile: null,
      messages: [],
    });
  });

  afterEach(() => {
    while (activeUnmounts.length > 0) {
      activeUnmounts.pop()?.();
    }
    bindClientRootContext(undefined);
  });

  it("exposes all four client microkernel modules in CLIENT_MODULES", async () => {
    expect(typeof CLIENT_MODULES["@qianji/client"]).toBe("function");
    expect(typeof CLIENT_MODULES["@qianji/client-slots"]).toBe("function");
    expect(typeof CLIENT_MODULES["@qianji/client-store"]).toBe("function");
    expect(typeof CLIENT_MODULES["@qianji/client-primitives"]).toBe("function");

    const [clientMod, slotsMod, storeMod, primitivesMod] = await Promise.all([
      CLIENT_MODULES["@qianji/client"](),
      CLIENT_MODULES["@qianji/client-slots"](),
      CLIENT_MODULES["@qianji/client-store"](),
      CLIENT_MODULES["@qianji/client-primitives"](),
    ]);

    expect(typeof (clientMod as Record<string, unknown>).useSessionState).toBe("function");
    expect(typeof (clientMod as Record<string, unknown>).useSessionHandle).toBe("function");
    expect(typeof (clientMod as Record<string, unknown>).useFrontendService).toBe("function");
    expect(typeof (slotsMod as Record<string, unknown>).ClientSlotsService).toBe("function");
    expect(typeof (storeMod as Record<string, unknown>).createReactiveStore).toBe("function");
    expect((primitivesMod as Record<string, unknown>).CLIENT_PRIMITIVES_EXPORTS).toEqual(CLIENT_PRIMITIVES_EXPORTS);
  });

  it("bridges sessionService into ClientSlotsService via SessionScopeAdapter for session & session-maybe slots and <SessionArea> retain lifecycle", async () => {
    const root = new Context();
    const registry = new SlotRegistry();
    const contributions = new ClientContributionRegistry();
    await root.plugin(ClientSlotsService, registry);
    await registerFrontendServices(root, { contributionRegistry: contributions, shortcutTarget: null });
    const disposeAdapter = installSessionScopeAdapter(root);

    expect(registry.getScopeAdapter()).toBeDefined();

    registry.defineSlot("wave1.stage.maybe", { kind: "single", scope: "session-maybe" });
    registry.defineSlot("wave1.stage.strict", { kind: "single", scope: "session" });

    registry.register("wave1.stage.maybe", {
      id: "maybe-view",
      pluginId: "core-conversation",
      tier: "builtin",
      component: ({ sessionId }) => createElement("span", null, `maybe:${sessionId ?? "none"}`),
    });
    registry.register("wave1.stage.strict", {
      id: "strict-view",
      pluginId: "core-conversation",
      tier: "builtin",
      component: ({ sessionId }) => createElement("span", null, `strict:${sessionId}`),
    });

    const mounted = mountTinyDom(
      createElement(
        SlotKernelProvider,
        { registry, ctx: root },
        createElement(
          "div",
          null,
          createElement(SlotHost, { slotKey: "wave1.stage.maybe", registry, rootCtx: root }),
          createElement(SlotHost, { slotKey: "wave1.stage.strict", registry, rootCtx: root, fallback: createElement("span", null, "no-session") }),
        ),
      ),
    );

    expect(mounted.container.textContent).toBe("maybe:none" + "no-session");

    act(() => {
      useAppStore.setState({ sessionId: "sess-main-42" });
    });
    expect(mounted.container.textContent).toBe("maybe:sess-main-42" + "strict:sess-main-42");

    // Mount an explicit <SessionArea> for an isolated side-chat session and verify retain ref-counting
    const sessionSvc = root.get("sessionService");
    expect(sessionSvc).toBeDefined();
    expect(sessionSvc?.getRetainCount("side-chat-7")).toBe(0);

    mounted.rerender(
      createElement(
        SlotKernelProvider,
        { registry, ctx: root },
        createElement(
          SessionArea,
          { sessionId: "side-chat-7" },
          createElement(SlotHost, { slotKey: "wave1.stage.strict", registry, rootCtx: root }),
        ),
      ),
    );
    expect(mounted.container.textContent).toBe("strict:side-chat-7");
    expect(sessionSvc?.getRetainCount("side-chat-7")).toBe(1);

    mounted.unmount();
    expect(sessionSvc?.getRetainCount("side-chat-7")).toBe(0);

    disposeAdapter();
    expect(registry.getScopeAdapter()).toBeUndefined();
    registry.dispose();
  });

  it("exposes reactive @qianji/client frontend service hooks and auto-releases useSessionHandle", async () => {
    const root = new Context();
    const registry = new SlotRegistry();
    const contributions = new ClientContributionRegistry();
    await root.plugin(ClientSlotsService, registry);
    await registerFrontendServices(root, { contributionRegistry: contributions, shortcutTarget: null });
    bindClientRootContext(root);

    const resourcesSvc = root.get("resourcesService");
    let pushResource: ((val: string) => void) | undefined;
    resourcesSvc?.registerProtocol<string>("demo", {
      read: async () => "initial-val",
      subscribe: (_uri, listener) => {
        pushResource = listener;
        listener("live-val-1");
        return () => undefined;
      },
    });

    function Inspector() {
      const ctx = useClientContext();
      const sessSvc = useFrontendService("sessionService");
      const session = useSessionState();
      const retained = useSessionHandle("isolated-pane-1", { isolated: true, cwd: "/repo/wave1" });
      const workspace = useWorkspaceState();
      const composer = useComposerState();
      const workbench = useWorkbenchState();
      const nav = useNavigationState();
      const theme = useThemeState();
      const shortcuts = useShortcutsState();
      const menus = useMenusState();
      const rpc = useRpcState();
      const locale = useLocaleState();
      const resources = useResourcesState();
      const liveResource = useResource("demo://item/1");
      const safeMode = useSafeMode();
      const overrides = useSlotOverrides();

      return createElement(
        "div",
        null,
        [
          `ctx:${ctx === root ? "ok" : "miss"}`,
          `svc:${sessSvc !== undefined ? "ok" : "miss"}`,
          `cwd:${workspace?.cwd ?? ""}`,
          `session:${session?.sessionId ?? "none"}`,
          `retained:${retained.snapshot?.sessionId ?? "pending"}:${retained.handle?.isolated === true ? "iso" : "main"}`,
          `draft:${composer?.draft ?? ""}`,
          `wb:${workbench?.activeTab ?? ""}`,
          `route:${nav?.activeRoute.kind ?? ""}`,
          `theme:${theme?.themeId ?? ""}`,
          `shortcuts:${shortcuts?.shortcuts.length ?? -1}`,
          `menus:${menus?.items.length ?? -1}`,
          `rpc:${rpc?.hostStatus ?? ""}`,
          `locale:${locale?.locale ?? ""}`,
          `res:${resources?.schemes.length ?? -1}:${String(liveResource ?? "")}`,
          `safe:${String(safeMode.enabled)}`,
          `ovr:${Object.keys(overrides).length}`,
        ].join("|"),
      );
    }

    const sessionSvc = root.get("sessionService");
    expect(sessionSvc?.getRetainCount("isolated-pane-1", { isolated: true })).toBe(0);

    const mounted = mountTinyDom(
      createElement(SlotKernelProvider, { registry, ctx: root }, createElement(Inspector)),
    );
    expect(mounted.container.textContent).toContain("ctx:ok");
    expect(mounted.container.textContent).toContain("svc:ok");
    expect(mounted.container.textContent).toContain("cwd:/repo/wave1");
    expect(mounted.container.textContent).toContain("retained:isolated-pane-1:iso");
    expect(mounted.container.textContent).toContain("res:1:live-val-1");
    expect(sessionSvc?.getRetainCount("isolated-pane-1", { isolated: true })).toBe(1);

    act(() => {
      useAppStore.setState({ sessionId: "sess-99" });
      root.get("composerService")?.setDraft("hello wave 1");
      pushResource?.("live-val-2");
    });
    expect(mounted.container.textContent).toContain("draft:hello wave 1");
    expect(mounted.container.textContent).toContain("session:sess-99");
    expect(mounted.container.textContent).toContain("res:1:live-val-2");

    mounted.unmount();
    expect(sessionSvc?.getRetainCount("isolated-pane-1", { isolated: true })).toBe(0);
    registry.dispose();
  });

  it("registers core primitive factories into SlotFactoryMap with override and abdication fallback", () => {
    const registry = new SlotRegistry();
    const disposeFactories = registerCorePrimitiveFactories(registry);

    for (const key of CORE_PRIMITIVE_FACTORY_KEYS) {
      expect(registry.getFactoryCandidates(key).length).toBeGreaterThanOrEqual(1);
    }

    const builtinHtml = renderToStaticMarkup(
      createElement(
        SlotKernelProvider,
        { registry },
        createElement(SlotFactoryHost, {
          factoryKey: "primitive.card",
          props: { variant: "elevated", children: "Core Card Body" },
          registry,
        }),
      ),
    );
    expect(builtinHtml).toContain("Core Card Body");
    expect(builtinHtml).toContain('data-qj-plugin="core-primitives"');
    expect(builtinHtml).not.toContain("renderSlot");

    // Register a user-tier override that throws -> abdication automatically falls back to builtin primitive.card
    const disposeBadOverride = registry.registerFactory("primitive.card", {
      id: "broken-card-override",
      pluginId: "broken-card-plugin",
      tier: "user",
      priority: 50,
      component: () => {
        throw new Error("boom in card override");
      },
    });

    const mounted = mountTinyDom(
      createElement(
        SlotKernelProvider,
        { registry },
        createElement(SlotFactoryHost, {
          factoryKey: "primitive.card",
          props: { children: "Safe Builtin Fallback" },
          registry,
        }),
      ),
    );
    expect(mounted.container.textContent).toContain("Safe Builtin Fallback");
    expect(registry.abdication.isAbdicated("factory:primitive.card", "broken-card-override", "broken-card-plugin")).toBe(true);

    mounted.unmount();
    disposeBadOverride();
    disposeFactories();
    registry.dispose();
  });

  it("boots ensureClientPluginRuntime() with frontend services, SessionScopeAdapter, and core primitive factories", async () => {
    const prevAdapter = createSessionScopeAdapter;
    expect(typeof prevAdapter).toBe("function");

    const runtime = ensureClientPluginRuntime();
    expect(runtime).toBeDefined();
    await whenClientPluginServicesReady();

    const root = getClientRootContext();
    expect(root).toBeDefined();
    expect(root?.get("slots")).toBeDefined();
    expect(root?.get("contributions")).toBeDefined();
    expect(root?.get("styles")).toBeDefined();
    for (const serviceName of FRONTEND_SERVICE_NAMES) {
      expect(root?.get(serviceName)).toBeDefined();
    }
    expect(clientSlotsRegistry.getScopeAdapter()).toBeDefined();
    expect(clientSlotsRegistry.getFactoryCandidates("primitive.markdown").length).toBeGreaterThanOrEqual(1);
  });

  it("compiles an external plugin consuming @qianji/client, @qianji/client-slots, @qianji/client-store, and @qianji/client-primitives against offline plugin-types", () => {
    const tempBase = mkdtempSync(join(tmpdir(), "qj-wave1-plugin-types-"));
    const typesDir = join(tempBase, "plugin-types");
    const pluginDir = join(tempBase, "wave1-ext");
    try {
      generatePluginTypes({ targetDir: typesDir });
      mkdirSync(pluginDir, { recursive: true });
      const relTypes = relative(pluginDir, typesDir).replace(/\\/g, "/");

      writeFileSync(
        join(pluginDir, "tsconfig.json"),
        JSON.stringify(
          {
            extends: `${relTypes}/tsconfig.plugin.json`,
            compilerOptions: {
              baseUrl: ".",
              paths: {
                "react/jsx-runtime": [`${relTypes}/react/jsx-runtime.d.ts`],
                "react/jsx-dev-runtime": [`${relTypes}/react/jsx-dev-runtime.d.ts`],
                "*": [`${relTypes}/*/index.d.ts`, `${relTypes}/*`],
              },
            },
            include: ["client.tsx"],
          },
          null,
          2,
        ),
        "utf8",
      );

      writeFileSync(
        join(pluginDir, "client.tsx"),
        `import type { Context } from "@deepseek-ai/cordis";
import { useSessionHandle, useSessionState, useSafeMode } from "@qianji/client";
import { Card, Markdown, Button } from "@qianji/client-primitives";
import { SessionArea, SlotFactoryHost, type SlotSpec } from "@qianji/client-slots";
import { createReactiveStore } from "@qianji/client-store";

declare module "@qianji/client-slots" {
  interface SlotMap {
    "wave1.demo": SlotSpec<{ title: string }, "single", "session">;
  }
}

function DemoPanel({ title, sessionId }: { title: string; sessionId: string }) {
  const session = useSessionState();
  const { snapshot } = useSessionHandle(sessionId, { isolated: true });
  const safeMode = useSafeMode();
  return (
    <SessionArea sessionId={sessionId}>
      <Card header={title}>
        <Markdown content={snapshot?.cwd ?? String(session?.sessionId ?? "")} />
        <SlotFactoryHost factoryKey="primitive.markdown" props={{ content: String(safeMode.enabled) }} />
        <Button variant="primary">Run</Button>
      </Card>
    </SessionArea>
  );
}

export const name = "wave1-ext-demo";
export const inject = ["slots", "styles", "sessionService"];
export function apply(ctx: Context) {
  ctx.styles.injectGlobal(".wave1-skin { opacity: 1; }");
  ctx.slots.register("wave1.demo", {
    store: {
      create: () => createReactiveStore({ count: 0 }),
      dispose: (store) => store.dispose(),
    },
    component: ({ title, sessionId }) => <DemoPanel title={title} sessionId={sessionId} />,
  });
}
`,
        "utf8",
      );

      const configFile = ts.readConfigFile(join(pluginDir, "tsconfig.json"), ts.sys.readFile);
      expect(configFile.error).toBeUndefined();
      const parsed = ts.parseJsonConfigFileContent(configFile.config, ts.sys, pluginDir);
      const program = ts.createProgram(parsed.fileNames, parsed.options);
      const diagnostics = ts.getPreEmitDiagnostics(program).map((d) =>
        ts.flattenDiagnosticMessageText(d.messageText, "\n"),
      );
      expect(diagnostics).toEqual([]);
    } finally {
      rmSync(tempBase, { recursive: true, force: true });
    }
  });
});

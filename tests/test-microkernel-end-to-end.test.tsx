/**
 * End-to-end integration tests for ADR 0023 Wave 2C full microkernel cutover:
 * 1. Full `<App />` mounts through `<SlotRoot />` + `BuiltinCorePluginCoordinator`
 *    with a minimal (`<= 150` lines) microkernel boot stub.
 * 2. External plugin taking over `composer.main` with `overlay: true` hides the
 *    built-in composer via `display: none` without unmounting and preserves typed
 *    draft text across takeover and return.
 * 3. Throwing user core-override plugin automatically abdicates back to built-in
 *    `core-home` and emits a non-blocking warning toast.
 * 4. `*.global.css` (`@layer plugin-skin` via `ctx.styles.injectGlobal`) restyles
 *    global chrome without `@scope` and cleans up on disable AND Safe Mode
 *    (`Ctrl+Shift+Alt+R`), while un-overridable `<SafeModeBanner />` renders and exits.
 * 5. Disabling and same-ID overriding all 5 feature plugins (`code-review`,
 *    `web-preview`, `side-chat`, `diagram-viewer`, `intelligent-ui`) plus
 *    `core-composer` genuinely unmounts/replaces their Fibers and updates slots.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { act, createElement, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Context, type Plugin } from "@deepseek-ai/cordis";
import type { PluginInfo } from "@qianji/protocol";
import App from "../src/App";
import {
  createBuiltinCorePluginCoordinator,
  createSafeModeController,
  safeModeController,
  setPluginTier,
  type BuiltinCorePluginTransport,
} from "../src/kernel/runtime";
import { DEFAULT_BUILTIN_CLIENT_PLUGINS } from "../src/kernel/runtime/registerDefaultBuiltinPlugins";
import { registerFrontendServices } from "../src/kernel/services";
import {
  ClientSlotsService,
  clientSlotsRegistry,
  SlotRegistry,
  type ComposerMainSlotProps,
  type HomeHeroSlotProps,
  type SlotComponentProps,
} from "../src/kernel/slots";
import {
  ClientContributionRegistry,
  ClientContributionService,
  ClientStylesService,
} from "../src/lib/clientContributions";
import {
  ensureClientPluginRuntime,
  getClientRootContext,
  whenClientPluginServicesReady,
} from "../src/lib/clientPluginBootstrap";
import { useAppStore } from "../src/store";

const REPO_ROOT = resolve(__dirname, "..");

/* ── Lightweight interactive DOM harness for Node-mode React 19 testing ── */

interface ListenerEntry {
  readonly fn: (event: MiniEvent) => void;
  readonly capture: boolean;
}

class MiniEvent {
  readonly type: string;
  readonly bubbles: boolean;
  readonly cancelable: boolean;
  readonly key: string;
  readonly code: string;
  readonly ctrlKey: boolean;
  readonly metaKey: boolean;
  readonly shiftKey: boolean;
  readonly altKey: boolean;
  readonly isComposing = false;
  readonly keyCode = 0;
  target: MiniEventTarget | null = null;
  currentTarget: MiniEventTarget | null = null;
  defaultPrevented = false;
  propagationStopped = false;
  eventPhase = 0;

  constructor(
    type: string,
    init: {
      bubbles?: boolean;
      cancelable?: boolean;
      key?: string;
      code?: string;
      ctrlKey?: boolean;
      metaKey?: boolean;
      shiftKey?: boolean;
      altKey?: boolean;
    } = {},
  ) {
    this.type = type;
    this.bubbles = init.bubbles ?? true;
    this.cancelable = init.cancelable ?? true;
    this.key = init.key ?? "";
    this.code = init.code ?? "";
    this.ctrlKey = init.ctrlKey ?? false;
    this.metaKey = init.metaKey ?? false;
    this.shiftKey = init.shiftKey ?? false;
    this.altKey = init.altKey ?? false;
  }

  preventDefault(): void {
    if (this.cancelable) this.defaultPrevented = true;
  }

  stopPropagation(): void {
    this.propagationStopped = true;
  }

  stopImmediatePropagation(): void {
    this.propagationStopped = true;
  }
}

class MiniEventTarget {
  private readonly listeners = new Map<string, ListenerEntry[]>();

  addEventListener(
    type: string,
    fn: ((event: MiniEvent) => void) | null,
    opts?: boolean | { capture?: boolean },
  ): void {
    if (fn === null) return;
    const capture = typeof opts === "boolean" ? opts : (opts?.capture ?? false);
    const list = this.listeners.get(type) ?? [];
    if (!list.some((item) => item.fn === fn && item.capture === capture)) {
      list.push({ fn, capture });
      this.listeners.set(type, list);
    }
  }

  removeEventListener(
    type: string,
    fn: ((event: MiniEvent) => void) | null,
    opts?: boolean | { capture?: boolean },
  ): void {
    if (fn === null) return;
    const capture = typeof opts === "boolean" ? opts : (opts?.capture ?? false);
    const list = this.listeners.get(type);
    if (list !== undefined) {
      this.listeners.set(
        type,
        list.filter((item) => item.fn !== fn || item.capture !== capture),
      );
    }
  }

  invokeListeners(event: MiniEvent, capture: boolean): void {
    for (const entry of [...(this.listeners.get(event.type) ?? [])]) {
      if (entry.capture === capture) {
        event.currentTarget = this;
        entry.fn(event);
      }
    }
  }

  dispatchEvent(event: MiniEvent): boolean {
    event.target = this;
    this.invokeListeners(event, true);
    if (!event.propagationStopped) this.invokeListeners(event, false);
    return !event.defaultPrevented;
  }
}

class MiniNode extends MiniEventTarget {
  readonly nodeType: number;
  readonly nodeName: string;
  ownerDocument: MiniDocument | null;
  parentNode: MiniNode | null = null;
  readonly childNodes: MiniNode[] = [];
  protected textValue = "";

  constructor(nodeType: number, nodeName: string, ownerDocument: MiniDocument | null) {
    super();
    this.nodeType = nodeType;
    this.nodeName = nodeName;
    this.ownerDocument = ownerDocument;
  }

  get parentElement(): MiniElement | null {
    return this.parentNode instanceof MiniElement ? this.parentNode : null;
  }

  get isConnected(): boolean {
    if (this.ownerDocument === null) return false;
    if ((this as MiniNode) === this.ownerDocument) return true;
    let cur: MiniNode | null = this.parentNode;
    while (cur !== null) {
      if (cur === this.ownerDocument) return true;
      cur = cur.parentNode;
    }
    return false;
  }

  get firstChild(): MiniNode | null {
    return this.childNodes[0] ?? null;
  }

  get lastChild(): MiniNode | null {
    return this.childNodes[this.childNodes.length - 1] ?? null;
  }

  get nextSibling(): MiniNode | null {
    const idx = this.parentNode?.childNodes.indexOf(this) ?? -1;
    return idx >= 0 ? (this.parentNode?.childNodes[idx + 1] ?? null) : null;
  }

  get nodeValue(): string | null {
    return this.nodeType === 3 || this.nodeType === 8 ? this.textValue : null;
  }

  set nodeValue(val: string | null) {
    this.textValue = val ?? "";
  }

  get data(): string {
    return this.textValue;
  }

  set data(val: string) {
    this.textValue = val;
  }

  get textContent(): string {
    if (this.nodeType === 3) return this.textValue;
    if (this.nodeType === 8) return "";
    return this.childNodes.map((child) => child.textContent).join("");
  }

  set textContent(val: string) {
    if (this.nodeType === 3 || this.nodeType === 8) {
      this.textValue = val;
      return;
    }
    for (const child of [...this.childNodes]) this.removeChild(child);
    if (val !== "" && this.ownerDocument !== null) {
      this.appendChild(this.ownerDocument.createTextNode(val));
    }
  }

  appendChild<T extends MiniNode>(child: T): T {
    if (child.parentNode !== null) child.parentNode.removeChild(child);
    child.parentNode = this;
    this.childNodes.push(child);
    return child;
  }

  insertBefore<T extends MiniNode>(child: T, refNode: MiniNode | null): T {
    if (refNode === null) return this.appendChild(child);
    if (child.parentNode !== null) child.parentNode.removeChild(child);
    const idx = this.childNodes.indexOf(refNode);
    if (idx < 0) return this.appendChild(child);
    child.parentNode = this;
    this.childNodes.splice(idx, 0, child);
    return child;
  }

  removeChild<T extends MiniNode>(child: T): T {
    const idx = this.childNodes.indexOf(child);
    if (idx >= 0) {
      this.childNodes.splice(idx, 1);
      child.parentNode = null;
    }
    return child;
  }

  remove(): void {
    this.parentNode?.removeChild(this);
  }

  override dispatchEvent(event: MiniEvent): boolean {
    event.target = this;
    const path: MiniEventTarget[] = [this];
    for (let cur = this.parentNode; cur !== null; cur = cur.parentNode) path.push(cur);
    if (this.ownerDocument !== null && path[path.length - 1] !== this.ownerDocument) {
      path.push(this.ownerDocument);
    }
    if (this.ownerDocument !== null) path.push(this.ownerDocument.defaultView);
    event.eventPhase = 1;
    for (let i = path.length - 1; i > 0; i -= 1) {
      if (event.propagationStopped) return !event.defaultPrevented;
      path[i]?.invokeListeners(event, true);
    }
    if (!event.propagationStopped) {
      event.eventPhase = 2;
      this.invokeListeners(event, true);
      if (!event.propagationStopped) this.invokeListeners(event, false);
    }
    if (event.bubbles) {
      event.eventPhase = 3;
      for (let i = 1; i < path.length; i += 1) {
        if (event.propagationStopped) break;
        path[i]?.invokeListeners(event, false);
      }
    }
    return !event.defaultPrevented;
  }
}

class MiniStyle {
  private readonly props = new Map<string, string>();
  display = "";
  fontFamily = "";
  color = "";
  background = "";
  zoom = "";
  transform = "";

  setProperty(name: string, value: string): void {
    this.props.set(name, value);
    if (name === "display") this.display = value;
  }

  removeProperty(name: string): void {
    this.props.delete(name);
    if (name === "display") this.display = "";
  }

  getPropertyValue(name: string): string {
    return this.props.get(name) ?? "";
  }
}

class MiniElement extends MiniNode {
  readonly tagName: string;
  readonly attributes = new Map<string, string>();
  readonly style = new MiniStyle();
  readonly dataset: Record<string, string> = {};
  disabled = false;
  oninput: unknown = null;
  onchange: unknown = null;
  onclick: unknown = null;
  onkeydown: unknown = null;

  constructor(tag: string, ownerDocument: MiniDocument) {
    super(1, tag.toUpperCase(), ownerDocument);
    this.tagName = tag.toUpperCase();
  }

  get className(): string {
    return this.attributes.get("class") ?? "";
  }

  set className(val: string) {
    this.attributes.set("class", val);
  }

  get id(): string {
    return this.attributes.get("id") ?? "";
  }

  set id(val: string) {
    this.attributes.set("id", val);
  }

  setAttribute(key: string, val: string): void {
    this.attributes.set(key.toLowerCase(), String(val));
  }

  getAttribute(key: string): string | null {
    return this.attributes.get(key.toLowerCase()) ?? null;
  }

  removeAttribute(key: string): void {
    this.attributes.delete(key.toLowerCase());
  }

  hasAttribute(key: string): boolean {
    return this.attributes.has(key.toLowerCase());
  }

  toggleAttribute(key: string, force?: boolean): boolean {
    const lower = key.toLowerCase();
    const shouldAdd = force ?? !this.attributes.has(lower);
    if (shouldAdd) this.attributes.set(lower, "");
    else this.attributes.delete(lower);
    return shouldAdd;
  }

  focus(): void {
    if (this.ownerDocument !== null) this.ownerDocument.activeElement = this;
  }

  click(): void {
    this.dispatchEvent(new MiniEvent("click", { bubbles: true, cancelable: true }));
  }

  attachEvent(): void {}
  detachEvent(): void {}

  findAll(predicate: (el: MiniElement) => boolean): MiniElement[] {
    const matches: MiniElement[] = [];
    const walk = (node: MiniNode) => {
      if (node instanceof MiniElement && predicate(node)) matches.push(node);
      for (const child of node.childNodes) walk(child);
    };
    walk(this);
    return matches;
  }

  findOne(predicate: (el: MiniElement) => boolean): MiniElement | undefined {
    return this.findAll(predicate)[0];
  }
}

class MiniTextareaElement extends MiniElement {
  private _value = "";
  private _defaultValue = "";
  selectionStart = 0;
  selectionEnd = 0;

  constructor(ownerDocument: MiniDocument) {
    super("textarea", ownerDocument);
  }

  get value(): string {
    return this._value;
  }

  set value(next: string) {
    this._value = String(next);
    this.selectionStart = this._value.length;
    this.selectionEnd = this._value.length;
  }

  get defaultValue(): string {
    return this._defaultValue;
  }

  set defaultValue(next: string) {
    this._defaultValue = String(next);
  }
}

class MiniInputElement extends MiniElement {
  private _value = "";
  private _defaultValue = "";
  type = "text";

  constructor(ownerDocument: MiniDocument) {
    super("input", ownerDocument);
  }

  get value(): string {
    return this._value;
  }

  set value(next: string) {
    this._value = String(next);
  }

  get defaultValue(): string {
    return this._defaultValue;
  }

  set defaultValue(next: string) {
    this._defaultValue = String(next);
  }
}

class MiniIframeElement extends MiniElement {}

class MiniStorage {
  private readonly map = new Map<string, string>();
  getItem(key: string): string | null {
    return this.map.get(key) ?? null;
  }
  setItem(key: string, value: string): void {
    this.map.set(key, String(value));
  }
  removeItem(key: string): void {
    this.map.delete(key);
  }
  clear(): void {
    this.map.clear();
  }
}

class MiniWindow extends MiniEventTarget {
  readonly navigator = { userAgent: "node", platform: "Win32" };
  readonly location = { search: "", href: "http://localhost/" };
  readonly localStorage = new MiniStorage();
  readonly sessionStorage = new MiniStorage();
  readonly innerWidth = 1280;
  readonly innerHeight = 800;
  readonly HTMLIFrameElement = MiniIframeElement;
  readonly HTMLTextAreaElement = MiniTextareaElement;
  readonly HTMLInputElement = MiniInputElement;
  readonly HTMLElement = MiniElement;
  readonly Element = MiniElement;
  readonly Node = MiniNode;
  readonly Event = MiniEvent;
  readonly KeyboardEvent = MiniEvent;
  setTimeout = globalThis.setTimeout.bind(globalThis);
  clearTimeout = globalThis.clearTimeout.bind(globalThis);
  matchMedia = () => ({
    matches: false,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
  });
  requestAnimationFrame = (cb: () => void) => {
    cb();
    return 1;
  };
  cancelAnimationFrame = () => undefined;
}

class MiniDocument extends MiniNode {
  readonly documentElement: MiniElement;
  readonly head: MiniElement;
  readonly body: MiniElement;
  readonly defaultView = new MiniWindow();
  activeElement: MiniElement | null = null;

  constructor() {
    super(9, "#document", null);
    this.documentElement = new MiniElement("html", this);
    this.head = new MiniElement("head", this);
    this.body = new MiniElement("body", this);
    this.documentElement.appendChild(this.head);
    this.documentElement.appendChild(this.body);
    this.appendChild(this.documentElement);
  }

  hasFocus(): boolean {
    return true;
  }

  getElementById(id: string): MiniElement | null {
    return this.documentElement.findOne((el) => el.id === id) ?? null;
  }

  querySelector(selector: string): MiniElement | null {
    if (selector.startsWith(".")) {
      const cls = selector.slice(1);
      return this.documentElement.findOne((el) => el.className.split(/\s+/).includes(cls)) ?? null;
    }
    return null;
  }

  createElement(tag: string): MiniElement {
    const lower = tag.toLowerCase();
    if (lower === "textarea") return new MiniTextareaElement(this);
    if (lower === "input") return new MiniInputElement(this);
    return new MiniElement(tag, this);
  }

  createElementNS(_ns: string, tag: string): MiniElement {
    return new MiniElement(tag, this);
  }

  createTextNode(text: string): MiniNode {
    const node = new MiniNode(3, "#text", this);
    node.nodeValue = text;
    return node;
  }

  createComment(text: string): MiniNode {
    const node = new MiniNode(8, "#comment", this);
    node.nodeValue = text;
    return node;
  }
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

function hasClass(el: MiniElement, cls: string): boolean {
  return el.className.split(/\s+/).includes(cls);
}

function findAncestor(node: MiniNode | null, predicate: (el: MiniElement) => boolean): MiniElement | null {
  let cur = node?.parentNode ?? null;
  while (cur !== null) {
    if (cur instanceof MiniElement && predicate(cur)) return cur;
    cur = cur.parentNode;
  }
  return null;
}

function setTextareaValue(textarea: MiniTextareaElement, value: string): void {
  const protoDesc = Object.getOwnPropertyDescriptor(MiniTextareaElement.prototype, "value");
  textarea.focus();
  textarea.dispatchEvent(new MiniEvent("focusin", { bubbles: true }));
  protoDesc?.set?.call(textarea, value);
  textarea.dispatchEvent(new MiniEvent("input", { bubbles: true }));
  textarea.dispatchEvent(new MiniEvent("keyup", { bubbles: true }));
}

interface MountedMiniDom {
  readonly doc: MiniDocument;
  readonly win: MiniWindow;
  readonly container: MiniElement;
  readonly unmount: () => Promise<void>;
}

const activeMounts: MountedMiniDom[] = [];

async function mountAppInMiniDom(element: ReactNode = createElement(App)): Promise<MountedMiniDom> {
  const g = globalThis as Record<string, unknown>;
  const keys = [
    "window",
    "document",
    "Node",
    "Element",
    "HTMLElement",
    "HTMLIFrameElement",
    "HTMLTextAreaElement",
    "HTMLInputElement",
    "Event",
    "KeyboardEvent",
    "IS_REACT_ACT_ENVIRONMENT",
  ] as const;
  const saved: Record<string, unknown> = {};
  for (const key of keys) saved[key] = g[key];

  const doc = new MiniDocument();
  const win = doc.defaultView;
  const container = doc.createElement("div");
  container.id = "root";
  doc.body.appendChild(container);

  Object.assign(g, {
    window: win,
    document: doc,
    Node: MiniNode,
    Element: MiniElement,
    HTMLElement: MiniElement,
    HTMLIFrameElement: MiniIframeElement,
    HTMLTextAreaElement: MiniTextareaElement,
    HTMLInputElement: MiniInputElement,
    Event: MiniEvent,
    KeyboardEvent: MiniEvent,
    IS_REACT_ACT_ENVIRONMENT: true,
  });

  ensureClientPluginRuntime();
  await whenClientPluginServicesReady();

  const root: Root = createRoot(container as unknown as Element);
  await act(async () => {
    root.render(element);
  });

  let unmounted = false;
  const handle: MountedMiniDom = {
    doc,
    win,
    container,
    unmount: async () => {
      if (unmounted) return;
      unmounted = true;
      await act(async () => {
        root.unmount();
      });
      for (const key of keys) {
        if (saved[key] === undefined) delete g[key];
        else g[key] = saved[key];
      }
    },
  };
  activeMounts.push(handle);
  return handle;
}

function resetAppState(): void {
  safeModeController.disable();
  useAppStore.setState({
    connection: "disconnected",
    cwd: "",
    sessionFile: null,
    sessionId: null,
    sessionName: null,
    messages: [],
    sessions: [],
    toasts: [],
    notifications: [],
    lastError: null,
  });
}

describe("ADR 0023 Wave 2C: Full microkernel cutover end-to-end", () => {
  beforeEach(() => {
    resetAppState();
  });

  afterEach(async () => {
    while (activeMounts.length > 0) {
      const m = activeMounts.pop();
      await m?.unmount();
    }
    safeModeController.disable();
    vi.restoreAllMocks();
  });

  it("boots full <App /> through <SlotRoot /> + BuiltinCorePluginCoordinator with minimal boot stub", async () => {
    const appSource = readFileSync(resolve(REPO_ROOT, "src/App.tsx"), "utf8");
    const appLines = appSource.replace(/\r\n/g, "\n").replace(/\n$/, "").split("\n").length;
    expect(appLines).toBeLessThanOrEqual(150);
    expect(appSource).not.toContain("builtinPluginGatesStore");
    expect(appSource).not.toContain("components/shell/");
    expect(appSource).not.toContain("builtin-plugins/");

    const { container } = await mountAppInMiniDom();

    expect(container.findOne((el) => el.getAttribute("data-core-plugin") === "core-shell")).toBeDefined();
    expect(container.findOne((el) => el.getAttribute("data-core-plugin") === "core-home")).toBeDefined();
    expect(container.findOne((el) => el.getAttribute("data-testid") === "core-composer")).toBeDefined();
    expect(container.findOne((el) => hasClass(el, "window-menubar"))).toBeDefined();
    expect(container.findOne((el) => hasClass(el, "sidebar"))).toBeDefined();

    // Core shell, home, sidebar, and composer all resolve from the live slot registry
    expect(clientSlotsRegistry.getEntries("root").some((e) => e.pluginId === "core-shell")).toBe(true);
    expect(clientSlotsRegistry.getEntries("shell.sidebar").some((e) => e.pluginId === "core-sidebar")).toBe(true);
    expect(clientSlotsRegistry.getEntries("composer.main").some((e) => e.pluginId === "core-composer")).toBe(true);
  });

  it("supports composer.main overlay:true takeover preserving draft input text without unmounting", async () => {
    const { container } = await mountAppInMiniDom();
    const textarea = container.findOne((el) => el instanceof MiniTextareaElement && hasClass(el, "composer-input"));
    expect(textarea).toBeInstanceOf(MiniTextareaElement);
    if (!(textarea instanceof MiniTextareaElement)) return;

    await act(async () => {
      setTextareaValue(textarea, "unsent draft surviving overlay takeover");
    });
    expect(textarea.value).toBe("unsent draft surviving overlay takeover");

    setPluginTier("user-composer-overlay", "user");
    const OverlayComposer = (_props: SlotComponentProps<ComposerMainSlotProps, "session-maybe">) =>
      createElement("div", { "data-testid": "user-composer-overlay" }, "User Overlay Composer Active");

    let disposeOverlay: (() => void) | undefined;
    try {
      await act(async () => {
        disposeOverlay = clientSlotsRegistry.register("composer.main", {
          id: "user-composer-overlay:main",
          pluginId: "user-composer-overlay",
          tier: "user",
          priority: 100,
          overlay: true,
          select: () => true,
          component: OverlayComposer,
        });
      });

      expect(container.findOne((el) => el.getAttribute("data-testid") === "user-composer-overlay")).toBeDefined();

      // Built-in composer stays mounted under display:none so typed draft survives intact
      const coreComposer = container.findOne((el) => el.getAttribute("data-testid") === "core-composer");
      expect(coreComposer).toBeDefined();
      const hiddenWrapper = findAncestor(
        coreComposer ?? null,
        (el) => el.getAttribute("data-qj-chain-hidden") === "true" || el.style.display === "none",
      );
      expect(hiddenWrapper).not.toBeNull();
      expect(textarea.value).toBe("unsent draft surviving overlay takeover");

      // Disposing overlay restores visible built-in composer with exact draft text
      await act(async () => {
        disposeOverlay?.();
        disposeOverlay = undefined;
      });

      expect(container.findOne((el) => el.getAttribute("data-testid") === "user-composer-overlay")).toBeUndefined();
      const restoredTextarea = container.findOne(
        (el) => el instanceof MiniTextareaElement && hasClass(el, "composer-input"),
      );
      expect(restoredTextarea).toBeInstanceOf(MiniTextareaElement);
      expect((restoredTextarea as MiniTextareaElement).value).toBe("unsent draft surviving overlay takeover");
    } finally {
      if (disposeOverlay !== undefined) {
        await act(async () => {
          disposeOverlay?.();
        });
      }
    }
  });

  it("abdicates back to built-in core-home and emits warning toast when a user core-override throws", async () => {
    const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const { container } = await mountAppInMiniDom();
    expect(container.findOne((el) => hasClass(el, "new-task-heading"))).toBeDefined();

    setPluginTier("broken-home-override", "user");
    const BrokenHomeHero = (_props: SlotComponentProps<HomeHeroSlotProps, "root">) => {
      throw new Error("Simulated user home.hero crash");
    };

    let disposeBroken: (() => void) | undefined;
    try {
      await act(async () => {
        disposeBroken = clientSlotsRegistry.register("home.hero", {
          id: "broken-home-override:hero",
          pluginId: "broken-home-override",
          tier: "user",
          priority: 50,
          component: BrokenHomeHero,
        });
      });

      // Fallback built-in CoreHomeHero is still rendered smoothly after abdication
      expect(container.findOne((el) => hasClass(el, "new-task-heading"))).toBeDefined();
      // Warning toast surfaced to user
      const toasts = useAppStore.getState().toasts;
      expect(
        toasts.some(
          (t) =>
            t.kind === "warning" &&
            t.message.includes("broken-home-override") &&
            t.message.includes("home.hero"),
        ),
      ).toBe(true);
    } finally {
      await act(async () => {
        disposeBroken?.();
        clientSlotsRegistry.abdication.clearPlugin("broken-home-override");
      });
      consoleErrorSpy.mockRestore();
    }
  });

  it("injects *.global.css in @layer plugin-skin and cleans it up on disable and Safe Mode (Ctrl+Shift+Alt+R)", async () => {
    const { doc, win, container } = await mountAppInMiniDom();
    const root = getClientRootContext();
    expect(root).toBeDefined();
    expect(container.findOne((el) => el.getAttribute("data-core-plugin") === "core-shell")).toBeDefined();

    const findGlobalStyle = () =>
      doc.head.findOne(
        (el) =>
          el.tagName === "STYLE" &&
          el.getAttribute("data-qj-style-key") === "acme-global-skin" &&
          el.getAttribute("data-qj-style-scope") === "global",
      );

    const skinPlugin: Plugin.Object = {
      name: "acme-global-skin",
      inject: ["styles"],
      apply(ctx: Context) {
        ctx.styles.injectGlobal(".app-shell { --acme-skin-token: 42px; }", "acme-global-skin");
      },
    };

    // 1. Mount user skin plugin -> @layer plugin-skin style tag appears in document.head
    let skinFiber = root?.plugin(skinPlugin);
    await act(async () => {
      await skinFiber;
    });
    const styleEl = findGlobalStyle();
    expect(styleEl).toBeDefined();
    expect(styleEl?.textContent).toContain("@layer plugin-skin");
    expect(styleEl?.textContent).toContain("--acme-skin-token: 42px");
    expect(styleEl?.textContent).not.toContain("@scope");

    // 2. Disable plugin (Fiber dispose) -> global skin stylesheet is cleaned up automatically
    await act(async () => {
      await skinFiber?.dispose();
    });
    expect(findGlobalStyle()).toBeUndefined();

    // 3. Re-mount skin plugin gated on Safe Mode, install hotkey listener on this MiniWindow,
    //    and fire Ctrl+Shift+Alt+R -> SafeModeBanner renders & user skin stylesheet cleans up
    const localHotkeyController = createSafeModeController({
      windowLike: win as unknown as NonNullable<Parameters<typeof createSafeModeController>[0]>["windowLike"],
      storage: win.sessionStorage,
    });
    const offHotkeyInstall = localHotkeyController.install();
    const offForwardSafeMode = localHotkeyController.subscribe(() => {
      safeModeController.setEnabled(localHotkeyController.isEnabled(), localHotkeyController.getSnapshot().reason ?? "hotkey");
    });

    skinFiber = root?.plugin(skinPlugin);
    await act(async () => {
      await skinFiber;
    });
    const offSafeMode = safeModeController.subscribe(() => {
      if (safeModeController.isEnabled()) {
        void skinFiber?.dispose();
      }
    });

    try {
      expect(findGlobalStyle()).toBeDefined();

      await act(async () => {
        win.dispatchEvent(
          new MiniEvent("keydown", {
            key: "R",
            code: "KeyR",
            ctrlKey: true,
            shiftKey: true,
            altKey: true,
            bubbles: true,
            cancelable: true,
          }),
        );
        await Promise.resolve();
      });

      expect(safeModeController.isEnabled()).toBe(true);
      expect(container.findOne((el) => el.getAttribute("data-testid") === "safe-mode-banner")).toBeDefined();
      expect(findGlobalStyle()).toBeUndefined();

      // Clicking exit button on the un-overridable SafeModeBanner disables Safe Mode
      const exitButton = container.findOne((el) => el.getAttribute("data-testid") === "safe-mode-exit");
      expect(exitButton).toBeDefined();
      await act(async () => {
        exitButton?.click();
      });
      expect(safeModeController.isEnabled()).toBe(false);
      expect(container.findOne((el) => el.getAttribute("data-testid") === "safe-mode-banner")).toBeUndefined();
    } finally {
      offSafeMode();
      offForwardSafeMode();
      offHotkeyInstall();
      await skinFiber?.dispose();
    }
  });

  it("genuinely unmounts/overrides all 5 feature plugins (code-review, web-preview, side-chat, diagram-viewer, intelligent-ui) and same-ID core-composer override", async () => {
    const root = new Context();
    const registry = new SlotRegistry();
    const contributions = new ClientContributionRegistry();
    const localSafeMode = createSafeModeController({ windowLike: null, storage: null });

    const coreFibers = await Promise.all([
      root.plugin(ClientSlotsService, registry),
      root.plugin(ClientContributionService, contributions),
      root.plugin(ClientStylesService),
    ]);
    await registerFrontendServices(root, { contributionRegistry: contributions });

    const featureIds = [
      "code-review",
      "web-preview",
      "side-chat",
      "diagram-viewer",
      "intelligent-ui",
    ] as const;

    let hostPlugins: PluginInfo[] = [
      ...featureIds.map((id) => makePluginInfo({ id, tier: "builtin", enabled: true })),
      makePluginInfo({ id: "core-composer", tier: "builtin", enabled: true }),
    ];

    const transport: BuiltinCorePluginTransport = {
      list: async () => hostPlugins,
      onChanged: () => () => undefined,
    };

    const coordinator = createBuiltinCorePluginCoordinator(root, {
      transport,
      safeMode: localSafeMode,
      descriptors: DEFAULT_BUILTIN_CLIENT_PLUGINS,
    });

    const statusOf = (id: string) =>
      coordinator.getSnapshot().plugins.find((entry) => entry.id === id)?.status;
    const resolveKeyed = (slotKey: string, routeKey: string) =>
      registry.getKeyedCandidates(slotKey, routeKey)[0];

    try {
      await coordinator.sync();

      // All 5 feature plugins + core-composer are mounted and registered in SlotRegistry
      for (const id of featureIds) {
        expect(statusOf(id)).toBe("mounted");
      }
      expect(statusOf("core-composer")).toBe("mounted");
      expect(resolveKeyed("workbench.panes", "review")).toBeDefined();
      expect(resolveKeyed("workbench.panes", "preview")).toBeDefined();
      expect(resolveKeyed("workbench.panes", "side-chat")).toBeDefined();
      expect(resolveKeyed("workbench.panes", "intelligent-ui-canvas")?.pluginId).toBe("intelligent-ui");
      expect(resolveKeyed("conversation.markdown.codeBlock", "mermaid")?.pluginId).toBe(
        "diagram-viewer",
      );
      expect(resolveKeyed("conversation.markdown.codeBlock", "plantuml")?.pluginId).toBe(
        "diagram-viewer",
      );

      // Disable all 5 feature plugins -> Fibers genuinely dispose and all their slot registrations vanish
      hostPlugins = [
        ...featureIds.map((id) =>
          makePluginInfo({ id, tier: "builtin", enabled: false, status: "disabled" }),
        ),
        makePluginInfo({ id: "core-composer", tier: "builtin", enabled: true }),
      ];
      await coordinator.sync();

      for (const id of featureIds) {
        expect(statusOf(id)).toBe("disabled");
        expect(coordinator.getMountedIds()).not.toContain(id);
      }
      expect(resolveKeyed("workbench.panes", "review")).toBeUndefined();
      expect(resolveKeyed("workbench.panes", "preview")).toBeUndefined();
      expect(resolveKeyed("workbench.panes", "side-chat")).toBeUndefined();
      expect(resolveKeyed("workbench.panes", "intelligent-ui-canvas")).toBeUndefined();
      expect(resolveKeyed("conversation.markdown.codeBlock", "mermaid")?.pluginId).not.toBe(
        "diagram-viewer",
      );
      expect(resolveKeyed("conversation.markdown.codeBlock", "plantuml")?.pluginId).not.toBe(
        "diagram-viewer",
      );

      // Same-ID user override for all 5 feature plugins AND core-composer -> built-ins yield
      hostPlugins = [
        ...featureIds.map((id) =>
          makePluginInfo({ id, tier: "user", enabled: true, hasClient: true }),
        ),
        makePluginInfo({ id: "core-composer", tier: "user", enabled: true, hasClient: true }),
      ];
      await coordinator.sync();

      for (const id of [...featureIds, "core-composer"] as const) {
        expect(statusOf(id)).toBe("overridden");
        expect(coordinator.getMountedIds()).not.toContain(id);
      }

      // Enabling Safe Mode automatically restores all built-in core + feature Fibers
      localSafeMode.enable("hotkey");
      await coordinator.sync({ fetchList: false });

      for (const id of [...featureIds, "core-composer"] as const) {
        expect(statusOf(id)).toBe("mounted");
        expect(coordinator.getMountedIds()).toContain(id);
      }
    } finally {
      await coordinator.dispose();
      for (const fiber of coreFibers) {
        await fiber.dispose();
      }
    }
  });
});

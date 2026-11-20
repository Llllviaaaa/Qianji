/**
 * Integration tests for built-in `core-settings` plugin & `SlotOwnershipPanel`
 * (ADR 0023 §5 & §7 Phase 4).
 */
import { act, type ReactNode } from "react";
import type { Root } from "react-dom/client";
import { Context } from "@deepseek-ai/cordis";
import { afterEach, describe, expect, it } from "vitest";
import {
  CORE_SETTINGS_PLUGIN_ID,
  SlotOwnershipPanel,
  coreSettingsPlugin,
} from "../src/builtin-plugins/core-settings";
import {
  createSafeModeController,
  createSlotOverridesStore,
  safeModeController,
} from "../src/kernel/runtime";
import { registerFrontendServices, type RpcTransport } from "../src/kernel/services";
import type { PluginInfo } from "@qianji/protocol";
import {
  ClientSlotsService,
  CORE_SLOT_SPECS,
  SlotHost,
  SlotKernelProvider,
  SlotRegistry,
} from "../src/kernel/slots";

type ListenerEntry = { readonly fn: (event: MiniEvent) => void; readonly capture: boolean };
interface MiniEventInit { bubbles?: boolean; cancelable?: boolean; key?: string; code?: string; ctrlKey?: boolean; metaKey?: boolean; shiftKey?: boolean; altKey?: boolean }

class MiniEvent {
  readonly type: string; readonly bubbles: boolean; readonly cancelable: boolean;
  readonly key: string; readonly code: string;
  readonly ctrlKey: boolean; readonly metaKey: boolean; readonly shiftKey: boolean; readonly altKey: boolean;
  target: MiniEventTarget | null = null; currentTarget: MiniEventTarget | null = null;
  defaultPrevented = false; propagationStopped = false; eventPhase = 0;
  constructor(type: string, init: MiniEventInit = {}) {
    this.type = type; this.bubbles = init.bubbles ?? true; this.cancelable = init.cancelable ?? true;
    this.key = init.key ?? ""; this.code = init.code ?? "";
    this.ctrlKey = init.ctrlKey ?? false; this.metaKey = init.metaKey ?? false;
    this.shiftKey = init.shiftKey ?? false; this.altKey = init.altKey ?? false;
  }
  preventDefault(): void { if (this.cancelable) this.defaultPrevented = true; }
  stopPropagation(): void { this.propagationStopped = true; }
  stopImmediatePropagation(): void { this.propagationStopped = true; }
}

class MiniEventTarget {
  private readonly listeners = new Map<string, ListenerEntry[]>();
  addEventListener(type: string, fn: ((event: MiniEvent) => void) | null, opts?: boolean | { capture?: boolean }): void {
    if (fn === null) return;
    const capture = typeof opts === "boolean" ? opts : (opts?.capture ?? false);
    const list = this.listeners.get(type) ?? [];
    if (!list.some((i) => i.fn === fn && i.capture === capture)) { list.push({ fn, capture }); this.listeners.set(type, list); }
  }
  removeEventListener(type: string, fn: ((event: MiniEvent) => void) | null, opts?: boolean | { capture?: boolean }): void {
    if (fn === null) return;
    const capture = typeof opts === "boolean" ? opts : (opts?.capture ?? false);
    const list = this.listeners.get(type);
    if (list !== undefined) this.listeners.set(type, list.filter((i) => i.fn !== fn || i.capture !== capture));
  }
  invokeListeners(event: MiniEvent, capture: boolean): void {
    for (const e of [...(this.listeners.get(event.type) ?? [])]) {
      if (e.capture === capture) { event.currentTarget = this; e.fn(event); }
    }
  }
}

class MiniNode extends MiniEventTarget {
  readonly nodeType: number; readonly nodeName: string;
  ownerDocument: MiniDocument | null; parentNode: MiniNode | null = null;
  readonly childNodes: MiniNode[] = []; protected textValue = "";
  constructor(nodeType: number, nodeName: string, ownerDocument: MiniDocument | null) {
    super(); this.nodeType = nodeType; this.nodeName = nodeName; this.ownerDocument = ownerDocument;
  }
  get parentElement(): MiniElement | null { return this.parentNode instanceof MiniElement ? this.parentNode : null; }
  get firstChild(): MiniNode | null { return this.childNodes[0] ?? null; }
  get lastChild(): MiniNode | null { return this.childNodes[this.childNodes.length - 1] ?? null; }
  get nextSibling(): MiniNode | null { const i = this.parentNode?.childNodes.indexOf(this) ?? -1; return i >= 0 ? (this.parentNode?.childNodes[i + 1] ?? null) : null; }
  get previousSibling(): MiniNode | null { const i = this.parentNode?.childNodes.indexOf(this) ?? -1; return i > 0 ? (this.parentNode?.childNodes[i - 1] ?? null) : null; }
  get nodeValue(): string | null { return this.nodeType === 3 || this.nodeType === 8 ? this.textValue : null; }
  set nodeValue(v: string | null) { this.textValue = v ?? ""; }
  get data(): string { return this.textValue; }
  set data(v: string) { this.textValue = v; }
  get textContent(): string { return this.nodeType === 3 ? this.textValue : this.nodeType === 8 ? "" : this.childNodes.map((c) => c.textContent).join(""); }
  set textContent(v: string) {
    if (this.nodeType === 3 || this.nodeType === 8) { this.textValue = v; return; }
    for (const c of [...this.childNodes]) this.removeChild(c);
    if (v !== "" && this.ownerDocument !== null) this.appendChild(this.ownerDocument.createTextNode(v));
  }
  appendChild<T extends MiniNode>(child: T): T {
    if (child.parentNode !== null) child.parentNode.removeChild(child);
    child.parentNode = this; this.childNodes.push(child); return child;
  }
  insertBefore<T extends MiniNode>(child: T, ref: MiniNode | null): T {
    if (ref === null) return this.appendChild(child);
    if (child.parentNode !== null) child.parentNode.removeChild(child);
    const idx = this.childNodes.indexOf(ref);
    if (idx < 0) return this.appendChild(child);
    child.parentNode = this; this.childNodes.splice(idx, 0, child); return child;
  }
  removeChild<T extends MiniNode>(child: T): T {
    const idx = this.childNodes.indexOf(child);
    if (idx >= 0) { this.childNodes.splice(idx, 1); child.parentNode = null; }
    return child;
  }
  contains(other: MiniNode | null): boolean {
    for (let cur: MiniNode | null = other; cur !== null; cur = cur.parentNode) if (cur === this) return true;
    return false;
  }
  dispatchEvent(event: MiniEvent): boolean {
    event.target = this;
    const path: MiniEventTarget[] = [this];
    for (let cur = this.parentNode; cur !== null; cur = cur.parentNode) path.push(cur);
    if (this.ownerDocument !== null && path[path.length - 1] !== this.ownerDocument) path.push(this.ownerDocument);
    if (this.ownerDocument?.defaultView != null) path.push(this.ownerDocument.defaultView);
    event.eventPhase = 1;
    for (let i = path.length - 1; i > 0; i -= 1) { if (event.propagationStopped) return !event.defaultPrevented; path[i]?.invokeListeners(event, true); }
    if (!event.propagationStopped) { event.eventPhase = 2; this.invokeListeners(event, true); if (!event.propagationStopped) this.invokeListeners(event, false); }
    if (event.bubbles) { event.eventPhase = 3; for (let i = 1; i < path.length; i += 1) { if (event.propagationStopped) break; path[i]?.invokeListeners(event, false); } }
    return !event.defaultPrevented;
  }
}

function matchesSelector(el: MiniElement, sel: string): boolean {
  if (/^[a-zA-Z]+$/.test(sel)) return el.tagName === sel.toUpperCase();
  const attrEq = /^\[([a-zA-Z0-9_-]+)=['"]([^'"]*)['"]\]$/.exec(sel);
  if (attrEq !== null) return el.getAttribute(attrEq[1] ?? "") === (attrEq[2] ?? "");
  const attrPresent = /^\[([a-zA-Z0-9_-]+)\]$/.exec(sel);
  if (attrPresent !== null) return el.hasAttribute(attrPresent[1] ?? "");
  return sel.startsWith(".") && el.className.split(/\s+/).includes(sel.slice(1));
}

class MiniElement extends MiniNode {
  readonly tagName: string; readonly namespaceURI = "http://www.w3.org/1999/xhtml";
  readonly attributes = new Map<string, string>(); readonly style: Record<string, string> = {};
  private _value = ""; defaultValue = ""; checked = false; disabled = false;
  oninput: unknown = null; onchange: unknown = null;
  constructor(tag: string, ownerDocument: MiniDocument) { super(1, tag.toUpperCase(), ownerDocument); this.tagName = tag.toUpperCase(); }
  get value(): string { return this._value; }
  set value(v: string) { this._value = String(v); }
  get id(): string { return this.attributes.get("id") ?? ""; }
  set id(v: string) { this.attributes.set("id", v); }
  get className(): string { return this.attributes.get("class") ?? ""; }
  set className(v: string) { this.attributes.set("class", v); }
  get type(): string { return this.attributes.get("type") ?? ""; }
  set type(v: string) { this.attributes.set("type", v); }
  get options(): MiniElement[] { return this.querySelectorAll("option"); }
  get selected(): boolean { return this.hasAttribute("selected"); }
  set selected(v: boolean) { if (v) this.setAttribute("selected", ""); else this.removeAttribute("selected"); }
  setAttribute(name: string, value: string): void {
    const k = name.toLowerCase(); this.attributes.set(k, String(value));
    if (k === "disabled") this.disabled = true;
    if (k === "value") this._value = String(value);
  }
  getAttribute(name: string): string | null { return this.attributes.get(name.toLowerCase()) ?? null; }
  removeAttribute(name: string): void { const k = name.toLowerCase(); this.attributes.delete(k); if (k === "disabled") this.disabled = false; }
  hasAttribute(name: string): boolean { return this.attributes.has(name.toLowerCase()); }
  focus(): void { if (this.ownerDocument !== null) this.ownerDocument.activeElement = this; }
  blur(): void { if (this.ownerDocument?.activeElement === this) this.ownerDocument.activeElement = this.ownerDocument.body; }
  querySelectorAll(selector: string): MiniElement[] {
    const out: MiniElement[] = [];
    const parts = selector.split(",").map((s) => s.trim()).filter((s) => s !== "");
    const visit = (n: MiniNode): void => {
      for (const c of n.childNodes) if (c instanceof MiniElement) { if (parts.some((p) => matchesSelector(c, p))) out.push(c); visit(c); }
    };
    visit(this);
    return out;
  }
  querySelector(selector: string): MiniElement | null { return this.querySelectorAll(selector)[0] ?? null; }
}

class MiniDocument extends MiniNode {
  readonly documentElement: MiniElement; readonly head: MiniElement; readonly body: MiniElement;
  activeElement: MiniElement | null; defaultView: MiniWindow | null = null;
  oninput: unknown = null; onchange: unknown = null;
  constructor() {
    super(9, "#document", null);
    this.documentElement = new MiniElement("html", this);
    this.head = new MiniElement("head", this);
    this.body = new MiniElement("body", this);
    this.documentElement.appendChild(this.head);
    this.documentElement.appendChild(this.body);
    this.appendChild(this.documentElement);
    this.activeElement = this.body;
  }
  createElement(tag: string): MiniElement { return new MiniElement(tag, this); }
  createElementNS(_ns: string, tag: string): MiniElement { return new MiniElement(tag, this); }
  createTextNode(text: string): MiniNode { const n = new MiniNode(3, "#text", this); n.nodeValue = String(text); return n; }
  createComment(text: string): MiniNode { const n = new MiniNode(8, "#comment", this); n.nodeValue = String(text); return n; }
  querySelector(sel: string): MiniElement | null { return this.documentElement.querySelector(sel); }
  querySelectorAll(sel: string): MiniElement[] { return this.documentElement.querySelectorAll(sel); }
}

class MiniIframeStub {}

class MiniWindow extends MiniEventTarget {
  readonly document: MiniDocument;
  readonly HTMLElement = MiniElement; readonly HTMLIFrameElement = MiniIframeStub;
  readonly Element = MiniElement; readonly Node = MiniNode;
  readonly Event = MiniEvent; readonly KeyboardEvent = MiniEvent;
  private readonly pendingTimers = new Set<ReturnType<typeof globalThis.setTimeout>>();
  constructor(doc: MiniDocument) { super(); this.document = doc; doc.defaultView = this; }
  setTimeout(fn: () => void, ms?: number): ReturnType<typeof globalThis.setTimeout> {
    const id = globalThis.setTimeout(() => { this.pendingTimers.delete(id); fn(); }, ms);
    this.pendingTimers.add(id);
    return id;
  }
  clearTimeout(id: ReturnType<typeof globalThis.setTimeout>): void { this.pendingTimers.delete(id); globalThis.clearTimeout(id); }
  clearAllTimers(): void { for (const id of this.pendingTimers) globalThis.clearTimeout(id); this.pendingTimers.clear(); }
  dispatchEvent(event: MiniEvent): boolean {
    event.target = this; this.invokeListeners(event, true);
    if (!event.propagationStopped) this.invokeListeners(event, false);
    return !event.defaultPrevented;
  }
}

function createMemoryStorage() {
  const data = new Map<string, string>();
  return {
    getItem: (key: string): string | null => data.get(key) ?? null,
    setItem: (key: string, value: string): void => { data.set(key, value); },
    removeItem: (key: string): void => { data.delete(key); },
  };
}

function clickElement(el: MiniElement | null): void {
  expect(el).not.toBeNull();
  act(() => { el?.dispatchEvent(new MiniEvent("click", { bubbles: true, cancelable: true })); });
}

function setControlValue(el: MiniElement | null, nextValue: string): void {
  expect(el).not.toBeNull();
  if (el === null) return;
  const descriptor = Object.getOwnPropertyDescriptor(MiniElement.prototype, "value");
  act(() => {
    descriptor?.set?.call(el, nextValue);
    if (el.tagName === "SELECT") el.dispatchEvent(new MiniEvent("change", { bubbles: true, cancelable: true }));
    else { el.dispatchEvent(new MiniEvent("input", { bubbles: true, cancelable: true })); el.dispatchEvent(new MiniEvent("change", { bubbles: true, cancelable: true })); }
  });
}

const cleanups: Array<() => Promise<void> | void> = [];

async function mountInDom(node: ReactNode) {
  const g = globalThis as Record<string, unknown>;
  const keys = ["window", "document", "Node", "Element", "HTMLElement", "HTMLIFrameElement", "Event", "KeyboardEvent", "IS_REACT_ACT_ENVIRONMENT"] as const;
  const saved = Object.fromEntries(keys.map((key) => [key, g[key]]));
  const doc = new MiniDocument();
  const win = new MiniWindow(doc);
  const container = doc.createElement("div");
  doc.body.appendChild(container);
  Object.assign(g, {
    window: win, document: doc, Node: MiniNode, Element: MiniElement, HTMLElement: MiniElement,
    HTMLIFrameElement: MiniIframeStub, Event: MiniEvent, KeyboardEvent: MiniEvent, IS_REACT_ACT_ENVIRONMENT: true,
  });
  const { createRoot } = await import("react-dom/client");
  let root: Root | null = null;
  act(() => { root = createRoot(container as unknown as Element); root.render(node); });
  cleanups.push(() => {
    win.clearAllTimers();
    act(() => { root?.unmount(); });
    for (const key of keys) { if (saved[key] === undefined) delete g[key]; else g[key] = saved[key]; }
  });
  return { doc, win, container };
}

async function createCoreSettingsHarness(rpcTransport?: RpcTransport) {
  const overrides = createSlotOverridesStore({ storage: createMemoryStorage() });
  const registry = new SlotRegistry({ overrides });
  registry.defineSlot("shell.modals", CORE_SLOT_SPECS["shell.modals"]);
  registry.defineSlot("shell.sidebar", CORE_SLOT_SPECS["shell.sidebar"]);
  registry.defineSlot("shell.topbar", CORE_SLOT_SPECS["shell.topbar"]);
  const root = new Context();
  await root.plugin(ClientSlotsService, registry);
  await registerFrontendServices(root, { shortcutTarget: null, ...(rpcTransport === undefined ? {} : { rpcTransport }) });
  const settingsFiber = await root.plugin(coreSettingsPlugin);
  cleanups.push(async () => { await Promise.resolve(settingsFiber.dispose()).catch(() => undefined); registry.dispose(); });
  return { root, registry, overrides, settingsFiber };
}

afterEach(async () => {
  safeModeController.disable();
  while (cleanups.length > 0) { const fn = cleanups.pop(); if (fn !== undefined) await fn(); }
});

describe("core-settings plugin & SlotOwnershipPanel", () => {
  it("opens Settings via navigationService.openSettings('slots') and renders core + custom slots", async () => {
    const { root, registry, settingsFiber } = await createCoreSettingsHarness();
    registry.defineSlot("acme.custom.banner", { kind: "single", scope: "root", description: "第三方动态横幅" });
    registry.register("acme.custom.banner", { pluginId: "acme-plugin", tier: "user", component: () => <span>acme</span> });

    const { container } = await mountInDom(
      <SlotKernelProvider registry={registry} ctx={root}>
        <SlotHost slotKey="shell.modals" kind="list" scope="root" />
      </SlotKernelProvider>,
    );

    expect(container.querySelector("[data-testid='core-settings-shell']")).toBeNull();
    expect(CORE_SETTINGS_PLUGIN_ID).toBe("core-settings");

    act(() => { root.navigationService.openSettings("slots"); });

    const shell = container.querySelector("[data-testid='core-settings-shell']");
    expect(shell).not.toBeNull();
    expect(shell?.className).toContain("settings-modal");
    expect(shell?.textContent).toContain("核心槽位与接管");
    expect(shell?.textContent).toContain("查看核心界面槽位归属、切换冲突胜出插件或一键恢复内置默认");
    expect(container.querySelector("[data-testid='slot-ownership-panel']")).not.toBeNull();
    expect(container.querySelector("[data-testid='slot-row-root']")).not.toBeNull();
    expect(container.querySelector("[data-testid='slot-row-shell.sidebar']")).not.toBeNull();
    expect(container.querySelector("[data-testid='slot-row-settings.shell']")).not.toBeNull();
    expect(container.querySelector("[data-testid='slot-row-settings.pages']")).not.toBeNull();
    expect(container.querySelector("[data-testid='slot-row-settings.sections']")).not.toBeNull();
    expect(container.querySelector("[data-testid='slot-row-acme.custom.banner']")?.textContent).toContain("acme-plugin");

    await act(async () => { await settingsFiber.dispose(); });
    expect(registry.getEntries("settings.shell").length).toBe(0);
    expect(registry.getEntries("settings.pages").length).toBe(0);
  });

  it("pins competing plugins on a single slot via UI and restores default on 恢复默认 / 全部恢复默认接管", async () => {
    const { root, registry, overrides } = await createCoreSettingsHarness();
    registry.register("shell.sidebar", { id: "builtin-sb", pluginId: "core-sidebar", tier: "builtin", priority: 0, component: () => <div data-testid="live-sidebar-owner">core-sidebar-view</div> });
    registry.register("shell.sidebar", { id: "alpha-sb", pluginId: "ext-sidebar-alpha", tier: "user", priority: 10, component: () => <div data-testid="live-sidebar-owner">alpha-sidebar-view</div> });
    registry.register("shell.sidebar", { id: "beta-sb", pluginId: "ext-sidebar-beta", tier: "user", priority: 20, component: () => <div data-testid="live-sidebar-owner">beta-sidebar-view</div> });

    const { container } = await mountInDom(
      <SlotKernelProvider registry={registry} ctx={root}>
        <SlotHost slotKey="shell.sidebar" kind="single" scope="root" />
        <SlotHost slotKey="shell.modals" kind="list" scope="root" />
      </SlotKernelProvider>,
    );
    act(() => { root.navigationService.openSettings("slots"); });

    expect(container.querySelector("[data-testid='live-sidebar-owner']")?.textContent).toBe("beta-sidebar-view");
    expect(container.querySelector("[data-testid='slot-winner-shell.sidebar']")?.textContent).toBe("ext-sidebar-beta");
    expect(container.querySelector("[data-testid='slot-winner-tier-shell.sidebar']")?.textContent).toBe("user");

    clickElement(container.querySelector("[data-testid='slot-pin-shell.sidebar-ext-sidebar-alpha']"));
    expect(overrides.get("shell.sidebar")).toBe("ext-sidebar-alpha");
    expect(registry.inspectSlot("shell.sidebar").winner?.pluginId).toBe("ext-sidebar-alpha");
    expect(container.querySelector("[data-testid='live-sidebar-owner']")?.textContent).toBe("alpha-sidebar-view");

    setControlValue(container.querySelector("[data-testid='slot-override-select-shell.sidebar']"), "core-sidebar");
    expect(overrides.get("shell.sidebar")).toBe("core-sidebar");
    expect(container.querySelector("[data-testid='live-sidebar-owner']")?.textContent).toBe("core-sidebar-view");

    clickElement(container.querySelector("[data-testid='slot-clear-override-shell.sidebar']"));
    expect(overrides.get("shell.sidebar")).toBeUndefined();
    expect(registry.inspectSlot("shell.sidebar").winner?.pluginId).toBe("ext-sidebar-beta");
    expect(container.querySelector("[data-testid='live-sidebar-owner']")?.textContent).toBe("beta-sidebar-view");

    clickElement(container.querySelector("[data-testid='slot-pin-shell.sidebar-core-sidebar']"));
    act(() => { overrides.set("settings.shell", "core-settings"); });
    expect(Object.keys(overrides.getSnapshot()).length).toBe(2);
    clickElement(container.querySelector("[data-testid='slots-reset-all-overrides']"));
    expect(overrides.getSnapshot()).toEqual({});
  });

  it("displays abdication warning badge and error text cleanly for abdicated candidates", async () => {
    const { root, registry } = await createCoreSettingsHarness();
    registry.register("shell.topbar", { id: "builtin-tb", pluginId: "core-shell", tier: "builtin", priority: 0, component: () => <span>builtin</span> });
    registry.register("shell.topbar", { id: "broken-tb", pluginId: "broken-topbar-plugin", tier: "user", priority: 99, component: () => <span>broken</span> });
    registry.abdication.abdicate({
      slotKey: "shell.topbar",
      entryId: "broken-tb",
      pluginId: "broken-topbar-plugin",
      error: new Error("Topbar render exploded"),
      fallbackEntryId: "builtin-tb",
      fallbackPluginId: "core-shell",
    });

    const { container } = await mountInDom(
      <SlotKernelProvider registry={registry} ctx={root}>
        <SlotHost slotKey="shell.modals" kind="list" scope="root" />
      </SlotKernelProvider>,
    );
    act(() => { root.navigationService.openSettings("slots"); });

    expect(container.querySelector("[data-testid='slot-abdication-badge-shell.topbar']")?.textContent).toContain("异常退让");
    const detail = container.querySelector("[data-testid='slot-abdication-detail-shell.topbar']");
    expect(detail?.textContent).toContain("broken-topbar-plugin");
    expect(detail?.textContent).toContain("Topbar render exploded");
    expect(detail?.textContent).toContain("core-shell");
    expect(container.querySelector("[data-testid='slot-winner-shell.topbar']")?.textContent).toBe("core-shell");
  });

  it("narrows slot list accurately via search input and all four filter pills", async () => {
    const { root, registry } = await createCoreSettingsHarness();
    registry.register("shell.sidebar", { id: "u-sb", pluginId: "custom-sidebar-ext", tier: "user", priority: 10, component: () => null });
    registry.register("shell.topbar", { id: "c-tb", pluginId: "crash-topbar-ext", tier: "user", priority: 10, component: () => null });
    registry.abdication.abdicate({ slotKey: "shell.topbar", entryId: "c-tb", pluginId: "crash-topbar-ext", error: new Error("Crash in topbar") });

    const { container } = await mountInDom(
      <SlotKernelProvider registry={registry} ctx={root}>
        <SlotHost slotKey="shell.modals" kind="list" scope="root" />
      </SlotKernelProvider>,
    );
    act(() => { root.navigationService.openSettings("slots"); });

    const listRows = () => container.querySelectorAll("[data-slot-key]");
    expect(listRows().length).toBeGreaterThanOrEqual(Object.keys(CORE_SLOT_SPECS).length);

    clickElement(container.querySelector("[data-testid='slots-filter-takeover']"));
    const takeoverRows = listRows();
    expect(takeoverRows.length).toBeGreaterThan(0);
    for (const row of takeoverRows) {
      const kind = row.getAttribute("data-slot-kind");
      expect(kind === "single" || kind === "chain").toBe(true);
    }

    clickElement(container.querySelector("[data-testid='slots-filter-external']"));
    expect(listRows().map((r) => r.getAttribute("data-slot-key"))).toEqual(["shell.sidebar"]);

    clickElement(container.querySelector("[data-testid='slots-filter-abdicated']"));
    expect(listRows().map((r) => r.getAttribute("data-slot-key"))).toEqual(["shell.topbar"]);

    clickElement(container.querySelector("[data-testid='slots-filter-all']"));
    setControlValue(container.querySelector("[data-testid='slots-search-input']"), "custom-sidebar-ext");
    expect(listRows().map((r) => r.getAttribute("data-slot-key"))).toEqual(["shell.sidebar"]);

    setControlValue(container.querySelector("[data-testid='slots-search-input']"), "composer.main");
    expect(listRows().map((r) => r.getAttribute("data-slot-key"))).toEqual(["composer.main"]);

    setControlValue(container.querySelector("[data-testid='slots-search-input']"), "底部集成终端");
    expect(listRows().map((r) => r.getAttribute("data-slot-key"))).toEqual(["shell.workbench.bottom"]);

    setControlValue(container.querySelector("[data-testid='slots-search-input']"), "nonexistent-slot-xyz");
    expect(container.querySelector("[data-testid='slots-empty-state']")).not.toBeNull();
    clickElement(container.querySelector("[data-testid='slots-reset-filters']"));
    expect(listRows().length).toBeGreaterThanOrEqual(Object.keys(CORE_SLOT_SPECS).length);
  });

  it("supports plugins->slots shortcut section, Safe Mode exit toggle, and Escape/backdrop closing", async () => {
    const { root, registry } = await createCoreSettingsHarness();
    const safeModeCtrl = createSafeModeController({ windowLike: null, storage: createMemoryStorage() });
    safeModeCtrl.enable("hotkey");

    const { container, win } = await mountInDom(
      <SlotKernelProvider registry={registry} ctx={root}>
        <SlotHost slotKey="shell.modals" kind="list" scope="root" />
        <SlotOwnershipPanel registry={registry} ctx={root} safeModeControl={safeModeCtrl} />
      </SlotKernelProvider>,
    );

    expect(container.querySelector("[data-testid='slots-safe-mode-banner']")?.textContent).toContain("安全模式已启用");
    clickElement(container.querySelector("[data-testid='slots-exit-safe-mode']"));
    expect(safeModeCtrl.isEnabled()).toBe(false);
    expect(container.querySelector("[data-testid='slots-safe-mode-banner']")).toBeNull();

    act(() => { root.navigationService.openSettings("plugins"); });
    expect(container.querySelector("[data-testid='settings-page-plugins']")).not.toBeNull();
    expect(container.querySelector("[data-testid='plugins-slots-shortcut-section']")).not.toBeNull();

    clickElement(container.querySelector("[data-testid='plugins-open-slots-btn']"));
    const settingsShell = container.querySelector("[data-testid='core-settings-shell']");
    expect(settingsShell?.querySelector("[data-active-settings-page='slots']")).not.toBeNull();

    clickElement(container.querySelector("[data-testid='settings-nav-general']"));
    expect(container.querySelector("[data-testid='settings-page-general']")).not.toBeNull();
    clickElement(container.querySelector("[data-testid='settings-nav-appearance']"));
    expect(container.querySelector("[data-testid='settings-page-appearance']")).not.toBeNull();
    clickElement(container.querySelector("[data-testid='settings-nav-providers']"));
    expect(container.querySelector("[data-testid='settings-page-providers']")).not.toBeNull();

    act(() => { win.dispatchEvent(new MiniEvent("keydown", { key: "Escape", bubbles: true, cancelable: true })); });
    expect(root.navigationService.getSnapshot().settingsOpen).toBe(false);
    expect(container.querySelector("[data-testid='core-settings-shell']")).toBeNull();

    act(() => { root.navigationService.openSettings("general"); });
    act(() => { container.querySelector("[data-testid='core-settings-backdrop']")?.dispatchEvent(new MiniEvent("mousedown", { bubbles: true, cancelable: true })); });
    expect(root.navigationService.getSnapshot().settingsOpen).toBe(false);
  });

  it("loads and toggles plugins via Host RPC plugin.list, plugin.disable, plugin.enable, and plugin/changed", async () => {
    const calls: Array<{ readonly method: string; readonly params?: Record<string, unknown> }> = [];
    const notifListeners = new Map<string, Set<(params: unknown) => void>>();
    let pluginEnabled = true;
    const makePlugin = (): PluginInfo => ({
      id: "demo-ext", name: "Demo Extension", version: "1.0.0", description: "demo",
      tier: "user", status: pluginEnabled ? "active" : "disabled", enabled: pluginEnabled,
      canDisable: true, overridesBuiltin: false, removable: true, hasHost: true, hasClient: true, watch: false,
    });
    const mockTransport: RpcTransport = {
      async call<T>(method: string, params?: Record<string, unknown>): Promise<T> {
        calls.push({ method, ...(params === undefined ? {} : { params }) });
        if (method === "plugin.list") return { plugins: [makePlugin()] } as T;
        if (method === "plugin.disable") { pluginEnabled = false; return { ok: true, plugins: [makePlugin()] } as T; }
        if (method === "plugin.enable") { pluginEnabled = true; return { ok: true, plugins: [makePlugin()] } as T; }
        throw new Error(`Unexpected RPC method: ${method}`);
      },
      onNotification: (method, listener) => {
        const set = notifListeners.get(method) ?? new Set();
        set.add(listener);
        notifListeners.set(method, set);
        return () => { set.delete(listener); };
      },
      onHostStatus: () => () => undefined,
      reconnectNow: () => undefined,
    };

    const { root, registry } = await createCoreSettingsHarness(mockTransport);
    const { container } = await mountInDom(
      <SlotKernelProvider registry={registry} ctx={root}>
        <SlotHost slotKey="shell.modals" kind="list" scope="root" />
      </SlotKernelProvider>,
    );
    await act(async () => { root.navigationService.openSettings("plugins"); await Promise.resolve(); });

    expect(calls[0]?.method).toBe("plugin.list");
    expect(notifListeners.get("plugin/changed")?.size).toBe(1);
    expect(container.querySelector("[data-testid='settings-plugin-row-demo-ext']")?.textContent).toContain("Demo Extension");

    const listCallsBefore = calls.filter((c) => c.method === "plugin.list").length;
    await act(async () => {
      for (const fn of notifListeners.get("plugin/changed") ?? []) fn({ reason: "reload" });
      await Promise.resolve();
    });
    expect(calls.filter((c) => c.method === "plugin.list").length).toBeGreaterThan(listCallsBefore);

    const toggleSwitch = async () => {
      await act(async () => {
        container.querySelector("[data-testid='settings-plugin-toggle-demo-ext']")?.dispatchEvent(new MiniEvent("click", { bubbles: true, cancelable: true }));
        await Promise.resolve();
        await Promise.resolve();
      });
    };
    await toggleSwitch();
    expect(calls.some((c) => c.method === "plugin.disable" && c.params?.id === "demo-ext")).toBe(true);
    expect(pluginEnabled).toBe(false);

    await toggleSwitch();
    expect(calls.some((c) => c.method === "plugin.enable" && c.params?.id === "demo-ext")).toBe(true);
    expect(pluginEnabled).toBe(true);
  });
});

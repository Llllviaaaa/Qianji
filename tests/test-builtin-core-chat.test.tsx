/**
 * Integration tests for ADR 0023 Wave 2B built-in chat plugins:
 * - `core-conversation` (`src/builtin-plugins/core-conversation/`)
 * - `core-composer` (`src/builtin-plugins/core-composer/`)
 *
 * Verifies:
 * 1. Full default conversation + composer slot tree rendering under real
 *    `SlotRegistry` + `registerFrontendServices` + `installSessionScopeAdapter`
 *    + `<SessionArea>`.
 * 2. Higher-priority plugin taking over `composer.main` with `overlay: true`
 *    hides default composer via `display: none` (`data-qj-chain-hidden="true"`)
 *    without unmounting and preserves typed draft text when takeover ends.
 * 3. Throwing external plugins taking over `composer.main` or
 *    `conversation.message` abdicate automatically back to the built-in core
 *    plugins.
 * 4. Two concurrent `<SessionArea>` instances with different `sessionId`s
 *    receive isolated `SessionStandardProps`, messages, and composer drafts.
 */
import { act, createElement, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Context } from "@deepseek-ai/cordis";
import type { UiMessage } from "@qianji/client";
import type { ExtensionUIRequest } from "../src/types";
import {
  ClientSlotsService,
  SessionArea,
  SlotFactoryHost,
  SlotHost,
  SlotKernelProvider,
  SlotRegistry,
  type SessionStandardProps,
} from "@qianji/client-slots";
import {
  CORE_COMPOSER_PLUGIN_ID,
  coreComposerPlugin,
} from "../src/builtin-plugins/core-composer";
import {
  CONVERSATION_SURFACE_FACTORY_KEY,
  CORE_CONVERSATION_PLUGIN_ID,
  coreConversationPlugin,
  SessionConversationSurface,
} from "../src/builtin-plugins/core-conversation";
import {
  installSessionScopeAdapter,
  registerFrontendServices,
} from "../src/kernel/services";
import { registerHostComponentFactories } from "../src/kernel/primitives/hostComponentFactories";
import { ClientContributionRegistry } from "../src/lib/clientContributions";
import { bindClientRootContext } from "../src/sdk/rootContext";
import { useAppStore } from "../src/store";

/* ── Minimal interactive DOM harness supporting React 19 createRoot + textarea onChange ── */

interface ListenerEntry {
  readonly fn: (event: MiniEvent) => void;
  readonly capture: boolean;
}

class MiniEvent {
  readonly type: string;
  readonly bubbles: boolean;
  readonly cancelable: boolean;
  readonly key: string;
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

  dispatchEvent(event: MiniEvent): boolean {
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

class MiniElement extends MiniNode {
  readonly tagName: string;
  readonly attributes = new Map<string, string>();
  readonly style: Record<string, unknown> = {
    setProperty: () => undefined,
    removeProperty: () => undefined,
  };
  readonly dataset: Record<string, string> = {};
  scrollHeight = 20;
  clientHeight = 20;
  scrollTop = 0;
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

  focus(): void {
    if (this.ownerDocument !== null) this.ownerDocument.activeElement = this;
  }

  closest(_selector: string): MiniElement | null {
    return null;
  }

  getBoundingClientRect(): { top: number; bottom: number; left: number; right: number; width: number; height: number } {
    return { top: 0, bottom: 20, left: 0, right: 200, width: 200, height: 20 };
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

class MiniWindow extends MiniEventTarget {
  readonly navigator = { userAgent: "node" };
  readonly HTMLIFrameElement = MiniIframeElement;
  readonly HTMLTextAreaElement = MiniTextareaElement;
  readonly HTMLInputElement = MiniInputElement;
  readonly HTMLElement = MiniElement;
  readonly Element = MiniElement;
  readonly Node = MiniNode;
  readonly Event = MiniEvent;
  private readonly activeIntervals = new Set<ReturnType<typeof setInterval>>();
  setTimeout = globalThis.setTimeout.bind(globalThis);
  clearTimeout = globalThis.clearTimeout.bind(globalThis);
  setInterval = (cb: () => void, ms?: number): ReturnType<typeof setInterval> => {
    const id = globalThis.setInterval(cb, ms);
    this.activeIntervals.add(id);
    return id;
  };
  clearInterval = (id: ReturnType<typeof setInterval>): void => {
    this.activeIntervals.delete(id);
    globalThis.clearInterval(id);
  };
  clearAllIntervals(): void {
    for (const id of this.activeIntervals) globalThis.clearInterval(id);
    this.activeIntervals.clear();
  }
  matchMedia = () => ({
    matches: true,
    media: "",
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    addListener: () => undefined,
    removeListener: () => undefined,
  });
  getComputedStyle = () => ({ lineHeight: "22px", fontSize: "14px" });
  requestAnimationFrame = (cb: () => void) => {
    cb();
    return 1;
  };
  cancelAnimationFrame = () => undefined;
}

class MiniDocument extends MiniNode {
  readonly documentElement: MiniElement;
  readonly body: MiniElement;
  readonly defaultView = new MiniWindow();
  activeElement: MiniElement | null = null;

  constructor() {
    super(9, "#document", null);
    this.documentElement = new MiniElement("html", this);
    this.body = new MiniElement("body", this);
    this.documentElement.appendChild(this.body);
    this.appendChild(this.documentElement);
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

const activeCleanups: Array<() => void> = [];

function mountDom(node: ReactNode): {
  container: MiniElement;
  rerender: (next: ReactNode) => void;
  unmount: () => void;
} {
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
    "IS_REACT_ACT_ENVIRONMENT",
  ] as const;
  const saved: Record<string, unknown> = {};
  for (const key of keys) saved[key] = g[key];

  const doc = new MiniDocument();
  const container = doc.createElement("div");
  doc.body.appendChild(container);
  Object.assign(g, {
    window: doc.defaultView,
    document: doc,
    Node: MiniNode,
    Element: MiniElement,
    HTMLElement: MiniElement,
    HTMLIFrameElement: MiniIframeElement,
    HTMLTextAreaElement: MiniTextareaElement,
    HTMLInputElement: MiniInputElement,
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
    doc.defaultView.clearAllIntervals();
    act(() => {
      root?.unmount();
    });
    for (const key of keys) {
      if (saved[key] === undefined) delete g[key];
      else g[key] = saved[key];
    }
  };
  activeCleanups.push(unmount);

  return {
    container,
    rerender(next: ReactNode) {
      act(() => {
        root?.render(next);
      });
    },
    unmount,
  };
}

function setTextareaValue(textarea: MiniElement, nextValue: string): void {
  const desc = Object.getOwnPropertyDescriptor(MiniTextareaElement.prototype, "value");
  act(() => {
    textarea.focus();
    textarea.dispatchEvent(new MiniEvent("focusin", { bubbles: true }));
    desc?.set?.call(textarea, nextValue);
    textarea.dispatchEvent(new MiniEvent("input", { bubbles: true }));
    textarea.dispatchEvent(new MiniEvent("keyup", { bubbles: true }));
  });
}

async function bootCoreChatKernel(): Promise<{
  root: Context;
  registry: SlotRegistry;
  contributions: ClientContributionRegistry;
  dispose: () => Promise<void>;
}> {
  const root = new Context();
  const registry = new SlotRegistry();
  const contributions = new ClientContributionRegistry();

  await root.plugin(ClientSlotsService, registry);
  await registerFrontendServices(root, {
    contributionRegistry: contributions,
    shortcutTarget: null,
  });
  const disposeAdapter = installSessionScopeAdapter(root);
  bindClientRootContext(root);

  await root.plugin(coreConversationPlugin);
  await root.plugin(coreComposerPlugin);

  return {
    root,
    registry,
    contributions,
    async dispose() {
      disposeAdapter();
      bindClientRootContext(undefined);
      registry.dispose();
    },
  };
}

describe("ADR 0023 Wave 2B: core-conversation & core-composer built-in plugins", () => {
  beforeEach(() => {
    useAppStore.setState({
      cwd: "/repo/core-chat",
      sessionId: "sess-main-1",
      sessionFile: "harness:sess-main-1",
      messages: [],
      isStreaming: false,
      isCompacting: false,
      retryStatus: null,
      extensionRequest: null,
      extensionWidgets: {},
      composerPrefill: null,
      git: null,
    });
  });

  afterEach(() => {
    while (activeCleanups.length > 0) {
      activeCleanups.pop()?.();
    }
    bindClientRootContext(undefined);
    vi.restoreAllMocks();
  });

  it("renders default conversation stage, transcript, approval dialog, and composer cleanly via slots", async () => {
    const messages: UiMessage[] = [
      {
        id: "u1",
        entryId: "e1",
        role: "user",
        content: "Explain the microkernel architecture",
        timestamp: 1700000000000,
      },
      {
        id: "a1",
        entryId: "e2",
        role: "assistant",
        thinking: "Checking ADR 0023 core slot tree",
        content: "Here is the overview:\n```ts\nconst ok = true;\n```",
        toolCalls: [
          {
            id: "tc1",
            name: "read_file",
            args: { path: "docs/adr/0023.md" },
            result: "# ADR 0023",
            running: false,
          },
        ],
        durationMs: 2500,
        timestamp: 1700000005000,
      },
    ];
    const approvalReq: ExtensionUIRequest = {
      type: "extension_ui_request",
      id: "req-1",
      method: "confirm",
      title: "允许执行测试命令？",
      message: "将运行 npm test",
    };

    useAppStore.setState({
      messages,
      extensionRequest: approvalReq,
    });

    const env = await bootCoreChatKernel();
    const mounted = mountDom(
      createElement(
        SlotKernelProvider,
        { registry: env.registry, ctx: env.root },
        createElement(SlotHost, {
          slotKey: "shell.stage",
          kind: "chain",
          scope: "session-maybe",
          props: { cwd: "/repo/core-chat", sessionFile: "harness:sess-main-1", hubView: null, draftMode: false },
          registry: env.registry,
          rootCtx: env.root,
        }),
      ),
    );

    const text = mounted.container.textContent;
    expect(text).toContain("Explain the microkernel architecture");
    expect(text).toContain("Here is the overview:");
    expect(text).toContain("const ok = true;");
    expect(text).toContain("read_file");
    expect(text).toContain("允许执行测试命令？");

    const textarea = mounted.container.findOne((el) => el.getAttribute("data-testid") === "composer-textarea");
    expect(textarea).toBeDefined();
    expect(textarea?.getAttribute("class")).toContain("composer-input");

    // Verify shell.stage declines when hubView or draftMode is active
    mounted.rerender(
      createElement(
        SlotKernelProvider,
        { registry: env.registry, ctx: env.root },
        createElement(SlotHost, {
          slotKey: "shell.stage",
          kind: "chain",
          scope: "session-maybe",
          props: { cwd: "/repo/core-chat", hubView: "plugins", draftMode: false },
          fallback: createElement("div", null, "hub-takes-over"),
          registry: env.registry,
          rootCtx: env.root,
        }),
      ),
    );
    expect(mounted.container.textContent).toBe("hub-takes-over");

    mounted.unmount();
    await env.dispose();
  });

  it("preserves typed composer draft under display:none during higher-priority overlay:true takeover on composer.main", async () => {
    const env = await bootCoreChatKernel();

    const disposeOverlay = env.registry.register("composer.main", {
      id: "approval-bar-overlay",
      pluginId: "approval-overlay-plugin",
      tier: "user",
      priority: 50,
      overlay: true,
      select: (ownerProps) => (ownerProps.pendingApproval === true ? { prompt: "请先审批当前工具调用" } : null),
      component: ({ selected }) =>
        createElement(
          "div",
          { className: "approval-overlay-bar", "data-testid": "composer-overlay-takeover" },
          String((selected as { prompt: string }).prompt),
        ),
    });

    const renderStage = () =>
      createElement(
        SlotKernelProvider,
        { registry: env.registry, ctx: env.root },
        createElement(SlotHost, {
          slotKey: "shell.stage",
          kind: "chain",
          scope: "session-maybe",
          props: { cwd: "/repo/core-chat", sessionFile: "harness:sess-main-1", hubView: null, draftMode: false },
          registry: env.registry,
          rootCtx: env.root,
        }),
      );

    const mounted = mountDom(renderStage());

    const textareaBefore = mounted.container.findOne(
      (el) => el.getAttribute("data-testid") === "composer-textarea",
    ) as MiniTextareaElement | undefined;
    expect(textareaBefore).toBeDefined();

    // User types draft text into default core-composer textarea
    if (textareaBefore !== undefined) {
      setTextareaValue(textareaBefore, "draft must survive overlay takeover");
    }
    expect(textareaBefore?.value).toBe("draft must survive overlay takeover");
    expect(env.root.get("composerService")?.getDraft("sess-main-1")).toBe("draft must survive overlay takeover");

    // Trigger pendingApproval so higher-priority overlay:true entry takes over composer.main
    act(() => {
      useAppStore.setState({
        extensionRequest: {
          type: "extension_ui_request",
          id: "req-overlay-1",
          method: "confirm",
          title: "确认写入文件",
          message: "写入 src/index.ts",
        },
      });
    });

    const overlayEl = mounted.container.findOne(
      (el) => el.getAttribute("data-testid") === "composer-overlay-takeover",
    );
    expect(overlayEl).toBeDefined();
    expect(overlayEl?.textContent).toContain("请先审批当前工具调用");

    // Default composer chain wrapper MUST stay mounted and hidden via display: none
    const hiddenWrapper = mounted.container.findOne(
      (el) => el.getAttribute("data-qj-chain-entry") === `${CORE_COMPOSER_PLUGIN_ID}:main`,
    );
    expect(hiddenWrapper).toBeDefined();
    expect(hiddenWrapper?.getAttribute("data-qj-chain-hidden")).toBe("true");
    expect(hiddenWrapper?.style.display).toBe("none");

    const textareaDuringOverlay = mounted.container.findOne(
      (el) => el.getAttribute("data-testid") === "composer-textarea",
    ) as MiniTextareaElement | undefined;
    expect(textareaDuringOverlay).toBe(textareaBefore);
    expect(textareaDuringOverlay?.value).toBe("draft must survive overlay takeover");

    // End takeover and confirm the EXACT same textarea node is visible again with draft intact
    act(() => {
      useAppStore.setState({ extensionRequest: null });
    });

    expect(
      mounted.container.findOne((el) => el.getAttribute("data-testid") === "composer-overlay-takeover"),
    ).toBeUndefined();

    const restoredWrapper = mounted.container.findOne(
      (el) => el.getAttribute("data-qj-chain-entry") === `${CORE_COMPOSER_PLUGIN_ID}:main`,
    );
    expect(restoredWrapper?.getAttribute("data-qj-chain-hidden")).toBeNull();
    expect(restoredWrapper?.style.display).toBe("contents");

    const textareaAfter = mounted.container.findOne(
      (el) => el.getAttribute("data-testid") === "composer-textarea",
    ) as MiniTextareaElement | undefined;
    expect(textareaAfter).toBe(textareaBefore);
    expect(textareaAfter?.value).toBe("draft must survive overlay takeover");
    expect(env.root.get("composerService")?.getDraft("sess-main-1")).toBe("draft must survive overlay takeover");

    mounted.unmount();
    disposeOverlay();
    await env.dispose();
  });

  it("abdicates automatically back to built-in core plugins when external overrides throw on composer.main or conversation.message", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);

    useAppStore.setState({
      messages: [
        {
          id: "u-abd-1",
          role: "user",
          content: "Fallback message content stays visible",
          timestamp: 1700000010000,
        },
      ],
    });

    const env = await bootCoreChatKernel();

    const disposeBadComposer = env.registry.register("composer.main", {
      id: "rogue-composer-override",
      pluginId: "rogue-composer-plugin",
      tier: "user",
      priority: 100,
      select: () => true,
      component: () => {
        throw new Error("boom in external composer");
      },
    });

    const disposeBadMessage = env.registry.register("conversation.message", {
      id: "rogue-message-override",
      pluginId: "rogue-message-plugin",
      tier: "user",
      priority: 100,
      select: () => true,
      component: () => {
        throw new Error("boom in external message renderer");
      },
    });

    const mounted = mountDom(
      createElement(
        SlotKernelProvider,
        { registry: env.registry, ctx: env.root },
        createElement(SlotHost, {
          slotKey: "shell.stage",
          kind: "chain",
          scope: "session-maybe",
          props: { cwd: "/repo/core-chat", sessionFile: "harness:sess-main-1", hubView: null, draftMode: false },
          registry: env.registry,
          rootCtx: env.root,
        }),
      ),
    );

    // Both throwing user overrides must be abdicated and built-in fallbacks rendered!
    expect(
      env.registry.abdication.isAbdicated("composer.main", "rogue-composer-override", "rogue-composer-plugin"),
    ).toBe(true);
    expect(
      env.registry.abdication.isAbdicated("conversation.message", "rogue-message-override", "rogue-message-plugin"),
    ).toBe(true);

    expect(mounted.container.textContent).toContain("Fallback message content stays visible");
    const fallbackComposer = mounted.container.findOne(
      (el) => el.getAttribute("data-testid") === "core-composer",
    );
    expect(fallbackComposer).toBeDefined();

    const messageWrapper = mounted.container.findOne(
      (el) =>
        el.getAttribute("data-qj-slot") === "conversation.message" &&
        el.getAttribute("data-qj-plugin") === CORE_CONVERSATION_PLUGIN_ID,
    );
    expect(messageWrapper).toBeDefined();

    mounted.unmount();
    disposeBadComposer();
    disposeBadMessage();
    await env.dispose();
  });

  it("isolates SessionStandardProps, transcripts, and composer drafts across two concurrent <SessionArea> instances", async () => {
    useAppStore.setState({
      sessionId: "sess-alpha",
      sessionFile: "harness:sess-alpha",
      messages: [
        {
          id: "alpha-m1",
          role: "user",
          content: "Only in session alpha",
          timestamp: 1700000020000,
        },
      ],
    });

    const env = await bootCoreChatKernel();
    const observedScopes = new Map<string, SessionStandardProps["scope"]>();

    const disposeProbe = env.registry.register("conversation.header", {
      id: "scope-probe-header",
      pluginId: "scope-probe",
      tier: "user",
      order: 1,
      component: ({ scope, sessionId }) => {
        observedScopes.set(sessionId, scope);
        return createElement(
          "div",
          { "data-testid": `probe-${sessionId}` },
          `scope:${scope.scope}:${scope.sessionId}:${scope.scopeKey}`,
        );
      },
    });

    // Retain isolated beta session with distinct initial messages before rendering
    const sessionSvc = env.root.get("sessionService");
    const betaSeedHandle = sessionSvc?.retain("sess-beta", {
      isolated: true,
      cwd: "/repo/beta",
      initialMessages: [
        {
          id: "beta-m1",
          role: "user",
          content: "Only in session beta",
          timestamp: 1700000030000,
        },
      ],
    });

    // Mount two concurrent SessionAreas: one via <SessionConversationSurface>, one via SlotFactoryHost("conversation.surface")
    const mounted = mountDom(
      createElement(
        SlotKernelProvider,
        { registry: env.registry, ctx: env.root },
        createElement(
          "div",
          { className: "dual-sessions" },
          createElement(SessionConversationSurface, {
            sessionId: "sess-alpha",
            cwd: "/repo/alpha",
            showHeader: true,
            isolated: false,
          }),
          createElement(
            SessionArea,
            { sessionId: "sess-beta" },
            createElement(SlotFactoryHost, {
              factoryKey: CONVERSATION_SURFACE_FACTORY_KEY,
              occurrenceKey: "beta-pane",
              props: {
                cwd: "/repo/beta",
                showHeader: true,
                isolated: true,
                compact: true,
              },
              registry: env.registry,
              rootCtx: env.root,
            }),
          ),
        ),
      ),
    );

    expect(observedScopes.get("sess-alpha")).toEqual({
      scope: "session",
      sessionId: "sess-alpha",
      scopeKey: "session:sess-alpha",
    });
    expect(observedScopes.get("sess-beta")).toEqual({
      scope: "session",
      sessionId: "sess-beta",
      scopeKey: "session:sess-beta",
    });

    const alphaSurface = mounted.container.findOne(
      (el) => el.getAttribute("data-session-surface") === "sess-alpha",
    );
    const betaSurface = mounted.container.findOne(
      (el) => el.getAttribute("data-session-surface") === "sess-beta",
    );
    expect(alphaSurface).toBeDefined();
    expect(betaSurface).toBeDefined();

    // Transcripts are strictly isolated per sessionId
    expect(alphaSurface?.textContent).toContain("Only in session alpha");
    expect(alphaSurface?.textContent).not.toContain("Only in session beta");
    expect(betaSurface?.textContent).toContain("Only in session beta");
    expect(betaSurface?.textContent).not.toContain("Only in session alpha");

    // Composer inputs under each <SessionArea> have isolated draft buckets
    const alphaTextarea = alphaSurface?.findOne(
      (el) => el.getAttribute("data-testid") === "composer-textarea",
    ) as MiniTextareaElement | undefined;
    const betaTextarea = betaSurface?.findOne(
      (el) => el.getAttribute("data-testid") === "composer-textarea",
    ) as MiniTextareaElement | undefined;
    expect(alphaTextarea).toBeDefined();
    expect(betaTextarea).toBeDefined();
    expect(alphaTextarea).not.toBe(betaTextarea);

    if (alphaTextarea !== undefined) setTextareaValue(alphaTextarea, "alpha draft");
    if (betaTextarea !== undefined) setTextareaValue(betaTextarea, "beta draft");

    expect(alphaTextarea?.value).toBe("alpha draft");
    expect(betaTextarea?.value).toBe("beta draft");
    expect(env.root.get("composerService")?.getDraft("sess-alpha")).toBe("alpha draft");
    expect(env.root.get("composerService")?.getDraft("sess-beta")).toBe("beta draft");

    mounted.unmount();
    disposeProbe();
    betaSeedHandle?.release();
    await env.dispose();
  });

  it("routes keyed conversation.toolCall, conversation.markdown.codeBlock, and composer child slots to external plugins and cleans up on Fiber disposal", async () => {
    useAppStore.setState({
      messages: [
        {
          id: "u-ext-1",
          role: "user",
          content: "Show diagram and sqlite query",
          timestamp: 1700000040000,
        },
        {
          id: "a-ext-1",
          role: "assistant",
          content: "Chart:\n```mermaid\ngraph TD; A-->B;\n```",
          toolCalls: [
            {
              id: "tc-sql",
              name: "sqlite_query",
              args: { sql: "SELECT 1" },
              result: "1",
              running: false,
            },
          ],
          timestamp: 1700000045000,
        },
      ],
    });

    const env = await bootCoreChatKernel();

    const extFiber = await env.root.plugin({
      name: "ext-chat-enhancer",
      inject: ["slots"],
      apply(ctx: Context) {
        ctx.slots.register("conversation.toolCall", {
          id: "ext-sqlite-card",
          pluginId: "ext-chat-enhancer",
          tier: "user",
          key: ["sqlite_*"],
          component: ({ call, sessionId }) =>
            createElement("div", { "data-testid": "ext-sqlite" }, `SQLiteCard:${call.name}@${sessionId}`),
        });
        ctx.slots.register("conversation.markdown.codeBlock", {
          id: "ext-mermaid-block",
          pluginId: "ext-chat-enhancer",
          tier: "user",
          key: ["mermaid"],
          component: ({ language, code, sessionId }) =>
            createElement("div", { "data-testid": "ext-mermaid" }, `Mermaid:${language}:${code.trim()}@${sessionId}`),
        });
        ctx.slots.register("conversation.message.actions", {
          id: "ext-msg-action",
          pluginId: "ext-chat-enhancer",
          tier: "user",
          order: 5,
          component: ({ message }) =>
            createElement("button", { type: "button" }, `Pin:${message.id}`),
        });
        ctx.slots.register("composer.banners", {
          id: "ext-composer-banner",
          pluginId: "ext-chat-enhancer",
          tier: "user",
          order: 5,
          component: () => createElement("div", { "data-testid": "ext-banner" }, "CustomBanner"),
        });
        ctx.slots.register("composer.toolbar", {
          id: "ext-composer-tool",
          pluginId: "ext-chat-enhancer",
          tier: "user",
          order: 5,
          component: () => createElement("button", { type: "button" }, "CustomToolBtn"),
        });
        ctx.slots.register("composer.status", {
          id: "ext-composer-status",
          pluginId: "ext-chat-enhancer",
          tier: "user",
          order: 5,
          component: ({ position }) =>
            position === "after-model" ? createElement("span", null, "CustomStatusChip") : null,
        });
      },
    });

    const mounted = mountDom(
      createElement(
        SlotKernelProvider,
        { registry: env.registry, ctx: env.root },
        createElement(SlotHost, {
          slotKey: "shell.stage",
          kind: "chain",
          scope: "session-maybe",
          props: { cwd: "/repo/core-chat", sessionFile: "harness:sess-main-1", hubView: null, draftMode: false },
          registry: env.registry,
          rootCtx: env.root,
        }),
      ),
    );

    const text = mounted.container.textContent;
    expect(text).toContain("SQLiteCard:sqlite_query@sess-main-1");
    expect(text).toContain("Mermaid:mermaid:graph TD; A-->B;@sess-main-1");
    expect(text).toContain("Pin:u-ext-1");
    expect(text).toContain("Pin:a-ext-1");
    expect(text).toContain("CustomBanner");
    expect(text).toContain("CustomToolBtn");
    expect(text).toContain("CustomStatusChip");

    // Unmounting external plugin Fiber restores built-in defaults cleanly
    await act(async () => {
      await extFiber.dispose();
    });
    const afterDispose = mounted.container.textContent;
    expect(afterDispose).not.toContain("SQLiteCard:");
    expect(afterDispose).not.toContain("Mermaid:");
    expect(afterDispose).not.toContain("CustomBanner");
    expect(afterDispose).toContain("sqlite_query");
    expect(afterDispose).toContain("graph TD; A-->B;");

    mounted.unmount();
    await env.dispose();
  });

  it("preserves streamingBehavior ('followUp' and 'steer') when submitting from CoreComposerDock while streaming", async () => {
    const origSendMessage = useAppStore.getState().sendMessage;
    const sendSpy = vi.fn(async () => true);
    useAppStore.setState({
      isStreaming: true,
      sendMessage: sendSpy,
    });

    const env = await bootCoreChatKernel();
    try {
      const mounted = mountDom(
        createElement(
          SlotKernelProvider,
          { registry: env.registry, ctx: env.root },
          createElement(SlotHost, {
            slotKey: "shell.stage",
            kind: "chain",
            scope: "session-maybe",
            props: {
              cwd: "/repo/core-chat",
              sessionFile: "harness:sess-main-1",
              hubView: null,
              draftMode: false,
            },
            registry: env.registry,
            rootCtx: env.root,
          }),
        ),
      );

      const textarea = mounted.container.findOne(
        (el) => el.getAttribute("data-testid") === "composer-textarea",
      ) as MiniTextareaElement | undefined;
      expect(textarea).toBeDefined();

      // Open streaming behavior menu and select "排队到下一轮" ("followUp")
      const behaviorBtn = mounted.container.findOne((el) =>
        (el.getAttribute("aria-label") ?? "").startsWith("运行中发送："),
      );
      expect(behaviorBtn).toBeDefined();
      act(() => {
        behaviorBtn?.dispatchEvent(new MiniEvent("click", { bubbles: true }));
      });

      const followUpOption = mounted.container.findOne(
        (el) => el.getAttribute("role") === "menuitemradio" && el.textContent.includes("排队到下一轮"),
      );
      expect(followUpOption).toBeDefined();
      act(() => {
        followUpOption?.dispatchEvent(new MiniEvent("click", { bubbles: true }));
      });

      if (textarea !== undefined) {
        setTextareaValue(textarea, "queue this follow-up while streaming");
        await act(async () => {
          textarea.dispatchEvent(new MiniEvent("keydown", { bubbles: true, key: "Enter" }));
        });
      }

      expect(sendSpy).toHaveBeenCalledTimes(1);
      expect(sendSpy).toHaveBeenCalledWith("queue this follow-up while streaming", [], "followUp");

      // Switch back to "调整当前任务" ("steer") and verify "steer" is passed too
      act(() => {
        behaviorBtn?.dispatchEvent(new MiniEvent("click", { bubbles: true }));
      });
      const steerOption = mounted.container.findOne(
        (el) => el.getAttribute("role") === "menuitemradio" && el.textContent.includes("调整当前任务"),
      );
      expect(steerOption).toBeDefined();
      act(() => {
        steerOption?.dispatchEvent(new MiniEvent("click", { bubbles: true }));
      });

      if (textarea !== undefined) {
        setTextareaValue(textarea, "steer mid-turn");
        await act(async () => {
          textarea.dispatchEvent(new MiniEvent("keydown", { bubbles: true, key: "Enter" }));
        });
      }

      expect(sendSpy).toHaveBeenCalledTimes(2);
      expect(sendSpy).toHaveBeenNthCalledWith(2, "steer mid-turn", [], "steer");

      mounted.unmount();
    } finally {
      useAppStore.setState({ sendMessage: origSendMessage, isStreaming: false });
      await env.dispose();
    }
  });

  it("merges multi-step assistant turns into one unified turn with production ProcessGroup, ToolCall, CodeFence, and live slot overrides", async () => {
    const multiStepMessages: UiMessage[] = [
      {
        id: "u-multi",
        entryId: "e-multi-u",
        role: "user",
        content: "帮我看看 Magpie 是怎么接入插件的",
        timestamp: 1700001000000,
      },
      {
        id: "a-step-1",
        role: "assistant",
        thinking: "先定位 Magpie 源码目录和插件接口",
        content: "我先摸清 Magpie 里 Pi / OMP 是怎么接入的。",
        toolCalls: [
          { id: "tc-r1", name: "read", args: { path: "src/plugins.ts" }, result: "export {}", running: false },
          { id: "tc-g1", name: "grep", args: { pattern: "registerPlugin" }, result: "src/plugins.ts:1", running: false },
        ],
        timestamp: 1700001002000,
      },
      {
        id: "a-step-2",
        role: "assistant",
        content: "",
        toolCalls: [
          { id: "tc-b1", name: "bash", args: { command: "ls -la" }, result: "package.json", running: false },
          { id: "tc-r2", name: "read", args: { path: "package.json" }, result: "{}", running: false },
        ],
        timestamp: 1700001005000,
      },
      {
        id: "a-step-3",
        role: "assistant",
        content: "Magpie 源码和本地配置都在，我接着核对插件协议。",
        toolCalls: [
          { id: "tc-s1", name: "sqlite_query", args: { sql: "SELECT 1" }, result: "1", running: false },
        ],
        timestamp: 1700001008000,
      },
      {
        id: "a-final",
        role: "assistant",
        content: "已经梳理完成：\n```ts\nexport const adapter = true;\n```",
        durationMs: 12000,
        timestamp: 1700001012000,
      },
    ];

    useAppStore.setState({
      messages: multiStepMessages,
      isStreaming: false,
    });

    const env = await bootCoreChatKernel();
    const disposeHostFactories = registerHostComponentFactories(env.registry);
    try {
      const renderStage = () =>
        createElement(
          SlotKernelProvider,
          { registry: env.registry, ctx: env.root },
          createElement(SlotHost, {
            slotKey: "shell.stage",
            kind: "chain",
            scope: "session-maybe",
            props: { cwd: "/repo/core-chat", sessionFile: "harness:sess-main-1", hubView: null, draftMode: false },
            registry: env.registry,
            rootCtx: env.root,
          }),
        );

      const mounted = mountDom(renderStage());

      // 1. All 4 consecutive assistant messages merge into ONE `.dshc-turn` article (not 4 stacked pills).
      const assistantTurns = mounted.container.findAll(
        (el) => el.getAttribute("data-chat-flow-kind") === "assistant",
      );
      expect(assistantTurns).toHaveLength(1);

      const turnProcessButtons = mounted.container.findAll(
        (el) => el.className.split(/\s+/).includes("dshc-turn-process"),
      );
      expect(turnProcessButtons).toHaveLength(1);
      expect(turnProcessButtons[0]?.textContent).toContain("已完成，用时");

      // Intermediate narration stays collapsed inside the turn process; final answer & syntax-highlighted CodeFence are visible.
      expect(mounted.container.textContent).toContain("已经梳理完成：");
      expect(mounted.container.textContent).toContain("export const adapter = true;");
      expect(mounted.container.textContent).not.toContain("我先摸清 Magpie");
      expect(mounted.container.textContent).not.toContain("Magpie 源码和本地配置都在");
      expect(
        mounted.container.findOne((el) => el.className.split(/\s+/).includes("markdown-code")),
      ).toBeDefined();

      // 2. Expanding `.dshc-turn-process` reveals grouped ProcessGroup segments + intermediate narrations.
      act(() => {
        turnProcessButtons[0]?.dispatchEvent(new MiniEvent("click", { bubbles: true }));
      });
      const expandedText = mounted.container.textContent;
      expect(expandedText).toContain("我先摸清 Magpie");
      expect(expandedText).toContain("Magpie 源码和本地配置都在");
      expect(expandedText).toContain("读取 2 个文件，搜索 1 次，运行 1 条命令");

      // 3. External plugin overrides on conversation.toolCall & conversation.markdown.codeBlock still work with host factories active!
      let extFiber: Awaited<ReturnType<typeof env.root.plugin>> | undefined;
      await act(async () => {
        extFiber = await env.root.plugin({
          name: "ext-host-factory-override",
          inject: ["slots"],
          apply(ctx: Context) {
            ctx.slots.register("conversation.toolCall", {
              id: "ext-sqlite-override",
              pluginId: "ext-host-factory-override",
              tier: "user",
              key: ["sqlite_*"],
              component: ({ call }) =>
                createElement("div", { "data-testid": "ext-sqlite-host" }, `HostOverride:${call.name}`),
            });
            ctx.slots.register("conversation.markdown.codeBlock", {
              id: "ext-ts-override",
              pluginId: "ext-host-factory-override",
              tier: "user",
              key: ["ts"],
              component: ({ code }) =>
                createElement("div", { "data-testid": "ext-ts-host" }, `CustomTS:${code.trim()}`),
            });
          },
        });
      });

      // Open each collapsed process group inside the expanded turn to inspect tool rows
      const groupButtons = mounted.container.findAll(
        (el) => el.className.split(/\s+/).includes("dshc-group-title"),
      );
      expect(groupButtons.length).toBeGreaterThanOrEqual(2);
      for (const btn of groupButtons) {
        act(() => {
          btn.dispatchEvent(new MiniEvent("click", { bubbles: true }));
        });
      }
      expect(mounted.container.textContent).toContain("HostOverride:sqlite_query");
      expect(mounted.container.textContent).toContain("CustomTS:export const adapter = true;");

      await act(async () => {
        await extFiber?.dispose();
      });
      expect(mounted.container.textContent).not.toContain("HostOverride:");
      expect(mounted.container.textContent).not.toContain("CustomTS:");
      expect(mounted.container.textContent).toContain("export const adapter = true;");

      // 4. Live streaming multi-step turn renders ZERO collapsed `.dshc-turn-process` pills, showing live ProcessGroup + RunningRow instead!
      act(() => {
        useAppStore.setState({
          isStreaming: true,
          messages: [
            multiStepMessages[0] as UiMessage,
            multiStepMessages[1] as UiMessage,
            multiStepMessages[2] as UiMessage,
            {
              id: "a-live-step",
              role: "assistant",
              content: "",
              isStreaming: true,
              toolCalls: [
                { id: "tc-live", name: "read", args: { path: "src/live.ts" }, running: true },
              ],
              timestamp: 1700001015000,
            },
          ],
        });
      });

      expect(
        mounted.container.findAll((el) => el.getAttribute("data-chat-flow-kind") === "assistant"),
      ).toHaveLength(1);
      expect(
        mounted.container.findAll((el) => el.className.split(/\s+/).includes("dshc-turn-process")),
      ).toHaveLength(0);
      expect(
        mounted.container.findOne((el) => el.className.split(/\s+/).includes("dshc-running")),
      ).toBeDefined();
      expect(mounted.container.textContent).toContain("正在读取");

      act(() => {
        useAppStore.setState({ isStreaming: false, messages: [] });
      });
      mounted.unmount();
    } finally {
      disposeHostFactories();
      useAppStore.setState({ isStreaming: false, messages: [] });
      await env.dispose();
    }
  });
});

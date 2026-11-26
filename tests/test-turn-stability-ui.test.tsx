import { act, createElement, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Context } from "@deepseek-ai/cordis";
import {
  ClientSlotsService,
  SlotHost,
  SlotKernelProvider,
  SlotRegistry,
} from "@qianji/client-slots";
import { coreConversationPlugin } from "../src/builtin-plugins/core-conversation";
import { Message } from "../src/components/Message";
import {
  DEFAULT_TURN_CONTINUE_PROMPT,
  DEFAULT_TURN_RETRY_PROMPT,
  TurnErrorCard,
  TurnIncompleteBanner,
} from "../src/components/message/TurnErrorCard";
import { registerHostComponentFactories } from "../src/kernel/primitives/hostComponentFactories";
import { installSessionScopeAdapter, registerFrontendServices } from "../src/kernel/services";
import { ClientContributionRegistry } from "../src/lib/clientContributions";
import {
  describeLlmErrorHint,
  describeLlmErrorTitle,
  shouldSuggestModelSettings,
  type UiLlmError,
} from "../src/lib/llmError";
import { bindClientRootContext } from "../src/sdk/rootContext";
import { useAppStore } from "../src/store";
import type { UiMessage } from "../src/types";

/* ── Minimal interactive DOM harness for React 19 click & store dispatch tests ── */

interface ListenerEntry {
  readonly fn: (event: MiniEvent) => void;
  readonly capture: boolean;
}

class MiniEvent {
  readonly type: string;
  readonly bubbles: boolean;
  readonly cancelable: boolean;
  target: MiniEventTarget | null = null;
  currentTarget: MiniEventTarget | null = null;
  defaultPrevented = false;
  propagationStopped = false;
  eventPhase = 0;

  constructor(type: string, init: { bubbles?: boolean; cancelable?: boolean } = {}) {
    this.type = type;
    this.bubbles = init.bubbles ?? true;
    this.cancelable = init.cancelable ?? true;
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

  addEventListener(type: string, fn: ((event: MiniEvent) => void) | null, opts?: boolean | { capture?: boolean }): void {
    if (fn === null) return;
    const capture = typeof opts === "boolean" ? opts : (opts?.capture ?? false);
    const list = this.listeners.get(type) ?? [];
    if (!list.some((item) => item.fn === fn && item.capture === capture)) {
      list.push({ fn, capture });
      this.listeners.set(type, list);
    }
  }

  removeEventListener(type: string, fn: ((event: MiniEvent) => void) | null, opts?: boolean | { capture?: boolean }): void {
    if (fn === null) return;
    const capture = typeof opts === "boolean" ? opts : (opts?.capture ?? false);
    const list = this.listeners.get(type);
    if (list !== undefined) {
      this.listeners.set(type, list.filter((item) => item.fn !== fn || item.capture !== capture));
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
    if (val !== "" && this.ownerDocument !== null) this.appendChild(this.ownerDocument.createTextNode(val));
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
    if (this.ownerDocument !== null && path[path.length - 1] !== this.ownerDocument) path.push(this.ownerDocument);
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
  readonly style: Record<string, unknown> = { setProperty: () => undefined, removeProperty: () => undefined };
  disabled = false;
  onclick: unknown = null;

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
  setAttribute(key: string, val: string): void {
    this.attributes.set(key.toLowerCase(), String(val));
  }
  getAttribute(key: string): string | null {
    return this.attributes.get(key.toLowerCase()) ?? null;
  }
  removeAttribute(key: string): void {
    this.attributes.delete(key.toLowerCase());
  }
  focus(): void {
    if (this.ownerDocument !== null) this.ownerDocument.activeElement = this;
  }
  closest(): MiniElement | null {
    return null;
  }
  attachEvent(): void {}
  detachEvent(): void {}

  findOne(predicate: (el: MiniElement) => boolean): MiniElement | undefined {
    const walk = (node: MiniNode): MiniElement | undefined => {
      if (node instanceof MiniElement && predicate(node)) return node;
      for (const child of node.childNodes) {
        const hit = walk(child);
        if (hit !== undefined) return hit;
      }
      return undefined;
    };
    return walk(this);
  }
}

class MiniIframeElement extends MiniElement {}

class MiniWindow extends MiniEventTarget {
  readonly navigator = { userAgent: "node" };
  readonly HTMLIFrameElement = MiniIframeElement;
  readonly HTMLElement = MiniElement;
  readonly Element = MiniElement;
  readonly Node = MiniNode;
  readonly Event = MiniEvent;
  setTimeout = globalThis.setTimeout.bind(globalThis);
  clearTimeout = globalThis.clearTimeout.bind(globalThis);
  getComputedStyle = () => ({ lineHeight: "22px", fontSize: "14px" });
  matchMedia = () => ({ matches: true, media: "", addEventListener: () => undefined, removeEventListener: () => undefined, addListener: () => undefined, removeListener: () => undefined });
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

const cleanups: Array<() => void> = [];

function mountDom(node: ReactNode): { container: MiniElement; unmount: () => void } {
  const g = globalThis as Record<string, unknown>;
  const keys = ["window", "document", "Node", "Element", "HTMLElement", "HTMLIFrameElement", "IS_REACT_ACT_ENVIRONMENT"] as const;
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
    act(() => {
      root?.unmount();
    });
    for (const key of keys) {
      if (saved[key] === undefined) delete g[key];
      else g[key] = saved[key];
    }
  };
  cleanups.push(unmount);
  return { container, unmount };
}

function words(markup: string): string {
  return markup.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
}

const originalSendMessage = useAppStore.getState().sendMessage;

describe("Turn stability UI: empty_response_exhausted retry & length-truncation indicators", () => {
  beforeEach(() => {
    useAppStore.setState({
      cwd: "/repo/turn-stability",
      sessionId: "sess-stability-1",
      sessionFile: "harness:sess-stability-1",
      messages: [],
      isStreaming: false,
      isCompacting: false,
      retryStatus: null,
      sendMessage: originalSendMessage,
    });
  });

  afterEach(() => {
    while (cleanups.length > 0) cleanups.pop()?.();
    bindClientRootContext(undefined);
    useAppStore.setState({ sendMessage: originalSendMessage, isStreaming: false });
    vi.restoreAllMocks();
  });

  it("classifies empty_response_exhausted with honest title, hint, and no model-settings prompt", () => {
    const err: UiLlmError = {
      kind: "unknown",
      code: "empty_response_exhausted",
      message: "模型未返回可见正文（连续仅输出思考或空响应）。",
      retryable: true,
    };
    expect(describeLlmErrorTitle(err)).toBe("模型未返回可见正文");
    expect(describeLlmErrorHint(err)).toBe("模型连续仅输出了内部思考或空响应。可点击重试，或调低推理强度后再试。");
    expect(shouldSuggestModelSettings(err)).toBe(false);
  });

  it("renders empty_response_exhausted card with retry action on last assistant turn only", () => {
    const errMessage: UiMessage = {
      id: "assistant-empty-exhausted",
      role: "assistant",
      content: "模型未返回可见正文（连续仅输出思考或空响应）。",
      thinking: "Step 1 internal reasoning only",
      isError: true,
      stopReason: "error",
      error: {
        kind: "unknown",
        code: "empty_response_exhausted",
        message: "模型未返回可见正文（连续仅输出思考或空响应）。",
        retryable: true,
      },
      timestamp: 1000,
    };

    const lastMarkup = renderToStaticMarkup(createElement(Message, { message: errMessage, isLastAssistant: true }));
    expect(words(lastMarkup)).toContain("处理失败");
    expect(lastMarkup).toContain("模型未返回可见正文");
    expect(lastMarkup).toContain("empty_response_exhausted");
    expect(lastMarkup).toContain("模型连续仅输出了内部思考或空响应。可点击重试，或调低推理强度后再试。");
    expect(lastMarkup).toContain("<span>重试</span>");
    expect(lastMarkup).not.toContain("模型设置");
    expect(lastMarkup).not.toContain('class="dshc-answer"');

    const historicalMarkup = renderToStaticMarkup(createElement(Message, { message: errMessage, isLastAssistant: false }));
    expect(historicalMarkup).toContain("模型未返回可见正文");
    expect(historicalMarkup).not.toContain("<span>重试</span>");

    const nonRetryableMarkup = renderToStaticMarkup(
      createElement(Message, {
        message: { ...errMessage, error: { ...errMessage.error, message: errMessage.content, retryable: false } },
        isLastAssistant: true,
      }),
    );
    expect(nonRetryableMarkup).not.toContain("<span>重试</span>");
  });

  it("renders honest incomplete status label and TurnIncompleteBanner for stopReason === 'length'", () => {
    const truncatedWithDuration: UiMessage = {
      id: "assistant-length-1",
      role: "assistant",
      content: "这里是尚未写完的前半段分析……",
      stopReason: "length",
      durationMs: 5_000,
      timestamp: 2000,
    };

    const lastMarkup = renderToStaticMarkup(
      createElement(Message, { message: truncatedWithDuration, showThinking: false, isLastAssistant: true }),
    );
    expect(words(lastMarkup)).toContain("未完成（输出受限），用时 5 秒");
    expect(words(lastMarkup)).not.toContain("已完成");
    expect(lastMarkup).toContain("这里是尚未写完的前半段分析");
    expect(lastMarkup).toContain('class="dshc-turn-incomplete"');
    expect(lastMarkup).toContain("回答因达到输出长度上限而未完成");
    expect(lastMarkup).toContain("<span>继续生成</span>");

    const noDurationHistorical: UiMessage = {
      id: "assistant-length-2",
      role: "assistant",
      content: "早期被截断的回复",
      stopReason: "length",
      timestamp: 2100,
    };
    const historicalMarkup = renderToStaticMarkup(createElement(Message, { message: noDurationHistorical, isLastAssistant: false }));
    expect(words(historicalMarkup)).toContain("未完成（输出受限）");
    expect(historicalMarkup).toContain("回答因达到输出长度上限而未完成");
    expect(historicalMarkup).not.toContain("<span>继续生成</span>");
  });

  it("dispatches retry and continue prompts via active session store when clicked", () => {
    const sendSpy = vi.fn().mockResolvedValue(true);
    useAppStore.setState({ sendMessage: sendSpy, isStreaming: false });

    const errMessage: UiMessage = {
      id: "err-click-1",
      role: "assistant",
      content: "模型未返回可见正文（连续仅输出思考或空响应）。",
      isError: true,
      error: {
        kind: "unknown",
        code: "empty_response_exhausted",
        message: "模型未返回可见正文（连续仅输出思考或空响应）。",
        retryable: true,
      },
      timestamp: 3000,
    };

    const mounted = mountDom(
      createElement(
        "div",
        null,
        createElement(TurnErrorCard, { message: errMessage, isLast: true }),
        createElement(TurnIncompleteBanner, { isLast: true }),
      ),
    );

    const retryBtn = mounted.container.findOne((el) => el.tagName === "BUTTON" && el.textContent.includes("重试"));
    const continueBtn = mounted.container.findOne((el) => el.tagName === "BUTTON" && el.textContent.includes("继续生成"));
    expect(retryBtn).toBeDefined();
    expect(continueBtn).toBeDefined();

    act(() => {
      retryBtn?.dispatchEvent(new MiniEvent("click", { bubbles: true }));
    });
    expect(sendSpy).toHaveBeenCalledTimes(1);
    expect(sendSpy.mock.lastCall?.[0]).toBe(DEFAULT_TURN_RETRY_PROMPT);

    act(() => {
      continueBtn?.dispatchEvent(new MiniEvent("click", { bubbles: true }));
    });
    expect(sendSpy).toHaveBeenCalledTimes(2);
    expect(sendSpy.mock.lastCall?.[0]).toBe("请从上次截断处直接继续输出剩余内容。");
    expect(DEFAULT_TURN_CONTINUE_PROMPT).toBe("请从上次截断处直接继续输出剩余内容。");
  });

  it("mirrors retry and incomplete-turn banner in CoreMessageItem (both pure fallback and host factory)", async () => {
    for (const withHostFactories of [false, true]) {
      const sendSpy = vi.fn().mockResolvedValue(true);
      const messages: UiMessage[] = [
        { id: "u1", entryId: "1", role: "user", content: "写一份超长报告", timestamp: 1000 },
        {
          id: "a-err",
          role: "assistant",
          content: "模型未返回可见正文（连续仅输出思考或空响应）。",
          isError: true,
          stopReason: "error",
          error: {
            kind: "unknown",
            code: "empty_response_exhausted",
            message: "模型未返回可见正文（连续仅输出思考或空响应）。",
            retryable: true,
          },
          timestamp: 2000,
        },
      ];
      useAppStore.setState({ messages, sendMessage: sendSpy, isStreaming: false });

      const root = new Context();
      const registry = new SlotRegistry();
      const contributions = new ClientContributionRegistry();
      await root.plugin(ClientSlotsService, registry);
      await registerFrontendServices(root, { contributionRegistry: contributions, shortcutTarget: null });
      const disposeAdapter = installSessionScopeAdapter(root);
      const disposeFactories = withHostFactories ? registerHostComponentFactories(registry) : () => undefined;
      bindClientRootContext(root);
      await root.plugin(coreConversationPlugin);

      const mountedErr = mountDom(
        createElement(
          SlotKernelProvider,
          { registry, ctx: root },
          createElement(SlotHost, {
            slotKey: "conversation.transcript",
            kind: "chain",
            scope: "session",
            sessionId: "sess-stability-1",
            props: { cwd: "/repo/turn-stability", sessionFile: "harness:sess-stability-1" },
            registry,
            rootCtx: root,
          }),
        ),
      );

      expect(mountedErr.container.textContent).toContain("处理失败");
      expect(mountedErr.container.textContent).toContain("模型未返回可见正文");
      const retryBtn = mountedErr.container.findOne((el) => el.tagName === "BUTTON" && el.textContent.includes("重试"));
      expect(retryBtn).toBeDefined();
      act(() => {
        retryBtn?.dispatchEvent(new MiniEvent("click", { bubbles: true }));
      });
      expect(sendSpy).toHaveBeenCalledTimes(1);
      mountedErr.unmount();

      const lengthMessages: UiMessage[] = [
        { id: "u1", entryId: "1", role: "user", content: "写一份超长报告", timestamp: 1000 },
        {
          id: "a-len",
          role: "assistant",
          content: "第一部分内容已生成……",
          stopReason: "length",
          durationMs: 3_000,
          timestamp: 4000,
        },
      ];
      useAppStore.setState({ messages: lengthMessages, sendMessage: sendSpy, isStreaming: false });

      const mountedLen = mountDom(
        createElement(
          SlotKernelProvider,
          { registry, ctx: root },
          createElement(SlotHost, {
            slotKey: "conversation.transcript",
            kind: "chain",
            scope: "session",
            sessionId: "sess-stability-1",
            props: { cwd: "/repo/turn-stability", sessionFile: "harness:sess-stability-1" },
            registry,
            rootCtx: root,
          }),
        ),
      );

      expect(mountedLen.container.textContent).toContain("未完成（输出受限）");
      expect(mountedLen.container.textContent).toContain("回答因达到输出长度上限而未完成");
      const continueBtn = mountedLen.container.findOne((el) => el.tagName === "BUTTON" && el.textContent.includes("继续生成"));
      expect(continueBtn).toBeDefined();
      act(() => {
        continueBtn?.dispatchEvent(new MiniEvent("click", { bubbles: true }));
      });
      expect(sendSpy).toHaveBeenCalledTimes(2);
      expect(sendSpy.mock.lastCall?.[0]).toBe("请从上次截断处直接继续输出剩余内容。");

      mountedLen.unmount();
      disposeFactories();
      disposeAdapter();
      bindClientRootContext(undefined);
      registry.dispose();
    }
  });
});

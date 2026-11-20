import { act, createRef, useState, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as Primitives from "../src/kernel/primitives";
import {
  Badge, Button, Card, CLIENT_PRIMITIVES_EXPORTS, Dialog, DialogSection,
  IconButton, Input, Markdown, Popover, ScrollArea, Select, Switch,
  Tabs, TabsContent, TabsList, TabsTrigger, Tooltip,
} from "../src/kernel/primitives";

type ListenerEntry = { fn: (event: MiniEvent) => void; capture: boolean };
interface EventInitLike { bubbles?: boolean; cancelable?: boolean; key?: string; relatedTarget?: MiniNode | null }

class MiniEvent {
  readonly type: string;
  readonly bubbles: boolean;
  readonly cancelable: boolean;
  readonly key: string;
  readonly relatedTarget: MiniNode | null;
  target: MiniEventTarget | null = null;
  currentTarget: MiniEventTarget | null = null;
  defaultPrevented = false;
  propagationStopped = false;
  eventPhase = 0;
  constructor(type: string, init: EventInitLike = {}) {
    this.type = type;
    this.bubbles = init.bubbles ?? true;
    this.cancelable = init.cancelable ?? true;
    this.key = init.key ?? "";
    this.relatedTarget = init.relatedTarget ?? null;
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
  readonly nodeType: number;
  readonly nodeName: string;
  ownerDocument: MiniDocument | null;
  parentNode: MiniNode | null = null;
  readonly childNodes: MiniNode[] = [];
  protected textValue = "";
  constructor(nodeType: number, nodeName: string, ownerDocument: MiniDocument | null) {
    super(); this.nodeType = nodeType; this.nodeName = nodeName; this.ownerDocument = ownerDocument;
  }
  get parentElement(): MiniElement | null { return this.parentNode instanceof MiniElement ? this.parentNode : null; }
  get firstChild(): MiniNode | null { return this.childNodes[0] ?? null; }
  get lastChild(): MiniNode | null { return this.childNodes[this.childNodes.length - 1] ?? null; }
  get nextSibling(): MiniNode | null { const i = this.parentNode?.childNodes.indexOf(this) ?? -1; return i >= 0 ? (this.parentNode?.childNodes[i + 1] ?? null) : null; }
  get previousSibling(): MiniNode | null { const i = this.parentNode?.childNodes.indexOf(this) ?? -1; return i > 0 ? (this.parentNode?.childNodes[i - 1] ?? null) : null; }
  get nodeValue(): string | null { return this.nodeType === 3 || this.nodeType === 8 ? this.textValue : null; }
  set nodeValue(value: string | null) { this.textValue = value ?? ""; }
  get data(): string { return this.textValue; }
  set data(value: string) { this.textValue = value; }
  get textContent(): string { return this.nodeType === 3 ? this.textValue : this.nodeType === 8 ? "" : this.childNodes.map((c) => c.textContent).join(""); }
  set textContent(value: string) {
    if (this.nodeType === 3 || this.nodeType === 8) { this.textValue = value; return; }
    for (const c of [...this.childNodes]) this.removeChild(c);
    if (value !== "" && this.ownerDocument !== null) this.appendChild(this.ownerDocument.createTextNode(value));
  }
  appendChild<T extends MiniNode>(child: T): T {
    if (child.parentNode !== null) child.parentNode.removeChild(child);
    child.parentNode = this; this.childNodes.push(child); return child;
  }
  insertBefore<T extends MiniNode>(child: T, refNode: MiniNode | null): T {
    if (refNode === null) return this.appendChild(child);
    if (child.parentNode !== null) child.parentNode.removeChild(child);
    const idx = this.childNodes.indexOf(refNode);
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
    if (this.ownerDocument !== null && this.ownerDocument.defaultView !== null) path.push(this.ownerDocument.defaultView);
    event.eventPhase = 1;
    for (let i = path.length - 1; i > 0; i -= 1) { if (event.propagationStopped) return !event.defaultPrevented; path[i]?.invokeListeners(event, true); }
    if (!event.propagationStopped) { event.eventPhase = 2; this.invokeListeners(event, true); if (!event.propagationStopped) this.invokeListeners(event, false); }
    if (event.bubbles) {
      event.eventPhase = 3;
      for (let i = 1; i < path.length; i += 1) { if (event.propagationStopped) break; path[i]?.invokeListeners(event, false); }
    }
    return !event.defaultPrevented;
  }
}

function matchesSelector(el: MiniElement, selector: string): boolean {
  if (/^[a-zA-Z]+$/.test(selector)) return el.tagName === selector.toUpperCase();
  const attrEq = /^\[([a-zA-Z0-9_-]+)=['"]([^'"]*)['"]\]$/.exec(selector);
  if (attrEq !== null) return el.getAttribute(attrEq[1] ?? "") === (attrEq[2] ?? "");
  const attrPresent = /^\[([a-zA-Z0-9_-]+)\]$/.exec(selector);
  if (attrPresent !== null) return el.hasAttribute(attrPresent[1] ?? "");
  if (selector.startsWith(".")) return el.className.split(/\s+/).includes(selector.slice(1));
  if (selector === "[tabindex]:not([tabindex='-1'])") { const raw = el.getAttribute("tabindex"); return raw !== null && raw !== "-1"; }
  return false;
}

class MiniElement extends MiniNode {
  readonly tagName: string;
  readonly namespaceURI = "http://www.w3.org/1999/xhtml";
  readonly attributes = new Map<string, string>();
  readonly style: Record<string, string> = {};
  value = "";
  defaultValue = "";
  checked = false;
  disabled = false;
  constructor(tag: string, ownerDocument: MiniDocument) { super(1, tag.toUpperCase(), ownerDocument); this.tagName = tag.toUpperCase(); }
  get id(): string { return this.attributes.get("id") ?? ""; }
  set id(v: string) { this.attributes.set("id", v); }
  get className(): string { return this.attributes.get("class") ?? ""; }
  set className(v: string) { this.attributes.set("class", v); }
  get tabIndex(): number { const r = this.attributes.get("tabindex"); return r === undefined ? -1 : Number(r); }
  set tabIndex(v: number) { this.attributes.set("tabindex", String(v)); }
  get type(): string { return this.attributes.get("type") ?? ""; }
  set type(v: string) { this.attributes.set("type", v); }
  get href(): string { return this.attributes.get("href") ?? ""; }
  set href(v: string) { this.attributes.set("href", v); }
  get options(): MiniElement[] { return this.querySelectorAll("option"); }
  get selected(): boolean { return this.hasAttribute("selected"); }
  set selected(v: boolean) { if (v) this.setAttribute("selected", ""); else this.removeAttribute("selected"); }
  setAttribute(name: string, value: string): void {
    const k = name.toLowerCase(); this.attributes.set(k, String(value));
    if (k === "disabled") this.disabled = true;
    if (k === "value") this.value = String(value);
  }
  getAttribute(name: string): string | null { return this.attributes.get(name.toLowerCase()) ?? null; }
  removeAttribute(name: string): void { const k = name.toLowerCase(); this.attributes.delete(k); if (k === "disabled") this.disabled = false; }
  hasAttribute(name: string): boolean { return this.attributes.has(name.toLowerCase()); }
  focus(): void { if (this.ownerDocument !== null) this.ownerDocument.activeElement = this; }
  blur(): void { if (this.ownerDocument !== null && this.ownerDocument.activeElement === this) this.ownerDocument.activeElement = this.ownerDocument.body; }
  querySelectorAll(selector: string): MiniElement[] {
    const out: MiniElement[] = [];
    const parts = selector.split(",").map((s) => s.trim()).filter((s) => s !== "");
    const visit = (n: MiniNode) => {
      for (const c of n.childNodes) {
        if (c instanceof MiniElement) { if (parts.some((p) => matchesSelector(c, p))) out.push(c); visit(c); }
      }
    };
    visit(this);
    return out;
  }
  querySelector(selector: string): MiniElement | null { return this.querySelectorAll(selector)[0] ?? null; }
}

class MiniDocument extends MiniNode {
  readonly documentElement: MiniElement;
  readonly head: MiniElement;
  readonly body: MiniElement;
  activeElement: MiniElement | null;
  defaultView: MiniWindow | null = null;
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
  querySelector(selector: string): MiniElement | null { return this.documentElement.querySelector(selector); }
  querySelectorAll(selector: string): MiniElement[] { return this.documentElement.querySelectorAll(selector); }
}

class MiniIframeStub {}

class MiniWindow extends MiniEventTarget {
  readonly document: MiniDocument;
  readonly HTMLElement = MiniElement;
  readonly HTMLIFrameElement = MiniIframeStub;
  readonly Element = MiniElement;
  readonly Node = MiniNode;
  readonly Event = MiniEvent;
  constructor(doc: MiniDocument) { super(); this.document = doc; doc.defaultView = this; }
  dispatchEvent(event: MiniEvent): boolean {
    event.target = this;
    this.invokeListeners(event, true);
    if (!event.propagationStopped) this.invokeListeners(event, false);
    return !event.defaultPrevented;
  }
}

const activeCleanups: Array<() => void> = [];

function mountInDom(node: ReactNode) {
  const g = globalThis as Record<string, unknown>;
  const keys = ["window", "document", "Node", "Element", "HTMLElement", "HTMLIFrameElement", "Event", "IS_REACT_ACT_ENVIRONMENT"] as const;
  const saved = Object.fromEntries(keys.map((key) => [key, g[key]]));
  const doc = new MiniDocument();
  const win = new MiniWindow(doc);
  const container = doc.createElement("div");
  doc.body.appendChild(container);
  Object.assign(g, {
    window: win, document: doc, Node: MiniNode, Element: MiniElement,
    HTMLElement: MiniElement, HTMLIFrameElement: MiniIframeStub, Event: MiniEvent, IS_REACT_ACT_ENVIRONMENT: true,
  });

  let root: Root | null = null;
  act(() => { root = createRoot(container as unknown as HTMLElement); root.render(node); });

  let unmounted = false;
  const unmount = () => {
    if (unmounted) return;
    unmounted = true;
    act(() => { root?.unmount(); });
    for (const key of keys) { if (saved[key] === undefined) delete g[key]; else g[key] = saved[key]; }
  };
  activeCleanups.push(unmount);
  return { doc, win, container, unmount };
}

const fireClick = (el: MiniElement) => act(() => { el.dispatchEvent(new MiniEvent("click")); });
const fire = (target: MiniNode | MiniWindow | null | undefined, type: string, init?: EventInitLike) =>
  act(() => { target?.dispatchEvent(new MiniEvent(type, init)); });

afterEach(() => { while (activeCleanups.length > 0) activeCleanups.pop()?.(); });

describe("@qianji/client-primitives export manifest & parity", () => {
  it("matches CLIENT_PRIMITIVES_EXPORTS 1:1 with runtime exports and hides host-private internals", () => {
    const runtimeExports = Object.keys(Primitives).filter((k) => k !== "CLIENT_PRIMITIVES_EXPORTS").sort();
    expect(runtimeExports).toEqual([...CLIENT_PRIMITIVES_EXPORTS].sort());
    for (const name of CLIENT_PRIMITIVES_EXPORTS) expect(typeof Primitives[name]).toBe("function");
    for (const required of [
      "Button", "IconButton", "Card", "Dialog", "DialogSection", "Popover",
      "Tabs", "TabsList", "TabsTrigger", "TabsContent", "Select", "Switch",
      "Input", "Badge", "Tooltip", "Markdown", "ScrollArea",
    ] as const) {
      expect(CLIENT_PRIMITIVES_EXPORTS).toContain(required);
    }
    expect("WorkspaceFileOpenContext" in Primitives).toBe(false);
    expect("useAppStore" in Primitives).toBe(false);
  });
});

describe("@qianji/client-primitives rendering & interactive behavior", () => {
  it("renders and interacts with Button, IconButton, Card, Input, Select, Switch, Badge, Tabs, Dialog, and Tooltip", () => {
    const onButtonClick = vi.fn();
    const onSwitch = vi.fn();
    const onSelect = vi.fn();
    const onDialogChange = vi.fn();
    const inputRef = createRef<HTMLInputElement>();

    const harness = mountInDom(
      <div>
        <Button variant="primary" size="sm" onClick={onButtonClick}>Run</Button>
        <IconButton aria-label="Pin item" active tooltip="Pin to top">P</IconButton>
        <Card variant="elevated" header={<span>Card Title</span>} footer={<span>Footer</span>}>Body content</Card>
        <Input ref={inputRef} placeholder="Search..." />
        <Select aria-label="Theme" defaultValue="dark" onValueChange={onSelect} options={[
          { value: "dark", label: "Dark" }, { value: "light", label: "Light" },
        ]} />
        <Switch aria-label="Enable" checked={false} onCheckedChange={onSwitch} />
        <Badge variant="success">Ready</Badge>
        <Tabs defaultValue="a">
          <TabsList><TabsTrigger value="a">Tab A</TabsTrigger><TabsTrigger value="b">Tab B</TabsTrigger></TabsList>
          <TabsContent value="a">Panel A</TabsContent>
          <TabsContent value="b">Panel B</TabsContent>
        </Tabs>
        <Tooltip content="Helpful tip" side="bottom"><span>Hover target</span></Tooltip>
        <Dialog open title="Confirm" description="Proceed?" onOpenChange={onDialogChange}>
          <DialogSection>Dialog body</DialogSection>
        </Dialog>
      </div>,
    );

    const text = harness.container.textContent;
    for (const label of ["Run", "Card Title", "Body content", "Footer", "Ready", "Panel A"]) expect(text).toContain(label);
    expect(text).not.toContain("Panel B");

    const runBtn = harness.container.querySelector(".qj-btn--primary");
    if (runBtn !== null) fireClick(runBtn);
    expect(onButtonClick).toHaveBeenCalledTimes(1);
    expect(inputRef.current).toBe(harness.container.querySelector("input"));

    const iconBtn = harness.container.querySelector('[aria-label="Pin item"]');
    expect(iconBtn?.getAttribute("aria-pressed")).toBe("true");
    expect(iconBtn?.style.background).toBe("var(--qj-bg-active)");
    expect(harness.container.querySelector('[data-qj-primitive="card"]')?.style.background).toBe("var(--qj-bg-elevated)");

    const selectEl = harness.container.querySelector("select");
    if (selectEl !== null) { selectEl.value = "light"; fire(selectEl, "change"); }
    expect(onSelect).toHaveBeenCalledWith("light");

    const switchBtn = harness.container.querySelector('[role="switch"]');
    expect(switchBtn?.getAttribute("aria-checked")).toBe("false");
    if (switchBtn !== null) fireClick(switchBtn);
    expect(onSwitch).toHaveBeenCalledWith(true);

    const tabB = harness.container.querySelectorAll('[role="tab"]')[1];
    if (tabB !== undefined) fireClick(tabB);
    expect(harness.container.textContent).toContain("Panel B");
    expect(harness.container.textContent).not.toContain("Panel A");

    const dialog = harness.doc.body.querySelector('[role="dialog"]');
    expect(dialog?.textContent).toContain("Confirm");
    expect(dialog?.textContent).toContain("Dialog body");
    fire(harness.win, "keydown", { key: "Escape" });
    expect(onDialogChange).toHaveBeenCalledWith(false);

    const tooltipWraps = harness.container.querySelectorAll(".qj-tooltip-wrap");
    expect(tooltipWraps).toHaveLength(2);
    fire(tooltipWraps[0], "focusin");
    expect(tooltipWraps[0]?.querySelector('[role="tooltip"]')?.textContent).toBe("Pin to top");
    fire(tooltipWraps[1], "focusin");
    expect(tooltipWraps[1]?.querySelector('[role="tooltip"]')?.textContent).toBe("Helpful tip");
  });

  it("opens Popover on trigger click, stays open on inside click, and dismisses on Escape and outside click", () => {
    const onOpenChange = vi.fn();
    const popoverRef = createRef<HTMLDivElement>();

    const harness = mountInDom(
      <div>
        <button type="button" id="outside-btn">Outside</button>
        <Popover ref={popoverRef} ariaLabel="Quick menu" side="top" align="end" onOpenChange={onOpenChange} trigger={<Button>Open Popover</Button>}>
          <button type="button" id="inside-action">Inside action</button>
        </Popover>
      </div>,
    );

    expect(popoverRef.current).not.toBeNull();
    expect(harness.container.querySelector('[role="dialog"]')).toBeNull();

    const triggerBtn = harness.container.querySelectorAll("button")[1];
    expect(triggerBtn?.getAttribute("aria-expanded")).toBe("false");
    if (triggerBtn !== undefined) fireClick(triggerBtn);

    const content = harness.container.querySelector('[role="dialog"]');
    expect(content).not.toBeNull();
    expect(content?.getAttribute("aria-label")).toBe("Quick menu");
    expect(content?.getAttribute("data-side")).toBe("top");
    expect(content?.getAttribute("data-align")).toBe("end");
    expect(content?.style.background).toBe("var(--qj-bg-surface)");
    expect(content?.style.border).toBe("1px solid var(--qj-border-strong)");
    expect(triggerBtn?.getAttribute("aria-expanded")).toBe("true");
    expect(triggerBtn?.getAttribute("aria-controls")).toBe(content?.id);
    expect(onOpenChange).toHaveBeenLastCalledWith(true);

    const insideBtn = harness.container.querySelector('[id="inside-action"]');
    fire(insideBtn, "pointerdown");
    fire(insideBtn, "mousedown");
    expect(harness.container.querySelector('[role="dialog"]')).not.toBeNull();

    insideBtn?.focus();
    fire(harness.doc, "keydown", { key: "Escape" });
    expect(harness.container.querySelector('[role="dialog"]')).toBeNull();
    expect(onOpenChange).toHaveBeenLastCalledWith(false);
    expect(harness.doc.activeElement).toBe(triggerBtn);

    if (triggerBtn !== undefined) fireClick(triggerBtn);
    expect(harness.container.querySelector('[role="dialog"]')).not.toBeNull();
    onOpenChange.mockClear();

    const outsideBtn = harness.container.querySelector('[id="outside-btn"]');
    act(() => {
      outsideBtn?.dispatchEvent(new MiniEvent("pointerdown"));
      outsideBtn?.dispatchEvent(new MiniEvent("mousedown"));
    });
    expect(harness.container.querySelector('[role="dialog"]')).toBeNull();
    expect(onOpenChange).toHaveBeenCalledTimes(1);
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it("supports Popover controlled mode, render-prop trigger, string trigger, and disabled guard", () => {
    function ControlledDemo() {
      const [open, setOpen] = useState(false);
      return (
        <div>
          <Popover
            open={open}
            onOpenChange={setOpen}
            trigger={({ toggle, open: isOpen }) => <button type="button" onClick={toggle}>{isOpen ? "Close" : "Show"}</button>}
            content={({ close }) => <button type="button" id="close-inner" onClick={close}>Done</button>}
          />
          <Popover trigger="Plain">Plain body</Popover>
        </div>
      );
    }

    const harness = mountInDom(<ControlledDemo />);
    const [controlledTrigger, plainTrigger] = harness.container.querySelectorAll("button");
    expect(controlledTrigger?.textContent).toBe("Show");
    if (controlledTrigger !== undefined) fireClick(controlledTrigger);
    expect(controlledTrigger?.textContent).toBe("Close");
    expect(harness.container.querySelector('[role="dialog"]')).not.toBeNull();

    const closeBtn = harness.container.querySelector('[id="close-inner"]');
    if (closeBtn !== null) fireClick(closeBtn);
    expect(harness.container.querySelector('[role="dialog"]')).toBeNull();

    if (plainTrigger !== undefined) fireClick(plainTrigger);
    expect(harness.container.textContent).toContain("Plain body");

    const disabledMarkup = renderToStaticMarkup(<Popover disabled defaultOpen trigger="Disabled">Hidden</Popover>);
    expect(disabledMarkup).not.toContain("Hidden");
  });

  it("renders ScrollArea with vertical, horizontal, and both overflow modes plus ref forwarding", () => {
    const scrollRef = createRef<HTMLDivElement>();
    const harness = mountInDom(
      <div>
        <ScrollArea ref={scrollRef} aria-label="Logs" orientation="vertical" maxHeight={240}>Line 1</ScrollArea>
        <ScrollArea orientation="horizontal" maxWidth="320px" focusable={false}>Wide content</ScrollArea>
        <ScrollArea orientation="both" className="custom-scroll">Matrix</ScrollArea>
      </div>,
    );

    const nodes = harness.container.querySelectorAll('[data-qj-primitive="scroll-area"]');
    expect(nodes).toHaveLength(3);
    expect(scrollRef.current).toBe(nodes[0]);
    expect(nodes[0]?.getAttribute("role")).toBe("region");
    expect(nodes[0]?.getAttribute("tabindex")).toBe("0");
    expect(nodes[0]?.style.overflowY).toBe("auto");
    expect(nodes[0]?.style.overflowX).toBe("hidden");
    expect(nodes[0]?.style.maxHeight).toBe("240px");
    expect(nodes[1]?.getAttribute("tabindex")).toBeNull();
    expect(nodes[1]?.style.overflowX).toBe("auto");
    expect(nodes[1]?.style.overflowY).toBe("hidden");
    expect(nodes[1]?.style.maxWidth).toBe("320px");
    expect(nodes[2]?.style.overflowX).toBe("auto");
    expect(nodes[2]?.style.overflowY).toBe("auto");
    expect(nodes[2]?.className).toContain("custom-scroll");
  });

  it("renders Markdown with className and routes file clicks through onOpenFile with optional cwd resolution", () => {
    const openedWithCwd: Array<{ path: string; line: number | undefined }> = [];
    const openedRaw: Array<{ path: string; line: number | undefined }> = [];
    const harness = mountInDom(
      <div>
        <Markdown
          className="doc-preview"
          cwd="/workspace/demo"
          content={"# Heading\n\nCheck `src/App.tsx:42` and **bold** text."}
          onOpenFile={(path, line) => openedWithCwd.push({ path, line })}
        />
        <Markdown
          content={"Open `README.md`"}
          onOpenFile={(path, line) => openedRaw.push({ path, line })}
        />
      </div>,
    );

    const roots = harness.container.querySelectorAll('[data-qj-primitive="markdown"]');
    expect(roots[0]?.className).toContain("qj-markdown");
    expect(roots[0]?.className).toContain("doc-preview");
    expect(roots[0]?.textContent).toContain("Heading");
    expect(roots[0]?.textContent).toContain("bold");

    const fileLinks = harness.container.querySelectorAll(".file-ref");
    expect(fileLinks).toHaveLength(2);
    if (fileLinks[0] !== undefined) fireClick(fileLinks[0]);
    if (fileLinks[1] !== undefined) fireClick(fileLinks[1]);

    expect(openedWithCwd).toEqual([{ path: "/workspace/demo/src/App.tsx", line: 42 }]);
    expect(openedRaw).toEqual([{ path: "README.md", line: undefined }]);
  });
});

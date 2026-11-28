/**
 * Real Event-Driven CDP `Page.startScreencast` & Full Mouse/Keycode Dispatch
 * (`packages/host/src/bot/computer/cdp-screencast.ts`).
 */
import type { BrowserSession } from "@qianji/browser";
import type {
  BotComputerEngineId,
  BotComputerInputEvent,
  BotComputerPointerTelemetry,
  BotComputerStreamFrame,
} from "@qianji/protocol";
import { encodeCdpModifiers, resolveCdpKeyDescriptor, type CdpKeyDescriptor } from "./cdp-keymap.ts";

export { encodeCdpModifiers, resolveCdpKeyDescriptor, type CdpKeyDescriptor };

export const STUDIO_BROWSER_WIDTH = 1280;
export const STUDIO_BROWSER_HEIGHT = 800;

export interface CdpScreencastFramePayload {
  data: string;
  sessionId: number;
  metadata?: { deviceWidth?: number; deviceHeight?: number };
}

export interface CdpClientLike {
  connected?: boolean;
  send?: <T = unknown>(method: string, params?: Record<string, unknown>, timeoutMs?: number) => Promise<T>;
  on?: (method: string, listener: (params: unknown) => void) => (() => void) | void;
  off?: (method: string, listener: (params: unknown) => void) => void;
  waiters?: Map<string, Set<(params: unknown) => void>>;
}

function subscribeCdpEvent(cdp: CdpClientLike, method: string, fn: (params: unknown) => void): () => void {
  if (typeof cdp.on === "function") {
    const unsub = cdp.on(method, fn);
    return () => { if (typeof unsub === "function") unsub(); else cdp.off?.(method, fn); };
  }
  if (cdp.waiters instanceof Map) {
    const set = cdp.waiters.get(method) ?? new Set<(params: unknown) => void>();
    set.add(fn);
    cdp.waiters.set(method, set);
    return () => { set.delete(fn); };
  }
  return () => undefined;
}

export class CdpScreencastController {
  private streaming = false;
  private activeEngine: BotComputerEngineId = "local-linux";
  private detachListeners: (() => void) | null = null;
  private currentUrl = "";
  private currentTitle = "";

  constructor(private readonly deps: {
    getBrowser: () => BrowserSession;
    nextFrameSeq: () => number;
    getCursor: () => BotComputerPointerTelemetry | undefined;
    onFrame: (frame: BotComputerStreamFrame) => void;
  }) {}

  get isStreaming(): boolean { return this.streaming; }

  private getCdp(browser: BrowserSession): CdpClientLike | undefined {
    return (browser as unknown as { cdp?: CdpClientLike }).cdp;
  }

  async ensureViewport(browser: BrowserSession): Promise<void> {
    const cdp = this.getCdp(browser);
    if (!cdp?.connected || typeof cdp.send !== "function") return;
    await cdp.send("Emulation.setDeviceMetricsOverride", {
      width: STUDIO_BROWSER_WIDTH, height: STUDIO_BROWSER_HEIGHT, deviceScaleFactor: 1, mobile: false,
    }).catch(() => undefined);
  }

  async start(engine: BotComputerEngineId): Promise<void> {
    await this.stop();
    this.activeEngine = engine;
    const browser = this.deps.getBrowser();
    await browser.ensureStarted(true);
    await this.ensureViewport(browser);
    const snap = await browser.inspect().catch(() => null);
    if (snap) {
      this.currentUrl = snap.url.startsWith("data:text/html") ? "about:qianji-live-view" : snap.url;
      this.currentTitle = snap.title;
    }
    const cdp = this.getCdp(browser);
    if (!cdp?.connected || typeof cdp.send !== "function") return;
    const cdpSend = cdp.send.bind(cdp);
    let gotScreencastFrame = false;
    const unsubFrame = subscribeCdpEvent(cdp, "Page.screencastFrame", (raw) => {
      const p = raw as CdpScreencastFramePayload | undefined;
      if (!p || typeof p.data !== "string") return;
      gotScreencastFrame = true;
      void cdpSend("Page.screencastFrameAck", { sessionId: p.sessionId }).catch(() => undefined);
      this.deps.onFrame({
        engine: this.activeEngine, tab: "browser", mimeType: "image/jpeg", dataBase64: p.data,
        width: Math.round(p.metadata?.deviceWidth ?? STUDIO_BROWSER_WIDTH) || STUDIO_BROWSER_WIDTH,
        height: Math.round(p.metadata?.deviceHeight ?? STUDIO_BROWSER_HEIGHT) || STUDIO_BROWSER_HEIGHT,
        seq: this.deps.nextFrameSeq(), ts: Date.now(),
        ...(this.currentUrl ? { url: this.currentUrl } : {}), ...(this.currentTitle ? { title: this.currentTitle } : {}),
        ...(this.deps.getCursor() ? { cursor: this.deps.getCursor() } : {}),
      });
    });
    const unsubNav = subscribeCdpEvent(cdp, "Page.frameNavigated", (raw) => {
      const f = (raw as { frame?: { parentId?: string; url?: string } } | undefined)?.frame;
      if (f && !f.parentId && typeof f.url === "string") {
        this.currentUrl = f.url.startsWith("data:text/html") ? "about:qianji-live-view" : f.url;
      }
    });
    this.detachListeners = () => { unsubFrame(); unsubNav(); };
    this.streaming = true;
    await cdpSend("Page.startScreencast", {
      format: "jpeg", quality: 82, maxWidth: STUDIO_BROWSER_WIDTH, maxHeight: STUDIO_BROWSER_HEIGHT, everyNthFrame: 1,
    });
    if (!gotScreencastFrame) {
      const initial = await browser.screenshot(false).catch(() => null);
      if (initial?.data && !gotScreencastFrame) {
        this.deps.onFrame({
          engine, tab: "browser", mimeType: "image/png", dataBase64: initial.data,
          width: STUDIO_BROWSER_WIDTH, height: STUDIO_BROWSER_HEIGHT, seq: this.deps.nextFrameSeq(), ts: Date.now(),
          url: initial.snapshot.url.startsWith("data:text/html") ? "about:qianji-live-view" : initial.snapshot.url,
          title: initial.snapshot.title, ...(this.deps.getCursor() ? { cursor: this.deps.getCursor() } : {}),
        });
      }
    }
  }

  async stop(): Promise<void> {
    if (this.detachListeners) { this.detachListeners(); this.detachListeners = null; }
    if (!this.streaming) return;
    this.streaming = false;
    const cdp = this.getCdp(this.deps.getBrowser());
    if (cdp?.connected && typeof cdp.send === "function") await cdp.send("Page.stopScreencast").catch(() => undefined);
  }

  async dispatchInput(event: BotComputerInputEvent): Promise<void> {
    const browser = this.deps.getBrowser();
    await browser.ensureStarted(true);
    await this.ensureViewport(browser);
    const cdp = this.getCdp(browser);
    const modifiers = encodeCdpModifiers(event.modifiers);
    const sx = event.viewportWidth && event.viewportWidth > 0 ? STUDIO_BROWSER_WIDTH / event.viewportWidth : 1;
    const sy = event.viewportHeight && event.viewportHeight > 0 ? STUDIO_BROWSER_HEIGHT / event.viewportHeight : 1;
    const x = Math.max(0, Math.min(STUDIO_BROWSER_WIDTH, Math.round((event.x ?? 640) * sx)));
    const y = Math.max(0, Math.min(STUDIO_BROWSER_HEIGHT, Math.round((event.y ?? 400) * sy)));
    if (!cdp?.connected || typeof cdp.send !== "function") {
      if (event.kind === "mouse" && event.mouseAction !== "move" && event.mouseAction !== "up") await browser.clickAt(x, y);
      else if (event.kind === "wheel") await browser.scroll(Math.round(event.deltaX ?? 0), Math.round(event.deltaY ?? 0));
      else if ((event.kind === "text" || event.kind === "paste") && event.text) await browser.type(undefined, ":focus", event.text);
      else if (event.kind === "key" && event.key) await browser.press(event.key);
      return;
    }
    const button = event.button ?? "left";
    const buttons = button === "right" ? 2 : button === "middle" ? 4 : 1;
    if (event.kind === "mouse") {
      const act = event.mouseAction ?? "click";
      if (act === "move") await cdp.send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y, button: "none", modifiers });
      else if (act === "down") await cdp.send("Input.dispatchMouseEvent", { type: "mousePressed", x, y, button, buttons, clickCount: 1, modifiers });
      else if (act === "up") await cdp.send("Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button, buttons: 0, clickCount: 1, modifiers });
      else if (act === "double-click") {
        await cdp.send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y, modifiers });
        for (const clickCount of [1, 2]) {
          await cdp.send("Input.dispatchMouseEvent", { type: "mousePressed", x, y, button, buttons, clickCount, modifiers });
          await cdp.send("Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button, buttons: 0, clickCount, modifiers });
        }
      } else if (typeof event.endX === "number" && typeof event.endY === "number") {
        const ex = Math.max(0, Math.min(STUDIO_BROWSER_WIDTH, Math.round(event.endX * sx)));
        const ey = Math.max(0, Math.min(STUDIO_BROWSER_HEIGHT, Math.round(event.endY * sy)));
        await cdp.send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y, modifiers });
        await cdp.send("Input.dispatchMouseEvent", { type: "mousePressed", x, y, button, buttons, clickCount: 1, modifiers });
        await cdp.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: ex, y: ey, button, buttons, modifiers });
        await cdp.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: ex, y: ey, button, buttons: 0, clickCount: 1, modifiers });
      } else {
        await cdp.send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y, modifiers });
        await cdp.send("Input.dispatchMouseEvent", { type: "mousePressed", x, y, button, buttons, clickCount: 1, modifiers });
        await cdp.send("Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button, buttons: 0, clickCount: 1, modifiers });
      }
    } else if (event.kind === "wheel") {
      await cdp.send("Input.dispatchMouseEvent", { type: "mouseWheel", x, y, deltaX: Math.round(event.deltaX ?? 0), deltaY: Math.round(event.deltaY ?? 0), modifiers });
    } else if (event.kind === "text" || event.kind === "paste") {
      if (event.text) await cdp.send("Input.insertText", { text: event.text });
    } else if (event.kind === "key" && event.key) {
      const desc = resolveCdpKeyDescriptor(event.key, event.modifiers, event.text);
      if (desc) {
        await cdp.send("Input.dispatchKeyEvent", { type: "keyDown", ...desc });
        await cdp.send("Input.dispatchKeyEvent", { type: "keyUp", ...desc, text: undefined, unmodifiedText: undefined });
      } else if ((modifiers & (1 | 2 | 4)) === 0 && (event.text || event.key)) {
        await cdp.send("Input.insertText", { text: event.text ?? event.key });
      }
    }
  }

  async dispose(): Promise<void> { await this.stop(); }
}

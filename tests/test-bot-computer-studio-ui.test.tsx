/**
 * Frontend UI integration tests for OpenMausBot-crafted 「千机的电脑 (Qianji's Computer)」:
 * 1. Strict 3-column layout (`#bot-right-wrap` `380px–680px` default `420px` replaces `BotCompanionPanel`
 *    when open — zero 4-column squeeze, zero duplicate mini PiP) & chat topbar `🖥️` toggle button.
 * 2. Single-row 40px minimal header (`⚙️`, `[桌面 | 浏览器 | 终端 | 文件]`, `✕`), Desktop tab states
 *    (real `@novnc/novnc` `BotVncCanvas` + fullscreen workspace, unprovisioned Linux, Windows Child
 *    Session 3-tier onboarding + `open-native-desktop`), 2-button action row, and `运行位置` (`Runs on`) card.
 * 3. `16:10` zero-letterbox Browser viewport, AI cursor + ripple, seamless takeover, and pixel-accurate
 *    `imgRef` bounding-rect coordinate clamping.
 * 4. Real `@xterm/xterm` PTY session bridge (`open`/`write`/`resize`/stream), `/workspace` Files tab,
 *    and `2x2` Virtual Server Console settings.
 */
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Context } from "@deepseek-ai/cordis";
import { ClientSlotsService, SlotRegistry, SlotRoot } from "@qianji/client-slots";
import type {
  BotComputerStudioSnapshot,
  BotLocalLinuxDesktopStatus,
  BotLocalWinPipStatus,
} from "@qianji/protocol";
import { botModePlugin } from "../src/builtin-plugins/bot-mode";
import {
  botDataStore, botUiStore, FALLBACK_BOT_SNAPSHOT, INITIAL_BOT_UI_STATE, openBotLiveView, openBotModal,
} from "../src/builtin-plugins/bot-mode/botStore";
import {
  applyComputerEventNotification, applyComputerStudioSnapshot, attachPtyXtermSession,
  buildKeyInputEvent, buildMouseInputEvent, buildPasteInputEvent, buildWheelInputEvent,
  clampStudioWidth, closeComputerStudio, computerStudioSnapshotStore, DEFAULT_STUDIO_WIDTH,
  FALLBACK_COMPUTER_STUDIO_SNAPSHOT, openComputerStudio, openDesktopRfb, pasteOnDesktop,
  patchComputerStudioUi, resetComputerStudioStores, setComputerScrubIndex, toggleComputerStudio,
  typeOnDesktop, useComputerStudio,
} from "../src/builtin-plugins/bot-mode/computer-studio";
import { coreShellPlugin } from "../src/builtin-plugins/core-shell";
import { registerFrontendServices } from "../src/kernel/services";

const SAMPLE_PNG_B64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";

async function createStudioHarness(
  rpcResponder?: (method: string, params?: Record<string, unknown>) => unknown,
) {
  const root = new Context();
  const registry = new SlotRegistry();
  await root.plugin(ClientSlotsService, registry);
  await registerFrontendServices(root, { shortcutTarget: null });

  const rpcCalls: Array<{ method: string; params: Record<string, unknown> | undefined }> = [];
  vi.spyOn(root.rpcService, "call").mockImplementation(
    async <T,>(method: string, params?: Record<string, unknown>) => {
      rpcCalls.push({ method, params });
      if (rpcResponder) {
        const custom = rpcResponder(method, params);
        if (custom !== undefined) return custom as T;
      }
      return {} as T;
    },
  );

  const shellFiber = await root.plugin(coreShellPlugin);
  const botFiber = await root.plugin(botModePlugin);
  root.navigationService.setShellMode("bot", { persist: false });

  let latestStudio: ReturnType<typeof useComputerStudio> | null = null;
  function StudioProbe() {
    latestStudio = useComputerStudio(root);
    return null;
  }

  return {
    root,
    rpcCalls,
    getStudio: () => {
      renderToStaticMarkup(createElement(StudioProbe));
      if (latestStudio === null) throw new Error("Failed to capture useComputerStudio");
      return latestStudio;
    },
    renderHtml: () => renderToStaticMarkup(createElement(SlotRoot, { registry, ctx: root })),
    dispose: async () => {
      await botFiber.dispose();
      await shellFiber.dispose();
    },
  };
}

describe("OpenMausBot-Style Computer Panel (3-Column Layout, VNC, Child Session, 16:10 Browser & Xterm)", () => {
  const cleanups: Array<() => Promise<void>> = [];

  afterEach(async () => {
    vi.restoreAllMocks();
    resetComputerStudioStores();
    botUiStore.set(INITIAL_BOT_UI_STATE);
    botDataStore.set(FALLBACK_BOT_SNAPSHOT);
    while (cleanups.length > 0) {
      const fn = cleanups.pop();
      if (fn) await fn();
    }
  });

  it("enforces strict 3-column layout, chat header 🖥️ toggle, and borderless companion trigger with zero duplicate screens", async () => {
    const harness = await createStudioHarness();
    cleanups.push(harness.dispose);

    expect(DEFAULT_STUDIO_WIDTH).toBe(420);
    expect(clampStudioWidth(200)).toBe(380);
    expect(clampStudioWidth(1200)).toBe(680);

    const closedHtml = harness.renderHtml();
    expect(closedHtml).toContain('data-testid="bot-header-computer-btn"');
    expect(closedHtml).toContain('aria-pressed="false"');
    expect(closedHtml).toContain('data-testid="bot-companion-panel"');
    expect(closedHtml).toContain('data-testid="bot-vserver-pill"');
    expect(closedHtml).toContain('data-testid="bot-open-computer-studio-btn"');
    expect(closedHtml).not.toContain('data-testid="bot-computer-mini-pip"');
    expect(closedHtml).not.toContain('data-testid="bot-computer-studio-pane"');

    toggleComputerStudio();
    const openHtml = harness.renderHtml();
    expect(openHtml).toContain('data-studio-open="true"');
    expect(openHtml).toContain('aria-pressed="true"');
    expect(openHtml).toContain("width:420px");
    expect(openHtml).toContain('data-testid="bot-computer-studio-resizer"');
    expect(openHtml).toContain('data-testid="bot-computer-studio-pane"');
    expect(openHtml).not.toContain('data-testid="bot-companion-panel"');
    expect(openHtml).not.toContain("qj-cs-split-pane");

    closeComputerStudio();
    const restoredHtml = harness.renderHtml();
    expect(restoredHtml).toContain('data-testid="bot-companion-panel"');
    expect(restoredHtml).not.toContain('data-testid="bot-computer-studio-pane"');

    openBotLiveView("https://example.com/login");
    const modalHtml = harness.renderHtml();
    expect(modalHtml).toContain('data-testid="bot-liveview-modal"');
    expect(modalHtml).toContain('data-testid="bot-computer-studio-pane"');
  });

  it("renders single-row header, VNC canvas + fullscreen workspace, Win Child Session onboarding, and Runs-on card", async () => {
    const harness = await createStudioHarness();
    cleanups.push(harness.dispose);

    openComputerStudio({ engine: "local-linux", tab: "desktop" });
    const unprovHtml = harness.renderHtml();
    for (const id of ["computer-open-settings-btn", "computer-view-tabs", "computer-tab-desktop", "computer-tab-browser", "computer-tab-terminal", "computer-tab-files", "computer-close-btn"]) {
      expect(unprovHtml).toContain(`data-testid="${id}"`);
    }
    for (const removed of ["win-pip-quick-bar", "win-pip-launch-notepad", "computer-desktop-window-bar", "computer-autofollow-toggle"]) {
      expect(unprovHtml).not.toContain(`data-testid="${removed}"`);
    }
    expect(unprovHtml).toContain("千机的屏幕");
    expect(unprovHtml).toContain("本地 Linux 桌面尚未启动");
    expect(unprovHtml).toContain('data-testid="computer-start-linux-btn"');
    expect(unprovHtml).toContain('data-testid="computer-takeover-btn"');
    expect(unprovHtml).toContain('data-testid="computer-sleep-btn"');
    expect(unprovHtml).toContain('data-testid="computer-engine-switcher"');
    expect(unprovHtml).toContain("运行位置");
    expect(unprovHtml).not.toContain('data-testid="remote-node-lease-bar"');

    const vncLinux: BotLocalLinuxDesktopStatus = {
      distro: "Ubuntu-24.04", guiReady: true, display: ":99", resolution: "1280x800", chromiumReady: true,
      vncReady: true, vncWsUrl: "ws://127.0.0.1:49152/vnc/test-placeholder",
    };
    computerStudioSnapshotStore.set((prev) => ({
      ...prev, localLinux: vncLinux, takeover: { status: "active", engine: "local-linux", tab: "desktop" },
    }));
    patchComputerStudioUi({ expandedDesktop: true });
    const vncHtml = harness.renderHtml();
    expect(vncHtml).toContain('data-testid="computer-vnc-canvas"');
    expect(vncHtml).toContain('data-view-only="false"');
    expect(vncHtml).toContain('data-testid="computer-vnc-expanded-header"');
    expect(vncHtml).toContain("退出全屏");
    expect(vncHtml).toContain("✓ 交还千机");
    patchComputerStudioUi({ expandedDesktop: false });

    const sentKeys: Array<{ keysym: number; code: string | null; down?: boolean }> = [];
    let pastedClip = "";
    const mockRfb = {
      viewOnly: false, scaleViewport: false, background: "",
      clipboardPasteFrom: (t: string) => { pastedClip = t; },
      sendKey: (keysym: number, code: string | null, down?: boolean) => { sentKeys.push({ keysym, code, down }); },
      disconnect: vi.fn(), addEventListener: vi.fn(),
    };
    pasteOnDesktop(mockRfb, "hello-vnc", null);
    expect(pastedClip).toBe("hello-vnc");
    expect(sentKeys.some((k) => k.keysym === 0x76 && k.code === "KeyV")).toBe(true);
    sentKeys.length = 0;
    typeOnDesktop(mockRfb, "A中\n");
    expect(sentKeys[0]?.keysym).toBe(65);
    expect(sentKeys[1]?.keysym).toBe(0x01000000 | ("中".codePointAt(0) ?? 0));
    expect(sentKeys[2]?.keysym).toBe(0xff0d);

    const rfbCtrl = new AbortController();
    class MockRfbCtor {
      scaleViewport = false; viewOnly = false; background = "";
      disconnect = vi.fn(); clipboardPasteFrom = vi.fn(); sendKey = vi.fn(); addEventListener = vi.fn();
    }
    const opened = await openDesktopRfb({ addEventListener: vi.fn() } as unknown as HTMLElement, "ws://127.0.0.1:49152/vnc/test-placeholder", {
      viewOnly: true, signal: rfbCtrl.signal, events: { connected: vi.fn(), disconnected: vi.fn() }, RfbCtor: MockRfbCtor as never,
    });
    expect(opened.scaleViewport).toBe(true);
    expect(opened.viewOnly).toBe(true);
    rfbCtrl.abort();

    const studio = harness.getStudio();
    await studio.selectStudio({ engine: "local-win-pip" });
    expect(harness.renderHtml()).toContain('data-testid="computer-enable-win-desktop-btn"');

    const signOutWin: BotLocalWinPipStatus = {
      accountMode: "current-user", backend: "rdp-child-session", proSupported: true,
      childSessionEnabled: true, signOutRequired: true, desktopName: "QianjiChildSession", fencedRoots: [], openWindows: [],
    };
    computerStudioSnapshotStore.set((prev) => ({ ...prev, localWinPip: signOutWin }));
    expect(harness.renderHtml()).toContain("请注销并重新登录一次 Windows 以激活免密独立桌面");

    computerStudioSnapshotStore.set((prev) => ({ ...prev, localWinPip: { ...signOutWin, signOutRequired: false, childSessionActive: true } }));
    expect(harness.renderHtml()).toContain('data-testid="computer-open-native-win-btn"');
    await studio.runEngineAction({ engine: "local-win-pip", action: "open-native-desktop" });
    expect(harness.rpcCalls).toContainEqual({ method: "bot.computer.action", params: { engine: "local-win-pip", action: "open-native-desktop" } });

    await studio.selectStudio({ engine: "remote-pc" });
    expect(harness.renderHtml()).toContain('data-testid="remote-node-lease-bar"');
  });

  it("computes pixel-accurate mouse & wheel coordinates strictly from imgRef bounding rect in 16:10 Browser tab", async () => {
    const harness = await createStudioHarness();
    cleanups.push(harness.dispose);

    openComputerStudio({ engine: "local-linux", tab: "browser" });
    // Desktop frame must NOT bleed into Browser tab, and welcome URL keeps clean address bar draft
    applyComputerEventNotification({
      kind: "frame",
      frame: {
        engine: "local-linux", tab: "desktop", mimeType: "image/png", dataBase64: SAMPLE_PNG_B64,
        width: 1280, height: 800, seq: 1, ts: 1732752090_000, title: "Desktop 1x1",
      },
    });
    expect(harness.renderHtml()).toContain('data-testid="computer-viewport-placeholder"');
    expect(harness.renderHtml()).not.toContain('data-testid="computer-viewport-frame"');

    applyComputerEventNotification({
      kind: "frame",
      frame: {
        engine: "local-linux", tab: "browser", mimeType: "image/png", dataBase64: SAMPLE_PNG_B64,
        width: 1280, height: 800, seq: 2, ts: 1732752095_000, url: "about:qianji-live-view", title: "千机分身隔离浏览器",
      },
    });
    const welcomeBrowserHtml = harness.renderHtml();
    expect(welcomeBrowserHtml).toContain('data-testid="computer-viewport-frame"');
    expect(welcomeBrowserHtml).toContain('value="https://example.com"');
    expect(welcomeBrowserHtml).not.toContain('value="about:qianji-live-view"');

    applyComputerEventNotification({
      kind: "frame",
      frame: {
        engine: "local-linux", tab: "browser", mimeType: "image/jpeg", dataBase64: SAMPLE_PNG_B64,
        width: 1280, height: 800, seq: 3, ts: 1732752100_000, url: "https://github.com/login", title: "Sign in to GitHub",
        cursor: { x: 640, y: 400, viewportWidth: 1280, viewportHeight: 800, action: "click", label: "千机", ts: 1732752100_000 },
      },
    });

    const watchHtml = harness.renderHtml();
    expect(watchHtml).toContain('data-testid="computer-viewport-frame"');
    expect(watchHtml).toContain('data-testid="computer-ai-cursor"');
    expect(watchHtml).not.toContain('data-testid="computer-timeline-bar"');

    applyComputerEventNotification({
      kind: "takeover",
      takeover: { status: "requested", reason: "请输入二次验证码", targetUrlOrApp: "https://github.com", tab: "browser" },
    });
    expect(harness.renderHtml()).toContain('data-testid="computer-takeover-prompt"');

    const studio = harness.getStudio();
    await studio.triggerTakeover({ action: "start", engine: "local-linux", tab: "browser" });
    expect(harness.renderHtml()).toContain('data-testid="computer-takeover-active-banner"');

    const outerRect = { left: 0, top: 0, width: 800, height: 600 };
    const imgRect = { left: 80, top: 100, width: 640, height: 400 };
    const noMods = { ctrlKey: false, shiftKey: false, altKey: false, metaKey: false };

    const midClick = buildMouseInputEvent({
      mouseAction: "down", button: 0, clientX: 400, clientY: 300,
      rect: outerRect, imgRect, vpWidth: 1280, vpHeight: 800, modifiers: noMods,
    });
    expect(midClick).toMatchObject({ kind: "mouse", mouseAction: "down", button: "left", x: 640, y: 400 });

    const clampedClick = buildMouseInputEvent({
      mouseAction: "click", button: 0, clientX: 10, clientY: 20,
      rect: outerRect, imgRect, vpWidth: 1280, vpHeight: 800, modifiers: noMods,
    });
    expect(clampedClick).toMatchObject({ x: 0, y: 0 });

    await studio.sendInput(midClick);
    const wheelEvt = buildWheelInputEvent({ deltaX: 0, deltaY: 120, clientX: 400, clientY: 300, rect: outerRect, imgRect, vpWidth: 1280, vpHeight: 800, modifiers: noMods });
    if (wheelEvt !== null) await studio.sendInput(wheelEvt);
    const keyEvt = buildKeyInputEvent({ key: "8", ...noMods });
    if (keyEvt !== "allow-native-paste") await studio.sendInput(keyEvt);
    const pasteEvt = buildPasteInputEvent("otp-123456");
    if (pasteEvt !== null) await studio.sendInput(pasteEvt);

    const inputCalls = harness.rpcCalls.filter((c) => c.method === "bot.computer.input");
    expect(inputCalls).toHaveLength(4);
    expect(inputCalls[0]?.params).toMatchObject({ kind: "mouse", x: 640, y: 400 });
    expect(inputCalls[1]?.params).toMatchObject({ kind: "wheel", x: 640, y: 400, deltaY: 120 });
  });

  it("wires real xterm.js PTY session bridge, Timeline Scrubber, /workspace Files tab, and 2x2 Settings Console", async () => {
    const harness = await createStudioHarness((method, params) => {
      if (method === "bot.computer.files.list") {
        return {
          engine: "local-linux", cwd: String(params?.path ?? "/workspace"),
          entries: [
            { name: "docs", path: "/workspace/docs", isDir: true, sizeBytes: 0, updatedAt: 1732752200_000 },
            { name: "notes.md", path: "/workspace/notes.md", isDir: false, sizeBytes: 512, updatedAt: 1732752200_000 },
          ],
        };
      }
      if (method === "bot.computer.files.read") {
        return { path: "/workspace/notes.md", content: "# Project Notes\nClean OpenMausBot craft.", sizeBytes: 40, isBinary: false, mimeType: "text/markdown" };
      }
      return undefined;
    });
    cleanups.push(harness.dispose);

    openComputerStudio({ engine: "local-linux", tab: "browser" });
    applyComputerEventNotification({
      kind: "timeline",
      step: { id: "s1", seq: 1, ts: 1732752100_000, engine: "local-linux", tab: "browser", title: "打开文档站点", thumbnailBase64: SAMPLE_PNG_B64, status: "completed" },
    });
    expect(harness.renderHtml()).toContain('data-testid="computer-timeline-bar"');
    setComputerScrubIndex(0);
    expect(harness.renderHtml()).toContain("历史回放 · 打开文档站点");
    setComputerScrubIndex(null);

    const studio = harness.getStudio();
    await studio.selectStudio({ tab: "terminal" });
    expect(harness.renderHtml()).toContain('data-testid="computer-terminal-view"');
    expect(harness.renderHtml()).toContain('data-testid="computer-xterm-host"');

    const termWrites: string[] = [];
    let onDataCb: ((d: string) => void) | null = null;
    const mockTerm = {
      cols: 112, rows: 32,
      write: (d: string) => { termWrites.push(d); },
      clear: vi.fn(), dispose: vi.fn(),
      onData: (cb: (d: string) => void) => { onDataCb = cb; return { dispose: vi.fn() }; },
    };
    const detachXterm = attachPtyXtermSession({
      container: { clientWidth: 400, clientHeight: 280 } as HTMLElement,
      engine: "local-linux", term: mockTerm, fitAddon: { fit: vi.fn() },
      openPty: studio.openPty, writePty: studio.writePty, resizePty: studio.resizePty,
    });
    expect(harness.rpcCalls).toContainEqual({ method: "bot.computer.pty.open", params: { engine: "local-linux", cols: 112, rows: 32 } });

    applyComputerEventNotification({ kind: "pty", sessionId: "pty-x1", engine: "local-linux", chunk: "ubuntu@qianji:~$ ls\r\n", alive: true, updatedAt: 1732752300_000 });
    expect(termWrites).toContain("ubuntu@qianji:~$ ls\r\n");

    const triggerData = onDataCb as ((d: string) => void) | null;
    triggerData?.("pwd\r");
    triggerData?.("l");
    triggerData?.("x");
    triggerData?.("\x7f");
    triggerData?.("s");
    triggerData?.("\r");
    await studio.resizePty(120, 36);
    expect(harness.rpcCalls).toContainEqual({ method: "bot.computer.pty.write", params: { engine: "local-linux", sessionId: "pty-x1", data: "pwd\r" } });
    expect(harness.rpcCalls).toContainEqual({ method: "bot.computer.pty.write", params: { engine: "local-linux", sessionId: "pty-x1", data: "ls\r" } });
    expect(harness.rpcCalls).toContainEqual({ method: "bot.computer.pty.resize", params: { engine: "local-linux", sessionId: "pty-x1", cols: 120, rows: 36 } });
    detachXterm();

    await studio.selectStudio({ tab: "files" });
    await studio.listFiles("/workspace");
    await studio.readFile("/workspace/notes.md");
    const filesHtml = harness.renderHtml();
    expect(filesHtml).toContain('data-testid="computer-files-view"');
    expect(filesHtml).toContain("# Project Notes");

    const snapWithRemote: BotComputerStudioSnapshot = {
      ...FALLBACK_COMPUTER_STUDIO_SNAPSHOT,
      remoteNodes: [{ id: "node-1", alias: "Mac mini", kind: "companion-pc", host: "100.64.0.8", port: 22, connected: true, autonomyLease: { active: true, lastSeq: 9, queuedOfflineEvents: 1 } }],
    };
    applyComputerStudioSnapshot(snapWithRemote);
    openBotModal("settings", "server");
    expect(harness.renderHtml()).toContain('data-testid="bot-vserver-console"');
  });
});

/**
 * Frontend UI integration tests for 「千机的电脑 (Qianji's Computer)」 Studio (`2x2` Virtual Computer 2.0):
 * 1. Companion `236×148` Mini PiP card (`BotComputerMiniPip`), 4 engine badges, AI cursor dot,
 *    amber takeover pulse, and quick `"打开分身电脑"` trigger next to `bot-vserver-pill`.
 * 2. Resizable side-by-side `BotComputerStudioPane` in `BotStage` + `modal === "live-view"`
 *    compatibility (`data-testid="bot-liveview-modal"`), `2x2` engine switcher, `local-win-pip`
 *    non-hijacking quick launch bar, 4-tab bar, and `自动跟随` toggle.
 * 3. Live `BotComputerViewport` with smooth AI cursor + click ripple, seamless takeover request
 *    prompt, and direct canvas pointer/wheel/key/paste input forwarding to `bot.computer.input`.
 * 4. Timeline Scrubber, stateful PTY & `/workspace` File Explorer, and `2x2` `VirtualServerConsole`.
 */
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Context } from "@deepseek-ai/cordis";
import { ClientSlotsService, SlotRegistry, SlotRoot } from "@qianji/client-slots";
import type { BotComputerStudioSnapshot } from "@qianji/protocol";
import { botModePlugin } from "../src/builtin-plugins/bot-mode";
import {
  botDataStore, botUiStore, FALLBACK_BOT_SNAPSHOT, INITIAL_BOT_UI_STATE, openBotLiveView, openBotModal,
} from "../src/builtin-plugins/bot-mode/botStore";
import {
  applyComputerEventNotification, applyComputerStudioSnapshot, buildKeyInputEvent, buildMouseInputEvent,
  buildPasteInputEvent, buildWheelInputEvent, clampStudioWidth, computerStudioSnapshotStore,
  computerStudioUiStore, FALLBACK_COMPUTER_STUDIO_SNAPSHOT, openComputerStudio, patchComputerStudioUi,
  resetComputerStudioStores, setComputerScrubIndex, useComputerStudio,
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

describe("Qianji's Computer Studio UI (`2x2` Engines, Mini PiP, Direct Takeover, PTY, Files & Timeline)", () => {
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

  it("renders 236x148 Mini PiP card with 4 engine badges, AI cursor dot, amber takeover pulse, and quick trigger", async () => {
    const harness = await createStudioHarness();
    cleanups.push(harness.dispose);

    const idleHtml = harness.renderHtml();
    expect(idleHtml).toContain('data-testid="bot-vserver-pill"');
    expect(idleHtml).toContain('data-testid="bot-open-computer-studio-btn"');
    expect(idleHtml).toContain("打开分身电脑");
    expect(idleHtml).toContain('data-testid="bot-computer-mini-pip"');
    expect(idleHtml).toContain("Linux 桌面");

    applyComputerEventNotification({
      kind: "frame",
      frame: {
        engine: "local-win-pip",
        tab: "desktop",
        mimeType: "image/png",
        dataBase64: SAMPLE_PNG_B64,
        width: 1280,
        height: 800,
        seq: 1,
        ts: 1732752000_000,
        title: "Windows 多开桌面 · Chrome",
        cursor: { x: 640, y: 400, viewportWidth: 1280, viewportHeight: 800, action: "click", label: "千机", ts: 1732752000_000 },
      },
    });
    computerStudioSnapshotStore.set((prev) => ({ ...prev, activeEngine: "local-win-pip" }));

    const winPipHtml = harness.renderHtml();
    expect(winPipHtml).toContain("Win 多开副屏");
    expect(winPipHtml).toContain('data-testid="bot-mini-pip-cursor"');
    expect(winPipHtml).toContain("left:50%");
    expect(winPipHtml).toContain("top:50%");

    computerStudioSnapshotStore.set((prev) => ({ ...prev, activeEngine: "remote-vm" }));
    expect(harness.renderHtml()).toContain("远程 VM");

    computerStudioSnapshotStore.set((prev) => ({ ...prev, activeEngine: "remote-pc" }));
    expect(harness.renderHtml()).toContain("远程电脑");

    applyComputerEventNotification({
      kind: "takeover",
      takeover: {
        status: "requested",
        reason: "需要扫码登录企业微信",
        targetUrlOrApp: "https://work.weixin.qq.com",
        engine: "local-win-pip",
        tab: "browser",
      },
    });
    const alertHtml = harness.renderHtml();
    expect(alertHtml).toContain("is-takeover-alert");
    expect(alertHtml).toContain("待接管");
    expect(alertHtml).toContain("需要扫码登录企业微信");
  });

  it("mounts resizable side-by-side Computer Studio pane, 2x2 engine switcher, local-win-pip quick bar, and live-view modal", async () => {
    const harness = await createStudioHarness();
    cleanups.push(harness.dispose);

    expect(clampStudioWidth(200)).toBe(440);
    expect(clampStudioWidth(1400)).toBe(960);

    openComputerStudio({ engine: "local-win-pip", tab: "desktop" });
    patchComputerStudioUi({ studioWidth: 640 });
    computerStudioSnapshotStore.set((prev) => ({
      ...prev,
      localWinPip: {
        accountMode: "current-user",
        backend: "win32-secondary-desktop",
        proSupported: true,
        childSessionEnabled: false,
        desktopName: "QianjiBotDesktop",
        fencedRoots: ["D:/Workspace"],
        openWindows: [{ hwnd: "0x1024", title: "独立多开记事本", app: "notepad.exe" }],
        resolution: "1440×900",
      },
    }));

    const splitHtml = harness.renderHtml();
    expect(splitHtml).toContain('data-studio-open="true"');
    expect(splitHtml).toContain('data-testid="bot-computer-studio-resizer"');
    expect(splitHtml).toContain('data-testid="bot-computer-studio-pane"');
    expect(splitHtml).toContain("本地 Linux 桌面");
    expect(splitHtml).toContain("本地 Win 多开桌面");
    expect(splitHtml).toContain("远程虚拟机");
    expect(splitHtml).toContain("远程个人电脑");
    expect(splitHtml).toContain('data-testid="win-pip-quick-bar"');
    expect(splitHtml).toContain("当前账号派生不抢鼠标");
    expect(splitHtml).toContain('data-testid="win-pip-launch-browser"');
    expect(splitHtml).toContain('data-testid="win-pip-launch-explorer"');
    expect(splitHtml).toContain('data-testid="win-pip-launch-notepad"');
    expect(splitHtml).toContain("独立多开记事本");
    expect(splitHtml).toContain("1440×900");
    expect(splitHtml).toContain("桌面全景");
    expect(splitHtml).toContain("浏览器");
    expect(splitHtml).toContain("终端");
    expect(splitHtml).toContain("文件");
    expect(splitHtml).toContain('data-testid="computer-autofollow-toggle"');
    expect(splitHtml).toContain("🤚 接管控制");

    const studio = harness.getStudio();
    await studio.selectStudio({ engine: "remote-pc", tab: "browser", autoFollow: true });
    expect(harness.rpcCalls).toContainEqual({
      method: "bot.computer.select",
      params: { engine: "remote-pc", tab: "browser", autoFollow: true },
    });

    await studio.runEngineAction({
      engine: "local-win-pip",
      action: "launch-app",
      launchKind: "browser",
      appOrUrl: "https://github.com",
    });
    expect(harness.rpcCalls).toContainEqual({
      method: "bot.computer.action",
      params: { engine: "local-win-pip", action: "launch-app", launchKind: "browser", appOrUrl: "https://github.com" },
    });

    patchComputerStudioUi({ studioOpen: false });
    openBotLiveView("https://github.com/login");
    const modalHtml = harness.renderHtml();
    expect(modalHtml).toContain('data-testid="bot-liveview-modal"');
    expect(modalHtml).toContain('data-testid="bot-computer-studio-pane"');
  });

  it("renders AI Virtual Cursor + click ripple in Watch mode and forwards direct canvas inputs in Takeover mode", async () => {
    const harness = await createStudioHarness();
    cleanups.push(harness.dispose);

    openComputerStudio({ engine: "local-linux", tab: "browser" });
    applyComputerEventNotification({
      kind: "frame",
      frame: {
        engine: "local-linux",
        tab: "browser",
        mimeType: "image/png",
        dataBase64: SAMPLE_PNG_B64,
        width: 1280,
        height: 800,
        seq: 5,
        ts: 1732752100_000,
        url: "https://github.com/login",
        title: "Sign in to GitHub",
        cursor: { x: 320, y: 200, viewportWidth: 1280, viewportHeight: 800, action: "click", label: "千机", ts: 1732752100_000 },
      },
    });

    const watchHtml = harness.renderHtml();
    expect(watchHtml).toContain('data-testid="computer-viewport-frame"');
    expect(watchHtml).toContain('data-testid="computer-ai-cursor"');
    expect(watchHtml).toContain('data-testid="computer-ai-cursor-ripple"');
    expect(watchHtml).toContain("千机");
    expect(watchHtml).not.toContain('aria-label="向焦点元素输入文本"');

    applyComputerEventNotification({
      kind: "takeover",
      takeover: { status: "requested", reason: "请输入 GitHub 双重验证码", targetUrlOrApp: "https://github.com/sessions/two-factor" },
    });
    const reqHtml = harness.renderHtml();
    expect(reqHtml).toContain("is-takeover-requested");
    expect(reqHtml).toContain('data-testid="computer-takeover-prompt"');
    expect(reqHtml).toContain("请输入 GitHub 双重验证码");
    expect(reqHtml).toContain("立即在画面中接管");

    const studio = harness.getStudio();
    await studio.triggerTakeover({ action: "start", engine: "local-linux", tab: "browser" });
    expect(harness.rpcCalls).toContainEqual({
      method: "bot.computer.takeover",
      params: { action: "start", engine: "local-linux", tab: "browser" },
    });

    const activeHtml = harness.renderHtml();
    expect(activeHtml).toContain("is-takeover-active");
    expect(activeHtml).toContain('data-testid="computer-takeover-active-banner"');
    expect(activeHtml).toContain("✓ 已完成，交还千机");
    expect(activeHtml).not.toContain('data-testid="computer-ai-cursor"');
    expect(activeHtml).not.toContain('aria-label="向焦点元素输入文本"');

    const rect = { left: 100, top: 50, width: 640, height: 400 };
    const noMods = { ctrlKey: false, shiftKey: false, altKey: false, metaKey: false };
    await studio.sendInput(
      buildMouseInputEvent({ mouseAction: "down", button: 0, clientX: 420, clientY: 250, rect, vpWidth: 1280, vpHeight: 800, modifiers: noMods }),
    );
    const wheelEvt = buildWheelInputEvent({ deltaX: 0, deltaY: 120, clientX: 420, clientY: 250, rect, vpWidth: 1280, vpHeight: 800, modifiers: noMods });
    if (wheelEvt !== null) await studio.sendInput(wheelEvt);
    const keyEvt = buildKeyInputEvent({ key: "6", ...noMods });
    if (keyEvt !== "allow-native-paste") await studio.sendInput(keyEvt);
    expect(buildKeyInputEvent({ key: "v", ctrlKey: true, shiftKey: false, altKey: false, metaKey: false })).toBe("allow-native-paste");
    const pasteEvt = buildPasteInputEvent("otp-839201");
    if (pasteEvt !== null) await studio.sendInput(pasteEvt);

    const inputCalls = harness.rpcCalls.filter((c) => c.method === "bot.computer.input");
    expect(inputCalls).toHaveLength(4);
    expect(inputCalls[0]?.params).toMatchObject({ kind: "mouse", mouseAction: "down", button: "left", x: 640, y: 400 });
    expect(inputCalls[1]?.params).toMatchObject({ kind: "wheel", deltaY: 120 });
    expect(inputCalls[2]?.params).toMatchObject({ kind: "key", key: "6", text: "6" });
    expect(inputCalls[3]?.params).toMatchObject({ kind: "paste", text: "otp-839201" });

    await studio.triggerTakeover({ action: "release", engine: "local-linux", tab: "browser" });
    expect(computerStudioSnapshotStore.get().takeover.status).toBe("idle");
  });

  it("supports Timeline Scrubber replay + LIVE jump, stateful PTY streaming, and /workspace File Explorer preview", async () => {
    const harness = await createStudioHarness((method, params) => {
      if (method === "bot.computer.pty.write") {
        return { pty: { sessionId: "pty-1", engine: "local-linux", cwd: "/workspace/demo", alive: true, outputTail: "$ pwd\n/workspace/demo\n", updatedAt: 1732752200_000 } };
      }
      if (method === "bot.computer.files.list") {
        return {
          engine: "local-linux",
          cwd: String(params?.path ?? "/workspace"),
          entries: [
            { name: "reports", path: "/workspace/reports", isDir: true, sizeBytes: 0, updatedAt: 1732752200_000 },
            { name: "summary.md", path: "/workspace/summary.md", isDir: false, sizeBytes: 1280, updatedAt: 1732752200_000 },
          ],
        };
      }
      if (method === "bot.computer.files.read") {
        return { path: "/workspace/summary.md", content: "# Weekly Report\nAll checks green.", sizeBytes: 34, isBinary: false, mimeType: "text/markdown" };
      }
      return undefined;
    });
    cleanups.push(harness.dispose);

    openComputerStudio({ engine: "local-linux", tab: "browser" });
    applyComputerEventNotification({
      kind: "timeline",
      step: { id: "step-1", seq: 1, ts: 1732752100_000, engine: "local-linux", tab: "browser", title: "打开 GitHub Issues 列表", thumbnailBase64: SAMPLE_PNG_B64, status: "completed" },
    });
    applyComputerEventNotification({
      kind: "timeline",
      step: { id: "step-2", seq: 2, ts: 1732752150_000, engine: "local-linux", tab: "terminal", title: "执行构建测试脚本", terminalSnippet: "$ npm test\nPASS all suites", status: "running" },
    });
    expect(computerStudioSnapshotStore.get().activeTab).toBe("terminal");

    applyComputerEventNotification({
      kind: "pty", sessionId: "pty-1", engine: "local-linux", chunk: "$ uname -a\nLinux qianji-vm 6.6\n", alive: true, updatedAt: 1732752180_000,
    });
    const ptyHtml = harness.renderHtml();
    expect(ptyHtml).toContain('data-testid="computer-terminal-view"');
    expect(ptyHtml).toContain("Linux qianji-vm 6.6");
    expect(ptyHtml).toContain("2/2 · 执行构建测试脚本");

    const studio = harness.getStudio();
    await studio.writePty("cd demo && pwd\n");
    expect(harness.renderHtml()).toContain("/workspace/demo");

    setComputerScrubIndex(0);
    await studio.selectStudio({ tab: "browser" });
    const scrubHtml = harness.renderHtml();
    expect(scrubHtml).toContain("1/2 · 打开 GitHub Issues 列表");
    expect(scrubHtml).toContain("历史回放 · 打开 GitHub Issues 列表");

    setComputerScrubIndex(null);
    expect(computerStudioUiStore.get().scrubIndex).toBeNull();

    await studio.selectStudio({ tab: "files" });
    await studio.listFiles("/workspace");
    await studio.readFile("/workspace/summary.md");
    const filesHtml = harness.renderHtml();
    expect(filesHtml).toContain('data-testid="computer-files-view"');
    expect(filesHtml).toContain("reports");
    expect(filesHtml).toContain("summary.md");
    expect(filesHtml).toContain("# Weekly Report");
  });

  it("renders full 2x2 Virtual Server Console settings (Linux GUI, Win Multi-Desktop + Fence, Remote VM, and Remote PC + Autonomy Lease)", async () => {
    const harness = await createStudioHarness();
    cleanups.push(harness.dispose);

    const customSnapshot: BotComputerStudioSnapshot = {
      ...FALLBACK_COMPUTER_STUDIO_SNAPSHOT,
      activeEngine: "remote-pc",
      remoteNodes: [
        {
          id: "node-mac-mini",
          alias: "书房 Mac mini M4",
          kind: "companion-pc",
          host: "100.88.12.34",
          port: 22,
          username: "yht",
          osSummary: "macOS 15.4 arm64",
          connected: true,
          autonomyLease: { active: true, lastSeq: 42, queuedOfflineEvents: 3 },
        },
      ],
    };
    applyComputerStudioSnapshot(customSnapshot);

    openBotModal("settings", "server");
    const localSettingsHtml = harness.renderHtml();
    expect(localSettingsHtml).toContain('data-testid="bot-vserver-console"');
    expect(localSettingsHtml).toContain('data-testid="vserver-2x2-matrix-bar"');
    expect(localSettingsHtml).toContain('data-testid="vserver-local-linux-card"');
    expect(localSettingsHtml).toContain('data-testid="vserver-local-win-pip-card"');
    expect(localSettingsHtml).toContain("本地 Windows 多开虚拟桌面 · 当前账号派生不抢鼠标");
    expect(localSettingsHtml).toContain("Sentinel 受控路径围栏");

    botDataStore.set((prev) => ({ ...prev, virtualServer: { ...prev.virtualServer, mode: "remote" } }));
    const remoteSettingsHtml = harness.renderHtml();
    expect(remoteSettingsHtml).toContain('data-testid="vserver-remote-vm-card"');
    expect(remoteSettingsHtml).toContain('data-testid="vserver-remote-pc-card"');
    expect(remoteSettingsHtml).toContain("书房 Mac mini M4");
    expect(remoteSettingsHtml).toContain("自治租约 #42 · 离线缓存 3 条");
    expect(remoteSettingsHtml).toContain('data-testid="sync-lease-node-mac-mini"');
  });
});

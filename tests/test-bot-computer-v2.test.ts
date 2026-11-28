/**
 * Comprehensive unit & integration tests for Qianji Virtual Computer 2.0 (`2x2` matrix):
 * - Built-in RFB VNC WebSocket-to-TCP binary proxy (`vnc-ws-proxy.ts`) against a real mock TCP RFB server
 * - `local-linux` WSL2 Ubuntu + XFCE4 + x11vnc + `xdotool` desktop engine, `git worktree add --detach` sync, `/workspace` files
 * - Real event-driven CDP `Page.startScreencast` (`1280x800` `16:10`), `Page.screencastFrameAck`, & full `Input.dispatchKeyEvent` keycodes
 * - `local-win-pip` Child Session states (`childSessionEnabled`, `signOutRequired`, `childSessionActive`, `viewerOpen`, `open-native-desktop`), Sentinel Path Fence, zero fake windows
 * - `remote-vm` & `remote-pc` (`ssh-vm` + `companion-pc`, VNC tunnel bridge, `BotRemoteAutonomyLease` ring-buffer replay)
 * - Persistent stateful PTY (`cd` & env persistence across writes, Sentinel fence on `cd`) & `bot_request_takeover` state machine
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createServer, type AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { WebSocket } from "ws";
import { Service, type Context } from "@deepseek-ai/cordis";
import type { BrowserSession } from "@qianji/browser";
import { Credentials } from "@qianji/llm";
import type {
  BotComputerEventNotification,
  BotComputerFilesListResult,
  BotComputerFilesReadResult,
  BotComputerPtySessionInfo,
  BotComputerStreamFrame,
  BotComputerStudioSnapshot,
  BotComputerTakeoverState,
  BotDesktopNotificationPayload,
  BotRemoteComputerNode,
  BotSnapshotResult,
} from "@qianji/protocol";
import type { RpcHandler, RpcService } from "@qianji/rpc";
import { Sessions } from "@qianji/session";
import { SystemPrompt } from "@qianji/system-prompt";
import * as toolFs from "@qianji/tool-fs";
import { textOutput, Tools } from "@qianji/tools";
import { Ui } from "@qianji/ui";
import * as botPlugin from "../packages/host/src/bot/index";
import { resolveCdpKeyDescriptor } from "../packages/host/src/bot/computer/cdp-screencast";
import {
  buildXdotoolScript,
  LocalLinuxComputerEngine,
  syncIsolatedCopyWithWorktree,
} from "../packages/host/src/bot/computer/local-linux-engine";
import { quotePosixPath } from "../packages/host/src/bot/computer/remote-lease";
import { startVncWsProxy } from "../packages/host/src/bot/computer/vnc-ws-proxy";
import { resolveWinInputAction } from "../packages/host/src/bot/computer/win-helper-client";
import { BOT_NATIVE_TOOL_SCHEMAS, executeBotNativeTool } from "../packages/host/src/bot/harness/bot-tools";
import { createBotHarnessHost } from "../packages/host/src/bot/harness/bot-tools-host";
import type { WslContainerRuntime } from "../packages/host/src/bot/wsl-runtime";
import { builtinFeatureDefinitions } from "../packages/host/src/builtin-feature-defs";
import { harnessFromDesktop } from "../packages/host/src/desktop-settings";
import { createHost, type Host } from "../packages/host/src/host";

const FAKE_PNG =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";

class SpyRpc extends Service implements RpcService {
  static provide = "rpc";
  private readonly handlers = new Map<string, RpcHandler>();
  readonly broadcasts: Array<{ channel: string; payload: unknown }> = [];

  constructor(ctx: Context) {
    super(ctx, "rpc");
  }

  method(name: string, handler: RpcHandler): () => void {
    this.handlers.set(name, handler);
    return () => {
      if (this.handlers.get(name) === handler) this.handlers.delete(name);
    };
  }

  methods(): string[] {
    return ["initialize", ...this.handlers.keys()];
  }

  broadcast(channel: string, payload?: unknown): void {
    this.broadcasts.push({ channel, payload });
  }

  async invoke<T>(name: string, params: unknown = {}): Promise<T> {
    const fn = this.handlers.get(name);
    if (!fn) throw new Error(`RPC method not registered: ${name}`);
    return (await fn(params, {
      signal: new AbortController().signal,
      notify: () => undefined,
    })) as T;
  }
}

function createFakeBrowser() {
  const cdpCalls: Array<{ method: string; params?: Record<string, unknown> }> = [];
  const waiters = new Map<string, Set<(params: unknown) => void>>();
  let currentUrl = "about:blank";
  let currentTitle = "Fake Isolated Browser";
  const emitCdpEvent = (method: string, params: unknown) => {
    for (const fn of waiters.get(method) ?? []) fn(params);
  };
  const fake = {
    cdp: {
      connected: true,
      waiters,
      send: async (method: string, params?: Record<string, unknown>) => {
        cdpCalls.push({ method, params });
        return {};
      },
    },
    ensureStarted: async () => undefined,
    navigate: async (url: string) => {
      currentUrl = url;
      currentTitle = `Page ${url}`;
      return { url: currentUrl, title: currentTitle, text: "hello page", elements: [] };
    },
    inspect: async () => ({ url: currentUrl, title: currentTitle, text: "hello page", elements: [] }),
    screenshot: async () => ({
      data: FAKE_PNG,
      snapshot: { url: currentUrl, title: currentTitle, text: "hello page", elements: [] },
    }),
    click: async () => ({ url: currentUrl, title: currentTitle, text: "clicked", elements: [] }),
    clickAt: async () => ({ url: currentUrl, title: currentTitle, text: "clicked-xy", elements: [] }),
    type: async () => ({ url: currentUrl, title: currentTitle, text: "typed", elements: [] }),
    press: async (key: string) => {
      cdpCalls.push({ method: "press", params: { key } });
      return { url: currentUrl, title: currentTitle, text: "pressed", elements: [] };
    },
    scroll: async () => ({ url: currentUrl, title: currentTitle, text: "scrolled", elements: [] }),
    wait: async () => ({ url: currentUrl, title: currentTitle, text: "waited", elements: [] }),
    listTabs: async () => [{ id: "tab-1", title: currentTitle, url: currentUrl, active: true }],
    newTab: async (url?: string) => {
      if (url) currentUrl = url;
      return {
        tabs: [{ id: "tab-1", title: currentTitle, url: currentUrl, active: true }],
        snapshot: { url: currentUrl, title: currentTitle, text: "", elements: [] },
      };
    },
    switchTab: async () => ({
      tabs: [{ id: "tab-1", title: currentTitle, url: currentUrl, active: true }],
      snapshot: { url: currentUrl, title: currentTitle, text: "", elements: [] },
    }),
    closeTab: async () => ({
      tabs: [{ id: "tab-1", title: currentTitle, url: currentUrl, active: true }],
      snapshot: { url: currentUrl, title: currentTitle, text: "", elements: [] },
    }),
    close: async () => undefined,
  };
  return { browser: fake as unknown as BrowserSession, cdpCalls, emitCdpEvent };
}

describe("Virtual Computer 2.0 Host Engine (RFB VNC Proxy, Ubuntu XFCE4, CDP Screencast, Child Session, PTY & Lease)", () => {
  const tempDirs: string[] = [];
  const activeHosts: Host[] = [];

  afterEach(async () => {
    while (activeHosts.length > 0) {
      const h = activeHosts.pop();
      if (h) await h.stop();
    }
    while (tempDirs.length > 0) {
      const dir = tempDirs.pop();
      if (dir) rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  });

  async function bootBotHost(extraConfig: Partial<botPlugin.BotStoreConfig> = {}) {
    const dataDir = mkdtempSync(join(tmpdir(), "qj-comp-v2-"));
    tempDirs.push(dataDir);
    const secretMap = new Map<string, string>();
    const { browser, cdpCalls, emitCdpEvent } = createFakeBrowser();

    const host = createHost({
      version: "0.4.0-test",
      dataDir,
      plugins: [
        [SpyRpc],
        [Credentials],
        [Sessions],
        [SystemPrompt],
        [Ui],
        [Tools],
        [toolFs],
        [
          botPlugin,
          {
            dataDir,
            distroName: "qianji-bot-unit-noop",
            wslSupported: false,
            browserFactory: () => browser,
            displayName: "千机",
            ...extraConfig,
          },
        ],
      ],
    });
    await host.start();
    activeHosts.push(host);

    host.ctx.credentials.registerStore({
      resolve: (id) => Promise.resolve(secretMap.get(id)),
      set: (id, val) => { secretMap.set(id, val); },
      delete: (id) => secretMap.delete(id),
    });
    host.ctx.tools.register({
      name: "bash",
      description: "mock bash",
      parameters: { type: "object", properties: { command: { type: "string" } }, required: ["command"] },
      execute: async (args) => textOutput(`bash-out: ${String(args.command ?? "")}`),
    });
    host.ctx.tools.register({
      name: "browser_navigate",
      description: "mock browser navigate fallback",
      parameters: { type: "object", properties: { url: { type: "string" } }, required: ["url"] },
      execute: async () => textOutput("HOST_BROWSER_FALLBACK", true),
    });
    host.ctx.tools.register({
      name: "browser_click",
      description: "mock browser click fallback",
      parameters: { type: "object", properties: { x: { type: "number" }, y: { type: "number" } } },
      execute: async () => textOutput("HOST_BROWSER_FALLBACK", true),
    });

    const rpc = host.ctx.rpc as unknown as SpyRpc;
    return { host, rpc, dataDir, secretMap, cdpCalls, emitCdpEvent };
  }

  it("bridges binary RFB frames end-to-end over vnc-ws-proxy against a real mock TCP RFB server and rejects invalid tokens", async () => {
    const receivedByTcp: Buffer[] = [];
    let tcpConnections = 0;
    const rfbGreeting = Buffer.from("RFB 003.008\n", "ascii");
    const rfbFramebufferAck = Buffer.from([0x00, 0x00, 0x00, 0x01, 0xde, 0xad, 0xbe, 0xef]);

    const tcpServer = createServer((sock) => {
      tcpConnections += 1;
      sock.write(rfbGreeting);
      sock.on("data", (chunk: Buffer) => {
        receivedByTcp.push(Buffer.from(chunk));
        sock.write(rfbFramebufferAck);
      });
    });
    await new Promise<void>((res) => tcpServer.listen(0, "127.0.0.1", () => res()));
    const rfbPort = (tcpServer.address() as AddressInfo).port;

    const proxy = await startVncWsProxy({ targetPort: rfbPort, token: "placeholder" });
    try {
      expect(proxy.wsUrl).toBe(`ws://127.0.0.1:${proxy.wsPort}/vnc/placeholder`);

      // Invalid token path closes with 1008 without opening any TCP connection to VNC
      const rejectedCode = await new Promise<number>((res) => {
        const badWs = new WebSocket(`ws://127.0.0.1:${proxy.wsPort}/vnc/wrong`);
        badWs.once("close", (code) => res(code));
      });
      expect(rejectedCode).toBe(1008);
      expect(tcpConnections).toBe(0);

      // Case A: Client offering `Sec-WebSocket-Protocol: binary` negotiates `binary` and streams RFB frames
      const wsClient = new WebSocket(proxy.wsUrl, ["binary"]);
      const incomingFrames: Buffer[] = [];
      const gotTwoFrames = new Promise<void>((res, rej) => {
        const timer = setTimeout(() => rej(new Error("Timed out waiting for RFB frames (binary subprotocol)")), 5_000);
        wsClient.on("message", (data, isBinary) => {
          expect(isBinary).toBe(true);
          const buf = Buffer.isBuffer(data) ? data : Buffer.from(data as ArrayBuffer);
          incomingFrames.push(buf);
          if (incomingFrames.length === 1) {
            wsClient.send(Buffer.from([0x01, 0xaa, 0x55, 0xff]), { binary: true });
          } else if (incomingFrames.length >= 2) {
            clearTimeout(timer);
            res();
          }
        });
      });

      await gotTwoFrames;
      expect(wsClient.protocol).toBe("binary");
      expect(incomingFrames[0]?.toString("ascii")).toBe("RFB 003.008\n");
      expect(Buffer.concat(receivedByTcp).toString("hex")).toBe("01aa55ff");
      expect(incomingFrames[1]?.toString("hex")).toBe("00000001deadbeef");
      wsClient.close();

      // Case B: `@novnc/novnc` 1.7.x default (`wsProtocols: []` -> no `Sec-WebSocket-Protocol` header)
      // connects cleanly with empty protocol and exchanges raw Uint8Array/ArrayBuffer binary frames
      receivedByTcp.length = 0;
      const plainWsClient = new WebSocket(proxy.wsUrl);
      plainWsClient.binaryType = "arraybuffer";
      const plainFrames: Buffer[] = [];
      const gotPlainFrames = new Promise<void>((res, rej) => {
        const timer = setTimeout(() => rej(new Error("Timed out waiting for RFB frames (no subprotocol)")), 5_000);
        plainWsClient.on("message", (data, isBinary) => {
          expect(isBinary).toBe(true);
          expect(data).toBeInstanceOf(ArrayBuffer);
          const buf = Buffer.from(data as ArrayBuffer);
          plainFrames.push(buf);
          if (plainFrames.length === 1) {
            plainWsClient.send(new Uint8Array([0x06, 0x11, 0x22, 0x33]));
          } else if (plainFrames.length >= 2) {
            clearTimeout(timer);
            res();
          }
        });
      });

      await gotPlainFrames;
      expect(plainWsClient.protocol).toBe("");
      expect(plainFrames[0]?.toString("ascii")).toBe("RFB 003.008\n");
      expect(Buffer.concat(receivedByTcp).toString("hex")).toBe("06112233");
      expect(plainFrames[1]?.toString("hex")).toBe("00000001deadbeef");
      plainWsClient.close();
    } finally {
      await proxy.close();
      await new Promise<void>((res) => tcpServer.close(() => res()));
    }
  });

  it("provisions WSL2 Ubuntu + XFCE4 + x11vnc (removing lockers) over Alpine and dispatches xdotool on DISPLAY :99", async () => {
    const wslCalls: Array<{ args: readonly string[]; stdin?: string }> = [];
    let ubuntuRunning = false;
    const engine = new LocalLinuxComputerEngine({
      enableDistroKeepalive: false,
      wslRunner: async (_bin, args, opts) => {
        wslCalls.push({ args, stdin: opts?.stdin });
        if (args.includes("--terminate") && args.includes("Ubuntu-24.04")) ubuntuRunning = false;
        if (args.includes("-d") && args.includes("Ubuntu-24.04")) ubuntuRunning = true;
        if (args.includes("--list")) {
          return {
            stdout: `  NAME                   STATE           VERSION\n* qianji-bot-vm          Running         2\n  Ubuntu-24.04           ${ubuntuRunning ? "Running" : "Stopped"}         2\n`,
            stderr: "",
            exitCode: 0,
            durationMs: 5,
          };
        }
        if (opts?.stdin?.includes("echo GUI=")) {
          return { stdout: "GUI=1\nCHR=1\nWM=xfce4\nVNC=5900\n", stderr: "", exitCode: 0, durationMs: 5 };
        }
        return { stdout: "", stderr: "", exitCode: 0, durationMs: 10 };
      },
    });
    const fakeWsl = { distroName: "qianji-bot-vm", isSupported: () => true } as unknown as WslContainerRuntime;
    const fakeVs = { local: { distroName: "qianji-bot-vm" } } as unknown as BotSnapshotResult["virtualServer"];

    try {
      const prov = await engine.provisionGui(fakeWsl, fakeVs);
      expect(prov.ok).toBe(true);
      expect(prov.status.distro).toBe("Ubuntu-24.04");
      expect(prov.status.windowManager).toBe("xfce4");
      expect(prov.status.vncReady).toBe(true);
      expect(prov.status.vncWsUrl).toMatch(/^ws:\/\/127\.0\.0\.1:\d+\/vnc\/[0-9a-f]+$/);

      const installCall = wslCalls.find((c) => c.stdin?.includes("xvfb xfce4 x11vnc xdotool dbus-x11 fonts-noto-cjk"));
      expect(installCall?.args).toContain("Ubuntu-24.04");
      expect(installCall?.stdin).toContain("apt-get remove -y light-locker xfce4-screensaver xfce4-power-manager");
      expect(installCall?.stdin).toContain("Xvfb :99 -screen 0 1280x800x24 -ac");
      expect(installCall?.stdin).toContain("DISPLAY=:99 nohup dbus-launch startxfce4");
      expect(installCall?.stdin).toContain("x11vnc -display :99 -forever -shared -nopw -rfbport 5900");

      await engine.dispatchDesktopInput(
        { kind: "mouse", mouseAction: "click", button: "left", x: 500, y: 300 },
        fakeWsl,
        fakeVs,
        1,
      );
      await engine.dispatchDesktopInput(
        { kind: "key", key: "c", modifiers: ["ctrl"] },
        fakeWsl,
        fakeVs,
        2,
      );
      expect(wslCalls.some((c) => c.args.some((a) => a.includes("DISPLAY=:99 xdotool mousemove --sync 500 300 click 1")))).toBe(true);
      expect(wslCalls.some((c) => c.args.some((a) => a.includes("DISPLAY=:99 xdotool key --clearmodifiers ctrl+c")))).toBe(true);
      expect(buildXdotoolScript({ kind: "text", text: "你好 Ubuntu" })).toContain("xdotool type --clearmodifiers");

      await engine.stop(fakeWsl);
      const afterStop = await engine.inspectStatus(fakeWsl, fakeVs);
      expect(afterStop.guiReady).toBe(false);
    } finally {
      await engine.dispose();
    }
  });

  it("streams real CDP Page.startScreencast (1280x800 16:10) with Page.screencastFrameAck and dispatches full virtual keycodes", async () => {
    const { rpc, dataDir, cdpCalls, emitCdpEvent } = await bootBotHost();
    const wsDir = join(dataDir, "bot-workspace");
    mkdirSync(join(wsDir, "docs"), { recursive: true });
    writeFileSync(join(wsDir, "docs", "guide.md"), "# 千机分身手册\nHello Computer 2.0", "utf8");

    const botSnap = await rpc.invoke<BotSnapshotResult>("bot.getSnapshot", {});
    expect(botSnap.computerStudio?.activeEngine).toBe("local-linux");

    // Provision Linux GUI -> starts VNC WS proxy and exposes vncWsUrl
    const guiRes = await rpc.invoke<{ ok: boolean; snapshot: BotComputerStudioSnapshot }>("bot.computer.action", {
      engine: "local-linux",
      action: "provision-linux-gui",
    });
    expect(guiRes.ok).toBe(true);
    expect(guiRes.snapshot.localLinux?.display).toBe(":99");
    expect(guiRes.snapshot.localLinux?.guiReady).toBe(true);
    expect(guiRes.snapshot.localLinux?.vncReady).toBe(true);
    expect(guiRes.snapshot.localLinux?.vncWsUrl).toMatch(/^ws:\/\/127\.0\.0\.1:\d+\/vnc\//);

    const navRes = await rpc.invoke<{ ok: boolean; frame?: BotComputerStreamFrame; snapshot: BotComputerStudioSnapshot }>(
      "bot.computer.navigate",
      { url: "https://qianji.example/login", engine: "local-linux" },
    );
    expect(navRes.ok).toBe(true);
    expect(navRes.frame?.width).toBe(1280);
    expect(navRes.frame?.height).toBe(800);

    // Start real event-driven CDP screencast
    rpc.broadcasts.length = 0;
    cdpCalls.length = 0;
    await rpc.invoke("bot.computer.stream", { active: true, engine: "local-linux", tab: "browser" });

    expect(
      cdpCalls.some(
        (c) => c.method === "Emulation.setDeviceMetricsOverride" && c.params?.width === 1280 && c.params?.height === 800,
      ),
    ).toBe(true);
    expect(
      cdpCalls.some(
        (c) =>
          c.method === "Page.startScreencast" &&
          c.params?.format === "jpeg" &&
          c.params?.quality === 82 &&
          c.params?.maxWidth === 1280 &&
          c.params?.maxHeight === 800 &&
          c.params?.everyNthFrame === 1,
      ),
    ).toBe(true);

    // Emit two real CDP compositor frames and verify immediate Page.screencastFrameAck + bot/computer push
    emitCdpEvent("Page.screencastFrame", {
      data: FAKE_PNG,
      sessionId: 41,
      metadata: { deviceWidth: 1280, deviceHeight: 800 },
    });
    emitCdpEvent("Page.screencastFrame", {
      data: FAKE_PNG,
      sessionId: 42,
      metadata: { deviceWidth: 1280, deviceHeight: 800 },
    });

    expect(cdpCalls.some((c) => c.method === "Page.screencastFrameAck" && c.params?.sessionId === 41)).toBe(true);
    expect(cdpCalls.some((c) => c.method === "Page.screencastFrameAck" && c.params?.sessionId === 42)).toBe(true);
    const jpegStreamFrames = rpc.broadcasts
      .filter((b) => b.channel === "bot/computer")
      .map((b) => b.payload as BotComputerEventNotification)
      .filter((p): p is { kind: "frame"; frame: BotComputerStreamFrame } => p.kind === "frame" && p.frame.mimeType === "image/jpeg");
    expect(jpegStreamFrames.length).toBe(2);
    expect(jpegStreamFrames[0]?.frame.width).toBe(1280);
    expect(jpegStreamFrames[0]?.frame.height).toBe(800);

    // Direct mouse, wheel, paste, and real virtual keycodes over CDP
    await rpc.invoke("bot.computer.input", { engine: "local-linux", tab: "browser", kind: "mouse", mouseAction: "click", button: "right", x: 320, y: 240 });
    await rpc.invoke("bot.computer.input", { engine: "local-linux", tab: "browser", kind: "wheel", deltaX: 0, deltaY: 180, x: 320, y: 240, modifiers: ["shift"] });
    await rpc.invoke("bot.computer.input", { engine: "local-linux", tab: "browser", kind: "paste", text: "OTP-889900" });
    await rpc.invoke("bot.computer.input", { engine: "local-linux", tab: "browser", kind: "key", key: "Enter" });
    await rpc.invoke("bot.computer.input", { engine: "local-linux", tab: "browser", kind: "key", key: "Backspace" });
    await rpc.invoke("bot.computer.input", { engine: "local-linux", tab: "browser", kind: "key", key: "ArrowDown" });
    await rpc.invoke("bot.computer.input", { engine: "local-linux", tab: "browser", kind: "key", key: "a", modifiers: ["ctrl"] });

    expect(cdpCalls.some((c) => c.method === "Input.dispatchMouseEvent" && c.params?.button === "right")).toBe(true);
    expect(cdpCalls.some((c) => c.method === "Input.dispatchMouseEvent" && c.params?.type === "mouseWheel" && c.params?.modifiers === 8)).toBe(true);
    expect(cdpCalls.some((c) => c.method === "Input.insertText" && c.params?.text === "OTP-889900")).toBe(true);
    expect(cdpCalls.some((c) => c.method === "Input.dispatchKeyEvent" && c.params?.type === "keyDown" && c.params?.windowsVirtualKeyCode === 13)).toBe(true);
    expect(cdpCalls.some((c) => c.method === "Input.dispatchKeyEvent" && c.params?.type === "keyDown" && c.params?.windowsVirtualKeyCode === 8)).toBe(true);
    expect(cdpCalls.some((c) => c.method === "Input.dispatchKeyEvent" && c.params?.type === "keyDown" && c.params?.windowsVirtualKeyCode === 40)).toBe(true);
    expect(
      cdpCalls.some(
        (c) =>
          c.method === "Input.dispatchKeyEvent" &&
          c.params?.type === "keyDown" &&
          c.params?.windowsVirtualKeyCode === 65 &&
          c.params?.modifiers === 2 &&
          c.params?.text === undefined,
      ),
    ).toBe(true);

    // Unit-verify remaining keycode descriptors (Tab=9, Escape=27, Space=32, Arrows=37..40, Delete=46, Ctrl+C/V/X, printable)
    expect(resolveCdpKeyDescriptor("Tab")?.windowsVirtualKeyCode).toBe(9);
    expect(resolveCdpKeyDescriptor("Escape")?.windowsVirtualKeyCode).toBe(27);
    expect(resolveCdpKeyDescriptor("Space")?.windowsVirtualKeyCode).toBe(32);
    expect(resolveCdpKeyDescriptor("ArrowLeft")?.windowsVirtualKeyCode).toBe(37);
    expect(resolveCdpKeyDescriptor("ArrowUp")?.windowsVirtualKeyCode).toBe(38);
    expect(resolveCdpKeyDescriptor("ArrowRight")?.windowsVirtualKeyCode).toBe(39);
    expect(resolveCdpKeyDescriptor("Delete")?.windowsVirtualKeyCode).toBe(46);
    expect(resolveCdpKeyDescriptor("c", ["ctrl"])).toMatchObject({ windowsVirtualKeyCode: 67, modifiers: 2 });
    expect(resolveCdpKeyDescriptor("v", ["ctrl"])).toMatchObject({ windowsVirtualKeyCode: 86, modifiers: 2 });
    expect(resolveCdpKeyDescriptor("x", ["ctrl"])).toMatchObject({ windowsVirtualKeyCode: 88, modifiers: 2 });
    expect(resolveCdpKeyDescriptor("@", ["shift"])).toMatchObject({ code: "Digit2", windowsVirtualKeyCode: 50, text: "@" });

    await rpc.invoke("bot.computer.stream", { active: false });
    expect(cdpCalls.some((c) => c.method === "Page.stopScreencast")).toBe(true);

    // /workspace file listing & reading
    const listRes = await rpc.invoke<BotComputerFilesListResult>("bot.computer.files.list", {
      engine: "local-linux",
      path: "/workspace/docs",
    });
    expect(listRes.cwd).toBe("/workspace/docs");
    expect(listRes.entries.some((e) => e.name === "guide.md" && !e.isDir)).toBe(true);

    const readRes = await rpc.invoke<BotComputerFilesReadResult>("bot.computer.files.read", {
      engine: "local-linux",
      path: "/workspace/docs/guide.md",
    });
    expect(readRes.isBinary).toBe(false);
    expect(readRes.content).toContain("Hello Computer 2.0");
  });

  it("upgrades isolated-copy shared folder sync to fast git worktree add --detach with cpSync fallback", () => {
    const root = mkdtempSync(join(tmpdir(), "qj-wt-test-"));
    tempDirs.push(root);

    const gitSrc = join(root, "git-repo");
    mkdirSync(gitSrc, { recursive: true });
    writeFileSync(join(gitSrc, "hello.ts"), "export const v = 1;\n", "utf8");
    const gitInit = spawnSync("git", ["init"], { cwd: gitSrc, windowsHide: true });
    if (gitInit.error === undefined && gitInit.status === 0) {
      spawnSync("git", ["config", "user.email", "test@qianji.local"], { cwd: gitSrc, windowsHide: true });
      spawnSync("git", ["config", "user.name", "Qianji Test"], { cwd: gitSrc, windowsHide: true });
      spawnSync("git", ["add", "."], { cwd: gitSrc, windowsHide: true });
      spawnSync("git", ["commit", "-m", "init"], { cwd: gitSrc, windowsHide: true });

      const wtCopy = join(root, "copies", "1-git-repo");
      syncIsolatedCopyWithWorktree({ path: gitSrc, access: "isolated-copy" }, wtCopy);
      expect(existsSync(join(wtCopy, "hello.ts"))).toBe(true);
      expect(statSync(join(wtCopy, ".git")).isFile()).toBe(true);
      spawnSync("git", ["-C", gitSrc, "worktree", "remove", "--force", wtCopy], { windowsHide: true });
    }

    const plainSrc = join(root, "plain-folder");
    mkdirSync(plainSrc, { recursive: true });
    writeFileSync(join(plainSrc, "notes.txt"), "plain-copy-ok", "utf8");
    const plainCopy = join(root, "copies", "2-plain-folder");
    syncIsolatedCopyWithWorktree({ path: plainSrc, access: "isolated-copy" }, plainCopy);
    expect(readFileSync(join(plainCopy, "notes.txt"), "utf8")).toBe("plain-copy-ok");
  });

  it("drives local-win-pip Ray-Desktop Child Session states (signOutRequired, open-native-desktop), Sentinel Fence, and zero fake windows", async () => {
    const helperPayloads: Array<Record<string, unknown>> = [];
    const openWins: Array<{ hwnd: string; title: string; app?: string }> = [];
    let childSessionEnabled = false;
    let signOutRequired = false;
    let childSessionActive = false;
    let viewerOpen = false;
    let allowElevation = false;

    const { host, rpc, dataDir } = await bootBotHost({
      computerHelperInvoker: async (payload) => {
        helperPayloads.push(payload);
        if (payload.action === "win_desktop_status") {
          return {
            ok: true,
            accountMode: "current-user",
            backend: "rdp-child-session",
            proSupported: true,
            childSessionEnabled,
            childSessionActive,
            signOutRequired,
            viewerOpen,
            desktopName: "QianjiChildSession",
            openWindows: openWins,
          };
        }
        if (payload.action === "win_desktop_enable_child_session") {
          if (!allowElevation) {
            return {
              ok: true,
              enabled: false,
              requiresElevation: true,
              elevationHint: "请以管理员身份开启系统 Child Sessions",
            };
          }
          childSessionEnabled = true;
          signOutRequired = true;
          return {
            ok: true,
            enabled: true,
            signOutRequired: true,
          };
        }
        if (payload.action === "win_desktop_open_viewer") {
          if (payload.mode === "close") {
            viewerOpen = false;
            return { ok: true, viewerOpen: false, action: "close" };
          }
          if (signOutRequired) {
            return { ok: false, signOutRequired: true };
          }
          viewerOpen = true;
          childSessionActive = true;
          return { ok: true, viewerOpen: true, childSessionActive: true };
        }
        if (payload.action === "win_desktop_launch") {
          openWins.push({ hwnd: "0x2001", title: String(payload.url ?? payload.app ?? "App"), app: "msedge.exe" });
          return { ok: true, pid: 4321, openWindows: openWins };
        }
        if (payload.action === "win_desktop_capture") {
          return { ok: true, mimeType: "image/jpeg", dataBase64: FAKE_PNG, width: 1280, height: 800 };
        }
        if (payload.action === "win_desktop_input") {
          return { ok: true, dispatched: true };
        }
        if (payload.action === "win_desktop_close_window") {
          if (payload.closeAll === true) {
            openWins.length = 0;
          } else {
            const idx = openWins.findIndex((w) => w.hwnd === payload.hwnd);
            if (idx >= 0) openWins.splice(idx, 1);
          }
          return { ok: true, openWindows: openWins };
        }
        return { ok: true };
      },
    });

    const sharedRoDir = mkdtempSync(join(tmpdir(), "qj-fence-ro-"));
    const outsideSecretDir = mkdtempSync(join(tmpdir(), "qj-fence-outside-"));
    tempDirs.push(sharedRoDir, outsideSecretDir);
    writeFileSync(join(sharedRoDir, "shared-spec.md"), "shared-readonly-content", "utf8");
    writeFileSync(join(outsideSecretDir, "private-tax.txt"), "TOP_SECRET_HOST_FILE", "utf8");

    await rpc.invoke("bot.server.configure", {
      sharedFolderAdd: { path: sharedRoDir, access: "read-only" },
    });

    const selected = await rpc.invoke<BotComputerStudioSnapshot>("bot.computer.select", {
      engine: "local-win-pip",
      tab: "desktop",
    });
    expect(selected.localWinPip?.backend).toBe("rdp-child-session");
    expect(selected.localWinPip?.childSessionEnabled).toBe(false);
    expect(selected.localWinPip?.openWindows).toEqual([]);
    expect(selected.localWinPip?.isolatedProfileDir).toBe(join(resolve(dataDir, "bot"), "win-pip-browser-profile"));

    // 1. Declining UAC surfaces elevationRequired
    const deniedElev = await rpc.invoke<{ ok: boolean; elevationRequired?: boolean }>("bot.computer.action", {
      engine: "local-win-pip",
      action: "enable-win-child-session",
    });
    expect(deniedElev.ok).toBe(false);
    expect(deniedElev.elevationRequired).toBe(true);

    // 2. Approving UAC enables Child Sessions and surfaces signOutRequired = true
    allowElevation = true;
    const enabledRes = await rpc.invoke<{ ok: boolean; message: string; snapshot: BotComputerStudioSnapshot }>("bot.computer.action", {
      engine: "local-win-pip",
      action: "enable-win-child-session",
    });
    expect(enabledRes.ok).toBe(true);
    expect(enabledRes.snapshot.localWinPip?.childSessionEnabled).toBe(true);
    expect(enabledRes.snapshot.localWinPip?.signOutRequired).toBe(true);
    expect(enabledRes.message).toContain("注销并重新登录");

    // 3. After Windows re-login, open-native-desktop launches viewer & activates Child Session
    signOutRequired = false;
    const openViewerRes = await rpc.invoke<{ ok: boolean; snapshot: BotComputerStudioSnapshot }>("bot.computer.action", {
      engine: "local-win-pip",
      action: "open-native-desktop",
    });
    expect(openViewerRes.ok).toBe(true);
    expect(helperPayloads.some((p) => p.action === "win_desktop_open_viewer")).toBe(true);
    expect(openViewerRes.snapshot.localWinPip?.viewerOpen).toBe(true);
    expect(openViewerRes.snapshot.localWinPip?.childSessionActive).toBe(true);

    // 4. Launch isolated browser & dispatch input inside Child Session
    const launchRes = await rpc.invoke<{ ok: boolean; snapshot: BotComputerStudioSnapshot }>("bot.computer.action", {
      engine: "local-win-pip",
      action: "launch-app",
      launchKind: "browser",
      appOrUrl: "https://portal.example.com",
    });
    expect(launchRes.ok).toBe(true);
    expect(launchRes.snapshot.localWinPip?.openWindows.length).toBe(1);

    await rpc.invoke("bot.computer.input", {
      engine: "local-win-pip",
      tab: "desktop",
      kind: "mouse",
      mouseAction: "double-click",
      button: "left",
      x: 410,
      y: 295,
    });
    const inputCall = helperPayloads.find((p) => p.action === "win_desktop_input");
    expect(inputCall?.inputAction).toBe("double_click");

    // Sleeping (`action: "stop"`) on `local-win-pip` closes child windows AND closes the native viewer window
    const sleepWinRes = await rpc.invoke<{ ok: boolean; snapshot: BotComputerStudioSnapshot }>("bot.computer.action", {
      engine: "local-win-pip",
      action: "stop",
    });
    expect(sleepWinRes.ok).toBe(true);
    expect(sleepWinRes.snapshot.localWinPip?.viewerOpen).toBe(false);
    expect(sleepWinRes.snapshot.localWinPip?.openWindows).toEqual([]);
    expect(helperPayloads.some((p) => p.action === "win_desktop_open_viewer" && p.mode === "close")).toBe(true);
    expect(resolveWinInputAction({ kind: "mouse", mouseAction: "down", button: "left", x: 10, y: 20 })).toBe("down");
    expect(resolveWinInputAction({ kind: "key", key: "@", text: "@", modifiers: ["shift"] })).toBe("text");
    expect(resolveWinInputAction({ kind: "key", key: "a", text: "a", modifiers: ["ctrl"] })).toBe("key");

    const { config: desktopHarnessCfg } = harnessFromDesktop({
      settings: {},
      configDir: dataDir,
      executable: "C:\\Program Files\\Qianji\\qianji.exe",
    });
    const botDef = builtinFeatureDefinitions(dataDir, desktopHarnessCfg).find((d) => d.id === "bot-mode");
    expect((botDef?.config as { computerHelperPath?: string } | undefined)?.computerHelperPath).toBe(
      "C:\\Program Files\\Qianji\\qianji.exe",
    );

    // 5. Sentinel Path Fence enforcement
    const snap0 = await rpc.invoke<BotSnapshotResult>("bot.getSnapshot", {});
    const env = { sessionId: snap0.mainSessionId, cwd: snap0.botCwd, signal: new AbortController().signal };

    const writeInside = await host.ctx.tools.execute(
      { id: "t-w1", name: "write", args: { path: "inside-ok.txt", content: "safe-in-fence" } },
      env,
    );
    expect(writeInside.isError).not.toBe(true);

    const writeRoDenied = await host.ctx.tools.execute(
      { id: "t-w2", name: "write", args: { path: join(sharedRoDir, "tamper.txt"), content: "nope" } },
      env,
    );
    expect(writeRoDenied.isError).toBe(true);

    await expect(
      rpc.invoke("bot.computer.files.read", {
        engine: "local-win-pip",
        path: join(outsideSecretDir, "private-tax.txt"),
      }),
    ).rejects.toThrow(/Sentinel Path Fence/);

    // 6. Missing helper binary honestly reports ok: false with ZERO fake fallbackOpenWindows!
    const noHelperEnv = await bootBotHost({ computerHelperPath: join(dataDir, "non-existent-helper.exe") });
    await noHelperEnv.rpc.invoke("bot.computer.select", { engine: "local-win-pip", tab: "desktop" });
    const fbLaunch = await noHelperEnv.rpc.invoke<{ ok: boolean; snapshot: BotComputerStudioSnapshot }>(
      "bot.computer.action",
      { engine: "local-win-pip", action: "launch-app", launchKind: "app", appOrUrl: "notepad.exe" },
    );
    expect(fbLaunch.ok).toBe(false);
    expect(fbLaunch.snapshot.localWinPip?.openWindows).toEqual([]);
  });

  it("manages remote-vm & remote-pc nodes, syncs legacy virtualServer.remote, and replays BotRemoteAutonomyLease ring-buffer", async () => {
    const { host, rpc, secretMap } = await bootBotHost();

    const pcUpsert = await rpc.invoke<{ node: BotRemoteComputerNode; snapshot: BotComputerStudioSnapshot }>(
      "bot.computer.remoteNode.upsert",
      {
        alias: "家里闲置 Mac mini",
        kind: "companion-pc",
        host: "100.64.10.8",
        port: 22,
        username: "yht",
        workDir: "~/.qianji-companion",
        authMethod: "password",
        password: "example-mac-mini-pw",
      },
    );
    expect(pcUpsert.node.kind).toBe("companion-pc");
    expect(pcUpsert.node.hasStoredSecret).toBe(true);
    expect(secretMap.get(`bot/remote-node-password/${pcUpsert.node.id}`)).toBe("example-mac-mini-pw");

    await rpc.invoke("bot.server.configure", {
      remoteHost: "10.20.30.40",
      remotePort: 2222,
      remoteUser: "ubuntu",
      remoteWorkDir: "/srv/qianji",
    });
    const snapWithBoth = await rpc.invoke<BotComputerStudioSnapshot>("bot.computer.getSnapshot", {});
    expect(snapWithBoth.remoteNodes.some((n) => n.id === "default-ssh-vm" && n.host === "10.20.30.40")).toBe(true);
    expect(snapWithBoth.remoteNodes.some((n) => n.id === pcUpsert.node.id && n.kind === "companion-pc")).toBe(true);

    await rpc.invoke("bot.computer.select", {
      engine: "remote-pc",
      activeRemoteNodeId: pcUpsert.node.id,
      tab: "terminal",
    });
    await rpc.invoke("bot.computer.action", {
      engine: "remote-pc",
      action: "disconnect-remote",
      remoteNodeId: pcUpsert.node.id,
    });

    const ptyOpen = await rpc.invoke<{ pty: BotComputerPtySessionInfo }>("bot.computer.pty.open", {
      engine: "remote-pc",
    });
    await rpc.invoke("bot.computer.pty.write", {
      sessionId: ptyOpen.pty.sessionId,
      engine: "remote-pc",
      data: "echo offline-step-1\n",
    });
    await rpc.invoke("bot.computer.pty.write", {
      sessionId: ptyOpen.pty.sessionId,
      engine: "remote-pc",
      data: "echo offline-step-2\n",
    });

    const beforeSync = await rpc.invoke<BotComputerStudioSnapshot>("bot.computer.getSnapshot", {});
    const pcBefore = beforeSync.remoteNodes.find((n) => n.id === pcUpsert.node.id);
    expect(pcBefore?.autonomyLease.active).toBe(true);
    expect(pcBefore?.autonomyLease.queuedOfflineEvents).toBe(2);

    rpc.broadcasts.length = 0;
    const syncRes = await rpc.invoke<{ ok: boolean; snapshot: BotComputerStudioSnapshot }>("bot.computer.action", {
      engine: "remote-pc",
      action: "sync-autonomy-lease",
      remoteNodeId: pcUpsert.node.id,
    });
    expect(syncRes.ok).toBe(true);
    const pcAfter = syncRes.snapshot.remoteNodes.find((n) => n.id === pcUpsert.node.id);
    expect(pcAfter?.autonomyLease.queuedOfflineEvents).toBe(0);

    await rpc.invoke("bot.computer.remoteNode.delete", { id: pcUpsert.node.id });
    expect(quotePosixPath("~")).toBe('"$HOME"');
    expect(quotePosixPath("~/My Documents/a'b $(id)")).toBe(`"$HOME"'/My Documents/a'\\''b $(id)'`);
    void host;
  });

  it("maintains persistent stateful PTY (cd + env across writes) and enforces Sentinel Path Fence on cd", async () => {
    const { rpc, dataDir } = await bootBotHost();
    const wsDir = join(dataDir, "bot-workspace");
    mkdirSync(join(wsDir, "project-alpha"), { recursive: true });

    await rpc.invoke("bot.computer.select", { engine: "local-win-pip", tab: "terminal" });
    const opened = await rpc.invoke<{ pty: BotComputerPtySessionInfo }>("bot.computer.pty.open", {
      engine: "local-win-pip",
    });
    expect(opened.pty.alive).toBe(true);

    await rpc.invoke("bot.computer.pty.write", { sessionId: opened.pty.sessionId, data: "cd project-alpha\n" });
    await rpc.invoke("bot.computer.pty.write", { sessionId: opened.pty.sessionId, data: "export QJ_STATEFUL_VAR=persist_ok_99\n" });
    const echoRes = await rpc.invoke<{ pty: BotComputerPtySessionInfo }>("bot.computer.pty.write", {
      sessionId: opened.pty.sessionId,
      data: "echo $QJ_STATEFUL_VAR\n",
    });
    expect(echoRes.pty.cwd.toLowerCase()).toContain("project-alpha");
    expect(echoRes.pty.outputTail).toContain("persist_ok_99");

    const escapeRes = await rpc.invoke<{ pty: BotComputerPtySessionInfo }>("bot.computer.pty.write", {
      sessionId: opened.pty.sessionId,
      data: "cd ../..\n",
    });
    expect(escapeRes.pty.cwd.toLowerCase()).toBe(resolve(wsDir).toLowerCase());
    expect(escapeRes.pty.outputTail).toContain("Sentinel Fence");

    await rpc.invoke("bot.computer.pty.resize", { sessionId: opened.pty.sessionId, cols: 120, rows: 40 });
    await rpc.invoke("bot.computer.pty.close", { sessionId: opened.pty.sessionId });
  });

  it("records timeline steps with autoFollow & drives bot_request_takeover state machine (requested -> active -> idle)", async () => {
    const { host, rpc, dataDir } = await bootBotHost();
    const snap0 = await rpc.invoke<BotSnapshotResult>("bot.getSnapshot", {});
    const env = { sessionId: snap0.mainSessionId, cwd: join(dataDir, "bot-workspace"), signal: new AbortController().signal };

    expect(BOT_NATIVE_TOOL_SCHEMAS.some((t) => t.name === "bot_request_takeover")).toBe(true);

    await host.ctx.tools.execute(
      { id: "Step-1", name: "browser_navigate", args: { url: "https://accounts.example.com/2fa" } },
      env,
    );
    let cs = await rpc.invoke<BotComputerStudioSnapshot>("bot.computer.getSnapshot", {});
    expect(cs.activeTab).toBe("browser");

    await host.ctx.tools.execute({ id: "Step-2", name: "bash", args: { command: "ls -la" } }, env);
    cs = await rpc.invoke<BotComputerStudioSnapshot>("bot.computer.getSnapshot", {});
    expect(cs.activeTab).toBe("terminal");

    const store = new botPlugin.BotStateStore(
      host.ctx.sessions,
      { dataDir, distroName: "qianji-bot-unit-noop", wslSupported: false },
      host.ctx.credentials,
    );
    store.computer.attachBroadcaster((ch, payload) => rpc.broadcast(ch, payload));
    const nativeHost = createBotHarnessHost(store, (reason) => rpc.broadcast("bot/updated", { reason }));

    const toolOut = await executeBotNativeTool(
      "bot_request_takeover",
      {
        reason: "需要你扫码完成企业 SSO 二次验证",
        targetUrlOrApp: "https://accounts.example.com/2fa",
        engine: "local-linux",
      },
      env,
      nativeHost,
    );
    expect(toolOut.isError).not.toBe(true);
    expect(store.computer.buildEmbeddedSnapshot(await store.ensureLoaded()).takeover.status).toBe("requested");

    const desktopNotifs = rpc.broadcasts
      .filter((b) => b.channel === "bot/desktopNotification")
      .map((b) => b.payload as BotDesktopNotificationPayload);
    expect(desktopNotifs.some((n) => n.urgency === "urgent" && n.body.includes("SSO 二次验证"))).toBe(true);

    const reqRpc = await rpc.invoke<{ takeover: BotComputerTakeoverState; snapshot: BotComputerStudioSnapshot }>(
      "bot.computer.takeover",
      { action: "request", reason: "请完成图形验证码与登录", targetUrlOrApp: "https://accounts.example.com/2fa" },
    );
    expect(reqRpc.takeover.status).toBe("requested");

    const activeRpc = await rpc.invoke<{ takeover: BotComputerTakeoverState; snapshot: BotComputerStudioSnapshot }>(
      "bot.computer.takeover",
      { action: "start" },
    );
    expect(activeRpc.takeover.status).toBe("active");

    const idleRpc = await rpc.invoke<{ takeover: BotComputerTakeoverState; snapshot: BotComputerStudioSnapshot }>(
      "bot.computer.takeover",
      { action: "release" },
    );
    expect(idleRpc.takeover.status).toBe("idle");
    await store.computer.dispose();
  });
});

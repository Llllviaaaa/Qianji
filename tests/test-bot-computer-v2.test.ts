/**
 * Comprehensive unit & integration tests for Qianji Virtual Computer 2.0 (`2x2` matrix):
 * - `local-linux` (WSL2 GUI `:99` status, fast `git worktree add --detach` shared copy + `cpSync` fallback, CDP input, `/workspace` files)
 * - `local-win-pip` (`--computer-helper` JSON protocol + graceful fallback, isolated browser profile, Sentinel Path Fence)
 * - `remote-vm` & `remote-pc` (`ssh-vm` + `companion-pc`, legacy `virtualServer.remote` sync, `BotRemoteAutonomyLease` ring-buffer replay)
 * - Persistent stateful PTY (`cd` & env persistence across writes, live `pty` stream chunks, Sentinel fence on `cd`)
 * - Action Timeline Recorder (`autoFollow`, pointer telemetry, frame capture) & `bot_request_takeover` (`requested -> active -> idle`)
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
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
import { syncIsolatedCopyWithWorktree } from "../packages/host/src/bot/computer/local-linux-engine";
import { resolveWinInputAction } from "../packages/host/src/bot/computer/win-helper-client";
import { BOT_NATIVE_TOOL_SCHEMAS, executeBotNativeTool } from "../packages/host/src/bot/harness/bot-tools";
import { createBotHarnessHost } from "../packages/host/src/bot/harness/bot-tools-host";
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
  let currentUrl = "about:blank";
  let currentTitle = "Fake Isolated Browser";
  const fake = {
    cdp: {
      connected: true,
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
  return { browser: fake as unknown as BrowserSession, cdpCalls };
}

describe("Virtual Computer 2.0 Host Engine (2x2 Matrix, PTY, Sentinel Fence, Lease & Takeover)", () => {
  const tempDirs: string[] = [];
  const activeHosts: Host[] = [];

  afterEach(async () => {
    while (activeHosts.length > 0) {
      const h = activeHosts.pop();
      if (h) await h.stop();
    }
    while (tempDirs.length > 0) {
      const dir = tempDirs.pop();
      if (dir) rmSync(dir, { recursive: true, force: true });
    }
  });

  async function bootBotHost(extraConfig: Partial<botPlugin.BotStoreConfig> = {}) {
    const dataDir = mkdtempSync(join(tmpdir(), "qj-comp-v2-"));
    tempDirs.push(dataDir);
    const secretMap = new Map<string, string>();
    const { browser, cdpCalls } = createFakeBrowser();

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
    return { host, rpc, dataDir, secretMap, cdpCalls };
  }

  it("attaches computerStudio to BotSnapshotResult & supports 2x2 engine selection, local-linux CDP input, stream & /workspace files", async () => {
    const { rpc, dataDir, cdpCalls } = await bootBotHost();
    const wsDir = join(dataDir, "bot-workspace");
    mkdirSync(join(wsDir, "docs"), { recursive: true });
    writeFileSync(join(wsDir, "docs", "guide.md"), "# 千机分身手册\nHello Computer 2.0", "utf8");

    const botSnap = await rpc.invoke<BotSnapshotResult>("bot.getSnapshot", {});
    expect(botSnap.computerStudio).toBeDefined();
    expect(botSnap.virtualServer.computerStudio).toBeDefined();
    expect(botSnap.computerStudio?.activeEngine).toBe("local-linux");

    // Provision Linux GUI & navigate browser
    const guiRes = await rpc.invoke<{ ok: boolean; snapshot: BotComputerStudioSnapshot }>("bot.computer.action", {
      engine: "local-linux",
      action: "provision-linux-gui",
    });
    expect(guiRes.ok).toBe(true);
    expect(guiRes.snapshot.localLinux?.display).toBe(":99");
    expect(guiRes.snapshot.localLinux?.guiReady).toBe(true);

    const navRes = await rpc.invoke<{ ok: boolean; frame?: BotComputerStreamFrame; snapshot: BotComputerStudioSnapshot }>(
      "bot.computer.navigate",
      { url: "https://qianji.example/login", engine: "local-linux" },
    );
    expect(navRes.ok).toBe(true);
    expect(navRes.frame?.url).toBe("https://qianji.example/login");

    // Direct mouse, wheel, key, text, and paste input over CDP
    await rpc.invoke("bot.computer.input", { engine: "local-linux", tab: "browser", kind: "mouse", mouseAction: "click", button: "right", x: 320, y: 240 });
    await rpc.invoke("bot.computer.input", { engine: "local-linux", tab: "browser", kind: "wheel", deltaX: 0, deltaY: 180, x: 320, y: 240 });
    await rpc.invoke("bot.computer.input", { engine: "local-linux", tab: "browser", kind: "text", text: "alice@example.com" });
    await rpc.invoke("bot.computer.input", { engine: "local-linux", tab: "browser", kind: "paste", text: "OTP-889900" });
    await rpc.invoke("bot.computer.input", { engine: "local-linux", tab: "browser", kind: "key", key: "Enter", modifiers: ["ctrl"] });

    expect(cdpCalls.some((c) => c.method === "Input.dispatchMouseEvent" && c.params?.button === "right")).toBe(true);
    expect(cdpCalls.some((c) => c.method === "Input.dispatchMouseEvent" && c.params?.type === "mouseWheel")).toBe(true);
    expect(cdpCalls.some((c) => c.method === "Input.insertText" && c.params?.text === "OTP-889900")).toBe(true);
    expect(cdpCalls.some((c) => c.method === "press" && c.params?.key === "Ctrl+Enter")).toBe(true);

    // Live frame streaming start & stop
    rpc.broadcasts.length = 0;
    await rpc.invoke("bot.computer.stream", { active: true, engine: "local-linux", tab: "browser", fps: 4 });
    await rpc.invoke("bot.computer.stream", { active: false });
    const frameEvents = rpc.broadcasts
      .filter((b) => b.channel === "bot/computer")
      .map((b) => b.payload as BotComputerEventNotification)
      .filter((p) => p.kind === "frame");
    expect(frameEvents.length).toBeGreaterThanOrEqual(1);

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

    // 1. Git repository -> fast `git worktree add --detach`
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
      // In a git worktree, `.git` inside wtCopy is a file pointing to the main repo's worktrees dir
      expect(statSync(join(wtCopy, ".git")).isFile()).toBe(true);
      spawnSync("git", ["-C", gitSrc, "worktree", "remove", "--force", wtCopy], { windowsHide: true });
    }

    // 2. Plain directory without `.git` -> `cpSync` fallback
    const plainSrc = join(root, "plain-folder");
    mkdirSync(plainSrc, { recursive: true });
    writeFileSync(join(plainSrc, "notes.txt"), "plain-copy-ok", "utf8");
    const plainCopy = join(root, "copies", "2-plain-folder");
    syncIsolatedCopyWithWorktree({ path: plainSrc, access: "isolated-copy" }, plainCopy);
    expect(readFileSync(join(plainCopy, "notes.txt"), "utf8")).toBe("plain-copy-ok");
  });

  it("bridges local-win-pip to --computer-helper with isolatedProfileDir, enforces Sentinel Path Fence, and falls back gracefully", async () => {
    const helperPayloads: Array<Record<string, unknown>> = [];
    const openWins = [{ hwnd: "0x1001", title: "Edge - 隔离窗口", app: "msedge.exe" }];

    const { host, rpc, dataDir } = await bootBotHost({
      computerHelperInvoker: async (payload) => {
        helperPayloads.push(payload);
        if (payload.action === "win_desktop_status") {
          return {
            ok: true,
            accountMode: "current-user",
            backend: "win32-secondary-desktop",
            proSupported: true,
            childSessionEnabled: false,
            desktopName: "QianjiBotDesktop",
            openWindows: openWins,
          };
        }
        if (payload.action === "win_desktop_enable_child_session") {
          return {
            ok: true,
            enabled: false,
            requiresElevation: true,
            elevationHint: "请以管理员身份开启 RDP 子会话",
          };
        }
        if (payload.action === "win_desktop_launch") {
          openWins.push({ hwnd: "0x1002", title: String(payload.url ?? payload.app ?? "App"), app: "notepad.exe" });
          return { ok: true, pid: 4321, openWindows: openWins };
        }
        if (payload.action === "win_desktop_capture") {
          return { ok: true, mimeType: "image/png", dataBase64: FAKE_PNG, width: 1280, height: 800, openWindows: openWins };
        }
        if (payload.action === "win_desktop_input") {
          return { ok: true, dispatched: true, openWindows: openWins };
        }
        if (payload.action === "win_desktop_close_window") {
          const idx = openWins.findIndex((w) => w.hwnd === payload.hwnd);
          if (idx >= 0) openWins.splice(idx, 1);
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
    expect(selected.activeEngine).toBe("local-win-pip");
    expect(selected.localWinPip?.accountMode).toBe("current-user");
    expect(selected.localWinPip?.desktopName).toBe("QianjiBotDesktop");
    expect(selected.localWinPip?.isolatedProfileDir).toBe(join(resolve(dataDir, "bot"), "win-pip-browser-profile"));
    expect(selected.localWinPip?.fencedRoots).toContain(resolve(dataDir, "bot-workspace"));
    expect(selected.localWinPip?.fencedRoots).toContain(resolve(sharedRoDir));

    // Child session probe surfaces elevationRequired cleanly
    const childRes = await rpc.invoke<{ ok: boolean; elevationRequired?: boolean }>("bot.computer.action", {
      engine: "local-win-pip",
      action: "enable-win-child-session",
    });
    expect(childRes.ok).toBe(false);
    expect(childRes.elevationRequired).toBe(true);

    // Launch browser passes isolatedProfileDir so current-user Chrome/Edge profile locks never collide
    const launchRes = await rpc.invoke<{ ok: boolean; snapshot: BotComputerStudioSnapshot }>("bot.computer.action", {
      engine: "local-win-pip",
      action: "launch-app",
      launchKind: "browser",
      appOrUrl: "https://portal.example.com",
    });
    expect(launchRes.ok).toBe(true);
    const launchCall = helperPayloads.find((p) => p.action === "win_desktop_launch");
    expect(launchCall?.isolatedProfileDir).toBe(join(resolve(dataDir, "bot"), "win-pip-browser-profile"));
    expect(launchRes.snapshot.localWinPip?.openWindows.length).toBe(2);

    // Non-hijacking background input & close-window
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
    expect(inputCall?.x).toBe(410);
    expect(inputCall?.y).toBe(295);

    // Direct canvas pointer down/up & printable vs shortcut key translation
    expect(resolveWinInputAction({ kind: "mouse", mouseAction: "down", button: "left", x: 10, y: 20 })).toBe("down");
    expect(resolveWinInputAction({ kind: "mouse", mouseAction: "up", button: "right", x: 10, y: 20 })).toBe("up");
    expect(resolveWinInputAction({ kind: "key", key: "@", text: "@", modifiers: ["shift"] })).toBe("text");
    expect(resolveWinInputAction({ kind: "key", key: "a", text: "a", modifiers: ["ctrl"] })).toBe("key");

    // Desktop executable automatically wires into bot-mode computerHelperPath without manual env setup
    const { config: desktopHarnessCfg } = harnessFromDesktop({
      settings: {},
      configDir: dataDir,
      executable: "C:\\Program Files\\Qianji\\qianji.exe",
    });
    const botDef = builtinFeatureDefinitions(dataDir, desktopHarnessCfg).find((d) => d.id === "bot-mode");
    expect((botDef?.config as { computerHelperPath?: string } | undefined)?.computerHelperPath).toBe(
      "C:\\Program Files\\Qianji\\qianji.exe",
    );

    const afterClose = await rpc.invoke<{ snapshot: BotComputerStudioSnapshot }>("bot.computer.action", {
      engine: "local-win-pip",
      action: "close-window",
      hwnd: "0x1002",
    });
    expect(afterClose.snapshot.localWinPip?.openWindows.some((w) => w.hwnd === "0x1002")).toBe(false);

    // Sentinel Path Fence: allows workspace & shared folder reads, blocks outside paths & blocks writes to read-only shared
    const snap0 = await rpc.invoke<BotSnapshotResult>("bot.getSnapshot", {});
    const env = { sessionId: snap0.mainSessionId, cwd: snap0.botCwd, signal: new AbortController().signal };

    const writeInside = await host.ctx.tools.execute(
      { id: "t-w1", name: "write", args: { path: "inside-ok.txt", content: "safe-in-fence" } },
      env,
    );
    expect(writeInside.isError).not.toBe(true);
    expect(readFileSync(join(dataDir, "bot-workspace", "inside-ok.txt"), "utf8")).toBe("safe-in-fence");

    const writeRoDenied = await host.ctx.tools.execute(
      { id: "t-w2", name: "write", args: { path: join(sharedRoDir, "tamper.txt"), content: "nope" } },
      env,
    );
    expect(writeRoDenied.isError).toBe(true);
    expect(existsSync(join(sharedRoDir, "tamper.txt"))).toBe(false);

    const readOutsideTool = await host.ctx.tools.execute(
      { id: "t-r1", name: "read", args: { path: join(outsideSecretDir, "private-tax.txt") } },
      env,
    );
    expect(readOutsideTool.isError).toBe(true);

    await expect(
      rpc.invoke("bot.computer.files.read", {
        engine: "local-win-pip",
        path: join(outsideSecretDir, "private-tax.txt"),
      }),
    ).rejects.toThrow(/Sentinel Path Fence/);

    await expect(
      rpc.invoke("bot.computer.files.list", {
        engine: "local-win-pip",
        path: "../..",
      }),
    ).rejects.toThrow(/Sentinel Path Fence/);

    // Graceful fallback when native helper binary is absent
    const fallbackEnv = await bootBotHost({ computerHelperPath: join(dataDir, "non-existent-helper.exe") });
    await fallbackEnv.rpc.invoke("bot.computer.select", { engine: "local-win-pip", tab: "desktop" });
    const fbLaunch = await fallbackEnv.rpc.invoke<{ ok: boolean; snapshot: BotComputerStudioSnapshot }>(
      "bot.computer.action",
      { engine: "local-win-pip", action: "launch-app", launchKind: "app", appOrUrl: "notepad.exe" },
    );
    expect(fbLaunch.ok).toBe(true);
    expect(fbLaunch.snapshot.localWinPip?.openWindows.some((w) => w.title.includes("notepad.exe"))).toBe(true);
  });

  it("manages remote-vm & remote-pc nodes, syncs legacy virtualServer.remote, and replays BotRemoteAutonomyLease ring-buffer", async () => {
    const { host, rpc, secretMap } = await bootBotHost();

    // Upsert companion-pc node with encrypted password & ssh-vm node
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

    // Legacy virtualServer.remote syncs seamlessly with default-ssh-vm
    await rpc.invoke("bot.server.configure", {
      remoteHost: "10.20.30.40",
      remotePort: 2222,
      remoteUser: "ubuntu",
      remoteWorkDir: "/srv/qianji",
    });
    const snapWithBoth = await rpc.invoke<BotComputerStudioSnapshot>("bot.computer.getSnapshot", {});
    expect(snapWithBoth.remoteNodes.some((n) => n.id === "default-ssh-vm" && n.host === "10.20.30.40")).toBe(true);
    expect(snapWithBoth.remoteNodes.some((n) => n.id === pcUpsert.node.id && n.kind === "companion-pc")).toBe(true);

    // Stub SshRemoteRuntime on BotStateStore via remote-pc connection & offline lease replay
    await rpc.invoke("bot.computer.select", {
      engine: "remote-pc",
      activeRemoteNodeId: pcUpsert.node.id,
      tab: "terminal",
    });

    // Disconnect remote-pc -> autonomy lease remains active and queues offline tool executions in ring-buffer
    await rpc.invoke("bot.computer.action", {
      engine: "remote-pc",
      action: "disconnect-remote",
      remoteNodeId: pcUpsert.node.id,
    });

    // Trigger remote PTY / files while disconnected -> queues offline lease events
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
    expect(pcBefore?.autonomyLease.lastSeq).toBeGreaterThanOrEqual(2);

    rpc.broadcasts.length = 0;
    const syncRes = await rpc.invoke<{ ok: boolean; snapshot: BotComputerStudioSnapshot }>("bot.computer.action", {
      engine: "remote-pc",
      action: "sync-autonomy-lease",
      remoteNodeId: pcUpsert.node.id,
    });
    expect(syncRes.ok).toBe(true);
    const pcAfter = syncRes.snapshot.remoteNodes.find((n) => n.id === pcUpsert.node.id);
    expect(pcAfter?.autonomyLease.queuedOfflineEvents).toBe(0);
    expect(syncRes.snapshot.timeline.some((s) => s.title.includes("离线自治排队命令"))).toBe(true);

    const replayedTimelineBroadcasts = rpc.broadcasts
      .filter((b) => b.channel === "bot/computer")
      .map((b) => b.payload as BotComputerEventNotification)
      .filter((p) => p.kind === "timeline");
    expect(replayedTimelineBroadcasts.length).toBe(2);

    // Delete remote node cleans up
    await rpc.invoke("bot.computer.remoteNode.delete", { id: pcUpsert.node.id });
    const afterDel = await rpc.invoke<BotComputerStudioSnapshot>("bot.computer.getSnapshot", {});
    expect(afterDel.remoteNodes.some((n) => n.id === pcUpsert.node.id)).toBe(false);
    void host;
  });

  it("maintains persistent stateful PTY (cd + env across writes) and enforces Sentinel Path Fence on cd", async () => {
    const { rpc, dataDir } = await bootBotHost();
    const wsDir = join(dataDir, "bot-workspace");
    const subDir = join(wsDir, "project-alpha");
    mkdirSync(subDir, { recursive: true });

    await rpc.invoke("bot.computer.select", { engine: "local-win-pip", tab: "terminal" });
    const opened = await rpc.invoke<{ pty: BotComputerPtySessionInfo }>("bot.computer.pty.open", {
      engine: "local-win-pip",
    });
    expect(opened.pty.alive).toBe(true);

    rpc.broadcasts.length = 0;
    await rpc.invoke("bot.computer.pty.write", {
      sessionId: opened.pty.sessionId,
      data: "cd project-alpha\n",
    });
    await rpc.invoke("bot.computer.pty.write", {
      sessionId: opened.pty.sessionId,
      data: "export QJ_STATEFUL_VAR=persist_ok_99\n",
    });
    const echoRes = await rpc.invoke<{ pty: BotComputerPtySessionInfo }>("bot.computer.pty.write", {
      sessionId: opened.pty.sessionId,
      data: "echo $QJ_STATEFUL_VAR\n",
    });

    expect(echoRes.pty.cwd.toLowerCase()).toContain("project-alpha");
    expect(echoRes.pty.outputTail).toContain("persist_ok_99");

    const ptyChunks = rpc.broadcasts
      .filter((b) => b.channel === "bot/computer")
      .map((b) => b.payload as BotComputerEventNotification)
      .filter((p) => p.kind === "pty");
    expect(ptyChunks.length).toBeGreaterThanOrEqual(1);

    // Attempting to `cd` outside fencedRoots snaps back inside botWorkspaceDir!
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

    // Verify bot_request_takeover is registered in BOT_NATIVE_TOOL_SCHEMAS
    expect(BOT_NATIVE_TOOL_SCHEMAS.some((t) => t.name === "bot_request_takeover")).toBe(true);

    rpc.broadcasts.length = 0;

    // 1. Browser tool -> auto-switches activeTab to "browser", emits pointer + frame + timeline
    await host.ctx.tools.execute(
      { id: "Step-1", name: "browser_navigate", args: { url: "https://accounts.example.com/2fa" } },
      env,
    );
    let cs = await rpc.invoke<BotComputerStudioSnapshot>("bot.computer.getSnapshot", {});
    expect(cs.activeTab).toBe("browser");
    expect(cs.timeline.some((s) => s.toolName === "browser_navigate" && s.urlOrApp === "https://accounts.example.com/2fa")).toBe(true);

    // 2. Bash tool -> auto-switches activeTab to "terminal" when autoFollow === true
    await host.ctx.tools.execute(
      { id: "Step-2", name: "bash", args: { command: "ls -la" } },
      env,
    );
    cs = await rpc.invoke<BotComputerStudioSnapshot>("bot.computer.getSnapshot", {});
    expect(cs.activeTab).toBe("terminal");
    expect(cs.timeline.some((s) => s.toolName === "bash" && s.terminalSnippet?.includes("bash-out: ls -la"))).toBe(true);

    // 3. Bot calls native tool `bot_request_takeover` -> requested + desktopNotification + takeoverRequired
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
    expect((await store.snapshot()).virtualServer.takeoverRequired).toBe(true);

    const desktopNotifs = rpc.broadcasts
      .filter((b) => b.channel === "bot/desktopNotification")
      .map((b) => b.payload as BotDesktopNotificationPayload);
    expect(desktopNotifs.some((n) => n.urgency === "urgent" && n.body.includes("SSO 二次验证"))).toBe(true);

    // Transition requested -> active -> idle via RPC against the main host RPC
    const reqRpc = await rpc.invoke<{ takeover: BotComputerTakeoverState; snapshot: BotComputerStudioSnapshot }>(
      "bot.computer.takeover",
      {
        action: "request",
        reason: "请完成图形验证码与登录",
        targetUrlOrApp: "https://accounts.example.com/2fa",
      },
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
    expect((await rpc.invoke<BotSnapshotResult>("bot.getSnapshot", {})).virtualServer.takeoverRequired).toBe(false);
    expect(idleRpc.snapshot.timeline.some((s) => s.title.includes("交还千机"))).toBe(true);

    store.computer.dispose();
  });
});

/**
 * Real Live View & Manual Takeover controller for Qianji Bot Mode (`packages/host/src/bot/live-view.ts`).
 *
 * Bridges:
 * 1. Dedicated Bot-isolated `BrowserSession` (`profileDir: <dataDir>/bot/browser-profile`, `1280×900`)
 *    shared between Bot `browser_*` tools and the Live View interactive takeover modal.
 * 2. Live container diagnostic terminal (`execDiag`) against the active WSL2 or Remote SSH environment.
 */
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { BrowserSession, grokSnapshotText, parseElementRef, tabsText } from "@qianji/browser";
import type {
  BotLiveViewExecDiagResult,
  BotLiveViewSnapshot,
  BotVirtualServerStatus,
} from "@qianji/protocol";
import { textOutput, type ToolCall, type ToolOutput } from "@qianji/tools";
import type { SshRemoteRuntime } from "./ssh-runtime.ts";
import { sharedFolderSlug, type WslContainerRuntime } from "./wsl-runtime.ts";

export const BOT_BROWSER_TOOLS = new Set([
  "browser_navigate",
  "browser_inspect",
  "browser_screenshot",
  "browser_click",
  "browser_type",
  "browser_press",
  "browser_scroll",
  "browser_wait",
  "browser_tabs",
]);

const WELCOME_HTML_DATA_URL = `data:text/html;charset=utf-8,${encodeURIComponent(`<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><style>
body{margin:0;min-height:100vh;display:grid;place-items:center;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;background:#f7f8fa;color:#111214}
.card{max-width:560px;padding:32px 36px;border-radius:20px;background:#fff;border:1px solid #e5e7eb;box-shadow:0 8px 24px rgba(0,0,0,.06)}
h1{margin:0 0 8px;font-size:20px}p{margin:0;font-size:14px;line-height:1.65;color:#555a66}
</style></head><body><div class="card"><h1>千机分身 · 隔离浏览器实时画面</h1><p>此浏览器实例使用独立的持久化会话目录（与你本机日常浏览器完全隔离）。当分身需要网页检索、登录授权或处理安全验证时，可直接在顶部地址栏输入网址或在画面中点击、输入完成人工接管。</p></div></body></html>`)}`;

export class BotLiveViewController {
  private profileDir: string;
  private botWorkspaceDir: string;
  private browser: BrowserSession | null = null;
  private initializedBlank = false;

  constructor(
    private readonly options: {
      botDir: string;
      botWorkspaceDir: string;
      wsl: WslContainerRuntime;
      ssh: SshRemoteRuntime;
      getRemotePassword: () => Promise<string | undefined>;
    },
  ) {
    this.profileDir = join(options.botDir, "browser-profile");
    this.botWorkspaceDir = options.botWorkspaceDir;
    mkdirSync(this.profileDir, { recursive: true });
  }

  async setPaths(next: { storageDir: string; botWorkspaceDir: string }): Promise<void> {
    const nextProfile = join(next.storageDir, "browser-profile");
    if (nextProfile !== this.profileDir || next.botWorkspaceDir !== this.botWorkspaceDir) {
      await this.close();
      this.profileDir = nextProfile;
      this.botWorkspaceDir = next.botWorkspaceDir;
      mkdirSync(this.profileDir, { recursive: true });
    }
  }

  private ensureBrowser(): BrowserSession {
    if (this.browser === null) {
      this.browser = new BrowserSession({
        workspace: this.botWorkspaceDir,
        profileDir: this.profileDir,
      });
    }
    return this.browser;
  }

  private buildContainerSummary(vs: BotVirtualServerStatus): BotLiveViewSnapshot["containerSummary"] {
    if (vs.mode === "remote") {
      return {
        engine: "远端 SSH 虚拟服务器",
        state: vs.lifecycle,
        kernelOrHost: vs.remote.host
          ? `${vs.remote.username}@${vs.remote.host}:${vs.remote.port}${vs.remote.osSummary ? ` (${vs.remote.osSummary})` : ""}`
          : "未配置远端主机",
        mounts: [`${vs.remote.workDir || "~/.qianji-vm"}/workspace`],
        cgroupSummary: `${vs.local.cpuCores} 核 · ${vs.local.memoryLimitGb} GB RAM`,
      };
    }

    const mounts = [
      `/workspace -> ${this.botWorkspaceDir} (rw)`,
      ...vs.local.sharedFolders.map(
        (sf, idx) => `/shared/${sharedFolderSlug(sf.path, idx)} -> ${sf.path} (${sf.access})`,
      ),
    ];
    return {
      engine: vs.local.engine === "wsl2" ? `WSL2 容器 (${vs.local.distroName ?? "qianji-bot-vm"})` : "宿主机隔离目录模式",
      state: vs.local.engineState ?? vs.lifecycle,
      kernelOrHost: vs.local.kernelVersion ?? (vs.local.engine === "wsl2" ? "未启动 / 等待初始化" : "Host fallback"),
      mounts,
      cgroupSummary: `cpu=${vs.local.cpuCores} 核 · mem=${vs.local.memoryLimitGb} GB · disk=${vs.local.diskUsedGb}/${vs.local.diskLimitGb} GB`,
    };
  }

  async getSnapshot(vs: BotVirtualServerStatus): Promise<BotLiveViewSnapshot> {
    const containerSummary = this.buildContainerSummary(vs);
    const browser = this.ensureBrowser();
    await browser.ensureStarted(true);
    if (!this.initializedBlank) {
      this.initializedBlank = true;
      const cur = await browser.inspect().catch(() => null);
      if (!cur || cur.url === "about:blank") {
        await browser.navigate(WELCOME_HTML_DATA_URL).catch(() => undefined);
      }
    }
    const capture = await browser.screenshot(false);
    return {
      url: capture.snapshot.url.startsWith("data:text/html") ? "about:qianji-live-view" : capture.snapshot.url,
      title: capture.snapshot.title || "千机分身隔离浏览器",
      screenshotBase64: capture.data,
      viewport: { width: 1280, height: 900 },
      containerSummary,
    };
  }

  async navigate(url: string, vs: BotVirtualServerStatus): Promise<BotLiveViewSnapshot> {
    const browser = this.ensureBrowser();
    await browser.ensureStarted(true);
    this.initializedBlank = true;
    await browser.navigate(url);
    return this.getSnapshot(vs);
  }

  async click(x: number, y: number, vs: BotVirtualServerStatus): Promise<BotLiveViewSnapshot> {
    const browser = this.ensureBrowser();
    await browser.ensureStarted(true);
    await browser.clickAt(x, y);
    return this.getSnapshot(vs);
  }

  async scroll(deltaX: number, deltaY: number, vs: BotVirtualServerStatus): Promise<BotLiveViewSnapshot> {
    const browser = this.ensureBrowser();
    await browser.ensureStarted(true);
    await browser.scroll(deltaX, deltaY);
    return this.getSnapshot(vs);
  }

  async typeOrPress(
    input: { text?: string; key?: string },
    vs: BotVirtualServerStatus,
  ): Promise<BotLiveViewSnapshot> {
    const browser = this.ensureBrowser();
    await browser.ensureStarted(true);
    if (input.text !== undefined && input.text !== "") {
      await browser.type(undefined, ":focus", input.text);
    }
    if (input.key !== undefined && input.key.trim() !== "") {
      await browser.press(input.key.trim());
    }
    return this.getSnapshot(vs);
  }

  async executeBrowserTool(call: ToolCall): Promise<ToolOutput> {
    const browser = this.ensureBrowser();
    await browser.ensureStarted(true);
    this.initializedBlank = true;
    const args = call.args;
    const tabId = typeof args.tabId === "string" ? args.tabId : undefined;
    if (tabId) await browser.switchTab(tabId);

    switch (call.name) {
      case "browser_navigate": {
        await browser.navigate(String(args.url ?? ""));
        break;
      }
      case "browser_inspect": {
        const snap = await browser.inspect();
        return textOutput(grokSnapshotText(snap));
      }
      case "browser_screenshot": {
        const capture = await browser.screenshot(false);
        return {
          content: [
            { type: "text", text: `URL: ${capture.snapshot.url}\nTitle: ${capture.snapshot.title || "(untitled)"}` },
            { type: "image", data: capture.data, mimeType: "image/png" },
          ],
          details: { url: capture.snapshot.url, title: capture.snapshot.title },
        };
      }
      case "browser_click": {
        const ref = parseElementRef(args.ref);
        if (ref !== undefined) await browser.click(ref);
        else await browser.clickAt(Number(args.x ?? 0), Number(args.y ?? 0));
        break;
      }
      case "browser_type":
        await browser.type(parseElementRef(args.ref), undefined, String(args.text ?? ""));
        break;
      case "browser_press":
        await browser.press(String(args.key ?? "Enter"));
        break;
      case "browser_scroll":
        await browser.scroll(Number(args.deltaX ?? 0), Number(args.deltaY ?? 0));
        break;
      case "browser_wait":
        await browser.wait(Math.min(30_000, Math.max(0, Number(args.timeoutMs ?? 1000))));
        break;
      case "browser_tabs": {
        const action = String(args.action ?? "list");
        if (action === "list") return textOutput(tabsText(await browser.listTabs()));
        if (action === "create") await browser.newTab(typeof args.url === "string" ? args.url : undefined);
        else if (action === "switch" && tabId) await browser.switchTab(tabId);
        else if (action === "close") await browser.closeTab(tabId);
        break;
      }
      default:
        return textOutput(`Unsupported browser tool: ${call.name}`, true);
    }

    const capture = await browser.screenshot(false);
    return {
      content: [
        { type: "text", text: grokSnapshotText(capture.snapshot) },
        { type: "image", data: capture.data, mimeType: "image/png" },
      ],
      details: { url: capture.snapshot.url, title: capture.snapshot.title },
    };
  }

  async execDiag(command: string, vs: BotVirtualServerStatus): Promise<BotLiveViewExecDiagResult> {
    if (vs.mode === "remote") {
      const password = await this.options.getRemotePassword();
      const res = await this.options.ssh.exec(vs.remote, command, { password, timeoutMs: 20_000 });
      return { stdout: res.stdout, stderr: res.stderr, exitCode: res.exitCode };
    }
    const res = await this.options.wsl.exec(command, {
      cpuCores: vs.local.cpuCores,
      memoryLimitGb: vs.local.memoryLimitGb,
      sharedFolders: vs.local.sharedFolders,
      timeoutMs: 20_000,
    });
    return { stdout: res.stdout, stderr: res.stderr, exitCode: res.exitCode };
  }

  async close(): Promise<void> {
    if (this.browser !== null) {
      await this.browser.close().catch(() => undefined);
      this.browser = null;
    }
  }
}

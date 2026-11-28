/**
 * `local-linux` Virtual Computer Engine (`packages/host/src/bot/computer/local-linux-engine.ts`).
 *
 * Real WSL2 Ubuntu + XFCE4 + x11vnc + RFB WebSocket Proxy + `xdotool` Desktop Agent Engine.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { findBrowserExecutable } from "@qianji/browser";
import type {
  BotComputerFilesListResult,
  BotComputerFilesReadResult,
  BotComputerInputEvent,
  BotComputerPointerTelemetry,
  BotComputerStreamFrame,
  BotComputerStreamTab,
  BotLocalLinuxDesktopStatus,
  BotSharedFolderRule,
  BotVirtualServerStatus,
} from "@qianji/protocol";
import type { BotLiveViewController } from "../live-view.ts";
import { runWslSubprocess, type WslContainerRuntime } from "../wsl-runtime.ts";
import { STUDIO_BROWSER_HEIGHT, STUDIO_BROWSER_WIDTH } from "./cdp-screencast.ts";
import {
  buildUbuntuGuiProvisionScript,
  buildXdotoolScript,
  MINIMAL_PNG_BASE64,
  parseWslVerboseList,
  PREFERRED_UBUNTU_DISTROS,
  selectPreferredUbuntuDistro,
  syncIsolatedCopyWithWorktree,
  type WslDistroEntry,
} from "./linux-gui-helpers.ts";
import { listFencedFiles, readFencedFile } from "./sentinel-fence.ts";
import { startVncWsProxy, type VncWsProxyHandle } from "./vnc-ws-proxy.ts";

export {
  buildXdotoolScript,
  MINIMAL_PNG_BASE64,
  parseWslVerboseList,
  PREFERRED_UBUNTU_DISTROS,
  selectPreferredUbuntuDistro,
  syncIsolatedCopyWithWorktree,
  type WslDistroEntry,
};

function isBrowserInstalledOnHost(): boolean {
  try {
    return Boolean(findBrowserExecutable());
  } catch {
    return false;
  }
}

export interface LocalLinuxEngineOptions {
  wslRunner?: typeof runWslSubprocess;
  vncTargetHost?: string;
  vncTargetPort?: number;
  enableDistroKeepalive?: boolean;
}

export class LocalLinuxComputerEngine {
  private guiProvisioned = false;
  private activeGuiDistro: string | undefined;
  private provisioningStep: string | undefined;
  private cachedGuiStatus: { ts: number; status: BotLocalLinuxDesktopStatus } | undefined;
  private vncProxy: VncWsProxyHandle | null = null;
  private keepaliveChild: ChildProcess | null = null;
  private readonly wslRunner: typeof runWslSubprocess;
  private readonly vncTargetHost: string;
  private readonly vncTargetPort: number;
  private readonly enableKeepalive: boolean;

  constructor(options: LocalLinuxEngineOptions = {}) {
    this.wslRunner = options.wslRunner ?? runWslSubprocess;
    this.vncTargetHost = options.vncTargetHost ?? "127.0.0.1";
    this.vncTargetPort = options.vncTargetPort ?? 5900;
    this.enableKeepalive = options.enableDistroKeepalive ?? (options.wslRunner === undefined);
  }

  getActiveDistro(): string | undefined {
    return this.activeGuiDistro;
  }

  private async ensureVncProxy(port = this.vncTargetPort): Promise<VncWsProxyHandle> {
    if (this.vncProxy !== null) {
      this.vncProxy.updateTarget(this.vncTargetHost, port);
      return this.vncProxy;
    }
    this.vncProxy = await startVncWsProxy({ targetHost: this.vncTargetHost, targetPort: port });
    return this.vncProxy;
  }

  private startDistroKeepalive(distro: string): void {
    if (!this.enableKeepalive || this.keepaliveChild !== null) return;
    const child = spawn("wsl.exe", ["-d", distro, "--cd", "/", "--", "/bin/sh", "-c", "exec sleep 86400"], {
      detached: true, stdio: "ignore", windowsHide: true, env: { ...process.env, WSL_UTF8: "1" },
    });
    child.on("exit", () => { if (this.keepaliveChild === child) this.keepaliveChild = null; });
    child.on("error", () => { if (this.keepaliveChild === child) this.keepaliveChild = null; });
    child.unref();
    this.keepaliveChild = child;
  }

  async resolveGuiDistro(wsl: WslContainerRuntime, vs: BotVirtualServerStatus): Promise<{ distro: string; state: "running" | "stopped" | "not-installed" }> {
    const fallback = vs.local.distroName || wsl.distroName || "Ubuntu-24.04";
    const listRes = await this.wslRunner("wsl.exe", ["--list", "--verbose"], { timeoutMs: 6_000 });
    return selectPreferredUbuntuDistro(parseWslVerboseList(listRes.stdout), fallback);
  }

  async inspectStatus(wsl: WslContainerRuntime, vs: BotVirtualServerStatus): Promise<BotLocalLinuxDesktopStatus> {
    if (this.cachedGuiStatus && Date.now() - this.cachedGuiStatus.ts < 3_500 && !this.provisioningStep) {
      return this.cachedGuiStatus.status;
    }
    const hostChromium = isBrowserInstalledOnHost();
    if (!wsl.isSupported()) {
      const vncReady = this.guiProvisioned && this.vncProxy !== null;
      const fallback: BotLocalLinuxDesktopStatus = {
        distro: process.platform === "linux" ? "host-linux-sandbox" : (this.activeGuiDistro ?? wsl.distroName),
        guiReady: this.guiProvisioned || process.platform === "linux",
        display: ":99",
        resolution: "1280x800",
        chromiumReady: hostChromium,
        ...(this.guiProvisioned ? { windowManager: "xfce4", vncPort: this.vncTargetPort } : {}),
        ...(vncReady && this.vncProxy ? { vncReady: true, vncWsUrl: this.vncProxy.wsUrl } : { vncReady: false }),
        ...(this.provisioningStep ? { provisioningStep: this.provisioningStep } : {}),
        ...(process.platform === "win32" && !this.guiProvisioned
          ? { error: "WSL2 当前不可用，已回退至隔离浏览器与受控工作区" }
          : {}),
      };
      this.cachedGuiStatus = { ts: Date.now(), status: fallback };
      return fallback;
    }

    const resolved = await this.resolveGuiDistro(wsl, vs);
    const targetDistro = this.activeGuiDistro ?? resolved.distro;
    if (resolved.state !== "running" && !this.guiProvisioned) {
      const stopped: BotLocalLinuxDesktopStatus = {
        distro: targetDistro, guiReady: false, display: ":99", resolution: "1280x800",
        chromiumReady: hostChromium, vncReady: false,
        ...(this.provisioningStep ? { provisioningStep: this.provisioningStep } : {}),
      };
      this.cachedGuiStatus = { ts: Date.now(), status: stopped };
      return stopped;
    }

    const probe = await this.wslRunner(
      "wsl.exe",
      ["-d", targetDistro, "--cd", "/", "-u", "root", "--", "/bin/sh", "-s"],
      {
        timeoutMs: 5_000,
        stdin: [
          "if [ -S /tmp/.X11-unix/X99 ] || pgrep -f 'Xvfb :99' >/dev/null 2>&1; then echo GUI=1; else echo GUI=0; fi",
          "if command -v chromium >/dev/null 2>&1 || command -v chromium-browser >/dev/null 2>&1 || command -v google-chrome >/dev/null 2>&1; then echo CHR=1; else echo CHR=0; fi",
          "if command -v startxfce4 >/dev/null 2>&1; then echo WM=xfce4; elif command -v fluxbox >/dev/null 2>&1; then echo WM=fluxbox; else echo WM=; fi",
          `if pgrep -f 'x11vnc' >/dev/null 2>&1; then echo VNC=${this.vncTargetPort}; else echo VNC=0; fi`,
        ].join("\n") + "\n",
      },
    );
    const lines = probe.stdout.split(/\r?\n/);
    const val = (k: string) => lines.find((l) => l.startsWith(`${k}=`))?.slice(k.length + 1).trim() ?? "";
    const guiReady = val("GUI") === "1" || this.guiProvisioned;
    const chromiumReady = val("CHR") === "1" || hostChromium;
    const wm = val("WM");
    const vncPort = Number.parseInt(val("VNC"), 10);
    const vncActive = Number.isFinite(vncPort) && vncPort > 0;
    const proxy = vncActive ? await this.ensureVncProxy(vncPort) : null;

    const status: BotLocalLinuxDesktopStatus = {
      distro: targetDistro, guiReady, display: ":99", resolution: "1280x800", chromiumReady,
      vncReady: Boolean(proxy),
      ...(wm ? { windowManager: wm } : {}),
      ...(vncActive ? { vncPort } : {}),
      ...(proxy ? { vncWsUrl: proxy.wsUrl } : {}),
      ...(this.provisioningStep ? { provisioningStep: this.provisioningStep } : {}),
    };
    this.cachedGuiStatus = { ts: Date.now(), status };
    return status;
  }

  async provisionGui(
    wsl: WslContainerRuntime,
    vs: BotVirtualServerStatus,
  ): Promise<{ ok: boolean; message: string; status: BotLocalLinuxDesktopStatus }> {
    this.cachedGuiStatus = undefined;
    try {
      if (!wsl.isSupported()) {
        this.provisioningStep = "starting-vnc";
        const proxy = await this.ensureVncProxy(this.vncTargetPort);
        this.guiProvisioned = true;
        this.provisioningStep = undefined;
        const status = await this.inspectStatus(wsl, vs);
        return { ok: true, message: `已就绪本地 Linux 虚拟桌面通道 (:99 · ${proxy.wsUrl})`, status };
      }

      this.provisioningStep = "selecting-distro";
      let resolved = await this.resolveGuiDistro(wsl, vs);
      if (resolved.state === "not-installed") {
        const snap = await wsl.wake();
        resolved = { distro: snap.distroName, state: snap.engineState === "running" ? "running" : "stopped" };
      } else if (resolved.state === "stopped") {
        await this.wslRunner("wsl.exe", ["-d", resolved.distro, "--cd", "/", "-u", "root", "--", "true"], { timeoutMs: 20_000 });
      }
      const targetDistro = resolved.distro;
      this.activeGuiDistro = targetDistro;
      if (targetDistro.toLowerCase() !== wsl.distroName.toLowerCase()) {
        this.startDistroKeepalive(targetDistro);
      }

      this.provisioningStep = "installing-packages";
      await this.wslRunner(
        "wsl.exe",
        ["-d", targetDistro, "--cd", "/", "-u", "root", "--", "/bin/sh", "-s"],
        { timeoutMs: 240_000, stdin: `${buildUbuntuGuiProvisionScript(this.vncTargetPort)}\n` },
      );

      this.provisioningStep = "starting-vnc";
      const proxy = await this.ensureVncProxy(this.vncTargetPort);
      this.guiProvisioned = true;
      this.provisioningStep = undefined;
      this.cachedGuiStatus = undefined;
      const status = await this.inspectStatus(wsl, vs);
      const readyStatus: BotLocalLinuxDesktopStatus = {
        ...status, guiReady: true, vncReady: true, vncPort: this.vncTargetPort, vncWsUrl: proxy.wsUrl,
      };
      this.cachedGuiStatus = { ts: Date.now(), status: readyStatus };
      return {
        ok: true,
        message: `Linux XFCE4 桌面 (${readyStatus.distro} · DISPLAY :99 · VNC) 已准备就绪`,
        status: readyStatus,
      };
    } finally {
      this.provisioningStep = undefined;
    }
  }

  async dispatchDesktopInput(
    event: BotComputerInputEvent,
    wsl: WslContainerRuntime,
    vs: BotVirtualServerStatus,
    seq: number,
    cursor?: BotComputerPointerTelemetry,
  ): Promise<BotComputerStreamFrame> {
    const script = buildXdotoolScript(event);
    if (script && wsl.isSupported()) {
      const targetDistro = this.activeGuiDistro ?? (await this.resolveGuiDistro(wsl, vs)).distro;
      await this.wslRunner("wsl.exe", ["-d", targetDistro, "--cd", "/", "--", "/bin/sh", "-c", script], { timeoutMs: 8_000 });
    }
    return {
      engine: "local-linux", tab: "desktop", mimeType: "image/png", dataBase64: MINIMAL_PNG_BASE64,
      width: STUDIO_BROWSER_WIDTH, height: STUDIO_BROWSER_HEIGHT, seq, ts: Date.now(),
      title: `${this.activeGuiDistro ?? wsl.distroName} · DISPLAY :99`, ...(cursor ? { cursor } : {}),
    };
  }

  async captureFrame(
    tab: BotComputerStreamTab,
    liveView: BotLiveViewController,
    wsl: WslContainerRuntime,
    vs: BotVirtualServerStatus,
    seq: number,
    cursor?: BotComputerPointerTelemetry,
  ): Promise<BotComputerStreamFrame> {
    if (tab === "desktop") {
      return {
        engine: "local-linux", tab: "desktop", mimeType: "image/png", dataBase64: MINIMAL_PNG_BASE64,
        width: STUDIO_BROWSER_WIDTH, height: STUDIO_BROWSER_HEIGHT, seq, ts: Date.now(),
        title: `${this.activeGuiDistro ?? wsl.distroName} · DISPLAY :99`, ...(cursor ? { cursor } : {}),
      };
    }
    try {
      const snap = await liveView.getSnapshot(vs);
      return {
        engine: "local-linux", tab: "browser", mimeType: "image/png",
        dataBase64: snap.screenshotBase64 || MINIMAL_PNG_BASE64,
        width: STUDIO_BROWSER_WIDTH, height: STUDIO_BROWSER_HEIGHT, seq, ts: Date.now(),
        url: snap.url, title: snap.title, ...(cursor ? { cursor } : {}),
      };
    } catch {
      return {
        engine: "local-linux", tab, mimeType: "image/png", dataBase64: MINIMAL_PNG_BASE64,
        width: STUDIO_BROWSER_WIDTH, height: STUDIO_BROWSER_HEIGHT, seq, ts: Date.now(),
        title: "Linux 隔离桌面待命", ...(cursor ? { cursor } : {}),
      };
    }
  }

  listWorkspaceFiles(rawPath: string | undefined, botWorkspaceDir: string, sharedFolders: readonly BotSharedFolderRule[]): BotComputerFilesListResult {
    return listFencedFiles("local-linux", rawPath, botWorkspaceDir, sharedFolders, false);
  }

  readWorkspaceFile(rawPath: string, maxBytes: number | undefined, botWorkspaceDir: string, sharedFolders: readonly BotSharedFolderRule[]): BotComputerFilesReadResult {
    return readFencedFile(rawPath, maxBytes, botWorkspaceDir, sharedFolders, false);
  }

  async stop(wsl: WslContainerRuntime): Promise<void> {
    this.guiProvisioned = false;
    this.cachedGuiStatus = undefined;
    await this.dispose();
    if (wsl.isSupported() && this.activeGuiDistro && this.activeGuiDistro.toLowerCase() !== wsl.distroName.toLowerCase()) {
      await this.wslRunner("wsl.exe", ["--terminate", this.activeGuiDistro], { timeoutMs: 10_000 });
    }
  }

  async dispose(): Promise<void> {
    if (this.keepaliveChild !== null) {
      try { this.keepaliveChild.kill(); } catch { /* ignore */ }
      this.keepaliveChild = null;
    }
    if (this.vncProxy !== null) {
      await this.vncProxy.close();
      this.vncProxy = null;
    }
  }
}

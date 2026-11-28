/**
 * `local-linux` Virtual Computer Engine (`packages/host/src/bot/computer/local-linux-engine.ts`).
 *
 * Upgrades local Linux sandbox support:
 * 1. Detects WSL2 Ubuntu/Alpine distros & GUI `Xvfb` (`:99`) / Chromium / VNC readiness.
 * 2. Fast `git worktree add --detach` isolated shared folder sync with `cpSync` fallback.
 * 3. Direct mouse/wheel/key/text/paste CDP input & live frame capture via `BrowserSession`.
 * 4. `/workspace` & `/shared` file listing and reading.
 */
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readdirSync } from "node:fs";
import { join } from "node:path";
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
import { listFencedFiles, readFencedFile } from "./sentinel-fence.ts";

/** Valid 1x1 dark slate PNG fallback frame when headless GUI/browser is initializing. */
export const MINIMAL_PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";

/**
 * Syncs an `isolated-copy` shared folder using `git worktree add --detach` when `.git`
 * is present in the source repository, falling back to filtered `cpSync` otherwise.
 */
export function syncIsolatedCopyWithWorktree(rule: BotSharedFolderRule, copyDir: string): string {
  if (rule.access !== "isolated-copy" || !existsSync(rule.path)) return copyDir;
  if (existsSync(copyDir)) {
    try {
      if (readdirSync(copyDir).length > 0) return copyDir;
    } catch {
      return copyDir;
    }
  }

  const gitMarker = join(rule.path, ".git");
  if (existsSync(gitMarker)) {
    mkdirSync(join(copyDir, ".."), { recursive: true });
    const wt = spawnSync(
      "git",
      ["-C", rule.path, "worktree", "add", "--detach", "--force", copyDir],
      { windowsHide: true, timeout: 25_000 },
    );
    if (wt.error === undefined && wt.status === 0 && existsSync(copyDir)) {
      return copyDir;
    }
  }

  mkdirSync(copyDir, { recursive: true });
  cpSync(rule.path, copyDir, {
    recursive: true,
    filter: (src) => !src.includes(join("node_modules")) && !src.includes("target") && !src.endsWith(".git"),
  });
  return copyDir;
}

interface CdpSendCapable {
  connected?: boolean;
  send?: <T = unknown>(method: string, params?: Record<string, unknown>) => Promise<T>;
}

function formatKeyCombo(key: string, modifiers?: readonly string[]): string {
  if (!modifiers || modifiers.length === 0) return key;
  const prefix = modifiers
    .map((m) => (m === "ctrl" ? "Ctrl" : m === "shift" ? "Shift" : m === "alt" ? "Alt" : "Meta"))
    .filter((m) => !key.toLowerCase().includes(m.toLowerCase()));
  return prefix.length > 0 ? `${prefix.join("+")}+${key}` : key;
}

function isBrowserInstalledOnHost(): boolean {
  try {
    return Boolean(findBrowserExecutable());
  } catch {
    return false;
  }
}

export class LocalLinuxComputerEngine {
  private guiProvisioned = false;
  private cachedGuiStatus: { ts: number; status: BotLocalLinuxDesktopStatus } | undefined;

  async inspectStatus(wsl: WslContainerRuntime, vs: BotVirtualServerStatus): Promise<BotLocalLinuxDesktopStatus> {
    if (this.cachedGuiStatus && Date.now() - this.cachedGuiStatus.ts < 4_000) {
      return this.cachedGuiStatus.status;
    }

    const hostChromium = isBrowserInstalledOnHost();
    if (!wsl.isSupported()) {
      const fallback: BotLocalLinuxDesktopStatus = {
        distro: process.platform === "linux" ? "host-linux-sandbox" : wsl.distroName,
        guiReady: this.guiProvisioned || process.platform === "linux",
        display: ":99",
        resolution: "1280x800",
        chromiumReady: hostChromium,
        ...(this.guiProvisioned ? { windowManager: "fluxbox", vncPort: 5900 } : {}),
        ...(process.platform === "win32" ? { error: "WSL2 当前不可用，已回退至隔离浏览器与受控工作区" } : {}),
      };
      this.cachedGuiStatus = { ts: Date.now(), status: fallback };
      return fallback;
    }

    const wslSnap = await wsl.inspect();
    let detectedDistro = wslSnap.distroName || vs.local.distroName || "qianji-bot-vm";
    if (wslSnap.engineState === "not-installed") {
      const listRes = await runWslSubprocess("wsl.exe", ["--list", "--quiet"], { timeoutMs: 4_000 });
      const candidates = listRes.stdout
        .replace(/\0/g, "")
        .split(/\r?\n/)
        .map((s) => s.trim())
        .filter(Boolean);
      const preferred = candidates.find((c) => /ubuntu|alpine|debian/i.test(c));
      if (preferred) detectedDistro = `${wsl.distroName} (可用基底: ${preferred})`;
    }

    if (wslSnap.engineState !== "running") {
      const stopped: BotLocalLinuxDesktopStatus = {
        distro: detectedDistro,
        guiReady: this.guiProvisioned,
        display: ":99",
        resolution: "1280x800",
        chromiumReady: hostChromium,
      };
      this.cachedGuiStatus = { ts: Date.now(), status: stopped };
      return stopped;
    }

    const probe = await runWslSubprocess(
      "wsl.exe",
      ["-d", wsl.distroName, "--cd", "/", "-u", "root", "--", "/bin/sh", "-s"],
      {
        timeoutMs: 5_000,
        stdin: [
          "if [ -S /tmp/.X11-unix/X99 ] || pgrep -f 'Xvfb :99' >/dev/null 2>&1; then echo GUI=1; else echo GUI=0; fi",
          "if command -v chromium >/dev/null 2>&1 || command -v chromium-browser >/dev/null 2>&1; then echo CHR=1; else echo CHR=0; fi",
          "if command -v fluxbox >/dev/null 2>&1; then echo WM=fluxbox; elif command -v openbox >/dev/null 2>&1; then echo WM=openbox; else echo WM=; fi",
          "if pgrep -f x11vnc >/dev/null 2>&1; then echo VNC=5900; else echo VNC=0; fi",
        ].join("\n") + "\n",
      },
    );
    const lines = probe.stdout.split(/\r?\n/);
    const val = (k: string) => lines.find((l) => l.startsWith(`${k}=`))?.slice(k.length + 1).trim() ?? "";
    const guiReady = val("GUI") === "1" || this.guiProvisioned;
    const chromiumReady = val("CHR") === "1" || hostChromium;
    const wm = val("WM");
    const vncPort = Number.parseInt(val("VNC"), 10);

    const status: BotLocalLinuxDesktopStatus = {
      distro: detectedDistro,
      guiReady,
      display: ":99",
      resolution: "1280x800",
      chromiumReady,
      ...(wm ? { windowManager: wm } : {}),
      ...(Number.isFinite(vncPort) && vncPort > 0 ? { vncPort } : {}),
    };
    this.cachedGuiStatus = { ts: Date.now(), status };
    return status;
  }

  async provisionGui(wsl: WslContainerRuntime, vs: BotVirtualServerStatus): Promise<{ ok: boolean; message: string; status: BotLocalLinuxDesktopStatus }> {
    this.cachedGuiStatus = undefined;
    if (!wsl.isSupported()) {
      this.guiProvisioned = true;
      const status = await this.inspectStatus(wsl, vs);
      return {
        ok: true,
        message: "已就绪本地隔离虚拟显示通道 (:99 · 1280x800) 与受控浏览器层",
        status,
      };
    }

    const snap = await wsl.wake();
    if (snap.engineState === "running") {
      const guiScript = [
        "(apk add --no-cache xvfb fluxbox x11vnc scrot imagemagick >/dev/null 2>&1 || apt-get update && apt-get install -y xvfb fluxbox x11vnc scrot >/dev/null 2>&1) || true",
        "if ! pgrep -f 'Xvfb :99' >/dev/null 2>&1; then nohup Xvfb :99 -screen 0 1280x800x24 -ac >/tmp/xvfb.log 2>&1 & sleep 0.4; fi",
        "if command -v fluxbox >/dev/null 2>&1 && ! pgrep -f fluxbox >/dev/null 2>&1; then DISPLAY=:99 nohup fluxbox >/tmp/fluxbox.log 2>&1 & fi",
        "if command -v x11vnc >/dev/null 2>&1 && ! pgrep -f x11vnc >/dev/null 2>&1; then DISPLAY=:99 nohup x11vnc -display :99 -forever -nopw -rfbport 5900 -quiet >/tmp/x11vnc.log 2>&1 & fi",
      ].join("\n");
      await runWslSubprocess(
        "wsl.exe",
        ["-d", wsl.distroName, "--cd", "/", "-u", "root", "--", "/bin/sh", "-s"],
        { timeoutMs: 90_000, stdin: `${guiScript}\n` },
      );
    }
    this.guiProvisioned = true;
    this.cachedGuiStatus = undefined;
    const status = await this.inspectStatus(wsl, vs);
    return {
      ok: true,
      message: `Linux 桌面环境 (${status.distro} · DISPLAY ${status.display}) 已准备就绪`,
      status,
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
    if (tab === "desktop" && wsl.isSupported()) {
      const snap = await wsl.inspect();
      if (snap.engineState === "running") {
        const cap = await runWslSubprocess(
          "wsl.exe",
          ["-d", wsl.distroName, "--cd", "/tmp", "-u", "bot", "--", "/bin/sh", "-c", "if [ -S /tmp/.X11-unix/X99 ] && command -v scrot >/dev/null 2>&1; then DISPLAY=:99 scrot -o /tmp/.qj_desk.png && (base64 -w 0 /tmp/.qj_desk.png 2>/dev/null || base64 /tmp/.qj_desk.png | tr -d '\\r\\n'); fi"],
          { timeoutMs: 4_000 },
        );
        const b64 = cap.stdout.trim();
        if (cap.exitCode === 0 && b64.length > 64) {
          return {
            engine: "local-linux",
            tab: "desktop",
            mimeType: "image/png",
            dataBase64: b64,
            width: 1280,
            height: 800,
            seq,
            ts: Date.now(),
            title: `${wsl.distroName} · DISPLAY :99`,
            ...(cursor ? { cursor } : {}),
          };
        }
      }
    }

    try {
      const snap = await liveView.getSnapshot(vs);
      return {
        engine: "local-linux",
        tab,
        mimeType: "image/png",
        dataBase64: snap.screenshotBase64 || MINIMAL_PNG_BASE64,
        width: snap.viewport.width,
        height: snap.viewport.height,
        seq,
        ts: Date.now(),
        url: snap.url,
        title: snap.title,
        ...(cursor ? { cursor } : {}),
      };
    } catch {
      return {
        engine: "local-linux",
        tab,
        mimeType: "image/png",
        dataBase64: MINIMAL_PNG_BASE64,
        width: 1280,
        height: 800,
        seq,
        ts: Date.now(),
        title: "Linux 隔离桌面待命",
        ...(cursor ? { cursor } : {}),
      };
    }
  }

  async dispatchBrowserInput(
    event: BotComputerInputEvent,
    liveView: BotLiveViewController,
    wsl: WslContainerRuntime,
    vs: BotVirtualServerStatus,
    seq: number,
    cursor?: BotComputerPointerTelemetry,
  ): Promise<BotComputerStreamFrame> {
    const rawBrowser = liveView.getBrowserSessionForInput();
    await rawBrowser.ensureStarted(true);
    const cdp = (rawBrowser as unknown as { cdp?: CdpSendCapable }).cdp;
    const x = Math.round(event.x ?? cursor?.x ?? 640);
    const y = Math.round(event.y ?? cursor?.y ?? 400);
    const button = event.button ?? "left";

    if (event.kind === "mouse") {
      const action = event.mouseAction ?? "click";
      if (cdp?.connected && typeof cdp.send === "function") {
        if (action === "move") {
          await cdp.send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y });
        } else if (action === "down") {
          await cdp.send("Input.dispatchMouseEvent", { type: "mousePressed", x, y, button, clickCount: 1 });
        } else if (action === "up") {
          await cdp.send("Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button, clickCount: 1 });
        } else if (action === "double-click") {
          await cdp.send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y });
          await cdp.send("Input.dispatchMouseEvent", { type: "mousePressed", x, y, button, clickCount: 2 });
          await cdp.send("Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button, clickCount: 2 });
        } else {
          await cdp.send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y });
          await cdp.send("Input.dispatchMouseEvent", { type: "mousePressed", x, y, button, clickCount: 1 });
          await cdp.send("Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button, clickCount: 1 });
        }
      } else if (action !== "move" && action !== "up") {
        await rawBrowser.clickAt(x, y);
      }
    } else if (event.kind === "wheel") {
      const dx = Math.round(event.deltaX ?? 0);
      const dy = Math.round(event.deltaY ?? 0);
      if (cdp?.connected && typeof cdp.send === "function") {
        await cdp.send("Input.dispatchMouseEvent", { type: "mouseWheel", x, y, deltaX: dx, deltaY: dy });
      } else {
        await rawBrowser.scroll(dx, dy);
      }
    } else if (event.kind === "text" || event.kind === "paste") {
      const text = event.text ?? "";
      if (text !== "") {
        if (cdp?.connected && typeof cdp.send === "function") {
          await cdp.send("Input.insertText", { text });
        } else {
          await rawBrowser.type(undefined, ":focus", text);
        }
      }
    } else if (event.kind === "key" && event.key) {
      const combo = formatKeyCombo(event.key, event.modifiers);
      await rawBrowser.press(combo);
    }

    const tab: BotComputerStreamTab = event.tab === "desktop" ? "desktop" : "browser";
    return this.captureFrame(tab, liveView, wsl, vs, seq, cursor);
  }

  listWorkspaceFiles(
    rawPath: string | undefined,
    botWorkspaceDir: string,
    sharedFolders: readonly BotSharedFolderRule[],
  ): BotComputerFilesListResult {
    return listFencedFiles("local-linux", rawPath, botWorkspaceDir, sharedFolders, false);
  }

  readWorkspaceFile(
    rawPath: string,
    maxBytes: number | undefined,
    botWorkspaceDir: string,
    sharedFolders: readonly BotSharedFolderRule[],
  ): BotComputerFilesReadResult {
    return readFencedFile(rawPath, maxBytes, botWorkspaceDir, sharedFolders, false);
  }
}

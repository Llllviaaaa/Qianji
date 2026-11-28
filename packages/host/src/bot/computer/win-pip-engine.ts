/**
 * `local-win-pip` Virtual Computer Engine (`packages/host/src/bot/computer/win-pip-engine.ts`).
 *
 * Bridges to `--computer-helper` (`Ray-Desktop` Windows Child Session architecture):
 * - Real `WTSEnableChildSessions` / `MsRdpClient` Child Session status (`childSessionEnabled`, `childSessionActive`, `signOutRequired`, `viewerOpen`)
 * - Native `Ray-Desktop` Child Session viewer launch (`win_desktop_open_viewer`)
 * - Isolated Child Session screen capture, `SendInput` dispatch, and app/browser launching
 * - Strict Sentinel Path Fence (`[botWorkspaceDir, ...sharedFolders.map(f => f.path)]`)
 */
import { mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import type {
  BotComputerFilesListResult,
  BotComputerFilesReadResult,
  BotComputerInputEvent,
  BotComputerPointerTelemetry,
  BotComputerStreamFrame,
  BotComputerStreamMimeType,
  BotLocalWinPipStatus,
  BotSharedFolderRule,
} from "@qianji/protocol";
import { MINIMAL_PNG_BASE64 } from "./local-linux-engine.ts";
import { computeFencedRoots, listFencedFiles, readFencedFile } from "./sentinel-fence.ts";
import {
  createSubprocessHelperInvoker,
  isUrlLike,
  normalizeBackend,
  normalizeOpenWindows,
  resolveWinInputAction,
  type ComputerHelperInvoke,
} from "./win-helper-client.ts";

export { createSubprocessHelperInvoker, type ComputerHelperInvoke };

export class WinPipComputerEngine {
  private lastCursor = { x: 640, y: 400 };

  constructor(
    private readonly deps: {
      getBotStorageDir: () => string;
      getBotWorkspaceDir: () => string;
      getSharedFolders: () => readonly BotSharedFolderRule[];
      invokeHelper: ComputerHelperInvoke;
    },
  ) {}

  get isolatedProfileDir(): string {
    const dir = join(resolve(this.deps.getBotStorageDir()), "win-pip-browser-profile");
    mkdirSync(dir, { recursive: true });
    return dir;
  }

  get fencedRoots(): string[] {
    return computeFencedRoots(this.deps.getBotWorkspaceDir(), this.deps.getSharedFolders());
  }

  async inspectStatus(): Promise<BotLocalWinPipStatus> {
    const isolatedProfileDir = this.isolatedProfileDir;
    const fencedRoots = this.fencedRoots;
    try {
      const res = await this.deps.invokeHelper({
        action: "win_desktop_status",
        isolatedProfileDir,
        workspaceDir: this.deps.getBotWorkspaceDir(),
      });
      const childSessionId = typeof res.childSessionId === "number" ? res.childSessionId : undefined;
      const childSessionActive =
        typeof res.childSessionActive === "boolean"
          ? res.childSessionActive
          : typeof childSessionId === "number" && childSessionId > 0;
      return {
        accountMode: "current-user",
        backend: normalizeBackend(res.backend),
        proSupported: Boolean(res.proSupported),
        childSessionEnabled: Boolean(res.childSessionEnabled),
        childSessionActive,
        signOutRequired: Boolean(res.signOutRequired),
        viewerOpen: Boolean(res.viewerOpen),
        ...(childSessionId !== undefined ? { childSessionId } : {}),
        desktopName: typeof res.desktopName === "string" && res.desktopName ? res.desktopName : "QianjiChildSession",
        isolatedProfileDir,
        fencedRoots,
        openWindows: normalizeOpenWindows(res.openWindows),
        resolution: typeof res.resolution === "string" ? res.resolution : "1280x800",
        ...(typeof res.elevationHint === "string" ? { elevationHint: res.elevationHint } : {}),
        ...(typeof res.error === "string" ? { error: res.error } : {}),
      };
    } catch (err) {
      return {
        accountMode: "current-user",
        backend: process.platform === "win32" ? "rdp-child-session" : "unavailable",
        proSupported: process.platform === "win32",
        childSessionEnabled: false,
        childSessionActive: false,
        signOutRequired: false,
        viewerOpen: false,
        desktopName: "QianjiChildSession",
        isolatedProfileDir,
        fencedRoots,
        openWindows: [],
        resolution: "1280x800",
        ...(err instanceof Error ? { error: err.message } : {}),
      };
    }
  }

  async enableChildSession(): Promise<{
    ok: boolean;
    message: string;
    elevationRequired?: boolean;
    status: BotLocalWinPipStatus;
  }> {
    try {
      const res = await this.deps.invokeHelper(
        {
          action: "win_desktop_enable_child_session",
          isolatedProfileDir: this.isolatedProfileDir,
          workspaceDir: this.deps.getBotWorkspaceDir(),
        },
        60_000,
      );
      const enabled = Boolean(res.enabled ?? res.childSessionEnabled);
      const signOutRequired = Boolean(res.signOutRequired);
      const elevationRequired = Boolean(res.requiresElevation ?? res.elevationRequired);
      const hint = typeof res.elevationHint === "string" ? res.elevationHint : undefined;
      const base = await this.inspectStatus();
      const status: BotLocalWinPipStatus = {
        ...base,
        childSessionEnabled: enabled || base.childSessionEnabled,
        signOutRequired: signOutRequired || Boolean(base.signOutRequired),
        ...(hint ? { elevationHint: hint } : {}),
      };
      const message =
        typeof res.message === "string" && res.message
          ? res.message
          : enabled && status.signOutRequired
            ? "已开启系统 Child Sessions，请注销并重新登录一次 Windows 以激活免密独立桌面"
            : enabled
              ? "已开启 Windows Child Sessions 独立子会话桌面"
              : hint ?? "启用 Windows Child Sessions 需要管理员权限";
      return {
        ok: enabled,
        message,
        ...(elevationRequired ? { elevationRequired: true } : {}),
        status,
      };
    } catch (err) {
      const status = await this.inspectStatus();
      return {
        ok: false,
        elevationRequired: true,
        message: err instanceof Error ? err.message : "启用 Windows Child Sessions 需要管理员权限",
        status,
      };
    }
  }

  async openNativeViewer(): Promise<{
    ok: boolean;
    message: string;
    elevationRequired?: boolean;
    status: BotLocalWinPipStatus;
  }> {
    try {
      const res = await this.deps.invokeHelper({
        action: "win_desktop_open_viewer",
        isolatedProfileDir: this.isolatedProfileDir,
        workspaceDir: this.deps.getBotWorkspaceDir(),
      });
      const base = await this.inspectStatus();
      const signOutRequired = Boolean(res.signOutRequired ?? base.signOutRequired);
      const elevationRequired = Boolean(res.requiresElevation ?? res.elevationRequired);
      const ok = res.ok !== false && !signOutRequired && !elevationRequired;
      const status: BotLocalWinPipStatus = {
        ...base,
        signOutRequired,
        viewerOpen: typeof res.viewerOpen === "boolean" ? res.viewerOpen : ok || Boolean(base.viewerOpen),
        childSessionActive:
          typeof res.childSessionActive === "boolean" ? res.childSessionActive : Boolean(base.childSessionActive),
      };
      const message =
        typeof res.message === "string" && res.message
          ? res.message
          : signOutRequired
            ? "已开启系统 Child Sessions，请注销并重新登录一次 Windows 以激活免密独立桌面"
            : ok
              ? "已打开 Windows 独立子会话桌面窗口"
              : "请先开启系统 Child Sessions 后再打开独立桌面窗口";
      return {
        ok,
        message,
        ...(elevationRequired ? { elevationRequired: true } : {}),
        status,
      };
    } catch (err) {
      const status = await this.inspectStatus();
      return {
        ok: false,
        message: err instanceof Error ? err.message : "无法启动 Windows 独立子会话桌面窗口",
        status,
      };
    }
  }

  async launch(params: { launchKind?: "browser" | "app"; appOrUrl?: string }): Promise<{
    ok: boolean;
    message: string;
    status: BotLocalWinPipStatus;
  }> {
    const isolatedProfileDir = this.isolatedProfileDir;
    const rawTarget = params.appOrUrl?.trim() ?? "";
    const kind: "browser" | "app" = params.launchKind ?? (rawTarget === "" || isUrlLike(rawTarget) ? "browser" : "app");
    const url = kind === "browser" ? (rawTarget || "https://example.com") : undefined;
    const app = kind === "app" ? (rawTarget || "notepad.exe") : undefined;

    try {
      const res = await this.deps.invokeHelper({
        action: "win_desktop_launch",
        kind,
        ...(app ? { app } : {}),
        ...(url ? { url } : {}),
        cwd: this.deps.getBotWorkspaceDir(),
        isolatedProfileDir,
      });
      const status = await this.inspectStatus();
      return {
        ok: res.ok !== false,
        message:
          kind === "browser"
            ? `已在 Windows 独立桌面启动隔离配置浏览器 (${url})`
            : `已在 Windows 独立桌面启动应用 (${app})`,
        status,
      };
    } catch (err) {
      const status = await this.inspectStatus();
      return {
        ok: false,
        message: err instanceof Error ? err.message : "Windows 独立桌面辅助服务未就绪",
        status,
      };
    }
  }

  async closeWindow(hwnd?: string, closeAll = false): Promise<BotLocalWinPipStatus> {
    try {
      await this.deps.invokeHelper({
        action: "win_desktop_close_window",
        ...(hwnd ? { hwnd } : {}),
        ...(closeAll ? { closeAll: true } : {}),
      });
    } catch {
      // Helper unavailable in headless unit tests.
    }
    return this.inspectStatus();
  }

  async sleepDesktop(): Promise<BotLocalWinPipStatus> {
    try {
      await this.deps.invokeHelper({
        action: "win_desktop_close_window",
        closeAll: true,
      });
    } catch {
      // Ignore if Child Session agent is not running.
    }
    let closedViewer = false;
    try {
      const res = await this.deps.invokeHelper({
        action: "win_desktop_open_viewer",
        mode: "close",
        isolatedProfileDir: this.isolatedProfileDir,
        workspaceDir: this.deps.getBotWorkspaceDir(),
      });
      if (res.viewerOpen === false || res.ok !== false) {
        closedViewer = true;
      }
    } catch {
      // Ignore if viewer control endpoint is not running.
    }
    const status = await this.inspectStatus();
    return closedViewer ? { ...status, viewerOpen: false } : status;
  }

  async captureFrame(seq: number, cursor?: BotComputerPointerTelemetry): Promise<BotComputerStreamFrame> {
    const cx = Math.round(cursor?.x ?? this.lastCursor.x);
    const cy = Math.round(cursor?.y ?? this.lastCursor.y);
    try {
      const res = await this.deps.invokeHelper({
        action: "win_desktop_capture",
        width: 1280,
        height: 800,
        drawCursor: true,
        cursorX: cx,
        cursorY: cy,
      });
      const b64 =
        typeof res.dataBase64 === "string" && res.dataBase64
          ? res.dataBase64
          : typeof res.data === "string" && res.data
            ? res.data
            : MINIMAL_PNG_BASE64;
      const mimeType: BotComputerStreamMimeType =
        res.mimeType === "image/jpeg" || res.mimeType === "image/webp" ? res.mimeType : "image/png";
      return {
        engine: "local-win-pip",
        tab: "desktop",
        mimeType,
        dataBase64: b64,
        width: typeof res.width === "number" && res.width > 0 ? res.width : 1280,
        height: typeof res.height === "number" && res.height > 0 ? res.height : 800,
        seq,
        ts: Date.now(),
        title: typeof res.title === "string" && res.title ? res.title : "Windows 独立子会话桌面",
        ...(cursor ? { cursor } : {}),
      };
    } catch {
      return {
        engine: "local-win-pip",
        tab: "desktop",
        mimeType: "image/png",
        dataBase64: MINIMAL_PNG_BASE64,
        width: 1280,
        height: 800,
        seq,
        ts: Date.now(),
        title: "Windows 独立子会话桌面",
        ...(cursor ? { cursor } : {}),
      };
    }
  }

  async dispatchInput(
    event: BotComputerInputEvent,
    seq: number,
    cursor?: BotComputerPointerTelemetry,
  ): Promise<BotComputerStreamFrame> {
    if (typeof event.x === "number") this.lastCursor.x = Math.round(event.x);
    if (typeof event.y === "number") this.lastCursor.y = Math.round(event.y);
    try {
      await this.deps.invokeHelper({
        action: "win_desktop_input",
        inputAction: resolveWinInputAction(event),
        kind: event.kind,
        ...(event.mouseAction ? { mouseAction: event.mouseAction } : {}),
        ...(event.button ? { button: event.button } : {}),
        x: this.lastCursor.x,
        y: this.lastCursor.y,
        ...(typeof event.deltaX === "number" ? { deltaX: Math.round(event.deltaX) } : {}),
        ...(typeof event.deltaY === "number" ? { deltaY: Math.round(event.deltaY) } : {}),
        ...(event.key ? { key: event.key } : {}),
        ...(event.text !== undefined ? { text: event.text } : {}),
        ...(event.modifiers ? { modifiers: event.modifiers } : {}),
      });
    } catch {
      // Graceful no-op when helper binary is absent.
    }
    return this.captureFrame(seq, cursor);
  }

  listFiles(rawPath?: string): BotComputerFilesListResult {
    return listFencedFiles("local-win-pip", rawPath, this.deps.getBotWorkspaceDir(), this.deps.getSharedFolders(), false);
  }

  readFile(rawPath: string, maxBytes?: number): BotComputerFilesReadResult {
    return readFencedFile(rawPath, maxBytes, this.deps.getBotWorkspaceDir(), this.deps.getSharedFolders(), false);
  }
}

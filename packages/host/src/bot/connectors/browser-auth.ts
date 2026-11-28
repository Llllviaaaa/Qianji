/**
 * Native Chromium `--app` popup authentication & headless cookie verification for
 * browser-based Bot Connectors (`Gmail`, `Google Calendar`, `Google Drive`,
 * `GitHub`, `Outlook`, `Slack`, `Figma`).
 *
 * Launches Edge/Chrome WITHOUT `--headless` or `--remote-debugging-port` so
 * Google/Microsoft/GitHub anti-automation checks pass cleanly, sharing the Bot
 * persistent `--user-data-dir` profile.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import {
  BrowserSession,
  cleanupOrphanedBrowserProfile,
  findBrowserExecutable,
  type PageSnapshot,
} from "@qianji/browser";

export interface BrowserAuthSpec {
  readonly id: string;
  readonly loginUrl: string;
  readonly verifyUrl: string;
  readonly isAuthenticated: (url: URL) => boolean;
  readonly defaultLabel: string;
  readonly writeCapable: boolean;
  readonly kind: "google" | "github" | "outlook" | "slack" | "figma" | "custom";
}

export type BrowserAuthResult =
  | { readonly status: "connected"; readonly accountLabel: string; readonly writeCapable: boolean }
  | { readonly status: "pending"; readonly loginUrl: string }
  | { readonly status: "not_authenticated"; readonly message: string };

interface ActivePopupAuth {
  readonly connectorId: string;
  readonly child: ChildProcess;
  cancelled: boolean;
  completingManually: boolean;
}

const BROWSER_AUTH_SPECS: Readonly<Record<string, BrowserAuthSpec>> = {
  gmail: {
    id: "gmail",
    loginUrl:
      "https://accounts.google.com/ServiceLogin?service=mail&continue=https%3A%2F%2Fmail.google.com%2Fmail%2Fu%2F0%2F",
    verifyUrl: "https://mail.google.com/mail/u/0/",
    isAuthenticated: (u) => u.hostname === "mail.google.com" && u.pathname.startsWith("/mail"),
    defaultLabel: "Google 账号 (Gmail)",
    writeCapable: true,
    kind: "google",
  },
  calendar: {
    id: "calendar",
    loginUrl: "https://calendar.google.com/calendar/r",
    verifyUrl: "https://calendar.google.com/calendar/r",
    isAuthenticated: (u) => u.hostname === "calendar.google.com" && u.pathname.startsWith("/calendar"),
    defaultLabel: "Google 日历账号",
    writeCapable: false,
    kind: "google",
  },
  google_drive: {
    id: "google_drive",
    loginUrl: "https://drive.google.com/drive/my-drive",
    verifyUrl: "https://drive.google.com/drive/my-drive",
    isAuthenticated: (u) => u.hostname === "drive.google.com" && u.pathname.startsWith("/drive"),
    defaultLabel: "Google 云端硬盘",
    writeCapable: false,
    kind: "google",
  },
  github: {
    id: "github",
    loginUrl: "https://github.com/login?return_to=%2Fsettings%2Fprofile",
    verifyUrl: "https://github.com/settings/profile",
    isAuthenticated: (u) => u.hostname === "github.com" && u.pathname.startsWith("/settings"),
    defaultLabel: "GitHub 账号",
    writeCapable: true,
    kind: "github",
  },
  outlook: {
    id: "outlook",
    loginUrl: "https://outlook.live.com/mail/0/",
    verifyUrl: "https://outlook.live.com/mail/0/",
    isAuthenticated: (u) =>
      (u.hostname === "outlook.live.com" ||
        u.hostname === "outlook.office.com" ||
        u.hostname === "outlook.office365.com") &&
      u.pathname.startsWith("/mail"),
    defaultLabel: "Outlook 邮箱",
    writeCapable: true,
    kind: "outlook",
  },
  slack: {
    id: "slack",
    loginUrl: "https://app.slack.com/client",
    verifyUrl: "https://app.slack.com/client",
    isAuthenticated: (u) => u.hostname === "app.slack.com" && /^\/client\/[A-Z0-9]/i.test(u.pathname),
    defaultLabel: "Slack 工作区",
    writeCapable: true,
    kind: "slack",
  },
  figma: {
    id: "figma",
    loginUrl: "https://www.figma.com/files",
    verifyUrl: "https://www.figma.com/files",
    isAuthenticated: (u) => u.hostname.endsWith("figma.com") && u.pathname.startsWith("/files"),
    defaultLabel: "Figma 账号",
    writeCapable: false,
    kind: "figma",
  },
};

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function waitForExit(child: ChildProcess, timeoutMs: number): Promise<boolean> {
  if (child.exitCode !== null) return Promise.resolve(true);
  return new Promise((resolve) => {
    const onDone = () => {
      clearTimeout(timer);
      resolve(true);
    };
    const timer = setTimeout(() => {
      child.off("close", onDone);
      resolve(child.exitCode !== null);
    }, timeoutMs);
    child.once("close", onDone);
  });
}

async function closePopupGracefully(child: ChildProcess): Promise<void> {
  const pid = child.pid;
  if (!pid || child.exitCode !== null) return;
  if (process.platform === "win32") {
    // Graceful WM_CLOSE first so Chromium flushes cookies cleanly to SQLite.
    spawn("taskkill", ["/PID", String(pid)], { windowsHide: true, stdio: "ignore" });
    const exited = await waitForExit(child, 2_500);
    if (!exited) {
      spawn("taskkill", ["/PID", String(pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" });
      await waitForExit(child, 1_500);
    }
    return;
  }
  child.kill("SIGTERM");
  const exited = await waitForExit(child, 2_500);
  if (!exited) {
    child.kill("SIGKILL");
    await waitForExit(child, 1_000);
  }
}

function extractAccountLabel(spec: BrowserAuthSpec, snap: PageSnapshot): string {
  const combined = `${snap.title}\n${snap.text.slice(0, 1200)}`;
  if (spec.kind === "google" || spec.kind === "outlook") {
    const emailMatch = /([a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,})/.exec(combined);
    if (emailMatch?.[1]) return emailMatch[1];
  }
  if (spec.kind === "github") {
    const userMatch = /@([a-zA-Z0-9-]+)|Your profile\s*\(([^)]+)\)/i.exec(combined);
    if (userMatch?.[1]) return `@${userMatch[1]}`;
    if (userMatch?.[2]) return `@${userMatch[2]}`;
  }
  const title = snap.title.trim();
  if (
    title &&
    !/^(sign in|log in|login|slack|figma|google|github|outlook)/i.test(title)
  ) {
    return title.slice(0, 64);
  }
  return spec.defaultLabel;
}

export function getBrowserAuthSpec(connectorId: string): BrowserAuthSpec | undefined {
  return BROWSER_AUTH_SPECS[connectorId];
}

export function buildCustomBrowserAuthSpec(input: {
  id: string;
  loginUrl: string;
  defaultLabel: string;
  writeCapable?: boolean;
}): BrowserAuthSpec {
  let expectedOrigin = "";
  try {
    expectedOrigin = new URL(input.loginUrl).origin;
  } catch {
    expectedOrigin = "";
  }
  return {
    id: input.id,
    loginUrl: input.loginUrl,
    verifyUrl: input.loginUrl,
    isAuthenticated: (u) => {
      if (expectedOrigin && u.origin !== expectedOrigin) return false;
      return !/\/(login|signin|sign-in|auth|passport|oauth)\b/i.test(u.pathname);
    },
    defaultLabel: input.defaultLabel,
    writeCapable: input.writeCapable === true,
    kind: "custom",
  };
}

export class BrowserConnectorAuthManager {
  private activeAuth: ActivePopupAuth | null = null;

  async cancelAuth(): Promise<void> {
    const cur = this.activeAuth;
    if (!cur) return;
    cur.cancelled = true;
    this.activeAuth = null;
    await closePopupGracefully(cur.child);
  }

  async verifyLogin(
    connectorId: string,
    options: {
      profileDir: string;
      workspaceDir: string;
      closeLiveView: () => Promise<void>;
      customSpec?: BrowserAuthSpec;
    },
  ): Promise<{ authenticated: boolean; accountLabel: string; writeCapable: boolean }> {
    const spec = BROWSER_AUTH_SPECS[connectorId] ?? options.customSpec;
    if (!spec) throw new Error(`Unsupported browser connector: ${connectorId}`);

    await options.closeLiveView();
    await cleanupOrphanedBrowserProfile(options.profileDir);

    const session = new BrowserSession({
      profileDir: options.profileDir,
      workspace: options.workspaceDir,
    });
    try {
      await session.ensureStarted(true);
      await session.navigate(spec.verifyUrl);
      const snap = await session.inspect();
      const parsed = new URL(snap.url);
      const authenticated = spec.isAuthenticated(parsed);
      return {
        authenticated,
        accountLabel: authenticated ? extractAccountLabel(spec, snap) : spec.defaultLabel,
        writeCapable: spec.writeCapable,
      };
    } finally {
      await session.close().catch(() => undefined);
    }
  }

  async startAuth(
    connectorId: string,
    options: {
      forceInteractive?: boolean;
      profileDir: string;
      workspaceDir: string;
      closeLiveView: () => Promise<void>;
      customSpec?: BrowserAuthSpec;
      onAutoCompleted?: (res: { authenticated: boolean; accountLabel: string; writeCapable: boolean }) => void | Promise<void>;
    },
  ): Promise<BrowserAuthResult> {
    const spec = BROWSER_AUTH_SPECS[connectorId] ?? options.customSpec;
    if (!spec) throw new Error(`Unsupported browser connector: ${connectorId}`);

    await this.cancelAuth();
    await options.closeLiveView();
    await cleanupOrphanedBrowserProfile(options.profileDir);

    if (!options.forceInteractive && existsSync(join(options.profileDir, "Default"))) {
      const check = await this.verifyLogin(connectorId, options).catch(() => null);
      if (check?.authenticated) {
        return { status: "connected", accountLabel: check.accountLabel, writeCapable: check.writeCapable };
      }
    }

    const executable = findBrowserExecutable();
    const args = [
      `--user-data-dir=${options.profileDir}`,
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-background-mode",
      "--window-size=560,720",
      `--app=${spec.loginUrl}`,
    ];
    const child = spawn(executable, args, { stdio: "ignore", windowsHide: false });
    const handle: ActivePopupAuth = {
      connectorId,
      child,
      cancelled: false,
      completingManually: false,
    };
    this.activeAuth = handle;

    child.once("close", () => {
      if (this.activeAuth === handle) this.activeAuth = null;
      if (handle.cancelled || handle.completingManually) return;
      void (async () => {
        await delay(300);
        const check = await this.verifyLogin(connectorId, options).catch(() => ({
          authenticated: false,
          accountLabel: spec.defaultLabel,
          writeCapable: spec.writeCapable,
        }));
        await options.onAutoCompleted?.(check);
      })();
    });

    return { status: "pending", loginUrl: spec.loginUrl };
  }

  async completeAuth(
    connectorId: string,
    options: {
      profileDir: string;
      workspaceDir: string;
      closeLiveView: () => Promise<void>;
      customSpec?: BrowserAuthSpec;
      onAutoCompleted?: (res: { authenticated: boolean; accountLabel: string; writeCapable: boolean }) => void | Promise<void>;
    },
  ): Promise<BrowserAuthResult> {
    const spec = BROWSER_AUTH_SPECS[connectorId] ?? options.customSpec;
    if (!spec) throw new Error(`Unsupported browser connector: ${connectorId}`);

    if (this.activeAuth && this.activeAuth.connectorId === connectorId) {
      const cur = this.activeAuth;
      cur.completingManually = true;
      this.activeAuth = null;
      await closePopupGracefully(cur.child);
      await delay(300);
    }

    const check = await this.verifyLogin(connectorId, options);
    if (check.authenticated) {
      return {
        status: "connected",
        accountLabel: check.accountLabel,
        writeCapable: check.writeCapable,
      };
    }

    await this.startAuth(connectorId, { ...options, forceInteractive: true });
    return {
      status: "not_authenticated",
      message: "尚未检测到登录成功状态，请先在弹出的窗口中完成账号登录。",
    };
  }
}

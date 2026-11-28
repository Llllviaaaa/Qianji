/**
 * WSL2 Ubuntu GUI Distro Selection, XFCE4/x11vnc Provisioning Script, `xdotool` Builder,
 * and `git worktree` Shared Folder Sync (`packages/host/src/bot/computer/linux-gui-helpers.ts`).
 */
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readdirSync } from "node:fs";
import { join } from "node:path";
import type { BotComputerInputEvent, BotSharedFolderRule } from "@qianji/protocol";
import { STUDIO_BROWSER_HEIGHT, STUDIO_BROWSER_WIDTH } from "./cdp-screencast.ts";

/** Valid 1x1 dark slate PNG fallback frame when headless GUI/browser is initializing. */
export const MINIMAL_PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";

export const PREFERRED_UBUNTU_DISTROS = [
  "qianji-ubuntu-vm",
  "Ubuntu-24.04",
  "Ubuntu-22.04",
  "Ubuntu",
  "Debian",
] as const;

export interface WslDistroEntry {
  name: string;
  state: string;
}

export function parseWslVerboseList(stdout: string): WslDistroEntry[] {
  const lines = stdout.replace(/\0/g, "").split(/\r?\n/).slice(1);
  const out: WslDistroEntry[] = [];
  for (const raw of lines) {
    const cleaned = raw.replace(/^\s*\*?\s*/, "").trim();
    if (cleaned === "") continue;
    const parts = cleaned.split(/\s{2,}/);
    if (parts[0] && parts[1]) {
      out.push({ name: parts[0].trim(), state: parts[1].trim() });
    }
  }
  return out;
}

export function selectPreferredUbuntuDistro(
  distros: readonly WslDistroEntry[],
  fallbackDistro: string,
): { distro: string; state: "running" | "stopped" | "not-installed" } {
  for (const preferred of PREFERRED_UBUNTU_DISTROS) {
    const hit = distros.find((d) => d.name.toLowerCase() === preferred.toLowerCase());
    if (hit) {
      return { distro: hit.name, state: hit.state.toLowerCase() === "running" ? "running" : "stopped" };
    }
  }
  const ubuntuOrDebian = distros.find((d) => /^(?:ubuntu|debian)/i.test(d.name));
  if (ubuntuOrDebian) {
    return {
      distro: ubuntuOrDebian.name,
      state: ubuntuOrDebian.state.toLowerCase() === "running" ? "running" : "stopped",
    };
  }
  const fallbackHit = distros.find((d) => d.name.toLowerCase() === fallbackDistro.toLowerCase());
  if (fallbackHit) {
    return { distro: fallbackHit.name, state: fallbackHit.state.toLowerCase() === "running" ? "running" : "stopped" };
  }
  return { distro: fallbackDistro, state: "not-installed" };
}

export function syncIsolatedCopyWithWorktree(rule: BotSharedFolderRule, copyDir: string): string {
  if (rule.access !== "isolated-copy" || !existsSync(rule.path)) return copyDir;
  if (existsSync(copyDir)) {
    try {
      if (readdirSync(copyDir).length > 0) return copyDir;
    } catch {
      return copyDir;
    }
  }
  if (existsSync(join(rule.path, ".git"))) {
    mkdirSync(join(copyDir, ".."), { recursive: true });
    const wt = spawnSync(
      "git",
      ["-C", rule.path, "worktree", "add", "--detach", "--force", copyDir],
      { windowsHide: true, timeout: 25_000 },
    );
    if (wt.error === undefined && wt.status === 0 && existsSync(copyDir)) return copyDir;
  }
  mkdirSync(copyDir, { recursive: true });
  cpSync(rule.path, copyDir, {
    recursive: true,
    filter: (src) => !src.includes(join("node_modules")) && !src.includes("target") && !src.endsWith(".git"),
  });
  return copyDir;
}

export function buildUbuntuGuiProvisionScript(rfbPort: number): string {
  return [
    "export DEBIAN_FRONTEND=noninteractive",
    "if command -v apt-get >/dev/null 2>&1; then",
    "  if ! command -v Xvfb >/dev/null 2>&1 || ! command -v startxfce4 >/dev/null 2>&1 || ! command -v x11vnc >/dev/null 2>&1 || ! command -v xdotool >/dev/null 2>&1 || ! command -v dbus-launch >/dev/null 2>&1; then",
    "    apt-get update && apt-get install -y xvfb xfce4 x11vnc xdotool dbus-x11 fonts-noto-cjk x11-xserver-utils",
    "    apt-get remove -y light-locker xfce4-screensaver xfce4-power-manager || true",
    "  fi",
    "  mkdir -p /run/dbus /var/run/dbus && (dbus-uuidgen --ensure=/etc/machine-id 2>/dev/null || true)",
    "elif command -v apk >/dev/null 2>&1; then",
    "  apk add --no-cache xvfb xfce4 x11vnc xdotool dbus-x11 font-noto-cjk >/dev/null 2>&1 || true",
    "fi",
    "if ! pgrep -f 'Xvfb :99' >/dev/null 2>&1; then",
    "  nohup Xvfb :99 -screen 0 1280x800x24 -ac >/tmp/qianji-xvfb.log 2>&1 </dev/null &",
    "  for _i in 1 2 3 4 5 6 7 8 9 10; do [ -S /tmp/.X11-unix/X99 ] && break; sleep 0.2; done",
    "fi",
    "DISPLAY=:99 xset s off -dpms >/dev/null 2>&1 || true",
    "if command -v startxfce4 >/dev/null 2>&1 && ! pgrep -f 'xfce4-session' >/dev/null 2>&1 && ! pgrep -f 'startxfce4' >/dev/null 2>&1; then",
    "  DISPLAY=:99 nohup dbus-launch startxfce4 >/tmp/qianji-xfce4.log 2>&1 </dev/null &",
    "  sleep 0.5",
    "fi",
    "if command -v x11vnc >/dev/null 2>&1 && ! pgrep -f 'x11vnc.*:99' >/dev/null 2>&1; then",
    `  nohup x11vnc -display :99 -forever -shared -nopw -rfbport ${rfbPort} >/tmp/qianji-x11vnc.log 2>&1 </dev/null &`,
    "  sleep 0.4",
    "fi",
  ].join("\n");
}

const XDOTOOL_KEY_MAP: Record<string, string> = {
  enter: "Return", return: "Return", backspace: "BackSpace", tab: "Tab",
  escape: "Escape", esc: "Escape", space: "space", " ": "space",
  delete: "Delete", insert: "Insert", home: "Home", end: "End",
  pageup: "Prior", pagedown: "Next",
  arrowleft: "Left", left: "Left", arrowup: "Up", up: "Up",
  arrowright: "Right", right: "Right", arrowdown: "Down", down: "Down",
};

export function buildXdotoolScript(event: BotComputerInputEvent): string | null {
  const sx = event.viewportWidth && event.viewportWidth > 0 ? STUDIO_BROWSER_WIDTH / event.viewportWidth : 1;
  const sy = event.viewportHeight && event.viewportHeight > 0 ? STUDIO_BROWSER_HEIGHT / event.viewportHeight : 1;
  const x = Math.max(0, Math.min(STUDIO_BROWSER_WIDTH, Math.round((event.x ?? 640) * sx)));
  const y = Math.max(0, Math.min(STUDIO_BROWSER_HEIGHT, Math.round((event.y ?? 400) * sy)));
  const btn = event.button === "right" ? 3 : event.button === "middle" ? 2 : 1;

  if (event.kind === "mouse") {
    const act = event.mouseAction ?? "click";
    if (act === "move") return `DISPLAY=:99 xdotool mousemove --sync ${x} ${y}`;
    if (act === "down") return `DISPLAY=:99 xdotool mousemove --sync ${x} ${y} mousedown ${btn}`;
    if (act === "up") return `DISPLAY=:99 xdotool mousemove --sync ${x} ${y} mouseup ${btn}`;
    if (act === "double-click") return `DISPLAY=:99 xdotool mousemove --sync ${x} ${y} click --repeat 2 --delay 80 ${btn}`;
    if (typeof event.endX === "number" && typeof event.endY === "number") {
      const ex = Math.max(0, Math.min(STUDIO_BROWSER_WIDTH, Math.round(event.endX * sx)));
      const ey = Math.max(0, Math.min(STUDIO_BROWSER_HEIGHT, Math.round(event.endY * sy)));
      return `DISPLAY=:99 xdotool mousemove --sync ${x} ${y} mousedown ${btn} mousemove --sync ${ex} ${ey} mouseup ${btn}`;
    }
    return `DISPLAY=:99 xdotool mousemove --sync ${x} ${y} click ${btn}`;
  }
  if (event.kind === "wheel") {
    const dy = Math.round(event.deltaY ?? 0);
    const dx = Math.round(event.deltaX ?? 0);
    const cmds = [`mousemove --sync ${x} ${y}`];
    if (dy !== 0) cmds.push(`click --repeat ${Math.max(1, Math.min(10, Math.round(Math.abs(dy) / 100) || 1))} ${dy > 0 ? 5 : 4}`);
    if (dx !== 0) cmds.push(`click --repeat ${Math.max(1, Math.min(10, Math.round(Math.abs(dx) / 100) || 1))} ${dx > 0 ? 7 : 6}`);
    return `DISPLAY=:99 xdotool ${cmds.join(" ")}`;
  }
  if ((event.kind === "text" || event.kind === "paste") && event.text) {
    const b64 = Buffer.from(event.text, "utf8").toString("base64");
    return `printf '%s' '${b64}' | base64 -d | DISPLAY=:99 xdotool type --clearmodifiers --delay 10 --file -`;
  }
  if (event.kind === "key" && event.key) {
    const mods = (event.modifiers ?? []).map((m) => (m === "meta" ? "super" : m));
    const mapped = XDOTOOL_KEY_MAP[event.key.toLowerCase()] ?? (/^[a-zA-Z0-9]$/.test(event.key) ? event.key : "");
    if (mapped !== "") return `DISPLAY=:99 xdotool key --clearmodifiers ${[...mods, mapped].join("+")}`;
    if (mods.length === 0) {
      const b64 = Buffer.from(event.text ?? event.key, "utf8").toString("base64");
      return `printf '%s' '${b64}' | base64 -d | DISPLAY=:99 xdotool type --clearmodifiers --delay 10 --file -`;
    }
  }
  return null;
}

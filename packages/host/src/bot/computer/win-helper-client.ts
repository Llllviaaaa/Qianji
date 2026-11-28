/**
 * Subprocess JSON stdin/stdout invoker for `--computer-helper` (`packages/host/src/bot/computer/win-helper-client.ts`).
 */
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import type { BotComputerInputEvent, BotWinDesktopBackend, BotWinOpenWindow } from "@qianji/protocol";

export type ComputerHelperInvoke = (
  payload: Record<string, unknown>,
  timeoutMs?: number,
) => Promise<Record<string, unknown>>;

export function createSubprocessHelperInvoker(
  getHelperPath: () => string | undefined,
): ComputerHelperInvoke {
  return (payload, timeoutMs = 20_000) => {
    const helper = getHelperPath()?.trim();
    if (!helper || !existsSync(helper)) {
      return Promise.reject(new Error("Native computer helper binary is not available"));
    }
    return new Promise((resolvePromise, rejectPromise) => {
      const child = spawn(helper, ["--computer-helper"], {
        windowsHide: true,
        stdio: ["pipe", "pipe", "pipe"],
      });
      let stdout = "";
      let stderr = "";
      let settled = false;
      const finish = (err?: Error, value?: Record<string, unknown>) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (err) rejectPromise(err);
        else resolvePromise(value ?? {});
      };
      const timer = setTimeout(() => {
        child.kill();
        finish(new Error(`Computer helper timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      child.stdout.on("data", (chunk: Buffer) => { stdout += chunk.toString("utf8"); });
      child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString("utf8"); });
      child.once("error", (err) => finish(err));
      child.once("close", (code) => {
        const line = stdout.trim().split(/\r?\n/).filter(Boolean).at(-1);
        if (!line) {
          finish(new Error(stderr.trim() || `Computer helper exited with code ${code ?? "null"}`));
          return;
        }
        try {
          const parsed = JSON.parse(line) as Record<string, unknown>;
          if (parsed.ok === false && typeof parsed.error === "string") {
            finish(new Error(parsed.error));
            return;
          }
          finish(undefined, parsed);
        } catch {
          finish(new Error(`Invalid computer helper JSON: ${line.slice(0, 240)}`));
        }
      });
      child.stdin.on("error", () => undefined);
      child.stdin.end(JSON.stringify(payload));
    });
  };
}

export function normalizeOpenWindows(raw: unknown): BotWinOpenWindow[] {
  if (!Array.isArray(raw)) return [];
  const out: BotWinOpenWindow[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object" || Array.isArray(item)) continue;
    const rec = item as Record<string, unknown>;
    const hwnd = String(rec.hwnd ?? rec.handle ?? "").trim();
    const title = String(rec.title ?? "").trim();
    if (hwnd === "" && title === "") continue;
    out.push({
      hwnd: hwnd || `hwnd-${out.length + 1}`,
      title: title || "(Untitled Window)",
      ...(typeof rec.app === "string" && rec.app.trim() !== "" ? { app: rec.app.trim() } : {}),
    });
  }
  return out;
}

export function normalizeBackend(raw: unknown): BotWinDesktopBackend {
  if (raw === "rdp-child-session" || raw === "win32-secondary-desktop" || raw === "unavailable") return raw;
  return process.platform === "win32" ? "win32-secondary-desktop" : "unavailable";
}

export function isUrlLike(value: string | undefined): boolean {
  return Boolean(value && /^(?:https?:\/\/|about:|data:)/i.test(value.trim()));
}

export function resolveWinInputAction(event: BotComputerInputEvent): string {
  if (event.kind === "wheel") return "wheel";
  if (event.kind === "text" || event.kind === "paste") return "text";
  if (event.kind === "key") {
    const hasShortcutMod =
      event.modifiers?.some((m) => m === "ctrl" || m === "alt" || m === "meta") === true;
    if (!hasShortcutMod && typeof event.text === "string" && event.text.length > 0) {
      return "text";
    }
    return "key";
  }
  if (event.mouseAction === "move") return "move";
  if (event.mouseAction === "down") return "down";
  if (event.mouseAction === "up") return "up";
  if (event.mouseAction === "double-click") return "double_click";
  if (event.button === "right") return "right_click";
  if (event.button === "middle") return "middle_click";
  return "click";
}

import { spawnSync } from "node:child_process";

export const DEFAULT_TIMEOUT_SECONDS = 120;
/** Output kept in memory while a command runs; the tool then keeps the tail of it. */
export const MAX_BUFFER_BYTES = 1024 * 1024;
export const MAX_OUTPUT_LINES = 2000;
export const MAX_OUTPUT_BYTES = 50 * 1024;
/** Grace window after the shell exits before detaching inherited background stdio pipes. */
export const POST_EXIT_PIPE_DRAIN_MS = 250;
/** Grace window after killing a timed-out or aborted command before forcing resolution. */
export const POST_KILL_GRACE_MS = 500;

export function killTree(pid: number): void {
  if (process.platform === "win32") {
    spawnSync("taskkill", ["/pid", String(pid), "/T", "/F"], { windowsHide: true });
  } else {
    try {
      process.kill(-pid, "SIGKILL");
    } catch {
      // Already gone.
    }
  }
}

export function tailLinesOf(
  text: string,
  maxLines = MAX_OUTPUT_LINES,
  maxBytes = MAX_OUTPUT_BYTES,
): { text: string; truncated: boolean } {
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  if (lines.at(-1) === "") lines.pop();
  const kept: string[] = [];
  let bytes = 0;
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index] ?? "";
    bytes += Buffer.byteLength(line) + 1;
    if (kept.length >= maxLines || bytes > maxBytes) return { text: kept.reverse().join("\n"), truncated: true };
    kept.push(line);
  }
  return { text: kept.reverse().join("\n"), truncated: false };
}

export function tail(text: string): { text: string; truncated: boolean } {
  return tailLinesOf(text, MAX_OUTPUT_LINES, MAX_OUTPUT_BYTES);
}

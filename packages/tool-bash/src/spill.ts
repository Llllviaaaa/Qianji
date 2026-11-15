/**
 * Helpers for foreground shell output spilling and throttled live progress previews.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { StringDecoder } from "node:string_decoder";

export const PROGRESS_INTERVAL_MS = 100;
export const PROGRESS_MAX_BYTES = 4096;

let fallbackCounter = 0;

function safeSegment(raw: string | undefined, fallback: string): string {
  const trimmed = raw?.trim() ?? "";
  if (trimmed === "") return fallback;
  const cleaned = trimmed.replace(/[^A-Za-z0-9_.-]/g, "_").slice(0, 120);
  if (cleaned === "" || cleaned === "." || cleaned === "..") return fallback;
  return cleaned;
}

/**
 * Write full truncated foreground shell output to `<spillDir>/<safeSessionId>/<safeId>.log`.
 * Returns the written path, or `undefined` if spilling is unconfigured or fails.
 */
export function spillTruncatedOutput(
  spillDir: string | undefined,
  sessionId: string,
  callId: string | undefined,
  fullOutput: string,
): string | undefined {
  if (spillDir === undefined || spillDir.trim() === "") return undefined;
  const safeSessionId = safeSegment(sessionId, "session");
  fallbackCounter += 1;
  const safeId = safeSegment(callId, `cmd-${Date.now()}-${fallbackCounter}`);
  const dir = join(spillDir, safeSessionId);
  const filePath = join(dir, `${safeId}.log`);
  try {
    mkdirSync(dir, { recursive: true });
    writeFileSync(filePath, fullOutput, "utf8");
    return filePath;
  } catch {
    return undefined;
  }
}

function trimTailBytes(text: string, maxBytes: number): string {
  if (Buffer.byteLength(text, "utf8") <= maxBytes) return text;
  let lo = Math.max(0, text.length - maxBytes);
  let hi = text.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (Buffer.byteLength(text.slice(mid), "utf8") <= maxBytes) {
      hi = mid;
    } else {
      lo = mid + 1;
    }
  }
  let start = lo;
  if (start < text.length) {
    const code = text.charCodeAt(start);
    if (code >= 0xdc00 && code <= 0xdfff) start += 1;
  }
  return text.slice(start);
}

export interface ProgressReporter {
  push(chunk: Buffer | string): void;
  flush(): void;
  dispose(): void;
}

export interface ProgressReporterOptions {
  intervalMs?: number;
  maxBytes?: number;
  now?: () => number;
}

const NOOP_REPORTER: ProgressReporter = {
  push() {},
  flush() {},
  dispose() {},
};

/**
 * Create a throttled (~100ms) reporter that streams bounded (~4KB) tail previews
 * of foreground command stdout/stderr chunks to `onProgress`.
 */
export function createProgressReporter(
  onProgress?: (text: string) => void,
  options: ProgressReporterOptions = {},
): ProgressReporter {
  if (onProgress === undefined) return NOOP_REPORTER;

  const intervalMs = Math.max(1, options.intervalMs ?? PROGRESS_INTERVAL_MS);
  const maxBytes = Math.max(64, options.maxBytes ?? PROGRESS_MAX_BYTES);
  const now = options.now ?? (() => Date.now());
  const decoder = new StringDecoder("utf8");

  let tailText = "";
  let lastEmitAt = -Infinity;
  let pendingTimer: ReturnType<typeof setTimeout> | undefined;
  let dirty = false;
  let disposed = false;

  const clearTimer = (): void => {
    if (pendingTimer !== undefined) {
      clearTimeout(pendingTimer);
      pendingTimer = undefined;
    }
  };

  const emit = (): void => {
    clearTimer();
    if (disposed || !dirty) return;
    dirty = false;
    lastEmitAt = now();
    try {
      onProgress(tailText);
    } catch {
      // Never let a consumer progress listener abort shell execution.
    }
  };

  return {
    push(chunk: Buffer | string): void {
      if (disposed) return;
      const decoded = typeof chunk === "string" ? chunk : decoder.write(chunk);
      if (decoded === "") return;
      tailText = trimTailBytes(tailText + decoded, maxBytes);
      dirty = true;
      const elapsed = now() - lastEmitAt;
      if (elapsed >= intervalMs) {
        emit();
      } else if (pendingTimer === undefined) {
        pendingTimer = setTimeout(emit, Math.max(1, intervalMs - elapsed));
        pendingTimer.unref();
      }
    },
    flush(): void {
      if (disposed) return;
      const remainder = decoder.end();
      if (remainder !== "") {
        tailText = trimTailBytes(tailText + remainder, maxBytes);
        dirty = true;
      }
      if (dirty) emit();
      disposed = true;
      clearTimer();
    },
    dispose(): void {
      disposed = true;
      dirty = false;
      clearTimer();
    },
  };
}

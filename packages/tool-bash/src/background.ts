import { spawn, type ChildProcessByStdio } from "node:child_process";
import type { Readable } from "node:stream";
import { textOutput, type ToolDefinition, type ToolEnv } from "@qianji/tools";
import { MAX_BUFFER_BYTES, POST_EXIT_PIPE_DRAIN_MS, POST_KILL_GRACE_MS, killTree, tailLinesOf } from "./proc.ts";
import { attachWindowsJobObject, buildSandboxedEnv } from "./sandbox.ts";

export const MAX_BG_PROCESSES_PER_SESSION = 8;
const MAX_EXITED_RETAINED_PER_SESSION = 16;
const DEFAULT_WAIT_MS = 10_000;
const DEFAULT_LOG_LINES = 200;

export interface BgStartOptions {
  sessionId: string;
  shellPath: string;
  shellArgs: string[];
  command: string;
  cwd: string;
  sandbox: boolean;
  env?: NodeJS.ProcessEnv;
}

export interface BgProcessSnapshot {
  id: string;
  sessionId: string;
  pid?: number;
  command: string;
  cwd: string;
  status: "running" | "exited";
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  startedAt: string;
  endedAt?: string;
  totalBytes: number;
  unreadBytes: number;
}

export interface BgWaitResult {
  snapshot: BgProcessSnapshot;
  timedOut: boolean;
  aborted: boolean;
  output: string;
  truncated: boolean;
}

export interface AsyncJobObjectBinding {
  /** Idempotently dispose the Job Object handle, or mark it to dispose immediately upon resolution. */
  dispose(options?: { stopped?: boolean }): void;
  readonly settled: Promise<void>;
}

/** Binds an async Windows Job Object attachment to a process lifecycle so handles never leak on fast exit or stop. */
export function bindAsyncJobObjectDisposer(
  attachment: Promise<(() => void) | undefined>,
  options: { isDisposed?: () => boolean; isStopped?: () => boolean; onStoppedResolve?: () => void } = {},
): AsyncJobObjectBinding {
  let closeJob: (() => void) | undefined;
  let disposed = false;
  let stopped = false;
  const dispose = (disposeOptions?: { stopped?: boolean }): void => {
    disposed = true;
    if (disposeOptions?.stopped === true) stopped = true;
    const handle = closeJob;
    closeJob = undefined;
    handle?.();
  };
  const settled = attachment.then(
    (disposer) => {
      const alreadyDisposed = disposed || (options.isDisposed?.() ?? false);
      const alreadyStopped = stopped || (options.isStopped?.() ?? false);
      if (alreadyDisposed || alreadyStopped) {
        disposer?.();
        if (alreadyStopped) options.onStoppedResolve?.();
        return;
      }
      closeJob = disposer;
    },
    () => undefined,
  );
  return { dispose, settled };
}

interface BgEntry {
  id: string;
  sessionId: string;
  command: string;
  cwd: string;
  startedAt: string;
  endedAt?: string;
  child: ChildProcessByStdio<null, Readable, Readable>;
  status: "running" | "exited";
  terminated?: boolean;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  chunks: Buffer[];
  bufferedBytes: number;
  baseByteOffset: number;
  totalBytes: number;
  readByteOffset: number;
  jobBinding?: AsyncJobObjectBinding;
  drainTimer?: ReturnType<typeof setTimeout>;
  killTimer?: ReturnType<typeof setTimeout>;
  waiters: Set<() => void>;
  done: Promise<void>;
  settleDone: () => void;
}

function clampMs(value: number | undefined, fallback: number, min: number, max: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return Math.min(Math.max(Math.floor(value), min), max);
}

function formatSnapshotHeader(s: BgProcessSnapshot, includeCmd = false): string {
  const pidPart = s.pid === undefined ? "" : ` pid=${s.pid}`;
  const exitPart = s.status === "exited" ? ` exitCode=${s.exitCode ?? s.signal ?? "unknown"}` : "";
  const cmdPart = includeCmd
    ? ` cwd=${s.cwd} cmd=${JSON.stringify(s.command.length > 120 ? `${s.command.slice(0, 120)}...` : s.command)}`
    : "";
  return `[${s.id}] status=${s.status}${pidPart}${exitPart} bytes=${s.totalBytes}${cmdPart}`;
}

export class BackgroundProcessManager {
  private readonly entries = new Map<string, BgEntry>();
  private nextSeq = 0;

  start(options: BgStartOptions): BgProcessSnapshot {
    const activeCount = [...this.entries.values()].filter(
      (entry) => entry.sessionId === options.sessionId && entry.status === "running",
    ).length;
    if (activeCount >= MAX_BG_PROCESSES_PER_SESSION) {
      throw new Error(
        `Maximum of ${MAX_BG_PROCESSES_PER_SESSION} concurrent background processes reached for this session. Use bg_process(action: "stop") or wait for an existing process to finish.`,
      );
    }

    this.pruneExited(options.sessionId);

    const baseEnv = options.env ?? process.env;
    const childEnv = options.sandbox ? buildSandboxedEnv(baseEnv, options.cwd) : baseEnv;
    const child = spawn(options.shellPath, options.shellArgs, {
      cwd: options.cwd,
      env: childEnv,
      windowsHide: true,
      detached: process.platform !== "win32",
      stdio: ["ignore", "pipe", "pipe"],
    });

    this.nextSeq += 1;
    const id = `bg-${this.nextSeq}`;
    let settleDone = () => {};
    const done = new Promise<void>((resolve) => {
      settleDone = resolve;
    });

    const entry: BgEntry = {
      id,
      sessionId: options.sessionId,
      command: options.command,
      cwd: options.cwd,
      startedAt: new Date().toISOString(),
      child,
      status: "running",
      exitCode: null,
      signal: null,
      chunks: [],
      bufferedBytes: 0,
      baseByteOffset: 0,
      totalBytes: 0,
      readByteOffset: 0,
      waiters: new Set(),
      done,
      settleDone,
    };
    this.entries.set(id, entry);

    if (options.sandbox && child.pid !== undefined) {
      const pid = child.pid;
      entry.jobBinding = bindAsyncJobObjectDisposer(attachWindowsJobObject(pid), {
        isDisposed: () => entry.status === "exited" || entry.terminated === true,
        isStopped: () => entry.terminated === true,
        onStoppedResolve: () => killTree(pid),
      });
    }

    const collect = (chunk: Buffer) => {
      entry.chunks.push(chunk);
      entry.bufferedBytes += chunk.length;
      entry.totalBytes += chunk.length;
      while (entry.bufferedBytes > MAX_BUFFER_BYTES && entry.chunks.length > 1) {
        const dropped = entry.chunks.shift();
        if (dropped === undefined) break;
        entry.bufferedBytes -= dropped.length;
        entry.baseByteOffset += dropped.length;
      }
    };
    child.stdout.on("data", collect);
    child.stderr.on("data", collect);

    const finalize = (exitCode: number | null, sig: NodeJS.Signals | null) => {
      if (entry.status === "exited") return;
      entry.status = "exited";
      entry.exitCode = exitCode;
      entry.signal = sig;
      entry.endedAt = new Date().toISOString();
      if (entry.drainTimer !== undefined) {
        clearTimeout(entry.drainTimer);
        entry.drainTimer = undefined;
      }
      if (entry.killTimer !== undefined) {
        clearTimeout(entry.killTimer);
        entry.killTimer = undefined;
      }
      entry.jobBinding?.dispose();
      entry.child.stdout.destroy();
      entry.child.stderr.destroy();
      for (const wake of entry.waiters) wake();
      entry.waiters.clear();
      entry.settleDone();
    };

    child.once("error", (error) => {
      collect(Buffer.from(`[spawn error: ${error.message}]\n`, "utf8"));
      finalize(entry.exitCode, entry.signal);
    });
    child.once("exit", (exitCode, sig) => {
      entry.exitCode = exitCode;
      entry.signal = sig;
      if (entry.status === "exited" || entry.drainTimer !== undefined) return;
      entry.drainTimer = setTimeout(() => finalize(entry.exitCode, entry.signal), POST_EXIT_PIPE_DRAIN_MS);
      entry.drainTimer.unref();
    });
    child.once("close", (exitCode, sig) => {
      finalize(exitCode ?? entry.exitCode, sig ?? entry.signal);
    });

    return this.snapshot(entry);
  }

  list(sessionId: string): BgProcessSnapshot[] {
    return [...this.entries.values()]
      .filter((entry) => entry.sessionId === sessionId)
      .map((entry) => this.snapshot(entry));
  }

  logs(
    sessionId: string,
    id: string,
    options: { incremental?: boolean; tailLines?: number } = {},
  ): { snapshot: BgProcessSnapshot; output: string; truncated: boolean; droppedNotice?: string } | undefined {
    const entry = this.requireEntry(sessionId, id);
    if (entry === undefined) return undefined;
    if (options.incremental === true) {
      const startByte = Math.max(entry.readByteOffset, entry.baseByteOffset);
      const skipped = entry.baseByteOffset > entry.readByteOffset ? entry.baseByteOffset - entry.readByteOffset : 0;
      const combined = entry.chunks.length === 0 ? Buffer.alloc(0) : Buffer.concat(entry.chunks);
      const offsetInBuffer = Math.max(0, startByte - entry.baseByteOffset);
      const unreadText = combined.subarray(offsetInBuffer).toString("utf8");
      entry.readByteOffset = entry.totalBytes;
      const sliced = tailLinesOf(unreadText, options.tailLines ?? DEFAULT_LOG_LINES);
      return {
        snapshot: this.snapshot(entry),
        output: sliced.text,
        truncated: sliced.truncated,
        ...(skipped > 0 ? { droppedNotice: `[... ${skipped} older bytes rotated out of ${MAX_BUFFER_BYTES} byte buffer ...]` } : {}),
      };
    }
    const maxLines = clampMs(options.tailLines, DEFAULT_LOG_LINES, 1, 2_000);
    const full = entry.chunks.length === 0 ? "" : Buffer.concat(entry.chunks).toString("utf8");
    const sliced = tailLinesOf(full, maxLines);
    return {
      snapshot: this.snapshot(entry),
      output: sliced.text,
      truncated: sliced.truncated,
    };
  }

  async wait(
    sessionId: string,
    id: string,
    timeoutMs: number | undefined,
    signal: AbortSignal,
    options: { tailLines?: number } = {},
  ): Promise<BgWaitResult | undefined> {
    const entry = this.requireEntry(sessionId, id);
    if (entry === undefined) return undefined;
    const waitMs = clampMs(timeoutMs, DEFAULT_WAIT_MS, 50, 120_000);

    let timedOut = false;
    let aborted = false;
    if (entry.status === "running") {
      await new Promise<void>((resolve) => {
        let settled = false;
        const finish = () => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          signal.removeEventListener("abort", onAbort);
          entry.waiters.delete(onExit);
          resolve();
        };
        const onExit = () => finish();
        const onAbort = () => {
          aborted = true;
          finish();
        };
        const timer = setTimeout(() => {
          timedOut = true;
          finish();
        }, waitMs);
        timer.unref();
        entry.waiters.add(onExit);
        signal.addEventListener("abort", onAbort, { once: true });
        if (signal.aborted) onAbort();
      });
    }

    const full = entry.chunks.length === 0 ? "" : Buffer.concat(entry.chunks).toString("utf8");
    const sliced = tailLinesOf(full, clampMs(options.tailLines, DEFAULT_LOG_LINES, 1, 2_000));
    return {
      snapshot: this.snapshot(entry),
      timedOut,
      aborted,
      output: sliced.text,
      truncated: sliced.truncated,
    };
  }

  async stop(sessionId: string, id: string): Promise<BgProcessSnapshot | undefined> {
    const entry = this.requireEntry(sessionId, id);
    if (entry === undefined) return undefined;
    this.terminateEntry(entry);
    if (entry.status === "running") {
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, POST_KILL_GRACE_MS);
        timer.unref();
        void entry.done.then(() => {
          clearTimeout(timer);
          resolve();
        });
      });
    }
    return this.snapshot(entry);
  }

  stopSession(sessionId: string): void {
    for (const [id, entry] of this.entries) {
      if (entry.sessionId !== sessionId) continue;
      this.terminateEntry(entry);
      this.entries.delete(id);
    }
  }

  stopAll(): void {
    for (const entry of this.entries.values()) {
      this.terminateEntry(entry);
    }
    this.entries.clear();
  }

  private terminateEntry(entry: BgEntry): void {
    if (entry.status === "exited") return;
    entry.terminated = true;
    entry.jobBinding?.dispose({ stopped: true });
    if (entry.child.pid !== undefined) killTree(entry.child.pid);
    entry.child.stdout.destroy();
    entry.child.stderr.destroy();
    if (entry.killTimer === undefined) {
      entry.killTimer = setTimeout(() => {
        if (entry.status === "exited") return;
        entry.status = "exited";
        entry.endedAt = new Date().toISOString();
        if (entry.drainTimer !== undefined) {
          clearTimeout(entry.drainTimer);
          entry.drainTimer = undefined;
        }
        for (const wake of entry.waiters) wake();
        entry.waiters.clear();
        entry.settleDone();
      }, POST_KILL_GRACE_MS);
      entry.killTimer.unref();
    }
  }

  private pruneExited(sessionId: string): void {
    const exited = [...this.entries.values()].filter(
      (entry) => entry.sessionId === sessionId && entry.status === "exited",
    );
    while (exited.length > MAX_EXITED_RETAINED_PER_SESSION) {
      const oldest = exited.shift();
      if (oldest !== undefined) this.entries.delete(oldest.id);
    }
  }

  private requireEntry(sessionId: string, id: string): BgEntry | undefined {
    const entry = this.entries.get(id);
    if (entry === undefined || entry.sessionId !== sessionId) return undefined;
    return entry;
  }

  private snapshot(entry: BgEntry): BgProcessSnapshot {
    return {
      id: entry.id,
      sessionId: entry.sessionId,
      ...(entry.child.pid === undefined ? {} : { pid: entry.child.pid }),
      command: entry.command,
      cwd: entry.cwd,
      status: entry.status,
      exitCode: entry.exitCode,
      signal: entry.signal,
      startedAt: entry.startedAt,
      ...(entry.endedAt === undefined ? {} : { endedAt: entry.endedAt }),
      totalBytes: entry.totalBytes,
      unreadBytes: Math.max(0, entry.totalBytes - Math.max(entry.readByteOffset, entry.baseByteOffset)),
    };
  }
}

export type BgProcessArgs = {
  action: "list" | "logs" | "wait" | "stop";
  id?: string;
  incremental?: boolean;
  tailLines?: number;
  timeoutMs?: number;
};

export function bgProcessTool(manager: BackgroundProcessManager): ToolDefinition<BgProcessArgs> {
  return {
    name: "bg_process",
    deferred: true,
    group: "process",
    groupDescription: "Inspect, wait on, and stop background shell processes started in this session",
    description:
      "Manage background processes started in this session via `bash`/`powershell` (`background: true`). Supports `list`, `logs` (with `incremental` cursor or `tailLines`), `wait` (wait for exit without killing on timeout), and `stop`.",
    parameters: {
      type: "object",
      properties: {
        action: {
          type: "string",
          enum: ["list", "logs", "wait", "stop"],
          description: "Action to perform on session background processes",
        },
        id: { type: "string", description: "Background process id (required for logs, wait, stop)" },
        incremental: { type: "boolean", description: "For logs: return only unread output since previous incremental read" },
        tailLines: { type: "number", description: "Maximum trailing lines to include (default 200)" },
        timeoutMs: { type: "number", description: "For wait: timeout in ms (50-120000, default 10000)" },
      },
      required: ["action"],
    },
    async execute({ action, id, incremental, tailLines, timeoutMs }, env: ToolEnv) {
      if (action === "list") {
        const items = manager.list(env.sessionId);
        if (items.length === 0) return textOutput("No background processes in this session.");
        return textOutput(items.map((item) => formatSnapshotHeader(item, true)).join("\n"));
      }
      if (id === undefined || id.trim() === "") {
        return textOutput(`bg_process(${action}) requires 'id'.`, true);
      }
      const cleanId = id.trim();
      if (action === "logs") {
        const res = manager.logs(env.sessionId, cleanId, { incremental, tailLines });
        if (res === undefined) return textOutput(`Background process '${cleanId}' not found in this session.`, true);
        const parts = [formatSnapshotHeader(res.snapshot)];
        if (res.droppedNotice !== undefined) parts.push(res.droppedNotice);
        if (res.truncated) parts.push("[Output truncated; showing the end.]");
        parts.push(res.output === "" ? "(no new output)" : res.output);
        return textOutput(parts.join("\n"));
      }
      if (action === "wait") {
        const res = await manager.wait(env.sessionId, cleanId, timeoutMs, env.signal, { tailLines });
        if (res === undefined) return textOutput(`Background process '${cleanId}' not found in this session.`, true);
        const notes: string[] = [];
        if (res.timedOut) notes.push("[Wait timed out; process is still running.]");
        if (res.aborted) notes.push("[Wait aborted; process was left running.]");
        if (res.truncated) notes.push("[Output truncated; showing the end.]");
        const body = [formatSnapshotHeader(res.snapshot), ...notes, res.output === "" ? "(no output)" : res.output].join("\n");
        return {
          content: [{ type: "text", text: body }],
          isError: false,
          details: { snapshot: res.snapshot, timedOut: res.timedOut, aborted: res.aborted },
        };
      }
      if (action === "stop") {
        const stopped = await manager.stop(env.sessionId, cleanId);
        if (stopped === undefined) return textOutput(`Background process '${cleanId}' not found in this session.`, true);
        return {
          content: [{ type: "text", text: `${formatSnapshotHeader(stopped)}\nBackground process stopped.` }],
          isError: false,
          details: { snapshot: stopped },
        };
      }
      return textOutput(`Unknown bg_process action '${String(action)}'.`, true);
    },
  };
}

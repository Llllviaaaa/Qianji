/**
 * Session-scoped Read-Before-Edit + mtime/SHA-256 TOCTOU CAS tracker and
 * bounded writethrough diagnostics wrapper for `@qianji/tool-fs`.
 */
import { createHash } from "node:crypto";
import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import type { Context } from "@deepseek-ai/cordis";
import type { ToolCall, ToolDecision, ToolEnv, ToolOutput } from "@qianji/tools";
import { collectFileErrorDiagnostics } from "./diagnostics.ts";
import { MAX_TEXT_READ_BYTES } from "./file-guards.ts";
import { resolvePath } from "./shared.ts";

export interface FileStamp {
  mtimeMs: number;
  size: number;
  sha256: string;
}

interface SessionHistoryLike {
  header?: { cwd?: string };
  events: ReadonlyArray<{ type: string; data: Record<string, unknown> }>;
}

interface SessionsPeekLike {
  peek?(id: string): SessionHistoryLike | undefined;
}

const OBSERVED_TOOLS = new Set(["read", "edit", "write"]);
const realpathNative = typeof realpathSync.native === "function" ? realpathSync.native : realpathSync;
const FAST_HASH_VERIFY_BYTES = 2 * 1024 * 1024;
const MAX_SUMMARY_DIAGNOSTICS = 20;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function canonicalObservedPath(filePath: string): string {
  let resolved = filePath;
  try {
    resolved = realpathNative(filePath);
  } catch {
    // Fall back to normalized path if realpath fails transiently.
  }
  const normalized = resolved.replace(/\\/g, "/");
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

function computeSha256(filePath: string): string | undefined {
  try {
    const stat = statSync(filePath);
    if (!stat.isFile() || stat.size > MAX_TEXT_READ_BYTES) return undefined;
    return createHash("sha256").update(readFileSync(filePath)).digest("hex");
  } catch {
    return undefined;
  }
}

function readStamp(filePath: string): FileStamp | undefined {
  try {
    if (!existsSync(filePath)) return undefined;
    const stat = statSync(filePath);
    if (!stat.isFile()) return undefined;
    const sha256 = computeSha256(filePath);
    if (sha256 === undefined) return undefined;
    return { mtimeMs: stat.mtimeMs, size: stat.size, sha256 };
  } catch {
    return undefined;
  }
}

export class FileObservationTracker {
  private readonly observed = new Map<string, Map<string, FileStamp>>();

  constructor(private readonly ctx: Context) {
    const drop = ((sessionId: string) => {
      this.observed.delete(sessionId);
    }) as never;
    ctx.on("session/deleted" as never, drop);
    ctx.on("session/unloaded" as never, drop);
  }

  record(sessionId: string, cwd: string, rawPath: string): void {
    if (sessionId === "" || rawPath.trim() === "") return;
    const table = this.ensureSession(sessionId, cwd);
    this.seedFile(table, cwd, rawPath);
  }

  checkBeforeWriteOrEdit(call: ToolCall, env: ToolEnv): ToolDecision | undefined {
    if ((call.name !== "edit" && call.name !== "write") || env.sessionId === "") return undefined;
    const rawPath = typeof call.args.path === "string" ? call.args.path : undefined;
    if (rawPath === undefined || rawPath.trim() === "") return undefined;
    const resolved = resolvePath(env.cwd, rawPath);
    let stat;
    try {
      if (!existsSync(resolved)) return undefined;
      stat = statSync(resolved);
    } catch {
      return undefined;
    }
    if (!stat.isFile()) return undefined;

    const table = this.ensureSession(env.sessionId, env.cwd);
    const key = canonicalObservedPath(resolved);
    const recorded = table.get(key);
    if (recorded === undefined) {
      return {
        deny: true,
        reason: `[FS_NOT_OBSERVED] Read "${rawPath}" first before editing or overwriting it.`,
      };
    }

    const mtimeChanged = stat.mtimeMs !== recorded.mtimeMs || stat.size !== recorded.size;
    if (mtimeChanged || stat.size <= FAST_HASH_VERIFY_BYTES) {
      const currentSha = computeSha256(resolved);
      if (currentSha !== undefined && currentSha === recorded.sha256) {
        recorded.mtimeMs = stat.mtimeMs;
        recorded.size = stat.size;
        return undefined;
      }
      if (currentSha !== undefined) {
        return {
          deny: true,
          reason: `[FS_STALE_VERSION] "${rawPath}" was modified externally since you last read it; read it again before editing.`,
        };
      }
    }
    return undefined;
  }

  private ensureSession(sessionId: string, fallbackCwd: string): Map<string, FileStamp> {
    const existing = this.observed.get(sessionId);
    if (existing !== undefined) return existing;
    const table = new Map<string, FileStamp>();
    this.observed.set(sessionId, table);
    const sessions = this.ctx.get("sessions") as SessionsPeekLike | undefined;
    const history = sessions?.peek?.(sessionId);
    if (history === undefined) return table;

    const sessionCwd = typeof history.header?.cwd === "string" && history.header.cwd !== ""
      ? history.header.cwd
      : fallbackCwd;
    const calls = new Map<string, string>();
    for (const event of history.events) {
      if (event.type === "tool-call") {
        const callId = typeof event.data.callId === "string" ? event.data.callId : "";
        const toolName = typeof event.data.name === "string" ? event.data.name : "";
        const args = isRecord(event.data.args) ? event.data.args : undefined;
        if (callId !== "" && OBSERVED_TOOLS.has(toolName) && typeof args?.path === "string") {
          calls.set(callId, args.path);
        }
      } else if (event.type === "assistant" && Array.isArray(event.data.content)) {
        for (const block of event.data.content) {
          if (!isRecord(block) || block.type !== "tool-call") continue;
          const callId = typeof block.id === "string" ? block.id : "";
          const toolName = typeof block.name === "string" ? block.name : "";
          const args = isRecord(block.arguments) ? block.arguments : undefined;
          if (callId !== "" && OBSERVED_TOOLS.has(toolName) && typeof args?.path === "string") {
            calls.set(callId, args.path);
          }
        }
      } else if (event.type === "tool-result" && event.data.isError !== true) {
        const callId = typeof event.data.callId === "string" ? event.data.callId : "";
        const rawPath = calls.get(callId);
        if (rawPath !== undefined) this.seedFile(table, sessionCwd, rawPath);
      }
    }
    return table;
  }

  private seedFile(table: Map<string, FileStamp>, cwd: string, rawPath: string): void {
    const resolved = resolvePath(cwd, rawPath);
    const stamp = readStamp(resolved);
    if (stamp !== undefined) {
      table.set(canonicalObservedPath(resolved), stamp);
    }
  }
}

export function appendWritethroughDiagnostics(
  ctx: Context,
  timeoutMs: number,
): void {
  if (timeoutMs <= 0) return;
  ctx.on("tools/execute", async (call, env, next) => {
    const output = await next();
    if (output.isError === true || (call.name !== "edit" && call.name !== "write")) return output;
    const rawPath = typeof call.args.path === "string" ? call.args.path : undefined;
    if (rawPath === undefined || rawPath.trim() === "" || env.signal.aborted) return output;

    const resolved = resolvePath(env.cwd, rawPath);
    const timeoutSignal = AbortSignal.timeout(timeoutMs);
    const combined = AbortSignal.any([env.signal, timeoutSignal]);
    const issues = await collectFileErrorDiagnostics(env.cwd, resolved, combined);
    if (issues.length === 0) return output;

    const shown = issues.slice(0, MAX_SUMMARY_DIAGNOSTICS);
    const lines = shown.map((item) => `${item.file}:${item.line}:${item.column} [${item.severity} ${item.code}] ${item.message}`);
    if (issues.length > MAX_SUMMARY_DIAGNOSTICS) {
      lines.push(`[${issues.length - MAX_SUMMARY_DIAGNOSTICS} more error diagnostics omitted.]`);
    }
    const blockText = `\n\n<diagnostics-summary>\n${lines.join("\n")}\n</diagnostics-summary>`;
    const idx = output.content.findIndex((block) => block.type === "text");
    if (idx === -1) {
      return { ...output, content: [...output.content, { type: "text", text: blockText.trimStart() }] };
    }
    return {
      ...output,
      content: output.content.map((block, i): ToolOutput["content"][number] =>
        i === idx && block.type === "text" ? { ...block, text: `${block.text}${blockText}` } : block,
      ),
    };
  });
}

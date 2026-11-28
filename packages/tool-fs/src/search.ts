/**
 * Search tools (`find` and `grep`) for `@qianji/tool-fs`.
 * Uses `ripgrep` (`rg`) as a fast path for `grep` when available, with
 * deterministic fallback to in-process recursive scanning (`walkFiles`).
 */
import { spawn, spawnSync } from "node:child_process";
import { readFileSync, statSync } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { basename, dirname } from "node:path";
import { textOutput, type ToolDefinition, type ToolEnv } from "@qianji/tools";
import {
  clipLine,
  displayPath,
  isWindowsDeviceBaseName,
  matchesGlob,
  resolvePath,
  walkFiles,
} from "./shared.ts";

export const MAX_FIND_RESULTS = 1000;
export const MAX_GREP_MATCHES = 100;
export const MAX_SCAN_FILES = 25_000;
export const MAX_SCAN_DURATION_MS = 15_000;
const MAX_GREP_FILE_BYTES = 2 * 1024 * 1024;
const YIELD_BUDGET_MS = 20;

const yieldToEventLoop = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

let cachedRg: string | null | undefined;

export function findRipgrep(): string | undefined {
  if (cachedRg !== undefined) return cachedRg ?? undefined;
  const check = spawnSync("rg", ["--version"], { windowsHide: true, timeout: 1500, stdio: "ignore" });
  cachedRg = check.status === 0 ? "rg" : null;
  return cachedRg ?? undefined;
}

export const find: ToolDefinition<{ pattern: string; path?: string }> = {
  name: "find",
  readOnly: true,
  description: `Find files by glob, e.g. "*.ts" (any depth) or "src/**/*.test.ts". Skips .git and node_modules. At most ${MAX_FIND_RESULTS} paths.`,
  parameters: {
    type: "object",
    properties: {
      pattern: { type: "string", description: "Glob; without a '/' it matches file names at any depth" },
      path: { type: "string", description: "Directory to search (default: the working directory)" },
    },
    required: ["pattern"],
  },
  async execute({ pattern, path }, env) {
    const root = resolvePath(env.cwd, path ?? ".");
    const found: string[] = [];
    let more = false;
    let scanned = 0;
    let capped = false;
    const startedAt = performance.now();
    let sliceStart = startedAt;
    for (const file of walkFiles(root, env.signal)) {
      scanned += 1;
      const now = performance.now();
      if (now - sliceStart >= YIELD_BUDGET_MS) {
        await yieldToEventLoop();
        if (env.signal.aborted) break;
        sliceStart = performance.now();
      }
      if (scanned > MAX_SCAN_FILES || now - startedAt > MAX_SCAN_DURATION_MS) {
        capped = true;
        break;
      }
      const rel = displayPath(root, file);
      if (!matchesGlob(pattern, rel)) continue;
      if (found.length >= MAX_FIND_RESULTS) {
        more = true;
        break;
      }
      found.push(rel);
    }
    if (found.length === 0) {
      return textOutput(
        capped
          ? `No matching files found before reaching scan limit (${MAX_SCAN_FILES} files / ${MAX_SCAN_DURATION_MS / 1000}s); pass a narrower \`path\`.`
          : "No files found.",
      );
    }
    found.sort((a, b) => a.localeCompare(b));
    const tail = more
      ? `\n[More than ${MAX_FIND_RESULTS} files; narrow the pattern.]`
      : capped
        ? `\n[Search stopped at scan limit (${MAX_SCAN_FILES} files / ${MAX_SCAN_DURATION_MS / 1000}s); pass a narrower \`path\`.]`
        : "";
    return textOutput(found.join("\n") + tail);
  },
};

export type GrepParams = {
  pattern: string;
  path?: string;
  glob?: string;
  ignoreCase?: boolean;
  literal?: boolean;
  limit?: number;
};

export interface GrepScanLimits {
  maxFiles?: number;
  maxDurationMs?: number;
}

export interface GrepRunResult {
  matches: string[];
  more: boolean;
  capped?: boolean;
  error?: string;
}

function compileGrepRegex(params: GrepParams): RegExp | { error: string } {
  try {
    return new RegExp(
      params.literal ? params.pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") : params.pattern,
      params.ignoreCase ? "i" : "",
    );
  } catch (error) {
    return { error: `Invalid pattern: ${(error as Error).message}` };
  }
}

function collectBufferMatches(
  buffer: Buffer,
  rel: string,
  regex: RegExp,
  max: number,
  matches: string[],
): boolean {
  if (buffer.subarray(0, 8192).includes(0)) return false;
  const lines = buffer.toString("utf8").split("\n");
  for (let index = 0; index < lines.length; index += 1) {
    const line = (lines[index] as string).replace(/\r$/, "");
    if (!regex.test(line)) continue;
    if (matches.length >= max) {
      return true;
    }
    matches.push(`${rel}:${index + 1}: ${clipLine(line)}`);
  }
  return false;
}

/** Pure-Node synchronous grep implementation retained for direct unit tests. */
export function grepWithNode(
  params: GrepParams,
  env: Pick<ToolEnv, "cwd" | "signal">,
  limits?: GrepScanLimits,
): GrepRunResult {
  const compiled = compileGrepRegex(params);
  if ("error" in compiled) return { matches: [], more: false, error: compiled.error };
  const target = resolvePath(env.cwd, params.path ?? ".");
  if (isWindowsDeviceBaseName(basename(target))) {
    return { matches: [], more: false, error: `Cannot search Windows reserved device name: ${basename(target)}` };
  }
  const single = statSync(target).isFile();
  const base = single ? dirname(target) : target;
  const files = single ? [target] : walkFiles(target, env.signal);
  const max = Math.max(1, params.limit ?? MAX_GREP_MATCHES);
  const maxFiles = limits?.maxFiles ?? MAX_SCAN_FILES;
  const maxDurationMs = limits?.maxDurationMs ?? MAX_SCAN_DURATION_MS;
  const startedAt = performance.now();
  const matches: string[] = [];
  let more = false;
  let capped = false;
  let scanned = 0;
  for (const file of files) {
    if (env.signal.aborted) break;
    scanned += 1;
    if (scanned > maxFiles || performance.now() - startedAt > maxDurationMs) {
      capped = true;
      break;
    }
    const rel = displayPath(base, file);
    if (params.glob !== undefined && !matchesGlob(params.glob, rel)) continue;
    let buffer: Buffer;
    try {
      if (statSync(file).size > MAX_GREP_FILE_BYTES) continue;
      buffer = readFileSync(file);
    } catch {
      continue;
    }
    if (collectBufferMatches(buffer, rel, compiled, max, matches)) {
      more = true;
      break;
    }
  }
  return { matches, more, ...(capped ? { capped: true } : {}) };
}

/**
 * Cooperative async fallback grep used by the live `grep` tool when `rg` is
 * unavailable: yields to the JS event loop every ~20ms and reads files via
 * libuv worker threads so large workspaces never freeze Harness RPCs.
 */
export async function grepWithNodeAsync(
  params: GrepParams,
  env: Pick<ToolEnv, "cwd" | "signal">,
  limits?: GrepScanLimits,
): Promise<GrepRunResult> {
  const compiled = compileGrepRegex(params);
  if ("error" in compiled) return { matches: [], more: false, error: compiled.error };
  const target = resolvePath(env.cwd, params.path ?? ".");
  if (isWindowsDeviceBaseName(basename(target))) {
    return { matches: [], more: false, error: `Cannot search Windows reserved device name: ${basename(target)}` };
  }
  let single: boolean;
  try {
    single = (await stat(target)).isFile();
  } catch (error) {
    return { matches: [], more: false, error: (error as Error).message };
  }
  const base = single ? dirname(target) : target;
  const files = single ? [target] : walkFiles(target, env.signal);
  const max = Math.max(1, params.limit ?? MAX_GREP_MATCHES);
  const maxFiles = limits?.maxFiles ?? MAX_SCAN_FILES;
  const maxDurationMs = limits?.maxDurationMs ?? MAX_SCAN_DURATION_MS;
  const startedAt = performance.now();
  let sliceStart = startedAt;
  const matches: string[] = [];
  let more = false;
  let capped = false;
  let scanned = 0;

  for (const file of files) {
    if (env.signal.aborted) break;
    scanned += 1;
    const now = performance.now();
    if (now - sliceStart >= YIELD_BUDGET_MS) {
      await yieldToEventLoop();
      if (env.signal.aborted) break;
      sliceStart = performance.now();
    }
    if (scanned > maxFiles || performance.now() - startedAt > maxDurationMs) {
      capped = true;
      break;
    }
    const rel = displayPath(base, file);
    if (params.glob !== undefined && !matchesGlob(params.glob, rel)) continue;
    let buffer: Buffer;
    try {
      const info = await stat(file);
      if (info.size > MAX_GREP_FILE_BYTES) continue;
      buffer = await readFile(file);
    } catch {
      continue;
    }
    if (collectBufferMatches(buffer, rel, compiled, max, matches)) {
      more = true;
      break;
    }
  }
  return { matches, more, ...(capped ? { capped: true } : {}) };
}

interface RgMatchData {
  path?: { text?: string };
  lines?: { text?: string };
  line_number?: number;
}

/** Run ripgrep and format output identically to `grepWithNode`; returns undefined to fall back to Node. */
export function grepWithRipgrep(
  rgBinary: string,
  params: GrepParams,
  env: Pick<ToolEnv, "cwd" | "signal">,
): Promise<{ matches: string[]; more: boolean } | undefined> {
  return new Promise((resolve) => {
    const target = resolvePath(env.cwd, params.path ?? ".");
    if (isWindowsDeviceBaseName(basename(target))) {
      resolve(undefined);
      return;
    }
    let single: boolean;
    try {
      single = statSync(target).isFile();
    } catch {
      resolve(undefined);
      return;
    }
    const base = single ? dirname(target) : target;
    const max = Math.max(1, params.limit ?? MAX_GREP_MATCHES);
    const args = [
      "--json",
      "--line-number",
      "--no-heading",
      "--color", "never",
      "--sort", "path",
      "--max-filesize", "2M",
      "--no-ignore",
      "--glob", "!.git/**",
      "--glob", "!node_modules/**",
      "--glob", "!.hg/**",
      "--glob", "!.svn/**",
      "--glob", "!.ccache/**",
      ...(process.platform === "win32"
        ? ["--glob", "!**/CON", "--glob", "!**/PRN", "--glob", "!**/AUX", "--glob", "!**/NUL"]
        : []),
    ];
    if (params.literal) args.push("-F");
    if (params.ignoreCase) args.push("-i");
    if (params.glob !== undefined) {
      const normalized = params.glob.includes("/") ? params.glob : `**/${params.glob}`;
      args.push("--glob", normalized);
    }
    args.push("--", params.pattern, target);

    const child = spawn(rgBinary, args, { cwd: base, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    const matches: string[] = [];
    let more = false;
    let remainder = "";
    let finished = false;

    const done = (result: { matches: string[]; more: boolean } | undefined) => {
      if (finished) return;
      finished = true;
      env.signal.removeEventListener("abort", onAbort);
      resolve(result);
    };
    const onAbort = () => {
      try { child.kill(); } catch { /* ignore */ }
      done({ matches, more });
    };
    env.signal.addEventListener("abort", onAbort, { once: true });

    const consumeLine = (line: string) => {
      if (line.trim() === "") return;
      let parsed: { type?: string; data?: RgMatchData };
      try {
        parsed = JSON.parse(line) as { type?: string; data?: RgMatchData };
      } catch {
        return;
      }
      if (parsed.type !== "match" || parsed.data === undefined) return;
      const filePath = parsed.data.path?.text;
      const lineNo = parsed.data.line_number;
      const rawText = parsed.data.lines?.text ?? "";
      if (filePath === undefined || lineNo === undefined) return;
      const rel = displayPath(base, resolvePath(base, filePath));
      if (matches.length >= max) {
        more = true;
        try { child.kill(); } catch { /* ignore */ }
        done({ matches, more });
        return;
      }
      const lineText = rawText.replace(/\r?\n$/, "");
      matches.push(`${rel}:${lineNo}: ${clipLine(lineText)}`);
    };

    child.stdout.on("data", (chunk: Buffer) => {
      if (finished) return;
      remainder += chunk.toString("utf8");
      let nl = remainder.indexOf("\n");
      while (nl >= 0) {
        consumeLine(remainder.slice(0, nl));
        if (finished) return;
        remainder = remainder.slice(nl + 1);
        nl = remainder.indexOf("\n");
      }
    });
    child.once("error", () => done(undefined));
    child.once("close", (code) => {
      if (finished) return;
      if (remainder.trim() !== "") consumeLine(remainder);
      if (finished) return;
      // code 0 = matches found, 1 = no matches, 2 = error/unsupported regex -> fall back to Node.
      if (code === 0 || code === 1) done({ matches, more });
      else done(undefined);
    });
  });
}

export const grep: ToolDefinition<GrepParams> = {
  name: "grep",
  readOnly: true,
  description: `Search file contents for a regular expression (or literal text). Prints "path:line: text". Skips .git, node_modules and binary files. At most ${MAX_GREP_MATCHES} matches unless \`limit\` says otherwise.`,
  parameters: {
    type: "object",
    properties: {
      pattern: { type: "string", description: "JavaScript regular expression, or text when literal is true" },
      path: { type: "string", description: "File or directory to search (default: the working directory)" },
      glob: { type: "string", description: "Only search files matching this glob, e.g. \"*.ts\"" },
      ignoreCase: { type: "boolean" },
      literal: { type: "boolean" },
      limit: { type: "integer", description: "Maximum matches" },
    },
    required: ["pattern"],
  },
  async execute(params, env) {
    if (!params.literal) {
      try {
        void new RegExp(params.pattern, params.ignoreCase ? "i" : "");
      } catch (error) {
        return textOutput(`Invalid pattern: ${(error as Error).message}`, true);
      }
    }
    const max = Math.max(1, params.limit ?? MAX_GREP_MATCHES);
    const rg = findRipgrep();
    const rgResult = rg !== undefined ? await grepWithRipgrep(rg, params, env) : undefined;
    const result: GrepRunResult = rgResult ?? await grepWithNodeAsync(params, env);
    if (typeof result.error === "string") {
      return textOutput(result.error, true);
    }
    if (result.matches.length === 0) {
      return textOutput(
        result.capped === true
          ? `No matches found before reaching scan limit (${MAX_SCAN_FILES} files / ${MAX_SCAN_DURATION_MS / 1000}s); pass a narrower \`path\` or \`glob\`.`
          : "No matches.",
      );
    }
    const tail = result.more
      ? `\n[Stopped at ${max} matches; narrow the search.]`
      : result.capped === true
        ? `\n[Search stopped at scan limit (${MAX_SCAN_FILES} files / ${MAX_SCAN_DURATION_MS / 1000}s); pass a narrower \`path\` or \`glob\`.]`
        : "";
    return textOutput(result.matches.join("\n") + tail);
  },
};

/**
 * Search tools (`find` and `grep`) for `@qianji/tool-fs`.
 * Uses `ripgrep` (`rg`) as a fast path for `grep` when available, with
 * deterministic fallback to in-process recursive scanning (`walkFiles`).
 */
import { spawn, spawnSync } from "node:child_process";
import { readFileSync, statSync } from "node:fs";
import { dirname } from "node:path";
import { textOutput, type ToolDefinition, type ToolEnv } from "@qianji/tools";
import { clipLine, displayPath, matchesGlob, resolvePath, walkFiles } from "./shared.ts";

export const MAX_FIND_RESULTS = 1000;
export const MAX_GREP_MATCHES = 100;
const MAX_GREP_FILE_BYTES = 2 * 1024 * 1024;

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
  execute({ pattern, path }, env) {
    const root = resolvePath(env.cwd, path ?? ".");
    const found: string[] = [];
    let more = false;
    for (const file of walkFiles(root, env.signal)) {
      const rel = displayPath(root, file);
      if (!matchesGlob(pattern, rel)) continue;
      if (found.length >= MAX_FIND_RESULTS) {
        more = true;
        break;
      }
      found.push(rel);
    }
    if (found.length === 0) return textOutput("No files found.");
    found.sort((a, b) => a.localeCompare(b));
    return textOutput(found.join("\n") + (more ? `\n[More than ${MAX_FIND_RESULTS} files; narrow the pattern.]` : ""));
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

/** Pure-Node grep implementation used as fallback when `rg` is absent or incompatible. */
export function grepWithNode(params: GrepParams, env: Pick<ToolEnv, "cwd" | "signal">): { matches: string[]; more: boolean; error?: string } {
  let regex: RegExp;
  try {
    regex = new RegExp(
      params.literal ? params.pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") : params.pattern,
      params.ignoreCase ? "i" : "",
    );
  } catch (error) {
    return { matches: [], more: false, error: `Invalid pattern: ${(error as Error).message}` };
  }
  const target = resolvePath(env.cwd, params.path ?? ".");
  const single = statSync(target).isFile();
  const base = single ? dirname(target) : target;
  const files = single ? [target] : walkFiles(target, env.signal);
  const max = Math.max(1, params.limit ?? MAX_GREP_MATCHES);
  const matches: string[] = [];
  let more = false;
  outer: for (const file of files) {
    const rel = displayPath(base, file);
    if (params.glob !== undefined && !matchesGlob(params.glob, rel)) continue;
    let buffer: Buffer;
    try {
      if (statSync(file).size > MAX_GREP_FILE_BYTES) continue;
      buffer = readFileSync(file);
    } catch {
      continue;
    }
    if (buffer.subarray(0, 8192).includes(0)) continue;
    const lines = buffer.toString("utf8").split("\n");
    for (let index = 0; index < lines.length; index += 1) {
      const line = (lines[index] as string).replace(/\r$/, "");
      if (!regex.test(line)) continue;
      if (matches.length >= max) {
        more = true;
        break outer;
      }
      matches.push(`${rel}:${index + 1}: ${clipLine(line)}`);
    }
  }
  return { matches, more };
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
    const result: { matches: string[]; more: boolean; error?: string } = rgResult ?? grepWithNode(params, env);
    if (typeof result.error === "string") {
      return textOutput(result.error, true);
    }
    if (result.matches.length === 0) return textOutput("No matches.");
    return textOutput(result.matches.join("\n") + (result.more ? `\n[Stopped at ${max} matches; narrow the search.]` : ""));
  },
};

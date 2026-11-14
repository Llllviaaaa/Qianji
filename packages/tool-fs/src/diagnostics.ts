/**
 * Deferred read-only `diagnostics` tool for `@qianji/tool-fs`.
 * Runs strict JSON syntax checks and invokes the workspace-local TypeScript
 * compiler (`tsc --noEmit`) via child process without bundling `typescript`.
 */
import { spawn } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { textOutput, type ToolDefinition, type ToolEnv } from "@qianji/tools";
import { displayPath, resolvePath } from "./shared.ts";

const DEFAULT_DIAGNOSTICS_LIMIT = 50;
const TSC_TIMEOUT_MS = 45_000;
const TSC_LINE_RE = /^(.+?)\((\d+),(\d+)\):\s+(error|warning)\s+(TS\d+):\s+(.+)$/;

export interface DiagnosticEntry {
  file: string;
  line: number;
  column: number;
  severity: "error" | "warning";
  code: string;
  message: string;
}

function findNearestFileUp(startDir: string, relParts: readonly string[]): string | undefined {
  let dir = resolve(startDir);
  while (true) {
    const candidate = join(dir, ...relParts);
    if (existsSync(candidate)) return candidate;
    const parent = dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
}

function jsonPosition(raw: string, message: string): { line: number; column: number } {
  const match = message.match(/\bposition\s+(\d+)\b/i);
  if (!match) return { line: 1, column: 1 };
  const offset = Math.min(raw.length, Math.max(0, Number.parseInt(match[1] ?? "0", 10)));
  const prefix = raw.slice(0, offset);
  const lines = prefix.split("\n");
  return { line: lines.length, column: (lines.at(-1)?.length ?? 0) + 1 };
}

function checkJsonFile(cwd: string, filePath: string): DiagnosticEntry | undefined {
  if (basename(filePath).toLowerCase().startsWith("tsconfig")) return undefined;
  if (!existsSync(filePath)) return undefined;
  let stat;
  try {
    stat = statSync(filePath);
  } catch {
    return undefined;
  }
  if (!stat.isFile()) return undefined;
  const raw = readFileSync(filePath, "utf8");
  try {
    JSON.parse(raw);
    return undefined;
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    const pos = jsonPosition(raw, msg);
    return {
      file: displayPath(cwd, filePath),
      line: pos.line,
      column: pos.column,
      severity: "error",
      code: "JSON",
      message: msg,
    };
  }
}

/** Parse `tsc --noEmit --pretty false` output into structured diagnostics. */
export function parseTscDiagnostics(output: string, baseDir: string, displayBase: string): DiagnosticEntry[] {
  const entries: DiagnosticEntry[] = [];
  for (const rawLine of output.replace(/\r\n/g, "\n").split("\n")) {
    const line = rawLine.trimEnd();
    const match = line.match(TSC_LINE_RE);
    if (match) {
      const absFile = resolve(baseDir, match[1] ?? "");
      entries.push({
        file: displayPath(displayBase, absFile),
        line: Number.parseInt(match[2] ?? "1", 10),
        column: Number.parseInt(match[3] ?? "1", 10),
        severity: match[4] === "warning" ? "warning" : "error",
        code: match[5] ?? "TS",
        message: match[6] ?? "",
      });
    } else if (/^error TS\d+:\s+/.test(line)) {
      const globalMatch = line.match(/^error\s+(TS\d+):\s+(.+)$/);
      if (globalMatch) {
        entries.push({
          file: displayPath(displayBase, baseDir),
          line: 1,
          column: 1,
          severity: "error",
          code: globalMatch[1] ?? "TS",
          message: globalMatch[2] ?? line,
        });
      }
    }
  }
  return entries;
}

function resolveNodeExecutable(): string {
  return /^(?:node|bun)(?:\.exe)?$/i.test(basename(process.execPath)) ? process.execPath : "node";
}

function runTsc(
  tscScript: string,
  tsconfigPath: string,
  signal: AbortSignal,
): Promise<{ output: string; timedOut: boolean }> {
  return new Promise((resolvePromise) => {
    const projectDir = dirname(tsconfigPath);
    const child = spawn(resolveNodeExecutable(), [tscScript, "--noEmit", "--pretty", "false", "-p", tsconfigPath], {
      cwd: projectDir,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const chunks: Buffer[] = [];
    let timedOut = false;
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
      resolvePromise({ output: Buffer.concat(chunks).toString("utf8"), timedOut });
    };
    const onAbort = () => {
      try { child.kill(); } catch { /* ignore */ }
      finish();
    };
    const timer = setTimeout(() => {
      timedOut = true;
      onAbort();
    }, TSC_TIMEOUT_MS);
    signal.addEventListener("abort", onAbort, { once: true });
    child.stdout.on("data", (chunk: Buffer) => chunks.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => chunks.push(chunk));
    child.once("error", finish);
    child.once("close", finish);
  });
}

export const diagnostics: ToolDefinition<{ paths?: string[]; limit?: number }> = {
  name: "diagnostics",
  readOnly: true,
  deferred: true,
  group: "code_intelligence",
  groupDescription: "Workspace type and JSON syntax diagnostics (diagnostics)",
  timeoutMs: 60_000,
  description: [
    "Run static diagnostics across the workspace or specified `paths` using local JSON syntax validation and the workspace TypeScript compiler (`tsc --noEmit`).",
    "Call this after editing code to catch type errors cleanly.",
  ].join(" "),
  parameters: {
    type: "object",
    properties: {
      paths: { type: "array", items: { type: "string" }, description: "Optional workspace file or directory paths to filter diagnostics" },
      limit: { type: "integer", description: `Maximum diagnostics to return (default ${DEFAULT_DIAGNOSTICS_LIMIT})` },
    },
  },
  async execute({ paths, limit }, env: ToolEnv) {
    const max = Math.max(1, limit ?? DEFAULT_DIAGNOSTICS_LIMIT);
    const resolvedTargets = (paths ?? []).map((p) => resolvePath(env.cwd, p));
    const jsonTargets = resolvedTargets.length > 0
      ? resolvedTargets.filter((p) => p.toLowerCase().endsWith(".json"))
      : [join(env.cwd, "package.json")];

    const entries: DiagnosticEntry[] = [];
    for (const jsonFile of jsonTargets) {
      const issue = checkJsonFile(env.cwd, jsonFile);
      if (issue !== undefined) entries.push(issue);
    }

    const searchStart = resolvedTargets[0] !== undefined
      ? (existsSync(resolvedTargets[0]) && statSync(resolvedTargets[0]).isFile() ? dirname(resolvedTargets[0]) : resolvedTargets[0])
      : env.cwd;
    const tsconfig = findNearestFileUp(searchStart, ["tsconfig.json"]) ?? findNearestFileUp(env.cwd, ["tsconfig.json"]);
    const tscScript = findNearestFileUp(searchStart, ["node_modules", "typescript", "bin", "tsc"])
      ?? findNearestFileUp(env.cwd, ["node_modules", "typescript", "bin", "tsc"]);

    let checkerNote: string | undefined;
    if (tsconfig !== undefined && tscScript !== undefined) {
      const { output, timedOut } = await runTsc(tscScript, tsconfig, env.signal);
      if (timedOut) {
        return textOutput("TypeScript diagnostics timed out after 45s.", true);
      }
      const tsEntries = parseTscDiagnostics(output, dirname(tsconfig), env.cwd);
      if (resolvedTargets.length > 0) {
        const filterRels = resolvedTargets.map((target) => displayPath(env.cwd, target));
        for (const entry of tsEntries) {
          const matchesTarget = filterRels.some((rel) => entry.file === rel || entry.file.startsWith(`${rel}/`) || rel === ".");
          if (matchesTarget) entries.push(entry);
        }
      } else {
        entries.push(...tsEntries);
      }
    } else if (jsonTargets.every((p) => !existsSync(p))) {
      checkerNote = "No local tsconfig.json + workspace TypeScript compiler or JSON target found.";
    }

    if (entries.length === 0) {
      return textOutput(checkerNote ?? "No diagnostics found.");
    }
    const shown = entries.slice(0, max);
    const formatted = shown.map((item) => `${item.file}:${item.line}:${item.column} [${item.severity} ${item.code}] ${item.message}`);
    const note = entries.length > max ? `\n\n[${entries.length - max} more diagnostics omitted.]` : "";
    return textOutput(formatted.join("\n") + note);
  },
};

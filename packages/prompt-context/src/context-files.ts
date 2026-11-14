/**
 * Context file discovery (`AGENTS.md`, `CLAUDE.md`, `.local.md` overrides),
 * project boundary detection, nested subdirectory discovery, and bounded
 * `@path` import expansion.
 */
import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, extname, isAbsolute, join, parse, relative, resolve } from "node:path";

export const SHARED_CONTEXT_FILES = ["AGENTS.md", "CLAUDE.md"] as const;
export const LOCAL_CONTEXT_FILES = ["AGENTS.local.md", "CLAUDE.local.md"] as const;
export const MAX_IMPORT_DEPTH = 5;
export const MAX_IMPORT_BYTES = 64 * 1024;

const IMPORTABLE_EXTENSIONS = new Set([".md", ".mdc", ".txt", ".markdown"]);
const BLOCKED_IMPORT_BASENAMES = new Set([
  ".env",
  "secrets.dat",
  "mcp-secrets.dat",
  "auth.json",
  "id_rsa",
  "id_dsa",
  "id_ecdsa",
  "id_ed25519",
]);
const BLOCKED_IMPORT_EXTENSIONS = new Set([".pem", ".key", ".pfx", ".p12", ".kdbx", ".sqlite", ".db"]);

export function normalizeComparePath(filePath: string): string {
  const normalized = resolve(filePath).replace(/\\/g, "/");
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

function safeRealpath(targetPath: string): string {
  const abs = resolve(targetPath);
  if (!existsSync(abs)) return abs;
  try {
    return realpathSync(abs);
  } catch {
    return abs;
  }
}

export function isExistingFile(filePath: string): boolean {
  if (!existsSync(filePath)) return false;
  try {
    return statSync(filePath).isFile();
  } catch {
    return false;
  }
}

export function isExistingDirectory(dirPath: string): boolean {
  if (!existsSync(dirPath)) return false;
  try {
    return statSync(dirPath).isDirectory();
  } catch {
    return false;
  }
}

export function isPathInside(childPath: string, parentDir: string): boolean {
  const child = safeRealpath(childPath);
  const parent = safeRealpath(parentDir);
  const comparableChild = process.platform === "win32" ? child.toLowerCase() : child;
  const comparableParent = process.platform === "win32" ? parent.toLowerCase() : parent;
  const rel = relative(comparableParent, comparableChild);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

/**
 * Nearest ancestor containing `.git`, else nearest containing `.qianji` or `.pid`,
 * else `resolve(cwd)`. Filesystem root is excluded from marker checks.
 */
export function findProjectBoundary(cwd: string): string {
  const resolvedCwd = resolve(cwd);
  const root = parse(resolvedCwd).root;
  let dir = resolvedCwd;
  let qianjiHit: string | undefined;

  while (dir !== root) {
    if (existsSync(join(dir, ".git"))) {
      return dir;
    }
    if (qianjiHit === undefined && (existsSync(join(dir, ".qianji")) || existsSync(join(dir, ".pid")))) {
      qianjiHit = dir;
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }

  return qianjiHit ?? resolvedCwd;
}

function collectDirContextFiles(
  dir: string,
  files: string[],
  seen: Set<string>,
): void {
  const pushFirst = (names: readonly string[]): void => {
    for (const name of names) {
      const candidate = join(dir, name);
      if (!isExistingFile(candidate)) continue;
      const key = normalizeComparePath(candidate);
      if (!seen.has(key)) {
        seen.add(key);
        files.push(candidate);
      }
      return;
    }
  };
  pushFirst(SHARED_CONTEXT_FILES);
  pushFirst(LOCAL_CONTEXT_FILES);
}

/**
 * The context files that apply in `cwd`: global (`dataDir`) first, then from
 * the filesystem root down to `cwd`. In each directory, `AGENTS.md` wins over
 * `CLAUDE.md`, followed by `AGENTS.local.md` (or `CLAUDE.local.md`).
 */
export function contextFiles(dataDir: string, cwd: string): string[] {
  const files: string[] = [];
  const seen = new Set<string>();

  collectDirContextFiles(dataDir, files, seen);

  const dirs: string[] = [];
  let dir = resolve(cwd);
  const root = parse(dir).root;
  for (;;) {
    dirs.unshift(dir);
    if (dir === root) break;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }

  for (const each of dirs) {
    collectDirContextFiles(each, files, seen);
  }

  return files;
}

/**
 * Discover context files in subdirectories strictly below `cwd` along the
 * path to `targetPath`.
 */
export function nestedContextFiles(cwd: string, targetPath: string): string[] {
  const absCwd = resolve(cwd);
  const absTarget = resolve(absCwd, targetPath);
  const targetDir = isExistingDirectory(absTarget) ? absTarget : dirname(absTarget);

  if (!isPathInside(targetDir, absCwd) || normalizeComparePath(targetDir) === normalizeComparePath(absCwd)) {
    return [];
  }

  const dirs: string[] = [];
  let dir = targetDir;
  const cwdKey = normalizeComparePath(safeRealpath(absCwd));
  const root = parse(dir).root;

  while (dir !== root) {
    const dirKey = normalizeComparePath(safeRealpath(dir));
    if (dirKey === cwdKey || !isPathInside(dir, absCwd)) break;
    dirs.unshift(dir);
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }

  const files: string[] = [];
  const seen = new Set<string>();
  for (const each of dirs) {
    collectDirContextFiles(each, files, seen);
  }
  return files;
}

export interface ExpandImportsOptions {
  dataDir?: string;
  boundaryDir?: string;
  visited?: Set<string>;
  depth?: number;
  budget?: { remaining: number };
}

function isBlockedImportTarget(resolvedPath: string): boolean {
  const base = basename(resolvedPath).toLowerCase();
  if (BLOCKED_IMPORT_BASENAMES.has(base) || base.startsWith(".env.")) {
    return true;
  }
  const ext = extname(base);
  return BLOCKED_IMPORT_EXTENSIONS.has(ext);
}

function isCandidateImportToken(token: string, allowHome: boolean): boolean {
  if (token.startsWith("./") || token.startsWith("../")) return true;
  if (allowHome && token.startsWith("~/")) return true;
  if (token.includes("/")) return true;
  return IMPORTABLE_EXTENSIONS.has(extname(token).toLowerCase());
}

/** Split a line into alternating prose and inline-code segments (`...`). */
function extractProseSegments(line: string): string[] {
  const segments: string[] = [];
  let index = 0;
  let proseStart = 0;

  while (index < line.length) {
    if (line[index] !== "`") {
      index += 1;
      continue;
    }
    let ticks = 0;
    while (index + ticks < line.length && line[index + ticks] === "`") {
      ticks += 1;
    }
    const closer = "`".repeat(ticks);
    const closeIndex = line.indexOf(closer, index + ticks);
    if (closeIndex === -1) {
      index += ticks;
      continue;
    }
    // Check exact backtick count match on closing delimiter when possible.
    if (closeIndex > proseStart && index > proseStart) {
      segments.push(line.slice(proseStart, index));
    }
    index = closeIndex + ticks;
    proseStart = index;
  }

  if (proseStart < line.length) {
    segments.push(line.slice(proseStart));
  }
  return segments;
}

function findImportTokensInLine(line: string, allowHome: boolean): string[] {
  const tokens: string[] = [];
  const pattern = /(^|[\s([<"'])@([^\s)>\]"']+)/g;
  for (const segment of extractProseSegments(line)) {
    pattern.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(segment)) !== null) {
      const raw = match[2];
      if (raw === undefined) continue;
      const cleaned = raw.replace(/[.,;:!?]+$/, "");
      if (cleaned !== "" && isCandidateImportToken(cleaned, allowHome)) {
        tokens.push(cleaned);
      }
    }
  }
  return tokens;
}

function resolveImportCandidate(
  candidate: string,
  sourceDir: string,
  isGlobalSource: boolean,
  boundaryDir: string,
): string | undefined {
  let resolved: string | undefined;
  let effectiveBoundary = boundaryDir;
  if (candidate.startsWith("~/")) {
    if (!isGlobalSource) return undefined;
    const home = homedir();
    resolved = resolve(home, candidate.slice(2));
    effectiveBoundary = home;
  } else if (candidate.startsWith("./") || candidate.startsWith("../")) {
    resolved = resolve(sourceDir, candidate);
  } else {
    const localCandidate = resolve(sourceDir, candidate);
    if (isExistingFile(localCandidate)) {
      resolved = localCandidate;
    } else {
      const rootCandidate = resolve(boundaryDir, candidate);
      if (isExistingFile(rootCandidate)) {
        resolved = rootCandidate;
      }
    }
  }

  if (resolved === undefined || !isExistingFile(resolved)) return undefined;
  if (isBlockedImportTarget(resolved)) return undefined;
  if (!isPathInside(resolved, effectiveBoundary)) return undefined;
  return resolved;
}

function readSafeUtf8WithinBudget(filePath: string, budget: { remaining: number }): string | undefined {
  if (budget.remaining <= 0) return undefined;
  let buffer: Buffer;
  try {
    buffer = readFileSync(filePath);
  } catch {
    return undefined;
  }
  const probeLen = Math.min(buffer.length, 4096);
  if (buffer.subarray(0, probeLen).includes(0)) return undefined;

  let text: string;
  if (buffer.byteLength > budget.remaining) {
    text = buffer.subarray(0, budget.remaining).toString("utf8").replace(/\uFFFD$/, "");
    budget.remaining = 0;
  } else {
    text = buffer.toString("utf8");
    budget.remaining -= buffer.byteLength;
  }
  return text.trim();
}

const STANDALONE_IMPORT_LINE = /^(?:[-*]\s+)?@[^\s)>\]"']+[.,;:!?]*$/;

/**
 * Expand safe `@path` imports inside a context or rule Markdown document.
 * Ignores fenced code blocks, inline code spans, email addresses, and
 * scoped identifiers, while enforcing boundary, secret, depth, and byte limits.
 */
export function expandContextImports(
  content: string,
  sourceFile: string,
  options: ExpandImportsOptions = {},
): string {
  const absSource = resolve(sourceFile);
  const visited = options.visited ?? new Set<string>([normalizeComparePath(safeRealpath(absSource))]);
  const depth = options.depth ?? 0;
  const budget = options.budget ?? { remaining: MAX_IMPORT_BYTES };
  const isGlobalSource = options.dataDir !== undefined && isPathInside(absSource, options.dataDir);
  const boundaryDir =
    options.boundaryDir ??
    (isGlobalSource && options.dataDir !== undefined ? options.dataDir : dirname(absSource));

  const lines = content.replace(/\r\n/g, "\n").split("\n");
  const out: string[] = [];
  let fenceChar: "`" | "~" | undefined;
  let fenceLen = 0;

  for (const line of lines) {
    if (fenceChar !== undefined) {
      out.push(line);
      const closeMatch = /^\s*(`{3,}|~{3,})\s*$/.exec(line);
      const marker = closeMatch?.[1];
      if (marker !== undefined && marker[0] === fenceChar && marker.length >= fenceLen) {
        fenceChar = undefined;
        fenceLen = 0;
      }
      continue;
    }

    const openMatch = /^\s*(`{3,}|~{3,})/.exec(line);
    const openMarker = openMatch?.[1];
    if (openMarker !== undefined) {
      const char = openMarker[0];
      if (char === "`" || char === "~") {
        // CommonMark: backtick info strings cannot contain other backticks.
        const rest = line.slice(openMatch?.[0].length ?? 0);
        if (char === "~" || !rest.includes("`")) {
          fenceChar = char;
          fenceLen = openMarker.length;
          out.push(line);
          continue;
        }
      }
    }

    const tokens = depth < MAX_IMPORT_DEPTH ? findImportTokensInLine(line, isGlobalSource) : [];
    if (tokens.length === 0) {
      out.push(line);
      continue;
    }

    const blocks: string[] = [];
    const sourceDir = dirname(absSource);
    for (const token of tokens) {
      if (budget.remaining <= 0) break;
      const resolved = resolveImportCandidate(token, sourceDir, isGlobalSource, boundaryDir);
      if (resolved === undefined) continue;
      const canonicalKey = normalizeComparePath(safeRealpath(resolved));
      if (visited.has(canonicalKey)) continue;
      const rawChild = readSafeUtf8WithinBudget(resolved, budget);
      if (rawChild === undefined) continue;
      visited.add(canonicalKey);
      const expandedChild = expandContextImports(rawChild, resolved, {
        ...(options.dataDir === undefined ? {} : { dataDir: options.dataDir }),
        boundaryDir: isGlobalSource && token.startsWith("~/") ? homedir() : boundaryDir,
        visited,
        depth: depth + 1,
        budget,
      });
      if (expandedChild !== "") {
        blocks.push(`<imported-file path="${resolved}">\n${expandedChild}\n</imported-file>`);
      }
    }

    const isStandalone = STANDALONE_IMPORT_LINE.test(line.trim()) && tokens.length === 1 && blocks.length === 1;
    if (isStandalone) {
      const only = blocks[0];
      if (only !== undefined) out.push(only);
    } else {
      out.push(line);
      for (const block of blocks) {
        out.push(block);
      }
    }
  }

  return out.join("\n");
}

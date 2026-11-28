/**
 * Sentinel Path Fence & fenced file explorer (`packages/host/src/bot/computer/sentinel-fence.ts`).
 *
 * Enforces strict filesystem containment for `local-win-pip` and `/workspace` + `/shared`
 * mappings so Bot file operations never escape `[botWorkspaceDir, ...sharedFolders.map(f => f.path)]`.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { dirname, extname, isAbsolute, join, posix, relative, resolve } from "node:path";
import type {
  BotComputerEngineId,
  BotComputerFileEntry,
  BotComputerFilesListResult,
  BotComputerFilesReadResult,
  BotSharedFolderRule,
} from "@qianji/protocol";
import { stripBom } from "@qianji/tool-fs";
import { sharedFolderSlug } from "../wsl-exec-helpers.ts";

export class SentinelFenceError extends Error {
  readonly targetPath: string;
  readonly fencedRoots: readonly string[];

  constructor(message: string, targetPath: string, fencedRoots: readonly string[]) {
    super(message);
    this.name = "SentinelFenceError";
    this.targetPath = targetPath;
    this.fencedRoots = fencedRoots;
  }
}

const MIME_BY_EXT: Record<string, string> = {
  ".md": "text/markdown", ".txt": "text/plain", ".json": "application/json",
  ".ts": "text/typescript", ".tsx": "text/typescript", ".js": "text/javascript",
  ".py": "text/x-python", ".rs": "text/x-rust", ".html": "text/html", ".css": "text/css",
  ".yml": "text/yaml", ".yaml": "text/yaml", ".csv": "text/csv", ".svg": "image/svg+xml",
  ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif", ".webp": "image/webp",
};
const BINARY_IMAGE_EXTS = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp"]);

function stripWinVerbatimPrefix(p: string): string {
  if (process.platform !== "win32") return p;
  if (p.startsWith("\\\\?\\UNC\\")) return `\\\\${p.slice("\\\\?\\UNC\\".length)}`;
  if (/^\\\\\?\\[a-zA-Z]:[\\/]/.test(p)) return p.slice(4);
  return p;
}

function trimTrailingPathSep(p: string): string {
  if (process.platform === "win32") {
    if (/^[a-zA-Z]:[\\/]*$/.test(p)) return `${p.slice(0, 2)}\\`;
    return p.replace(/[\\/]+$/, "");
  }
  return p === "/" ? "/" : p.replace(/\/+$/, "");
}

function normalizeCmp(p: string): string {
  const abs = trimTrailingPathSep(resolve(p));
  return process.platform === "win32" ? abs.toLowerCase() : abs;
}

/**
 * Canonicalizes `target` by resolving the deepest existing directory/file ancestor
 * via `realpathSync.native` (expanding Windows 8.3 short paths such as `RUNNER~1`
 * into `runneradmin` as well as symlinks/junctions) and appending any not-yet-created
 * relative suffix segments.
 */
export function canonicalizeExistingAncestors(target: string): string {
  const abs = resolve(target);
  let cur = abs;
  while (true) {
    if (existsSync(cur)) {
      let realCur: string;
      try {
        realCur = stripWinVerbatimPrefix(realpathSync.native(cur));
      } catch {
        try {
          realCur = stripWinVerbatimPrefix(realpathSync(cur));
        } catch {
          realCur = cur;
        }
      }
      return cur === abs ? resolve(realCur) : resolve(realCur, relative(cur, abs));
    }
    const parent = dirname(cur);
    if (parent === cur) return abs;
    cur = parent;
  }
}

export function hasTrailingSafeRootPrefix(candidatePath: string, rootPath: string): boolean {
  const isWin = process.platform === "win32";
  const sep = isWin ? "\\" : "/";
  const norm = (s: string) => trimTrailingPathSep(isWin ? resolve(s).replace(/\//g, "\\").toLowerCase() : resolve(s));
  const cand = norm(candidatePath);
  const root = norm(rootPath);
  if (cand === root) return true;
  const prefix = root.endsWith(sep) ? root : `${root}${sep}`;
  return cand.startsWith(prefix);
}

export function isSubpathOfRoot(candidatePath: string, rootPath: string): boolean {
  const cand = canonicalizeExistingAncestors(candidatePath);
  const root = canonicalizeExistingAncestors(rootPath);
  if (!hasTrailingSafeRootPrefix(cand, root)) return false;
  const rel = relative(
    process.platform === "win32" ? root.toLowerCase() : root,
    process.platform === "win32" ? cand.toLowerCase() : cand,
  );
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

export function computeFencedRoots(
  botWorkspaceDir: string,
  sharedFolders: readonly BotSharedFolderRule[],
): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const addRootVariants = (raw: string) => {
    const canonical = trimTrailingPathSep(canonicalizeExistingAncestors(raw));
    const lexical = trimTrailingPathSep(resolve(raw));
    for (const variant of [canonical, lexical]) {
      const key = normalizeCmp(variant);
      if (!seen.has(key)) {
        seen.add(key);
        out.push(variant);
      }
    }
  };
  addRootVariants(botWorkspaceDir);
  for (const folder of sharedFolders) {
    const trimmed = folder.path.trim();
    if (trimmed === "") continue;
    addRootVariants(trimmed);
  }
  return out;
}

export interface ResolvedFencedTarget {
  hostPath: string;
  virtualPath: string;
  readonly: boolean;
}

export function resolveFencedPath(
  rawPath: string | undefined,
  botWorkspaceDir: string,
  sharedFolders: readonly BotSharedFolderRule[],
  options: { requireWritable?: boolean } = {},
): ResolvedFencedTarget {
  const fencedRoots = computeFencedRoots(botWorkspaceDir, sharedFolders);
  const wsRoot = canonicalizeExistingAncestors(botWorkspaceDir);
  const trimmed = (rawPath ?? "").trim();
  const isWinDriveOrUnc = /^[a-zA-Z]:[\\/]/.test(trimmed) || trimmed.startsWith("\\\\");
  const vpath = isWinDriveOrUnc ? trimmed : trimmed.replace(/\\/g, "/");

  let candidateHostPath: string;
  if (vpath === "" || vpath === "." || vpath === "/workspace" || vpath === "/workspace/") {
    candidateHostPath = wsRoot;
  } else if (vpath.startsWith("/workspace/")) {
    candidateHostPath = resolve(wsRoot, vpath.slice("/workspace/".length));
  } else if (vpath === "/shared" || vpath.startsWith("/shared/")) {
    const rest = vpath.slice("/shared".length).replace(/^\/+/, "");
    const slashIdx = rest.indexOf("/");
    const slug = slashIdx >= 0 ? rest.slice(0, slashIdx) : rest;
    const sub = slashIdx >= 0 ? rest.slice(slashIdx + 1) : "";
    const matchedIdx = sharedFolders.findIndex((sf, idx) => sharedFolderSlug(sf.path, idx) === slug);
    const matched = matchedIdx >= 0 ? sharedFolders[matchedIdx] : undefined;
    if (!matched) {
      throw new SentinelFenceError(`Sentinel Path Fence blocked unknown shared mount "${trimmed}"`, trimmed, fencedRoots);
    }
    const matchedRootCanon = canonicalizeExistingAncestors(matched.path);
    candidateHostPath = sub ? resolve(matchedRootCanon, sub) : matchedRootCanon;
  } else if (isWinDriveOrUnc || isAbsolute(vpath) || vpath.startsWith("/")) {
    candidateHostPath = resolve(isWinDriveOrUnc ? trimmed : vpath);
  } else {
    candidateHostPath = resolve(wsRoot, vpath);
  }

  const resolvedHost = canonicalizeExistingAncestors(candidateHostPath);
  let matchedRoot: string | undefined;
  let isReadonly = false;
  if (isSubpathOfRoot(resolvedHost, wsRoot)) {
    matchedRoot = wsRoot;
  } else {
    for (const sf of sharedFolders) {
      if (sf.path.trim() !== "" && isSubpathOfRoot(resolvedHost, sf.path)) {
        matchedRoot = canonicalizeExistingAncestors(sf.path);
        isReadonly = sf.access === "read-only";
        break;
      }
    }
  }

  if (matchedRoot === undefined) {
    throw new SentinelFenceError(
      `Sentinel Path Fence refused path "${rawPath ?? ""}" outside allowed roots (${fencedRoots.join(", ")})`,
      resolvedHost,
      fencedRoots,
    );
  }
  if (options.requireWritable === true && isReadonly) {
    throw new SentinelFenceError(
      `Sentinel Path Fence refused write to read-only shared folder "${rawPath ?? ""}"`,
      resolvedHost,
      fencedRoots,
    );
  }

  let virtualPath: string;
  if (isSubpathOfRoot(resolvedHost, wsRoot)) {
    const rel = relative(wsRoot, resolvedHost).replace(/\\/g, "/");
    virtualPath = rel === "" ? "/workspace" : posix.join("/workspace", rel);
  } else {
    const sfIdx = sharedFolders.findIndex((sf) => sf.path.trim() !== "" && isSubpathOfRoot(resolvedHost, sf.path));
    const sf = sfIdx >= 0 ? sharedFolders[sfIdx] : undefined;
    if (sf !== undefined) {
      const slug = sharedFolderSlug(sf.path, sfIdx);
      const sfCanon = canonicalizeExistingAncestors(sf.path);
      const rel = relative(sfCanon, resolvedHost).replace(/\\/g, "/");
      virtualPath = rel === "" ? `/shared/${slug}` : posix.join(`/shared/${slug}`, rel);
    } else {
      virtualPath = resolvedHost;
    }
  }
  return { hostPath: resolvedHost, virtualPath, readonly: isReadonly };
}

export function listFencedFiles(
  engine: BotComputerEngineId,
  rawPath: string | undefined,
  botWorkspaceDir: string,
  sharedFolders: readonly BotSharedFolderRule[],
  useHostPathsInDisplay = false,
): BotComputerFilesListResult {
  const target = resolveFencedPath(rawPath, botWorkspaceDir, sharedFolders);
  if (!existsSync(target.hostPath)) {
    const canonWsDir = canonicalizeExistingAncestors(botWorkspaceDir);
    if (normalizeCmp(target.hostPath) !== normalizeCmp(canonWsDir)) {
      throw new Error(`Directory not found: ${rawPath ?? target.hostPath}`);
    }
    mkdirSync(target.hostPath, { recursive: true });
  }
  const st = statSync(target.hostPath);
  if (!st.isDirectory()) throw new Error(`Not a directory: ${rawPath ?? target.hostPath}`);

  const entries: BotComputerFileEntry[] = [];
  for (const dirent of readdirSync(target.hostPath, { withFileTypes: true })) {
    const full = join(target.hostPath, dirent.name);
    let itemStat;
    try { itemStat = statSync(full); } catch { continue; }
    const ext = extname(dirent.name).toLowerCase();
    const entryPath = useHostPathsInDisplay ? full : posix.join(target.virtualPath, dirent.name);
    entries.push({
      name: dirent.name,
      path: entryPath,
      isDir: itemStat.isDirectory(),
      sizeBytes: itemStat.isDirectory() ? 0 : itemStat.size,
      updatedAt: Math.floor(itemStat.mtimeMs),
      ...(MIME_BY_EXT[ext] ? { mimeType: MIME_BY_EXT[ext] } : {}),
      ...(target.readonly ? { readonly: true } : {}),
    });
  }
  entries.sort((a, b) => (a.isDir !== b.isDir ? (a.isDir ? -1 : 1) : a.name.localeCompare(b.name)));
  return { engine, cwd: useHostPathsInDisplay ? target.hostPath : target.virtualPath, entries };
}

export function readFencedFile(
  rawPath: string,
  maxBytes: number | undefined,
  botWorkspaceDir: string,
  sharedFolders: readonly BotSharedFolderRule[],
  useHostPathsInDisplay = false,
): BotComputerFilesReadResult {
  const target = resolveFencedPath(rawPath, botWorkspaceDir, sharedFolders);
  if (!existsSync(target.hostPath)) throw new Error(`File not found: ${rawPath}`);
  const st = statSync(target.hostPath);
  if (!st.isFile()) throw new Error(`Path is not a regular file: ${rawPath}`);

  const cap = Math.min(4 * 1024 * 1024, Math.max(256, maxBytes ?? 512 * 1024));
  const rawBuf = readFileSync(target.hostPath);
  const sliced = rawBuf.byteLength > cap ? rawBuf.subarray(0, cap) : rawBuf;
  const ext = extname(target.hostPath).toLowerCase();
  const mimeType = MIME_BY_EXT[ext];
  const isBinary = BINARY_IMAGE_EXTS.has(ext) || sliced.includes(0);
  const outPath = useHostPathsInDisplay ? target.hostPath : target.virtualPath;
  if (isBinary) {
    return {
      path: outPath,
      dataBase64: sliced.toString("base64"),
      ...(mimeType ? { mimeType } : {}),
      sizeBytes: st.size,
      isBinary: true,
    };
  }
  return {
    path: outPath,
    content: stripBom(sliced.toString("utf8")).text,
    mimeType: mimeType ?? "text/plain",
    sizeBytes: st.size,
    isBinary: false,
  };
}

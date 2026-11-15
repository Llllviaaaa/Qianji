/**
 * Session-pinned environment date and stat/mtime/size-fingerprinted memoization
 * caches for context files, project/user rules, and skills.
 */
import { createHash } from "node:crypto";
import { readdirSync, readFileSync, realpathSync, statSync, type Stats } from "node:fs";
import { basename, dirname, join, parse, resolve } from "node:path";
import {
  contextFiles,
  expandContextImports,
  findProjectBoundary,
  isPathInside,
  LOCAL_CONTEXT_FILES,
  SHARED_CONTEXT_FILES,
} from "./context-files.ts";

export const MAX_PINNED_SESSIONS = 512;
const MAX_CACHE_ENTRIES = 64;
const RACILY_CLEAN_MS = 100;

export interface PathSnapshot {
  path: string;
  kind: "file" | "dir" | "missing";
  size: number;
  mtimeMs: number;
  quickHash?: string;
  dirListing?: string;
}

export type CacheBucketName = "contextBlocks" | "rules" | "alwaysRules" | "skills";
export type CacheStats = Record<CacheBucketName, { hits: number; misses: number }>;

interface SnapshotEntry<T> {
  value: T;
  snapshots: PathSnapshot[];
  signature?: string;
}

const defaultPinnedDates = new Map<string, string>();
const buckets: Record<CacheBucketName, Map<string, SnapshotEntry<unknown>>> = {
  contextBlocks: new Map(),
  rules: new Map(),
  alwaysRules: new Map(),
  skills: new Map(),
};
const stats: CacheStats = {
  contextBlocks: { hits: 0, misses: 0 },
  rules: { hits: 0, misses: 0 },
  alwaysRules: { hits: 0, misses: 0 },
  skills: { hits: 0, misses: 0 },
};

const safeStat = (p: string): Stats | undefined => { try { return statSync(p); } catch { return undefined; } };
const safeQuickHash = (p: string): string | undefined => {
  try { return createHash("sha1").update(readFileSync(p)).digest("hex"); } catch { return undefined; }
};
const safeDirListing = (p: string): string | undefined => {
  try { return readdirSync(p).sort().join("\0"); } catch { return undefined; }
};

function touchBounded<V>(map: Map<string, V>, key: string, value: V, limit: number): void {
  if (map.has(key)) map.delete(key);
  map.set(key, value);
  while (map.size > limit) {
    const oldest = map.keys().next().value;
    if (oldest === undefined) break;
    map.delete(oldest);
  }
}

/** Captures file/dir/missing stat snapshots (plus racily-clean hash/listing guards). */
export function takeSnapshots(paths: Iterable<string>): PathSnapshot[] {
  const nowMs = Date.now();
  const seen = new Set<string>();
  const snapshots: PathSnapshot[] = [];
  for (const rawPath of paths) {
    const abs = resolve(rawPath);
    if (seen.has(abs)) continue;
    seen.add(abs);
    const st = safeStat(abs);
    if (st === undefined) {
      snapshots.push({ path: abs, kind: "missing", size: 0, mtimeMs: 0 });
    } else if (st.isDirectory()) {
      const dirListing = nowMs - st.mtimeMs < RACILY_CLEAN_MS ? safeDirListing(abs) : undefined;
      snapshots.push({ path: abs, kind: "dir", size: 0, mtimeMs: st.mtimeMs, ...(dirListing === undefined ? {} : { dirListing }) });
    } else {
      const quickHash = nowMs - st.mtimeMs < RACILY_CLEAN_MS ? safeQuickHash(abs) : undefined;
      snapshots.push({ path: abs, kind: "file", size: st.size, mtimeMs: st.mtimeMs, ...(quickHash === undefined ? {} : { quickHash }) });
    }
  }
  return snapshots;
}

/** Validates a snapshot list against current filesystem stat/mtime/size state. */
export function isSnapshotValid(snapshots: readonly PathSnapshot[]): boolean {
  const nowMs = Date.now();
  for (const snap of snapshots) {
    const st = safeStat(snap.path);
    if (snap.kind === "missing") {
      if (st !== undefined) return false;
      continue;
    }
    if (st === undefined) return false;
    if (snap.kind === "dir") {
      if (!st.isDirectory() || st.mtimeMs !== snap.mtimeMs) return false;
      if (snap.dirListing !== undefined) {
        if (safeDirListing(snap.path) !== snap.dirListing) return false;
        if (nowMs - st.mtimeMs >= RACILY_CLEAN_MS) snap.dirListing = undefined;
      }
      continue;
    }
    if (!st.isFile() || st.size !== snap.size || st.mtimeMs !== snap.mtimeMs) return false;
    if (snap.quickHash !== undefined) {
      if (safeQuickHash(snap.path) !== snap.quickHash) return false;
      if (nowMs - st.mtimeMs >= RACILY_CLEAN_MS) snap.quickHash = undefined;
    }
  }
  return true;
}

function getCachedEntry<T>(
  bucket: CacheBucketName,
  key: string,
  compute: () => { value: T; deps: string[] },
  signature?: string,
): T {
  const cache = buckets[bucket];
  const cached = cache.get(key) as SnapshotEntry<T> | undefined;
  if (cached !== undefined && cached.signature === signature && isSnapshotValid(cached.snapshots)) {
    touchBounded(cache, key, cached, MAX_CACHE_ENTRIES);
    stats[bucket].hits += 1;
    return cached.value;
  }
  stats[bucket].misses += 1;
  const { value, deps } = compute();
  touchBounded(cache, key, { value, snapshots: takeSnapshots(deps), ...(signature === undefined ? {} : { signature }) }, MAX_CACHE_ENTRIES);
  return value;
}

function listAncestorDirs(cwd: string): string[] {
  const dirs: string[] = [];
  let dir = resolve(cwd);
  const root = parse(dir).root;
  for (;;) {
    dirs.push(dir);
    if (dir === root) break;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return dirs;
}

/**
 * Canonicalizes symlinks, Windows junctions, and 8.3 short paths (e.g. `RUNNER~1` -> `runneradmin`),
 * walking up to the nearest existing ancestor when leaf segments do not exist yet.
 */
export function canonicalSkillPath(input: string): string {
  const resolved = resolve(input);
  try {
    return realpathSync.native(resolved);
  } catch {
    const tail: string[] = [];
    let current = resolved;
    for (;;) {
      const parent = dirname(current);
      if (parent === current) return resolved;
      tail.unshift(basename(current));
      current = parent;
      try {
        return join(realpathSync.native(current), ...tail);
      } catch {
        // Walk up until an existing ancestor resolves.
      }
    }
  }
}

/** Pins `YYYY-MM-DD` once per non-empty `sessionId` (bounded LRU up to `MAX_PINNED_SESSIONS`). */
export function pinSessionDate(
  sessionId: string | undefined,
  now: () => Date,
  cache: Map<string, string> = defaultPinnedDates,
): string {
  if (sessionId === undefined || sessionId === "") return now().toISOString().slice(0, 10);
  const existing = cache.get(sessionId);
  if (existing !== undefined) {
    touchBounded(cache, sessionId, existing, MAX_PINNED_SESSIONS);
    return existing;
  }
  const pinned = now().toISOString().slice(0, 10);
  touchBounded(cache, sessionId, pinned, MAX_PINNED_SESSIONS);
  return pinned;
}

const CONTEXT_CANDIDATES = [...SHARED_CONTEXT_FILES, ...LOCAL_CONTEXT_FILES] as const;
const BOUNDARY_MARKERS = [".git", ".qianji", ".pid"] as const;

function collectContextFileDeps(dataDir: string, resolvedCwd: string): string[] {
  const deps: string[] = [];
  for (const name of CONTEXT_CANDIDATES) deps.push(join(dataDir, name));
  for (const dir of listAncestorDirs(resolvedCwd)) {
    for (const name of CONTEXT_CANDIDATES) deps.push(join(dir, name));
    for (const marker of BOUNDARY_MARKERS) deps.push(join(dir, marker));
  }
  return deps;
}

/** Memoized context-file blocks with `@import` expansion per `(dataDir, cwd)`. */
export function getCachedContextBlocks(dataDir: string, cwd: string): string[] {
  const resolvedCwd = resolve(cwd);
  return getCachedEntry("contextBlocks", `${resolve(dataDir)}\0${resolvedCwd}`, () => {
    const files = contextFiles(dataDir, resolvedCwd);
    const boundary = findProjectBoundary(resolvedCwd);
    const deps: string[] = [...collectContextFileDeps(dataDir, resolvedCwd), ...files];
    const blocks: string[] = [];
    for (const file of files) {
      let raw: string;
      try {
        raw = readFileSync(file, "utf8").trim();
      } catch {
        continue;
      }
      if (raw === "") continue;
      const expanded = expandContextImports(raw, file, {
        dataDir,
        boundaryDir: isPathInside(file, dataDir) ? dataDir : boundary,
        onDependency: (depPath) => deps.push(depPath),
      });
      if (expanded !== "") blocks.push(`<context-file path="${file}">\n${expanded}\n</context-file>`);
    }
    return { value: blocks, deps };
  });
}

/** Shared stat-validated cache for `discoverRules(dataDir, cwd)`. */
export function getCachedDiscoveredRules<T>(key: string, compute: () => { value: T; deps: string[] }): T {
  return getCachedEntry("rules", key, compute);
}

/** Stat-validated cache for `renderAlwaysRules` expanded blocks. */
export function getCachedAlwaysRuleBlocks(
  cacheKey: string,
  signature: string,
  compute: (onDep: (depPath: string) => void) => string[],
): string[] {
  return getCachedEntry("alwaysRules", cacheKey, () => {
    const deps: string[] = [];
    return { value: compute((depPath) => deps.push(depPath)), deps };
  }, signature);
}

/** Stat-validated cache for `findSkills` directory scans (prior to `disabled` filtering). */
export function getCachedScannedSkills<T>(dirsKey: string, scan: () => { value: T; deps: string[] }): T {
  return getCachedEntry("skills", dirsKey, scan);
}

/** Returns current cache hit/miss counters for diagnostics and unit tests. */
export function getCacheStats(): CacheStats {
  return {
    contextBlocks: { ...stats.contextBlocks },
    rules: { ...stats.rules },
    alwaysRules: { ...stats.alwaysRules },
    skills: { ...stats.skills },
  };
}

/** Clears all memoization caches and resets hit/miss counters (intended for tests). */
export function clearPromptContextCaches(): void {
  defaultPinnedDates.clear();
  for (const cache of Object.values(buckets)) cache.clear();
  for (const key of Object.keys(stats) as CacheBucketName[]) stats[key] = { hits: 0, misses: 0 };
}

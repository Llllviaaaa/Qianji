/**
 * Path, shell-prefix, and custom-rule matching helpers for `@qianji/permissions`.
 */
import { lstatSync, readlinkSync, realpathSync } from "node:fs";
import { dirname, resolve as resolveNodePath } from "node:path";

const realpathNative = typeof realpathSync.native === "function" ? realpathSync.native : realpathSync;
const MAX_SYMLINK_HOPS = 16;

export interface PermissionRules {
  alwaysConfirmShell: boolean;
  blockWriteOutsideWorkspace: boolean;
  /** Settings → 允许强制推送. Off (the default) blocks a shell `git push` that would rewrite a remote branch. */
  allowForcePush?: boolean;
  /** Command prefixes that skip shell confirmation under ask / workspace-write. */
  shellAllowPrefixes: string[];
  toolRules: ToolPermissionRule[];
}

export interface ToolPermissionRule {
  id: string;
  enabled: boolean;
  toolPattern: string;
  action: "allow" | "confirm" | "block";
  commandPrefix: string;
  pathPrefix: string;
}

export function normalizePath(value: string): string {
  return value.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
}

/** True for Windows drive paths, UNC, or POSIX absolute paths. */
export function isAbsolutePath(path: string): boolean {
  const candidate = path.replace(/\\/g, "/");
  return /^[a-zA-Z]:(\/|$)/.test(candidate) || candidate.startsWith("/") || candidate.startsWith("//");
}

/**
 * Resolve a tool path against the workspace root (Pi write/edit often pass relative paths).
 * Mirrors a lightweight resolveToCwd so outside-workspace checks do not false-block `src/main.ts`.
 */
export function resolveAgainstWorkspace(path: string, workspace: string): string {
  const raw = path.trim();
  if (!raw) return raw;
  const slashPath = raw.replace(/\\/g, "/");
  if (isAbsolutePath(slashPath)) {
    return normalizePath(slashPath);
  }

  const root = workspace.replace(/\\/g, "/").replace(/\/+$/, "");
  // Windows "D:/foo" keeps "D:" as the first segment.
  const stack = root.match(/^[a-zA-Z]:/i)
    ? root.split("/").filter((segment, index) => index === 0 || segment.length > 0)
    : root.split("/").filter(Boolean);

  for (const segment of slashPath.split("/")) {
    if (!segment || segment === ".") continue;
    if (segment === "..") {
      if (stack.length > 1 || (stack.length === 1 && !/^[a-zA-Z]:$/i.test(stack[0] || ""))) {
        stack.pop();
      }
      continue;
    }
    stack.push(segment);
  }

  if (stack.length && /^[a-zA-Z]:$/i.test(stack[0])) {
    return normalizePath(`${stack[0]}/${stack.slice(1).join("/")}`);
  }
  if (root.startsWith("/")) {
    return normalizePath(`/${stack.join("/")}`);
  }
  return normalizePath(stack.join("/"));
}

function parentOfSlashPath(slashPath: string): { parent: string; base: string } | undefined {
  const clean = slashPath.replace(/\/+$/, "");
  if (clean === "" || /^[a-zA-Z]:$/i.test(clean) || /^\/\/[^/]+\/[^/]+$/.test(clean)) return undefined;
  const idx = clean.lastIndexOf("/");
  if (idx < 0) return undefined;
  if (idx === 0) return clean === "/" ? undefined : { parent: "/", base: clean.slice(1) };
  const head = clean.slice(0, idx);
  const parent = /^[a-zA-Z]:$/i.test(head) ? `${head}/` : head;
  return { parent, base: clean.slice(idx + 1) };
}

function resolveRealWithMissingTail(rawInput: string, hops = 0): string | undefined {
  if (hops > MAX_SYMLINK_HOPS) return undefined;
  const slashInput = rawInput.replace(/\\/g, "/");
  try {
    return normalizePath(realpathNative(slashInput));
  } catch {
    // Walk up to the nearest existing ancestor while preserving missing trailing segments.
  }

  const tailSegments: string[] = [];
  let cursor = slashInput;
  while (true) {
    // Detect dangling symlinks before stepping past them: existsSync/realpathSync fail with ENOENT,
    // but writing through a dangling symlink inside workspace would create a file outside workspace.
    try {
      const lstat = lstatSync(cursor);
      if (lstat.isSymbolicLink()) {
        const linkTarget = readlinkSync(cursor);
        const resolvedLink = resolveNodePath(dirname(cursor), linkTarget).replace(/\\/g, "/");
        const combined = tailSegments.length > 0 ? `${resolvedLink}/${tailSegments.join("/")}` : resolvedLink;
        return resolveRealWithMissingTail(combined, hops + 1);
      }
    } catch {
      // Missing path segment; keep climbing.
    }

    const split = parentOfSlashPath(cursor);
    if (split === undefined) return undefined;
    tailSegments.unshift(split.base);
    cursor = split.parent;
    try {
      const realAncestor = realpathNative(cursor);
      return resolveAgainstWorkspace(tailSegments.join("/"), realAncestor);
    } catch {
      // Continue climbing until an existing ancestor or root is reached.
    }
  }
}

export function insideWorkspace(path: string, workspace: string): boolean {
  const lexicalRoot = normalizePath(workspace);
  if (!lexicalRoot || !path.trim()) return false;

  const rawJoined = isAbsolutePath(path.trim())
    ? path.trim()
    : `${workspace.replace(/[\\/]+$/, "")}/${path.trim()}`;

  const realRoot = isAbsolutePath(workspace) ? resolveRealWithMissingTail(workspace) : undefined;
  const realCandidate = isAbsolutePath(rawJoined) ? resolveRealWithMissingTail(rawJoined) : undefined;
  if (realCandidate === undefined && isAbsolutePath(rawJoined)) {
    // Only return lexical fallback if no ancestor existed on disk (synthetic test drive),
    // whereas exceeding MAX_SYMLINK_HOPS fails closed.
    try {
      let probe = rawJoined.replace(/\\/g, "/");
      let depth = 0;
      while (depth <= MAX_SYMLINK_HOPS + 1) {
        const lstat = lstatSync(probe);
        if (!lstat.isSymbolicLink()) break;
        probe = resolveNodePath(dirname(probe), readlinkSync(probe)).replace(/\\/g, "/");
        depth += 1;
      }
      if (depth > MAX_SYMLINK_HOPS) return false;
    } catch {
      // Synthetic path not on disk.
    }
  }

  const root = realRoot ?? lexicalRoot;
  const candidate = realCandidate ?? resolveAgainstWorkspace(path, workspace);
  return candidate === root || candidate.startsWith(`${root}/`);
}

export function parseAllowPrefixes(raw: string | undefined | null): string[] {
  if (!raw) return [];
  return raw
    .split(/[\n,]/)
    .map((item) => item.trim())
    .filter(Boolean);
}

export function commandMatchesAllowPrefix(command: string, prefixes: string[]): boolean {
  const normalized = command.trim();
  if (!normalized || prefixes.length === 0) return false;
  const lower = normalized.toLowerCase();
  return prefixes.some((prefix) => {
    const needle = prefix.trim();
    if (!needle) return false;
    return lower === needle.toLowerCase() || lower.startsWith(`${needle.toLowerCase()} `) || lower.startsWith(`${needle.toLowerCase()}\t`);
  });
}

export function toolPatternMatches(toolName: string, pattern: string): boolean {
  const escaped = pattern.trim().toLowerCase().replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*");
  if (!escaped) return false;
  return new RegExp(`^${escaped}$`).test(toolName.toLowerCase());
}

export function parseToolRules(encoded: string | undefined | null): ToolPermissionRule[] {
  if (!encoded) return [];
  try {
    const value = JSON.parse(Buffer.from(encoded, "base64").toString("utf8"));
    if (!Array.isArray(value)) return [];
    return value.slice(0, 64).flatMap((item): ToolPermissionRule[] => {
      if (!item || typeof item !== "object") return [];
      const rule = item as Partial<ToolPermissionRule>;
      if (typeof rule.id !== "string" || typeof rule.toolPattern !== "string") return [];
      if (rule.action !== "allow" && rule.action !== "confirm" && rule.action !== "block") return [];
      return [{
        id: rule.id,
        enabled: rule.enabled !== false,
        toolPattern: rule.toolPattern.trim(),
        action: rule.action,
        commandPrefix: typeof rule.commandPrefix === "string" ? rule.commandPrefix.trim() : "",
        pathPrefix: typeof rule.pathPrefix === "string" ? rule.pathPrefix.trim() : "",
      }];
    });
  } catch {
    return [];
  }
}

export function matchingToolRule(options: {
  rules: PermissionRules;
  workspace: string;
  toolName: string;
  input: Record<string, unknown>;
}): ToolPermissionRule | null {
  const command = shellCommandFromInput(options.input);
  const target = pathFromToolInput(options.input);
  return (options.rules.toolRules ?? []).find((rule) => {
    if (!rule.enabled || !toolPatternMatches(options.toolName, rule.toolPattern)) return false;
    if (rule.commandPrefix && !commandMatchesAllowPrefix(command, [rule.commandPrefix])) return false;
    if (rule.pathPrefix) {
      if (!target) return false;
      const candidate = resolveAgainstWorkspace(target, options.workspace);
      const prefix = resolveAgainstWorkspace(rule.pathPrefix, options.workspace);
      if (candidate !== prefix && !candidate.startsWith(`${prefix}/`)) return false;
    }
    return true;
  }) ?? null;
}

export function pathFromToolInput(input: Record<string, unknown>): string | undefined {
  return pathsFromToolInput(input)[0];
}

export function pathsFromToolInput(input: Record<string, unknown>): string[] {
  const paths: string[] = [];
  for (const key of ["path", "file", "filePath", "target"]) {
    if (typeof input[key] === "string" && (input[key] as string).trim()) {
      paths.push((input[key] as string).trim());
    }
  }
  for (const key of ["paths", "files", "targets"]) {
    const values = input[key];
    if (!Array.isArray(values)) continue;
    for (const value of values) {
      if (typeof value === "string" && value.trim()) paths.push(value.trim());
    }
  }
  return [...new Set(paths)];
}

/**
 * True when a shell command runs a `git push` that can rewrite a remote branch:
 * `--force`, `--force-with-lease`, a short-flag cluster holding `f` (`-f`, `-uf`),
 * or a `+` refspec (`+main`, `+HEAD:main`). Each `;`, `&&`, `||`, `|` or line
 * break starts a new command, and git's own options may sit before `push`.
 */
export function isForcePush(command: string): boolean {
  for (const segment of command.split(/&&|\|\||[;|\n]/)) {
    const words = segment.trim().split(/\s+/).map((word) => word.replace(/^["']|["']$/g, ""));
    const git = words.findIndex((word) => /(^|[\\/])git(\.exe)?$/i.test(word));
    if (git < 0) continue;
    // `git -C dir push`, `git -c key=value push`, `git --no-pager push`.
    let index = git + 1;
    while (index < words.length && words[index].startsWith("-")) {
      index += words[index] === "-C" || words[index] === "-c" ? 2 : 1;
    }
    if (words[index] !== "push") continue;
    for (const word of words.slice(index + 1)) {
      if (/^--force(-with-lease)?(=|$)/.test(word)) return true;
      if (/^-[a-zA-Z]*f[a-zA-Z]*$/.test(word)) return true;
      if (/^\+[^\s]/.test(word)) return true;
    }
  }
  return false;
}

export function shellCommandFromInput(input: Record<string, unknown>): string {
  if (typeof input.command === "string") return input.command;
  try {
    return JSON.stringify(input);
  } catch {
    return String(input);
  }
}

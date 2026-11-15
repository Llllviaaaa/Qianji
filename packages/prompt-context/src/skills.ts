/**
 * Skill discovery, enablement state, and Settings RPC handlers for `@qianji/prompt-context`.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import type { Context } from "@deepseek-ai/cordis";
import {
  ErrorCode,
  type MemoryScope,
  type SkillCreateResult,
  type SkillInfo,
  type SkillListResult,
  type SkillReadResult,
  type SkillScope,
} from "@qianji/protocol";
import { RpcError } from "@qianji/rpc";

const MAX_SKILL_BYTES = 256 * 1024;

export interface Skill {
  name: string;
  description: string;
  path: string;
}

export interface ManagedSkillEntry {
  name: string;
  description: string;
  path: string;
  scope: SkillScope;
  enabled: boolean;
  readOnly?: boolean;
}

export interface SkillsConfig {
  dataDir: string;
  bundledSkillsDirs?: readonly string[] | (() => readonly string[]);
}

export function normalizeSkillPathKey(filePath: string): string {
  const abs = resolve(filePath).replace(/\\/g, "/");
  return process.platform === "win32" ? abs.toLowerCase() : abs;
}

export function resolveBundledSkillRoots(
  configured?: readonly string[] | (() => readonly string[]),
): string[] {
  const rawList = typeof configured === "function" ? configured() : configured ?? [];
  const candidates: string[] = [...rawList];
  const envDir = process.env.QIANJI_BUNDLED_SKILLS_DIR?.trim();
  if (envDir) candidates.push(envDir);

  const seen = new Set<string>();
  const resolved: string[] = [];
  for (const item of candidates) {
    if (!item || item.trim() === "") continue;
    const abs = resolve(item.trim());
    const key = normalizeSkillPathKey(abs);
    if (seen.has(key)) continue;
    seen.add(key);
    if (existsSync(abs)) {
      resolved.push(abs);
    }
  }
  return resolved;
}

export function skillsStatePath(dataDir: string): string {
  return join(dataDir, "skills.json");
}

export function readDisabledSkillKeys(dataDir: string): Set<string> {
  const file = skillsStatePath(dataDir);
  if (!existsSync(file)) return new Set();
  try {
    const parsed: unknown = JSON.parse(readFileSync(file, "utf8"));
    const disabled = (parsed as { disabled?: unknown } | null)?.disabled;
    if (!Array.isArray(disabled)) return new Set();
    return new Set(
      disabled
        .filter((item): item is string => typeof item === "string" && item.trim() !== "")
        .map((item) => normalizeSkillPathKey(item)),
    );
  } catch {
    return new Set();
  }
}

export function setSkillEnabledState(dataDir: string, skillPath: string, enabled: boolean): void {
  const file = skillsStatePath(dataDir);
  let rawDisabled: string[] = [];
  if (existsSync(file)) {
    try {
      const parsed: unknown = JSON.parse(readFileSync(file, "utf8"));
      const existing = (parsed as { disabled?: unknown } | null)?.disabled;
      if (Array.isArray(existing)) {
        rawDisabled = existing.filter((item): item is string => typeof item === "string" && item.trim() !== "");
      }
    } catch {
      rawDisabled = [];
    }
  }
  const targetKey = normalizeSkillPathKey(skillPath);
  const filtered = rawDisabled.filter((item) => normalizeSkillPathKey(item) !== targetKey);
  if (!enabled) {
    filtered.push(resolve(skillPath));
  }
  mkdirSync(dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(temp, `${JSON.stringify({ version: 1, disabled: filtered }, null, 2)}\n`, "utf8");
  renameSync(temp, file);
}

/** The `name` and `description` of a SKILL.md's front matter. */
export function readFrontMatter(text: string): Record<string, string> {
  const match = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text);
  const fields: Record<string, string> = {};
  for (const line of match?.[1]?.split(/\r?\n/) ?? []) {
    const field = /^([A-Za-z_-]+):\s*(.*)$/.exec(line);
    if (field?.[1] !== undefined && field[2] !== undefined) fields[field[1]] = field[2].replace(/^["']|["']$/g, "").trim();
  }
  return fields;
}

/** Skills under each dir; a later dir's skill replaces an earlier one of the same name. */
export function findSkills(dirs: readonly string[], options: { disabled?: ReadonlySet<string> } = {}): Skill[] {
  const skills = new Map<string, Skill>();
  for (const dir of dirs) {
    if (!existsSync(dir)) continue;
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const path = join(dir, entry.name, "SKILL.md");
      if (!existsSync(path)) continue;
      if (options.disabled?.has(normalizeSkillPathKey(path))) continue;
      const fields = readFrontMatter(readFileSync(path, "utf8"));
      const skillName = fields.name || entry.name;
      if (!fields.description) continue;
      skills.set(skillName, { name: skillName, description: fields.description, path });
    }
  }
  return [...skills.values()].sort((a, b) => a.name.localeCompare(b.name));
}

const SCOPE_RANK: Record<SkillScope, number> = {
  builtin: 0,
  user: 1,
  project: 2,
};

/** Discover all skills (enabled and disabled across builtin, user, and project tiers) for Settings management. */
export function discoverSkillEntries(
  dataDir: string,
  cwd?: string,
  bundledSkillsDirs?: readonly string[] | (() => readonly string[]),
): ManagedSkillEntry[] {
  const disabled = readDisabledSkillKeys(dataDir);
  const bundledRoots = resolveBundledSkillRoots(bundledSkillsDirs);
  const roots: Array<{ dir: string; scope: SkillScope; readOnly?: boolean }> = [
    ...bundledRoots.map((dir) => ({ dir, scope: "builtin" as const, readOnly: true })),
    { dir: join(dataDir, "skills"), scope: "user" },
  ];
  const trimmedCwd = cwd?.trim();
  if (trimmedCwd) {
    roots.push({ dir: join(trimmedCwd, ".qianji", "skills"), scope: "project" });
    roots.push({ dir: join(trimmedCwd, ".pid", "skills"), scope: "project" });
    roots.push({ dir: join(trimmedCwd, ".agents", "skills"), scope: "project" });
    roots.push({ dir: join(trimmedCwd, ".claude", "skills"), scope: "project" });
  }
  const seenPaths = new Set<string>();
  const list: ManagedSkillEntry[] = [];
  for (const { dir, scope, readOnly } of roots) {
    if (!existsSync(dir)) continue;
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const path = resolve(join(dir, entry.name, "SKILL.md"));
      if (!existsSync(path)) continue;
      const key = normalizeSkillPathKey(path);
      if (seenPaths.has(key)) continue;
      seenPaths.add(key);
      const fields = readFrontMatter(readFileSync(path, "utf8"));
      const skillName = fields.name || entry.name;
      list.push({
        name: skillName,
        description: fields.description ?? "",
        path,
        scope,
        enabled: !disabled.has(key),
        ...(readOnly ? { readOnly: true } : {}),
      });
    }
  }
  return list.sort((a, b) =>
    a.scope === b.scope ? a.name.localeCompare(b.name) : SCOPE_RANK[a.scope] - SCOPE_RANK[b.scope],
  );
}

/**
 * Ordered skill directories from lowest to highest precedence:
 * `builtin` (`bundled-skills`) < `user` (`~/.qianji/skills`) < `project` (`.claude` / `.agents` / `.pid` / `.qianji`).
 */
export function skillDirs(
  dataDir: string,
  cwd: string,
  bundledSkillsDirs?: readonly string[] | (() => readonly string[]),
): string[] {
  const bundled = resolveBundledSkillRoots(bundledSkillsDirs);
  return [
    ...bundled,
    join(dataDir, "skills"),
    join(cwd, ".claude", "skills"),
    join(cwd, ".agents", "skills"),
    join(cwd, ".pid", "skills"),
    join(cwd, ".qianji", "skills"),
  ];
}

type RpcParams = Record<string, unknown>;

function recordOf(raw: unknown): RpcParams {
  if (raw === undefined || raw === null) return {};
  if (typeof raw !== "object" || Array.isArray(raw)) {
    throw new RpcError(ErrorCode.InvalidParams, "params must be an object");
  }
  return raw as RpcParams;
}

function optionalCwd(p: RpcParams): string | undefined {
  if (p.cwd === undefined || p.cwd === "") return undefined;
  if (typeof p.cwd !== "string") throw new RpcError(ErrorCode.InvalidParams, "cwd must be a string");
  const trimmed = p.cwd.trim();
  if (trimmed === "") return undefined;
  if (!isAbsolute(trimmed)) throw new RpcError(ErrorCode.InvalidParams, "cwd must be an absolute path");
  return resolve(trimmed);
}

function requiredExistingCwd(p: RpcParams): string {
  const cwd = optionalCwd(p);
  if (cwd === undefined || !existsSync(cwd) || !statSync(cwd).isDirectory()) {
    throw new RpcError(ErrorCode.InvalidParams, "需要打开有效的工作区目录才能操作当前项目配置");
  }
  return cwd;
}

function scopeOf(p: RpcParams): MemoryScope {
  if (p.scope === undefined || p.scope === "user") return "user";
  if (p.scope === "project") return "project";
  throw new RpcError(ErrorCode.InvalidParams, "scope must be 'user' or 'project'");
}

function allowedSkillRoots(
  dataDir: string,
  cwd: string | undefined,
  bundledRoots: readonly string[],
): Array<{ root: string; readOnly: boolean }> {
  const roots: Array<{ root: string; readOnly: boolean }> = [
    ...bundledRoots.map((dir) => ({ root: resolve(dir), readOnly: true })),
    { root: resolve(join(dataDir, "skills")), readOnly: false },
  ];
  if (cwd !== undefined) {
    roots.push({ root: resolve(join(cwd, ".qianji", "skills")), readOnly: false });
    roots.push({ root: resolve(join(cwd, ".pid", "skills")), readOnly: false });
    roots.push({ root: resolve(join(cwd, ".agents", "skills")), readOnly: false });
    roots.push({ root: resolve(join(cwd, ".claude", "skills")), readOnly: false });
  }
  return roots;
}

function resolveAllowedSkillFile(
  dataDir: string,
  cwd: string | undefined,
  rawPath: unknown,
  bundledRoots: readonly string[],
  options: { requireWritable?: boolean } = {},
): string {
  if (typeof rawPath !== "string" || rawPath.trim() === "") {
    throw new RpcError(ErrorCode.InvalidParams, "path must be a non-empty string");
  }
  const resolved = resolve(rawPath.trim());
  if (basename(resolved) !== "SKILL.md") {
    throw new RpcError(ErrorCode.InvalidParams, "技能文件路径必须指向 SKILL.md");
  }
  const fileKey = normalizeSkillPathKey(resolved);
  for (const { root, readOnly } of allowedSkillRoots(dataDir, cwd, bundledRoots)) {
    const rootPrefix = `${normalizeSkillPathKey(root)}/`;
    if (!fileKey.startsWith(rootPrefix)) continue;
    const rel = relative(root, resolved);
    const parts = rel.split(sep).filter(Boolean);
    if (parts.length === 2 && parts[1] === "SKILL.md" && parts[0] !== "." && parts[0] !== "..") {
      if (options.requireWritable && readOnly) {
        throw new RpcError(
          ErrorCode.InvalidParams,
          "内置技能为只读资源，不支持直接覆盖或删除；如需定制请在用户或项目目录创建同名技能覆盖。",
        );
      }
      return resolved;
    }
  }
  throw new RpcError(ErrorCode.InvalidParams, "不允许访问技能目录之外的路径");
}

function slugifySkillName(raw: string): string {
  return raw
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64);
}

function listSkills(
  dataDir: string,
  cwd: string | undefined,
  bundledSkillsDirs?: readonly string[] | (() => readonly string[]),
): SkillInfo[] {
  return discoverSkillEntries(dataDir, cwd, bundledSkillsDirs).map((entry) => ({
    ...entry,
    trusted: true,
  }));
}

function buildSkillMarkdown(skillName: string, description: string, body?: string): string {
  const cleanName = skillName.trim();
  const cleanDesc = description.trim().replace(/\r?\n/g, " ");
  const trimmedBody = body?.trim();
  const contentBody = trimmedBody && trimmedBody !== ""
    ? trimmedBody
    : [
        `# ${cleanName}`,
        "",
        "## 适用场景",
        cleanDesc,
        "",
        "## 执行步骤",
        "1. 先使用 `read` / `grep` 了解相关代码上下文。",
        "2. 按最小改动原则完成修改并补充测试。",
        "3. 运行测试确认通过后汇报结果。",
      ].join("\n");
  return `---\nname: ${cleanName}\ndescription: ${JSON.stringify(cleanDesc)}\n---\n\n${contentBody}\n`;
}

function writeFileAtomically(file: string, content: string): void {
  mkdirSync(dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(temp, content, "utf8");
  renameSync(temp, file);
}

export function registerSkillRpc(rpcCtx: Context, pluginName: string, config: SkillsConfig): void {
  const { dataDir } = config;
  const getBundledRoots = () => resolveBundledSkillRoots(config.bundledSkillsDirs);
  const notifyCommands = () => {
    rpcCtx.get("commands")?.notifyChanged("skills");
  };
  const methods: Record<string, (raw: unknown) => unknown> = {
    "skill.list": (raw): SkillListResult => {
      const p = recordOf(raw);
      return { skills: listSkills(dataDir, optionalCwd(p), config.bundledSkillsDirs) };
    },
    "skill.read": (raw): SkillReadResult => {
      const p = recordOf(raw);
      const file = resolveAllowedSkillFile(dataDir, optionalCwd(p), p.path, getBundledRoots());
      if (!existsSync(file)) throw new RpcError(ErrorCode.InvalidParams, `找不到技能文件：${file}`);
      const content = readFileSync(file, "utf8");
      const fields = readFrontMatter(content);
      return { path: file, content, name: fields.name || basename(dirname(file)), description: fields.description ?? "" };
    },
    "skill.create": (raw): SkillCreateResult => {
      const p = recordOf(raw);
      const scope = scopeOf(p);
      const rawName = typeof p.name === "string" ? p.name.trim() : "";
      const rawDesc = typeof p.description === "string" ? p.description.trim() : "";
      if (rawName === "") throw new RpcError(ErrorCode.InvalidParams, "请填写技能标识名称（如 fix-ci）");
      const slug = slugifySkillName(rawName);
      if (slug === "" || !/^[a-z0-9][a-z0-9._-]*$/.test(slug)) {
        throw new RpcError(ErrorCode.InvalidParams, "技能标识只能包含英文字母、数字、点、下划线和连字符");
      }
      if (rawDesc === "") throw new RpcError(ErrorCode.InvalidParams, "请填写技能触发描述（description）");
      const cwd = scope === "project" ? requiredExistingCwd(p) : optionalCwd(p);
      const rootDir = scope === "project" && cwd !== undefined ? join(cwd, ".qianji", "skills") : join(dataDir, "skills");
      const skillFile = resolve(join(rootDir, slug, "SKILL.md"));
      if (existsSync(skillFile)) throw new RpcError(ErrorCode.InvalidParams, `技能 ${slug} 已存在`);
      const content = buildSkillMarkdown(slug, rawDesc, typeof p.body === "string" ? p.body : undefined);
      writeFileAtomically(skillFile, content);
      setSkillEnabledState(dataDir, skillFile, true);
      notifyCommands();
      return {
        skill: { name: slug, description: rawDesc, path: skillFile, scope, enabled: true, trusted: true },
        content,
      };
    },
    "skill.save": (raw): SkillListResult => {
      const p = recordOf(raw);
      const cwd = optionalCwd(p);
      const file = resolveAllowedSkillFile(dataDir, cwd, p.path, getBundledRoots(), { requireWritable: true });
      if (typeof p.content !== "string") throw new RpcError(ErrorCode.InvalidParams, "content must be a string");
      if (Buffer.byteLength(p.content, "utf8") > MAX_SKILL_BYTES) {
        throw new RpcError(ErrorCode.InvalidParams, "SKILL.md 内容不能超过 256 KB");
      }
      const fields = readFrontMatter(p.content);
      if (!fields.description || fields.description.trim() === "") {
        throw new RpcError(ErrorCode.InvalidParams, "SKILL.md 顶部 Frontmatter 必须包含非空的 description 字段");
      }
      writeFileAtomically(file, p.content);
      notifyCommands();
      return { skills: listSkills(dataDir, cwd, config.bundledSkillsDirs) };
    },
    "skill.toggle": (raw): SkillListResult => {
      const p = recordOf(raw);
      const cwd = optionalCwd(p);
      const file = resolveAllowedSkillFile(dataDir, cwd, p.path, getBundledRoots());
      if (typeof p.enabled !== "boolean") throw new RpcError(ErrorCode.InvalidParams, "enabled must be a boolean");
      setSkillEnabledState(dataDir, file, p.enabled);
      notifyCommands();
      return { skills: listSkills(dataDir, cwd, config.bundledSkillsDirs) };
    },
    "skill.delete": (raw): SkillListResult => {
      const p = recordOf(raw);
      const cwd = optionalCwd(p);
      const file = resolveAllowedSkillFile(dataDir, cwd, p.path, getBundledRoots(), { requireWritable: true });
      rmSync(dirname(file), { recursive: true, force: true });
      setSkillEnabledState(dataDir, file, true);
      notifyCommands();
      return { skills: listSkills(dataDir, cwd, config.bundledSkillsDirs) };
    },
  };

  for (const [method, handler] of Object.entries(methods)) {
    rpcCtx.effect(() => rpcCtx.rpc.method(method, handler), `${pluginName}: ${method}`);
  }
}

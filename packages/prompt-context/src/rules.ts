/**
 * Rule discovery (`.qianji/rules`, `.claude/rules`, `.agents/rules`, `.cursor/rules`,
 * and `~/.qianji/rules`), static prompt rendering, and on-demand `tools/execute`
 * activation for glob rules and nested subdirectory context files.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import type { Context } from "@deepseek-ai/cordis";
import "@qianji/tools";
import {
  expandContextImports,
  findProjectBoundary,
  isExistingDirectory,
  nestedContextFiles,
  normalizeComparePath,
} from "./context-files.ts";
import { matchesRuleGlobs, parseRuleFile, type RuleMode } from "./rule-parser.ts";

export {
  globToRegExp,
  matchesRuleGlobs,
  parseRuleFile,
  type ParsedRuleFile,
  type RuleMode,
} from "./rule-parser.ts";

export interface ProjectRule {
  id: string;
  path: string;
  scope: "user" | "project";
  baseDir: string;
  boundaryDir: string;
  mode: RuleMode;
  globs: string[];
  description: string;
  body: string;
}

const MAX_RULE_BYTES = 128 * 1024;
const TRACKED_SESSIONS = 500;
const FILE_TOOLS = new Set(["read", "write", "edit", "ls", "find", "grep", "diagnostics"]);

const PROJECT_RULE_DIRS = [
  [".cursor", "rules"],
  [".claude", "rules"],
  [".agents", "rules"],
  [".qianji", "rules"],
] as const;

function walkRuleFiles(rootDir: string, prefix = ""): Array<{ rel: string; full: string }> {
  if (!isExistingDirectory(rootDir)) return [];
  const entries = readdirSync(rootDir, { withFileTypes: true });
  const results: Array<{ rel: string; full: string }> = [];

  for (const entry of entries) {
    if (entry.name.startsWith(".") || entry.name === "node_modules") continue;
    const full = join(rootDir, entry.name);
    const rel = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
    if (entry.isDirectory()) {
      results.push(...walkRuleFiles(full, rel));
    } else if (entry.isFile() && /\.(?:md|mdc)$/i.test(entry.name)) {
      results.push({ rel, full });
    }
  }

  results.sort((a, b) => a.rel.localeCompare(b.rel));
  return results;
}

function collectRulesFromDir(
  rulesDir: string,
  meta: { idPrefix: string; scope: "user" | "project"; baseDir: string; boundaryDir: string },
  target: Map<string, ProjectRule>,
): void {
  for (const { rel, full } of walkRuleFiles(rulesDir)) {
    let size: number;
    try {
      size = statSync(full).size;
    } catch {
      continue;
    }
    if (size > MAX_RULE_BYTES) continue;

    let rawText: string;
    try {
      rawText = readFileSync(full, "utf8");
    } catch {
      continue;
    }

    const parsed = parseRuleFile(rawText, full);
    if (parsed.body === "") continue;

    const stem = rel.replace(/\.(?:md|mdc)$/i, "");
    const id = `${meta.idPrefix}:${stem}`;
    target.set(id, {
      id,
      path: full,
      scope: meta.scope,
      baseDir: meta.baseDir,
      boundaryDir: meta.boundaryDir,
      mode: parsed.mode,
      globs: parsed.globs,
      description: parsed.description,
      body: parsed.body,
    });
  }
}

/**
 * Discover user (`<dataDir>/rules`) and project (`.cursor`, `.claude`, `.agents`,
 * `.qianji` rules along `findProjectBoundary(cwd) -> cwd`) rule files.
 */
export function discoverRules(dataDir: string, cwd: string): ProjectRule[] {
  const resolvedCwd = resolve(cwd);
  const boundary = findProjectBoundary(resolvedCwd);
  const rules = new Map<string, ProjectRule>();

  collectRulesFromDir(
    join(dataDir, "rules"),
    {
      idPrefix: "user",
      scope: "user",
      baseDir: resolvedCwd,
      boundaryDir: dataDir,
    },
    rules,
  );

  const dirs: string[] = [];
  let cur = resolvedCwd;
  const boundaryKey = normalizeComparePath(boundary);
  for (;;) {
    dirs.unshift(cur);
    if (normalizeComparePath(cur) === boundaryKey) break;
    const parent = dirname(cur);
    if (parent === cur) break;
    cur = parent;
  }

  for (const dir of dirs) {
    const dirKey = normalizeComparePath(dir);
    for (const parts of PROJECT_RULE_DIRS) {
      collectRulesFromDir(
        join(dir, ...parts),
        {
          idPrefix: `project:${dirKey}`,
          scope: "project",
          baseDir: dir,
          boundaryDir: boundary,
        },
        rules,
      );
    }
  }

  return [...rules.values()];
}

export function renderAlwaysRules(rules: readonly ProjectRule[], dataDir: string): string[] {
  return rules
    .filter((rule) => rule.mode === "always")
    .map((rule) => {
      const expanded = expandContextImports(rule.body, rule.path, {
        dataDir,
        boundaryDir: rule.boundaryDir,
      });
      return `<rule-file path="${rule.path}">\n${expanded}\n</rule-file>`;
    });
}

export function renderScopedRulesIndex(rules: readonly ProjectRule[]): string | undefined {
  const scoped = rules.filter((rule) => rule.mode === "glob" || rule.mode === "manual");
  if (scoped.length === 0) return undefined;
  return [
    "Scoped project rules (matching rules auto-load when reading/editing files; use `read` before creating new files matching a rule):",
    "<scoped-rules>",
    ...scoped.map((rule) =>
      rule.mode === "glob" && rule.globs.length > 0
        ? `<rule path="${rule.path}" globs="${rule.globs.join(", ")}">${rule.description}</rule>`
        : `<rule path="${rule.path}">${rule.description}</rule>`,
    ),
    "</scoped-rules>",
  ].join("\n");
}

function getOrCreateSessionSet(map: Map<string, Set<string>>, sessionId: string): Set<string> {
  const existing = map.get(sessionId);
  if (existing !== undefined) {
    map.delete(sessionId);
    map.set(sessionId, existing);
    return existing;
  }
  const created = new Set<string>();
  map.set(sessionId, created);
  if (map.size > TRACKED_SESSIONS) {
    const oldest = map.keys().next().value;
    if (oldest !== undefined) map.delete(oldest);
  }
  return created;
}

/**
 * Dynamically append matching `glob` rules and nested subdirectory `AGENTS.md`
 * files onto file tool outputs once per session without mutating the static
 * system prompt cache prefix.
 */
export function registerScopedRuleInjector(
  ctx: Context,
  config: { dataDir: string; contextFiles?: boolean },
): void {
  const seenBySession = new Map<string, Set<string>>();

  const forgetSession = (sessionId: string): void => {
    seenBySession.delete(sessionId);
  };
  ctx.on("session/deleted" as never, forgetSession as never);
  ctx.on("session/unloaded" as never, forgetSession as never);

  ctx.on("tools/execute", async (call, env, next) => {
    const output = await next();
    if (config.contextFiles === false || output.isError === true || !FILE_TOOLS.has(call.name)) {
      return output;
    }

    const rawPath = typeof call.args.path === "string" ? call.args.path.trim() : "";
    if (rawPath === "") return output;

    const absTarget = resolve(env.cwd, rawPath);
    const seen = getOrCreateSessionSet(seenBySession, env.sessionId);
    const boundaryDir = findProjectBoundary(env.cwd);
    const blocks: string[] = [];

    for (const file of nestedContextFiles(env.cwd, absTarget)) {
      const key = `ctx:${normalizeComparePath(file)}`;
      if (seen.has(key)) continue;
      seen.add(key);
      let raw: string;
      try {
        raw = readFileSync(file, "utf8").trim();
      } catch {
        continue;
      }
      if (raw === "") continue;
      const expanded = expandContextImports(raw, file, {
        dataDir: config.dataDir,
        boundaryDir,
      });
      blocks.push(`<context-file path="${file}">\n${expanded}\n</context-file>`);
    }

    const rules = discoverRules(config.dataDir, env.cwd).filter((rule) => rule.mode === "glob");
    for (const rule of rules) {
      const rel = relative(rule.baseDir, absTarget).replace(/\\/g, "/");
      if (rel === "" || rel.startsWith("..") || isAbsolute(rel)) continue;
      if (!matchesRuleGlobs(rel, rule.globs)) continue;
      const key = `rule:${normalizeComparePath(rule.path)}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const expanded = expandContextImports(rule.body, rule.path, {
        dataDir: config.dataDir,
        boundaryDir: rule.boundaryDir,
      });
      blocks.push(`<rule-file path="${rule.path}" globs="${rule.globs.join(", ")}">\n${expanded}\n</rule-file>`);
    }

    if (blocks.length === 0) return output;

    return {
      ...output,
      content: [
        ...output.content,
        {
          type: "text",
          text: [
            "<project-rules-activated>",
            "Follow these path-specific instructions for the paths accessed:",
            ...blocks,
            "</project-rules-activated>",
          ].join("\n\n"),
        },
      ],
    };
  });
}

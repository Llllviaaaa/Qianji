/**
 * The built-in system prompt sections: who the agent is, how it works,
 * the project's context files (AGENTS.md, else CLAUDE.md, plus .local overrides
 * and safe @path imports), path-scoped rules, available skills
 * (`<dir>/<skill>/SKILL.md`), `/init`, and the environment.
 */
import type { Context } from "@deepseek-ai/cordis";
import type { CommandDefinition } from "@qianji/commands";
import "@qianji/protocol";
import "@qianji/rpc";
import { SectionOrder, type PromptEnv } from "@qianji/system-prompt";
import { getCachedContextBlocks, pinSessionDate } from "./cache.ts";
import { createInitCommand } from "./init-command.ts";
import {
  discoverRules,
  registerScopedRuleInjector,
  renderAlwaysRules,
  renderScopedRulesIndex,
} from "./rules.ts";
import { findSkills, readDisabledSkillKeys, registerSkillRpc, skillDirs, type PluginSkillSource } from "./skills.ts";

export {
  clearPromptContextCaches,
  getCacheStats,
  getCachedContextBlocks,
  isSnapshotValid,
  MAX_PINNED_SESSIONS,
  pinSessionDate,
  takeSnapshots,
  type CacheBucketName,
  type CacheStats,
  type PathSnapshot,
} from "./cache.ts";

export {
  contextFiles,
  expandContextImports,
  findProjectBoundary,
  isPathInside,
  LOCAL_CONTEXT_FILES,
  MAX_IMPORT_BYTES,
  MAX_IMPORT_DEPTH,
  nestedContextFiles,
  SHARED_CONTEXT_FILES,
  type ExpandImportsOptions,
} from "./context-files.ts";
export { createInitCommand } from "./init-command.ts";
export {
  discoverRules,
  globToRegExp,
  matchesRuleGlobs,
  parseRuleFile,
  registerScopedRuleInjector,
  renderAlwaysRules,
  renderScopedRulesIndex,
  type ParsedRuleFile,
  type ProjectRule,
  type RuleMode,
} from "./rules.ts";
export {
  discoverSkillEntries,
  findSkills,
  normalizeSkillPathKey,
  readDisabledSkillKeys,
  readFrontMatter,
  resolveBundledSkillRoots,
  setSkillEnabledState,
  skillDirs,
  skillsStatePath,
  type ManagedSkillEntry,
  type PluginSkillSource,
  type Skill,
} from "./skills.ts";

export const name = "qianji-prompt-context";
export const inject = ["systemPrompt"];

export interface Config {
  /** The user's data directory (`~/.qianji`): its AGENTS.md, rules/, and skills/ apply everywhere. */
  dataDir: string;
  /** Optional read-only built-in skill directories (`resources/harness/bundled-skills` or repo `skills/`). */
  bundledSkillsDirs?: readonly string[] | (() => readonly string[]);
  /** Optional read-only companion skill directories contributed by enabled plugins. */
  pluginSkills?: (cwd?: string) => readonly PluginSkillSource[];
  /** Override for "today", for tests. */
  now?: () => Date;
  /** Include AGENTS.md / CLAUDE.md, .local overrides, and rules/. Default true. */
  contextFiles?: boolean;
  /** The user's own instructions (personality, custom instructions), after the guidelines. */
  instructions?: string;
}

export const IDENTITY = `You are a coding agent running in Qianji (千机) on the user's computer. You help with software tasks by reading and changing files and running commands with the tools you are given.`;

export const GUIDELINES = `Guidelines:
- Work through the user's request end-to-end until the task is complete and verified; do not stop mid-task unless blocked by missing information, a permission denial, or an unrecoverable error.
- Act with tools instead of announcing what you plan to inspect, edit, or run next — never end a turn saying what you will do next when you can invoke the tool immediately.
- For multi-step work, track progress with update_plan when available and keep working until every step is completed.
- Read the relevant code before changing it; prefer small, focused edits with the edit tool over rewriting files, and use find, grep and ls to explore instead of guessing paths.
- Run the project's tests, typecheck, or build after changes when you can, fix issues your changes introduced, and report any remaining failures honestly.
- When the task is done, reply with a concise summary of what changed.`;

export function apply(ctx: Context, config: Config): void {
  const now = config.now ?? (() => new Date());
  const pinnedDates = new Map<string, string>();
  ctx.on("session/deleted" as never, ((sessionId: string) => {
    pinnedDates.delete(sessionId);
  }) as never);

  ctx.effect(() => ctx.systemPrompt.section("identity", () => IDENTITY, { order: SectionOrder.identity }), `${name}: identity`);
  ctx.effect(() => ctx.systemPrompt.section("guidelines", () => GUIDELINES, { order: SectionOrder.guidelines }), `${name}: guidelines`);

  const instructions = config.instructions?.trim();
  if (instructions) {
    ctx.effect(() => ctx.systemPrompt.section("instructions", () => `The user's instructions:\n${instructions}`, { order: SectionOrder.guidelines + 50 }), `${name}: instructions`);
  }

  ctx.effect(() => ctx.systemPrompt.section("context-files", ({ cwd }: PromptEnv) => {
    if (config.contextFiles === false) return undefined;
    const contextBlocks = getCachedContextBlocks(config.dataDir, cwd);
    const alwaysRuleBlocks = renderAlwaysRules(discoverRules(config.dataDir, cwd), config.dataDir);
    if (contextBlocks.length === 0 && alwaysRuleBlocks.length === 0) return undefined;

    return [
      "Project instructions from context files. Follow them; more specific (deeper) files and .local overrides win over general ones.",
      ...contextBlocks,
      ...alwaysRuleBlocks,
    ].join("\n\n");
  }, { order: SectionOrder.contextFiles }), `${name}: context-files`);

  ctx.effect(() => ctx.systemPrompt.section("scoped-rules", ({ cwd }: PromptEnv) => {
    if (config.contextFiles === false) return undefined;
    return renderScopedRulesIndex(discoverRules(config.dataDir, cwd));
  }, { order: SectionOrder.contextFiles + 20 }), `${name}: scoped-rules`);

  ctx.effect(() => ctx.systemPrompt.section("skills", ({ cwd, tools }: PromptEnv) => {
    if (!tools.some((tool) => tool.name === "read")) return undefined;
    const disabled = readDisabledSkillKeys(config.dataDir);
    const skills = findSkills(skillDirs(config.dataDir, cwd, config.bundledSkillsDirs, config.pluginSkills), { disabled });
    if (skills.length === 0) return undefined;
    return [
      "Skills are instructions for specific tasks. When a task matches a skill's description, read its SKILL.md with the read tool before starting and follow it.",
      "<skills>",
      ...skills.map((skill) => `<skill name="${skill.name}" path="${skill.path}">${skill.description}</skill>`),
      "</skills>",
    ].join("\n");
  }, { order: SectionOrder.skills }), `${name}: skills`);

  ctx.effect(() => ctx.systemPrompt.section("environment", ({ sessionId, cwd }: PromptEnv) => [
    "Environment:",
    `- Working directory: ${cwd}`,
    `- Platform: ${process.platform}`,
    `- Date: ${pinSessionDate(sessionId, now, pinnedDates)}`,
  ].join("\n"), { order: SectionOrder.environment }), `${name}: environment`);

  ctx.inject(["tools"], (toolsCtx) => {
    registerScopedRuleInjector(toolsCtx, config);
  });

  ctx.inject(["commands"], (inner) => {
    inner.effect(() => inner.commands.register(createInitCommand()), `${name}: /init`);
    inner.effect(() => inner.commands.registerProvider((cwd) => {
      const targetCwd = cwd && cwd.trim() !== "" ? cwd : process.cwd();
      const disabled = readDisabledSkillKeys(config.dataDir);
      return findSkills(skillDirs(config.dataDir, targetCwd, config.bundledSkillsDirs, config.pluginSkills), { disabled }).map((skill): CommandDefinition => ({
        name: `skill:${skill.name}`,
        description: skill.description,
        argsHint: "[任务说明]",
        source: "skill",
        execute(rawArgs) {
          const suffix = rawArgs.trim() ? `\n\n用户任务：${rawArgs.trim()}` : "";
          return {
            prompt: `请先使用 \`read\` 工具阅读技能说明文件 \`${skill.path}\`（技能：${skill.name}），并严格遵循该技能的步骤完成工作。${suffix}`,
          };
        },
      }));
    }), `${name}: skill commands`);
  });

  ctx.inject(["rpc"], (rpcCtx) => {
    registerSkillRpc(rpcCtx, name, config);
  });
}

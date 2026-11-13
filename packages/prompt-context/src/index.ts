/**
 * The built-in system prompt sections: who the agent is, how it works,
 * the project's context files (AGENTS.md, else CLAUDE.md), the available
 * skills (`<dir>/<skill>/SKILL.md`) and the environment.
 */
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, parse, resolve } from "node:path";
import type { Context } from "@deepseek-ai/cordis";
import type { CommandDefinition } from "@qianji/commands";
import "@qianji/protocol";
import "@qianji/rpc";
import { SectionOrder, type PromptEnv } from "@qianji/system-prompt";
import { findSkills, readDisabledSkillKeys, registerSkillRpc, skillDirs } from "./skills.ts";

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
  type Skill,
} from "./skills.ts";

export const name = "qianji-prompt-context";
export const inject = ["systemPrompt"];

export interface Config {
  /** The user's data directory (`~/.qianji`): its AGENTS.md and skills/ apply everywhere. */
  dataDir: string;
  /** Optional read-only built-in skill directories (`resources/harness/bundled-skills` or repo `skills/`). */
  bundledSkillsDirs?: readonly string[] | (() => readonly string[]);
  /** Override for "today", for tests. */
  now?: () => Date;
  /** Include AGENTS.md / CLAUDE.md. Default true. */
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

const CONTEXT_FILES = ["AGENTS.md", "CLAUDE.md"];

/** The context files that apply in `cwd`: global first, then from the root down. One per directory. */
export function contextFiles(dataDir: string, cwd: string): string[] {
  const files: string[] = [];
  const global = join(dataDir, "AGENTS.md");
  if (existsSync(global)) files.push(global);
  const dirs: string[] = [];
  let dir = resolve(cwd);
  const root = parse(dir).root;
  for (;;) {
    dirs.unshift(dir);
    if (dir === root) break;
    dir = dirname(dir);
  }
  for (const each of dirs) {
    const found = CONTEXT_FILES.map((file) => join(each, file)).find((file) => existsSync(file));
    if (found !== undefined && found !== global) files.push(found);
  }
  return files;
}

export function apply(ctx: Context, config: Config): void {
  const now = config.now ?? (() => new Date());

  ctx.effect(() => ctx.systemPrompt.section("identity", () => IDENTITY, { order: SectionOrder.identity }), `${name}: identity`);
  ctx.effect(() => ctx.systemPrompt.section("guidelines", () => GUIDELINES, { order: SectionOrder.guidelines }), `${name}: guidelines`);

  const instructions = config.instructions?.trim();
  if (instructions) {
    ctx.effect(() => ctx.systemPrompt.section("instructions", () => `The user's instructions:\n${instructions}`, { order: SectionOrder.guidelines + 50 }), `${name}: instructions`);
  }

  ctx.effect(() => ctx.systemPrompt.section("context-files", ({ cwd }: PromptEnv) => {
    if (config.contextFiles === false) return undefined;
    const files = contextFiles(config.dataDir, cwd);
    if (files.length === 0) return undefined;
    return [
      "Project instructions from context files. Follow them; more specific (deeper) files win over general ones.",
      ...files.map((file) => `<context-file path="${file}">\n${readFileSync(file, "utf8").trim()}\n</context-file>`),
    ].join("\n\n");
  }, { order: SectionOrder.contextFiles }), `${name}: context-files`);

  ctx.effect(() => ctx.systemPrompt.section("skills", ({ cwd, tools }: PromptEnv) => {
    if (!tools.some((tool) => tool.name === "read")) return undefined;
    const disabled = readDisabledSkillKeys(config.dataDir);
    const skills = findSkills(skillDirs(config.dataDir, cwd, config.bundledSkillsDirs), { disabled });
    if (skills.length === 0) return undefined;
    return [
      "Skills are instructions for specific tasks. When a task matches a skill's description, read its SKILL.md with the read tool before starting and follow it.",
      "<skills>",
      ...skills.map((skill) => `<skill name="${skill.name}" path="${skill.path}">${skill.description}</skill>`),
      "</skills>",
    ].join("\n");
  }, { order: SectionOrder.skills }), `${name}: skills`);

  ctx.effect(() => ctx.systemPrompt.section("environment", ({ cwd }: PromptEnv) => [
    "Environment:",
    `- Working directory: ${cwd}`,
    `- Platform: ${process.platform}`,
    `- Date: ${now().toISOString().slice(0, 10)}`,
  ].join("\n"), { order: SectionOrder.environment }), `${name}: environment`);

  ctx.inject(["commands"], (inner) => {
    inner.effect(() => inner.commands.registerProvider((cwd) => {
      const targetCwd = cwd && cwd.trim() !== "" ? cwd : process.cwd();
      const disabled = readDisabledSkillKeys(config.dataDir);
      return findSkills(skillDirs(config.dataDir, targetCwd, config.bundledSkillsDirs), { disabled }).map((skill): CommandDefinition => ({
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

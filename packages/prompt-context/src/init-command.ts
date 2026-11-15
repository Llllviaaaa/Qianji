/**
 * Built-in `/init` slash command: inspects the workspace manifests and existing
 * rule files, then generates a prompt instructing the agent to create or update
 * `<cwd>/AGENTS.md`.
 */
import { existsSync } from "node:fs";
import { join } from "node:path";
import type { CommandDefinition } from "@qianji/commands";
import { isExistingDirectory, isExistingFile } from "./context-files.ts";

const MANIFEST_CANDIDATES = [
  "package.json",
  "Cargo.toml",
  "pyproject.toml",
  "go.mod",
  "Makefile",
  "justfile",
  "README.md",
] as const;

const EXISTING_RULE_ARTIFACTS = [
  ".cursorrules",
  ".windsurfrules",
  ".github/copilot-instructions.md",
  ".cursor/rules",
  ".claude/rules",
  ".agents/rules",
  ".qianji/rules",
] as const;

export function createInitCommand(): CommandDefinition {
  return {
    name: "init",
    description: "分析当前工作区架构与脚本，生成或更新 AGENTS.md 项目规范",
    argsHint: "[补充要求]",
    source: "builtin",
    execute(rawArgs, env) {
      const cwd = env.cwd?.trim() ?? "";
      if (cwd === "" || !isExistingDirectory(cwd)) {
        return {
          output: "请先打开一个有效的工作区目录后再运行 `/init`。",
          isError: true,
        };
      }

      const agentsPath = join(cwd, "AGENTS.md");
      const claudePath = join(cwd, "CLAUDE.md");
      const hasAgents = isExistingFile(agentsPath);
      const hasClaude = isExistingFile(claudePath);

      const detectedManifests = MANIFEST_CANDIDATES.filter((name) => isExistingFile(join(cwd, name)));
      const detectedRules = EXISTING_RULE_ARTIFACTS.filter((rel) => existsSync(join(cwd, rel)));

      const lines: string[] = [
        `目标工作区：\`${cwd}\``,
      ];

      if (detectedManifests.length > 0) {
        lines.push(`已探测到的项目清单与构建入口：${detectedManifests.map((m) => `\`${m}\``).join("、")}`);
      }
      if (detectedRules.length > 0) {
        lines.push(`已探测到的现有规则/指令文件或目录：${detectedRules.map((r) => `\`${r}\``).join("、")}`);
      }

      if (hasAgents || hasClaude) {
        const existingName = hasAgents ? "AGENTS.md" : "CLAUDE.md";
        lines.push(
          "",
          `当前工作区已存在 \`${existingName}\`。请按以下步骤审查并增量更新项目规范：`,
          `1. 先使用 \`read\` 阅读现有的 \`${existingName}\`（以及上述探测到的项目清单、脚本与目录结构）。`,
          "2. 核对其中记录的目录边界、技术栈、构建/测试/Lint/类型检查命令及单个测试命令是否与最新代码一致，补充缺失的关键工程红线与约定。",
          hasAgents
            ? "3. 优先使用 `edit` 在保留现有有效规则的前提下精准修正过期信息或补充缺口，避免无故重写整份文件。"
            : "3. 若用户希望迁移或同时保留标准规范，可参考现有 `CLAUDE.md` 补全或生成 `AGENTS.md`（或用 `edit` 增量完善现有规范）。",
          "4. 确保内容精炼：可将大块参考文档拆入 `@docs/...` 引用，将仅对特定文件类型/目录生效的规则放到 `.qianji/rules/*.md`（通过 frontmatter `globs` 或 `paths` 限定作用范围），个人不入库覆盖使用 `AGENTS.local.md`。",
          "5. 如文中包含命令或本地文档链接，核对它们真实存在且命令可执行后，给出简洁的变更摘要。",
        );
      } else {
        lines.push(
          "",
          "当前工作区尚未创建 `AGENTS.md`。请分析代码库并生成一份高质量、可执行的 `AGENTS.md`：",
          "1. 先使用 `ls`、`find` 和 `read` 检查探测到的项目清单（如 `package.json`、`Cargo.toml`、`pyproject.toml`、`go.mod` 等）、核心源码目录结构与现有规则文件。",
          "2. 提取并核实项目真实的构建、启动、类型检查、Lint、全量测试及单文件测试命令，写明硬性架构边界、模块职责分工、代码风格与关键避坑点；不要空泛套话或虚构不存在的命令。",
          "3. 控制 `AGENTS.md` 篇幅精炼高信噪比：长文档可通过 `@docs/...` 语法引用；按路径生效的局部规则建议写入 `.qianji/rules/*.md` 并配置 `globs`/`paths`；个人本地覆盖建议放到 `AGENTS.local.md`（不入库）。",
          `4. 使用 \`write\` 在 \`${agentsPath}\` 创建文件，并在完成后核对写入内容与命令准确性，向用户汇报关键章节摘要。`,
        );
      }

      const extra = rawArgs.trim();
      if (extra !== "") {
        lines.push("", `用户补充要求：${extra}`);
      }

      return { prompt: lines.join("\n") };
    },
  };
}

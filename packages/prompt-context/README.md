# @qianji/prompt-context

内置的系统提示词片段、上下文/规则发现、技能管理与 `/init` 指令：

- **身份、行为准则与用户指令**：核心角色声明（`IDENTITY`）、工程执行规范（`GUIDELINES`）及可选自定义指令 `instructions`；
- **上下文文件**（`contextFiles !== false` 时启用）：先加载 `<dataDir>/AGENTS.md`（及 `AGENTS.local.md`），再从文件系统根目录逐层向下至 `cwd`，每层优先取 `AGENTS.md`（否则 `CLAUDE.md`）并紧跟同层 `AGENTS.local.md`（否则 `CLAUDE.local.md`）；支持安全的 `@path` 递归引用展开（带深度/字节上限、边界校验与敏感文件拦截）；
- **路径规则（`rules/`）**：扫描 `<dataDir>/rules` 与工作区 `.cursor/rules`、`.claude/rules`、`.agents/rules`、`.qianji/rules` 下的 `.md` / `.mdc` 文件；无条件规则随系统提示词注入，带 `globs` / `paths` 的局部规则仅注入紧凑索引，并在文件工具访问匹配路径（以及 `cwd` 下方子目录的 `AGENTS.md`）时通过 `tools/execute` 按会话去重自动加载；
- **技能（`skills/`）**：按优先级从低到高扫描内置只读技能（`bundledSkillsDirs` / `bundled-skills` 与 `QIANJI_BUNDLED_SKILLS_DIR`）、已启用插件贡献的只读技能（`pluginSkills`）、用户目录 `<dataDir>/skills`，以及项目目录 `<cwd>/.claude/skills`、`<cwd>/.agents/skills`、兼容旧目录 `<cwd>/.pid/skills` 与 `<cwd>/.qianji/skills` 下的 `*/SKILL.md`（同名后者覆盖前者）；提示词仅列出名称、描述和路径，并注册 `/skill:<name>` 斜杠指令；启用/禁用状态持久化在 `<dataDir>/skills.json`；
- **技能管理 RPC**：注册 6 个 RPC 方法——`skill.list`、`skill.read`、`skill.create`、`skill.save`、`skill.toggle`、`skill.delete`（内置与插件技能为只读，支持禁用或由用户/项目技能覆盖）；
- **`/init` 指令**：探测当前工作区清单与现有规则文件，引导 Agent 生成或增量更新 `AGENTS.md`；
- **环境信息**：`cwd`、平台与按会话固定的日期（支持 `now` 覆盖）。

配置（`Config`）：`{ dataDir, bundledSkillsDirs?, pluginSkills?, contextFiles?, instructions?, now? }`。

# @qianji/prompt-context

内置的系统提示词片段、规则发现与 `/init` 指令：

- **身份和行为准则**：核心角色声明、工程执行规范与用户自定义指令；
- **上下文文件**：先是 `<dataDir>/AGENTS.md`（及 `AGENTS.local.md`），然后从根目录一路到 `cwd`，每层目录优先取 `AGENTS.md`（否则取 `CLAUDE.md`），紧接着加载同层 `AGENTS.local.md`（否则取 `CLAUDE.local.md`）；支持安全的 `@path` 递归引用展开（带深度/字节上限、边界校验与敏感文件拦截）；
- **路径规则（`rules/`）**：扫描 `<dataDir>/rules` 与工作区 `.cursor/rules`、`.claude/rules`、`.agents/rules`、`.qianji/rules` 下的 `.md` / `.mdc` 文件；无条件规则随系统提示词注入，带 `globs` / `paths` 的局部规则仅注入紧凑索引，并在工具访问匹配路径（以及 `cwd` 下方子目录的 `AGENTS.md`）时通过 `tools/execute` 按会话去重自动加载；
- **技能（`skills/`）**：`<dataDir>/skills`、`<cwd>/.qianji/skills`、`<cwd>/.agents/skills`、`<cwd>/.claude/skills` 下的 `*/SKILL.md`，只列出名称、描述和路径，并注册 `/skill:<name>` 斜杠指令；
- **`/init` 指令**：探测当前工作区清单与现有规则文件，引导 Agent 生成或增量更新 `AGENTS.md`；
- **环境信息**：`cwd`、平台、日期。

配置：`{ dataDir }`。

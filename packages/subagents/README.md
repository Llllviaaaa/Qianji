# @qianji/subagents

`delegate_task` 工具：把最多 8 个互相独立的任务交给子 agent 并行执行。每个子 agent 运行在调用方会话的一个子会话里，由同一个 loop 驱动。见 [ADR 0010](../../docs/adr/0010-subagents-mcp-usage.md)、[ADR 0020](../../docs/adr/0020-tool-guards.md) 和 [ADR 0022](../../docs/adr/0022-agent-capability-enhancements.md)。

- 子会话的头部记录 `parent: { sessionId, callId }`，权限模式为 `read-only`（默认）或 `workspace-write`。工具声明 `timeoutMs: 0`，由子 agent 自身轮次上限和父任务中止控制。
- **工具访问边界**：
  - `read-only` 仅授予 `read`、`grep`、`find`、`ls`；
  - `workspace-write` 默认再授予 `edit`、`write`（不含 shell）；仅当调用传入 `allowShell: true` 且插件配置 `config.allowShell !== false` 时，额外授予验证工具 `bash`、`powershell`、`diagnostics`；
  - 所有子 agent 均不能再次委派（无 `delegate_task`）。
- **Worktree 隔离与补丁合入**：当 `permission === "workspace-write"` 且传入 `isolateWorktree: true` 时（要求工作区为带有效 `HEAD` 的 Git 仓库），每个子 agent 在基于 `HEAD` 创建的临时独立 `git worktree` 中运行；完成后收集变更并清理临时 worktree，再依次执行 `git apply` 合入主仓库（`applyChanges` 默认 `true`）。若 `applyChanges: false` 或补丁冲突，将补丁保存至 `.qianji/subagent-patches/*.patch`，并在结果及 `details.results[].patch` 中返回详情。
- **结构化结果**：调用时传入 `outputSchema`（一个 JSON Schema），每个子 agent 都必须用一个符合该 schema 的 JSON 值作为最终回答（`src/structured.ts`，思路来自 oh-my-pi 的 `task` 工具）。
  - 回答外面可以包一层 Markdown 代码块。
  - 解析失败或不符合 schema 时，会在同一个子会话里请它改正一次；改正后仍不符合，这个任务记为失败，错误里写明不符合的位置（例如 `$.files[0] should be string`）。
  - 成功时，父会话收到的是格式化后的 JSON 代码块，`details.results[].structured` 里是解析后的值。
  - 检查范围是工具 schema 常用的子集：`type`、`enum`、`const`、`properties`、`required`、`additionalProperties: false`、`items`、`minItems`、`maxItems`。其他关键字接受但不检查。
- **无值守传播与进度**：若父会话不可交互（`!ui.canAsk(parent.id)`），自动调用 `ui.markUnattended(child.id)` 透传静默约束；运行进度以 `{ type: "subagents" }` 实时增量发出；中止父会话会连带中止子 agent。

配置：`{ model?, effort?, roleModels?, concurrency?, allowShell? }`。`concurrency` 默认 3、上限 4；`allowShell` 总开关默认 `true`；`roleModels` 支持为 `explorer`、`planner`、`reviewer`、`worker` 按角色配置 `{ provider, model, effort? }`。

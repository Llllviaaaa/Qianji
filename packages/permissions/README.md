# @qianji/permissions

权限模式（`read-only`、`ask`、`workspace-write`、`full-access`）、agent 模式（`agent`、`plan`、`ask`）和工具规则，前置挂在 `tools/pre-execute` 上。见 [ADR 0009](../../docs/adr/0009-feature-plugins.md) 和 [ADR 0022](../../docs/adr/0022-agent-capability-enhancements.md)。

- `permissions` 服务：
  - `modes(session)` 返回会话的模式和有效模式（agent 模式不是 `agent` 时一律按 `read-only` 处理）；旁白会话（`session.header.side === true`）默认 `{ permission: "read-only", agentMode: "ask", effective: "read-only" }`，且仅读取 `forkedFrom.seq` 之后的模式事件。
  - `set(session, change)` 修改模式，记为 `custom` 事件 `qianji-permissions`（读取时以 `pid-permissions` 作为旧会话的只读兜底）。
- 自注册 RPC 方法：`permission.get` 与 `permission.set`。
- 评估规则（`rules.ts`）：
  - **硬性上界（先于自定义 `toolRules` 且覆盖所有模式）**：基于 `inspectSelfKillCommand` 的自杀命令拦截与基于 `isForcePush` 的强制推送拦截（受 `allowForcePush` 控制，默认 `false`）在包含 `full-access` 在内的所有模式均生效；`blockWriteOutsideWorkspace`（默认 `true`）在非 `full-access` 模式下拦截工作区外写入及浏览器下载；`quickChat` 禁用本地文件/Shell/子代理/`bg_process`/`plugin_manager`。
  - **`ToolDefinition.readOnly`**：声明 `readOnly: true`（且非已知写/交互类动作）的工具视为只读工具，在 `read-only` 及 `ask`/`workspace-write` 模式下免确认放行。
  - **细分工具动作判定**：
    - `powershell` 与 `bash` 在所有模式、前缀白名单与规则判定上保持完全一致；
    - `bg_process`：`list` / `logs` / `wait` 在 `read-only` 下放行，`stop` 禁止；
    - `desktop_memory`：`read` / `search` 在 `read-only` 下放行，写操作禁止；
    - `plugin_manager`：`list` / `verify` 在 `read-only` 下放行，其余修改操作禁止；
    - `delegate_task`：`read-only` 仅允许 `permission: "read-only"`；`ask` / `workspace-write` 下请求 `workspace-write` 时触发确认，并提示是否开启 `allowShell` 与 `isolateWorktree`。
- 需要确认时通过 `ui.confirm` 询问，没有 UI 时拒绝。
- 系统提示词片段 `agent-mode` 加入当前 `plan` / `ask` 模式的说明。

配置（`harness.json` 的 `permissions` 段）：`defaultPermission`、`defaultAgentMode`、`alwaysConfirmShell`（默认 `true`）、`blockWriteOutsideWorkspace`（默认 `true`）、`allowForcePush`（默认 `false`）、`shellAllowPrefixes`、`toolRules`。

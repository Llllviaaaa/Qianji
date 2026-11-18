# @qianji/plan

`update_plan` 工具：模型为多步骤的工作维护一份可见的计划。见 [ADR 0009](../../docs/adr/0009-feature-plugins.md)。

- **计划存储与实时增量**：计划记为 `custom` 事件，写入命名空间为 `qianji-plan`（`planOf(session)` 等读取逻辑同时兼容旧命名空间 `pid-plan`），随会话分支变化；每次更新通过 `session.delta` 发出 `{ type: "plan", plan }` 实时增量。
- **校验规则**：最多 50 步，步 `id` 非空且不重复，同一时间只能有一步 `in_progress`（`src/core.ts` 沿用自原 `pidesktop-plan-core.ts`）。
- **斜杠命令与 RPC**：注入 `commands` 时注册 `/plan [clear]`（查看当前会话计划或清空计划）；注入 `rpc` 时注册 `plan.get` 返回当前分支计划。
- **防漂移提醒（`llm/request`）**：当当前分支存在未完成步骤且距上次计划事件超过 `DRIFT_REMINDER_EVENT_THRESHOLD`（`12`）条事件时，向请求末尾 `user` / `tool-result` 消息追加 `<plan-reminder>` 提醒（不修改系统提示词以保持前缀 KV cache 稳定）。
- **未完成续跑（`agent/before-stop`）**：在可执行的非 `side` Agent 会话正常结束（`stop === "stop"` 且非只读）前，若最新计划仍有未完成步骤且该计划事件尚未提醒过（按 `seq` 去重），返回续跑提示催促模型继续执行或更新步骤状态。

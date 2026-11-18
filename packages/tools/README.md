# @qianji/tools

工具注册表和执行管线，见 [ADR 0003](../../docs/adr/0003-plugin-model-and-events.md)、[ADR 0008](../../docs/adr/0008-agent-loop-and-sessions.md) 和 [ADR 0020](../../docs/adr/0020-tool-guards.md)。

## 服务

| 键 | 类 | 说明 |
|---|---|---|
| `tools` | `Tools` | 工具注册表与执行管线，`execute(call, env)` 不抛异常 |

`Tools` 主要方法：

- `register(definition)` / `get(name)` / `listDefinitions()`：注册工具（自动绑定调用方 Cordis fiber 回收，不允许重名或占用 `ACTIVATE_TOOLS_NAME`）、按名查询定义，以及按名称排序返回全部已注册定义供运行时自省。
- `restrict(sessionId, names)` / `allows(sessionId, name)`：限制会话（如子代理）可见与可调用的工具集合并返回 disposer，以及检查会话是否允许访问某工具。
- `schemas(sessionId?)`：省略 `sessionId` 时返回全部已注册工具的 schema（全局自省）；传入 `sessionId` 时按 `allows` 过滤，并将未激活的 `deferred` 工具折叠为 `activate_tools`（`ACTIVATE_TOOLS_NAME = "activate_tools"`），且描述文本在部分激活后保持不变以维持 prompt 缓存稳定。
- `activate(sessionId, namesOrGroups)` / `isActivated(sessionId, name)`：按工具名、`group` 名、`<prefix>_` 或 `"all"`/`"*"` 为会话激活已授权的延迟工具并查询状态；直接调用延迟工具也会自动激活其分组，会话在 `session/deleted` 时自动清理激活记录。
- `execute(call, env)`：每次调用浅拷贝 `env` 并注入 `callId: call.id`，保证同一轮并发调用的 `tools/execute` 监听器可以安全替换与恢复 `env.signal` 而不互相影响。

## `ToolDefinition` 与 `ToolEnv`

- `ToolDefinition` 除 `name`、`description`、`parameters`、`execute` 外，还支持以下可选字段：
  - `deferred?: boolean`：设为 `true` 时在 `schemas(sessionId)` 中延迟暴露，需经 `activate_tools` 或直接调用激活。
  - `group?: string` 与 `groupDescription?: string`：用于按分组批量激活及在 `activate_tools` 描述中展示分组摘要。
  - `readOnly?: boolean`：声明工具严格只读且无副作用，供权限插件在 `Plan` / `Ask` / `ask` 模式下免确认放行。
  - `timeoutMs?: number`：供 `@qianji/tool-guards` 使用的调用时限（毫秒）；省略走插件默认，`0` 表示不限时。
- `ToolEnv` 包含 `sessionId`、`cwd`、`signal`、`callId?` 以及增量进度回调 `onProgress?: (text: string) => void`。

## 事件

| 事件 | 方式 | 说明 |
|---|---|---|
| `tools/pre-execute` | serial（异步 bail） | 返回 `{ allow: true }` 或 `{ deny: true, reason }`，没有返回值就放行；可以原地改写 `call.args` |
| `tools/execute` | waterfall | `(call, env, next)`：包裹执行，例如 checkpoint、超时、截断 |
| `tools/result` | emit | 观察结果（监听器异常会被捕获并记警告，不影响返回） |

参数仅校验 `required` 和顶层类型（`argumentProblem`）。

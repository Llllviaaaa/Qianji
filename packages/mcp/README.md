# @qianji/mcp

把 MCP 服务器提供的能力注册为工具，见 [ADR 0010](../../docs/adr/0010-subagents-mcp-usage.md)。

- `mcp` 服务在后台连接所有启用的服务器（STDIO 或 Streamable HTTP，由 `client.ts` 实现），每个远程工具注册为 `mcp__<server>__<tool>`（工具分组 `mcp_<serverId>`）。
- 有服务器支持时，额外注册资源和提示词相关工具：`mcp_list_resources`、`mcp_read_resource`、`mcp_subscribe_resource`、`mcp_unsubscribe_resource`、`mcp_list_prompts`、`mcp_get_prompt`。
- 只读会话只能访问标记为 `trustedReadOnly` 的服务器（且远程工具未标记 `destructiveHint`）；其余调用默认经 `ui.confirm` 确认，除非会话处于 `full-access` 或 `confirmTools` 为 `false`。
- 工具按需延迟注册：单个服务器的 `deferTools` 优先于全局 `Config.deferTools`，均未指定时当该服务器工具数超过 `AUTO_DEFER_TOOL_THRESHOLD`（8 个）会自动设 `deferred: true`，模型需先通过 `activate_tools` 激活。
- 动态刷新与自动重连：收到 `notifications/tools/list_changed` 时无需重启 Host 即可在线刷新该服务器工具列表；STDIO 服务器在初始化后意外退出时按 `reconnectDelaysMs`（默认 `[1000, 2000, 4000]` ms）自动退避重连并恢复订阅；`mcp.reconnect(serverId?)` 支持按需重连指定或全部已启用服务器。
- 状态与交互接口：状态变更会触发 Cordis 事件 `"mcp/changed"` 并广播 `mcp/changed` 通知；`statuses()` 返回连接状态，`ready` 在首批连接结束后完成；注册 6 个 RPC 方法（`mcp.status`、`mcp.reconnect`、`mcp.resources`、`mcp.readResource`、`mcp.prompts`、`mcp.getPrompt`）与 5 个斜杠指令（`/mcp-status`、`/mcp-diagnose`、`/mcp-resources`、`/mcp-read`、`/mcp-prompts`）。

配置（`Config` / `harness.json` 的 `mcp` 段）：`{ servers?, confirmTools?, reconnectDelaysMs?, deferTools? }`。

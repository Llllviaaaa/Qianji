# @qianji/ui

`ui` 服务：插件通过 `ask`、`confirm`、`select`、`input` 向用户提问，通过 `notify` 发送通知，不关心由谁回答。见 [ADR 0009](../../docs/adr/0009-feature-plugins.md)。

- `attach(transport)` 挂上实际的投递通道（Host 的 `ui-rpc` 是桌面端的实现），返回卸载函数。内部通过 `Set<UiTransport>` 支持同时挂载多个 transport：提问会分发给所有已挂载通道，先到者通过 `respond(requestId, value)` 胜出并自动向其余通道发送 `cancel(requestId)`。
- `available` 返回是否存在已挂载的 transport；`markUnattended(sessionId)` 将指定会话标记为无人值守（如后台/定时任务运行）并返回解除标记的 disposer；`canAsk(sessionId)` 在存在 transport 且会话非无人值守时返回 `true`。
- `ask(sessionId, request, signal?)` 是 `confirm`、`select`、`input` 的底层统一入口；当 `!canAsk(sessionId)`（无 transport 或会话无人值守）或 `signal` 已中止时立即返回“无回答”（`confirm` 返回 `false`，其余返回 `undefined`）。
- `signal` 中止或最后一个 transport 被卸下时，等待中的提问会被取消并解析为 `undefined`；`pending()` 列出仍在等待的提问（供重连客户端恢复）。
- `notify(sessionId, message, level = "info")` 向所有已挂载的 transport 广播通知。

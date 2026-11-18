# @qianji/llm-anthropic

Anthropic Messages API 的适配器插件，见 [ADR 0007](../../docs/adr/0007-llm-layer.md)。通过 `ctx.llm.registerProtocol("anthropic", protocolSpec)` 注册 `"anthropic"` 协议，也适用于提供同一接口的网关。

```ts
ctx.plugin(anthropic, {
  providers: [{ id: "anthropic", apiKey: { secret: "anthropic" } }],
});
```

| 字段 | 说明 |
|---|---|
| `baseUrl` | 不含版本路径，默认 `https://api.anthropic.com`；请求发往 `{baseUrl}/v1/messages` |
| `apiKey` | `SecretRef`，以 `x-api-key` 头发送（同时附带 `anthropic-version: 2023-06-01`） |
| `headers` | 额外的请求头，例如 `anthropic-beta` |
| `models` | 配置的模型；其中的 `maxOutputTokens` 会作为默认的 `max_tokens` |

- `listModels()` 请求 `GET {baseUrl}/v1/models?limit=1000` 发现模型名称、`contextWindow`（`max_input_tokens`）与 `maxOutputTokens`（`max_tokens`），并与配置的 `models` 合并（配置优先）。
- thinking 与 `max_tokens` 按模型版本分 4 档（[ADR 0018](../../docs/adr/0018-anthropic-adaptive-thinking-and-caching.md)）：
  - **Claude 4.5 及更早 / 非 Claude 模型 id（`budget`）**：使用 `thinking: { type: "enabled", budget_tokens }`，默认 `max_tokens` 为 `8192`（若 `max_tokens <= budget` 则自动提升为 `budget + 8192`）；`resolveThinkingBudget` 将 `minimal` / `low` / `medium` / `high` / `xhigh` / `max` / `auto` 分别映射为 `1024` / `2048` / `8192` / `24576` / `32768` / `64000` / `16384`，并支持数字或 `budget:<n>`（含 `k` 后缀，最低 `1024`）；
  - **Claude 4.6（`adaptive`）**：默认 `max_tokens` 为 `64000`，发送 `thinking: { type: "adaptive" }` 与 `output_config.effort`（`low`/`medium`/`high`/`max`；`minimal` 映为 `low`、`xhigh` 回退为 `high`，数字/`budget:<n>` 按预算分档），不思考时仍可发送 `temperature`；
  - **Claude 4.7 – 4.x（`adaptive`）**：默认 `max_tokens` 为 `64000`，发送 `thinking: { type: "adaptive", display: "summarized" }` 与 `output_config.effort`（`low`/`medium`/`high`/`xhigh`/`max`），一律不发送 `temperature`；
  - **Claude 5 及以后（`always-on`）**：默认 `max_tokens` 为 `64000` 且一律不发送 `temperature`；thinking 无法关闭，开启时发送 `thinking: { type: "adaptive", display: "summarized" }` 与 `output_config.effort`，`effort` 为 `off` 或未设置时发送 `output_config: { effort: "low" }`。
- 开启 thinking 时不发送 `temperature`；Claude 4.7 及以后一律不发。
- 带 `sessionId` 的请求最多设 **3** 个 `cache_control: { type: "ephemeral" }` 提示词缓存断点：分别位于 `system` 提示词、`tools` 最后一个工具定义，以及对话历史最后一个可缓存块（`text`/`image`/`tool_use`/`tool_result`/`document`，跳过 `thinking` 块）。不带 `sessionId` 的一次性请求不设断点。
- 测试夹具（`test/fixtures`）是按 Anthropic 的公开流式格式手工编写的。

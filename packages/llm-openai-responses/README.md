# @qianji/llm-openai-responses

OpenAI Responses API 原生适配器插件，见 [ADR 0007](../../docs/adr/0007-llm-layer.md)。`apply()` 通过 `ctx.llm.registerProtocol("openai-responses", protocolSpec)` 注册 `"openai-responses"` 协议，并为配置中的 `providers` 注册适配器。

```ts
ctx.plugin(openaiResponses, {
  providers: [{ id: "openai-responses", apiKey: { secret: "openai" } }],
});
```

## 配置（`Config` / `ProviderConfig`）

`Config` 接收 `{ providers?: ProviderConfig[] }`，每个 `ProviderConfig` 字段如下：

| 字段 | 说明 |
|---|---|
| `id` / `name` | 服务商标识与可选显示名称 |
| `baseUrl` | 默认 `DEFAULT_OPENAI_RESPONSES_BASE_URL`（`https://api.openai.com/v1`）；`normalizeResponsesBaseUrl` 会在传入裸域名 `https://api.openai.com` 时自动补全 `/v1` |
| `apiKey` | `SecretRef`，以 `Authorization: Bearer` 请求头发送 |
| `headers` | 额外的请求头 |
| `models` | 预配置模型列表；元数据优先于 `/models` 接口返回结果 |

## 适配器行为

- 流式请求发往 `POST {baseUrl}/responses`（`stream: true`），系统提示词通过 `instructions` 发送，输出上限使用 `max_output_tokens`，消息按 `input_text` / `input_image` / `output_text` / `function_call` / `function_call_output` 转换。
- 会话缓存亲和：当 `request.sessionId` 存在时，在请求体设置 `prompt_cache_key: request.sessionId`，并在请求头附带 `session_id: request.sessionId`。
- 推理与摘要：当 `model?.reasoning !== false` 且 `effort` 非 `"off"` 时发送 `reasoning: { effort, summary: "auto" }`（在默认或 `api.openai.com` 端点下 `"max"` 自动映射为 `"xhigh"`）；未启用推理参数时透传 `temperature`。
- 流式与用量翻译：处理 `response.reasoning_summary_text.delta` / `response.reasoning_text.delta`、`response.output_text.delta`、`response.output_item.added` / `response.function_call_arguments.delta` / `response.output_item.done`，并从 `response.completed` / `response.incomplete` 的 `usage` 提取扣除 `cached_tokens` 后的 `inputTokens`、`outputTokens`、`cacheReadTokens` 与 `reasoningTokens`（`output_tokens_details.reasoning_tokens`）。
- `listModels()` 请求 `GET {baseUrl}/models`，提取 `contextWindow`、`maxOutputTokens`、`thinkingLevels`、`thinkingLevel`、`reasoning` 与多模态 `input`，并与配置模型合并。

# @qianji/llm-openai-compat

适用于 OpenAI 兼容 Chat Completions 接口的适配器插件，见 [ADR 0007](../../docs/adr/0007-llm-layer.md)。通过 `ctx.llm.registerProtocol("openai-compat", protocolSpec)` 注册 `"openai-compat"` 协议，一个插件可以服务多个 provider，例如 OpenAI、DeepSeek、OpenRouter、Ollama、vLLM。

```ts
ctx.plugin(openaiCompat, {
  providers: [
    { id: "deepseek", baseUrl: "https://api.deepseek.com", apiKey: { env: "DEEPSEEK_API_KEY" } },
    { id: "ollama", baseUrl: "http://127.0.0.1:11434/v1", models: [{ id: "qwen3:8b" }] },
  ],
});
```

| 字段 | 说明 |
|---|---|
| `baseUrl` | 包含版本路径，请求发往 `{baseUrl}/chat/completions`，模型列表从 `{baseUrl}/models` 获取 |
| `apiKey` | `SecretRef`，以 `Authorization: Bearer` 发送；不填就不带这个头 |
| `headers` | 额外的请求头，例如 OpenRouter 的 `HTTP-Referer` |
| `reasoningEffort` | 可选布尔值，控制是否发送 `reasoning_effort`；未设置时由 `supportsReasoningEffort` 自动推断 |
| `models` | 配置的模型，元数据优先于接口返回的 |

- `reasoningEffort` 自动推断（`supportsReasoningEffort`）：显式设置 `true` / `false` 始终优先；未设置时自动排除 `deepseek-reasoner` 及 `api.deepseek.com` 端点，为已配置推理能力的模型以及 `o1` / `o3` / `o4` / `gpt-5` / `grok-3-mini` / `grok-4` 系列开启 `reasoning_effort`（除非模型配置 `reasoning: false`）。
- 会话亲和头：请求带 `sessionId` 时附加 `x-session-id`；模型名匹配 `grok` 时同时附加 `x-grok-conv-id`。
- 轮内 `reasoning_content` 回放：在最新一条用户消息之后的同轮工具调用循环（`index > lastUserIndex`）中附带历史 `reasoning_content`；最新用户轮之前的消息不回放。
- HTTP 400 自动降级重试（单次请求最多 4 次回退）：
  - 提示需用 `max_completion_tokens` 时记忆该模型并替换 `max_tokens`；
  - 拒绝 `reasoning_content` 时记忆该模型并移除后续回放；
  - 拒绝特定 `reasoning_effort` 取值时钳制重试（`minimal` → `low`，`xhigh`/`max` → `high`，其余 → `medium`）；
  - 拒绝自动推断的 `reasoning_effort`（`reasoningEffort === undefined`）时记忆该模型并去掉该字段重试。
- 流式解析支持 `delta.reasoning_content` / `delta.reasoning`、结构化 `delta.content` 分片、`choice.message` 兜底与多分片 `tool_calls` 组装，并通过 `InlineThinkParser` 从 `delta.content` 开头跨分片实时提取 `<think>...</think>` 与 `<thinking>...</thinking>` 思考块。

测试夹具（`test/fixtures`）是按 OpenAI 和 DeepSeek 的公开流式格式手工编写的。

# @qianji/llm-gemini

Google Gemini 原生 GenerateContent / StreamGenerateContent API 的适配器插件，见 [ADR 0007](../../docs/adr/0007-llm-layer.md)。`apply()` 通过 `ctx.llm.registerProtocol("gemini", protocolSpec)` 注册 `"gemini"` 协议，并为配置中的 `providers` 注册适配器。

```ts
ctx.plugin(gemini, {
  providers: [{ id: "gemini", apiKey: { secret: "gemini" } }],
});
```

## 配置（`Config` / `ProviderConfig`）

`Config` 接收 `{ providers?: ProviderConfig[] }`，每个 `ProviderConfig` 字段如下：

| 字段 | 说明 |
|---|---|
| `id` / `name` | 服务商标识与可选显示名称 |
| `baseUrl` | 默认 `DEFAULT_GEMINI_BASE_URL`（`https://generativelanguage.googleapis.com/v1beta`）；`normalizeGeminiBaseUrl` 会在传入裸官方域名时自动补全 `/v1beta` |
| `apiKey` | `SecretRef`，以 `x-goog-api-key` 请求头发送 |
| `headers` | 额外的请求头 |
| `models` | 预配置模型列表；元数据优先于 `/models` 接口返回结果 |

## 适配器行为

- 流式生成发往 `POST {baseUrl}/models/{model}:streamGenerateContent?alt=sse`（自动剥离模型 id 前缀 `models/`）；模型发现 `listModels()` 请求 `GET {baseUrl}/models?pageSize=1000`，筛选支持 `generateContent` 的模型并读取 `displayName`、`inputTokenLimit`、`outputTokenLimit` 与 `thinking` 能力（同时对 `gemini-2.5+` / `gemini-3+` 推断 `reasoning: true`）。
- 思考预算（`resolveThinkingBudget`）：开启思考时发送 `generationConfig.thinkingConfig: { includeThoughts: true, thinkingBudget }`（`minimal` 512、`low` 2048、`medium` 8192、`high` 24576、`xhigh` 28672、`max` 32768、`auto` -1，及数字/`budget:<n>`）；当 `effort === "off"` 且 `model.reasoning === true` 时发送最小关闭预算（`gemini-2.5-pro*` 为 `128`，其余为 `0`）。
- 流式与多模态翻译：转换 `systemInstruction`、`inlineData`、`functionCall` / `functionResponse` 与带 `thoughtSignature` 的思考块（标注 `provider: "gemini"` 并在后续轮次回传），并从 `usageMetadata` 提取扣除缓存后的 `inputTokens`、`outputTokens`、`cacheReadTokens` 与 `reasoningTokens`。
- `sanitizeGeminiSchema`：递归剔除 Gemini OpenAPI 子集参数校验器不支持的 JSON Schema 关键字（`$schema`、`additionalProperties`、`$defs`）。

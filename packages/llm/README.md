# @qianji/llm

与厂商无关的 LLM 词汇、协议注册表与 `llm` / `credentials` 服务，见 [ADR 0007](../../docs/adr/0007-llm-layer.md)。本包只定义接口和通用机制，具体 wire 协议由 4 个适配器包实现：`@qianji/llm-openai-compat`、`@qianji/llm-openai-responses`、`@qianji/llm-anthropic`、`@qianji/llm-gemini`。

## 服务

| 键 | 类 | 说明 |
|---|---|---|
| `llm` | `LlmService` | 协议工厂管理（`registerProtocol`、`getProtocol`、`listProtocols`、`instantiateProtocolAdapter`）与适配器调用（`registerAdapter`、`listProviders`、`listModels`、`stream`） |
| `credentials` | `Credentials` | 解析 `SecretRef`（`{ env }` / `{ secret }` / `{ value }`）；`registerStore` 用于接入密钥存储（并提供 `get`、`set`、`delete`、`writable`） |

`LlmService.stream` 不会抛异常，最终恒以单个 `{ type: "finish" }` 结束。对于可重试失败——包括尚未产出内容时的请求/空流错误，以及流式输出中途的网络断连或 SSE 截断——会自动按指数退避加抖动重试（`LlmServiceConfig` 默认 `maxAttempts: 5`、`baseDelayMs: 1000`、`jitterRatio: 0.2`）：

- 每次重试前发出 `{ type: "retry", attempt, maxAttempts, delayMs, error, effort? }` 块并清零本轮累计用量，通知下游丢弃不完整的部分块；
- `maxRetryableAttemptMs`（默认 `45_000` ms）：尚未产出内容且单次尝试耗时达到该阈值时停止重试；
- `longStreamStepDownMs`（默认 `60_000` ms）：长流已产出内容且运行达到该阈值后中断时，重试会逐级下调 `effort`（`max` → `xhigh` → `high` → `medium` → `low`），且达到第 3 次尝试后不再重试。

## 事件

| 事件 | 方式 | 说明 |
|---|---|---|
| `llm/request` | waterfall | `(request, next)`：调用 `next()` 前可以改写请求，也可以包装返回的流 |
| `llm/response` | emit | 一次调用结束（包括重试），带用量、结束原因、尝试次数和耗时 |
| `llm/protocols-changed` | emit | 通过 `registerProtocol` 注册协议或清理函数注销协议时触发 |

## 工具

- `parseSse`、`postSse`（内置 `DEFAULT_SSE_IDLE_TIMEOUT_MS = 90_000` 空闲超时与 `markFreshConnectionSignal`）、`getJson`、`joinUrl`：适配器共用的 SSE 和 HTTP 辅助函数。
- `errorFromResponse`、`toLlmError`、`LlmError`：把 HTTP 状态码和抛出的异常归类为 `LlmErrorInfo`。
- `BlockAssembler`、`assemble`：把流组装成最终的 `AssistantMessage` 并汇总用量；收到 `retry` 块时自动清空已累积的块与用量。
- `transformMessagesForProvider`、`normalizeToolCallId`：按目标协议（`anthropic`、`gemini`、`openai-compat`、`openai-responses`）规范化 `tool-call.id` 与 `tool-result.callId`、过滤孤立 `tool-result`、清洗 `{ __invalidJson }` 参数，并隔离跨厂商 `thinking` 签名。

`test/fake-server.ts` 是适配器测试共用的假 provider 服务器。

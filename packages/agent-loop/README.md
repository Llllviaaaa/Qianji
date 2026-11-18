# @qianji/agent-loop

唯一的 agent loop（`agents` 服务的实现），见 [ADR 0008](../../docs/adr/0008-agent-loop-and-sessions.md)、[ADR 0019](../../docs/adr/0019-context-pressure.md) 与 [ADR 0022](../../docs/adr/0022-agent-capability-enhancements.md)。只有 `@qianji/host` 加载它，其他包不得依赖它。

## 配置（`AgentLoopConfig`）

`{ maxTurns?, compactAboveTokens?, compactAtContextRatio?, summaryMaxTokens?, keepRecentTokens? }`

- `maxTurns`：单次运行最大模型调用轮数，默认 `DEFAULT_MAX_TURNS`（`500`）。
- `compactAboveTokens`：上一次调用用量加尾部事件估算 token 超过该值时在下一轮前压缩，优先级高于 `compactAtContextRatio`。
- `compactAtContextRatio`：未设 `compactAboveTokens` 时按模型 `contextWindow` 比例触发提前压缩，默认 `0.8`（设 `0` 关闭，窗口未知的模型不提前压缩，见 [ADR 0019](../../docs/adr/0019-context-pressure.md)）。
- `summaryMaxTokens`：压缩摘要调用的 `maxTokens` 预算（默认 `8_192`）。
- `keepRecentTokens`：运行中（`turn >= 2`）滑动窗口压缩保留近期完整步骤的近似 token 预算，默认 `12_000`（见 [ADR 0022](../../docs/adr/0022-agent-capability-enhancements.md)）。

## 关键机制与导出

- **上下文压缩与滑动窗口（`sliding`）**：第 1 轮前与手动 `compact` 采用 `keepLatestTurn` 模式保留最新用户轮次；运行中（`turn >= 2`）主动压缩切换为 `sliding` 模式，经 `slidingCompactionPoint` 保留最近约 `keepRecentTokens` 的完整工具步骤原文并仅压缩更早历史；遇到无输出的 `context-length` 错误时执行一次 `full` 全量压缩并重试。
- **摘要输入序列化与逐级收缩**：导出 `SUMMARY_CLIP_LEVELS`（`[8_000, 1_000]`）、`shrinkForSummary`、`prepareSummaryMessages`、`serializeConversation`。先将历史消息序列化为纯文本 `<previous-summary>` / `<conversation>` 用户消息（图片替换为 `[image omitted]`），若摘要请求仍触发 `context-length`，按 `SUMMARY_CLIP_LEVELS` 逐级裁剪长文本并重试。
- **工作集重注（Rehydration）**：导出 `buildCompactionWorkingSetAddendum`，从被压缩分支及前序压缩摘要中提取最近 `read` / `edit` / `write` 文件（最多 8 个）和最新 `update_plan` 条目（最多 8 条），在摘要末尾追加 `[Working-set context]`。
- **只读并发分批**：内部 `partitionToolBatches` 将连续只读工具（`readOnly === true` 或 `activate_tools`）合并为并发批次（`Promise.all`），遇非只读工具切分为串行屏障；若前一阶段结束时已有排队的 `steer` 消息，则跳过后续剩余批次。
- **有界自动续跑**：模型停止且无工具调用和排队消息时，按上限追加 `custom`（`qianji-continuation`）续跑提示词（并在有工具调用或排队消息推进时清零计数）：`length` 截断最多 `MAX_LENGTH_CONTINUATIONS`（`3`）次，无可见文本/工具的空轮最多 `MAX_EMPTY_CONTINUATIONS`（`2`）次，`agent/before-stop` 钩子最多 `MAX_PLUGIN_CONTINUATIONS`（`2`）次。

`test/golden/*.jsonl` 是 loop 的黄金日志：每个场景用脚本化的 provider 跑一遍，再逐字比较会话日志。改变 loop 行为时用 `npx vitest run packages/agent-loop -u` 更新，并在评审中检查 diff。

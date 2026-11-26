# 0024 Agent Loop V2 架构演进（流后动态安全并发、先读后改 CAS、两阶段缓存感知压缩、双模子代理与模型故障转移）

- 状态：已接受（扩展 [0007](0007-llm-layer.md)、[0008](0008-agent-loop-and-sessions.md)、[0010](0010-subagents-mcp-usage.md)、[0018](0018-anthropic-adaptive-thinking-and-caching.md)、[0019](0019-context-pressure.md)、[0020](0020-tool-guards.md)、[0022](0022-agent-capability-enhancements.md)）
- 日期：2026-11-25

## 背景

在对 Qianji 现有 Agent 执行主循环与主流本地编码 Agent（DeepSeek Harness、Claude Code、Codex CLI、π Agent）进行系统性基线审查后，工程链路暴露出两类待演进问题：

1. **Phase 1 — 对话稳定性与截断恢复边界**：
   - 在 `agent/before-stop` 异步续跑与 `session.flush()` 落盘窗口期间到达的 `steer` / `followUp` 消息易与结算竞态。
   - 模型仅输出思考块（`<think>` / `thinking`）而无可见正文或工具调用时易被误判为正常完成；`max_tokens` 截断导致工具参数 JSON 残缺（`__invalidJson`）时缺少无污染自愈。
   - 主动上下文水位估算遗漏最后一轮 `assistant` 之后追加的大体积 `tool-result` / `user` 事件，且 `bash` 与 `tool-output` 存在重复截断错位。
2. **Phase 2 — 并发吞吐、编辑防呆、压缩缓存命中率、持久子代理协同与多模型容灾**：
   - 仅依赖静态 `readOnly === true` 布尔标记，无法识别多动作工具（`desktop_memory`、`bg_process`、只读 `delegate_task`）或纯查询 `bash` 命令的动态并发安全性；工具参数 JSON Schema 校验位于 `tools/pre-execute` 之后，权限与钩子可能收到未校验入参。
   - 对已存在文件直接 `edit`/`write` 缺少会话级“先读后改”与外部并发修改（TOCTOU）检测，且写后缺少低延迟增量静态诊断反馈。
   - 主动压缩直接触发全量重排式 LLM 总结，破坏会话前缀 Prompt Cache 局部性，且宿主演进崩溃后的悬空工具调用未区分“未启动”与“已启动结果未知”。
   - 子代理仅支持阻塞式一次性 `delegate_task`：隔离 Git Worktree 未带入父工作区未提交脏改动，交互式父会话已批准 `allowShell: true` 后子会话执行验证命令仍会重复弹窗或因无人值守被拒，探索/审查子代理无法复用父会话已落定前缀，且缺乏后台异步句柄协同。
   - 单一主模型遭遇持续 `529 Overloaded`、限流或额度耗尽时缺乏跨服务商冷却自动切换与恢复回切机制。

所有演进继续严守 [0005](0005-repository-layout.md) 的三平面解耦及包依赖边界，以及 [LOCAL_CAPABILITIES.md](../LOCAL_CAPABILITIES.md) 的纯本地执行原则。

## 决策

### 1. Phase 1：运行队列无损结算、空答/截断恢复与单点输出截断
- **结算窗口防吞消息与思考剥离**（[`packages/agent-loop/src/index.ts`](../../packages/agent-loop/src/index.ts)、[`packages/session/src/derive.ts`](../../packages/session/src/derive.ts)）：在 `before-stop` 与 `flush()` 前后复检 `steer`/`followUp` 队列；新增 `hasVisibleProse` 剥离内联 `<think>`，对无可见正文且无工具调用的轮次触发有界续写提示，对残缺 `__invalidJson` 工具调用触发 `LENGTH_CONTINUATION_PROMPT` 自愈并在历史推导中过滤报错孤儿块。
- **水位补齐与单点截断**（[`packages/agent-loop/src/compaction.ts`](../../packages/agent-loop/src/compaction.ts)、[`packages/tool-output/src/index.ts`](../../packages/tool-output/src/index.ts)）：主动压缩估算纳入末尾 `assistant` 之后的增量事件 Token；移除工具内重复截断，统一由 `tool-output` 负责落盘 spill 与尾部摘要保留。

### 2. Phase 2 模块组 1：流后动态安全并发、前置深度校验与文件观测 CAS
- **坚持流后分批，升级 `isConcurrencySafe(args)` 与 `steeringSignal`**（[`packages/tools/src/index.ts`](../../packages/tools/src/index.ts)）：不引入流中投机执行，避免 SSE 断流重试污染状态；`ToolDefinition` 新增 `isConcurrencySafe?: (args) => boolean`（异常或未知工具一律 `fail-closed` 返回 `false`），解锁只读 `bash`、只读多动作工具与只读子代理并发；`ToolEnv` 新增 `steeringSignal` 供长等待工具在用户插话时协作让出；深度 JSON Schema 校验前移至 `tools/pre-execute` 之前。
- **会话级先读后改、mtime/SHA-256 CAS 与增量写穿诊断**（[`packages/tool-fs/src/index.ts`](../../packages/tool-fs/src/index.ts)）：运行时挂载文件观测守卫（保留纯函数 `execute` 单测兼容），拦截未读覆盖已有文件（`FS_NOT_OBSERVED`）及外部改写冲突（`FS_STALE_VERSION`，哈希一致时容忍时间戳漂移），并在写后以短超时附加增量错误摘要；[`packages/permissions/src/helpers.ts`](../../packages/permissions/src/helpers.ts) 补强 `realpathSync` 祖先校验阻断符号链接越界，[`packages/mcp/src/index.ts`](../../packages/mcp/src/index.ts) 将人工审批前移至 `tools/pre-execute`。

### 3. Phase 2 模块组 2：两阶段缓存感知压缩、崩溃分级恢复与惰性快照/钩子
- **Stage 1 零 LLM 影子裁剪 + Stage 2 同前缀总结与活跃切片回填**（[`packages/session/src/derive.ts`](../../packages/session/src/derive.ts)、[`packages/agent-loop/src/compaction.ts`](../../packages/agent-loop/src/compaction.ts)、[`packages/agent-loop/src/rehydrate.ts`](../../packages/agent-loop/src/rehydrate.ts)）：优先通过 `qianji-context-prune` 事件非破坏性折叠窗口外超大旧工具输出（保留原始 JSONL 与 UI 展示），回落至迟滞带内时直接省去总结；仍需总结时优先复用同会话前缀（`sessionId`、`system`、`tools`）发起总结并记录 `cacheReadTokens`（异常自动回退纯文本裁剪管线），同时回填最近活跃文件关键片段。
- **崩溃尾部分级与多监听器聚合**（[`packages/session/src/derive.ts`](../../packages/session/src/derive.ts)、[`packages/checkpoints/src/index.ts`](../../packages/checkpoints/src/index.ts)、[`packages/hooks/src/index.ts`](../../packages/hooks/src/index.ts)）：按是否已写入 `tool-call` 执行事件区分 `[TOOL_NOT_STARTED]` 与 `[TOOL_OUTCOME_UNKNOWN]`；检查点支持后续轮次首次写工具前惰性快照；聚合全部 `agent/before-stop` 监听器提示并支持 `Stop` 阻断钩子与 `PostToolUse` 上下文注入。

### 4. Phase 2 模块组 3：双模持久后台子代理、`forkContext` 与模型故障转移
- **脏工作区继承、受托 `allowShell` 与动态只读工具**（[`packages/subagents/src/worktree.ts`](../../packages/subagents/src/worktree.ts)、[`packages/subagents/src/index.ts`](../../packages/subagents/src/index.ts)）：`prepareIsolatedWorktree` 同步父工作区未提交修改与未跟踪小文件并以无签名底层 `commit-tree` 建立净基线，确保仅提取子代理净变更补丁；父会话批准 `allowShell: true` 后子会话静默执行验证命令而不重复弹窗，同时通过前置路径守卫与权限规则严守防越界写、防强推与防自杀红线；动态放行所有 `readOnly === true` 工具。
- **前缀克隆与按需折叠的持久后台协同原语**（[`packages/subagents/src/fork-context.ts`](../../packages/subagents/src/fork-context.ts)、[`packages/subagents/src/collab.ts`](../../packages/subagents/src/collab.ts)）：`forkContext: true` 克隆父会话已落定分支前缀；在 `group: "subagents"`（`deferred: true`，保持常驻工具列表零膨胀）下提供 `spawn_agent`、`send_input`、`wait_agent`（零轮询事件唤醒 + `steeringSignal` 响应）、`close_agent`，辅以后台完成自动 `followUp` 投递与 `agent/before-stop` 静默屏障。
- **冷却感知模型故障转移与宿主配置透传**（[`packages/llm/src/failover.ts`](../../packages/llm/src/failover.ts)、[`packages/llm/src/service.ts`](../../packages/llm/src/service.ts)、[`packages/host/src/harness-config.ts`](../../packages/host/src/harness-config.ts)、[`packages/host/src/agent-plugins.ts`](../../packages/host/src/agent-plugins.ts)）：`FailoverRouter` 在持续 `529`/`overloaded`、`rate-limit` 或配额耗尽时发出 `retry` 重置块并切换至健康 `fallbackModels`，冷却到期（默认 `120s`）后自动回切主模型；`harness.json` 暴露可选 `agentLoop` 与 `llm` 配置段。

## 后果

### 正面收益
- 只读查询、多动作状态探针与只读子代理可安全并发，显著缩短探索轮次耗时，同时不引入流中投机副作用。
- 先读后改 CAS 与写后增量诊断在首轮即捕获盲改与类型回归；两阶段压缩兼顾 Token 裁剪效率、UI 日志完整性与前缀缓存复用。
- 并行与后台子代理能准确看见父会话未提交代码并支持多轮交互控制，模型主备切换提升长任务抗抖动韧性。

### 代价与约束
- 会话运行时对未读已有文件的直接改写会返回 `FS_NOT_OBSERVED` 要求补读一次（可通过插件配置关闭）。
- 持久后台子代理受限于单宿主有界槽位（默认最多 6 个活跃句柄、递归深度上限 2），未分离（`detach !== true`）的运行中句柄会通过 `before-stop` 阻止父轮次提前收尾。

## 备选方案

- **流中工具投机抢跑（Streaming Tool Execution）**：虽可提前数百毫秒启动首个工具，但一旦流中途断线重试会导致 `activate_tools`、文件观测表及重复调用计数污染，故坚持流后确定性并发分批。
- **全量常驻暴露后台协同工具 Schema**：会改变所有普通会话默认工具前缀并消耗额外 Token，故采用 `deferred: true` 按需组激活（直接调用亦自动激活）。

# 0022 Agent 核心能力五向演进（代码精准编辑、子代理隔离、上下文保真、受管后台进程、渐进式记忆索引）

- 状态：已接受（扩展 [0009](0009-feature-plugins.md)、[0010](0010-subagents-mcp-usage.md)、[0019](0019-context-pressure.md)）
- 日期：2026-11-14

## 背景

Qianji 的桌面端三平面架构与 Cordis 插件体系已提供了完整的桌面与局部工具基础，但与 DeepSeek Harness、π Agent、oh my pi 等主流编码 Agent 对比后，在以下五个高频工程链路存在可补强的工程落差：

1. **代码定位与精准编辑**：缺少基于行内容哈希的锚点校验，长文件或小范围上下文漂移时 `edit` 易失败；纯 Node 搜索在大型仓库吞吐偏慢；缺少按需激活的轻量级类型诊断工具。
2. **并行子代理工程落地**：默认子代理共享主工作区且无命令验证通路，多写并发易冲突；角色模型路由与无值守（unattended）状态透传不足。
3. **长链路上下文连续性**：`session.rewind` 丢弃死胡同分支后缺少经验摘要注入；运行中达到上下文阈值时缺少基于近期完整工具步骤的滑动窗口保留机制。
4. **长驻后台进程受控管理**：长耗时构建/开发服务器缺少显式会话级后台生命周期管理、增量日志游标、主动 `wait`/`stop` 及子代理退出时的自动收割。
5. **大记忆文件上下文控制**：本地记忆（`<memory>` / `<project-memory>`）全量内联，文件增大后占用宝贵的 system prompt token 预算，且缺乏检索与按节更新原语。

所有演进严格遵循 [LOCAL_CAPABILITIES.md](../LOCAL_CAPABILITIES.md) 的**纯本地执行边界**：不引入云端沙箱或远程托管，权限审批与进程隔离均基于本地规则、Git Worktree、Windows Job Object 与会话生命周期事件实现。

## 决策

围绕上述五个方向落地增强：

### 1. 代码精准读取、编辑、高速检索与按需诊断
- **Hashline 锚点读写**（[`packages/tool-fs/src/hashline.ts`](../../packages/tool-fs/src/hashline.ts)、[`packages/tool-fs/src/index.ts`](../../packages/tool-fs/src/index.ts)）：`read` 支持 `hashlines: true` 输出 `<lineNo>#<4位hex>|<line>` 锚点；`edit` 原子化支持传统 `oldText`/`newText` 与基于 `anchor` / `endAnchor` 的 `HashlineEdit` 混用，支持 `±20` 行漂移自动重定位并在失败时整批回滚不写盘；前端工具卡片（[`src/lib/toolPresentation.ts`](../../src/lib/toolPresentation.ts)）同步展示多段 diff 与 hashline 变更预览。
- **`ripgrep` 极速检索回退链**（[`packages/tool-fs/src/search.ts`](../../packages/tool-fs/src/search.ts)）：`grep` 优先探测并调用 `rg --sort path` 获取确定性高速搜索结果，未安装或执行异常时无缝回退纯 Node 遍历。
- **延迟只读诊断工具**（[`packages/tool-fs/src/diagnostics.ts`](../../packages/tool-fs/src/diagnostics.ts)）：注册 `diagnostics` 工具（`deferred: true`、`group: "code_intelligence"`、`readOnly: true`），支持工作区内严格 JSON 检查及本地 `tsc --noEmit` 子进程诊断。

### 2. Git Worktree 隔离、受控验证命令、角色模型路由与无值守传播
- **隔离 Worktree 与补丁合入**（[`packages/subagents/src/worktree.ts`](../../packages/subagents/src/worktree.ts)、[`packages/subagents/src/index.ts`](../../packages/subagents/src/index.ts)）：`delegate_task` 支持 `isolateWorktree: true` 与 `applyChanges`，通过独立 `git worktree` 运行并行编码子任务；任务完成后按序生成并检查应用补丁，若合入冲突则保存为 `.qianji/subagent-conflicts/*.patch` 供人工或主会话处理，并清理临时 worktree。
- **验证型 Shell 白名单与权限守卫**（[`packages/subagents/src/core.ts`](../../packages/subagents/src/core.ts)、[`packages/permissions/src/rules.ts`](../../packages/permissions/src/rules.ts)）：支持配置及调用级 `allowShell: true`（受 `workspace-write` 与主会话权限上界约束），未开启时默认仅限安全文件工具；主会话在 `ask` 模式下调用敏感子代理选项时触发交互确认。
- **角色模型/思考强度路由与无值守传播**（[`packages/subagents/src/index.ts`](../../packages/subagents/src/index.ts)）：支持按 `role` 配置 `roleModels`（model + effort），并在子代理派生时调用 `ui.markUnattended(child.id)` 传播静默约束，避免子会话弹窗阻塞父运行。

### 3. Rewind 分支摘要注入与运行时滑动窗口压缩
- **Rewind 分支摘要**（[`packages/session/src/types.ts`](../../packages/session/src/types.ts)、[`packages/session/src/derive.ts`](../../packages/session/src/derive.ts)、[`packages/host/src/sessions-rpc.ts`](../../packages/host/src/sessions-rpc.ts)）：`session.rewind` 支持显式 `branchSummary` 与可选 `summarizeDropped: true`（在回退前对当前分支被丢弃段落调用 LLM 生成 dead-end 要点）；`deriveState` 在 `toSeq` 锚点注入 `BRANCH_SUMMARY_PREFIX` 提示（确保不拆散 `tool-call`/`tool-result` 配对），更早锚点的二次 rewind 自动清理已被超越的后代笔记，`forkEvents` 在新会话中完整保留存活分支摘要。
- **滑动窗口压缩**（[`packages/session/src/derive.ts`](../../packages/session/src/derive.ts)、[`packages/agent-loop/src/index.ts`](../../packages/agent-loop/src/index.ts)）：`AgentLoopConfig` 增加 `keepRecentTokens`（默认 `12_000`）；`compactIfLarge` 在 `turn >= 2` 触发中程主动压缩时切换为 `sliding` 模式（调用 `slidingCompactionPoint` 完整保留最近完整 turn/tool-step，不切断工具调用对；当单步超预算时安全回退全量锚点），而硬性 `context-length` 溢出仍执行全分支紧急压缩。

### 4. 会话隔离的受管后台进程生命周期
- **受管进程池与增量游标**（[`packages/tool-bash/src/proc.ts`](../../packages/tool-bash/src/proc.ts)、[`packages/tool-bash/src/background.ts`](../../packages/tool-bash/src/background.ts)、[`packages/tool-bash/src/index.ts`](../../packages/tool-bash/src/index.ts)）：`bash`/`powershell` 增加 `background?: boolean` 与 `waitMs?: number`（沿用现有自杀指令守卫与沙箱环境变量 / Windows Job Object 绑定）；每会话最多并发 8 个后台进程，维持 1 MB 有界环形日志缓冲与增量 `readOffset`；后台启动时自动通过 `ctx.tools.activate` 激活延迟工具 `bg_process`（`group: "process"`，支持 `list`/`logs`/`wait`/`stop` 且严格按 `sessionId` 隔离）。
- **自动收割与权限映射**（[`packages/tool-bash/src/index.ts`](../../packages/tool-bash/src/index.ts)、[`packages/permissions/src/rules.ts`](../../packages/permissions/src/rules.ts)）：通过 `session/deleted`、`session/unloaded`、`agent/settled`（针对 `header.parent !== undefined` 的子会话）及插件 `effect` disposal 自动终止并回收子进程树；`bg_process` 的 `list`/`logs`/`wait` 允许只读模式调用，`stop` 在只读模式下禁止。

### 5. 渐进式分段记忆索引与安全分节更新
- **大记忆阈值索引**（[`packages/memory/src/index-search.ts`](../../packages/memory/src/index-search.ts)、[`packages/memory/src/index.ts`](../../packages/memory/src/index.ts)、[`packages/host/src/harness-config.ts`](../../packages/host/src/harness-config.ts)）：当 `<memory>` 或 `<project-memory>` 内容不超过 `inlineMaxChars`（默认 `4000` 字符，可通过 `harness.json` 的 `memory.inlineMaxChars` 覆盖）时保持全文内联；超出时转为紧凑目录模式（`<memory mode="indexed">`），按代码块外部的 `#`–`###` 标题列出节名、行范围、字符数与首行摘要。
- **按需检索与 Unified Diff 分节写入**（[`packages/memory/src/core.ts`](../../packages/memory/src/core.ts)、[`packages/memory/src/index.ts`](../../packages/memory/src/index.ts)、[`packages/permissions/src/rules.ts`](../../packages/permissions/src/rules.ts)）：`desktop_memory` 扩展只读 `search`、`read` 的 `section`/`offset`/`limit` 切片读取，以及保留其余章节原地替换/追加新节的 `upsert_section`；`search` 在 `read-only` 模式下放行，`upsert_section` 复用统一 diff 交互确认流（`ui.confirm`）。

## 后果

### 正面收益
- 减少大文件行号误判带来的无效编辑重试，并使跨平台代码检索和轻诊断零配置可用。
- 并行子代理具备隔离写环境、测试校验能力与清晰冲突产物，避免污染主工作区。
- 多轮失败回溯与超长工具循环不再轻易遗忘关键尝试结论或丢失当前工具结果上下文。
- Dev server 与长构建任务可在会话生命周期内被显式观测和清理，不再成为孤儿进程或阻塞工具超时（配合 [0020](0020-tool-guards.md)）。
- 大型项目记忆不会无节制膨胀 system prompt，兼顾按需检索精准性与既有小记忆的零开销。

### 代价与约束
- Subagent Worktree 隔离依赖工作区本身为 Git 仓库且具备有效提交基线；非 Git 目录显式降级报错，要求调用方显式知悉或使用常规非隔离模式。
- 后台进程与本地沙箱依赖宿主 OS 信号、Job Object 与规则守卫（非虚拟机强隔离），不提供跨主机/容器化内核沙箱承诺。
- 新增 `branchSummary`、`bg_process`、`desktop_memory(search/upsert_section)` 等工具/事件模式增加了端到端状态机与权限单测矩阵维护成本。

## 备选方案

- **长期保留全量记忆与纯正文替换编辑器**：实现简单，但在超长上下文和大记忆场景下 token 浪费显著且编辑漂移率高，故采用阈值渐进切换与 Hashline 双协议兼容方案，保证小记忆与既有工具调用完全向后兼容。
- **通过中心化守护进程或独立沙箱容器托管后台命令**：增加跨进程运维复杂度且偏离桌面端轻量本地运行定位（[LOCAL_CAPABILITIES.md](../LOCAL_CAPABILITIES.md)），因此在 Cordis 插件层按 `sessionId` 管理并绑定系统事件自动清理是最小复杂度方案。

# 千机（Qianji）本地能力边界

这份清单是后续开发的范围基线。目标是用本地的 Harness Host 打造融合 Agent 工作台、自主 Bot 与 IDE 的全能本地创造环境。所有“已完成”项都必须从界面连接到真实本机后端。

## 必须具备的本地能力

| 能力域 | 当前状态 | 产品要求 |
| --- | --- | --- |
| 多任务 Agent | 已完成 | 一个 Harness Host 同时承载所有任务的会话；支持 `agent/before-stop`、受控隔离 Worktree 子代理（含 `outputSchema` 与 `roleModels`）、`activate_tools` 按需工具加载、工具超时/重复提醒守卫与 `bg_process` 受管后台进程；后台继续流式执行、切换任务不丢状态 |
| 动态插件系统 | 已完成 | 统一插件中心管理核心能力、10 个官方内置插件（`code-review`、`diagram-viewer`、`goal-tracker`、`message-actions`、`observability`、`quick-prompts`、`session-usage`、`side-chat`、`smart-rewind`、`web-preview`）及用户/工作区插件；`@qianji/client` SDK 与 22 个故障隔离 `<PluginSlot>` 扩展点；运行中自动延迟 HMR；工作区显式信任门禁与 `qianji_inspect`/`plugin_manager` Agent 闭环工具（遵循 ADR 0017 完全信任边界） |
| 会话与上下文 | 已完成 | 本地 JSONL 事件日志、`~/.qianji/index.sqlite` FTS5 全文搜索、`/` 快捷斜杠指令菜单、滑动窗口提前压缩与 50K 工具输出溢出（`~/.qianji/spill/`）、`rewind` 死胡同分支摘要、`/goal` 长程目标追踪、重命名、归档、恢复、删除、clone、fork、tree、compact、export |
| 模型与提供商 | 已完成 | 原生支持 Anthropic（含 Claude 4.6+/5 自适应 thinking 与多断点 Prompt Caching）、OpenAI Chat（自动 `reasoning_effort` 推断与 400 回退）、OpenAI Responses（`/v1/responses`）与 Google Gemini（`streamGenerateContent`）；会话内切换模型与思考等级并下发到 runtime |
| 成本与可观测性 | 已完成 | 采集 `reasoningTokens`，基于 `@qianji/pricing` 本地单价表估算会话与累计成本（支持自定义覆盖），`session-usage` 实时拆解上下文占比与 TTFT/TPS，配合 `observability` 三端闪退取证（`host-crashes.jsonl` + `/logs`）与诊断导出 |
| 工作区与 Worktree | 已完成 | 本地或 worktree 新任务、创建/打开 worktree、工作区信任门禁、右侧自由分屏平铺工作台（代码空间/Git 审查/预览/终端/侧边聊天/画布）、资源管理器与外部编辑器打开 |
| 权限与轻量沙箱 | 已完成 | `read-only`/`ask`/`workspace-write`/`full-access` 审批策略（含 `powershell` 回退对齐与默认 `allowForcePush: false`）；实验性 Windows 轻量沙箱（环境变量脱敏、`.qianji/sandbox-tmp` 重定向、Windows Job Object 进程数限制与高危系统命令拦截）及 `.wsb` / Dev Container 外部强隔离配置导出 |
| 本地长期记忆与技能 | 已完成 | 渐进式双层 Memory 2.0（`~/.qianji/memory.md` 全局 + `<repo>/.qianji/memory.md` 项目独立开关、超 `inlineMaxChars` 自动转为索引目录、`search`/切片 `read`/`upsert_section` 与 Unified Diff 审批）；应用内技能中心（含插件附带技能并实时同步 `/skill:<name>`） |
| Git Review 与 PR 闭环 | 已完成 | index/worktree 状态、hunk 级 stage/revert、代码行内批注批量发送 Agent、二进制/纯重命名/超大 diff 专门状态卡片；基于本机 `gh` 的桌面端 PR 创建（AI 生成标题与正文，遵守 `pullRequestInstructions`）及 PR 审查评论/CI 失败一键回灌对话修复 |
| 本地终端 | 已完成 | 真实 PTY（可停靠底部抽屉或右侧工作台分屏）、多 tab、自定义 Shell 启动参数（`terminalShellArgs`）、退出码徽章、选区或最近输出一键发送到对话，默认不自动污染模型上下文 |
| 本地定时任务 | 已完成 | 创建、暂停、立即运行、安全权限快照、运行记录、结果会话；仅 App 与电脑运行时触发 |
| Browser / Computer | 已完成 | `browser_*` / `computer_*` 延迟按需扩展；页面/桌面截图与状态可见；控制会话与交互动作受审批控制 |
| MCP | 已完成 | STDIO/HTTP、动态工具（超 8 个工具自动延迟加载）与 `list_changed` 热刷新、指数退避与手动一键重连、Resources/Prompts 浏览面板、DPAPI 凭据保护与审批 |

## 持续演进方向

按真实工程需求按需迭代：

1. **Agent ⇄ Bot 双形态切换（核心演进）**：在已有的单进程常驻 Harness Host、托盘防休眠、`@qianji/schedule`、`@qianji/memory`、MCP、Browser/Computer Use、`Intelligent UI` 与精灵图虚拟形象底座之上，构建可一键切换的 **Bot 形态**（跨天连续个人时间线、Heartbeat 周期心跳主动巡检与提醒卡片、右侧分身档案与自主行动时间轴，以及 Bot → Agent 双向接力）。
2. **官方插件生态扩展**：在已有的 `plugin_manager(action: "scaffold")`、离线 `plugin-types/` 与 3 套基础模板（`tool-only`、`ui-slot-widget`、`fullstack-panel`）之上，按需沉淀更多垂直场景官方插件包。
3. **终端进阶交互**：按需评估终端内搜索高亮与多分屏布局，继续保持终端输出不自动塞入模型上下文。
4. **跨平台强隔离向导**：在现有 Windows Sandbox（`.wsb`）与 Dev Container 模板基础上，按需补充容器自动检测与一键拉起体验。

## 明确不做

- 云端执行环境、远程 worker、云任务队列
- OpenAI/ChatGPT 账号、套餐、计费、组织 RBAC 和企业策略
- 跨设备云同步与 handoff
- 自建插件审核/托管平台；只管理本机的插件、技能和外观资源
- 把纯权限审批或进程级轻量沙箱夸大宣称为内核级/Hyper-V 级完整 OS 虚拟化沙箱（强隔离请使用导出的 `.wsb` 或 Dev Container）
- 只有外观、没有真实本机能力的页面空壳

## 验收原则

- 数据与运行记录可指出明确本机路径。
- 断网时已有会话、Git、终端和本地 provider 仍可工作或给出诚实错误。
- Browser、Computer、MCP、轻量沙箱等能力关闭后，核心对话仍可用。
- 新功能必须有真实后端、失败状态和最小针对性测试，才能标记已完成。

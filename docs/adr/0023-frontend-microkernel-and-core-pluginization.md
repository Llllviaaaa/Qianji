# 0023 前端微内核化、强类型槽位树与全栈核心插件化

- 状态：已接受（扩展并修订 [0016](0016-dynamic-plugins-and-hmr.md) 的前端扩展模型与 CSS 层序）
- 日期：2026-11-20

## 背景

在 [ADR 0003](0003-plugin-model-and-events.md) 与 [ADR 0016](0016-dynamic-plugins-and-hmr.md) 落地后，千机后端（Harness Host）已高度微内核化：`corePlugins()` 仅保留 8 个纯内存总线/骨架，30 余项核心能力均已作为 `PluginManager` 托管的一等内置插件，支持用户在 `<dataDir>/plugins/` 以同名 `id` 热覆盖。

然而前端渲染层（`src/`）与后端之间存在显著不对称：

1. **核心外壳硬编码**：`App.tsx` 与 `MainConversationStage.tsx` 将菜单栏、侧边栏、首页、对话消息流、输入框、右侧/底部工作台、设置中心全部写死在单体组件树中，插件仅能通过 `ctx.contributions` 向 22 个预定义扁平插槽追加挂件，无法替换核心交互区，也无法为下游插件递归暴露新子槽位。
2. **部分官方内置功能为“假插件化”**：`code-review`、`web-preview`、`side-chat`、`diagram-viewer` 在前端依赖 `builtinPluginGatesStore` 的布尔开关控制硬编码组件显隐，而非真正以客户端插件注册渲染实现，无法通过同名插件替换。
3. **前端状态未服务化**：核心界面通过数十个 props 与内部 Zustand 切片直连；对外冻结的 `@qianji/client` 仅提供 5 个只读摘要 Hook，缺少多会话绑定、完整消息流、草稿/附件、分屏布局、编辑器与终端控制句柄。
4. **全局皮肤能力被 `@scope` 锁死**：`clientPluginStyles.ts` 强制将全部插件 CSS 锁定在 `@layer plugin-ui { @scope ([data-qj-plugin="<id>"]) }` 且置于宿主样式之下，导致皮肤类插件无法定制宿主排版、气泡结构或全局样式。
5. **后端 `AgentLoop` 尚不可覆盖**：后端唯一仍固化在 `corePlugins()` 内的编排逻辑是 `AgentLoop`。

为实现“**前后端万物皆可通过插件更改，包括核心**”，同时不引入上游 `@deepseek-ai/dsh-*` rc 包的版本脆弱性，本 ADR 定义千机自研的强类型前端微内核架构与全栈核心插件化边界。

## 决策

### 1. 前端微内核架构：极薄底座 + 内置核心插件层

前端渲染层拆分为两层，保持 [ADR 0005](0005-repository-layout.md) 的三平面隔离不变（`packages/*` 仍归 Host 侧，除 `@qianji/protocol` 外不跨平面共享代码）：

- **微内核底座（`src/kernel/`）**：包含强类型槽位内核（`src/kernel/slots/`）、受管 Store 生命周期（`src/kernel/store/`）、前端 Cordis Service 网格（`src/kernel/services/`）、公开 UI 原语（`src/kernel/primitives/`）以及运行时协调器与防变砖底座（`src/kernel/runtime/`）。`src/App.tsx` 收缩为极薄微内核启动入口，仅挂载 `SlotKernelProvider`、不可被覆盖的 `<SafeModeBanner />` 与唯一入口 `<SlotRoot />`（渲染 `root` 槽位）。
- **内置核心插件层（`src/builtin-plugins/`）**：将核心界面拆分为 8 个不可停用的领域级内置核心插件（`canDisable: false`：`core-shell`、`core-sidebar`、`core-home`、`core-conversation`、`core-composer`、`core-workbench`、`core-settings`、`core-hubs`），以及 5 个可独立停用与替换的功能插件（`canDisable: true`：`code-review`、`web-preview`、`side-chat`、`diagram-viewer`、`intelligent-ui`）。
- **编译兜底 + 同名热覆盖**：内置核心插件由 Vite 预编译进渲染产物，保证零延迟冷启动与离线/故障兜底；运行时由 `BuiltinCorePluginCoordinator`（`src/kernel/runtime/builtinCorePlugins.ts`）统一作为 `tier: "builtin"` 节点管理。当用户在 `<dataDir>/plugins/` 或受信任工作区安装同名 `id` 且激活健康的客户端插件（或在 `single`/`chain` 槽位以更高优先级接管）时，运行时无刷新卸载内置 Fiber 并挂载用户插件 Fiber；停用、卸载、激活失败或进入安全模式时立即回退至内置层。
- **机械化的边界等价**：通过 `eslint.config.js` 强制限制 `src/builtin-plugins/**` 仅可导入公开前端契约（`@qianji/client-slots`、`@qianji/client-store`、`@qianji/client-primitives`、`@qianji/client`、`@qianji/protocol`、`react`、`lucide-react`、`@deepseek-ai/cordis`、`@deepseek-ai/schemastery`），禁止直连 `src/store/*`、`src/stores/*`、`src/lib/*`、`src/kernel/services/*` 或以 `../` 跨出自身插件目录导入其他内置插件，确保内置核心插件与外部动态插件完全平权。

### 2. 千机自有强类型槽位内核（`@qianji/client-slots` / `@qianji/client-store`）

自研对标 DSH 槽位引擎能力的前端内核包（位于 `src/kernel/slots/` 与 `src/kernel/store/`，通过 Vite/TS 别名、`CLIENT_MODULES`（`src/lib/clientPluginBootstrap.ts`）、`CLIENT_SHARED_EXTERNALS`（`packages/protocol/src/plugin-methods.ts`）与 `scripts/generate-plugin-types.mjs` / `scripts/plugin-types-client-kernel.mjs` 对内外统一暴露），不依赖任何上游 `@deepseek-ai/dsh-*` UI 包：

1. **声明合并注册表与 46 个规范核心槽位**：
   - `SlotMap`：任何内置或外部插件均可通过 `declare module "@qianji/client-slots"` 声明并拥有新槽位；`src/kernel/slots/coreSlotMap.ts` 定义全量 **46 个规范核心槽位**（`CoreSlotMap` 与运行时规格表 `CORE_SLOT_SPECS`，覆盖 `root` / `shell.*`、`sidebar.*`、`home.*`、`conversation.*`、`composer.*`、`workbench.*`、`settings.*`、`hub.pages`）。
   - `ChildrenDecl` 与所有权鉴权：注册组件在 `children` 中声明并认领子槽位规格（`kind`、`scope`、`inject`），运行期仅授权该注册项对应的 `renderSlot` / `renderSlotChain` 句柄渲染其声明的子槽位，防止越权渲染与悬挂句柄（`SlotOwnershipError` / `StaleAuthorizationError`）。
2. **四种槽位分发语义（`SlotKind`）与洋葱包裹（`wrap`）**：
   - `single`：独占槽位（按 `slotOverrides > workspace > user > builtin > priority > registrationOrder` 选出胜出者，支持用户手动锁定胜出插件）。
   - `list`：有序列表（按 `order` 升序渲染全部条目）。
   - `keyed`：按键路由（支持精确键、数组、前缀通配如 `"sqlite_*"` 或 `matchKey` 谓词，如工具卡按 `toolName`、文件预览按扩展名/MIME、代码块按语言、工作台按 `paneId`）。
   - `chain`：纯函数选择器链（按优先级依次执行 `select(ownerProps)`，首个非空/非 `false` 结果当选并通过 `selected` 属性透传；支持 `overlay: true` 以 `display: none` 隐藏而非卸载底层组件，确保如 `composer.main` 被临时接管后退出时草稿与 DOM 状态零丢失）。
   - 同时支持通过 `ctx.slots.wrap()` 注册洋葱装饰器（由独立的 `WrapperErrorBoundary` 隔离，单层装饰器抛错不破坏内层核心视图），便于插件增量包裹核心组件而不必整块重写。
3. **三档作用域与多会话绑定（`SlotScope`）**：
   - `root`：全局作用域，注入 `GlobalStandardProps`。
   - `session-maybe`：当前会话可选作用域，注入 `SessionMaybeStandardProps`（含 `sessionId: string | null`）。
   - `session`：严格绑定某一具体会话实例（注入 `SessionStandardProps`；通过 `<SessionArea sessionId={...}>`（别名 `<SessionProvider>`）显式绑定或经 `src/kernel/services/sessionScopeAdapter.ts` 继承当前活跃会话），使主对话区、右侧 `side-chat` 与未来多分屏多会话共享完全一致的对话流与输入框槽位树。
4. **组件工厂与托管 Store**：
   - `SlotFactoryMap`：支持可替换、按渲染位置（`occurrenceKey`）隔离生命周期与错误边界的可复用组件工厂（`ctx.slots.registerFactory` / `renderFactory` / `<SlotFactoryHost>`），并在 `src/kernel/primitives/factories.ts` 内置注册 5 个可替换核心原语工厂（`primitive.markdown`、`primitive.dialog`、`primitive.popover`、`primitive.card`、`primitive.scrollArea`）。
   - `@qianji/client-store`（`src/kernel/store/index.ts`）：通过 `SlotStoreRegistry` 为每个槽位注册项与工厂实例提供按 `(entryId, scopeKey)` / `(factoryKey, occurrenceKey, scopeKey)` 自动创建与回收的受管 Store 席位，并提供零 Zustand 依赖的轻量响应式单元 `createReactiveStore` 与 `useStoreValue`。
5. **预留多语言与资源协议扩展口**：
   - 在 `@qianji/client-slots` 中预留 `LocaleNamespaceMap`（声明 `locale:` 自动注入 `t` 函数）与 `ResourceProtocolMap`（`useResource<P>(address)`）合并接口供插件按需使用；首期内置核心插件拆分不强制抽离全量中文文案或重写现有 TanStack Query 逻辑。
6. **100% 向后兼容层**：
   - 保留 `ctx.contributions`（全部 22 项注册方法）、`@qianji/client` 现有导出与 `ctx.betterSidebar` 垫片，底层经 `mirrorContributionToSlot` 镜像至 `ctx.slots`，确保仓库内全部官方插件与已有第三方插件零修改继续运行。

### 3. 前端 Cordis Service 网格与公开 UI 原语（`@qianji/client-primitives`）

1. **前端 Cordis Service 网格（`src/kernel/services/`）**：将原先散落在 `App.tsx`、Zustand 切片与工作台 Store 的状态与动作封装为挂载在客户端根 `Context` 上的标准服务（共 11 个领域服务 + `slots` / `styles` 2 个内核服务），经 `@qianji/client`（`src/sdk/frontendServices.ts`）以 `useFrontendService`、`useSessionState`、`useSessionHandle`、`useWorkspaceState`、`useComposerState`、`useWorkbenchState`、`useNavigationState`、`useThemeState`、`useShortcutsState`、`useMenusState`、`useRpcState`、`useLocaleState`、`useResourcesState`、`useSafeMode`、`useSlotOverrides` 等响应式 Hook 对外开放，隐藏内部实现细节：
   - `sessionService`：会话目录、多会话 ref-counted `retain` 句柄（`SessionHandle`）、完整 `messages[]` 流、流式/压缩状态、发送/中断/引导/排队、编辑重发、分支树/回退/导出、模型/思考等级/权限与 Agent 模式切换。
   - `workspaceService`：工作区切换与目录列表、Git 状态/差异/恢复、工作区信任状态、文件读写与外部打开。
   - `composerService`：按会话分桶的草稿文本、预填、附件列表、排队消息控制与斜杠命令拦截/回退管线。
   - `workbenchService`：右侧/底部工作台显隐、分屏平铺树（开/关/拖拽停靠/比例调整/最大化/翻转方向）、文件打开与代码编辑器状态、代码审查/预览/摘要/集成终端生命周期与检查器状态。
   - `navigationService`：主舞台路由（新任务/会话/内置中心页/插件页）、前后导航历史、设置弹窗与页签跳转、左侧栏折叠/宽度、Toast 与通知中心、扩展审批弹窗队列。
   - `themeService`、`shortcutService`、`menuService`、`rpcService`、`localeService`、`resourcesService`：主题目录与深浅色/缩放/密度管理、全局快捷键分发（保留 Safe Mode 不可覆盖）、窗口与右键菜单统一注册表、Host JSON-RPC 调用与服务端通知订阅、可选多语言词典与资源 URI 协议注册。
2. **公开 UI 原语包（`src/kernel/primitives/` / `@qianji/client-primitives`）**：对外暴露 17 个 SemVer 稳定、基于 `--qj-*` 令牌的基础 UI 原语（`Badge`、`Button`、`Card`、`Dialog`、`DialogSection`、`IconButton`、`Input`、`Markdown`、`Popover`、`ScrollArea`、`Select`、`Switch`、`Tabs`、`TabsContent`、`TabsList`、`TabsTrigger`、`Tooltip`）与 5 个可替换 `SlotFactoryMap` 核心原语工厂（`src/kernel/primitives/factories.ts`），接入 `CLIENT_MODULES` 与 `CLIENT_SHARED_EXTERNALS`；CodeMirror 6、xterm.js、Mermaid 等重型库暂不纳入强契约共享单例，避免锁死宿主大版本升级。
3. **Agent 自省闭环升级**：扩展 `packages/protocol/src/plugin-catalog.ts`（`CORE_SLOT_CATALOG`、`FRONTEND_SERVICE_CATALOG`）、`packages/host/src/plugin-dev-tools.ts` 与 `packages/host/src/plugin-inspect-core.ts`（`qianji_inspect` 新增 `slot_tree`、`frontend_services`、`slot_owners`、`primitives` 四个主题）、`scripts/generate-plugin-types.mjs` 与 `scripts/plugin-types-client-kernel.mjs`（产出 `@qianji/client-slots`、`@qianji/client-store`、`@qianji/client-primitives` 完整离线 `.d.ts`）以及 `packages/host/src/plugin-templates-core.ts`（`plugin_manager(action: "scaffold")` 新增 `"core-override"` 与 `"global-skin"` 脚手架模板）。

### 4. CSS 级联层序与受控全局皮肤通道

修订 [ADR 0016](0016-dynamic-plugins-and-hmr.md) 第 7 节的样式层序，将 `src/styles/index.css` 更新为：

```css
@layer theme, base, plugin-ui, legacy, skin, components, plugin-skin, utilities;
```

- **默认安全隔离不变**：普通插件通过 `import "./style.css"` 或 `ctx.styles.inject(css)` 注入的样式由 `src/kernel/runtime/pluginStyles.ts` 自动包裹在 `@layer plugin-ui { @scope ([data-qj-plugin="<id>"]) { ... } }` 中（`:root` 自动改写为 `:scope` 并清理不匹配花括号），无法误伤宿主或其他插件。
- **显式全局皮肤通道**：皮肤/核心改写类插件可通过 `ctx.styles.injectGlobal(css)` 或在源码中导入 `*.global.css`（由 `packages/host/src/client-bundles.ts` 自动转译至 `globalThis.__qianjiInjectPluginGlobalStyle`），样式包裹为 `@layer plugin-skin { ... }`（无 `@scope` 限制，保留 `:root` 令牌声明，优先级高于内置核心的 `legacy` / `skin` / `components`，低于 Tailwind 原子工具类 `utilities`），并与作用域样式共享 HMR 快照、修剪、失败回滚与卸载清理事务。
- 与 [ADR 0017](0017-plugin-trust-model.md) 的完全信任模型一致，不虚构无法执行的样式权限限制。

### 5. 三层防变砖与冲突治理

允许插件替换 `core-shell`、`core-composer`、`core-settings` 等核心界面后，底座必须保证永不“变砖”：

1. **渲染抛错自动退让（Abdication Fallback）**：由 `src/kernel/slots/abdication.ts`（`AbdicationTracker`）实现。当占据 `single`、`keyed`、`chain` 或工厂槽位的插件在渲染期或 `select()` 期间抛出异常，或进入熔断锁定时，槽位渲染器自动将 `(slotKey, entryId)` 标记为 `abdicated`，立即回退渲染下一优先级实现（最终兜底到内置默认核心插件），并通过非阻塞 Toast 告知发生退让的插件 ID；当插件产生新的 `(etag, configKey, reloadEpoch)` 周期（HMR 重编译、配置变更或显式重载）时自动解锁重试。
2. **逻辑白屏 Safe Mode 急救**：微内核底座（`src/kernel/runtime/safeMode.ts` 与 `src/kernel/runtime/SafeModeBanner.tsx`）注册不可被任何插件覆盖的独立急救通道——窗口捕获阶段快捷键 `Ctrl+Shift+Alt+R`（macOS 同步支持 `Cmd+Shift+Alt+R`）、桌面端启动参数 `--safe-mode`（`src-tauri/src/lib.rs` 与 `src-tauri/src/webview_guard.rs` 注入 `window.__QIANJI_SAFE_MODE__ = true`，支持二次启动 `--safe-mode` 触发主窗口重载与 `is_safe_mode` 命令查询）、URL 参数 `?safeMode=1` 与 `sessionStorage["qianji:safe-mode"]`。触发后 `createSafeModeGatedTransport` 立即暂停挂载全部 `user` 与 `workspace` 外部客户端插件，仅以纯净内置核心层运行并在 `<SlotRoot />` 外渲染 `<SafeModeBanner />`。
3. **冲突解析与槽位归属可视化**：同一 `single`（及 `chain` / `keyed`）槽位存在多个有效注册项时，按 `slotOverrides > workspace > user > builtin > priority > registrationOrder` 确定胜出者；用户手动锁定保存在 `localStorage["qianji:slot-overrides"]`（`src/kernel/runtime/slotOverrides.ts`）。`core-settings` 内置「核心槽位与接管」面板（`src/builtin-plugins/core-settings/SlotOwnershipPanel.tsx`，`settings.pages` 路由键 `"slots"`），实时展示全部 46 个规范核心槽位与第三方自定义槽位的当前胜出插件、候选列表、异常退让诊断与安全模式状态，支持搜索/筛选、手动锁定、单槽或一键全部恢复默认。

### 6. 消除假插件门控与后端 `AgentLoop` 插件化

- **前端清零 `builtinPluginGatesStore`**：`code-review`、`web-preview`、`side-chat`、`diagram-viewer`、`intelligent-ui` 均改写为 `src/builtin-plugins/` 下的标准内置功能插件（`canDisable: true`），由 `BuiltinCorePluginCoordinator` 统一协调生命周期，直接向 `workbench.panes`、`conversation.markdown.codeBlock`、`workbench.fileViewer`、`workbench.topbarControls`、`menus`、`keybindings` 等槽位注册，停用即卸载 Fiber、同名插件即完全替换其前后端实现。
- **后端 `AgentLoop` 移入可覆盖插件层**：在 `packages/host/src/agent-plugins.ts` 中，将 `AgentLoop` 从 `corePlugins()` 移入 `builtinPluginDefinitions()`（`id: "agent-loop"`，`provides: ["agents"]`，`canDisable: false`，`canOverride: true`），`corePlugins()` 进一步收敛为 7 个纯内存总线（`Credentials`、`LlmService`、`Sessions`、`Ui`、`Tools`、`Commands`、`SystemPrompt`）。用户可通过同名 `id: "agent-loop"` 插件替换整套 Agent 主循环策略；`tests/test-package-boundaries.test.ts` 中仅 `@qianji/host` 可直接导入 `@qianji/agent-loop` 的边界约束保持不变。

## 后果

- **正面收益**：
  - 前后端达成一致的“极薄底座 + 万物皆可插件覆盖”微内核哲学：小至单个按钮、消息气泡、输入框，大至整个应用外壳、工作台布局、全局视觉皮肤与后端 `AgentLoop`，均可在不重编安装包的前提下通过插件热替换。
  - 多会话 `SlotScope` 从根上消除了 `SideChatPanel` 与主对话区重复维护两套渲染与状态同步逻辑的历史包袱。
  - ESLint 机械化约束内置核心插件只能消费公开契约，从根本上杜绝“宿主特权后门”，让官方团队成为自身插件 SDK 的第一重度用户（Dogfooding）。
- **代价与风险**：
  - 一次性全量拆分风险极高，必须按 6 个独立可验收阶段渐进推进，每个阶段保持全量单测、架构门禁、类型检查与 E2E 测试全绿。
  - 需长期维护 `@qianji/client-slots`、`@qianji/client-store`、`@qianji/client-primitives` 与前端 Cordis Service 网格（11 个领域服务 + `slots` / `styles` 内核服务）的向后兼容性，不能随意破坏公开接口签名。
  - 现有部分架构门禁（如 `tests/test-architecture-guardrails.test.ts` 中对 `src/styles/index.css` `@layer` 顺序、核心模板编译和入口文件行数的断言）已同步演进为微内核边界门禁。

## 备选方案

- **仅在单体外壳上追加几个可替换外壳组件（渐进补丁方案）**：短期改动小，但无法根除 `App.tsx` 巨型 props 钻透、`builtinPluginGatesStore` 假插件门控以及插件无法递归暴露子槽位的结构性瓶颈，最终仍会在核心定制需求增多后被迫返工。否决。
- **直接重新引入上游 `@deepseek-ai/dsh-*` 前端包**：上游包处于快速演进阶段且 API 变动频繁，容易引入高耦合与升级断裂（参见 [ADR 0003](0003-plugin-model-and-events.md) 备选方案）。否决，改为自研同级别能力但由千机完全掌控演进节奏的 `@qianji/client-*` 内核。
- **将全部内置核心插件移至 `plugins/` 目录由 Host 启动期动态编译加载**：会导致冷启动强依赖 Host 连接与多 MB React/CodeMirror/xterm 动态打包耗时，且在无 Host 的离线/浏览器测试模式下不可用。否决，采用 Vite 预编译内置兜底层 + 同名运行时热覆盖方案。
- **彻底移除旧版 `ctx.contributions` 兼容层**：会立即破坏现有全部官方与社区插件。否决，保留薄适配层实现平滑迁移。

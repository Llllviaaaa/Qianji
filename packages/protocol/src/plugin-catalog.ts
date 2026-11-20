/**
 * Authoritative shared metadata catalog of Qianji client extension slots and
 * `@qianji/client` SDK exports, consumed by both the React renderer
 * (`src/lib/clientContributions.ts`), the Host `qianji_inspect` introspection
 * tool (`packages/host/src/plugin-dev-tools.ts`), and guardrail tests so
 * frontend and backend slot schemas can never drift apart.
 */

export interface ClientSlotMetadata {
  readonly name: string;
  readonly slot: string;
  readonly method: string;
  readonly registerMethod: string;
  readonly summary: string;
  readonly options: readonly string[];
  readonly contextFields: readonly string[];
  readonly contextProps: readonly string[];
  readonly note?: string;
}

function defineSlot(entry: {
  name: string;
  method: string;
  summary: string;
  options: readonly string[];
  contextFields: readonly string[];
  note?: string;
}): ClientSlotMetadata {
  return {
    name: entry.name,
    slot: entry.name,
    method: entry.method,
    registerMethod: entry.method,
    summary: entry.summary,
    options: entry.options,
    contextFields: entry.contextFields,
    contextProps: entry.contextFields,
    ...(entry.note === undefined ? {} : { note: entry.note }),
  };
}

export const CLIENT_SLOT_CATALOG: readonly ClientSlotMetadata[] = [
  defineSlot({
    name: "pages",
    method: "ctx.contributions.registerPage",
    summary: "左侧栏顶部主导航入口与主舞台全屏功能页",
    options: ["id", "label", "icon?", "order?", "render(ctx)"],
    contextFields: ["cwd", "sessionFile"],
  }),
  defineSlot({
    name: "leftSidebar",
    method: "ctx.contributions.registerLeftSidebar",
    summary: "左侧栏会话列表下方（底部「设置」按钮上方）自定义常驻分区",
    options: ["id", "order?", "render(ctx)"],
    contextFields: ["cwd", "sessionFile"],
  }),
  defineSlot({
    name: "rightWorkbenchTabs",
    method: "ctx.contributions.registerRightWorkbenchTab",
    summary: "右侧工作台独立标签页（可通过 sidebar_open / openWorkbenchTab 聚焦）",
    options: ["id", "label", "icon?", "order?", "render(ctx)"],
    contextFields: ["cwd", "sessionFile"],
  }),
  defineSlot({
    name: "bottomPanelTabs",
    method: "ctx.contributions.registerBottomPanelTab",
    summary: "底部终端/输出抽屉并列标签页",
    options: ["id", "label", "icon?", "order?", "render(ctx)"],
    contextFields: ["cwd", "sessionFile"],
  }),
  defineSlot({
    name: "topbarActions",
    method: "ctx.contributions.registerTopbarAction",
    summary: "主舞台右上角工具栏紧凑操作按钮",
    options: ["id", "order?", "render(ctx)"],
    contextFields: ["cwd", "sessionFile"],
  }),
  defineSlot({
    name: "composerToolbar",
    method: "ctx.contributions.registerComposerToolbar",
    summary: "输入栏左下角工具栏胶囊/按钮",
    options: ["id", "order?", "render(ctx)"],
    contextFields: ["cwd", "sessionFile", "variant"],
  }),
  defineSlot({
    name: "composerStatus",
    method: "ctx.contributions.registerComposerStatus",
    summary: "输入栏右下角模型选择器两侧遥测微件（before-model / after-model）",
    options: ["id", "position?", "order?", "render(ctx)"],
    contextFields: ["cwd", "sessionFile", "variant"],
  }),
  defineSlot({
    name: "composerBanners",
    method: "ctx.contributions.registerComposerBanner",
    summary: "输入栏顶部上下文提示条",
    options: ["id", "order?", "render(ctx)"],
    contextFields: ["cwd", "sessionFile", "variant"],
  }),
  defineSlot({
    name: "overlays",
    method: "ctx.contributions.registerOverlay",
    summary: "全局浮层/模态框槽位（根层默认 pointer-events: none 防误遮挡，交互子弹窗设 pointer-events: auto）",
    options: ["id", "order?", "render(ctx)"],
    contextFields: ["cwd", "sessionFile"],
    note: "Overlay root forces pointer-events: none; set pointer-events: auto on interactive modal children.",
  }),
  defineSlot({
    name: "message.actions",
    method: "ctx.contributions.registerMessageAction",
    summary: "单条对话消息（用户/助手）底部悬浮操作栏扩展按钮",
    options: ["id", "role?", "order?", "render(ctx)"],
    contextFields: ["cwd", "sessionFile", "message", "contentText"],
  }),
  defineSlot({
    name: "message.toolRenderer",
    method: "ctx.contributions.registerToolRenderer",
    summary: "按工具名或前缀通配（如 sqlite_*）匹配自定义对话流卡片视图",
    options: ["id", "toolNames", "order?", "render(ctx)"],
    contextFields: ["cwd", "sessionFile", "call", "state"],
  }),
  defineSlot({
    name: "file.viewer",
    method: "ctx.contributions.registerFileViewer",
    summary: "按扩展名或 MIME 类型注册右侧工作台自定义文件预览器（如 SQLite、XLSX、3D、流程图）",
    options: ["id", "label?", "extensions?", "mimeTypes?", "order?", "render(ctx)"],
    contextFields: ["cwd", "sessionFile", "path", "content", "isBinary", "mimeType", "dataBase64", "size"],
  }),
  defineSlot({
    name: "status.bar",
    method: "ctx.contributions.registerStatusBarItem",
    summary: "工作区底部全局状态栏微件（支持 left / right 对齐）",
    options: ["id", "align?", "order?", "render(ctx)"],
    contextFields: ["cwd", "sessionFile"],
  }),
  defineSlot({
    name: "home.quickActions",
    method: "ctx.contributions.registerHomeQuickAction",
    summary: "新任务首页快捷启动指令胶囊",
    options: ["id", "label?", "icon?", "prompt?", "order?", "onSelect?(ctx)", "render?(ctx)"],
    contextFields: ["cwd", "sessionFile", "prefillComposer", "sendPrompt"],
  }),
  defineSlot({
    name: "slashInterceptors",
    method: "ctx.contributions.registerSlashInterceptor",
    summary: "客户端斜杠命令（/xxx）前端优先拦截器",
    options: ["id", "order?", "onSlashCommand(name, rawArgs, ctx)"],
    contextFields: ["name", "rawArgs", "cwd", "sessionFile"],
  }),
  defineSlot({
    name: "rewindHandlers",
    method: "ctx.contributions.registerRewindHandler",
    summary: "会话消息检查点回退与时间轴拦截器",
    options: ["id", "order?", "onRewindMessage(message)", "onOpenTimeline?()"],
    contextFields: ["message"],
  }),
  defineSlot({
    name: "settings.pages",
    method: "ctx.contributions.registerSettingsPage",
    summary: "设置中心左侧导航「扩展」分组下的独立设置页",
    options: ["id", "label", "icon?", "heading?", "subtitle?", "order?", "wide?", "render(ctx)"],
    contextFields: ["cwd", "sessionFile", "page", "closeSettings"],
    note: "Open it from code with openSettingsPage(id) from @qianji/client.",
  }),
  defineSlot({
    name: "settings.sections",
    method: "ctx.contributions.registerSettingsSection",
    summary: "追加到内置设置页（general / appearance / providers / plugins）或插件设置页底部的卡片分区",
    options: ["id", "page", "title?", "order?", "render(ctx)"],
    contextFields: ["cwd", "sessionFile", "page", "closeSettings"],
  }),
  defineSlot({
    name: "menus",
    method: "ctx.contributions.registerMenuItem",
    summary: "窗口菜单栏（文件/编辑/视图/帮助/工具）、线程「…」菜单、侧边栏项目菜单与会话右键菜单、文件右键菜单的命令项",
    options: ["id", "location", "label", "icon?", "shortcut?", "order?", "danger?", "when?(ctx)", "disabled?(ctx)", "onSelect(ctx)"],
    contextFields: ["menubar.* / thread.more: cwd, sessionFile", "sidebar.project: workspace, sessionFiles", "sidebar.thread: cwd, sessionFile, title", "file.context: cwd, sessionFile, path, absolutePath, line?"],
    note: "location: menubar.file | menubar.edit | menubar.view | menubar.help | menubar.tools | thread.more | sidebar.project | sidebar.thread | file.context. The 工具 menu appears only while it has items.",
  }),
  defineSlot({
    name: "keybindings",
    method: "ctx.contributions.registerKeybinding",
    summary: "全局键盘快捷键（不会覆盖内置快捷键或输入框、编辑器、终端内已处理的按键）",
    options: ["id", "key", "label?", "order?", "allowInEditable?", "run(ctx)"],
    contextFields: ["cwd", "sessionFile"],
  }),
  defineSlot({
    name: "markdown.codeBlock",
    method: "ctx.contributions.registerCodeBlockRenderer",
    summary: "按围栏语言（如 ```plantuml）接管对话 Markdown 代码块渲染",
    options: ["id", "languages", "order?", "render(ctx)"],
    contextFields: ["cwd", "sessionFile", "language", "code"],
  }),
  defineSlot({
    name: "themes",
    method: "ctx.contributions.registerTheme",
    summary: "动态外观配色皮肤与桌宠主题贡献",
    options: ["id", "label", "mode", "scope?", "sourcePath?", "palette?"],
    contextFields: ["AppearanceThemeDefinition"],
  }),
] as const;

export const CLIENT_SDK_EXPORTS = {
  hooks: [
    "useActiveSession()",
    "useActiveWorkspace()",
    "useAppearanceTheme()",
    "usePluginConfig<T>(pluginId, defaults?)",
    "useHostRpcQuery<T>(method, params?, options?)",
  ],
  actions: [
    "callHostRpc<T>(method, params?)",
    "openWorkbenchTab(tabId)",
    "openWorkspaceFile(path, line?)",
    "sendChatPrompt(text, options?)",
    "showToast(message, kind?)",
    "openSettingsPage(pageId?)",
    "openPluginPage(pageId)",
    "getActiveSessionSnapshot()",
    "subscribeSessionActivity(listener)",
  ],
} as const;

export type CoreSlotKind = "single" | "list" | "keyed" | "chain";

export type CoreSlotScope = "root" | "session-maybe" | "session";

export interface CoreSlotMetadata {
  readonly id: string;
  readonly kind: CoreSlotKind;
  readonly scope: CoreSlotScope;
  readonly parent: string | null;
  readonly defaultOwner: string;
  readonly replaceable: boolean;
  readonly summary: string;
  readonly note?: string;
}

function coreSlot(
  id: string,
  kind: CoreSlotKind,
  scope: CoreSlotScope,
  parent: string | null,
  defaultOwner: string,
  replaceable: boolean,
  summary: string,
  note?: string,
): CoreSlotMetadata {
  return { id, kind, scope, parent, defaultOwner, replaceable, summary, ...(note === undefined ? {} : { note }) };
}

/**
 * Authoritative hierarchical core slot tree exposed by the ADR 0023 frontend
 * microkernel (`@qianji/client-slots`) and built-in core plugins, consumed by
 * `qianji_inspect` and plugin conflict-resolution tooling.
 */
export const CORE_SLOT_CATALOG: readonly CoreSlotMetadata[] = [
  coreSlot("root", "single", "root", null, "core-shell", true, "应用微内核唯一根槽位，承载菜单栏、侧边栏、主舞台、工作台、状态栏、设置弹窗与全局浮层"),
  coreSlot("shell.menubar", "single", "root", "root", "core-shell", true, "顶部自定义窗口标题栏与文件/编辑/视图/帮助/工具菜单栏"),
  coreSlot("shell.sidebar", "single", "root", "root", "core-sidebar", true, "左侧主导航与会话列表侧边栏"),
  coreSlot("shell.sidebar.header", "list", "root", "shell.sidebar", "core-sidebar", false, "左侧栏顶部新建会话与工作区切换操作区"),
  coreSlot("shell.sidebar.nav", "list", "root", "shell.sidebar", "core-sidebar", false, "左侧栏功能页导航入口列表（内置中心页与插件全屏页）"),
  coreSlot("shell.sidebar.sessions", "single", "root", "shell.sidebar", "core-sidebar", true, "左侧栏工作区分组会话列表树"),
  coreSlot("shell.sidebar.footer", "list", "root", "shell.sidebar", "core-sidebar", false, "左侧栏底部常驻分区与设置入口区"),
  coreSlot("shell.topbar", "single", "session-maybe", "root", "core-shell", true, "主舞台顶部标题、分支/模型摘要与操作栏"),
  coreSlot("shell.topbar.actions", "list", "session-maybe", "shell.topbar", "core-shell", false, "主舞台右上角紧凑工具栏扩展操作项"),
  coreSlot("shell.stage", "chain", "session-maybe", "root", "core-shell", true, "主舞台路由选择器链（首页/对话流/内置中心页/插件全屏页）"),
  coreSlot("stage.home", "single", "root", "shell.stage", "core-home", true, "新任务欢迎首页视图"),
  coreSlot("stage.home.quickActions", "list", "root", "stage.home", "core-home", false, "新任务首页快捷启动指令胶囊列表"),
  coreSlot("stage.hub", "keyed", "root", "shell.stage", "core-hubs", true, "内置中心管理页按键路由槽位（models/skills/mcp/plugins/schedules）"),
  coreSlot("stage.pluginPage", "keyed", "root", "shell.stage", "core-shell", true, "插件自定义全屏功能页按键路由槽位"),
  coreSlot("stage.conversation", "single", "session", "shell.stage", "core-conversation", true, "绑定具体 sessionId 的对话主舞台容器（主对话与 side-chat 共享槽位树）"),
  coreSlot("conversation.header", "list", "session", "stage.conversation", "core-conversation", false, "对话流顶部会话状态横幅与扩展条"),
  coreSlot("conversation.messages", "single", "session", "stage.conversation", "core-conversation", true, "对话消息虚拟滚动列表与流式输出区"),
  coreSlot("conversation.message.item", "single", "session", "conversation.messages", "core-conversation", true, "单条用户/助手消息气泡渲染器"),
  coreSlot("conversation.message.actions", "list", "session", "conversation.message.item", "core-conversation", false, "单条消息底部悬浮操作按钮列表"),
  coreSlot("conversation.message.toolRenderer", "keyed", "session", "conversation.message.item", "core-conversation", true, "按 toolName（含前缀通配）路由的自定义工具调用卡片"),
  coreSlot("conversation.message.codeBlock", "keyed", "session", "conversation.message.item", "core-conversation", true, "按围栏语言路由的 Markdown 代码块渲染器"),
  coreSlot(
    "conversation.composer",
    "chain",
    "session",
    "stage.conversation",
    "core-composer",
    true,
    "会话底部输入栏选择器链（支持 overlay: true 无卸载临时接管以保留草稿状态）",
    "Supports overlay takeover without unmounting underlying draft or DOM state.",
  ),
  coreSlot("composer.banners", "list", "session", "conversation.composer", "core-composer", false, "输入框上方上下文/队列提示条列表"),
  coreSlot("composer.toolbar", "list", "session", "conversation.composer", "core-composer", false, "输入框左下角工具按钮列表"),
  coreSlot("composer.status", "list", "session", "conversation.composer", "core-composer", false, "输入框右下角模型选择器两侧状态微件列表"),
  coreSlot("shell.workbench.right", "single", "session-maybe", "root", "core-workbench", true, "右侧分屏工作台容器（平铺布局树、编辑器、审查、预览、副对话与扩展面板）"),
  coreSlot("workbench.panes", "keyed", "session-maybe", "shell.workbench.right", "core-workbench", true, "按 paneId 路由的右侧工作台面板集合"),
  coreSlot("workbench.fileViewer", "keyed", "session-maybe", "workbench.panes", "core-workbench", true, "按文件扩展名或 MIME 类型路由的工作台文件预览器"),
  coreSlot("shell.workbench.bottom", "single", "session-maybe", "root", "core-workbench", true, "底部终端与输出抽屉容器"),
  coreSlot("workbench.bottomTabs", "keyed", "session-maybe", "shell.workbench.bottom", "core-workbench", true, "按 tabId 路由的底部抽屉标签页集合"),
  coreSlot("shell.statusBar", "list", "session-maybe", "root", "core-shell", false, "窗口底部全局状态栏扩展微件"),
  coreSlot("shell.settings", "single", "root", "root", "core-settings", true, "设置中心模态框与页签框架"),
  coreSlot("settings.pages", "keyed", "root", "shell.settings", "core-settings", true, "设置中心独立设置页按键路由槽位"),
  coreSlot("settings.sections", "list", "root", "shell.settings", "core-settings", false, "追加到内置或扩展设置页底部的卡片分区列表"),
  coreSlot(
    "shell.overlays",
    "list",
    "session-maybe",
    "root",
    "core-shell",
    false,
    "全局浮层/模态框槽位（根层强制 pointer-events: none）",
    "Overlay root enforces pointer-events: none; interactive children opt in with pointer-events: auto.",
  ),
] as const;

export interface FrontendServiceMetadata {
  readonly name: string;
  readonly summary: string;
  readonly methods: readonly string[];
  readonly autoDispose: boolean;
  readonly note?: string;
}

/**
 * Authoritative catalog of frontend Cordis services exposed by the ADR 0023
 * client microkernel (`src/kernel/slots`, `src/kernel/runtime`, `src/kernel/services`)
 * for Host `qianji_inspect` introspection.
 */
export const FRONTEND_SERVICE_CATALOG: readonly FrontendServiceMetadata[] = [
  {
    name: "slots",
    summary: "强类型前端槽位树注册、包裹装饰、组件工厂与覆盖选举服务（@qianji/client-slots）",
    methods: ["register(slotKey, registration)", "wrap(slotKey, wrapper)", "registerFactory(factoryKey, definition)", "getEntries(slotKey)", "getActiveOwner(slotKey)", "setOverride(slotKey, pluginId)", "clearOverride(slotKey)"],
    autoDispose: true,
  },
  {
    name: "styles",
    summary: "插件样式注入服务（支持 @layer plugin-ui 作用域样式与 @layer plugin-skin 全局皮肤样式）",
    methods: ["inject(css, key?)", "injectGlobal(css, key?)"],
    autoDispose: true,
  },
  {
    name: "sessionService",
    summary: "多会话目录、Ref-Counted retain 句柄、消息流、流式控制、分支/回退与模型切换服务",
    methods: ["getSnapshot()", "subscribe(listener)", "retain(sessionId, options?)", "newSession(options?)", "switchSession(sessionId)", "renameSession(sessionId, title)", "archiveSession(sessionId, archived?)", "deleteSession(sessionId)", "refreshSessions()"],
    autoDispose: false,
  },
  {
    name: "workspaceService",
    summary: "当前工作区目录、Git 快照/恢复、工作区信任状态与文件读写打开服务",
    methods: ["getSnapshot()", "subscribe(listener)", "selectWorkspace(path)", "pickFolder()", "refreshGit()", "restoreGitFiles(paths)", "listDir(path?)", "readFile(path)", "openExternal(path)", "openInFileManager(path)"],
    autoDispose: false,
  },
  {
    name: "composerService",
    summary: "输入草稿、预填、附件列表、排队消息与斜杠拦截/回退控制器服务",
    methods: ["getSnapshot()", "subscribe(listener)", "setDraft(text)", "prefill(text)", "consumePrefill()", "addAttachments(items)", "removeAttachment(id)", "clearAttachments()", "moveQueuedMessage(id, delta)", "removeQueuedMessage(id)", "steerQueuedMessage(id)"],
    autoDispose: true,
  },
  {
    name: "workbenchService",
    summary: "右侧/底部工作台显隐、平铺分屏树、打开文件编辑器、代码审查、网页预览与终端控制服务",
    methods: ["getSnapshot()", "subscribe(listener)", "openPane(paneId)", "closePane(paneId)", "togglePane(paneId)", "activateExtensionPane(paneId)", "swapOrDockPanes(sourceId, targetId, position)", "setSplitNodeRatio(nodeId, ratio)", "setTwoPaneDirection(direction)", "toggleMaximizePane(paneId?)", "toggleInspector()", "toggleBottom()", "openFile(path, line?)", "openReview()", "openPreview()", "openSummary()", "bumpTerminalCreateNonce()", "toggleFileDrawer()"],
    autoDispose: false,
  },
  {
    name: "navigationService",
    summary: "主舞台路由、导航历史、设置中心、左侧栏折叠宽度、Toast 与通知中心及审批队列服务",
    methods: ["getSnapshot()", "subscribe(listener)", "navigate(route)", "goBack()", "goForward()", "openSettings(page?)", "closeSettings()", "openPluginPage(pageId)", "setHubView(view)", "setDraftMode(enabled)", "showToast(message, kind?)", "dismissToast(id)", "markNotificationRead(id)", "markAllNotificationsRead()", "dismissNotification(id)", "answerExtension(requestId, value)"],
    autoDispose: false,
  },
  {
    name: "themeService",
    summary: "外观主题目录、深浅色方案、强调色、界面缩放与对话密度管理服务",
    methods: ["getSnapshot()", "subscribe(listener)", "registerTheme(definition)", "setTheme(themeId)", "setTranscriptDensity(density)", "cycleTranscriptDensity()", "setUiScale(scale)"],
    autoDispose: true,
  },
  {
    name: "shortcutService",
    summary: "全局快捷键注册与优先级分发服务（保留 Safe Mode 快捷键不可被覆盖）",
    methods: ["register(binding)", "list()", "dispatch(event)"],
    autoDispose: true,
  },
  {
    name: "menuService",
    summary: "窗口菜单栏、线程菜单、侧边栏菜单与文件右键菜单统一注册表服务",
    methods: ["register(item)", "list(location)", "execute(id, ctx)"],
    autoDispose: true,
  },
  {
    name: "rpcService",
    summary: "Harness Host JSON-RPC 调用、服务端通知订阅与连接状态监控服务",
    methods: ["call(method, params?)", "onNotification(method, handler)", "getHostStatus()", "subscribeHostStatus(listener)", "reconnect()"],
    autoDispose: true,
  },
  {
    name: "localeService",
    summary: "可选多语言命名空间词典与类型化 t() 绑定服务",
    methods: ["registerNamespace(namespace, messages)", "getLocale()", "setLocale(locale)", "bind(namespace)"],
    autoDispose: true,
  },
  {
    name: "resourcesService",
    summary: "按 URI 协议注册与订阅前端资源句柄的扩展服务",
    methods: ["registerProtocol(scheme, handler)", "read(address)", "subscribe(address, listener)"],
    autoDispose: true,
  },
] as const;

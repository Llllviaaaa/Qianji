# @qianji/intelligent-ui

内置 Intelligent UI 插件（`qianji-intelligent-ui`），让模型在对话流中直接渲染与更新交互式界面组件。

- **`render_ui` 与 `update_ui` 工具**：支持按会话分支自动追踪版本历史（`v1`、`v2`……），`spec` 与 `html` 载荷上限均为 96 KB（`MAX_PAYLOAD_BYTES = 96 * 1024`）；变更记录为会话 `custom` 事件（命名空间 `qianji-intelligent-ui`，并向下兼容读取 `pid-intelligent-ui`）。
- **双渲染引擎**：
  - `engine: "declarative"` — 原生声明式组件树（`controls`、`stats`、`chart`、`table`、`tabs`、`form`、`callout`、`checklist`），支持本地响应式状态与安全公式绑定；
  - `engine: "html"` — 隔离的 `<iframe sandbox="allow-scripts">` 沙箱（禁用网络 `connect-src 'none'`），内置 `--pi-*` 主题 CSS tokens（如 `--pi-bg`、`--pi-surface`、`--pi-surface-soft`、`--pi-text`、`--pi-muted`、`--pi-border`、`--pi-accent`）及 `window.piUI` 通信桥接（如 `window.piUI?.sendPrompt(text)`）。
- **系统提示词集成**：仅在 `render_ui` 工具注册时注入 `intelligent-ui` 提示词片段，在 Settings → Plugins 禁用后自动卸载。
- **`/ui` 斜杠指令与 RPC**：`/ui` 或 `/ui list` 列出当前分支的组件，`/ui clear` 写入清除事件以清空当前分支的组件历史索引，`/ui <需求描述>` 触发组件生成；同时注册 `intelligentUi.list` RPC 方法按 `sessionId` 查询各组件全部版本及最新版本。

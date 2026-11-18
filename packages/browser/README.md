# @qianji/browser

内置浏览器工具：通过 Chrome DevTools 协议驱动 Edge、Chrome 或 Chromium，见 [ADR 0012](../../docs/adr/0012-browser.md)。

- 工具（共 11 个，统一归入 `group: "browser"` 且 `deferred: true`，需通过 `activate_tools` 激活）：`browser_navigate`、`browser_inspect`、`browser_screenshot`、`browser_click`、`browser_type`、`browser_press`、`browser_scroll`、`browser_select`、`browser_wait`、`browser_tabs`、`browser_upload`。
- 每个 agent 会话各自拥有一个浏览器实例（`driver.ts` 接收工作区、profile 目录和可执行文件路径），首次使用时启动；上传与下载限制在该会话目录内；空闲 `idleMinutes`（默认 10 分钟）后自动关闭，页面变化通过 `{ type: "browser" }` 实时增量（`session.delta`）通知前端。
- 只读会话中拒绝交互操作；其余情况下交互操作需通过 `ui.confirm` 确认，除非会话为 `full-access` 或 `confirmActions` 为 `false`。
- 注册 `/browser-diagnose` 斜杠指令，检查本机检测到的浏览器可执行文件及当前配置状态。

配置（`Config` / `harness.json` 的 `browser` 段）：`{ enabled?, headless?, confirmActions?, profileDir?, executable?, idleMinutes? }`。

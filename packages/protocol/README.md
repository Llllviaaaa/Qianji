# @qianji/protocol

前端（`src/`）与 Harness Host 之间的共享协议与安全契约，按 [ADR 0002](../../docs/adr/0002-client-protocol.md) 实现。渲染器对 `@qianji/*` 的依赖只允许导入此包，它是前后端及桌面配置类型的唯一来源。

## 模块结构

| 模块 | 说明 |
|---|---|
| `src/version.ts` | `PROTOCOL_VERSION`（`"1.0"`）、`parseProtocolVersion`、`isCompatibleProtocol`：主次版本号解析与兼容判断 |
| `src/jsonrpc.ts` | `decodeMessage`、`success`、`failure`、`isRequest`/`isNotification`/`isResponse`、`ErrorCode`：JSON-RPC 2.0 帧信封解码与标准错误码 |
| `src/handshake.ts` | `SUBPROTOCOL`（`"qianji.v1"`）、`clientSubprotocols`、`readOfferedSubprotocols`、`InitializeParams`、`InitializeResult`：借助 `Sec-WebSocket-Protocol` 携带 token 的连接握手 |
| `src/methods.ts` | 核心 RPC 方法与通知契约：`host.info`、`provider.*`/`model.*`、`session.*`/`session/event`/`session/delta`、`ui.*`/`ui/request`、`permission.*`、`plan.*`、`checkpoint.*`、`mcp.*`/`mcp/changed`、`usage.summary`、`llm.complete`、`schedule.*`/`schedule/task`（并重新导出 `plugin-methods.ts` 与 `feature-methods.ts`） |
| `src/plugin-methods.ts` | 动态插件与工作区信任契约（[ADR 0016](../../docs/adr/0016-dynamic-plugins-and-hmr.md)）：`PluginInfo`、`PluginTier`、`PluginStatus`、`CLIENT_SHARED_EXTERNALS`、安装/更新/重载/配置/前端报错及 `plugin/changed`、`workspace/trustChanged` 通知 |
| `src/feature-methods.ts` | 斜杠命令（`command.*`/`command/changed`）、记忆与技能管理（`memory.*`、`skill.*`）、沙箱配置生成（`SandboxGenerateConfigParams`）与原生工作台联动（`WorkbenchOpenParams`、`workbench/open`、`WorkbenchPreviewUrlResult`） |
| `src/app-settings.ts` | 跨桌面端 Rust（`src-tauri/src/config.rs`）、Host（`packages/host/src/desktop-settings.ts`）与 React 前端（`src/types.ts`）的三端统一 `AppSettings` 类型、`DEFAULT_APP_SETTINGS` 与 `APP_SETTINGS_FIELD_NAMES` |
| `src/plugin-catalog.ts` | 客户端 `<PluginSlot>` 扩展槽位目录 `CLIENT_SLOT_CATALOG` 与 `@qianji/client` SDK 导出清单 `CLIENT_SDK_EXPORTS`，供前端与 `qianji_inspect` 共享 |
| `src/redact.ts` | `redactSensitiveText`：在日志或错误输出前脱敏 API Key、Bearer Token 与常见凭据字段 |
| `src/self-guard.ts` | `inspectSelfKillCommand` / `isSelfKillCommand`：检测并拦截会误杀 `qianji` / `qianji-harness` 或受保护宿主 PID 的 Shell / PowerShell / CMD / WMI 自杀命令 |

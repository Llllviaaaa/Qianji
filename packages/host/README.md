# @qianji/host

Harness Host 的 Cordis 根，见 [ADR 0001](../../docs/adr/0001-harness-host-process.md) 和 [ADR 0003](../../docs/adr/0003-plugin-model-and-events.md)。

`createHost({ version, dataDir, plugins })` 会创建根 `Context`。`start()` 先装载内置服务，再按顺序装载插件；`stop()` 会释放根 fiber，所有插件的副作用随之回收。

## 服务

| 键 | 类 | 说明 |
|---|---|---|
| `hostInfo` | `HostInfo` | Host 版本、协议版本、数据目录、启动时间 |
| `webServer` | `WebServer` | 只监听本机回环地址 `127.0.0.1` 的 HTTP 服务和路由表；校验页面 Origin 并处理 CORS |
| `rpc` | `RpcGateway` | `/rpc` 上的 JSON-RPC 2.0 网关（[ADR 0002](../../docs/adr/0002-client-protocol.md)）：校验 token、处理 `initialize`、`host.info`、`host.ping`；插件通过 `ctx.rpc.method()` 注册方法，通过 `broadcast()` 推送通知 |

原生工作台插件 `qianji-workbench`（插件 id `"workbench"`，`src/workbench-rpc.ts`）提供 Agent `sidebar_open` 工具、`workbench.open` 与 `workbench.previewUrl` RPC 方法，向统一前端广播 `workbench/open` 通知，并在 `webServer` 挂载能力令牌静态路由 `/preview/<cap>/<path>` 安全服务工作区预览文件。

## 动态插件、开发工具与分层覆盖

`PluginManager`（`src/plugin-manager.ts`，见 [ADR 0016](../../docs/adr/0016-dynamic-plugins-and-hmr.md)）统一管理三层插件来源（`workspace` > `user` > `builtin`）：

- **内置层（`builtin`）**：由 `builtinPluginDefinitions`（`src/agent-plugins.ts`）与只读 `bundled-plugins/` 目录（开发态对应仓库根 `plugins/*`，打包后为 `resources/harness/bundled-plugins`）构成，按拓扑依赖排序加载、逆序卸载；其中 `web-server` 与 `rpc-gateway` 标记 `canDisable: false` 不可停用。
- **用户全局层（`user`）**：`<dataDir>/plugins/<dir>/` 与 `<dataDir>/plugins.json`（支持 `local` 目录链接/复制、`.tgz`/`.zip` 归档、`git` 仓库与 `npm` 包安装；同 `id` 自动覆盖内置版本，移除后回退）。
- **工作区项目层（`workspace`）**：`<workspace>/.qianji/plugins/<dir>/`，受 `<dataDir>/trusted-workspaces.json` 显式信任门禁保护，并在独立子作用域 `WorkspacePluginScope` 中按工作区隔离挂载。
- **客户端分发与延迟 HMR**：通过 `/plugins/<id>/client.js`、`plugin.clientBundle` 与 `/plugins/<id>/assets/*` 按内容哈希 `ETag` 分发；`watch` 模式由 `PluginWatcherController`（`src/plugin-watchers.ts`）监听文件变化，若当前存在活跃的 `AgentLoop` 运行（`agent/before-start` 至 `agent/settled` 或 `agents.isBusy()`）则暂缓重载，待运行结束后防抖刷新（`plugin/changed`），并在失败时执行 Fiber 级故障回滚。
- **Agent 插件开发工具（`src/plugin-dev-tools.ts`）**：内置免审只读自省工具 `qianji_inspect` 与延迟加载工具 `plugin_manager`（`deferred: true, group: "plugin_dev"`），同时导出 `scaffoldPluginFiles` 与 `verifyPluginDirectory` 供脚手架生成与离线预检使用。

## 信任模型与进程防护

依据 [ADR 0017](../../docs/adr/0017-plugin-trust-model.md)，**启用的插件即完全信任**：Host 插件与 Host 共用同一进程与事件循环，无运行期沙箱或能力白名单，插件清单中也没有 `permissions` 字段；Fiber 隔离仅兜底同步/异步异常与编译错误，无法隔离恶意行为或阻塞事件循环的同步死循环。

- `src/crash-guard.ts`：捕获全局 `uncaughtException` 与 `unhandledRejection`（含启动期失败），同步脱敏写入 `<dataDir>/logs/host-YYYY-MM-DD.log` 与 `host-crashes.jsonl`；可按调用栈归因外部插件异常并在高频风暴时自动熔断隔离该插件。
- `src/stall-watch.ts`：每 500 ms 采样一次事件循环调度延迟，单次阻塞 ≥ 2000 ms（且低于 5 分钟系统休眠阈值）时在日志记录 `event loop blocked for <n>ms`。

## 进程与无头模式

`src/bin.ts` 是可执行文件的入口，`scripts/prepare-harness-host.mjs` 把它打包成 `src-tauri/resources/harness/qianji-harness.exe`：

```text
qianji-harness --data-dir <dir> [--port <n>] [--page-origin <origin>]... [--exit-with-stdin]
qianji-harness run [--data-dir <dir>] [--cwd <dir>] [--model <provider>/<model>] [--effort <level>] [--permission <mode>] [--session <id>] [--json] <prompt...>
```

- **常驻服务模式**：token 从环境变量 `QIANJI_HARNESS_TOKEN` 读取，未设置时会自动生成并打印到 stderr；开始监听后 stdout 只输出一行 `{"port": n}`，日志写到 stderr 与 `<dataDir>/logs/`。
- **无头 CLI 模式（`src/headless.ts`）**：`qianji-harness run` 不启动窗口与 RPC，单轮运行后直接退出（默认权限取 `--permission`、`harness.json` 的 `defaultPermission` 或 `workspace-write`，需要交互确认的工具会直接拒绝）；正文流式输出到 stdout（`--json` 输出 JSONL 会话事件），工具活动输出到 stderr。
- 浏览器开发时，用 `node scripts/prepare-harness-host.mjs --bundle-only` 打包，然后执行 `node node_modules/.cache/qianji-harness-host/host.mjs --data-dir <dir> --port 47100 --page-origin http://localhost:1420`。

# @qianji/tool-bash

shell 工具与受管后台进程：在会话的 cwd 中执行命令，返回合并后的 stdout 与 stderr（前台只保留最后 2000 行或 50 KB，运行中内存缓冲上限 1 MB）。

## Shell 选择与执行

- 工具名默认为 `bash`：Windows 上使用 Git Bash（不会选中 WSL 的 `System32\bash.exe`），其他平台使用 `/bin/bash`（回退 `/bin/sh`）。
- Windows 上找不到 Git Bash，或 `Config.shell` 指向 `pwsh.exe` / `powershell.exe` 时，改为注册 `powershell` 工具（[ADR 0021](../../docs/adr/0021-powershell-fallback.md)）：
  - 优先使用 `pwsh.exe`（PowerShell 7），否则使用 Windows 自带的 PowerShell 5.1（`powershell.exe`）。
  - 命令以 `-NoLogo -NoProfile -NonInteractive -EncodedCommand`（UTF-16LE Base64）传入，脚本开头将 `[Console]::OutputEncoding` 设为 UTF-8；5.1 上追加退出码修正，避免原生命令 stderr 重定向后被误判失败。
  - 工具描述会提示模型当前无 bash 并给出 PowerShell 语法示例；用哪种 shell 在插件加载时决定（新装 Git Bash 需重载插件切换）。
- 工具声明 `timeoutMs: 0`（不受 `@qianji/tool-guards` 通用超时限制），由自身 `timeout` 参数控制时长（默认 120 秒，上限受 `maxTimeoutSeconds` 控制，默认 600 秒）；超时或中止时结束整个进程树，并在执行前运行自杀指令检查（`inspectSelfKillCommand`）。
- **截断落盘与实时进度**：配置 `Config.spillDir` 时，被截断的前台完整输出会写入 `<spillDir>/<safeSessionId>/<safeId>.log`（`spillTruncatedOutput`），并在提示文本和 `details.spillPath` 中返回路径；同时通过 `env.onProgress` 节流推送增量尾部预览（默认间隔 100 ms、单次上限 4 KB）。

## 后台进程（`bg_process`）

- `bash` / `powershell` 支持 `background: true` 与 `waitMs`（`100`–`30000` ms，默认 `1500` ms 初始等待窗口），启动后自动为当前会话激活延迟工具 `bg_process`（`deferred: true`、`group: "process"`，[ADR 0022](../../docs/adr/0022-agent-capability-enhancements.md)）。
- `bg_process` 支持 `list`、`logs`（支持基于 `readByteOffset` 游标的 `incremental: true` 增量读取与 `tailLines`，默认 200 行）、`wait`（`50`–`120000` ms，默认 `10000` ms，超时或中止不杀进程）和 `stop`。
- 每个会话最多并发 8 个运行中后台进程（最多保留 16 条已退出记录），单进程维护 1 MB 环形日志缓冲，严格按 `sessionId` 隔离；在 `session/deleted`、`session/unloaded`、子会话 `agent/settled` 及插件卸载时自动终止并回收。

## 沙箱与配置

- 提供 `BashSandbox` 服务（`ctx.bashSandbox`，`enabled` 默认 `true`）：当 `Config.sandbox === true` 或 `ctx.bashSandbox?.enabled === true` 时，清洗敏感环境变量并将 `TMP`/`TEMP`/`TMPDIR` 重定向至 `<cwd>/.qianji/sandbox-tmp`（`buildSandboxedEnv`），在 Windows Bun 下通过 `bun:ffi` 绑定 Job Object（`KILL_ON_JOB_CLOSE` 与 `ACTIVE_PROCESS` 上限 32）。
- 自注册 RPC 方法 `sandbox.generateConfig`：支持生成 Windows Sandbox 配置（`kind: "wsb"` 写入 `.qianji/sandbox.wsb`）或 Dev Container 配置（`kind: "devcontainer"` 写入 `.devcontainer/devcontainer.json`，若已存在且未传 `overwrite: true` 则写入 `.qianji/devcontainer.generated.json`）。

配置：`{ shell?, maxTimeoutSeconds?, sandbox?, spillDir? }`。

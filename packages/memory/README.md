# @qianji/memory

本地记忆 2.0：双层 Markdown 记忆，见 [ADR 0009](../../docs/adr/0009-feature-plugins.md) 与 [ADR 0022](../../docs/adr/0022-agent-capability-enhancements.md)。

## 双层记忆与按需索引

- **双层作用域（`scope: "user" | "project"`）**：
  - `user` 层：全局记忆 `<dataDir>/memory.md`（由 `file` 指定），注入系统提示词 `memory` 片段（`<memory>`）。
  - `project` 层：项目记忆 `<cwd>/.qianji/memory.md`（读取时若不存在则回退读取旧路径 `<cwd>/.pid/memory.md`，写入统一落盘至 `<cwd>/.qianji/memory.md`），注入系统提示词 `project-memory` 片段（`<project-memory>`）。受 `isTrusted?.(cwd)` 工作区信任门禁约束，未信任工作区不注入项目记忆且拒绝 `scope: "project"` 工具操作。
- **渐进式目录索引**：内容不超过 `inlineMaxChars`（默认 `4000`）时全文内联；超出时自动切换为目录模式（`<memory mode="indexed">` / `<project-memory mode="indexed">`），仅预加载 `#`–`###` 标题、行范围、字符数与首行摘要，引导模型按需检索或切片读取。

## 工具与 RPC

- **`desktop_memory` 工具**（单文件上限 256 KB）：
  - `read`：支持全量读取，或通过 `section` 按标题读取、通过 `offset`/`limit` 按行号分页读取；
  - `search`：按 `query` 关键词检索匹配章节与行号（`read-only` 权限放行）；
  - `append`、`replace`、`upsert_section`、`clear`：写入前校验权限（`read-only` 直接拒绝），非 `full-access` 模式下生成 Unified Diff 并经 `ui.confirm` 用户确认后写入。
- **RPC 接口**（注入 `rpc` 服务时自动注册）：`memory.get`、`memory.set`、`memory.delete`、`memory.export`。

## 配置（`Config`）

`{ file, userEnabled?, projectEnabled?, inlineMaxChars?, isTrusted? }`

- `file`：全局记忆文件路径，Host 传入 `<dataDir>/memory.md`。
- `userEnabled` / `projectEnabled`：分别控制是否启用全局 `<memory>` 与项目 `<project-memory>` 注入（默认均为 `true`；仅当两者都为 `false` 时不注册 `desktop_memory`）。Host 在 `harness.json` 中通过 `memory.enabled` 与 `memory.projectEnabled` 配置（未显式指定 `projectEnabled` 时跟随 `memory.enabled`）。
- `inlineMaxChars`：系统提示词内联字符上限，默认 `4000`。
- `isTrusted`：可选工作区信任检查回调 `(cwd: string) => boolean`。

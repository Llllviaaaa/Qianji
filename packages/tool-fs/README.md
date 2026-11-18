# @qianji/tool-fs

内置文件与代码辅助工具：`read`、`write`、`edit`、`ls`、`find`、`grep`，以及延迟只读工具 `diagnostics`（见 [ADR 0022](../../docs/adr/0022-agent-capability-enhancements.md)）。路径相对于会话的 cwd 解析，`~` 指用户主目录。

- **`read`**（`readOnly: true`）：按 1-based `offset` / `limit` 分窗读取文本，单次输出上限为 2000 行或 50 KB（超出时提示继续读取方式）；传入 `hashlines: true` 时在每行前附带 `<line>:<3-hex-fnv1a>| ` 锚点。读取文本时自动剥离前导 UTF-8 BOM（`\uFEFF`）。读取前执行预检（`inspectFileBeforeRead`）：文本上限 32 MB，图片（`.png` / `.jpg` / `.jpeg` / `.gif` / `.webp`）上限 4.5 MB 并以 image block 返回；嗅探前 8192 字节拦截 UTF-16 BOM 与包含 NUL 字节的二进制文件。
- **`write`**：自动创建缺失父目录并创建或覆盖文件。
- **`edit`**：原子化批量应用修改（要么全部生效，要么全部回滚），执行前同样做二进制/UTF-16 预检，写回时保留文件原有的 UTF-8 BOM 与 CRLF 换行，并在 `details.diff` 返回统一 diff：
  - 传统 `{ oldText, newText }`：先精确唯一匹配，失败时回退到 `tolerantPattern`（忽略弯/直引号、Unicode 破折号与空格、行尾空白和 CRLF/LF 差异，缩进与其他字符须一致，仍要求唯一匹配并标注模糊匹配索引）。
  - `HashlineEdit`（`{ anchor, endAnchor?, op?, newText? }`）：支持 `replace`（默认）、`insert_after`、`insert_before`、`delete`；支持基于行内容哈希在 `±20` 行漂移窗口内自动重定位。
- **`ls` / `find` / `grep`**（均为 `readOnly: true`）：跳过 `.git`、`node_modules`、`.hg`、`.svn`。`ls` 最多返回 500 项（目录以 `/` 结尾）；`find` 按 glob 最多返回 1000 个路径；`grep` 跳过二进制文件与 2 MB 以上文件（默认最多 100 条匹配，单行截断 500 字符），优先走 `ripgrep`（`rg`）高速路径，不可用或执行异常时回退至纯 Node 实现（`grepWithNode`）。
- **`diagnostics`**（`deferred: true`、`group: "code_intelligence"`、`readOnly: true`、`timeoutMs: 60_000`）：对指定 `.json` 文件（或默认 `package.json`，跳过 `tsconfig*`）执行严格 JSON 语法校验，并调用工作区本地 `node_modules/typescript/bin/tsc --noEmit` 进行 TypeScript 诊断（内置 45 秒执行超时，默认最多返回 50 条）。

本包不做权限检查，权限由 `tools/pre-execute` 上的插件负责。

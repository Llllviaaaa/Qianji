# @qianji/session-jsonl

把会话日志存成 JSONL 文件：`<dir>/<YYYY-MM>/<sessionId>.jsonl`，第一行是头部，之后每行一条事件（[ADR 0004](../../docs/adr/0004-session-format.md)）。

- **纯 JSONL 持久化与 `summaryCache`**：追加是同步的，事件广播前已经写入；`flush` 时 fsync。未传 `indexFile` 时，`JsonlStorage` 不在同步 `append` 热路径上执行 SQLite/FTS 分词，并在 `list()` 中通过按文件路径索引的 `summaryCache`（比对 `mtimeMs` 与 `size`）避免重复解析未改动的文件（后台全文索引由 `@qianji/session-search-fts` 异步维护）。
- **容错解析**：读取时跳过未知类型、序号不连续的行和崩溃时写了一半的最后一行，并记录警告；更高主版本的文件拒绝打开。
- **可选内联 SQLite FTS5 模式**：传入 `indexFile` 时启用 `SessionSqliteIndex`（WAL 模式 + `sessions_fts` `unicode61` 索引与 `LIKE` 回退），自动与磁盘 `.jsonl` 对账并在损坏或版本变更时重建。

配置：`{ dir, indexFile? }`，Host 传入 `{ dir: "<dataDir>/sessions" }`（不传 `indexFile`）。

## 导出

- **存储与日志工具**：`JsonlStorage`、`walkJsonlFiles`、`parseLog`、`ParsedLog`、`Config`、`apply`。
- **SQLite FTS5 与检索辅助**：`SessionSqliteIndex`、`IndexedSessionInput`、`segmentForFts`、`buildFtsMatchQuery`、`extractSessionSearchBody`、`extractMatchSnippet`。

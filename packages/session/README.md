# @qianji/session

事件溯源的会话日志，见 [ADR 0004](../../docs/adr/0004-session-format.md)、[ADR 0008](../../docs/adr/0008-agent-loop-and-sessions.md) 和 [ADR 0022](../../docs/adr/0022-agent-capability-enhancements.md)。

## 服务

| 键 | 类 | 说明 |
|---|---|---|
| `sessions` | `Sessions` | `create`、`get`、`peek`、`list`、`search`、`delete`、`fork`、`hold`、`sweep`、`openSessions`、`setModel`、`setEffort`、`registerStorage`、`registerSearcher`。每个打开的日志对应一个 `Session`，提供 `append`、`delta`、`state`、`setModel`、`setEffort`、`summary`、`flush` |

- `peek(id)` 仅返回已在内存中的 `Session`，不读取存储；`hold(id)` 维持引用计数防止空闲卸载，无人持有且超过 `idleMs`（默认 `SESSION_IDLE_MS` = 10 分钟）后由 `sweep()` 卸载；`openSessions()` 返回当前内存中会话快照。
- `search(query, options?)` 优先调用通过 `registerSearcher` 注册的外部检索引擎，其次回退到 `storage.search`，最后扫描内存/存储会话。
- 没有注册存储时默认使用 `MemoryStorage`。

## 事件

| 事件 | 方式 | 说明 |
|---|---|---|
| `session/created` | emit | 新建了一个会话 |
| `session/event` | emit | 一条事件已交给存储 |
| `session/delta` | emit | 不落盘的实时进度，带 `liveSeq` |
| `session/flush` | parallel | 存储已 fsync，插件做各自的检查点 |
| `session/unloaded` | emit | 空闲会话从内存卸载（携带 `sessionId`），插件清理缓存 |
| `session/deleted` | emit | 会话日志已删除（携带 `sessionId`），插件清理关联状态 |

## 派生与辅助导出

所有派生与辅助函数均为纯函数，测试可以直接拿 JSONL 夹具断言：

- **分支与状态派生**：`currentBranch`、`deriveState`、`forkEvents`、`compactionPoint`、`slidingCompactionPoint`、`settledSeq`、`activeBranchSummaries`，以及常量 `BRANCH_SUMMARY_PREFIX`、`CONTINUATION_NAMESPACE`（和 `COMPACTION_PREFIX`、`COMPACTION_CONTINUE_SUFFIX`）。
- **摘要、自定义事件与导出**：`summarize`、`sessionMarkdown`、`customEvents`、`latestCustom`。
- **Token 估算**：`estimateEventTokens`（及 `charTokens`，ASCII 字符按 1/4 token、非 ASCII/CJK 字符按 3/4 token 估算，图片块按 256 token 估算）。

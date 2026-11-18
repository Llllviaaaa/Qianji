# @qianji/checkpoints

运行前给 git 工作区拍快照（不动真实的暂存区），以便回退。见 [ADR 0009](../../docs/adr/0009-feature-plugins.md)。

- 在 `agent/before-start` 时拍快照，有效权限为 `read-only` 时跳过。快照记为 `custom` 事件 `qianji-checkpoints`（读取时兼容旧命名空间 `pid-checkpoints`）：`{ userSeq, checkpoint }`。
- 包内直接通过 `ctx.rpc.method` 自注册 `checkpoint.list`、`checkpoint.diff` 和 `checkpoint.restore` RPC 方法（会话运行中调用 `checkpoint.restore` 会返回 `SessionBusy`），并导出 `checkpointsOf`、`checkpointFor`、`takeCheckpoint`、`diffCheckpoint`、`restoreCheckpoint`。
- git 部分（`git.ts`）使用临时 `GIT_INDEX_FILE` 捕获工作区状态并写入 `refs/qianji/checkpoints` 命名空间，最多保留 250 个快照，并在清理时一并回收遗留的 `refs/pidesktop/checkpoints` 旧引用。

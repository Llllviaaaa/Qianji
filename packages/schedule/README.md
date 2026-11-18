# @qianji/schedule

由 Host 执行的定时任务，见 [ADR 0011](../../docs/adr/0011-computer-and-schedule.md)。

- 每次运行在任务目录下新建一个会话，并标记为无人值守（`ui.markUnattended`）：需要用户确认的操作一律拒绝。到超时（`timeoutMinutes`，1–240 分钟，默认 `30`）后中止运行。
- 运行频率支持 `hourly`、`daily`、`weekdays`、`weekly`，按本地时间计算。最多同时运行 `maxConcurrent`（默认 `2`）个任务，调度轮询间隔 `tickMs`（默认 `30_000` ms）。
- 权限模式只能是 `read-only`、`ask` 或 `workspace-write`。
- 任务存在 `<dataDir>/schedules.json`（`tasksFile`），运行记录存在 `<dataDir>/schedule-runs.jsonl`（`runsFile`）。
- **事件与自注册 RPC**：在 Cordis 上发出 `schedule/task`、`schedule/run` 事件；注入 `rpc` 服务时由 `@qianji/schedule` 自行注册 `schedule.list`、`schedule.save`、`schedule.delete`、`schedule.run`、`schedule.cancel`、`schedule.runs` 方法，并将 `schedule/task`（删除时为 `{ id, deleted: true }`，否则 `{ id, task }`）与 `schedule/run` 广播为同名通知。

只有长期运行的 RPC Host 会加载本插件，headless 运行不加载。

# @qianji/agent

agent 的接口，见 [ADR 0008](../../docs/adr/0008-agent-loop-and-sessions.md)。唯一的实现是 `@qianji/agent-loop`。

## 服务

`agents`：`prompt`、`steer`、`followUp`、`abort`、`compact`、`status`、`isBusy?()`、`idle`。运行中再次 `prompt` 抛 `AgentBusyError`，会话没有模型时抛 `NoModelError`；`isBusy?()` 返回是否存在任意运行中的会话。

## 事件

| 事件 | 方式 | 说明 |
|---|---|---|
| `agent/before-start` | serial | 一次运行开始 |
| `agent/turn-start` / `agent/turn-end` | serial | 每一轮的开始和结束 |
| `agent/before-stop` | serial | 运行即将以 `done` 结束前触发（传入 `BeforeStopContext`），返回非空提示词字符串可继续运行 |
| `agent/settled` | parallel | 运行结束，带结果 |

实时进度以 `AgentDelta` 的形式通过 `session/delta` 发出。

# @qianji/computer

Windows computer use，通过桌面端的原生 helper（`<helper> --computer-helper`）实现，见 [ADR 0011](../../docs/adr/0011-computer-and-schedule.md)。

- 工具（共 11 个，统一归入 `group: "computer"` 且 `deferred: true`，需通过 `activate_tools` 激活）：`computer_sources`、`computer_state`、`computer_start`、`computer_stop`、`computer_screenshot`、`computer_inspect`、`computer_click`、`computer_move`、`computer_scroll`、`computer_type`、`computer_key`。
- 每个 agent 会话各自有一个 computer 会话，状态变化通过 `{ type: "computer" }` 实时增量通知前端；`core.ts` 提供会话状态门禁与坐标/元素映射等纯辅助函数。
- 进入控制模式前需要经 `ui.confirm` 确认（除非会话为 `full-access` 或 `confirmActions` 为 `false`）；只读会话不能进入控制模式，且仅屏幕来源（`screen`）允许控制。

配置（`Config` / `harness.json` 的 `computer` 段）：`{ enabled?, helper?, confirmActions? }`。未配置 `helper` 时 Host 会回退读取环境变量 `QIANJI_COMPUTER_HELPER`。

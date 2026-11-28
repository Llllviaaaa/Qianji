import type { PluginInfo, PluginMutationResult } from "@qianji/protocol";
import { pluginClient } from "../../lib/pluginClient";

export function PluginModeScopePills({
  plugin,
  title,
  busy,
  scopeWorkspace,
  onRunTask,
}: {
  readonly plugin: PluginInfo;
  readonly title: string;
  readonly busy: boolean;
  readonly scopeWorkspace?: string;
  readonly onRunTask: (task: { run: () => Promise<PluginMutationResult>; label: string }) => void;
}) {
  if (plugin.canDisable === false) return null;
  return (
    <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginTop: 2 }}>
      {(["agent", "bot"] as const).map((mode) => {
        const active = plugin.enabled && plugin.scopes?.[mode] === true;
        const label = mode === "agent" ? "Agent 工作台" : "Bot 分身";
        return (
          <button
            key={mode}
            type="button"
            disabled={busy || plugin.status === "untrusted"}
            className={`plugin-ghost-btn ${active ? "active" : "muted"}`}
            style={{ height: 24, padding: "0 8px", fontSize: 11.5 }}
            aria-pressed={active}
            onClick={() =>
              onRunTask({
                run: () =>
                  pluginClient.setScope({
                    id: plugin.id,
                    mode,
                    enabled: !active,
                    ...(scopeWorkspace === undefined ? {} : { workspace: scopeWorkspace }),
                  }),
                label: `已${!active ? "开启" : "关闭"} "${title}" 的 ${label} 作用域。`,
              })
            }
          >
            {label}：{active ? "已启用" : "未启用"}
          </button>
        );
      })}
    </div>
  );
}

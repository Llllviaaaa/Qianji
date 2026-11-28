/**
 * Meta Muse & ChatGPT style 4-tier Default Policy + Granular per-action permissions
 * section for a connected Connector (`BotConnectorPermissionSection.tsx`).
 */
import type { ReactElement } from "react";
import { RotateCcw, ShieldCheck } from "lucide-react";
import type {
  BotActionPermissionLevel,
  BotConnectedAppPolicy,
  BotConnectorPolicyTier,
} from "@qianji/protocol";

export interface ConnectorActionRow {
  readonly id: string;
  readonly label: string;
  readonly kind: "read" | "write";
  readonly defaultPerm: BotActionPermissionLevel;
}

const POLICY_TIERS: ReadonlyArray<{ readonly id: BotConnectorPolicyTier; readonly title: string; readonly desc: string }> = [
  { id: "always-ask", title: "始终询问", desc: "读取或更改任何数据前先请求你的确认" },
  { id: "read-only-auto", title: "允许使用只读工具", desc: "读取无需询问，任何修改或外发前需批准" },
  { id: "low-risk-auto", title: "允许使用低风险工具（默认）", desc: "自动执行查询与草拟，外发操作必经「批准」" },
  { id: "strict-read-only", title: "仅只读（停用写操作）", desc: "严禁一切写入与对外发送接口" },
];

export function BotConnectorPermissionSection({
  entryId,
  readOnlyOnly,
  policyTier,
  appPolicy,
  actionRows,
  onSelectTier,
  onUpdateActionPerm,
  onResetDefaults,
  onToggleBackgroundSync,
}: {
  readonly entryId: string;
  readonly readOnlyOnly: boolean;
  readonly policyTier: BotConnectorPolicyTier;
  readonly appPolicy?: BotConnectedAppPolicy;
  readonly actionRows: readonly ConnectorActionRow[];
  readonly onSelectTier: (tier: BotConnectorPolicyTier) => void;
  readonly onUpdateActionPerm: (capId: string, level: BotActionPermissionLevel) => void;
  readonly onResetDefaults: () => void;
  readonly onToggleBackgroundSync: (enabled: boolean) => void;
}): ReactElement {
  const readRows = actionRows.filter((r) => r.kind === "read");
  const writeRows = actionRows.filter((r) => r.kind === "write");

  const renderGroup = (head: string, rows: readonly ConnectorActionRow[], isWrite: boolean) =>
    rows.length > 0 && (
      <div className="qj-conn-perm-group">
        <div className="qj-conn-cap-head">{head}</div>
        {rows.map((row) => {
          const raw = appPolicy?.actionPermissions?.[row.id] ?? row.defaultPerm;
          const val = isWrite && policyTier === "strict-read-only" ? "deny" : raw;
          return (
            <div key={row.id} className="qj-conn-cap-row">
              <span>{row.label}</span>
              <select
                aria-label={`${row.label} 权限`}
                value={val}
                onChange={(e) => onUpdateActionPerm(row.id, e.target.value as BotActionPermissionLevel)}
                className="qj-conn-perm-select"
              >
                {isWrite ? (
                  <>
                    <option value="ask">请求批准</option>
                    <option value="allow">允许</option>
                    <option value="deny">禁用</option>
                  </>
                ) : (
                  <>
                    <option value="allow">允许</option>
                    <option value="ask">每次询问</option>
                    <option value="deny">禁用</option>
                  </>
                )}
              </select>
            </div>
          );
        })}
      </div>
    );

  return (
    <>
      {!readOnlyOnly && (
        <div className="qj-conn-section-card">
          <div className="qj-conn-section-title">默认权限</div>
          <div className="qj-conn-tier-list">
            {POLICY_TIERS.map((tier) => (
              <label key={tier.id} className={`qj-conn-perm-radio${policyTier === tier.id ? " active" : ""}`}>
                <input
                  type="radio"
                  name={`tier-${entryId}`}
                  checked={policyTier === tier.id}
                  onChange={() => onSelectTier(tier.id)}
                />
                <ShieldCheck size={14} />
                <div>
                  <div className="qj-conn-perm-radio-title">{tier.title}</div>
                  <div className="qj-conn-perm-radio-sub">{tier.desc}</div>
                </div>
              </label>
            ))}
          </div>
        </div>
      )}

      <div className="qj-conn-section-card">
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
          <div className="qj-conn-section-title">细分操作权限</div>
          <button type="button" className="qj-conn-inline-link" onClick={onResetDefaults}>
            <RotateCcw size={12} />
            <span>重置为默认</span>
          </button>
        </div>

        {renderGroup("读取权限", readRows, false)}
        {renderGroup("写入和删除权限", writeRows, true)}

        <div className="qj-conn-perm-group">
          <div className="qj-conn-cap-head">后台操作</div>
          <div className="qj-conn-cap-row">
            <span>后台自动同步（Heartbeat 巡检）</span>
            <select
              aria-label="后台自动同步"
              value={appPolicy?.backgroundSync === false ? "off" : "on"}
              onChange={(e) => onToggleBackgroundSync(e.target.value === "on")}
              className="qj-conn-perm-select"
            >
              <option value="on">允许</option>
              <option value="off">暂停</option>
            </select>
          </div>
        </div>
      </div>
    </>
  );
}

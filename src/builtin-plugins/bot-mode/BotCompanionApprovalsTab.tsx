/**
 * Structured Outbound Approval Queue tab (`批准`) showing drafted emails,
 * Telegram/Feishu messages, and external shell commands ready for 1-click confirmation.
 */
import type { ReactElement } from "react";
import type { Context } from "@deepseek-ai/cordis";
import { BotIcon } from "./BotAvatarArt";
import { useBotController, useBotSnapshot } from "./botStore";

const KIND_LABELS: Record<string, string> = {
  "send-email": "邮件回复草稿（待发出）",
  "send-telegram": "Telegram 外发草稿",
  "send-feishu": "飞书推送草稿",
  shell: "外部系统写操作",
};

export function BotCompanionApprovalsTab({ ctx }: { readonly ctx?: Context }): ReactElement {
  const snapshot = useBotSnapshot();
  const ctrl = useBotController(ctx);

  return (
    <div className="qj-animate-page-in" style={{ display: "flex", flexDirection: "column", gap: 16 }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
        <span style={{ fontSize: 15, fontWeight: 600 }}>审核</span>
        <span style={{ fontSize: 12, color: "var(--qj-text-secondary)" }}>
          {snapshot.pendingApprovals.length > 0 ? `${snapshot.pendingApprovals.length} 项待确认` : "全部已处理"}
        </span>
      </div>

      {snapshot.pendingApprovals.length === 0 ? (
        <div style={{ padding: "40px 12px", textAlign: "center" }}>
          <div style={{ fontSize: 15, fontWeight: 500 }}>审核</div>
          <div style={{ fontSize: 13, color: "var(--qj-text-secondary)", marginTop: 4 }}>暂无待批准记录</div>
        </div>
      ) : (
        snapshot.pendingApprovals.map((apr) => (
          <div
            key={apr.id}
            data-testid={`approval-card-${apr.id}`}
            style={{ padding: 14, borderRadius: 18, background: "var(--muse-soft-fill)", display: "flex", flexDirection: "column", gap: 10 }}
          >
            <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
              <div style={{ width: 34, height: 34, borderRadius: "9999px", background: "var(--qj-bg-surface)", display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}>
                <BotIcon name="tabShield" />
              </div>
              <div style={{ minWidth: 0 }}>
                <div style={{ fontSize: 11.5, color: "var(--qj-brand-primary)", fontWeight: 520 }}>
                  {KIND_LABELS[apr.kind ?? "shell"] ?? "外发操作"}
                </div>
                <div style={{ fontSize: 13.5, fontWeight: 600 }}>{apr.title}</div>
                <div style={{ fontSize: 11.5, color: "var(--qj-text-secondary)" }}>{apr.commandSignature}</div>
              </div>
            </div>

            {apr.recipient && (
              <div style={{ fontSize: 12, color: "var(--qj-text-secondary)" }}>
                <strong>收件对象：</strong>{apr.recipient}{apr.subject ? ` · ${apr.subject}` : ""}
              </div>
            )}

            {apr.draftBody ? (
              <pre
                style={{
                  margin: 0,
                  padding: 10,
                  borderRadius: 12,
                  background: "var(--qj-bg-surface)",
                  color: "var(--qj-text-primary)",
                  fontSize: 12,
                  lineHeight: 1.55,
                  whiteSpace: "pre-wrap",
                  fontFamily: "inherit",
                  maxHeight: 150,
                  overflowY: "auto",
                }}
              >
                {apr.draftBody}
              </pre>
            ) : (
              <p style={{ margin: 0, fontSize: 12.5, lineHeight: 1.55, color: "var(--qj-text-secondary)" }}>{apr.summary}</p>
            )}

            <div style={{ display: "flex", gap: 8 }}>
              <button
                type="button"
                className="qj-primary-pill-btn"
                style={{ flex: 1, height: 34, fontSize: 12.5, fontWeight: 500 }}
                onClick={() => void ctrl.resolveApproval(apr.id, "approved")}
              >
                批准并执行
              </button>
              <button
                type="button"
                className="qj-soft-btn"
                style={{ flex: 1, height: 34, fontSize: 12.5, fontWeight: 500, background: "var(--qj-bg-surface)" }}
                onClick={() => void ctrl.resolveApproval(apr.id, "denied")}
              >
                拒绝
              </button>
            </div>
          </div>
        ))
      )}

      {snapshot.recentApprovals.length > 0 && (
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          <div style={{ fontSize: 12, fontWeight: 500, color: "var(--qj-text-muted)" }}>最近审核记录</div>
          {snapshot.recentApprovals.map((rec) => (
            <div key={rec.id} style={{ padding: 12, borderRadius: 16, background: "var(--muse-soft-fill)", display: "flex", alignItems: "center", justifyContent: "space-between", fontSize: 12 }}>
              <div>
                <div style={{ fontSize: 13, fontWeight: 500 }}>{rec.title}</div>
                <div style={{ color: "var(--qj-text-secondary)" }}>{rec.summary}</div>
              </div>
              <span style={{ color: "var(--qj-text-secondary)" }}>{rec.timeLabel}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
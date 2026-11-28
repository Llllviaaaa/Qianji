/**
 * 1:1 Meta Muse Outbound Approval Queue tab (`批准`).
 */
import type { ReactElement } from "react";
import type { Context } from "@deepseek-ai/cordis";
import { ShieldCheck } from "lucide-react";
import { useBotController, useBotSnapshot } from "./botStore";

const KIND_LABELS: Record<string, string> = {
  "send-email": "邮件回复草稿（待发出）",
  "send-telegram": "Telegram 外发草稿",
  "send-feishu": "飞书推送草稿",
  "send-slack": "Slack 频道推送",
  "github-comment": "GitHub Issue / PR 评论",
  "notion-page": "Notion 页面归档",
  "trigger-webhook": "触发外部 Webhook",
  shell: "外部系统写操作",
};

export function BotCompanionApprovalsTab({ ctx }: { readonly ctx?: Context }): ReactElement {
  const snapshot = useBotSnapshot();
  const ctrl = useBotController(ctx);

  if (snapshot.pendingApprovals.length === 0 && snapshot.recentApprovals.length === 0) {
    return (
      <div className="qj-animate-page-in qj-muse-panel-center-empty">
        <ShieldCheck size={20} strokeWidth={1.75} className="qj-muse-empty-icon" />
        <div className="qj-soft-empty-title">审核</div>
        <div className="qj-soft-empty-desc">暂无批准记录</div>
      </div>
    );
  }

  return (
    <div className="qj-animate-page-in qj-sheet-pane">
      {snapshot.pendingApprovals.map((apr) => (
        <div
          key={apr.id}
          data-testid={`approval-card-${apr.id}`}
          className="qj-soft-card qj-sheet-approval-card"
        >
          <div className="qj-sheet-approval-head">
            <div className="qj-sheet-circle-icon">
              <ShieldCheck size={15} />
            </div>
            <div className="qj-sheet-approval-titles">
              <div className="qj-sheet-kicker">
                {KIND_LABELS[apr.kind ?? "shell"] ?? "外发操作"}
              </div>
              <div className="qj-sheet-card-title">{apr.title}</div>
              <div className="qj-sheet-card-sub">{apr.commandSignature}</div>
            </div>
          </div>

          {apr.recipient && (
            <div className="qj-sheet-card-sub">
              <strong>收件对象：</strong>
              {apr.recipient}
              {apr.subject ? ` · ${apr.subject}` : ""}
            </div>
          )}

          {apr.draftBody ? (
            <pre className="qj-sheet-draft-pre">{apr.draftBody}</pre>
          ) : (
            <p className="qj-sheet-card-desc">{apr.summary}</p>
          )}

          <div className="qj-sheet-card-actions">
            <button
              type="button"
              className="qj-primary-pill-btn qj-sheet-pill-fill"
              onClick={() => void ctrl.resolveApproval(apr.id, "approved")}
            >
              批准并执行
            </button>
            <button
              type="button"
              className="qj-soft-btn qj-sheet-pill-fill surface"
              onClick={() => void ctrl.resolveApproval(apr.id, "denied")}
            >
              拒绝
            </button>
          </div>
        </div>
      ))}

      {snapshot.recentApprovals.length > 0 && (
        <div className="qj-sheet-recent-block">
          <div className="qj-sheet-day-title">最近审核记录</div>
          {snapshot.recentApprovals.map((rec) => (
            <div key={rec.id} className="qj-soft-card qj-sheet-recent-row">
              <div className="qj-sheet-recent-copy">
                <div className="qj-sheet-card-title">{rec.title}</div>
                <div className="qj-sheet-card-sub">{rec.summary}</div>
              </div>
              <span className="qj-sheet-activity-time">{rec.timeLabel}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

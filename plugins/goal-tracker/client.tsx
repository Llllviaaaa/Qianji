import { useEffect, useState } from "react";
import type { Context } from "@deepseek-ai/cordis";
import {
  callHostRpc,
  subscribeSessionActivity,
  useActiveSession,
  useHostRpcQuery,
} from "@qianji/client";
import { Check, CheckCircle2, CircleAlert, Clock, Target, X } from "lucide-react";

export const name = "goal-tracker";
export const inject = ["contributions", "styles"];

type GoalStatus = "active" | "blocked" | "complete";

interface GoalRecord {
  id: string;
  sessionId: string;
  objective: string;
  status: GoalStatus;
  createdAt: number;
  updatedAt: number;
  completedAt?: number;
  tokenBudget?: number;
  notes?: string;
}

interface GoalSnapshot {
  goal: GoalRecord | null;
}

function formatElapsed(ms: number): string {
  const sec = Math.max(0, Math.floor(ms / 1000));
  if (sec < 60) return `${sec} 秒`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min} 分 ${sec % 60} 秒`;
  const hr = Math.floor(min / 60);
  return `${hr} 小时 ${min % 60} 分`;
}

function GoalBannerView({ variant }: { variant?: "task-start" | "follow-up" }) {
  const session = useActiveSession();
  const sessionKey = session.sessionId ?? "default";
  const [busy, setBusy] = useState(false);

  const { data, refetch } = useHostRpcQuery<GoalSnapshot>(
    "goalTracker.get",
    { sessionId: sessionKey },
    { enabled: variant !== "task-start", refreshIntervalMs: session.isStreaming ? 2500 : 12000 },
  );

  useEffect(() => {
    if (variant === "task-start") return;
    return subscribeSessionActivity(() => {
      void refetch();
    });
  }, [refetch, variant]);

  if (variant === "task-start") return null;
  const goal = data?.goal;
  if (!goal) return null;

  const statusLabel =
    goal.status === "complete" ? "已完成" : goal.status === "blocked" ? "受阻" : "进行中";
  const elapsed = formatElapsed((goal.completedAt ?? goal.updatedAt) - goal.createdAt);

  return (
    <div className={`gt-banner is-${goal.status}`} role="region" aria-label="会话目标追踪">
      <div className="gt-main">
        <span className="gt-badge">
          {goal.status === "complete" ? (
            <CheckCircle2 size={13} />
          ) : goal.status === "blocked" ? (
            <CircleAlert size={13} />
          ) : (
            <Target size={13} />
          )}
          <span>{statusLabel}</span>
        </span>
        <span className="gt-objective" title={goal.notes || goal.objective}>
          {goal.objective}
        </span>
      </div>
      <div className="gt-meta">
        <span className="gt-pill">
          <Clock size={11.5} />
          <span>{elapsed}</span>
        </span>
        {goal.tokenBudget !== undefined && (
          <span className="gt-pill">预算 {goal.tokenBudget.toLocaleString()} tok</span>
        )}
        {goal.status !== "complete" && (
          <button
            type="button"
            className="gt-btn"
            disabled={busy}
            title="标记目标完成"
            onClick={() => {
              setBusy(true);
              void callHostRpc("goalTracker.complete", { sessionId: sessionKey })
                .then(() => refetch())
                .finally(() => setBusy(false));
            }}
          >
            <Check size={12} />
            <span>完成</span>
          </button>
        )}
        <button
          type="button"
          className="gt-btn is-muted"
          disabled={busy}
          title="清除目标横幅"
          aria-label="清除目标横幅"
          onClick={() => {
            setBusy(true);
            void callHostRpc("goalTracker.clear", { sessionId: sessionKey })
              .then(() => refetch())
              .finally(() => setBusy(false));
          }}
        >
          <X size={12} />
        </button>
      </div>
    </div>
  );
}

const SCOPED_CSS = `
.gt-banner {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  padding: 7px 12px;
  margin-bottom: 6px;
  border-radius: 10px;
  border: 1px solid var(--border, rgba(128, 128, 128, 0.22));
  background: var(--panel, rgba(255, 255, 255, 0.04));
  color: var(--text, inherit);
  font-size: 12px;
  line-height: 1.4;
}
.gt-banner.is-complete {
  border-color: rgba(34, 197, 94, 0.35);
}
.gt-banner.is-blocked {
  border-color: rgba(245, 158, 11, 0.45);
}
.gt-main {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
  flex: 1;
}
.gt-badge {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 2px 7px;
  border-radius: 999px;
  font-size: 11px;
  font-weight: 600;
  background: rgba(16, 185, 129, 0.14);
  color: var(--accent, #10b981);
  flex-shrink: 0;
}
.gt-banner.is-blocked .gt-badge {
  background: rgba(245, 158, 11, 0.15);
  color: #d97706;
}
.gt-objective {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-weight: 500;
}
.gt-meta {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  flex-shrink: 0;
}
.gt-pill {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  color: var(--text-3, #888);
  font-size: 11px;
}
.gt-btn {
  display: inline-flex;
  align-items: center;
  gap: 3px;
  height: 22px;
  padding: 0 7px;
  border-radius: 6px;
  border: 1px solid var(--border, rgba(128, 128, 128, 0.25));
  background: transparent;
  color: var(--text-2, inherit);
  font-size: 11px;
  cursor: pointer;
}
.gt-btn:hover {
  background: var(--hover, rgba(128, 128, 128, 0.12));
  color: var(--text, inherit);
}
.gt-btn.is-muted {
  padding: 0 5px;
}
`;

export function apply(ctx: Context): void {
  ctx.styles.inject(SCOPED_CSS);
  ctx.contributions.registerComposerBanner({
    id: "goal-tracker:banner",
    order: 15,
    render: ({ variant }) => <GoalBannerView variant={variant} />,
  });
}

export default {
  name,
  inject,
  apply,
};

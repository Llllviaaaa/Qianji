import { useEffect, useRef, useState } from "react";
import type { Context } from "@deepseek-ai/cordis";
import {
  callHostRpc,
  subscribeSessionActivity,
  useActiveSession,
  useHostRpcQuery,
  type SessionStats,
} from "@qianji/client";
import {
  Check,
  CircleAlert,
  Clock,
  Pause,
  Pencil,
  Play,
  Target,
  X,
} from "lucide-react";

export const name = "goal-tracker";
export const inject = ["contributions", "styles"];

export type GoalPhase = "active" | "paused" | "blocked" | "complete";
export type GoalStatus = GoalPhase;

export interface GoalBlockReason {
  code: string;
  message: string;
}

export interface GoalRecord {
  id: string;
  sessionId: string;
  revision: number;
  objective: string;
  phase: GoalPhase;
  status?: GoalPhase;
  armed?: boolean;
  roundsStarted: number;
  maxGoalRounds: number;
  createdAt: number;
  updatedAt: number;
  accumulatedMs?: number;
  activeSince?: number;
  completedAt?: number;
  tokenBudget?: number;
  notes?: string;
  blockedReason?: GoalBlockReason;
}

export interface GoalSnapshot {
  goal: GoalRecord | null;
}

export function formatGoalElapsed(ms: number): string {
  const sec = Math.max(0, Math.floor(ms / 1000));
  if (sec < 60) return `${sec} 秒`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min} 分 ${sec % 60} 秒`;
  const hr = Math.floor(min / 60);
  return `${hr} 小时 ${min % 60} 分`;
}

export function formatTokenCompact(tokens: number): string {
  if (!Number.isFinite(tokens) || tokens <= 0) return "0";
  if (tokens >= 1_000_000) {
    return `${(tokens / 1_000_000).toFixed(1).replace(/\.0$/, "")}M`;
  }
  if (tokens >= 10_000) {
    return `${Math.round(tokens / 1_000)}k`;
  }
  if (tokens >= 1_000) {
    return `${(tokens / 1_000).toFixed(1).replace(/\.0$/, "")}k`;
  }
  return `${Math.round(tokens)}`;
}

function resolveUsedTokens(stats: SessionStats | null): number | undefined {
  if (stats === null) return undefined;
  const rawTokens = stats.tokens as {
    input: number;
    output: number;
    cacheRead?: number;
    cacheWrite?: number;
    reasoning?: number;
    total?: number;
  };
  if (typeof rawTokens.total === "number" && Number.isFinite(rawTokens.total) && rawTokens.total >= 0) {
    return rawTokens.total;
  }
  const sum =
    (rawTokens.input || 0)
    + (rawTokens.output || 0)
    + (rawTokens.cacheRead ?? 0)
    + (rawTokens.cacheWrite ?? 0)
    + (rawTokens.reasoning ?? 0);
  return Number.isFinite(sum) && sum >= 0 ? sum : undefined;
}

export function GoalBar({ variant }: { variant?: "task-start" | "follow-up" }) {
  const session = useActiveSession();
  const rawSessionId = session.sessionId?.trim() ?? "";
  const activeSessionId = rawSessionId !== "" ? rawSessionId : null;
  const queryEnabled = variant !== "task-start" && activeSessionId !== null;

  const inFlightRef = useRef(false);
  const [busy, setBusy] = useState(false);
  const [nowMs, setNowMs] = useState<number>(() => Date.now());
  const [clearedGoalId, setClearedGoalId] = useState<string | null>(null);
  const [editing, setEditing] = useState<{ goalId: string; draft: string } | null>(null);

  const { data, refetch } = useHostRpcQuery<GoalSnapshot>(
    "goalTracker.get",
    { sessionId: activeSessionId ?? "" },
    { enabled: queryEnabled },
  );

  useEffect(() => {
    if (!queryEnabled) return;
    return subscribeSessionActivity(() => {
      void refetch();
    });
  }, [queryEnabled, refetch]);

  const rawGoal = data?.goal ?? null;
  const goal =
    queryEnabled
    && rawGoal !== null
    && (rawGoal.sessionId === "" || rawGoal.sessionId === activeSessionId)
      ? rawGoal
      : null;

  const phase: GoalPhase | null = goal === null ? null : (goal.phase ?? goal.status ?? "active");
  const isArmed = goal !== null && phase === "active" && goal.armed === true;

  useEffect(() => {
    if (!isArmed || typeof window === "undefined" || typeof window.setInterval !== "function") {
      return;
    }
    const timer = window.setInterval(() => {
      setNowMs(Date.now());
    }, 1000);
    return () => {
      if (typeof window !== "undefined" && typeof window.clearInterval === "function") {
        window.clearInterval(timer);
      }
    };
  }, [isArmed]);

  if (!queryEnabled || goal === null || activeSessionId === null || phase === null) {
    return null;
  }
  if (phase === "complete" || clearedGoalId === goal.id) {
    return null;
  }

  const statusLabel =
    phase === "paused"
      ? "已暂停"
      : phase === "blocked"
        ? "已受阻"
        : isArmed
          ? "进行中"
          : "已挂起";

  const effectiveNow = Math.max(nowMs, Date.now());
  const liveSegmentMs =
    isArmed && goal.activeSince !== undefined ? Math.max(0, effectiveNow - goal.activeSince) : 0;
  const elapsedMs = Math.max(0, (goal.accumulatedMs ?? 0) + liveSegmentMs);
  const elapsedText = formatGoalElapsed(elapsedMs);

  const usedTokens = resolveUsedTokens(session.stats);
  const overBudget =
    goal.tokenBudget !== undefined && usedTokens !== undefined && usedTokens > goal.tokenBudget;
  const budgetText =
    goal.tokenBudget === undefined
      ? null
      : usedTokens !== undefined && usedTokens > 0
        ? `${formatTokenCompact(usedTokens)} / ${formatTokenCompact(goal.tokenBudget)} tok`
        : `预算 ${formatTokenCompact(goal.tokenBudget)} tok`;

  const isEditing = editing !== null && editing.goalId === goal.id;
  const blockerMessage =
    phase === "blocked" ? (goal.blockedReason?.message ?? goal.notes ?? "").trim() : "";

  const runMutation = (fn: () => Promise<unknown>, optimisticClearId?: string) => {
    if (inFlightRef.current) return;
    inFlightRef.current = true;
    setBusy(true);
    if (optimisticClearId !== undefined) setClearedGoalId(optimisticClearId);
    void fn()
      .then(() => refetch())
      .catch(() => {
        if (optimisticClearId !== undefined) setClearedGoalId(null);
      })
      .finally(() => {
        inFlightRef.current = false;
        setBusy(false);
      });
  };

  const commitEdit = () => {
    if (!isEditing || editing === null) return;
    const nextObjective = editing.draft.trim();
    if (nextObjective === "" || nextObjective === goal.objective) {
      setEditing(null);
      return;
    }
    const targetId = goal.id;
    const targetRev = goal.revision;
    setEditing(null);
    runMutation(() =>
      callHostRpc("goalTracker.edit", {
        sessionId: activeSessionId,
        goalId: targetId,
        revision: targetRev,
        objective: nextObjective,
      }),
    );
  };

  const casPayload = {
    sessionId: activeSessionId,
    goalId: goal.id,
    revision: goal.revision,
  };

  const barStateClass = phase === "active" && !isArmed ? "is-disarmed" : `is-${phase}`;

  return (
    <div
      className={`gt-bar ${barStateClass}${session.isStreaming && isArmed ? " is-streaming" : ""}`}
      role="region"
      aria-label="会话目标控制条"
      data-goal-phase={phase}
      data-goal-armed={isArmed ? "true" : "false"}
    >
      <div className="gt-row">
        <div className="gt-main">
          <span className="gt-badge">
            {phase === "blocked" ? (
              <CircleAlert size={12} aria-hidden="true" />
            ) : phase === "paused" || (phase === "active" && !isArmed) ? (
              <Pause size={11.5} aria-hidden="true" />
            ) : session.isStreaming ? (
              <span className="gt-pulse-dot" aria-hidden="true" />
            ) : (
              <Target size={12} aria-hidden="true" />
            )}
            <span>{statusLabel}</span>
          </span>

          {isEditing ? (
            <div className="gt-edit-wrap">
              <input
                type="text"
                className="gt-edit-input"
                value={editing.draft}
                disabled={busy}
                aria-label="编辑目标描述"
                autoFocus
                onChange={(e) => setEditing({ goalId: goal.id, draft: e.target.value })}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    commitEdit();
                  } else if (e.key === "Escape") {
                    e.preventDefault();
                    setEditing(null);
                  }
                }}
              />
              <button
                type="button"
                className="gt-btn is-icon is-save"
                disabled={busy}
                title="保存目标"
                aria-label="保存目标"
                onClick={commitEdit}
              >
                <Check size={12} />
              </button>
              <button
                type="button"
                className="gt-btn is-icon"
                disabled={busy}
                title="取消编辑"
                aria-label="取消编辑"
                onClick={() => setEditing(null)}
              >
                <X size={12} />
              </button>
            </div>
          ) : (
            <span
              className="gt-objective"
              title={goal.objective}
              onDoubleClick={() => {
                if (!busy) setEditing({ goalId: goal.id, draft: goal.objective });
              }}
            >
              {goal.objective}
            </span>
          )}
        </div>

        <div className="gt-meta">
          <span className="gt-pill gt-round-pill" data-goal-round="" title="目标自动推进轮次">
            第 {goal.roundsStarted}/{goal.maxGoalRounds} 轮
          </span>

          {budgetText !== null && (
            <span className={`gt-pill gt-budget-pill${overBudget ? " is-over" : ""}`}>
              {budgetText}
            </span>
          )}

          <span className="gt-pill gt-time-pill" data-goal-elapsed="">
            <Clock size={11} aria-hidden="true" />
            <span>{elapsedText}</span>
          </span>

          {!isEditing && (
            <>
              {isArmed ? (
                <button
                  type="button"
                  className="gt-btn is-action"
                  disabled={busy}
                  title="暂停自动推进"
                  aria-label="暂停目标"
                  onClick={() => runMutation(() => callHostRpc("goalTracker.pause", casPayload))}
                >
                  <Pause size={11.5} />
                  <span>暂停</span>
                </button>
              ) : (
                <button
                  type="button"
                  className="gt-btn is-action is-resume"
                  disabled={busy}
                  title="恢复并继续自动推进"
                  aria-label="恢复目标"
                  onClick={() => runMutation(() => callHostRpc("goalTracker.resume", casPayload))}
                >
                  <Play size={11.5} />
                  <span>继续</span>
                </button>
              )}

              <button
                type="button"
                className="gt-btn is-icon"
                disabled={busy}
                title="编辑目标"
                aria-label="编辑目标"
                onClick={() => setEditing({ goalId: goal.id, draft: goal.objective })}
              >
                <Pencil size={11.5} />
              </button>

              <button
                type="button"
                className="gt-btn is-icon is-muted"
                disabled={busy}
                title="清除目标"
                aria-label="清除目标"
                onClick={() => runMutation(() => callHostRpc("goalTracker.clear", casPayload), goal.id)}
              >
                <X size={12} />
              </button>
            </>
          )}
        </div>
      </div>

      {blockerMessage !== "" && (
        <div className="gt-blocker-row" data-goal-blocker="">
          <CircleAlert size={12} className="gt-blocker-icon" aria-hidden="true" />
          <span className="gt-blocker-text" title={blockerMessage}>
            {blockerMessage}
          </span>
        </div>
      )}
    </div>
  );
}

export { GoalBar as GoalBannerView };

const SCOPED_CSS = `
.gt-bar {
  display: flex;
  flex-direction: column;
  gap: 4px;
  padding: 6px 10px;
  min-height: 36px;
  box-sizing: border-box;
  border-radius: var(--qj-radius-md, 10px);
  border: 1px solid var(--qj-border-default);
  background: var(--qj-bg-surface);
  color: var(--qj-text-primary);
  font-family: var(--qj-font-sans);
  font-size: 12px;
  box-shadow: var(--qj-shadow-sm, 0 1px 2px rgba(0, 0, 0, 0.04));
}

.gt-bar.is-active {
  border-color: color-mix(in srgb, var(--qj-brand-primary) 26%, var(--qj-border-default));
  background: color-mix(in srgb, var(--qj-brand-primary) 4%, var(--qj-bg-surface));
}

.gt-bar.is-paused,
.gt-bar.is-disarmed {
  border-color: var(--qj-border-default);
  background: var(--qj-bg-subtle);
}

.gt-bar.is-blocked {
  border-color: color-mix(in srgb, var(--qj-status-warning) 44%, var(--qj-border-default));
  background: color-mix(in srgb, var(--qj-status-warning) 6%, var(--qj-bg-surface));
}

.gt-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  min-height: 22px;
  min-width: 0;
}

.gt-main {
  display: flex;
  align-items: center;
  gap: 7px;
  min-width: 0;
  flex: 1 1 auto;
}

.gt-badge {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 2px 7px;
  border-radius: 9999px;
  font-size: 11px;
  font-weight: 600;
  white-space: nowrap;
  flex-shrink: 0;
  background: color-mix(in srgb, var(--qj-brand-primary) 12%, transparent);
  color: var(--qj-brand-primary);
}

.gt-bar.is-paused .gt-badge,
.gt-bar.is-disarmed .gt-badge {
  background: color-mix(in srgb, var(--qj-text-secondary) 12%, transparent);
  color: var(--qj-text-secondary);
}

.gt-bar.is-blocked .gt-badge {
  background: color-mix(in srgb, var(--qj-status-warning) 16%, transparent);
  color: var(--qj-status-warning);
}

.gt-pulse-dot {
  width: 6px;
  height: 6px;
  border-radius: 9999px;
  background: var(--qj-brand-primary);
  box-shadow: 0 0 0 0 color-mix(in srgb, var(--qj-brand-primary) 55%, transparent);
  animation: gtPulse 1.6s infinite;
}

@keyframes gtPulse {
  0% {
    box-shadow: 0 0 0 0 color-mix(in srgb, var(--qj-brand-primary) 55%, transparent);
  }
  70% {
    box-shadow: 0 0 0 5px transparent;
  }
  100% {
    box-shadow: 0 0 0 0 transparent;
  }
}

.gt-objective {
  font-weight: 550;
  color: var(--qj-text-primary);
  min-width: 0;
  flex: 1 1 auto;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.gt-edit-wrap {
  display: flex;
  align-items: center;
  gap: 4px;
  flex: 1 1 auto;
  min-width: 0;
}

.gt-edit-input {
  flex: 1 1 auto;
  min-width: 100px;
  height: 22px;
  padding: 0 7px;
  border-radius: var(--qj-radius-sm, 6px);
  border: 1px solid var(--qj-brand-primary);
  background: var(--qj-bg-app, var(--qj-bg-surface));
  color: var(--qj-text-primary);
  font-family: inherit;
  font-size: 12px;
  outline: none;
}

.gt-meta {
  display: flex;
  align-items: center;
  gap: 5px;
  flex-shrink: 0;
}

.gt-pill {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 2px 7px;
  border-radius: 9999px;
  border: 1px solid var(--qj-border-default);
  background: var(--qj-bg-subtle);
  color: var(--qj-text-secondary);
  font-size: 11px;
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
}

.gt-pill.is-over {
  border-color: color-mix(in srgb, var(--qj-status-danger) 42%, var(--qj-border-default));
  color: var(--qj-status-danger);
}

.gt-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 3px;
  height: 22px;
  padding: 0 7px;
  border-radius: var(--qj-radius-sm, 6px);
  border: 1px solid var(--qj-border-default);
  background: var(--qj-bg-surface);
  color: var(--qj-text-secondary);
  font-family: inherit;
  font-size: 11px;
  font-weight: 550;
  cursor: pointer;
  white-space: nowrap;
  transition: background-color 140ms ease, border-color 140ms ease, color 140ms ease;
}

.gt-btn:hover:not(:disabled) {
  background: var(--qj-bg-hover);
  color: var(--qj-text-primary);
}

.gt-btn.is-resume {
  border-color: color-mix(in srgb, var(--qj-brand-primary) 34%, var(--qj-border-default));
  color: var(--qj-brand-primary);
}

.gt-btn.is-save {
  border-color: color-mix(in srgb, var(--qj-status-success) 38%, var(--qj-border-default));
  color: var(--qj-status-success);
}

.gt-btn.is-icon {
  width: 22px;
  padding: 0;
}

.gt-btn.is-muted {
  border-color: transparent;
  background: transparent;
}

.gt-btn:disabled {
  opacity: 0.45;
  cursor: not-allowed;
}

.gt-blocker-row {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 4px 8px;
  border-radius: var(--qj-radius-sm, 6px);
  background: color-mix(in srgb, var(--qj-status-warning) 10%, var(--qj-bg-surface));
  color: var(--qj-status-warning);
  font-size: 11.5px;
  line-height: 1.4;
}

.gt-blocker-icon {
  flex-shrink: 0;
}

.gt-blocker-text {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
`;

export function apply(ctx: Context): void {
  ctx.styles.inject(SCOPED_CSS, "goal-tracker:styles");
  ctx.contributions.registerComposerBanner({
    id: "goal-tracker:banner",
    order: 20,
    render: (context) => <GoalBar variant={context.variant} />,
  });
}

export default {
  name,
  inject,
  apply,
};

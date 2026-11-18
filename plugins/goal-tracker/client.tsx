import { useEffect, useState } from "react";
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
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  CircleAlert,
  Clock,
  Compass,
  RefreshCw,
  Target,
  X,
} from "lucide-react";

export const name = "goal-tracker";
export const inject = ["contributions", "styles"];

export type GoalStatus = "active" | "blocked" | "complete";

export interface GoalCriterion {
  id: string;
  text: string;
  done: boolean;
}

export interface GoalRecord {
  id: string;
  sessionId: string;
  objective: string;
  status: GoalStatus;
  createdAt: number;
  updatedAt: number;
  completedAt?: number;
  tokenBudget?: number;
  notes?: string;
  criteria?: GoalCriterion[];
  remindCount?: number;
  maxReminds?: number;
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
    (rawTokens.input || 0) +
    (rawTokens.output || 0) +
    (rawTokens.cacheRead ?? 0) +
    (rawTokens.cacheWrite ?? 0) +
    (rawTokens.reasoning ?? 0);
  return Number.isFinite(sum) && sum >= 0 ? sum : undefined;
}

function CriteriaProgressRing({ done, total }: { done: number; total: number }) {
  const radius = 5.5;
  const circumference = 2 * Math.PI * radius;
  const ratio = total > 0 ? Math.min(1, Math.max(0, done / total)) : 0;
  const dashOffset = circumference * (1 - ratio);
  return (
    <svg className="gt-ring-svg" viewBox="0 0 16 16" aria-hidden="true">
      <circle
        className="gt-ring-track"
        cx="8"
        cy="8"
        r={radius}
        fill="none"
        strokeWidth="2"
      />
      <circle
        className="gt-ring-fill"
        cx="8"
        cy="8"
        r={radius}
        fill="none"
        strokeWidth="2"
        strokeLinecap="round"
        strokeDasharray={`${circumference}`}
        strokeDashoffset={`${dashOffset}`}
        transform="rotate(-90 8 8)"
      />
    </svg>
  );
}

export function GoalBannerView({ variant }: { variant?: "task-start" | "follow-up" }) {
  const session = useActiveSession();
  const rawSessionId = session.sessionId?.trim() ?? "";
  const activeSessionId = rawSessionId !== "" ? rawSessionId : null;
  const queryEnabled = variant !== "task-start" && activeSessionId !== null;

  const [busy, setBusy] = useState(false);
  const [togglingId, setTogglingId] = useState<string | null>(null);
  const [nowMs, setNowMs] = useState<number>(() => Date.now());
  const [manualExpand, setManualExpand] = useState<{ goalId: string; open: boolean } | null>(null);

  const { data, refetch } = useHostRpcQuery<GoalSnapshot>(
    "goalTracker.get",
    { sessionId: activeSessionId ?? "" },
    { enabled: queryEnabled, refreshIntervalMs: session.isStreaming ? 1000 : 8000 },
  );

  useEffect(() => {
    if (!queryEnabled) return;
    return subscribeSessionActivity(() => {
      void refetch();
    });
  }, [queryEnabled, refetch]);

  const rawGoal = data?.goal ?? null;
  const goal =
    queryEnabled &&
    rawGoal !== null &&
    (rawGoal.sessionId === "" || rawGoal.sessionId === activeSessionId)
      ? rawGoal
      : null;

  const isGoalActive = goal !== null && goal.status === "active";

  useEffect(() => {
    if (!isGoalActive || typeof window === "undefined" || typeof window.setInterval !== "function") {
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
  }, [isGoalActive]);

  if (!queryEnabled || goal === null || activeSessionId === null) {
    return null;
  }

  const statusLabel =
    goal.status === "complete" ? "已完成" : goal.status === "blocked" ? "受阻" : "进行中";
  const effectiveNow = Math.max(nowMs, Date.now());
  const elapsedMs =
    goal.status === "active"
      ? Math.max(0, effectiveNow - goal.createdAt)
      : Math.max(0, (goal.completedAt ?? goal.updatedAt) - goal.createdAt);
  const elapsedText = formatGoalElapsed(elapsedMs);

  const criteria = goal.criteria ?? [];
  const hasCriteria = criteria.length > 0;
  const doneCriteriaCount = criteria.filter((item) => item.done).length;
  const notesText = goal.notes?.trim() ?? "";
  const hasNotes = notesText !== "";
  const canExpand = hasCriteria || notesText.length > 48;
  const autoExpand = goal.status === "blocked" && (hasCriteria || hasNotes);
  const isExpanded =
    (hasCriteria || hasNotes) &&
    (manualExpand?.goalId === goal.id ? manualExpand.open : autoExpand);

  const toggleExpand = () => {
    setManualExpand({ goalId: goal.id, open: !isExpanded });
  };

  const remindCount = goal.remindCount ?? 0;
  const maxReminds = goal.maxReminds ?? 3;
  const usedTokens = resolveUsedTokens(session.stats);
  const overBudget =
    goal.tokenBudget !== undefined && usedTokens !== undefined && usedTokens > goal.tokenBudget;
  const budgetText =
    goal.tokenBudget === undefined
      ? null
      : usedTokens !== undefined && usedTokens > 0
        ? `${formatTokenCompact(usedTokens)} / ${formatTokenCompact(goal.tokenBudget)} tok`
        : `预算 ${formatTokenCompact(goal.tokenBudget)} tok`;

  return (
    <div
      className={`gt-banner is-${goal.status}${session.isStreaming && goal.status === "active" ? " is-streaming" : ""}`}
      role="region"
      aria-label="会话目标追踪"
      data-goal-status={goal.status}
    >
      <div className="gt-row-primary">
        <div className="gt-main">
          <span className="gt-badge">
            {goal.status === "complete" ? (
              <CheckCircle2 size={12.5} aria-hidden="true" />
            ) : goal.status === "blocked" ? (
              <CircleAlert size={12.5} aria-hidden="true" />
            ) : session.isStreaming ? (
              <span className="gt-pulse-dot" aria-hidden="true" />
            ) : (
              <Target size={12.5} aria-hidden="true" />
            )}
            <span>{statusLabel}</span>
          </span>

          {canExpand ? (
            <button
              type="button"
              className={`gt-objective is-interactive${isExpanded ? " is-expanded" : ""}`}
              aria-expanded={isExpanded}
              title={goal.objective}
              onClick={toggleExpand}
            >
              {goal.objective}
            </button>
          ) : (
            <span className="gt-objective" title={goal.objective}>
              {goal.objective}
            </span>
          )}
        </div>

        <div className="gt-meta">
          {hasCriteria && (
            <button
              type="button"
              className={`gt-pill is-interactive gt-criteria-pill${doneCriteriaCount === criteria.length ? " is-all-done" : ""}`}
              title="点击展开或收起验收清单"
              aria-expanded={isExpanded}
              onClick={toggleExpand}
            >
              <CriteriaProgressRing done={doneCriteriaCount} total={criteria.length} />
              <span>
                ✓ {doneCriteriaCount}/{criteria.length}
              </span>
            </button>
          )}

          {remindCount > 0 && goal.status === "active" && (
            <span className="gt-pill gt-audit-pill" title="任务结束前自动核查轮次">
              <RefreshCw size={11} aria-hidden="true" />
              <span>
                核查 {remindCount}/{maxReminds}
              </span>
            </span>
          )}

          {budgetText !== null && (
            <span className={`gt-pill gt-budget-pill${overBudget ? " is-over" : ""}`}>
              {budgetText}
            </span>
          )}

          <span className="gt-pill gt-time-pill" data-goal-elapsed="">
            <Clock size={11.5} aria-hidden="true" />
            <span>{elapsedText}</span>
          </span>

          {(hasCriteria || hasNotes) && (
            <button
              type="button"
              className="gt-btn is-icon"
              aria-label={isExpanded ? "收起目标详情" : "展开目标详情"}
              aria-expanded={isExpanded}
              title={isExpanded ? "收起详情" : "展开验收清单与详情"}
              onClick={toggleExpand}
            >
              {isExpanded ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
            </button>
          )}

          {goal.status !== "complete" && (
            <button
              type="button"
              className="gt-btn is-complete"
              disabled={busy}
              title="标记目标完成"
              onClick={() => {
                setBusy(true);
                void callHostRpc("goalTracker.complete", { sessionId: activeSessionId })
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
            className="gt-btn is-icon is-muted"
            disabled={busy}
            title="清除目标横幅"
            aria-label="清除目标横幅"
            onClick={() => {
              setBusy(true);
              void callHostRpc("goalTracker.clear", { sessionId: activeSessionId })
                .then(() => refetch())
                .finally(() => setBusy(false));
            }}
          >
            <X size={12} />
          </button>
        </div>
      </div>

      {hasNotes && (
        <div className={`gt-notes-row is-${goal.status}${isExpanded ? " is-expanded" : ""}`} data-goal-notes="">
          {goal.status === "blocked" ? (
            <CircleAlert size={12.5} className="gt-notes-icon" aria-hidden="true" />
          ) : goal.status === "complete" ? (
            <CheckCircle2 size={12.5} className="gt-notes-icon" aria-hidden="true" />
          ) : (
            <Compass size={12.5} className="gt-notes-icon" aria-hidden="true" />
          )}
          <span className="gt-notes-text">{notesText}</span>
        </div>
      )}

      {isExpanded && hasCriteria && (
        <div className="gt-checklist" role="group" aria-label="目标验收标准清单">
          {criteria.map((item) => {
            const isItemBusy = busy || togglingId === item.id;
            return (
              <button
                key={item.id}
                type="button"
                role="checkbox"
                aria-checked={item.done}
                disabled={isItemBusy}
                className={`gt-criterion${item.done ? " is-done" : ""}`}
                onClick={() => {
                  setTogglingId(item.id);
                  void callHostRpc("goalTracker.toggleCriterion", {
                    sessionId: activeSessionId,
                    criterionId: item.id,
                  })
                    .then(() => refetch())
                    .finally(() => setTogglingId(null));
                }}
              >
                <span className="gt-check-box" aria-hidden="true">
                  {item.done ? <Check size={10.5} strokeWidth={2.6} /> : null}
                </span>
                <span className="gt-criterion-text">{item.text}</span>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

const SCOPED_CSS = `
.gt-banner {
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: 8px 12px;
  margin-bottom: 8px;
  border-radius: var(--qj-radius-md, 10px);
  border: 1px solid var(--qj-border-default);
  background: var(--qj-bg-surface);
  color: var(--qj-text-primary);
  font-family: var(--qj-font-sans);
  font-size: 12.5px;
  line-height: 1.4;
  box-shadow: 0 1px 2px rgba(0, 0, 0, 0.06);
  transition: border-color 150ms ease, background-color 150ms ease;
}

.gt-banner.is-active.is-streaming {
  border-color: color-mix(in srgb, var(--qj-brand-primary) 34%, var(--qj-border-default));
}

.gt-banner.is-complete {
  border-color: color-mix(in srgb, var(--qj-status-success) 38%, var(--qj-border-default));
}

.gt-banner.is-blocked {
  border-color: color-mix(in srgb, var(--qj-status-warning) 48%, var(--qj-border-strong));
}

.gt-row-primary {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  min-width: 0;
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
  gap: 5px;
  padding: 2px 8px;
  border-radius: 999px;
  font-size: 11px;
  font-weight: 600;
  letter-spacing: 0.01em;
  background: color-mix(in srgb, var(--qj-brand-primary) 13%, transparent);
  color: var(--qj-brand-primary);
  flex-shrink: 0;
}

.gt-banner.is-complete .gt-badge {
  background: color-mix(in srgb, var(--qj-status-success) 14%, transparent);
  color: var(--qj-status-success);
}

.gt-banner.is-blocked .gt-badge {
  background: color-mix(in srgb, var(--qj-status-warning) 16%, transparent);
  color: var(--qj-status-warning);
}

.gt-pulse-dot {
  width: 6.5px;
  height: 6.5px;
  border-radius: 999px;
  background: var(--qj-brand-primary);
  box-shadow: 0 0 0 0 color-mix(in srgb, var(--qj-brand-primary) 55%, transparent);
  animation: gt-pulse 1.8s ease-out infinite;
  flex-shrink: 0;
}

@keyframes gt-pulse {
  0% {
    box-shadow: 0 0 0 0 color-mix(in srgb, var(--qj-brand-primary) 50%, transparent);
  }
  70% {
    box-shadow: 0 0 0 5px transparent;
  }
  100% {
    box-shadow: 0 0 0 0 transparent;
  }
}

@media (prefers-reduced-motion: reduce) {
  .gt-pulse-dot {
    animation: none;
  }
}

.gt-objective {
  min-width: 0;
  flex: 1;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-weight: 600;
  color: var(--qj-text-primary);
  text-align: left;
}

.gt-objective.is-interactive {
  padding: 0;
  margin: 0;
  border: 0;
  background: transparent;
  font: inherit;
  font-weight: 600;
  cursor: pointer;
}

.gt-objective.is-interactive:hover {
  color: var(--qj-brand-primary);
}

.gt-objective.is-expanded {
  white-space: normal;
  overflow: visible;
}

.gt-meta {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  flex-shrink: 0;
}

.gt-pill {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  height: 22px;
  padding: 0 7px;
  border-radius: 999px;
  border: 1px solid var(--qj-border-subtle, var(--qj-border-default));
  background: var(--qj-bg-subtle);
  color: var(--qj-text-secondary);
  font-size: 11px;
  font-weight: 500;
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
}

.gt-pill.is-interactive {
  cursor: pointer;
  font-family: inherit;
  transition: background-color 120ms ease, border-color 120ms ease, color 120ms ease;
}

.gt-pill.is-interactive:hover {
  background: var(--qj-bg-hover);
  border-color: var(--qj-border-strong);
  color: var(--qj-text-primary);
}

.gt-criteria-pill.is-all-done {
  color: var(--qj-status-success);
  border-color: color-mix(in srgb, var(--qj-status-success) 30%, var(--qj-border-default));
}

.gt-audit-pill {
  color: var(--qj-brand-primary);
  background: color-mix(in srgb, var(--qj-brand-primary) 10%, transparent);
  border-color: color-mix(in srgb, var(--qj-brand-primary) 24%, transparent);
}

.gt-budget-pill {
  font-family: var(--qj-font-mono);
  font-size: 10.5px;
}

.gt-budget-pill.is-over {
  color: var(--qj-status-warning);
  border-color: color-mix(in srgb, var(--qj-status-warning) 35%, transparent);
}

.gt-time-pill {
  color: var(--qj-text-muted);
}

.gt-ring-svg {
  width: 12.5px;
  height: 12.5px;
  display: block;
  flex-shrink: 0;
}

.gt-ring-track {
  stroke: color-mix(in srgb, var(--qj-text-muted) 28%, transparent);
}

.gt-ring-fill {
  stroke: var(--qj-brand-primary);
  transition: stroke-dashoffset 220ms ease;
}

.gt-criteria-pill.is-all-done .gt-ring-fill,
.gt-banner.is-complete .gt-ring-fill {
  stroke: var(--qj-status-success);
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
  background: transparent;
  color: var(--qj-text-secondary);
  font-family: inherit;
  font-size: 11px;
  font-weight: 500;
  cursor: pointer;
  transition: background-color 120ms ease, color 120ms ease, border-color 120ms ease;
}

.gt-btn:hover:not(:disabled) {
  background: var(--qj-bg-hover);
  border-color: var(--qj-border-strong);
  color: var(--qj-text-primary);
}

.gt-btn:disabled {
  opacity: 0.55;
  cursor: default;
}

.gt-btn.is-complete:hover:not(:disabled) {
  color: var(--qj-status-success);
  border-color: color-mix(in srgb, var(--qj-status-success) 38%, var(--qj-border-strong));
  background: color-mix(in srgb, var(--qj-status-success) 10%, transparent);
}

.gt-btn.is-icon {
  width: 22px;
  padding: 0;
}

.gt-btn.is-muted {
  color: var(--qj-text-muted);
}

.gt-notes-row {
  display: flex;
  align-items: flex-start;
  gap: 6px;
  padding: 4px 8px;
  border-radius: var(--qj-radius-sm, 6px);
  background: var(--qj-bg-subtle);
  color: var(--qj-text-secondary);
  font-size: 11.5px;
  line-height: 1.45;
}

.gt-notes-row.is-blocked {
  background: color-mix(in srgb, var(--qj-status-warning) 11%, transparent);
  border: 1px solid color-mix(in srgb, var(--qj-status-warning) 30%, transparent);
  color: var(--qj-text-primary);
}

.gt-notes-row.is-complete {
  background: color-mix(in srgb, var(--qj-status-success) 9%, transparent);
  border: 1px solid color-mix(in srgb, var(--qj-status-success) 24%, transparent);
}

.gt-notes-icon {
  margin-top: 2px;
  flex-shrink: 0;
  color: var(--qj-text-muted);
}

.gt-notes-row.is-blocked .gt-notes-icon {
  color: var(--qj-status-warning);
}

.gt-notes-row.is-complete .gt-notes-icon {
  color: var(--qj-status-success);
}

.gt-notes-text {
  min-width: 0;
  flex: 1;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.gt-notes-row.is-expanded .gt-notes-text,
.gt-notes-row.is-blocked .gt-notes-text {
  white-space: pre-wrap;
  overflow: visible;
  word-break: break-word;
}

.gt-checklist {
  display: flex;
  flex-direction: column;
  gap: 3px;
  padding-top: 4px;
  border-top: 1px solid var(--qj-border-subtle, var(--qj-border-default));
}

.gt-criterion {
  display: flex;
  align-items: flex-start;
  gap: 7px;
  width: 100%;
  padding: 4px 6px;
  border: 0;
  border-radius: var(--qj-radius-sm, 6px);
  background: transparent;
  color: var(--qj-text-primary);
  font-family: inherit;
  font-size: 12px;
  line-height: 1.4;
  text-align: left;
  cursor: pointer;
  transition: background-color 120ms ease;
}

.gt-criterion:hover:not(:disabled) {
  background: var(--qj-bg-hover);
}

.gt-criterion:disabled {
  opacity: 0.6;
  cursor: default;
}

.gt-check-box {
  width: 14px;
  height: 14px;
  margin-top: 1.5px;
  border-radius: 4px;
  border: 1.5px solid var(--qj-border-strong);
  background: var(--qj-bg-surface);
  color: var(--qj-brand-contrast, #ffffff);
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
  transition: background-color 120ms ease, border-color 120ms ease;
}

.gt-criterion.is-done .gt-check-box {
  background: var(--qj-status-success);
  border-color: var(--qj-status-success);
}

.gt-criterion-text {
  min-width: 0;
  flex: 1;
}

.gt-criterion.is-done .gt-criterion-text {
  color: var(--qj-text-muted);
  text-decoration: line-through;
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

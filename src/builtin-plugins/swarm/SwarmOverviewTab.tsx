/**
 * Tab 1: Editorial Dispatch & Live Workstream `总览` (`src/builtin-plugins/swarm/SwarmOverviewTab.tsx`).
 *
 * Studio-refined hierarchy:
 * 1. Conditional Stall/Error Banner (hidden when healthy; 1-click `唤醒` & `#seq` jump)
 * 2. Editorial Masthead (`15.5px/650` balanced title + right-aligned tabular ratio + clean 1-line subtitle)
 * 3. Contextual Unmerged Worktree Action Bar (`N 处独立工作区变更待合并` + `审阅代码变更` 1-click jump to Diff)
 * 4. Always-Live `正在推进` Activity Feed (surfaces `@coordinator`'s live step even before workers spawn!)
 * 5. Expandable Progress Donut + Outcome Workstream Cards + Team Bee Filter Strip
 */
import { useMemo, useState, type ReactElement } from "react";
import type { Context } from "@deepseek-ai/cordis";
import { AlertTriangle, Check, ChevronDown, ChevronRight, GitMerge, SlidersHorizontal, X } from "lucide-react";
import { Button, IconButton } from "@qianji/client-primitives";
import type { SwarmMemberInfo, SwarmSnapshotResult } from "@qianji/protocol";
import { SwarmPixelBee } from "./SwarmPixelBee";
import {
  deriveOutcomeOverview, jumpToBoardSeq, patchSwarmUi, selectSwarmMember, useSwarmUi,
} from "./swarmStore";
import { useSwarmController } from "./useSwarmController";

export interface SwarmOverviewTabProps {
  readonly snapshot: SwarmSnapshotResult;
  readonly ctx?: Context;
}

function extractFirstSeqRef(text: string): number | null {
  const match = /#([1-9]\d*)\b/.exec(text);
  if (match === null || match[1] === undefined) return null;
  const parsed = Number.parseInt(match[1], 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function StatusGlyph({ status }: { readonly status: string }): ReactElement {
  if (status === "done") return <Check size={12} className="qj-swarm-check-icon" />;
  if (status === "working") return <span className="qj-swarm-spinner-ring" aria-hidden="true" />;
  return <span className={`qj-swarm-mini-dot is-${status}`} aria-hidden="true" />;
}

export function SwarmOverviewTab({ snapshot, ctx }: SwarmOverviewTabProps): ReactElement {
  const ui = useSwarmUi();
  const controller = useSwarmController(ctx);
  const [ringExpanded, setRingExpanded] = useState(false);

  const overview = useMemo(() => deriveOutcomeOverview(snapshot), [snapshot]);
  const unresolvedAlerts = useMemo(() => snapshot.alerts.filter((a) => !a.resolved), [snapshot.alerts]);
  const queen = snapshot.members.find((m) => m.role === "coordinator" || m.name === "coordinator");
  const workerMembers = useMemo(
    () => snapshot.members.filter((m) => m.role !== "coordinator" && m.name !== "coordinator"),
    [snapshot.members],
  );
  const activeProgressMembers = useMemo<SwarmMemberInfo[]>(() => {
    const working = snapshot.members.filter((m) => !m.killed && m.state === "working");
    if (working.length > 0) return working;
    if (workerMembers.length === 0 && snapshot.run.status === "running" && queen !== undefined && !queen.killed) {
      return [queen];
    }
    return [];
  }, [queen, snapshot.members, snapshot.run.status, workerMembers.length]);

  const dirtyLeadMember = useMemo(
    () =>
      snapshot.members.find((m) => !m.killed && m.workspaceMode !== "inherit" && m.changedFileCount > 0) ??
      snapshot.members.find((m) => !m.killed && m.changedFileCount > 0),
    [snapshot.members],
  );
  const liveTeamMembers = useMemo(() => snapshot.members.filter((m) => !m.killed), [snapshot.members]);

  const filteredThreads = useMemo(() => {
    const filterName = ui.overviewMemberFilter;
    if (filterName === null || filterName === "coordinator") return overview.threads;
    return overview.threads.filter((th) => th.items.some((item) => item.memberName === filterName));
  }, [overview.threads, ui.overviewMemberFilter]);

  const circumference = 2 * Math.PI * 7;
  const progressRatio = overview.totalCount > 0 ? Math.min(1, overview.doneCount / overview.totalCount) : 0;
  const dashLen = progressRatio * circumference;
  const hasWorkstreams = workerMembers.length > 0 || overview.threads.length > 0;

  return (
    <div className="qj-swarm-overview" data-testid="swarm-overview-tab">
      {unresolvedAlerts.length > 0 && (
        <div className="qj-swarm-alert-list" data-testid="swarm-alert-banner">
          {unresolvedAlerts.slice(0, 2).map((alert) => {
            const alertMember =
              alert.memberName !== undefined ? snapshot.members.find((m) => m.name === alert.memberName) : undefined;
            const targetSeq = extractFirstSeqRef(alert.message) ?? alertMember?.lastPostSeq ?? null;
            return (
              <div
                key={alert.id}
                className={`qj-swarm-calm-alert${alert.severity === "danger" ? " is-danger" : ""}`}
                role="status"
              >
                <AlertTriangle size={13} className="qj-swarm-alert-icon" />
                <span className="qj-swarm-alert-text">{alert.message}</span>
                <div className="qj-swarm-alert-btns">
                  {alert.memberName !== undefined && alert.memberName !== "" && (
                    <button
                      type="button"
                      className="qj-swarm-inline-action"
                      onClick={() => {
                        const targetName = alert.memberName ?? "";
                        void controller.controlMember(snapshot.run.id, targetName, "nudge", {
                          message: "请继续推进当前子任务并在消息板回报进展",
                        });
                        void controller.controlRun(snapshot.run.id, "dismissAlert", { alertId: alert.id });
                      }}
                    >
                      唤醒
                    </button>
                  )}
                  {targetSeq !== null && (
                    <button type="button" className="qj-swarm-seq-pill" onClick={() => jumpToBoardSeq(targetSeq)}>
                      #{targetSeq}
                    </button>
                  )}
                  <IconButton
                    size="sm"
                    aria-label="忽略告警"
                    onClick={() => void controller.controlRun(snapshot.run.id, "dismissAlert", { alertId: alert.id })}
                  >
                    <X size={12} />
                  </IconButton>
                </div>
              </div>
            );
          })}
        </div>
      )}

      <section className="qj-swarm-masthead" data-testid="swarm-goal-card">
        <div className="qj-swarm-masthead-row">
          <h3 className="qj-swarm-goal-title">{overview.goalTitle}</h3>
          {overview.totalCount > 0 && (
            <span className="qj-swarm-masthead-ratio" data-testid="swarm-masthead-ratio">
              {overview.doneCount}/{overview.totalCount}
            </span>
          )}
        </div>
        {overview.goalLine !== "" && overview.goalLine !== overview.goalTitle && (
          <p className="qj-swarm-goal-line">{overview.goalLine}</p>
        )}
      </section>

      {overview.dirtyFileCount > 0 && dirtyLeadMember !== undefined && (
        <div className="qj-swarm-dirty-bar" data-testid="swarm-dirty-worktree-bar">
          <span className="qj-swarm-dirty-bar-copy">
            <GitMerge size={13} className="qj-swarm-dirty-bar-icon" aria-hidden="true" />
            <span>{overview.dirtyFileCount} 处独立工作区变更待合并</span>
          </span>
          <button
            type="button"
            className="qj-swarm-dirty-bar-btn"
            data-testid="swarm-review-changes-btn"
            onClick={() => selectSwarmMember(dirtyLeadMember.name, { inspectorTab: "diff" })}
          >
            审阅代码变更
          </button>
        </div>
      )}

      {activeProgressMembers.length > 0 && (
        <section className="qj-swarm-running-section" data-testid="swarm-running-now">
          <header className="qj-swarm-subhead">
            <span className="qj-swarm-dot is-working" />
            <span>正在推进</span>
            <span className="qj-swarm-subcount">{activeProgressMembers.length}</span>
          </header>
          <div className="qj-swarm-running-list">
            {activeProgressMembers.map((m) => {
              const isCoord = m.role === "coordinator" || m.name === "coordinator";
              const fallbackCopy =
                isCoord && workerMembers.length === 0 ? "协调者正在分析仓库并规划分工…" : "正在推理与执行…";
              const activity = m.currentStep || m.currentTool || fallbackCopy;
              return (
                <button
                  key={m.name}
                  type="button"
                  className="qj-swarm-running-row"
                  data-testid={`swarm-running-row-${m.name}`}
                  onClick={() => selectSwarmMember(m.name, { inspectorTab: "session" })}
                >
                  <SwarmPixelBee name={m.name} isQueen={isCoord} state="working" size="sm" />
                  <span className="qj-swarm-row-handle">@{m.name}</span>
                  <span className="qj-swarm-row-step shimmer-text">{activity}</span>
                </button>
              );
            })}
          </div>
        </section>
      )}

      {!hasWorkstreams ? (
        <section className="qj-swarm-starting-empty" data-testid="swarm-starting-empty">
          <div className="qj-swarm-silhouette-cluster" aria-hidden="true">
            <SwarmPixelBee name={queen?.name ?? "coordinator"} isQueen state={queen?.state ?? "working"} size="md" />
            <div className="qj-swarm-silhouette-workers">
              <SwarmPixelBee name="silhouette-1" state="waiting" size="sm" className="is-silhouette" />
              <SwarmPixelBee name="silhouette-2" state="waiting" size="sm" className="is-silhouette" />
              <SwarmPixelBee name="silhouette-3" state="waiting" size="sm" className="is-silhouette" />
            </div>
          </div>
          <strong className="qj-swarm-explainer-lead">等待派生专职成员</strong>
          <p className="qj-swarm-explainer-sub">
            协调者完成代码扫描与方案拆解后，将按职责召集工蜂并在独立工作区并行推进。
          </p>
          <Button
            variant="secondary"
            size="sm"
            onClick={() =>
              patchSwarmUi({ activeSwarmId: snapshot.run.id, roleModelsModalOpen: true, roleModelsModalScope: "session" })
            }
          >
            <SlidersHorizontal size={12.5} />
            <span>按角色预设模型</span>
          </Button>
        </section>
      ) : (
        <>
          <section className="qj-swarm-progress-block">
            <button
              type="button"
              className="qj-swarm-progress-ring-row"
              data-testid="swarm-progress-ring-toggle"
              aria-expanded={ringExpanded}
              onClick={() => setRingExpanded((v) => !v)}
            >
              <svg width="18" height="18" viewBox="0 0 18 18" className="qj-swarm-donut" aria-hidden="true">
                <circle cx="9" cy="9" r="7" fill="none" stroke="var(--qj-border-strong)" strokeWidth="2.2" />
                {dashLen > 0 && (
                  <circle
                    cx="9" cy="9" r="7" fill="none" stroke="var(--qj-status-success)"
                    strokeWidth="2.2" strokeLinecap="round" strokeDasharray={`${dashLen} ${circumference}`}
                    transform="rotate(-90 9 9)"
                  />
                )}
              </svg>
              <strong className="qj-swarm-progress-main">
                已完成 {overview.doneCount} / {overview.totalCount} 项
              </strong>
              {overview.verifyingCount > 0 && <span className="qj-swarm-meta-pill">{overview.verifyingCount} 待审阅</span>}
              {overview.dirtyFileCount > 0 && (
                <span className="qj-swarm-meta-pill is-warning">{overview.dirtyFileCount} 文件待合并</span>
              )}
              <span className="qj-swarm-progress-chevron">
                {ringExpanded ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
              </span>
            </button>

            {ringExpanded && overview.allItems.length > 0 && (
              <div className="qj-swarm-progress-drawer" data-testid="swarm-progress-drawer">
                {overview.allItems.map((item) => (
                  <button
                    key={item.memberName}
                    type="button"
                    className={`qj-swarm-checklist-row is-${item.status}`}
                    onClick={() => selectSwarmMember(item.memberName, { inspectorTab: "session" })}
                  >
                    <StatusGlyph status={item.status} />
                    <span className="qj-swarm-row-handle">@{item.memberName}</span>
                    <span className="qj-swarm-checklist-label">{item.label}</span>
                  </button>
                ))}
              </div>
            )}
          </section>

          <section className="qj-swarm-threads-list" data-testid="swarm-outcome-threads">
            {filteredThreads.map((thread) => {
              const pct = thread.totalCount > 0 ? Math.round((thread.doneCount / thread.totalCount) * 100) : 0;
              return (
                <article
                  key={thread.id}
                  className={`qj-swarm-thread-card state-${thread.state}`}
                  data-testid={`swarm-outcome-thread-${thread.id}`}
                  data-thread-state={thread.state}
                >
                  <header className="qj-swarm-thread-head">
                    <span className={`qj-swarm-thread-dot state-${thread.state}`} aria-hidden="true" />
                    <h4 className="qj-swarm-thread-title">{thread.title}</h4>
                    <span className="qj-swarm-thread-fraction">{thread.doneCount}/{thread.totalCount}</span>
                    <span className="qj-swarm-thread-minibar" aria-hidden="true">
                      <span className="qj-swarm-thread-minifill" style={{ width: `${pct}%` }} />
                    </span>
                  </header>
                  {thread.goal !== "" && thread.goal !== thread.title && (
                    <p className="qj-swarm-thread-goal">{thread.goal}</p>
                  )}
                  <div className="qj-swarm-thread-items">
                    {thread.items.map((item) => (
                      <button
                        key={`${thread.id}:${item.memberName}`}
                        type="button"
                        className={`qj-swarm-thread-item is-${item.status}`}
                        onClick={() => selectSwarmMember(item.memberName, { inspectorTab: "session" })}
                      >
                        <StatusGlyph status={item.status} />
                        <span className="qj-swarm-thread-member">@{item.memberName}</span>
                        <span className="qj-swarm-thread-task">{item.label}</span>
                        {item.waitingOn !== undefined && (
                          <span className="qj-swarm-waiting-tag">等待 @{item.waitingOn}</span>
                        )}
                      </button>
                    ))}
                  </div>
                </article>
              );
            })}
          </section>

          <footer className="qj-swarm-bee-strip" data-testid="swarm-bee-filter-strip">
            <div className="qj-swarm-bee-tiles" role="group" aria-label="按成员筛选进展">
              <button
                type="button"
                className={`qj-swarm-bee-tile${ui.overviewMemberFilter === null ? " active" : ""}`}
                aria-pressed={ui.overviewMemberFilter === null}
                onClick={() => patchSwarmUi({ overviewMemberFilter: null })}
              >
                <span>全部</span>
              </button>
              {liveTeamMembers.map((m) => {
                const isSelected = ui.overviewMemberFilter === m.name;
                return (
                  <button
                    key={m.name}
                    type="button"
                    className={`qj-swarm-bee-tile${isSelected ? " active" : ""}`}
                    aria-pressed={isSelected}
                    title={`筛选 @${m.name}`}
                    onClick={() => patchSwarmUi({ overviewMemberFilter: isSelected ? null : m.name })}
                  >
                    <SwarmPixelBee
                      name={m.name}
                      isQueen={m.role === "coordinator" || m.name === "coordinator"}
                      state={m.state}
                      size="sm"
                    />
                    <span className="qj-swarm-bee-tile-name">{m.name}</span>
                  </button>
                );
              })}
            </div>

            {ui.overviewMemberFilter !== null && (
              <button
                type="button"
                className="qj-swarm-open-session-link"
                data-testid="swarm-filter-open-session"
                onClick={() => selectSwarmMember(ui.overviewMemberFilter, { inspectorTab: "session" })}
              >
                <span>打开会话</span>
              </button>
            )}
          </footer>
        </>
      )}
    </div>
  );
}

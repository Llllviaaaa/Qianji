/**
 * 1:1 Meta Muse Right `360px` Companion Sheet (`BotCompanionPanel`).
 *
 * Frameless Live2D companion portrait, companion name + consolidated single
 * live status line (`bot-vserver-pill`: `已连接` at idle, morphing seamlessly to
 * active tool/approval/hover status during tasks), `9999px` 4-icon pill switcher
 * (`动态 · 批准 · 身份 · 邮箱`), and collapsible scheduled-task + activity groups.
 */
import { useState, type ReactElement } from "react";
import type { Context } from "@deepseek-ai/cordis";
import {
  Activity, AlertCircle, ArrowUpRight, CalendarClock, CheckCircle2, ChevronDown,
  Clock, Fingerprint, Globe, Heart, Layers, Loader2, Mail, MonitorPlay, Play, Plus, ShieldCheck, Target, X,
} from "lucide-react";
import type { BotActivityKind, BotActivityStatus } from "@qianji/protocol";
import { BotCharacterStage, useCompanionTaskRuntime } from "./BotCharacterStage";
import { BotCompanionApprovalsTab } from "./BotCompanionApprovalsTab";
import { BotCompanionIdentityTab, BotCompanionInboxTab } from "./BotCompanionIdentityAndInbox";
import { BotComputerMiniPip } from "./computer-studio/BotComputerMiniPip";
import { toggleComputerStudio, useComputerStudioUi } from "./computer-studio/computerStudioStore";
import { formatBotScheduleCadence, formatRelativeNextRun, useBotScheduleManager } from "./botScheduleStore";
import {
  formatVirtualServerStatus, openBotActivityDetail, openBotModal, openBotScheduledModal,
  patchBotUi, useBotController, useBotSnapshot, useBotUiState, type BotCompanionTab,
} from "./botStore";
import type { ResolvedTaskCompanionPresence } from "./live2d/botTaskChoreographer";

const RIGHT_TABS: ReadonlyArray<{ readonly id: BotCompanionTab; readonly label: string; readonly Icon: typeof Activity }> = [
  { id: "activity", label: "动态", Icon: Activity },
  { id: "approvals", label: "批准", Icon: ShieldCheck },
  { id: "identity", label: "身份", Icon: Fingerprint },
  { id: "inbox", label: "邮箱", Icon: Mail },
];

function normalizeActivityDesc(raw: string): string {
  if (raw === "Updated main companion conversation") return "已同步更新主聊天上下文";
  if (raw === "Updated isolated side conversation") return "已同步更新独立旁聊上下文";
  return raw
    .replace(/\[\[options:[\s\S]*?\]\]/gi, "")
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/[*_`~]+/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function resolveTaskDotColor(tone: ResolvedTaskCompanionPresence["statusTone"], fallbackColor: string): string {
  if (tone === "warning") return "var(--qj-status-warning)";
  if (tone === "danger") return "var(--qj-status-danger)";
  if (tone === "success") return "var(--qj-status-success)";
  if (tone === "active") return "var(--qj-brand-primary)";
  return fallbackColor;
}

function renderActivityStatusIcon(
  status: BotActivityStatus | undefined,
  kind: BotActivityKind | undefined,
  statusTitle: string | undefined,
): ReactElement {
  if (status === "running") {
    return <Loader2 size={15.5} strokeWidth={2} className="animate-spin" style={{ color: "var(--qj-brand-primary)" }} />;
  }
  if (status === "error") {
    return <AlertCircle size={15.5} strokeWidth={1.85} style={{ color: "var(--qj-status-danger)" }} />;
  }
  if (status === "interrupted" || statusTitle === "等待确认") {
    return <Clock size={15.5} strokeWidth={1.85} style={{ color: "var(--qj-status-warning)" }} />;
  }
  if (kind === "browser") return <Globe size={15.5} strokeWidth={1.8} />;
  if (kind === "scheduled" || kind === "patrol") return <CalendarClock size={15.5} strokeWidth={1.8} />;
  if (kind === "mail") return <Mail size={15.5} strokeWidth={1.8} />;
  if (kind === "goal") return <Target size={15.5} strokeWidth={1.8} />;
  if (kind === "space") return <Layers size={15.5} strokeWidth={1.8} />;
  return <CheckCircle2 size={15.5} strokeWidth={1.8} />;
}

export function BotCompanionPanel({ ctx }: { readonly ctx?: Context }): ReactElement {
  const ui = useBotUiState();
  const studioUi = useComputerStudioUi();
  const snapshot = useBotSnapshot();
  const ctrl = useBotController(ctx);
  const sched = useBotScheduleManager(ctx);
  const { taskPresence } = useCompanionTaskRuntime(ctx);
  const [collapsedDates, setCollapsedDates] = useState<Readonly<Record<string, boolean>>>({});

  const tabIdx = Math.max(0, RIGHT_TABS.findIndex((t) => t.id === ui.rightTab));
  const pendingCount = snapshot.pendingApprovals.length;
  const serverStatus = formatVirtualServerStatus(snapshot.virtualServer);
  const isPanelVisible = ui.rightPanelOpen && ui.activeView === "chat";

  const customTasks = ui.scheduledTasks.filter((t) => t.id !== "heartbeat" && !t.isHeartbeat);
  const totalScheduledCount = 1 + customTasks.length;

  const isIdlePhase = taskPresence.phase === "idle-ready";
  const statusDotColor = isIdlePhase
    ? serverStatus.dotColor
    : resolveTaskDotColor(taskPresence.statusTone, serverStatus.dotColor);
  const statusLabel = isIdlePhase
    ? serverStatus.label
    : (taskPresence.activeToolLabel ?? taskPresence.badgeLabelZh);
  const statusTitle = isIdlePhase ? "点击配置虚拟服务器环境" : "点击查看当前任务详情";

  const isActiveRunPhase =
    taskPresence.phase === "thinking-stream" ||
    taskPresence.phase === "tool-reading" ||
    taskPresence.phase === "tool-editing" ||
    taskPresence.phase === "tool-command" ||
    taskPresence.phase === "tool-web" ||
    taskPresence.phase === "patrol-running" ||
    taskPresence.phase === "task-error";

  const handleStatusPillClick = () => {
    if (taskPresence.phase === "awaiting-approval") {
      patchBotUi({ rightPanelOpen: true, rightTab: "approvals" });
      return;
    }
    if (taskPresence.phase === "unread-briefing") {
      patchBotUi({ rightPanelOpen: true, rightTab: "inbox" });
      return;
    }
    if (isActiveRunPhase) {
      patchBotUi({ rightPanelOpen: true, rightTab: "activity" });
      return;
    }
    openBotModal("settings", "server");
  };

  return (
    <aside id="bot-right-inner" className="qj-bot-sheet" aria-label="陪伴动态与分身状态" data-testid="bot-companion-panel">
      <div className="qj-sheet-top">
        {isPanelVisible && (
          <button
            id="btn-toggle-right-panel"
            type="button"
            className="qj-sheet-close-btn"
            title="收起陪伴面板"
            aria-label="收起陪伴面板"
            onClick={() => patchBotUi({ rightPanelOpen: false })}
          >
            <X size={17} strokeWidth={1.8} />
          </button>
        )}

        <BotCharacterStage ctx={ctx} />

        <div className="qj-sheet-hero-meta">
          <div className="qj-sheet-companion-name">{snapshot.profile.displayName}</div>
          <div className="qj-sheet-status-row">
            <button
              type="button"
              data-testid="bot-vserver-pill"
              data-task-phase={taskPresence.phase}
              data-tone={isIdlePhase ? "neutral" : taskPresence.statusTone}
              className="qj-sheet-vserver-pill"
              title={statusTitle}
              onClick={handleStatusPillClick}
            >
              <span className="qj-sheet-vserver-dot" style={{ background: statusDotColor }} />
              <span className="qj-sheet-vserver-label">{statusLabel}</span>
            </button>
            <button
              type="button"
              data-testid="bot-open-computer-studio-btn"
              aria-pressed={studioUi.studioOpen}
              className={`qj-cs-quick-studio-pill${studioUi.studioOpen ? " active" : ""}`}
              title="打开千机的分身电脑实时分屏"
              onClick={() => toggleComputerStudio()}
            >
              <MonitorPlay size={12} strokeWidth={1.9} />
              <span>打开分身电脑</span>
            </button>
          </div>
        </div>

        <BotComputerMiniPip />

        <div
          id="right-tab-pill"
          className="qj-sheet-tab-pill"
          role="tablist"
          aria-label="陪伴面板分栏"
          style={{ ["--tab-idx" as string]: String(tabIdx) }}
        >
          <div id="right-tab-thumb" className="qj-sheet-tab-thumb" aria-hidden="true" />
          {RIGHT_TABS.map(({ id, label, Icon }) => {
            const active = ui.rightTab === id;
            return (
              <button
                key={id}
                type="button"
                role="tab"
                data-companion-tab={id}
                title={label}
                aria-label={label}
                aria-selected={active}
                className={`qj-sheet-tab-btn${active ? " active" : ""}`}
                onClick={() => patchBotUi({ rightTab: id })}
              >
                <Icon size={16} strokeWidth={1.85} aria-hidden="true" />
                {id === "approvals" && pendingCount > 0 && <span className="qj-sheet-tab-dot" aria-hidden="true" />}
              </button>
            );
          })}
        </div>
      </div>

      <div className="qj-sheet-scroll">
        {ui.rightTab === "activity" && (
          <div className="qj-animate-page-in qj-sheet-pane">
            <div className="qj-sheet-scheduled-section">
              <div className="qj-sheet-section-head">
                <button
                  type="button"
                  className="qj-sheet-collapse-btn"
                  aria-expanded={ui.scheduledExpanded}
                  onClick={() => patchBotUi({ scheduledExpanded: !ui.scheduledExpanded })}
                >
                  <span className="qj-tabular">{`${totalScheduledCount} 项预定任务`}</span>
                  <ChevronDown size={15} className={ui.scheduledExpanded ? "" : "collapsed"} />
                </button>
                <button
                  type="button"
                  className="qj-sheet-sched-add-btn"
                  title="新建预定任务"
                  aria-label="新建预定任务"
                  data-testid="bot-companion-new-scheduled"
                  onClick={() => openBotScheduledModal("create")}
                >
                  <Plus size={15} strokeWidth={1.9} aria-hidden="true" />
                </button>
              </div>

              {ui.scheduledExpanded && (
                <div className="qj-sheet-patrol-body">
                  <div className="qj-sheet-sched-item">
                    <button
                      type="button"
                      className="qj-sheet-patrol-toggle"
                      title="查看 Heartbeat 详情与运行记录"
                      onClick={() => openBotScheduledModal("heartbeat")}
                    >
                      <span className={`qj-sheet-heart-badge${snapshot.pacing.heartbeatEnabled ? " active" : ""}`}>
                        <Heart size={15} />
                      </span>
                      <div className="qj-sheet-patrol-copy">
                        <div className="qj-sheet-patrol-title">Heartbeat</div>
                        <div className="qj-sheet-patrol-meta qj-tabular">
                          每{snapshot.pacing.heartbeatIntervalMinutes}分钟
                          {snapshot.pacing.heartbeatEnabled ? "" : " · 已暂停"}
                        </div>
                      </div>
                    </button>
                    <button
                      type="button"
                      className="qj-sheet-quick-run-btn"
                      title="立即运行一次巡检"
                      aria-label="立即运行 Heartbeat"
                      disabled={ui.serverBusy}
                      onClick={() => void ctrl.runPatrolNow()}
                    >
                      <Play size={13} />
                    </button>
                  </div>

                  {customTasks.map((task) => {
                    const nextRel = task.enabled ? formatRelativeNextRun(task.nextRunAt) : "";
                    return (
                      <div key={task.id} className="qj-sheet-sched-item">
                        <button
                          type="button"
                          className="qj-sheet-patrol-toggle"
                          title={`查看「${task.name}」运行记录`}
                          onClick={() => openBotScheduledModal(task.id)}
                        >
                          <span className={`qj-sheet-routine-badge${task.enabled ? "" : " paused"}`}>
                            <CalendarClock size={15} />
                          </span>
                          <div className="qj-sheet-patrol-copy">
                            <div className="qj-sheet-patrol-title">{task.name}</div>
                            <div className="qj-sheet-patrol-meta qj-tabular">
                              {formatBotScheduleCadence(task)}
                              {!task.enabled ? " · 已暂停" : nextRel !== "" ? ` · ${nextRel}` : ""}
                            </div>
                          </div>
                        </button>
                        <button
                          type="button"
                          className="qj-sheet-quick-run-btn"
                          title="立即运行此预定任务"
                          aria-label={`立即运行 ${task.name}`}
                          disabled={task.running === true}
                          onClick={() => void sched.runTaskNow(task)}
                        >
                          <Play size={13} />
                        </button>
                      </div>
                    );
                  })}

                  <button type="button" className="qj-sheet-view-all-btn" onClick={() => openBotScheduledModal(null)}>
                    查看所有预定任务
                  </button>
                </div>
              )}
            </div>

            {snapshot.activityGroups.length > 0 && (
              <div className="qj-sheet-activity-groups">
                {snapshot.activityGroups.map((g) => {
                  const collapsed = collapsedDates[g.date] === true;
                  return (
                    <div key={g.date} className="qj-sheet-day-group">
                      <button
                        type="button"
                        className="qj-sheet-collapse-btn"
                        onClick={() => setCollapsedDates((prev) => ({ ...prev, [g.date]: !collapsed }))}
                      >
                        <span>{g.date}</span>
                        <ChevronDown size={15} className={collapsed ? "collapsed" : ""} />
                      </button>

                      {!collapsed && (
                        <div className="qj-sheet-day-list">
                          {g.items.map((it) => {
                            const handoff = it.handoff;
                            return (
                              <div key={it.id} className="qj-sheet-activity-item-wrap">
                                  <button
                                    type="button"
                                    className="qj-sheet-activity-row interactive"
                                    data-testid="bot-activity-row"
                                    data-status={it.status ?? "completed"}
                                    data-kind={it.kind ?? "chat"}
                                    onClick={() => openBotActivityDetail(it)}
                                  >
                                    <span
                                      className="qj-sheet-activity-icon"
                                      data-activity-status={it.status ?? "completed"}
                                      data-activity-kind={it.kind ?? "chat"}
                                    >
                                      {renderActivityStatusIcon(it.status, it.kind, it.statusTitle)}
                                    </span>
                                    <div className="qj-sheet-activity-copy">
                                      <div className="qj-sheet-activity-title">{it.title}</div>
                                      <div className="qj-sheet-activity-desc">
                                        {normalizeActivityDesc(it.subtitle ?? it.description)}
                                      </div>
                                      <div className="qj-sheet-activity-time qj-tabular">
                                        {it.status === "running"
                                          ? `执行中 · ${it.timeLabel}`
                                          : it.statusTitle
                                            ? `${it.statusTitle} · ${it.timeLabel}`
                                            : it.timeLabel}
                                      </div>
                                    </div>
                                  </button>
                                {handoff && (
                                  <button
                                    type="button"
                                    className="qj-sheet-handoff-quick-btn"
                                    title="在 Agent 工作台中打开"
                                    aria-label={`在工作台中打开 ${it.title}`}
                                    onClick={() => ctrl.triggerHandoff(handoff)}
                                  >
                                    <ArrowUpRight size={14} />
                                  </button>
                                )}
                              </div>
                            );
                          })}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        )}

        {ui.rightTab === "approvals" && <BotCompanionApprovalsTab ctx={ctx} />}
        {ui.rightTab === "identity" && <BotCompanionIdentityTab ctx={ctx} />}
        {ui.rightTab === "inbox" && <BotCompanionInboxTab ctx={ctx} />}
      </div>
    </aside>
  );
}

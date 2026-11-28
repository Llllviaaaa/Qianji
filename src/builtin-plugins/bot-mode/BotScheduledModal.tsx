/**
 * Muse `预定任务` Dialog (`<BotScheduledModal>`, `src/builtin-plugins/bot-mode/BotScheduledModal.tsx`).
 */
import { useState, type ReactElement } from "react";
import type { Context } from "@deepseek-ai/cordis";
import { ArrowLeft, CalendarClock, Heart, Play, Plus, X } from "lucide-react";
import {
  BotScheduledEditorForm,
  BotScheduledNlQuickBar,
  BotScheduledTaskDetailPane,
} from "./BotScheduledEditorPane";
import {
  formatBotScheduleCadence,
  formatRelativeNextRun,
  useBotScheduleManager,
  type NaturalScheduleParseResult,
} from "./botScheduleStore";
import {
  closeActiveBotModal,
  patchBotUi,
  useBotSnapshot,
  useBotUiState,
  type BotScheduledSummary,
} from "./botStore";

interface RoutineGroup {
  readonly id: string;
  readonly title: string;
  readonly items: readonly BotScheduledSummary[];
}

function buildCanonicalTasks(
  rawTasks: readonly BotScheduledSummary[],
  heartbeatEnabled: boolean,
  heartbeatMinutes: number,
  lastPatrolAt?: number,
): readonly BotScheduledSummary[] {
  const mins = Math.max(5, heartbeatMinutes || 30);
  const existingHb = rawTasks.find((t) => t.id === "heartbeat" || t.isHeartbeat === true);
  const heartbeat: BotScheduledSummary = {
    ...existingHb,
    id: "heartbeat",
    name: "Heartbeat",
    frequency: "interval",
    intervalMinutes: mins,
    cronOrInterval: `每${mins}分钟`,
    enabled: heartbeatEnabled,
    lastRunAt: lastPatrolAt ?? existingHb?.lastRunAt,
    isHeartbeat: true,
  };
  return [heartbeat, ...rawTasks.filter((t) => t.id !== "heartbeat" && !t.isHeartbeat)];
}

function groupRoutines(allTasks: readonly BotScheduledSummary[]): readonly RoutineGroup[] {
  const highFreq: BotScheduledSummary[] = [];
  const dailyWeekdays: BotScheduledSummary[] = [];
  const weeklyOnce: BotScheduledSummary[] = [];
  const paused: BotScheduledSummary[] = [];

  for (const item of allTasks) {
    if (!item.enabled) paused.push(item);
    else if (item.isHeartbeat || item.frequency === "interval" || item.frequency === "hourly") highFreq.push(item);
    else if (item.frequency === "daily" || item.frequency === "weekdays") dailyWeekdays.push(item);
    else weeklyOnce.push(item);
  }

  return [
    { id: "high-freq", title: "高频巡检", items: highFreq },
    { id: "daily", title: "每日与工作日", items: dailyWeekdays },
    { id: "weekly", title: "每周与单次", items: weeklyOnce },
    { id: "paused", title: "已暂停", items: paused },
  ].filter((g) => g.items.length > 0);
}

function formatRowMeta(item: BotScheduledSummary): string {
  const cadence = item.isHeartbeat ? item.cronOrInterval : formatBotScheduleCadence(item);
  if (!item.enabled) return `${cadence} · 已暂停`;
  if (item.running) return `${cadence} · 正在执行…`;
  const rel = formatRelativeNextRun(item.nextRunAt);
  if (rel === "") return cadence;
  return rel.endsWith("后") ? `${cadence} · 距下次 ${rel.slice(0, -1)}` : `${cadence} · 下次 ${rel}`;
}

function ScheduledRoutineGroups(props: {
  readonly groups: readonly RoutineGroup[];
  readonly serverBusy: boolean;
  readonly onSelectTask: (id: string) => void;
  readonly onToggleTask: (task: BotScheduledSummary) => void;
  readonly onRunTask: (task: BotScheduledSummary) => void;
}): ReactElement {
  const { groups, serverBusy, onSelectTask, onToggleTask, onRunTask } = props;
  return (
    <div className="qj-sched-groups">
      {groups.map((group) => (
        <section key={group.id} className="qj-sched-group">
          <div className="qj-sched-group-head">
            <span>{group.title}</span>
            <span className="qj-tabular">{group.items.length}</span>
          </div>
          <div className="qj-sched-group-list">
            {group.items.map((item) => {
              const isHb = item.id === "heartbeat" || item.isHeartbeat === true;
              const isBusy = isHb ? serverBusy : item.running === true;
              return (
                <div key={item.id} className="qj-sched-row-card">
                  <button type="button" className="qj-sched-row-main" onClick={() => onSelectTask(item.id)}>
                    <span className={`qj-sched-icon-circle ${!item.enabled ? "paused" : isHb ? "heartbeat" : "routine"}`}>
                      {isHb ? <Heart size={17} /> : <CalendarClock size={17} />}
                    </span>
                    <span className="qj-sched-row-copy">
                      <span className="qj-sched-row-title-line">
                        <span className="qj-sched-row-title">{item.name}</span>
                        {isBusy && <span className="qj-sched-running-dot" aria-hidden="true" />}
                      </span>
                      <span className="qj-sched-row-meta">{formatRowMeta(item)}</span>
                    </span>
                  </button>

                  <div className="qj-sched-row-controls">
                    <button
                      type="button"
                      className="qj-sched-play-btn"
                      title="立即运行"
                      aria-label={`立即运行 ${item.name}`}
                      disabled={isBusy}
                      onClick={() => onRunTask(item)}
                    >
                      <Play size={13} />
                    </button>
                    <button
                      type="button"
                      role="switch"
                      aria-checked={item.enabled}
                      aria-label={`${item.enabled ? "暂停" : "启用"} ${item.name}`}
                      className="qj-sched-switch"
                      onClick={() => onToggleTask(item)}
                    >
                      <span className="qj-sched-switch-thumb" />
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        </section>
      ))}
    </div>
  );
}

export function BotScheduledModal({ ctx }: { readonly ctx?: Context }): ReactElement {
  const ui = useBotUiState();
  const snapshot = useBotSnapshot();
  const sched = useBotScheduleManager(ctx);
  const [nlText, setNlText] = useState("");
  const [prefillNl, setPrefillNl] = useState("");
  const [editingTaskId, setEditingTaskId] = useState<string | null>(null);

  const allTasks = buildCanonicalTasks(
    sched.tasks,
    snapshot.pacing.heartbeatEnabled,
    snapshot.pacing.heartbeatIntervalMinutes,
    snapshot.awareness.lastPatrolAt,
  );
  const groups = groupRoutines(allTasks);
  const effectiveCwd = snapshot.botCwd;

  const quickCreate = async (parsed: NaturalScheduleParseResult) => {
    const saved = await sched.saveTask({
      name: parsed.nameSuggestion || "新建预定任务",
      prompt: parsed.cleanPrompt || nlText.trim(),
      cwd: effectiveCwd,
      frequency: parsed.frequency,
      intervalMinutes: parsed.intervalMinutes,
      hour: parsed.hour,
      minute: parsed.minute,
      weekday: parsed.weekday,
      runAt: parsed.runAt,
      permissionMode: "ask",
      enabled: true,
    });
    setNlText("");
    setEditingTaskId(null);
    if (saved?.id) patchBotUi({ selectedScheduledTaskId: saved.id });
  };

  const closeModal = () => {
    patchBotUi({ selectedScheduledTaskId: null });
    closeActiveBotModal();
  };
  const selectedId = ui.selectedScheduledTaskId;
  const isCreateMode = selectedId === "create";
  const editingTask = editingTaskId !== null ? (allTasks.find((t) => t.id === editingTaskId) ?? null) : null;
  const detailTask = selectedId !== null && selectedId !== "create" ? (allTasks.find((t) => t.id === selectedId) ?? null) : null;

  const cancelEditor = () => {
    setEditingTaskId(null);
    setPrefillNl("");
    patchBotUi({ selectedScheduledTaskId: editingTask ? editingTask.id : null });
  };

  return (
    <div className="qj-bot-modal-backdrop" onClick={closeModal} data-testid="bot-scheduled-modal">
      <div className="qj-bot-dialog qj-bot-sched-modal" onClick={(e) => e.stopPropagation()}>
        {isCreateMode || editingTask !== null ? (
          <>
            <div className="qj-sched-head">
              <div className="qj-sched-editor-head-left">
                <button type="button" className="qj-sched-back-btn" onClick={cancelEditor}>
                  <ArrowLeft size={14} />
                  <span>返回</span>
                </button>
                <h2 className="qj-sched-title qj-sched-title-compact">
                  {editingTask ? "编辑预定任务" : "新建预定任务"}
                </h2>
              </div>
              <button type="button" aria-label="关闭预定任务" className="qj-muse-modal-close" onClick={closeModal}>
                <X size={16} strokeWidth={1.85} />
              </button>
            </div>
            <div className="qj-sched-body">
              <BotScheduledEditorForm
                key={editingTask?.id ?? `create-${prefillNl}`}
                initialTask={editingTask}
                prefillNl={prefillNl}
                defaultCwd={effectiveCwd}
                busy={sched.loading}
                onCancel={cancelEditor}
                onSave={async (draft) => {
                  const saved = await sched.saveTask(draft);
                  setEditingTaskId(null);
                  setPrefillNl("");
                  patchBotUi({ selectedScheduledTaskId: saved?.id ?? editingTask?.id ?? null });
                }}
              />
            </div>
          </>
        ) : detailTask !== null ? (
          <BotScheduledTaskDetailPane
            key={detailTask.id}
            ctx={ctx}
            task={detailTask}
            showBackButton
            showCloseButton
            onBack={() => patchBotUi({ selectedScheduledTaskId: null })}
            onClose={closeModal}
            onEditTask={(t) => setEditingTaskId(t.id)}
            onDeletedTask={() => patchBotUi({ selectedScheduledTaskId: null })}
          />
        ) : (
          <>
            <div className="qj-sched-head">
              <div className="qj-sched-head-titles">
                <h2 className="qj-sched-title">预定任务</h2>
                <p className="qj-sched-subtitle">由千机在后台按计划自动执行并留存每次记录</p>
              </div>
              <div className="qj-sched-head-actions">
                <button
                  type="button"
                  data-testid="bot-scheduled-new-btn"
                  className="qj-sched-new-pill"
                  onClick={() => { setPrefillNl(""); patchBotUi({ selectedScheduledTaskId: "create" }); }}
                >
                  <Plus size={14} strokeWidth={2.1} />
                  <span>新建任务</span>
                </button>
                <button type="button" aria-label="关闭预定任务" className="qj-muse-modal-close" onClick={closeModal}>
                  <X size={16} strokeWidth={1.85} />
                </button>
              </div>
            </div>

            <div className="qj-sched-body">
              <BotScheduledNlQuickBar
                nlText={nlText}
                onChangeNlText={setNlText}
                busy={sched.loading}
                onQuickCreate={(parsed) => void quickCreate(parsed)}
                onOpenAdvanced={() => {
                  setPrefillNl(nlText);
                  setNlText("");
                  patchBotUi({ selectedScheduledTaskId: "create" });
                }}
              />
              <ScheduledRoutineGroups
                groups={groups}
                serverBusy={ui.serverBusy}
                onSelectTask={(id) => patchBotUi({ selectedScheduledTaskId: id })}
                onToggleTask={(t) => void sched.toggleTaskEnabled(t)}
                onRunTask={(t) => void sched.runTaskNow(t)}
              />
            </div>
          </>
        )}
      </div>
    </div>
  );
}

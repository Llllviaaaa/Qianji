/**
 * Natural-Language Quick Creator, Structured Cadence Editor, and Single-Task
 * Detail + `运行记录` Inspector (`src/builtin-plugins/bot-mode/BotScheduledEditorPane.tsx`).
 */
import { useEffect, useState, type FormEvent, type ReactElement } from "react";
import type { Context } from "@deepseek-ai/cordis";
import {
  ArrowLeft, CalendarClock, ChevronDown, Heart, MessageSquare,
  Pencil, Play, Shield, Sparkles, Trash2, X,
} from "lucide-react";
import type { ScheduledRunInfo } from "@qianji/protocol";
import {
  formatBotScheduleCadence, formatRelativeNextRun, parseNaturalScheduleInput,
  useBotScheduleManager, type BotScheduleFrequency, type BotScheduleSaveDraft,
  type NaturalScheduleParseResult,
} from "./botScheduleStore";
import { openBotModal, patchBotUi, useBotSnapshot, useBotUiState, type BotScheduledSummary } from "./botStore";

const FREQUENCY_OPTIONS: ReadonlyArray<{ readonly id: BotScheduleFrequency; readonly label: string }> = [
  { id: "interval", label: "每N分钟" }, { id: "hourly", label: "每小时" }, { id: "daily", label: "每天" },
  { id: "weekdays", label: "工作日" }, { id: "weekly", label: "每周" }, { id: "once", label: "单次定时" },
];

const WEEKDAY_BTNS: ReadonlyArray<{ readonly day: number; readonly short: string }> = [
  { day: 1, short: "一" }, { day: 2, short: "二" }, { day: 3, short: "三" },
  { day: 4, short: "四" }, { day: 5, short: "五" }, { day: 6, short: "六" }, { day: 0, short: "日" },
];

const PERM_OPTIONS: ReadonlyArray<{ readonly id: "read-only" | "ask" | "workspace-write"; readonly label: string }> = [
  { id: "read-only", label: "只读巡检" },
  { id: "ask", label: "敏感操作进批准栏" },
  { id: "workspace-write", label: "工作区写入" },
];

const pad2 = (n: number): string => String(Math.max(0, Math.floor(n))).padStart(2, "0");

function toDatetimeLocalValue(epochMs?: number): string {
  const dt = new Date(typeof epochMs === "number" && epochMs > 0 ? epochMs : Date.now() + 2 * 3_600_000);
  return `${dt.getFullYear()}-${pad2(dt.getMonth() + 1)}-${pad2(dt.getDate())}T${pad2(dt.getHours())}:${pad2(dt.getMinutes())}`;
}

function formatRunTime(epochMs: number): string {
  const dt = new Date(epochMs);
  const now = new Date();
  const sameDay = dt.getFullYear() === now.getFullYear() && dt.getMonth() === now.getMonth() && dt.getDate() === now.getDate();
  const hm = `${pad2(dt.getHours())}:${pad2(dt.getMinutes())}`;
  return sameDay ? hm : `${pad2(dt.getMonth() + 1)}/${pad2(dt.getDate())} ${hm}`;
}

function formatDurationSec(durationMs?: number): string {
  if (typeof durationMs !== "number" || !Number.isFinite(durationMs) || durationMs <= 0) return "";
  return durationMs < 1000 ? `${Math.round(durationMs)}ms` : `${(durationMs / 1000).toFixed(1)}s`;
}

export function BotScheduledNlQuickBar(props: {
  readonly nlText: string;
  readonly onChangeNlText: (next: string) => void;
  readonly onQuickCreate: (parsed: NaturalScheduleParseResult) => void;
  readonly onOpenAdvanced: (parsed: NaturalScheduleParseResult) => void;
  readonly busy?: boolean;
}): ReactElement {
  const { nlText, onChangeNlText, onQuickCreate, onOpenAdvanced, busy = false } = props;
  const parsed = nlText.trim() !== "" ? parseNaturalScheduleInput(nlText.trim()) : null;

  return (
    <div className="qj-sched-nl-card">
      <div className="qj-sched-nl-input-row">
        <Sparkles size={15} strokeWidth={1.9} className="qj-sched-nl-sparkle" aria-hidden="true" />
        <input
          type="text"
          data-testid="bot-scheduled-nl-input"
          className="qj-sched-nl-input"
          value={nlText}
          onChange={(e) => onChangeNlText(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter" && parsed !== null && !busy) { e.preventDefault(); onQuickCreate(parsed); } }}
          placeholder="例如：每天早上 9 点帮我检查未读邮件和仓库 PR…"
        />
        {nlText !== "" && (
          <button type="button" className="qj-muse-modal-close" style={{ width: 24, height: 24 }} aria-label="清空自然语言输入" onClick={() => onChangeNlText("")}>
            <X size={13} />
          </button>
        )}
      </div>
      {parsed !== null && (
        <div className="qj-sched-nl-recog-row">
          <span className="qj-sched-nl-chip">{`已识别：${parsed.summaryZh}`}</span>
          <div className="qj-sched-nl-actions">
            <button type="button" className="qj-sched-ghost-pill" onClick={() => onOpenAdvanced(parsed)}>高级配置</button>
            <button type="button" className="qj-sched-create-pill" disabled={busy} onClick={() => onQuickCreate(parsed)}>立即创建</button>
          </div>
        </div>
      )}
    </div>
  );
}

export function BotScheduledEditorForm(props: {
  readonly initialTask?: BotScheduledSummary | null;
  readonly prefillNl?: string;
  readonly defaultCwd?: string;
  readonly busy?: boolean;
  readonly onCancel: () => void;
  readonly onSave: (draft: BotScheduleSaveDraft) => Promise<void>;
}): ReactElement {
  const { initialTask = null, prefillNl = "", defaultCwd = "", busy = false, onCancel, onSave } = props;
  const seed = prefillNl.trim() !== "" ? parseNaturalScheduleInput(prefillNl) : null;

  const [assistInput, setAssistInput] = useState(prefillNl);
  const [name, setName] = useState(() => initialTask?.name ?? seed?.nameSuggestion ?? "");
  const [prompt, setPrompt] = useState(() => initialTask?.prompt ?? seed?.cleanPrompt ?? "");
  const [frequency, setFrequency] = useState<BotScheduleFrequency>(() => initialTask?.frequency ?? seed?.frequency ?? "daily");
  const [intervalMinutes, setIntervalMinutes] = useState<number>(() => initialTask?.intervalMinutes ?? seed?.intervalMinutes ?? 30);
  const [hour, setHour] = useState<number>(() => initialTask?.hour ?? seed?.hour ?? 9);
  const [minute, setMinute] = useState<number>(() => initialTask?.minute ?? seed?.minute ?? 0);
  const [weekday, setWeekday] = useState<number>(() => initialTask?.weekday ?? seed?.weekday ?? 1);
  const [onceVal, setOnceVal] = useState<string>(() => toDatetimeLocalValue(initialTask?.runAt ?? seed?.runAt));
  const [permissionMode, setPermissionMode] = useState<"read-only" | "ask" | "workspace-write">(() => initialTask?.permissionMode ?? "ask");

  const applyAssistParse = (rawText: string) => {
    setAssistInput(rawText);
    const p = parseNaturalScheduleInput(rawText);
    if (!p.matched && rawText.trim() === "") return;
    setFrequency(p.frequency);
    if (p.intervalMinutes !== undefined) setIntervalMinutes(p.intervalMinutes);
    setHour(p.hour);
    setMinute(p.minute);
    setWeekday(p.weekday);
    if (p.runAt !== undefined) setOnceVal(toDatetimeLocalValue(p.runAt));
    if (p.nameSuggestion !== "" && name.trim() === "") setName(p.nameSuggestion);
    if (p.cleanPrompt !== "" && prompt.trim() === "") setPrompt(p.cleanPrompt);
  };

  const handleSubmit = (event: FormEvent) => {
    event.preventDefault();
    const finalPrompt = prompt.trim() || assistInput.trim();
    const finalName = name.trim() || finalPrompt.slice(0, 20) || "新建预定任务";
    if (finalPrompt === "") return;
    const parsedOnceMs = new Date(onceVal).getTime();
    void onSave({
      ...(initialTask ? { id: initialTask.id } : {}),
      name: finalName,
      prompt: finalPrompt,
      cwd: initialTask?.cwd || defaultCwd,
      frequency,
      intervalMinutes: Math.max(5, Math.min(1440, intervalMinutes || 30)),
      hour: Math.max(0, Math.min(23, hour)),
      minute: Math.max(0, Math.min(59, minute)),
      weekday,
      ...(frequency === "once" && Number.isFinite(parsedOnceMs) ? { runAt: parsedOnceMs } : {}),
      permissionMode,
      enabled: initialTask ? initialTask.enabled : true,
    });
  };

  return (
    <form onSubmit={handleSubmit} className="qj-sched-editor-form">
      <div className="qj-sched-field">
        <span className="qj-sched-label">自然语言智能识别（可选）</span>
        <div className="qj-sched-nl-card" style={{ padding: "8px 11px" }}>
          <div className="qj-sched-nl-input-row">
            <Sparkles size={14} className="qj-sched-nl-sparkle" />
            <input type="text" className="qj-sched-nl-input" value={assistInput} onChange={(e) => applyAssistParse(e.target.value)} placeholder="输入如「工作日早上 9:30 检查 PR 并汇总晨报」自动填入下方配置…" />
          </div>
        </div>
      </div>

      <label className="qj-sched-field">
        <span className="qj-sched-label">任务名称</span>
        <input type="text" className="qj-sched-input" value={name} onChange={(e) => setName(e.target.value)} placeholder="例如：每日晨间收件箱与 PR 简报" />
      </label>

      <label className="qj-sched-field">
        <span className="qj-sched-label">执行指令 (Prompt)</span>
        <textarea rows={3} className="qj-sched-textarea" value={prompt} onChange={(e) => setPrompt(e.target.value)} placeholder="详细描述希望千机按时为你执行的巡检、检索、整理或汇报任务…" />
      </label>

      <div className="qj-sched-field">
        <span className="qj-sched-label">执行频率</span>
        <div className="qj-sched-pill-group">
          {FREQUENCY_OPTIONS.map((opt) => (
            <button key={opt.id} type="button" className={`qj-sched-choice-pill${frequency === opt.id ? " active" : ""}`} onClick={() => setFrequency(opt.id)}>{opt.label}</button>
          ))}
        </div>

        <div className="qj-sched-cadence-params">
          {frequency === "interval" && (
            <>
              <span>每隔</span>
              <input type="number" min={5} max={1440} className="qj-sched-time-input" value={intervalMinutes} onChange={(e) => setIntervalMinutes(Number(e.target.value) || 30)} />
              <span>分钟</span>
              {[15, 30, 60].map((preset) => (
                <button key={preset} type="button" className={`qj-sched-choice-pill${intervalMinutes === preset ? " active" : ""}`} onClick={() => setIntervalMinutes(preset)}>{`${preset}m`}</button>
              ))}
            </>
          )}
          {frequency === "hourly" && (
            <>
              <span>每小时第</span>
              <input type="number" min={0} max={59} className="qj-sched-time-input" value={minute} onChange={(e) => setMinute(Number(e.target.value) || 0)} />
              <span>分钟触发</span>
            </>
          )}
          {frequency === "weekly" && (
            <div style={{ display: "flex", gap: 5, alignItems: "center" }}>
              {WEEKDAY_BTNS.map((w) => (
                <button key={w.day} type="button" className={`qj-sched-weekday-btn${weekday === w.day ? " active" : ""}`} onClick={() => setWeekday(w.day)}>{w.short}</button>
              ))}
            </div>
          )}
          {(frequency === "daily" || frequency === "weekdays" || frequency === "weekly") && (
            <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
              <span>时间</span>
              <input type="time" className="qj-sched-input" style={{ width: 126, padding: "5px 9px" }} value={`${pad2(hour)}:${pad2(minute)}`} onChange={(e) => { const [hh, mm] = e.target.value.split(":"); setHour(Number(hh) || 0); setMinute(Number(mm) || 0); }} />
            </div>
          )}
          {frequency === "once" && (
            <input type="datetime-local" className="qj-sched-input" style={{ width: 220, padding: "6px 10px" }} value={onceVal} onChange={(e) => setOnceVal(e.target.value)} />
          )}
        </div>
      </div>

      <div className="qj-sched-field">
        <span className="qj-sched-label">执行权限</span>
        <div className="qj-sched-pill-group">
          {PERM_OPTIONS.map((perm) => (
            <button key={perm.id} type="button" className={`qj-sched-choice-pill${permissionMode === perm.id ? " active" : ""}`} onClick={() => setPermissionMode(perm.id)}>{perm.label}</button>
          ))}
        </div>
      </div>

      <div className="qj-muse-modal-foot" style={{ paddingTop: 4 }}>
        <button type="button" className="qj-soft-btn qj-sheet-pill-xs" onClick={onCancel}>取消</button>
        <button type="submit" className="qj-muse-blue-pill-btn sm" disabled={busy || (prompt.trim() === "" && assistInput.trim() === "")}>保存预定任务</button>
      </div>
    </form>
  );
}

interface UnifiedRunItem {
  readonly id: string;
  readonly status: ScheduledRunInfo["status"];
  readonly trigger: "scheduled" | "manual";
  readonly timeLabel: string;
  readonly durationLabel: string;
  readonly output: string;
  readonly sessionId?: string;
}

export function BotScheduledTaskDetailPane(props: {
  readonly ctx?: Context;
  readonly task: BotScheduledSummary;
  readonly showBackButton: boolean;
  readonly showCloseButton: boolean;
  readonly onBack: () => void;
  readonly onClose: () => void;
  readonly onEditTask: (task: BotScheduledSummary) => void;
  readonly onDeletedTask: () => void;
}): ReactElement {
  const { ctx, task, showBackButton, showCloseButton, onBack, onClose, onEditTask, onDeletedTask } = props;
  const snapshot = useBotSnapshot();
  const ui = useBotUiState();
  const sched = useBotScheduleManager(ctx);
  const { fetchRunsForTask } = sched;

  const [fetchedRuns, setFetchedRuns] = useState<readonly ScheduledRunInfo[]>([]);
  const [runsOpen, setRunsOpen] = useState(true);
  const [expandedRunId, setExpandedRunId] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);

  const isHeartbeat = task.id === "heartbeat" || task.isHeartbeat === true;
  const isEnabled = isHeartbeat ? snapshot.pacing.heartbeatEnabled : task.enabled;
  const isRunning = isHeartbeat ? ui.serverBusy : task.running === true;

  useEffect(() => {
    let cancelled = false;
    fetchRunsForTask(task.id, 20).then((list) => { if (!cancelled) setFetchedRuns(list); }).catch(() => undefined);
    return () => { cancelled = true; };
  }, [fetchRunsForTask, task.id, task.lastRunAt]);

  const patrolRuns: readonly UnifiedRunItem[] = isHeartbeat
    ? snapshot.activityGroups.flatMap((g) => g.items)
        .filter((it) => it.kind === "patrol" || /heartbeat|巡检|简报/i.test(it.title))
        .slice(0, 12)
        .map((it) => ({
          id: `patrol-${it.id}`, status: "success" as const, trigger: "scheduled" as const,
          timeLabel: it.timeLabel || formatRunTime(it.createdAt), durationLabel: "1.4s",
          output: it.description, sessionId: it.sessionId,
        }))
    : [];

  const displayRuns: readonly UnifiedRunItem[] = [
    ...fetchedRuns.map((r) => ({
      id: r.id, status: r.status, trigger: r.trigger,
      timeLabel: formatRunTime(r.startedAt), durationLabel: formatDurationSec(r.durationMs),
      output: r.output || (r.status === "running" ? "正在执行预定任务…" : "执行完毕，无额外文本输出。"),
      sessionId: r.sessionId,
    })),
    ...patrolRuns,
  ].slice(0, 20);

  const nextRel = isEnabled && task.nextRunAt ? formatRelativeNextRun(task.nextRunAt) : "";
  const cadenceLine = `${formatBotScheduleCadence(task)}${nextRel !== "" ? ` · 下次 ${nextRel}` : ""}`;

  return (
    <div className="qj-sched-detail-pane">
      <div className="qj-sched-detail-topbar">
        {showBackButton && (
          <button type="button" className="qj-sched-back-btn" onClick={onBack}><ArrowLeft size={14} strokeWidth={1.9} /><span>全部预定任务</span></button>
        )}
        <div className="qj-sched-topbar-right">
          <span className={`qj-sched-status-pill ${isRunning ? "running" : isEnabled ? "enabled" : "paused"}`}>
            {isRunning ? "运行中" : isEnabled ? "已定时" : "已暂停"}
          </span>
          {showCloseButton && (
            <button type="button" aria-label="关闭预定任务" className="qj-muse-modal-close" onClick={onClose}><X size={16} strokeWidth={1.85} /></button>
          )}
        </div>
      </div>

      <div className="qj-sched-detail-scroll">
        <div className="qj-sched-detail-hero">
          <div className="qj-sched-detail-hero-left">
            <span className={`qj-sched-icon-circle ${!isEnabled ? "paused" : isHeartbeat ? "heartbeat" : "routine"}`}>
              {isHeartbeat ? <Heart size={18} /> : <CalendarClock size={18} />}
            </span>
            <div>
              <h2 className="qj-sched-detail-title">{isHeartbeat ? "Heartbeat" : task.name}</h2>
              <div className="qj-sched-detail-cadence">{cadenceLine}</div>
            </div>
          </div>

          <div className="qj-sched-detail-hero-actions">
            <button type="button" role="switch" aria-checked={isEnabled} aria-label={isEnabled ? "暂停此预定任务" : "启用此预定任务"} className="qj-sched-switch" onClick={() => void sched.toggleTaskEnabled(task)}>
              <span className="qj-sched-switch-thumb" />
            </button>
            <button type="button" className="qj-sched-ghost-pill" disabled={isRunning} onClick={() => void sched.runTaskNow(task)}><Play size={12} /><span>立即运行</span></button>
          </div>
        </div>

        <div className="qj-sched-prompt-box">
          {isHeartbeat
            ? `按每 ${snapshot.pacing.heartbeatIntervalMinutes} 分钟静默唤醒分身，巡检收件箱、连接器通知与活跃目标，仅在有价值发现时主动推送动态简报。`
            : task.prompt || "按设定周期自动在后台运行并留存会话记录。"}
        </div>

        <section className="qj-sched-runs-section" data-testid="bot-scheduled-run-history">
          <button type="button" className="qj-sched-runs-head" onClick={() => setRunsOpen((v) => !v)}>
            <span>{`运行记录 (${displayRuns.length})`}</span>
            <ChevronDown size={15} style={{ transform: runsOpen ? "none" : "rotate(-90deg)" }} />
          </button>

          {runsOpen && (displayRuns.length === 0 ? (
            <div className="qj-sched-runs-empty">暂无历史运行记录，点击上方「立即运行」可即刻测试执行。</div>
          ) : (
            <div className="qj-sched-runs-list">
              {displayRuns.map((run) => {
                const expanded = expandedRunId === run.id;
                const statusZh = run.status === "running" ? "运行中" : run.status === "success" ? "成功" : "失败";
                const dotCls = run.status === "running" ? "run" : run.status === "success" ? "ok" : "err";
                return (
                  <div key={run.id} className="qj-sched-run-card">
                    <button type="button" className="qj-sched-run-row" onClick={() => setExpandedRunId(expanded ? null : run.id)}>
                      <span className="qj-sched-run-left"><span className={`qj-sched-run-dot ${dotCls}`} /><span>{`${statusZh} · ${run.trigger}`}</span></span>
                      <span className="qj-sched-run-right"><span>{run.timeLabel}</span>{run.durationLabel !== "" && <span>{run.durationLabel}</span>}</span>
                    </button>
                    {expanded && (
                      <div className="qj-sched-run-expand">
                        <pre className="qj-sched-run-output">{run.output}</pre>
                        {run.sessionId && (
                          <div className="qj-sched-run-actions">
                            <button type="button" className="qj-sched-create-pill" onClick={() => patchBotUi({ modal: null, activeView: "chat", activeSessionId: run.sessionId ?? null })}>
                              <MessageSquare size={12} /><span>在聊天中打开会话</span>
                            </button>
                          </div>
                        )}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          ))}
        </section>
      </div>

      <div className="qj-sched-detail-foot">
        <div style={{ display: "flex", gap: 8 }}>
          {!isHeartbeat && (
            <button type="button" className="qj-sched-ghost-pill" onClick={() => onEditTask(task)}><Pencil size={12} /><span>编辑配置</span></button>
          )}
          <button type="button" className="qj-sched-ghost-pill" onClick={() => openBotModal("settings", "permissions")}><Shield size={12} /><span>查看权限</span></button>
        </div>

        {isHeartbeat ? (
          <button type="button" className="qj-sched-ghost-pill" onClick={() => void sched.toggleTaskEnabled(task)}>{isEnabled ? "暂停巡检" : "恢复巡检"}</button>
        ) : (
          <button type="button" className="qj-sched-danger-pill" onClick={() => { if (!confirmDelete) { setConfirmDelete(true); return; } void sched.deleteTask(task.id).then(() => onDeletedTask()); }}>
            <Trash2 size={13} /><span>{confirmDelete ? "确认删除" : "删除"}</span>
          </button>
        )}
      </div>
    </div>
  );
}

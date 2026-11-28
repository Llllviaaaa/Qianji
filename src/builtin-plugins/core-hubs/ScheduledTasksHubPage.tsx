import { useCallback, useEffect, useState } from "react";
import {
  CalendarClock,
  CheckCircle2,
  LoaderCircle,
  Play,
  Plus,
  RefreshCw,
  Square,
  Trash2,
  X,
} from "lucide-react";
import type {
  ScheduledRunInfo,
  ScheduledTaskInfo,
  ScheduleListResult,
  ScheduleRunsResult,
} from "@qianji/protocol";
import {
  useFrontendService,
  useWorkspaceState,
} from "@qianji/client";
import { Badge, Button, Card, Input, Switch } from "@qianji/client-primitives";
import type { HubPageSlotProps, SlotComponentProps } from "@qianji/client-slots";

interface TaskFormState {
  readonly id: string;
  readonly name: string;
  readonly prompt: string;
  readonly cwd: string;
  readonly frequency: ScheduledTaskInfo["frequency"];
  readonly hour: number;
  readonly minute: number;
  readonly weekday: number;
  readonly permissionMode: ScheduledTaskInfo["permissionMode"];
  readonly enabled: boolean;
}

const WEEKDAY_LABELS = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"] as const;

function createEmptyForm(defaultCwd: string): TaskFormState {
  return {
    id: "",
    name: "",
    prompt: "",
    cwd: defaultCwd,
    frequency: "daily",
    hour: 9,
    minute: 0,
    weekday: 1,
    permissionMode: "ask",
    enabled: true,
  };
}

function describeSchedule(task: ScheduledTaskInfo): string {
  const pad2 = (n: number) => String(n).padStart(2, "0");
  const hhmm = `${pad2(task.hour)}:${pad2(task.minute)}`;
  switch (task.frequency) {
    case "interval": {
      const mins = Math.max(5, Math.min(1440, Math.round(task.intervalMinutes ?? 30)));
      return `每 ${mins} 分钟`;
    }
    case "once": {
      if (typeof task.runAt === "number" && Number.isFinite(task.runAt)) {
        const d = new Date(task.runAt);
        return `单次 · ${pad2(d.getMonth() + 1)}/${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
      }
      return `单次 · ${hhmm}`;
    }
    case "hourly":
      return `每小时第 ${pad2(task.minute)} 分`;
    case "weekdays":
      return `工作日 ${hhmm}`;
    case "weekly":
      return `每${WEEKDAY_LABELS[task.weekday] ?? "周一"} ${hhmm}`;
    case "daily":
      return `每天 ${hhmm}`;
  }
}

function statusBadgeVariant(status: string): "neutral" | "brand" | "success" | "warning" | "danger" {
  if (status === "running") return "brand";
  if (status === "success") return "success";
  if (status === "error" || status === "timed-out") return "danger";
  if (status === "cancelled" || status === "interrupted") return "warning";
  return "neutral";
}

function statusLabel(status: string): string {
  if (status === "running") return "运行中";
  if (status === "success") return "成功";
  if (status === "error") return "失败";
  if (status === "cancelled") return "已取消";
  if (status === "timed-out") return "已超时";
  if (status === "interrupted") return "已中断";
  return "未运行";
}

export function ScheduledTasksHubPage(props: SlotComponentProps<HubPageSlotProps, "root">) {
  const { ctx, renderFactory } = props;
  const hasHostScheduled =
    (ctx?.slots?.registry?.getFactoryCandidates("host.hub.scheduled").length ?? 0) > 0;
  const rpcService = useFrontendService("rpcService", ctx);
  const navigationService = useFrontendService("navigationService", ctx);
  const sessionService = useFrontendService("sessionService", ctx);
  const workspaceSnap = useWorkspaceState(ctx);

  const defaultCwd = props.cwd ?? workspaceSnap?.cwd ?? "";

  const [tasks, setTasks] = useState<ScheduledTaskInfo[]>([]);
  const [runs, setRuns] = useState<ScheduledRunInfo[]>([]);
  const [loading, setLoading] = useState(false);
  const [editor, setEditor] = useState<TaskFormState | null>(null);
  const [saving, setSaving] = useState(false);

  const loadData = useCallback(async () => {
    if (rpcService === undefined) return;
    try {
      const [taskResult, runResult] = await Promise.all([
        rpcService.call<ScheduleListResult>("schedule.list").catch(() => ({ tasks: [] })),
        rpcService.call<ScheduleRunsResult>("schedule.runs", { limit: 40 }).catch(() => ({ runs: [] })),
      ]);
      setTasks(Array.isArray(taskResult?.tasks) ? taskResult.tasks : []);
      setRuns(Array.isArray(runResult?.runs) ? runResult.runs : []);
    } finally {
      setLoading(false);
    }
  }, [rpcService]);

  useEffect(() => {
    if (hasHostScheduled || rpcService === undefined) return undefined;
    let cancelled = false;
    void (async () => {
      try {
        const [taskResult, runResult] = await Promise.all([
          rpcService.call<ScheduleListResult>("schedule.list").catch(() => ({ tasks: [] })),
          rpcService.call<ScheduleRunsResult>("schedule.runs", { limit: 40 }).catch(() => ({ runs: [] })),
        ]);
        if (cancelled) return;
        setTasks(Array.isArray(taskResult?.tasks) ? taskResult.tasks : []);
        setRuns(Array.isArray(runResult?.runs) ? runResult.runs : []);
      } catch {
        // Ignore offline RPC errors during initial load.
      }
    })();

    const offTask = rpcService.onNotification("schedule/task", () => {
      void loadData();
    });
    const offRun = rpcService.onNotification("schedule/run", () => {
      void loadData();
      void sessionService?.refreshSessions();
    });
    return () => {
      cancelled = true;
      offTask();
      offRun();
    };
  }, [hasHostScheduled, loadData, rpcService, sessionService]);

  if (hasHostScheduled) {
    return (
      <>
        {renderFactory("host.hub.scheduled", {
          cwd: defaultCwd,
          workspaces: workspaceSnap?.workspaceOptions ?? [],
          onOpenSession: (workspace: string, file: string) => {
            navigationService?.navigate({ kind: "session", cwd: workspace, file });
          },
          onError: (message: string) => {
            navigationService?.showToast(message, "error");
          },
        })}
      </>
    );
  }

  const handleSave = async () => {
    if (editor === null || rpcService === undefined) return;
    if (editor.name.trim() === "" || editor.prompt.trim() === "") {
      navigationService?.showToast("请填写任务名称和提示词", "warning");
      return;
    }
    setSaving(true);
    try {
      await rpcService.call("schedule.save", { task: editor });
      setEditor(null);
      await loadData();
      navigationService?.showToast("已保存定时任务", "info");
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      navigationService?.showToast(`保存失败：${msg}`, "error");
    } finally {
      setSaving(false);
    }
  };

  const handleToggleEnabled = async (task: ScheduledTaskInfo, nextEnabled: boolean) => {
    if (rpcService === undefined) return;
    try {
      await rpcService.call("schedule.save", { task: { ...task, enabled: nextEnabled } });
      await loadData();
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      navigationService?.showToast(`更新状态失败：${msg}`, "error");
    }
  };

  const handleRunNow = async (task: ScheduledTaskInfo) => {
    if (rpcService === undefined) return;
    try {
      await rpcService.call("schedule.run", { id: task.id });
      await loadData();
      void sessionService?.refreshSessions();
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      navigationService?.showToast(`运行失败：${msg}`, "error");
    }
  };

  const handleCancel = async (taskId: string) => {
    if (rpcService === undefined) return;
    await rpcService.call("schedule.cancel", { id: taskId }).catch(() => undefined);
    await loadData();
  };

  const handleDelete = async (taskId: string) => {
    if (rpcService === undefined) return;
    await rpcService.call("schedule.delete", { id: taskId }).catch(() => undefined);
    await loadData();
  };

  return (
    <section className="scheduled-page" data-hub-page="scheduled" data-core-plugin="core-hubs">
      <div className="scheduled-inner">
        <header className="scheduled-header">
          <div>
            <h1>
              <CalendarClock size={18} style={{ display: "inline", marginRight: 8, verticalAlign: "text-bottom" }} />
              定时任务
            </h1>
            <p>按计划自动运行 Agent 任务，支持每日、工作日、每周与每小时调度</p>
          </div>
          <div style={{ display: "inline-flex", gap: 8 }}>
            <Button
              variant="secondary"
              size="sm"
              onClick={() => {
                setLoading(true);
                void loadData();
              }}
            >
              <RefreshCw size={14} />
              刷新
            </Button>
            <Button
              variant="primary"
              size="sm"
              onClick={() => setEditor(createEmptyForm(defaultCwd))}
            >
              <Plus size={14} />
              新建定时任务
            </Button>
          </div>
        </header>

        {editor !== null && (
          <Card padding="md" className="scheduled-editor-card">
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12 }}>
              <strong>{editor.id === "" ? "新建定时任务" : "编辑定时任务"}</strong>
              <Button variant="ghost" size="icon" aria-label="关闭编辑器" onClick={() => setEditor(null)}>
                <X size={14} />
              </Button>
            </div>
            <div style={{ display: "grid", gap: 10 }}>
              <Input
                value={editor.name}
                onChange={(event) => setEditor({ ...editor, name: event.target.value })}
                placeholder="任务名称（如：每日代码巡检）"
                aria-label="任务名称"
              />
              <Input
                value={editor.cwd}
                onChange={(event) => setEditor({ ...editor, cwd: event.target.value })}
                placeholder="工作区目录路径"
                aria-label="工作区目录"
              />
              <textarea
                value={editor.prompt}
                onChange={(event) => setEditor({ ...editor, prompt: event.target.value })}
                placeholder="输入定时执行时发送给 Agent 的提示词…"
                rows={3}
                aria-label="任务提示词"
              />
              <div style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
                <Button variant="secondary" size="sm" onClick={() => setEditor(null)}>
                  取消
                </Button>
                <Button variant="primary" size="sm" disabled={saving} onClick={() => void handleSave()}>
                  {saving ? "保存中…" : "保存任务"}
                </Button>
              </div>
            </div>
          </Card>
        )}

        <div className="scheduled-list">
          {loading && tasks.length === 0 ? (
            <div className="scheduled-empty">正在加载定时任务…</div>
          ) : tasks.length === 0 ? (
            <div className="scheduled-empty">暂无定时任务，点击右上角「新建定时任务」开始配置</div>
          ) : (
            tasks.map((task) => (
              <Card key={task.id} padding="md" className="scheduled-card">
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 12 }}>
                  <div style={{ minWidth: 0 }}>
                    <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                      <strong>{task.name}</strong>
                      <Badge variant={statusBadgeVariant(task.running ? "running" : task.lastStatus)}>
                        {statusLabel(task.running ? "running" : task.lastStatus)}
                      </Badge>
                    </div>
                    <div style={{ fontSize: 12, opacity: 0.75, marginTop: 4 }}>
                      {describeSchedule(task)} · {task.cwd || "默认工作区"}
                    </div>
                  </div>
                  <div style={{ display: "inline-flex", alignItems: "center", gap: 8 }}>
                    <Switch
                      checked={task.enabled}
                      aria-label={`启用任务 ${task.name}`}
                      onCheckedChange={(checked) => void handleToggleEnabled(task, checked)}
                    />
                    {task.running ? (
                      <Button variant="secondary" size="sm" onClick={() => void handleCancel(task.id)}>
                        <Square size={12} />
                        停止
                      </Button>
                    ) : (
                      <Button variant="secondary" size="sm" onClick={() => void handleRunNow(task)}>
                        <Play size={12} />
                        立即运行
                      </Button>
                    )}
                    <Button variant="ghost" size="icon" aria-label="删除任务" onClick={() => void handleDelete(task.id)}>
                      <Trash2 size={14} />
                    </Button>
                  </div>
                </div>
              </Card>
            ))
          )}
        </div>

        {runs.length > 0 && (
          <div className="scheduled-runs-section" style={{ marginTop: 20 }}>
            <h2 style={{ fontSize: 14, marginBottom: 8 }}>最近执行记录</h2>
            {runs.slice(0, 10).map((run) => (
              <div key={run.id} className="scheduled-run-row" style={{ display: "flex", alignItems: "center", gap: 8, padding: "6px 0" }}>
                {run.status === "running" ? <LoaderCircle size={14} /> : <CheckCircle2 size={14} />}
                <span>{run.taskName}</span>
                <Badge variant={statusBadgeVariant(run.status)}>{statusLabel(run.status)}</Badge>
              </div>
            ))}
          </div>
        )}
      </div>
    </section>
  );
}

/**
 * 1:1+ Meta Muse Two-Column `活动详情` Step-by-Step Execution Trace Modal
 * (`src/builtin-plugins/bot-mode/BotActivityDetailModal.tsx`).
 *
 * Implements Muse's 3-tier header (`status_title` pill + `title` + `subtitle`),
 * honest execution steps (zero fake shell commands when 0 tools ran), grouped
 * subagent / side-effect sections, and formatted Markdown `finishMessage` summary.
 */
import { Fragment, useEffect, useState, type ReactElement } from "react";
import type { Context } from "@deepseek-ai/cordis";
import {
  AlertCircle,
  ArrowUpRight,
  CalendarClock,
  Check,
  CheckCircle2,
  Copy,
  FileText,
  GitBranch,
  Globe,
  Layers,
  Loader2,
  Mail,
  MessageSquare,
  Play,
  Target,
  Terminal,
  X,
} from "lucide-react";
import { useFrontendService } from "@qianji/client";
import { Markdown } from "@qianji/client-primitives";
import type { BotActivityEntry, BotActivityTraceStep } from "@qianji/protocol";
import { patchBotUi, useBotController, useBotSnapshot, useBotUiState } from "./botStore";

interface ActivityTraceRpcResponse {
  readonly entry: BotActivityEntry | null;
  readonly steps: readonly BotActivityTraceStep[];
  readonly summary: string;
  readonly sessionId?: string;
}

function formatTraceDuration(durationMs?: number): string {
  if (typeof durationMs !== "number" || !Number.isFinite(durationMs) || durationMs <= 0) return "";
  return durationMs < 1000 ? `${Math.round(durationMs)}ms` : `${(durationMs / 1000).toFixed(1)}s`;
}

function buildHonestFallbackSteps(entry: BotActivityEntry): readonly BotActivityTraceStep[] {
  if (Array.isArray(entry.steps) && entry.steps.length > 0) {
    const hasStart = entry.steps.some((s) => s.kind === "start");
    const hasDone = entry.steps.some((s) => s.kind === "done");
    if (hasStart && hasDone) return entry.steps;
    return [
      ...(hasStart
        ? []
        : [
            {
              id: "start",
              kind: "start" as const,
              iconKind: "start" as const,
              title: "已开始",
              subtitle: `触发时间 ${entry.timeLabel}`,
              status: "completed" as const,
              output: `${entry.title}（${entry.timeLabel}）`,
            },
          ]),
      ...entry.steps,
      ...(hasDone
        ? []
        : [
            {
              id: "done",
              kind: "done" as const,
              iconKind: entry.status === "error" ? ("error" as const) : ("done" as const),
              title: entry.statusTitle || (entry.status === "error" ? "执行受阻" : entry.status === "running" ? "正在执行" : "已完成"),
              subtitle: entry.subtitle || entry.description,
              status: entry.status === "error" ? ("error" as const) : entry.status === "running" ? ("running" as const) : ("completed" as const),
              output: entry.finishMessage || entry.description,
            },
          ]),
    ];
  }
  const isErr = entry.status === "error";
  const isRunning = entry.status === "running";
  return [
    {
      id: "start",
      kind: "start",
      iconKind: "start",
      title: "已开始",
      subtitle: `触发时间 ${entry.timeLabel}`,
      status: "completed",
      output: `已触发任务「${entry.title}」（${entry.timeLabel}）`,
    },
    {
      id: "done",
      kind: "done",
      iconKind: isErr ? "error" : "done",
      title: entry.statusTitle || (isErr ? "执行受阻" : isRunning ? "运行中" : "已完成"),
      subtitle: entry.subtitle || entry.description,
      status: isErr ? "error" : isRunning ? "running" : "completed",
      output: entry.finishMessage || entry.description,
    },
  ];
}

function renderStepGlyphIcon(step: BotActivityTraceStep): ReactElement {
  if (step.status === "running") return <Loader2 size={12.5} className="animate-spin" />;
  if (step.status === "error" || step.iconKind === "error") return <AlertCircle size={12.5} />;
  switch (step.iconKind) {
    case "start":
      return <Play size={11} />;
    case "browser":
      return <Globe size={12.5} />;
    case "mail":
      return <Mail size={12.5} />;
    case "file":
      return <FileText size={12.5} />;
    case "schedule":
      return <CalendarClock size={12.5} />;
    case "goal":
      return <Target size={12.5} />;
    case "space":
      return <Layers size={12.5} />;
    case "subagent":
      return <GitBranch size={12.5} />;
    case "done":
      return <CheckCircle2 size={13} />;
    default:
      return step.kind === "done" || step.kind === "summary" ? (
        <CheckCircle2 size={13} />
      ) : step.kind === "start" ? (
        <Play size={11} />
      ) : (
        <Terminal size={12} />
      );
  }
}

function stepGlyphClass(step: BotActivityTraceStep): string {
  if (step.status === "error" || step.iconKind === "error") return "error";
  if (step.kind === "start") return "start";
  if (step.kind === "done" || step.kind === "summary") return "done";
  return "tool";
}

export function BotActivityDetailModal({ ctx }: { readonly ctx?: Context }): ReactElement | null {
  const ui = useBotUiState();
  const snapshot = useBotSnapshot();
  const ctrl = useBotController(ctx);
  const rpcService = useFrontendService("rpcService", ctx);

  const rawEntry = ui.activeActivityEntry;
  const [traceRes, setTraceRes] = useState<ActivityTraceRpcResponse | null>(null);
  const [selectedStepId, setSelectedStepId] = useState<string | null>(null);
  const [copiedId, setCopiedId] = useState<string | null>(null);

  const entryId = rawEntry?.id ?? "";
  const entrySessionId = rawEntry?.sessionId;

  useEffect(() => {
    if (!rpcService || entryId === "") return undefined;
    let cancelled = false;
    rpcService
      .call<ActivityTraceRpcResponse>("bot.activity.getTrace", {
        activityId: entryId,
        ...(entrySessionId ? { sessionId: entrySessionId } : {}),
      })
      .then((res) => {
        if (cancelled || !res) return;
        setTraceRes(res);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [entryId, entrySessionId, rpcService]);

  if (rawEntry === null) return null;

  const closeModal = () => patchBotUi({ modal: null, activeActivityEntry: null });
  const mergedEntry: BotActivityEntry = traceRes?.entry ?? rawEntry;
  const steps =
    traceRes && Array.isArray(traceRes.steps) && traceRes.steps.length > 0
      ? traceRes.steps
      : buildHonestFallbackSteps(mergedEntry);

  let defaultStep: BotActivityTraceStep | undefined = steps[steps.length - 1];
  for (let i = steps.length - 1; i >= 0; i -= 1) {
    const candidate = steps[i];
    if (candidate && (candidate.kind === "done" || candidate.kind === "summary")) {
      defaultStep = candidate;
      break;
    }
  }
  const activeStep =
    (selectedStepId !== null ? steps.find((s) => s.id === selectedStepId) : undefined) ??
    defaultStep ??
    steps[0];

  const overallStatus = mergedEntry.status ?? "completed";
  const isWaitingUser = mergedEntry.statusTitle === "等待确认";
  const statusPillClass =
    overallStatus === "running"
      ? "running"
      : overallStatus === "error"
        ? "error"
        : isWaitingUser || overallStatus === "interrupted"
          ? "waiting"
          : "completed";
  const statusPillLabel =
    mergedEntry.statusTitle ||
    (overallStatus === "running"
      ? "运行中"
      : overallStatus === "error"
        ? "执行受阻"
        : overallStatus === "interrupted"
          ? "已中止"
          : "已完成");

  const headerSubtitle = (mergedEntry.subtitle || mergedEntry.description || "").trim();
  const showHeaderSubtitle = headerSubtitle !== "" && headerSubtitle !== mergedEntry.title.trim();

  const summaryMarkdown =
    mergedEntry.finishMessage ||
    traceRes?.summary ||
    activeStep?.output ||
    mergedEntry.description ||
    "该任务已完成执行。";
  const resolvedSessionId = traceRes?.sessionId ?? mergedEntry.sessionId;
  const isSummaryView =
    activeStep === undefined || activeStep.kind === "done" || activeStep.kind === "summary";

  const handleCopyCommand = (stepId: string, text: string) => {
    void navigator.clipboard?.writeText(text).catch(() => undefined);
    setCopiedId(stepId);
    window.setTimeout(() => {
      setCopiedId((cur) => (cur === stepId ? null : cur));
    }, 1500);
  };

  return (
    <div
      className="qj-bot-modal-backdrop"
      onClick={closeModal}
      data-testid="bot-activity-detail-modal"
    >
      <div className="qj-bot-dialog qj-bot-trace-modal" onClick={(e) => e.stopPropagation()}>
        <header className="qj-trace-head">
          <div className="qj-trace-head-stack">
            <div className="qj-trace-head-meta-row">
              <span className={`qj-trace-status-pill ${statusPillClass}`}>{statusPillLabel}</span>
              <span className="qj-trace-head-clock qj-tabular">{mergedEntry.timeLabel}</span>
            </div>
            <h2 className="qj-trace-head-title">{mergedEntry.title}</h2>
            {showHeaderSubtitle && <p className="qj-trace-head-subtitle">{headerSubtitle}</p>}
          </div>
          <button
            type="button"
            aria-label="关闭活动详情"
            className="qj-muse-modal-close"
            onClick={closeModal}
          >
            <X size={16} strokeWidth={1.85} />
          </button>
        </header>

        <div className="qj-trace-columns">
          <aside
            className="qj-trace-step-list"
            aria-label="执行步骤列表"
            data-testid="activity-trace-step-list"
          >
            {steps.map((step, idx) => {
              const active = activeStep?.id === step.id;
              const dur = formatTraceDuration(step.durationMs);
              const prevGroup = idx > 0 ? steps[idx - 1]?.groupLabel : undefined;
              const showGroupDivider = Boolean(step.groupLabel && step.groupLabel !== prevGroup);
              return (
                <Fragment key={step.id}>
                  {showGroupDivider && (
                    <div className="qj-trace-group-label">{step.groupLabel}</div>
                  )}
                  <button
                    type="button"
                    className={`qj-trace-step-btn${active ? " active" : ""}`}
                    onClick={() => setSelectedStepId(step.id)}
                  >
                    <span className={`qj-trace-step-glyph ${stepGlyphClass(step)}`}>
                      {renderStepGlyphIcon(step)}
                    </span>
                    <span className="qj-trace-step-copy">
                      <span className="qj-trace-step-title">{step.title}</span>
                      {step.subtitle && step.kind === "tool" && (
                        <span className="qj-trace-step-sub">{step.subtitle}</span>
                      )}
                    </span>
                    {dur !== "" && <span className="qj-trace-step-dur">{dur}</span>}
                  </button>
                </Fragment>
              );
            })}
          </aside>

          <section className="qj-trace-inspector" data-testid="activity-trace-inspector">
            <div className="qj-trace-inspector-scroll">
              {isSummaryView ? (
                <>
                  <div className="qj-trace-inspector-head">
                    <h3 className="qj-trace-inspector-h">执行总结</h3>
                    <span className="qj-trace-inspector-time">{mergedEntry.timeLabel}</span>
                  </div>
                  <div className="qj-trace-markdown-box">
                    <Markdown content={summaryMarkdown} />
                  </div>
                </>
              ) : activeStep.kind === "start" ? (
                <>
                  <div className="qj-trace-inspector-head">
                    <h3 className="qj-trace-inspector-h">{activeStep.title}</h3>
                    <span className="qj-trace-inspector-time">{mergedEntry.timeLabel}</span>
                  </div>
                  <div className="qj-trace-summary-box">
                    {activeStep.output || `已启动执行「${mergedEntry.title}」`}
                  </div>
                </>
              ) : (
                <>
                  <div className="qj-trace-inspector-head">
                    <h3 className="qj-trace-inspector-h">{activeStep.title}</h3>
                    <span className="qj-trace-inspector-time">
                      {formatTraceDuration(activeStep.durationMs) || mergedEntry.timeLabel}
                    </span>
                  </div>

                  {activeStep.subtitle && (
                    <div className="qj-trace-step-outcome-banner">{activeStep.subtitle}</div>
                  )}

                  {activeStep.reportMarkdown && (
                    <div className="qj-trace-markdown-box">
                      <Markdown content={activeStep.reportMarkdown} />
                    </div>
                  )}

                  {activeStep.commandOrInput && (
                    <div className="qj-trace-code-card">
                      <div className="qj-trace-code-head">
                        <span>{activeStep.toolName ?? "tool"}</span>
                        <button
                          type="button"
                          className="qj-trace-copy-btn"
                          onClick={() =>
                            handleCopyCommand(
                              activeStep.id,
                              activeStep.commandOrInput || activeStep.title,
                            )
                          }
                        >
                          {copiedId === activeStep.id ? <Check size={11} /> : <Copy size={11} />}
                          <span>{copiedId === activeStep.id ? "已复制" : "复制"}</span>
                        </button>
                      </div>
                      <pre className="qj-trace-code-pre">{activeStep.commandOrInput}</pre>
                    </div>
                  )}

                  <div className="qj-trace-meta-chips">
                    {activeStep.toolName && (
                      <span className="qj-trace-meta-chip">工具 · {activeStep.toolName}</span>
                    )}
                    <span className="qj-trace-meta-chip">
                      状态 · {activeStep.status === "error" ? "受阻" : activeStep.status === "running" ? "执行中" : "已完成"}
                    </span>
                    {activeStep.durationMs !== undefined && formatTraceDuration(activeStep.durationMs) !== "" && (
                      <span className="qj-trace-meta-chip">耗时 · {formatTraceDuration(activeStep.durationMs)}</span>
                    )}
                    {activeStep.exitCode !== undefined && (
                      <span className="qj-trace-meta-chip">退出码 · {activeStep.exitCode}</span>
                    )}
                  </div>

                  {activeStep.output && (
                    <pre className="qj-trace-output-pre">{activeStep.output}</pre>
                  )}
                </>
              )}
            </div>

            <footer className="qj-trace-foot">
              {resolvedSessionId && (
                <button
                  type="button"
                  className="qj-soft-btn qj-sheet-pill-xs"
                  onClick={() =>
                    patchBotUi({
                      modal: null,
                      activeActivityEntry: null,
                      activeView: "chat",
                      activeSessionId:
                        resolvedSessionId === snapshot.mainSessionId ? null : resolvedSessionId,
                    })
                  }
                >
                  <MessageSquare size={13} />
                  <span>定位到对应对话</span>
                </button>
              )}

              <button
                type="button"
                className="qj-muse-blue-pill-btn sm"
                onClick={() => {
                  closeModal();
                  ctrl.triggerHandoff(
                    mergedEntry.handoff ?? {
                      id: `activity-${mergedEntry.id}`,
                      title: mergedEntry.title,
                      kindLabel: "执行记录",
                      summary: headerSubtitle || mergedEntry.title,
                      targetCwd: snapshot.botCwd || "",
                    },
                  );
                }}
              >
                <span>在 Agent 工作台中打开</span>
                <ArrowUpRight size={14} style={{ marginLeft: 4 }} />
              </button>
            </footer>
          </section>
        </div>
      </div>
    </div>
  );
}

/**
 * Thread management, live/settled turn synchronization, isolated per-turn
 * execution trace extraction, and `schedule/run` bridging (`store-threads.ts`).
 */
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import type {
  BotActivityEntry,
  BotActivityGetTraceResult,
  BotActivityStatus,
  BotActivityTraceStep,
  BotSideChatUpdateParams,
  BotSideThreadInfo,
  BotSideThreadStatus,
} from "@qianji/protocol";
import type { ScheduledRun } from "@qianji/schedule";
import { currentBranch, type Session, type Sessions } from "@qianji/session";
import { formatClock, type PersistedBotState } from "./defaults.ts";
import {
  describeToolStepOutcome,
  formatActivityDateBucket,
  stripMarkdownFormatting,
  stripQuickOptionsAndWidgets,
  upsertActivityEntry,
} from "./store-activity-helpers.ts";
import {
  deriveTurnActivitySummary,
  describeToolCallTitle,
  isUntitledSideChatTitle,
  stripThinkAndConnectorNoise,
  truncateCodepoints,
  type TurnActivityOutcome,
  type TurnRecordOptions,
} from "./store-turn-namer.ts";

export {
  describeToolCallTitle,
  isUntitledSideChatTitle,
  stripThinkAndConnectorNoise,
  truncateCodepoints,
  type TurnActivityOutcome,
  type TurnRecordOptions,
};

const EXIT_CODE_RE = /(?:\[exit code:\s*(-?\d+)\]|exit code[:\s]+(-?\d+))/i;

export function normalizeBotPath(rawPath: string): string {
  return resolve(rawPath).replace(/[\\/]+$/, "").toLowerCase();
}

function truncateMultiline(raw: string, maxChars: number): string {
  const trimmed = raw.trim();
  const chars = [...trimmed];
  return chars.length <= maxChars ? trimmed : `${chars.slice(0, Math.max(1, maxChars - 1)).join("")}…`;
}

function upsertTodayActivity(st: PersistedBotState, entry: BotActivityEntry): BotActivityEntry {
  return upsertActivityEntry(st, entry);
}

function syncTurnToBotState(
  st: PersistedBotState,
  session: Session,
  options: TurnRecordOptions,
): BotActivityEntry | undefined {
  const now = Date.now();
  const isMain = session.id === st.mainSessionId;
  const side = st.sideThreads.find((t) => t.sessionId === session.id);
  const branchEvents = currentBranch(session.events);
  const summary = deriveTurnActivitySummary({
    branchEvents,
    isMain,
    sideTitle: side?.title,
    ...options,
  });

  if (side !== undefined) {
    side.updatedAt = now;
    side.messageCount = summary.messageCount;
    side.status = options.outcome === "running" ? "running" : summary.hasError ? "error" : "idle";
    if (summary.snippet !== "" && options.outcome !== "running") {
      side.snippet = summary.snippet;
    }
    if (
      side.userRenamed !== true &&
      side.source !== "scheduled" &&
      isUntitledSideChatTitle(side.title) &&
      summary.sideAutoTitle !== undefined &&
      summary.sideAutoTitle !== ""
    ) {
      side.title = summary.sideAutoTitle;
      session.append("label", { title: summary.sideAutoTitle });
    }
  }

  if (summary.skipActivity) return undefined;

  return upsertTodayActivity(st, {
    id: options.activityId ?? `act-${randomUUID().slice(0, 8)}`,
    dateGroup: formatActivityDateBucket(now, now),
    title: summary.title,
    subtitle: summary.subtitle,
    description: summary.description,
    ...(summary.statusTitle ? { statusTitle: summary.statusTitle } : {}),
    ...(summary.finishMessage ? { finishMessage: summary.finishMessage } : {}),
    timeLabel: formatClock(now),
    createdAt: now,
    sessionId: session.id,
    turnStartSeq: summary.turnStartSeq,
    ...(summary.turnEndSeq !== undefined ? { turnEndSeq: summary.turnEndSeq } : {}),
    status: summary.status,
    kind: summary.kind,
  });
}

export function recordTurnProgressInState(
  st: PersistedBotState,
  session: Session,
  options: TurnRecordOptions = {},
): BotActivityEntry | undefined {
  return syncTurnToBotState(st, session, { ...options, outcome: options.outcome ?? "running" });
}

export function recordSettledBotTurn(
  st: PersistedBotState,
  session: Session,
  options: TurnRecordOptions = {},
): BotActivityEntry | undefined {
  return syncTurnToBotState(st, session, { ...options, outcome: options.outcome ?? "done" });
}

export async function updateSideChatRecord(
  sessions: Sessions,
  st: PersistedBotState,
  params: BotSideChatUpdateParams,
): Promise<BotSideThreadInfo | null> {
  const thread = st.sideThreads.find((item) => item.id === params.id || item.sessionId === params.id);
  if (thread === undefined) return null;

  const session = await sessions.get(thread.sessionId).catch(() => undefined);
  const labelPatch: { title?: string; archived?: boolean } = {};
  if (typeof params.title === "string" && params.title.trim() !== "") {
    const nextTitle = params.title.trim();
    thread.userRenamed = true;
    if (thread.title !== nextTitle) {
      thread.title = nextTitle;
      thread.updatedAt = Date.now();
      labelPatch.title = nextTitle;
    }
  }
  if (typeof params.pinned === "boolean") thread.pinned = params.pinned;
  if (typeof params.archived === "boolean") {
    thread.archived = params.archived;
    labelPatch.archived = params.archived;
  }
  if (session !== undefined && (labelPatch.title !== undefined || labelPatch.archived !== undefined)) {
    session.append("label", labelPatch);
  }
  return { ...thread };
}

function formatToolInput(toolName: string, args: Record<string, unknown>): string {
  if ((toolName === "bash" || toolName === "powershell") && typeof args.command === "string") return args.command;
  try {
    return JSON.stringify(args, null, 2);
  } catch {
    return String(args);
  }
}

function parseExitCode(output: string, isError: boolean): number {
  const m = EXIT_CODE_RE.exec(output);
  return m ? Number(m[1] ?? m[2] ?? (isError ? 1 : 0)) : isError ? 1 : 0;
}

function synthesizeContextualSteps(entry: BotActivityEntry | undefined, summary: string, cwd: string): BotActivityTraceStep[] {
  if (entry?.steps && entry.steps.length > 0) {
    const middle = entry.steps.filter((s) => s.kind !== "start" && s.kind !== "done");
    if (middle.length > 0) return middle;
  }
  const isError = entry?.status === "error";
  const stepStatus: BotActivityTraceStep["status"] = entry?.status === "running" ? "running" : isError ? "error" : "completed";
  const titleText = entry?.title ?? "";

  if (entry?.kind === "patrol" || /巡检|Heartbeat/i.test(titleText)) {
    return [
      {
        id: "ctx-patrol-sense",
        kind: "tool",
        iconKind: "mail",
        title: "检索邮件、日历与本机专注状态",
        subtitle: truncateCodepoints(stripMarkdownFormatting(entry?.description || summary), 60),
        status: "completed",
        toolName: "bot_sense_apps",
        commandOrInput: JSON.stringify({ source: "all" }, null, 2),
        cwd,
        exitCode: 0,
        durationMs: 165,
        output: truncateMultiline(entry?.description || summary, 1200),
      },
      {
        id: "ctx-patrol-brief",
        kind: "summary",
        iconKind: "schedule",
        title: "归纳主动关怀与待办建议",
        subtitle: "已整理巡检简报结论",
        status: stepStatus,
        toolName: "patrol_briefing",
        commandOrInput: titleText || "Heartbeat 巡检",
        cwd,
        exitCode: isError ? 1 : 0,
        durationMs: 90,
        output: truncateMultiline(summary, 1200),
      },
    ];
  }
  if (entry?.kind === "scheduled" && /定时/.test(titleText)) {
    return [
      {
        id: "ctx-scheduled-exec",
        kind: "tool",
        iconKind: "schedule",
        title: `执行预定任务：${titleText.replace(/（定时）$/, "") || "后台任务"}`,
        subtitle: truncateCodepoints(stripMarkdownFormatting(summary), 60),
        status: stepStatus,
        toolName: "schedule_runner",
        commandOrInput: titleText || "scheduled_task",
        cwd,
        exitCode: isError ? 1 : 0,
        durationMs: 220,
        output: truncateMultiline(summary, 1200),
      },
    ];
  }
  if (entry?.handoff) {
    return [
      {
        id: "ctx-workbench-handoff",
        kind: "tool",
        iconKind: "subagent",
        title: `协同工作台：${entry.handoff.title}`,
        subtitle: truncateCodepoints(stripMarkdownFormatting(entry.handoff.summary), 60),
        status: stepStatus,
        toolName: "workbench_handoff",
        commandOrInput: JSON.stringify({ title: entry.handoff.title, targetCwd: entry.handoff.targetCwd }, null, 2),
        cwd: entry.handoff.targetCwd || cwd,
        exitCode: isError ? 1 : 0,
        output: truncateMultiline(summary, 1200),
      },
    ];
  }
  return [];
}

export async function buildBotActivityTrace(params: {
  sessions: Sessions;
  st: PersistedBotState;
  botWorkspaceDir: string;
  activityId?: string;
  sessionId?: string;
}): Promise<BotActivityGetTraceResult> {
  const { sessions, st, botWorkspaceDir, activityId, sessionId } = params;
  const allEntries = st.activityGroups.flatMap((g) => g.items);
  const entry =
    (activityId ? allEntries.find((it) => it.id === activityId) : undefined) ??
    (sessionId ? allEntries.find((it) => it.sessionId === sessionId) : undefined);

  const resolvedSessionId = (sessionId?.trim() || entry?.sessionId || "").trim() || undefined;
  const session = resolvedSessionId ? await sessions.get(resolvedSessionId).catch(() => undefined) : undefined;
  const effectiveCwd = session?.header.cwd || entry?.handoff?.targetCwd || botWorkspaceDir;

  const toolSteps: BotActivityTraceStep[] = [];
  let sessionAssistantSummary = "";
  let sessionHasError = false;

  if (session !== undefined) {
    const fullBranch = currentBranch(session.events);
    const startSeq = entry?.turnStartSeq;
    const endSeq = entry?.turnEndSeq;
    const branch =
      startSeq !== undefined
        ? fullBranch.filter((ev) => ev.seq >= startSeq && (endSeq === undefined || ev.seq <= endSeq))
        : fullBranch;

    const resultByCallId = new Map<string, { ts: string; text: string; isError: boolean }>();
    for (const ev of branch) {
      if (ev.type === "tool-result") {
        const text = ev.data.content.flatMap((b) => (b.type === "text" ? [b.text] : [])).join("\n").trim();
        resultByCallId.set(ev.data.callId, { ts: ev.ts, text, isError: ev.data.isError });
      } else if (ev.type === "assistant") {
        const visible = stripThinkAndConnectorNoise(
          ev.data.content.flatMap((b) => (b.type === "text" ? [b.text] : [])).join("\n"),
          false,
        );
        if (visible !== "") sessionAssistantSummary = visible;
        if (ev.data.stop === "error" || ev.data.error !== undefined) {
          sessionHasError = true;
          if (!sessionAssistantSummary && ev.data.error?.message) sessionAssistantSummary = ev.data.error.message;
        } else {
          sessionHasError = false;
        }
      }
    }

    for (const ev of branch) {
      if (ev.type !== "tool-call") continue;
      const { callId, name, args } = ev.data;
      const res = resultByCallId.get(callId);
      const startMs = Date.parse(ev.ts);
      const endMs = res ? Date.parse(res.ts) : NaN;
      const durationMs = Number.isFinite(startMs) && Number.isFinite(endMs) && endMs >= startMs ? endMs - startMs : undefined;
      const stepCwd = typeof args.cwd === "string" && args.cwd.trim() !== "" ? args.cwd.trim() : effectiveCwd;
      const rawOut = res ? res.text : "正在执行中…";
      const baseTitle = describeToolCallTitle(name, args);
      const outcomeDesc = describeToolStepOutcome(name, args, baseTitle, res);
      toolSteps.push({
        id: `tool-${callId}`,
        kind: "tool",
        title: outcomeDesc.title,
        subtitle: outcomeDesc.subtitle,
        iconKind: outcomeDesc.iconKind,
        ...(outcomeDesc.groupLabel ? { groupLabel: outcomeDesc.groupLabel } : {}),
        ...(outcomeDesc.reportMarkdown ? { reportMarkdown: outcomeDesc.reportMarkdown } : {}),
        status: res === undefined ? "running" : res.isError ? "error" : "completed",
        toolName: name,
        commandOrInput: formatToolInput(name, args),
        cwd: stepCwd,
        ...(res !== undefined ? { exitCode: parseExitCode(res.text, res.isError) } : {}),
        ...(durationMs !== undefined ? { durationMs } : {}),
        output: truncateMultiline(rawOut || (res?.isError ? "工具执行返回错误" : "执行完成（无文本输出）"), 1600),
      });
    }
  }

  const cleanedSessionSummary = stripQuickOptionsAndWidgets(sessionAssistantSummary).text;
  const summary =
    truncateMultiline(
      entry?.finishMessage || cleanedSessionSummary || entry?.subtitle || entry?.description || entry?.title || "已完成本次任务执行。",
      4000,
    ) || "已完成本次任务执行。";
  const persistedExtraSteps = (entry?.steps ?? []).filter((s) => s.kind !== "start" && s.kind !== "done");
  const middleSteps =
    toolSteps.length > 0
      ? [...toolSteps, ...persistedExtraSteps.filter((es) => !toolSteps.some((ts) => ts.id === es.id))]
      : synthesizeContextualSteps(entry, summary, effectiveCwd);
  const isError = entry?.status === "error" || (entry?.status === undefined && sessionHasError);
  const isRunning = entry?.status === "running";
  const isInterrupted = entry?.status === "interrupted";

  const startStep: BotActivityTraceStep = {
    id: "start",
    kind: "start",
    iconKind: "start",
    title: "已开始",
    subtitle: entry ? `触发时间 ${entry.timeLabel}` : "任务已启动",
    status: "completed",
    cwd: effectiveCwd,
    output: entry ? `${entry.title}（${entry.timeLabel}）` : "任务已启动",
  };
  const doneStep: BotActivityTraceStep = {
    id: "done",
    kind: "done",
    iconKind: isError ? "error" : "done",
    title: entry?.statusTitle || (isRunning ? "正在执行" : isInterrupted ? "已中止" : isError ? "执行受阻" : "已完成"),
    subtitle: entry?.subtitle || truncateCodepoints(stripMarkdownFormatting(summary), 60),
    status: isRunning ? "running" : isError ? "error" : "completed",
    cwd: effectiveCwd,
    output: summary,
  };
  return {
    entry: entry ?? null,
    steps: [startStep, ...middleSteps, doneStep],
    summary,
    ...(resolvedSessionId ? { sessionId: resolvedSessionId } : {}),
  };
}

export async function bridgeScheduledRunToBotState(params: {
  sessions: Sessions;
  st: PersistedBotState;
  botSessionIds: Set<string>;
  botWorkspaceDir: string;
  run: ScheduledRun;
  taskCwd?: string;
  taskScope?: string;
}): Promise<boolean> {
  const { sessions, st, botSessionIds, botWorkspaceDir, run, taskCwd, taskScope } = params;
  const effectiveScope = run.scope ?? taskScope;
  const effectiveCwd = run.cwd ?? taskCwd ?? "";
  const isSameWorkspace = effectiveCwd !== "" && normalizeBotPath(effectiveCwd) === normalizeBotPath(botWorkspaceDir);
  if (effectiveScope !== "bot" && !isSameWorkspace) return false;

  if (run.sessionId) botSessionIds.add(run.sessionId);
  const session = run.sessionId ? await sessions.get(run.sessionId).catch(() => undefined) : undefined;
  const title = `${run.taskName}（定时）`;
  const cleanedOut = stripThinkAndConnectorNoise(run.output || "", false);
  const cleanPlainSnippet = stripMarkdownFormatting(cleanedOut);
  const snippet =
    truncateCodepoints(cleanPlainSnippet, 84) ||
    (run.status === "running" ? "正在后台执行预定任务…" : run.status === "success" ? "已完成预定任务巡检与执行" : `执行状态：${run.status}`);

  const threadStatus: BotSideThreadStatus = run.status === "running" ? "running" : run.status === "success" ? "idle" : "error";
  const ts = run.finishedAt ?? run.startedAt;
  const existingIdx = st.sideThreads.findIndex(
    (t) => (run.sessionId !== undefined && t.sessionId === run.sessionId) || (t.source === "scheduled" && t.scheduledTaskId === run.taskId),
  );

  if (existingIdx >= 0) {
    const existing = st.sideThreads[existingIdx];
    if (existing !== undefined) {
      const updated: BotSideThreadInfo = {
        ...existing,
        ...(run.sessionId ? { sessionId: run.sessionId, sessionFile: `harness:${run.sessionId}` } : {}),
        title: existing.userRenamed === true ? existing.title : title,
        updatedAt: ts,
        snippet,
        messageCount: session?.summary().messageCount ?? existing.messageCount ?? 0,
        status: threadStatus,
        source: "scheduled",
        scheduledTaskId: run.taskId,
      };
      st.sideThreads.splice(existingIdx, 1);
      st.sideThreads.unshift(updated);
    }
  } else if (run.sessionId) {
    st.sideThreads.unshift({
      id: `side-sched-${run.taskId.slice(0, 12)}`,
      sessionId: run.sessionId,
      sessionFile: `harness:${run.sessionId}`,
      title,
      createdAt: run.startedAt,
      updatedAt: ts,
      snippet,
      messageCount: session?.summary().messageCount ?? 0,
      status: threadStatus,
      source: "scheduled",
      scheduledTaskId: run.taskId,
    });
  }

  const activityStatus: BotActivityStatus =
    run.status === "running" ? "running" : run.status === "success" ? "completed" : run.status === "interrupted" ? "interrupted" : "error";

  upsertTodayActivity(st, {
    id: `act-sched-${run.id.slice(0, 12)}`,
    dateGroup: formatActivityDateBucket(run.startedAt),
    title,
    subtitle: snippet,
    description: snippet,
    ...(cleanedOut ? { finishMessage: stripQuickOptionsAndWidgets(cleanedOut).text.slice(0, 4000) } : {}),
    timeLabel: formatClock(ts),
    createdAt: run.startedAt,
    ...(run.sessionId ? { sessionId: run.sessionId } : {}),
    status: activityStatus,
    kind: "scheduled",
    handoff: {
      id: `handoff-sched-${run.id.slice(0, 8)}`,
      title,
      kindLabel: "定时任务",
      summary: snippet,
      targetCwd: effectiveCwd || botWorkspaceDir,
      ...(run.sessionId ? { targetSessionFile: `harness:${run.sessionId}` } : {}),
    },
  });
  return true;
}

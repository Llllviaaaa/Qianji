/** Task-Aware Live2D Co-Pilot Choreographer (`botTaskChoreographer.ts`). */
import { createReactiveStore, useStoreValue } from "@qianji/client-store";
import type { BotSnapshotResult } from "@qianji/protocol";
import type { BotActionId, BotExpressionId, BotUiState } from "../botUiAtoms";

export type CompanionTaskPhaseId =
  | "awaiting-approval" | "task-error" | "patrol-running" | "tool-editing"
  | "tool-command" | "tool-reading" | "tool-web" | "thinking-stream"
  | "task-completed" | "listening-draft" | "hover-preview" | "unread-briefing" | "idle-ready";

export type RehearsableTaskStageId =
  | "tool-reading" | "tool-editing" | "tool-command"
  | "awaiting-approval" | "task-completed" | "task-error";

export interface TaskQuickActionChip {
  readonly id:
    | "approve-first" | "open-approvals" | "run-patrol" | "plan-today-goals"
    | "summarize-briefing" | "audit-workspace" | "wake-server" | "switch-workbench" | "open-providers";
  readonly labelZh: string;
  readonly tone?: "primary" | "default" | "warning";
  readonly approvalId?: string;
  readonly promptText?: string;
}

export interface HoveredHeroTaskPreview {
  readonly id: string;
  readonly expression: BotExpressionId;
  readonly action: BotActionId;
  readonly speechText: string;
  readonly badgeLabelZh: string;
}

export const hoveredHeroTaskStore = createReactiveStore<HoveredHeroTaskPreview | null>(null);

export function setHoveredHeroTaskPreview(preview: HoveredHeroTaskPreview | null): void {
  if (hoveredHeroTaskStore.get() === preview) return;
  hoveredHeroTaskStore.set(preview);
}

export function getHoveredHeroTaskPreview(): HoveredHeroTaskPreview | null {
  return hoveredHeroTaskStore.get();
}

export function useHoveredHeroTaskPreview(): HoveredHeroTaskPreview | null {
  return useStoreValue(hoveredHeroTaskStore);
}

export interface ResolvedTaskCompanionPresence {
  readonly phase: CompanionTaskPhaseId;
  readonly badgeLabelZh: string;
  readonly statusTone: "neutral" | "active" | "warning" | "success" | "danger";
  readonly expression: BotExpressionId;
  readonly action: BotActionId;
  readonly speechText: string;
  readonly activeToolLabel: string | null;
  readonly quickActions: readonly TaskQuickActionChip[];
}

export interface LiveSessionToolCallLike {
  readonly name: string;
  readonly status?: string;
  readonly args?: Record<string, unknown>;
  readonly input?: Record<string, unknown>;
}

export interface LiveSessionMessageLike {
  readonly role?: string;
  readonly content?: string;
  readonly toolCalls?: readonly LiveSessionToolCallLike[];
}

export interface LiveSessionToolActivity {
  readonly toolPhase: "tool-editing" | "tool-command" | "tool-reading" | "tool-web" | null;
  readonly activeToolName: string | null;
  readonly activeToolLabel: string | null;
  readonly isRunningTool: boolean;
  readonly hasToolError: boolean;
  readonly completedToolCount: number;
  readonly totalTurnToolCount: number;
}

export interface RehearsableTaskStageSpec {
  readonly id: RehearsableTaskStageId;
  readonly labelZh: string;
  readonly shortLabelZh: string;
  readonly badgeLabelZh: string;
  readonly statusTone: ResolvedTaskCompanionPresence["statusTone"];
  readonly sampleToolLabel: string;
  readonly speechText: string;
  readonly defaultExpression: BotExpressionId;
  readonly defaultAction: BotActionId;
}

export const CO_PILOT_TASK_PROMPTS = {
  planGoals: "请结合当前工作区进展与近期记录，帮我梳理今日最关键的 3 项推进目标并给出第一步行动建议。",
  summarizeBriefing: "请帮我汇总最近的巡检简报、待处理事项与未读消息摘要。",
  auditWorkspace: "请快速检查当前工作区的最近改动状态与待关注风险，给我一份简洁体检汇报。",
} as const;

export const REHEARSABLE_TASK_STAGES: readonly RehearsableTaskStageSpec[] = [
  { id: "tool-reading", labelZh: "查阅检索", shortLabelZh: "查阅检索", badgeLabelZh: "正在查阅 · package.json", statusTone: "active", sampleToolLabel: "正在查阅 · package.json", speechText: "正在核对项目依赖与关键代码上下文…", defaultExpression: "curious", defaultAction: "scan" },
  { id: "tool-editing", labelZh: "编码撰写", shortLabelZh: "编码撰写", badgeLabelZh: "正在编写 · BotStage.tsx", statusTone: "active", sampleToolLabel: "正在编写 · BotStage.tsx", speechText: "正在编写改动并保持类型与架构边界对齐…", defaultExpression: "focused", defaultAction: "think" },
  { id: "tool-command", labelZh: "终端执行", shortLabelZh: "终端执行", badgeLabelZh: "正在执行 · 单测与门禁校验", statusTone: "active", sampleToolLabel: "正在执行 · npm test", speechText: "正在终端运行验证命令，确认所有检查通过…", defaultExpression: "patrol", defaultAction: "scan" },
  { id: "awaiting-approval", labelZh: "等待拍板", shortLabelZh: "等待拍板", badgeLabelZh: "1 项待你批准", statusTone: "warning", sampleToolLabel: "待批准 · 发送周报草稿", speechText: "拦下了「发送周报草稿」，确认无误我就立即执行", defaultExpression: "happy", defaultAction: "wave" },
  { id: "task-completed", labelZh: "任务告捷", shortLabelZh: "任务告捷", badgeLabelZh: "任务刚刚完成", statusTone: "success", sampleToolLabel: "已完成 · 4 步工具协作", speechText: "已完成 4 步工具操作并整理好结果啦", defaultExpression: "happy", defaultAction: "celebrate" },
  { id: "task-error", labelZh: "异常提醒", shortLabelZh: "异常提醒", badgeLabelZh: "执行受阻 · 待排查", statusTone: "danger", sampleToolLabel: "异常中断 · 需检查环境或配置", speechText: "刚才的步骤遇到阻碍，已备好排查入口等你确认", defaultExpression: "curious", defaultAction: "think" },
];

export type RehearsableStageLookup =
  ReadonlyMap<RehearsableTaskStageId, RehearsableTaskStageSpec> &
  Readonly<Record<RehearsableTaskStageId, RehearsableTaskStageSpec>>;

export const REHEARSABLE_STAGE_BY_ID: RehearsableStageLookup = Object.assign(
  new Map<RehearsableTaskStageId, RehearsableTaskStageSpec>(REHEARSABLE_TASK_STAGES.map((s) => [s.id, s])),
  Object.fromEntries(REHEARSABLE_TASK_STAGES.map((s) => [s.id, s])) as Record<RehearsableTaskStageId, RehearsableTaskStageSpec>,
);

export function mapPhaseToRehearsableStage(phase: CompanionTaskPhaseId): RehearsableTaskStageId | null {
  if (phase === "tool-reading" || phase === "tool-web") return "tool-reading";
  if (phase === "tool-editing") return "tool-editing";
  if (phase === "tool-command" || phase === "patrol-running") return "tool-command";
  if (phase === "awaiting-approval") return "awaiting-approval";
  if (phase === "task-completed") return "task-completed";
  if (phase === "task-error") return "task-error";
  return null;
}

function extractShortBasename(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim().replace(/\\/g, "/");
  if (trimmed.length === 0) return null;
  const base = trimmed.split("/").filter(Boolean).pop() ?? trimmed;
  return base.length > 26 ? `${base.slice(0, 24)}…` : base;
}

function extractShortSnippet(raw: unknown, maxLen = 22): string | null {
  if (typeof raw !== "string") return null;
  const clean = raw.trim().replace(/\s+/g, " ");
  if (clean.length === 0) return null;
  return clean.length > maxLen ? `${clean.slice(0, maxLen - 1)}…` : clean;
}

function classifySingleToolCall(tc: LiveSessionToolCallLike): {
  readonly phase: NonNullable<LiveSessionToolActivity["toolPhase"]>;
  readonly label: string;
} {
  const lower = tc.name.toLowerCase();
  const bag = tc.args ?? tc.input ?? {};
  const fileTarget =
    extractShortBasename(bag.path ?? bag.Path ?? bag.file_path ?? bag.filePath ?? bag.target_file) ??
    extractShortSnippet(bag.title, 20);
  if (/(?:edit|write|patch|create|replace|delete_file|notebook|notion)/.test(lower)) {
    return { phase: "tool-editing", label: fileTarget ? `正在编写 · ${fileTarget}` : "正在编写文件改动…" };
  }
  if (/(?:bash|command|shell|terminal|exec|vitest|pytest|cargo)/.test(lower) || lower === "test") {
    const cmd = extractShortSnippet(bag.command ?? bag.CommandLine ?? bag.cmd, 20);
    return { phase: "tool-command", label: cmd ? `正在执行 · ${cmd}` : "正在执行终端验证…" };
  }
  if (/(?:web|browser|fetch|http|gmail|github|slack|telegram|feishu|mail|calendar)/.test(lower)) {
    const q = extractShortSnippet(bag.query ?? bag.url ?? bag.subject ?? bag.repo, 18);
    return { phase: "tool-web", label: q ? `正在检索 · ${q}` : "正在检索网页资料…" };
  }
  const readTarget = fileTarget ?? extractShortSnippet(bag.pattern ?? bag.query, 18);
  return { phase: "tool-reading", label: readTarget ? `正在查阅 · ${readTarget}` : "正在查阅项目上下文…" };
}

export function extractLiveSessionToolActivity(
  messages: readonly LiveSessionMessageLike[],
): LiveSessionToolActivity {
  const turnCalls: LiveSessionToolCallLike[] = [];
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const msg = messages[i];
    if (msg === undefined) continue;
    if (msg.role === "user") break;
    if (Array.isArray(msg.toolCalls) && msg.toolCalls.length > 0) turnCalls.unshift(...msg.toolCalls);
  }
  if (turnCalls.length === 0) {
    return {
      toolPhase: null, activeToolName: null, activeToolLabel: null,
      isRunningTool: false, hasToolError: false, completedToolCount: 0, totalTurnToolCount: 0,
    };
  }
  let completedToolCount = 0;
  let hasToolError = false;
  let activeCandidate: LiveSessionToolCallLike | null = null;
  let isRunningTool = false;
  for (const tc of turnCalls) {
    const st = (tc.status ?? "").toLowerCase();
    if (st === "error" || st === "failed") hasToolError = true;
    else if (st === "running" || st === "pending" || st === "streaming" || st === "in_progress") {
      activeCandidate = tc;
      isRunningTool = true;
    } else completedToolCount += 1;
  }
  const chosen = activeCandidate ?? turnCalls[turnCalls.length - 1] ?? null;
  if (chosen === null) {
    return {
      toolPhase: null, activeToolName: null, activeToolLabel: null,
      isRunningTool: false, hasToolError, completedToolCount, totalTurnToolCount: turnCalls.length,
    };
  }
  const classified = classifySingleToolCall(chosen);
  return {
    toolPhase: classified.phase, activeToolName: chosen.name, activeToolLabel: classified.label,
    isRunningTool, hasToolError, completedToolCount, totalTurnToolCount: turnCalls.length,
  };
}

function buildIdleCheckInActions(snapshot: BotSnapshotResult, runningCount: number): readonly TaskQuickActionChip[] {
  const chips: TaskQuickActionChip[] = [
    { id: "run-patrol", labelZh: "立即巡检", tone: "primary" },
    { id: "plan-today-goals", labelZh: "梳理目标", promptText: CO_PILOT_TASK_PROMPTS.planGoals },
  ];
  if (snapshot.virtualServer.lifecycle === "sleeping") {
    chips.unshift({ id: "wake-server", labelZh: "唤醒环境", tone: "primary" });
    return chips.slice(0, 3);
  }
  if (runningCount > 0) chips.push({ id: "switch-workbench", labelZh: "去工作台查看" });
  return chips;
}

export function resolveTaskCompanionPresence(params: {
  readonly ui: BotUiState;
  readonly snapshot: BotSnapshotResult;
  readonly isStreaming?: boolean;
  readonly justReplied?: boolean;
  readonly idleLookAround?: boolean;
  readonly hoveringStage?: boolean;
  readonly toolActivity?: LiveSessionToolActivity | null;
  readonly hoveredPreview?: HoveredHeroTaskPreview | null;
  readonly runtimeError?: string | null;
  readonly runningWorkbenchCount?: number;
  readonly approvalWorkbenchCount?: number;
}): ResolvedTaskCompanionPresence {
  const {
    ui, snapshot, isStreaming = false, justReplied = false, idleLookAround = false,
    hoveringStage = false, toolActivity = null,
    runtimeError = null, runningWorkbenchCount = 0, approvalWorkbenchCount = 0,
  } = params;
  const activeHover = params.hoveredPreview !== undefined ? params.hoveredPreview : hoveredHeroTaskStore.get();

  if (activeHover !== null) {
    return {
      phase: "hover-preview", badgeLabelZh: activeHover.badgeLabelZh, statusTone: "active",
      expression: activeHover.expression, action: activeHover.action,
      speechText: activeHover.speechText, activeToolLabel: null, quickActions: [],
    };
  }
  const trimmedErr = runtimeError?.trim() ?? "";
  if (trimmedErr.length > 0 || (!isStreaming && toolActivity?.hasToolError === true)) {
    return {
      phase: "task-error", badgeLabelZh: "执行受阻 · 待排查", statusTone: "danger",
      expression: "curious", action: "think",
      speechText: trimmedErr.length > 0 ? `执行遇到阻碍：${extractShortSnippet(trimmedErr, 28)}` : "刚才的工具调用遇到异常，需要我帮你排查原因吗？",
      activeToolLabel: toolActivity?.activeToolLabel ?? null,
      quickActions: [
        { id: "audit-workspace", labelZh: "排查环境状态", tone: "primary", promptText: CO_PILOT_TASK_PROMPTS.auditWorkspace },
        { id: "open-providers", labelZh: "检查模型配置", tone: "warning" },
      ],
    };
  }
  const firstApproval = snapshot.pendingApprovals[0];
  const totalApprovals = snapshot.pendingApprovals.length + approvalWorkbenchCount;
  if (totalApprovals > 0) {
    return {
      phase: "awaiting-approval", badgeLabelZh: `${totalApprovals} 项待你批准`, statusTone: "warning",
      expression: "happy", action: "wave",
      speechText: firstApproval !== undefined
        ? `拦下了「${firstApproval.title}」，确认无误我就立即执行`
        : `工作台有 ${approvalWorkbenchCount} 项敏感操作正在等待你的确认`,
      activeToolLabel: firstApproval !== undefined ? `待批准 · ${firstApproval.title}` : null,
      quickActions: firstApproval !== undefined
        ? [{ id: "approve-first", labelZh: "批准并执行", tone: "primary", approvalId: firstApproval.id }, { id: "open-approvals", labelZh: "查看详情" }]
        : [{ id: "switch-workbench", labelZh: "去工作台批准", tone: "primary" }],
    };
  }
  if (isStreaming) {
    const tp = toolActivity?.toolPhase ?? null;
    const label = toolActivity?.activeToolLabel ?? null;
    if (tp === "tool-editing") {
      return { phase: "tool-editing", badgeLabelZh: label ?? "正在编写代码…", statusTone: "active", expression: "focused", action: "think", speechText: label ? `${label}，保持类型与规范对齐中` : "正在为你编写文件改动…", activeToolLabel: label, quickActions: [] };
    }
    if (tp === "tool-command") {
      return { phase: "tool-command", badgeLabelZh: label ?? "正在执行验证…", statusTone: "active", expression: "patrol", action: "scan", speechText: label ? `${label}，正在盯紧终端输出` : "正在执行终端检查命令…", activeToolLabel: label, quickActions: [] };
    }
    if (tp === "tool-reading" || tp === "tool-web") {
      return { phase: tp, badgeLabelZh: label ?? "正在查阅上下文…", statusTone: "active", expression: "curious", action: "scan", speechText: label ? `${label}，梳理关键线索中` : "正在检索核对项目上下文…", activeToolLabel: label, quickActions: [] };
    }
    return { phase: "thinking-stream", badgeLabelZh: "正在推演整理…", statusTone: "active", expression: "focused", action: "think", speechText: "正在综合上下文为你推演执行方案…", activeToolLabel: null, quickActions: [] };
  }
  if (ui.serverBusy) {
    return { phase: "patrol-running", badgeLabelZh: "巡检运行中", statusTone: "active", expression: "patrol", action: "scan", speechText: "正在主动扫描工作区变更、待办与环境健康…", activeToolLabel: "正在执行 · 主动巡检", quickActions: [] };
  }
  if (justReplied) {
    const done = toolActivity?.completedToolCount ?? 0;
    return {
      phase: "task-completed", badgeLabelZh: "任务刚刚完成", statusTone: "success",
      expression: "happy", action: done >= 2 ? "celebrate" : "wave",
      speechText: done > 0 ? `已完成 ${done} 步工具操作并整理好结果啦` : "已经回复好啦，要继续推进下一步吗？",
      activeToolLabel: done > 0 ? `已完成 · ${done} 步工具操作` : null,
      quickActions: [
        { id: "plan-today-goals", labelZh: "推进下一步目标", tone: "primary", promptText: CO_PILOT_TASK_PROMPTS.planGoals },
        ...(runningWorkbenchCount > 0 ? [{ id: "switch-workbench" as const, labelZh: "去工作台查看" }] : []),
      ],
    };
  }
  if (ui.characterMoodMode === "manual") {
    return {
      phase: "idle-ready", badgeLabelZh: "任务协作待命", statusTone: "active",
      expression: ui.characterExpression || "happy", action: ui.characterAction || "wave",
      speechText: ui.characterSpeech ?? "工作区状态正常，需要我现在跑一次主动巡检，还是梳理今日目标？",
      activeToolLabel: null, quickActions: buildIdleCheckInActions(snapshot, runningWorkbenchCount),
    };
  }
  if (ui.voiceCallActive) return { phase: "listening-draft", badgeLabelZh: "实时语音连线中", statusTone: "active", expression: "happy", action: "wave", speechText: "语音连线倾听中，请直接交办任务", activeToolLabel: null, quickActions: [] };
  if (ui.composerDraft.trim().length > 0) return { phase: "listening-draft", badgeLabelZh: "倾听任务输入中", statusTone: "active", expression: "curious", action: "nod", speechText: "正在听你整理需求，发送后我立即跟进", activeToolLabel: null, quickActions: [] };
  const unread = snapshot.inboxItems.filter((item) => item.unread).length;
  if (unread > 0) {
    return {
      phase: "unread-briefing", badgeLabelZh: `${unread} 条未读消息`, statusTone: "warning",
      expression: "calm", action: "idle", speechText: `收件箱有 ${unread} 条未读动态，需要我帮你浓缩摘要吗？`,
      activeToolLabel: null,
      quickActions: [{ id: "summarize-briefing", labelZh: "汇总未读简报", tone: "primary", promptText: CO_PILOT_TASK_PROMPTS.summarizeBriefing }, { id: "run-patrol", labelZh: "立即巡检" }],
    };
  }
  if (snapshot.virtualServer.lifecycle === "sleeping") {
    return { phase: "idle-ready", badgeLabelZh: "容器浅眠待命", statusTone: "neutral", expression: "sleepy", action: "idle", speechText: "隔离环境正处于节能浅眠，发消息或点此即可唤醒", activeToolLabel: null, quickActions: buildIdleCheckInActions(snapshot, runningWorkbenchCount) };
  }
  const activeGoals = snapshot.goals.filter((g) => g.status === "active").length;
  const idleBadge = runningWorkbenchCount > 0 ? `${runningWorkbenchCount} 项后台任务运行中` : activeGoals > 0 ? `盯守 ${activeGoals} 项重点目标` : "待命守候";
  return {
    phase: "idle-ready", badgeLabelZh: idleBadge, statusTone: runningWorkbenchCount > 0 ? "active" : "neutral",
    expression: hoveringStage || idleLookAround ? "curious" : "calm",
    action: hoveringStage || idleLookAround ? "nod" : "idle",
    speechText: hoveringStage ? "点我可以快捷发起工作区巡检或梳理今日重点目标" : snapshot.pacing.heartbeatEnabled ? `工作区盯守中 · 每 ${snapshot.pacing.heartbeatIntervalMinutes}m 自动巡检` : "工作区待命守候中，随时准备执行任务",
    activeToolLabel: null, quickActions: buildIdleCheckInActions(snapshot, runningWorkbenchCount),
  };
}

/**
 * Pure selectors, strict session-scoping matchers, Outcome-Thread synthesis,
 * and telemetry formatters for `swarm` (`src/builtin-plugins/swarm/swarmSelectors.ts`).
 */
import type {
  SwarmMemberInfo,
  SwarmPlanThread,
  SwarmRoleModelConfig,
  SwarmSnapshotResult,
  SwarmSummaryInfo,
  SwarmTaskItem,
} from "@qianji/protocol";
import type { SwarmDataState, SwarmMemberFilter, SwarmUiState } from "./swarmStore";

export function computeMemberCounts(members: readonly SwarmMemberInfo[]): SwarmSummaryInfo["memberCounts"] {
  let total = 0;
  let working = 0;
  let waiting = 0;
  let stalled = 0;
  let blocked = 0;
  for (const m of members) {
    if (m.killed) continue;
    total += 1;
    if (m.state === "working") working += 1;
    else if (m.state === "waiting") waiting += 1;
    else if (m.state === "stalled") stalled += 1;
    else if (m.state === "blocked") blocked += 1;
  }
  return { total, working, waiting, stalled, blocked };
}

export function computeTaskCounts(tasks: readonly SwarmTaskItem[]): SwarmSummaryInfo["taskCounts"] {
  let pending = 0;
  let inProgress = 0;
  let verifying = 0;
  let completed = 0;
  let blocked = 0;
  for (const t of tasks) {
    if (t.status === "pending") pending += 1;
    else if (t.status === "claimed" || t.status === "in_progress") inProgress += 1;
    else if (t.status === "verifying") verifying += 1;
    else if (t.status === "completed") completed += 1;
    else if (t.status === "blocked" || t.status === "failed") blocked += 1;
  }
  return { total: tasks.length, pending, inProgress, verifying, completed, blocked };
}

export function deriveSummaryFromSnapshot(snapshot: SwarmSnapshotResult): SwarmSummaryInfo {
  const explicitTasks = computeTaskCounts(snapshot.tasks);
  if (explicitTasks.total > 0) {
    return {
      run: snapshot.run,
      memberCounts: computeMemberCounts(snapshot.members),
      taskCounts: explicitTasks,
      unresolvedAlertCount: snapshot.alerts.filter((a) => !a.resolved).length,
    };
  }
  const workers = snapshot.members.filter((m) => m.role !== "coordinator" && m.role !== "monitor");
  let completed = 0;
  let inProgress = 0;
  let pending = 0;
  let blocked = 0;
  for (const w of workers) {
    if (typeof w.completedAt === "number" && w.completedAt > 0) completed += 1;
    else if (w.state === "working") inProgress += 1;
    else if (w.state === "blocked" || w.state === "stalled") blocked += 1;
    else if (!w.killed) pending += 1;
  }
  const total = completed + inProgress + pending + blocked;
  return {
    run: snapshot.run,
    memberCounts: computeMemberCounts(snapshot.members),
    taskCounts: { total, pending, inProgress, verifying: 0, completed, blocked },
    unresolvedAlertCount: snapshot.alerts.filter((a) => !a.resolved).length,
  };
}

export function normalizeBareSessionId(raw: string | null | undefined): string {
  if (typeof raw !== "string") return "";
  const trimmed = raw.trim();
  if (trimmed.startsWith("harness://")) return trimmed.slice("harness://".length);
  if (trimmed.startsWith("harness:")) return trimmed.slice("harness:".length);
  return trimmed;
}

export function sameWorkspacePath(a: string | undefined, b: string | undefined): boolean {
  const cleanA = (a ?? "").trim().replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
  const cleanB = (b ?? "").trim().replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
  return cleanA !== "" && cleanA === cleanB;
}

export function findSwarmSummaryForSession(
  summaries: readonly SwarmSummaryInfo[],
  sessionId: string | null | undefined,
  sessionFile?: string | null,
): SwarmSummaryInfo | undefined {
  const candidates = new Set<string>();
  const normId = normalizeBareSessionId(sessionId);
  const normFile = normalizeBareSessionId(sessionFile);
  if (normId !== "") candidates.add(normId);
  if (normFile !== "") candidates.add(normFile);
  if (candidates.size === 0) return undefined;
  return summaries.find((item) => {
    const coord = normalizeBareSessionId(item.run.coordinatorSessionId);
    return coord !== "" && candidates.has(coord);
  });
}

export function resolveSessionSwarmSummary(
  data: SwarmDataState,
  ui: SwarmUiState,
  sessionId: string | null | undefined,
  sessionFile?: string | null,
): SwarmSummaryInfo | undefined {
  const normId = normalizeBareSessionId(sessionId);
  const normFile = normalizeBareSessionId(sessionFile);
  if (normId !== "" || normFile !== "") {
    const direct = findSwarmSummaryForSession(data.summaries, sessionId, sessionFile);
    if (direct !== undefined) return direct;
    if (
      ui.pendingDraftSwarmId !== null &&
      ui.pendingAdoptingSessionId !== null &&
      (ui.pendingAdoptingSessionId === normId || ui.pendingAdoptingSessionId === normFile)
    ) {
      return data.summaries.find((item) => item.run.id === ui.pendingDraftSwarmId);
    }
    return undefined;
  }
  if (ui.pendingDraftSwarmId !== null) {
    return data.summaries.find(
      (item) => item.run.id === ui.pendingDraftSwarmId && item.run.status !== "stopped",
    );
  }
  return undefined;
}

export function isSwarmEnabledForSession(
  data: SwarmDataState,
  ui: SwarmUiState,
  sessionId: string | null | undefined,
  sessionFile?: string | null,
): boolean {
  if (resolveSessionSwarmSummary(data, ui, sessionId, sessionFile) !== undefined) return true;
  const normId = normalizeBareSessionId(sessionId);
  const normFile = normalizeBareSessionId(sessionFile);
  return normId === "" && normFile === "" && (ui.pendingDraftSwarm || ui.pendingDraftSwarmId !== null);
}

export function resolveActiveSwarmSnapshot(
  data: SwarmDataState,
  ui: SwarmUiState,
  sessionId?: string | null,
  sessionFile?: string | null,
): SwarmSnapshotResult | null {
  const bound = resolveSessionSwarmSummary(data, ui, sessionId, sessionFile);
  if (bound !== undefined) {
    return data.snapshotsById[bound.run.id] ?? null;
  }
  const normId = normalizeBareSessionId(sessionId);
  const normFile = normalizeBareSessionId(sessionFile);
  if (normId === "" && normFile === "" && ui.activeSwarmId !== null) {
    return data.snapshotsById[ui.activeSwarmId] ?? null;
  }
  return null;
}

export function filterSwarmMembers(
  members: readonly SwarmMemberInfo[],
  filter: SwarmMemberFilter,
): SwarmMemberInfo[] {
  return members.filter((member) => {
    if (filter === "all") return true;
    if (filter === "working") return !member.killed && member.state === "working";
    if (filter === "waiting") return !member.killed && member.state === "waiting";
    return !member.killed && (member.state === "stalled" || member.state === "blocked" || Boolean(member.error));
  });
}

/* ── Outcome Threads & Overview Derivation (v2 Antigravity Architecture) ── */

export type OutcomeMemberItemStatus = "done" | "working" | "waitingOn" | "stalled" | "queued";

export interface OutcomeThreadMemberItem {
  readonly memberName: string;
  readonly member?: SwarmMemberInfo;
  readonly label: string;
  readonly status: OutcomeMemberItemStatus;
  readonly waitingOn?: string;
}

export interface ResolvedOutcomeThread {
  readonly id: string;
  readonly title: string;
  readonly goal: string;
  readonly items: readonly OutcomeThreadMemberItem[];
  readonly doneCount: number;
  readonly totalCount: number;
  readonly state: "active" | "waitingOn" | "completed" | "idle";
}

export interface DerivedOutcomeOverview {
  readonly goalTitle: string;
  readonly goalLine: string;
  readonly threads: readonly ResolvedOutcomeThread[];
  readonly allItems: readonly OutcomeThreadMemberItem[];
  readonly doneCount: number;
  readonly totalCount: number;
  readonly verifyingCount: number;
  readonly dirtyFileCount: number;
}

function summarizeBriefOneLine(brief: string): string {
  const clean = brief.replace(/\s+/g, " ").trim();
  if (clean === "") return "协同子任务执行";
  return clean.length > 56 ? `${clean.slice(0, 55)}…` : clean;
}

export function resolveMemberTaskLabel(snapshot: SwarmSnapshotResult, member: SwarmMemberInfo): string {
  const planned = snapshot.run.plan?.tasks[member.name];
  if (typeof planned === "string" && planned.trim() !== "") return planned.trim();
  const assignedTask =
    snapshot.tasks.find((t) => t.assignee === member.name && t.status !== "completed") ??
    snapshot.tasks.find((t) => t.assignee === member.name);
  if (assignedTask !== undefined) return assignedTask.title;
  return summarizeBriefOneLine(member.brief);
}

export function resolveMemberItemStatus(
  snapshot: SwarmSnapshotResult,
  member: SwarmMemberInfo | undefined,
  memberName: string,
): OutcomeMemberItemStatus {
  if (member !== undefined) {
    if (typeof member.completedAt === "number" && member.completedAt > 0 && member.state !== "working") {
      return "done";
    }
    if (member.state === "stalled" || member.state === "blocked") return "stalled";
    if (member.state === "working") return "working";
    if (typeof member.waitingOn === "string" && member.waitingOn !== "") return "waitingOn";
  }
  const memberTasks = snapshot.tasks.filter((t) => t.assignee === memberName);
  if (memberTasks.length > 0 && memberTasks.every((t) => t.status === "completed")) {
    return "done";
  }
  if (memberTasks.some((t) => t.status === "in_progress" || t.status === "claimed")) {
    return "working";
  }
  if (snapshot.run.status === "completed") return "done";
  return "queued";
}

function buildSynthesizedThreads(snapshot: SwarmSnapshotResult): SwarmPlanThread[] {
  const planThreads = snapshot.run.plan?.threads ?? [];
  const nonObservers = snapshot.members.filter(
    (m) => m.role !== "coordinator" && m.role !== "monitor",
  );
  if (planThreads.length > 0) {
    const covered = new Set(planThreads.flatMap((t) => t.members));
    const ungrouped = nonObservers.filter((m) => !covered.has(m.name) && !m.killed).map((m) => m.name);
    if (ungrouped.length === 0 || planThreads.length >= 6) return planThreads.slice(0, 6);
    return [
      ...planThreads,
      { id: "thread-extra", title: "补充协同任务", goal: "新增并行协作分支", members: ungrouped },
    ].slice(0, 6);
  }

  if (nonObservers.length === 0) {
    if (snapshot.tasks.length === 0) return [];
    const taskAssignees = Array.from(
      new Set(
        snapshot.tasks
          .map((t) => (typeof t.assignee === "string" && t.assignee.trim() !== "" ? t.assignee.trim() : "coordinator"))
          .filter((name) => name !== ""),
      ),
    );
    return [
      {
        id: "syn-tasks",
        title: "任务拆解与推进",
        goal: snapshot.run.goal || "按计划推进工作流任务",
        members: taskAssignees,
      },
    ];
  }
  const builders = nonObservers.filter((m) => m.role === "worker" || m.role === "planner");
  const explorers = nonObservers.filter((m) => m.role === "explorer");
  const verifiers = nonObservers.filter((m) => m.role === "verifier");
  const groups: SwarmPlanThread[] = [];

  if (explorers.length > 0) {
    groups.push({ id: "syn-explore", title: "调研与上下文梳理", goal: "定位关键代码路径与边界条件", members: explorers.map((m) => m.name) });
  }
  if (builders.length > 0) {
    groups.push({ id: "syn-build", title: "核心实现与改造", goal: snapshot.run.goal || "并行推进模块开发与重构", members: builders.map((m) => m.name) });
  }
  if (verifiers.length > 0) {
    groups.push({ id: "syn-verify", title: "独立验收与门禁", goal: "交叉审查变更与自动化测试验证", members: verifiers.map((m) => m.name) });
  }
  return groups.slice(0, 6);
}

const THREAD_ORDER_RANK: Readonly<Record<ResolvedOutcomeThread["state"], number>> = {
  active: 0,
  waitingOn: 1,
  idle: 2,
  completed: 3,
};

export function deriveOutcomeOverview(snapshot: SwarmSnapshotResult): DerivedOutcomeOverview {
  const byName = new Map(snapshot.members.map((m) => [m.name, m] as const));
  const rawThreads = buildSynthesizedThreads(snapshot);

  const resolvedThreads: ResolvedOutcomeThread[] = rawThreads.map((thread) => {
    const items: OutcomeThreadMemberItem[] = thread.members.map((name) => {
      const member = byName.get(name);
      const label =
        snapshot.run.plan?.tasks[name] ??
        (member !== undefined ? resolveMemberTaskLabel(snapshot, member) : name);
      const status = resolveMemberItemStatus(snapshot, member, name);
      return {
        memberName: name,
        ...(member !== undefined ? { member } : {}),
        label,
        status,
        ...(member?.waitingOn !== undefined && member.waitingOn !== "" ? { waitingOn: member.waitingOn } : {}),
      };
    });

    const totalCount = items.length;
    const doneCount = items.filter((i) => i.status === "done").length;
    const hasWorking = items.some((i) => i.status === "working" || i.status === "stalled");
    const hasWaitingOn = items.some((i) => i.status === "waitingOn");
    const state: ResolvedOutcomeThread["state"] =
      totalCount > 0 && doneCount === totalCount
        ? "completed"
        : hasWorking
          ? "active"
          : hasWaitingOn
            ? "waitingOn"
            : "idle";

    return { id: thread.id, title: thread.title, goal: thread.goal, items, doneCount, totalCount, state };
  });

  resolvedThreads.sort((a, b) => THREAD_ORDER_RANK[a.state] - THREAD_ORDER_RANK[b.state]);

  const seenMembers = new Set<string>();
  const uniqueItems: OutcomeThreadMemberItem[] = [];
  for (const th of resolvedThreads) {
    for (const item of th.items) {
      if (!seenMembers.has(item.memberName)) {
        seenMembers.add(item.memberName);
        uniqueItems.push(item);
      }
    }
  }

  const useExplicitTaskTotals = snapshot.run.plan === undefined && snapshot.tasks.length > 0;
  const taskCounts = computeTaskCounts(snapshot.tasks);
  const doneCount = useExplicitTaskTotals ? taskCounts.completed : uniqueItems.filter((i) => i.status === "done").length;
  const totalCount = useExplicitTaskTotals ? taskCounts.total : uniqueItems.length;
  const dirtyFileCount = snapshot.members.reduce((acc, m) => acc + (m.killed ? 0 : m.changedFileCount), 0);

  return {
    goalTitle: snapshot.run.plan?.goalTitle || snapshot.run.title || "蜂群协作任务",
    goalLine: snapshot.run.plan?.goalLine || snapshot.run.goal || "",
    threads: resolvedThreads,
    allItems: uniqueItems,
    doneCount,
    totalCount,
    verifyingCount: taskCounts.verifying,
    dirtyFileCount,
  };
}

export const ROLE_MODEL_VALUE_SEP = "::";

export function encodeRoleModelValue(cfg: SwarmRoleModelConfig | null | undefined): string {
  if (!cfg || cfg.model.trim() === "") return "";
  return `${cfg.provider.trim()}${ROLE_MODEL_VALUE_SEP}${cfg.model.trim()}`;
}

export function decodeRoleModelValue(
  encoded: string,
  prevEffort?: string,
): SwarmRoleModelConfig | null {
  const trimmed = encoded.trim();
  if (trimmed === "") return null;
  const sepIdx = trimmed.indexOf(ROLE_MODEL_VALUE_SEP);
  if (sepIdx <= 0) {
    return {
      provider: "",
      model: trimmed,
      ...(prevEffort !== undefined && prevEffort !== "" ? { effort: prevEffort } : {}),
    };
  }
  const provider = trimmed.slice(0, sepIdx).trim();
  const model = trimmed.slice(sepIdx + ROLE_MODEL_VALUE_SEP.length).trim();
  if (model === "") return null;
  return {
    provider,
    model,
    ...(prevEffort !== undefined && prevEffort !== "" ? { effort: prevEffort } : {}),
  };
}

export function formatTokenCompact(tokens: number): string {
  if (!Number.isFinite(tokens) || tokens <= 0) return "0";
  if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(2)}M`;
  if (tokens >= 1_000) return `${(tokens / 1_000).toFixed(1)}K`;
  return String(Math.round(tokens));
}

export function formatUsdCost(usd: number): string {
  if (!Number.isFinite(usd) || usd <= 0) return "$0.00";
  if (usd < 0.01) return `$${usd.toFixed(4)}`;
  return `$${usd.toFixed(2)}`;
}

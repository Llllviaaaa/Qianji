/**
 * Internal swarm state records, snapshot/summary builders, live token/cost
 * rollup, alert helpers, and Host stall watchdog logic (`@qianji/swarm`).
 */
import { randomBytes } from "node:crypto";
import type { Context } from "@deepseek-ai/cordis";
import { estimateUsageCost, lookupBuiltinPricing } from "@qianji/pricing";
import type {
  SwarmAlertInfo,
  SwarmMemberInfo,
  SwarmRunInfo,
  SwarmSnapshotResult,
  SwarmSummaryInfo,
  SwarmTokenUsage,
} from "@qianji/protocol";
import type { SessionSummary } from "@qianji/session";
import type { SwarmBoardEngine } from "./board.ts";
import { extractBoardScreenshots, isEligibleOutcomeWorker, synthesizeSwarmPlan } from "./outcomes.ts";
import type { SwarmTaskEngine } from "./tasks.ts";
import type { BoundWorkerSession } from "./worker-session.ts";
import type { MemberWorkspaceHandle } from "./worktrees.ts";

export interface ManagedMember {
  info: SwarmMemberInfo;
  workspace: MemberWorkspaceHandle;
  bound?: BoundWorkerSession;
  inTurnWaiters: number;
}

export interface ManagedSwarm {
  run: SwarmRunInfo;
  board: SwarmBoardEngine;
  tasks: SwarmTaskEngine;
  members: Map<string, ManagedMember>;
  alerts: SwarmAlertInfo[];
}

export function emptyUsage(): SwarmTokenUsage {
  return { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, totalTokens: 0 };
}

export function shortId(prefix: string): string {
  return `${prefix}-${randomBytes(4).toString("hex")}`;
}

export function parseModelSpec(
  rawModel: string | undefined,
  explicitProvider: string | undefined,
  fallback: { provider: string; model: string },
): { provider: string; model: string } {
  if (rawModel === undefined || rawModel.trim() === "") return fallback;
  const trimmed = rawModel.trim();
  if (explicitProvider !== undefined && explicitProvider.trim() !== "") {
    return { provider: explicitProvider.trim(), model: trimmed };
  }
  const slash = trimmed.indexOf("/");
  if (slash > 0 && slash < trimmed.length - 1) {
    return { provider: trimmed.slice(0, slash), model: trimmed.slice(slash + 1) };
  }
  return { provider: fallback.provider, model: trimmed };
}

export function recomputeSwarmTotals(swarm: ManagedSwarm): void {
  const total = emptyUsage();
  let totalCost = 0;
  for (const { info } of swarm.members.values()) {
    total.inputTokens += info.usage.inputTokens;
    total.outputTokens += info.usage.outputTokens;
    total.cacheReadTokens += info.usage.cacheReadTokens;
    total.cacheWriteTokens += info.usage.cacheWriteTokens;
    total.totalTokens += info.usage.totalTokens;
    totalCost += info.estimatedCostUsd;
  }
  swarm.run.totalUsage = total;
  swarm.run.totalCostUsd = totalCost;
}

export function estimateMemberSessionCost(ctx: Context, summary: SessionSummary): number {
  const pricing = ctx.get("pricing") as { estimateSessionCost?: (s: SessionSummary) => number } | undefined;
  if (pricing?.estimateSessionCost !== undefined) {
    return pricing.estimateSessionCost(summary);
  }
  let cost = 0;
  for (const bucket of summary.modelUsage ?? []) {
    cost += estimateUsageCost(bucket.usage, lookupBuiltinPricing(bucket.model));
  }
  return cost;
}

export function buildSwarmSnapshot(swarm: ManagedSwarm): SwarmSnapshotResult {
  const roleModels = swarm.run.roleModels === undefined
    ? undefined
    : Object.fromEntries(Object.entries(swarm.run.roleModels).map(([k, v]) => [k, v === undefined ? undefined : { ...v }]));
  const members = [...swarm.members.values()].map((m) => ({
    ...m.info,
    channels: [...m.info.channels],
    usage: { ...m.info.usage },
  }));
  const plan = synthesizeSwarmPlan(swarm.run, members);
  const screenshots = extractBoardScreenshots(swarm.board.allMessages());
  return {
    run: {
      ...swarm.run,
      ...(roleModels === undefined ? {} : { roleModels }),
      plan,
      channels: swarm.board.listChannels(),
      totalUsage: { ...swarm.run.totalUsage },
    },
    members,
    tasks: swarm.tasks.list(),
    recentMessages: swarm.board.read({ limit: 80 }).messages,
    alerts: swarm.alerts.map((a) => ({ ...a })),
    screenshots,
  };
}

export function buildSwarmSummary(swarm: ManagedSwarm): SwarmSummaryInfo {
  const allInfos = [...swarm.members.values()].map((m) => m.info);
  const members = [...swarm.members.values()].filter((m) => !m.info.killed);
  const tasks = swarm.tasks.list();
  const plan = synthesizeSwarmPlan(swarm.run, allInfos);
  const roleModels = swarm.run.roleModels === undefined
    ? undefined
    : Object.fromEntries(Object.entries(swarm.run.roleModels).map(([k, v]) => [k, v === undefined ? undefined : { ...v }]));
  const outcomeWorkers = allInfos.filter(isEligibleOutcomeWorker);
  const taskCounts = tasks.length > 0
    ? {
        total: tasks.length,
        pending: tasks.filter((t) => t.status === "pending").length,
        inProgress: tasks.filter((t) => t.status === "claimed" || t.status === "in_progress").length,
        verifying: tasks.filter((t) => t.status === "verifying").length,
        completed: tasks.filter((t) => t.status === "completed").length,
        blocked: tasks.filter((t) => t.status === "blocked" || t.status === "failed").length,
      }
    : (() => {
        const completed = outcomeWorkers.filter((m) => m.completedAt !== undefined).length;
        const blocked = outcomeWorkers.filter(
          (m) => m.completedAt === undefined && (m.waitingOn !== undefined || m.state === "blocked" || m.state === "stalled"),
        ).length;
        const inProgress = outcomeWorkers.filter(
          (m) => m.completedAt === undefined && m.waitingOn === undefined && m.state === "working",
        ).length;
        const pending = Math.max(0, outcomeWorkers.length - completed - blocked - inProgress);
        return {
          total: outcomeWorkers.length,
          pending,
          inProgress,
          verifying: 0,
          completed,
          blocked,
        };
      })();

  return {
    run: {
      ...swarm.run,
      ...(roleModels === undefined ? {} : { roleModels }),
      plan,
      channels: swarm.board.listChannels(),
      totalUsage: { ...swarm.run.totalUsage },
    },
    memberCounts: {
      total: members.length,
      working: members.filter((m) => m.info.state === "working").length,
      waiting: members.filter((m) => m.info.state === "waiting").length,
      stalled: members.filter((m) => m.info.state === "stalled").length,
      blocked: members.filter((m) => m.info.state === "blocked").length,
    },
    taskCounts,
    unresolvedAlertCount: swarm.alerts.filter((a) => !a.resolved).length,
  };
}

export function emitSwarmAlert(
  ctx: Context,
  swarm: ManagedSwarm,
  input: Omit<SwarmAlertInfo, "id" | "swarmId" | "resolved" | "createdAt">,
  now = Date.now(),
): SwarmAlertInfo {
  const existing = swarm.alerts.find(
    (a) => !a.resolved && a.kind === input.kind && a.memberName === input.memberName && a.taskId === input.taskId,
  );
  if (existing !== undefined) return existing;
  const alert: SwarmAlertInfo = {
    id: shortId("alert"),
    swarmId: swarm.run.id,
    resolved: false,
    createdAt: now,
    ...input,
  };
  swarm.alerts.push(alert);
  ctx.emit("swarm/alert", { swarmId: swarm.run.id, alert: { ...alert } });
  return alert;
}

export function resolveMemberAlerts(
  swarm: ManagedSwarm,
  memberName: string,
  kind?: SwarmAlertInfo["kind"],
): void {
  for (const alert of swarm.alerts) {
    if (!alert.resolved && alert.memberName === memberName && (kind === undefined || alert.kind === kind)) {
      alert.resolved = true;
    }
  }
}

export function runSwarmWatchdogOnSwarm(
  ctx: Context,
  swarm: ManagedSwarm,
  now: number,
  onPersist: (swarm: ManagedSwarm, now: number) => void,
): SwarmAlertInfo[] {
  if (swarm.run.status !== "running") return [];
  const emitted: SwarmAlertInfo[] = [];
  let mutated = false;

  for (const m of swarm.members.values()) {
    if (m.info.killed || m.info.role === "coordinator") continue;
    if (m.info.state === "working" && now - m.info.lastActivityAt > swarm.run.stallTimeoutMs) {
      m.info.state = "stalled";
      const before = swarm.alerts.length;
      const alert = emitSwarmAlert(
        ctx,
        swarm,
        {
          kind: "stall",
          severity: "warning",
          memberName: m.info.name,
          message: `@${m.info.name} stalled (no activity for ${Math.round((now - m.info.lastActivityAt) / 1000)}s).`,
        },
        now,
      );
      if (swarm.alerts.length > before) emitted.push(alert);
      ctx.emit("swarm/memberDelta", { swarmId: swarm.run.id, member: { ...m.info } });
      mutated = true;
    }
  }

  const nonMonitor = [...swarm.members.values()].filter((m) => !m.info.killed && m.info.role !== "monitor");
  const allIdleOrStopped =
    nonMonitor.length > 0
    && nonMonitor.every(
      (m) =>
        (m.info.state === "waiting" || m.info.state === "stopped")
        && (m.info.sessionId === "" || !ctx.agents.status(m.info.sessionId).running),
    );
  const anyUnreadWake = [...swarm.members.values()].some(
    (m) => !m.info.killed && swarm.board.hasUnreadWakeFor(m.info, m.info.lastReadSeq),
  );

  if (allIdleOrStopped && swarm.tasks.hasIncompleteTasks() && !anyUnreadWake) {
    const before = swarm.alerts.length;
    const alert = emitSwarmAlert(
      ctx,
      swarm,
      {
        kind: "stall",
        severity: "warning",
        message: "Swarm stalled: all non-monitor members are waiting/stopped while incomplete tasks remain and no unread @mentions are pending.",
      },
      now,
    );
    if (swarm.alerts.length > before) {
      emitted.push(alert);
      mutated = true;
    }
  }

  if (mutated) onPersist(swarm, now);
  return emitted;
}

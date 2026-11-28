/**
 * Session & agent lifecycle bindings (`session/event`, `session/delta`,
 * `agent/settled`), crash-revive session re-binding, and `<swarm-doorbell>`
 * delivery (`@qianji/swarm`).
 */
import { resolve } from "node:path";
import type { Context } from "@deepseek-ai/cordis";
import type { SwarmModelSettings } from "@qianji/protocol";
import type { Session } from "@qianji/session";
import { applyRoleModelToSessionAndInfo, resolveCoordinatorRoleModel } from "./model-config.ts";
import { extractBoldHeadingStep, formatToolCallStep, truncateStepText } from "./outcomes.ts";
import { buildDoorbellPrompt } from "./prompts.ts";
import {
  emitSwarmAlert,
  estimateMemberSessionCost,
  resolveMemberAlerts,
  type ManagedMember,
  type ManagedSwarm,
} from "./state.ts";
import {
  bindSwarmWorkerSession,
  createSwarmWorkerSession,
  SWARM_TOOL_GROUP,
  SWARM_TOOL_NAMES,
} from "./worker-session.ts";
import { inspectMemberWorktree } from "./worktrees.ts";

export function normalizeSwarmCwd(cwd: string): string {
  const trimmed = cwd.trim();
  if (trimmed === "") return "";
  return resolve(trimmed).replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
}

export interface LifecycleBridgeDeps {
  ctx: Context;
  swarms: Map<string, ManagedSwarm>;
  sessionToSwarm: Map<string, { swarmId: string; memberName: string }>;
  getGlobalConfig: () => SwarmModelSettings;
  persistAndNotify: (swarm: ManagedSwarm, now?: number) => void;
}

export function tryAdoptCoordinatorSession(
  deps: LifecycleBridgeDeps,
  session: Session,
  targetSwarmId?: string,
): ManagedSwarm | undefined {
  if (session.id === "" || deps.sessionToSwarm.has(session.id)) return undefined;
  if (session.header.parent !== undefined || session.header.side === true) return undefined;
  const sessionCwd = normalizeSwarmCwd(session.header.cwd);
  if (sessionCwd === "") return undefined;

  let candidate: ManagedSwarm | undefined;
  for (const swarm of deps.swarms.values()) {
    if (swarm.run.status !== "running" && swarm.run.status !== "paused") continue;
    if (swarm.run.coordinatorSessionId !== "") continue;
    if (targetSwarmId !== undefined && swarm.run.id !== targetSwarmId) continue;
    if (normalizeSwarmCwd(swarm.run.cwd) !== sessionCwd) continue;
    if (candidate === undefined || swarm.run.updatedAt >= candidate.run.updatedAt) {
      candidate = swarm;
    }
  }
  if (candidate === undefined) return undefined;

  const now = Date.now();
  candidate.run.coordinatorSessionId = session.id;
  deps.sessionToSwarm.set(session.id, { swarmId: candidate.run.id, memberName: "coordinator" });
  const coordMember = candidate.members.get("coordinator");
  if (coordMember !== undefined) {
    coordMember.info.sessionId = session.id;
    const coordRoleCfg = resolveCoordinatorRoleModel(candidate.run.roleModels, deps.getGlobalConfig());
    const appliedRoleCfg = coordRoleCfg !== undefined
      && applyRoleModelToSessionAndInfo(deps.ctx, session, coordMember.info, coordRoleCfg);
    if (!appliedRoleCfg) {
      const curState = session.state();
      if (curState.model !== undefined) {
        coordMember.info.provider = curState.model.provider;
        coordMember.info.model = curState.model.model;
      }
      if (curState.effort !== undefined) {
        coordMember.info.effort = curState.effort;
      }
    }
    const summary = session.summary();
    const u = summary.usage;
    coordMember.info.usage = {
      inputTokens: u.inputTokens,
      outputTokens: u.outputTokens,
      cacheReadTokens: u.cacheReadTokens,
      cacheWriteTokens: u.cacheWriteTokens,
      totalTokens: u.inputTokens + u.outputTokens + u.cacheReadTokens + u.cacheWriteTokens,
    };
    coordMember.info.estimatedCostUsd = estimateMemberSessionCost(deps.ctx, summary);
    coordMember.info.state = deps.ctx.agents.status(session.id).running ? "working" : "waiting";
    coordMember.info.lastActivityAt = now;
    deps.ctx.emit("swarm/memberDelta", { swarmId: candidate.run.id, member: { ...coordMember.info } });
  }
  deps.ctx.tools.activate(session.id, [SWARM_TOOL_GROUP, ...SWARM_TOOL_NAMES]);
  deps.persistAndNotify(candidate, now);
  return candidate;
}

export async function resolveCoordinatorDefaultModel(
  ctx: Context,
  coordinatorSessionId: string,
): Promise<{ provider: string; model: string }> {
  if (coordinatorSessionId !== "") {
    const coord = await ctx.sessions.get(coordinatorSessionId);
    const coordModel = coord?.state().model;
    if (coordModel !== undefined) return coordModel;
  }
  const llm = ctx.get("llm");
  const providers = llm?.listProviders() ?? [];
  for (const p of providers) {
    const models = llm !== undefined ? await llm.listModels(p.id).catch(() => []) : [];
    if (models[0] !== undefined) return { provider: p.id, model: models[0].id };
  }
  return { provider: providers[0]?.id ?? "default", model: "default" };
}

export async function ensureManagedWorkerBound(
  deps: LifecycleBridgeDeps,
  swarm: ManagedSwarm,
  member: ManagedMember,
): Promise<Session> {
  if (member.bound !== undefined) return member.bound.session;
  const existing = member.info.sessionId !== "" ? await deps.ctx.sessions.get(member.info.sessionId) : undefined;
  if (existing === undefined) {
    const fallback = await resolveCoordinatorDefaultModel(deps.ctx, swarm.run.coordinatorSessionId);
    const bound = createSwarmWorkerSession({
      ctx: deps.ctx,
      coordinatorSessionId: swarm.run.coordinatorSessionId,
      sessionCwd: member.workspace.sessionCwd,
      provider: member.info.provider ?? fallback.provider,
      model: member.info.model || fallback.model,
      effort: member.info.effort,
      memberName: member.info.name,
      role: member.info.role,
    });
    deps.sessionToSwarm.delete(member.info.sessionId);
    member.info.sessionId = bound.session.id;
    deps.sessionToSwarm.set(bound.session.id, { swarmId: swarm.run.id, memberName: member.info.name });
    member.bound = bound;
    return bound.session;
  }
  member.bound = bindSwarmWorkerSession(deps.ctx, existing, member.info.role, member.workspace.sessionCwd);
  return existing;
}

export async function deliverMemberDoorbell(
  deps: LifecycleBridgeDeps,
  swarm: ManagedSwarm,
  member: ManagedMember,
  nudgeNote?: string,
): Promise<boolean> {
  if (member.info.killed) return false;
  const unread = swarm.board.messagesSince(member.info.lastReadSeq);
  member.info.lastReadSeq = swarm.board.headSeq;
  delete member.info.parkedSinceSeq;
  delete member.info.completedAt;
  member.info.state = "working";
  member.info.lastActivityAt = Date.now();
  resolveMemberAlerts(swarm, member.info.name, "stall");

  const promptText = buildDoorbellPrompt(swarm.run, member.info, unread, nudgeNote);
  const session = member.info.role === "coordinator"
    ? (member.info.sessionId !== "" ? await deps.ctx.sessions.get(member.info.sessionId) : undefined)
    : await ensureManagedWorkerBound(deps, swarm, member);
  if (session === undefined) return false;

  const content = [{ type: "text" as const, text: promptText, meta: true }];
  if (deps.ctx.agents.status(session.id).running) {
    deps.ctx.agents.followUp(session, content);
  } else {
    deps.ctx.agents.prompt(session, content);
  }
  deps.ctx.emit("swarm/memberDelta", { swarmId: swarm.run.id, member: { ...member.info } });
  return true;
}

export function attachSwarmLifecycleListeners(deps: LifecycleBridgeDeps): () => void {
  const { ctx, swarms, sessionToSwarm, persistAndNotify } = deps;
  const thinkingBuffers = new Map<string, string>();

  const offEvent = ctx.on("session/event", (session, event) => {
    let ref = sessionToSwarm.get(session.id);
    if (ref === undefined && tryAdoptCoordinatorSession(deps, session) !== undefined) {
      ref = sessionToSwarm.get(session.id);
    }
    if (ref === undefined) return;
    const swarm = swarms.get(ref.swarmId);
    const member = swarm?.members.get(ref.memberName);
    if (swarm === undefined || member === undefined || member.info.killed) return;
    const now = Date.now();
    member.info.lastActivityAt = now;
    if (member.info.state === "stalled") {
      member.info.state = "working";
      resolveMemberAlerts(swarm, member.info.name, "stall");
    }
    if (event.type === "tool-call") {
      member.info.currentTool = event.data.name;
      member.info.currentStep = formatToolCallStep(
        event.data.name,
        event.data.args,
        member.workspace.sessionCwd || swarm.run.cwd,
      );
      ctx.emit("swarm/memberDelta", { swarmId: swarm.run.id, member: { ...member.info } });
    } else if (event.type === "tool-result") {
      delete member.info.currentTool;
      ctx.emit("swarm/memberDelta", { swarmId: swarm.run.id, member: { ...member.info } });
    } else if (event.type === "model") {
      member.info.provider = event.data.provider;
      member.info.model = event.data.model;
      ctx.emit("swarm/memberDelta", { swarmId: swarm.run.id, member: { ...member.info } });
    } else if (event.type === "effort") {
      member.info.effort = event.data.effort;
      ctx.emit("swarm/memberDelta", { swarmId: swarm.run.id, member: { ...member.info } });
    } else if (event.type === "assistant") {
      if (member.info.currentTool === undefined) {
        for (const block of event.data.content) {
          if (block.type === "thinking") {
            const heading = extractBoldHeadingStep(block.text);
            if (heading !== undefined) {
              member.info.currentStep = heading;
              break;
            }
          }
        }
      }
      const summary = session.summary();
      const u = summary.usage;
      member.info.usage = {
        inputTokens: u.inputTokens,
        outputTokens: u.outputTokens,
        cacheReadTokens: u.cacheReadTokens,
        cacheWriteTokens: u.cacheWriteTokens,
        totalTokens: u.inputTokens + u.outputTokens + u.cacheReadTokens + u.cacheWriteTokens,
      };
      member.info.estimatedCostUsd = estimateMemberSessionCost(ctx, summary);
      ctx.emit("swarm/memberDelta", { swarmId: swarm.run.id, member: { ...member.info } });
      persistAndNotify(swarm, now);
    }
  });

  const offDelta = ctx.on("session/delta", (session, _seq, delta) => {
    let ref = sessionToSwarm.get(session.id);
    if (ref === undefined && tryAdoptCoordinatorSession(deps, session) !== undefined) {
      ref = sessionToSwarm.get(session.id);
    }
    if (ref === undefined) return;
    const swarm = swarms.get(ref.swarmId);
    const member = swarm?.members.get(ref.memberName);
    if (swarm === undefined || member === undefined || member.info.killed) return;
    member.info.lastActivityAt = Date.now();
    if (delta.type === "agent-start") {
      thinkingBuffers.delete(session.id);
      if (member.info.state !== "working") {
        member.info.state = "working";
        delete member.info.parkedSinceSeq;
        ctx.emit("swarm/memberDelta", { swarmId: swarm.run.id, member: { ...member.info } });
      }
    } else if (delta.type === "turn-start") {
      thinkingBuffers.delete(session.id);
    } else if (delta.type === "llm-chunk" && typeof delta.chunk === "object" && delta.chunk !== null) {
      const chunk = delta.chunk as { type?: unknown; text?: unknown };
      if (chunk.type === "thinking-delta" && typeof chunk.text === "string") {
        const prevBuf = thinkingBuffers.get(session.id) ?? "";
        if (prevBuf.length < 2048) {
          const nextBuf = (prevBuf + chunk.text).slice(0, 2048);
          thinkingBuffers.set(session.id, nextBuf);
          const heading = extractBoldHeadingStep(nextBuf);
          if (heading !== undefined && member.info.currentTool === undefined && member.info.currentStep !== heading) {
            member.info.currentStep = heading;
            ctx.emit("swarm/memberDelta", { swarmId: swarm.run.id, member: { ...member.info } });
          }
        }
      }
    } else if (delta.type === "tool-start" && typeof delta.name === "string") {
      member.info.currentTool = delta.name;
      if (member.info.currentStep === undefined || !member.info.currentStep.startsWith(delta.name)) {
        member.info.currentStep = truncateStepText(delta.name);
      }
      ctx.emit("swarm/memberDelta", { swarmId: swarm.run.id, member: { ...member.info } });
    } else if (
      delta.type === "tool-progress"
      && typeof delta.name === "string"
      && typeof delta.text === "string"
      && delta.text.trim() !== ""
    ) {
      member.info.currentStep = truncateStepText(`${delta.name}: ${delta.text}`);
      ctx.emit("swarm/memberDelta", { swarmId: swarm.run.id, member: { ...member.info } });
    } else if (delta.type === "tool-end") {
      delete member.info.currentTool;
      ctx.emit("swarm/memberDelta", { swarmId: swarm.run.id, member: { ...member.info } });
    }
  });

  const offSettled = ctx.on("agent/settled", async (session, outcome) => {
    thinkingBuffers.delete(session.id);
    const ref = sessionToSwarm.get(session.id);
    if (ref === undefined) return;
    const swarm = swarms.get(ref.swarmId);
    const member = swarm?.members.get(ref.memberName);
    if (swarm === undefined || member === undefined || member.info.killed) return;

    delete member.info.currentTool;
    delete member.info.currentStep;
    member.info.lastActivityAt = Date.now();

    if (member.workspace.workspaceMode !== "inherit" && member.workspace.prepared !== undefined) {
      const inspected = await inspectMemberWorktree({
        swarmId: swarm.run.id,
        memberName: member.info.name,
        sessionId: member.info.sessionId,
        handle: member.workspace,
      });
      member.info.changedFileCount = inspected.diff.changedFiles.length;
    }

    if (outcome === "error") {
      const lastAssistant = session.events.findLast((ev) => ev.type === "assistant");
      const errMsg = lastAssistant?.type === "assistant" ? lastAssistant.data.error?.message : undefined;
      member.info.error = errMsg ?? "Worker turn ended with an error.";
      emitSwarmAlert(ctx, swarm, {
        kind: "member-error",
        severity: "danger",
        memberName: member.info.name,
        message: `@${member.info.name}: ${member.info.error}`,
      });
    }

    if (swarm.run.status === "stopped") {
      member.info.state = "stopped";
      persistAndNotify(swarm);
      return;
    }

    if (
      member.info.role !== "coordinator"
      && outcome === "done"
      && swarm.run.status === "running"
      && swarm.board.hasUnreadWakeFor(member.info, member.info.lastReadSeq)
    ) {
      await deliverMemberDoorbell(deps, swarm, member);
      return;
    }

    member.info.state = "waiting";
    member.info.parkedSinceSeq = member.info.lastReadSeq;
    ctx.emit("swarm/memberDelta", { swarmId: swarm.run.id, member: { ...member.info } });
    persistAndNotify(swarm);
  });

  return () => {
    offEvent();
    offDelta();
    offSettled();
  };
}

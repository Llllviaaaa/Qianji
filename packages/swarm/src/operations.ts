/**
 * Member spawning (`addMember`), member lifecycle controls (`nudge`, `switchModel`,
 * `abort`, `mergeWorktree`, `kill`, `revive`), and swarm run controls (`pause`,
 * `resume`, `stop`, `complete`, `setTitle`, `dismissAlert`) (`@qianji/swarm`).
 */
import type {
  SwarmChannelInfo,
  SwarmMemberControlParams,
  SwarmMemberControlResult,
  SwarmMemberInfo,
  SwarmMemberRole,
  SwarmRunControlParams,
  SwarmRunControlResult,
} from "@qianji/protocol";
import type { Session } from "@qianji/session";
import {
  deriveGroupPrefix,
  normalizeChannelName,
  SWARM_MAIN_CHANNEL,
  validateWorkerName,
} from "./board.ts";
import type { SwarmAddMemberInput, SwarmChannelManageInput, SwarmServiceOptions } from "./index.ts";
import {
  deliverMemberDoorbell,
  ensureManagedWorkerBound,
  resolveCoordinatorDefaultModel,
  type LifecycleBridgeDeps,
} from "./lifecycle.ts";
import { resolveWorkerRoleModel } from "./model-config.ts";
import { buildWorkerInitialPrompt } from "./prompts.ts";
import {
  emitSwarmAlert,
  emptyUsage,
  parseModelSpec,
  resolveMemberAlerts,
  type ManagedSwarm,
} from "./state.ts";
import { createSwarmWorkerSession } from "./worker-session.ts";
import {
  cleanupMemberWorkspace,
  inspectMemberWorktree,
  mergeMemberWorktree,
  prepareMemberWorkspace,
} from "./worktrees.ts";

export async function executeAddSwarmMembers(
  bridge: LifecycleBridgeDeps,
  options: SwarmServiceOptions,
  swarm: ManagedSwarm,
  input: SwarmAddMemberInput,
): Promise<SwarmMemberInfo[]> {
  const baseName = validateWorkerName(input.name);
  const role: SwarmMemberRole = input.role ?? "worker";
  const addedBy = input.addedBy?.trim().toLowerCase() || "coordinator";
  const defaultModel = await resolveCoordinatorDefaultModel(bridge.ctx, swarm.run.coordinatorSessionId);
  const chosenModel = resolveWorkerRoleModel({
    role,
    explicitModel: input.model,
    explicitProvider: input.provider,
    explicitEffort: input.effort,
    runRoleModels: swarm.run.roleModels,
    globalConfig: bridge.getGlobalConfig(),
    coordinatorFallback: defaultModel,
  });

  const shardSpecs: Array<{ name: string; brief: string }> =
    input.tasks !== undefined && input.tasks.length > 0
      ? input.tasks.map((slice, i) => ({
          name: validateWorkerName(`${baseName}-${i + 1}`),
          brief: `${input.brief.trim()}\n\nAssigned slice (${i + 1}/${input.tasks?.length ?? 1}):\n${slice}`,
        }))
      : input.n !== undefined && input.n > 1
        ? Array.from({ length: Math.min(8, Math.floor(input.n)) }, (_, i) => ({
            name: validateWorkerName(`${baseName}-${i + 1}`),
            brief: input.brief.trim(),
          }))
        : [{ name: baseName, brief: input.brief.trim() }];

  for (const spec of shardSpecs) {
    const existing = swarm.members.get(spec.name);
    if (existing !== undefined && !existing.info.killed) {
      throw new Error(`Swarm member "@${spec.name}" already exists and is active.`);
    }
  }

  let forkSource: Session | undefined;
  if (input.forkFrom !== undefined && input.forkFrom.trim() !== "") {
    const forkMember = swarm.members.get(input.forkFrom.trim().toLowerCase());
    if (forkMember !== undefined && forkMember.info.sessionId !== "") {
      forkSource = await bridge.ctx.sessions.get(forkMember.info.sessionId);
    }
  }

  const createdInfos: SwarmMemberInfo[] = [];
  for (const spec of shardSpecs) {
    const workspace = await prepareMemberWorkspace({
      cwd: swarm.run.cwd,
      swarmId: swarm.run.id,
      memberName: spec.name,
      role,
      requestedMode: input.workspaceMode,
      dataDir: options.dataDir,
      branchPrefix: options.branchPrefix,
      signal: input.signal,
    });

    const bound = createSwarmWorkerSession({
      ctx: bridge.ctx,
      coordinatorSessionId: swarm.run.coordinatorSessionId,
      forkSource,
      sessionCwd: workspace.sessionCwd,
      provider: chosenModel.provider,
      model: chosenModel.model,
      effort: chosenModel.effort,
      memberName: spec.name,
      role,
    });

    const channels = [SWARM_MAIN_CHANNEL];
    for (const rawCh of input.channels ?? []) {
      const ch = normalizeChannelName(rawCh);
      if (!channels.includes(ch)) channels.push(ch);
    }
    for (const ch of channels) swarm.board.subscribeMember(ch, spec.name, addedBy);

    const now = Date.now();
    const briefMsg = swarm.board.append({
      sender: addedBy,
      text: `@${spec.name} ${spec.brief}`,
      channel: SWARM_MAIN_CHANNEL,
      now,
    });
    const groupPrefix = deriveGroupPrefix(spec.name);
    const info: SwarmMemberInfo = {
      name: spec.name,
      ...(groupPrefix === undefined ? {} : { groupPrefix }),
      role,
      brief: spec.brief,
      addedBy,
      sessionId: bound.session.id,
      provider: chosenModel.provider,
      model: chosenModel.model,
      ...(chosenModel.effort === undefined ? {} : { effort: chosenModel.effort }),
      state: swarm.run.status === "running" ? "working" : "waiting",
      killed: false,
      workspaceMode: workspace.workspaceMode,
      ...(workspace.prepared === undefined ? {} : { worktreePath: workspace.prepared.wtRoot }),
      ...(workspace.branchName === undefined ? {} : { branchName: workspace.branchName }),
      changedFileCount: 0,
      channels,
      lastReadSeq: briefMsg.seq,
      ...(swarm.run.status === "running" ? {} : { parkedSinceSeq: 0 }),
      lastActivityAt: now,
      usage: emptyUsage(),
      estimatedCostUsd: 0,
    };

    swarm.members.set(spec.name, { info, workspace, bound, inTurnWaiters: 0 });
    bridge.sessionToSwarm.set(bound.session.id, { swarmId: swarm.run.id, memberName: spec.name });
    bridge.ctx.emit("swarm/board", {
      swarmId: swarm.run.id,
      message: briefMsg,
      headSeq: swarm.board.headSeq,
      wokenMembers: swarm.run.status === "running" ? [spec.name] : [],
    });

    if (swarm.run.status === "running") {
      bridge.ctx.agents.prompt(bound.session, [
        { type: "text", text: buildWorkerInitialPrompt(swarm.run, info, briefMsg.seq) },
      ]);
    }
    createdInfos.push({ ...info, channels: [...info.channels], usage: { ...info.usage } });
  }

  bridge.persistAndNotify(swarm);
  return createdInfos;
}

export async function executeControlSwarmMember(
  bridge: LifecycleBridgeDeps,
  swarm: ManagedSwarm,
  params: SwarmMemberControlParams,
): Promise<SwarmMemberControlResult> {
  const member = swarm.members.get(params.name.trim().toLowerCase());
  if (member === undefined) return { ok: false, message: `Swarm member "@${params.name}" not found.` };

  switch (params.action) {
    case "abort": {
      swarm.board.cancelWaitersForMember(member.info.name);
      if (member.info.sessionId !== "") await bridge.ctx.agents.abort(member.info.sessionId);
      member.info.state = "waiting";
      member.info.parkedSinceSeq = member.info.lastReadSeq;
      delete member.info.currentTool;
      delete member.info.currentStep;
      bridge.persistAndNotify(swarm);
      return { ok: true, member: { ...member.info }, message: `Aborted @${member.info.name}'s current turn.` };
    }
    case "nudge":
    case "revive": {
      if (member.info.killed) return { ok: false, message: `Cannot wake killed member @${member.info.name}.` };
      if (params.interrupt === true && member.info.sessionId !== "") {
        await bridge.ctx.agents.abort(member.info.sessionId);
      }
      await deliverMemberDoorbell(bridge, swarm, member, params.message);
      bridge.persistAndNotify(swarm);
      return { ok: true, member: { ...member.info }, message: `Woke @${member.info.name}.` };
    }
    case "switchModel": {
      const next = parseModelSpec(params.model, params.provider, {
        provider: member.info.provider ?? "default",
        model: member.info.model,
      });
      const hadError = member.info.error !== undefined;
      const session = member.info.role === "coordinator"
        ? (member.info.sessionId !== "" ? await bridge.ctx.sessions.get(member.info.sessionId) : undefined)
        : await ensureManagedWorkerBound(bridge, swarm, member);
      session?.setModel(next);
      member.info.provider = next.provider;
      member.info.model = next.model;
      delete member.info.error;
      resolveMemberAlerts(swarm, member.info.name, "member-error");
      if (
        member.info.role !== "coordinator"
        && swarm.run.status === "running"
        && (hadError || (params.message ?? "").trim() !== "")
      ) {
        await deliverMemberDoorbell(
          bridge,
          swarm,
          member,
          params.message ?? `Switched model to ${next.provider}/${next.model}; resume unfinished work.`,
        );
      }
      bridge.persistAndNotify(swarm);
      return { ok: true, member: { ...member.info }, message: `Switched @${member.info.name} to ${next.provider}/${next.model}.` };
    }
    case "mergeWorktree": {
      const mergeResult = await mergeMemberWorktree({
        memberName: member.info.name,
        sessionId: member.info.sessionId,
        handle: member.workspace,
        applyChanges: params.applyChanges !== false,
      });
      if (mergeResult.conflict) {
        emitSwarmAlert(bridge.ctx, swarm, {
          kind: "worktree-conflict",
          severity: "warning",
          memberName: member.info.name,
          message: `Worktree merge conflict for @${member.info.name}: ${mergeResult.reason ?? "patch conflict"}`,
        });
      } else if (mergeResult.applied) {
        member.info.changedFileCount = 0;
      }
      bridge.persistAndNotify(swarm);
      return { ok: !mergeResult.conflict, member: { ...member.info }, mergeResult };
    }
    case "kill": {
      if (member.info.role === "coordinator") {
        return { ok: false, message: "The @coordinator member cannot be killed." };
      }
      if (member.workspace.workspaceMode !== "inherit" && member.workspace.prepared !== undefined) {
        const inspected = await inspectMemberWorktree({
          swarmId: swarm.run.id,
          memberName: member.info.name,
          sessionId: member.info.sessionId,
          handle: member.workspace,
        });
        member.info.changedFileCount = inspected.diff.changedFiles.length;
        if (!inspected.diff.empty && params.forceKillUnmerged !== true) {
          return {
            ok: false,
            member: { ...member.info },
            message: `Refusing to kill @${member.info.name}: isolated ${member.workspace.workspaceMode} worktree has ${inspected.diff.changedFiles.length} unmerged file(s) (${inspected.diff.changedFiles.join(", ")}). Merge first via mergeWorktree / swarm(action:"merge") or pass forceKillUnmerged: true.`,
          };
        }
      }
      member.info.killed = true;
      member.info.state = "killed";
      delete member.info.currentTool;
      delete member.info.currentStep;
      delete member.info.waitingOn;
      delete member.info.parkedSinceSeq;
      swarm.board.cancelWaitersForMember(member.info.name);
      if (member.info.sessionId !== "") await bridge.ctx.agents.abort(member.info.sessionId);
      member.bound?.dispose();
      member.bound = undefined;
      await cleanupMemberWorkspace(member.workspace);
      delete member.info.worktreePath;
      bridge.persistAndNotify(swarm);
      return { ok: true, member: { ...member.info }, message: `Killed @${member.info.name}.` };
    }
  }
}

export async function executeControlSwarmRun(
  bridge: LifecycleBridgeDeps,
  swarm: ManagedSwarm,
  params: SwarmRunControlParams,
  getSnapshot: () => { run: SwarmRunControlResult["run"]; alerts: SwarmRunControlResult["alerts"] },
): Promise<SwarmRunControlResult> {
  if (params.action === "pause") {
    swarm.run.status = "paused";
    for (const m of swarm.members.values()) {
      if (m.info.role !== "coordinator" && !m.info.killed && m.info.sessionId !== "") {
        await bridge.ctx.agents.abort(m.info.sessionId);
        m.info.state = "waiting";
        delete m.info.currentTool;
        delete m.info.currentStep;
      }
    }
  } else if (params.action === "resume") {
    swarm.run.status = "running";
    for (const alert of swarm.alerts) if (alert.kind === "stall") alert.resolved = true;
    for (const m of swarm.members.values()) {
      if (m.info.role !== "coordinator" && !m.info.killed && swarm.board.hasUnreadWakeFor(m.info, m.info.lastReadSeq)) {
        await deliverMemberDoorbell(bridge, swarm, m);
      }
    }
  } else if (params.action === "complete") {
    swarm.run.status = "completed";
    swarm.board.cancelAllWaiters();
  } else if (params.action === "stop") {
    swarm.run.status = "stopped";
    swarm.board.cancelAllWaiters();
    for (const m of swarm.members.values()) {
      if (m.info.role !== "coordinator" && !m.info.killed) {
        if (m.info.sessionId !== "") await bridge.ctx.agents.abort(m.info.sessionId);
        m.info.state = "stopped";
        delete m.info.currentTool;
        delete m.info.currentStep;
        m.bound?.dispose();
        m.bound = undefined;
      }
    }
  } else if (params.action === "setTitle" && params.title !== undefined && params.title.trim() !== "") {
    swarm.run.title = params.title.trim();
  } else if (params.action === "dismissAlert") {
    for (const alert of swarm.alerts) {
      if (params.alertId === undefined || alert.id === params.alertId) alert.resolved = true;
    }
  }
  bridge.persistAndNotify(swarm);
  return getSnapshot();
}

export function executeManageSwarmChannel(
  bridge: LifecycleBridgeDeps,
  swarm: ManagedSwarm,
  input: SwarmChannelManageInput,
): SwarmChannelInfo[] {
  const actor = (input.actor ?? "coordinator").trim().toLowerCase();
  if (input.action === "list") return swarm.board.listChannels();
  const channelName = normalizeChannelName(input.channel);
  const member = swarm.members.get(actor);
  if (input.action === "create" || input.action === "join") {
    if (input.action === "create") swarm.board.ensureChannel(channelName, actor, input.topic ?? "");
    swarm.board.subscribeMember(channelName, actor, actor);
    if (member !== undefined && !member.info.channels.includes(channelName)) member.info.channels.push(channelName);
  } else if (input.action === "leave") {
    swarm.board.unsubscribeMember(channelName, actor);
    if (member !== undefined && channelName !== SWARM_MAIN_CHANNEL) {
      member.info.channels = member.info.channels.filter((c) => c !== channelName);
    }
  } else if (input.action === "archive") {
    swarm.board.archiveChannel(channelName);
  }
  bridge.persistAndNotify(swarm);
  return swarm.board.listChannels();
}

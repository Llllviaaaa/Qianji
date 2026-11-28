/**
 * Core `SwarmService` (`provide: "swarm"`): public RPC & tool orchestration methods
 * across `SwarmBoardEngine`, `SwarmTaskEngine`, Git worktrees, and Stall Watchdog.
 */
import { Context, Service } from "@deepseek-ai/cordis";
import type {
  SwarmAlertInfo, SwarmBoardPostParams, SwarmBoardPostResult, SwarmBoardReadParams, SwarmBoardReadResult,
  SwarmChannelInfo, SwarmConfigGetParams, SwarmConfigGetResult, SwarmConfigUpdateParams, SwarmConfigUpdateResult,
  SwarmCreateParams, SwarmListParams, SwarmListResult, SwarmMemberControlParams, SwarmMemberControlResult,
  SwarmMemberInfo, SwarmModelSettings, SwarmPlanOverview, SwarmRunControlParams, SwarmRunControlResult, SwarmRunInfo,
  SwarmSnapshotResult, SwarmSummaryInfo, SwarmTasksMutateParams, SwarmTasksMutateResult, SwarmWorktreeDiffResult,
} from "@qianji/protocol";
import { doesMessageWakeMember, SWARM_MAIN_CHANNEL, SwarmBoardEngine } from "./board.ts";
import { registerSwarmCapabilities } from "./command.ts";
import type { SwarmAddMemberInput, SwarmChannelManageInput, SwarmServiceOptions, SwarmWaitInput, SwarmWaitResult } from "./index.ts";
import {
  attachSwarmLifecycleListeners, deliverMemberDoorbell, normalizeSwarmCwd,
  resolveCoordinatorDefaultModel, tryAdoptCoordinatorSession, type LifecycleBridgeDeps,
} from "./lifecycle.ts";
import {
  applyRoleModelToSessionAndInfo, cloneRoleModelsMap, executeGetSwarmConfig, executeUpdateSwarmConfig,
  loadSwarmGlobalConfig, resolveCoordinatorRoleModel, sanitizeRoleModelsMap,
} from "./model-config.ts";
import { executeAddSwarmMembers, executeControlSwarmMember, executeControlSwarmRun, executeManageSwarmChannel } from "./operations.ts";
import {
  applyBoardMessageMemberState, applySwarmPlanUpdate, clonePlanOverview,
  synthesizeSwarmPlan, type SwarmPlanUpdateInput,
} from "./outcomes.ts";
import { loadPersistedSwarms, savePersistedSwarm } from "./persistence.ts";
import {
  buildSwarmSnapshot, buildSwarmSummary, emptyUsage, recomputeSwarmTotals,
  runSwarmWatchdogOnSwarm, shortId, type ManagedMember, type ManagedSwarm,
} from "./state.ts";
import { SwarmTaskEngine } from "./tasks.ts";
import { SWARM_TOOL_GROUP, SWARM_TOOL_NAMES } from "./worker-session.ts";
import { inspectMemberWorktree, type MemberWorkspaceHandle } from "./worktrees.ts";

const DEFAULT_STALL_TIMEOUT_MS = 180_000;
const DEFAULT_WATCHDOG_INTERVAL_MS = 15_000;

export class SwarmService extends Service {
  static provide = "swarm";
  static inject = ["llm", "sessions", "agents", "tools", "commands", "systemPrompt"];

  readonly options: SwarmServiceOptions;
  private globalConfig: SwarmModelSettings = { roleModels: {} };
  private readonly swarms = new Map<string, ManagedSwarm>();
  private readonly sessionToSwarm = new Map<string, { swarmId: string; memberName: string }>();
  private readonly bridge: LifecycleBridgeDeps;

  constructor(ctx: Context, options: SwarmServiceOptions = {}) {
    super(ctx, "swarm");
    this.options = options;
    this.bridge = {
      ctx,
      swarms: this.swarms,
      sessionToSwarm: this.sessionToSwarm,
      getGlobalConfig: () => this.globalConfig,
      persistAndNotify: (swarm, now) => {
        this.persistAndNotify(swarm, now);
      },
    };
    this.hydrateFromDisk();

    ctx.effect(() => registerSwarmCapabilities(ctx, this), "swarm: tools & commands");
    ctx.effect(() => attachSwarmLifecycleListeners(this.bridge), "swarm: session & agent listeners");
    ctx.effect(() => {
      const intervalMs = Math.max(25, options.watchdogIntervalMs ?? DEFAULT_WATCHDOG_INTERVAL_MS);
      const timer = setInterval(() => {
        this.runWatchdogTick();
      }, intervalMs);
      timer.unref?.();
      return () => {
        clearInterval(timer);
        for (const swarm of this.swarms.values()) {
          swarm.board.cancelAllWaiters();
          for (const m of swarm.members.values()) m.bound?.dispose();
        }
      };
    }, "swarm: stall watchdog");
  }

  private hydrateFromDisk(): void {
    this.globalConfig = loadSwarmGlobalConfig(this.options.dataDir);
    for (const persisted of loadPersistedSwarms(this.options.dataDir)) {
      const board = new SwarmBoardEngine(persisted.run.id, persisted.run.createdAt, {
        messages: persisted.messages,
        channels: persisted.run.channels,
        headSeq: persisted.run.headSeq,
      });
      const tasks = new SwarmTaskEngine(persisted.run.id, persisted.tasks);
      const members = new Map<string, ManagedMember>();
      for (const rec of persisted.members) {
        const workspace: MemberWorkspaceHandle = {
          workspaceMode: rec.info.workspaceMode,
          sessionCwd: rec.prepared?.sessionCwd ?? persisted.run.cwd,
          ...(rec.prepared === undefined ? {} : { prepared: rec.prepared }),
          ...(rec.info.branchName === undefined ? {} : { branchName: rec.info.branchName }),
        };
        members.set(rec.info.name, { info: rec.info, workspace, inTurnWaiters: 0 });
        if (rec.info.sessionId !== "") {
          this.sessionToSwarm.set(rec.info.sessionId, { swarmId: persisted.run.id, memberName: rec.info.name });
        }
      }
      this.swarms.set(persisted.run.id, { run: persisted.run, board, tasks, members, alerts: persisted.alerts });
    }
  }

  private persistAndNotify(swarm: ManagedSwarm, now = Date.now()): SwarmSnapshotResult {
    swarm.run.channels = swarm.board.listChannels();
    swarm.run.headSeq = swarm.board.headSeq;
    swarm.run.updatedAt = now;
    recomputeSwarmTotals(swarm);
    const roleModels = cloneRoleModelsMap(swarm.run.roleModels);
    const plan = clonePlanOverview(swarm.run.plan);
    savePersistedSwarm(this.options.dataDir, {
      version: 1,
      run: { ...swarm.run, ...(roleModels === undefined ? {} : { roleModels }), ...(plan === undefined ? {} : { plan }) },
      members: [...swarm.members.values()].map((m) => ({
        info: { ...m.info, channels: [...m.info.channels], usage: { ...m.info.usage } },
        ...(m.workspace.prepared === undefined ? {} : { prepared: { ...m.workspace.prepared } }),
      })),
      tasks: swarm.tasks.list(),
      messages: swarm.board.allMessages(),
      alerts: swarm.alerts.map((a) => ({ ...a })),
    });
    const snapshot = buildSwarmSnapshot(swarm);
    this.ctx.emit("swarm/updated", { swarmId: swarm.run.id, snapshot, summary: buildSwarmSummary(swarm) });
    return snapshot;
  }

  private requireSwarm(swarmId: string): ManagedSwarm {
    const swarm = this.swarms.get(swarmId);
    if (swarm === undefined) throw new Error(`Swarm "${swarmId}" not found.`);
    return swarm;
  }

  listSwarms(params: SwarmListParams = {}): SwarmListResult {
    const cwdKey = params.cwd !== undefined && params.cwd !== "" ? normalizeSwarmCwd(params.cwd) : "";
    const summaries: SwarmSummaryInfo[] = [];
    for (const swarm of this.swarms.values()) {
      if (params.includeStopped !== true && swarm.run.status === "stopped") continue;
      if (cwdKey !== "" && normalizeSwarmCwd(swarm.run.cwd) !== cwdKey) continue;
      if (params.sessionId !== undefined && params.sessionId !== "") {
        const inSwarm = swarm.run.coordinatorSessionId === params.sessionId
          || [...swarm.members.values()].some((m) => m.info.sessionId === params.sessionId);
        if (!inSwarm) continue;
      }
      summaries.push(buildSwarmSummary(swarm));
    }
    summaries.sort((a, b) => b.run.updatedAt - a.run.updatedAt);
    return { swarms: summaries };
  }

  getSnapshot(swarmId: string): SwarmSnapshotResult {
    return buildSwarmSnapshot(this.requireSwarm(swarmId));
  }

  adoptCoordinatorSessionById(sessionId: string, targetSwarmId?: string): SwarmSnapshotResult | undefined {
    if (sessionId === "") return undefined;
    const peeked = this.ctx.sessions.peek(sessionId);
    if (peeked === undefined) return undefined;
    const adopted = tryAdoptCoordinatorSession(this.bridge, peeked, targetSwarmId);
    return adopted === undefined ? undefined : buildSwarmSnapshot(adopted);
  }

  getActiveSwarmForSession(sessionId: string): SwarmSnapshotResult | undefined {
    const ref = this.sessionToSwarm.get(sessionId);
    if (ref !== undefined) {
      const swarm = this.swarms.get(ref.swarmId);
      if (swarm !== undefined && swarm.run.status !== "stopped") return buildSwarmSnapshot(swarm);
    }
    for (const swarm of this.swarms.values()) {
      if (swarm.run.status !== "stopped" && swarm.run.coordinatorSessionId === sessionId) {
        return buildSwarmSnapshot(swarm);
      }
    }
    return this.adoptCoordinatorSessionById(sessionId);
  }

  isActiveWorkerSession(sessionId: string): boolean {
    const ref = this.sessionToSwarm.get(sessionId);
    if (ref === undefined) return false;
    const swarm = this.swarms.get(ref.swarmId);
    const member = swarm?.members.get(ref.memberName);
    if (swarm === undefined || member === undefined) return false;
    if (swarm.run.status !== "running" && swarm.run.status !== "paused") return false;
    return member.info.role !== "coordinator" && !member.info.killed && member.info.state !== "stopped";
  }

  async createSwarm(params: SwarmCreateParams): Promise<SwarmSnapshotResult> {
    const goal = params.goal.trim();
    if (goal === "") throw new Error("Swarm goal must be non-empty.");
    const now = Date.now();
    const coordSessionId = params.coordinatorSessionId?.trim() ?? "";
    if (coordSessionId !== "") {
      const existing = this.getActiveSwarmForSession(coordSessionId);
      if (existing !== undefined && (existing.run.status === "running" || existing.run.status === "paused")) {
        const managed = this.requireSwarm(existing.run.id);
        managed.run.goal = goal;
        if (params.title !== undefined && params.title.trim() !== "") managed.run.title = params.title.trim();
        if (params.roleModels !== undefined) {
          const cleaned = cloneRoleModelsMap(sanitizeRoleModelsMap(params.roleModels));
          if (cleaned !== undefined) managed.run.roleModels = cleaned;
          else delete managed.run.roleModels;
        }
        const coordMember = managed.members.get("coordinator");
        const coordRoleCfg = resolveCoordinatorRoleModel(managed.run.roleModels, this.globalConfig);
        if (coordMember !== undefined && coordRoleCfg !== undefined) {
          const existingCoord = await this.ctx.sessions.get(coordSessionId);
          applyRoleModelToSessionAndInfo(this.ctx, existingCoord, coordMember.info, coordRoleCfg);
        }
        managed.run.status = "running";
        return this.persistAndNotify(managed, now);
      }
    }

    const coordSession = coordSessionId !== "" ? await this.ctx.sessions.get(coordSessionId) : undefined;
    const cwd = params.cwd?.trim() || coordSession?.header.cwd || process.cwd();
    const modelRef = await resolveCoordinatorDefaultModel(this.ctx, coordSessionId);
    const swarmId = shortId("swarm");
    const title = params.title?.trim() || (goal.length <= 42 ? goal : `${goal.slice(0, 42)}…`);
    const board = new SwarmBoardEngine(swarmId, now);
    const tasks = new SwarmTaskEngine(swarmId);
    const roleModels = cloneRoleModelsMap(sanitizeRoleModelsMap(params.roleModels));

    const run: SwarmRunInfo = {
      id: swarmId,
      title,
      goal,
      cwd,
      coordinatorSessionId: coordSessionId,
      status: "running",
      stallTimeoutMs: params.stallTimeoutMs ?? this.options.defaultStallTimeoutMs ?? DEFAULT_STALL_TIMEOUT_MS,
      ...(roleModels === undefined ? {} : { roleModels }),
      channels: board.listChannels(),
      totalUsage: emptyUsage(),
      totalCostUsd: 0,
      headSeq: 0,
      createdAt: now,
      updatedAt: now,
    };

    const coordEffort = coordSession?.state().effort;
    const coordInfo: SwarmMemberInfo = {
      name: "coordinator",
      role: "coordinator",
      brief: goal,
      addedBy: "user",
      sessionId: coordSessionId,
      provider: modelRef.provider,
      model: modelRef.model,
      ...(coordEffort === undefined ? {} : { effort: coordEffort }),
      state: coordSessionId !== "" && this.ctx.agents.status(coordSessionId).running ? "working" : "waiting",
      killed: false,
      workspaceMode: "inherit",
      changedFileCount: 0,
      channels: [SWARM_MAIN_CHANNEL],
      lastReadSeq: 0,
      lastActivityAt: now,
      usage: emptyUsage(),
      estimatedCostUsd: 0,
    };
    const coordRoleCfg = resolveCoordinatorRoleModel(run.roleModels, this.globalConfig);
    if (coordRoleCfg !== undefined) {
      applyRoleModelToSessionAndInfo(this.ctx, coordSession, coordInfo, coordRoleCfg);
    }

    const members = new Map<string, ManagedMember>();
    members.set("coordinator", { info: coordInfo, workspace: { workspaceMode: "inherit", sessionCwd: cwd }, inTurnWaiters: 0 });
    if (coordSessionId !== "") {
      this.sessionToSwarm.set(coordSessionId, { swarmId, memberName: "coordinator" });
      this.ctx.tools.activate(coordSessionId, [SWARM_TOOL_GROUP, ...SWARM_TOOL_NAMES]);
    }

    const swarm: ManagedSwarm = { run, board, tasks, members, alerts: [] };
    this.swarms.set(swarmId, swarm);
    return this.persistAndNotify(swarm, now);
  }

  addMember(input: SwarmAddMemberInput): Promise<SwarmMemberInfo[]> {
    return executeAddSwarmMembers(this.bridge, this.options, this.requireSwarm(input.swarmId), input);
  }

  readBoard(params: SwarmBoardReadParams): SwarmBoardReadResult {
    const swarm = this.requireSwarm(params.swarmId);
    const res = swarm.board.read({ channel: params.channel, since: params.since, seqs: params.seqs, limit: params.limit });
    if (params.readerName !== undefined) {
      const reader = swarm.members.get(params.readerName.trim().toLowerCase());
      if (reader !== undefined && res.messages.length > 0) {
        const highest = res.messages.at(-1)?.seq ?? reader.info.lastReadSeq;
        if (highest > reader.info.lastReadSeq) reader.info.lastReadSeq = highest;
      }
    }
    return res;
  }

  async postBoardMessage(params: SwarmBoardPostParams): Promise<SwarmBoardPostResult> {
    const swarm = this.requireSwarm(params.swarmId);
    const sender = (params.sender ?? "user").trim().toLowerCase() || "user";
    const now = Date.now();
    const senderMember = swarm.members.get(sender);
    const inTurnSnapshot = new Set<string>();
    for (const [mName, m] of swarm.members) if (m.inTurnWaiters > 0) inTurnSnapshot.add(mName);

    const message = swarm.board.append({ sender, text: params.text, channel: params.channel, replyToSeq: params.replyToSeq, now });
    if (senderMember !== undefined) {
      senderMember.info.lastPostSeq = message.seq;
      if (message.seq > senderMember.info.lastReadSeq) senderMember.info.lastReadSeq = message.seq;
      senderMember.info.lastActivityAt = now;
    }
    const mutatedNames = new Set(applyBoardMessageMemberState(swarm.members, message));

    const wokenMembers: string[] = [];
    if (swarm.run.status === "running") {
      for (const member of swarm.members.values()) {
        if (member.info.killed || member.info.name === sender) continue;
        if (!doesMessageWakeMember(message, member.info, true)) continue;
        if (inTurnSnapshot.has(member.info.name)) {
          delete member.info.completedAt;
          mutatedNames.add(member.info.name);
          wokenMembers.push(member.info.name);
          continue;
        }
        if (member.info.role === "coordinator") continue;
        if (await deliverMemberDoorbell(this.bridge, swarm, member)) wokenMembers.push(member.info.name);
      }
    }
    for (const name of mutatedNames) {
      const m = swarm.members.get(name);
      if (m !== undefined) this.ctx.emit("swarm/memberDelta", { swarmId: swarm.run.id, member: { ...m.info } });
    }

    this.ctx.emit("swarm/board", { swarmId: swarm.run.id, message: { ...message }, headSeq: swarm.board.headSeq, wokenMembers });
    this.persistAndNotify(swarm, now);
    return { message, wokenMembers };
  }

  async waitForBoard(input: SwarmWaitInput): Promise<SwarmWaitResult> {
    const swarm = this.requireSwarm(input.swarmId);
    const member = swarm.members.get(input.memberName.trim().toLowerCase());
    const target = member?.info ?? { name: input.memberName.trim().toLowerCase(), channels: [SWARM_MAIN_CHANNEL] };

    if (member !== undefined) member.inTurnWaiters += 1;
    try {
      const res = await swarm.board.waitFor({
        member: target,
        since: input.since,
        mentionsOnly: input.mentionsOnly,
        timeoutMs: input.timeoutMs,
        signal: input.signal,
        onPark: (since) => {
          if (member !== undefined && !member.info.killed) {
            member.info.state = "waiting";
            member.info.parkedSinceSeq = since;
            delete member.info.currentTool;
            delete member.info.currentStep;
            this.ctx.emit("swarm/memberDelta", { swarmId: swarm.run.id, member: { ...member.info } });
            this.persistAndNotify(swarm);
          }
        },
      });
      if (member !== undefined && !member.info.killed && !res.aborted && !res.timedOut) {
        member.info.lastReadSeq = Math.max(member.info.lastReadSeq, res.headSeq);
        member.info.state = "working";
        delete member.info.parkedSinceSeq;
        delete member.info.completedAt;
        member.info.lastActivityAt = Date.now();
        this.ctx.emit("swarm/memberDelta", { swarmId: swarm.run.id, member: { ...member.info } });
        this.persistAndNotify(swarm);
      }
      return res;
    } finally {
      if (member !== undefined) member.inTurnWaiters = Math.max(0, member.inTurnWaiters - 1);
    }
  }

  updatePlan(input: SwarmPlanUpdateInput): SwarmPlanOverview {
    const swarm = this.requireSwarm(input.swarmId);
    applySwarmPlanUpdate(swarm.run, input);
    return this.persistAndNotify(swarm).run.plan ?? synthesizeSwarmPlan(swarm.run, []);
  }

  mutateTask(params: SwarmTasksMutateParams): SwarmTasksMutateResult {
    const swarm = this.requireSwarm(params.swarmId);
    const outcome = swarm.tasks.mutate(params);
    this.persistAndNotify(swarm);
    return { ...(outcome.task === undefined ? {} : { task: outcome.task }), tasks: outcome.tasks };
  }

  controlMember(params: SwarmMemberControlParams): Promise<SwarmMemberControlResult> {
    return executeControlSwarmMember(this.bridge, this.requireSwarm(params.swarmId), params);
  }

  controlRun(params: SwarmRunControlParams): Promise<SwarmRunControlResult> {
    const swarm = this.requireSwarm(params.swarmId);
    return executeControlSwarmRun(this.bridge, swarm, params, () => {
      const snap = buildSwarmSnapshot(swarm);
      return { run: snap.run, alerts: snap.alerts };
    });
  }

  async getWorktreeDiff(swarmId: string, memberName: string): Promise<SwarmWorktreeDiffResult> {
    const swarm = this.requireSwarm(swarmId);
    const member = swarm.members.get(memberName.trim().toLowerCase());
    if (member === undefined) throw new Error(`Swarm member "@${memberName}" not found.`);
    const inspected = await inspectMemberWorktree({
      swarmId: swarm.run.id,
      memberName: member.info.name,
      sessionId: member.info.sessionId,
      handle: member.workspace,
    });
    if (member.info.changedFileCount !== inspected.diff.changedFiles.length) {
      member.info.changedFileCount = inspected.diff.changedFiles.length;
      this.persistAndNotify(swarm);
    }
    return inspected.diff;
  }

  manageChannel(input: SwarmChannelManageInput): SwarmChannelInfo[] {
    return executeManageSwarmChannel(this.bridge, this.requireSwarm(input.swarmId), input);
  }

  getConfig(params: SwarmConfigGetParams = {}): Promise<SwarmConfigGetResult> {
    return executeGetSwarmConfig(this.ctx, this.options.dataDir, this.globalConfig, this.swarms, params);
  }

  updateConfig(params: SwarmConfigUpdateParams): Promise<SwarmConfigUpdateResult> {
    return executeUpdateSwarmConfig({
      ctx: this.ctx,
      dataDir: this.options.dataDir,
      getGlobalConfig: () => this.globalConfig,
      setGlobalConfig: (next) => {
        this.globalConfig = next;
      },
      requireSwarm: (id) => this.requireSwarm(id),
      persistAndNotify: (s, now) => this.persistAndNotify(s, now),
      params,
    });
  }

  runWatchdogTick(now = Date.now()): SwarmAlertInfo[] {
    const emitted: SwarmAlertInfo[] = [];
    for (const swarm of this.swarms.values()) {
      emitted.push(...runSwarmWatchdogOnSwarm(this.ctx, swarm, now, (s, ts) => this.persistAndNotify(s, ts)));
    }
    return emitted;
  }
}

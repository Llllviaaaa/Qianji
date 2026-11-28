/**
 * JSON-RPC 2.0 gateway bindings for `@qianji/swarm` (`swarm.*` methods and
 * `swarm/*` push notifications, with 150ms per-member `swarm/memberDelta`
 * coalescing so streaming tool/token updates never flood WebSocket clients).
 */
import type { Context } from "@deepseek-ai/cordis";
import {
  ErrorCode,
  SWARM_RPC_METHODS,
  SWARM_RPC_NOTIFICATIONS,
  type SwarmBoardPostResult,
  type SwarmBoardReadResult,
  type SwarmConfigGetResult,
  type SwarmConfigUpdateResult,
  type SwarmCreateResult,
  type SwarmGetResult,
  type SwarmListResult,
  type SwarmMemberControlAction,
  type SwarmMemberControlResult,
  type SwarmMemberDeltaNotification,
  type SwarmMemberRole,
  type SwarmModelSettings,
  type SwarmRoleModelConfig,
  type SwarmRunControlAction,
  type SwarmRunControlResult,
  type SwarmTaskMutateAction,
  type SwarmTaskStatus,
  type SwarmTasksMutateResult,
  type SwarmWorktreeDiffResult,
} from "@qianji/protocol";
import "@qianji/swarm";
import { RpcError } from "./rpc.ts";

export const name = "qianji-swarm-rpc";
export const inject = ["rpc", "swarm"];
export const MEMBER_DELTA_THROTTLE_MS = 150;

type Params = Record<string, unknown>;

const VALID_TASK_ACTIONS = new Set<SwarmTaskMutateAction>(["create", "claim", "start", "verify", "complete", "block", "fail", "update", "delete"]);
const VALID_TASK_STATUSES = new Set<SwarmTaskStatus>(["pending", "claimed", "in_progress", "verifying", "completed", "blocked", "failed"]);
const VALID_MEMBER_ACTIONS = new Set<SwarmMemberControlAction>(["nudge", "switchModel", "abort", "kill", "mergeWorktree", "revive"]);
const VALID_RUN_ACTIONS = new Set<SwarmRunControlAction>(["pause", "resume", "stop", "complete", "setTitle", "dismissAlert"]);
const VALID_ROLES = new Set<SwarmMemberRole>(["coordinator", "planner", "explorer", "worker", "verifier", "monitor"]);

function asParams(value: unknown): Params {
  if (value === undefined || value === null) return {};
  if (typeof value !== "object" || Array.isArray(value)) throw new RpcError(ErrorCode.InvalidParams, "params must be an object");
  return value as Params;
}

function requiredStr(p: Params, key: string, trim = true): string {
  const raw = p[key];
  if (typeof raw !== "string" || raw.trim() === "") throw new RpcError(ErrorCode.InvalidParams, `${key} must be a non-empty string`);
  return trim ? raw.trim() : raw;
}

function optionalStr(p: Params, key: string, trim = true): string | undefined {
  const raw = p[key];
  if (raw === undefined) return undefined;
  if (typeof raw !== "string") throw new RpcError(ErrorCode.InvalidParams, `${key} must be a string`);
  const value = trim ? raw.trim() : raw;
  return value === "" ? undefined : value;
}

function optionalBool(p: Params, key: string): boolean | undefined {
  const raw = p[key];
  if (raw === undefined) return undefined;
  if (typeof raw !== "boolean") throw new RpcError(ErrorCode.InvalidParams, `${key} must be a boolean`);
  return raw;
}

function optionalNonNegInt(p: Params, key: string): number | undefined {
  const raw = p[key];
  if (raw === undefined) return undefined;
  if (typeof raw !== "number" || !Number.isInteger(raw) || raw < 0) throw new RpcError(ErrorCode.InvalidParams, `${key} must be a non-negative integer`);
  return raw;
}

function optionalPositiveInt(p: Params, key: string): number | undefined {
  const raw = p[key];
  if (raw === undefined) return undefined;
  if (typeof raw !== "number" || !Number.isInteger(raw) || raw <= 0) throw new RpcError(ErrorCode.InvalidParams, `${key} must be a positive integer`);
  return raw;
}

function optionalStringArray(p: Params, key: string): string[] | undefined {
  const raw = p[key];
  if (raw === undefined) return undefined;
  if (!Array.isArray(raw) || !raw.every((item) => typeof item === "string")) throw new RpcError(ErrorCode.InvalidParams, `${key} must be an array of strings`);
  return raw.map((item) => item.trim()).filter((item) => item !== "");
}

function optionalSeqArray(p: Params, key: string): number[] | undefined {
  const raw = p[key];
  if (raw === undefined) return undefined;
  if (!Array.isArray(raw) || !raw.every((item) => typeof item === "number" && Number.isInteger(item) && item >= 0)) {
    throw new RpcError(ErrorCode.InvalidParams, `${key} must be an array of non-negative integers`);
  }
  return raw as number[];
}

function optionalRoleModelEntry(raw: unknown, label: string): SwarmRoleModelConfig | null | undefined {
  if (raw === undefined || raw === null) return raw;
  if (typeof raw !== "object" || Array.isArray(raw)) throw new RpcError(ErrorCode.InvalidParams, `${label} must be an object`);
  const rec = raw as Params;
  if (rec.provider !== undefined && typeof rec.provider !== "string") throw new RpcError(ErrorCode.InvalidParams, `${label}.provider must be a string`);
  if (rec.model !== undefined && typeof rec.model !== "string") throw new RpcError(ErrorCode.InvalidParams, `${label}.model must be a string`);
  if (rec.effort !== undefined && rec.effort !== null && typeof rec.effort !== "string") {
    throw new RpcError(ErrorCode.InvalidParams, `${label}.effort must be a string`);
  }
  const model = typeof rec.model === "string" ? rec.model.trim() : "";
  if (model === "") return undefined;
  const provider = typeof rec.provider === "string" ? rec.provider.trim() : "";
  const effort = typeof rec.effort === "string" && rec.effort.trim() !== "" ? rec.effort.trim() : undefined;
  return { provider, model, ...(effort === undefined ? {} : { effort }) };
}

function optionalRoleModels(p: Params, key: string): Partial<Record<SwarmMemberRole, SwarmRoleModelConfig>> | undefined {
  const raw = p[key];
  if (raw === undefined) return undefined;
  if (raw === null) return {};
  if (typeof raw !== "object" || Array.isArray(raw)) throw new RpcError(ErrorCode.InvalidParams, `${key} must be an object`);
  const out: Partial<Record<SwarmMemberRole, SwarmRoleModelConfig>> = {};
  for (const [role, val] of Object.entries(raw as Params)) {
    if (!VALID_ROLES.has(role as SwarmMemberRole)) throw new RpcError(ErrorCode.InvalidParams, `Invalid swarm role: ${role}`);
    const parsed = optionalRoleModelEntry(val, `${key}.${role}`);
    if (parsed !== undefined && parsed !== null) out[role as SwarmMemberRole] = parsed;
  }
  return out;
}

function optionalGlobalConfig(p: Params, key: string): SwarmModelSettings | undefined {
  const raw = p[key];
  if (raw === undefined) return undefined;
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) throw new RpcError(ErrorCode.InvalidParams, `${key} must be an object`);
  const rec = raw as Params;
  const defaultWorkerModel = optionalRoleModelEntry(rec.defaultWorkerModel, `${key}.defaultWorkerModel`);
  const roleModels = optionalRoleModels(rec, "roleModels") ?? {};
  return {
    ...(defaultWorkerModel === undefined ? {} : { defaultWorkerModel }),
    roleModels,
  };
}

async function withSwarmErrors<T>(fn: () => T | Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (error) {
    if (error instanceof RpcError) throw error;
    if (error instanceof Error) {
      const code = /\b(?:no session|session\b.*not found)\b/i.test(error.message) ? ErrorCode.SessionNotFound : ErrorCode.InvalidParams;
      throw new RpcError(code, error.message);
    }
    throw error;
  }
}

export function apply(ctx: Context): void {
  const lastMemberDeltaAt = new Map<string, number>();
  const pendingMemberDeltas = new Map<string, { payload: SwarmMemberDeltaNotification; timer: ReturnType<typeof setTimeout> }>();

  const flushMemberDelta = (key: string, payload: SwarmMemberDeltaNotification): void => {
    const existing = pendingMemberDeltas.get(key);
    if (existing !== undefined) {
      clearTimeout(existing.timer);
      pendingMemberDeltas.delete(key);
    }
    lastMemberDeltaAt.set(key, Date.now());
    ctx.rpc.broadcast(SWARM_RPC_NOTIFICATIONS.memberDelta, payload);
  };

  ctx.on("swarm/updated", (payload) => ctx.rpc.broadcast(SWARM_RPC_NOTIFICATIONS.updated, payload));
  ctx.on("swarm/board", (payload) => ctx.rpc.broadcast(SWARM_RPC_NOTIFICATIONS.board, payload));
  ctx.on("swarm/alert", (payload) => ctx.rpc.broadcast(SWARM_RPC_NOTIFICATIONS.alert, payload));
  ctx.on("swarm/open", (payload) => ctx.rpc.broadcast(SWARM_RPC_NOTIFICATIONS.open, payload));
  ctx.on("swarm/configUpdated", (payload) => ctx.rpc.broadcast(SWARM_RPC_NOTIFICATIONS.configUpdated, payload));
  ctx.on("swarm/memberDelta", (payload) => {
    const key = `${payload.swarmId}\0${payload.member.name}`;
    if (payload.member.state !== "working") {
      flushMemberDelta(key, payload);
      return;
    }
    const elapsed = Date.now() - (lastMemberDeltaAt.get(key) ?? 0);
    const existing = pendingMemberDeltas.get(key);
    if (elapsed >= MEMBER_DELTA_THROTTLE_MS && existing === undefined) {
      flushMemberDelta(key, payload);
      return;
    }
    if (existing !== undefined) {
      existing.payload = payload;
      return;
    }
    const timer = setTimeout(() => {
      const queued = pendingMemberDeltas.get(key);
      pendingMemberDeltas.delete(key);
      if (queued !== undefined) {
        lastMemberDeltaAt.set(key, Date.now());
        ctx.rpc.broadcast(SWARM_RPC_NOTIFICATIONS.memberDelta, queued.payload);
      }
    }, Math.max(1, MEMBER_DELTA_THROTTLE_MS - elapsed));
    pendingMemberDeltas.set(key, { payload, timer });
  });

  ctx.effect(() => () => {
    for (const entry of pendingMemberDeltas.values()) clearTimeout(entry.timer);
    pendingMemberDeltas.clear();
    lastMemberDeltaAt.clear();
  }, `${name}: memberDelta throttle cleanup`);

  const methods: Record<string, (p: Params) => unknown> = {
    [SWARM_RPC_METHODS.list]: (p): Promise<SwarmListResult> =>
      withSwarmErrors(() => {
        const cwd = optionalStr(p, "cwd");
        const sessionId = optionalStr(p, "sessionId");
        const includeStopped = optionalBool(p, "includeStopped") ?? optionalBool(p, "includeCompleted");
        return ctx.swarm.listSwarms({
          ...(cwd === undefined ? {} : { cwd }),
          ...(sessionId === undefined ? {} : { sessionId }),
          ...(includeStopped === undefined ? {} : { includeStopped }),
        });
      }),

    [SWARM_RPC_METHODS.get]: (p): Promise<SwarmGetResult> =>
      withSwarmErrors(() => ctx.swarm.getSnapshot(requiredStr(p, "swarmId"))),

    [SWARM_RPC_METHODS.create]: (p): Promise<SwarmCreateResult> =>
      withSwarmErrors(() => {
        const goal = requiredStr(p, "goal", false);
        const title = optionalStr(p, "title");
        const cwd = optionalStr(p, "cwd");
        const coordinatorSessionId = optionalStr(p, "coordinatorSessionId");
        const stallTimeoutMs = optionalPositiveInt(p, "stallTimeoutMs");
        const roleModels = optionalRoleModels(p, "roleModels");
        return ctx.swarm.createSwarm({
          goal,
          ...(title === undefined ? {} : { title }),
          ...(cwd === undefined ? {} : { cwd }),
          ...(coordinatorSessionId === undefined ? {} : { coordinatorSessionId }),
          ...(stallTimeoutMs === undefined ? {} : { stallTimeoutMs }),
          ...(roleModels === undefined ? {} : { roleModels }),
        });
      }),

    [SWARM_RPC_METHODS.boardRead]: (p): Promise<SwarmBoardReadResult> =>
      withSwarmErrors(() => {
        const swarmId = requiredStr(p, "swarmId");
        const channel = optionalStr(p, "channel");
        const since = optionalNonNegInt(p, "since");
        const seqs = optionalSeqArray(p, "seqs");
        const limit = optionalPositiveInt(p, "limit");
        const readerName = optionalStr(p, "readerName");
        return ctx.swarm.readBoard({
          swarmId,
          ...(channel === undefined ? {} : { channel }),
          ...(since === undefined ? {} : { since }),
          ...(seqs === undefined ? {} : { seqs }),
          ...(limit === undefined ? {} : { limit }),
          ...(readerName === undefined ? {} : { readerName }),
        });
      }),

    [SWARM_RPC_METHODS.boardPost]: (p): Promise<SwarmBoardPostResult> =>
      withSwarmErrors(() => {
        const swarmId = requiredStr(p, "swarmId");
        const text = requiredStr(p, "text", false);
        const channel = optionalStr(p, "channel");
        const sender = optionalStr(p, "sender");
        const replyToSeq = optionalNonNegInt(p, "replyToSeq");
        return ctx.swarm.postBoardMessage({
          swarmId,
          text,
          ...(channel === undefined ? {} : { channel }),
          ...(sender === undefined ? {} : { sender }),
          ...(replyToSeq === undefined ? {} : { replyToSeq }),
        });
      }),

    [SWARM_RPC_METHODS.tasksMutate]: (p): Promise<SwarmTasksMutateResult> =>
      withSwarmErrors(() => {
        const swarmId = requiredStr(p, "swarmId");
        const actionRaw = requiredStr(p, "action") as SwarmTaskMutateAction;
        if (!VALID_TASK_ACTIONS.has(actionRaw)) throw new RpcError(ErrorCode.InvalidParams, `Invalid task action: ${actionRaw}`);
        const statusRaw = optionalStr(p, "status") as SwarmTaskStatus | undefined;
        if (statusRaw !== undefined && !VALID_TASK_STATUSES.has(statusRaw)) throw new RpcError(ErrorCode.InvalidParams, `Invalid task status: ${statusRaw}`);
        const taskId = optionalStr(p, "taskId");
        const title = optionalStr(p, "title");
        const description = optionalStr(p, "description", false);
        const assignee = optionalStr(p, "assignee");
        const dependsOn = optionalStringArray(p, "dependsOn");
        const ownedFiles = optionalStringArray(p, "ownedFiles");
        const verificationNotes = optionalStr(p, "verificationNotes", false);
        const expectedRevision = optionalNonNegInt(p, "expectedRevision");
        const actor = optionalStr(p, "actor");
        return ctx.swarm.mutateTask({
          swarmId,
          action: actionRaw,
          ...(taskId === undefined ? {} : { taskId }),
          ...(title === undefined ? {} : { title }),
          ...(description === undefined ? {} : { description }),
          ...(statusRaw === undefined ? {} : { status: statusRaw }),
          ...(assignee === undefined ? {} : { assignee }),
          ...(dependsOn === undefined ? {} : { dependsOn }),
          ...(ownedFiles === undefined ? {} : { ownedFiles }),
          ...(verificationNotes === undefined ? {} : { verificationNotes }),
          ...(expectedRevision === undefined ? {} : { expectedRevision }),
          ...(actor === undefined ? {} : { actor }),
        });
      }),

    [SWARM_RPC_METHODS.memberControl]: (p): Promise<SwarmMemberControlResult> =>
      withSwarmErrors(() => {
        const swarmId = requiredStr(p, "swarmId");
        const memberName = requiredStr(p, "name");
        const actionRaw = requiredStr(p, "action") as SwarmMemberControlAction;
        if (!VALID_MEMBER_ACTIONS.has(actionRaw)) throw new RpcError(ErrorCode.InvalidParams, `Invalid member action: ${actionRaw}`);
        const message = optionalStr(p, "message", false);
        const interrupt = optionalBool(p, "interrupt");
        const provider = optionalStr(p, "provider");
        const model = optionalStr(p, "model");
        const reason = optionalStr(p, "reason", false);
        const applyChanges = optionalBool(p, "applyChanges");
        const forceKillUnmerged = optionalBool(p, "forceKillUnmerged");
        return ctx.swarm.controlMember({
          swarmId,
          name: memberName,
          action: actionRaw,
          ...(message === undefined ? {} : { message }),
          ...(interrupt === undefined ? {} : { interrupt }),
          ...(provider === undefined ? {} : { provider }),
          ...(model === undefined ? {} : { model }),
          ...(reason === undefined ? {} : { reason }),
          ...(applyChanges === undefined ? {} : { applyChanges }),
          ...(forceKillUnmerged === undefined ? {} : { forceKillUnmerged }),
        });
      }),

    [SWARM_RPC_METHODS.runControl]: (p): Promise<SwarmRunControlResult> =>
      withSwarmErrors(() => {
        const swarmId = requiredStr(p, "swarmId");
        const actionRaw = requiredStr(p, "action") as SwarmRunControlAction;
        if (!VALID_RUN_ACTIONS.has(actionRaw)) throw new RpcError(ErrorCode.InvalidParams, `Invalid run action: ${actionRaw}`);
        const title = optionalStr(p, "title");
        const alertId = optionalStr(p, "alertId");
        const forceStopUnmerged = optionalBool(p, "forceStopUnmerged");
        return ctx.swarm.controlRun({
          swarmId,
          action: actionRaw,
          ...(title === undefined ? {} : { title }),
          ...(alertId === undefined ? {} : { alertId }),
          ...(forceStopUnmerged === undefined ? {} : { forceStopUnmerged }),
        });
      }),

    [SWARM_RPC_METHODS.worktreeDiff]: (p): Promise<SwarmWorktreeDiffResult> =>
      withSwarmErrors(() => {
        const swarmId = requiredStr(p, "swarmId");
        const memberName = optionalStr(p, "name") ?? requiredStr(p, "memberName");
        return ctx.swarm.getWorktreeDiff(swarmId, memberName);
      }),

    [SWARM_RPC_METHODS.configGet]: (p): Promise<SwarmConfigGetResult> =>
      withSwarmErrors(() => {
        const swarmId = optionalStr(p, "swarmId");
        return ctx.swarm.getConfig(swarmId === undefined ? {} : { swarmId });
      }),

    [SWARM_RPC_METHODS.configUpdate]: (p): Promise<SwarmConfigUpdateResult> =>
      withSwarmErrors(() => {
        const globalConfig = optionalGlobalConfig(p, "globalConfig");
        const swarmId = optionalStr(p, "swarmId");
        const sessionOverrides = optionalRoleModels(p, "sessionOverrides");
        const applyToWaitingMembers = optionalBool(p, "applyToWaitingMembers");
        return ctx.swarm.updateConfig({
          ...(globalConfig === undefined ? {} : { globalConfig }),
          ...(swarmId === undefined ? {} : { swarmId }),
          ...(sessionOverrides === undefined ? {} : { sessionOverrides }),
          ...(applyToWaitingMembers === undefined ? {} : { applyToWaitingMembers }),
        });
      }),
  };

  for (const [method, handler] of Object.entries(methods)) {
    ctx.effect(() => ctx.rpc.method(method, (raw) => handler(asParams(raw))), `${name}: ${method}`);
  }
}

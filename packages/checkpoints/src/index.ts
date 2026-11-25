/**
 * Workspace checkpoints (ADR 0009, ADR 0024): before each run that may change
 * files, snapshot the git workspace (without touching the real index) and
 * record it in the session as a `custom` event of namespace
 * `qianji-checkpoints`, tied to the user message that started the run. On
 * `turn >= 2`, the first non-concurrency-safe tool call lazily records an
 * incremental snapshot tagged with `turn`.
 *
 * Runs whose effective permission is read-only take no checkpoint.
 */
import type { Context } from "@deepseek-ai/cordis";
import "@qianji/agent";
import { ErrorCode, type CheckpointDiffResult, type CheckpointListResult } from "@qianji/protocol";
import { RpcError } from "@qianji/rpc";
import { currentBranch, customEvents, type Session } from "@qianji/session";
import { ACTIVATE_TOOLS_NAME, type ToolCall, type Tools } from "@qianji/tools";
import {
  createWorkspaceCheckpoint,
  diffWorkspaceCheckpoint,
  isWorkspaceCheckpoint,
  restoreWorkspaceCheckpoint,
  type WorkspaceCheckpoint,
  type WorkspaceCheckpointDiff,
} from "./git.ts";

export * from "./git.ts";

export const name = "qianji-checkpoints";
export const inject = ["sessions", "agents"];
export const NAMESPACE = "qianji-checkpoints";
export const LEGACY_NAMESPACE = "pid-checkpoints";

export interface CheckpointRecord {
  /** The user message whose run this snapshot precedes. */
  userSeq: number;
  /** Optional 1-based turn within the run when captured lazily before a mutating tool (`turn >= 2`). */
  turn?: number;
  checkpoint: WorkspaceCheckpoint;
}

/** The checkpoints recorded on the session's current branch, oldest first. */
export function checkpointsOf(session: Session): CheckpointRecord[] {
  return customEvents(session.events, [NAMESPACE, LEGACY_NAMESPACE]).flatMap((event) => {
    const data = event.data.data as Partial<CheckpointRecord> | undefined;
    if (typeof data?.userSeq !== "number" || !isWorkspaceCheckpoint(data.checkpoint)) return [];
    const turn = typeof data.turn === "number" && Number.isInteger(data.turn) ? data.turn : undefined;
    return [
      turn === undefined
        ? { userSeq: data.userSeq, checkpoint: data.checkpoint }
        : { userSeq: data.userSeq, turn, checkpoint: data.checkpoint },
    ];
  });
}

export function checkpointFor(session: Session, userSeq: number, turn?: number): CheckpointRecord | undefined {
  const list = checkpointsOf(session);
  if (turn !== undefined) {
    return list.find((record) => record.userSeq === userSeq && record.turn === turn);
  }
  return list.find((record) => record.userSeq === userSeq && record.turn === undefined)
    ?? list.find((record) => record.userSeq === userSeq);
}

/** Take a checkpoint for the session's latest user message (and optional `turn`); undefined outside a git repository. */
export async function takeCheckpoint(
  session: Session,
  signal?: AbortSignal,
  turn?: number,
): Promise<CheckpointRecord | undefined> {
  if (signal?.aborted) return undefined;
  const user = currentBranch(session.events).findLast((event) => event.type === "user");
  if (user === undefined || checkpointFor(session, user.seq, turn) !== undefined) return undefined;
  const checkpoint = await createWorkspaceCheckpoint(session.header.cwd, signal);
  if (checkpoint === null || signal?.aborted) return undefined;
  if (checkpointFor(session, user.seq, turn) !== undefined) return undefined;
  const record: CheckpointRecord = turn === undefined
    ? { userSeq: user.seq, checkpoint }
    : { userSeq: user.seq, turn, checkpoint };
  session.append("custom", { ns: NAMESPACE, data: record });
  return record;
}

export async function diffCheckpoint(record: CheckpointRecord): Promise<WorkspaceCheckpointDiff> {
  return diffWorkspaceCheckpoint(record.checkpoint);
}

export async function restoreCheckpoint(record: CheckpointRecord): Promise<WorkspaceCheckpointDiff> {
  return restoreWorkspaceCheckpoint(record.checkpoint);
}

function isCallConcurrencySafe(tools: Tools, call: ToolCall, sessionId: string): boolean {
  if (typeof tools.isConcurrencySafe === "function") {
    return tools.isConcurrencySafe(call.name, call.args, sessionId);
  }
  return call.name === ACTIVATE_TOOLS_NAME || tools.get(call.name)?.readOnly === true;
}

export function apply(ctx: Context): void {
  const activeTurns = new Map<string, number>();
  const inFlight = new Map<string, Promise<CheckpointRecord | undefined>>();

  const isReadOnlySession = (targetCtx: Context, session: Session): boolean => {
    const permissions = targetCtx.get("permissions") as { modes(s: Session): { effective: string } } | undefined;
    return permissions?.modes(session).effective === "read-only";
  };

  ctx.on("agent/turn-start", (session, turn) => {
    activeTurns.set(session.id, turn);
  });
  ctx.on("agent/settled", async (session) => {
    activeTurns.delete(session.id);
  });
  ctx.on("session/deleted", (id) => {
    activeTurns.delete(id);
  });
  ctx.on("session/unloaded", (id) => {
    activeTurns.delete(id);
  });

  ctx.on("agent/before-start", async (session, signal) => {
    if (signal?.aborted || isReadOnlySession(ctx, session)) return;
    try {
      await takeCheckpoint(session, signal);
    } catch (error) {
      ctx.logger("checkpoints").warn("checkpoint of %s failed: %s", session.id, error);
    }
  });

  ctx.inject(["tools"], (toolsCtx) => {
    toolsCtx.on("tools/execute", async (call, env, next) => {
      const turn = activeTurns.get(env.sessionId);
      if (turn !== undefined && turn >= 2 && !env.signal.aborted && !isCallConcurrencySafe(toolsCtx.tools, call, env.sessionId)) {
        const session = toolsCtx.sessions.peek(env.sessionId) ?? await toolsCtx.sessions.get(env.sessionId);
        if (session !== undefined && !isReadOnlySession(toolsCtx, session)) {
          const user = currentBranch(session.events).findLast((event) => event.type === "user");
          if (user !== undefined && checkpointFor(session, user.seq, turn) === undefined) {
            const key = `${session.id}:${user.seq}:${turn}`;
            let pending = inFlight.get(key);
            if (pending === undefined) {
              pending = takeCheckpoint(session, env.signal, turn)
                .catch((error) => {
                  toolsCtx.logger("checkpoints").warn("turn %d checkpoint of %s failed: %s", turn, session.id, error);
                  return undefined;
                })
                .finally(() => {
                  inFlight.delete(key);
                });
              inFlight.set(key, pending);
            }
            await pending;
          }
        }
      }
      return next();
    });
  });

  ctx.inject(["rpc"], (rpcCtx) => {
    const resolveSession = async (params: unknown): Promise<{ target: Session; p: Record<string, unknown> }> => {
      const p = (typeof params === "object" && params !== null ? params : {}) as Record<string, unknown>;
      if (typeof p.sessionId !== "string") throw new RpcError(ErrorCode.InvalidParams, "sessionId must be a string");
      const target = await rpcCtx.sessions.get(p.sessionId);
      if (target === undefined) throw new RpcError(ErrorCode.SessionNotFound, `No session ${p.sessionId}`);
      return { target, p };
    };
    const parseUserSeq = (p: Record<string, unknown>): number => {
      if (!Number.isInteger(p.userSeq)) {
        throw new RpcError(ErrorCode.InvalidParams, "userSeq must be the seq of a user message");
      }
      return p.userSeq as number;
    };
    const parseOptionalTurn = (p: Record<string, unknown>): number | undefined => {
      if (p.turn === undefined) return undefined;
      if (!Number.isInteger(p.turn) || (p.turn as number) < 1) {
        throw new RpcError(ErrorCode.InvalidParams, "turn must be a positive integer");
      }
      return p.turn as number;
    };

    rpcCtx.effect(
      () => rpcCtx.rpc.method("checkpoint.list", async (params): Promise<CheckpointListResult> => ({
        checkpoints: checkpointsOf((await resolveSession(params)).target).map(({ userSeq, checkpoint }) => ({
          userSeq,
          root: checkpoint.root,
          createdAt: checkpoint.createdAt,
        })),
      })),
      `${name}: checkpoint.list`,
    );

    rpcCtx.effect(
      () => rpcCtx.rpc.method("checkpoint.diff", async (params): Promise<CheckpointDiffResult> => {
        const { target, p } = await resolveSession(params);
        const record = checkpointFor(target, parseUserSeq(p), parseOptionalTurn(p));
        if (record === undefined) throw new RpcError(ErrorCode.InvalidParams, "No checkpoint for that message");
        return diffCheckpoint(record);
      }),
      `${name}: checkpoint.diff`,
    );

    rpcCtx.effect(
      () => rpcCtx.rpc.method("checkpoint.restore", async (params): Promise<CheckpointDiffResult> => {
        const { target, p } = await resolveSession(params);
        if (rpcCtx.agents.status(target.id).running) {
          throw new RpcError(ErrorCode.SessionBusy, `Session ${target.id} is running`);
        }
        const record = checkpointFor(target, parseUserSeq(p), parseOptionalTurn(p));
        if (record === undefined) throw new RpcError(ErrorCode.InvalidParams, "No checkpoint for that message");
        return restoreCheckpoint(record);
      }),
      `${name}: checkpoint.restore`,
    );
  });
}

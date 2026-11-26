/**
 * Persistent background collaboration handles (`spawn_agent`, `send_input`,
 * `wait_agent`, `close_agent`) plus the `agent/before-stop` quiescence barrier.
 */
import type { Context } from "@deepseek-ai/cordis";
import type { RunOutcome } from "@qianji/agent";
import type { Session } from "@qianji/session";
import { textOutput, type ToolDefinition, type ToolEnv } from "@qianji/tools";
import type { SpawnChildInput, SpawnChildResult } from "./child-session.ts";
import { subagentPrompt, type SubagentPermission, type SubagentRole } from "./core.ts";
import { applyOrSaveWorktreePatch, cleanupWorktree, collectWorktreePatch, type PreparedWorktree, type WorktreePatchResult } from "./worktree.ts";

export const SUBAGENTS_TOOL_GROUP = "subagents";
export const SUBAGENTS_GROUP_DESCRIPTION =
  "Persistent background subagents (spawn_agent, send_input, wait_agent, close_agent)";
export const DEFAULT_MAX_ACTIVE_AGENTS = 6;
export const DEFAULT_MAX_SUBAGENT_DEPTH = 2;

export type SpawnChildFn = (parent: Session, input: SpawnChildInput) => Promise<SpawnChildResult>;

interface ManagedAgent {
  agentId: string; parentSessionId: string; parent: Session; child: Session;
  label: string; role: SubagentRole; permission: SubagentPermission; allowShell: boolean; detach: boolean;
  prepared?: PreparedWorktree; disposeRestrictions: () => void; releaseHold: () => void;
  running: boolean; closed: boolean; interrupting: boolean; parentWasRunning: boolean;
  deliveredToParent: boolean; waiterCount: number; promptSeq: number; lastOutcome?: RunOutcome; lastOutput: string;
}

function finalTextAfter(session: Session, afterSeq: number): string {
  const last = session.events.findLast((event) => event.seq > afterSeq && event.type === "assistant");
  if (last?.type !== "assistant") return "";
  return last.data.content.flatMap((block) => (block.type === "text" ? [block.text] : [])).join("\n").trim();
}

async function sessionDepth(ctx: Context, session: Session): Promise<number> {
  let depth = 0;
  let cur: Session | undefined = session;
  const visited = new Set<string>([session.id]);
  while (cur?.header.parent !== undefined) {
    depth += 1;
    const parentId = cur.header.parent.sessionId;
    if (visited.has(parentId)) break;
    visited.add(parentId);
    cur = await ctx.sessions.get(parentId);
  }
  return depth;
}

export interface CollabOptions {
  maxActiveAgents?: number;
  maxDepth?: number;
  spawnChild: SpawnChildFn;
}

export function registerCollabTools(ctx: Context, options: CollabOptions): () => void {
  const maxActive = Math.max(1, options.maxActiveAgents ?? DEFAULT_MAX_ACTIVE_AGENTS);
  const maxDepth = Math.max(1, options.maxDepth ?? DEFAULT_MAX_SUBAGENT_DEPTH);
  const handles = new Map<string, ManagedAgent>();
  const wakeCallbacks = new Set<() => void>();
  const notifyWaiters = (): void => { for (const wake of [...wakeCallbacks]) wake(); };
  const isSettled = (e: ManagedAgent): boolean => e.closed || (!e.running && !ctx.agents.status(e.agentId).running);
  const isParentReadOnly = (parent: Session): boolean =>
    (ctx.get("permissions") as { modes?(s: Session): { effective: string } } | undefined)?.modes?.(parent).effective === "read-only";

  const closeHandle = async (entry: ManagedAgent, applyChanges = true): Promise<WorktreePatchResult | undefined> => {
    if (entry.closed) return undefined;
    entry.closed = true;
    entry.running = false;
    handles.delete(entry.agentId);
    notifyWaiters();
    await ctx.agents.abort(entry.agentId);
    let patchResult: WorktreePatchResult | undefined;
    if (entry.prepared !== undefined) {
      try {
        const collected = await collectWorktreePatch({ wtRoot: entry.prepared.wtRoot, baseHead: entry.prepared.baseHead, childId: entry.agentId });
        if (!collected.empty && collected.patchBuffer !== undefined) {
          patchResult = await applyOrSaveWorktreePatch({
            repoRoot: entry.prepared.repoRoot,
            label: entry.label,
            childId: entry.agentId,
            changedFiles: collected.changedFiles,
            patchBuffer: collected.patchBuffer,
            applyChanges,
          });
        }
      } finally {
        await cleanupWorktree(entry.prepared.repoRoot, entry.prepared.wtRoot);
      }
    }
    entry.disposeRestrictions();
    entry.releaseHold();
    return patchResult;
  };

  const offSettled = ctx.on("agent/settled", async (session, outcome) => {
    const entry = handles.get(session.id);
    if (entry === undefined || entry.closed || entry.interrupting) return;
    entry.running = false;
    entry.lastOutcome = outcome;
    entry.lastOutput = finalTextAfter(entry.child, entry.promptSeq);
    if (entry.waiterCount > 0) {
      entry.deliveredToParent = true;
      notifyWaiters();
      return;
    }
    notifyWaiters();
    if (!entry.deliveredToParent && (ctx.agents.status(entry.parentSessionId).running || entry.parentWasRunning)) {
      entry.deliveredToParent = true;
      const raw = (entry.lastOutput || `Subagent ended with ${outcome}.`).trim();
      const body = raw.length <= 1_200 ? raw : `${raw.slice(0, 1_200)}…`;
      const note = `<subagent-settled id="${entry.agentId}" label="${entry.label}" role="${entry.role}" status="${outcome}">\n${body}\n</subagent-settled>`;
      try { ctx.agents.followUp(entry.parent, [{ type: "text", text: note }]); } catch { /* parent closed */ }
    }
  });

  const offBeforeStop = ctx.on("agent/before-stop", (session) => {
    const active = [...handles.values()].filter((e) => e.parentSessionId === session.id && !e.closed && !e.detach && !isSettled(e));
    if (active.length === 0) return undefined;
    const list = active.map((e) => `${e.agentId} (${e.label})`).join(", ");
    return `Background subagent(s) are still running: ${list}. Call wait_agent to collect their results or close_agent to stop them before finishing.`;
  });

  const offSessionDeleted = ctx.on("session/deleted", (sessionId) => {
    for (const e of [...handles.values()]) {
      if (e.parentSessionId === sessionId || e.agentId === sessionId) void closeHandle(e, false);
    }
  });

  const spawnTool: ToolDefinition<{
    task?: string; role?: SubagentRole; label?: string; permission?: SubagentPermission;
    allowShell?: boolean; forkContext?: boolean; isolateWorktree?: boolean; detach?: boolean;
  }> = {
    name: "spawn_agent",
    deferred: true,
    group: SUBAGENTS_TOOL_GROUP,
    groupDescription: SUBAGENTS_GROUP_DESCRIPTION,
    description: "Spawn a persistent background subagent session and return its agentId immediately without blocking.",
    parameters: {
      type: "object",
      properties: {
        task: { type: "string", description: "Task instructions for the background subagent" },
        role: { type: "string", enum: ["explorer", "planner", "reviewer", "worker"] },
        label: { type: "string", description: "Short display label" },
        permission: { type: "string", enum: ["read-only", "workspace-write"] },
        allowShell: { type: "boolean", description: "Grant verification shell access when permission is workspace-write" },
        forkContext: { type: "boolean", description: "Clone the parent session's settled conversation prefix" },
        isolateWorktree: { type: "boolean", description: "Isolate workspace-write edits in a Git worktree until close_agent" },
        detach: { type: "boolean", description: "Allow the parent turn to stop without waiting for this subagent" },
      },
      required: ["task"],
    },
    async execute(args, env) {
      const taskText = args.task?.trim() ?? "";
      if (taskText === "") return textOutput("task must be a non-empty string.", true);
      const parent = await ctx.sessions.get(env.sessionId);
      if (parent === undefined) return textOutput("No parent session found.", true);
      if ((await sessionDepth(ctx, parent)) + 1 > maxDepth) return textOutput(`Maximum subagent recursion depth (${maxDepth}) exceeded.`, true);
      if (handles.size >= maxActive) return textOutput(`Maximum active background subagents (${maxActive}) reached; close_agent before spawning more.`, true);
      const role: SubagentRole = args.role === "planner" || args.role === "reviewer" || args.role === "worker" ? args.role : "explorer";
      const label = args.label?.trim() || `${role}-${handles.size + 1}`;
      const permission: SubagentPermission = args.permission === "workspace-write" ? "workspace-write" : "read-only";
      const spawned = await options.spawnChild(parent, {
        label, task: taskText, role, permission,
        allowShell: args.allowShell, isolateWorktree: args.isolateWorktree, forkContext: args.forkContext,
        callId: env.callId, signal: env.signal,
      });
      if (!spawned.ok) return textOutput(spawned.error, true);
      const { child, prepared, allowShell, disposeRestrictions } = spawned;
      const entry: ManagedAgent = {
        agentId: child.id, parentSessionId: parent.id, parent, child, label, role, permission, allowShell,
        detach: args.detach === true, prepared, disposeRestrictions, releaseHold: ctx.sessions.hold(child.id),
        running: true, closed: false, interrupting: false, parentWasRunning: ctx.agents.status(parent.id).running,
        deliveredToParent: false, waiterCount: 0, promptSeq: child.lastSeq, lastOutput: "",
      };
      handles.set(child.id, entry);
      const promptText = subagentPrompt({ label, task: taskText, role }, { allowShell, isolatedWorktree: prepared !== undefined });
      try {
        ctx.agents.prompt(child, [{ type: "text", text: promptText }]);
      } catch (error) {
        await closeHandle(entry, false);
        return textOutput(`Failed to start subagent: ${(error as Error).message}`, true);
      }
      const details = { agentId: child.id, label, role, permission, status: "running" as const };
      return { content: [{ type: "text", text: JSON.stringify(details) }], details };
    },
  };

  const sendInputTool: ToolDefinition<{ agentId?: string; message?: string; interrupt?: boolean; delivery?: "steer" | "followUp" }> = {
    name: "send_input",
    deferred: true,
    group: SUBAGENTS_TOOL_GROUP,
    description: "Send a follow-up or steering message to an owned background subagent.",
    parameters: {
      type: "object",
      properties: {
        agentId: { type: "string", description: "Target agentId from spawn_agent" },
        message: { type: "string", description: "Instruction to deliver to the subagent" },
        interrupt: { type: "boolean", description: "Abort the subagent's in-progress turn before prompting" },
        delivery: { type: "string", enum: ["steer", "followUp"], description: "Queue mode when running and interrupt is false" },
      },
      required: ["agentId", "message"],
    },
    async execute(args, env) {
      const entry = args.agentId === undefined ? undefined : handles.get(args.agentId);
      if (entry === undefined || entry.closed || entry.parentSessionId !== env.sessionId) {
        return textOutput(`Unknown or unowned background subagent "${args.agentId ?? ""}".`, true);
      }
      if (entry.permission === "workspace-write" && isParentReadOnly(entry.parent)) {
        return textOutput("Qianji read-only mode blocks sending input to a workspace-write subagent.", true);
      }
      const text = args.message?.trim() ?? "";
      if (text === "") return textOutput("message must be non-empty.", true);
      entry.deliveredToParent = false;
      entry.lastOutcome = undefined;
      if (args.interrupt === true) {
        entry.interrupting = true;
        try { await ctx.agents.abort(entry.agentId); } finally { entry.interrupting = false; }
        entry.promptSeq = entry.child.lastSeq;
        entry.running = true;
        ctx.agents.prompt(entry.child, [{ type: "text", text }]);
      } else if (ctx.agents.status(entry.agentId).running) {
        entry.promptSeq = entry.child.lastSeq;
        entry.running = true;
        if (args.delivery === "followUp") ctx.agents.followUp(entry.child, [{ type: "text", text }]);
        else ctx.agents.steer(entry.child, [{ type: "text", text }]);
      } else {
        entry.promptSeq = entry.child.lastSeq;
        entry.running = true;
        ctx.agents.prompt(entry.child, [{ type: "text", text }]);
      }
      const details = { agentId: entry.agentId, status: "running" as const, interrupted: args.interrupt === true };
      return { content: [{ type: "text", text: JSON.stringify(details) }], details };
    },
  };

  const waitTool: ToolDefinition<{ agentIds?: string[]; mode?: "any" | "all"; timeoutMs?: number }> = {
    name: "wait_agent",
    deferred: true,
    group: SUBAGENTS_TOOL_GROUP,
    readOnly: true,
    isConcurrencySafe: () => true,
    timeoutMs: 0,
    description: "Wait for one or more owned background subagents to settle without polling.",
    parameters: {
      type: "object",
      properties: {
        agentIds: { type: "array", items: { type: "string" }, description: "Agent IDs to wait on (defaults to all owned active subagents)" },
        mode: { type: "string", enum: ["any", "all"], description: "Wake when any target settles or wait for all (default all)" },
        timeoutMs: { type: "number", description: "Optional maximum wait duration in milliseconds" },
      },
    },
    async execute(args, env: ToolEnv) {
      const owned = [...handles.values()].filter((e) => !e.closed && e.parentSessionId === env.sessionId);
      const ids = args.agentIds?.length ? args.agentIds : owned.map((e) => e.agentId);
      if (ids.length === 0) return textOutput("No active background subagents to wait on.", true);
      const targets: ManagedAgent[] = [];
      for (const id of ids) {
        const found = handles.get(id);
        if (found === undefined || found.parentSessionId !== env.sessionId) return textOutput(`Unknown or unowned background subagent "${id}".`, true);
        targets.push(found);
      }
      const ready = () => (args.mode === "any" ? targets.some(isSettled) : targets.every(isSettled));
      let timedOut = false;
      let steered = false;
      if (!ready() && !env.signal.aborted && !env.steeringSignal?.aborted) {
        for (const t of targets) t.waiterCount += 1;
        try {
          await new Promise<void>((resolveWait) => {
            let timer: ReturnType<typeof setTimeout> | undefined;
            const done = () => {
              if (timer !== undefined) clearTimeout(timer);
              wakeCallbacks.delete(check);
              env.signal.removeEventListener("abort", done);
              env.steeringSignal?.removeEventListener("abort", onSteer);
              resolveWait();
            };
            const check = () => { if (ready()) done(); };
            const onSteer = () => { steered = true; done(); };
            wakeCallbacks.add(check);
            env.signal.addEventListener("abort", done, { once: true });
            env.steeringSignal?.addEventListener("abort", onSteer, { once: true });
            if (typeof args.timeoutMs === "number" && Number.isFinite(args.timeoutMs) && args.timeoutMs > 0) {
              timer = setTimeout(() => { timedOut = true; done(); }, args.timeoutMs);
            }
            check();
          });
        } finally {
          for (const t of targets) t.waiterCount = Math.max(0, t.waiterCount - 1);
        }
      }
      const snapshots = targets.map((t) => {
        const settled = isSettled(t);
        if (settled) t.deliveredToParent = true;
        return {
          agentId: t.agentId, label: t.label, role: t.role,
          status: settled ? (t.lastOutcome ?? "done") : "running",
          output: t.lastOutput || finalTextAfter(t.child, t.promptSeq),
        };
      });
      const details = { agents: snapshots, timedOut, steered: steered || env.steeringSignal?.aborted === true };
      return { content: [{ type: "text", text: JSON.stringify(details, null, 2) }], details };
    },
  };

  const closeTool: ToolDefinition<{ agentId?: string; applyChanges?: boolean }> = {
    name: "close_agent",
    deferred: true,
    group: SUBAGENTS_TOOL_GROUP,
    description: "Abort or finalize an owned background subagent, apply/save any isolated worktree patch, and free its slot.",
    parameters: {
      type: "object",
      properties: {
        agentId: { type: "string", description: "Target agentId from spawn_agent" },
        applyChanges: { type: "boolean", description: "Apply clean isolated worktree changes back to the parent repo (default true)" },
      },
      required: ["agentId"],
    },
    async execute(args, env) {
      const entry = args.agentId === undefined ? undefined : handles.get(args.agentId);
      if (entry === undefined || entry.closed || entry.parentSessionId !== env.sessionId) {
        return textOutput(`Unknown or unowned background subagent "${args.agentId ?? ""}".`, true);
      }
      const output = entry.lastOutput || finalTextAfter(entry.child, entry.promptSeq);
      const patch = await closeHandle(entry, args.applyChanges !== false && !isParentReadOnly(entry.parent));
      const details = { agentId: entry.agentId, label: entry.label, status: "closed" as const, output, ...(patch === undefined ? {} : { patch }) };
      return { content: [{ type: "text", text: JSON.stringify(details, null, 2) }], details };
    },
  };

  const disposers = [ctx.tools.register(spawnTool), ctx.tools.register(sendInputTool), ctx.tools.register(waitTool), ctx.tools.register(closeTool)];
  return () => { offSettled(); offBeforeStop(); offSessionDeleted(); for (const d of disposers) d(); for (const e of [...handles.values()]) void closeHandle(e, false); };
}

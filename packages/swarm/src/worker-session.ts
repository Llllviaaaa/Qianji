/**
 * Swarm worker child-session provisioning, role-tiered tool allowlists,
 * unattended UI marking, and isolated workspace write confinement (`@qianji/swarm`).
 */
import { existsSync, realpathSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import type { Context } from "@deepseek-ai/cordis";
import type { SwarmMemberRole } from "@qianji/protocol";
import type { Session } from "@qianji/session";
import {
  buildForkedContextSeed,
  resolveSubagentAllowedTools,
  SHELL_VERIFICATION_TOOLS,
} from "@qianji/subagents";

export const SWARM_TOOL_GROUP = "swarm";
export const SWARM_GROUP_DESCRIPTION =
  "Native multi-agent swarm coordination (swarm, read_board, post_message, swarm_wait)";

export const SWARM_TOOL_NAMES = [
  "swarm",
  "read_board",
  "post_message",
  "swarm_wait",
] as const;

function realOrResolved(targetPath: string): string {
  const abs = resolve(targetPath);
  let cur = abs;
  const tail: string[] = [];
  while (!existsSync(cur)) {
    const parentDir = dirname(cur);
    if (parentDir === cur) break;
    tail.unshift(basename(cur));
    cur = parentDir;
  }
  try {
    const realBase = realpathSync(cur);
    return tail.length > 0 ? join(realBase, ...tail) : realBase;
  } catch {
    return abs;
  }
}

function normalizeSlash(pathValue: string): string {
  return pathValue.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
}

function isInsideWorkspace(candidatePath: string, workspaceRoot: string): boolean {
  const realRoot = normalizeSlash(realOrResolved(workspaceRoot));
  if (realRoot === "") return false;
  const resolvedCandidate = normalizeSlash(realOrResolved(resolve(workspaceRoot, candidatePath)));
  return resolvedCandidate === realRoot || resolvedCandidate.startsWith(`${realRoot}/`);
}

function extractWriteTargets(args: Record<string, unknown>): string[] {
  const out: string[] = [];
  for (const key of ["path", "file", "filePath", "target"]) {
    const val = args[key];
    if (typeof val === "string" && val.trim() !== "") out.push(val.trim());
  }
  for (const key of ["paths", "files", "targets"]) {
    const arr = args[key];
    if (!Array.isArray(arr)) continue;
    for (const item of arr) {
      if (typeof item === "string" && item.trim() !== "") out.push(item.trim());
    }
  }
  return out;
}

const confinedSwarmWorkspaces = new WeakMap<object, Map<string, string>>();

function confineSessionWritesToWorkspace(ctx: Context, sessionId: string, workspaceCwd: string): () => void {
  const rootKey = (ctx.root ?? ctx) as object;
  let map = confinedSwarmWorkspaces.get(rootKey);
  if (map === undefined) {
    const created = new Map<string, string>();
    confinedSwarmWorkspaces.set(rootKey, created);
    map = created;
    (ctx.root ?? ctx).on("tools/pre-execute", (call, env) => {
      const workspace = created.get(env.sessionId);
      if (workspace === undefined) return undefined;
      const lower = call.name.toLowerCase();
      if (lower !== "write" && lower !== "edit" && lower !== "apply_patch") return undefined;
      const permissions = ctx.get("permissions") as { rules?: { blockWriteOutsideWorkspace?: boolean } } | undefined;
      if (permissions?.rules?.blockWriteOutsideWorkspace === false) return undefined;
      const targets = extractWriteTargets(call.args);
      if (targets.length === 0) {
        return { deny: true, reason: "Swarm worker write requires an explicit path inside its workspace." };
      }
      const outside = targets.find((candidate) => !isInsideWorkspace(candidate, workspace));
      return outside === undefined
        ? undefined
        : { deny: true, reason: `Swarm worker write outside workspace (${workspace}) blocked: ${outside}` };
    }, true);
  }
  map.set(sessionId, workspaceCwd);
  return () => {
    map.delete(sessionId);
  };
}

export function resolveSwarmWorkerAllowedTools(ctx: Context, role: SwarmMemberRole): string[] {
  if (role === "worker") {
    const base = resolveSubagentAllowedTools(ctx, "workspace-write", true);
    return [...new Set([...base, ...SWARM_TOOL_NAMES])];
  }
  if (role === "verifier") {
    const base = resolveSubagentAllowedTools(ctx, "read-only", false);
    return [...new Set([...base, ...SHELL_VERIFICATION_TOOLS, ...SWARM_TOOL_NAMES])];
  }
  const base = resolveSubagentAllowedTools(ctx, "read-only", false);
  return [...new Set([...base, ...SWARM_TOOL_NAMES])];
}

export interface BoundWorkerSession {
  session: Session;
  dispose: () => void;
}

export function bindSwarmWorkerSession(
  ctx: Context,
  session: Session,
  role: SwarmMemberRole,
  workspaceCwd: string,
): BoundWorkerSession {
  const holdRelease = ctx.sessions.hold(session.id);
  const allowedTools = resolveSwarmWorkerAllowedTools(ctx, role);
  const unrestrict = ctx.tools.restrict(session.id, allowedTools);
  ctx.tools.activate(session.id, [SWARM_TOOL_GROUP, ...SWARM_TOOL_NAMES]);

  const permissions = ctx.get("permissions") as {
    set?(target: Session, change: { permission: string; agentMode: string }): number;
  } | undefined;
  const ui = ctx.get("ui") as { markUnattended?(sessionId: string): () => void } | undefined;

  const needsShellOrWrite = role === "worker" || role === "verifier";
  if (needsShellOrWrite) {
    permissions?.set?.(session, { permission: "full-access", agentMode: "agent" });
  } else {
    permissions?.set?.(session, { permission: "read-only", agentMode: "agent" });
  }

  const disposeConfinement = role === "worker"
    ? confineSessionWritesToWorkspace(ctx, session.id, workspaceCwd)
    : undefined;
  const disposeUnattended = ui?.markUnattended?.(session.id);

  let disposed = false;
  return {
    session,
    dispose: () => {
      if (disposed) return;
      disposed = true;
      unrestrict();
      disposeConfinement?.();
      disposeUnattended?.();
      holdRelease();
    },
  };
}

export function createSwarmWorkerSession(options: {
  ctx: Context;
  coordinatorSessionId: string;
  forkSource?: Session;
  sessionCwd: string;
  provider: string;
  model: string;
  effort?: string;
  memberName: string;
  role: SwarmMemberRole;
}): BoundWorkerSession {
  const seed = options.forkSource !== undefined
    ? buildForkedContextSeed(options.forkSource)
    : { events: [] };
  const effort = options.effort !== undefined && options.effort.trim() !== "" ? options.effort.trim() : undefined;
  const session = options.ctx.sessions.create({
    cwd: options.sessionCwd,
    ...(options.coordinatorSessionId !== ""
      ? { parent: { sessionId: options.coordinatorSessionId, callId: `swarm:${options.memberName}` } }
      : {}),
    ...(seed.forkedFrom === undefined ? {} : { forkedFrom: seed.forkedFrom, events: seed.events }),
    model: { provider: options.provider, model: options.model },
    ...(effort === undefined ? {} : { effort }),
  });
  session.append("label", { title: `@${options.memberName} (${options.role})` });
  return bindSwarmWorkerSession(options.ctx, session, options.role, options.sessionCwd);
}

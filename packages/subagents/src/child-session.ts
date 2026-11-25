/**
 * Shared child-session configuration, dynamic read-only tool allowlisting, and
 * workspace write confinement for `delegate_task` and `spawn_agent`.
 */
import { existsSync, realpathSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import type { Context } from "@deepseek-ai/cordis";
import type { Effort } from "@qianji/llm";
import type { Session } from "@qianji/session";
import { SHELL_VERIFICATION_TOOLS, type SubagentPermission, type SubagentRole } from "./core.ts";
import { buildForkedContextSeed } from "./fork-context.ts";
import { cleanupWorktree, prepareIsolatedWorktree, type PreparedWorktree } from "./worktree.ts";

export interface RoleModelConfig {
  provider: string;
  model: string;
  effort?: Effort;
}

export interface Config {
  /** Default model for subagents; falls back to the parent session's model. */
  model?: { provider: string; model: string };
  effort?: Effort;
  /** Optional per-role model & effort overrides (`explorer`, `planner`, `reviewer`, `worker`). */
  roleModels?: Partial<Record<SubagentRole, RoleModelConfig>>;
  /** Subagents running at once in `delegate_task`, 1..4. Default 3. */
  concurrency?: number;
  /** Master switch allowing `allowShell: true` on `workspace-write` subagents (default `true`). */
  allowShell?: boolean;
  /** Maximum active background subagents via `spawn_agent` (default `6`). */
  maxActiveAgents?: number;
  /** Maximum subagent recursion depth (default `2`). */
  maxDepth?: number;
}

export interface SpawnChildInput {
  label: string;
  task: string;
  role: SubagentRole;
  permission: SubagentPermission;
  allowShell?: boolean;
  isolateWorktree?: boolean;
  forkContext?: boolean;
  callId?: string;
  signal: AbortSignal;
}

export type SpawnChildResult =
  | { ok: true; child: Session; prepared?: PreparedWorktree; allowShell: boolean; disposeRestrictions: () => void }
  | { ok: false; error: string };

export const READ_TOOLS = ["read", "grep", "find", "ls"] as const;
export const WRITE_TOOLS = ["edit", "write"] as const;
export const SUBAGENT_META_TOOLS = new Set([
  "delegate_task",
  "spawn_agent",
  "send_input",
  "wait_agent",
  "close_agent",
]);

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

const confinedWorkspacesByRoot = new WeakMap<object, Map<string, string>>();

function trackConfinedSubagentWorkspace(ctx: Context, sessionId: string, workspaceCwd: string): () => void {
  const rootKey = (ctx.root ?? ctx) as object;
  let map = confinedWorkspacesByRoot.get(rootKey);
  if (map === undefined) {
    const created = new Map<string, string>();
    confinedWorkspacesByRoot.set(rootKey, created);
    map = created;
    (ctx.root ?? ctx).on("tools/pre-execute", (call, env) => {
      const workspace = created.get(env.sessionId);
      if (workspace === undefined) return undefined;
      const lower = call.name.toLowerCase();
      if (lower !== "write" && lower !== "edit" && lower !== "apply_patch") return undefined;
      const permissions = ctx.get("permissions") as { rules?: { blockWriteOutsideWorkspace?: boolean } } | undefined;
      if (permissions?.rules?.blockWriteOutsideWorkspace === false) return undefined;
      const targets = extractWriteTargets(call.args);
      if (targets.length === 0) return { deny: true, reason: "Subagent write requires an explicit path inside the workspace" };
      const outside = targets.find((candidate) => !isInsideWorkspace(candidate, workspace));
      return outside === undefined ? undefined : { deny: true, reason: `Write outside workspace blocked by rule: ${outside}` };
    }, true);
  }
  map.set(sessionId, workspaceCwd);
  return () => { map.delete(sessionId); };
}

export function resolveSubagentAllowedTools(
  ctx: Context,
  permission: SubagentPermission,
  allowShell: boolean,
): string[] {
  const allowed = new Set<string>(READ_TOOLS);
  for (const def of ctx.tools.listDefinitions()) {
    if (def.readOnly === true && !SUBAGENT_META_TOOLS.has(def.name)) allowed.add(def.name);
  }
  if (permission === "workspace-write") {
    for (const toolName of WRITE_TOOLS) allowed.add(toolName);
    if (allowShell) {
      for (const toolName of SHELL_VERIFICATION_TOOLS) allowed.add(toolName);
    }
  }
  return [...allowed];
}

export async function spawnConfiguredChild(
  ctx: Context,
  parent: Session,
  input: SpawnChildInput,
  config: Config,
): Promise<SpawnChildResult> {
  const permissions = ctx.get("permissions") as {
    modes?(session: Session): { effective: string };
    set(session: Session, change: { permission: string; agentMode: string }): number;
  } | undefined;
  if (input.permission === "workspace-write" && permissions?.modes?.(parent).effective === "read-only") {
    return { ok: false, error: "Qianji read-only mode only permits read-only subagents" };
  }

  const roleOverride = config.roleModels?.[input.role];
  const parentState = parent.state();
  const model = roleOverride !== undefined
    ? { provider: roleOverride.provider, model: roleOverride.model }
    : (config.model ?? parentState.model);
  const effort = roleOverride?.effort ?? config.effort ?? (input.forkContext === true ? parentState.effort : undefined);
  if (model === undefined) return { ok: false, error: "The parent session has no model" };

  const useWorktree = input.permission === "workspace-write" && input.isolateWorktree === true;
  let prepared: PreparedWorktree | undefined;
  if (useWorktree) {
    const prep = await prepareIsolatedWorktree(parent.header.cwd, `${input.label}-${Date.now()}`, input.signal);
    if (!prep.ok) return { ok: false, error: prep.error };
    prepared = prep.worktree;
  }
  if (input.signal.aborted) {
    if (prepared !== undefined) await cleanupWorktree(prepared.repoRoot, prepared.wtRoot);
    return { ok: false, error: "Aborted" };
  }

  const sessionCwd = prepared !== undefined ? prepared.sessionCwd : parent.header.cwd;
  const seed = input.forkContext === true ? buildForkedContextSeed(parent) : { events: [] };
  const child = ctx.sessions.create({
    cwd: sessionCwd,
    parent: { sessionId: parent.id, callId: input.callId ?? "" },
    ...(seed.forkedFrom === undefined ? {} : { forkedFrom: seed.forkedFrom, events: seed.events }),
  });
  child.append("model", model);
  if (effort !== undefined) child.append("effort", { effort });
  child.append("label", { title: `${input.label} (${input.role})` });

  const allowShell = input.permission === "workspace-write" && input.allowShell === true && config.allowShell !== false;
  const ui = ctx.get("ui") as { canAsk(sessionId?: string): boolean; markUnattended(sessionId: string): () => void } | undefined;
  let disposeWorkspaceGuard: (() => void) | undefined;
  let disposeUnattended: (() => void) | undefined;

  if (allowShell) {
    permissions?.set(child, { permission: "full-access", agentMode: "agent" });
    disposeWorkspaceGuard = trackConfinedSubagentWorkspace(ctx, child.id, sessionCwd);
    disposeUnattended = ui?.markUnattended(child.id);
  } else {
    permissions?.set(child, { permission: input.permission, agentMode: "agent" });
    disposeUnattended = ui !== undefined && !ui.canAsk(parent.id) ? ui.markUnattended(child.id) : undefined;
  }

  const unrestrict = ctx.tools.restrict(child.id, resolveSubagentAllowedTools(ctx, input.permission, allowShell));
  return {
    ok: true,
    child,
    prepared,
    allowShell,
    disposeRestrictions: () => {
      unrestrict();
      disposeUnattended?.();
      disposeWorkspaceGuard?.();
    },
  };
}

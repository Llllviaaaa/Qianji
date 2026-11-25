/**
 * Permission modes, agent modes and tool rules (ADR 0009), on
 * `tools/pre-execute`. The decision logic is the Pi guard's (`rules.ts`);
 * this plugin supplies it with each session's modes and asks through `ui`
 * when a rule says to confirm. With no UI attached, a call that needs
 * confirmation is denied.
 *
 * A session's modes are `custom` events of namespace `pid-permissions`, so
 * they follow the branch and survive restarts.
 */
import { Context, Service } from "@deepseek-ai/cordis";
import { ErrorCode, type AppendResult, type PermissionGetResult } from "@qianji/protocol";
import { RpcError } from "@qianji/rpc";
import { latestCustom, type Session } from "@qianji/session";
import { SectionOrder } from "@qianji/system-prompt";
import "@qianji/tools";
import "@qianji/ui";
import {
  agentModeSystemInstructions,
  applyDesktopToolDefaults,
  evaluateToolPermission,
  normalizeAgentMode,
  normalizePermissionMode,
  parseToolRules,
  permissionForAgentMode,
  type AgentMode,
  type PermissionMode,
  type PermissionRules,
  type ToolPermissionRule,
} from "./rules.ts";

export * from "./rules.ts";

declare module "@deepseek-ai/cordis" {
  interface Context {
    permissions: Permissions;
  }
}

export const NAMESPACE = "qianji-permissions";
export const LEGACY_NAMESPACE = "pid-permissions";

const PERMISSION_MODES: readonly PermissionMode[] = ["read-only", "ask", "workspace-write", "full-access"];
const AGENT_MODES: readonly AgentMode[] = ["agent", "plan", "ask"];

export interface SessionModes {
  permission: PermissionMode;
  agentMode: AgentMode;
  /** What tool calls are judged by: read-only unless the agent mode is `agent`. */
  effective: PermissionMode;
}

export interface Config {
  defaultPermission?: PermissionMode;
  defaultAgentMode?: AgentMode;
  /** Default true. */
  alwaysConfirmShell?: boolean;
  /** Default true. */
  blockWriteOutsideWorkspace?: boolean;
  /** Default false: a shell `git push --force` (and the like) is blocked. */
  allowForcePush?: boolean;
  shellAllowPrefixes?: string[];
  toolRules?: ToolPermissionRule[];
}

export interface PermissionConfirmContext {
  sessionId: string;
  session?: Session;
  cwd: string;
  mode: PermissionMode;
  toolName: string;
  args: Record<string, unknown>;
  title: string;
  message: string;
  signal: AbortSignal;
}

export type PermissionConfirmOutcome =
  | boolean
  | { allowed: true }
  | { allowed: false; reason?: string };

export type PermissionConfirmHandler = (
  request: PermissionConfirmContext,
) => Promise<PermissionConfirmOutcome | undefined> | PermissionConfirmOutcome | undefined;

/** Rules from config, with the guard's defaults; tool rules go through the guard's own validation. */
export function rulesFromConfig(config: Config): PermissionRules {
  return {
    alwaysConfirmShell: config.alwaysConfirmShell !== false,
    blockWriteOutsideWorkspace: config.blockWriteOutsideWorkspace !== false,
    allowForcePush: config.allowForcePush === true,
    shellAllowPrefixes: (config.shellAllowPrefixes ?? []).map((prefix) => prefix.trim()).filter(Boolean),
    toolRules: parseToolRules(Buffer.from(JSON.stringify(config.toolRules ?? [])).toString("base64")),
  };
}

export class Permissions extends Service {
  static inject = ["sessions", "tools", "ui", "systemPrompt"];
  static provide = "permissions";

  readonly rules: PermissionRules;
  private readonly confirmHandlers: PermissionConfirmHandler[] = [];

  constructor(ctx: Context, private readonly config: Config = {}) {
    super(ctx, "permissions");
    this.rules = rulesFromConfig(config);
    const protectedPids = new Set<number>(
      [process.pid, process.ppid].filter((pid): pid is number => Number.isInteger(pid) && pid > 1),
    );

    // Prepended, so permissions decide before hooks and other listeners even
    // after a reload re-registers this plugin last.
    ctx.on("tools/pre-execute", async (call, env) => {
      applyDesktopToolDefaults(call.name, call.args);
      const session = await ctx.sessions.get(env.sessionId);
      const mode = session === undefined ? this.defaultModes().effective : this.modes(session).effective;
      const toolDef = ctx.tools.get(call.name);
      const decision = evaluateToolPermission({
        mode,
        rules: this.rules,
        workspace: env.cwd,
        toolName: call.name,
        input: call.args,
        protectedPids,
        readOnlyTool: toolDef?.readOnly === true,
      });
      if (decision.action === "allow") return undefined;
      if (decision.action === "block") return { deny: true, reason: decision.reason };
      if (!ctx.ui.canAsk(env.sessionId)) return { deny: true, reason: "Confirmation required but no UI is available" };

      for (let i = this.confirmHandlers.length - 1; i >= 0; i -= 1) {
        const handler = this.confirmHandlers[i];
        if (handler === undefined) continue;
        const outcome = await handler({
          sessionId: env.sessionId,
          ...(session === undefined ? {} : { session }),
          cwd: env.cwd,
          mode,
          toolName: call.name,
          args: call.args,
          title: decision.title,
          message: decision.message,
          signal: env.signal,
        });
        if (outcome === undefined) continue;
        if (outcome === true) return undefined;
        if (outcome === false) return { deny: true, reason: `${decision.title} denied by user` };
        if (outcome.allowed) return undefined;
        const customReason = outcome.reason?.trim();
        return {
          deny: true,
          reason: customReason !== undefined && customReason !== "" ? customReason : `${decision.title} denied by user`,
        };
      }

      const allowed = await ctx.ui.confirm(env.sessionId, decision.title, decision.message, env.signal);
      return allowed ? undefined : { deny: true, reason: `${decision.title} denied by user` };
    }, true);

    ctx.effect(() => ctx.systemPrompt.section("agent-mode", async ({ sessionId }) => {
      const session = await ctx.sessions.get(sessionId);
      return agentModeSystemInstructions(session === undefined ? this.defaultModes().agentMode : this.modes(session).agentMode);
    }, { order: SectionOrder.guidelines + 10 }), "permissions: agent-mode section");

    ctx.inject(["rpc"], (rpcCtx) => {
      const resolveSession = async (params: unknown): Promise<{ target: Session; p: Record<string, unknown> }> => {
        const p = (typeof params === "object" && params !== null ? params : {}) as Record<string, unknown>;
        if (typeof p.sessionId !== "string") throw new RpcError(ErrorCode.InvalidParams, "sessionId must be a string");
        const target = await rpcCtx.sessions.get(p.sessionId);
        if (target === undefined) throw new RpcError(ErrorCode.SessionNotFound, `No session ${p.sessionId}`);
        return { target, p };
      };

      rpcCtx.effect(
        () => rpcCtx.rpc.method("permission.get", async (params): Promise<PermissionGetResult> =>
          this.modes((await resolveSession(params)).target),
        ),
        "permissions: permission.get",
      );

      rpcCtx.effect(
        () => rpcCtx.rpc.method("permission.set", async (params): Promise<AppendResult> => {
          const { target, p } = await resolveSession(params);
          if (p.permission !== undefined && !PERMISSION_MODES.includes(p.permission as PermissionMode)) {
            throw new RpcError(ErrorCode.InvalidParams, `permission must be one of ${PERMISSION_MODES.join(", ")}`);
          }
          if (p.agentMode !== undefined && !AGENT_MODES.includes(p.agentMode as AgentMode)) {
            throw new RpcError(ErrorCode.InvalidParams, `agentMode must be one of ${AGENT_MODES.join(", ")}`);
          }
          return {
            seq: this.set(target, {
              ...(p.permission === undefined ? {} : { permission: normalizePermissionMode(p.permission as string) }),
              ...(p.agentMode === undefined ? {} : { agentMode: normalizeAgentMode(p.agentMode as string) }),
            }),
          };
        }),
        "permissions: permission.set",
      );
    });
  }

  defaultModes(): SessionModes {
    const permission = normalizePermissionMode(this.config.defaultPermission);
    const agentMode = normalizeAgentMode(this.config.defaultAgentMode);
    return { permission, agentMode, effective: permissionForAgentMode(agentMode, permission) };
  }

  defaultModesForSession(session?: Session): SessionModes {
    if (session?.header.side === true) {
      return { permission: "read-only", agentMode: "ask", effective: "read-only" };
    }
    return this.defaultModes();
  }

  modes(session: Session): SessionModes {
    const defaults = this.defaultModesForSession(session);
    const minSeq = session.header.side === true ? (session.header.forkedFrom?.seq ?? 0) : 0;
    const events = minSeq > 0 ? session.events.filter((event) => event.seq > minSeq) : session.events;
    const stored = latestCustom<{ permission?: string; agentMode?: string }>(events, [NAMESPACE, LEGACY_NAMESPACE]);
    const permission = stored?.permission === undefined ? defaults.permission : normalizePermissionMode(stored.permission);
    const agentMode = stored?.agentMode === undefined ? defaults.agentMode : normalizeAgentMode(stored.agentMode);
    return { permission, agentMode, effective: permissionForAgentMode(agentMode, permission) };
  }

  /** Change a session's modes; returns the appended event's seq. */
  set(session: Session, change: { permission?: PermissionMode; agentMode?: AgentMode }): number {
    const current = this.modes(session);
    return session.append("custom", {
      ns: NAMESPACE,
      data: { permission: change.permission ?? current.permission, agentMode: change.agentMode ?? current.agentMode },
    }).seq;
  }

  /**
   * Register a custom interactive confirmation handler (e.g. from the built-in
   * `permission` plugin for session-scoped grants, always-allow rules, and deny
   * feedback). Hard caps (`read-only`, workspace confinement, self-kill, force-push,
   * and explicit `block` rules) are always evaluated first.
   */
  registerConfirmHandler(handler: PermissionConfirmHandler): () => void {
    this.confirmHandlers.push(handler);
    let disposed = false;
    const remove = (): void => {
      if (disposed) return;
      disposed = true;
      const idx = this.confirmHandlers.lastIndexOf(handler);
      if (idx >= 0) this.confirmHandlers.splice(idx, 1);
    };
    if (this.ctx?.fiber?.uid != null && this.ctx.fiber.state !== 5) {
      try {
        return this.ctx.effect(() => remove, "permissions.registerConfirmHandler") as unknown as () => void;
      } catch {
        return remove;
      }
    }
    return remove;
  }
}

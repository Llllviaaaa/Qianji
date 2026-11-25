import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Context } from "@deepseek-ai/cordis";
import "@qianji/commands";
import { ErrorCode } from "@qianji/protocol";
import { RpcError } from "@qianji/rpc";
import { currentBranch, latestCustom, type Session } from "@qianji/session";
import { SectionOrder } from "@qianji/system-prompt";
import { textOutput, type ToolDefinition } from "@qianji/tools";
import "@qianji/ui";
import {
  CORE_PERMISSIONS_NAMESPACE,
  LEGACY_PERMISSIONS_NAMESPACE,
  PERMISSION_GRANTS_NAMESPACE,
  PERMISSION_PLACEHOLDER,
  assessPermissionRisk,
  deriveSuggestedGrant,
  extractPrimaryPath,
  extractShellCommand,
  isRecord,
  matchesGrantRules,
  parsePermissionResponse,
  serializePermissionEnvelope,
  type AgentModeValue,
  type PermissionGrantRule,
  type PermissionGrantSpec,
  type PermissionInspectResult,
  type PermissionModeValue,
  type PermissionPromptEnvelope,
  type RequestPermissionResultPayload,
} from "./shared.ts";

export const name = "permission";
export const inject = ["tools", "ui", "sessions", "commands", "rpc", "systemPrompt", "hostInfo"];

export interface PermissionPluginConfig {
  enableSessionGrants?: boolean;
  enableAlwaysAllow?: boolean;
  enableDenyFeedback?: boolean;
  enableRequestTool?: boolean;
  showRiskLevelBadge?: boolean;
}

const VALID_PERMISSIONS: readonly PermissionModeValue[] = [
  "read-only",
  "ask",
  "workspace-write",
  "full-access",
];
const VALID_AGENT_MODES: readonly AgentModeValue[] = ["agent", "plan", "ask"];

export const PERMISSION_SYSTEM_PROMPT = `Proactive Permission Requests (\`request_permission\`):
- If the session is in \`plan\`, \`ask\`, or \`read-only\` mode and you have finished planning or investigating and are ready to edit files or run commands, call \`request_permission\` with \`scope: "mode"\` and a concise \`reason\` to ask the user to switch into executable \`agent\` / \`workspace-write\` mode instead of telling them to click UI menus manually.
- Before running a repeated verification command (e.g. \`npm test\`, \`cargo check\`) across multiple iterations, you may call \`request_permission\` with \`scope: "tool"\` to request a session-scoped grant.`;

function alwaysRulesFilePath(dataDir: string): string {
  return join(dataDir, "permission-plugin-rules.json");
}

function readAlwaysRules(dataDir: string): PermissionGrantRule[] {
  const file = alwaysRulesFilePath(dataDir);
  if (!existsSync(file)) return [];
  try {
    const parsed: unknown = JSON.parse(readFileSync(file, "utf8"));
    if (!isRecord(parsed) || !Array.isArray(parsed.rules)) return [];
    return parsed.rules.filter(
      (item): item is PermissionGrantRule =>
        isRecord(item) &&
        typeof item.id === "string" &&
        typeof item.toolPattern === "string" &&
        typeof item.label === "string",
    );
  } catch {
    return [];
  }
}

function writeAlwaysRules(dataDir: string, rules: readonly PermissionGrantRule[]): void {
  const file = alwaysRulesFilePath(dataDir);
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify({ version: 1, rules }, null, 2)}\n`, "utf8");
  renameSync(tmp, file);
}

function deduplicateRuleList(rules: readonly PermissionGrantRule[]): PermissionGrantRule[] {
  const seen = new Set<string>();
  const out: PermissionGrantRule[] = [];
  for (const rule of rules) {
    const sig = `${rule.toolPattern}::${rule.commandPrefix ?? ""}::${rule.exactCommand ?? ""}::${rule.pathPrefix ?? ""}`;
    if (seen.has(sig)) continue;
    seen.add(sig);
    out.push(rule);
  }
  return out;
}

export function reconstructSessionGrants(session: Session): PermissionGrantRule[] {
  const list: PermissionGrantRule[] = [];
  for (const event of currentBranch(session.events)) {
    if (event.type !== "custom" || event.data.ns !== PERMISSION_GRANTS_NAMESPACE) continue;
    const payload = event.data.data;
    if (!isRecord(payload)) continue;
    if (payload.action === "clear") {
      list.length = 0;
      continue;
    }
    if (payload.action === "revoke" && typeof payload.grantId === "string") {
      const idx = list.findIndex((item) => item.id === payload.grantId);
      if (idx >= 0) list.splice(idx, 1);
      continue;
    }
    if (payload.action === "grant" && isRecord(payload.rule)) {
      const rule = payload.rule as unknown as PermissionGrantRule;
      if (typeof rule.id === "string" && typeof rule.toolPattern === "string") {
        list.push(rule);
      }
    }
  }
  return deduplicateRuleList(list);
}

function resolveSessionModes(
  ctx: Context,
  session: Session | undefined,
): { permission: PermissionModeValue; agentMode: AgentModeValue; effective: PermissionModeValue } {
  const perms = ctx.get("permissions");
  if (perms !== undefined) {
    return session !== undefined ? perms.modes(session) : perms.defaultModes();
  }
  if (session === undefined) {
    return { permission: "ask", agentMode: "agent", effective: "ask" };
  }
  const stored = latestCustom<{ permission?: string; agentMode?: string }>(session.events, [
    CORE_PERMISSIONS_NAMESPACE,
    LEGACY_PERMISSIONS_NAMESPACE,
  ]);
  const permission: PermissionModeValue = VALID_PERMISSIONS.includes(stored?.permission as PermissionModeValue)
    ? (stored?.permission as PermissionModeValue)
    : "ask";
  const agentMode: AgentModeValue = VALID_AGENT_MODES.includes(stored?.agentMode as AgentModeValue)
    ? (stored?.agentMode as AgentModeValue)
    : "agent";
  const effective: PermissionModeValue = agentMode === "agent" ? permission : "read-only";
  return { permission, agentMode, effective };
}

function updateSessionModes(
  ctx: Context,
  session: Session,
  change: { permission?: PermissionModeValue; agentMode?: AgentModeValue },
): void {
  const perms = ctx.get("permissions");
  if (perms !== undefined) {
    perms.set(session, change);
    return;
  }
  const current = resolveSessionModes(ctx, session);
  session.append("custom", {
    ns: CORE_PERMISSIONS_NAMESPACE,
    data: {
      permission: change.permission ?? current.permission,
      agentMode: change.agentMode ?? current.agentMode,
    },
  });
}

function makeGrantRule(spec: PermissionGrantSpec): PermissionGrantRule {
  return {
    ...spec,
    id: `pgrant_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
    createdAt: Date.now(),
  };
}

export function apply(ctx: Context, config: PermissionPluginConfig = {}): void {
  const dataDir = ctx.hostInfo.dataDir;
  let alwaysRules: PermissionGrantRule[] = readAlwaysRules(dataDir);
  const ephemeralGrants = new Map<string, PermissionGrantRule[]>();

  const getSessionGrants = (sessionId: string, session?: Session): PermissionGrantRule[] => {
    const persisted = session !== undefined ? reconstructSessionGrants(session) : [];
    const transient = ephemeralGrants.get(sessionId) ?? [];
    return deduplicateRuleList([...persisted, ...transient]);
  };

  const recordSessionGrant = (sessionId: string, session: Session | undefined, spec: PermissionGrantSpec): PermissionGrantRule => {
    const rule = makeGrantRule(spec);
    if (session !== undefined) {
      session.append("custom", {
        ns: PERMISSION_GRANTS_NAMESPACE,
        data: { action: "grant", rule },
      });
    } else {
      const existing = ephemeralGrants.get(sessionId) ?? [];
      ephemeralGrants.set(sessionId, deduplicateRuleList([...existing, rule]));
    }
    return rule;
  };

  const recordAlwaysRule = (spec: PermissionGrantSpec): PermissionGrantRule => {
    const rule = makeGrantRule(spec);
    alwaysRules = deduplicateRuleList([...alwaysRules, rule]);
    writeAlwaysRules(dataDir, alwaysRules);
    return rule;
  };

  ctx.effect(() => ctx.on("session/deleted", (id) => void ephemeralGrants.delete(id)), `${name}: cleanup deleted`);
  ctx.effect(() => ctx.on("session/unloaded", (id) => void ephemeralGrants.delete(id)), `${name}: cleanup unloaded`);

  // 1. Upgrade core Permissions confirm prompt with Session Grants, Always Allow, and Deny Feedback
  ctx.inject(["permissions"], (permCtx) => {
    permCtx.effect(
      () =>
        permCtx.permissions.registerConfirmHandler(async (req) => {
          const activeSessionGrants =
            config.enableSessionGrants !== false ? getSessionGrants(req.sessionId, req.session) : [];
          const activeAlwaysRules = config.enableAlwaysAllow !== false ? alwaysRules : [];
          const combinedRules = [...activeAlwaysRules, ...activeSessionGrants];

          const matched = matchesGrantRules(combinedRules, req.toolName, req.args, req.cwd);
          if (matched !== undefined) {
            return { allowed: true };
          }

          const command = extractShellCommand(req.args);
          const targetPath = extractPrimaryPath(req.args);
          const { riskLevel, riskLabel } = assessPermissionRisk({
            toolName: req.toolName,
            command,
            message: req.message,
          });
          const { spec, allowAlways } = deriveSuggestedGrant(req.toolName, req.args, req.cwd);

          const envelope: PermissionPromptEnvelope = {
            source: "tool_guard",
            title: req.title,
            message: req.message,
            toolName: req.toolName,
            ...(command === undefined ? {} : { command }),
            ...(targetPath === undefined ? {} : { targetPath }),
            cwd: req.cwd,
            riskLevel,
            riskLabel,
            showRiskBadge: config.showRiskLevelBadge !== false,
            suggestedGrant: spec,
            allowSessionOption: config.enableSessionGrants !== false,
            allowAlwaysOption: config.enableAlwaysAllow !== false && allowAlways,
            allowDenyFeedback: config.enableDenyFeedback !== false,
          };

          const rawAnswer = await permCtx.ui.ask(
            req.sessionId,
            {
              kind: "input",
              title: serializePermissionEnvelope(envelope),
              placeholder: PERMISSION_PLACEHOLDER,
            },
            req.signal,
          );

          const response = parsePermissionResponse(rawAnswer);
          if (response.decision === "allow_once") {
            return { allowed: true };
          }
          if (response.decision === "allow_session") {
            if (config.enableSessionGrants !== false) {
              recordSessionGrant(req.sessionId, req.session, spec);
            }
            return { allowed: true };
          }
          if (response.decision === "allow_always") {
            if (config.enableAlwaysAllow !== false && allowAlways) {
              recordAlwaysRule(spec);
            }
            if (config.enableSessionGrants !== false) {
              recordSessionGrant(req.sessionId, req.session, spec);
            }
            return { allowed: true };
          }

          const reason = response.feedback
            ? `${req.title} denied by user — User guidance: ${response.feedback}`
            : `${req.title} denied by user`;
          return { allowed: false, reason };
        }),
      `${name}: confirmHandler`,
    );
  });

  // 2. Register `request_permission` proactive tool for Agent mode transitions & pre-approvals
  if (config.enableRequestTool !== false) {
    const requestPermissionTool: ToolDefinition<Record<string, unknown>> = {
      name: "request_permission",
      description:
        "Proactively request user approval to switch session permission/agent mode (e.g. exiting Plan/read-only mode into Agent workspace-write) or pre-authorize a tool/command prefix for the current session.",
      readOnly: true,
      timeoutMs: 0,
      parameters: {
        type: "object",
        properties: {
          scope: {
            type: "string",
            enum: ["mode", "tool"],
            description: "'mode' to switch session agentMode/permissionMode; 'tool' to pre-authorize a tool or command prefix.",
          },
          reason: {
            type: "string",
            description: "Clear, concise explanation shown to the user for why this permission is needed.",
          },
          requestedAgentMode: {
            type: "string",
            enum: ["agent", "plan", "ask"],
            description: "Target agent mode when scope is 'mode' (typically 'agent').",
          },
          requestedPermission: {
            type: "string",
            enum: ["read-only", "ask", "workspace-write", "full-access"],
            description: "Target permission mode when scope is 'mode' (typically 'workspace-write').",
          },
          toolName: {
            type: "string",
            description: "Tool name to pre-authorize when scope is 'tool' (e.g. 'bash', 'write').",
          },
          commandPrefix: {
            type: "string",
            description: "Safe shell command prefix to pre-authorize when toolName is 'bash' (e.g. 'npm test').",
          },
          pathPrefix: {
            type: "string",
            description: "Relative workspace directory prefix when toolName is 'write'/'edit' (e.g. 'src').",
          },
        },
        required: ["reason"],
      },
      async execute(args, env) {
        const reason = typeof args.reason === "string" ? args.reason.trim() : "";
        if (reason === "") {
          return textOutput("Invalid arguments for request_permission: `reason` must be a non-empty string.", true);
        }

        const requestedPermission = VALID_PERMISSIONS.includes(args.requestedPermission as PermissionModeValue)
          ? (args.requestedPermission as PermissionModeValue)
          : undefined;
        const requestedAgentMode = VALID_AGENT_MODES.includes(args.requestedAgentMode as AgentModeValue)
          ? (args.requestedAgentMode as AgentModeValue)
          : undefined;
        const scope: "mode" | "tool" =
          args.scope === "tool" || (args.scope !== "mode" && !requestedPermission && !requestedAgentMode && typeof args.toolName === "string")
            ? "tool"
            : "mode";

        const session = await ctx.sessions.get(env.sessionId);

        if (!ctx.ui.canAsk(env.sessionId)) {
          const unattended: RequestPermissionResultPayload = {
            status: "unattended",
            scope,
            reason,
            message: "No interactive UI is available to approve permission elevation in this session.",
          };
          return {
            content: [{ type: "text", text: JSON.stringify(unattended, null, 2) }],
            details: unattended,
            isError: true,
          };
        }

        if (scope === "mode") {
          const targetPerm = requestedPermission ?? "workspace-write";
          const targetAgent = requestedAgentMode ?? "agent";
          const { riskLevel, riskLabel } = assessPermissionRisk({ requestedPermission: targetPerm });
          const summaryLines = [
            `申请切换工作模式为 **${targetAgent}**，执行权限为 **${targetPerm}**`,
            `原因：${reason}`,
          ];
          const envelope: PermissionPromptEnvelope = {
            source: "agent_request",
            title: "智能体申请切换执行权限",
            message: summaryLines.join("\n"),
            cwd: env.cwd,
            reason,
            requestedPermission: targetPerm,
            requestedAgentMode: targetAgent,
            riskLevel,
            riskLabel,
            showRiskBadge: config.showRiskLevelBadge !== false,
            allowSessionOption: false,
            allowAlwaysOption: false,
            allowDenyFeedback: config.enableDenyFeedback !== false,
          };

          const rawAnswer = await ctx.ui.ask(
            env.sessionId,
            {
              kind: "input",
              title: serializePermissionEnvelope(envelope),
              placeholder: PERMISSION_PLACEHOLDER,
            },
            env.signal,
          );
          const response = parsePermissionResponse(rawAnswer);

          if (response.decision === "deny") {
            const denied: RequestPermissionResultPayload = {
              status: "denied",
              scope: "mode",
              decision: "deny",
              reason,
              requestedPermission: targetPerm,
              requestedAgentMode: targetAgent,
              ...(response.feedback === undefined ? {} : { feedback: response.feedback }),
              message: response.feedback
                ? `User denied mode change with feedback: ${response.feedback}`
                : "User denied the requested permission mode change.",
            };
            return {
              content: [{ type: "text", text: JSON.stringify(denied, null, 2) }],
              details: denied,
            };
          }

          if (session !== undefined) {
            updateSessionModes(ctx, session, { permission: targetPerm, agentMode: targetAgent });
          }

          const granted: RequestPermissionResultPayload = {
            status: "granted",
            scope: "mode",
            decision: response.decision,
            reason,
            requestedPermission: targetPerm,
            requestedAgentMode: targetAgent,
            message: `User approved mode change: agentMode='${targetAgent}', permission='${targetPerm}'. You may now proceed.`,
          };
          return {
            content: [{ type: "text", text: JSON.stringify(granted, null, 2) }],
            details: granted,
          };
        }

        // scope === "tool"
        const rawToolName = typeof args.toolName === "string" && args.toolName.trim() !== "" ? args.toolName.trim() : "bash";
        const cmdPrefix = typeof args.commandPrefix === "string" && args.commandPrefix.trim() !== "" ? args.commandPrefix.trim() : undefined;
        const pathPrefix = typeof args.pathPrefix === "string" && args.pathPrefix.trim() !== "" ? args.pathPrefix.trim() : undefined;

        const syntheticArgs: Record<string, unknown> = {
          ...(cmdPrefix === undefined ? {} : { command: cmdPrefix }),
          ...(pathPrefix === undefined ? {} : { path: pathPrefix }),
        };
        const derived = deriveSuggestedGrant(rawToolName, syntheticArgs, env.cwd);
        const spec: PermissionGrantSpec =
          cmdPrefix !== undefined
            ? {
                toolPattern: "bash|powershell|shell|exec",
                commandPrefix: cmdPrefix,
                label: `命令前缀 "${cmdPrefix}"`,
              }
            : pathPrefix !== undefined
              ? {
                  toolPattern: "write|edit|apply_patch",
                  pathPrefix,
                  label: `${pathPrefix}/ 目录文件编辑`,
                }
              : derived.spec;

        const { riskLevel, riskLabel } = assessPermissionRisk({
          toolName: rawToolName,
          command: cmdPrefix,
        });

        const envelope: PermissionPromptEnvelope = {
          source: "agent_request",
          title: `智能体申请预授权：${spec.label}`,
          message: cmdPrefix ?? pathPrefix ?? rawToolName,
          toolName: rawToolName,
          ...(cmdPrefix === undefined ? {} : { command: cmdPrefix }),
          ...(pathPrefix === undefined ? {} : { targetPath: pathPrefix }),
          cwd: env.cwd,
          reason,
          riskLevel,
          riskLabel,
          showRiskBadge: config.showRiskLevelBadge !== false,
          suggestedGrant: spec,
          allowSessionOption: config.enableSessionGrants !== false,
          allowAlwaysOption: config.enableAlwaysAllow !== false && derived.allowAlways,
          allowDenyFeedback: config.enableDenyFeedback !== false,
        };

        const rawAnswer = await ctx.ui.ask(
          env.sessionId,
          {
            kind: "input",
            title: serializePermissionEnvelope(envelope),
            placeholder: PERMISSION_PLACEHOLDER,
          },
          env.signal,
        );
        const response = parsePermissionResponse(rawAnswer);

        if (response.decision === "deny") {
          const denied: RequestPermissionResultPayload = {
            status: "denied",
            scope: "tool",
            decision: "deny",
            reason,
            grantLabel: spec.label,
            ...(response.feedback === undefined ? {} : { feedback: response.feedback }),
            message: response.feedback
              ? `User denied tool pre-authorization with feedback: ${response.feedback}`
              : "User denied the requested tool pre-authorization.",
          };
          return {
            content: [{ type: "text", text: JSON.stringify(denied, null, 2) }],
            details: denied,
          };
        }

        if (response.decision === "allow_always" && config.enableAlwaysAllow !== false && derived.allowAlways) {
          recordAlwaysRule(spec);
        }
        recordSessionGrant(env.sessionId, session, spec);

        const granted: RequestPermissionResultPayload = {
          status: "granted",
          scope: "tool",
          decision: response.decision,
          reason,
          grantLabel: spec.label,
          message: `User pre-authorized ${spec.label} (${response.decision}).`,
        };
        return {
          content: [{ type: "text", text: JSON.stringify(granted, null, 2) }],
          details: granted,
        };
      },
    };

    ctx.effect(() => ctx.tools.register(requestPermissionTool), `${name}: tool request_permission`);
    ctx.effect(
      () =>
        ctx.systemPrompt.section(
          "permission-request-guidance",
          ({ tools }) => (tools.some((t) => t.name === "request_permission") ? PERMISSION_SYSTEM_PROMPT : undefined),
          { order: SectionOrder.guidelines + 23 },
        ),
      `${name}: system-prompt`,
    );
  }

  // 3. Slash commands `/permission` and `/permissions`
  const executePermissionCommand = async (
    rawArgs: string,
    env: { sessionId?: string },
  ): Promise<{ output: string; isError?: boolean }> => {
    const session = env.sessionId ? await ctx.sessions.get(env.sessionId) : undefined;
    const tokens = rawArgs.trim().split(/\s+/).filter(Boolean);
    const sub = (tokens[0] ?? "").toLowerCase();

    if (sub === "" || sub === "status" || sub === "list") {
      const modes = resolveSessionModes(ctx, session);
      const sGrants = env.sessionId ? getSessionGrants(env.sessionId, session) : [];
      const lines = [
        "### 当前权限与授权状态",
        "",
        `- **工作模式 (Agent Mode)**：\`${modes.agentMode}\``,
        `- **配置权限 (Permission)**：\`${modes.permission}\``,
        `- **当前生效权限 (Effective)**：\`${modes.effective}\``,
        `- **本会话临时放行规则**：${sGrants.length} 条${sGrants.length > 0 ? `（${sGrants.map((g) => g.label).join("、")}）` : ""}`,
        `- **持久始终允许规则**：${alwaysRules.length} 条${alwaysRules.length > 0 ? `（${alwaysRules.map((g) => g.label).join("、")}）` : ""}`,
        "",
        "> 用法：`/permission <read-only|ask|workspace-write|full-access>` 切换权限，`/permission mode <agent|plan|ask>` 切换工作模式，`/permission clear` 清空本会话临时授权。",
      ];
      return { output: lines.join("\n") };
    }

    if (sub === "clear" || sub === "reset") {
      if (!env.sessionId || !session) {
        return { output: "当前尚未创建会话，无需清理会话级临时授权。" };
      }
      ephemeralGrants.delete(env.sessionId);
      session.append("custom", { ns: PERMISSION_GRANTS_NAMESPACE, data: { action: "clear" } });
      return { output: "已清空当前会话的全部「本会话允许」临时授权记录。" };
    }

    if (sub === "mode") {
      const targetMode = (tokens[1] ?? "").toLowerCase() as AgentModeValue;
      if (!VALID_AGENT_MODES.includes(targetMode)) {
        return { output: "用法：`/permission mode <agent|plan|ask>`", isError: true };
      }
      if (!session) return { output: "请先发送一条消息创建会话后再切换模式。", isError: true };
      updateSessionModes(ctx, session, { agentMode: targetMode });
      return { output: `已将当前会话工作模式切换为 \`${targetMode}\`。` };
    }

    if (VALID_PERMISSIONS.includes(sub as PermissionModeValue)) {
      if (!session) return { output: "请先发送一条消息创建会话后再切换权限。", isError: true };
      updateSessionModes(ctx, session, { permission: sub as PermissionModeValue });
      return { output: `已将当前会话执行权限切换为 \`${sub}\`。` };
    }

    return {
      output:
        "未知子命令。可用：`/permission status`、`/permission <read-only|ask|workspace-write|full-access>`、`/permission mode <agent|plan|ask>`、`/permission clear`。",
      isError: true,
    };
  };

  for (const cmdName of ["permission", "permissions"] as const) {
    ctx.effect(
      () =>
        ctx.commands.register({
          name: cmdName,
          description: "查看或切换当前会话权限模式、工作模式与「本会话允许」临时白名单",
          argsHint: "[status | ask | workspace-write | full-access | read-only | mode <agent|plan|ask> | clear]",
          source: "plugin",
          execute: (rawArgs, env) => executePermissionCommand(rawArgs, env),
        }),
      `${name}: /${cmdName}`,
    );
  }

  // 4. JSON-RPC endpoints for Settings / UI inspection & revocation
  ctx.effect(
    () =>
      ctx.rpc.method("permissionPlugin.inspect", async (params): Promise<PermissionInspectResult> => {
        const p = isRecord(params) ? params : {};
        const sessionId = typeof p.sessionId === "string" && p.sessionId.trim() !== "" ? p.sessionId.trim() : undefined;
        const session = sessionId !== undefined ? await ctx.sessions.get(sessionId) : undefined;
        return {
          modes: resolveSessionModes(ctx, session),
          sessionGrants: sessionId !== undefined ? getSessionGrants(sessionId, session) : [],
          alwaysRules: [...alwaysRules],
        };
      }),
    `${name}: permissionPlugin.inspect`,
  );

  ctx.effect(
    () =>
      ctx.rpc.method("permissionPlugin.revokeSessionGrant", async (params) => {
        const p = isRecord(params) ? params : {};
        if (typeof p.sessionId !== "string" || p.sessionId.trim() === "") {
          throw new RpcError(ErrorCode.InvalidParams, "sessionId must be a non-empty string");
        }
        const sessionId = p.sessionId.trim();
        const session = await ctx.sessions.get(sessionId);
        const grantId = typeof p.grantId === "string" && p.grantId.trim() !== "" ? p.grantId.trim() : undefined;

        if (grantId === undefined) {
          ephemeralGrants.delete(sessionId);
          session?.append("custom", { ns: PERMISSION_GRANTS_NAMESPACE, data: { action: "clear" } });
        } else {
          const prev = ephemeralGrants.get(sessionId);
          if (prev !== undefined) {
            ephemeralGrants.set(
              sessionId,
              prev.filter((item) => item.id !== grantId),
            );
          }
          session?.append("custom", {
            ns: PERMISSION_GRANTS_NAMESPACE,
            data: { action: "revoke", grantId },
          });
        }
        return {
          sessionGrants: getSessionGrants(sessionId, session),
        };
      }),
    `${name}: permissionPlugin.revokeSessionGrant`,
  );

  ctx.effect(
    () =>
      ctx.rpc.method("permissionPlugin.removeAlwaysRule", async (params) => {
        const p = isRecord(params) ? params : {};
        const ruleId = typeof p.ruleId === "string" && p.ruleId.trim() !== "" ? p.ruleId.trim() : undefined;
        if (ruleId === undefined) {
          alwaysRules = [];
        } else {
          alwaysRules = alwaysRules.filter((item) => item.id !== ruleId);
        }
        writeAlwaysRules(dataDir, alwaysRules);
        return { alwaysRules: [...alwaysRules] };
      }),
    `${name}: permissionPlugin.removeAlwaysRule`,
  );
}

export default {
  name,
  inject,
  apply,
};

/**
 * The `update_plan` tool (ADR 0009): the model keeps a visible step list for
 * multi-step work. The plan is a `custom` event of namespace `pid-plan`, so
 * it follows the session branch; each change also goes out live as a
 * `{ type: "plan", plan }` delta for the UI.
 */
import type { Context } from "@deepseek-ai/cordis";
import "@qianji/agent";
import "@qianji/commands";
import { ErrorCode, type PlanGetResult } from "@qianji/protocol";
import { RpcError } from "@qianji/rpc";
import { currentBranch, customEvents, latestCustom, type Session } from "@qianji/session";
import { textOutput, type ToolDefinition } from "@qianji/tools";
import { validatePlanState, type PlanItemStatus, type PlanState } from "./core.ts";

export * from "./core.ts";

export const name = "qianji-plan";
export const inject = ["sessions", "tools"];
export const NAMESPACE = "qianji-plan";
export const LEGACY_NAMESPACE = "pid-plan";
export const DRIFT_REMINDER_EVENT_THRESHOLD = 12;

const EMPTY: PlanState = { explanation: "", items: [] };

/** The session's plan on its current branch; an unreadable one counts as empty. */
export function planOf(session: Session): PlanState {
  const stored = latestCustom<PlanState>(session.events, [NAMESPACE, LEGACY_NAMESPACE]);
  return parsePlanEventData(stored) ?? EMPTY;
}

export function setPlan(session: Session, plan: PlanState): PlanState {
  const valid = validatePlanState(plan);
  session.append("custom", { ns: NAMESPACE, data: valid });
  session.delta({ type: "plan", plan: valid });
  return valid;
}

export function planTool(ctx: Context): ToolDefinition<{ explanation?: string; items: Array<{ id: string; text: string; status: PlanItemStatus }> }> {
  return {
    name: "update_plan",
    description: [
      "Create or replace the current session plan and its step statuses.",
      "Use it for work with several meaningful steps and keep statuses current as work progresses: exactly one in_progress step while executing; mark finished steps completed before advancing.",
      "Do not use a plan for a single trivial action. An empty list clears the plan.",
    ].join(" "),
    parameters: {
      type: "object",
      properties: {
        explanation: { type: "string", description: "Why the plan changed" },
        items: {
          type: "array",
          maxItems: 50,
          items: {
            type: "object",
            properties: {
              id: { type: "string", description: "Stable short id for this step" },
              text: { type: "string", description: "Concrete, verifiable step" },
              status: { type: "string", enum: ["pending", "in_progress", "completed"] },
            },
            required: ["id", "text", "status"],
          },
        },
      },
      required: ["items"],
    },
    async execute({ explanation, items }, env) {
      const session = await ctx.sessions.get(env.sessionId);
      if (session === undefined) return textOutput("No session to keep a plan in.", true);
      const plan = setPlan(session, { explanation: explanation ?? "", items });
      const completed = plan.items.filter((item) => item.status === "completed").length;
      return {
        content: [{ type: "text", text: plan.items.length > 0 ? `Plan updated: ${completed}/${plan.items.length} steps completed.` : "Plan cleared." }],
        details: plan,
      };
    },
  };
}

export function formatPlanMarkdown(plan: PlanState): string {
  if (plan.items.length === 0) return "当前会话暂无执行计划。";
  const marker = (status: PlanItemStatus) => (status === "completed" ? "[x]" : status === "in_progress" ? "[>]" : "[ ]");
  const lines = ["### 当前任务计划", ""];
  if (plan.explanation.trim()) {
    lines.push(plan.explanation.trim(), "");
  }
  for (const item of plan.items) {
    lines.push(`- \`${marker(item.status)}\` ${item.text}`);
  }
  return lines.join("\n");
}

export function formatPlanPromptSection(plan: PlanState): string | undefined {
  if (plan.items.length === 0) return undefined;
  const remaining = plan.items.filter((item) => item.status !== "completed");
  if (remaining.length === 0) return undefined;
  const marker = (status: PlanItemStatus) => (status === "completed" ? "[x]" : status === "in_progress" ? "[>]" : "[ ]");
  const lines = ["Active plan (`update_plan`):"];
  if (plan.explanation.trim() !== "") lines.push(plan.explanation.trim());
  for (const item of plan.items) {
    lines.push(`- ${marker(item.status)} (${item.id}) ${item.text}`);
  }
  lines.push("Keep executing the remaining steps and mark each finished step `completed` via `update_plan` until all steps are complete.");
  return lines.join("\n");
}

function parsePlanEventData(raw: unknown): PlanState | undefined {
  if (typeof raw !== "object" || raw === null) return undefined;
  const candidate = raw as Partial<PlanState>;
  try {
    return validatePlanState({ explanation: candidate.explanation ?? "", items: candidate.items ?? [] });
  } catch {
    return undefined;
  }
}

export function formatPlanDriftReminder(plan: PlanState): string | undefined {
  const section = formatPlanPromptSection(plan);
  if (section === undefined) return undefined;
  return `<plan-reminder>\n${section}\n</plan-reminder>`;
}

function findPendingDriftReminder(session: Session): string | undefined {
  const branch = currentBranch(session.events);
  let lastPlanIndex = -1;
  for (let i = branch.length - 1; i >= 0; i -= 1) {
    const event = branch[i];
    if (event?.type === "custom" && (event.data.ns === NAMESPACE || event.data.ns === LEGACY_NAMESPACE)) {
      lastPlanIndex = i;
      break;
    }
  }
  if (lastPlanIndex === -1) return undefined;
  const eventsSincePlan = branch.length - 1 - lastPlanIndex;
  if (eventsSincePlan <= DRIFT_REMINDER_EVENT_THRESHOLD) return undefined;
  const latestPlanEvent = branch[lastPlanIndex];
  if (latestPlanEvent?.type !== "custom") return undefined;
  const plan = parsePlanEventData(latestPlanEvent.data.data);
  return plan === undefined ? undefined : formatPlanDriftReminder(plan);
}

function isExecutableAgentSession(ctx: Context, session: Session): boolean {
  if (session.header.side === true) return false;
  const perms = ctx.get("permissions" as never) as { modes?: (s: Session) => { agentMode?: string; effective?: string } } | undefined;
  if (typeof perms?.modes === "function") {
    const modes = perms.modes(session);
    return modes.agentMode === "agent" && modes.effective !== "read-only";
  }
  const stored = latestCustom<{ permission?: string; agentMode?: string }>(session.events, ["qianji-permissions", "pid-permissions"]);
  return (stored?.agentMode ?? "agent") === "agent" && stored?.permission !== "read-only";
}

export function apply(ctx: Context): void {
  const nudgedPlanSeq = new Map<string, number>();

  ctx.effect(() => ctx.tools.register(planTool(ctx)), `${name}: update_plan`);
  ctx.effect(() => ctx.on("session/deleted", (id) => void nudgedPlanSeq.delete(id)), `${name}: cleanup deleted`);
  ctx.effect(() => ctx.on("session/unloaded", (id) => void nudgedPlanSeq.delete(id)), `${name}: cleanup unloaded`);

  // Inject drift reminders into the trailing user/tool-result message instead of
  // mutating the system prompt so the upstream KV cache prefix stays invariant.
  ctx.effect(() => ctx.on("llm/request", (request, next) => {
    if (request.sessionId !== undefined && request.sessionId !== "") {
      const session = ctx.sessions.peek(request.sessionId);
      if (session !== undefined) {
        const reminder = findPendingDriftReminder(session);
        if (reminder !== undefined) {
          for (let i = request.messages.length - 1; i >= 0; i -= 1) {
            const msg = request.messages[i];
            if (msg !== undefined && (msg.role === "user" || msg.role === "tool-result")) {
              request.messages[i] = {
                ...msg,
                content: [...msg.content, { type: "text", text: `\n\n${reminder}` }],
              };
              break;
            }
          }
        }
      }
    }
    return next();
  }), `${name}: llm request drift reminder`);

  ctx.effect(() => ctx.on("agent/before-stop", (session, info) => {
    if (info.stop !== "stop" || !isExecutableAgentSession(ctx, session)) return undefined;
    const latestEvent = customEvents(session.events, [NAMESPACE, LEGACY_NAMESPACE]).at(-1);
    if (latestEvent === undefined) return undefined;
    const plan = parsePlanEventData(latestEvent.data.data);
    if (plan === undefined) return undefined;
    const remaining = plan.items.filter((item) => item.status !== "completed");
    if (remaining.length === 0) return undefined;
    if (nudgedPlanSeq.get(session.id) === latestEvent.seq) return undefined;
    nudgedPlanSeq.set(session.id, latestEvent.seq);
    const summary = remaining.slice(0, 5).map((item) => `[${item.status}] ${item.id}: ${item.text}`).join("; ");
    const more = remaining.length > 5 ? ` (+${remaining.length - 5} more)` : "";
    return `Your current plan still has unfinished steps (${summary}${more}). Continue executing the next step using your tools and update step statuses via update_plan; if those steps are already complete, mark them completed via update_plan before finishing, or explain clearly if you are blocked on user input.`;
  }), `${name}: before-stop`);

  ctx.inject(["commands"], (inner) => {
    inner.effect(() => inner.commands.register({
      name: "plan",
      description: "查看当前会话的任务计划（传入 clear 清空计划）",
      argsHint: "[clear]",
      source: "plan",
      async execute(rawArgs, env) {
        if (!env.sessionId) return { output: "当前会话尚未开始，暂无任务计划。" };
        const session = await inner.sessions.get(env.sessionId);
        if (session === undefined) return { output: "找不到当前会话。", isError: true };
        if (rawArgs.trim().toLowerCase() === "clear") {
          setPlan(session, { explanation: "", items: [] });
          return { output: "已清空当前会话的任务计划。" };
        }
        return { output: formatPlanMarkdown(planOf(session)) };
      },
    }), `${name}: /plan`);
  });
  ctx.inject(["rpc"], (rpcCtx) => {
    rpcCtx.effect(
      () => rpcCtx.rpc.method("plan.get", async (params): Promise<PlanGetResult> => {
        const p = (typeof params === "object" && params !== null ? params : {}) as Record<string, unknown>;
        if (typeof p.sessionId !== "string") throw new RpcError(ErrorCode.InvalidParams, "sessionId must be a string");
        const target = await rpcCtx.sessions.get(p.sessionId);
        if (target === undefined) throw new RpcError(ErrorCode.SessionNotFound, `No session ${p.sessionId}`);
        return { plan: planOf(target) };
      }),
      `${name}: plan.get`,
    );
  });
}

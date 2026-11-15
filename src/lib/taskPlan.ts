import type { UiMessage, UiToolCall } from "../types";

export type TaskPlanStatus = "pending" | "in_progress" | "completed";

export interface TaskPlanStep {
  id: string;
  text: string;
  status: TaskPlanStatus;
}

export interface TaskPlanSummary {
  explanation: string;
  steps: TaskPlanStep[];
  completed: number;
}

export interface TurnPlanState {
  turnPlans: Map<string, TaskPlanSummary>;
  latestPlanMessageId: string | undefined;
}

type PlanAction =
  | { kind: "set"; plan: TaskPlanSummary }
  | { kind: "clear" };

type ActiveTurnPlan = {
  ownerMessageId: string;
  plan: TaskPlanSummary;
};

interface TurnPlanPrefixEntry {
  settledCount: number;
  prefix: readonly UiMessage[];
  plans: Map<string, TaskPlanSummary>;
  latestSettledId: string | undefined;
  activePlan: ActiveTurnPlan | null;
  lastStreaming?: boolean;
  lastResult?: TurnPlanState;
}

const EMPTY_TURN_PLANS = new Map<string, TaskPlanSummary>();
const EMPTY_TURN_PLAN_STATE: TurnPlanState = {
  turnPlans: EMPTY_TURN_PLANS,
  latestPlanMessageId: undefined,
};
const messagePlanActionCache = new WeakMap<UiMessage, PlanAction | null>();
const turnPlanByArrayCache = new WeakMap<
  readonly UiMessage[],
  { streaming?: TurnPlanState; settled?: TurnPlanState }
>();
let lastPlanPrefix: TurnPlanPrefixEntry | null = null;

function recordValue(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function planStatus(value: unknown): TaskPlanStatus | null {
  return value === "pending" || value === "in_progress" || value === "completed" ? value : null;
}

function toolNameTail(name: string): string {
  const segments = name.toLowerCase().split(/__|[.:/]/).filter(Boolean);
  return segments[segments.length - 1] ?? name.toLowerCase();
}

function toolCallPlanAction(call: UiToolCall): PlanAction | null {
  if (toolNameTail(call.name) !== "update_plan" || call.isError) return null;
  const hasDetailItems = Array.isArray(call.details?.items);
  const rawItems = hasDetailItems
    ? call.details?.items
    : Array.isArray(call.args.items)
      ? call.args.items
      : null;
  if (!Array.isArray(rawItems)) return null;
  if (rawItems.length === 0) {
    // Partial streaming JSON `{"items":[` transiently parses as `[]`; only clear once settled or confirmed by details.
    return !call.running || hasDetailItems ? { kind: "clear" } : null;
  }
  const steps = rawItems.flatMap((value, stepIndex) => {
    const item = recordValue(value);
    const text = typeof item?.text === "string" ? item.text.trim() : "";
    const status = planStatus(item?.status);
    if (!text || !status) return [];
    return [{
      id: typeof item?.id === "string" && item.id.trim() ? item.id.trim() : `step-${stepIndex + 1}`,
      text,
      status,
    }];
  });
  if (steps.length === 0) return null;
  const explanation = typeof call.details?.explanation === "string"
    ? call.details.explanation.trim()
    : typeof call.args.explanation === "string" ? call.args.explanation.trim() : "";
  return {
    kind: "set",
    plan: {
      explanation,
      steps,
      completed: steps.filter((step) => step.status === "completed").length,
    },
  };
}

/** Parse a single update_plan tool call into the conversation/inspector plan widget. */
export function planFromToolCall(call: UiToolCall): TaskPlanSummary | null {
  const action = toolCallPlanAction(call);
  return action?.kind === "set" ? action.plan : null;
}

function messagePlanAction(message: UiMessage): PlanAction | null {
  if (messagePlanActionCache.has(message)) {
    return messagePlanActionCache.get(message) ?? null;
  }
  let resolved: PlanAction | null = null;
  if (message.role === "user") {
    if (/^\/plan\s+clear$/i.test(message.content.trim())) {
      resolved = { kind: "clear" };
    }
  } else {
    const calls = message.toolCalls ?? [];
    for (let index = calls.length - 1; index >= 0; index -= 1) {
      const action = toolCallPlanAction(calls[index]);
      if (action) {
        resolved = action;
        break;
      }
    }
  }
  messagePlanActionCache.set(message, resolved);
  return resolved;
}

/** Return the latest valid update_plan payload for the active conversation branch. */
export function deriveTaskPlan(messages: UiMessage[]): TaskPlanSummary | null {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const action = messagePlanAction(messages[index]);
    if (action?.kind === "clear") return null;
    if (action?.kind === "set") return action.plan;
  }
  return null;
}

function isPlanFinished(plan: TaskPlanSummary): boolean {
  return plan.completed >= plan.steps.length;
}

function openTurnStart(messages: readonly UiMessage[]): number {
  let start = messages.length;
  while (start > 0 && messages[start - 1]?.role !== "user") start -= 1;
  return start;
}

function scanSettledPlans(
  messages: readonly UiMessage[],
  start: number,
  end: number,
  basePlans: Map<string, TaskPlanSummary>,
  baseLatestSettledId: string | undefined,
  baseActivePlan: ActiveTurnPlan | null,
): {
  plans: Map<string, TaskPlanSummary>;
  latestSettledId: string | undefined;
  activePlan: ActiveTurnPlan | null;
} {
  let plans: Map<string, TaskPlanSummary> | null = null;
  let latestSettledId = baseLatestSettledId;
  let activePlan: ActiveTurnPlan | null = baseActivePlan;
  let lastTurnAssistantId: string | undefined = undefined;
  let turnUpdatedPlan = false;

  for (let index = start; index < end; index += 1) {
    const message = messages[index];
    if (message.role === "user") {
      if (activePlan !== null) {
        if (isPlanFinished(activePlan.plan)) {
          plans ??= new Map(basePlans);
          plans.set(activePlan.ownerMessageId, activePlan.plan);
          latestSettledId = activePlan.ownerMessageId;
          activePlan = null;
        } else if (!turnUpdatedPlan && lastTurnAssistantId !== undefined) {
          activePlan = { ownerMessageId: lastTurnAssistantId, plan: activePlan.plan };
        }
      }
      if (messagePlanAction(message)?.kind === "clear") {
        activePlan = null;
      }
      lastTurnAssistantId = undefined;
      turnUpdatedPlan = false;
    } else {
      if (message.role === "assistant") {
        lastTurnAssistantId = message.id;
      }
      const action = messagePlanAction(message);
      if (action?.kind === "clear") {
        activePlan = null;
        turnUpdatedPlan = true;
      } else if (action?.kind === "set") {
        activePlan = { ownerMessageId: message.id, plan: action.plan };
        turnUpdatedPlan = true;
      }
    }
  }

  return {
    plans: plans ?? basePlans,
    latestSettledId,
    activePlan,
  };
}

function getSettledPlanPrefix(messages: readonly UiMessage[], settledCount: number): TurnPlanPrefixEntry | null {
  if (settledCount <= 0) return null;
  const cached = lastPlanPrefix;
  if (cached && settledCount >= cached.settledCount && cached.prefix.every((item, idx) => messages[idx] === item)) {
    if (settledCount > cached.settledCount) {
      const adv = scanSettledPlans(
        messages,
        cached.settledCount,
        settledCount,
        cached.plans,
        cached.latestSettledId,
        cached.activePlan,
      );
      Object.assign(cached, {
        settledCount,
        prefix: messages.slice(0, settledCount),
        plans: adv.plans,
        latestSettledId: adv.latestSettledId,
        activePlan: adv.activePlan,
        lastResult: undefined,
      });
    }
    return cached;
  }
  const built = scanSettledPlans(messages, 0, settledCount, EMPTY_TURN_PLANS, undefined, null);
  return (lastPlanPrefix = {
    settledCount,
    prefix: messages.slice(0, settledCount),
    plans: built.plans,
    latestSettledId: built.latestSettledId,
    activePlan: built.activePlan,
  });
}

function resolveOpenTurnPlan(
  messages: readonly UiMessage[],
  settledCount: number,
  inheritedActive: ActiveTurnPlan | null,
): ActiveTurnPlan | null {
  let openActive = inheritedActive;
  let lastOpenAssistantId: string | undefined = undefined;
  let turnUpdatedPlan = false;

  for (let index = settledCount; index < messages.length; index += 1) {
    const message = messages[index];
    if (message.role === "assistant") {
      lastOpenAssistantId = message.id;
    }
    const action = messagePlanAction(message);
    if (action?.kind === "clear") {
      openActive = null;
      turnUpdatedPlan = true;
    } else if (action?.kind === "set") {
      openActive = { ownerMessageId: message.id, plan: action.plan };
      turnUpdatedPlan = true;
    }
  }

  if (openActive !== null && !turnUpdatedPlan && lastOpenAssistantId !== undefined) {
    openActive = { ownerMessageId: lastOpenAssistantId, plan: openActive.plan };
  }
  return openActive;
}

/** The plan of the open turn: either updated after the latest user message or carried over if still unfinished. */
export function deriveLiveTaskPlan(messages: UiMessage[]): TaskPlanSummary | null {
  const settledCount = openTurnStart(messages);
  const entry = getSettledPlanPrefix(messages, settledCount);
  const openActive = resolveOpenTurnPlan(messages, settledCount, entry ? entry.activePlan : null);
  return openActive ? openActive.plan : null;
}

/** Single-pass cached derivation of per-turn plans and the newest plan message ID. */
export function deriveTurnPlanState(messages: UiMessage[], isStreaming = false): TurnPlanState {
  const arrayCached = turnPlanByArrayCache.get(messages);
  const hit = isStreaming ? arrayCached?.streaming : arrayCached?.settled;
  if (hit) return hit;

  const settledCount = openTurnStart(messages);
  const entry = getSettledPlanPrefix(messages, settledCount);
  const prefixPlans = entry ? entry.plans : EMPTY_TURN_PLANS;
  const openActive = resolveOpenTurnPlan(messages, settledCount, entry ? entry.activePlan : null);

  let result: TurnPlanState;
  if (isStreaming || !openActive) {
    const latestPlanMessageId = openActive ? openActive.ownerMessageId : entry?.latestSettledId;
    if (prefixPlans === EMPTY_TURN_PLANS && latestPlanMessageId === undefined) {
      result = EMPTY_TURN_PLAN_STATE;
    } else if (
      entry?.lastResult
      && entry.lastStreaming === isStreaming
      && entry.lastResult.turnPlans === prefixPlans
      && entry.lastResult.latestPlanMessageId === latestPlanMessageId
    ) {
      result = entry.lastResult;
    } else {
      result = { turnPlans: prefixPlans, latestPlanMessageId };
    }
  } else {
    const turnPlans = new Map(prefixPlans);
    turnPlans.set(openActive.ownerMessageId, openActive.plan);
    result = { turnPlans, latestPlanMessageId: openActive.ownerMessageId };
  }

  if (entry) {
    entry.lastStreaming = isStreaming;
    entry.lastResult = result;
  }
  turnPlanByArrayCache.set(
    messages,
    isStreaming ? { ...arrayCached, streaming: result } : { ...arrayCached, settled: result },
  );
  return result;
}

export function findLatestTurnPlanMessageId(messages: UiMessage[]): string | undefined {
  return deriveTurnPlanState(messages, false).latestPlanMessageId;
}

/** Map each turn's final plan to the message that last updated it; skips open turn while streaming. */
export function deriveTurnPlans(messages: UiMessage[], skipOpenTurn = false): Map<string, TaskPlanSummary> {
  return deriveTurnPlanState(messages, skipOpenTurn).turnPlans;
}

/** The step a plan is on: the first in progress, else the first pending, else the last. */
export function currentPlanStepIndex(plan: TaskPlanSummary): number {
  const active = plan.steps.findIndex((step) => step.status === "in_progress");
  if (active >= 0) return active;
  const pending = plan.steps.findIndex((step) => step.status === "pending");
  return pending >= 0 ? pending : plan.steps.length - 1;
}

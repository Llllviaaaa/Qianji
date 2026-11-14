import type { Context } from "@deepseek-ai/cordis";
import "@qianji/agent";
import "@qianji/commands";
import "@qianji/rpc";
import { textOutput } from "@qianji/tools";

export const name = "goal-tracker";
export const inject = ["tools", "commands", "rpc", "agents"];

export type GoalStatus = "active" | "blocked" | "complete";

export interface GoalRecord {
  id: string;
  sessionId: string;
  objective: string;
  status: GoalStatus;
  createdAt: number;
  updatedAt: number;
  completedAt?: number;
  tokenBudget?: number;
  notes?: string;
  remindCount: number;
}

export interface GoalTrackerConfig {
  autoRemindBeforeStop?: boolean;
  maxAutoContinues?: number;
}

export interface GoalSnapshot {
  goal: GoalRecord | null;
}

function sessionKeyOf(sessionId?: string): string {
  const trimmed = sessionId?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : "default";
}

function normalizeStatus(value: unknown): GoalStatus | undefined {
  if (value === "active" || value === "blocked" || value === "complete") {
    return value;
  }
  return undefined;
}

function normalizeMaxContinues(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return 2;
  return Math.max(0, Math.min(5, Math.floor(value)));
}

function serializeGoal(record: GoalRecord): string {
  return JSON.stringify(
    {
      id: record.id,
      objective: record.objective,
      status: record.status,
      createdAt: record.createdAt,
      updatedAt: record.updatedAt,
      ...(record.completedAt === undefined ? {} : { completedAt: record.completedAt }),
      ...(record.tokenBudget === undefined ? {} : { tokenBudget: record.tokenBudget }),
      ...(record.notes === undefined ? {} : { notes: record.notes }),
    },
    null,
    2,
  );
}

export function apply(ctx: Context, rawConfig: GoalTrackerConfig = {}): void {
  const goals = new Map<string, GoalRecord>();
  let sequence = 0;

  const upsertGoal = (
    sessionId: string | undefined,
    objective: string,
    tokenBudget?: number,
    notes?: string,
  ): GoalRecord => {
    const key = sessionKeyOf(sessionId);
    const now = Date.now();
    sequence += 1;
    const record: GoalRecord = {
      id: `goal_${now}_${sequence}`,
      sessionId: key,
      objective,
      status: "active",
      createdAt: now,
      updatedAt: now,
      ...(typeof tokenBudget === "number" && Number.isFinite(tokenBudget) && tokenBudget > 0
        ? { tokenBudget: Math.round(tokenBudget) }
        : {}),
      ...(notes && notes.trim() ? { notes: notes.trim() } : {}),
      remindCount: 0,
    };
    goals.set(key, record);
    return record;
  };

  ctx.effect(
    () =>
      ctx.tools.register<{
        objective: string;
        token_budget?: number;
        notes?: string;
      }>({
        name: "create_goal",
        description: "为当前会话设定或重置长程任务目标，便于在长链路执行中持续追踪完成状态。",
        parameters: {
          type: "object",
          properties: {
            objective: {
              type: "string",
              description: "清晰、可验证的目标描述",
            },
            token_budget: {
              type: "number",
              description: "可选：预估或上限 Token 预算（如 120000）",
            },
            notes: {
              type: "string",
              description: "可选：阶段性约束或补充备注",
            },
          },
          required: ["objective"],
        },
        execute(args, env) {
          const objective = typeof args.objective === "string" ? args.objective.trim() : "";
          if (!objective) {
            return textOutput("create_goal 失败：objective 不能为空。", true);
          }
          const created = upsertGoal(env.sessionId, objective, args.token_budget, args.notes);
          return textOutput(`已建立会话目标：\n${serializeGoal(created)}`);
        },
      }),
    "goal-tracker: create_goal",
  );

  ctx.effect(
    () =>
      ctx.tools.register({
        name: "get_goal",
        description: "查询当前会话已设定的长程任务目标及其最新状态。",
        readOnly: true,
        parameters: {
          type: "object",
          properties: {},
        },
        execute(_args, env) {
          const record = goals.get(sessionKeyOf(env.sessionId)) ?? null;
          if (!record) {
            return textOutput("当前会话尚未设定长程目标。");
          }
          return textOutput(serializeGoal(record));
        },
      }),
    "goal-tracker: get_goal",
  );

  ctx.effect(
    () =>
      ctx.tools.register<{
        status: GoalStatus;
        notes?: string;
      }>({
        name: "update_goal",
        description: "更新当前会话长程目标的状态（active / blocked / complete）与备注。",
        parameters: {
          type: "object",
          properties: {
            status: {
              type: "string",
              enum: ["active", "blocked", "complete"],
              description: "目标当前状态",
            },
            notes: {
              type: "string",
              description: "可选：最新进展、阻塞原因或验收结论",
            },
          },
          required: ["status"],
        },
        execute(args, env) {
          const key = sessionKeyOf(env.sessionId);
          const existing = goals.get(key);
          if (!existing) {
            return textOutput("当前会话尚无活动目标，请先调用 create_goal。", true);
          }
          const nextStatus = normalizeStatus(args.status);
          if (!nextStatus) {
            return textOutput("无效的 status，仅支持 active、blocked 或 complete。", true);
          }
          const now = Date.now();
          const updated: GoalRecord = {
            ...existing,
            status: nextStatus,
            updatedAt: now,
            ...(nextStatus === "complete" ? { completedAt: existing.completedAt ?? now } : { completedAt: undefined }),
            ...(typeof args.notes === "string" && args.notes.trim() ? { notes: args.notes.trim() } : {}),
            ...(nextStatus === "active" ? { remindCount: 0 } : {}),
          };
          goals.set(key, updated);
          return textOutput(`已更新目标状态：\n${serializeGoal(updated)}`);
        },
      }),
    "goal-tracker: update_goal",
  );

  ctx.effect(
    () =>
      ctx.commands.register({
        name: "goal",
        argsHint: "[objective | clear | status]",
        description: "设定、查看或清除当前会话的长程任务目标",
        source: "plugin",
        execute(rawArgs, env) {
          const key = sessionKeyOf(env.sessionId);
          const trimmed = rawArgs.trim();
          if (trimmed === "" || trimmed.toLowerCase() === "status") {
            const existing = goals.get(key);
            if (!existing) {
              return {
                output: "当前会话暂无长程目标。用法：`/goal <目标描述>` 设定新目标，或 `/goal clear` 清除。",
              };
            }
            const statusText = existing.status === "complete" ? "已完成" : existing.status === "blocked" ? "受阻" : "进行中";
            return {
              output: `**当前目标（${statusText}）**：${existing.objective}${existing.notes ? `\n\n- 备注：${existing.notes}` : ""}`,
            };
          }

          if (trimmed.toLowerCase() === "clear" || trimmed.toLowerCase() === "reset") {
            goals.delete(key);
            return { output: "已清除当前会话的长程目标追踪。" };
          }

          if (trimmed.toLowerCase() === "done" || trimmed.toLowerCase() === "complete") {
            const existing = goals.get(key);
            if (!existing) {
              return { output: "当前会话没有正在追踪的目标。" };
            }
            const now = Date.now();
            goals.set(key, {
              ...existing,
              status: "complete",
              updatedAt: now,
              completedAt: existing.completedAt ?? now,
            });
            return { output: `已将目标标记为已完成：**${existing.objective}**` };
          }

          const created = upsertGoal(key, trimmed);
          return {
            prompt: [
              `请围绕以下长程目标持续推进执行：`,
              ``,
              `目标：${created.objective}`,
              ``,
              `要求：`,
              `1. 优先调用 \`get_goal\` 或在重要里程碑处调用 \`update_goal\` 同步真实进度。`,
              `2. 若遇到无法自动解决的阻塞，调用 \`update_goal(status="blocked", notes="...")\` 说明原因；`,
              `3. 全部验收项确认完成后，务必调用 \`update_goal(status="complete")\` 收尾。`,
            ].join("\n"),
          };
        },
      }),
    "goal-tracker: /goal command",
  );

  ctx.effect(
    () =>
      ctx.rpc.method("goalTracker.get", (rawParams): GoalSnapshot => {
        const p = typeof rawParams === "object" && rawParams !== null ? (rawParams as Record<string, unknown>) : {};
        const key = sessionKeyOf(typeof p.sessionId === "string" ? p.sessionId : undefined);
        return { goal: goals.get(key) ?? null };
      }),
    "goal-tracker: goalTracker.get",
  );

  ctx.effect(
    () =>
      ctx.rpc.method("goalTracker.complete", (rawParams): GoalSnapshot => {
        const p = typeof rawParams === "object" && rawParams !== null ? (rawParams as Record<string, unknown>) : {};
        const key = sessionKeyOf(typeof p.sessionId === "string" ? p.sessionId : undefined);
        const existing = goals.get(key);
        if (!existing) return { goal: null };
        const now = Date.now();
        const next: GoalRecord = {
          ...existing,
          status: "complete",
          updatedAt: now,
          completedAt: existing.completedAt ?? now,
        };
        goals.set(key, next);
        return { goal: next };
      }),
    "goal-tracker: goalTracker.complete",
  );

  ctx.effect(
    () =>
      ctx.rpc.method("goalTracker.clear", (rawParams): { cleared: boolean } => {
        const p = typeof rawParams === "object" && rawParams !== null ? (rawParams as Record<string, unknown>) : {};
        const key = sessionKeyOf(typeof p.sessionId === "string" ? p.sessionId : undefined);
        return { cleared: goals.delete(key) };
      }),
    "goal-tracker: goalTracker.clear",
  );

  ctx.on("agent/before-stop", (session) => {
    if (rawConfig.autoRemindBeforeStop === false) return undefined;
    const maxContinues = normalizeMaxContinues(rawConfig.maxAutoContinues);
    if (maxContinues <= 0) return undefined;
    const key = sessionKeyOf(session.id);
    const existing = goals.get(key);
    if (!existing || existing.status !== "active") return undefined;
    if (existing.remindCount >= maxContinues) return undefined;

    goals.set(key, {
      ...existing,
      remindCount: existing.remindCount + 1,
      updatedAt: Date.now(),
    });
    return (
      `[Goal Tracker 核查] 当前会话长程目标“${existing.objective}”仍标记为 active。` +
      `请确认目标要求是否已全部验证通过：若已完成请调用 update_goal(status="complete")；若确有阻塞请标记为 blocked 并向用户说明。`
    );
  });
}

export default {
  name,
  inject,
  apply,
};

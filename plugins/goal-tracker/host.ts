import type { Context } from "@deepseek-ai/cordis";
import "@qianji/agent";
import "@qianji/commands";
import "@qianji/llm";
import "@qianji/rpc";
import { currentBranch, type Session, type SessionEvent } from "@qianji/session";
import { textOutput } from "@qianji/tools";

export const name = "goal-tracker";
export const inject = ["tools", "commands", "rpc", "agents", "sessions"];

export const GOAL_NAMESPACE = "qianji-goal";
export const GOAL_DRIFT_EVENT_THRESHOLD = 10;
const PENDING_GOAL_TTL_MS = 60_000;

export type GoalStatus = "active" | "blocked" | "complete";

export interface GoalCriterion {
  id: string;
  text: string;
  done: boolean;
}

export interface GoalCriterionInput {
  id?: string;
  text: string;
  done?: boolean;
}

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
  criteria?: GoalCriterion[];
  remindCount: number;
  maxReminds: number;
}

export interface GoalTrackerConfig {
  autoRemindBeforeStop?: boolean;
  maxAutoContinues?: number;
}

export interface GoalSnapshot {
  goal: GoalRecord | null;
}

interface GoalClearedPayload {
  cleared: true;
  updatedAt: number;
}

function isObjectRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function sessionKeyOf(sessionId?: string): string {
  const trimmed = sessionId?.trim();
  return trimmed !== undefined && trimmed.length > 0 ? trimmed : "default";
}

function normalizeStatus(value: unknown): GoalStatus | undefined {
  if (value === "active" || value === "blocked" || value === "complete") {
    return value;
  }
  return undefined;
}

export function normalizeMaxContinues(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return 3;
  return Math.max(0, Math.min(5, Math.floor(value)));
}

export function normalizeCriteria(raw: unknown): GoalCriterion[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const usedIds = new Set<string>();
  const normalized: GoalCriterion[] = [];
  for (const entry of raw) {
    if (normalized.length >= 30) break;
    if (typeof entry === "string") {
      const text = entry.trim();
      if (text === "") continue;
      let nextIdx = normalized.length + 1;
      while (usedIds.has(`c${nextIdx}`)) nextIdx += 1;
      const id = `c${nextIdx}`;
      usedIds.add(id);
      normalized.push({ id, text, done: false });
      continue;
    }
    if (!isObjectRecord(entry) || typeof entry.text !== "string") continue;
    const text = entry.text.trim();
    if (text === "") continue;
    const rawId = typeof entry.id === "string" ? entry.id.trim() : "";
    let id = rawId;
    if (id === "" || usedIds.has(id)) {
      let nextIdx = normalized.length + 1;
      while (usedIds.has(`c${nextIdx}`)) nextIdx += 1;
      id = `c${nextIdx}`;
    }
    usedIds.add(id);
    normalized.push({
      id,
      text,
      done: Boolean(entry.done),
    });
  }
  return normalized;
}

function isClearedPayload(raw: unknown): raw is GoalClearedPayload {
  return isObjectRecord(raw) && raw.cleared === true;
}

function parseGoalRecord(raw: unknown, sessionId: string, defaultMaxReminds: number): GoalRecord | undefined {
  if (!isObjectRecord(raw) || raw.cleared === true) return undefined;
  const status = normalizeStatus(raw.status);
  const objective = typeof raw.objective === "string" ? raw.objective.trim() : "";
  if (status === undefined || objective === "") return undefined;
  const id = typeof raw.id === "string" && raw.id.trim() !== "" ? raw.id.trim() : `goal_${Date.now()}`;
  const createdAt = typeof raw.createdAt === "number" && Number.isFinite(raw.createdAt) ? raw.createdAt : Date.now();
  const updatedAt = typeof raw.updatedAt === "number" && Number.isFinite(raw.updatedAt) ? raw.updatedAt : createdAt;
  const completedAt =
    typeof raw.completedAt === "number" && Number.isFinite(raw.completedAt) ? raw.completedAt : undefined;
  const tokenBudget =
    typeof raw.tokenBudget === "number" && Number.isFinite(raw.tokenBudget) && raw.tokenBudget > 0
      ? Math.round(raw.tokenBudget)
      : undefined;
  const notes = typeof raw.notes === "string" && raw.notes.trim() !== "" ? raw.notes.trim() : undefined;
  const criteria = normalizeCriteria(raw.criteria);
  const remindCount =
    typeof raw.remindCount === "number" && Number.isFinite(raw.remindCount) && raw.remindCount >= 0
      ? Math.floor(raw.remindCount)
      : 0;
  const maxReminds =
    typeof raw.maxReminds === "number" && Number.isFinite(raw.maxReminds)
      ? Math.max(0, Math.min(5, Math.floor(raw.maxReminds)))
      : defaultMaxReminds;

  return {
    id,
    sessionId,
    objective,
    status,
    createdAt,
    updatedAt,
    ...(completedAt === undefined ? {} : { completedAt }),
    ...(tokenBudget === undefined ? {} : { tokenBudget }),
    ...(notes === undefined ? {} : { notes }),
    ...(criteria === undefined || criteria.length === 0 ? {} : { criteria }),
    remindCount,
    maxReminds,
  };
}

/** Reconstruct a session's active branch GoalRecord respecting `rewind` (`toSeq`) events. */
export function reconstructSessionGoal(session: Session, defaultMaxReminds = 3): GoalRecord | null {
  const branch = currentBranch(session.events);
  for (let i = branch.length - 1; i >= 0; i -= 1) {
    const event = branch[i];
    if (event?.type !== "custom" || event.data.ns !== GOAL_NAMESPACE) continue;
    if (isClearedPayload(event.data.data)) return null;
    const parsed = parseGoalRecord(event.data.data, session.id, defaultMaxReminds);
    if (parsed !== undefined) return parsed;
  }
  return null;
}

export function formatGoalDriftReminder(goal: GoalRecord): string {
  const lines = ["<goal-reminder>", `Active session goal: ${goal.objective}`];
  if (goal.notes !== undefined && goal.notes !== "") {
    lines.push(`Latest notes: ${goal.notes}`);
  }
  if (goal.criteria !== undefined && goal.criteria.length > 0) {
    const doneCount = goal.criteria.filter((item) => item.done).length;
    lines.push(`Acceptance criteria (${doneCount}/${goal.criteria.length} done):`);
    for (const item of goal.criteria) {
      lines.push(`- [${item.done ? "x" : " "}] (${item.id}) ${item.text}`);
    }
  }
  lines.push(
    'Keep advancing toward this goal, sync milestone progress via `update_goal`, and call `update_goal(status="complete", notes="...")` only after concrete verification.',
    "</goal-reminder>",
  );
  return lines.join("\n");
}

function findPendingGoalDriftReminder(session: Session, defaultMaxReminds: number): string | undefined {
  const branch = currentBranch(session.events);
  let lastGoalIndex = -1;
  for (let i = branch.length - 1; i >= 0; i -= 1) {
    const event = branch[i];
    if (event?.type === "custom" && event.data.ns === GOAL_NAMESPACE) {
      lastGoalIndex = i;
      break;
    }
  }
  if (lastGoalIndex < 0) return undefined;
  const eventsSinceGoal = branch.length - 1 - lastGoalIndex;
  if (eventsSinceGoal <= GOAL_DRIFT_EVENT_THRESHOLD) return undefined;
  const latestGoalEvent = branch[lastGoalIndex];
  if (latestGoalEvent?.type !== "custom" || isClearedPayload(latestGoalEvent.data.data)) return undefined;
  const goal = parseGoalRecord(latestGoalEvent.data.data, session.id, defaultMaxReminds);
  if (goal === undefined || goal.status !== "active") return undefined;
  return formatGoalDriftReminder(goal);
}

function extractSlashGoalObjective(event: Extract<SessionEvent, { type: "user" }>): string | undefined {
  const visibleText = event.data.content
    .flatMap((block) =>
      block.type === "text" && (block as { meta?: boolean }).meta !== true ? [block.text] : [],
    )
    .join("\n")
    .trim();
  const match = /^\/goal(?:\s+([\s\S]+))?$/i.exec(visibleText);
  if (!match) return undefined;
  const rawArg = (match[1] ?? "").trim();
  if (rawArg === "") return undefined;
  const lower = rawArg.toLowerCase();
  if (lower === "status" || lower === "clear" || lower === "reset" || lower === "done" || lower === "complete") {
    return undefined;
  }
  return rawArg;
}

function serializeGoal(record: GoalRecord): string {
  return JSON.stringify(
    {
      id: record.id,
      sessionId: record.sessionId,
      objective: record.objective,
      status: record.status,
      createdAt: record.createdAt,
      updatedAt: record.updatedAt,
      ...(record.completedAt === undefined ? {} : { completedAt: record.completedAt }),
      ...(record.tokenBudget === undefined ? {} : { tokenBudget: record.tokenBudget }),
      ...(record.notes === undefined ? {} : { notes: record.notes }),
      ...(record.criteria === undefined ? {} : { criteria: record.criteria }),
      remindCount: record.remindCount,
      maxReminds: record.maxReminds,
    },
    null,
    2,
  );
}

function formatGoalStatusMarkdown(record: GoalRecord): string {
  const statusText =
    record.status === "complete" ? "已完成" : record.status === "blocked" ? "受阻" : "进行中";
  const lines = [`**当前目标（${statusText}）**：${record.objective}`, ""];
  if (record.notes !== undefined) {
    lines.push(`- **最新备注**：${record.notes}`);
  }
  if (record.tokenBudget !== undefined) {
    lines.push(`- **Token 预算**：${record.tokenBudget.toLocaleString()} tok`);
  }
  lines.push(`- **自动核查轮次**：${record.remindCount}/${record.maxReminds}`);
  if (record.criteria !== undefined && record.criteria.length > 0) {
    const doneCount = record.criteria.filter((item) => item.done).length;
    lines.push("", `### 验收清单 (${doneCount}/${record.criteria.length})`);
    for (const item of record.criteria) {
      lines.push(`- [${item.done ? "x" : " "}] ${item.text}`);
    }
  }
  return lines.join("\n");
}

function buildGoalPrompt(record: GoalRecord): string {
  return [
    `当前会话已启用长程目标追踪（Goal ID: \`${record.id}\`）：`,
    `目标：${record.objective}`,
    ``,
    `请按以下自主闭环规范持续推进，直至目标经验证达成：`,
    `1. **设定验收清单**：针对多步骤目标，先调用 \`update_goal\` 建立 2–6 条具体、可验证的 \`criteria\` 验收标准（必要时配合 \`update_plan\` 维护执行步骤状态）。`,
    `2. **同步里程碑进展**：每完成关键阶段或验收项时，调用 \`update_goal(status="active", notes="简明进展摘要", criteria=[...])\` 勾选已达成项并更新进展摘要。`,
    `3. **真实命令验证收尾**：结束前必须运行真实测试、类型检查或构建命令完成验证，再调用 \`update_goal(status="complete", notes="验收结论摘要", criteria=[...])\` 收尾。`,
    `4. **明确说明阻塞**：若遇到需用户决策或外部环境限制的阻塞，调用 \`update_goal(status="blocked", notes="具体阻塞原因与需确认事项")\`。`,
  ].join("\n");
}

const CRITERIA_SCHEMA = {
  type: "array",
  description: "可选：2–6 条具体、可验证的验收标准清单",
  items: {
    type: "object",
    properties: {
      id: { type: "string", description: "可选：条目短 ID（默认自动分配 c1, c2, ...）" },
      text: { type: "string", description: "具体、可验证的验收条件" },
      done: { type: "boolean", description: "是否已达成（默认 false）" },
    },
    required: ["text"],
  },
} as const;

export function apply(ctx: Context, rawConfig: GoalTrackerConfig = {}): void {
  const fallbackGoals = new Map<string, GoalRecord>();
  let pendingUnattachedGoal: GoalRecord | undefined;
  let sequence = 0;

  const getMaxContinues = (): number => normalizeMaxContinues(rawConfig.maxAutoContinues);

  const resolveSession = async (sessionId?: string): Promise<Session | undefined> => {
    const trimmed = sessionId?.trim();
    if (trimmed === undefined || trimmed === "" || trimmed === "default") return undefined;
    return await ctx.sessions.get(trimmed);
  };

  const buildNewRecord = (
    sessionKey: string,
    objective: string,
    tokenBudget?: number,
    notes?: string,
    criteria?: GoalCriterion[],
  ): GoalRecord => {
    const now = Date.now();
    sequence += 1;
    return {
      id: `goal_${now}_${sequence}`,
      sessionId: sessionKey,
      objective,
      status: "active",
      createdAt: now,
      updatedAt: now,
      ...(typeof tokenBudget === "number" && Number.isFinite(tokenBudget) && tokenBudget > 0
        ? { tokenBudget: Math.round(tokenBudget) }
        : {}),
      ...(typeof notes === "string" && notes.trim() !== "" ? { notes: notes.trim() } : {}),
      ...(criteria !== undefined && criteria.length > 0 ? { criteria } : {}),
      remindCount: 0,
      maxReminds: getMaxContinues(),
    };
  };

  const readGoal = async (sessionId?: string): Promise<GoalRecord | null> => {
    const session = await resolveSession(sessionId);
    if (session !== undefined) {
      const persisted = reconstructSessionGoal(session, getMaxContinues());
      if (persisted !== null) return persisted;
      return fallbackGoals.get(session.id) ?? null;
    }
    return fallbackGoals.get(sessionKeyOf(sessionId)) ?? null;
  };

  const writeGoal = async (
    sessionId: string | undefined,
    record: GoalRecord,
    explicitSession?: Session,
  ): Promise<GoalRecord> => {
    const session = explicitSession ?? (await resolveSession(sessionId));
    if (session !== undefined) {
      const normalized: GoalRecord = { ...record, sessionId: session.id };
      session.append("custom", { ns: GOAL_NAMESPACE, data: normalized });
      fallbackGoals.delete(session.id);
      if (pendingUnattachedGoal?.id === record.id) {
        pendingUnattachedGoal = undefined;
      }
      return normalized;
    }
    const key = sessionKeyOf(sessionId);
    const normalized: GoalRecord = { ...record, sessionId: key };
    fallbackGoals.set(key, normalized);
    return normalized;
  };

  const clearGoal = async (sessionId?: string, explicitSession?: Session): Promise<boolean> => {
    const session = explicitSession ?? (await resolveSession(sessionId));
    if (session !== undefined) {
      let cleared = false;
      if (reconstructSessionGoal(session, getMaxContinues()) !== null) {
        const payload: GoalClearedPayload = { cleared: true, updatedAt: Date.now() };
        session.append("custom", { ns: GOAL_NAMESPACE, data: payload });
        cleared = true;
      }
      if (fallbackGoals.delete(session.id)) cleared = true;
      return cleared;
    }
    const key = sessionKeyOf(sessionId);
    if (key === "default") pendingUnattachedGoal = undefined;
    return fallbackGoals.delete(key);
  };

  ctx.effect(
    () =>
      ctx.tools.register<{
        objective: string;
        token_budget?: number;
        notes?: string;
        criteria?: GoalCriterionInput[];
      }>({
        name: "create_goal",
        description: "为当前会话设定或重置长程任务目标及可选验收标准清单，便于持续追踪完成状态。",
        parameters: {
          type: "object",
          properties: {
            objective: { type: "string", description: "清晰、可验证的目标描述" },
            token_budget: { type: "number", description: "可选：预估或上限 Token 预算（如 120000）" },
            notes: { type: "string", description: "可选：阶段性约束或补充备注" },
            criteria: CRITERIA_SCHEMA,
          },
          required: ["objective"],
        },
        async execute(args, env) {
          const objective = typeof args.objective === "string" ? args.objective.trim() : "";
          if (objective === "") {
            return textOutput("create_goal 失败：objective 不能为空。", true);
          }
          const criteria = normalizeCriteria(args.criteria);
          const draft = buildNewRecord(
            sessionKeyOf(env.sessionId),
            objective,
            args.token_budget,
            args.notes,
            criteria,
          );
          const created = await writeGoal(env.sessionId, draft);
          return textOutput(`已建立会话目标：\n${serializeGoal(created)}`);
        },
      }),
    "goal-tracker: create_goal",
  );

  ctx.effect(
    () =>
      ctx.tools.register({
        name: "get_goal",
        description: "查询当前会话已设定的长程任务目标、验收清单及核查轮次。",
        readOnly: true,
        parameters: { type: "object", properties: {} },
        async execute(_args, env) {
          const record = await readGoal(env.sessionId);
          if (record === null) {
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
        status?: GoalStatus;
        notes?: string;
        criteria?: GoalCriterionInput[];
      }>({
        name: "update_goal",
        description: "更新当前会话长程目标的状态（可选 active / blocked / complete）、最新进展备注与验收标准清单。",
        parameters: {
          type: "object",
          properties: {
            status: {
              type: "string",
              enum: ["active", "blocked", "complete"],
              description: "可选：目标当前状态（省略时保持当前状态）",
            },
            notes: { type: "string", description: "可选：最新进展、阻塞原因或验收结论" },
            criteria: CRITERIA_SCHEMA,
          },
        },
        async execute(args, env) {
          const existing = await readGoal(env.sessionId);
          if (existing === null) {
            return textOutput("当前会话尚无活动目标，请先调用 create_goal。", true);
          }
          const nextStatus = args.status === undefined ? existing.status : normalizeStatus(args.status);
          if (nextStatus === undefined) {
            return textOutput("无效的 status，仅支持 active、blocked 或 complete。", true);
          }
          const now = Date.now();
          const nextCriteria = args.criteria === undefined ? existing.criteria : normalizeCriteria(args.criteria);
          const reopenedToActive = existing.status !== "active" && nextStatus === "active";
          const nextNotes =
            typeof args.notes === "string" && args.notes.trim() !== "" ? args.notes.trim() : existing.notes;
          const updated: GoalRecord = {
            id: existing.id,
            sessionId: existing.sessionId,
            objective: existing.objective,
            status: nextStatus,
            createdAt: existing.createdAt,
            updatedAt: now,
            ...(nextStatus === "complete" ? { completedAt: existing.completedAt ?? now } : {}),
            ...(existing.tokenBudget === undefined ? {} : { tokenBudget: existing.tokenBudget }),
            ...(nextNotes === undefined ? {} : { notes: nextNotes }),
            ...(nextCriteria === undefined || nextCriteria.length === 0 ? {} : { criteria: nextCriteria }),
            remindCount: reopenedToActive ? 0 : existing.remindCount,
            maxReminds: getMaxContinues(),
          };
          const saved = await writeGoal(env.sessionId, updated);
          return textOutput(`已更新目标状态：\n${serializeGoal(saved)}`);
        },
      }),
    "goal-tracker: update_goal",
  );

  ctx.effect(
    () =>
      ctx.commands.register({
        name: "goal",
        argsHint: "[objective | status | done | clear]",
        description: "设定、查看、完成或清除当前会话的长程任务目标",
        source: "plugin",
        async execute(rawArgs, env) {
          const trimmed = rawArgs.trim();
          const lower = trimmed.toLowerCase();
          if (trimmed === "" || lower === "status") {
            const existing = await readGoal(env.sessionId);
            if (existing === null) {
              return {
                output: "当前会话暂无长程目标。用法：`/goal <目标描述>` 设定新目标，`/goal done` 标记完成，或 `/goal clear` 清除。",
              };
            }
            return { output: formatGoalStatusMarkdown(existing) };
          }

          if (lower === "clear" || lower === "reset") {
            await clearGoal(env.sessionId);
            return { output: "已清除当前会话的长程目标追踪。" };
          }

          if (lower === "done" || lower === "complete") {
            const existing = await readGoal(env.sessionId);
            if (existing === null) {
              return { output: "当前会话没有正在追踪的目标。" };
            }
            const now = Date.now();
            await writeGoal(env.sessionId, {
              ...existing,
              status: "complete",
              updatedAt: now,
              completedAt: existing.completedAt ?? now,
            });
            return { output: `已将目标标记为已完成：**${existing.objective}**` };
          }

          const session = await resolveSession(env.sessionId);
          const draft = buildNewRecord(session?.id ?? sessionKeyOf(env.sessionId), trimmed);
          const created = await writeGoal(env.sessionId, draft, session);
          if (session === undefined && (env.sessionId === undefined || env.sessionId.trim() === "")) {
            pendingUnattachedGoal = created;
          }
          return { prompt: buildGoalPrompt(created) };
        },
      }),
    "goal-tracker: /goal command",
  );

  ctx.effect(
    () =>
      ctx.rpc.method("goalTracker.get", async (rawParams): Promise<GoalSnapshot> => {
        const p = isObjectRecord(rawParams) ? rawParams : {};
        const sid = typeof p.sessionId === "string" ? p.sessionId : undefined;
        return { goal: await readGoal(sid) };
      }),
    "goal-tracker: goalTracker.get",
  );

  ctx.effect(
    () =>
      ctx.rpc.method("goalTracker.complete", async (rawParams): Promise<GoalSnapshot> => {
        const p = isObjectRecord(rawParams) ? rawParams : {};
        const sid = typeof p.sessionId === "string" ? p.sessionId : undefined;
        const existing = await readGoal(sid);
        if (existing === null) return { goal: null };
        const now = Date.now();
        const saved = await writeGoal(sid, {
          ...existing,
          status: "complete",
          updatedAt: now,
          completedAt: existing.completedAt ?? now,
        });
        return { goal: saved };
      }),
    "goal-tracker: goalTracker.complete",
  );

  ctx.effect(
    () =>
      ctx.rpc.method("goalTracker.clear", async (rawParams): Promise<{ cleared: boolean }> => {
        const p = isObjectRecord(rawParams) ? rawParams : {};
        const sid = typeof p.sessionId === "string" ? p.sessionId : undefined;
        return { cleared: await clearGoal(sid) };
      }),
    "goal-tracker: goalTracker.clear",
  );

  ctx.effect(
    () =>
      ctx.rpc.method("goalTracker.toggleCriterion", async (rawParams): Promise<GoalSnapshot> => {
        const p = isObjectRecord(rawParams) ? rawParams : {};
        const sid = typeof p.sessionId === "string" ? p.sessionId : undefined;
        const criterionId = typeof p.criterionId === "string" ? p.criterionId.trim() : "";
        const existing = await readGoal(sid);
        if (existing === null || criterionId === "" || existing.criteria === undefined) {
          return { goal: existing };
        }
        let matched = false;
        const nextCriteria = existing.criteria.map((item) => {
          if (item.id !== criterionId) return item;
          matched = true;
          return { ...item, done: !item.done };
        });
        if (!matched) return { goal: existing };
        const saved = await writeGoal(sid, {
          ...existing,
          criteria: nextCriteria,
          updatedAt: Date.now(),
        });
        return { goal: saved };
      }),
    "goal-tracker: goalTracker.toggleCriterion",
  );

  ctx.effect(
    () =>
      ctx.on("agent/before-start", (session) => {
        if (!Array.isArray(session.events) || typeof session.append !== "function") return;
        const branch = currentBranch(session.events);
        let lastUserIdx = -1;
        let lastGoalIdx = -1;
        for (let i = branch.length - 1; i >= 0; i -= 1) {
          const ev = branch[i];
          if (lastUserIdx < 0 && ev?.type === "user") lastUserIdx = i;
          if (lastGoalIdx < 0 && ev?.type === "custom" && ev.data.ns === GOAL_NAMESPACE) lastGoalIdx = i;
          if (lastUserIdx >= 0 && lastGoalIdx >= 0) break;
        }

        const latestUser = lastUserIdx >= 0 ? branch[lastUserIdx] : undefined;
        const slashObjective =
          latestUser?.type === "user" ? extractSlashGoalObjective(latestUser) : undefined;

        if (
          pendingUnattachedGoal !== undefined &&
          Date.now() - pendingUnattachedGoal.createdAt <= PENDING_GOAL_TTL_MS &&
          (reconstructSessionGoal(session, getMaxContinues()) === null ||
            (slashObjective !== undefined && pendingUnattachedGoal.objective === slashObjective))
        ) {
          const attached: GoalRecord = {
            ...pendingUnattachedGoal,
            sessionId: session.id,
            maxReminds: getMaxContinues(),
          };
          pendingUnattachedGoal = undefined;
          fallbackGoals.delete("default");
          session.append("custom", { ns: GOAL_NAMESPACE, data: attached });
          return;
        }

        if (slashObjective === undefined || lastGoalIdx > lastUserIdx) return;

        const existing = reconstructSessionGoal(session, getMaxContinues());
        const hasTurnBetweenGoalAndUser =
          lastGoalIdx >= 0 &&
          branch
            .slice(lastGoalIdx + 1, lastUserIdx)
            .some((ev) => ev.type === "user" || ev.type === "assistant");
        if (
          existing !== null &&
          existing.status === "active" &&
          existing.objective === slashObjective &&
          !hasTurnBetweenGoalAndUser
        ) {
          return;
        }

        const promoted = buildNewRecord(session.id, slashObjective);
        fallbackGoals.delete("default");
        session.append("custom", { ns: GOAL_NAMESPACE, data: promoted });
      }),
    "goal-tracker: agent/before-start",
  );

  ctx.effect(
    () =>
      ctx.on("llm/request", (request, next) => {
        if (request.sessionId !== undefined && request.sessionId.trim() !== "") {
          const session = ctx.sessions.peek(request.sessionId);
          if (session !== undefined) {
            const reminder = findPendingGoalDriftReminder(session, getMaxContinues());
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
      }),
    "goal-tracker: llm/request drift reminder",
  );

  ctx.effect(
    () =>
      ctx.on("agent/before-stop", (session, info) => {
        if (rawConfig.autoRemindBeforeStop === false) return undefined;
        if (info !== undefined && info.stop !== "stop") return undefined;
        if (session.header?.side === true) return undefined;
        const maxContinues = getMaxContinues();
        if (maxContinues <= 0) return undefined;

        const hasSessionLog = Array.isArray(session.events) && typeof session.append === "function";
        const existing = hasSessionLog
          ? (reconstructSessionGoal(session, maxContinues) ?? fallbackGoals.get(session.id) ?? null)
          : (fallbackGoals.get(sessionKeyOf(session.id)) ?? null);
        if (existing === null || existing.status !== "active") return undefined;
        if (existing.remindCount >= maxContinues) return undefined;

        const nextCount = existing.remindCount + 1;
        const updated: GoalRecord = {
          ...existing,
          sessionId: hasSessionLog ? session.id : sessionKeyOf(session.id),
          remindCount: nextCount,
          maxReminds: maxContinues,
          updatedAt: Date.now(),
        };
        if (hasSessionLog) {
          session.append("custom", { ns: GOAL_NAMESPACE, data: updated });
          fallbackGoals.delete(session.id);
        } else {
          fallbackGoals.set(sessionKeyOf(session.id), updated);
        }

        let uncheckedSummary = "";
        if (existing.criteria !== undefined && existing.criteria.length > 0) {
          const unchecked = existing.criteria.filter((item) => !item.done);
          if (unchecked.length > 0) {
            const preview = unchecked.slice(0, 4).map((item) => item.text).join("；");
            const more = unchecked.length > 4 ? ` 等 ${unchecked.length} 项` : "";
            uncheckedSummary = `（仍有 ${unchecked.length}/${existing.criteria.length} 项验收标准未勾选：${preview}${more}）`;
          } else {
            uncheckedSummary = `（全部 ${existing.criteria.length} 项验收标准已勾选，但目标状态仍为 active）`;
          }
        }

        return (
          `[Goal Tracker 核查 (${nextCount}/${maxContinues})] 当前长程目标“${existing.objective}”尚未标记完成${uncheckedSummary}。` +
          `请核对所有要求与验收项是否已通过真实命令/测试验证：若仍有遗漏请继续执行；` +
          `若已全部验证通过，请调用 update_goal(status="complete", notes="简明验收结论") 收尾` +
          `（若上一轮已输出详细总结，无需重复整篇长文，仅补充简短验收确认即可）；` +
          `若确有阻塞请调用 update_goal(status="blocked", notes="...") 说明。`
        );
      }),
    "goal-tracker: agent/before-stop",
  );
}

export default {
  name,
  inject,
  apply,
};

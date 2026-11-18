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
export const DEFAULT_MAX_GOAL_ROUNDS = 256;
export const DEFAULT_BLOCKED_AFTER_ROUNDS = 3;
const DEFAULT_ROUND_DELAY_MS = 25;
const PENDING_GOAL_TTL_MS = 60_000;

export type GoalPhase = "active" | "paused" | "blocked" | "complete";
export type GoalStatus = GoalPhase;
export type GoalAction = "complete" | "blocked" | "pause" | "resume" | "edit" | "progress";

export interface GoalBlockReason {
  code: string;
  message: string;
}

export interface GoalRecord {
  id: string;
  sessionId: string;
  revision: number;
  objective: string;
  phase: GoalPhase;
  status: GoalPhase;
  roundsStarted: number;
  maxGoalRounds: number;
  createdAt: number;
  updatedAt: number;
  accumulatedMs: number;
  activeSince?: number;
  completedAt?: number;
  tokenBudget?: number;
  notes?: string;
  blockedReason?: GoalBlockReason;
  consecutiveBlockCount: number;
  lastBlockedRound?: number;
}

export interface GoalView extends GoalRecord {
  armed: boolean;
}

export interface GoalTrackerConfig {
  enableRoundDriver?: boolean;
  defaultMaxGoalRounds?: number;
  blockedAfterConsecutiveRounds?: number;
  roundDelayMs?: number;
}

export interface GoalSnapshot {
  goal: GoalView | null;
}

interface GoalClearedPayload {
  cleared: true;
  updatedAt: number;
}

interface GoalPersistedPayload extends GoalRecord {
  justCompleted?: boolean;
}

function isObjectRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function sessionKeyOf(sessionId?: string): string {
  const trimmed = sessionId?.trim();
  return trimmed !== undefined && trimmed.length > 0 ? trimmed : "default";
}

function normalizePhase(value: unknown): GoalPhase | undefined {
  if (value === "active" || value === "paused" || value === "blocked" || value === "complete") {
    return value;
  }
  return undefined;
}

export function normalizeMaxGoalRounds(value: unknown, fallback = DEFAULT_MAX_GOAL_ROUNDS): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return Math.max(1, Math.min(1000, Math.floor(value)));
}

export function normalizeBlockedThreshold(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return DEFAULT_BLOCKED_AFTER_ROUNDS;
  return Math.max(1, Math.min(10, Math.floor(value)));
}

function normalizeRoundDelayMs(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return DEFAULT_ROUND_DELAY_MS;
  return Math.max(0, Math.min(5_000, Math.floor(value)));
}

function isClearedPayload(raw: unknown): raw is GoalClearedPayload {
  return isObjectRecord(raw) && raw.cleared === true;
}

function parseBlockReason(raw: unknown): GoalBlockReason | undefined {
  if (!isObjectRecord(raw) || typeof raw.message !== "string") return undefined;
  const message = raw.message.trim();
  if (message === "") return undefined;
  const code = typeof raw.code === "string" && raw.code.trim() !== "" ? raw.code.trim() : "blocked";
  return { code, message };
}

function parseGoalRecord(raw: unknown, sessionId: string, defaultMaxRounds: number): GoalRecord | undefined {
  if (!isObjectRecord(raw) || raw.cleared === true) return undefined;
  const phase = normalizePhase(raw.phase) ?? normalizePhase(raw.status);
  const objective = typeof raw.objective === "string" ? raw.objective.trim() : "";
  if (phase === undefined || objective === "") return undefined;

  const id = typeof raw.id === "string" && raw.id.trim() !== "" ? raw.id.trim() : `goal_${Date.now()}`;
  const revision =
    typeof raw.revision === "number" && Number.isInteger(raw.revision) && raw.revision > 0 ? raw.revision : 1;
  const createdAt = typeof raw.createdAt === "number" && Number.isFinite(raw.createdAt) ? raw.createdAt : Date.now();
  const updatedAt = typeof raw.updatedAt === "number" && Number.isFinite(raw.updatedAt) ? raw.updatedAt : createdAt;
  const completedAt =
    typeof raw.completedAt === "number" && Number.isFinite(raw.completedAt) ? raw.completedAt : undefined;
  const roundsStarted =
    typeof raw.roundsStarted === "number" && Number.isFinite(raw.roundsStarted) && raw.roundsStarted >= 0
      ? Math.floor(raw.roundsStarted)
      : typeof raw.remindCount === "number" && Number.isFinite(raw.remindCount) && raw.remindCount >= 0
        ? Math.floor(raw.remindCount)
        : 0;
  const maxGoalRounds =
    typeof raw.maxGoalRounds === "number" && Number.isFinite(raw.maxGoalRounds)
      ? normalizeMaxGoalRounds(raw.maxGoalRounds, defaultMaxRounds)
      : typeof raw.maxReminds === "number" && Number.isFinite(raw.maxReminds) && raw.maxReminds > 0
        ? normalizeMaxGoalRounds(raw.maxReminds, defaultMaxRounds)
        : defaultMaxRounds;
  const accumulatedMs =
    typeof raw.accumulatedMs === "number" && Number.isFinite(raw.accumulatedMs) && raw.accumulatedMs >= 0
      ? Math.floor(raw.accumulatedMs)
      : 0;
  const activeSince =
    typeof raw.activeSince === "number" && Number.isFinite(raw.activeSince) ? raw.activeSince : undefined;
  const tokenBudget =
    typeof raw.tokenBudget === "number" && Number.isFinite(raw.tokenBudget) && raw.tokenBudget > 0
      ? Math.round(raw.tokenBudget)
      : undefined;
  const notes = typeof raw.notes === "string" && raw.notes.trim() !== "" ? raw.notes.trim() : undefined;
  const blockedReason = parseBlockReason(raw.blockedReason);
  const consecutiveBlockCount =
    typeof raw.consecutiveBlockCount === "number"
    && Number.isFinite(raw.consecutiveBlockCount)
    && raw.consecutiveBlockCount >= 0
      ? Math.floor(raw.consecutiveBlockCount)
      : 0;
  const lastBlockedRound =
    typeof raw.lastBlockedRound === "number" && Number.isFinite(raw.lastBlockedRound) && raw.lastBlockedRound >= 0
      ? Math.floor(raw.lastBlockedRound)
      : undefined;

  return {
    id,
    sessionId,
    revision,
    objective,
    phase,
    status: phase,
    roundsStarted,
    maxGoalRounds,
    createdAt,
    updatedAt,
    accumulatedMs,
    ...(activeSince === undefined ? {} : { activeSince }),
    ...(completedAt === undefined ? {} : { completedAt }),
    ...(tokenBudget === undefined ? {} : { tokenBudget }),
    ...(notes === undefined ? {} : { notes }),
    ...(blockedReason === undefined ? {} : { blockedReason }),
    consecutiveBlockCount,
    ...(lastBlockedRound === undefined ? {} : { lastBlockedRound }),
  };
}

/** Reconstruct a session's active branch GoalRecord respecting `rewind` (`toSeq`) events. */
export function reconstructSessionGoal(
  session: Session,
  defaultMaxRounds = DEFAULT_MAX_GOAL_ROUNDS,
): GoalRecord | null {
  const branch = currentBranch(session.events);
  for (let i = branch.length - 1; i >= 0; i -= 1) {
    const event = branch[i];
    if (event?.type !== "custom" || event.data.ns !== GOAL_NAMESPACE) continue;
    if (isClearedPayload(event.data.data)) return null;
    const parsed = parseGoalRecord(event.data.data, session.id, defaultMaxRounds);
    if (parsed !== undefined) return parsed;
  }
  return null;
}

export function buildGoalRoundXml(record: GoalRecord): string {
  return [
    "<goal_round>",
    `Objective: ${JSON.stringify(record.objective)}`,
    `Round: ${record.roundsStarted}/${record.maxGoalRounds}`,
    `Continue working toward the objective in this same session (Goal ID: ${record.id}, Revision: ${record.revision}).`,
    "Treat the current workspace, tool results, and durable session state as authoritative; inspect them instead of assuming earlier narration is still current.",
    "Make concrete progress and verify the result with real commands or tests.",
    'Before claiming completion, gather concrete verification evidence, inspect current goal state if needed via `get_goal`, and call `update_goal(action="complete", notes="...")`.',
    "If work remains, finish the current step cleanly and leave the goal active for the next round (or use `update_plan` for multi-step checklists).",
    'Only report a blocker via `update_goal(action="blocked", blocked_reason="...")` after genuine repeated verification.',
    "</goal_round>",
  ].join("\n");
}

export function formatGoalDriftReminder(goal: GoalRecord): string {
  const lines = [
    "<goal-reminder>",
    `Active session goal: ${goal.objective} (Round ${goal.roundsStarted}/${goal.maxGoalRounds}, Revision ${goal.revision})`,
  ];
  if (goal.notes !== undefined && goal.notes !== "") {
    lines.push(`Latest notes: ${goal.notes}`);
  }
  lines.push(
    'Keep advancing toward this goal, and call `update_goal(action="complete", notes="...")` only after concrete verification.',
    "</goal-reminder>",
  );
  return lines.join("\n");
}

function findPendingGoalDriftReminder(session: Session, defaultMaxRounds: number): string | undefined {
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
  const goal = parseGoalRecord(latestGoalEvent.data.data, session.id, defaultMaxRounds);
  if (goal === undefined || goal.phase !== "active") return undefined;
  return formatGoalDriftReminder(goal);
}

function isAutomatedGoalRoundTurn(session: Session | undefined): boolean {
  if (session === undefined || !Array.isArray(session.events)) return false;
  const branch = currentBranch(session.events);
  for (let i = branch.length - 1; i >= 0; i -= 1) {
    const ev = branch[i];
    if (ev?.type !== "user") continue;
    return (
      ev.data.content.length > 0
      && ev.data.content.every((b) => b.type === "text" && (b as { meta?: boolean }).meta === true)
      && ev.data.content.some((b) => b.type === "text" && /^\s*<goal_round>/i.test(b.text))
    );
  }
  return false;
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
  if (/^(status|pause|resume|clear|reset|done|complete)(?:\s|$)/i.test(rawArg)) return undefined;
  if (/^edit(?:\s|$)/i.test(rawArg)) return undefined;
  return rawArg;
}

function phaseLabel(view: GoalView): string {
  switch (view.phase) {
    case "complete":
      return "已完成";
    case "paused":
      return "已暂停";
    case "blocked":
      return "已受阻";
    case "active":
      return view.armed ? "进行中（自动推进已开启）" : "已挂起（未武装，输入 /goal resume 继续）";
  }
}

function formatGoalStatusMarkdown(view: GoalView): string {
  const lines = [
    `**当前目标（${phaseLabel(view)}）**：${view.objective}`,
    "",
    `- **轮次进度**：第 ${view.roundsStarted}/${view.maxGoalRounds} 轮（Revision ${view.revision}）`,
  ];
  if (view.tokenBudget !== undefined) {
    lines.push(`- **Token 预算**：${view.tokenBudget.toLocaleString()} tok`);
  }
  if (view.blockedReason !== undefined) {
    lines.push(`- **受阻原因（${view.blockedReason.code}）**：${view.blockedReason.message}`);
  } else if (view.notes !== undefined) {
    lines.push(`- **最新备注**：${view.notes}`);
  }
  lines.push(
    "",
    "可用指令：`/goal edit <新目标>` · `/goal pause` · `/goal resume` · `/goal done` · `/goal clear`",
  );
  return lines.join("\n");
}

function serializeGoalView(view: GoalView): string {
  return JSON.stringify(
    {
      id: view.id,
      sessionId: view.sessionId,
      revision: view.revision,
      objective: view.objective,
      phase: view.phase,
      status: view.status,
      armed: view.armed,
      roundsStarted: view.roundsStarted,
      maxGoalRounds: view.maxGoalRounds,
      createdAt: view.createdAt,
      updatedAt: view.updatedAt,
      accumulatedMs: view.accumulatedMs,
      ...(view.activeSince === undefined ? {} : { activeSince: view.activeSince }),
      ...(view.completedAt === undefined ? {} : { completedAt: view.completedAt }),
      ...(view.tokenBudget === undefined ? {} : { tokenBudget: view.tokenBudget }),
      ...(view.notes === undefined ? {} : { notes: view.notes }),
      ...(view.blockedReason === undefined ? {} : { blockedReason: view.blockedReason }),
      consecutiveBlockCount: view.consecutiveBlockCount,
    },
    null,
    2,
  );
}

function freezeElapsed(record: GoalRecord, now: number): { accumulatedMs: number; activeSince?: number } {
  if (record.activeSince === undefined) {
    return { accumulatedMs: record.accumulatedMs };
  }
  return {
    accumulatedMs: record.accumulatedMs + Math.max(0, now - record.activeSince),
  };
}

function normalizeActionArg(
  rawAction: unknown,
  rawStatus: unknown,
  currentPhase: GoalPhase,
): GoalAction | undefined {
  if (
    rawAction === "complete"
    || rawAction === "blocked"
    || rawAction === "pause"
    || rawAction === "resume"
    || rawAction === "edit"
    || rawAction === "progress"
  ) {
    return rawAction;
  }
  if (rawAction !== undefined) return undefined;
  if (rawStatus === "complete") return "complete";
  if (rawStatus === "blocked") return "blocked";
  if (rawStatus === "paused") return "pause";
  if (rawStatus === "active") return currentPhase === "active" ? "progress" : "resume";
  if (rawStatus !== undefined) return undefined;
  return "progress";
}

function checkCas(
  existing: GoalRecord,
  goalId: unknown,
  revision: unknown,
): string | undefined {
  if (typeof goalId === "string" && goalId.trim() !== "" && goalId.trim() !== existing.id) {
    return `目标 ID 冲突：期望 ${goalId.trim()}，实际 ${existing.id}`;
  }
  if (revision !== undefined) {
    if (typeof revision !== "number" || !Number.isInteger(revision) || revision !== existing.revision) {
      return `目标版本 CAS 冲突：期望 revision=${String(revision)}，实际 revision=${existing.revision}`;
    }
  }
  return undefined;
}

export function apply(ctx: Context, rawConfig: GoalTrackerConfig = {}): void {
  const fallbackGoals = new Map<string, GoalRecord>();
  const armedSessions = new Map<string, string>();
  const drivingSessions = new Set<string>();
  const pendingTimers = new Map<string, { timer: ReturnType<typeof setTimeout>; release: () => void }>();
  let pendingUnattachedGoal: GoalRecord | undefined;
  let sequence = 0;
  let disposed = false;

  const getDefaultMaxRounds = (): number => normalizeMaxGoalRounds(rawConfig.defaultMaxGoalRounds);
  const getBlockedThreshold = (): number => normalizeBlockedThreshold(rawConfig.blockedAfterConsecutiveRounds);
  const getRoundDelayMs = (): number => normalizeRoundDelayMs(rawConfig.roundDelayMs);

  const isArmed = (sessionId: string, record: GoalRecord): boolean =>
    record.phase === "active" && armedSessions.get(sessionId) === record.id;

  const toView = (sessionId: string, record: GoalRecord): GoalView => ({
    ...record,
    armed: isArmed(sessionId, record),
  });

  const broadcastChange = (sessionId: string, record: GoalRecord | null): void => {
    try {
      ctx.rpc.broadcast("goalTracker/changed", {
        sessionId,
        goal: record === null ? null : toView(sessionId, record),
      });
    } catch {
      // Ignore broadcast errors during teardown.
    }
  };

  const cancelScheduledRound = (sessionId: string): void => {
    const entry = pendingTimers.get(sessionId);
    if (entry === undefined) return;
    clearTimeout(entry.timer);
    pendingTimers.delete(sessionId);
    entry.release();
  };

  const disarmSession = (sessionId: string): void => {
    cancelScheduledRound(sessionId);
    armedSessions.delete(sessionId);
  };

  ctx.effect(() => () => {
    disposed = true;
    for (const sessionId of [...pendingTimers.keys()]) {
      cancelScheduledRound(sessionId);
    }
    armedSessions.clear();
  }, "goal-tracker: dispose timers");

  const resolveSession = async (sessionId?: string): Promise<Session | undefined> => {
    const trimmed = sessionId?.trim();
    if (trimmed === undefined || trimmed === "" || trimmed === "default") return undefined;
    return await ctx.sessions.get(trimmed);
  };

  const buildNewRecord = (
    sessionKey: string,
    objective: string,
    options?: {
      roundsStarted?: number;
      maxGoalRounds?: number;
      tokenBudget?: number;
      notes?: string;
    },
  ): GoalRecord => {
    const now = Date.now();
    sequence += 1;
    return {
      id: `goal_${now}_${sequence}`,
      sessionId: sessionKey,
      revision: 1,
      objective,
      phase: "active",
      status: "active",
      roundsStarted: options?.roundsStarted ?? 1,
      maxGoalRounds: normalizeMaxGoalRounds(options?.maxGoalRounds, getDefaultMaxRounds()),
      createdAt: now,
      updatedAt: now,
      accumulatedMs: 0,
      activeSince: now,
      consecutiveBlockCount: 0,
      ...(typeof options?.tokenBudget === "number" && Number.isFinite(options.tokenBudget) && options.tokenBudget > 0
        ? { tokenBudget: Math.round(options.tokenBudget) }
        : {}),
      ...(typeof options?.notes === "string" && options.notes.trim() !== ""
        ? { notes: options.notes.trim() }
        : {}),
    };
  };

  const readGoal = async (sessionId?: string): Promise<GoalRecord | null> => {
    const session = await resolveSession(sessionId);
    if (session !== undefined) {
      const persisted = reconstructSessionGoal(session, getDefaultMaxRounds());
      if (persisted !== null) return persisted;
      return fallbackGoals.get(session.id) ?? null;
    }
    return fallbackGoals.get(sessionKeyOf(sessionId)) ?? null;
  };

  const writeGoal = async (
    sessionId: string | undefined,
    record: GoalRecord,
    options?: { explicitSession?: Session; justCompleted?: boolean; arm?: boolean },
  ): Promise<GoalRecord> => {
    const session = options?.explicitSession ?? (await resolveSession(sessionId));
    const key = session !== undefined ? session.id : sessionKeyOf(sessionId);
    const normalized: GoalRecord = { ...record, sessionId: key, status: record.phase };
    if (options?.arm === true && normalized.phase === "active") {
      armedSessions.set(key, normalized.id);
    } else if (options?.arm === false || normalized.phase !== "active") {
      disarmSession(key);
    }

    if (session !== undefined) {
      const payload: GoalPersistedPayload = {
        ...normalized,
        ...(options?.justCompleted === true ? { justCompleted: true } : {}),
      };
      session.append("custom", { ns: GOAL_NAMESPACE, data: payload });
      fallbackGoals.delete(session.id);
      if (pendingUnattachedGoal?.id === normalized.id) {
        pendingUnattachedGoal = undefined;
      }
      broadcastChange(session.id, normalized);
      return normalized;
    }

    fallbackGoals.set(key, normalized);
    broadcastChange(key, normalized);
    return normalized;
  };

  const clearGoal = async (sessionId?: string, explicitSession?: Session): Promise<boolean> => {
    const session = explicitSession ?? (await resolveSession(sessionId));
    const key = session !== undefined ? session.id : sessionKeyOf(sessionId);
    disarmSession(key);
    if (session !== undefined) {
      let cleared = false;
      if (reconstructSessionGoal(session, getDefaultMaxRounds()) !== null) {
        const payload: GoalClearedPayload = { cleared: true, updatedAt: Date.now() };
        session.append("custom", { ns: GOAL_NAMESPACE, data: payload });
        cleared = true;
      }
      if (fallbackGoals.delete(session.id)) cleared = true;
      if (cleared) broadcastChange(session.id, null);
      return cleared;
    }
    if (key === "default") pendingUnattachedGoal = undefined;
    const removed = fallbackGoals.delete(key);
    if (removed) broadcastChange(key, null);
    return removed;
  };

  const driveNextGoalRound = async (
    sessionId: string,
    expectedGoalId: string,
    expectedRevision: number,
  ): Promise<boolean> => {
    if (disposed || drivingSessions.has(sessionId) || rawConfig.enableRoundDriver === false) return false;
    drivingSessions.add(sessionId);
    try {
      const session = await ctx.sessions.get(sessionId);
      if (session === undefined || disposed) return false;
      const agentStatus = ctx.agents.status(sessionId);
      if (agentStatus.running || agentStatus.queue.steer > 0 || agentStatus.queue.followUp > 0) return false;

      const hasRunningChild = ctx.sessions
        .openSessions()
        .some((child) => child.header.parent?.sessionId === sessionId && ctx.agents.status(child.id).running);
      if (hasRunningChild) return false;
      if (session.state().model === undefined) return false;

      const current = reconstructSessionGoal(session, getDefaultMaxRounds());
      if (
        current === null
        || current.id !== expectedGoalId
        || current.revision !== expectedRevision
        || current.phase !== "active"
        || !isArmed(sessionId, current)
      ) {
        return false;
      }

      const now = Date.now();
      if (current.tokenBudget !== undefined) {
        const usage = session.summary().usage;
        const used = usage.inputTokens + usage.outputTokens + usage.cacheReadTokens + usage.cacheWriteTokens;
        if (used >= current.tokenBudget) {
          const message = `已达到 Token 预算上限（${used.toLocaleString()} / ${current.tokenBudget.toLocaleString()} tok）`;
          await writeGoal(
            sessionId,
            {
              ...current,
              phase: "blocked",
              status: "blocked",
              revision: current.revision + 1,
              updatedAt: now,
              ...freezeElapsed(current, now),
              blockedReason: { code: "token-budget", message },
              notes: message,
            },
            { explicitSession: session, arm: false },
          );
          return false;
        }
      }

      if (current.roundsStarted >= current.maxGoalRounds) {
        const message = `已达到最大自动推进轮次上限（${current.roundsStarted}/${current.maxGoalRounds} 轮）`;
        await writeGoal(
          sessionId,
          {
            ...current,
            phase: "blocked",
            status: "blocked",
            revision: current.revision + 1,
            updatedAt: now,
            ...freezeElapsed(current, now),
            blockedReason: { code: "round-limit", message },
            notes: message,
          },
          { explicitSession: session, arm: false },
        );
        return false;
      }

      const reserved = await writeGoal(
        sessionId,
        {
          ...current,
          roundsStarted: current.roundsStarted + 1,
          revision: current.revision + 1,
          updatedAt: now,
          activeSince: current.activeSince ?? now,
        },
        { explicitSession: session, arm: true },
      );

      ctx.agents.prompt(session, [{ type: "text", text: buildGoalRoundXml(reserved), meta: true }]);
      return true;
    } finally {
      drivingSessions.delete(sessionId);
    }
  };

  const scheduleGoalRound = (sessionId: string, goalId: string, revision: number, delayMs: number): void => {
    if (disposed || rawConfig.enableRoundDriver === false) return;
    cancelScheduledRound(sessionId);
    const release = ctx.sessions.hold(sessionId);
    const timer = setTimeout(() => {
      pendingTimers.delete(sessionId);
      void driveNextGoalRound(sessionId, goalId, revision).finally(release);
    }, delayMs);
    pendingTimers.set(sessionId, { timer, release });
  };

  const pauseSessionGoal = async (
    sessionId: string | undefined,
    cas?: { goalId?: unknown; revision?: unknown },
    notes?: string,
  ): Promise<{ goal: GoalRecord | null; error?: string }> => {
    const existing = await readGoal(sessionId);
    if (existing === null) return { goal: null };
    const conflict = checkCas(existing, cas?.goalId, cas?.revision);
    if (conflict !== undefined) return { goal: existing, error: conflict };
    if (existing.phase === "complete") return { goal: existing, error: "当前目标已完成，无法暂停。" };

    const now = Date.now();
    const saved = await writeGoal(
      sessionId,
      {
        ...existing,
        phase: "paused",
        status: "paused",
        revision: existing.revision + 1,
        updatedAt: now,
        ...freezeElapsed(existing, now),
        ...(notes !== undefined && notes.trim() !== "" ? { notes: notes.trim() } : {}),
      },
      { arm: false },
    );
    return { goal: saved };
  };

  const resumeSessionGoal = async (
    sessionId: string | undefined,
    cas?: { goalId?: unknown; revision?: unknown },
    notes?: string,
  ): Promise<{ goal: GoalRecord | null; error?: string }> => {
    const session = await resolveSession(sessionId);
    const existing = await readGoal(sessionId);
    if (existing === null) return { goal: null };
    const conflict = checkCas(existing, cas?.goalId, cas?.revision);
    if (conflict !== undefined) return { goal: existing, error: conflict };
    if (existing.phase === "complete") return { goal: existing, error: "当前目标已完成，请使用 /goal <新目标> 重新开启。" };
    if (existing.roundsStarted >= existing.maxGoalRounds) {
      return {
        goal: existing,
        error: `目标已达最大轮次上限（${existing.roundsStarted}/${existing.maxGoalRounds}），请使用 /goal <新目标> 或 /goal clear。`,
      };
    }

    const now = Date.now();
    const { blockedReason: _dropReason, lastBlockedRound: _dropRound, ...rest } = existing;
    const saved = await writeGoal(
      sessionId,
      {
        ...rest,
        phase: "active",
        status: "active",
        revision: existing.revision + 1,
        updatedAt: now,
        activeSince: existing.activeSince ?? now,
        consecutiveBlockCount: 0,
        ...(notes !== undefined && notes.trim() !== "" ? { notes: notes.trim() } : {}),
      },
      { explicitSession: session, arm: true },
    );

    if (
      session !== undefined
      && rawConfig.enableRoundDriver !== false
      && !ctx.agents.status(session.id).running
      && session.state().model !== undefined
    ) {
      void driveNextGoalRound(session.id, saved.id, saved.revision);
    }

    return { goal: saved };
  };

  const editSessionGoal = async (
    sessionId: string | undefined,
    objective: string,
    cas?: { goalId?: unknown; revision?: unknown },
    options?: { maxGoalRounds?: number; notes?: string },
  ): Promise<{ goal: GoalRecord | null; error?: string }> => {
    const trimmed = objective.trim();
    if (trimmed === "") return { goal: null, error: "目标描述不能为空。" };
    const existing = await readGoal(sessionId);
    if (existing === null) return { goal: null };
    const conflict = checkCas(existing, cas?.goalId, cas?.revision);
    if (conflict !== undefined) return { goal: existing, error: conflict };

    const key = sessionKeyOf(existing.sessionId);
    const keepArmed = isArmed(key, existing);
    const { lastBlockedRound: _dropRound, ...rest } = existing;
    const saved = await writeGoal(
      sessionId,
      {
        ...rest,
        objective: trimmed,
        revision: existing.revision + 1,
        updatedAt: Date.now(),
        consecutiveBlockCount: 0,
        ...(options?.maxGoalRounds !== undefined
          ? { maxGoalRounds: normalizeMaxGoalRounds(options.maxGoalRounds, existing.maxGoalRounds) }
          : {}),
        ...(options?.notes !== undefined && options.notes.trim() !== "" ? { notes: options.notes.trim() } : {}),
      },
      { arm: keepArmed },
    );
    return { goal: saved };
  };

  const completeSessionGoal = async (
    sessionId: string | undefined,
    cas?: { goalId?: unknown; revision?: unknown },
    notes?: string,
  ): Promise<{ goal: GoalRecord | null; error?: string }> => {
    const existing = await readGoal(sessionId);
    if (existing === null) return { goal: null };
    const conflict = checkCas(existing, cas?.goalId, cas?.revision);
    if (conflict !== undefined) return { goal: existing, error: conflict };

    const now = Date.now();
    const { blockedReason: _dropReason, lastBlockedRound: _dropRound, ...rest } = existing;
    const saved = await writeGoal(
      sessionId,
      {
        ...rest,
        phase: "complete",
        status: "complete",
        revision: existing.revision + 1,
        updatedAt: now,
        completedAt: existing.completedAt ?? now,
        ...freezeElapsed(existing, now),
        consecutiveBlockCount: 0,
        ...(notes !== undefined && notes.trim() !== "" ? { notes: notes.trim() } : {}),
      },
      { justCompleted: true, arm: false },
    );
    return { goal: saved };
  };

  ctx.effect(
    () =>
      ctx.tools.register<{
        objective: string;
        max_goal_rounds?: number;
        token_budget?: number;
        notes?: string;
      }>({
        name: "create_goal",
        description: "为当前会话设定长程任务目标，由调度器持续多轮推进直至经验证达成。",
        parameters: {
          type: "object",
          properties: {
            objective: { type: "string", description: "清晰、可验证的最终完成目标" },
            max_goal_rounds: { type: "number", description: "可选：最大自动推进轮次（1–1000，默认 256）" },
            token_budget: { type: "number", description: "可选：会话 Token 预算上限（如 120000）" },
            notes: { type: "string", description: "可选：约束条件或补充备注" },
          },
          required: ["objective"],
        },
        async execute(args, env) {
          const objective = typeof args.objective === "string" ? args.objective.trim() : "";
          if (objective === "") {
            return textOutput("create_goal 失败：objective 不能为空。", true);
          }
          const session = await resolveSession(env.sessionId);
          const existing = await readGoal(env.sessionId);
          if (existing !== null && existing.phase === "active" && isAutomatedGoalRoundTurn(session)) {
            return textOutput(
              "create_goal 拒绝：当前处于自动推进轮次中且已有活跃目标，禁止重置 roundsStarted 或替换目标。请使用 update_goal 更新当前目标。",
              true,
            );
          }
          const key = session?.id ?? sessionKeyOf(env.sessionId);
          const draft = buildNewRecord(key, objective, {
            roundsStarted: 1,
            maxGoalRounds: args.max_goal_rounds,
            tokenBudget: args.token_budget,
            notes: args.notes,
          });
          const created = await writeGoal(env.sessionId, draft, { explicitSession: session, arm: true });
          return textOutput(`已建立会话目标：\n${serializeGoalView(toView(created.sessionId, created))}`);
        },
      }),
    "goal-tracker: create_goal",
  );

  ctx.effect(
    () =>
      ctx.tools.register({
        name: "get_goal",
        description: "读取当前会话长程目标的 id、revision、phase、armed 状态与轮次进度。",
        readOnly: true,
        parameters: { type: "object", properties: {} },
        async execute(_args, env) {
          const record = await readGoal(env.sessionId);
          if (record === null) {
            return textOutput("当前会话尚未设定长程目标。");
          }
          return textOutput(serializeGoalView(toView(record.sessionId, record)));
        },
      }),
    "goal-tracker: get_goal",
  );

  ctx.effect(
    () =>
      ctx.tools.register<{
        action?: GoalAction;
        goal_id?: string;
        revision?: number;
        objective?: string;
        max_goal_rounds?: number;
        blocked_reason?: string;
        notes?: string;
        status?: GoalPhase;
      }>({
        name: "update_goal",
        description:
          "按 DSH 状态机更新当前长程目标（支持 action: complete | blocked | pause | resume | edit | progress 及 goal_id/revision CAS 校验）。",
        parameters: {
          type: "object",
          properties: {
            action: {
              type: "string",
              enum: ["complete", "blocked", "pause", "resume", "edit", "progress"],
              description: "状态流转动作",
            },
            goal_id: { type: "string", description: "可选：用于 CAS 校验的 goal id" },
            revision: { type: "number", description: "可选：用于 CAS 校验的 revision 版本号" },
            objective: { type: "string", description: "仅在 action=\"edit\" 时用于修改目标描述" },
            max_goal_rounds: { type: "number", description: "仅非自动轮次且 action=\"edit\" 时可调整最大轮次" },
            blocked_reason: { type: "string", description: "当 action=\"blocked\" 时必填：具体阻塞原因" },
            notes: { type: "string", description: "可选：阶段进展摘要或验收结论" },
            status: {
              type: "string",
              enum: ["active", "paused", "blocked", "complete"],
              description: "兼容别名（建议优先使用 action）",
            },
          },
        },
        async execute(args, env) {
          const session = await resolveSession(env.sessionId);
          const existing = await readGoal(env.sessionId);
          if (existing === null) {
            return textOutput("当前会话尚无活动目标，请先调用 create_goal。", true);
          }

          const conflict = checkCas(existing, args.goal_id, args.revision);
          if (conflict !== undefined) {
            return textOutput(`update_goal ${conflict}，请先调用 get_goal 获取最新状态。`, true);
          }

          const action = normalizeActionArg(args.action, args.status, existing.phase);
          if (action === undefined) {
            return textOutput(
              "无效的 action/status，仅支持 complete、blocked、pause、resume、edit 或 progress。",
              true,
            );
          }

          const key = session?.id ?? existing.sessionId;
          const notesArg = typeof args.notes === "string" && args.notes.trim() !== "" ? args.notes.trim() : undefined;

          if (action === "complete") {
            const res = await completeSessionGoal(env.sessionId, undefined, notesArg);
            if (res.error !== undefined || res.goal === null) {
              return textOutput(res.error ?? "标记完成失败。", true);
            }
            return textOutput(`已更新目标状态：\n${serializeGoalView(toView(res.goal.sessionId, res.goal))}`);
          }

          if (action === "pause") {
            const res = await pauseSessionGoal(env.sessionId, undefined, notesArg);
            if (res.error !== undefined || res.goal === null) {
              return textOutput(res.error ?? "暂停目标失败。", true);
            }
            return textOutput(`已暂停目标：\n${serializeGoalView(toView(res.goal.sessionId, res.goal))}`);
          }

          if (action === "resume") {
            const now = Date.now();
            const { blockedReason: _dropReason, lastBlockedRound: _dropRound, ...rest } = existing;
            const saved = await writeGoal(
              env.sessionId,
              {
                ...rest,
                phase: "active",
                status: "active",
                revision: existing.revision + 1,
                updatedAt: now,
                activeSince: existing.activeSince ?? now,
                consecutiveBlockCount: 0,
                ...(notesArg === undefined ? {} : { notes: notesArg }),
              },
              { explicitSession: session, arm: true },
            );
            return textOutput(`已恢复目标：\n${serializeGoalView(toView(saved.sessionId, saved))}`);
          }

          if (action === "edit") {
            if (args.max_goal_rounds !== undefined && isAutomatedGoalRoundTurn(session)) {
              return textOutput(
                "update_goal 拒绝：自动推进轮次中禁止提高或篡改 max_goal_rounds 轮次上限。",
                true,
              );
            }
            const nextObjective =
              typeof args.objective === "string" && args.objective.trim() !== ""
                ? args.objective.trim()
                : existing.objective;
            const res = await editSessionGoal(env.sessionId, nextObjective, undefined, {
              ...(args.max_goal_rounds === undefined ? {} : { maxGoalRounds: args.max_goal_rounds }),
              ...(notesArg === undefined ? {} : { notes: notesArg }),
            });
            if (res.error !== undefined || res.goal === null) {
              return textOutput(res.error ?? "修订目标失败。", true);
            }
            return textOutput(`已修订目标：\n${serializeGoalView(toView(res.goal.sessionId, res.goal))}`);
          }

          if (action === "blocked") {
            const reason =
              (typeof args.blocked_reason === "string" ? args.blocked_reason.trim() : "") || (notesArg ?? "");
            if (reason === "") {
              return textOutput('update_goal(action="blocked") 必须提供非空的 blocked_reason 或 notes。', true);
            }
            const threshold = getBlockedThreshold();
            const armedNow = isArmed(key, existing);
            const currentRound = existing.roundsStarted;
            const sameRound = existing.lastBlockedRound === currentRound;

            if (armedNow) {
              if (sameRound && existing.consecutiveBlockCount < threshold) {
                return textOutput(
                  `当前第 ${currentRound} 轮已记录受阻信号（${existing.consecutiveBlockCount}/${threshold}）：${reason}。请继续尝试排查或换用其他方法验证，若连续 ${threshold} 轮均无法解决再进入 blocked 态。`,
                );
              }
              const nextCount = sameRound ? existing.consecutiveBlockCount : existing.consecutiveBlockCount + 1;
              if (nextCount < threshold) {
                const kept = await writeGoal(
                  env.sessionId,
                  {
                    ...existing,
                    revision: existing.revision + 1,
                    updatedAt: Date.now(),
                    notes: reason,
                    consecutiveBlockCount: nextCount,
                    lastBlockedRound: currentRound,
                  },
                  { explicitSession: session, arm: true },
                );
                return textOutput(
                  `已记录连续受阻信号（${nextCount}/${threshold} 轮，Revision ${kept.revision}）：${reason}。请继续排查或尝试替代方案，达到 ${threshold} 轮阈值后方可转入 blocked 态。`,
                );
              }

              const now = Date.now();
              const blockedRecord = await writeGoal(
                env.sessionId,
                {
                  ...existing,
                  phase: "blocked",
                  status: "blocked",
                  revision: existing.revision + 1,
                  updatedAt: now,
                  ...freezeElapsed(existing, now),
                  notes: reason,
                  blockedReason: { code: "model-blocked", message: reason },
                  consecutiveBlockCount: nextCount,
                  lastBlockedRound: currentRound,
                },
                { explicitSession: session, arm: false },
              );
              return textOutput(`目标已进入受阻态：\n${serializeGoalView(toView(blockedRecord.sessionId, blockedRecord))}`);
            }

            const now = Date.now();
            const blockedRecord = await writeGoal(
              env.sessionId,
              {
                ...existing,
                phase: "blocked",
                status: "blocked",
                revision: existing.revision + 1,
                updatedAt: now,
                ...freezeElapsed(existing, now),
                notes: reason,
                blockedReason: { code: "model-blocked", message: reason },
                consecutiveBlockCount: existing.consecutiveBlockCount + (sameRound ? 0 : 1),
                lastBlockedRound: currentRound,
              },
              { explicitSession: session, arm: false },
            );
            return textOutput(`目标已进入受阻态：\n${serializeGoalView(toView(blockedRecord.sessionId, blockedRecord))}`);
          }

          // action === "progress"
          const { lastBlockedRound: _dropRound, ...rest } = existing;
          const keepArmed = isArmed(key, existing);
          const progressed = await writeGoal(
            env.sessionId,
            {
              ...rest,
              revision: existing.revision + 1,
              updatedAt: Date.now(),
              consecutiveBlockCount: 0,
              ...(notesArg === undefined ? {} : { notes: notesArg }),
            },
            { explicitSession: session, arm: keepArmed },
          );
          return textOutput(`已更新目标进展：\n${serializeGoalView(toView(progressed.sessionId, progressed))}`);
        },
      }),
    "goal-tracker: update_goal",
  );

  ctx.effect(
    () =>
      ctx.commands.register({
        name: "goal",
        argsHint: "[objective | edit <text> | pause | resume | clear]",
        description: "设定、编辑、暂停、恢复或清除当前会话的长程任务目标（纯控制面不入聊天流）",
        source: "plugin",
        async execute(rawArgs, env) {
          const trimmed = rawArgs.trim();
          const lower = trimmed.toLowerCase();

          if (trimmed === "" || lower === "status") {
            const existing = await readGoal(env.sessionId);
            if (existing === null) {
              return {
                output:
                  "当前会话暂无长程目标。用法：`/goal <目标描述>` 启动目标，`/goal edit <新描述>` 修改，`/goal pause` 暂停，`/goal resume` 恢复，`/goal clear` 清除。",
              };
            }
            return { output: formatGoalStatusMarkdown(toView(existing.sessionId, existing)) };
          }

          if (lower === "pause") {
            const res = await pauseSessionGoal(env.sessionId);
            if (res.goal === null) return { output: "当前会话暂无进行中的目标。" };
            if (res.error !== undefined) return { output: res.error, isError: true };
            return {
              output: `已暂停长程目标（第 ${res.goal.roundsStarted}/${res.goal.maxGoalRounds} 轮）：**${res.goal.objective}**`,
            };
          }

          if (lower === "resume") {
            const res = await resumeSessionGoal(env.sessionId);
            if (res.goal === null) return { output: "当前会话暂无可恢复的目标。" };
            if (res.error !== undefined) return { output: res.error, isError: true };
            return {
              output: `已恢复长程目标并继续推进（第 ${res.goal.roundsStarted}/${res.goal.maxGoalRounds} 轮）：**${res.goal.objective}**`,
            };
          }

          const editMatch = /^edit(?:\s+([\s\S]*))?$/i.exec(trimmed);
          if (editMatch !== null) {
            const nextText = (editMatch[1] ?? "").trim();
            if (nextText === "") {
              return { output: "用法：`/goal edit <新的目标描述>`", isError: true };
            }
            const res = await editSessionGoal(env.sessionId, nextText);
            if (res.goal === null) {
              return { output: "当前会话暂无可编辑的目标，请先使用 `/goal <目标描述>`。", isError: true };
            }
            if (res.error !== undefined) return { output: res.error, isError: true };
            return { output: `已更新目标描述：**${res.goal.objective}**` };
          }

          if (lower === "clear" || lower === "reset") {
            await clearGoal(env.sessionId);
            return { output: "已清除当前会话的长程目标追踪。" };
          }

          if (lower === "done" || lower === "complete") {
            const res = await completeSessionGoal(env.sessionId);
            if (res.goal === null) return { output: "当前会话没有正在追踪的目标。" };
            if (res.error !== undefined) return { output: res.error, isError: true };
            return { output: `已将目标标记为已完成：**${res.goal.objective}**` };
          }

          const session = await resolveSession(env.sessionId);
          const isRunning = session !== undefined && ctx.agents.status(session.id).running;
          const draft = buildNewRecord(session?.id ?? sessionKeyOf(env.sessionId), trimmed, {
            roundsStarted: isRunning ? 0 : 1,
          });
          const created = await writeGoal(env.sessionId, draft, { explicitSession: session, arm: true });
          if (session === undefined && (env.sessionId === undefined || env.sessionId.trim() === "")) {
            pendingUnattachedGoal = created;
          }
          if (isRunning) {
            return {
              output: `已设定长程目标（当前轮次完成后自动开启第 1/${created.maxGoalRounds} 轮）：**${created.objective}**`,
            };
          }
          return { prompt: buildGoalRoundXml(created) };
        },
      }),
    "goal-tracker: /goal command",
  );

  ctx.effect(
    () =>
      ctx.rpc.method("goalTracker.get", async (rawParams): Promise<GoalSnapshot> => {
        const p = isObjectRecord(rawParams) ? rawParams : {};
        const sid = typeof p.sessionId === "string" ? p.sessionId : undefined;
        const record = await readGoal(sid);
        return { goal: record === null ? null : toView(record.sessionId, record) };
      }),
    "goal-tracker: goalTracker.get",
  );

  ctx.effect(
    () =>
      ctx.rpc.method("goalTracker.pause", async (rawParams): Promise<GoalSnapshot> => {
        const p = isObjectRecord(rawParams) ? rawParams : {};
        const sid = typeof p.sessionId === "string" ? p.sessionId : undefined;
        const res = await pauseSessionGoal(sid, { goalId: p.goalId, revision: p.revision });
        if (res.error !== undefined) throw new Error(res.error);
        return { goal: res.goal === null ? null : toView(res.goal.sessionId, res.goal) };
      }),
    "goal-tracker: goalTracker.pause",
  );

  ctx.effect(
    () =>
      ctx.rpc.method("goalTracker.resume", async (rawParams): Promise<GoalSnapshot> => {
        const p = isObjectRecord(rawParams) ? rawParams : {};
        const sid = typeof p.sessionId === "string" ? p.sessionId : undefined;
        const res = await resumeSessionGoal(sid, { goalId: p.goalId, revision: p.revision });
        if (res.error !== undefined) throw new Error(res.error);
        return { goal: res.goal === null ? null : toView(res.goal.sessionId, res.goal) };
      }),
    "goal-tracker: goalTracker.resume",
  );

  ctx.effect(
    () =>
      ctx.rpc.method("goalTracker.edit", async (rawParams): Promise<GoalSnapshot> => {
        const p = isObjectRecord(rawParams) ? rawParams : {};
        const sid = typeof p.sessionId === "string" ? p.sessionId : undefined;
        const objective = typeof p.objective === "string" ? p.objective : "";
        const res = await editSessionGoal(sid, objective, { goalId: p.goalId, revision: p.revision });
        if (res.error !== undefined) throw new Error(res.error);
        return { goal: res.goal === null ? null : toView(res.goal.sessionId, res.goal) };
      }),
    "goal-tracker: goalTracker.edit",
  );

  ctx.effect(
    () =>
      ctx.rpc.method("goalTracker.complete", async (rawParams): Promise<GoalSnapshot> => {
        const p = isObjectRecord(rawParams) ? rawParams : {};
        const sid = typeof p.sessionId === "string" ? p.sessionId : undefined;
        const res = await completeSessionGoal(sid, { goalId: p.goalId, revision: p.revision });
        if (res.error !== undefined) throw new Error(res.error);
        return { goal: res.goal === null ? null : toView(res.goal.sessionId, res.goal) };
      }),
    "goal-tracker: goalTracker.complete",
  );

  ctx.effect(
    () =>
      ctx.rpc.method("goalTracker.clear", async (rawParams): Promise<{ cleared: boolean }> => {
        const p = isObjectRecord(rawParams) ? rawParams : {};
        const sid = typeof p.sessionId === "string" ? p.sessionId : undefined;
        if (p.goalId !== undefined || p.revision !== undefined) {
          const existing = await readGoal(sid);
          if (existing === null) return { cleared: false };
          const conflict = checkCas(existing, p.goalId, p.revision);
          if (conflict !== undefined) throw new Error(conflict);
        }
        return { cleared: await clearGoal(sid) };
      }),
    "goal-tracker: goalTracker.clear",
  );

  ctx.effect(
    () =>
      ctx.on("session/event", (session, event) => {
        if (event.type !== "rewind") return;
        disarmSession(session.id);
        broadcastChange(session.id, reconstructSessionGoal(session, getDefaultMaxRounds()));
      }),
    "goal-tracker: rewind disarm",
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
          pendingUnattachedGoal !== undefined
          && Date.now() - pendingUnattachedGoal.createdAt <= PENDING_GOAL_TTL_MS
          && (reconstructSessionGoal(session, getDefaultMaxRounds()) === null
            || (slashObjective !== undefined && pendingUnattachedGoal.objective === slashObjective))
        ) {
          const attached: GoalRecord = {
            ...pendingUnattachedGoal,
            sessionId: session.id,
            maxGoalRounds: getDefaultMaxRounds(),
          };
          pendingUnattachedGoal = undefined;
          fallbackGoals.delete("default");
          armedSessions.set(session.id, attached.id);
          session.append("custom", { ns: GOAL_NAMESPACE, data: attached });
          broadcastChange(session.id, attached);
          return;
        }

        if (slashObjective === undefined) return;
        const existing = reconstructSessionGoal(session, getDefaultMaxRounds());
        if (lastGoalIdx > lastUserIdx) {
          if (existing !== null && existing.phase === "active") {
            armedSessions.set(session.id, existing.id);
          }
          return;
        }

        const hasTurnBetweenGoalAndUser =
          lastGoalIdx >= 0
          && branch
            .slice(lastGoalIdx + 1, lastUserIdx)
            .some((ev) => ev.type === "user" || ev.type === "assistant");
        if (
          existing !== null
          && existing.phase === "active"
          && existing.objective === slashObjective
          && !hasTurnBetweenGoalAndUser
        ) {
          armedSessions.set(session.id, existing.id);
          return;
        }

        const promoted = buildNewRecord(session.id, slashObjective, { roundsStarted: 1 });
        fallbackGoals.delete("default");
        armedSessions.set(session.id, promoted.id);
        session.append("custom", { ns: GOAL_NAMESPACE, data: promoted });
        broadcastChange(session.id, promoted);
      }),
    "goal-tracker: agent/before-start",
  );

  ctx.effect(
    () =>
      ctx.on("llm/request", (request, next) => {
        if (request.sessionId !== undefined && request.sessionId.trim() !== "") {
          const session = ctx.sessions.peek(request.sessionId);
          if (session !== undefined) {
            const reminder = findPendingGoalDriftReminder(session, getDefaultMaxRounds());
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
      ctx.on("agent/settled", async (session, outcome) => {
        if (disposed) return;
        if (session.header?.side === true || session.header?.parent !== undefined) return;
        if (!Array.isArray(session.events) || typeof session.append !== "function") return;

        const existing = reconstructSessionGoal(session, getDefaultMaxRounds());
        if (existing === null) return;

        if (outcome === "aborted") {
          disarmSession(session.id);
          if (existing.phase === "active") {
            const now = Date.now();
            await writeGoal(
              session.id,
              {
                ...existing,
                phase: "paused",
                status: "paused",
                revision: existing.revision + 1,
                updatedAt: now,
                ...freezeElapsed(existing, now),
              },
              { explicitSession: session, arm: false },
            );
          }
          return;
        }

        if (outcome === "error") {
          disarmSession(session.id);
          if (existing.phase === "active") {
            const now = Date.now();
            const message = "上一轮模型或工具执行异常中断，已暂停自动推进等待排查。";
            await writeGoal(
              session.id,
              {
                ...existing,
                phase: "blocked",
                status: "blocked",
                revision: existing.revision + 1,
                updatedAt: now,
                ...freezeElapsed(existing, now),
                blockedReason: { code: "error", message },
                notes: message,
              },
              { explicitSession: session, arm: false },
            );
          }
          return;
        }

        if (outcome !== "done" && outcome !== "max-turns") return;
        if (rawConfig.enableRoundDriver === false) return;
        if (existing.phase !== "active" || !isArmed(session.id, existing)) return;

        scheduleGoalRound(session.id, existing.id, existing.revision, getRoundDelayMs());
      }),
    "goal-tracker: agent/settled round driver",
  );
}

export default {
  name,
  inject,
  apply,
};

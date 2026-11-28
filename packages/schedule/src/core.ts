/**
 * Scheduled task definitions and next-run computation, ported from the
 * desktop's Rust scheduler (`src-tauri/src/scheduler.rs`,
 * `commands/schedule.rs`), which keeps serving the Pi engine until P5.
 */

export type Frequency = "interval" | "hourly" | "daily" | "weekdays" | "weekly" | "once";
/** Unattended runs never get full access: nobody is there to watch. */
export type UnattendedPermission = "read-only" | "ask" | "workspace-write";
export type ScheduleScope = "agent" | "bot";

export interface ScheduledTask {
  id: string;
  name: string;
  prompt: string;
  cwd: string;
  frequency: Frequency;
  /** Interval cadence in minutes (`5..1440`, default `30`) when `frequency === "interval"`. */
  intervalMinutes?: number;
  /** Target epoch ms when `frequency === "once"`. */
  runAt?: number;
  /** Optional target mode scope (`"agent"` or `"bot"`). */
  scope?: ScheduleScope;
  hour: number;
  minute: number;
  /** 0 = Sunday … 6 = Saturday, for `weekly`. */
  weekday: number;
  permissionMode: UnattendedPermission;
  /** 1..240, default 30. */
  timeoutMinutes?: number;
  /** Overrides the host's default model. */
  model?: { provider: string; model: string };
  enabled: boolean;
  lastRunAt?: number;
  nextRunAt?: number;
  lastStatus: string;
  lastMessage: string;
}

export type RunStatus = "running" | "success" | "error" | "cancelled" | "timed-out" | "interrupted";

export interface ScheduledRun {
  id: string;
  taskId: string;
  taskName: string;
  cwd?: string;
  scope?: ScheduleScope;
  trigger: "scheduled" | "manual";
  status: RunStatus;
  startedAt: number;
  finishedAt?: number;
  durationMs?: number;
  /** The session the run worked in. */
  sessionId?: string;
  output: string;
}

export const FREQUENCIES: readonly Frequency[] = ["interval", "hourly", "daily", "weekdays", "weekly", "once"];
export const UNATTENDED_PERMISSIONS: readonly UnattendedPermission[] = ["read-only", "ask", "workspace-write"];
export const DEFAULT_TIMEOUT_MINUTES = 30;
export const DEFAULT_INTERVAL_MINUTES = 30;

export function timeoutMinutes(task: Pick<ScheduledTask, "timeoutMinutes">): number {
  return Math.min(240, Math.max(1, Math.round(task.timeoutMinutes ?? DEFAULT_TIMEOUT_MINUTES)));
}

export function clampIntervalMinutes(value?: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return DEFAULT_INTERVAL_MINUTES;
  return Math.max(5, Math.min(1440, Math.round(value)));
}

/** Validate an edited task; throws with the reason. Run state fields are kept from `previous`. */
export function validateTask(input: Partial<ScheduledTask>, previous?: ScheduledTask): ScheduledTask {
  const text = (value: unknown, field: string, max: number) => {
    if (typeof value !== "string" || value.trim() === "") throw new Error(`${field} is required`);
    if (value.length > max) throw new Error(`${field} is too long`);
    return value.trim();
  };
  const integer = (value: unknown, field: string, min: number, max: number) => {
    if (!Number.isInteger(value) || (value as number) < min || (value as number) > max) {
      throw new Error(`${field} must be an integer from ${min} to ${max}`);
    }
    return value as number;
  };
  if (!FREQUENCIES.includes(input.frequency as Frequency)) {
    throw new Error(`frequency must be one of ${FREQUENCIES.join(", ")}`);
  }
  const permissionMode = input.permissionMode ?? previous?.permissionMode ?? "ask";
  if (!UNATTENDED_PERMISSIONS.includes(permissionMode)) {
    throw new Error(`permissionMode must be one of ${UNATTENDED_PERMISSIONS.join(", ")}`);
  }
  if (input.model !== undefined && (typeof input.model?.provider !== "string" || typeof input.model.model !== "string")) {
    throw new Error("model must be { provider, model }");
  }

  const frequency = input.frequency as Frequency;
  const resolvedInterval =
    typeof input.intervalMinutes === "number" && Number.isFinite(input.intervalMinutes)
      ? clampIntervalMinutes(input.intervalMinutes)
      : frequency === "interval"
        ? clampIntervalMinutes(previous?.intervalMinutes ?? DEFAULT_INTERVAL_MINUTES)
        : previous?.intervalMinutes !== undefined
          ? clampIntervalMinutes(previous.intervalMinutes)
          : undefined;

  const resolvedRunAt =
    typeof input.runAt === "number" && Number.isFinite(input.runAt) && input.runAt > 0
      ? Math.round(input.runAt)
      : input.runAt === undefined && typeof previous?.runAt === "number" && Number.isFinite(previous.runAt)
        ? Math.round(previous.runAt)
        : undefined;

  const resolvedScope: ScheduleScope | undefined =
    input.scope === "agent" || input.scope === "bot"
      ? input.scope
      : input.scope === undefined && (previous?.scope === "agent" || previous?.scope === "bot")
        ? previous.scope
        : undefined;

  return {
    id: text(input.id, "id", 120),
    name: text(input.name, "name", 200),
    prompt: text(input.prompt, "prompt", 100_000),
    cwd: text(input.cwd, "cwd", 4096),
    frequency,
    ...(resolvedInterval === undefined ? {} : { intervalMinutes: resolvedInterval }),
    ...(resolvedRunAt === undefined ? {} : { runAt: resolvedRunAt }),
    ...(resolvedScope === undefined ? {} : { scope: resolvedScope }),
    hour: integer(input.hour ?? previous?.hour ?? 9, "hour", 0, 23),
    minute: integer(input.minute ?? previous?.minute ?? 0, "minute", 0, 59),
    weekday: integer(input.weekday ?? previous?.weekday ?? 1, "weekday", 0, 6),
    permissionMode,
    ...(input.timeoutMinutes === undefined
      ? previous?.timeoutMinutes === undefined
        ? {}
        : { timeoutMinutes: integer(previous.timeoutMinutes, "timeoutMinutes", 1, 240) }
      : { timeoutMinutes: integer(input.timeoutMinutes, "timeoutMinutes", 1, 240) }),
    ...(input.model === undefined ? {} : { model: { provider: input.model.provider, model: input.model.model } }),
    enabled: input.enabled !== false,
    ...(previous?.lastRunAt === undefined ? {} : { lastRunAt: previous.lastRunAt }),
    lastStatus: previous?.lastStatus ?? "",
    lastMessage: previous?.lastMessage ?? "",
  };
}

/** Local wall-clock time on `date`'s day. `Date` moves a time skipped by a DST change forward, as the Rust scheduler does. */
function localTime(date: Date, hour: number, minute: number): Date {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate(), hour, minute, 0, 0);
}

function addDays(date: Date, days: number): Date {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate() + days);
}

export type ScheduleTimingInput = Pick<ScheduledTask, "frequency" | "hour" | "minute" | "weekday"> &
  Partial<Pick<ScheduledTask, "intervalMinutes" | "runAt">>;

/**
 * The next run timestamp strictly after `afterMs` (epoch ms), or `undefined`
 * when a `"once"` task's `runAt` has already elapsed or is unset.
 */
export function nextRunAfter(task: ScheduleTimingInput, afterMs: number): number | undefined {
  switch (task.frequency) {
    case "interval": {
      const mins = Math.max(5, Math.min(1440, Math.round(task.intervalMinutes ?? DEFAULT_INTERVAL_MINUTES)));
      return afterMs + mins * 60_000;
    }
    case "once": {
      return typeof task.runAt === "number" && Number.isFinite(task.runAt) && task.runAt > afterMs
        ? Math.round(task.runAt)
        : undefined;
    }
    case "hourly": {
      const origin = new Date(afterMs);
      const candidate = localTime(origin, origin.getHours(), task.minute);
      if (candidate.getTime() <= afterMs) candidate.setHours(candidate.getHours() + 1);
      return candidate.getTime();
    }
    case "daily": {
      const origin = new Date(afterMs);
      const candidate = localTime(origin, task.hour, task.minute);
      return candidate.getTime() > afterMs
        ? candidate.getTime()
        : localTime(addDays(origin, 1), task.hour, task.minute).getTime();
    }
    case "weekdays": {
      let date = new Date(afterMs);
      if (localTime(date, task.hour, task.minute).getTime() <= afterMs) date = addDays(date, 1);
      while (date.getDay() === 0 || date.getDay() === 6) date = addDays(date, 1);
      return localTime(date, task.hour, task.minute).getTime();
    }
    case "weekly": {
      const origin = new Date(afterMs);
      const desired = Math.min(6, Math.max(0, task.weekday));
      let daysAhead = (desired - origin.getDay() + 7) % 7;
      if (daysAhead === 0 && localTime(origin, task.hour, task.minute).getTime() <= afterMs) daysAhead = 7;
      return localTime(addDays(origin, daysAhead), task.hour, task.minute).getTime();
    }
    default:
      return afterMs + 24 * 60 * 60 * 1000;
  }
}

/** The first run strictly after `from` (epoch ms), in local time. */
export function nextScheduledRun<T extends ScheduleTimingInput>(
  task: T,
  from: number,
): T["frequency"] extends Exclude<Frequency, "once"> ? number : number | undefined;
export function nextScheduledRun(task: ScheduleTimingInput, from: number): number | undefined {
  return nextRunAfter(task, from);
}

export function truncateOutput(value: string, limit: number): string {
  const chars = [...value];
  return chars.length > limit ? `${chars.slice(0, limit).join("")}\n... output truncated by Qianji` : value;
}

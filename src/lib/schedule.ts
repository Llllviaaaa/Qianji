import type { Frequency } from "@qianji/protocol";
import type { ScheduledTask } from "../types";

export type ScheduleTaskTimingLike = Omit<ScheduledTask, "frequency"> & {
  frequency: Frequency;
  intervalMinutes?: number | null;
  runAt?: number | null;
};

function atConfiguredTime(source: Date, task: Pick<ScheduledTask, "hour" | "minute">): Date {
  const result = new Date(source);
  result.setHours(task.hour, task.minute, 0, 0);
  return result;
}

export function nextScheduledRun(task: ScheduleTaskTimingLike, from = Date.now()): number {
  if (task.frequency === "interval") {
    const mins = Math.max(5, Math.min(1440, Math.round(task.intervalMinutes ?? 30)));
    return from + mins * 60_000;
  }

  if (task.frequency === "once") {
    if (typeof task.runAt === "number" && Number.isFinite(task.runAt) && task.runAt > from) {
      return Math.round(task.runAt);
    }
    return from;
  }

  const origin = new Date(from);
  if (task.frequency === "hourly") {
    const next = new Date(origin);
    next.setMinutes(task.minute, 0, 0);
    if (next.getTime() <= from) next.setHours(next.getHours() + 1);
    return next.getTime();
  }

  if (task.frequency === "daily") {
    const next = atConfiguredTime(origin, task);
    if (next.getTime() <= from) next.setDate(next.getDate() + 1);
    return next.getTime();
  }

  if (task.frequency === "weekdays") {
    const next = atConfiguredTime(origin, task);
    if (next.getTime() <= from) next.setDate(next.getDate() + 1);
    while (next.getDay() === 0 || next.getDay() === 6) next.setDate(next.getDate() + 1);
    return next.getTime();
  }

  const next = atConfiguredTime(origin, task);
  const daysAhead = (task.weekday - next.getDay() + 7) % 7;
  next.setDate(next.getDate() + daysAhead);
  if (next.getTime() <= from) next.setDate(next.getDate() + 7);
  return next.getTime();
}

export function scheduleSummary(task: ScheduleTaskTimingLike): string {
  const pad2 = (n: number) => String(n).padStart(2, "0");
  const time = `${pad2(task.hour)}:${pad2(task.minute)}`;
  if (task.frequency === "interval") {
    const mins = Math.max(5, Math.min(1440, Math.round(task.intervalMinutes ?? 30)));
    return `每 ${mins} 分钟`;
  }
  if (task.frequency === "once") {
    if (typeof task.runAt === "number" && Number.isFinite(task.runAt)) {
      const d = new Date(task.runAt);
      return `单次 · ${pad2(d.getMonth() + 1)}/${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
    }
    return `单次 · ${time}`;
  }
  if (task.frequency === "hourly") return `每小时的 ${pad2(task.minute)} 分`;
  if (task.frequency === "daily") return `每天 ${time}`;
  if (task.frequency === "weekdays") return `工作日 ${time}`;
  return `每周${["日", "一", "二", "三", "四", "五", "六"][task.weekday]} ${time}`;
}

export function formatScheduleTime(timestamp?: number | null): string {
  if (!timestamp) return "尚未安排";
  return new Date(timestamp).toLocaleString([], {
    month: "numeric",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

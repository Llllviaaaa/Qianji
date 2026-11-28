/**
 * Shared schedule & side-thread state, RPC actions, and Chinese/English
 * natural-language schedule parser for `bot-mode` (`botScheduleStore.ts`).
 */
import { useCallback, useEffect } from "react";
import type { Context } from "@deepseek-ai/cordis";
import { useFrontendService } from "@qianji/client";
import { createReactiveStore, useStoreValue } from "@qianji/client-store";
import type {
  BotSnapshotResult,
  ScheduleListResult,
  ScheduleRunsResult,
  ScheduledRunInfo,
  ScheduledTaskInfo,
} from "@qianji/protocol";
import { botDataStore, botUiStore, patchBotUi, useBotSnapshot, useBotUiState, type BotScheduledSummary } from "./botUiAtoms";

export type BotScheduleFrequency = "interval" | "hourly" | "daily" | "weekdays" | "weekly" | "once";

export interface NaturalScheduleParseResult {
  readonly matched: boolean;
  readonly frequency: BotScheduleFrequency;
  readonly intervalMinutes?: number;
  readonly hour: number;
  readonly minute: number;
  readonly weekday: number;
  readonly runAt?: number;
  readonly summaryZh: string;
  readonly nameSuggestion: string;
  readonly cleanPrompt: string;
}

export type BotScheduleSaveDraft = Omit<Partial<ScheduledTaskInfo>, "frequency"> & {
  readonly name: string;
  readonly prompt: string;
  readonly cwd?: string;
  readonly frequency?: BotScheduleFrequency;
  readonly intervalMinutes?: number;
  readonly runAt?: number;
  readonly scope?: "agent" | "bot";
};

type ExtendedTaskWire = Omit<Partial<BotScheduledSummary>, "id" | "name" | "cronOrInterval" | "enabled" | "frequency"> & {
  readonly id: string;
  readonly name: string;
  readonly frequency?: string;
  readonly enabled?: boolean;
};

const WEEKDAY_NAMES_ZH = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"] as const;
const CN_DIGITS: Readonly<Record<string, number>> = {
  零: 0, 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10,
};

const botScheduleRunsStore = createReactiveStore<readonly ScheduledRunInfo[]>([]);
const botScheduleLoadingStore = createReactiveStore<boolean>(false);
const pad2 = (n: number): string => String(Math.max(0, Math.floor(n))).padStart(2, "0");

function parseCnOrDigits(token: string): number | null {
  const t = token.trim();
  if (/^\d+$/.test(t)) return Number(t);
  if (t === "半") return 30;
  if (t === "十") return 10;
  if (t.startsWith("十") && t.length === 2) return CN_DIGITS[t[1] ?? ""] !== undefined ? 10 + (CN_DIGITS[t[1] ?? ""] ?? 0) : null;
  if (t.endsWith("十") && t.length === 2) return CN_DIGITS[t[0] ?? ""] !== undefined ? (CN_DIGITS[t[0] ?? ""] ?? 0) * 10 : null;
  if (t.length === 3 && t[1] === "十") {
    const tens = CN_DIGITS[t[0] ?? ""];
    const ones = CN_DIGITS[t[2] ?? ""];
    return tens !== undefined && ones !== undefined ? tens * 10 + ones : null;
  }
  return CN_DIGITS[t] ?? null;
}

function buildHeartbeatSummary(pacing: BotSnapshotResult["pacing"]): BotScheduledSummary {
  const mins = Math.max(5, pacing.heartbeatIntervalMinutes || 30);
  return {
    id: "heartbeat",
    name: "Heartbeat",
    prompt: "按节奏静默巡检收件箱、仓库动态与待办事项，仅在有价值发现时汇报。",
    frequency: "interval",
    intervalMinutes: mins,
    cronOrInterval: `每${mins}分钟`,
    enabled: pacing.heartbeatEnabled,
    isHeartbeat: true,
  };
}

export function formatBotScheduleCadence(task: {
  readonly frequency?: string;
  readonly intervalMinutes?: number;
  readonly hour?: number;
  readonly minute?: number;
  readonly weekday?: number;
  readonly runAt?: number;
  readonly cronOrInterval?: string;
}): string {
  const h = pad2(task.hour ?? 9);
  const m = pad2(task.minute ?? 0);
  switch (task.frequency) {
    case "interval":
      return `每 ${Math.max(5, task.intervalMinutes ?? 30)} 分钟`;
    case "hourly":
      return (task.minute ?? 0) === 0 ? "每小时整点" : `每小时 :${m}`;
    case "daily":
      return `每天 ${h}:${m}`;
    case "weekdays":
      return `工作日 ${h}:${m}`;
    case "weekly":
      return `每${WEEKDAY_NAMES_ZH[task.weekday ?? 1] ?? "周一"} ${h}:${m}`;
    case "once":
      if (typeof task.runAt === "number" && Number.isFinite(task.runAt)) {
        const dt = new Date(task.runAt);
        return `单次 · ${dt.getMonth() + 1}/${dt.getDate()} ${pad2(dt.getHours())}:${pad2(dt.getMinutes())}`;
      }
      return "单次定时";
    default:
      return task.cronOrInterval || "定时执行";
  }
}

export function formatRelativeNextRun(nextRunAt?: number | null, nowMs: number = Date.now()): string {
  if (typeof nextRunAt !== "number" || !Number.isFinite(nextRunAt) || nextRunAt <= 0) return "";
  const diffMs = nextRunAt - nowMs;
  if (diffMs <= 0) return "即将执行";
  if (diffMs < 60_000) return "1 分钟内";
  if (diffMs < 3_600_000) return `${Math.max(1, Math.round(diffMs / 60_000))} 分钟后`;

  const now = new Date(nowMs);
  const target = new Date(nextRunAt);
  const startToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const startTarget = new Date(target.getFullYear(), target.getMonth(), target.getDate()).getTime();
  const dayDiff = Math.round((startTarget - startToday) / 86_400_000);
  const hm = `${pad2(target.getHours())}:${pad2(target.getMinutes())}`;
  if (dayDiff === 0) return `今天 ${hm}`;
  if (dayDiff === 1) return `明天 ${hm}`;
  return `${target.getMonth() + 1}月${target.getDate()}日 ${hm}`;
}

export function mapWireTaskToSummary(raw: ExtendedTaskWire): BotScheduledSummary {
  return {
    ...raw,
    id: raw.id,
    name: raw.name,
    frequency: (raw.frequency ?? "daily") as BotScheduledSummary["frequency"],
    cronOrInterval: formatBotScheduleCadence(raw),
    enabled: raw.enabled !== false,
    running: raw.running === true,
    isHeartbeat: false,
  };
}

export function syncBotScheduledTasks(
  wireTasks: readonly ExtendedTaskWire[] | null | undefined,
  pacing: BotSnapshotResult["pacing"] = botDataStore.get().pacing,
): void {
  const heartbeat = buildHeartbeatSummary(pacing);
  if (!Array.isArray(wireTasks)) {
    const existingCustom = botUiStore.get().scheduledTasks.filter((t) => !t.isHeartbeat && t.id !== "heartbeat");
    patchBotUi({ scheduledTasks: [heartbeat, ...existingCustom] });
    return;
  }
  patchBotUi({
    scheduledTasks: [heartbeat, ...wireTasks.filter((t) => t.id !== "heartbeat").map(mapWireTaskToSummary)],
  });
}

export function applyScheduleTaskNotification(raw: unknown): void {
  if (typeof raw !== "object" || raw === null) return;
  const payload = raw as { id?: string; deleted?: boolean; task?: ExtendedTaskWire };
  if (typeof payload.id !== "string") return;
  const current = botUiStore.get().scheduledTasks;
  if (payload.deleted === true) {
    patchBotUi({ scheduledTasks: current.filter((t) => t.id !== payload.id) });
    return;
  }
  if (payload.task) {
    const prevItem = current.find((t) => t.id === payload.id);
    const updated = mapWireTaskToSummary({ ...payload.task, running: prevItem?.running });
    const exists = current.some((t) => t.id === payload.id);
    patchBotUi({ scheduledTasks: exists ? current.map((t) => (t.id === payload.id ? updated : t)) : [...current, updated] });
  }
}

export function applyScheduleRunNotification(raw: unknown): void {
  if (typeof raw !== "object" || raw === null) return;
  const run = raw as ScheduledRunInfo;
  if (typeof run.id !== "string" || typeof run.taskId !== "string") return;
  botScheduleRunsStore.set((prev) =>
    prev.some((r) => r.id === run.id) ? prev.map((r) => (r.id === run.id ? run : r)) : [run, ...prev].slice(0, 100),
  );
  botUiStore.set((prev) => ({
    ...prev,
    scheduledTasks: prev.scheduledTasks.map((t) =>
      t.id === run.taskId
        ? {
            ...t,
            running: run.status === "running",
            lastRunAt: run.finishedAt ?? run.startedAt,
            lastStatus: run.status,
            lastMessage: run.output ? run.output.slice(0, 140) : t.lastMessage,
          }
        : t,
    ),
  }));
}

function extractTimeOfDay(text: string): { hour: number; minute: number; matchedSpan: string } | null {
  const cnMatch =
    /(凌晨|早上|早晨|上午|中午|下午|傍晚|晚上|夜间)?\s*(\d{1,2}|[一二两三四五六七八九十]{1,3})\s*(?:点|时|:|：)(?:\s*(半|\d{1,2}|[一二三四五六七八九十]{1,3})\s*分?)?/.exec(
      text,
    );
  if (cnMatch) {
    const period = cnMatch[1] ?? "";
    const rawHour = parseCnOrDigits(cnMatch[2] ?? "");
    const rawMin = cnMatch[3] !== undefined ? parseCnOrDigits(cnMatch[3]) : 0;
    if (rawHour !== null && rawHour >= 0 && rawHour <= 23) {
      let hour = rawHour;
      if ((period === "下午" || period === "傍晚" || period === "晚上" || period === "夜间") && hour >= 1 && hour <= 11) hour += 12;
      else if (period === "中午" && hour >= 1 && hour <= 3) hour += 12;
      else if (period === "凌晨" && hour === 12) hour = 0;
      return { hour, minute: rawMin !== null && rawMin >= 0 && rawMin <= 59 ? rawMin : 0, matchedSpan: cnMatch[0] };
    }
  }
  const enMatch = /\b(\d{1,2})(?::(\d{2}))?\s*(am|pm)\b/i.exec(text);
  if (enMatch) {
    let hour = Number(enMatch[1]);
    const minute = enMatch[2] !== undefined ? Number(enMatch[2]) : 0;
    const mer = (enMatch[3] ?? "").toLowerCase();
    if (mer === "pm" && hour >= 1 && hour <= 11) hour += 12;
    if (mer === "am" && hour === 12) hour = 0;
    return { hour: Math.min(23, hour), minute: Math.min(59, minute), matchedSpan: enMatch[0] };
  }
  return null;
}

function buildSuggestions(raw: string, stripped: string): { nameSuggestion: string; cleanPrompt: string } {
  const promptText = stripped.replace(/^[\s,，。:：、·\-—]+/, "").trim() || raw.trim();
  const cleaned = promptText.replace(/^(?:请|麻烦)?(?:帮我|替我|提醒我|自动|定时)\s*/, "").trim();
  const baseName = (cleaned || promptText || "新建预定任务").replace(/[。.!！?？]+$/, "").trim();
  return { nameSuggestion: baseName.slice(0, 20), cleanPrompt: promptText };
}

export function parseNaturalScheduleInput(raw: string, nowMs: number = Date.now()): NaturalScheduleParseResult {
  const text = raw.trim();
  if (text === "") {
    return { matched: false, frequency: "daily", hour: 9, minute: 0, weekday: 1, summaryZh: "每天 09:00", nameSuggestion: "", cleanPrompt: "" };
  }

  const halfHour = /^每(?:隔)?\s*半\s*(?:个)?小时/.exec(text);
  const intervalCn = /每(?:隔)?\s*(\d{1,4}|[一二两三四五六七八九十]{1,3})\s*分钟/.exec(text);
  const intervalEn = /\bevery\s+(\d{1,4})\s*(?:m|min|mins|minutes)\b/i.exec(text);
  if (halfHour || intervalCn || intervalEn) {
    const rawMins = halfHour ? 30 : intervalCn ? (parseCnOrDigits(intervalCn[1] ?? "30") ?? 30) : Number(intervalEn?.[1] ?? 30);
    const intervalMinutes = Math.max(5, Math.min(1440, rawMins));
    const span = halfHour?.[0] ?? intervalCn?.[0] ?? intervalEn?.[0] ?? "";
    return { matched: true, frequency: "interval", intervalMinutes, hour: 9, minute: 0, weekday: 1, summaryZh: `每 ${intervalMinutes} 分钟`, ...buildSuggestions(text, text.replace(span, "")) };
  }

  const hourlyMatch = /(?:每(?:隔)?\s*(?:1|一)?\s*(?:个)?小时(?:\s*(\d{1,2})\s*分)?|\b(?:hourly|every\s+hour)\b)/i.exec(text);
  if (hourlyMatch) {
    const minute = hourlyMatch[1] !== undefined ? Math.min(59, Number(hourlyMatch[1])) : 0;
    return { matched: true, frequency: "hourly", hour: 0, minute, weekday: 1, summaryZh: minute === 0 ? "每小时整点" : `每小时 :${pad2(minute)}`, ...buildSuggestions(text, text.replace(hourlyMatch[0], "")) };
  }

  const time = extractTimeOfDay(text);
  const hour = time?.hour ?? 9;
  const minute = time?.minute ?? 0;
  const hm = `${pad2(hour)}:${pad2(minute)}`;
  const stripWithTime = (span: string) => (time ? text.replace(span, "").replace(time.matchedSpan, "") : text.replace(span, ""));

  const weeklyCn = /每?(?:周|星期|礼拜)([一二三四五六日天])/.exec(text);
  const weeklyEn = /\bevery\s+(sunday|monday|tuesday|wednesday|thursday|friday|saturday)\b/i.exec(text);
  if (weeklyCn || weeklyEn) {
    const cnMap: Readonly<Record<string, number>> = { 日: 0, 天: 0, 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6 };
    const enMap: Readonly<Record<string, number>> = { sunday: 0, monday: 1, tuesday: 2, wednesday: 3, thursday: 4, friday: 5, saturday: 6 };
    const weekday = weeklyCn ? (cnMap[weeklyCn[1] ?? "一"] ?? 1) : (enMap[(weeklyEn?.[1] ?? "monday").toLowerCase()] ?? 1);
    return { matched: true, frequency: "weekly", hour, minute, weekday, summaryZh: `每${WEEKDAY_NAMES_ZH[weekday]} ${hm}`, ...buildSuggestions(text, stripWithTime(weeklyCn?.[0] ?? weeklyEn?.[0] ?? "")) };
  }

  const weekdayMatch = /(?:每?(?:个)?工作日|周一(?:到|至)周五|\b(?:every\s+weekday|weekdays)\b)/i.exec(text);
  if (weekdayMatch) {
    return { matched: true, frequency: "weekdays", hour, minute, weekday: 1, summaryZh: `工作日 ${hm}`, ...buildSuggestions(text, stripWithTime(weekdayMatch[0])) };
  }

  const onceDay = /(今天|今晚|今夜|明天|明早|明晚|后天|\btoday\b|\btomorrow\b)/i.exec(text);
  if (onceDay) {
    const tok = onceDay[1]?.toLowerCase() ?? "明天";
    const dayOffset = tok === "后天" ? 2 : tok === "明天" || tok === "明早" || tok === "明晚" || tok === "tomorrow" ? 1 : 0;
    const finalHour = time ? hour : tok === "今晚" || tok === "今夜" || tok === "明晚" ? 20 : 9;
    const finalMin = time ? minute : 0;
    const base = new Date(nowMs);
    const target = new Date(base.getFullYear(), base.getMonth(), base.getDate() + dayOffset, finalHour, finalMin, 0, 0);
    const dayLabel = dayOffset === 0 ? "今天" : dayOffset === 1 ? "明天" : "后天";
    return { matched: true, frequency: "once", hour: finalHour, minute: finalMin, weekday: target.getDay(), runAt: target.getTime(), summaryZh: `单次 · ${dayLabel} ${pad2(finalHour)}:${pad2(finalMin)}`, ...buildSuggestions(text, stripWithTime(onceDay[0])) };
  }

  const dailyMatch = /(每天|每日|每晚|每早|\bdaily\b|\bevery\s+day\b)/i.exec(text);
  if (dailyMatch || time) {
    const finalHour = time ? hour : dailyMatch?.[1] === "每晚" ? 20 : 9;
    const finalMin = time ? minute : 0;
    return { matched: true, frequency: "daily", hour: finalHour, minute: finalMin, weekday: 1, summaryZh: `每天 ${pad2(finalHour)}:${pad2(finalMin)}`, ...buildSuggestions(text, stripWithTime(dailyMatch?.[0] ?? "")) };
  }

  return { matched: false, frequency: "daily", hour: 9, minute: 0, weekday: 1, summaryZh: "每天 09:00", ...buildSuggestions(text, text) };
}

export function useBotScheduleManager(ctx?: Context) {
  const rpcService = useFrontendService("rpcService", ctx);
  const navigationService = useFrontendService("navigationService", ctx);
  const workspaceService = useFrontendService("workspaceService", ctx);
  const ui = useBotUiState();
  const snapshot = useBotSnapshot();
  const runs = useStoreValue(botScheduleRunsStore);
  const loading = useStoreValue(botScheduleLoadingStore);

  const refreshSchedules = useCallback(async () => {
    if (rpcService === undefined) return;
    botScheduleLoadingStore.set(true);
    try {
      const [listRes, runsRes] = await Promise.all([
        rpcService.call<ScheduleListResult>("schedule.list", {}).catch(() => null),
        rpcService.call<ScheduleRunsResult>("schedule.runs", { limit: 40 }).catch(() => null),
      ]);
      if (listRes && Array.isArray(listRes.tasks)) {
        syncBotScheduledTasks(listRes.tasks as unknown as readonly ExtendedTaskWire[], botDataStore.get().pacing);
      }
      if (runsRes && Array.isArray(runsRes.runs)) botScheduleRunsStore.set(runsRes.runs);
    } finally {
      botScheduleLoadingStore.set(false);
    }
  }, [rpcService]);

  useEffect(() => {
    if (rpcService !== undefined) void refreshSchedules();
  }, [refreshSchedules, rpcService]);

  const saveTask = useCallback(
    async (draft: BotScheduleSaveDraft): Promise<ScheduledTaskInfo | null> => {
      if (rpcService === undefined) return null;
      const workspaceCwd = workspaceService?.getSnapshot().cwd ?? "";
      try {
        const res = await rpcService.call<{ task: ScheduledTaskInfo }>("schedule.save", {
          task: { ...draft, scope: "bot" as const, cwd: draft.cwd || snapshot.botCwd || workspaceCwd, permissionMode: draft.permissionMode ?? ("ask" as const) },
        });
        await refreshSchedules();
        navigationService?.showToast(`已保存预定任务：${draft.name}`, "info");
        return res?.task ?? null;
      } catch (err) {
        navigationService?.showToast(err instanceof Error ? err.message : "保存预定任务失败", "error");
        return null;
      }
    },
    [navigationService, refreshSchedules, rpcService, snapshot.botCwd, workspaceService],
  );

  const toggleTaskEnabled = useCallback(
    async (task: BotScheduledSummary): Promise<void> => {
      if (task.isHeartbeat || task.id === "heartbeat") {
        const nextEnabled = !snapshot.pacing.heartbeatEnabled;
        const nextPacing = { ...snapshot.pacing, heartbeatEnabled: nextEnabled };
        botDataStore.set((prev) => ({ ...prev, pacing: nextPacing }));
        syncBotScheduledTasks(null, nextPacing);
        const res = await rpcService?.call<{ snapshot?: BotSnapshotResult }>("bot.configure", { heartbeatEnabled: nextEnabled }).catch(() => null);
        if (res?.snapshot) {
          botDataStore.set(res.snapshot);
          syncBotScheduledTasks(null, res.snapshot.pacing);
        }
        return;
      }
      const nextEnabled = !task.enabled;
      patchBotUi({ scheduledTasks: ui.scheduledTasks.map((t) => (t.id === task.id ? { ...t, enabled: nextEnabled } : t)) });
      await rpcService?.call("schedule.save", { task: { ...task, enabled: nextEnabled, scope: "bot" } }).catch(() => undefined);
      await refreshSchedules();
    },
    [refreshSchedules, rpcService, snapshot.pacing, ui.scheduledTasks],
  );

  const runTaskNow = useCallback(
    async (task: BotScheduledSummary): Promise<ScheduledRunInfo | null> => {
      if (task.isHeartbeat || task.id === "heartbeat") {
        const res = await rpcService?.call<{ snapshot: BotSnapshotResult }>("bot.patrol.runNow", { force: true }).catch(() => null);
        if (res?.snapshot) botDataStore.set(res.snapshot);
        navigationService?.showToast("已立即触发 Heartbeat 巡检", "info");
        return null;
      }
      patchBotUi({ scheduledTasks: ui.scheduledTasks.map((t) => (t.id === task.id ? { ...t, running: true } : t)) });
      try {
        const res = await rpcService?.call<{ run: ScheduledRunInfo }>("schedule.run", { id: task.id });
        navigationService?.showToast(`已启动运行：${task.name}`, "info");
        await refreshSchedules();
        return res?.run ?? null;
      } catch (err) {
        navigationService?.showToast(err instanceof Error ? err.message : "立即运行失败", "error");
        await refreshSchedules();
        return null;
      }
    },
    [navigationService, refreshSchedules, rpcService, ui.scheduledTasks],
  );

  const cancelTaskRun = useCallback(async (taskId: string): Promise<void> => {
    await rpcService?.call("schedule.cancel", { id: taskId }).catch(() => undefined);
    await refreshSchedules();
  }, [refreshSchedules, rpcService]);

  const deleteTask = useCallback(async (taskId: string): Promise<void> => {
    if (taskId === "heartbeat") return;
    patchBotUi({
      scheduledTasks: ui.scheduledTasks.filter((t) => t.id !== taskId),
      ...(ui.selectedScheduledTaskId === taskId ? { selectedScheduledTaskId: null } : {}),
    });
    await rpcService?.call("schedule.delete", { id: taskId }).catch(() => undefined);
    await refreshSchedules();
    navigationService?.showToast("已删除预定任务", "info");
  }, [navigationService, refreshSchedules, rpcService, ui.scheduledTasks, ui.selectedScheduledTaskId]);

  const fetchRunsForTask = useCallback(async (taskId?: string, limit: number = 30): Promise<readonly ScheduledRunInfo[]> => {
    if (rpcService === undefined) return [];
    const res = await rpcService.call<ScheduleRunsResult>("schedule.runs", { ...(taskId ? { taskId } : {}), limit }).catch(() => null);
    const list = res?.runs ?? [];
    if (!taskId) botScheduleRunsStore.set(list);
    return list;
  }, [rpcService]);

  const updateSideChat = useCallback(async (id: string, patch: { title?: string; pinned?: boolean; archived?: boolean }): Promise<void> => {
    botDataStore.set((prev) => ({
      ...prev,
      sideThreads: prev.sideThreads.map((th) => (th.id === id ? ({ ...th, ...patch } as typeof th) : th)),
    }));
    await rpcService?.call("bot.sideChat.update", { id, ...patch }).catch(() => undefined);
  }, [rpcService]);

  return { tasks: ui.scheduledTasks, runs, loading, refreshSchedules, saveTask, toggleTaskEnabled, runTaskNow, cancelTaskRun, deleteTask, fetchRunsForTask, updateSideChat };
}

/**
 * V2 Discovery (`动态` / `点子` / `目标`) & Resizable Side-by-Side Split Chat actions
 * and pure formatters (`src/builtin-plugins/bot-mode/botDiscoveryActions.ts`).
 */
import { useCallback } from "react";
import type { useFrontendService } from "@qianji/client";
import type {
  BotFeedCreateParams, BotFeedEditionKind, BotFeedItem, BotGoalCreateParams,
  BotGoalItem, BotGoalTimelineEntry, BotGoalUpdateParams, BotGoalViewPrefs,
  BotIdeaCapabilityItem, BotIdeaItem, BotIdeaSentiment, BotIdeasLaunchResult, BotSnapshotResult,
} from "@qianji/protocol";
import { botDataStore, botUiStore, patchBotUi, type BotRailView } from "./botUiAtoms";

const WEEKDAY_ZH = ["日", "一", "二", "三", "四", "五", "六"] as const;
const dismissedIdeaCache = new Map<string, { category: string | null; item: BotIdeaItem }>();

export function isDiscoverySplitEligible(view: BotRailView): boolean {
  return view === "feed" || view === "ideas" || view === "goals";
}

export function discussInBot(prompt: string): void {
  const curView = botUiStore.get().activeView;
  if (isDiscoverySplitEligible(curView)) {
    patchBotUi({ splitChatOpen: true, activeSessionId: null, composerDraft: prompt, activeIdeaId: null, modal: null });
    return;
  }
  patchBotUi({ activeView: "chat", activeSessionId: null, composerDraft: prompt, activeIdeaId: null, modal: null });
}

export function startInBotNow(prompt: string): void {
  const curView = botUiStore.get().activeView;
  if (isDiscoverySplitEligible(curView)) {
    patchBotUi({
      splitChatOpen: true, activeSessionId: null, composerDraft: "",
      pendingAutoSendPrompt: prompt, activeIdeaId: null, modal: null,
    });
    return;
  }
  patchBotUi({
    activeView: "chat", activeSessionId: null,
    pendingAutoSendPrompt: prompt, activeIdeaId: null, modal: null,
  });
}

export function formatFeedEditionLabel(editionKind?: BotFeedEditionKind, kicker?: string): string | null {
  if (editionKind === "morning") return "早刊";
  if (editionKind === "midday") return "午刊";
  if (editionKind === "evening") return "晚刊";
  if (kicker !== undefined && kicker.trim() !== "") return kicker.trim();
  return null;
}

export function formatIdeaCapabilitiesBadge(capabilities?: readonly BotIdeaCapabilityItem[]): string | null {
  if (!capabilities || capabilities.length === 0) return null;
  const labels = capabilities.map((c) => {
    if (c.kind === "space") return "空间";
    if (c.kind === "schedule") return "定期任务";
    if (c.kind === "doc") return "文档";
    if (c.kind === "workbench") return "工作台草案";
    if (c.kind === "goal") return "目标追踪";
    return "提醒";
  });
  const unique = Array.from(new Set(labels));
  if (unique.length === 1 && unique[0] === "文档") return `${capabilities.length} 份文档`;
  return unique.slice(0, 2).join(" + ");
}

export function formatFeedRelativeTime(createdAt: number, fallbackLabel?: string, nowMs = Date.now()): string {
  if (!Number.isFinite(createdAt) || createdAt <= 0) {
    return fallbackLabel && fallbackLabel.trim() !== "" ? fallbackLabel : "刚刚";
  }
  const diffMin = Math.floor(Math.max(0, nowMs - createdAt) / 60_000);
  if (diffMin < 1) return "刚刚";
  if (diffMin < 60) return `${diffMin}分钟前`;
  const diffHours = Math.floor(diffMin / 60);
  if (diffHours < 24) return `${diffHours}小时前`;
  const diffDays = Math.floor(diffHours / 24);
  if (diffDays === 1) return "昨天";
  if (diffDays < 7) return `${diffDays}天前`;
  const d = new Date(createdAt);
  return `${d.getMonth() + 1}月${d.getDate()}日`;
}

export function formatFeedExactTimestamp(createdAt: number, fallbackLabel?: string): string {
  if (!Number.isFinite(createdAt) || createdAt <= 0) {
    return fallbackLabel && fallbackLabel.trim() !== "" ? fallbackLabel : "刚刚生成";
  }
  const d = new Date(createdAt);
  const wd = WEEKDAY_ZH[d.getDay()] ?? "一";
  return `${d.getMonth() + 1}月${d.getDate()}日星期${wd} ${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

export function sortActiveGoals(goals: readonly BotGoalItem[], autoSort: boolean): BotGoalItem[] {
  const active = goals.filter((g) => g.status !== "completed");
  if (!autoSort) return active;
  return [...active].sort((a, b) => {
    if (b.updatedAt !== a.updatedAt) return b.updatedAt - a.updatedAt;
    const aTotal = a.subGoals?.length ?? 0;
    const bTotal = b.subGoals?.length ?? 0;
    const aRatio = aTotal > 0 ? (a.subGoals?.filter((s) => s.done).length ?? 0) / aTotal : 0;
    const bRatio = bTotal > 0 ? (b.subGoals?.filter((s) => s.done).length ?? 0) / bTotal : 0;
    return bRatio - aRatio;
  });
}

export function groupCompletedGoalsByMonth(
  goals: readonly BotGoalItem[],
): ReadonlyArray<{ readonly monthLabel: string; readonly items: readonly BotGoalItem[] }> {
  const completed = goals
    .filter((g) => g.status === "completed")
    .sort((a, b) => (b.completedAt ?? b.updatedAt) - (a.completedAt ?? a.updatedAt));
  const groups = new Map<string, BotGoalItem[]>();
  for (const cg of completed) {
    const ts = cg.completedAt ?? cg.updatedAt;
    const d = new Date(ts > 0 ? ts : Date.now());
    const label = `${d.getFullYear()}年${String(d.getMonth() + 1).padStart(2, "0")}月`;
    const bucket = groups.get(label);
    if (bucket !== undefined) bucket.push(cg);
    else groups.set(label, [cg]);
  }
  return Array.from(groups.entries()).map(([monthLabel, items]) => ({ monthLabel, items }));
}

export function groupGoalTimelineByDate(
  goal: BotGoalItem,
  nowMs = Date.now(),
): ReadonlyArray<{ readonly label: string; readonly items: readonly BotGoalTimelineEntry[] }> {
  const raw = goal.timeline ?? [];
  const entries: BotGoalTimelineEntry[] = raw.length > 0
    ? [...raw].sort((a, b) => b.createdAt - a.createdAt)
    : [{
        id: `init-${goal.id}`,
        title: `Added ${goal.title}`,
        detail: goal.summary || `分类：${goal.category} · 持续追踪中`,
        createdAt: goal.createdAt ?? goal.updatedAt,
      }];

  const today = new Date(nowMs);
  const startOfToday = new Date(today.getFullYear(), today.getMonth(), today.getDate()).getTime();
  const startOfYesterday = startOfToday - 86_400_000;
  const groups = new Map<string, BotGoalTimelineEntry[]>();
  for (const item of entries) {
    const ts = item.createdAt > 0 ? item.createdAt : nowMs;
    const d = new Date(ts);
    const label = ts >= startOfToday
      ? "TODAY"
      : ts >= startOfYesterday
        ? "昨天"
        : `${String(d.getMonth() + 1).padStart(2, "0")}月${String(d.getDate()).padStart(2, "0")}日`;
    const bucket = groups.get(label);
    if (bucket !== undefined) bucket.push(item);
    else groups.set(label, [item]);
  }
  return Array.from(groups.entries()).map(([label, items]) => ({ label, items }));
}

function applyOptimisticGoalPatch(goal: BotGoalItem, patch: BotGoalUpdateParams, nowMs: number): BotGoalItem {
  let subGoals = goal.subGoals ? [...goal.subGoals] : [];
  if (patch.toggleSubGoalId !== undefined) {
    subGoals = subGoals.map((sg) => (sg.id === patch.toggleSubGoalId ? { ...sg, done: !sg.done } : sg));
  }
  if (patch.deleteSubGoalId !== undefined) {
    subGoals = subGoals.filter((sg) => sg.id !== patch.deleteSubGoalId);
  }
  if (patch.addSubGoal !== undefined && patch.addSubGoal.trim() !== "") {
    subGoals = [...subGoals, { id: `sg-${nowMs}-${subGoals.length + 1}`, title: patch.addSubGoal.trim(), done: false, createdAt: nowMs }];
  }
  let timeline = goal.timeline ? [...goal.timeline] : [];
  if (patch.timelineEntry !== undefined) {
    timeline = [{ id: `tl-${nowMs}`, title: patch.timelineEntry.title, detail: patch.timelineEntry.detail ?? "", createdAt: nowMs }, ...timeline];
  } else if (patch.status === "completed" && goal.status !== "completed") {
    timeline = [{ id: `tl-done-${nowMs}`, title: `已完成：${patch.title ?? goal.title}`, detail: "已将该目标归档至已完成列表", createdAt: nowMs }, ...timeline];
  }
  return {
    ...goal,
    ...(patch.title !== undefined && patch.title.trim() !== "" ? { title: patch.title.trim() } : {}),
    ...(patch.category !== undefined ? { category: patch.category } : {}),
    ...(patch.summary !== undefined ? { summary: patch.summary } : {}),
    ...(patch.description !== undefined ? { description: patch.description } : {}),
    ...(patch.momentumStatus !== undefined ? { momentumStatus: patch.momentumStatus } : {}),
    ...(patch.status !== undefined ? { status: patch.status } : {}),
    ...(patch.status === "completed" ? { completedAt: nowMs } : {}),
    ...(patch.status === "active" ? { completedAt: undefined } : {}),
    subGoals,
    timeline,
    updatedAt: nowMs,
  };
}

interface DiscoveryActionDeps {
  readonly rpcService: ReturnType<typeof useFrontendService<"rpcService">>;
  readonly navigationService: ReturnType<typeof useFrontendService<"navigationService">>;
  readonly refresh: () => Promise<void>;
}

export function useBotDiscoveryActions({ rpcService, navigationService, refresh }: DiscoveryActionDeps) {
  const createFeedItem = useCallback(
    async (titleOrParams: string | BotFeedCreateParams, body?: string, seedPrompt?: string) => {
      const payload: BotFeedCreateParams =
        typeof titleOrParams === "string" ? { title: titleOrParams, body: body ?? "", seedPrompt } : titleOrParams;
      await rpcService?.call("bot.feed.create", { ...payload }).catch(() => undefined);
      await refresh();
    },
    [refresh, rpcService],
  );

  const generateFeedEdition = useCallback(
    async (editionKind?: BotFeedEditionKind) => {
      patchBotUi({ serverBusy: true });
      try {
        const res = await rpcService
          ?.call<{ added: number; items: BotFeedItem[]; snapshot: BotSnapshotResult }>("bot.feed.generateEdition", {
            ...(editionKind !== undefined ? { editionKind } : {}),
            force: true,
          })
          .catch(() => null);
        if (res?.snapshot && Array.isArray(res.snapshot.feed)) {
          botDataStore.set(res.snapshot);
          navigationService?.showToast("已生成今日专属动态刊", "info");
          return res;
        }
        const fallback = await rpcService
          ?.call<{ triggered: boolean; summary: string; snapshot: BotSnapshotResult }>("bot.patrol.runNow", { force: true })
          .catch(() => null);
        if (fallback?.snapshot && Array.isArray(fallback.snapshot.feed)) botDataStore.set(fallback.snapshot);
        else await refresh();
        navigationService?.showToast("已生成今日专属动态刊", "info");
        return fallback ?? null;
      } finally {
        patchBotUi({ serverBusy: false });
      }
    },
    [navigationService, refresh, rpcService],
  );

  const toggleFeedLike = useCallback(async (id: string) => {
    let nextLiked = true;
    botDataStore.set((prev) => ({
      ...prev,
      feed: prev.feed.map((f) => {
        if (f.id !== id) return f;
        nextLiked = f.liked !== true;
        return { ...f, liked: nextLiked };
      }),
    }));
    const res = await rpcService?.call<{ item: BotFeedItem | null }>("bot.feed.toggleLike", { id, liked: nextLiked }).catch(() => null);
    if (res?.item) {
      const updated = res.item;
      botDataStore.set((prev) => ({ ...prev, feed: prev.feed.map((f) => (f.id === id ? updated : f)) }));
    }
  }, [rpcService]);

  const deleteFeedItem = useCallback(async (id: string) => {
    botDataStore.set((prev) => ({ ...prev, feed: prev.feed.filter((f) => f.id !== id) }));
    await rpcService?.call("bot.feed.delete", { id }).catch(() => undefined);
  }, [rpcService]);

  const saveFeedInstructions = useCallback(async (instructions: string, refreshNow = false) => {
    const trimmed = instructions.trim();
    botDataStore.set((prev) => ({ ...prev, feedInstructions: trimmed }));
    const res = await rpcService
      ?.call<{ instructions: string; snapshot: BotSnapshotResult }>("bot.feed.saveInstructions", { instructions: trimmed, refreshNow })
      .catch(() => null);
    if (res?.snapshot && Array.isArray(res.snapshot.feed)) botDataStore.set(res.snapshot);
    else await refresh();
    navigationService?.showToast(refreshNow ? "已更新动态指示并刷新简报" : "已保存动态版块说明", "info");
  }, [navigationService, refresh, rpcService]);

  const feedbackIdea = useCallback(async (id: string, sentiment: BotIdeaSentiment) => {
    if (sentiment === "not_interested") {
      let dismissedTitle = "该点子";
      for (const sec of botDataStore.get().ideaSections) {
        const hit = sec.items.find((it) => it.id === id);
        if (hit !== undefined) {
          dismissedTitle = hit.title;
          dismissedIdeaCache.set(id, { category: sec.category, item: hit });
          break;
        }
      }
      botDataStore.set((prev) => ({
        ...prev,
        ideaSections: prev.ideaSections.map((sec) => ({ ...sec, items: sec.items.filter((it) => it.id !== id) })),
      }));
      patchBotUi({
        lastDismissedIdea: { id, title: dismissedTitle },
        ...(botUiStore.get().activeIdeaId === id ? { activeIdeaId: null } : {}),
      });
      navigationService?.showToast("已减少此类点子推荐", "info");
    } else {
      navigationService?.showToast("正在结合偏好为你构思更多类似点子…", "info");
    }
    const res = await rpcService
      ?.call<{ ok: true; generated: BotIdeaItem[]; snapshot: BotSnapshotResult }>("bot.ideas.feedback", { id, sentiment })
      .catch(() => null);
    if (res?.snapshot && Array.isArray(res.snapshot.ideaSections)) botDataStore.set(res.snapshot);
  }, [navigationService, rpcService]);

  const restoreIdea = useCallback(async (id: string) => {
    patchBotUi({ lastDismissedIdea: null });
    const cached = dismissedIdeaCache.get(id);
    if (cached !== undefined) {
      dismissedIdeaCache.delete(id);
      botDataStore.set((prev) => {
        if (prev.ideaSections.some((s) => s.items.some((it) => it.id === id))) return prev;
        const hasSection = prev.ideaSections.some((s) => s.category === cached.category);
        return {
          ...prev,
          ideaSections: hasSection
            ? prev.ideaSections.map((s) => (s.category === cached.category ? { ...s, items: [cached.item, ...s.items] } : s))
            : [{ category: cached.category, items: [cached.item] }, ...prev.ideaSections],
        };
      });
    }
    const res = await rpcService?.call<{ ok: true; snapshot: BotSnapshotResult }>("bot.ideas.restore", { id }).catch(() => null);
    if (res?.snapshot && Array.isArray(res.snapshot.ideaSections)) botDataStore.set(res.snapshot);
    navigationService?.showToast("已恢复该点子", "info");
  }, [navigationService, rpcService]);

  const launchIdea = useCallback(async (id: string, fallbackPrompt?: string) => {
    const existing = botDataStore.get().ideaSections.flatMap((s) => s.items).find((it) => it.id === id);
    botDataStore.set((prev) => ({
      ...prev,
      ideaSections: prev.ideaSections.map((sec) => ({
        ...sec,
        items: sec.items.map((it) => (it.id === id ? { ...it, buildStatus: "installed" } : it)),
      })),
    }));
    const res = await rpcService?.call<BotIdeasLaunchResult>("bot.ideas.launch", { id }).catch(() => null);
    if (res?.snapshot && Array.isArray(res.snapshot.ideaSections)) botDataStore.set(res.snapshot);
    const promptToSend = res?.launchPrompt && res.launchPrompt.trim() !== ""
      ? res.launchPrompt
      : fallbackPrompt || existing?.seedPrompt || "";
    patchBotUi({ activeIdeaId: null });
    if (promptToSend.trim() !== "") startInBotNow(promptToSend);
    return res ?? null;
  }, [rpcService]);

  const refreshIdeas = useCallback(async () => {
    const res = await rpcService?.call<{ added: number; snapshot: BotSnapshotResult }>("bot.ideas.refresh", {}).catch(() => null);
    if (res?.snapshot && Array.isArray(res.snapshot.ideaSections)) botDataStore.set(res.snapshot);
    else await refresh();
    navigationService?.showToast("已刷新点子建议", "info");
  }, [navigationService, refresh, rpcService]);

  const createGoal = useCallback(
    async (title: string, category: string, extra?: Omit<BotGoalCreateParams, "title" | "category">) => {
      const trimmed = title.trim();
      if (trimmed === "") return null;
      const now = Date.now();
      const optimistic: BotGoalItem = {
        id: `goal-local-${now}`,
        title: trimmed,
        category,
        summary: extra?.summary ?? `围绕「${trimmed}」持续追踪关键里程碑与下一步进展。`,
        ...(extra?.description !== undefined ? { description: extra.description } : {}),
        ...(extra?.source !== undefined ? { source: extra.source } : {}),
        ...(extra?.momentumStatus !== undefined ? { momentumStatus: extra.momentumStatus } : {}),
        status: "active",
        createdAt: now,
        updatedAt: now,
        subGoals: (extra?.subGoals ?? []).map((sg, idx) => ({ id: `sg-${now}-${idx}`, title: sg, done: false, createdAt: now })),
        timeline: [{ id: `tl-${now}`, title: `Added ${trimmed}`, detail: `已归入「${category}」分类并开启持续追踪`, createdAt: now }],
      };
      botDataStore.set((prev) => ({ ...prev, goals: [optimistic, ...prev.goals] }));
      const res = await rpcService?.call<{ goal: BotGoalItem }>("bot.goals.create", { title: trimmed, category, ...extra }).catch(() => null);
      if (res?.goal) {
        const saved = res.goal;
        botDataStore.set((prev) => ({ ...prev, goals: prev.goals.map((g) => (g.id === optimistic.id ? saved : g)) }));
        await refresh();
        navigationService?.showToast(`已添加目标：${trimmed}`, "info");
        return saved;
      }
      await refresh();
      navigationService?.showToast(`已添加目标：${trimmed}`, "info");
      return optimistic;
    },
    [navigationService, refresh, rpcService],
  );

  const updateGoal = useCallback(async (params: BotGoalUpdateParams) => {
    const now = Date.now();
    botDataStore.set((prev) => ({
      ...prev,
      goals: prev.goals.map((g) => (g.id === params.id ? applyOptimisticGoalPatch(g, params, now) : g)),
    }));
    const res = await rpcService?.call<{ goal: BotGoalItem | null }>("bot.goals.update", { ...params }).catch(() => null);
    if (res?.goal) {
      const serverGoal = res.goal;
      botDataStore.set((prev) => ({ ...prev, goals: prev.goals.map((g) => (g.id === params.id ? serverGoal : g)) }));
    }
  }, [rpcService]);

  const deleteGoal = useCallback(async (id: string) => {
    botDataStore.set((prev) => ({ ...prev, goals: prev.goals.filter((g) => g.id !== id) }));
    if (botUiStore.get().activeGoalId === id) patchBotUi({ activeGoalId: null, activeGoalFocusSubGoal: false });
    await rpcService?.call("bot.goals.delete", { id }).catch(() => undefined);
  }, [rpcService]);

  const saveGoalPrefs = useCallback(async (prefs: Partial<BotGoalViewPrefs>) => {
    botDataStore.set((prev) => ({
      ...prev,
      goalViewPrefs: {
        showSubtitles: prev.goalViewPrefs?.showSubtitles ?? true,
        autoSort: prev.goalViewPrefs?.autoSort ?? false,
        ...prefs,
      },
    }));
    const res = await rpcService?.call<{ goalViewPrefs: BotGoalViewPrefs }>("bot.goals.savePrefs", { ...prefs }).catch(() => null);
    if (res?.goalViewPrefs) botDataStore.set((prev) => ({ ...prev, goalViewPrefs: res.goalViewPrefs }));
  }, [rpcService]);

  return {
    createFeedItem, generateFeedEdition, toggleFeedLike, deleteFeedItem, saveFeedInstructions,
    feedbackIdea, restoreIdea, launchIdea, refreshIdeas,
    createGoal, updateGoal, deleteGoal, saveGoalPrefs, discussInBot, startInBotNow,
  };
}

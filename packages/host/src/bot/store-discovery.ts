/**
 * Rich V2 Discovery state helpers (`动态` Feed & Widgets, `目标` Commitment State Machine,
 * and Space/Activity primitives) for `BotStateStore` (`packages/host/src/bot/store-discovery.ts`).
 */
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import type {
  BotActivityEntry,
  BotActivityKind,
  BotActivityStatus,
  BotActivityTraceStep,
  BotFeedActionKind,
  BotFeedAttachment,
  BotFeedCreateParams,
  BotFeedItem,
  BotFeedOrigin,
  BotFeedToggleLikeParams,
  BotGoalCreateParams,
  BotGoalItem,
  BotGoalMomentumStatus,
  BotGoalSource,
  BotGoalTimelineEntry,
  BotGoalUpdateParams,
  BotGoalViewPrefs,
  BotSpaceSummary,
  BotSubGoalItem,
} from "@qianji/protocol";
import {
  buildDefaultGoalViewPrefs,
  DEFAULT_FEED_INSTRUCTIONS,
  formatClock,
  type PersistedBotState,
} from "./defaults.ts";
import { rememberPreferenceEntry } from "./store-proactive.ts";
import {
  formatActivityDateBucket,
  stripMarkdownFormatting,
  upsertActivityEntry,
} from "./store-activity-helpers.ts";
import { writeFileAtomic } from "./workspace-scanner.ts";

const MAX_GOAL_TIMELINE = 30;

export function appendActivityRecord(
  st: PersistedBotState,
  input: {
    title: string;
    description: string;
    subtitle?: string;
    statusTitle?: string;
    finishMessage?: string;
    kind?: BotActivityKind;
    status?: BotActivityStatus;
    sessionId?: string;
    steps?: BotActivityTraceStep[];
  },
): BotActivityEntry {
  const now = Date.now();
  const cleanDesc = stripMarkdownFormatting(input.subtitle ?? input.description) || input.description;
  const entry: BotActivityEntry = {
    id: `act-${randomUUID().slice(0, 8)}`,
    dateGroup: formatActivityDateBucket(now, now),
    title: stripMarkdownFormatting(input.title) || input.title,
    subtitle: cleanDesc,
    description: cleanDesc,
    ...(input.statusTitle ? { statusTitle: input.statusTitle } : {}),
    ...(input.finishMessage ? { finishMessage: input.finishMessage } : {}),
    timeLabel: formatClock(now),
    createdAt: now,
    status: input.status ?? "completed",
    ...(input.kind ? { kind: input.kind } : {}),
    ...(input.sessionId ? { sessionId: input.sessionId } : {}),
    ...(input.steps ? { steps: input.steps } : {}),
  };
  return upsertActivityEntry(st, entry, now);
}

export function createSpaceRecord(
  st: PersistedBotState,
  botWorkspaceDir: string,
  title: string,
  description?: string,
  options?: { recordActivity?: boolean },
): BotSpaceSummary {
  const cleanTitle = title.replace(/^我想创建一个空间，关于\s*/, "").trim() || "新建自定义空间";
  const id = `space-${randomUUID().slice(0, 8)}`;
  const desc = description?.trim() || "由千机在专属虚拟服务器内持续维护的常驻追踪空间";
  const created: BotSpaceSummary = {
    id,
    title: cleanTitle,
    description: desc,
    metricBadge: "实时同步",
    updatedLabel: "刚刚",
    updatedAt: Date.now(),
    handoff: { id: `handoff-${id}`, title: cleanTitle, kindLabel: "常驻空间", summary: desc, targetCwd: botWorkspaceDir },
  };
  writeFileAtomic(join(botWorkspaceDir, "spaces", `${id}.md`), `# ${cleanTitle}\n\n${desc}\n`);
  st.spaces.unshift(created);
  if (options?.recordActivity !== false) {
    appendActivityRecord(st, { title: `创建常驻空间：${cleanTitle}`, description: desc, kind: "space" });
  }
  return created;
}

export function formatRelativeFeedTime(createdAt: number, nowMs = Date.now()): string {
  if (!Number.isFinite(createdAt)) return "刚刚";
  const diffMs = Math.max(0, nowMs - createdAt);
  if (diffMs < 60_000) return "刚刚";
  const mins = Math.floor(diffMs / 60_000);
  if (mins < 60) return `${mins}分钟前`;
  const hours = Math.floor(diffMs / 3_600_000);
  if (hours < 24) return `${hours}小时前`;
  const days = Math.floor(diffMs / 86_400_000);
  return days <= 1 ? "昨天" : `${days}天前`;
}

export function reconcileFeedAndGoalsState(st: PersistedBotState): void {
  if (typeof st.feedInstructions !== "string" || st.feedInstructions.trim() === "") {
    st.feedInstructions = DEFAULT_FEED_INSTRUCTIONS;
  }
  st.goalViewPrefs = {
    showSubtitles: st.goalViewPrefs?.showSubtitles !== false,
    autoSort: st.goalViewPrefs?.autoSort === true,
  };
  st.feed = Array.isArray(st.feed) ? st.feed : [];
  st.goals = Array.isArray(st.goals) ? st.goals : [];
  for (const g of st.goals) {
    const createdAt = typeof g.createdAt === "number" && Number.isFinite(g.createdAt) ? g.createdAt : g.updatedAt || Date.now();
    g.createdAt = createdAt;
    if (!Array.isArray(g.subGoals)) g.subGoals = [];
    if (!Array.isArray(g.timeline) || g.timeline.length === 0) {
      g.timeline = [{ id: `tl-${randomUUID().slice(0, 8)}`, title: `添加目标：${g.title}`, detail: g.summary, createdAt }];
    }
  }
}

export function sanitizeFeedAttachment(raw: BotFeedAttachment | undefined): BotFeedAttachment | undefined {
  if (!raw) return undefined;
  if (raw.kind === "none") return { kind: "none" };
  if (raw.kind === "hero_image" && typeof raw.heroImageUrl === "string" && raw.heroImageUrl.trim() !== "") {
    return {
      kind: "hero_image",
      heroImageUrl: raw.heroImageUrl.trim(),
      ...(typeof raw.imageAlt === "string" && raw.imageAlt.trim() !== "" ? { imageAlt: raw.imageAlt.trim() } : {}),
      ...(typeof raw.aspectRatio === "number" && Number.isFinite(raw.aspectRatio) ? { aspectRatio: raw.aspectRatio } : {}),
    };
  }
  if (raw.kind === "carousel" && Array.isArray(raw.imageUrls)) {
    const urls = raw.imageUrls.filter((u): u is string => typeof u === "string" && u.trim() !== "").map((u) => u.trim());
    return urls.length > 0 ? { kind: "carousel", imageUrls: urls } : undefined;
  }
  if (raw.kind === "widget" && typeof raw.widgetHtml === "string") {
    const safeHtml = raw.widgetHtml
      .replace(/<script\b[\s\S]*?<\/script>/gi, "")
      .replace(/<script\b[^>]*\/?>/gi, "")
      .replace(/\son[a-z]+\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi, "")
      .replace(/javascript:/gi, "")
      .trim();
    if (safeHtml === "") return undefined;
    return {
      kind: "widget",
      ...(typeof raw.widgetTitle === "string" && raw.widgetTitle.trim() !== "" ? { widgetTitle: raw.widgetTitle.trim() } : {}),
      widgetHtml: safeHtml,
    };
  }
  return undefined;
}

export function createRichFeedRecord(st: PersistedBotState, params: BotFeedCreateParams): BotFeedItem {
  const now = Date.now();
  const title = params.title.trim();
  const actionKind: BotFeedActionKind =
    params.actionKind === "start" || params.origin === "idea" ? "start" : "discuss";
  const origin: BotFeedOrigin =
    params.origin === "idea" || params.origin === "generated"
      ? params.origin
      : actionKind === "start"
        ? "idea"
        : "generated";
  const cleanLinks = (params.sourceLinks ?? [])
    .filter((l) => l && typeof l.label === "string" && typeof l.url === "string" && l.url.trim() !== "")
    .map((l) => ({ label: l.label.trim() || l.url.trim(), url: l.url.trim() }));
  const attachment = sanitizeFeedAttachment(params.attachment);

  const item: BotFeedItem = {
    id: `feed-${randomUUID().slice(0, 8)}`,
    title,
    ...(params.kicker?.trim() ? { kicker: params.kicker.trim() } : {}),
    ...(params.category?.trim() ? { category: params.category.trim() } : {}),
    ...(params.editionKind ? { editionKind: params.editionKind } : {}),
    origin,
    timeLabel: formatRelativeFeedTime(now, now),
    body: params.body.trim(),
    actionLabel: params.actionLabel?.trim() || (actionKind === "start" ? "立即开始" : "讨论"),
    actionKind,
    seedPrompt: params.seedPrompt?.trim() || (actionKind === "start" ? `请直接帮我推进：${title}` : `我们来深入聊聊：${title}`),
    ...(params.ideaId?.trim() ? { ideaId: params.ideaId.trim() } : {}),
    createdAt: now,
    liked: false,
    ...(params.icon?.trim() ? { icon: params.icon.trim() } : {}),
    ...(params.reason?.trim() ? { reason: params.reason.trim() } : {}),
    ...(attachment !== undefined ? { attachment } : {}),
    ...(cleanLinks.length > 0 ? { sourceLinks: cleanLinks } : {}),
    ...(params.metricsCard && params.metricsCard.rows.length > 0 ? { metricsCard: params.metricsCard } : {}),
  };
  st.feed = [item, ...st.feed].slice(0, 30);
  return item;
}

export function toggleFeedLikeRecord(
  st: PersistedBotState,
  memoryFile: string,
  params: BotFeedToggleLikeParams,
): BotFeedItem | null {
  const item = st.feed.find((f) => f.id === params.id);
  if (item === undefined) return null;
  item.liked = typeof params.liked === "boolean" ? params.liked : !item.liked;
  if (item.liked) rememberPreferenceEntry(st, memoryFile, `关注动态主题：${item.title.slice(0, 32)}`);
  return { ...item, timeLabel: formatRelativeFeedTime(item.createdAt) };
}

export function deleteFeedRecord(st: PersistedBotState, id: string): boolean {
  const prevLen = st.feed.length;
  st.feed = st.feed.filter((f) => f.id !== id);
  return st.feed.length !== prevLen;
}

export function saveFeedInstructionsRecord(st: PersistedBotState, instructions: string): string {
  const clean = instructions.trim() || DEFAULT_FEED_INSTRUCTIONS;
  st.feedInstructions = clean;
  return clean;
}

function normalizeGoalSource(raw: BotGoalSource | undefined): BotGoalSource {
  if (raw === "assistant_tracking" || raw === "chat_interview" || raw === "manual") return raw;
  return "manual";
}

function normalizeGoalMomentum(raw: BotGoalMomentumStatus | undefined): BotGoalMomentumStatus {
  if (raw === "on_track" || raw === "waiting_user" || raw === "stalled") return raw;
  return "on_track";
}

export function createRichGoalRecord(
  st: PersistedBotState,
  botWorkspaceDir: string,
  params: BotGoalCreateParams,
  options?: { recordActivity?: boolean },
): BotGoalItem {
  const now = Date.now();
  const cleanTitle = params.title.trim();
  const category = params.category?.trim() || "通用";
  const source = normalizeGoalSource(params.source);
  const momentumStatus = normalizeGoalMomentum(params.momentumStatus);
  const summary =
    params.summary?.trim() ||
    (source === "assistant_tracking"
      ? "已提炼跨天跟进节点，等待条件满足后继续执行。"
      : "正在后台持续追踪，有重要进展会主动汇报。");
  const id = `goal-${randomUUID().slice(0, 8)}`;
  const subGoals: BotSubGoalItem[] = (params.subGoals ?? [])
    .map((s) => s.trim())
    .filter((s) => s !== "")
    .map((subTitle) => ({ id: `sub-${randomUUID().slice(0, 8)}`, title: subTitle, done: false, createdAt: now }));
  const tlLead =
    source === "assistant_tracking"
      ? `自动立项追踪：${cleanTitle}`
      : source === "chat_interview"
        ? `对话共创目标：${cleanTitle}`
        : `设定目标：${cleanTitle}`;
  const timeline: BotGoalTimelineEntry[] = [
    { id: `tl-${randomUUID().slice(0, 8)}`, title: tlLead, detail: summary, createdAt: now },
  ];
  const created: BotGoalItem = {
    id,
    title: cleanTitle,
    category,
    summary,
    ...(params.description?.trim() ? { description: params.description.trim() } : {}),
    source,
    momentumStatus,
    ...(params.sessionId?.trim() ? { sessionId: params.sessionId.trim() } : {}),
    status: "active",
    updatedAt: now,
    createdAt: now,
    subGoals,
    timeline,
    handoff: {
      id: `handoff-${id}`,
      title: cleanTitle,
      kindLabel: category,
      summary: `围绕目标「${cleanTitle}」在 Agent 工作台执行深度分析`,
      targetCwd: botWorkspaceDir,
    },
  };
  st.goals.unshift(created);
  if (options?.recordActivity !== false) {
    appendActivityRecord(st, {
      title: `设定长期目标：${cleanTitle}`,
      description: `${category} · ${summary}`,
      kind: "goal",
    });
  }
  return created;
}

export function updateGoalRecord(st: PersistedBotState, params: BotGoalUpdateParams): BotGoalItem | null {
  const g = st.goals.find((item) => item.id === params.id);
  if (g === undefined) return null;
  const now = Date.now();
  const curTimeline = Array.isArray(g.timeline) ? [...g.timeline] : [];
  const curSubGoals = Array.isArray(g.subGoals) ? [...g.subGoals] : [];
  const pushTimeline = (title: string, detail: string) => {
    curTimeline.unshift({ id: `tl-${randomUUID().slice(0, 8)}`, title, detail, createdAt: now });
  };
  if (typeof params.title === "string" && params.title.trim() !== "" && params.title.trim() !== g.title) {
    g.title = params.title.trim();
    if (g.handoff) g.handoff.title = g.title;
  }
  if (typeof params.category === "string" && params.category.trim() !== "") g.category = params.category.trim();
  if (typeof params.summary === "string" && params.summary.trim() !== "") g.summary = params.summary.trim();
  if (typeof params.description === "string") g.description = params.description.trim();
  if (params.momentumStatus === "on_track" || params.momentumStatus === "waiting_user" || params.momentumStatus === "stalled") {
    g.momentumStatus = params.momentumStatus;
  }
  if (params.status !== undefined && params.status !== g.status) {
    const prev = g.status;
    g.status = params.status;
    if (params.status === "completed") {
      g.completedAt = now;
      pushTimeline(`完成目标：${g.title}`, g.summary);
    } else if (params.status === "active" && prev === "completed") {
      delete g.completedAt;
      pushTimeline("重新激活目标", g.title);
    }
  }
  if (typeof params.addSubGoal === "string" && params.addSubGoal.trim() !== "") {
    const subTitle = params.addSubGoal.trim();
    curSubGoals.push({ id: `sub-${randomUUID().slice(0, 8)}`, title: subTitle, done: false, createdAt: now });
    pushTimeline(`添加子目标：${subTitle}`, g.title);
  }
  if (typeof params.toggleSubGoalId === "string" && params.toggleSubGoalId.trim() !== "") {
    const sg = curSubGoals.find((s) => s.id === params.toggleSubGoalId);
    if (sg !== undefined) {
      sg.done = !sg.done;
      pushTimeline(sg.done ? `完成子目标：${sg.title}` : `恢复子目标：${sg.title}`, g.title);
    }
  }
  g.subGoals =
    typeof params.deleteSubGoalId === "string" && params.deleteSubGoalId.trim() !== ""
      ? curSubGoals.filter((s) => s.id !== params.deleteSubGoalId)
      : curSubGoals;
  if (params.timelineEntry && params.timelineEntry.title.trim() !== "") {
    pushTimeline(params.timelineEntry.title.trim(), params.timelineEntry.detail?.trim() || g.summary);
  }
  g.timeline = curTimeline.slice(0, MAX_GOAL_TIMELINE);
  g.updatedAt = now;
  return g;
}

export function saveGoalViewPrefsRecord(st: PersistedBotState, patch: Partial<BotGoalViewPrefs>): BotGoalViewPrefs {
  const cur = st.goalViewPrefs ?? buildDefaultGoalViewPrefs();
  const next: BotGoalViewPrefs = {
    showSubtitles: typeof patch.showSubtitles === "boolean" ? patch.showSubtitles : cur.showSubtitles,
    autoSort: typeof patch.autoSort === "boolean" ? patch.autoSort : cur.autoSort,
  };
  st.goalViewPrefs = next;
  return next;
}

/**
 * Rich V2 Discovery contracts (`动态` Feed Editions & Widgets, `点子` Blueprint Packages,
 * `目标` Commitment State Machine) for Qianji Bot Mode (`packages/protocol/src/bot-discovery.ts`).
 */
import type { BotSnapshotResult, BotTaskHandoffPayload } from "./bot-methods.ts";

export interface BotFeedSourceLink {
  label: string;
  url: string;
}

export interface BotFeedMetricRow {
  label: string;
  sublabel?: string;
  badge?: string;
  value: string;
  highlight?: boolean;
}

export interface BotFeedMetricsCard {
  title: string;
  rows: BotFeedMetricRow[];
}

export type BotFeedEditionKind = "morning" | "midday" | "evening" | "adhoc";
export type BotFeedOrigin = "generated" | "idea";
export type BotFeedActionKind = "discuss" | "start";

export type BotFeedAttachment =
  | { kind: "none" }
  | { kind: "hero_image"; heroImageUrl: string; imageAlt?: string; aspectRatio?: number }
  | { kind: "carousel"; imageUrls: string[] }
  | { kind: "widget"; widgetTitle?: string; widgetHtml: string };

export interface BotFeedItem {
  id: string;
  title: string;
  kicker?: string;
  category?: string;
  editionKind?: BotFeedEditionKind;
  origin?: BotFeedOrigin;
  timeLabel: string;
  body: string;
  actionLabel: string;
  actionKind?: BotFeedActionKind;
  seedPrompt: string;
  ideaId?: string;
  createdAt: number;
  icon?: string;
  liked?: boolean;
  reason?: string;
  attachment?: BotFeedAttachment;
  sourceLinks?: BotFeedSourceLink[];
  metricsCard?: BotFeedMetricsCard;
}

export type BotIdeaSource = "ai" | "starter";
export type BotIdeaSentiment = "more_like_this" | "not_interested";
export type BotIdeaBuildStatus = "not_started" | "building" | "installed";
export type BotIdeaCapabilityKind = "space" | "schedule" | "doc" | "goal" | "workbench" | "reminder";

export interface BotIdeaSchedulePreset {
  name: string;
  prompt: string;
  frequency: "interval" | "hourly" | "daily" | "weekdays" | "weekly" | "once";
  hour?: number;
  minute?: number;
  weekday?: number;
  intervalMinutes?: number;
}

export interface BotIdeaSpacePreset {
  title: string;
  description: string;
}

export interface BotIdeaDocPreset {
  name: string;
  summary: string;
}

export interface BotIdeaCapabilityItem {
  kind: BotIdeaCapabilityKind;
  title: string;
  subtitle: string;
  ready?: boolean;
  schedulePreset?: BotIdeaSchedulePreset;
  spacePreset?: BotIdeaSpacePreset;
  docPreset?: BotIdeaDocPreset;
}

export interface BotIdeaItem {
  id: string;
  icon: string;
  title: string;
  description: string;
  seedPrompt: string;
  category?: string | null;
  sourceLabel?: string;
  isFeatured?: boolean;
  source?: BotIdeaSource;
  reason?: string;
  capabilities?: BotIdeaCapabilityItem[];
  howItWorks?: string;
  buildStatus?: BotIdeaBuildStatus;
  createdAt?: number;
}

export interface BotIdeaSection {
  category: string | null;
  items: BotIdeaItem[];
}

export interface BotSubGoalItem {
  id: string;
  title: string;
  done: boolean;
  createdAt: number;
}

export interface BotGoalTimelineEntry {
  id: string;
  title: string;
  detail: string;
  createdAt: number;
}

export interface BotGoalViewPrefs {
  showSubtitles: boolean;
  autoSort: boolean;
}

export type BotGoalSource = "assistant_tracking" | "chat_interview" | "manual";
export type BotGoalMomentumStatus = "on_track" | "waiting_user" | "stalled";

export interface BotGoalItem {
  id: string;
  title: string;
  category: string;
  summary: string;
  description?: string;
  source?: BotGoalSource;
  momentumStatus?: BotGoalMomentumStatus;
  sessionId?: string;
  status: "active" | "paused" | "completed";
  updatedAt: number;
  createdAt?: number;
  completedAt?: number;
  subGoals?: BotSubGoalItem[];
  timeline?: BotGoalTimelineEntry[];
  handoff?: BotTaskHandoffPayload;
}

export interface BotFeedCreateParams {
  title: string;
  body: string;
  kicker?: string;
  category?: string;
  editionKind?: BotFeedEditionKind;
  origin?: BotFeedOrigin;
  seedPrompt?: string;
  ideaId?: string;
  actionKind?: BotFeedActionKind;
  actionLabel?: string;
  icon?: string;
  reason?: string;
  attachment?: BotFeedAttachment;
  sourceLinks?: BotFeedSourceLink[];
  metricsCard?: BotFeedMetricsCard;
}

export interface BotFeedToggleLikeParams {
  id: string;
  liked?: boolean;
}

export interface BotFeedSaveInstructionsParams {
  instructions: string;
  refreshNow?: boolean;
}

export interface BotFeedGenerateEditionParams {
  editionKind?: BotFeedEditionKind;
  force?: boolean;
}

export interface BotIdeasFeedbackParams {
  id: string;
  sentiment: BotIdeaSentiment;
}

export interface BotIdeasLaunchResult {
  ok: true;
  idea: BotIdeaItem | null;
  createdSpaceId?: string;
  createdScheduleId?: string;
  createdDocId?: string;
  launchPrompt: string;
  snapshot: BotSnapshotResult;
}

export interface BotGoalCreateParams {
  title: string;
  category?: string;
  summary?: string;
  description?: string;
  source?: BotGoalSource;
  momentumStatus?: BotGoalMomentumStatus;
  sessionId?: string;
  subGoals?: string[];
}

export interface BotGoalUpdateParams {
  id: string;
  title?: string;
  category?: string;
  summary?: string;
  description?: string;
  momentumStatus?: BotGoalMomentumStatus;
  status?: "active" | "paused" | "completed";
  timelineEntry?: { title: string; detail?: string };
  addSubGoal?: string;
  toggleSubGoalId?: string;
  deleteSubGoalId?: string;
}

export interface BotDiscoveryRpcMethodMap {
  "bot.feed.create": { params: BotFeedCreateParams; result: { item: BotFeedItem } };
  "bot.feed.toggleLike": { params: BotFeedToggleLikeParams; result: { item: BotFeedItem | null } };
  "bot.feed.delete": { params: { id: string }; result: { ok: true } };
  "bot.feed.saveInstructions": {
    params: BotFeedSaveInstructionsParams;
    result: { instructions: string; snapshot: BotSnapshotResult };
  };
  "bot.feed.generateEdition": {
    params: BotFeedGenerateEditionParams;
    result: { added: number; items: BotFeedItem[]; snapshot: BotSnapshotResult };
  };
  "bot.ideas.feedback": {
    params: BotIdeasFeedbackParams;
    result: { ok: true; generated: BotIdeaItem[]; snapshot: BotSnapshotResult };
  };
  "bot.ideas.restore": {
    params: { id: string };
    result: { ok: true; snapshot: BotSnapshotResult };
  };
  "bot.ideas.launch": {
    params: { id: string };
    result: BotIdeasLaunchResult;
  };
  "bot.ideas.refresh": {
    params: Record<string, never>;
    result: { added: number; snapshot: BotSnapshotResult };
  };
  "bot.goals.create": { params: BotGoalCreateParams; result: { goal: BotGoalItem } };
  "bot.goals.update": { params: BotGoalUpdateParams; result: { goal: BotGoalItem | null } };
  "bot.goals.delete": { params: { id: string }; result: { ok: true } };
  "bot.goals.savePrefs": {
    params: Partial<BotGoalViewPrefs>;
    result: { goalViewPrefs: BotGoalViewPrefs };
  };
}

/**
 * JSON-RPC 2.0 V2 `bot.feed.*`, `bot.ideas.*`, & `bot.goals.*` Discovery endpoints
 * (`packages/host/src/bot/bot-discovery-rpc.ts`).
 */
import type { Context } from "@deepseek-ai/cordis";
import {
  ErrorCode,
  type BotFeedActionKind,
  type BotFeedAttachment,
  type BotFeedEditionKind,
  type BotFeedMetricRow,
  type BotFeedMetricsCard,
  type BotFeedOrigin,
  type BotFeedSourceLink,
  type BotGoalMomentumStatus,
  type BotGoalSource,
  type BotIdeaSentiment,
} from "@qianji/protocol";
import { RpcError } from "@qianji/rpc";
import type { Schedule } from "@qianji/schedule";
import type { ProactivePulseEngine } from "./harness/bot-proactive-pulse.ts";
import type { BotStateStore } from "./store.ts";

type Params = Record<string, unknown>;

function asObject(raw: unknown): Params {
  if (raw === undefined || raw === null) return {};
  if (typeof raw !== "object" || Array.isArray(raw)) {
    throw new RpcError(ErrorCode.InvalidParams, "params must be an object");
  }
  return raw as Params;
}

function reqString(p: Params, key: string): string {
  const val = p[key];
  if (typeof val !== "string" || val.trim() === "") {
    throw new RpcError(ErrorCode.InvalidParams, `${key} must be a non-empty string`);
  }
  return val;
}

function parseEditionKind(raw: unknown): BotFeedEditionKind | undefined {
  return raw === "morning" || raw === "midday" || raw === "evening" || raw === "adhoc" ? raw : undefined;
}

function parseAttachment(raw: unknown): BotFeedAttachment | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const rec = raw as Record<string, unknown>;
  if (rec.kind === "none") return { kind: "none" };
  if (rec.kind === "hero_image" && typeof rec.heroImageUrl === "string" && rec.heroImageUrl.trim() !== "") {
    return {
      kind: "hero_image",
      heroImageUrl: rec.heroImageUrl.trim(),
      ...(typeof rec.imageAlt === "string" ? { imageAlt: rec.imageAlt } : {}),
      ...(typeof rec.aspectRatio === "number" ? { aspectRatio: rec.aspectRatio } : {}),
    };
  }
  if (rec.kind === "carousel" && Array.isArray(rec.imageUrls)) {
    const imageUrls = rec.imageUrls.filter((u): u is string => typeof u === "string" && u.trim() !== "");
    return imageUrls.length > 0 ? { kind: "carousel", imageUrls } : undefined;
  }
  if (rec.kind === "widget" && typeof rec.widgetHtml === "string" && rec.widgetHtml.trim() !== "") {
    return {
      kind: "widget",
      ...(typeof rec.widgetTitle === "string" ? { widgetTitle: rec.widgetTitle } : {}),
      widgetHtml: rec.widgetHtml,
    };
  }
  return undefined;
}

function parseSourceLinks(raw: unknown): BotFeedSourceLink[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const links: BotFeedSourceLink[] = [];
  for (const item of raw) {
    if (item && typeof item === "object" && !Array.isArray(item)) {
      const rec = item as Record<string, unknown>;
      if (typeof rec.label === "string" && typeof rec.url === "string" && rec.url.trim() !== "") {
        links.push({ label: rec.label.trim() || rec.url.trim(), url: rec.url.trim() });
      }
    }
  }
  return links.length > 0 ? links : undefined;
}

function parseMetricsCard(raw: unknown): BotFeedMetricsCard | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const card = raw as Record<string, unknown>;
  if (typeof card.title !== "string" || !Array.isArray(card.rows)) return undefined;
  const rows: BotFeedMetricRow[] = [];
  for (const row of card.rows) {
    if (row && typeof row === "object" && !Array.isArray(row)) {
      const r = row as Record<string, unknown>;
      if (typeof r.label === "string" && typeof r.value === "string") {
        rows.push({
          label: r.label,
          value: r.value,
          ...(typeof r.sublabel === "string" ? { sublabel: r.sublabel } : {}),
          ...(typeof r.badge === "string" ? { badge: r.badge } : {}),
          ...(typeof r.highlight === "boolean" ? { highlight: r.highlight } : {}),
        });
      }
    }
  }
  return rows.length > 0 ? { title: card.title, rows } : undefined;
}

export function registerBotDiscoveryRpc(
  rpcCtx: Context,
  store: BotStateStore,
  pulse: ProactivePulseEngine,
  notifyUpdated: (reason: string) => void,
): void {
  rpcCtx.rpc.method("bot.feed.create", async (raw) => {
    const p = asObject(raw);
    const actionKind: BotFeedActionKind | undefined =
      p.actionKind === "start" || p.actionKind === "discuss" ? p.actionKind : undefined;
    const origin: BotFeedOrigin | undefined =
      p.origin === "generated" || p.origin === "idea" ? p.origin : undefined;
    const editionKind = parseEditionKind(p.editionKind);
    const attachment = parseAttachment(p.attachment);
    const sourceLinks = parseSourceLinks(p.sourceLinks);
    const metricsCard = parseMetricsCard(p.metricsCard);
    const item = await store.createFeedItem({
      title: reqString(p, "title"),
      body: reqString(p, "body"),
      ...(typeof p.kicker === "string" ? { kicker: p.kicker } : {}),
      ...(typeof p.category === "string" ? { category: p.category } : {}),
      ...(editionKind !== undefined ? { editionKind } : {}),
      ...(origin !== undefined ? { origin } : {}),
      ...(typeof p.seedPrompt === "string" ? { seedPrompt: p.seedPrompt } : {}),
      ...(typeof p.ideaId === "string" ? { ideaId: p.ideaId } : {}),
      ...(actionKind !== undefined ? { actionKind } : {}),
      ...(typeof p.actionLabel === "string" ? { actionLabel: p.actionLabel } : {}),
      ...(typeof p.icon === "string" ? { icon: p.icon } : {}),
      ...(typeof p.reason === "string" ? { reason: p.reason } : {}),
      ...(attachment !== undefined ? { attachment } : {}),
      ...(sourceLinks !== undefined ? { sourceLinks } : {}),
      ...(metricsCard !== undefined ? { metricsCard } : {}),
    });
    notifyUpdated("feed-created");
    return { item };
  });

  rpcCtx.rpc.method("bot.feed.toggleLike", async (raw) => {
    const p = asObject(raw);
    const item = await store.toggleFeedLike({
      id: reqString(p, "id"),
      ...(typeof p.liked === "boolean" ? { liked: p.liked } : {}),
    });
    if (item !== null) notifyUpdated("feed-liked");
    return { item };
  });

  rpcCtx.rpc.method("bot.feed.delete", async (raw) => {
    const p = asObject(raw);
    await store.deleteFeedItem(reqString(p, "id"));
    notifyUpdated("feed-deleted");
    return { ok: true as const };
  });

  rpcCtx.rpc.method("bot.feed.saveInstructions", async (raw) => {
    const p = asObject(raw);
    if (typeof p.instructions !== "string") {
      throw new RpcError(ErrorCode.InvalidParams, "instructions must be a string");
    }
    const instructions = await store.saveFeedInstructions(p.instructions);
    if (p.refreshNow === true) {
      await pulse.runPatrol({ force: true });
    }
    const snapshot = await store.snapshot();
    notifyUpdated("feed-instructions-saved");
    return { instructions, snapshot };
  });

  rpcCtx.rpc.method("bot.feed.generateEdition", async (raw) => {
    const p = asObject(raw);
    const editionKind = parseEditionKind(p.editionKind);
    const items = await store.generateFeedEdition({
      ...(editionKind !== undefined ? { editionKind } : {}),
      force: p.force === true,
      ctx: rpcCtx,
    });
    const snapshot = await store.snapshot();
    if (items.length > 0) notifyUpdated("feed-edition-generated");
    return { added: items.length, items, snapshot };
  });

  rpcCtx.rpc.method("bot.ideas.feedback", async (raw) => {
    const p = asObject(raw);
    const id = reqString(p, "id");
    const sentiment: BotIdeaSentiment | undefined =
      p.sentiment === "more_like_this" || p.sentiment === "not_interested" ? p.sentiment : undefined;
    if (sentiment === undefined) {
      throw new RpcError(ErrorCode.InvalidParams, 'sentiment must be "more_like_this" or "not_interested"');
    }
    const st = await store.ensureLoaded();
    const model = st.modelConfig?.patrol ?? st.modelConfig?.primary;
    const { generated } = await store.feedbackIdea(id, sentiment, rpcCtx, model);
    const snapshot = await store.snapshot();
    notifyUpdated("ideas-feedback");
    return { ok: true as const, generated, snapshot };
  });

  rpcCtx.rpc.method("bot.ideas.restore", async (raw) => {
    const p = asObject(raw);
    await store.restoreIdea(reqString(p, "id"));
    const snapshot = await store.snapshot();
    notifyUpdated("idea-restored");
    return { ok: true as const, snapshot };
  });

  rpcCtx.rpc.method("bot.ideas.launch", async (raw) => {
    const p = asObject(raw);
    const scheduleSvc = rpcCtx.get("schedule") as Schedule | undefined;
    const launched = await store.launchIdea(reqString(p, "id"), scheduleSvc);
    const snapshot = await store.snapshot();
    notifyUpdated("idea-launched");
    return { ok: true as const, ...launched, snapshot };
  });

  rpcCtx.rpc.method("bot.ideas.refresh", async () => {
    const st = await store.ensureLoaded();
    const model = st.modelConfig?.patrol ?? st.modelConfig?.primary;
    const addedItems = await store.refreshIdeas(rpcCtx, model);
    const snapshot = await store.snapshot();
    notifyUpdated("ideas-refreshed");
    return { added: addedItems.length, snapshot };
  });

  rpcCtx.rpc.method("bot.goals.create", async (raw) => {
    const p = asObject(raw);
    const subGoals = Array.isArray(p.subGoals)
      ? p.subGoals.filter((s): s is string => typeof s === "string" && s.trim() !== "")
      : undefined;
    const source: BotGoalSource | undefined =
      p.source === "assistant_tracking" || p.source === "chat_interview" || p.source === "manual" ? p.source : undefined;
    const momentumStatus: BotGoalMomentumStatus | undefined =
      p.momentumStatus === "on_track" || p.momentumStatus === "waiting_user" || p.momentumStatus === "stalled"
        ? p.momentumStatus
        : undefined;
    const goal = await store.createGoal({
      title: reqString(p, "title"),
      category: typeof p.category === "string" ? p.category : "通用",
      ...(typeof p.summary === "string" ? { summary: p.summary } : {}),
      ...(typeof p.description === "string" ? { description: p.description } : {}),
      ...(source !== undefined ? { source } : {}),
      ...(momentumStatus !== undefined ? { momentumStatus } : {}),
      ...(typeof p.sessionId === "string" ? { sessionId: p.sessionId } : {}),
      ...(subGoals !== undefined ? { subGoals } : {}),
    });
    notifyUpdated("goal-created");
    return { goal };
  });

  rpcCtx.rpc.method("bot.goals.update", async (raw) => {
    const p = asObject(raw);
    const id = reqString(p, "id");
    const status =
      p.status === "active" || p.status === "paused" || p.status === "completed" ? p.status : undefined;
    const momentumStatus: BotGoalMomentumStatus | undefined =
      p.momentumStatus === "on_track" || p.momentumStatus === "waiting_user" || p.momentumStatus === "stalled"
        ? p.momentumStatus
        : undefined;
    const rawTl =
      p.timelineEntry && typeof p.timelineEntry === "object" && !Array.isArray(p.timelineEntry)
        ? (p.timelineEntry as Record<string, unknown>)
        : undefined;
    const timelineEntry =
      rawTl && typeof rawTl.title === "string" && rawTl.title.trim() !== ""
        ? {
            title: rawTl.title,
            ...(typeof rawTl.detail === "string" ? { detail: rawTl.detail } : {}),
          }
        : undefined;
    const goal = await store.updateGoal({
      id,
      ...(typeof p.title === "string" ? { title: p.title } : {}),
      ...(typeof p.category === "string" ? { category: p.category } : {}),
      ...(typeof p.summary === "string" ? { summary: p.summary } : {}),
      ...(typeof p.description === "string" ? { description: p.description } : {}),
      ...(momentumStatus !== undefined ? { momentumStatus } : {}),
      ...(status !== undefined ? { status } : {}),
      ...(timelineEntry !== undefined ? { timelineEntry } : {}),
      ...(typeof p.addSubGoal === "string" ? { addSubGoal: p.addSubGoal } : {}),
      ...(typeof p.toggleSubGoalId === "string" ? { toggleSubGoalId: p.toggleSubGoalId } : {}),
      ...(typeof p.deleteSubGoalId === "string" ? { deleteSubGoalId: p.deleteSubGoalId } : {}),
    });
    if (goal !== null) notifyUpdated("goal-updated");
    return { goal };
  });

  rpcCtx.rpc.method("bot.goals.delete", async (raw) => {
    const p = asObject(raw);
    await store.deleteGoal(reqString(p, "id"));
    notifyUpdated("goal-deleted");
    return { ok: true as const };
  });

  rpcCtx.rpc.method("bot.goals.savePrefs", async (raw) => {
    const p = asObject(raw);
    const goalViewPrefs = await store.saveGoalPrefs({
      ...(typeof p.showSubtitles === "boolean" ? { showSubtitles: p.showSubtitles } : {}),
      ...(typeof p.autoSort === "boolean" ? { autoSort: p.autoSort } : {}),
    });
    notifyUpdated("goal-prefs-saved");
    return { goalViewPrefs };
  });
}

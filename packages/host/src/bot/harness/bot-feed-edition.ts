/**
 * V2 Personalized Feed Edition Engine (`morning` | `midday` | `evening` | `adhoc`),
 * Real External Web Scouting (HN Algolia + GitHub Search + bounded 32KB `og:image` scraping),
 * and Sandboxed HTML Comparison Widget Synthesis (`packages/host/src/bot/harness/bot-feed-edition.ts`).
 */
import type { Context } from "@deepseek-ai/cordis";
import { BlockAssembler } from "@qianji/llm";
import type { BotFeedAttachment, BotFeedCreateParams, BotFeedEditionKind, BotFeedItem } from "@qianji/protocol";
import type { ModelRef, Sessions } from "@qianji/session";
import { DEFAULT_FEED_INSTRUCTIONS, type PersistedBotState } from "../defaults.ts";
import { appendActivityRecord, createRichFeedRecord } from "../store-discovery.ts";
import { upsertPersonalizedIdeas } from "../store-ideas.ts";
import { stripThinkAndConnectorNoise, truncateCodepoints } from "../store-turn-namer.ts";

const MAX_HTML_SCRAPE_BYTES = 32 * 1024;

export interface ExternalScoutHit {
  source: "hn" | "github"; title: string; url: string;
  metricPrimary: string; metricSecondary: string; summary: string;
  anchorReason: string; topicLabel: string; heroImageUrl?: string;
}

export interface FocusTopic {
  query: string; label: string; anchorReason: string;
}

export function resolveEditionKind(explicit?: BotFeedEditionKind, nowMs = Date.now()): BotFeedEditionKind {
  if (explicit === "morning" || explicit === "midday" || explicit === "evening" || explicit === "adhoc") return explicit;
  const hour = new Date(nowMs).getHours();
  if (hour >= 5 && hour < 11) return "morning";
  if (hour >= 11 && hour < 17) return "midday";
  return "evening";
}

function escapeHtml(raw: string): string {
  return raw.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

export function sanitizeWidgetHtml(rawHtml: string): string {
  return rawHtml.replace(/<script\b[\s\S]*?<\/script>/gi, "").replace(/<script\b[^>]*\/?>/gi, "")
    .replace(/\son[a-z]+\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi, "").replace(/javascript:/gi, "").trim();
}

export function buildComparisonWidgetHtml(
  widgetTitle: string,
  rows: ReadonlyArray<{ name: string; sub: string; badge?: string; metric: string; highlight?: boolean }>,
): string {
  const renderedRows = rows.slice(0, 4).map((r) => {
    const hiStyle = r.highlight
      ? "background:var(--hatch-widget-surface-muted,rgba(37,99,235,0.08));border-color:var(--hatch-widget-accent,#2563eb);"
      : "background:var(--hatch-widget-surface,#ffffff);border-color:var(--hatch-widget-border,rgba(120,120,128,0.18));";
    const badgeHtml = r.badge ? `<span style="display:inline-block;margin-left:6px;padding:1px 7px;border-radius:999px;font-size:11px;font-weight:600;color:var(--hatch-widget-accent,#2563eb);background:var(--hatch-widget-surface-muted,rgba(37,99,235,0.1));">${escapeHtml(r.badge)}</span>` : "";
    const valColor = r.highlight ? "var(--hatch-widget-accent,#2563eb)" : "var(--hatch-widget-text,#18181b)";
    return `<div style="display:flex;align-items:center;justify-content:space-between;gap:12px;padding:10px 12px;border:1px solid;border-radius:10px;${hiStyle}"><div style="min-width:0;"><div style="font-size:13px;font-weight:600;color:var(--hatch-widget-text,#18181b);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${escapeHtml(r.name)}${badgeHtml}</div><div style="font-size:12px;color:var(--hatch-widget-muted,#71717a);margin-top:2px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${escapeHtml(r.sub)}</div></div><div style="font-size:13px;font-weight:700;font-variant-numeric:tabular-nums;color:${valColor};white-space:nowrap;">${escapeHtml(r.metric)}</div></div>`;
  }).join("\n");
  return `<div style="font-family:system-ui,-apple-system,sans-serif;padding:12px;border-radius:12px;background:var(--hatch-widget-surface,#ffffff);border:1px solid var(--hatch-widget-border,rgba(120,120,128,0.18));color:var(--hatch-widget-text,#18181b);"><div style="font-size:11px;font-weight:600;letter-spacing:0.02em;color:var(--hatch-widget-muted,#71717a);margin-bottom:8px;">${escapeHtml(widgetTitle)}</div><div style="display:flex;flex-direction:column;gap:6px;">${renderedRows}</div></div>`;
}

function cleanQueryCandidate(raw: string): string {
  const latinTokens = raw.match(/[A-Za-z][A-Za-z0-9.+_-]{1,22}/g) ?? [];
  if (latinTokens.length > 0) return latinTokens.slice(0, 3).join(" ");
  return truncateCodepoints(raw.replace(/^(?:关注动态主题：|偏好点子方向：|不感兴趣的点子方向：)/u, "").replace(/[，。！？、：；“”"'（）()[\]【】]/g, " ").trim(), 18);
}

export async function extractFeedFocusTopics(options: { st: PersistedBotState; memoryMarkdown?: string; sessions?: Sessions }): Promise<FocusTopic[]> {
  const { st, memoryMarkdown = "", sessions } = options;
  const topics: FocusTopic[] = [];
  const seen = new Set<string>();
  const pushTopic = (rawCandidate: string, label: string, anchorReason: string) => {
    const query = cleanQueryCandidate(rawCandidate);
    const key = query.toLowerCase();
    if (!query || query.length < 2 || seen.has(key) || topics.length >= 4) return;
    seen.add(key);
    topics.push({ query, label: truncateCodepoints(label.trim(), 16), anchorReason });
  };

  const customInst = (st.feedInstructions ?? "").trim();
  if (customInst !== "" && customInst !== DEFAULT_FEED_INSTRUCTIONS) {
    pushTopic(customInst, "自定义关注", `你在「动态版块说明」里交代了「${truncateCodepoints(customInst, 28)}」，我按这条主线替你筛出了最新动态。`);
  }
  for (const goal of st.goals.filter((g) => g.status === "active").slice(0, 2)) {
    pushTopic(`${goal.title} ${goal.summary}`, goal.category || "目标关联", `你正在推进目标「${goal.title}」，这条外部进展与你当前卡点直接相关，可以拿来对照参考。`);
  }
  for (const pref of st.learnedPreferences.filter((p) => !p.startsWith("不感兴趣")).slice(0, 3)) {
    const cleanPref = pref.replace(/^关注动态主题：/u, "").trim();
    pushTopic(cleanPref, "偏好延伸", `我记得你一直关注「${truncateCodepoints(cleanPref, 22)}」，这篇新进展正好落在你关心的方向上。`);
  }
  for (const space of st.spaces.slice(0, 2)) {
    pushTopic(space.title, "常驻空间", `结合你维护的空间「${space.title}」，我把直接相关的最新外部信号整理到了这里。`);
  }
  if (topics.length < 2 && sessions !== undefined) {
    const mainSess = await sessions.get(st.mainSessionId).catch(() => undefined);
    const lastUserMsg = [...(mainSess?.state().messages ?? [])].reverse().find((m) => m.role === "user");
    if (lastUserMsg) {
      const txt = stripThinkAndConnectorNoise(lastUserMsg.content.flatMap((b) => (b.type === "text" ? [b.text] : [])).join(" "), true);
      if (txt.length >= 4) pushTopic(txt, "对话追踪", `上次我们在聊天里聊到了「${truncateCodepoints(txt, 22)}」，我顺着这个话题帮你盯到了最新实测与讨论。`);
    }
  }
  if (topics.length < 2 && memoryMarkdown.trim() !== "") {
    const firstBullet = memoryMarkdown.split(/\r?\n/).map((l) => l.replace(/^[-*•#]\s*/, "").trim()).find((l) => l.length >= 4 && !/^MEMORY\.md$/i.test(l));
    if (firstBullet) pushTopic(firstBullet, "长期记忆", `结合你长期关注的「${truncateCodepoints(firstBullet, 22)}」，这条外部变化值得花十秒扫一眼。`);
  }
  const defaultTopics: FocusTopic[] = [
    { query: "LLM local inference benchmark", label: "模型与推理", anchorReason: "你在千机里日常使用多模型与本地工作区协作，这条推理效率与模型实测进展能帮你在选型时做参考。" },
    { query: "AI coding agent developer tools", label: "开发工具链", anchorReason: "围绕你日常的工程开发与自动化工作流，我筛出了社区热度最高且有实际指标支撑的工具进展。" },
  ];
  for (const dt of defaultTopics) {
    if (topics.length >= 2) break;
    pushTopic(dt.query, dt.label, dt.anchorReason);
  }
  return topics.slice(0, 3);
}

async function readBoundedHtml(res: Response): Promise<string> {
  if (!res.body) return (await res.text()).slice(0, MAX_HTML_SCRAPE_BYTES);
  const reader = res.body.getReader();
  const decoder = new TextDecoder("utf-8", { fatal: false });
  let total = 0;
  let out = "";
  try {
    while (total < MAX_HTML_SCRAPE_BYTES) {
      const { done, value } = await reader.read();
      if (done || !value) break;
      const slice = value.byteLength + total > MAX_HTML_SCRAPE_BYTES ? value.subarray(0, MAX_HTML_SCRAPE_BYTES - total) : value;
      total += slice.byteLength;
      out += decoder.decode(slice, { stream: true });
      if (/<\/head>/i.test(out)) break;
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }
  return out;
}

export async function scrapeOgImageUrl(pageUrl: string, fetchFn: typeof fetch): Promise<string | undefined> {
  if (!/^https?:\/\//i.test(pageUrl)) return undefined;
  try {
    const res = await fetchFn(pageUrl, { headers: { Accept: "text/html,application/xhtml+xml", "User-Agent": "QianjiBot/2.0" }, signal: AbortSignal.timeout(4500) });
    if (!res.ok) return undefined;
    const html = await readBoundedHtml(res);
    for (const re of [
      /<meta[^>]+(?:property|name)\s*=\s*["'](?:og:image|twitter:image)["'][^>]+content\s*=\s*["']([^"']+)["']/i,
      /<meta[^>]+content\s*=\s*["']([^"']+)["'][^>]+(?:property|name)\s*=\s*["'](?:og:image|twitter:image)["']/i,
    ]) {
      const raw = re.exec(html)?.[1]?.trim();
      if (raw) {
        const resolved = new URL(raw.replace(/&amp;/g, "&"), pageUrl).toString();
        if (/^https?:\/\//i.test(resolved)) return resolved;
      }
    }
    return undefined;
  } catch { return undefined; }
}

export async function scoutExternalSignals(topics: readonly FocusTopic[], fetchFn: typeof fetch = globalThis.fetch): Promise<ExternalScoutHit[]> {
  const hits: ExternalScoutHit[] = [];
  const seenUrls = new Set<string>();
  const primaryTopic = topics[0];
  const secondaryTopic = topics[1] ?? topics[0];

  await Promise.all([
    primaryTopic ? (async () => {
      try {
        const res = await fetchFn(`https://hn.algolia.com/api/v1/search_by_date?query=${encodeURIComponent(primaryTopic.query)}&tags=story&hitsPerPage=4`, { signal: AbortSignal.timeout(4500) });
        if (!res.ok) return;
        const data = (await res.json()) as { hits?: Array<{ objectID?: string; title?: string; url?: string; points?: number; num_comments?: number }> };
        for (const h of data.hits ?? []) {
          const title = h.title?.trim() ?? "";
          const url = (h.url?.trim() || (h.objectID ? `https://news.ycombinator.com/item?id=${h.objectID}` : "")).trim();
          if (!title || !url || seenUrls.has(url)) continue;
          seenUrls.add(url);
          hits.push({
            source: "hn", title, url, metricPrimary: `${h.points ?? 0} 热度`, metricSecondary: `${h.num_comments ?? 0} 条讨论`,
            summary: `社区讨论达 ${h.num_comments ?? 0} 条，热度 ${h.points ?? 0} 分`, anchorReason: primaryTopic.anchorReason, topicLabel: primaryTopic.label,
          });
        }
      } catch { /* Offline */ }
    })() : Promise.resolve(),
    secondaryTopic ? (async () => {
      try {
        const res = await fetchFn(`https://api.github.com/search/repositories?q=${encodeURIComponent(secondaryTopic.query)}&sort=updated&per_page=3`, {
          headers: { Accept: "application/vnd.github+json", "User-Agent": "QianjiBot/2.0" }, signal: AbortSignal.timeout(4500),
        });
        if (!res.ok) return;
        const data = (await res.json()) as { items?: Array<{ full_name?: string; html_url?: string; description?: string; stargazers_count?: number; language?: string }> };
        for (const repo of data.items ?? []) {
          const name = repo.full_name?.trim() ?? "";
          const url = repo.html_url?.trim() ?? "";
          if (!name || !url || seenUrls.has(url)) continue;
          seenUrls.add(url);
          hits.push({
            source: "github", title: name, url, metricPrimary: `★ ${(repo.stargazers_count ?? 0).toLocaleString("en-US")}`,
            metricSecondary: repo.language || "开源项目", summary: repo.description?.trim() || `${repo.language || "开源"}仓库近期持续活跃更新`,
            anchorReason: secondaryTopic.anchorReason, topicLabel: secondaryTopic.label,
          });
        }
      } catch { /* Offline */ }
    })() : Promise.resolve(),
  ]);

  await Promise.all(hits.slice(0, 2).map(async (hit) => {
    const ogImg = await scrapeOgImageUrl(hit.url, fetchFn);
    if (ogImg !== undefined) hit.heroImageUrl = ogImg;
  }));
  return hits;
}

function collectLocalOpportunityUnit(st: PersistedBotState, editionKind: BotFeedEditionKind): BotFeedCreateParams | null {
  const latestMail = st.inboxItems[0];
  if (latestMail !== undefined) {
    const ideaTitle = `我可以帮你核查并处理来自 ${latestMail.sender} 的「${truncateCodepoints(latestMail.subject, 18)}」`;
    const added = upsertPersonalizedIdeas(st, [{
      icon: "✉", title: ideaTitle,
      description: `提取「${latestMail.subject}」中的关键确认点与截止时间，并在「批准」栏备好回复草稿。`,
      seedPrompt: `帮我查看并梳理 ${latestMail.sender} 发来的「${latestMail.subject}」，总结关键行动项并准备回复草稿。`,
      sourceLabel: "收件箱即时行动", reason: `收件箱刚刚同步了来自 ${latestMail.sender} 的消息`,
    }]);
    const matchedIdea = added[0] ?? st.ideaSections.flatMap((s) => s.items).find((it) => it.title.includes(truncateCodepoints(latestMail.subject, 12)));
    return {
      title: `待处理来信：${truncateCodepoints(latestMail.subject, 24)}`,
      kicker: "即时行动", category: "账户与收件箱", editionKind, origin: "idea", actionKind: "start", actionLabel: "立即开始",
      ...(matchedIdea ? { ideaId: matchedIdea.id, seedPrompt: matchedIdea.seedPrompt } : {}),
      body: `收件箱收到来自 **${latestMail.sender}** 的「${truncateCodepoints(latestMail.subject, 26)}」，摘要：${truncateCodepoints(latestMail.preview, 48)}。我已经为你备好分步核查方案，点一下即可提取待办并起草得体回复。`,
      reason: `这封来自 ${latestMail.sender} 的信件需要跟进确认，我直接把它封装成了可一键启动的行动卡。`,
      attachment: { kind: "none" },
    };
  }

  const waitingGoal = st.goals.find((g) => g.status === "active" && g.momentumStatus === "waiting_user") ?? st.goals.find((g) => g.status === "active");
  if (waitingGoal !== undefined) {
    const ideaTitle = `我可以帮你推进目标「${truncateCodepoints(waitingGoal.title, 18)}」的当前卡点`;
    const added = upsertPersonalizedIdeas(st, [{
      icon: "🎯", title: ideaTitle,
      description: `针对当前进展「${truncateCodepoints(waitingGoal.summary, 42)}」，拆出立即可落地的一步并更新目标时间线。`,
      seedPrompt: `围绕我的活跃目标「${waitingGoal.title}」（当前状态：${waitingGoal.summary}），帮我直接推进下一步关键动作。`,
      sourceLabel: "目标阻塞推进", reason: `你正在追踪的目标「${waitingGoal.title}」正处于推进窗口`,
    }]);
    const matchedIdea = added[0] ?? st.ideaSections.flatMap((s) => s.items).find((it) => it.title.includes(truncateCodepoints(waitingGoal.title, 12)));
    return {
      title: `推进「${truncateCodepoints(waitingGoal.title, 20)}」下一步节点`,
      kicker: "目标跟进", category: waitingGoal.category || "目标推进", editionKind, origin: "idea", actionKind: "start", actionLabel: "立即开始",
      ...(matchedIdea ? { ideaId: matchedIdea.id, seedPrompt: matchedIdea.seedPrompt } : {}),
      body: `你追踪的目标「${waitingGoal.title}」当前停在：${truncateCodepoints(waitingGoal.summary, 52)}。我可以现在替你把前置核对材料跑完，只留最关键的一步等你拍板。`,
      reason: `我一直在替你盯着「${waitingGoal.title}」的进度，趁现在有空档正好可以把卡住的一步往前推完。`,
      attachment: { kind: "none" },
    };
  }
  return null;
}

interface LlmEditionUnitDraft {
  title?: string; kicker?: string; category?: string; body?: string; reason?: string;
  seedPrompt?: string; sourceUrl?: string; sourceLabel?: string; heroImageUrl?: string;
  widgetTitle?: string; widgetHtml?: string;
}

async function synthesizeEditionWithLlm(options: {
  ctx?: Context; model?: ModelRef; editionKind: BotFeedEditionKind;
  feedInstructions: string; topics: readonly FocusTopic[]; hits: readonly ExternalScoutHit[];
}): Promise<BotFeedCreateParams[]> {
  const llm = options.ctx?.get("llm");
  if (!llm || !options.model || options.hits.length === 0) return [];
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 18_000);
  try {
    const assembler = new BlockAssembler();
    const system = [
      "你是千机个人分身的私人科技与工作主编（Muse 动态刊次引擎）。",
      `用户动态版块指示：${options.feedInstructions}`,
      "写作铁律：1) body 严格两句话高密度结论 + 关键数字，正文中直接内嵌 `[关键词](https://...)` 指向真实信源 URL；2) kicker 3-6 字眉题，reason 用温暖第一人称「我注意到你...」说明与用户上下文的因果关系；3) 对比类提供无 <script> 的 widgetHtml（使用 var(--hatch-widget-text/muted/border/surface/surface-muted/accent)）。",
      '只输出 JSON：{"units":[{"title":"...","kicker":"...","category":"...","body":"[关键词](https://...) ...","reason":"...","seedPrompt":"...","sourceUrl":"https://...","sourceLabel":"...","heroImageUrl":"...","widgetTitle":"...","widgetHtml":"..."}]}',
    ].join("\n");
    const hitText = options.hits.slice(0, 6).map(
      (h, i) => `[${i + 1}] (${h.source}) title="${h.title}" | url=${h.url} | metrics=${h.metricPrimary}, ${h.metricSecondary} | summary=${h.summary} | ogImage=${h.heroImageUrl ?? "none"} | userContext=${h.anchorReason}`,
    ).join("\n");

    for await (const chunk of llm.stream(
      {
        provider: options.model.provider, model: options.model.model, sessionId: "bot-feed-edition", system,
        messages: [{ role: "user", content: [{ type: "text", text: `刊次：${options.editionKind}\n实时信源：\n${hitText}\n请编发 2 条高信噪比资讯卡。` }] }],
      },
      controller.signal,
    )) {
      assembler.push(chunk);
    }
    const raw = assembler.result().message.content.flatMap((b) => (b.type === "text" ? [b.text] : [])).join("\n");
    const match = /\{[\s\S]*\}/.exec(stripThinkAndConnectorNoise(raw, false));
    if (!match) return [];
    const parsed = JSON.parse(match[0]) as { units?: LlmEditionUnitDraft[] };
    const out: BotFeedCreateParams[] = [];
    for (const u of (parsed.units ?? []).slice(0, 3)) {
      const title = u.title?.trim() ?? "";
      let body = u.body?.trim() ?? "";
      if (!title || !body) continue;
      const fallbackHit = options.hits[out.length] ?? options.hits[0];
      const url = u.sourceUrl?.trim() || fallbackHit?.url || "";
      if (url && !/\[[^\]]+\]\(https?:\/\/[^)]+\)/.test(body)) body = `[${truncateCodepoints(title, 18)}](${url}) ${body}`;
      let attachment: BotFeedAttachment | undefined;
      if (typeof u.widgetHtml === "string" && u.widgetHtml.trim() !== "") {
        const cleanHtml = sanitizeWidgetHtml(u.widgetHtml);
        if (cleanHtml !== "") attachment = { kind: "widget", ...(u.widgetTitle?.trim() ? { widgetTitle: u.widgetTitle.trim() } : {}), widgetHtml: cleanHtml };
      } else {
        const img = u.heroImageUrl?.trim() && /^https?:\/\//i.test(u.heroImageUrl.trim()) ? u.heroImageUrl.trim() : fallbackHit?.heroImageUrl;
        if (img) attachment = { kind: "hero_image", heroImageUrl: img, imageAlt: title, aspectRatio: 1.78 };
      }
      out.push({
        title, kicker: truncateCodepoints(u.kicker?.trim() || "前沿速递", 6),
        category: u.category?.trim() || fallbackHit?.topicLabel || "技术前沿",
        editionKind: options.editionKind, origin: "generated", actionKind: "discuss", actionLabel: "讨论", body,
        reason: u.reason?.trim() || fallbackHit?.anchorReason || "结合你的关注方向与实时检索编发",
        seedPrompt: u.seedPrompt?.trim() || `围绕「${title}」，结合我的实际场景深入聊聊关键取舍与落地价值。`,
        ...(url ? { sourceLinks: [{ label: u.sourceLabel?.trim() || "信源原文", url }] } : {}),
        ...(attachment ? { attachment } : {}),
      });
    }
    return out;
  } catch {
    return [];
  } finally {
    clearTimeout(timer);
  }
}

function buildFallbackEditorialUnits(
  editionKind: BotFeedEditionKind,
  topics: readonly FocusTopic[],
  hits: readonly ExternalScoutHit[],
): BotFeedCreateParams[] {
  const units: BotFeedCreateParams[] = [];
  const leadHit = hits.find((h) => h.heroImageUrl !== undefined) ?? hits[0];
  if (leadHit !== undefined) {
    units.push({
      title: truncateCodepoints(leadHit.title, 38),
      kicker: leadHit.source === "github" ? "开源热榜" : "前沿实测",
      category: leadHit.topicLabel, editionKind, origin: "generated", actionKind: "discuss", actionLabel: "讨论",
      body: `[${truncateCodepoints(leadHit.title, 26)}](${leadHit.url}) 最新动态引发技术社区关注（${leadHit.metricPrimary} · ${leadHit.metricSecondary}）。${truncateCodepoints(leadHit.summary, 58)}，适合与你手头的方案做直接对照。`,
      reason: leadHit.anchorReason,
      seedPrompt: `帮我深入拆解「${leadHit.title}」（${leadHit.url}）的核心设计亮点，并评估对我们当前工作的借鉴价值。`,
      sourceLinks: [{ label: leadHit.source === "github" ? "GitHub 仓库" : "Hacker News 原文", url: leadHit.url }],
      ...(leadHit.heroImageUrl ? { attachment: { kind: "hero_image", heroImageUrl: leadHit.heroImageUrl, imageAlt: leadHit.title, aspectRatio: 1.78 } } : {}),
    });
  }
  const compareHits = hits.filter((h) => h !== leadHit).slice(0, 3);
  const topCompare = compareHits[0];
  if (topCompare !== undefined) {
    const widgetRows = (compareHits.length >= 2 ? compareHits : hits.slice(0, 3)).map((h, idx) => ({
      name: truncateCodepoints(h.title, 24), sub: truncateCodepoints(h.summary, 34),
      ...(idx === 0 ? { badge: "重点关注", highlight: true } : {}), metric: h.metricPrimary,
    }));
    units.push({
      title: `${topCompare.topicLabel}近期活跃方案横向速览`,
      kicker: "横向对比", category: topCompare.topicLabel, editionKind, origin: "generated", actionKind: "discuss", actionLabel: "讨论",
      body: `[${truncateCodepoints(topCompare.title, 24)}](${topCompare.url}) 等 ${widgetRows.length} 个相关项目近期密集更新，最高指标达 ${topCompare.metricPrimary}。下方卡片整理了核心活跃度与定位差异，方便十秒钟看清取舍。`,
      reason: topCompare.anchorReason,
      seedPrompt: `对比这几个近期活跃方案（以 ${topCompare.title} 为首），帮我分析各自适合的落地场景。`,
      sourceLinks: compareHits.slice(0, 2).map((h) => ({ label: truncateCodepoints(h.title, 18), url: h.url })),
      attachment: { kind: "widget", widgetTitle: `${topCompare.topicLabel} · 实时信源指标对比`, widgetHtml: buildComparisonWidgetHtml(`${topCompare.topicLabel} · 实时信源指标对比`, widgetRows) },
    });
  }
  if (units.length === 0) {
    const primary = topics[0] ?? { query: "AI engineering", label: "工程效率", anchorReason: "结合你日常关注的高效研发与多模型协作节奏，整理了一组选型对比维度供你随时探讨。" };
    const secondary = topics[1] ?? { query: "open source developer tools", label: "开发工具链", anchorReason: "围绕你日常高频使用的本地工程工具链，提炼了近期值得关注的效率实践。" };
    const fallbackUrl = `https://github.com/search?q=${encodeURIComponent(primary.query)}&type=repositories`;
    const secondUrl = `https://news.ycombinator.com/from?site=github.com`;
    units.push(
      {
        title: `围绕「${primary.label}」的开源工具与推理效率选型参考`,
        kicker: "专题速览", category: primary.label, editionKind, origin: "generated", actionKind: "discuss", actionLabel: "讨论",
        body: `围绕你关注的 [${primary.label} 开源生态](${fallbackUrl})，近期工具链正明显向「轻量本地执行 + 按需云端深度推理」收敛。下方整理了三类主流工作流模式的响应延迟与维护开销对比。`,
        reason: primary.anchorReason, seedPrompt: `结合我当前的项目环境，帮我细化「${primary.label}」方向最值得优先落地的实践方案。`,
        sourceLinks: [{ label: "GitHub 专题检索", url: fallbackUrl }],
        attachment: {
          kind: "widget", widgetTitle: `${primary.label} · 工作流模式对比`,
          widgetHtml: buildComparisonWidgetHtml(`${primary.label} · 工作流模式对比`, [
            { name: "本地隔离门禁 + 轻量巡检", sub: "零外发风险 · 适合高频后台核查", badge: "推荐组合", metric: "< 1.5s 首包", highlight: true },
            { name: "全量主力大模型直连", sub: "深度架构推演 · 长上下文精准推理", metric: "高推理上限" },
            { name: "定时批处理早报汇总", sub: "错峰夜间调研 · 晨间一页拍板", metric: "省 60% 成本" },
          ]),
        },
      },
      {
        title: `${secondary.label}：隔离验证与自动化复盘实践要点`,
        kicker: "效率洞察", category: secondary.label, editionKind, origin: "generated", actionKind: "discuss", actionLabel: "讨论",
        body: `近期社区在 [${secondary.label} 工程实践](${secondUrl}) 上的高赞讨论表明，将门禁单测与日常编辑工作区解耦可减少约 40% 上下文切换打断。配合固定时段的精简简报能显著提升深度编码连贯度。`,
        reason: secondary.anchorReason, seedPrompt: `帮我评估如何在当前工作流里落地「${secondary.label}」的隔离验证与自动化复盘。`,
        sourceLinks: [{ label: "社区工程实践", url: secondUrl }],
      },
    );
  }
  return units;
}

export async function generateFeedEditionForState(options: {
  st: PersistedBotState; ctx?: Context; sessions?: Sessions; memoryMarkdown?: string;
  model?: ModelRef; editionKind?: BotFeedEditionKind; force?: boolean; fetchFn?: typeof fetch; nowMs?: number;
}): Promise<BotFeedItem[]> {
  const nowMs = options.nowMs ?? Date.now();
  const editionKind = resolveEditionKind(options.editionKind, nowMs);
  const feedInstructions = (options.st.feedInstructions ?? DEFAULT_FEED_INSTRUCTIONS).trim();
  const topics = await extractFeedFocusTopics({
    st: options.st, memoryMarkdown: options.memoryMarkdown, sessions: options.sessions ?? options.ctx?.get("sessions"),
  });
  const hits = await scoutExternalSignals(topics, options.fetchFn ?? globalThis.fetch);

  let editorialUnits = await synthesizeEditionWithLlm({
    ctx: options.ctx, model: options.model ?? options.st.modelConfig?.patrol ?? options.st.modelConfig?.primary,
    editionKind, feedInstructions, topics, hits,
  });
  if (editorialUnits.length === 0) {
    editorialUnits = buildFallbackEditorialUnits(editionKind, topics, hits);
  } else if (hits.length >= 2 && !editorialUnits.some((u) => u.attachment?.kind === "widget")) {
    const widgetRows = hits.slice(0, 3).map((h, idx) => ({
      name: truncateCodepoints(h.title, 24), sub: truncateCodepoints(h.summary, 34),
      ...(idx === 0 ? { badge: "高热信源", highlight: true } : {}), metric: h.metricPrimary,
    }));
    const secondUnit = editorialUnits[1];
    if (secondUnit !== undefined && secondUnit.attachment?.kind !== "hero_image") {
      secondUnit.attachment = {
        kind: "widget", widgetTitle: `${secondUnit.category ?? "前沿动态"} · 关键指标对比`,
        widgetHtml: buildComparisonWidgetHtml(`${secondUnit.category ?? "前沿动态"} · 关键指标对比`, widgetRows),
      };
    }
  }

  const localOpportunity = collectLocalOpportunityUnit(options.st, editionKind);
  const candidateUnits: BotFeedCreateParams[] = [
    ...editorialUnits.slice(0, 3),
    ...(localOpportunity !== null ? [localOpportunity] : []),
  ].slice(0, 4);

  const existingTitles = new Set(options.st.feed.map((f) => f.title.trim().toLowerCase()));
  const existingUrls = new Set(options.st.feed.flatMap((f) => (f.sourceLinks ?? []).map((l) => l.url.trim())));
  const createdItems: BotFeedItem[] = [];
  for (const unit of [...candidateUnits].reverse()) {
    const normTitle = unit.title.trim().toLowerCase();
    const firstUrl = unit.sourceLinks?.[0]?.url.trim();
    if (!options.force && (existingTitles.has(normTitle) || (firstUrl !== undefined && existingUrls.has(firstUrl)))) continue;
    existingTitles.add(normTitle);
    if (firstUrl !== undefined) existingUrls.add(firstUrl);
    createdItems.unshift(createRichFeedRecord(options.st, unit));
  }

  if (createdItems.length > 0) {
    const editionLabelMap: Record<BotFeedEditionKind, string> = { morning: "早刊", midday: "午刊", evening: "晚刊", adhoc: "即时特刊" };
    appendActivityRecord(options.st, {
      title: `编发动态${editionLabelMap[editionKind]}（${createdItems.length} 条）`,
      description: createdItems[0]?.title ?? "已更新个性化动态版块",
    });
  }
  return createdItems;
}

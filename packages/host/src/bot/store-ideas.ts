/**
 * V2 Idea Blueprint synthesis, one-click capability provisioning (`launchIdeaRecord`),
 * and `not_interested` undo (`restoreDismissedIdeaRecord`) (`packages/host/src/bot/store-ideas.ts`).
 */
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import type { Context } from "@deepseek-ai/cordis";
import { BlockAssembler } from "@qianji/llm";
import type {
  BotIdeaBuildStatus, BotIdeaCapabilityItem, BotIdeaCapabilityKind,
  BotIdeaItem, BotIdeaSection, BotIdeaSentiment,
} from "@qianji/protocol";
import type { Schedule } from "@qianji/schedule";
import type { ModelRef, Sessions } from "@qianji/session";
import { STARTER_IDEA_SECTIONS, type PersistedBotState } from "./defaults.ts";
import { appendActivityRecord, createSpaceRecord, reconcileFeedAndGoalsState } from "./store-discovery.ts";
import { rememberPreferenceEntry } from "./store-proactive.ts";
import { stripThinkAndConnectorNoise, truncateCodepoints } from "./store-turn-namer.ts";
import { writeFileAtomic } from "./workspace-scanner.ts";

const MAX_AI_IDEAS = 8;
const VALID_CAP_KINDS = new Set<BotIdeaCapabilityKind>(["space", "schedule", "doc", "goal", "workbench", "reminder"]);

export interface PersonalizedIdeaDraft {
  id?: string; icon?: string; title: string; description: string; seedPrompt: string;
  category?: string | null; sourceLabel?: string; isFeatured?: boolean; reason?: string;
  capabilities?: BotIdeaCapabilityItem[]; howItWorks?: string; buildStatus?: BotIdeaBuildStatus;
}

export interface IdeaLaunchOutcome {
  idea: BotIdeaItem | null; createdSpaceId?: string; createdScheduleId?: string; createdDocId?: string; launchPrompt: string;
}

export function normalizeIdeaKey(title: string): string {
  return title.toLowerCase().replace(/[\s，,。.!！?？：:；;“”"'「」『』·\-_()（）[\]【】]+/g, "").trim();
}

function slugifyDocFileName(raw: string): string {
  const base = raw.trim().replace(/[\\/:*?"<>|\s]+/g, "-").replace(/^-+|-+$/g, "") || `idea-report-${randomUUID().slice(0, 6)}`;
  return /\.[a-z0-9]+$/i.test(base) ? base : `${base}.md`;
}

function inferIdeaBlueprintDefaults(draft: PersonalizedIdeaDraft): {
  sourceLabel: string; capabilities: BotIdeaCapabilityItem[]; howItWorks: string;
} {
  const combined = `${draft.title} ${draft.description} ${draft.seedPrompt}`;
  const shortTitle = truncateCodepoints(draft.title.replace(/^(?:我可以(?:为你|帮你|按)?|给你一份)/u, "").trim(), 18) || "专项核查";
  const explicitCaps = (draft.capabilities ?? []).filter(
    (c): c is BotIdeaCapabilityItem => Boolean(c && VALID_CAP_KINDS.has(c.kind) && typeof c.title === "string" && c.title.trim() !== ""),
  );
  let capabilities: BotIdeaCapabilityItem[] = explicitCaps.map((c) => ({
    ...c, title: c.title.trim(), subtitle: (c.subtitle || draft.description).trim(), ready: c.ready !== false,
  }));

  let sourceLabel = draft.sourceLabel?.trim() || "";
  if (capabilities.length === 0) {
    if (/空间|面板|看板/u.test(combined)) {
      sourceLabel = sourceLabel || "空间沉淀方案";
      capabilities = [{
        kind: "space", title: "空间", subtitle: `围绕「${shortTitle}」持续归档进展与待拍板项。`,
        ready: true, spacePreset: { title: shortTitle, description: draft.description.trim() },
      }];
    } else if (/每周|每天|每日|早报|周报|定期|定时|巡检/u.test(combined)) {
      sourceLabel = sourceLabel || "自动跟进方案";
      const isWeekly = /每周|周[一二三四五六日]/u.test(combined);
      capabilities = [
        {
          kind: "schedule", title: "定期任务",
          subtitle: isWeekly ? "每周一 09:00 自动核查并更新简报。" : "每早 09:00 自动汇总关键进展。", ready: true,
          schedulePreset: {
            name: truncateCodepoints(shortTitle, 20), prompt: draft.seedPrompt.trim() || draft.title.trim(),
            frequency: isWeekly ? "weekly" : "daily", hour: 9, minute: 0, ...(isWeekly ? { weekday: 1 } : {}),
          },
        },
        {
          kind: "doc", title: `${shortTitle}归档报告`, subtitle: "每次执行后沉淀对比结论到资源库。", ready: true,
          docPreset: { name: slugifyDocFileName(`idea-${shortTitle.slice(0, 12)}`), summary: draft.description.trim() },
        },
      ];
    } else if (/压测|脚本|基准|仓库|分支|PR|构建|门禁|代码/iu.test(combined)) {
      sourceLabel = sourceLabel || "工程验证方案";
      capabilities = [
        { kind: "workbench", title: "隔离环境验证草案", subtitle: "在受控工作区采集指标并核实改动风险。", ready: true },
        {
          kind: "doc", title: `${shortTitle}对比清单`, subtitle: "汇总关键数据、影响范围与下一步建议。", ready: true,
          docPreset: { name: slugifyDocFileName(`verify-${shortTitle.slice(0, 12)}`), summary: draft.description.trim() },
        },
      ];
    } else {
      sourceLabel = sourceLabel || (/邮件|回复|收件箱/u.test(combined) ? "沟通跟进方案" : "个性化行动方案");
      capabilities = [{
        kind: "doc", title: `${shortTitle}核对报告`, subtitle: "提炼关键事实、风险点与可执行选项存入资源库。", ready: true,
        docPreset: { name: slugifyDocFileName(`brief-${shortTitle.slice(0, 12)}`), summary: draft.description.trim() },
      }];
    }
  }

  const howItWorks =
    draft.howItWorks?.trim() ||
    `我会先围绕「${shortTitle}」读取相关上下文与实时状态进行交叉核实，随后生成结构化结论交付物，并在关键拍板节点停下来提供清晰选项等你确认，绝不擅自执行对外写操作。`;

  return { sourceLabel: sourceLabel || "个性化行动方案", capabilities, howItWorks };
}

export function enrichIdeaItemBlueprint(item: BotIdeaItem, statusOverride?: BotIdeaBuildStatus): BotIdeaItem {
  const d = inferIdeaBlueprintDefaults(item);
  return {
    ...item, sourceLabel: item.sourceLabel?.trim() || d.sourceLabel,
    capabilities: item.capabilities && item.capabilities.length > 0 ? item.capabilities : d.capabilities,
    howItWorks: item.howItWorks?.trim() || d.howItWorks, buildStatus: statusOverride ?? item.buildStatus ?? "not_started",
  };
}

export function reconcileIdeaSectionsInState(st: PersistedBotState): void {
  const dismissedList = Array.from(new Set((st.dismissedIdeaIds ?? []).filter((id): id is string => typeof id === "string" && id.trim() !== "")));
  st.dismissedIdeaIds = dismissedList;
  const dismissed = new Set(dismissedList);
  const statusById = new Map<string, BotIdeaBuildStatus>();
  const persistedAi: BotIdeaItem[] = [];
  for (const sec of st.ideaSections ?? []) {
    for (const item of sec?.items ?? []) {
      if (!item || typeof item.id !== "string") continue;
      if (item.buildStatus === "installed" || item.buildStatus === "building") statusById.set(item.id, item.buildStatus);
      if (item.source === "ai" && typeof item.title === "string" && !dismissed.has(item.id)) persistedAi.push(enrichIdeaItemBlueprint(item, statusById.get(item.id)));
    }
  }

  const seenKeys = new Set<string>();
  const topItems: BotIdeaItem[] = [];
  for (const item of persistedAi) {
    const key = normalizeIdeaKey(item.title);
    if (key === "" || seenKeys.has(key)) continue;
    seenKeys.add(key);
    topItems.push({ ...item, source: "ai", isFeatured: item.isFeatured ?? true });
    if (topItems.length >= MAX_AI_IDEAS) break;
  }

  const sections: BotIdeaSection[] = [];
  for (const starterSec of STARTER_IDEA_SECTIONS) {
    const filteredStarter: BotIdeaItem[] = [];
    for (const stItem of starterSec.items) {
      if (dismissed.has(stItem.id)) continue;
      const key = normalizeIdeaKey(stItem.title);
      if (key === "" || seenKeys.has(key)) continue;
      seenKeys.add(key);
      filteredStarter.push(enrichIdeaItemBlueprint({ ...stItem, source: "starter", category: starterSec.category }, statusById.get(stItem.id)));
    }
    if (starterSec.category === null) {
      const mergedTop = [...topItems, ...filteredStarter];
      if (mergedTop.length > 0) sections.push({ category: null, items: mergedTop });
    } else if (filteredStarter.length > 0) {
      sections.push({ category: starterSec.category, items: filteredStarter });
    }
  }
  if (sections.every((s) => s.category !== null) && topItems.length > 0) sections.unshift({ category: null, items: topItems });
  st.ideaSections = sections;
}

export function reconcileBotDiscoveryState(st: PersistedBotState): void {
  reconcileIdeaSectionsInState(st);
  reconcileFeedAndGoalsState(st);
}

export function upsertPersonalizedIdeas(st: PersistedBotState, drafts: readonly PersonalizedIdeaDraft[]): BotIdeaItem[] {
  reconcileIdeaSectionsInState(st);
  const dismissed = new Set(st.dismissedIdeaIds ?? []);
  const existingAi: BotIdeaItem[] = [];
  const starterKeys = new Set<string>();
  for (const sec of st.ideaSections) {
    for (const item of sec.items) {
      if (item.source === "ai") existingAi.push(item);
      else starterKeys.add(normalizeIdeaKey(item.title));
    }
  }
  const now = Date.now();
  const added: BotIdeaItem[] = [];
  for (const draft of drafts) {
    const title = draft.title.trim();
    const description = draft.description.trim();
    if (title === "" || description === "") continue;
    const id = draft.id?.trim() || `idea-ai-${randomUUID().slice(0, 8)}`;
    const key = normalizeIdeaKey(title);
    if (dismissed.has(id) || key === "" || starterKeys.has(key)) continue;
    if (existingAi.some((it) => normalizeIdeaKey(it.title) === key) || added.some((it) => normalizeIdeaKey(it.title) === key)) continue;
    const bp = inferIdeaBlueprintDefaults(draft);
    added.push({
      id, icon: draft.icon?.trim() || "✦", title, description,
      seedPrompt: draft.seedPrompt.trim() || title, category: draft.category ?? null,
      sourceLabel: bp.sourceLabel, isFeatured: draft.isFeatured ?? true, source: "ai",
      ...(draft.reason?.trim() ? { reason: draft.reason.trim() } : {}),
      capabilities: bp.capabilities, howItWorks: bp.howItWorks,
      buildStatus: draft.buildStatus ?? "not_started", createdAt: now,
    });
  }
  if (added.length > 0) {
    st.ideaSections = [{ category: null, items: [...added, ...existingAi] }, ...st.ideaSections.filter((s) => s.category !== null)];
    reconcileIdeaSectionsInState(st);
  }
  return added;
}

async function synthesizeIdeasViaLlm(ctx: Context | undefined, model: ModelRef | undefined, prompt: string): Promise<PersonalizedIdeaDraft[]> {
  const llm = ctx?.get("llm");
  if (!llm || !model) return [];
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 20_000);
  try {
    const assembler = new BlockAssembler();
    const system = [
      "你是千机个人分身的「点子方案包 (Idea Blueprints)」构思引擎。",
      "请结合用户的真实目标、收件箱、常驻空间与近期对话，生成以「我可以...」或「给你一份...」开头的中文点子方案包，包含 capabilities（1-2 项 doc/space/schedule/goal/workbench/reminder）与 howItWorks。",
      '只输出 JSON：{"ideas":[{"icon":"✦","title":"...","description":"...","seedPrompt":"...","sourceLabel":"...","reason":"...","howItWorks":"...","capabilities":[{"kind":"doc","title":"...","subtitle":"...","ready":true}]}]}',
    ].join("\n");
    for await (const chunk of llm.stream(
      { provider: model.provider, model: model.model, sessionId: "bot-ideas-synth", system, messages: [{ role: "user", content: [{ type: "text", text: prompt }] }] },
      controller.signal,
    )) {
      assembler.push(chunk);
    }
    const raw = assembler.result().message.content.flatMap((b) => (b.type === "text" ? [b.text] : [])).join("\n");
    const match = /\{[\s\S]*\}/.exec(stripThinkAndConnectorNoise(raw, false));
    if (!match) return [];
    const parsed = JSON.parse(match[0]) as { ideas?: Array<Partial<PersonalizedIdeaDraft>> };
    return (parsed.ideas ?? [])
      .filter((it): it is PersonalizedIdeaDraft => typeof it.title === "string" && typeof it.description === "string")
      .map((it) => ({
        icon: typeof it.icon === "string" ? it.icon : "✦", title: it.title, description: it.description,
        seedPrompt: typeof it.seedPrompt === "string" && it.seedPrompt.trim() !== "" ? it.seedPrompt : it.title,
        ...(typeof it.sourceLabel === "string" ? { sourceLabel: it.sourceLabel } : {}),
        ...(typeof it.reason === "string" ? { reason: it.reason } : {}),
        ...(typeof it.howItWorks === "string" ? { howItWorks: it.howItWorks } : {}),
        ...(Array.isArray(it.capabilities) ? { capabilities: it.capabilities } : {}),
      }));
  } catch {
    return [];
  } finally {
    clearTimeout(timer);
  }
}

export async function applyIdeaFeedbackRecord(options: {
  ctx?: Context; st: PersistedBotState; memoryFile: string; model?: ModelRef; id: string; sentiment: BotIdeaSentiment;
}): Promise<{ generated: BotIdeaItem[] }> {
  const { ctx, st, memoryFile, model, id, sentiment } = options;
  reconcileIdeaSectionsInState(st);
  const found = st.ideaSections.flatMap((s) => s.items).find((it) => it.id === id);
  if (sentiment === "not_interested") {
    if (!(st.dismissedIdeaIds ?? []).includes(id)) st.dismissedIdeaIds = [...(st.dismissedIdeaIds ?? []), id];
    if (found !== undefined) rememberPreferenceEntry(st, memoryFile, `不感兴趣的点子方向：${found.title.slice(0, 28)}`);
    reconcileIdeaSectionsInState(st);
    return { generated: [] };
  }
  if (found === undefined) return { generated: [] };
  rememberPreferenceEntry(st, memoryFile, `偏好点子方向：${found.title.slice(0, 28)}`);

  const activeGoal = st.goals.find((g) => g.status === "active");
  const firstSpace = st.spaces[0];
  const existingTitles = st.ideaSections.flatMap((s) => s.items.map((i) => i.title)).join("；");
  const llmDrafts = await synthesizeIdeasViaLlm(
    ctx, model,
    [
      `用户对以下点子点击了「更多类似内容」：\n标题：${found.title}\n描述：${found.description}`,
      activeGoal ? `活跃目标：${activeGoal.title}（${activeGoal.summary}）` : "",
      firstSpace ? `常驻空间：${firstSpace.title}（${firstSpace.description}）` : "",
      `已有列表（避免重复）：${existingTitles}`,
      "请延伸构思 2 条更贴近用户上下文、带完整交付物清单的类似点子方案包。",
    ].filter(Boolean).join("\n"),
  );
  if (llmDrafts.length > 0) return { generated: upsertPersonalizedIdeas(st, llmDrafts.slice(0, 2)) };

  const shortTopic = truncateCodepoints(found.title.replace(/^(?:我可以(?:为你|帮你|按)?|给你一份)/u, "").trim(), 16) || found.title.slice(0, 16);
  const fallbackDrafts: PersonalizedIdeaDraft[] = [
    activeGoal
      ? {
          icon: "🎯", title: `我可以结合目标「${truncateCodepoints(activeGoal.title, 14)}」落地「${shortTopic}」清单`,
          description: `把该思路与你正在追踪的「${activeGoal.title}」对齐，拆出本周可直接勾选的推进步骤。`,
          seedPrompt: `结合我的目标「${activeGoal.title}」，按「${found.title}」的思路帮我制定一份可立即执行的行动清单。`,
          reason: `基于你对「${truncateCodepoints(found.title, 18)}」的偏好与活跃目标延伸生成`,
        }
      : {
          icon: "⚡", title: `给你一份围绕「${shortTopic}」的自动化复盘与定时跟进方案`,
          description: "整理成可复用的分步检查模板，必要时可挂入后台预定任务定期为你核对。",
          seedPrompt: `围绕「${found.title}」，帮我设计一套分步执行与定期复盘方案。`,
          reason: `基于你对「${truncateCodepoints(found.title, 18)}」点击「更多类似内容」延伸生成`,
        },
    firstSpace
      ? {
          icon: "❖", title: `我可以把「${shortTopic}」的关键结论持续沉淀到空间「${truncateCodepoints(firstSpace.title, 12)}」`,
          description: `每次核查后自动提炼变更要点归档进「${firstSpace.title}」，随时可查。`,
          seedPrompt: `帮我把「${found.seedPrompt}」的产出结构化沉淀到空间「${firstSpace.title}」中。`,
          reason: `结合你的偏好点子与常驻空间「${firstSpace.title}」生成`,
        }
      : {
          icon: "✓", title: `我可以先在隔离工作区试跑「${shortTopic}」并给你一页结论速览`,
          description: "无需打断手头节奏，我先完成信息采集与风险排查，只把需要你拍板的选项呈给你。",
          seedPrompt: `${found.seedPrompt}（请先给出核心结论与待拍板选项速览）`,
          reason: `基于你偏好的点子方向「${truncateCodepoints(found.title, 18)}」生成`,
        },
  ];
  return { generated: upsertPersonalizedIdeas(st, fallbackDrafts) };
}

export function restoreDismissedIdeaRecord(st: PersistedBotState, id: string): boolean {
  const cleanId = id.trim();
  const before = st.dismissedIdeaIds ?? [];
  const next = before.filter((item) => item !== cleanId);
  st.dismissedIdeaIds = next;
  reconcileBotDiscoveryState(st);
  return next.length !== before.length;
}

export async function refreshPersonalizedIdeas(options: {
  ctx?: Context; st: PersistedBotState; sessions: Sessions; model?: ModelRef;
}): Promise<BotIdeaItem[]> {
  const { ctx, st, sessions, model } = options;
  reconcileIdeaSectionsInState(st);
  const mainSess = await sessions.get(st.mainSessionId).catch(() => undefined);
  const chatSnippets = (mainSess?.state().messages ?? []).slice(-6).flatMap((m) => {
    if (m.role !== "user" && m.role !== "assistant") return [];
    const txt = stripThinkAndConnectorNoise(m.content.flatMap((b) => (b.type === "text" ? [b.text] : [])).join(" "), m.role === "user");
    return txt !== "" ? [`${m.role === "user" ? "用户" : "分身"}: ${truncateCodepoints(txt, 120)}`] : [];
  });
  const recentThreads = st.sideThreads.filter((t) => !t.archived).slice(0, 3).map((t) => `${t.title}${t.snippet ? `（${truncateCodepoints(t.snippet, 50)}）` : ""}`);
  const activeGoals = st.goals.filter((g) => g.status === "active").slice(0, 4);
  const recentInbox = st.inboxItems.slice(0, 3);
  const spaces = st.spaces.slice(0, 3);
  const prefs = st.learnedPreferences.slice(0, 8);
  if (chatSnippets.length === 0 && recentThreads.length === 0 && activeGoals.length === 0 && recentInbox.length === 0 && spaces.length === 0) return [];

  const existingTitles = st.ideaSections.flatMap((s) => s.items.map((i) => i.title)).join("；");
  const llmDrafts = await synthesizeIdeasViaLlm(
    ctx, model,
    [
      activeGoals.length > 0 ? `活跃目标：\n${activeGoals.map((g) => `- ${g.title}：${g.summary}`).join("\n")}` : "",
      recentInbox.length > 0 ? `近期收件箱：\n${recentInbox.map((m) => `- ${m.sender} | ${m.subject}`).join("\n")}` : "",
      spaces.length > 0 ? `常驻空间：\n${spaces.map((s) => `- ${s.title}：${s.description}`).join("\n")}` : "",
      recentThreads.length > 0 ? `近期旁聊主题：${recentThreads.join("；")}` : "",
      chatSnippets.length > 0 ? `近期主聊天片段：\n${chatSnippets.join("\n")}` : "",
      prefs.length > 0 ? `用户偏好记忆：${prefs.join("；")}` : "",
      `已有点子（请勿重复）：${existingTitles}`,
      "请合成 3 条高度贴合上述真实上下文、以「我可以...」或「给你一份...」开头的点子方案包。",
    ].filter(Boolean).join("\n\n"),
  );
  if (llmDrafts.length > 0) return upsertPersonalizedIdeas(st, llmDrafts.slice(0, 4));

  const fallback: PersonalizedIdeaDraft[] = [];
  if (activeGoals[0]) {
    const g = activeGoals[0];
    fallback.push({
      icon: "🎯", title: `我可以帮你拆解目标「${truncateCodepoints(g.title, 18)}」的下一步子目标与推进节奏`,
      description: `结合当前进展（${truncateCodepoints(g.summary, 42)}），梳理本周优先动作与检查节点。`,
      seedPrompt: `围绕我的目标「${g.title}」（当前进展：${g.summary}），帮我拆解具体的子目标与下一步行动方案。`,
      reason: `基于你的追踪目标「${g.title}」生成`,
    });
  }
  if (recentInbox[0]) {
    const m = recentInbox[0];
    fallback.push({
      icon: "✉", title: `我可以帮你梳理来自 ${m.sender} 的「${truncateCodepoints(m.subject, 18)}」并准备跟进草案`,
      description: "提炼核心诉求与截止时间，如需回复可提前备好草稿放入「批准」栏供你确认。",
      seedPrompt: `帮我查看并梳理 ${m.sender} 发来的「${m.subject}」，总结待办要点并拟定跟进建议。`,
      reason: `结合收件箱中 ${m.sender} 的近期消息生成`,
    });
  }
  if (spaces[0]) {
    const s = spaces[0];
    fallback.push({
      icon: "❖", title: `给你一份常驻空间「${truncateCodepoints(s.title, 18)}」的最新阶段性摘要`,
      description: `汇总「${truncateCodepoints(s.description, 44)}」的关键进展与待决策事项。`,
      seedPrompt: `帮我盘点常驻空间「${s.title}」的最新进展，并列出需要我拍板的下一步事项。`,
      reason: `结合你的常驻空间「${s.title}」生成`,
    });
  }
  if (fallback.length < 2 && (recentThreads[0] || chatSnippets[0])) {
    const rawTopic = recentThreads[0]?.split("（")[0] ?? chatSnippets.at(-1)?.replace(/^(?:用户|分身):\s*/, "") ?? "";
    const topic = truncateCodepoints(rawTopic, 18);
    if (topic !== "") {
      fallback.push({
        icon: "✦", title: `我可以围绕近期聊到的「${topic}」整理一份可执行跟进清单`,
        description: "把零散讨论归纳成结构化行动项、参考结论与后续检查点。",
        seedPrompt: `结合我们近期关于「${topic}」的讨论，帮我整理一份结构化的下一步行动清单。`,
        reason: `结合你近期的对话主题「${topic}」生成`,
      });
    }
  }
  return upsertPersonalizedIdeas(st, fallback.slice(0, 4));
}

export function launchIdeaRecord(options: {
  st: PersistedBotState; botWorkspaceDir: string; id: string; scheduleSvc?: Schedule;
}): IdeaLaunchOutcome {
  const { st, botWorkspaceDir, id, scheduleSvc } = options;
  reconcileIdeaSectionsInState(st);
  const found = st.ideaSections.flatMap((s) => s.items).find((it) => it.id === id);
  if (found === undefined) return { idea: null, launchPrompt: "" };

  let createdSpaceId: string | undefined;
  let createdScheduleId: string | undefined;
  let createdDocId: string | undefined;
  const provisionedNotes: string[] = [];

  for (const cap of found.capabilities ?? []) {
    cap.ready = true;
    if (cap.kind === "space") {
      const spaceTitle = (cap.spacePreset?.title || cap.title).trim() || found.title;
      const spaceDesc = (cap.spacePreset?.description || cap.subtitle || found.description).trim();
      const existing = st.spaces.find((s) => s.title.trim().toLowerCase() === spaceTitle.toLowerCase());
      const space = existing ?? createSpaceRecord(st, botWorkspaceDir, spaceTitle, spaceDesc);
      createdSpaceId = space.id;
      provisionedNotes.push(`常驻空间「${space.title}」（id=${space.id}）`);
    } else if (cap.kind === "schedule" && scheduleSvc !== undefined) {
      const preset = cap.schedulePreset ?? { name: truncateCodepoints(cap.title || found.title, 24), prompt: found.seedPrompt, frequency: "daily" as const, hour: 9, minute: 0 };
      const existingTask = scheduleSvc.list().find(
        (t) => (t.scope === "bot" || t.cwd === botWorkspaceDir) && t.name.trim().toLowerCase() === preset.name.trim().toLowerCase(),
      );
      const saved = existingTask
        ? scheduleSvc.save({ ...existingTask, scope: "bot", cwd: botWorkspaceDir, enabled: true })
        : scheduleSvc.save({
            name: preset.name, prompt: preset.prompt, cwd: botWorkspaceDir, scope: "bot", frequency: preset.frequency,
            ...(typeof preset.intervalMinutes === "number" ? { intervalMinutes: preset.intervalMinutes } : {}),
            hour: typeof preset.hour === "number" ? preset.hour : 9,
            minute: typeof preset.minute === "number" ? preset.minute : 0,
            weekday: typeof preset.weekday === "number" ? preset.weekday : 1,
            permissionMode: "ask", ...(st.modelConfig?.primary ? { model: st.modelConfig.primary } : {}), enabled: true,
          });
      createdScheduleId = saved.id;
      provisionedNotes.push(`定期任务「${saved.name}」（id=${saved.id}）`);
    } else if (cap.kind === "doc") {
      const fileName = slugifyDocFileName(cap.docPreset?.name || `idea-${found.id}`);
      const docSummary = cap.docPreset?.summary || cap.subtitle || found.description;
      const md = `# ${cap.title || found.title}\n\n> ${docSummary}\n\n## 方案目标\n${found.description}\n\n## 执行与核查步骤\n${found.howItWorks ?? found.seedPrompt}\n\n## 进展与待确认结论\n- 已由千机点子方案包初始化归档，正在推进具体核查。\n`;
      writeFileAtomic(join(botWorkspaceDir, "docs", fileName), md);
      createdDocId = `doc:docs/${fileName}`;
      provisionedNotes.push(`资源库文档「docs/${fileName}」`);
    }
  }

  found.buildStatus = "installed";
  appendActivityRecord(st, {
    title: `启动点子方案包：${truncateCodepoints(found.title, 22)}`,
    description: provisionedNotes.length > 0 ? `已就绪：${provisionedNotes.join("、")}` : found.description,
  });

  const launchPrompt = [
    found.seedPrompt,
    provisionedNotes.length > 0 ? `\n[系统已自动装配方案包组件：${provisionedNotes.join("；")}]` : "",
    found.howItWorks ? `请严格按照以下「如何运作」方案分步推进，并在需要我拍板处提供快捷确认选项：${found.howItWorks}` : "",
  ].filter((s) => s !== "").join("\n");

  return {
    idea: { ...found }, ...(createdSpaceId !== undefined ? { createdSpaceId } : {}),
    ...(createdScheduleId !== undefined ? { createdScheduleId } : {}), ...(createdDocId !== undefined ? { createdDocId } : {}), launchPrompt,
  };
}

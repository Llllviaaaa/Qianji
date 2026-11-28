/**
 * Proactive Heartbeat Patrol, Edition Fallback & Tiered Caring Delivery Engine
 * (`packages/host/src/bot/harness/bot-proactive-pulse.ts`).
 */
import { randomUUID } from "node:crypto";
import type { Context } from "@deepseek-ai/cordis";
import { BlockAssembler } from "@qianji/llm";
import type {
  BotDesktopNotificationPayload,
  BotFeedActionKind,
  BotFeedMetricRow,
  BotFeedMetricsCard,
  BotPacingConfig,
} from "@qianji/protocol";
import type { ModelRef, Session } from "@qianji/session";
import type { ConnectorDelta } from "../connectors/connector-hub.ts";
import {
  buildDefaultPacingConfig,
  DEFAULT_FEED_INSTRUCTIONS,
  formatClock,
  type PersistedBotState,
} from "../defaults.ts";
import { appendActivityRecord, createRichFeedRecord, createRichGoalRecord } from "../store-discovery.ts";
import { upsertPersonalizedIdeas, type PersonalizedIdeaDraft } from "../store-ideas.ts";
import { generateFeedEditionForState } from "./bot-feed-edition.ts";

const SYNTHETIC_BOT_MODEL = { provider: "qianji", model: "bot-companion" };
const ZERO_USAGE = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };

function parseHmMinutes(hhmm: string, fallbackMins: number): number {
  const m = /^(\d{1,2}):(\d{2})$/.exec(hhmm.trim());
  if (!m) return fallbackMins;
  return Math.min(23, Number(m[1])) * 60 + Math.min(59, Number(m[2]));
}

export function isWithinQuietHours(pacing: BotPacingConfig, nowMs = Date.now()): boolean {
  if (!pacing.quietHoursEnabled) return false;
  const d = new Date(nowMs);
  const curMins = d.getHours() * 60 + d.getMinutes();
  const start = parseHmMinutes(pacing.quietHoursStart, 23 * 60);
  const end = parseHmMinutes(pacing.quietHoursEnd, 8 * 60);
  if (start === end) return false;
  return start > end ? curMins >= start || curMins < end : curMins >= start && curMins < end;
}

export interface PatrolRunResult {
  triggered: boolean;
  suppressedByFocus: boolean;
  summary: string;
  queuedApprovals: number;
}

export interface ProactivePulseHost {
  ctx: Context;
  botWorkspaceDir: string;
  ensureLoaded(): Promise<PersistedBotState>;
  persist(): void;
  collectDelta(nowMs?: number): Promise<ConnectorDelta>;
  readMemory?(): string;
  fetchFn?: typeof fetch;
  stageOutboundDraft(input: {
    kind: "send-email" | "send-telegram" | "send-feishu" | "send-slack" | "github-comment" | "notion-page" | "trigger-webhook" | "shell";
    title: string;
    summary: string;
    recipient?: string;
    subject?: string;
    draftBody?: string;
  }): Promise<string>;
}

async function synthesizeWithLlm(
  ctx: Context,
  model: ModelRef,
  prompt: string,
  systemPrompt = "你是千机贴身个人分身。请用简洁温暖、直接给结论与行动建议的中文写出一条主动汇报，不要讲空话套话。",
): Promise<string | null> {
  const llm = ctx.get("llm");
  if (!llm) return null;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 20_000);
  try {
    const assembler = new BlockAssembler();
    for await (const chunk of llm.stream(
      {
        provider: model.provider,
        model: model.model,
        sessionId: "bot-patrol-synth",
        system: systemPrompt,
        messages: [{ role: "user", content: [{ type: "text", text: prompt }] }],
      },
      controller.signal,
    )) {
      assembler.push(chunk);
    }
    const text = assembler.result().message.content
      .flatMap((b) => (b.type === "text" ? [b.text] : []))
      .join("\n")
      .trim();
    return text || null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

function buildPatrolMetricsCard(st: PersistedBotState, delta: ConnectorDelta, queuedApprovals: number): BotFeedMetricsCard | undefined {
  const rows: BotFeedMetricRow[] = [];
  if (delta.newEmails.length > 0 || st.inboxItems.length > 0) {
    rows.push({
      label: "收件箱与外联",
      sublabel: delta.newEmails[0]?.subject.slice(0, 24) ?? "累计同步信件",
      ...(queuedApprovals > 0 ? { badge: `${queuedApprovals} 待批草稿`, highlight: true } : {}),
      value: delta.newEmails.length > 0 ? `+${delta.newEmails.length} 封` : `${st.inboxItems.length} 条`,
    });
  }
  if (delta.awareness.todayEvents.length > 0 || delta.conflicts.length > 0) {
    rows.push({
      label: "今日日程与会务",
      sublabel: delta.upcomingMeetings[0]?.title ?? delta.awareness.nextMeetingLabel ?? "日程排期",
      ...(delta.conflicts.length > 0 ? { badge: `${delta.conflicts.length} 处冲突`, highlight: true } : {}),
      value: `${delta.awareness.todayEvents.length} 项`,
    });
  }
  if (delta.completedProcesses.length > 0 || delta.awareness.runningWatched.length > 0) {
    rows.push({
      label: "盯守进程与长任务",
      sublabel: delta.completedProcesses[0] ?? delta.awareness.runningWatched[0] ?? "后台任务",
      ...(delta.completedProcesses.length > 0 ? { badge: "已结束", highlight: true } : {}),
      value: delta.completedProcesses.length > 0 ? `${delta.completedProcesses.length} 项完成` : `${delta.awareness.runningWatched.length} 项运行中`,
    });
  }
  if (delta.newGitHubItems.length > 0) {
    rows.push({
      label: "GitHub 仓库动态",
      sublabel: `${delta.newGitHubItems[0]?.repo ?? ""} #${delta.newGitHubItems[0]?.number ?? ""}`.trim(),
      value: `+${delta.newGitHubItems.length} 项`,
    });
  }
  return rows.length > 0 ? { title: "实时巡检概览", rows } : undefined;
}

function buildPatrolIdeas(delta: ConnectorDelta): PersonalizedIdeaDraft[] {
  const drafts: PersonalizedIdeaDraft[] = [];
  const firstMail = delta.newEmails[0];
  if (firstMail !== undefined) {
    drafts.push({
      icon: "✉",
      title: `我可以帮你批量梳理并跟进「${firstMail.subject.slice(0, 18)}」等最新收件箱事项`,
      description: `针对来自 ${firstMail.sender} 的新邮件及待办诉求，提炼截止节点并核对回复草稿。`,
      seedPrompt: `帮我梳理最新来自 ${firstMail.sender} 的邮件「${firstMail.subject}」并推进后续跟进事项。`,
      sourceLabel: "收件箱行动方案",
      reason: `基于巡检发现 ${firstMail.sender} 发来的新邮件自动生成`,
    });
  }
  const firstConflict = delta.conflicts[0];
  if (firstConflict !== undefined) {
    drafts.push({
      icon: "📅",
      title: `我可以帮你协调「${firstConflict.first.slice(0, 14)}」与「${firstConflict.second.slice(0, 14)}」的日程冲突`,
      description: `结合今日可用空档（${delta.freeBlocks[0] ? `${delta.freeBlocks[0].startLabel}-${delta.freeBlocks[0].endLabel}` : "空闲窗口"}）拟定改期建议与沟通说明。`,
      seedPrompt: `帮我规划如何调整今日冲突日程「${firstConflict.first}」与「${firstConflict.second}」，并准备改期沟通文案。`,
      sourceLabel: "会务协调方案",
      reason: "基于巡检发现的今日日程冲突预警自动生成",
    });
  }
  const firstGh = delta.newGitHubItems[0];
  if (firstGh !== undefined && drafts.length < 2) {
    drafts.push({
      icon: "⑂",
      title: `我可以帮你审阅 ${firstGh.repo} #${firstGh.number}「${firstGh.title.slice(0, 16)}」`,
      description: "快速归纳问题背景、影响范围与可执行的处理建议。",
      seedPrompt: `帮我查看并分析 GitHub ${firstGh.repo} #${firstGh.number}（${firstGh.title}）的重点与下一步行动。`,
      sourceLabel: "仓库审阅方案",
      reason: `基于 GitHub 仓库 ${firstGh.repo} 最新动态自动生成`,
    });
  }
  return drafts;
}

function buildQuickOptionsTag(delta: ConnectorDelta, queuedApprovals: number): string {
  if (queuedApprovals > 0) return "[[options: 好，帮我核对并发出 | 稍后再看]]";
  if (delta.conflicts.length > 0) return "[[options: 好，帮我协调改期 | 我自己调整]]";
  if (delta.upcomingMeetings.length > 0) return "[[options: 帮我准备参会提纲 | 知道了]]";
  return "[[options: 好，帮我处理 | 稍后再看]]";
}

export class ProactivePulseEngine {
  private timer: ReturnType<typeof setInterval> | null = null;
  private lastPatrolAt = 0;
  private running = false;

  constructor(private readonly host: ProactivePulseHost) {}

  start(): void {
    if (this.timer !== null) return;
    this.timer = setInterval(() => {
      void this.tick();
    }, 60_000);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  private async tick(): Promise<void> {
    const st = await this.host.ensureLoaded().catch(() => null);
    if (!st) return;
    const pacing = st.pacing ?? buildDefaultPacingConfig();
    if (!pacing.heartbeatEnabled) return;
    const intervalMs = Math.max(1, pacing.heartbeatIntervalMinutes) * 60_000;
    if (Date.now() - this.lastPatrolAt < intervalMs) return;
    await this.runPatrol({ force: false });
  }

  async runPatrol(options: { force?: boolean; nowMs?: number } = {}): Promise<PatrolRunResult> {
    if (this.running) {
      return { triggered: false, suppressedByFocus: false, summary: "巡检正在运行中", queuedApprovals: 0 };
    }
    this.running = true;
    const nowMs = options.nowMs ?? Date.now();
    this.lastPatrolAt = nowMs;

    try {
      const st = await this.host.ensureLoaded();
      const pacing = st.pacing ?? buildDefaultPacingConfig();
      const quietHours = isWithinQuietHours(pacing, nowMs);
      const delta = await this.host.collectDelta(nowMs);
      if (quietHours && delta.awareness.busyState === "normal") {
        delta.awareness.busyState = "quiet-hours";
        st.awareness = delta.awareness;
      }

      const hasConcreteDelta =
        delta.newEmails.length > 0 ||
        delta.upcomingMeetings.length > 0 ||
        delta.conflicts.length > 0 ||
        delta.completedProcesses.length > 0 ||
        delta.newMeetingNotes.length > 0 ||
        delta.newTelegramMsgs.length > 0 ||
        delta.newGitHubItems.length > 0 ||
        delta.newNotionPages.length > 0;
      const hasActionable = hasConcreteDelta || delta.lateNightReminderNeeded;

      if (!hasActionable && !options.force) {
        st.awareness = { ...delta.awareness, lastPatrolAt: nowMs, lastPatrolSummary: "一切平稳，保持静默" };
        this.host.persist();
        return { triggered: false, suppressedByFocus: false, summary: "一切平稳，保持静默", queuedApprovals: 0 };
      }

      if (!hasConcreteDelta && options.force) {
        const editionItems = await generateFeedEditionForState({
          st,
          ctx: this.host.ctx,
          memoryMarkdown: this.host.readMemory?.(),
          model: st.modelConfig?.patrol ?? st.modelConfig?.primary,
          force: true,
          fetchFn: this.host.fetchFn,
          nowMs,
        });
        const editionSummary = editionItems[0]?.body ?? "已为你编发最新一期个性化动态刊次";
        st.awareness = {
          ...delta.awareness,
          lastPatrolAt: nowMs,
          lastPatrolSummary: editionItems[0]?.title ?? "已编发个性化动态刊次",
        };
        this.host.persist();
        this.host.ctx.get("rpc")?.broadcast("bot/updated", { reason: "patrol-completed", ts: nowMs });
        return { triggered: true, suppressedByFocus: false, summary: editionSummary, queuedApprovals: 0 };
      }

      const summaryParts: string[] = [];
      let queuedApprovals = 0;

      for (const mail of delta.newEmails.slice(0, 3)) {
        summaryParts.push(`新邮件来自 ${mail.sender}：「${mail.subject}」——${mail.preview.slice(0, 90)}`);
        if (
          st.connectorConfigs?.email.permission !== "read-only" &&
          mail.replyTo &&
          !/noreply|no-reply|notification|mailer-daemon/i.test(mail.replyTo)
        ) {
          const model = st.modelConfig?.patrol ?? st.modelConfig?.primary;
          const draftPrompt = `发件人: ${mail.sender}\n主题: ${mail.subject}\n正文: ${mail.fullBody.slice(0, 800)}\n请帮用户直接起草一封礼貌简洁的中文回复邮件正文（只输出正文，不要称呼多余解释）：`;
          const aiDraft = model
            ? await synthesizeWithLlm(
                this.host.ctx,
                model,
                draftPrompt,
                "你是千机贴身个人分身，正在代用户起草礼貌、专业、得体的中文邮件回复草稿。只输出邮件正文，不要包含任何多余解释或标题。",
              )
            : null;
          const draftBody = aiDraft || `您好，\n\n已收到关于「${mail.subject}」的来信，我这边会尽快核实相关细节并跟进处理，如有进一步进展第一时间同步您。\n\n祝好`;
          await this.host.stageOutboundDraft({
            kind: "send-email",
            title: `回复邮件：${mail.subject.slice(0, 36)}`,
            summary: `收到 ${mail.sender} 来信，已按你的沟通风格拟好回复草稿，确认即可直接发出。`,
            recipient: mail.replyTo,
            subject: mail.subject.startsWith("Re:") ? mail.subject : `Re: ${mail.subject}`,
            draftBody,
          });
          queuedApprovals += 1;
        }
      }

      for (const ev of delta.upcomingMeetings) {
        summaryParts.push(`即将开始日程：「${ev.title}」（${ev.timeRangeLabel}${ev.location ? ` · ${ev.location}` : ""}），请准备参会`);
      }
      for (const c of delta.conflicts) {
        const freeHint = delta.freeBlocks[0] ? `，建议将其中一项调至 ${delta.freeBlocks[0].startLabel}–${delta.freeBlocks[0].endLabel} 空档` : "";
        summaryParts.push(`日程冲突提醒：「${c.first}」与「${c.second}」在 ${c.overlapLabel} 重叠${freeHint}`);
      }
      for (const proc of delta.completedProcesses) {
        summaryParts.push(`盯守任务「${proc}」已运行结束，请查看产物或日志确认结果`);
      }
      for (const note of delta.newMeetingNotes.slice(0, 2)) {
        summaryParts.push(`发现新会议记录「${note.fileName}」，已为你梳理行动要点`);
        const firstTodoLine = note.excerpt.split(/\r?\n/).find((l) => /待办|跟进|TODO|Action|完成|准备/i.test(l)) ?? `跟进会议「${note.fileName}」约定事项`;
        if (!st.goals.some((g) => g.title.includes(note.fileName))) {
          createRichGoalRecord(st, this.host.botWorkspaceDir, {
            title: firstTodoLine.replace(/^[-*•\d.\s]+/, "").slice(0, 48),
            category: "会议跟进",
            summary: `已从会议纪要「${note.fileName}」提炼行动节点，等待按期推进确认`,
            description: note.excerpt.slice(0, 240),
            source: "assistant_tracking",
            momentumStatus: "on_track",
          });
        }
      }
      for (const tg of delta.newTelegramMsgs.slice(0, 3)) {
        summaryParts.push(`Telegram 来自 ${tg.sender}：「${tg.text.slice(0, 90)}」`);
      }
      for (const gh of delta.newGitHubItems.slice(0, 3)) {
        summaryParts.push(`GitHub ${gh.repo} #${gh.number} (${gh.isPullRequest ? "PR" : "Issue"}): ${gh.title}`);
      }
      for (const pg of delta.newNotionPages.slice(0, 3)) {
        summaryParts.push(`Notion 最近更新：「${pg.title}」`);
      }
      if (delta.lateNightReminderNeeded) {
        summaryParts.push("已是深夜时段，注意保护用眼与作息，剩余收尾工作我可以帮你记入明日早报继续推进");
      }

      const fallbackMessage = [
        `[${formatClock(nowMs)} 贴心巡检汇报]`,
        ...summaryParts.map((p, idx) => `${idx + 1}. ${p}`),
        queuedApprovals > 0 ? `\n已为你准备好 ${queuedApprovals} 份回复草稿放入右侧「批准」栏，核对无误后点一下即可发出。` : "",
      ].filter(Boolean).join("\n");

      const feedInstructions = st.feedInstructions ?? DEFAULT_FEED_INSTRUCTIONS;
      const recentPrefs = st.learnedPreferences.slice(0, 8);
      const model = st.modelConfig?.patrol ?? st.modelConfig?.primary;
      const synthSystem = [
        "你是千机贴身个人分身。请严格遵循用户的「动态版块指示」与偏好记忆，用简洁温暖、直接给结论与行动建议的中文写出一条主动汇报，不要讲空话套话。",
        `动态版块指示：${feedInstructions}`,
        recentPrefs.length > 0 ? `近期偏好记忆：${recentPrefs.join("；")}` : "",
      ].filter(Boolean).join("\n");
      const synthUser = [
        `动态版块指示：${feedInstructions}`,
        recentPrefs.length > 0 ? `用户偏好：${recentPrefs.join("；")}` : "",
        `真实巡检结果（已备好 ${queuedApprovals} 份待批草稿）：\n${summaryParts.join("\n")}`,
      ].filter(Boolean).join("\n\n");

      const renderedBrief = model
        ? (await synthesizeWithLlm(this.host.ctx, model, synthUser, synthSystem)) ?? fallbackMessage
        : fallbackMessage;

      const urgent = delta.upcomingMeetings.length > 0 || delta.completedProcesses.length > 0;
      const inFocusSuppression = !options.force && (quietHours || delta.awareness.busyState === "in-meeting") && !urgent;
      const actionKind: BotFeedActionKind =
        queuedApprovals > 0 || delta.upcomingMeetings.length > 0 || delta.conflicts.length > 0 || delta.newEmails.length > 0
          ? "start"
          : "discuss";
      const reasonTags = [
        delta.newEmails.length > 0 ? "邮件" : "",
        delta.upcomingMeetings.length > 0 || delta.conflicts.length > 0 ? "日程" : "",
        delta.completedProcesses.length > 0 ? "进程变动" : "",
        delta.newGitHubItems.length > 0 ? "GitHub" : "",
      ].filter(Boolean);
      const metricsCard = summaryParts.length >= 2 ? buildPatrolMetricsCard(st, delta, queuedApprovals) : undefined;
      const addedPatrolIdeas =
        delta.newEmails.length > 0 || delta.newGitHubItems.length > 0 || delta.conflicts.length > 0
          ? upsertPersonalizedIdeas(st, buildPatrolIdeas(delta))
          : [];

      createRichFeedRecord(st, {
        title: urgent ? "紧急日程与任务提醒" : "贴心主动巡检简报",
        kicker: urgent ? "紧急提醒" : "实时脉搏",
        category: "贴心巡检",
        editionKind: "adhoc",
        origin: actionKind === "start" ? "idea" : "generated",
        ...(addedPatrolIdeas[0] ? { ideaId: addedPatrolIdeas[0].id } : {}),
        body: renderedBrief,
        actionKind,
        seedPrompt: actionKind === "start" ? "帮我立即处理刚才巡检简报里的待办与草稿事项" : "针对刚刚的巡检简报，帮我细化下一步安排",
        icon: urgent ? "⚡" : delta.newEmails.length > 0 ? "✉" : delta.conflicts.length > 0 ? "📅" : "✦",
        reason: reasonTags.length > 0 ? `基于你的巡检指示与实时感知生成（${reasonTags.join("/")}）` : "基于你的动态版块指示与定时巡检生成",
        ...(metricsCard !== undefined ? { metricsCard } : {}),
      });

      const patrolTitle = inFocusSuppression ? "专注期静默收纳巡检动态" : "完成主动贴心巡检与规划建议";
      const patrolDesc = summaryParts[0] ?? "巡检完毕";
      const existingQuietPatrol = inFocusSuppression
        ? st.activityGroups
            .find((g) => g.date === "今天")
            ?.items.find((it) => it.title === "专注期静默收纳巡检动态")
        : undefined;
      if (existingQuietPatrol !== undefined) {
        existingQuietPatrol.description = patrolDesc;
        existingQuietPatrol.subtitle = patrolDesc;
        existingQuietPatrol.timeLabel = formatClock(nowMs);
        existingQuietPatrol.createdAt = nowMs;
      } else {
        appendActivityRecord(st, {
          title: patrolTitle,
          description: patrolDesc,
          kind: "patrol",
          finishMessage: renderedBrief,
        });
      }
      st.awareness = { ...delta.awareness, lastPatrolAt: nowMs, lastPatrolSummary: patrolDesc };

      const mainSession: Session | undefined = await this.host.ctx.sessions.get(st.mainSessionId).catch(() => undefined);
      if (mainSession !== undefined && !inFocusSuppression) {
        const bubbleText = /\[\[options:\s*.+?\]\]/.test(renderedBrief)
          ? renderedBrief
          : `${renderedBrief}\n\n${buildQuickOptionsTag(delta, queuedApprovals)}`;
        mainSession.append("assistant", {
          content: [{ type: "text", text: bubbleText }],
          model: model ?? SYNTHETIC_BOT_MODEL,
          usage: ZERO_USAGE,
          stop: "stop",
        });
      }

      this.host.persist();
      this.host.ctx.get("rpc")?.broadcast("bot/updated", { reason: "patrol-completed", ts: nowMs });

      if (!inFocusSuppression && (urgent || hasActionable || options.force)) {
        const notif: BotDesktopNotificationPayload = {
          id: `notif-${randomUUID().slice(0, 8)}`,
          title: urgent ? "千机贴心紧急提醒" : "千机分身主动规划建议",
          body: summaryParts[0] ?? renderedBrief.slice(0, 120),
          urgency: urgent ? "urgent" : "normal",
          createdAt: nowMs,
        };
        this.host.ctx.get("rpc")?.broadcast("bot/desktopNotification", notif);
      }

      return { triggered: true, suppressedByFocus: inFocusSuppression, summary: renderedBrief, queuedApprovals };
    } finally {
      this.running = false;
    }
  }
}

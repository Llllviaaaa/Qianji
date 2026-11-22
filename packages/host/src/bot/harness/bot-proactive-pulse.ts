/**
 * Proactive Heartbeat Patrol & Tiered Caring Delivery Engine
 * (`packages/host/src/bot/harness/bot-proactive-pulse.ts`).
 */
import { randomUUID } from "node:crypto";
import type { Context } from "@deepseek-ai/cordis";
import { BlockAssembler } from "@qianji/llm";
import type { BotDesktopNotificationPayload, BotPacingConfig } from "@qianji/protocol";
import type { ModelRef, Session } from "@qianji/session";
import type { ConnectorDelta } from "../connectors/connector-hub.ts";
import { buildDefaultPacingConfig, formatClock, type PersistedBotState } from "../defaults.ts";
import { appendActivityRecord, createFeedRecord, createGoalRecord } from "../store-actions.ts";

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
  stageOutboundDraft(input: {
    kind: "send-email" | "send-telegram" | "send-feishu" | "shell";
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

      const hasActionable =
        delta.newEmails.length > 0 ||
        delta.upcomingMeetings.length > 0 ||
        delta.conflicts.length > 0 ||
        delta.completedProcesses.length > 0 ||
        delta.newMeetingNotes.length > 0 ||
        delta.newTelegramMsgs.length > 0 ||
        delta.lateNightReminderNeeded;

      if (!hasActionable && !options.force) {
        st.awareness = { ...delta.awareness, lastPatrolAt: nowMs, lastPatrolSummary: "一切平稳，保持静默" };
        this.host.persist();
        return { triggered: false, suppressedByFocus: false, summary: "一切平稳，保持静默", queuedApprovals: 0 };
      }

      const summaryParts: string[] = [];
      let queuedApprovals = 0;

      for (const mail of delta.newEmails.slice(0, 3)) {
        summaryParts.push(`新邮件来自 ${mail.sender}：「${mail.subject}」——${mail.preview.slice(0, 90)}`);
        if (mail.replyTo && !/noreply|no-reply|notification|mailer-daemon/i.test(mail.replyTo)) {
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
          createGoalRecord(st, this.host.botWorkspaceDir, firstTodoLine.replace(/^[-*•\d.\s]+/, "").slice(0, 48), "会议跟进");
        }
      }

      for (const tg of delta.newTelegramMsgs.slice(0, 3)) {
        summaryParts.push(`Telegram 来自 ${tg.sender}：「${tg.text.slice(0, 90)}」`);
      }

      if (delta.lateNightReminderNeeded) {
        summaryParts.push("已是深夜时段，注意保护用眼与作息，剩余收尾工作我可以帮你记入明日早报继续推进");
      }

      if (summaryParts.length === 0) {
        summaryParts.push(
          `已完成全盘巡检：当前工作状态为「${delta.awareness.busyState}」，今日日程 ${delta.awareness.todayEvents.length} 项（冲突 ${delta.awareness.conflictCount} 处），收件箱共 ${st.inboxItems.length} 条记录。`,
        );
      }

      const fallbackMessage = [
        `[${formatClock(nowMs)} 贴心巡检汇报]`,
        ...summaryParts.map((p, idx) => `${idx + 1}. ${p}`),
        queuedApprovals > 0 ? `\n已为你准备好 ${queuedApprovals} 份回复草稿放入右侧「批准」栏，核对无误后点一下即可发出。` : "",
      ].filter(Boolean).join("\n");

      const model = st.modelConfig?.patrol ?? st.modelConfig?.primary;
      const renderedBrief = hasActionable && model
        ? (await synthesizeWithLlm(this.host.ctx, model, `根据以下真实巡检结果，生成一段简洁贴心的主动汇报给用户，并提示已拟好 ${queuedApprovals} 份草稿（若有）：\n${summaryParts.join("\n")}`)) ?? fallbackMessage
        : fallbackMessage;

      const urgent = delta.upcomingMeetings.length > 0 || delta.completedProcesses.length > 0;
      const inFocusSuppression = !options.force && (quietHours || delta.awareness.busyState === "in-meeting") && !urgent;

      createFeedRecord(st, urgent ? "紧急日程与任务提醒" : "贴心主动巡检简报", renderedBrief, "针对刚刚的巡检简报，帮我细化下一步安排");
      appendActivityRecord(st, {
        title: inFocusSuppression ? "专注期静默收纳巡检动态" : "完成主动贴心巡检与规划建议",
        description: summaryParts[0] ?? "巡检完毕",
      });

      st.awareness = {
        ...delta.awareness,
        lastPatrolAt: nowMs,
        lastPatrolSummary: summaryParts[0] ?? "巡检完毕",
      };

      const mainSession: Session | undefined = await this.host.ctx.sessions.get(st.mainSessionId).catch(() => undefined);
      if (mainSession !== undefined && !inFocusSuppression) {
        mainSession.append("assistant", {
          content: [{ type: "text", text: renderedBrief }],
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

      return {
        triggered: true,
        suppressedByFocus: inFocusSuppression,
        summary: renderedBrief,
        queuedApprovals,
      };
    } finally {
      this.running = false;
    }
  }
}
/**
 * Coordinates the 4 real Bot connectors (Email IMAP/SMTP, ICS Calendar, Process Sensor,
 * Meeting Notes & Telegram/Feishu IM) and executes approved outbound actions.
 */
import type {
  BotCalendarEventSummary,
  BotInboxItem,
  BotLiveAwarenessSummary,
  PendingBotApproval,
} from "@qianji/protocol";
import { buildDefaultAwareness, buildDefaultConnectorsConfig, formatClock, type PersistedBotState } from "../defaults.ts";
import { syncCalendarEvents } from "./calendar-connector.ts";
import { fetchRecentEmails, sendSmtpEmail, type FetchedEmail } from "./email-connector.ts";
import {
  pollTelegramUpdates,
  scanMeetingNotes,
  sendFeishuWebhook,
  sendTelegramMessage,
  type MeetingNoteEntry,
  type TelegramMessageEntry,
} from "./meetings-and-im.ts";
import { ProcessSensor, type ProcessProbeFn } from "./process-sensor.ts";

export interface ConnectorSecrets {
  emailPassword?: string;
  telegramToken?: string;
  feishuWebhook?: string;
}

export interface ConnectorDelta {
  newEmails: FetchedEmail[];
  conflicts: Array<{ first: string; second: string; overlapLabel: string }>;
  upcomingMeetings: BotCalendarEventSummary[];
  freeBlocks: Array<{ startLabel: string; endLabel: string; minutes: number }>;
  completedProcesses: string[];
  newMeetingNotes: MeetingNoteEntry[];
  newTelegramMsgs: TelegramMessageEntry[];
  lateNightReminderNeeded: boolean;
  awareness: BotLiveAwarenessSummary;
}

export class ConnectorHub {
  readonly processSensor: ProcessSensor;
  private readonly seenEmailKeys = new Set<string>();
  private readonly notifiedMeetingIds = new Set<string>();
  private lastMeetingMtimeMs = 0;
  private telegramOffset = 0;
  private lastLateNightCareDate = "";

  constructor(probeFn?: ProcessProbeFn) {
    this.processSensor = new ProcessSensor(probeFn);
  }

  ensureConfig(st: PersistedBotState): void {
    if (!st.connectorConfigs) st.connectorConfigs = buildDefaultConnectorsConfig();
    if (!st.awareness) st.awareness = buildDefaultAwareness();
  }

  private mergeInboxItems(st: PersistedBotState, items: BotInboxItem[]): void {
    if (items.length === 0) return;
    st.inboxEnabled = true;
    const existingIds = new Set(st.inboxItems.map((it) => it.id));
    const fresh = items.filter((it) => !existingIds.has(it.id));
    if (fresh.length > 0) {
      st.inboxItems = [...fresh, ...st.inboxItems].slice(0, 40);
    }
  }

  async collectDelta(
    st: PersistedBotState,
    secrets: ConnectorSecrets,
    nowMs = Date.now(),
  ): Promise<ConnectorDelta> {
    this.ensureConfig(st);
    const cfg = st.connectorConfigs ?? buildDefaultConnectorsConfig();

    const delta: ConnectorDelta = {
      newEmails: [],
      conflicts: [],
      upcomingMeetings: [],
      freeBlocks: [],
      completedProcesses: [],
      newMeetingNotes: [],
      newTelegramMsgs: [],
      lateNightReminderNeeded: false,
      awareness: st.awareness ?? buildDefaultAwareness(),
    };

    const tasks: Array<Promise<void>> = [];

    if (cfg.email.enabled) {
      tasks.push(
        fetchRecentEmails(cfg.email, secrets.emailPassword ?? "", 8)
          .then((fetched) => {
            cfg.email.lastSyncAt = nowMs;
            cfg.email.lastError = undefined;
            const inboxAdded: BotInboxItem[] = [];
            for (const mail of fetched) {
              const key = `${cfg.email.emailAddress}:${mail.uid}`;
              if (!this.seenEmailKeys.has(key)) {
                this.seenEmailKeys.add(key);
                delta.newEmails.push(mail);
              }
              inboxAdded.push({
                id: `mail-${key}`,
                source: "email",
                sender: mail.sender,
                subject: mail.subject,
                preview: mail.preview,
                fullBody: mail.fullBody,
                replyTo: mail.replyTo,
                timeLabel: formatClock(mail.receivedAt),
                unread: true,
                createdAt: mail.receivedAt,
              });
            }
            this.mergeInboxItems(st, inboxAdded);
          })
          .catch((err) => {
            cfg.email.lastError = err instanceof Error ? err.message : String(err);
          }),
      );
    }

    if (cfg.calendar.enabled) {
      tasks.push(
        syncCalendarEvents(cfg.calendar, nowMs)
          .then((cal) => {
            cfg.calendar.lastSyncAt = nowMs;
            cfg.calendar.lastError = undefined;
            delta.awareness.todayEvents = cal.todayEvents;
            delta.awareness.conflictCount = cal.conflicts.length;
            delta.conflicts = cal.conflicts;
            delta.freeBlocks = cal.freeBlocks;
            for (const ev of cal.upcomingSoon) {
              if (!this.notifiedMeetingIds.has(ev.id)) {
                this.notifiedMeetingIds.add(ev.id);
                delta.upcomingMeetings.push(ev);
              }
            }
            const nextEv = cal.todayEvents.find((ev) => ev.endAt > nowMs);
            delta.awareness.nextMeetingLabel = nextEv ? `${nextEv.timeRangeLabel} ${nextEv.title}` : undefined;
          })
          .catch((err) => {
            cfg.calendar.lastError = err instanceof Error ? err.message : String(err);
          }),
      );
    }

    if (cfg.processSensor.enabled) {
      tasks.push(
        this.processSensor.sample(cfg.processSensor, nowMs).then((sample) => {
          delta.awareness.busyState = sample.busyState;
          delta.awareness.activeWindowTitle = sample.activeWindowTitle;
          delta.awareness.runningWatched = sample.runningWatched;
          delta.completedProcesses = sample.completedProcesses;
          const todayKey = new Date(nowMs).toDateString();
          if (sample.busyState === "late-night" && this.lastLateNightCareDate !== todayKey) {
            this.lastLateNightCareDate = todayKey;
            delta.lateNightReminderNeeded = true;
          }
        }),
      );
    }

    if (cfg.meetingsIm.meetingNotesEnabled && cfg.meetingsIm.meetingNotesDir.trim() !== "") {
      tasks.push(
        Promise.resolve().then(() => {
          const scanned = scanMeetingNotes(cfg.meetingsIm.meetingNotesDir, this.lastMeetingMtimeMs);
          this.lastMeetingMtimeMs = scanned.maxMtimeMs;
          delta.newMeetingNotes = scanned.notes;
          cfg.meetingsIm.lastSyncAt = nowMs;
        }),
      );
    }

    if (cfg.meetingsIm.telegramEnabled && secrets.telegramToken) {
      tasks.push(
        pollTelegramUpdates(cfg.meetingsIm.telegramApiBase, secrets.telegramToken, this.telegramOffset)
          .then((tg) => {
            cfg.meetingsIm.lastSyncAt = nowMs;
            cfg.meetingsIm.lastError = undefined;
            this.telegramOffset = tg.nextOffset;
            delta.newTelegramMsgs = tg.messages;
            const added = tg.messages.map((m): BotInboxItem => ({
              id: `tg-${m.updateId}`,
              source: "telegram",
              sender: m.sender,
              subject: "Telegram 消息",
              preview: m.text.slice(0, 180),
              fullBody: m.text,
              replyTo: m.chatId,
              timeLabel: formatClock(m.receivedAt),
              unread: true,
              createdAt: m.receivedAt,
            }));
            this.mergeInboxItems(st, added);
          })
          .catch((err) => {
            cfg.meetingsIm.lastError = err instanceof Error ? err.message : String(err);
          }),
      );
    }

    await Promise.all(tasks);
    st.awareness = delta.awareness;
    return delta;
  }

  async testConnector(
    kind: "email" | "calendar" | "processes" | "meetings_im",
    st: PersistedBotState,
    secrets: ConnectorSecrets,
  ): Promise<{ ok: boolean; message: string }> {
    this.ensureConfig(st);
    const cfg = st.connectorConfigs ?? buildDefaultConnectorsConfig();
    if (kind === "email") {
      try {
        const fetched = await fetchRecentEmails(cfg.email, secrets.emailPassword ?? "", 6);
        cfg.email.lastSyncAt = Date.now();
        cfg.email.lastError = undefined;
        await this.collectDelta(st, secrets);
        return { ok: true, message: `IMAP 邮箱连接成功，同步到最近 ${fetched.length} 封邮件` };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        cfg.email.lastError = msg;
        return { ok: false, message: msg };
      }
    }

    if (kind === "calendar") {
      try {
        const res = await syncCalendarEvents(cfg.calendar);
        cfg.calendar.lastSyncAt = Date.now();
        cfg.calendar.lastError = undefined;
        await this.collectDelta(st, secrets);
        return {
          ok: true,
          message: `日历同步成功：今日共 ${res.todayEvents.length} 项日程，检测到 ${res.conflicts.length} 处冲突`,
        };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        cfg.calendar.lastError = msg;
        return { ok: false, message: msg };
      }
    }

    if (kind === "processes") {
      const sample = await this.processSensor.sample(cfg.processSensor);
      st.awareness = {
        ...(st.awareness ?? buildDefaultAwareness()),
        busyState: sample.busyState,
        activeWindowTitle: sample.activeWindowTitle,
        runningWatched: sample.runningWatched,
      };
      return {
        ok: true,
        message: `状态感知就绪：当前状态「${sample.busyState}」，运行中盯守进程 ${sample.runningWatched.length} 个`,
      };
    }

    // meetings_im
    const msgs: string[] = [];
    if (cfg.meetingsIm.meetingNotesEnabled && cfg.meetingsIm.meetingNotesDir.trim() !== "") {
      const notes = scanMeetingNotes(cfg.meetingsIm.meetingNotesDir, 0);
      msgs.push(`扫描纪要文件 ${notes.notes.length} 份`);
    }
    if (cfg.meetingsIm.telegramEnabled) {
      if (!secrets.telegramToken) return { ok: false, message: "请填写 Telegram Bot Token" };
      const tg = await pollTelegramUpdates(cfg.meetingsIm.telegramApiBase, secrets.telegramToken, this.telegramOffset);
      this.telegramOffset = tg.nextOffset;
      msgs.push(`Telegram 收到 ${tg.messages.length} 条新消息`);
    }
    if (cfg.meetingsIm.feishuEnabled) {
      if (!secrets.feishuWebhook) return { ok: false, message: "请填写飞书机器人 Webhook 地址" };
      msgs.push("飞书 Webhook 已保存加密凭据");
    }
    cfg.meetingsIm.lastSyncAt = Date.now();
    cfg.meetingsIm.lastError = undefined;
    return { ok: true, message: msgs.length > 0 ? msgs.join(" · ") : "会议记录与消息渠道配置已保存" };
  }

  async executeApprovedOutbound(
    approval: PendingBotApproval,
    st: PersistedBotState,
    secrets: ConnectorSecrets,
  ): Promise<string> {
    this.ensureConfig(st);
    const cfg = st.connectorConfigs ?? buildDefaultConnectorsConfig();
    if (approval.kind === "send-email") {
      if (!approval.recipient || !approval.draftBody) {
        throw new Error("邮件批准项缺少收件人或正文草稿");
      }
      await sendSmtpEmail(cfg.email, secrets.emailPassword ?? "", {
        to: approval.recipient,
        subject: approval.subject || "Re: 回复",
        body: approval.draftBody,
      });
      return `刚刚 · 已通过 SMTP 发送邮件至 ${approval.recipient}`;
    }

    if (approval.kind === "send-telegram") {
      const chatId = approval.recipient || cfg.meetingsIm.telegramChatId;
      if (!secrets.telegramToken || !chatId || !approval.draftBody) {
        throw new Error("Telegram 发送缺少 Token、Chat ID 或消息正文");
      }
      await sendTelegramMessage(cfg.meetingsIm.telegramApiBase, secrets.telegramToken, chatId, approval.draftBody);
      return `刚刚 · 已发送 Telegram 消息给 ${chatId}`;
    }

    if (approval.kind === "send-feishu") {
      if (!secrets.feishuWebhook || !approval.draftBody) {
        throw new Error("飞书推送缺少加密 Webhook 或消息正文");
      }
      await sendFeishuWebhook(secrets.feishuWebhook, approval.draftBody);
      return "刚刚 · 已通过飞书机器人推送消息";
    }

    return "刚刚 · 已批准执行";
  }
}
/**
 * Coordinates the 4 real Bot connectors (Email IMAP/SMTP, ICS Calendar, Process Sensor,
 * Meeting Notes & Telegram/Feishu IM) and executes approved outbound actions.
 */
import type {
  BotCalendarEventSummary,
  BotConnectorTestKind,
  BotInboxItem,
  BotLiveAwarenessSummary,
  PendingBotApproval,
} from "@qianji/protocol";
import { buildDefaultAwareness, buildDefaultConnectorsConfig, formatClock, type PersistedBotState } from "../defaults.ts";
import { ensureBotWorkspaceDefaults } from "../store-actions.ts";
import { isConnectorWriteAllowed } from "../store-proactive.ts";
import { syncCalendarEvents } from "./calendar-connector.ts";
import {
  dispatchApprovedConnectorAction,
  syncGitHubRepos,
  syncNotionPages,
  type GitHubIssueEntry,
  type NotionPageEntry,
} from "./cloud-connectors.ts";
import { fetchRecentEmails, type FetchedEmail } from "./email-connector.ts";
import {
  pollTelegramUpdates,
  scanMeetingNotes,
  type MeetingNoteEntry,
  type TelegramMessageEntry,
} from "./meetings-and-im.ts";
import { ProcessSensor, type ProcessProbeFn } from "./process-sensor.ts";

export interface ConnectorSecrets {
  emailPassword?: string;
  telegramToken?: string;
  feishuWebhook?: string;
  githubToken?: string;
  notionToken?: string;
  slackWebhook?: string;
  customWebhookToken?: string;
}

export interface ConnectorDelta {
  newEmails: FetchedEmail[];
  conflicts: Array<{ first: string; second: string; overlapLabel: string }>;
  upcomingMeetings: BotCalendarEventSummary[];
  freeBlocks: Array<{ startLabel: string; endLabel: string; minutes: number }>;
  completedProcesses: string[];
  newMeetingNotes: MeetingNoteEntry[];
  newTelegramMsgs: TelegramMessageEntry[];
  newGitHubItems: GitHubIssueEntry[];
  newNotionPages: NotionPageEntry[];
  lateNightReminderNeeded: boolean;
  awareness: BotLiveAwarenessSummary;
}

export class ConnectorHub {
  readonly processSensor: ProcessSensor;
  private readonly seenEmailKeys = new Set<string>();
  private readonly seenGitHubIds = new Set<string>();
  private readonly seenNotionIds = new Set<string>();
  private readonly notifiedMeetingIds = new Set<string>();
  private lastMeetingMtimeMs = 0;
  private telegramOffset = 0;
  private lastLateNightCareDate = "";

  constructor(probeFn?: ProcessProbeFn) {
    this.processSensor = new ProcessSensor(probeFn);
  }

  ensureConfig(st: PersistedBotState): void {
    st.connectorConfigs = ensureBotWorkspaceDefaults(st.connectorConfigs ?? buildDefaultConnectorsConfig());
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
      newGitHubItems: [],
      newNotionPages: [],
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

    if (cfg.github?.enabled && cfg.github.watchedRepos.length > 0) {
      const ghCfg = cfg.github;
      tasks.push(
        syncGitHubRepos(ghCfg, secrets.githubToken)
          .then((gh) => {
            ghCfg.lastSyncAt = nowMs;
            ghCfg.lastError = undefined;
            const added: BotInboxItem[] = [];
            for (const it of gh.items) {
              if (!this.seenGitHubIds.has(it.id)) {
                this.seenGitHubIds.add(it.id);
                delta.newGitHubItems.push(it);
              }
              added.push({
                id: it.id,
                source: "github",
                sender: `${it.repo} · @${it.author}`,
                subject: `${it.isPullRequest ? "PR" : "Issue"} #${it.number}: ${it.title}`,
                preview: it.url,
                fullBody: `${it.title}\n${it.url}`,
                replyTo: `${it.repo}#${it.number}`,
                timeLabel: formatClock(it.updatedAt),
                unread: true,
                createdAt: it.updatedAt,
              });
            }
            this.mergeInboxItems(st, added);
          })
          .catch((err) => {
            ghCfg.lastError = err instanceof Error ? err.message : String(err);
          }),
      );
    }

    if (cfg.notion?.enabled && secrets.notionToken) {
      const notionCfg = cfg.notion;
      const notionToken = secrets.notionToken;
      tasks.push(
        syncNotionPages(notionCfg, notionToken)
          .then((pages) => {
            notionCfg.lastSyncAt = nowMs;
            notionCfg.lastError = undefined;
            const added: BotInboxItem[] = [];
            for (const pg of pages) {
              if (!this.seenNotionIds.has(pg.id)) {
                this.seenNotionIds.add(pg.id);
                delta.newNotionPages.push(pg);
              }
              added.push({
                id: `notion-${pg.id}`,
                source: "notion",
                sender: "Notion",
                subject: pg.title,
                preview: pg.url,
                fullBody: `${pg.title}\n${pg.url}`,
                replyTo: pg.id,
                timeLabel: formatClock(pg.lastEditedAt),
                unread: true,
                createdAt: pg.lastEditedAt,
              });
            }
            this.mergeInboxItems(st, added);
          })
          .catch((err) => {
            notionCfg.lastError = err instanceof Error ? err.message : String(err);
          }),
      );
    }

    await Promise.all(tasks);
    st.awareness = delta.awareness;
    return delta;
  }

  async testConnector(
    kind: BotConnectorTestKind,
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

    if (kind === "github") {
      const gh = cfg.github ?? buildDefaultConnectorsConfig().github;
      if (!gh) return { ok: false, message: "GitHub 配置缺失" };
      try {
        const res = await syncGitHubRepos(gh, secrets.githubToken);
        if (res.discoveredRepos && res.discoveredRepos.length > 0 && gh.watchedRepos.length === 0) {
          gh.watchedRepos = res.discoveredRepos;
        }
        gh.lastSyncAt = Date.now();
        gh.lastError = undefined;
        await this.collectDelta(st, secrets);
        return { ok: true, message: `GitHub 连接成功：同步到 ${res.totalCount} 条开放 Issue/PR` };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        gh.lastError = msg;
        return { ok: false, message: msg };
      }
    }

    if (kind === "notion") {
      const notion = cfg.notion ?? buildDefaultConnectorsConfig().notion;
      if (!notion) return { ok: false, message: "Notion 配置缺失" };
      try {
        const pages = await syncNotionPages(notion, secrets.notionToken ?? "");
        notion.lastSyncAt = Date.now();
        notion.lastError = undefined;
        await this.collectDelta(st, secrets);
        return { ok: true, message: `Notion 连接成功：检索到 ${pages.length} 个最近页面` };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        notion.lastError = msg;
        return { ok: false, message: msg };
      }
    }

    if (kind === "slack") {
      const slack = cfg.slack ?? buildDefaultConnectorsConfig().slack;
      if (!slack || !secrets.slackWebhook) return { ok: false, message: "请填写 Slack Incoming Webhook 地址" };
      slack.lastSyncAt = Date.now();
      slack.lastError = undefined;
      return { ok: true, message: "Slack Webhook 已加密保存，待批准外发就绪" };
    }

    if (kind === "custom_webhook") {
      const wh = cfg.customWebhook ?? buildDefaultConnectorsConfig().customWebhook;
      if (!wh || !/^https?:\/\//i.test(wh.endpointUrl.trim())) {
        return { ok: false, message: "请填写有效的自定义 Webhook HTTPS 地址" };
      }
      wh.lastSyncAt = Date.now();
      wh.lastError = undefined;
      return { ok: true, message: `自动化 Webhook「${wh.label || "自定义"}」配置就绪` };
    }

    if (kind === "meeting_notes") {
      if (cfg.meetingsIm.meetingNotesDir.trim() === "") {
        return { ok: false, message: "请选择或填写会议纪要目录路径" };
      }
      const notes = scanMeetingNotes(cfg.meetingsIm.meetingNotesDir, 0);
      cfg.meetingsIm.lastSyncAt = Date.now();
      cfg.meetingsIm.lastError = undefined;
      return { ok: true, message: `会议纪要目录已就绪，扫描到 ${notes.notes.length} 份纪要文件` };
    }

    if (kind === "telegram") {
      if (!secrets.telegramToken) return { ok: false, message: "请填写 Telegram Bot Token" };
      try {
        const tg = await pollTelegramUpdates(cfg.meetingsIm.telegramApiBase, secrets.telegramToken, this.telegramOffset);
        this.telegramOffset = tg.nextOffset;
        cfg.meetingsIm.lastSyncAt = Date.now();
        cfg.meetingsIm.lastError = undefined;
        return { ok: true, message: `Telegram 连接成功，收到 ${tg.messages.length} 条新消息` };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        cfg.meetingsIm.lastError = msg;
        return { ok: false, message: msg };
      }
    }

    if (kind === "feishu") {
      if (!secrets.feishuWebhook) return { ok: false, message: "请填写飞书机器人 Webhook 地址" };
      cfg.meetingsIm.lastSyncAt = Date.now();
      cfg.meetingsIm.lastError = undefined;
      return { ok: true, message: "飞书机器人 Webhook 已加密保存，待批准外发就绪" };
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
    if (approval.kind && !isConnectorWriteAllowed(st, approval.kind)) {
      throw new Error("该连接器当前处于「仅只读 (read-only)」权限模式，已拒绝外发操作");
    }
    return dispatchApprovedConnectorAction(approval, cfg, secrets);
  }
}
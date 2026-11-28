/**
 * Coordinates Bot connectors (ImapFlow/Nodemailer Email, Standard Gmail/Calendar MCP Sync,
 * ICS Calendar, Process Sensor, Meeting Notes & Telegram/Feishu/GitHub/Notion) and
 * executes approved outbound actions (`packages/host/src/bot/connectors/connector-hub.ts`).
 */
import type { Mcp } from "@qianji/mcp";
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
import { runConnectorDiagnosticTest } from "./connector-test-runner.ts";
import { fetchRecentEmails, type FetchedEmail } from "./email-connector.ts";
import { syncCalendarViaMcp, syncGmailViaMcp } from "./mcp-sync.ts";
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
  private getMcp: (() => Mcp | undefined) | undefined;
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

  setMcpGetter(getter: (() => Mcp | undefined) | undefined): void {
    this.getMcp = getter;
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

  private ingestEmails(st: PersistedBotState, delta: ConnectorDelta, namespace: string, fetched: FetchedEmail[]): void {
    const inboxAdded: BotInboxItem[] = [];
    for (const mail of fetched) {
      const key = `${namespace}:${mail.uid}`;
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
  }

  async collectDelta(
    st: PersistedBotState,
    secrets: ConnectorSecrets,
    nowMs = Date.now(),
  ): Promise<ConnectorDelta> {
    this.ensureConfig(st);
    const cfg = st.connectorConfigs ?? buildDefaultConnectorsConfig();
    const mcp = this.getMcp?.();

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
            this.ingestEmails(st, delta, cfg.email.emailAddress, fetched);
          })
          .catch((err) => {
            cfg.email.lastError = err instanceof Error ? err.message : String(err);
          }),
      );
    }

    const gmailPolicy = cfg.appPolicies?.gmail;
    const gmailMcpOnline = Boolean(mcp?.statuses().some((s) => s.config.id === "preset-mcp-gmail" && s.connected));
    if (mcp && gmailMcpOnline && gmailPolicy?.backgroundSync !== false) {
      tasks.push(
        syncGmailViaMcp(mcp, "preset-mcp-gmail", 8)
          .then((fetched) => {
            if (!cfg.appPolicies) cfg.appPolicies = {};
            cfg.appPolicies.gmail = {
              policy: gmailPolicy?.policy ?? "low-risk-auto",
              ...gmailPolicy,
              connected: true,
              lastSyncAt: nowMs,
              lastError: undefined,
            };
            this.ingestEmails(st, delta, "gmail-mcp", fetched);
          })
          .catch((err) => {
            if (gmailPolicy) {
              gmailPolicy.lastError = err instanceof Error ? err.message : String(err);
            }
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

    const calPolicy = cfg.appPolicies?.calendar;
    const calMcpOnline = Boolean(mcp?.statuses().some((s) => s.config.id === "preset-mcp-calendar" && s.connected));
    if (mcp && calMcpOnline && !cfg.calendar.enabled && calPolicy?.backgroundSync !== false) {
      tasks.push(
        syncCalendarViaMcp(mcp, "preset-mcp-calendar", nowMs, cfg.calendar.leadMinutes)
          .then((cal) => {
            if (!cfg.appPolicies) cfg.appPolicies = {};
            cfg.appPolicies.calendar = {
              policy: calPolicy?.policy ?? "read-only-auto",
              ...calPolicy,
              connected: true,
              lastSyncAt: nowMs,
              lastError: undefined,
            };
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
            if (calPolicy) {
              calPolicy.lastError = err instanceof Error ? err.message : String(err);
            }
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
    return runConnectorDiagnosticTest(kind, st, secrets, {
      getMcp: this.getMcp,
      processSensor: this.processSensor,
      getTelegramOffset: () => this.telegramOffset,
      setTelegramOffset: (next) => {
        this.telegramOffset = next;
      },
      collectDelta: (targetState, targetSecrets) => this.collectDelta(targetState, targetSecrets),
    });
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

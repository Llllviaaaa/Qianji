/**
 * On-demand diagnostic & immediate sync runner (`testConnector`) for `ConnectorHub`
 * (`packages/host/src/bot/connectors/connector-test-runner.ts`).
 */
import type { Mcp } from "@qianji/mcp";
import type { BotConnectorTestKind } from "@qianji/protocol";
import { buildDefaultAwareness, buildDefaultConnectorsConfig, type PersistedBotState } from "../defaults.ts";
import { syncCalendarEvents } from "./calendar-connector.ts";
import { syncGitHubRepos, syncNotionPages } from "./cloud-connectors.ts";
import type { ConnectorSecrets } from "./connector-hub.ts";
import { fetchRecentEmails } from "./email-connector.ts";
import { syncCalendarViaMcp, syncGmailViaMcp } from "./mcp-sync.ts";
import { pollTelegramUpdates, scanMeetingNotes } from "./meetings-and-im.ts";
import type { ProcessSensor } from "./process-sensor.ts";

export interface ConnectorTestRunnerDeps {
  getMcp?: () => Mcp | undefined;
  processSensor: ProcessSensor;
  getTelegramOffset: () => number;
  setTelegramOffset: (next: number) => void;
  collectDelta: (st: PersistedBotState, secrets: ConnectorSecrets) => Promise<unknown>;
}

export async function runConnectorDiagnosticTest(
  kind: BotConnectorTestKind,
  st: PersistedBotState,
  secrets: ConnectorSecrets,
  deps: ConnectorTestRunnerDeps,
): Promise<{ ok: boolean; message: string }> {
  const cfg = st.connectorConfigs ?? buildDefaultConnectorsConfig();
  const mcp = deps.getMcp?.();

  if (kind === "email") {
    const gmailMcpOnline = Boolean(mcp?.statuses().some((s) => s.config.id === "preset-mcp-gmail" && s.connected));
    if (mcp && gmailMcpOnline && !cfg.email.enabled) {
      try {
        const fetched = await syncGmailViaMcp(mcp, "preset-mcp-gmail", 8);
        await deps.collectDelta(st, secrets);
        return { ok: true, message: `Gmail MCP 同步成功，同步到最近 ${fetched.length} 封邮件` };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (cfg.appPolicies?.gmail) cfg.appPolicies.gmail.lastError = msg;
        return { ok: false, message: msg };
      }
    }
    try {
      const fetched = await fetchRecentEmails(cfg.email, secrets.emailPassword ?? "", 6);
      cfg.email.lastSyncAt = Date.now();
      cfg.email.lastError = undefined;
      await deps.collectDelta(st, secrets);
      return { ok: true, message: `IMAP 邮箱连接成功，同步到最近 ${fetched.length} 封邮件` };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      cfg.email.lastError = msg;
      return { ok: false, message: msg };
    }
  }

  if (kind === "calendar") {
    const calMcpOnline = Boolean(mcp?.statuses().some((s) => s.config.id === "preset-mcp-calendar" && s.connected));
    if (mcp && calMcpOnline && !cfg.calendar.enabled) {
      try {
        const res = await syncCalendarViaMcp(mcp, "preset-mcp-calendar", Date.now(), cfg.calendar.leadMinutes);
        await deps.collectDelta(st, secrets);
        return {
          ok: true,
          message: `Google 日历 MCP 同步成功：今日共 ${res.todayEvents.length} 项日程，检测到 ${res.conflicts.length} 处冲突`,
        };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (cfg.appPolicies?.calendar) cfg.appPolicies.calendar.lastError = msg;
        return { ok: false, message: msg };
      }
    }
    try {
      const res = await syncCalendarEvents(cfg.calendar);
      cfg.calendar.lastSyncAt = Date.now();
      cfg.calendar.lastError = undefined;
      await deps.collectDelta(st, secrets);
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
    const sample = await deps.processSensor.sample(cfg.processSensor);
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
      await deps.collectDelta(st, secrets);
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
      await deps.collectDelta(st, secrets);
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
      const tg = await pollTelegramUpdates(
        cfg.meetingsIm.telegramApiBase,
        secrets.telegramToken,
        deps.getTelegramOffset(),
      );
      deps.setTelegramOffset(tg.nextOffset);
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

  const msgs: string[] = [];
  if (cfg.meetingsIm.meetingNotesEnabled && cfg.meetingsIm.meetingNotesDir.trim() !== "") {
    const notes = scanMeetingNotes(cfg.meetingsIm.meetingNotesDir, 0);
    msgs.push(`扫描纪要文件 ${notes.notes.length} 份`);
  }
  if (cfg.meetingsIm.telegramEnabled) {
    if (!secrets.telegramToken) return { ok: false, message: "请填写 Telegram Bot Token" };
    const tg = await pollTelegramUpdates(
      cfg.meetingsIm.telegramApiBase,
      secrets.telegramToken,
      deps.getTelegramOffset(),
    );
    deps.setTelegramOffset(tg.nextOffset);
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

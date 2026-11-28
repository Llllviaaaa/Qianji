/**
 * State mutation & permission helpers for `BotStateStore` (`store-actions.ts`).
 */
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import type {
  BotComputerStudioSnapshot,
  BotConnectorItem,
  BotConnectorsConfig,
  BotFeedItem,
  BotGoalItem,
  BotSideThreadInfo,
  BotSnapshotResult,
  PendingBotApproval,
  ResolvedBotApproval,
} from "@qianji/protocol";
import type { Session, Sessions } from "@qianji/session";
import {
  buildDefaultAwareness,
  buildDefaultBotState,
  buildDefaultConnectorsConfig,
  buildDefaultGoalViewPrefs,
  buildDefaultPacingConfig,
  DEFAULT_FEED_INSTRUCTIONS,
  formatClock,
  type PersistedBotState,
} from "./defaults.ts";
import {
  appendActivityRecord,
  createRichFeedRecord,
  createRichGoalRecord,
  createSpaceRecord,
  formatRelativeFeedTime,
} from "./store-discovery.ts";
import { regroupAndSanitizeActivities } from "./store-activity-helpers.ts";
import { reconcileBotDiscoveryState } from "./store-ideas.ts";
import type { SshRemoteRuntime } from "./ssh-runtime.ts";

export { appendActivityRecord, createSpaceRecord };
import {
  applyBotConfigOverlay,
  executeApprovedShellCommand,
  extractLearnedPreferencesFromMemory,
  scanBotWorkspaceArtifacts,
  type BotStoreConfig,
} from "./workspace-scanner.ts";
import type { WslContainerRuntime } from "./wsl-runtime.ts";

export async function ensureMainBotSession(
  sessions: Sessions,
  botWorkspaceDir: string,
  botSessionIds: Set<string>,
  existingId?: string,
  defaultModel?: () => { provider: string; model: string } | undefined,
): Promise<Session> {
  let sess = existingId ? await sessions.get(existingId) : undefined;
  if (sess === undefined) {
    sess = sessions.create({ cwd: botWorkspaceDir, side: true });
    sess.append("label", { title: "主聊天" });
  }
  botSessionIds.add(sess.id);
  ensureBotFullAccessPermission(sess);
  if (sess.state().model === undefined) {
    const chosen = defaultModel?.();
    if (chosen && chosen.provider && chosen.model) {
      sess.setModel({ provider: chosen.provider, model: chosen.model });
    }
  }
  return sess;
}

export async function loadOrCreatePersistedBotState(params: {
  stateFile: string;
  sessions: Sessions;
  botWorkspaceDir: string;
  botSessionIds: Set<string>;
  config: BotStoreConfig;
}): Promise<PersistedBotState> {
  const { stateFile, sessions, botWorkspaceDir, botSessionIds, config } = params;
  const fallbackModel = () => config.defaultModel?.();
  if (existsSync(stateFile)) {
    try {
      const parsed = JSON.parse(readFileSync(stateFile, "utf8")) as PersistedBotState;
      if (parsed && parsed.version === 2 && typeof parsed.mainSessionId === "string") {
        const resolveModel = () => parsed.modelConfig?.primary ?? fallbackModel();
        parsed.connectorConfigs = ensureBotWorkspaceDefaults(parsed.connectorConfigs ?? buildDefaultConnectorsConfig());
        const mainSession = await ensureMainBotSession(sessions, botWorkspaceDir, botSessionIds, parsed.mainSessionId, resolveModel);
        parsed.mainSessionId = mainSession.id;
        reconcileBotDiscoveryState(parsed);
        parsed.activityGroups = regroupAndSanitizeActivities(parsed.activityGroups ?? []);
        parsed.virtualServer.local.sharedFolders = (parsed.virtualServer.local.sharedFolders ?? []).filter(
          (f) => f.path.toLowerCase() !== botWorkspaceDir.toLowerCase(),
        );
        for (const side of parsed.sideThreads ?? []) {
          botSessionIds.add(side.sessionId);
          const s = await sessions.get(side.sessionId).catch(() => undefined);
          if (s !== undefined) {
            ensureBotFullAccessPermission(s);
            if (s.state().model === undefined) {
              const chosen = resolveModel();
              if (chosen && chosen.provider && chosen.model) s.setModel({ provider: chosen.provider, model: chosen.model });
            }
          }
        }
        applyBotConfigOverlay(parsed, config);
        return parsed;
      }
    } catch {
      // Fall through to clean initialization.
    }
  }
  const mainSession = await ensureMainBotSession(sessions, botWorkspaceDir, botSessionIds, undefined, fallbackModel);
  const fresh = buildDefaultBotState({
    mainSessionId: mainSession.id,
    defaultCwd: botWorkspaceDir,
    displayName: config.displayName,
    avatarPreset: config.avatarPreset,
  });
  applyBotConfigOverlay(fresh, config);
  return fresh;
}

export function ensureBotFullAccessPermission(session: Session): void {
  for (let i = session.events.length - 1; i >= 0; i -= 1) {
    const ev = session.events[i];
    if (ev?.type === "custom" && ev.data && (ev.data as { ns?: string }).ns === "qianji-permissions") {
      const payload = (ev.data as { data?: { permission?: string; agentMode?: string } }).data;
      if (payload?.permission === "full-access" && payload.agentMode === "agent") return;
      break;
    }
  }
  session.append("custom", { ns: "qianji-permissions", data: { permission: "full-access", agentMode: "agent" } });
}

export function createSideChatRecord(params: {
  sessions: Sessions;
  st: PersistedBotState;
  botWorkspaceDir: string;
  botSessionIds: Set<string>;
  defaultModel?: { provider: string; model: string };
  title?: string;
}): BotSideThreadInfo {
  const { sessions, st, botWorkspaceDir, botSessionIds, defaultModel, title } = params;
  const session = sessions.create({ cwd: botWorkspaceDir, side: true });
  ensureBotFullAccessPermission(session);
  if (defaultModel?.provider && defaultModel?.model) {
    session.setModel({ provider: defaultModel.provider, model: defaultModel.model });
  }
  botSessionIds.add(session.id);
  const resolvedTitle = title?.trim() || `新旁聊 · ${formatClock()}`;
  session.append("label", { title: resolvedTitle });
  const info: BotSideThreadInfo = {
    id: `side-${randomUUID().slice(0, 8)}`,
    sessionId: session.id,
    sessionFile: `harness:${session.id}`,
    title: resolvedTitle,
    updatedAt: Date.now(),
  };
  st.sideThreads.unshift(info);
  return info;
}

export async function deleteSideChatRecord(
  sessions: Sessions,
  st: PersistedBotState,
  botSessionIds: Set<string>,
  id: string,
): Promise<void> {
  const target = st.sideThreads.find((item) => item.id === id || item.sessionId === id);
  st.sideThreads = st.sideThreads.filter((item) => item.id !== id && item.sessionId !== id);
  if (target !== undefined) {
    botSessionIds.delete(target.sessionId);
    await sessions.delete(target.sessionId).catch(() => false);
  }
}

export function deleteSpaceRecord(st: PersistedBotState, botWorkspaceDir: string, id: string): void {
  st.spaces = st.spaces.filter((s) => s.id !== id);
  try {
    rmSync(join(botWorkspaceDir, "spaces", `${id}.md`), { force: true });
  } catch {
    // Ignore missing space markdown file.
  }
}

export function createGoalRecord(
  st: PersistedBotState,
  botWorkspaceDir: string,
  title: string,
  category: string,
): BotGoalItem {
  return createRichGoalRecord(st, botWorkspaceDir, { title, category });
}

export function createFeedRecord(
  st: PersistedBotState,
  title: string,
  body: string,
  seedPrompt?: string,
): BotFeedItem {
  return createRichFeedRecord(st, { title, body, seedPrompt });
}

export function ensureBotWorkspaceDefaults(cfg: BotConnectorsConfig): BotConnectorsConfig {
  const defaults = buildDefaultConnectorsConfig();
  return {
    ...defaults,
    ...cfg,
    email: { ...defaults.email, ...cfg.email },
    calendar: { ...defaults.calendar, ...cfg.calendar },
    processSensor: { ...defaults.processSensor, ...cfg.processSensor },
    meetingsIm: { ...defaults.meetingsIm, ...cfg.meetingsIm },
    github: { ...(defaults.github ?? { enabled: false, permission: "read-only", watchedRepos: [] }), ...cfg.github },
    notion: { ...(defaults.notion ?? { enabled: false, permission: "read-only", parentPageId: "" }), ...cfg.notion },
    slack: { ...(defaults.slack ?? { enabled: false, permission: "ask-write", channelLabel: "" }), ...cfg.slack },
    customWebhook: {
      ...(defaults.customWebhook ?? { enabled: false, permission: "ask-write", label: "Zapier / 自定义 Webhook", endpointUrl: "" }),
      ...cfg.customWebhook,
    },
  };
}

function buildConnectorSummaryItems(cfg: BotConnectorsConfig): BotConnectorItem[] {
  return [
    { id: "email", name: "邮箱贴身管家", description: "IMAP 收信与 SMTP 草稿投递", enabled: cfg.email.enabled, permission: cfg.email.permission ?? "ask-write" },
    { id: "calendar", name: "日历与会议参谋", description: "ICS 日程同步与冲突预警", enabled: cfg.calendar.enabled, permission: "read-only" },
    { id: "processes", name: "进程与专注感知", description: "本机窗口/会议/长任务监听", enabled: cfg.processSensor.enabled, permission: "read-only" },
    { id: "github", name: "GitHub", description: "仓库 Issues / PR 监听与受控评论", enabled: cfg.github?.enabled === true, permission: cfg.github?.permission ?? "read-only" },
    { id: "notion", name: "Notion", description: "知识库页面检索与受控归档", enabled: cfg.notion?.enabled === true, permission: cfg.notion?.permission ?? "read-only" },
    { id: "slack", name: "Slack", description: "频道 Webhook 通知推送", enabled: cfg.slack?.enabled === true, permission: cfg.slack?.permission ?? "ask-write" },
    { id: "telegram-feishu", name: "Telegram / 飞书", description: "即时消息收发与会议纪要目录", enabled: cfg.meetingsIm.telegramEnabled || cfg.meetingsIm.feishuEnabled || cfg.meetingsIm.meetingNotesEnabled, permission: cfg.meetingsIm.permission ?? "ask-write" },
    { id: "custom-webhook", name: "Zapier / 自定义 Webhook", description: "通用自动化工作流触发器", enabled: cfg.customWebhook?.enabled === true, permission: cfg.customWebhook?.permission ?? "ask-write" },
  ];
}

export function buildBotSnapshotResult(params: {
  st: PersistedBotState;
  botWorkspaceDir: string;
  memoryFile: string;
  soulContent: string;
  memoryUpdatedAt: string;
  computerStudio?: BotComputerStudioSnapshot;
}): BotSnapshotResult {
  const { st, botWorkspaceDir, memoryFile, soulContent, memoryUpdatedAt, computerStudio } = params;
  const scanned = scanBotWorkspaceArtifacts(botWorkspaceDir);
  const memPrefs = extractLearnedPreferencesFromMemory(memoryFile);
  const normalizedCfg = ensureBotWorkspaceDefaults(st.connectorConfigs ?? buildDefaultConnectorsConfig());
  const virtualServer = computerStudio ? { ...st.virtualServer, computerStudio } : st.virtualServer;
  return {
    mainSessionId: st.mainSessionId,
    mainSessionFile: `harness:${st.mainSessionId}`,
    botCwd: botWorkspaceDir,
    customBotCwd: st.customWorkspaceDir ?? "",
    profile: st.profile,
    sideThreads: st.sideThreads,
    soulContent,
    soulUpdatedAt: st.soulUpdatedAt,
    memoryUpdatedAt,
    learnedPreferences: memPrefs.length > 0 ? memPrefs : st.learnedPreferences,
    activityGroups: regroupAndSanitizeActivities(st.activityGroups ?? []),
    pendingApprovals: st.pendingApprovals,
    recentApprovals: st.recentApprovals,
    feed: st.feed.map((item) => ({
      ...item,
      timeLabel: formatRelativeFeedTime(item.createdAt),
    })),
    feedInstructions: st.feedInstructions ?? DEFAULT_FEED_INSTRUCTIONS,
    ideaSections: st.ideaSections,
    goals: st.goals,
    goalViewPrefs: st.goalViewPrefs ?? buildDefaultGoalViewPrefs(),
    spaces: st.spaces,
    documents: scanned.documents,
    media: scanned.media,
    inboxEnabled: st.inboxEnabled,
    inboxAddress: st.inboxAddress,
    inboxItems: st.inboxItems,
    connectors: buildConnectorSummaryItems(normalizedCfg),
    modelConfig: st.modelConfig ?? {},
    pacing: st.pacing ?? buildDefaultPacingConfig(),
    connectorConfigs: normalizedCfg,
    awareness: st.awareness ?? buildDefaultAwareness(),
    virtualServer,
    ...(computerStudio ? { computerStudio } : {}),
    embeddedTasks: st.embeddedTasks,
  };
}

export async function resolveBotApprovalRecord(params: {
  st: PersistedBotState;
  id: string;
  decision: "approved" | "denied";
  rawCmd: string | undefined;
  botWorkspaceDir: string;
  wsl: WslContainerRuntime;
  ssh: SshRemoteRuntime;
  getRemotePassword: () => Promise<string | undefined>;
  executeOutbound?: (approval: PendingBotApproval) => Promise<string>;
}): Promise<ResolvedBotApproval> {
  const { st, id, decision, rawCmd, botWorkspaceDir, wsl, ssh, getRemotePassword, executeOutbound } = params;
  const idx = st.pendingApprovals.findIndex((item) => item.id === id);
  const found = idx >= 0 ? st.pendingApprovals[idx] : undefined;
  const title = found?.title ?? "外部操作请求";
  let summary = decision === "approved" ? "刚刚 · 用户手动批准执行" : "刚刚 · 用户手动拒绝";
  if (
    decision === "approved" &&
    found &&
    executeOutbound &&
    (found.kind === "send-email" ||
      found.kind === "send-telegram" ||
      found.kind === "send-feishu" ||
      found.kind === "send-slack" ||
      found.kind === "github-comment" ||
      found.kind === "notion-page" ||
      found.kind === "trigger-webhook")
  ) {
    summary = await executeOutbound(found);
  }
  if (idx >= 0) st.pendingApprovals.splice(idx, 1);
  if (decision === "approved" && rawCmd) {
    if (st.virtualServer.mode === "remote") {
      const res = await ssh.exec(st.virtualServer.remote, rawCmd, { password: await getRemotePassword() });
      summary = res.exitCode === 0 ? "刚刚 · 已批准并在远端服务器执行完成" : "刚刚 · 已批准执行";
    } else if (wsl.isSupported()) {
      const res = await wsl.exec(rawCmd, {
        cpuCores: st.virtualServer.local.cpuCores,
        memoryLimitGb: st.virtualServer.local.memoryLimitGb,
        sharedFolders: st.virtualServer.local.sharedFolders,
      });
      summary = res.exitCode === 0 ? "刚刚 · 已批准并在 WSL2 容器执行完成" : "刚刚 · 已批准执行";
    } else {
      const execRes = await executeApprovedShellCommand(rawCmd, botWorkspaceDir);
      summary = execRes.code === 0 ? "刚刚 · 已批准并在受控环境执行完成" : "刚刚 · 已批准执行";
    }
  }
  const resolved: ResolvedBotApproval = {
    id,
    title,
    summary,
    decision,
    timeLabel: decision === "approved" ? "已批准" : "已拒绝",
    resolvedAt: Date.now(),
  };
  st.recentApprovals.unshift(resolved);
  st.recentApprovals = st.recentApprovals.slice(0, 50);
  appendActivityRecord(st, {
    title: decision === "approved" ? `已批准：${title}` : `已拒绝：${title}`,
    description: summary,
  });
  return resolved;
}

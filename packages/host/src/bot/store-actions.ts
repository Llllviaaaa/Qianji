/**
 * State mutation & permission helpers for `BotStateStore` (`store-actions.ts`).
 */
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import type {
  BotActivityEntry,
  BotFeedItem,
  BotGoalItem,
  BotSnapshotResult,
  BotSpaceSummary,
  PendingBotApproval,
  ResolvedBotApproval,
} from "@qianji/protocol";
import type { Session, Sessions } from "@qianji/session";
import {
  buildDefaultAwareness,
  buildDefaultBotState,
  buildDefaultConnectorsConfig,
  buildDefaultPacingConfig,
  formatClock,
  STARTER_IDEA_SECTIONS,
  type PersistedBotState,
} from "./defaults.ts";
import type { SshRemoteRuntime } from "./ssh-runtime.ts";
import {
  applyBotConfigOverlay,
  executeApprovedShellCommand,
  extractLearnedPreferencesFromMemory,
  scanBotWorkspaceArtifacts,
  writeFileAtomic,
  type BotStoreConfig,
} from "./workspace-scanner.ts";
import type { WslContainerRuntime } from "./wsl-runtime.ts";

export async function ensureMainBotSession(
  sessions: Sessions,
  botWorkspaceDir: string,
  botSessionIds: Set<string>,
  existingId?: string,
): Promise<Session> {
  let sess = existingId ? await sessions.get(existingId) : undefined;
  if (sess === undefined) {
    sess = sessions.create({ cwd: botWorkspaceDir, side: true });
    sess.append("label", { title: "主聊天" });
  }
  botSessionIds.add(sess.id);
  ensureBotFullAccessPermission(sess);
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
  if (existsSync(stateFile)) {
    try {
      const parsed = JSON.parse(readFileSync(stateFile, "utf8")) as PersistedBotState;
      if (parsed && parsed.version === 2 && typeof parsed.mainSessionId === "string") {
        const mainSession = await ensureMainBotSession(sessions, botWorkspaceDir, botSessionIds, parsed.mainSessionId);
        parsed.mainSessionId = mainSession.id;
        parsed.ideaSections = STARTER_IDEA_SECTIONS;
        parsed.virtualServer.local.sharedFolders = (parsed.virtualServer.local.sharedFolders ?? []).filter(
          (f) => f.path.toLowerCase() !== botWorkspaceDir.toLowerCase(),
        );
        for (const side of parsed.sideThreads ?? []) {
          botSessionIds.add(side.sessionId);
          const s = await sessions.get(side.sessionId).catch(() => undefined);
          if (s !== undefined) ensureBotFullAccessPermission(s);
        }
        applyBotConfigOverlay(parsed, config);
        return parsed;
      }
    } catch {
      // Fall through to clean initialization.
    }
  }
  const mainSession = await ensureMainBotSession(sessions, botWorkspaceDir, botSessionIds);
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

export function appendActivityRecord(
  st: PersistedBotState,
  input: { title: string; description: string },
): BotActivityEntry {
  const now = Date.now();
  const entry: BotActivityEntry = {
    id: `act-${randomUUID().slice(0, 8)}`,
    dateGroup: "今天",
    title: input.title,
    description: input.description,
    timeLabel: formatClock(now),
    createdAt: now,
  };
  let todayGroup = st.activityGroups.find((g) => g.date === "今天");
  if (todayGroup === undefined) {
    todayGroup = { date: "今天", items: [] };
    st.activityGroups.unshift(todayGroup);
  }
  todayGroup.items.unshift(entry);
  todayGroup.items = todayGroup.items.slice(0, 40);
  return entry;
}

export function createSpaceRecord(
  st: PersistedBotState,
  botWorkspaceDir: string,
  title: string,
  description?: string,
): BotSpaceSummary {
  const cleanTitle = title.replace(/^我想创建一个空间，关于\s*/, "").trim() || "新建自定义空间";
  const id = `space-${randomUUID().slice(0, 8)}`;
  const desc = description?.trim() || "由千机在专属虚拟服务器内持续维护的常驻追踪空间";
  const created: BotSpaceSummary = {
    id,
    title: cleanTitle,
    description: desc,
    metricBadge: "实时同步",
    updatedLabel: "刚刚",
    updatedAt: Date.now(),
    handoff: { id: `handoff-${id}`, title: cleanTitle, kindLabel: "常驻空间", summary: desc, targetCwd: botWorkspaceDir },
  };
  writeFileAtomic(join(botWorkspaceDir, "spaces", `${id}.md`), `# ${cleanTitle}\n\n${desc}\n`);
  st.spaces.unshift(created);
  appendActivityRecord(st, { title: `创建常驻空间：${cleanTitle}`, description: desc });
  return created;
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
  const cleanTitle = title.trim();
  const id = `goal-${randomUUID().slice(0, 8)}`;
  const created: BotGoalItem = {
    id,
    title: cleanTitle,
    category: category.trim() || "通用",
    summary: "正在后台持续追踪，有重要进展会主动汇报。",
    status: "active",
    updatedAt: Date.now(),
    handoff: {
      id: `handoff-${id}`,
      title: cleanTitle,
      kindLabel: category.trim() || "长期目标",
      summary: `围绕目标「${cleanTitle}」在 Agent 工作台执行深度分析`,
      targetCwd: botWorkspaceDir,
    },
  };
  st.goals.unshift(created);
  appendActivityRecord(st, { title: `设定长期目标：${cleanTitle}`, description: created.category });
  return created;
}

export function createFeedRecord(
  st: PersistedBotState,
  title: string,
  body: string,
  seedPrompt?: string,
): BotFeedItem {
  const item: BotFeedItem = {
    id: `feed-${randomUUID().slice(0, 8)}`,
    title: title.trim(),
    timeLabel: "刚刚",
    body: body.trim(),
    actionLabel: "讨论",
    seedPrompt: seedPrompt?.trim() || `我们来深入聊聊：${title.trim()}`,
    createdAt: Date.now(),
  };
  st.feed.unshift(item);
  st.feed = st.feed.slice(0, 30);
  return item;
}

export function buildBotSnapshotResult(params: {
  st: PersistedBotState;
  botWorkspaceDir: string;
  memoryFile: string;
  soulContent: string;
  memoryUpdatedAt: string;
}): BotSnapshotResult {
  const { st, botWorkspaceDir, memoryFile, soulContent, memoryUpdatedAt } = params;
  const scanned = scanBotWorkspaceArtifacts(botWorkspaceDir);
  const memPrefs = extractLearnedPreferencesFromMemory(memoryFile);
  return {
    mainSessionId: st.mainSessionId,
    mainSessionFile: `harness:${st.mainSessionId}`,
    botCwd: botWorkspaceDir,
    profile: st.profile,
    sideThreads: st.sideThreads,
    soulContent,
    soulUpdatedAt: st.soulUpdatedAt,
    memoryUpdatedAt,
    learnedPreferences: memPrefs.length > 0 ? memPrefs : st.learnedPreferences,
    activityGroups: st.activityGroups,
    pendingApprovals: st.pendingApprovals,
    recentApprovals: st.recentApprovals,
    feed: st.feed,
    ideaSections: st.ideaSections,
    goals: st.goals,
    spaces: st.spaces,
    documents: scanned.documents,
    media: scanned.media,
    inboxEnabled: st.inboxEnabled,
    inboxAddress: st.inboxAddress,
    inboxItems: st.inboxItems,
    connectors: st.connectors,
    modelConfig: st.modelConfig ?? {},
    pacing: st.pacing ?? buildDefaultPacingConfig(),
    connectorConfigs: st.connectorConfigs ?? buildDefaultConnectorsConfig(),
    awareness: st.awareness ?? buildDefaultAwareness(),
    virtualServer: st.virtualServer,
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
    (found.kind === "send-email" || found.kind === "send-telegram" || found.kind === "send-feishu")
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

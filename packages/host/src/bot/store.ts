/**
 * Atomic `<dataDir>/bot/` state store & session coordinator (`@qianji/host` Bot service).
 */
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  BOT_TASK_CARD_NAMESPACE,
  type BotActivityEntry,
  type BotGoalItem,
  type BotHandoffCompleteParams,
  type BotProfile,
  type BotServerActionKind,
  type BotServerActionResult,
  type BotServerMode,
  type BotSideThreadInfo,
  type BotSnapshotResult,
  type BotSpaceSummary,
  type PendingBotApproval,
  type ResolvedBotApproval,
} from "@qianji/protocol";
import type { Session, Sessions } from "@qianji/session";
import {
  buildDefaultBotState,
  DEFAULT_SOUL_MARKDOWN,
  formatClock,
  formatShortDate,
  MAX_SOUL_BYTES,
  normalizeAvatarPreset,
  type PersistedBotState,
} from "./defaults.ts";
import {
  applyVirtualServerPatch,
  runVirtualServerAction,
  type VirtualServerPatch,
} from "./virtual-server.ts";

export interface BotStoreConfig {
  dataDir: string;
  displayName?: string;
  avatarPreset?: string;
  serverMode?: BotServerMode;
  localCpuCores?: number;
  localMemoryGb?: number;
  localDiskGb?: number;
  autoSleepIdle?: boolean;
  remoteHost?: string;
  remotePort?: number;
  remoteUser?: string;
  remoteWorkDir?: string;
}

const ZERO_USAGE = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };
const SYNTHETIC_BOT_MODEL = { provider: "qianji", model: "bot-companion" };

function writeFileAtomic(file: string, content: string, mode?: number): void {
  mkdirSync(dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(temp, content, mode === undefined ? "utf8" : { encoding: "utf8", mode });
  renameSync(temp, file);
}

function appendBotAssistantText(session: Session, text: string): void {
  session.append("assistant", {
    content: [{ type: "text", text }],
    model: SYNTHETIC_BOT_MODEL,
    usage: ZERO_USAGE,
    stop: "stop",
  });
}

function seedInitialMainConversation(session: Session, state: PersistedBotState): void {
  session.append("label", { title: "千机 · 主聊天" });
  appendBotAssistantText(
    session,
    "今早 08:30 已完成关注工作区与通知巡检：主分支核心门禁测试全部通过，多模型前缀缓存命中率稳定在 74.2%。\n\n同时检测到新增开发分支未出现未提交冲突。有需要盯办的事项随时告诉我。",
  );
  session.append("user", {
    content: [{ type: "text", text: "帮我盯着点 PR #142，挂了提醒我，先别改本地主分支" }],
  });
  appendBotAssistantText(session, "已安排，每 30 分钟在虚拟服务器内自动巡检 PR #142 构建状态，发现异常第一时间在独立副本备好草案提醒你。");
  if (state.embeddedTasks[0] !== undefined) {
    session.append("custom", {
      ns: BOT_TASK_CARD_NAMESPACE,
      data: state.embeddedTasks[0],
    });
  }
  appendBotAssistantText(
    session,
    "刚刚检测到 PR #142 有一项并发队列回归异常：我已按你的习惯在独立安全副本拟好修复方案，主工作区保持干净；需要外发 PR 诊断评论也可在右侧「批准」栏一键放行。",
  );
}

export class BotStateStore {
  readonly botDir: string;
  readonly botWorkspaceDir: string;
  readonly stateFile: string;
  readonly soulFile: string;
  readonly memoryFile: string;

  private state: PersistedBotState | undefined;
  private readonly botSessionIds = new Set<string>();

  constructor(
    private readonly sessions: Sessions,
    private config: BotStoreConfig,
  ) {
    this.botDir = join(config.dataDir, "bot");
    this.botWorkspaceDir = join(config.dataDir, "bot-workspace");
    this.stateFile = join(this.botDir, "state.json");
    this.soulFile = join(this.botDir, "SOUL.md");
    this.memoryFile = join(config.dataDir, "memory.md");
    mkdirSync(this.botDir, { recursive: true });
    mkdirSync(this.botWorkspaceDir, { recursive: true });
  }

  updateConfig(next: Partial<BotStoreConfig>): void {
    this.config = { ...this.config, ...next };
    if (this.state !== undefined) {
      this.applyConfigOverlay(this.state);
      this.persistState();
    }
  }

  isBotSession(sessionId: string): boolean {
    return this.botSessionIds.has(sessionId);
  }

  readSoul(): string {
    if (!existsSync(this.soulFile)) {
      writeFileAtomic(this.soulFile, DEFAULT_SOUL_MARKDOWN, 0o600);
      return DEFAULT_SOUL_MARKDOWN;
    }
    try {
      return readFileSync(this.soulFile, "utf8");
    } catch {
      return DEFAULT_SOUL_MARKDOWN;
    }
  }

  saveSoul(content: string): { content: string; updatedAt: string } {
    if (Buffer.byteLength(content, "utf8") > MAX_SOUL_BYTES) {
      throw new Error("SOUL.md cannot exceed 128 KB");
    }
    writeFileAtomic(this.soulFile, content, 0o600);
    const updatedAt = formatShortDate(Date.now());
    if (this.state !== undefined) {
      this.state.soulUpdatedAt = updatedAt;
      this.persistState();
    }
    return { content, updatedAt };
  }

  private memoryUpdatedAtLabel(): string {
    try {
      const st = statSync(this.memoryFile);
      return formatShortDate(st.mtimeMs);
    } catch {
      return formatShortDate(Date.now());
    }
  }

  private applyConfigOverlay(target: PersistedBotState): void {
    if (this.config.displayName && this.config.displayName.trim() !== "") {
      target.profile.displayName = this.config.displayName.trim();
    }
    if (this.config.avatarPreset) {
      target.profile.avatarPreset = normalizeAvatarPreset(this.config.avatarPreset);
    }
    if (this.config.serverMode === "local" || this.config.serverMode === "remote") {
      target.virtualServer.mode = this.config.serverMode;
    }
    if (typeof this.config.localCpuCores === "number") {
      target.virtualServer.local.cpuCores = this.config.localCpuCores;
    }
    if (typeof this.config.localMemoryGb === "number") {
      target.virtualServer.local.memoryLimitGb = this.config.localMemoryGb;
    }
    if (typeof this.config.localDiskGb === "number") {
      target.virtualServer.local.diskLimitGb = this.config.localDiskGb;
    }
    if (typeof this.config.autoSleepIdle === "boolean") {
      target.virtualServer.local.autoSleepIdle = this.config.autoSleepIdle;
    }
    if (typeof this.config.remoteHost === "string" && this.config.remoteHost !== "") {
      target.virtualServer.remote.host = this.config.remoteHost;
    }
    if (typeof this.config.remotePort === "number") {
      target.virtualServer.remote.port = this.config.remotePort;
    }
    if (typeof this.config.remoteUser === "string" && this.config.remoteUser !== "") {
      target.virtualServer.remote.username = this.config.remoteUser;
    }
    if (typeof this.config.remoteWorkDir === "string" && this.config.remoteWorkDir !== "") {
      target.virtualServer.remote.workDir = this.config.remoteWorkDir;
    }
  }

  private persistState(): void {
    if (this.state === undefined) return;
    writeFileAtomic(this.stateFile, `${JSON.stringify(this.state, null, 2)}\n`);
  }

  async ensureLoaded(): Promise<PersistedBotState> {
    if (this.state !== undefined) {
      const existingMain = await this.sessions.get(this.state.mainSessionId);
      if (existingMain === undefined) {
        const recreated = this.sessions.create({ cwd: this.botWorkspaceDir, side: true });
        this.state.mainSessionId = recreated.id;
        this.botSessionIds.add(recreated.id);
        seedInitialMainConversation(recreated, this.state);
        this.persistState();
      }
      return this.state;
    }

    this.readSoul();
    if (existsSync(this.stateFile)) {
      try {
        const parsed = JSON.parse(readFileSync(this.stateFile, "utf8")) as PersistedBotState;
        if (parsed && typeof parsed.mainSessionId === "string") {
          let mainSession = await this.sessions.get(parsed.mainSessionId);
          if (mainSession === undefined) {
            mainSession = this.sessions.create({ cwd: this.botWorkspaceDir, side: true });
            parsed.mainSessionId = mainSession.id;
            seedInitialMainConversation(mainSession, parsed);
          }
          this.botSessionIds.add(parsed.mainSessionId);
          for (const side of parsed.sideThreads ?? []) {
            this.botSessionIds.add(side.sessionId);
          }
          this.applyConfigOverlay(parsed);
          this.state = parsed;
          this.persistState();
          return parsed;
        }
      } catch {
        // Fall through to clean re-seed on corrupted JSON.
      }
    }

    const mainSession = this.sessions.create({ cwd: this.botWorkspaceDir, side: true });
    const fresh = buildDefaultBotState({
      mainSessionId: mainSession.id,
      defaultCwd: this.botWorkspaceDir,
      displayName: this.config.displayName,
      avatarPreset: this.config.avatarPreset,
    });
    this.applyConfigOverlay(fresh);
    seedInitialMainConversation(mainSession, fresh);
    this.botSessionIds.add(mainSession.id);
    this.state = fresh;
    this.persistState();
    return fresh;
  }

  async snapshot(): Promise<BotSnapshotResult> {
    const st = await this.ensureLoaded();
    return {
      mainSessionId: st.mainSessionId,
      mainSessionFile: `harness:${st.mainSessionId}`,
      botCwd: this.botWorkspaceDir,
      profile: st.profile,
      sideThreads: st.sideThreads,
      soulContent: this.readSoul(),
      soulUpdatedAt: st.soulUpdatedAt,
      memoryUpdatedAt: this.memoryUpdatedAtLabel(),
      learnedPreferences: st.learnedPreferences,
      activityGroups: st.activityGroups,
      pendingApprovals: st.pendingApprovals,
      recentApprovals: st.recentApprovals,
      feed: st.feed,
      ideaSections: st.ideaSections,
      goals: st.goals,
      spaces: st.spaces,
      documents: st.documents,
      media: st.media,
      inboxEnabled: st.inboxEnabled,
      inboxAddress: st.inboxAddress,
      inboxItems: st.inboxItems,
      connectors: st.connectors,
      virtualServer: st.virtualServer,
      embeddedTasks: st.embeddedTasks,
    };
  }

  async updateProfile(patch: Partial<BotProfile>): Promise<BotProfile> {
    const st = await this.ensureLoaded();
    if (typeof patch.displayName === "string" && patch.displayName.trim() !== "") {
      st.profile.displayName = patch.displayName.trim();
    }
    if (patch.avatarPreset !== undefined) {
      st.profile.avatarPreset = normalizeAvatarPreset(patch.avatarPreset);
    }
    if (patch.customAvatarDataUrl !== undefined) {
      st.profile.customAvatarDataUrl = patch.customAvatarDataUrl;
    }
    this.persistState();
    return st.profile;
  }

  async createSideChat(title?: string): Promise<BotSideThreadInfo> {
    const st = await this.ensureLoaded();
    const session = this.sessions.create({ cwd: this.botWorkspaceDir, side: true });
    this.botSessionIds.add(session.id);
    const resolvedTitle = title?.trim() || `新旁聊 · ${formatClock()}`;
    session.append("label", { title: resolvedTitle });
    appendBotAssistantText(session, "已开启独立旁聊。这里适合探讨临时问题或分支小实验，不会混入你的主聊天时间线。");
    const info: BotSideThreadInfo = {
      id: `side-${randomUUID().slice(0, 8)}`,
      sessionId: session.id,
      sessionFile: `harness:${session.id}`,
      title: resolvedTitle,
      updatedAt: Date.now(),
    };
    st.sideThreads.unshift(info);
    this.persistState();
    return info;
  }

  async deleteSideChat(id: string): Promise<void> {
    const st = await this.ensureLoaded();
    const target = st.sideThreads.find((item) => item.id === id || item.sessionId === id);
    st.sideThreads = st.sideThreads.filter((item) => item.id !== id && item.sessionId !== id);
    if (target !== undefined) {
      this.botSessionIds.delete(target.sessionId);
      await this.sessions.delete(target.sessionId).catch(() => false);
    }
    this.persistState();
  }

  async enqueueApproval(entry: Omit<PendingBotApproval, "id" | "createdAt" | "expiresAt">): Promise<PendingBotApproval> {
    const st = await this.ensureLoaded();
    const now = Date.now();
    const created: PendingBotApproval = {
      id: `apr-${randomUUID().slice(0, 8)}`,
      createdAt: now,
      expiresAt: now + 86_400_000 * 3,
      ...entry,
    };
    st.pendingApprovals.unshift(created);
    this.persistState();
    return created;
  }

  async resolveApproval(id: string, decision: "approved" | "denied"): Promise<ResolvedBotApproval> {
    const st = await this.ensureLoaded();
    const idx = st.pendingApprovals.findIndex((item) => item.id === id);
    const found = idx >= 0 ? st.pendingApprovals.splice(idx, 1)[0] : undefined;
    const title = found?.title ?? "外部操作请求";
    const resolved: ResolvedBotApproval = {
      id,
      title,
      summary: decision === "approved" ? "刚刚 · 用户手动批准执行" : "刚刚 · 用户手动拒绝",
      decision,
      timeLabel: decision === "approved" ? "已批准" : "已拒绝",
      resolvedAt: Date.now(),
    };
    st.recentApprovals.unshift(resolved);
    st.recentApprovals = st.recentApprovals.slice(0, 50);
    this.recordActivity({
      title: decision === "approved" ? `已批准：${title}` : `已拒绝：${title}`,
      description: decision === "approved" ? "Approved external action from Bot Approvals panel" : "Denied external action request",
    });
    this.persistState();
    return resolved;
  }

  recordActivity(input: { title: string; description: string }): BotActivityEntry {
    if (this.state === undefined) {
      throw new Error("BotStateStore must be loaded before recording activity");
    }
    const now = Date.now();
    const entry: BotActivityEntry = {
      id: `act-${randomUUID().slice(0, 8)}`,
      dateGroup: "今天",
      title: input.title,
      description: input.description,
      timeLabel: formatClock(now),
      createdAt: now,
    };
    let todayGroup = this.state.activityGroups.find((g) => g.date === "今天");
    if (todayGroup === undefined) {
      todayGroup = { date: "今天", items: [] };
      this.state.activityGroups.unshift(todayGroup);
    }
    todayGroup.items.unshift(entry);
    return entry;
  }

  async createSpace(title: string, description?: string): Promise<BotSpaceSummary> {
    const st = await this.ensureLoaded();
    const cleanTitle = title.replace(/^我想创建一个空间，关于\s*/, "").trim() || "新建自定义追踪空间";
    const created: BotSpaceSummary = {
      id: `space-${randomUUID().slice(0, 8)}`,
      title: cleanTitle,
      description: description?.trim() || "由千机在专属虚拟服务器内持续刷新的常驻空间看板",
      metricBadge: "实时刷新中",
      updatedLabel: "刚刚",
      updatedAt: Date.now(),
    };
    st.spaces.unshift(created);
    this.recordActivity({ title: `创建常驻空间：${cleanTitle}`, description: "Created persistent tracking space" });
    this.persistState();
    return created;
  }

  async createGoal(title: string, category: string): Promise<BotGoalItem> {
    const st = await this.ensureLoaded();
    const created: BotGoalItem = {
      id: `goal-${randomUUID().slice(0, 8)}`,
      title: title.trim(),
      category: category.trim() || "通用",
      summary: "已在虚拟服务器内建立周期跟进计划，有关键进展会主动汇报。",
      status: "active",
      updatedAt: Date.now(),
    };
    st.goals.unshift(created);
    this.persistState();
    return created;
  }

  async enableInbox(): Promise<{ inboxEnabled: boolean; inboxAddress: string }> {
    const st = await this.ensureLoaded();
    st.inboxEnabled = true;
    this.persistState();
    return { inboxEnabled: true, inboxAddress: st.inboxAddress };
  }

  async toggleConnector(id: string): Promise<void> {
    const st = await this.ensureLoaded();
    const target = st.connectors.find((item) => item.id === id);
    if (target !== undefined) {
      target.enabled = !target.enabled;
      this.persistState();
    }
  }

  async configureVirtualServer(patch: VirtualServerPatch): Promise<BotSnapshotResult["virtualServer"]> {
    const st = await this.ensureLoaded();
    const updated = applyVirtualServerPatch(st, patch);
    this.persistState();
    return updated;
  }

  async performServerAction(action: BotServerActionKind): Promise<BotServerActionResult> {
    const st = await this.ensureLoaded();
    const res = runVirtualServerAction(st, action, (act) => this.recordActivity(act));
    this.persistState();
    return res;
  }

  async completeHandoff(params: BotHandoffCompleteParams): Promise<BotActivityEntry> {
    const st = await this.ensureLoaded();
    const mainSession = await this.sessions.get(st.mainSessionId);
    if (mainSession !== undefined) {
      appendBotAssistantText(mainSession, `Agent 工作台已完成接力回传：${params.summary}`);
    }
    const activity = this.recordActivity({
      title: params.title?.trim() || "完成 Agent 工作台接力回传",
      description: params.summary,
    });
    this.persistState();
    return activity;
  }
}

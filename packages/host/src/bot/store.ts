/**
 * Atomic `<dataDir>/bot/` state store & session coordinator (`@qianji/host` Bot service).
 */
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import type {
  BotActivityEntry, BotFeedItem, BotGoalItem, BotHandoffCompleteParams,
  BotProfile, BotServerActionKind, BotServerActionResult, BotSideThreadInfo,
  BotSnapshotResult, BotSpaceSummary, PendingBotApproval, ResolvedBotApproval,
} from "@qianji/protocol";
import type { Session, Sessions } from "@qianji/session";
import {
  buildDefaultBotState, DEFAULT_SOUL_MARKDOWN, formatClock, formatShortDate,
  MAX_SOUL_BYTES, normalizeAvatarPreset, STARTER_IDEA_SECTIONS, type PersistedBotState,
} from "./defaults.ts";
import { applyVirtualServerPatch, refreshLiveLocalMetrics, runVirtualServerAction, type VirtualServerPatch } from "./virtual-server.ts";
import {
  applyBotConfigOverlay, executeApprovedShellCommand, extractLearnedPreferencesFromMemory,
  scanBotWorkspaceArtifacts, writeFileAtomic, type BotStoreConfig,
} from "./workspace-scanner.ts";

export type { BotStoreConfig };

const ZERO_USAGE = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };
const SYNTHETIC_BOT_MODEL = { provider: "qianji", model: "bot-companion" };

function appendBotAssistantText(session: Session, text: string): void {
  session.append("assistant", {
    content: [{ type: "text", text }],
    model: SYNTHETIC_BOT_MODEL,
    usage: ZERO_USAGE,
    stop: "stop",
  });
}

export class BotStateStore {
  readonly botDir: string;
  readonly botWorkspaceDir: string;
  readonly stateFile: string;
  readonly soulFile: string;
  readonly memoryFile: string;

  private state: PersistedBotState | undefined;
  private readonly botSessionIds = new Set<string>();
  private readonly pendingCommands = new Map<string, string>();

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
    applyBotConfigOverlay(target, this.config);
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
        recreated.append("label", { title: "主聊天" });
        this.state.mainSessionId = recreated.id;
        this.botSessionIds.add(recreated.id);
        this.persistState();
      }
      return this.state;
    }

    this.readSoul();
    if (existsSync(this.stateFile)) {
      try {
        const parsed = JSON.parse(readFileSync(this.stateFile, "utf8")) as PersistedBotState;
        if (parsed && parsed.version === 2 && typeof parsed.mainSessionId === "string") {
          let mainSession = await this.sessions.get(parsed.mainSessionId);
          if (mainSession === undefined) {
            mainSession = this.sessions.create({ cwd: this.botWorkspaceDir, side: true });
            mainSession.append("label", { title: "主聊天" });
            parsed.mainSessionId = mainSession.id;
          }
          parsed.ideaSections = STARTER_IDEA_SECTIONS;
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
        // Fall through to clean initialization.
      }
    }

    const mainSession = this.sessions.create({ cwd: this.botWorkspaceDir, side: true });
    mainSession.append("label", { title: "主聊天" });
    const fresh = buildDefaultBotState({
      mainSessionId: mainSession.id,
      defaultCwd: this.botWorkspaceDir,
      displayName: this.config.displayName,
      avatarPreset: this.config.avatarPreset,
    });
    this.applyConfigOverlay(fresh);
    this.botSessionIds.add(mainSession.id);
    this.state = fresh;
    this.persistState();
    return fresh;
  }

  async snapshot(): Promise<BotSnapshotResult> {
    const st = await this.ensureLoaded();
    refreshLiveLocalMetrics(st, this.botDir, this.botWorkspaceDir);
    const scanned = scanBotWorkspaceArtifacts(this.botWorkspaceDir);
    const memPrefs = extractLearnedPreferencesFromMemory(this.memoryFile);
    return {
      mainSessionId: st.mainSessionId,
      mainSessionFile: `harness:${st.mainSessionId}`,
      botCwd: this.botWorkspaceDir,
      profile: st.profile,
      sideThreads: st.sideThreads,
      soulContent: this.readSoul(),
      soulUpdatedAt: st.soulUpdatedAt,
      memoryUpdatedAt: this.memoryUpdatedAtLabel(),
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
      virtualServer: st.virtualServer,
      embeddedTasks: st.embeddedTasks,
    };
  }

  async recordSettledTurn(session: Session): Promise<void> {
    const st = await this.ensureLoaded();
    const isMain = session.id === st.mainSessionId;
    const side = st.sideThreads.find((t) => t.sessionId === session.id);
    if (side !== undefined) {
      side.updatedAt = Date.now();
    }
    this.recordActivity({
      title: isMain ? "完成主聊天回复与处理" : `完成旁聊回复：${side?.title ?? "旁聊"}`,
      description: isMain ? "Updated main companion conversation" : "Updated isolated side conversation",
    });
    this.persistState();
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

  async enqueueApproval(
    entry: Omit<PendingBotApproval, "id" | "createdAt" | "expiresAt">,
    rawCommand?: string,
  ): Promise<PendingBotApproval> {
    const st = await this.ensureLoaded();
    const now = Date.now();
    const created: PendingBotApproval = {
      id: `apr-${randomUUID().slice(0, 8)}`,
      createdAt: now,
      expiresAt: now + 86_400_000 * 3,
      ...entry,
    };
    if (rawCommand) {
      this.pendingCommands.set(created.id, rawCommand);
    }
    st.pendingApprovals.unshift(created);
    this.persistState();
    return created;
  }

  async resolveApproval(id: string, decision: "approved" | "denied"): Promise<ResolvedBotApproval> {
    const st = await this.ensureLoaded();
    const idx = st.pendingApprovals.findIndex((item) => item.id === id);
    const found = idx >= 0 ? st.pendingApprovals.splice(idx, 1)[0] : undefined;
    const rawCmd = this.pendingCommands.get(id);
    this.pendingCommands.delete(id);
    const title = found?.title ?? "外部操作请求";

    let summary = decision === "approved" ? "刚刚 · 用户手动批准执行" : "刚刚 · 用户手动拒绝";
    if (decision === "approved" && rawCmd) {
      const execRes = await executeApprovedShellCommand(rawCmd, this.botWorkspaceDir);
      summary = execRes.code === 0 ? "刚刚 · 已批准并在受控环境执行完成" : "刚刚 · 已批准执行";
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
    this.recordActivity({
      title: decision === "approved" ? `已批准：${title}` : `已拒绝：${title}`,
      description: summary,
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
    todayGroup.items = todayGroup.items.slice(0, 40);
    return entry;
  }

  async createSpace(title: string, description?: string): Promise<BotSpaceSummary> {
    const st = await this.ensureLoaded();
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
      handoff: {
        id: `handoff-${id}`,
        title: cleanTitle,
        kindLabel: "常驻空间",
        summary: desc,
        targetCwd: this.botWorkspaceDir,
      },
    };
    const spaceFile = join(this.botWorkspaceDir, "spaces", `${id}.md`);
    writeFileAtomic(spaceFile, `# ${cleanTitle}\n\n${desc}\n`);
    st.spaces.unshift(created);
    this.recordActivity({ title: `创建常驻空间：${cleanTitle}`, description: desc });
    this.persistState();
    return created;
  }

  async deleteSpace(id: string): Promise<void> {
    const st = await this.ensureLoaded();
    st.spaces = st.spaces.filter((s) => s.id !== id);
    try {
      rmSync(join(this.botWorkspaceDir, "spaces", `${id}.md`), { force: true });
    } catch {
      // Ignore missing space markdown file.
    }
    this.persistState();
  }

  async createGoal(title: string, category: string): Promise<BotGoalItem> {
    const st = await this.ensureLoaded();
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
        summary: `围绕目标「${cleanTitle}」在 Agent 工作台执行深度分析或文件编排`,
        targetCwd: this.botWorkspaceDir,
      },
    };
    st.goals.unshift(created);
    this.recordActivity({ title: `设定长期目标：${cleanTitle}`, description: created.category });
    this.persistState();
    return created;
  }

  async deleteGoal(id: string): Promise<void> {
    const st = await this.ensureLoaded();
    st.goals = st.goals.filter((g) => g.id !== id);
    this.persistState();
  }

  async createFeedItem(title: string, body: string, seedPrompt?: string): Promise<BotFeedItem> {
    const st = await this.ensureLoaded();
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
    this.persistState();
    return item;
  }

  async enableInbox(): Promise<{ inboxEnabled: boolean; inboxAddress: string }> {
    const st = await this.ensureLoaded();
    st.inboxEnabled = true;
    this.recordActivity({ title: "启用专属收件箱", description: st.inboxAddress });
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
    const res = await runVirtualServerAction(st, action, this.botWorkspaceDir, (act) => this.recordActivity(act));
    this.persistState();
    return res;
  }

  async resetAllBotData(): Promise<BotSnapshotResult> {
    const prev = await this.ensureLoaded();
    await this.sessions.delete(prev.mainSessionId).catch(() => false);
    for (const side of prev.sideThreads) {
      await this.sessions.delete(side.sessionId).catch(() => false);
    }
    this.botSessionIds.clear();
    this.state = undefined;
    try {
      rmSync(this.stateFile, { force: true });
    } catch {
      // Ignore
    }
    return this.snapshot();
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

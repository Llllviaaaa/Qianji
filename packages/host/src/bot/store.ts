/**
 * Atomic `<dataDir>/bot/` state store, WSL2/SSH VM orchestration & session coordinator.
 */
import { randomUUID } from "node:crypto";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import type { Context } from "@deepseek-ai/cordis";
import type { Credentials } from "@qianji/llm";
import type {
  BotActivityEntry, BotActivityGetTraceParams, BotActivityGetTraceResult, BotConnectorTestKind,
  BotFeedCreateParams, BotFeedGenerateEditionParams, BotFeedItem, BotFeedToggleLikeParams,
  BotGoalCreateParams, BotGoalItem, BotGoalUpdateParams, BotGoalViewPrefs, BotHandoffCompleteParams,
  BotIdeaItem, BotIdeaSentiment, BotProfile, BotServerActionKind, BotServerActionResult,
  BotSideChatUpdateParams, BotSideThreadInfo, BotSnapshotResult, BotSpaceSummary,
  PendingBotApproval, ResolvedBotApproval,
} from "@qianji/protocol";
import type { Schedule, ScheduledRun } from "@qianji/schedule";
import type { ModelRef, Session, Sessions } from "@qianji/session";
import type { ToolCall, ToolEnv, ToolOutput } from "@qianji/tools";
import { ConnectorHub, type ConnectorDelta, type ConnectorSecrets } from "./connectors/connector-hub.ts";
import { VirtualComputerManager } from "./computer/manager.ts";
import { ensureComputerStudioState } from "./computer/timeline-and-takeover.ts";
import { buildDefaultAwareness, buildDefaultConnectorsConfig, normalizeAvatarPreset, type PersistedBotState } from "./defaults.ts";
import { generateFeedEditionForState } from "./harness/bot-feed-edition.ts";
import { BotLiveViewController } from "./live-view.ts";
import { SshRemoteRuntime } from "./ssh-runtime.ts";
import { resolveBotStorageDir, resolveBotWorkspaceDir, syncBotRuntimePaths } from "./storage-paths.ts";
import {
  appendActivityRecord, buildBotSnapshotResult, completeBotHandoffRecord, createSideChatRecord,
  createSpaceRecord, deleteSideChatRecord, deleteSpaceRecord, ensureBotFullAccessPermission,
  ensureMainBotSession, loadOrCreatePersistedBotState, resolveBotApprovalRecord, syncBotSessionsModel,
} from "./store-actions.ts";
import {
  createRichFeedRecord, createRichGoalRecord, deleteFeedRecord, saveFeedInstructionsRecord,
  saveGoalViewPrefsRecord, toggleFeedLikeRecord, updateGoalRecord,
} from "./store-discovery.ts";
import {
  applyIdeaFeedbackRecord, launchIdeaRecord, refreshPersonalizedIdeas, restoreDismissedIdeaRecord,
  upsertPersonalizedIdeas, type IdeaLaunchOutcome, type PersonalizedIdeaDraft,
} from "./store-ideas.ts";
import {
  applyBotProactivePatch, applyConnectorSecretPatch, BotSecretVault, populateConnectorSecretFlags,
  readConnectorSecrets, readPersistedAppConnectedSync, seedPersistedBotSessionIds, type BotProactivePatch,
} from "./store-proactive.ts";
import {
  bridgeScheduledRunToBotState, buildBotActivityTrace, isUntitledSideChatTitle, normalizeBotPath,
  recordSettledBotTurn, recordTurnProgressInState, updateSideChatRecord, type TurnRecordOptions,
} from "./store-threads.ts";
import { applyVirtualServerPatch, refreshLiveLocalMetrics, runVirtualServerAction, type ServerRuntimeDeps, type VirtualServerPatch } from "./virtual-server.ts";
import { applyBotConfigOverlay, readBotMemoryFile, readBotSoulFile, readFileMtimeShortDate, writeBotSoulFile, writeFileAtomic, type BotStoreConfig } from "./workspace-scanner.ts";
import { WslContainerRuntime } from "./wsl-runtime.ts";

export type { BotStoreConfig };

const REMOTE_SECRET_ID = "bot/remote-ssh-password";
const AUTO_SLEEP_IDLE_MS = 15 * 60_000;

export class BotStateStore {
  readonly botDir: string;
  readonly stateFile: string;
  readonly soulFile: string;
  readonly memoryFile: string;
  readonly wsl: WslContainerRuntime;
  readonly ssh: SshRemoteRuntime;
  readonly liveView: BotLiveViewController;
  readonly computer: VirtualComputerManager;
  readonly connectorsHub: ConnectorHub;
  readonly vault: BotSecretVault;

  private state: PersistedBotState | undefined;
  private readonly botSessionIds = new Set<string>();
  private readonly pendingCommands = new Map<string, string>();
  private lastVmActivityAt = Date.now();
  private activeVmExecCount = 0;

  constructor(
    private readonly sessions: Sessions,
    private config: BotStoreConfig,
    credentials?: Credentials,
  ) {
    this.botDir = join(config.dataDir, "bot");
    this.stateFile = join(this.botDir, "state.json");
    this.soulFile = join(this.botDir, "SOUL.md");
    this.memoryFile = join(config.dataDir, "memory.md");
    mkdirSync(this.botDir, { recursive: true });
    mkdirSync(this.botStorageDir, { recursive: true });
    mkdirSync(this.botWorkspaceDir, { recursive: true });
    seedPersistedBotSessionIds(this.stateFile, this.botSessionIds);

    this.vault = new BotSecretVault(credentials);
    this.connectorsHub = new ConnectorHub(config.processProbe);
    this.wsl = new WslContainerRuntime({ dataDir: config.dataDir, botDir: this.botStorageDir, botWorkspaceDir: this.botWorkspaceDir, distroName: config.distroName, wslSupported: config.wslSupported });
    this.ssh = new SshRemoteRuntime();
    this.liveView = new BotLiveViewController({
      botDir: this.botStorageDir, botWorkspaceDir: this.botWorkspaceDir,
      wsl: this.wsl, ssh: this.ssh, getRemotePassword: () => this.getRemotePassword(),
      browserFactory: config.browserFactory,
    });
    this.computer = new VirtualComputerManager({
      ensureLoaded: () => this.ensureLoaded(), persist: () => this.persistState(),
      getBotStorageDir: () => this.botStorageDir, getBotWorkspaceDir: () => this.botWorkspaceDir,
      getComputerHelperPath: () => this.config.computerHelperPath ?? process.env.QIANJI_COMPUTER_HELPER ?? process.env.PID_COMPUTER_HELPER,
      customHelperInvoker: config.computerHelperInvoker, wsl: this.wsl, ssh: this.ssh, liveView: this.liveView,
      vault: this.vault, getSoul: () => this.readSoul(), getMemory: () => this.readMemory(),
    });
  }

  get botStorageDir(): string {
    return resolveBotStorageDir(this.config.dataDir, this.state?.virtualServer.local.customStorageDir ?? this.config.storageDir);
  }
  get botWorkspaceDir(): string {
    return resolveBotWorkspaceDir(this.config.dataDir, this.state?.customWorkspaceDir ?? this.config.workspaceDir, this.state?.virtualServer.local.customStorageDir ?? this.config.storageDir);
  }
  private getServerDeps(): ServerRuntimeDeps {
    return {
      botDir: this.botDir, botStorageDir: this.botStorageDir, botWorkspaceDir: this.botWorkspaceDir,
      customStorageDir: this.state?.virtualServer.local.customStorageDir ?? this.config.storageDir ?? "",
      wsl: this.wsl, ssh: this.ssh, getSoul: () => this.readSoul(), getMemory: () => this.readMemory(),
      getRemotePassword: () => this.getRemotePassword(), hasRemotePassword: () => this.hasRemotePassword(),
    };
  }

  setRemotePassword(pw: string | undefined): Promise<void> { return this.vault.set(REMOTE_SECRET_ID, pw); }
  getRemotePassword(): Promise<string | undefined> { return this.vault.get(REMOTE_SECRET_ID); }
  hasRemotePassword(): Promise<boolean> { return this.vault.has(REMOTE_SECRET_ID); }
  getConnectorSecrets(): Promise<ConnectorSecrets> { return readConnectorSecrets(this.vault); }
  persist(): void { this.persistState(); }
  isBotSession(sessionId: string): boolean {
    if (this.botSessionIds.has(sessionId)) return true;
    const opened = this.sessions.peek(sessionId);
    if (opened !== undefined && this.matchesBotWorkspace(opened.header.cwd)) {
      this.botSessionIds.add(sessionId);
      return true;
    }
    return false;
  }
  registerBotSession(sessionId: string): void { if (sessionId) this.botSessionIds.add(sessionId); }
  matchesBotWorkspace(cwd?: string): boolean { return Boolean(cwd && normalizeBotPath(cwd) === normalizeBotPath(this.botWorkspaceDir)); }
  readSoul(): string { return readBotSoulFile(this.soulFile); }
  readMemory(): string { return readBotMemoryFile(this.memoryFile); }
  resolvePrimaryModel(st: PersistedBotState): ModelRef | undefined {
    const chosen = st.modelConfig?.primary ?? this.config.defaultModel?.();
    return chosen?.provider && chosen?.model ? { provider: chosen.provider, model: chosen.model } : undefined;
  }

  private async syncRuntimePaths(st: PersistedBotState, prevWs: string, prevStorage: string, migrateFiles = true): Promise<void> {
    await syncBotRuntimePaths({
      sessions: this.sessions, st, prevWorkspaceDir: prevWs, nextWorkspaceDir: this.botWorkspaceDir,
      prevStorageDir: prevStorage, nextStorageDir: this.botStorageDir, migrateFiles,
      botSessionIds: this.botSessionIds,
      resolveModel: () => st.modelConfig?.primary ?? this.config.defaultModel?.(),
      ensureFullAccess: ensureBotFullAccessPermission,
      relocateStorage: (s, w) => this.wsl.relocateStorage(s, w),
      setWslPaths: (n) => this.wsl.setPaths(n),
      setLiveViewPaths: (n) => this.liveView.setPaths(n),
    });
  }

  updateConfig(next: Partial<BotStoreConfig>): void {
    const prevWs = this.botWorkspaceDir;
    const prevStorage = this.botStorageDir;
    this.config = { ...this.config, ...next };
    if (this.state !== undefined) {
      const st = this.state;
      applyBotConfigOverlay(st, this.config);
      void this.syncRuntimePaths(st, prevWs, prevStorage)
        .then(async () => {
          const target = this.resolvePrimaryModel(st);
          if (target) {
            const mainSess = await this.sessions.get(st.mainSessionId).catch(() => undefined);
            if (mainSess && (mainSess.state().model?.provider !== target.provider || mainSess.state().model?.model !== target.model)) {
              mainSess.setModel(target);
            }
          }
          this.persistState();
        })
        .catch(() => undefined);
    }
  }

  saveSoul(content: string): { content: string; updatedAt: string } {
    const res = writeBotSoulFile(this.soulFile, content);
    if (this.state !== undefined) {
      this.state.soulUpdatedAt = res.updatedAt;
      this.persistState();
    }
    return res;
  }

  isAppPolicyConnectedSync(connectorId: string): boolean {
    return this.state !== undefined
      ? this.state.connectorConfigs?.appPolicies?.[connectorId]?.connected === true
      : readPersistedAppConnectedSync(this.stateFile, connectorId);
  }

  private persistState(): void {
    if (this.state !== undefined) writeFileAtomic(this.stateFile, `${JSON.stringify(this.state, null, 2)}\n`);
  }

  async ensureLoaded(): Promise<PersistedBotState> {
    if (this.state !== undefined) {
      const st = this.state;
      const mainSess = await ensureMainBotSession(
        this.sessions, this.botWorkspaceDir, this.botSessionIds, st.mainSessionId,
        () => st.modelConfig?.primary ?? this.config.defaultModel?.(),
      );
      if (st.mainSessionId !== mainSess.id) {
        st.mainSessionId = mainSess.id;
        this.persistState();
      }
      return st;
    }

    this.readSoul();
    const loaded = await loadOrCreatePersistedBotState({
      stateFile: this.stateFile, sessions: this.sessions, botWorkspaceDir: this.botWorkspaceDir,
      botSessionIds: this.botSessionIds, config: this.config,
    });
    this.state = loaded;
    await this.syncRuntimePaths(loaded, this.botWorkspaceDir, this.botStorageDir, false);
    this.persistState();
    return loaded;
  }

  async snapshot(): Promise<BotSnapshotResult> {
    const st = await this.ensureLoaded();
    await refreshLiveLocalMetrics(st, this.getServerDeps());
    const cs = ensureComputerStudioState(st);
    cs.remoteNodes = await this.computer.remoteNodes.syncLegacyRemoteWithNodes(st.virtualServer, cs.remoteNodes);
    const computerStudio = this.computer.buildEmbeddedSnapshot(st);
    this.connectorsHub.ensureConfig(st);
    const cfg = st.connectorConfigs ?? buildDefaultConnectorsConfig();
    await populateConnectorSecretFlags(this.vault, cfg);
    if (!st.awareness) st.awareness = buildDefaultAwareness();
    return buildBotSnapshotResult({
      st, botWorkspaceDir: this.botWorkspaceDir, memoryFile: this.memoryFile,
      soulContent: this.readSoul(), memoryUpdatedAt: readFileMtimeShortDate(this.memoryFile),
      computerStudio,
    });
  }

  async configureProactive(patch: BotProactivePatch): Promise<BotSnapshotResult> {
    const st = await this.ensureLoaded();
    const prevWs = this.botWorkspaceDir;
    const prevStorage = this.botStorageDir;
    await applyConnectorSecretPatch(this.vault, patch);
    if (typeof patch.workspaceDir === "string" && patch.workspaceDir.trim() === "") {
      this.config = { ...this.config, workspaceDir: undefined };
    }
    applyBotProactivePatch(st, patch);
    await this.syncRuntimePaths(st, prevWs, prevStorage);
    await syncBotSessionsModel(this.sessions, st, this.resolvePrimaryModel(st), patch.modelConfig !== undefined);
    this.persistState();
    return this.snapshot();
  }

  async testConnector(kind: BotConnectorTestKind): Promise<{ ok: boolean; message: string; snapshot: BotSnapshotResult }> {
    const st = await this.ensureLoaded();
    const res = await this.connectorsHub.testConnector(kind, st, await this.getConnectorSecrets());
    this.persistState();
    return { ...res, snapshot: await this.snapshot() };
  }

  async collectConnectorDelta(nowMs = Date.now()): Promise<ConnectorDelta> {
    const st = await this.ensureLoaded();
    return this.connectorsHub.collectDelta(st, await this.getConnectorSecrets(), nowMs);
  }

  async executeToolInVm(call: ToolCall, env: ToolEnv): Promise<ToolOutput | undefined> {
    if (!this.isBotSession(env.sessionId)) return undefined;
    const st = await this.ensureLoaded();
    this.lastVmActivityAt = Date.now();
    this.activeVmExecCount += 1;
    try {
      return await this.computer.executeBotTool(call, env, st);
    } finally {
      this.activeVmExecCount = Math.max(0, this.activeVmExecCount - 1);
      this.lastVmActivityAt = Date.now();
    }
  }

  async recordFallbackBotTool(call: ToolCall, out: ToolOutput): Promise<void> {
    const st = await this.ensureLoaded();
    if (this.computer.tracker.recordToolCall(st, call, out)) this.persistState();
  }

  async checkIdleAutoSleep(): Promise<boolean> {
    if (this.state === undefined || this.activeVmExecCount > 0) return false;
    const vs = this.state.virtualServer;
    if (vs.mode !== "local" || !vs.local.autoSleepIdle || !this.wsl.isSupported() || vs.local.engineState !== "running") return false;
    if (Date.now() - this.lastVmActivityAt < AUTO_SLEEP_IDLE_MS) return false;
    await this.performServerAction("sleep");
    return true;
  }

  async recordTurnProgress(session: Session, options?: TurnRecordOptions): Promise<BotActivityEntry | undefined> {
    const entry = recordTurnProgressInState(await this.ensureLoaded(), session, options);
    this.persistState(); return entry;
  }
  async recordSettledTurn(session: Session, options?: TurnRecordOptions): Promise<BotActivityEntry | undefined> {
    const entry = recordSettledBotTurn(await this.ensureLoaded(), session, options);
    this.persistState(); return entry;
  }
  async updateProfile(patch: Partial<BotProfile>): Promise<BotProfile> {
    const st = await this.ensureLoaded();
    if (typeof patch.displayName === "string" && patch.displayName.trim() !== "") st.profile.displayName = patch.displayName.trim();
    if (patch.avatarPreset !== undefined) st.profile.avatarPreset = normalizeAvatarPreset(patch.avatarPreset);
    if (patch.customAvatarDataUrl !== undefined) st.profile.customAvatarDataUrl = patch.customAvatarDataUrl;
    this.persistState(); return st.profile;
  }
  async createSideChat(title?: string): Promise<BotSideThreadInfo> {
    const st = await this.ensureLoaded();
    const info = createSideChatRecord({
      sessions: this.sessions, st, botWorkspaceDir: this.botWorkspaceDir, botSessionIds: this.botSessionIds,
      defaultModel: st.modelConfig?.primary ?? this.config.defaultModel?.(), title,
    });
    if (title !== undefined && title.trim() !== "" && !isUntitledSideChatTitle(title)) info.userRenamed = true;
    this.persistState(); return info;
  }
  async updateSideChat(params: BotSideChatUpdateParams): Promise<BotSideThreadInfo | null> {
    const updated = await updateSideChatRecord(this.sessions, await this.ensureLoaded(), params);
    if (updated !== null) this.persistState();
    return updated;
  }
  async deleteSideChat(id: string): Promise<void> {
    await deleteSideChatRecord(this.sessions, await this.ensureLoaded(), this.botSessionIds, id); this.persistState();
  }
  async getActivityTrace(params: BotActivityGetTraceParams): Promise<BotActivityGetTraceResult> {
    return buildBotActivityTrace({ sessions: this.sessions, st: await this.ensureLoaded(), botWorkspaceDir: this.botWorkspaceDir, activityId: params.activityId, sessionId: params.sessionId });
  }
  async recordScheduledRun(run: ScheduledRun, taskCwd?: string, taskScope?: string): Promise<boolean> {
    const bridged = await bridgeScheduledRunToBotState({ sessions: this.sessions, st: await this.ensureLoaded(), botSessionIds: this.botSessionIds, botWorkspaceDir: this.botWorkspaceDir, run, taskCwd, taskScope });
    if (bridged) this.persistState();
    return bridged;
  }

  async enqueueApproval(entry: Omit<PendingBotApproval, "id" | "createdAt" | "expiresAt">, rawCommand?: string): Promise<PendingBotApproval> {
    const st = await this.ensureLoaded();
    const now = Date.now();
    const created: PendingBotApproval = { id: `apr-${randomUUID().slice(0, 8)}`, createdAt: now, expiresAt: now + 86_400_000 * 3, ...entry };
    if (rawCommand) this.pendingCommands.set(created.id, rawCommand);
    st.pendingApprovals.unshift(created);
    this.persistState();
    return created;
  }
  async resolveApproval(id: string, decision: "approved" | "denied"): Promise<ResolvedBotApproval> {
    const st = await this.ensureLoaded();
    const secrets = await this.getConnectorSecrets();
    const resolved = await resolveBotApprovalRecord({
      st, id, decision, rawCmd: this.pendingCommands.get(id), botWorkspaceDir: this.botWorkspaceDir,
      wsl: this.wsl, ssh: this.ssh, getRemotePassword: () => this.getRemotePassword(),
      executeOutbound: (approval) => this.connectorsHub.executeApprovedOutbound(approval, st, secrets),
    });
    this.pendingCommands.delete(id);
    this.persistState();
    return resolved;
  }
  async createSpace(title: string, description?: string): Promise<BotSpaceSummary> {
    const created = createSpaceRecord(await this.ensureLoaded(), this.botWorkspaceDir, title, description);
    this.persistState(); return created;
  }
  async deleteSpace(id: string): Promise<void> {
    deleteSpaceRecord(await this.ensureLoaded(), this.botWorkspaceDir, id); this.persistState();
  }
  async createGoal(
    titleOrParams: string | BotGoalCreateParams,
    category = "通用",
    options?: { recordActivity?: boolean },
  ): Promise<BotGoalItem> {
    const created = createRichGoalRecord(
      await this.ensureLoaded(),
      this.botWorkspaceDir,
      typeof titleOrParams === "string" ? { title: titleOrParams, category } : titleOrParams,
      options,
    );
    this.persistState(); return created;
  }
  async updateGoal(params: BotGoalUpdateParams): Promise<BotGoalItem | null> {
    const updated = updateGoalRecord(await this.ensureLoaded(), params);
    if (updated !== null) this.persistState();
    return updated;
  }
  async deleteGoal(id: string): Promise<void> {
    const st = await this.ensureLoaded();
    st.goals = st.goals.filter((g) => g.id !== id); this.persistState();
  }
  async saveGoalPrefs(patch: Partial<BotGoalViewPrefs>): Promise<BotGoalViewPrefs> {
    const prefs = saveGoalViewPrefsRecord(await this.ensureLoaded(), patch);
    this.persistState(); return prefs;
  }
  async createFeedItem(titleOrParams: string | BotFeedCreateParams, body = "", seedPrompt?: string): Promise<BotFeedItem> {
    const item = createRichFeedRecord(await this.ensureLoaded(), typeof titleOrParams === "string" ? { title: titleOrParams, body, seedPrompt } : titleOrParams);
    this.persistState(); return item;
  }
  async generateFeedEdition(params?: BotFeedGenerateEditionParams & { ctx?: Context; fetchFn?: typeof fetch; nowMs?: number }): Promise<BotFeedItem[]> {
    const st = await this.ensureLoaded();
    const items = await generateFeedEditionForState({
      st, ctx: params?.ctx, sessions: this.sessions, memoryMarkdown: this.readMemory(),
      model: st.modelConfig?.patrol ?? st.modelConfig?.primary ?? this.config.defaultModel?.(),
      editionKind: params?.editionKind, force: params?.force, fetchFn: params?.fetchFn, nowMs: params?.nowMs,
    });
    if (items.length > 0) this.persistState();
    return items;
  }
  async toggleFeedLike(params: BotFeedToggleLikeParams): Promise<BotFeedItem | null> {
    const item = toggleFeedLikeRecord(await this.ensureLoaded(), this.memoryFile, params);
    if (item !== null) this.persistState();
    return item;
  }
  async deleteFeedItem(id: string): Promise<boolean> {
    const removed = deleteFeedRecord(await this.ensureLoaded(), id);
    if (removed) this.persistState();
    return removed;
  }
  async saveFeedInstructions(instructions: string): Promise<string> {
    const saved = saveFeedInstructionsRecord(await this.ensureLoaded(), instructions);
    this.persistState(); return saved;
  }
  async proposeIdeas(drafts: readonly PersonalizedIdeaDraft[]): Promise<BotIdeaItem[]> {
    const added = upsertPersonalizedIdeas(await this.ensureLoaded(), drafts);
    if (added.length > 0) this.persistState();
    return added;
  }
  async feedbackIdea(id: string, sentiment: BotIdeaSentiment, ctx?: Context, model?: ModelRef): Promise<{ generated: BotIdeaItem[] }> {
    const st = await this.ensureLoaded();
    const res = await applyIdeaFeedbackRecord({ ctx, st, memoryFile: this.memoryFile, model: model ?? st.modelConfig?.patrol ?? st.modelConfig?.primary, id, sentiment });
    this.persistState(); return res;
  }
  async restoreIdea(id: string): Promise<boolean> {
    const restored = restoreDismissedIdeaRecord(await this.ensureLoaded(), id);
    if (restored) this.persistState();
    return restored;
  }
  async launchIdea(id: string, scheduleSvc?: Schedule): Promise<IdeaLaunchOutcome> {
    const out = launchIdeaRecord({ st: await this.ensureLoaded(), botWorkspaceDir: this.botWorkspaceDir, id, scheduleSvc });
    if (out.idea !== null) this.persistState();
    return out;
  }
  async refreshIdeas(ctx?: Context, model?: ModelRef): Promise<BotIdeaItem[]> {
    const st = await this.ensureLoaded();
    const added = await refreshPersonalizedIdeas({ ctx, st, sessions: this.sessions, model: model ?? st.modelConfig?.patrol ?? st.modelConfig?.primary });
    if (added.length > 0) this.persistState();
    return added;
  }
  async enableInbox(): Promise<{ inboxEnabled: boolean; inboxAddress: string }> {
    const st = await this.ensureLoaded(); st.inboxEnabled = true;
    appendActivityRecord(st, { title: "启用专属收件箱", description: st.inboxAddress });
    this.persistState(); return { inboxEnabled: true, inboxAddress: st.inboxAddress };
  }
  async toggleConnector(id: string): Promise<void> {
    const st = await this.ensureLoaded();
    const target = st.connectors.find((item) => item.id === id);
    if (target !== undefined) { target.enabled = !target.enabled; this.persistState(); }
  }
  async configureVirtualServer(patch: VirtualServerPatch): Promise<BotSnapshotResult["virtualServer"]> {
    const st = await this.ensureLoaded();
    const prevWs = this.botWorkspaceDir;
    const prevStorage = this.botStorageDir;
    if (typeof patch.storageDir === "string" && patch.storageDir.trim() === "") this.config = { ...this.config, storageDir: undefined };
    applyVirtualServerPatch(st, patch, this.botWorkspaceDir);
    await this.syncRuntimePaths(st, prevWs, prevStorage);
    await refreshLiveLocalMetrics(st, this.getServerDeps(), true);
    const cs = ensureComputerStudioState(st);
    cs.remoteNodes = await this.computer.remoteNodes.syncLegacyRemoteWithNodes(st.virtualServer, cs.remoteNodes);
    st.virtualServer.computerStudio = this.computer.buildEmbeddedSnapshot(st);
    this.persistState();
    return st.virtualServer;
  }
  async performServerAction(action: BotServerActionKind): Promise<BotServerActionResult> {
    const st = await this.ensureLoaded();
    const res = await runVirtualServerAction(st, action, this.getServerDeps(), (act) => appendActivityRecord(st, act));
    const cs = ensureComputerStudioState(st);
    cs.remoteNodes = await this.computer.remoteNodes.syncLegacyRemoteWithNodes(st.virtualServer, cs.remoteNodes);
    st.virtualServer.computerStudio = this.computer.buildEmbeddedSnapshot(st);
    this.persistState();
    return res;
  }
  async resetAllBotData(): Promise<BotSnapshotResult> {
    const prev = await this.ensureLoaded();
    this.computer.dispose();
    await this.sessions.delete(prev.mainSessionId).catch(() => false);
    for (const side of prev.sideThreads) await this.sessions.delete(side.sessionId).catch(() => false);
    this.botSessionIds.clear();
    this.state = undefined;
    try { rmSync(this.stateFile, { force: true }); } catch { /* Ignore */ }
    return this.snapshot();
  }
  async completeHandoff(params: BotHandoffCompleteParams): Promise<BotActivityEntry> {
    const activity = await completeBotHandoffRecord(this.sessions, await this.ensureLoaded(), params);
    this.persistState();
    return activity;
  }
}

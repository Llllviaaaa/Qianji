/**
 * Atomic `<dataDir>/bot/` state store, WSL2/SSH VM orchestration & session coordinator.
 */
import { randomUUID } from "node:crypto";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import type { Credentials } from "@qianji/llm";
import type {
  BotActivityEntry,
  BotFeedItem,
  BotGoalItem,
  BotHandoffCompleteParams,
  BotProfile,
  BotServerActionKind,
  BotServerActionResult,
  BotSideThreadInfo,
  BotSnapshotResult,
  BotSpaceSummary,
  PendingBotApproval,
  ResolvedBotApproval,
} from "@qianji/protocol";
import type { Session, Sessions } from "@qianji/session";
import type { ToolCall, ToolEnv, ToolOutput } from "@qianji/tools";
import { ConnectorHub, type ConnectorDelta, type ConnectorSecrets } from "./connectors/connector-hub.ts";
import {
  buildDefaultAwareness,
  buildDefaultConnectorsConfig,
  formatClock,
  normalizeAvatarPreset,
  type PersistedBotState,
} from "./defaults.ts";
import { BOT_BROWSER_TOOLS, BotLiveViewController } from "./live-view.ts";
import { SshRemoteRuntime } from "./ssh-runtime.ts";
import {
  appendActivityRecord,
  buildBotSnapshotResult,
  createFeedRecord,
  createGoalRecord,
  createSpaceRecord,
  deleteSpaceRecord,
  ensureBotFullAccessPermission,
  ensureMainBotSession,
  loadOrCreatePersistedBotState,
  resolveBotApprovalRecord,
} from "./store-actions.ts";
import {
  applyBotProactivePatch,
  BotSecretVault,
  EMAIL_SECRET_ID,
  FEISHU_SECRET_ID,
  TELEGRAM_SECRET_ID,
  type BotProactivePatch,
} from "./store-proactive.ts";
import {
  applyVirtualServerPatch,
  refreshLiveLocalMetrics,
  runVirtualServerAction,
  type ServerRuntimeDeps,
  type VirtualServerPatch,
} from "./virtual-server.ts";
import { executeBotToolInVm, VM_BRIDGED_TOOLS } from "./vm-tool-bridge.ts";
import {
  applyBotConfigOverlay,
  readBotMemoryFile,
  readBotSoulFile,
  readFileMtimeShortDate,
  writeBotSoulFile,
  writeFileAtomic,
  type BotStoreConfig,
} from "./workspace-scanner.ts";
import { WslContainerRuntime } from "./wsl-runtime.ts";

export type { BotStoreConfig };

const ZERO_USAGE = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };
const SYNTHETIC_BOT_MODEL = { provider: "qianji", model: "bot-companion" };
const REMOTE_SECRET_ID = "bot/remote-ssh-password";
const AUTO_SLEEP_IDLE_MS = 15 * 60_000;

export class BotStateStore {
  readonly botDir: string;
  readonly botWorkspaceDir: string;
  readonly stateFile: string;
  readonly soulFile: string;
  readonly memoryFile: string;
  readonly wsl: WslContainerRuntime;
  readonly ssh: SshRemoteRuntime;
  readonly liveView: BotLiveViewController;
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
    this.botWorkspaceDir = join(config.dataDir, "bot-workspace");
    this.stateFile = join(this.botDir, "state.json");
    this.soulFile = join(this.botDir, "SOUL.md");
    this.memoryFile = join(config.dataDir, "memory.md");
    mkdirSync(this.botDir, { recursive: true });
    mkdirSync(this.botWorkspaceDir, { recursive: true });

    this.vault = new BotSecretVault(credentials);
    this.connectorsHub = new ConnectorHub(config.processProbe);
    this.wsl = new WslContainerRuntime({
      dataDir: config.dataDir,
      botDir: this.botDir,
      botWorkspaceDir: this.botWorkspaceDir,
      distroName: config.distroName,
    });
    this.ssh = new SshRemoteRuntime();
    this.liveView = new BotLiveViewController({
      botDir: this.botDir,
      botWorkspaceDir: this.botWorkspaceDir,
      wsl: this.wsl,
      ssh: this.ssh,
      getRemotePassword: () => this.getRemotePassword(),
    });
  }

  private getServerDeps(): ServerRuntimeDeps {
    return {
      botDir: this.botDir,
      botWorkspaceDir: this.botWorkspaceDir,
      wsl: this.wsl,
      ssh: this.ssh,
      getSoul: () => this.readSoul(),
      getMemory: () => this.readMemory(),
      getRemotePassword: () => this.getRemotePassword(),
      hasRemotePassword: () => this.hasRemotePassword(),
    };
  }

  setRemotePassword(password: string | undefined): Promise<void> {
    return this.vault.set(REMOTE_SECRET_ID, password);
  }

  getRemotePassword(): Promise<string | undefined> {
    return this.vault.get(REMOTE_SECRET_ID);
  }

  hasRemotePassword(): Promise<boolean> {
    return this.vault.has(REMOTE_SECRET_ID);
  }

  async getConnectorSecrets(): Promise<ConnectorSecrets> {
    const [emailPassword, telegramToken, feishuWebhook] = await Promise.all([
      this.vault.get(EMAIL_SECRET_ID),
      this.vault.get(TELEGRAM_SECRET_ID),
      this.vault.get(FEISHU_SECRET_ID),
    ]);
    return { emailPassword, telegramToken, feishuWebhook };
  }

  persist(): void {
    this.persistState();
  }

  updateConfig(next: Partial<BotStoreConfig>): void {
    this.config = { ...this.config, ...next };
    if (this.state !== undefined) {
      applyBotConfigOverlay(this.state, this.config);
      this.persistState();
    }
  }

  isBotSession(sessionId: string): boolean {
    return this.botSessionIds.has(sessionId);
  }

  readSoul(): string {
    return readBotSoulFile(this.soulFile);
  }

  readMemory(): string {
    return readBotMemoryFile(this.memoryFile);
  }

  saveSoul(content: string): { content: string; updatedAt: string } {
    const res = writeBotSoulFile(this.soulFile, content);
    if (this.state !== undefined) {
      this.state.soulUpdatedAt = res.updatedAt;
      this.persistState();
    }
    return res;
  }

  private memoryUpdatedAtLabel(): string {
    return readFileMtimeShortDate(this.memoryFile);
  }

  private persistState(): void {
    if (this.state === undefined) return;
    writeFileAtomic(this.stateFile, `${JSON.stringify(this.state, null, 2)}\n`);
  }

  async ensureLoaded(): Promise<PersistedBotState> {
    if (this.state !== undefined) {
      const mainSess = await ensureMainBotSession(
        this.sessions,
        this.botWorkspaceDir,
        this.botSessionIds,
        this.state.mainSessionId,
      );
      if (this.state.mainSessionId !== mainSess.id) {
        this.state.mainSessionId = mainSess.id;
        this.persistState();
      }
      return this.state;
    }

    this.readSoul();
    const loaded = await loadOrCreatePersistedBotState({
      stateFile: this.stateFile,
      sessions: this.sessions,
      botWorkspaceDir: this.botWorkspaceDir,
      botSessionIds: this.botSessionIds,
      config: this.config,
    });
    this.state = loaded;
    this.persistState();
    return loaded;
  }

  async snapshot(): Promise<BotSnapshotResult> {
    const st = await this.ensureLoaded();
    await refreshLiveLocalMetrics(st, this.getServerDeps());
    this.connectorsHub.ensureConfig(st);
    const cfg = st.connectorConfigs ?? buildDefaultConnectorsConfig();
    cfg.email.hasPassword = await this.vault.has(EMAIL_SECRET_ID);
    cfg.meetingsIm.hasTelegramToken = await this.vault.has(TELEGRAM_SECRET_ID);
    cfg.meetingsIm.hasFeishuWebhook = await this.vault.has(FEISHU_SECRET_ID);
    if (!st.awareness) st.awareness = buildDefaultAwareness();
    return buildBotSnapshotResult({
      st,
      botWorkspaceDir: this.botWorkspaceDir,
      memoryFile: this.memoryFile,
      soulContent: this.readSoul(),
      memoryUpdatedAt: this.memoryUpdatedAtLabel(),
    });
  }

  async configureProactive(patch: BotProactivePatch): Promise<BotSnapshotResult> {
    const st = await this.ensureLoaded();
    if (typeof patch.email?.password === "string") await this.vault.set(EMAIL_SECRET_ID, patch.email.password);
    if (typeof patch.meetingsIm?.telegramToken === "string") await this.vault.set(TELEGRAM_SECRET_ID, patch.meetingsIm.telegramToken);
    if (typeof patch.meetingsIm?.feishuWebhook === "string") await this.vault.set(FEISHU_SECRET_ID, patch.meetingsIm.feishuWebhook);
    applyBotProactivePatch(st, patch);
    const primary = st.modelConfig?.primary;
    if (primary?.provider && primary?.model) {
      const mainSess = await this.sessions.get(st.mainSessionId).catch(() => undefined);
      mainSess?.setModel({ provider: primary.provider, model: primary.model });
    }
    this.persistState();
    return this.snapshot();
  }

  async testConnector(kind: "email" | "calendar" | "processes" | "meetings_im"): Promise<{ ok: boolean; message: string; snapshot: BotSnapshotResult }> {
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
    if (BOT_BROWSER_TOOLS.has(call.name)) return this.liveView.executeBrowserTool(call);
    if (!VM_BRIDGED_TOOLS.has(call.name)) return undefined;
    if (st.virtualServer.mode === "local" && !this.wsl.isSupported()) return undefined;

    this.activeVmExecCount += 1;
    try {
      return await executeBotToolInVm(call, env, {
        status: st.virtualServer,
        hostWorkspaceDir: this.botWorkspaceDir,
        wsl: this.wsl,
        ssh: this.ssh,
        getRemotePassword: () => this.getRemotePassword(),
      });
    } finally {
      this.activeVmExecCount = Math.max(0, this.activeVmExecCount - 1);
      this.lastVmActivityAt = Date.now();
    }
  }

  async checkIdleAutoSleep(): Promise<boolean> {
    if (this.state === undefined || this.activeVmExecCount > 0) return false;
    const vs = this.state.virtualServer;
    if (vs.mode !== "local" || !vs.local.autoSleepIdle || !this.wsl.isSupported()) return false;
    if (vs.local.engineState !== "running") return false;
    if (Date.now() - this.lastVmActivityAt < AUTO_SLEEP_IDLE_MS) return false;
    await this.performServerAction("sleep");
    return true;
  }

  async recordSettledTurn(session: Session): Promise<void> {
    const st = await this.ensureLoaded();
    const isMain = session.id === st.mainSessionId;
    const side = st.sideThreads.find((t) => t.sessionId === session.id);
    if (side !== undefined) side.updatedAt = Date.now();
    appendActivityRecord(st, {
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
    if (patch.avatarPreset !== undefined) st.profile.avatarPreset = normalizeAvatarPreset(patch.avatarPreset);
    if (patch.customAvatarDataUrl !== undefined) st.profile.customAvatarDataUrl = patch.customAvatarDataUrl;
    this.persistState();
    return st.profile;
  }

  async createSideChat(title?: string): Promise<BotSideThreadInfo> {
    const st = await this.ensureLoaded();
    const session = this.sessions.create({ cwd: this.botWorkspaceDir, side: true });
    ensureBotFullAccessPermission(session);
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
    const rawCmd = this.pendingCommands.get(id);
    const secrets = await this.getConnectorSecrets();
    const resolved = await resolveBotApprovalRecord({
      st,
      id,
      decision,
      rawCmd,
      botWorkspaceDir: this.botWorkspaceDir,
      wsl: this.wsl,
      ssh: this.ssh,
      getRemotePassword: () => this.getRemotePassword(),
      executeOutbound: (approval) => this.connectorsHub.executeApprovedOutbound(approval, st, secrets),
    });
    this.pendingCommands.delete(id);
    this.persistState();
    return resolved;
  }

  async createSpace(title: string, description?: string): Promise<BotSpaceSummary> {
    const st = await this.ensureLoaded();
    const created = createSpaceRecord(st, this.botWorkspaceDir, title, description);
    this.persistState();
    return created;
  }

  async deleteSpace(id: string): Promise<void> {
    const st = await this.ensureLoaded();
    deleteSpaceRecord(st, this.botWorkspaceDir, id);
    this.persistState();
  }

  async createGoal(title: string, category: string): Promise<BotGoalItem> {
    const st = await this.ensureLoaded();
    const created = createGoalRecord(st, this.botWorkspaceDir, title, category);
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
    const item = createFeedRecord(st, title, body, seedPrompt);
    this.persistState();
    return item;
  }

  async enableInbox(): Promise<{ inboxEnabled: boolean; inboxAddress: string }> {
    const st = await this.ensureLoaded();
    st.inboxEnabled = true;
    appendActivityRecord(st, { title: "启用专属收件箱", description: st.inboxAddress });
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
    applyVirtualServerPatch(st, patch, this.botWorkspaceDir);
    await refreshLiveLocalMetrics(st, this.getServerDeps(), true);
    this.persistState();
    return st.virtualServer;
  }

  async performServerAction(action: BotServerActionKind): Promise<BotServerActionResult> {
    const st = await this.ensureLoaded();
    const res = await runVirtualServerAction(st, action, this.getServerDeps(), (act) => appendActivityRecord(st, act));
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
      mainSession.append("assistant", { content: [{ type: "text", text: `Agent 工作台已完成接力回传：${params.summary}` }], model: SYNTHETIC_BOT_MODEL, usage: ZERO_USAGE, stop: "stop" });
    }
    const activity = appendActivityRecord(st, { title: params.title?.trim() || "完成 Agent 工作台接力回传", description: params.summary });
    this.persistState();
    return activity;
  }
}

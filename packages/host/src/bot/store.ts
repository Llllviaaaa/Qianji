/**
 * Atomic `<dataDir>/bot/` state store, WSL2/SSH VM orchestration & session coordinator.
 */
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, statSync } from "node:fs";
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
import {
  buildDefaultBotState,
  DEFAULT_SOUL_MARKDOWN,
  formatClock,
  formatShortDate,
  MAX_SOUL_BYTES,
  normalizeAvatarPreset,
  STARTER_IDEA_SECTIONS,
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
  resolveBotApprovalRecord,
} from "./store-actions.ts";
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

  private state: PersistedBotState | undefined;
  private readonly botSessionIds = new Set<string>();
  private readonly pendingCommands = new Map<string, string>();
  private inMemoryRemotePassword: string | undefined;
  private lastVmActivityAt = Date.now();
  private activeVmExecCount = 0;

  constructor(
    private readonly sessions: Sessions,
    private config: BotStoreConfig,
    private readonly credentials?: Credentials,
  ) {
    this.botDir = join(config.dataDir, "bot");
    this.botWorkspaceDir = join(config.dataDir, "bot-workspace");
    this.stateFile = join(this.botDir, "state.json");
    this.soulFile = join(this.botDir, "SOUL.md");
    this.memoryFile = join(config.dataDir, "memory.md");
    mkdirSync(this.botDir, { recursive: true });
    mkdirSync(this.botWorkspaceDir, { recursive: true });

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

  async setRemotePassword(password: string | undefined): Promise<void> {
    if (password === undefined) return;
    if (password === "") {
      this.inMemoryRemotePassword = undefined;
      if (this.credentials?.writable) {
        await this.credentials.delete(REMOTE_SECRET_ID).catch(() => false);
      }
      return;
    }
    this.inMemoryRemotePassword = password;
    if (this.credentials?.writable) {
      await this.credentials.set(REMOTE_SECRET_ID, password).catch(() => undefined);
    }
  }

  async getRemotePassword(): Promise<string | undefined> {
    if (this.inMemoryRemotePassword !== undefined) return this.inMemoryRemotePassword;
    if (this.credentials) {
      const secret = await this.credentials.get(REMOTE_SECRET_ID).catch(() => undefined);
      if (secret !== undefined && secret !== "") return secret;
    }
    return undefined;
  }

  async hasRemotePassword(): Promise<boolean> {
    return (await this.getRemotePassword()) !== undefined;
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

  readMemory(): string {
    try {
      return existsSync(this.memoryFile) ? readFileSync(this.memoryFile, "utf8") : "# MEMORY.md\n";
    } catch {
      return "# MEMORY.md\n";
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
      return formatShortDate(statSync(this.memoryFile).mtimeMs);
    } catch {
      return formatShortDate(Date.now());
    }
  }

  private persistState(): void {
    if (this.state === undefined) return;
    writeFileAtomic(this.stateFile, `${JSON.stringify(this.state, null, 2)}\n`);
  }

  async ensureLoaded(): Promise<PersistedBotState> {
    if (this.state !== undefined) {
      let existingMain = await this.sessions.get(this.state.mainSessionId);
      if (existingMain === undefined) {
        existingMain = this.sessions.create({ cwd: this.botWorkspaceDir, side: true });
        existingMain.append("label", { title: "主聊天" });
        this.state.mainSessionId = existingMain.id;
        this.botSessionIds.add(existingMain.id);
        this.persistState();
      }
      ensureBotFullAccessPermission(existingMain);
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
          ensureBotFullAccessPermission(mainSession);
          parsed.ideaSections = STARTER_IDEA_SECTIONS;
          parsed.virtualServer.local.sharedFolders = (parsed.virtualServer.local.sharedFolders ?? []).filter(
            (f) => f.path.toLowerCase() !== this.botWorkspaceDir.toLowerCase(),
          );
          this.botSessionIds.add(parsed.mainSessionId);
          for (const side of parsed.sideThreads ?? []) {
            this.botSessionIds.add(side.sessionId);
            const s = await this.sessions.get(side.sessionId).catch(() => undefined);
            if (s !== undefined) ensureBotFullAccessPermission(s);
          }
          applyBotConfigOverlay(parsed, this.config);
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
    ensureBotFullAccessPermission(mainSession);
    const fresh = buildDefaultBotState({
      mainSessionId: mainSession.id,
      defaultCwd: this.botWorkspaceDir,
      displayName: this.config.displayName,
      avatarPreset: this.config.avatarPreset,
    });
    applyBotConfigOverlay(fresh, this.config);
    this.botSessionIds.add(mainSession.id);
    this.state = fresh;
    this.persistState();
    return fresh;
  }

  async snapshot(): Promise<BotSnapshotResult> {
    const st = await this.ensureLoaded();
    await refreshLiveLocalMetrics(st, this.getServerDeps());
    return buildBotSnapshotResult({
      st,
      botWorkspaceDir: this.botWorkspaceDir,
      memoryFile: this.memoryFile,
      soulContent: this.readSoul(),
      memoryUpdatedAt: this.memoryUpdatedAtLabel(),
    });
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
    this.pendingCommands.delete(id);
    const resolved = await resolveBotApprovalRecord({
      st,
      id,
      decision,
      rawCmd,
      botWorkspaceDir: this.botWorkspaceDir,
      wsl: this.wsl,
      ssh: this.ssh,
      getRemotePassword: () => this.getRemotePassword(),
    });
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

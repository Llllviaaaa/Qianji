/**
 * Wire protocol contracts for Qianji Bot Mode (`@qianji/protocol`).
 *
 * Covers evergreen main chat + side threads, SOUL contract, background approvals,
 * feed/ideas/goals/spaces/library/inbox, Local & Remote Virtual Server management,
 * and cross-mode Agent Workbench handoff.
 */

export type UiShellMode = "agent" | "bot";

export type BotServerMode = "local" | "remote";

export type BotServerLifecycleState = "running" | "sleeping" | "connecting" | "offline";

export type BotAvatarPresetId = "alabaster-felt" | "warm-felt" | "plush-ears" | "custom";

export interface BotProfile {
  displayName: string;
  avatarPreset: BotAvatarPresetId;
  customAvatarDataUrl?: string;
}

export interface BotSideThreadInfo {
  id: string;
  sessionId: string;
  sessionFile: string;
  title: string;
  updatedAt: number;
  snippet?: string;
}

export interface BotTaskHandoffPayload {
  id: string;
  title: string;
  kindLabel: string;
  summary: string;
  targetCwd: string;
  targetSessionFile?: string;
  highlightFile?: string;
  highlightLine?: number;
}

export interface BotActivityEntry {
  id: string;
  dateGroup: string;
  title: string;
  description: string;
  timeLabel: string;
  createdAt: number;
  sessionId?: string;
  handoff?: BotTaskHandoffPayload;
}

export interface BotActivityGroup {
  date: string;
  items: BotActivityEntry[];
}

export interface BotFeedItem {
  id: string;
  title: string;
  timeLabel: string;
  body: string;
  actionLabel: string;
  seedPrompt: string;
  createdAt: number;
}

export interface BotIdeaItem {
  id: string;
  icon: string;
  title: string;
  description: string;
  seedPrompt: string;
}

export interface BotIdeaSection {
  category: string | null;
  items: BotIdeaItem[];
}

export interface BotGoalItem {
  id: string;
  title: string;
  category: string;
  summary: string;
  status: "active" | "paused" | "completed";
  updatedAt: number;
  handoff?: BotTaskHandoffPayload;
}

export interface BotSpaceSummary {
  id: string;
  title: string;
  description: string;
  metricBadge: string;
  updatedLabel: string;
  updatedAt: number;
  handoff?: BotTaskHandoffPayload;
}

export interface BotDocumentItem {
  id: string;
  name: string;
  updatedLabel: string;
  sizeLabel: string;
  content: string;
  path?: string;
  updatedAt: number;
}

export interface BotMediaItem {
  id: string;
  kind: "images" | "videos" | "podcasts";
  title: string;
  updatedLabel: string;
  urlOrPath?: string;
}

export interface BotInboxItem {
  id: string;
  sender: string;
  subject: string;
  preview: string;
  timeLabel: string;
  unread: boolean;
  createdAt: number;
}

export interface PendingBotApproval {
  id: string;
  title: string;
  commandSignature: string;
  summary: string;
  sessionId?: string;
  createdAt: number;
  expiresAt: number;
}

export interface ResolvedBotApproval {
  id: string;
  title: string;
  summary: string;
  decision: "approved" | "denied" | "auto-allowed";
  timeLabel: string;
  resolvedAt: number;
}

export interface BotSharedFolderRule {
  path: string;
  access: "read-only" | "isolated-copy";
}

export type BotLocalEngineKind = "wsl2" | "host-fallback";

export type BotLocalEngineState = "not-installed" | "stopped" | "provisioning" | "running" | "unavailable";

export type BotRemoteAuthMethod = "agent-or-key" | "password";

export interface BotVirtualServerStatus {
  mode: BotServerMode;
  lifecycle: BotServerLifecycleState;
  uptimeLabel: string;
  latencyMs?: number;
  local: {
    cpuCores: number;
    cpuUsagePercent: number;
    memoryUsedGb: number;
    memoryLimitGb: number;
    diskUsedGb: number;
    diskLimitGb: number;
    autoSleepIdle: boolean;
    sharedFolders: BotSharedFolderRule[];
    lastSnapshotAt?: number;
    engine?: BotLocalEngineKind;
    engineState?: BotLocalEngineState;
    distroName?: string;
    kernelVersion?: string;
    vhdxPath?: string;
    isolationSummary?: string;
  };
  remote: {
    alias: string;
    host: string;
    port: number;
    username: string;
    workDir: string;
    initialized: boolean;
    offlineSyncedAt?: number;
    authMethod?: BotRemoteAuthMethod;
    privateKeyPath?: string;
    hasStoredSecret?: boolean;
    osSummary?: string;
  };
  liveViewUrl?: string;
  liveViewTaskTitle?: string;
  takeoverRequired?: boolean;
}

export interface BotConnectorItem {
  id: string;
  name: string;
  description: string;
  enabled: boolean;
}

export interface BotSnapshotResult {
  mainSessionId: string;
  mainSessionFile: string;
  botCwd: string;
  profile: BotProfile;
  sideThreads: BotSideThreadInfo[];
  soulContent: string;
  soulUpdatedAt: string;
  memoryUpdatedAt: string;
  learnedPreferences: string[];
  activityGroups: BotActivityGroup[];
  pendingApprovals: PendingBotApproval[];
  recentApprovals: ResolvedBotApproval[];
  feed: BotFeedItem[];
  ideaSections: BotIdeaSection[];
  goals: BotGoalItem[];
  spaces: BotSpaceSummary[];
  documents: BotDocumentItem[];
  media: BotMediaItem[];
  inboxEnabled: boolean;
  inboxAddress: string;
  inboxItems: BotInboxItem[];
  connectors: BotConnectorItem[];
  virtualServer: BotVirtualServerStatus;
  embeddedTasks: BotTaskHandoffPayload[];
}

export type BotServerActionKind =
  | "start"
  | "sleep"
  | "restart"
  | "provision-local"
  | "reset-snapshot"
  | "test-remote"
  | "init-remote";

export interface BotServerActionResult {
  ok: boolean;
  message: string;
  virtualServer: BotVirtualServerStatus;
}

export interface BotLiveViewSnapshot {
  url: string;
  title: string;
  screenshotBase64: string;
  viewport: { width: number; height: number };
  containerSummary: {
    engine: string;
    state: string;
    kernelOrHost: string;
    mounts: string[];
    cgroupSummary: string;
  };
}

export interface BotLiveViewExecDiagResult {
  stdout: string;
  stderr: string;
  exitCode: number | null;
}

export interface BotHandoffCompleteParams {
  handoffId: string;
  title?: string;
  summary: string;
}

export interface BotHandoffCompleteResult {
  ok: true;
  activity: BotActivityEntry;
}

/** Namespace used inside session `custom` events for embedded Bot task reminder widgets. */
export const BOT_TASK_CARD_NAMESPACE = "qianji.bot.task-card";

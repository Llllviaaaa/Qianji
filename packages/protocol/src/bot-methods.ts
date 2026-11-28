/**
 * Wire protocol contracts for Qianji Bot Mode (`@qianji/protocol`).
 *
 * Covers evergreen main chat + side threads, SOUL contract, background approvals,
 * feed/ideas/goals/spaces/library/inbox, Local & Remote Virtual Server management,
 * and cross-mode Agent Workbench handoff.
 */
import type { BotConnectorItem, BotConnectorsConfig } from "./bot-connectors.ts";
import type {
  BotFeedItem,
  BotGoalItem,
  BotGoalViewPrefs,
  BotIdeaSection,
} from "./bot-discovery.ts";
export * from "./bot-connectors.ts";
export * from "./bot-discovery.ts";

export type UiShellMode = "agent" | "bot";

export type BotServerMode = "local" | "remote";

export type BotServerLifecycleState = "running" | "sleeping" | "connecting" | "offline";

export type BotAvatarPresetId = "alabaster-felt" | "warm-felt" | "plush-ears" | "custom";

export interface BotProfile {
  displayName: string;
  avatarPreset: BotAvatarPresetId;
  customAvatarDataUrl?: string;
}

export type BotSideThreadStatus = "idle" | "running" | "awaiting-approval" | "error";

export type BotSideThreadSource = "chat" | "scheduled" | "space" | "handoff";

export interface BotSideThreadInfo {
  id: string;
  sessionId: string;
  sessionFile: string;
  title: string;
  updatedAt: number;
  snippet?: string;
  createdAt?: number;
  pinned?: boolean;
  archived?: boolean;
  userRenamed?: boolean;
  messageCount?: number;
  status?: BotSideThreadStatus;
  source?: BotSideThreadSource;
  scheduledTaskId?: string;
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

export type BotActivityTraceStepIconKind =
  | "start"
  | "tool"
  | "browser"
  | "mail"
  | "file"
  | "schedule"
  | "goal"
  | "space"
  | "subagent"
  | "done"
  | "error";

export interface BotActivityTraceStep {
  id: string;
  kind: "start" | "tool" | "summary" | "done";
  title: string;
  subtitle?: string;
  status: "completed" | "running" | "error";
  iconKind?: BotActivityTraceStepIconKind;
  groupLabel?: string;
  reportMarkdown?: string;
  toolName?: string;
  commandOrInput?: string;
  cwd?: string;
  exitCode?: number;
  durationMs?: number;
  output?: string;
}

export type BotActivityStatus = "completed" | "running" | "error" | "interrupted";

export type BotActivityKind = "patrol" | "scheduled" | "browser" | "mail" | "chat" | "goal" | "space" | "system";

export interface BotActivityEntry {
  id: string;
  dateGroup: string;
  title: string;
  subtitle?: string;
  description: string;
  statusTitle?: string;
  finishMessage?: string;
  timeLabel: string;
  createdAt: number;
  sessionId?: string;
  turnStartSeq?: number;
  turnEndSeq?: number;
  handoff?: BotTaskHandoffPayload;
  status?: BotActivityStatus;
  kind?: BotActivityKind;
  steps?: BotActivityTraceStep[];
}

export interface BotActivityGroup {
  date: string;
  items: BotActivityEntry[];
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
  source?: "email" | "telegram" | "meeting" | "github" | "notion";
  sender: string;
  subject: string;
  preview: string;
  fullBody?: string;
  replyTo?: string;
  timeLabel: string;
  unread: boolean;
  createdAt: number;
}

export interface PendingBotApproval {
  id: string;
  kind?:
    | "shell"
    | "send-email"
    | "send-telegram"
    | "send-feishu"
    | "send-slack"
    | "github-comment"
    | "notion-page"
    | "trigger-webhook";
  title: string;
  commandSignature: string;
  summary: string;
  recipient?: string;
  subject?: string;
  draftBody?: string;
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
    storageDir?: string;
    customStorageDir?: string;
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

export interface BotModelRef {
  provider: string;
  model: string;
}

export interface BotModelConfig {
  primary?: BotModelRef;
  patrol?: BotModelRef;
}

export interface BotPacingConfig {
  heartbeatEnabled: boolean;
  heartbeatIntervalMinutes: number;
  quietHoursEnabled: boolean;
  quietHoursStart: string;
  quietHoursEnd: string;
}

export interface BotCalendarEventSummary {
  id: string;
  title: string;
  startAt: number;
  endAt: number;
  timeRangeLabel: string;
  location?: string;
  conflictWith?: string;
}

export type BotBusyState = "normal" | "in-meeting" | "deep-focus" | "quiet-hours" | "late-night";

export interface BotLiveAwarenessSummary {
  busyState: BotBusyState;
  activeWindowTitle?: string;
  runningWatched: string[];
  todayEvents: BotCalendarEventSummary[];
  conflictCount: number;
  nextMeetingLabel?: string;
  lastPatrolAt?: number;
  lastPatrolSummary?: string;
}

export interface BotDesktopNotificationPayload {
  id: string;
  title: string;
  body: string;
  urgency: "urgent" | "normal";
  createdAt: number;
}

export interface BotSnapshotResult {
  mainSessionId: string;
  mainSessionFile: string;
  botCwd: string;
  customBotCwd?: string;
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
  feedInstructions?: string;
  ideaSections: BotIdeaSection[];
  goals: BotGoalItem[];
  goalViewPrefs?: BotGoalViewPrefs;
  spaces: BotSpaceSummary[];
  documents: BotDocumentItem[];
  media: BotMediaItem[];
  inboxEnabled: boolean;
  inboxAddress: string;
  inboxItems: BotInboxItem[];
  connectors: BotConnectorItem[];
  modelConfig: BotModelConfig;
  pacing: BotPacingConfig;
  connectorConfigs: BotConnectorsConfig;
  awareness: BotLiveAwarenessSummary;
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

export interface BotSideChatUpdateParams {
  id: string;
  title?: string;
  pinned?: boolean;
  archived?: boolean;
}

export interface BotSideChatUpdateResult {
  thread: BotSideThreadInfo | null;
}

export interface BotActivityGetTraceParams {
  activityId?: string;
  sessionId?: string;
}

export interface BotActivityGetTraceResult {
  entry: BotActivityEntry | null;
  steps: BotActivityTraceStep[];
  summary: string;
  sessionId?: string;
}

export interface BotThreadsRpcMethodMap {
  "bot.sideChat.update": { params: BotSideChatUpdateParams; result: BotSideChatUpdateResult };
  "bot.activity.getTrace": { params: BotActivityGetTraceParams; result: BotActivityGetTraceResult };
}

/** Namespace used inside session `custom` events for embedded Bot task reminder widgets. */
export const BOT_TASK_CARD_NAMESPACE = "qianji.bot.task-card";

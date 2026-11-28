/**
 * Wire protocol contracts for Qianji Native Multi-Agent Swarms (`@qianji/protocol`).
 *
 * Covers Hub-and-Board coordination (`#main` + `#channels`, backtick-safe `@mention`
 * zero-token doorbells), CAS shared task board with `dependsOn` auto-unblocking,
 * role-tiered Git worktree isolation (`inherit` | `share` | `branch`), live token &
 * USD telemetry, and Host stall watchdog alerts.
 */

export type SwarmWorkspaceMode = "inherit" | "share" | "branch";

export type SwarmRunStatus = "running" | "paused" | "completed" | "stopped";

export type SwarmMemberState = "working" | "waiting" | "blocked" | "stalled" | "stopped" | "killed";

export type SwarmMemberRole = "coordinator" | "explorer" | "planner" | "worker" | "verifier" | "monitor";

export interface SwarmRoleModelConfig {
  provider: string;
  model: string;
  effort?: string;
}

export interface SwarmModelSettings {
  /** Optional default fallback model for workers; null/undefined means inherit coordinator session model. */
  defaultWorkerModel?: SwarmRoleModelConfig | null;
  /** Per-role model & effort overrides (`coordinator`, `planner`, `explorer`, `worker`, `verifier`, `monitor`). */
  roleModels: Partial<Record<SwarmMemberRole, SwarmRoleModelConfig>>;
}

export interface SwarmAvailableModelInfo {
  provider: string;
  providerName: string;
  id: string;
  name: string;
  reasoning: boolean;
}

export type SwarmTaskStatus =
  | "pending"
  | "claimed"
  | "in_progress"
  | "verifying"
  | "completed"
  | "blocked"
  | "failed";

export interface SwarmTokenUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  totalTokens: number;
}

export interface SwarmChannelInfo {
  name: string;
  topic: string;
  createdBy: string;
  archived: boolean;
  subscriberNames: string[];
  createdAt: number;
}

export interface SwarmPlanThread {
  id: string;
  title: string;
  goal: string;
  /** Member names contributing to this outcome thread (never grouped 1-per-agent unless single piece). */
  members: string[];
}

export interface SwarmPlanOverview {
  goalTitle: string;
  goalLine: string;
  /** Per-member short task label (e.g. `{ "parser": "Fix lexer edge cases" }`). */
  tasks: Record<string, string>;
  /** 1 to 6 outcome-oriented threads. */
  threads: SwarmPlanThread[];
}

export interface SwarmScreenshotItem {
  seq: number;
  sender: string;
  path: string;
  caption: string;
  createdAt: number;
}

export interface SwarmRunInfo {
  id: string;
  title: string;
  goal: string;
  cwd: string;
  coordinatorSessionId: string;
  status: SwarmRunStatus;
  stallTimeoutMs: number;
  roleModels?: Partial<Record<SwarmMemberRole, SwarmRoleModelConfig>>;
  plan?: SwarmPlanOverview;
  channels: SwarmChannelInfo[];
  totalUsage: SwarmTokenUsage;
  totalCostUsd: number;
  headSeq: number;
  createdAt: number;
  updatedAt: number;
}

export interface SwarmMemberInfo {
  name: string;
  groupPrefix?: string;
  role: SwarmMemberRole;
  brief: string;
  addedBy: string;
  sessionId: string;
  provider?: string;
  model: string;
  effort?: string;
  state: SwarmMemberState;
  killed: boolean;
  workspaceMode: SwarmWorkspaceMode;
  worktreePath?: string;
  branchName?: string;
  changedFileCount: number;
  channels: string[];
  lastReadSeq: number;
  parkedSinceSeq?: number;
  lastPostSeq?: number;
  lastActivityAt: number;
  currentTool?: string;
  currentStep?: string;
  waitingOn?: string;
  completedAt?: number;
  usage: SwarmTokenUsage;
  estimatedCostUsd: number;
  error?: string;
}

export interface SwarmBoardMessage {
  seq: number;
  swarmId: string;
  channel: string;
  sender: string;
  text: string;
  mentions: string[];
  channelMentions: string[];
  mentionAll: boolean;
  isDone: boolean;
  isStall: boolean;
  replyToSeq?: number;
  createdAt: number;
}

export interface SwarmTaskItem {
  id: string;
  swarmId: string;
  title: string;
  description: string;
  status: SwarmTaskStatus;
  assignee?: string;
  dependsOn: string[];
  ownedFiles: string[];
  attemptCount: number;
  verificationNotes?: string;
  revision: number;
  createdAt: number;
  updatedAt: number;
}

export type SwarmAlertKind = "stall" | "worktree-conflict" | "member-error" | "approval-needed";

export interface SwarmAlertInfo {
  id: string;
  swarmId: string;
  kind: SwarmAlertKind;
  severity: "warning" | "danger" | "info";
  memberName?: string;
  taskId?: string;
  message: string;
  resolved: boolean;
  createdAt: number;
}

export interface SwarmSnapshotResult {
  run: SwarmRunInfo;
  members: SwarmMemberInfo[];
  tasks: SwarmTaskItem[];
  recentMessages: SwarmBoardMessage[];
  alerts: SwarmAlertInfo[];
  screenshots?: SwarmScreenshotItem[];
}

export interface SwarmSummaryInfo {
  run: SwarmRunInfo;
  memberCounts: {
    total: number;
    working: number;
    waiting: number;
    stalled: number;
    blocked: number;
  };
  taskCounts: {
    total: number;
    pending: number;
    inProgress: number;
    verifying: number;
    completed: number;
    blocked: number;
  };
  unresolvedAlertCount: number;
}

export interface SwarmWorktreeDiffResult {
  swarmId: string;
  memberName: string;
  workspaceMode: SwarmWorkspaceMode;
  worktreePath?: string;
  branchName?: string;
  empty: boolean;
  changedFiles: string[];
  diffText: string;
}

// ---------------------------------------------------------------------------
// JSON-RPC Request & Result Payloads
// ---------------------------------------------------------------------------

export interface SwarmListParams {
  cwd?: string;
  sessionId?: string;
  includeStopped?: boolean;
}

export interface SwarmListResult {
  swarms: SwarmSummaryInfo[];
}

export interface SwarmGetParams {
  swarmId: string;
}

export type SwarmGetResult = SwarmSnapshotResult;

export interface SwarmCreateParams {
  goal: string;
  title?: string;
  cwd?: string;
  coordinatorSessionId?: string;
  stallTimeoutMs?: number;
  roleModels?: Partial<Record<SwarmMemberRole, SwarmRoleModelConfig>>;
}

export type SwarmCreateResult = SwarmSnapshotResult;

export interface SwarmBoardReadParams {
  swarmId: string;
  channel?: string;
  since?: number;
  seqs?: number[];
  limit?: number;
  readerName?: string;
}

export interface SwarmBoardReadResult {
  messages: SwarmBoardMessage[];
  headSeq: number;
}

export interface SwarmBoardPostParams {
  swarmId: string;
  text: string;
  channel?: string;
  sender?: string;
  replyToSeq?: number;
}

export interface SwarmBoardPostResult {
  message: SwarmBoardMessage;
  wokenMembers: string[];
}

export type SwarmTaskMutateAction =
  | "create"
  | "claim"
  | "start"
  | "verify"
  | "complete"
  | "block"
  | "fail"
  | "update"
  | "delete";

export interface SwarmTasksMutateParams {
  swarmId: string;
  action: SwarmTaskMutateAction;
  taskId?: string;
  title?: string;
  description?: string;
  status?: SwarmTaskStatus;
  assignee?: string;
  dependsOn?: string[];
  ownedFiles?: string[];
  verificationNotes?: string;
  expectedRevision?: number;
  actor?: string;
}

export interface SwarmTasksMutateResult {
  task?: SwarmTaskItem;
  tasks: SwarmTaskItem[];
}

export type SwarmMemberControlAction =
  | "nudge"
  | "switchModel"
  | "abort"
  | "kill"
  | "mergeWorktree"
  | "revive";

export interface SwarmMemberControlParams {
  swarmId: string;
  name: string;
  action: SwarmMemberControlAction;
  message?: string;
  interrupt?: boolean;
  provider?: string;
  model?: string;
  reason?: string;
  applyChanges?: boolean;
  forceKillUnmerged?: boolean;
}

export interface SwarmWorktreeMergeSummary {
  changedFiles: string[];
  applied: boolean;
  conflict?: boolean;
  patchFile?: string;
  reason?: string;
}

export interface SwarmMemberControlResult {
  ok: boolean;
  member?: SwarmMemberInfo;
  mergeResult?: SwarmWorktreeMergeSummary;
  message?: string;
}

export type SwarmRunControlAction =
  | "pause"
  | "resume"
  | "stop"
  | "complete"
  | "setTitle"
  | "dismissAlert";

export interface SwarmRunControlParams {
  swarmId: string;
  action: SwarmRunControlAction;
  title?: string;
  alertId?: string;
  forceStopUnmerged?: boolean;
}

export interface SwarmRunControlResult {
  run: SwarmRunInfo;
  alerts: SwarmAlertInfo[];
}

export interface SwarmWorktreeDiffParams {
  swarmId: string;
  name: string;
}

export interface SwarmConfigGetParams {
  swarmId?: string;
}

export interface SwarmConfigGetResult {
  globalConfig: SwarmModelSettings;
  sessionOverrides?: Partial<Record<SwarmMemberRole, SwarmRoleModelConfig>>;
  availableModels: SwarmAvailableModelInfo[];
}

export interface SwarmConfigUpdateParams {
  globalConfig?: SwarmModelSettings;
  swarmId?: string;
  sessionOverrides?: Partial<Record<SwarmMemberRole, SwarmRoleModelConfig>>;
  applyToWaitingMembers?: boolean;
}

export interface SwarmConfigUpdateResult {
  globalConfig: SwarmModelSettings;
  sessionOverrides?: Partial<Record<SwarmMemberRole, SwarmRoleModelConfig>>;
  snapshot?: SwarmSnapshotResult;
}

// ---------------------------------------------------------------------------
// Push Notifications (Host -> WebView)
// ---------------------------------------------------------------------------

export interface SwarmUpdatedNotification {
  swarmId: string;
  snapshot: SwarmSnapshotResult;
  summary: SwarmSummaryInfo;
}

export interface SwarmBoardNotification {
  swarmId: string;
  message: SwarmBoardMessage;
  headSeq: number;
  wokenMembers: string[];
}

export interface SwarmMemberDeltaNotification {
  swarmId: string;
  member: SwarmMemberInfo;
}

export interface SwarmAlertNotification {
  swarmId: string;
  alert: SwarmAlertInfo;
}

export interface SwarmOpenNotification {
  swarmId?: string;
  sessionId?: string;
  cwd?: string;
  surface?: "pane" | "hub";
}

export interface SwarmConfigUpdatedNotification {
  globalConfig: SwarmModelSettings;
  swarmId?: string;
  sessionOverrides?: Partial<Record<SwarmMemberRole, SwarmRoleModelConfig>>;
}

export const SWARM_RPC_METHODS = {
  list: "swarm.list",
  get: "swarm.get",
  create: "swarm.create",
  boardRead: "swarm.board.read",
  boardPost: "swarm.board.post",
  tasksMutate: "swarm.tasks.mutate",
  memberControl: "swarm.member.control",
  runControl: "swarm.run.control",
  worktreeDiff: "swarm.worktree.diff",
  configGet: "swarm.config.get",
  configUpdate: "swarm.config.update",
} as const;

export const SWARM_RPC_NOTIFICATIONS = {
  updated: "swarm/updated",
  board: "swarm/board",
  memberDelta: "swarm/memberDelta",
  alert: "swarm/alert",
  open: "swarm/open",
  configUpdated: "swarm/configUpdated",
} as const;

/**
 * Reactive data & UI stores for the built-in `swarm` feature plugin
 * (`src/builtin-plugins/swarm/swarmStore.ts`).
 */
import { createReactiveStore, useStoreValue } from "@qianji/client-store";
import type {
  SwarmAlertNotification,
  SwarmAvailableModelInfo,
  SwarmBoardMessage,
  SwarmBoardNotification,
  SwarmConfigUpdatedNotification,
  SwarmMemberDeltaNotification,
  SwarmMemberRole,
  SwarmModelSettings,
  SwarmRoleModelConfig,
  SwarmSnapshotResult,
  SwarmSummaryInfo,
  SwarmUpdatedNotification,
  SwarmWorktreeDiffResult,
} from "@qianji/protocol";
import {
  computeMemberCounts,
  computeTaskCounts,
  decodeRoleModelValue,
  deriveOutcomeOverview,
  deriveSummaryFromSnapshot,
  encodeRoleModelValue,
  filterSwarmMembers,
  findSwarmSummaryForSession,
  formatTokenCompact,
  formatUsdCost,
  isSwarmEnabledForSession,
  normalizeBareSessionId,
  resolveActiveSwarmSnapshot,
  resolveMemberItemStatus,
  resolveMemberTaskLabel,
  resolveSessionSwarmSummary,
  sameWorkspacePath,
} from "./swarmSelectors";

export {
  computeMemberCounts,
  computeTaskCounts,
  decodeRoleModelValue,
  deriveOutcomeOverview,
  deriveSummaryFromSnapshot,
  encodeRoleModelValue,
  filterSwarmMembers,
  findSwarmSummaryForSession,
  formatTokenCompact,
  formatUsdCost,
  isSwarmEnabledForSession,
  normalizeBareSessionId,
  resolveActiveSwarmSnapshot,
  resolveMemberItemStatus,
  resolveMemberTaskLabel,
  resolveSessionSwarmSummary,
  sameWorkspacePath,
};

export type SwarmMemberFilter = "all" | "working" | "waiting" | "attention";
export type SwarmWorkbenchTab = "overview" | "board" | "members" | "hive";
export type SwarmInspectorTab = "session" | "diff";
export type SwarmHiveMode = "hex" | "mentions";
export type SwarmRoleModelsScope = "global" | "session";

export interface SwarmDataState {
  readonly summaries: readonly SwarmSummaryInfo[];
  readonly snapshotsById: Readonly<Record<string, SwarmSnapshotResult>>;
  readonly boardBySwarmChannel: Readonly<Record<string, readonly SwarmBoardMessage[]>>;
  readonly diffsByMemberKey: Readonly<Record<string, SwarmWorktreeDiffResult>>;
  readonly globalModelConfig: SwarmModelSettings;
  readonly sessionRoleOverridesBySwarmId: Readonly<
    Record<string, Partial<Record<SwarmMemberRole, SwarmRoleModelConfig>>>
  >;
  readonly availableModels: readonly SwarmAvailableModelInfo[];
  readonly configRevision: number;
  readonly loading: boolean;
  readonly error: string | null;
}

export interface SwarmUiState {
  readonly activeSwarmId: string | null;
  readonly pendingDraftSwarm: boolean;
  readonly pendingDraftSwarmId: string | null;
  readonly pendingAdoptingSessionId: string | null;
  readonly selectedMemberName: string | null;
  readonly inspectorTab: SwarmInspectorTab;
  readonly workbenchTab: SwarmWorkbenchTab;
  readonly overviewMemberFilter: string | null;
  readonly activeChannel: string;
  readonly boardSearchQuery: string;
  readonly boardMemberFilter: string | null;
  readonly highlightedSeq: number | null;
  readonly hiveMode: SwarmHiveMode;
  readonly hiveReplaySeq: number | null;
  readonly hivePlaying: boolean;
  readonly selectedHexThreadId: string | null;
  readonly memberFilter: SwarmMemberFilter;
  readonly roleModelsModalOpen: boolean;
  readonly roleModelsModalScope: SwarmRoleModelsScope;
  readonly busyAction: string | null;
}

export const EMPTY_SWARM_MODEL_SETTINGS: SwarmModelSettings = {
  defaultWorkerModel: null,
  roleModels: {},
};

export const INITIAL_SWARM_DATA_STATE: SwarmDataState = {
  summaries: [],
  snapshotsById: {},
  boardBySwarmChannel: {},
  diffsByMemberKey: {},
  globalModelConfig: EMPTY_SWARM_MODEL_SETTINGS,
  sessionRoleOverridesBySwarmId: {},
  availableModels: [],
  configRevision: 0,
  loading: false,
  error: null,
};

export const INITIAL_SWARM_UI_STATE: SwarmUiState = {
  activeSwarmId: null,
  pendingDraftSwarm: false,
  pendingDraftSwarmId: null,
  pendingAdoptingSessionId: null,
  selectedMemberName: null,
  inspectorTab: "session",
  workbenchTab: "overview",
  overviewMemberFilter: null,
  activeChannel: "main",
  boardSearchQuery: "",
  boardMemberFilter: null,
  highlightedSeq: null,
  hiveMode: "hex",
  hiveReplaySeq: null,
  hivePlaying: false,
  selectedHexThreadId: null,
  memberFilter: "all",
  roleModelsModalOpen: false,
  roleModelsModalScope: "session",
  busyAction: null,
};

export const swarmDataStore = createReactiveStore<SwarmDataState>(INITIAL_SWARM_DATA_STATE);
export const swarmUiStore = createReactiveStore<SwarmUiState>(INITIAL_SWARM_UI_STATE);

export function useSwarmData(): SwarmDataState {
  return useStoreValue(swarmDataStore);
}

export function useSwarmUi(): SwarmUiState {
  return useStoreValue(swarmUiStore);
}

export function resetSwarmStores(): void {
  swarmDataStore.set(INITIAL_SWARM_DATA_STATE);
  swarmUiStore.set(INITIAL_SWARM_UI_STATE);
}

export function patchSwarmUi(patch: Partial<SwarmUiState>): void {
  swarmUiStore.set((prev) => ({ ...prev, ...patch }));
}

export function selectSwarmMember(
  memberName: string | null,
  options?: { readonly inspectorTab?: SwarmInspectorTab },
): void {
  swarmUiStore.set((prev) => ({
    ...prev,
    selectedMemberName: memberName,
    ...(options?.inspectorTab !== undefined ? { inspectorTab: options.inspectorTab } : {}),
  }));
}

export function jumpToBoardSeq(seq: number, channel?: string): void {
  swarmUiStore.set((prev) => ({
    ...prev,
    selectedMemberName: null,
    workbenchTab: "board",
    highlightedSeq: seq,
    ...(channel !== undefined && channel !== "" ? { activeChannel: channel } : {}),
  }));
}

export function swarmMemberDiffKey(swarmId: string, memberName: string): string {
  return `${swarmId}:${memberName}`;
}

export function swarmChannelKey(swarmId: string, channel: string): string {
  return `${swarmId}#${channel || "main"}`;
}

function mergeBoardMessages(
  existing: readonly SwarmBoardMessage[],
  incoming: readonly SwarmBoardMessage[],
): SwarmBoardMessage[] {
  const bySeq = new Map<number, SwarmBoardMessage>();
  for (const m of existing) bySeq.set(m.seq, m);
  for (const m of incoming) bySeq.set(m.seq, m);
  return [...bySeq.values()].sort((a, b) => a.seq - b.seq);
}

function upsertSummaryList(
  summaries: readonly SwarmSummaryInfo[],
  nextSummary: SwarmSummaryInfo,
): SwarmSummaryInfo[] {
  const idx = summaries.findIndex((item) => item.run.id === nextSummary.run.id);
  if (idx < 0) return [nextSummary, ...summaries];
  const copy = [...summaries];
  copy[idx] = nextSummary;
  return copy;
}

export function applySwarmListResult(
  swarms: readonly SwarmSummaryInfo[],
  preferredSessionId?: string | null,
  _preferredCwd?: string,
): void {
  swarmDataStore.set((prev) => {
    let merged = [...swarms];
    for (const snap of Object.values(prev.snapshotsById)) {
      if (!merged.some((s) => s.run.id === snap.run.id)) {
        merged = upsertSummaryList(merged, deriveSummaryFromSnapshot(snap));
      }
    }
    return {
      ...prev,
      summaries: merged,
      loading: false,
      error: null,
    };
  });

  const allSummaries = swarmDataStore.get().summaries;
  const bySession = findSwarmSummaryForSession(allSummaries, preferredSessionId);
  if (bySession !== undefined) {
    patchSwarmUi({ activeSwarmId: bySession.run.id });
    return;
  }

  const ui = swarmUiStore.get();
  if (ui.activeSwarmId !== null && allSummaries.some((s) => s.run.id === ui.activeSwarmId)) {
    return;
  }
}

export function applySwarmSnapshot(snapshot: SwarmSnapshotResult): void {
  const summary = deriveSummaryFromSnapshot(snapshot);
  swarmDataStore.set((prev) => {
    const nextBoard = { ...prev.boardBySwarmChannel };
    const grouped = new Map<string, SwarmBoardMessage[]>();
    for (const msg of snapshot.recentMessages) {
      const ch = msg.channel || "main";
      const bucket = grouped.get(ch) ?? [];
      bucket.push(msg);
      grouped.set(ch, bucket);
    }
    for (const [ch, list] of grouped.entries()) {
      const key = swarmChannelKey(snapshot.run.id, ch);
      nextBoard[key] = mergeBoardMessages(prev.boardBySwarmChannel[key] ?? [], list);
    }
    const nextOverrides = {
      ...prev.sessionRoleOverridesBySwarmId,
      [snapshot.run.id]: snapshot.run.roleModels ?? {},
    };
    return {
      ...prev,
      summaries: upsertSummaryList(prev.summaries, summary),
      snapshotsById: { ...prev.snapshotsById, [snapshot.run.id]: snapshot },
      boardBySwarmChannel: nextBoard,
      sessionRoleOverridesBySwarmId: nextOverrides,
      loading: false,
      error: null,
    };
  });

  const ui = swarmUiStore.get();
  if (snapshot.run.coordinatorSessionId !== "" && ui.pendingDraftSwarmId === snapshot.run.id) {
    patchSwarmUi({
      activeSwarmId: snapshot.run.id,
      pendingDraftSwarm: false,
      pendingDraftSwarmId: null,
      pendingAdoptingSessionId: null,
    });
  } else if (ui.activeSwarmId === null) {
    patchSwarmUi({ activeSwarmId: snapshot.run.id });
  }
}

export function applySwarmConfigPayload(payload: {
  readonly globalConfig?: SwarmModelSettings;
  readonly swarmId?: string;
  readonly sessionOverrides?: Partial<Record<SwarmMemberRole, SwarmRoleModelConfig>>;
  readonly availableModels?: readonly SwarmAvailableModelInfo[];
  readonly snapshot?: SwarmSnapshotResult;
}): void {
  if (payload.snapshot !== undefined && payload.snapshot.run !== undefined) {
    applySwarmSnapshot(payload.snapshot);
  }
  const resolvedOverrides =
    payload.sessionOverrides
    ?? (payload.snapshot !== undefined ? (payload.snapshot.run.roleModels ?? {}) : {});
  swarmDataStore.set((prev) => ({
    ...prev,
    globalModelConfig: payload.globalConfig ?? prev.globalModelConfig,
    ...(payload.availableModels !== undefined ? { availableModels: payload.availableModels } : {}),
    ...(payload.swarmId !== undefined && payload.swarmId !== ""
      ? {
          sessionRoleOverridesBySwarmId: {
            ...prev.sessionRoleOverridesBySwarmId,
            [payload.swarmId]: resolvedOverrides,
          },
        }
      : {}),
    configRevision: prev.configRevision + 1,
  }));
}

export function applySwarmConfigUpdatedNotification(payload: SwarmConfigUpdatedNotification): void {
  if (!payload || typeof payload !== "object") return;
  applySwarmConfigPayload(payload);
}

export function applySwarmUpdatedNotification(payload: SwarmUpdatedNotification): void {
  if (!payload || typeof payload.swarmId !== "string" || !payload.snapshot) return;
  applySwarmSnapshot(payload.snapshot);
}

export function applySwarmBoardNotification(payload: SwarmBoardNotification): void {
  if (!payload || typeof payload.swarmId !== "string" || !payload.message) return;
  const ch = payload.message.channel || "main";
  const key = swarmChannelKey(payload.swarmId, ch);
  swarmDataStore.set((prev) => {
    const existingSnap = prev.snapshotsById[payload.swarmId];
    const updatedBoard = mergeBoardMessages(prev.boardBySwarmChannel[key] ?? [], [payload.message]);
    if (existingSnap === undefined) {
      return { ...prev, boardBySwarmChannel: { ...prev.boardBySwarmChannel, [key]: updatedBoard } };
    }
    const nextSnap: SwarmSnapshotResult = {
      ...existingSnap,
      run: { ...existingSnap.run, headSeq: Math.max(existingSnap.run.headSeq, payload.headSeq) },
      recentMessages: mergeBoardMessages(existingSnap.recentMessages, [payload.message]),
    };
    return {
      ...prev,
      summaries: upsertSummaryList(prev.summaries, deriveSummaryFromSnapshot(nextSnap)),
      snapshotsById: { ...prev.snapshotsById, [payload.swarmId]: nextSnap },
      boardBySwarmChannel: { ...prev.boardBySwarmChannel, [key]: updatedBoard },
    };
  });
}

export function applySwarmBoardReadResult(
  swarmId: string,
  channel: string,
  messages: readonly SwarmBoardMessage[],
): void {
  const key = swarmChannelKey(swarmId, channel || "main");
  swarmDataStore.set((prev) => ({
    ...prev,
    boardBySwarmChannel: {
      ...prev.boardBySwarmChannel,
      [key]: mergeBoardMessages(prev.boardBySwarmChannel[key] ?? [], messages),
    },
  }));
}

export function applySwarmMemberDeltaNotification(payload: SwarmMemberDeltaNotification): void {
  if (!payload || typeof payload.swarmId !== "string" || !payload.member) return;
  swarmDataStore.set((prev) => {
    const existingSnap = prev.snapshotsById[payload.swarmId];
    if (existingSnap === undefined) return prev;
    const idx = existingSnap.members.findIndex((m) => m.name === payload.member.name);
    const nextMembers =
      idx >= 0
        ? existingSnap.members.map((m, i) => (i === idx ? payload.member : m))
        : [...existingSnap.members, payload.member];
    const nextSnap: SwarmSnapshotResult = { ...existingSnap, members: nextMembers };
    return {
      ...prev,
      summaries: upsertSummaryList(prev.summaries, deriveSummaryFromSnapshot(nextSnap)),
      snapshotsById: { ...prev.snapshotsById, [payload.swarmId]: nextSnap },
    };
  });
}

export function applySwarmAlertNotification(payload: SwarmAlertNotification): void {
  if (!payload || typeof payload.swarmId !== "string" || !payload.alert) return;
  swarmDataStore.set((prev) => {
    const existingSnap = prev.snapshotsById[payload.swarmId];
    if (existingSnap === undefined) return prev;
    const idx = existingSnap.alerts.findIndex((a) => a.id === payload.alert.id);
    const nextAlerts =
      idx >= 0
        ? existingSnap.alerts.map((a, i) => (i === idx ? payload.alert : a))
        : [payload.alert, ...existingSnap.alerts];
    const nextSnap: SwarmSnapshotResult = { ...existingSnap, alerts: nextAlerts };
    return {
      ...prev,
      summaries: upsertSummaryList(prev.summaries, deriveSummaryFromSnapshot(nextSnap)),
      snapshotsById: { ...prev.snapshotsById, [payload.swarmId]: nextSnap },
    };
  });
}

export function applyWorktreeDiff(diff: SwarmWorktreeDiffResult): void {
  const key = swarmMemberDiffKey(diff.swarmId, diff.memberName);
  swarmDataStore.set((prev) => ({
    ...prev,
    diffsByMemberKey: { ...prev.diffsByMemberKey, [key]: diff },
  }));
}

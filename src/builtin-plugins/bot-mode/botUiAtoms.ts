/**
 * Reactive UI & Snapshot state atoms for `bot-mode` (`src/builtin-plugins/bot-mode/botUiAtoms.ts`).
 */
import { createReactiveStore, useStoreValue } from "@qianji/client-store";
import type {
  BotActivityEntry,
  BotDocumentItem,
  BotPluginConnectorCatalogItem,
  BotSnapshotResult,
  BotSpaceSummary,
  McpServerStatus,
} from "@qianji/protocol";
import { FALLBACK_BOT_SNAPSHOT } from "./botFallbackData";

export type BotRailView = "chat" | "feed" | "ideas" | "goals" | "library" | "spaces";
export type BotCompanionTab = "activity" | "approvals" | "identity" | "inbox";
export type BotLibrarySection = "spaces" | "docs" | "images" | "videos" | "podcasts" | "sysfiles";
export type BotExpressionId = "calm" | "happy" | "focused" | "patrol" | "curious" | "sleepy";
export type BotActionId = "idle" | "wave" | "nod" | "think" | "scan" | "celebrate";
export type BotMoodMode = "auto" | "manual";
export type BotModalKind =
  | "search"
  | "soul"
  | "memory"
  | "shortcuts"
  | "settings"
  | "live-view"
  | "doc-preview"
  | "space-detail"
  | "report-issue"
  | "scheduled"
  | "activity-detail"
  | null;
export type BotSettingsTab =
  | "general"
  | "models"
  | "server"
  | "browser"
  | "connectors"
  | "plugins"
  | "vault"
  | "permissions"
  | "channels"
  | "data"
  | "voice";

export interface BotScheduledSummary {
  readonly id: string;
  readonly name: string;
  readonly prompt?: string;
  readonly cwd?: string;
  readonly frequency?: "interval" | "hourly" | "daily" | "weekdays" | "weekly" | "once";
  readonly intervalMinutes?: number;
  readonly hour?: number;
  readonly minute?: number;
  readonly weekday?: number;
  readonly runAt?: number;
  readonly permissionMode?: "read-only" | "ask" | "workspace-write";
  readonly timeoutMinutes?: number;
  readonly cronOrInterval: string;
  readonly enabled: boolean;
  readonly running?: boolean;
  readonly nextRunAt?: number;
  readonly lastRunAt?: number;
  readonly lastStatus?: string;
  readonly lastMessage?: string;
  readonly isHeartbeat?: boolean;
}

export const MIN_SPLIT_CHAT_WIDTH = 340;
export const MAX_SPLIT_CHAT_WIDTH = 620;
export const DEFAULT_SPLIT_CHAT_WIDTH = 440;

export function clampSplitChatWidth(width: number): number {
  if (!Number.isFinite(width)) return DEFAULT_SPLIT_CHAT_WIDTH;
  return Math.max(MIN_SPLIT_CHAT_WIDTH, Math.min(MAX_SPLIT_CHAT_WIDTH, Math.round(width)));
}

export interface BotDismissedIdeaSummary {
  readonly id: string;
  readonly title: string;
}

export interface BotUiState {
  readonly activeView: BotRailView;
  readonly chatDrawerOpen: boolean;
  readonly chatDrawerPinned: boolean;
  readonly chatDrawerShowArchived: boolean;
  readonly chatDrawerWidth: number;
  readonly activeSessionId: string | null;
  readonly rightPanelOpen: boolean;
  readonly rightTab: BotCompanionTab;
  readonly libSection: BotLibrarySection;
  readonly modal: BotModalKind;
  readonly returnModal: BotModalKind;
  readonly settingsTab: BotSettingsTab;
  readonly settingsPageMode: boolean;
  readonly connectorOriginTab: BotSettingsTab | null;
  readonly suspendedForHostSettings: boolean;
  readonly modalNonce: number;
  readonly moreMenuOpen: boolean;
  readonly composerDraft: string;
  readonly quotedText: string | null;
  readonly voiceCallActive: boolean;
  readonly scheduledExpanded: boolean;
  readonly scheduledTasks: readonly BotScheduledSummary[];
  readonly selectedScheduledTaskId: string | null;
  readonly activeActivityEntry: BotActivityEntry | null;
  readonly memoryContent: string;
  readonly serverFeedback: string | null;
  readonly serverBusy: boolean;
  readonly activeConnectorId: string | null;
  readonly pluginConnectors: readonly BotPluginConnectorCatalogItem[];
  readonly mcpStatus: readonly McpServerStatus[];
  readonly liveViewTargetUrl: string | null;
  readonly composerApps: readonly string[];
  readonly activeDoc: BotDocumentItem | null;
  readonly activeSpace: BotSpaceSummary | null;
  readonly splitChatOpen: boolean;
  readonly splitChatWidth: number;
  readonly pendingAutoSendPrompt: string | null;
  readonly activeIdeaId: string | null;
  readonly lastDismissedIdea: BotDismissedIdeaSummary | null;
  readonly activeGoalId: string | null;
  readonly activeGoalFocusSubGoal: boolean;
  readonly characterMoodMode: BotMoodMode;
  readonly characterExpression: BotExpressionId;
  readonly characterAction: BotActionId;
  readonly characterSpeech: string | null;
  readonly characterBurstNonce: number;
}

export const INITIAL_BOT_UI_STATE: BotUiState = {
  activeView: "chat",
  chatDrawerOpen: false,
  chatDrawerPinned: false,
  chatDrawerShowArchived: false,
  chatDrawerWidth: 256,
  activeSessionId: null,
  rightPanelOpen: true,
  rightTab: "activity",
  libSection: "spaces",
  modal: null,
  returnModal: null,
  settingsTab: "general",
  settingsPageMode: false,
  connectorOriginTab: null,
  suspendedForHostSettings: false,
  modalNonce: 0,
  moreMenuOpen: false,
  composerDraft: "",
  quotedText: null,
  voiceCallActive: false,
  scheduledExpanded: true,
  scheduledTasks: [
    {
      id: "heartbeat",
      name: "Heartbeat",
      prompt: "按节奏静默巡检收件箱、仓库动态与待办事项，仅在有价值发现时汇报。",
      frequency: "interval",
      intervalMinutes: 30,
      cronOrInterval: "每30分钟",
      enabled: true,
      isHeartbeat: true,
    },
  ],
  selectedScheduledTaskId: null,
  activeActivityEntry: null,
  memoryContent: "",
  serverFeedback: null,
  serverBusy: false,
  activeConnectorId: null,
  pluginConnectors: [],
  mcpStatus: [],
  liveViewTargetUrl: null,
  composerApps: [],
  activeDoc: null,
  activeSpace: null,
  splitChatOpen: false,
  splitChatWidth: DEFAULT_SPLIT_CHAT_WIDTH,
  pendingAutoSendPrompt: null,
  activeIdeaId: null,
  lastDismissedIdea: null,
  activeGoalId: null,
  activeGoalFocusSubGoal: false,
  characterMoodMode: "auto",
  characterExpression: "calm",
  characterAction: "idle",
  characterSpeech: null,
  characterBurstNonce: 0,
};

export const botUiStore = createReactiveStore<BotUiState>(INITIAL_BOT_UI_STATE);
export const botDataStore = createReactiveStore<BotSnapshotResult>(FALLBACK_BOT_SNAPSHOT);

export function useBotUiState(): BotUiState {
  return useStoreValue(botUiStore);
}

export function useBotSnapshot(): BotSnapshotResult {
  return useStoreValue(botDataStore);
}

export function patchBotUi(patch: Partial<BotUiState>): void {
  botUiStore.set((prev) => ({
    ...prev,
    ...patch,
    ...(patch.splitChatWidth !== undefined
      ? { splitChatWidth: clampSplitChatWidth(patch.splitChatWidth) }
      : {}),
  }));
}

export function openBotModal(
  modal: Exclude<BotModalKind, null>,
  settingsTab?: BotSettingsTab,
  options?: { readonly returnToCurrent?: boolean },
): void {
  botUiStore.set((prev) => ({
    ...prev,
    modal,
    returnModal:
      options?.returnToCurrent === true && prev.modal !== null && prev.modal !== modal
        ? prev.modal
        : null,
    moreMenuOpen: false,
    serverFeedback: null,
    suspendedForHostSettings: false,
    ...(modal === "settings" ? { activeConnectorId: null, connectorOriginTab: null } : {}),
    modalNonce: prev.modalNonce + 1,
    ...(settingsTab !== undefined ? { settingsTab } : {}),
  }));
}

export function closeActiveBotModal(): void {
  botUiStore.set((prev) => {
    if (prev.returnModal !== null && prev.returnModal !== prev.modal) {
      return {
        ...prev,
        modal: prev.returnModal,
        returnModal: null,
      };
    }
    return {
      ...prev,
      modal: null,
      returnModal: null,
      connectorOriginTab: null,
    };
  });
}

export function openBotScheduledModal(
  taskId?: string | null,
  options?: { readonly returnToCurrent?: boolean },
): void {
  botUiStore.set((prev) => ({
    ...prev,
    modal: "scheduled",
    returnModal:
      options?.returnToCurrent === true && prev.modal !== null && prev.modal !== "scheduled"
        ? prev.modal
        : null,
    selectedScheduledTaskId: taskId ?? null,
    moreMenuOpen: false,
    suspendedForHostSettings: false,
    modalNonce: prev.modalNonce + 1,
  }));
}

export function openBotActivityDetail(entry: BotActivityEntry): void {
  botUiStore.set((prev) => ({
    ...prev,
    modal: "activity-detail",
    returnModal: null,
    activeActivityEntry: entry,
    moreMenuOpen: false,
    modalNonce: prev.modalNonce + 1,
  }));
}

export function openBotConnector(
  connectorId: string | null,
  originTab?: BotSettingsTab | null,
): void {
  botUiStore.set((prev) => ({
    ...prev,
    modal: "settings",
    returnModal: null,
    settingsTab: "connectors",
    activeConnectorId: connectorId,
    connectorOriginTab: originTab ?? null,
    moreMenuOpen: false,
    serverFeedback: null,
    suspendedForHostSettings: false,
    modalNonce: prev.modalNonce + 1,
  }));
}

export function openBotLiveView(
  targetUrl?: string,
  options?: { readonly returnToCurrent?: boolean },
): void {
  botUiStore.set((prev) => ({
    ...prev,
    modal: "live-view",
    returnModal:
      options?.returnToCurrent === true && prev.modal !== null && prev.modal !== "live-view"
        ? prev.modal
        : null,
    liveViewTargetUrl: targetUrl?.trim() ? targetUrl.trim() : null,
    moreMenuOpen: false,
    suspendedForHostSettings: false,
    modalNonce: prev.modalNonce + 1,
  }));
}

export function openHostSettingsFromBot(
  navigationService: { openSettings(page?: string): void } | undefined,
  page: string,
): void {
  if (!navigationService) return;
  const fromBotSettings = botUiStore.get().modal === "settings";
  if (fromBotSettings) {
    patchBotUi({ modal: null, returnModal: null, suspendedForHostSettings: true });
  }
  navigationService.openSettings(page);
}

export function formatVirtualServerStatus(
  vs: BotSnapshotResult["virtualServer"],
): { readonly label: string; readonly dotColor: string } {
  const isLocalWslUninit =
    vs.mode === "local" && vs.local.engine === "wsl2" && vs.local.engineState === "not-installed";
  const label =
    vs.mode === "local"
      ? isLocalWslUninit
        ? "待唤醒 · WSL2 容器"
        : vs.lifecycle === "sleeping" || vs.local.engineState === "stopped"
          ? "休眠中 · WSL2 容器"
          : "已连接"
      : vs.lifecycle === "running"
        ? "已连接 · 远端虚拟服务器"
        : "未连接 · 远端虚拟服务器";
  const dotColor =
    vs.lifecycle === "running"
      ? "var(--qj-status-success)"
      : isLocalWslUninit
        ? "var(--qj-text-muted)"
        : vs.lifecycle === "sleeping"
          ? "var(--qj-status-warning)"
          : "var(--qj-status-danger)";
  return { label, dotColor };
}

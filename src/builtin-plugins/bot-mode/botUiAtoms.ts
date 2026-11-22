/**
 * Reactive UI & Snapshot state atoms for `bot-mode` (`src/builtin-plugins/bot-mode/botUiAtoms.ts`).
 */
import { createReactiveStore, useStoreValue } from "@qianji/client-store";
import type { BotDocumentItem, BotSnapshotResult, BotSpaceSummary } from "@qianji/protocol";
import { FALLBACK_BOT_SNAPSHOT } from "./botFallbackData";

export type BotRailView = "chat" | "feed" | "ideas" | "goals" | "library" | "spaces";
export type BotCompanionTab = "activity" | "approvals" | "identity" | "inbox";
export type BotLibrarySection = "spaces" | "docs" | "images" | "videos" | "podcasts" | "sysfiles";
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
  | null;
export type BotSettingsTab =
  | "general"
  | "server"
  | "browser"
  | "connectors"
  | "vault"
  | "permissions"
  | "channels"
  | "data"
  | "voice";

export interface BotScheduledSummary {
  readonly id: string;
  readonly name: string;
  readonly cronOrInterval: string;
  readonly enabled: boolean;
}

export interface BotUiState {
  readonly activeView: BotRailView;
  readonly chatDrawerOpen: boolean;
  readonly activeSessionId: string | null;
  readonly rightPanelOpen: boolean;
  readonly rightTab: BotCompanionTab;
  readonly libSection: BotLibrarySection;
  readonly modal: BotModalKind;
  readonly settingsTab: BotSettingsTab;
  readonly modalNonce: number;
  readonly moreMenuOpen: boolean;
  readonly composerDraft: string;
  readonly quotedText: string | null;
  readonly voiceCallActive: boolean;
  readonly scheduledExpanded: boolean;
  readonly scheduledTasks: readonly BotScheduledSummary[];
  readonly memoryContent: string;
  readonly serverFeedback: string | null;
  readonly serverBusy: boolean;
  readonly activeDoc: BotDocumentItem | null;
  readonly activeSpace: BotSpaceSummary | null;
}

export const INITIAL_BOT_UI_STATE: BotUiState = {
  activeView: "chat",
  chatDrawerOpen: false,
  activeSessionId: null,
  rightPanelOpen: true,
  rightTab: "activity",
  libSection: "spaces",
  modal: null,
  settingsTab: "general",
  modalNonce: 0,
  moreMenuOpen: false,
  composerDraft: "",
  quotedText: null,
  voiceCallActive: false,
  scheduledExpanded: true,
  scheduledTasks: [{ id: "heartbeat", name: "Heartbeat", cronOrInterval: "每30分钟", enabled: true }],
  memoryContent: "",
  serverFeedback: null,
  serverBusy: false,
  activeDoc: null,
  activeSpace: null,
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
  botUiStore.set((prev) => ({ ...prev, ...patch }));
}

export function openBotModal(modal: Exclude<BotModalKind, null>, settingsTab?: BotSettingsTab): void {
  botUiStore.set((prev) => ({
    ...prev,
    modal,
    moreMenuOpen: false,
    serverFeedback: null,
    modalNonce: prev.modalNonce + 1,
    ...(settingsTab !== undefined ? { settingsTab } : {}),
  }));
}
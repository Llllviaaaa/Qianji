/**
 * Canonical ADR 0023 §3 typed core slot tree (`@qianji/client-slots`).
 *
 * Augments `SlotMap` on `@qianji/client-slots` with every built-in core slot's
 * `kind`, `scope`, and typed owner props so Wave 2B built-in plugins and
 * external user/workspace plugins share a single strongly-typed contract.
 */
import type { ReactNode } from "react";
import type {
  AttachmentPayload,
  ExtensionUIRequest,
  SessionInfo,
  UiMessage,
  UiToolCall,
  WorkStep,
} from "../../types";
import type { NavigationHubView, NavigationRoute } from "../services/navigationService";
import type { ChildSlotDecl, SlotSpec } from "./types";

/* ── Shell / Root Slot Owner Props ── */

export interface CoreRootSlotProps {
  readonly safeMode?: boolean;
}

export interface CoreShellMenubarProps {
  readonly title?: string;
  readonly sidebarVisible?: boolean;
  readonly onToggleSidebar?: () => void;
}

export interface CoreShellSidebarProps {
  readonly visible?: boolean;
  readonly width?: number;
  readonly onResize?: (width: number) => void;
}

export interface CoreShellTopbarProps {
  readonly cwd?: string;
  readonly sessionFile?: string | null;
  readonly title?: string;
}

export interface CoreShellStageProps {
  readonly route?: NavigationRoute;
  readonly cwd?: string;
  readonly sessionFile?: string | null;
  readonly hubView?: NavigationHubView | null;
  readonly draftMode?: boolean;
}

export interface CoreWorkbenchRightProps {
  readonly cwd?: string;
  readonly sessionFile?: string | null;
  readonly open?: boolean;
  readonly maximized?: boolean;
}

export interface CoreWorkbenchBottomProps {
  readonly cwd?: string;
  readonly sessionFile?: string | null;
  readonly open?: boolean;
  readonly activeTab?: string;
}

export interface CoreStatusbarProps {
  readonly cwd?: string;
  readonly sessionFile?: string | null;
  readonly align?: "left" | "right";
}

export interface CoreShellOverlayProps {
  readonly cwd?: string;
  readonly sessionFile?: string | null;
}

export interface CoreShellModalProps {
  readonly cwd?: string;
  readonly sessionFile?: string | null;
}

/* ── Sidebar Slot Owner Props ── */

export interface SidebarHeaderSlotProps {
  readonly cwd?: string;
  readonly onNewTask?: () => void;
}

export interface SidebarNavSlotProps {
  readonly cwd?: string;
  readonly sessionFile?: string | null;
  readonly activeView?: string | null;
}

export interface SidebarThreadsSlotProps {
  readonly cwd?: string;
  readonly activeSessionFile?: string | null;
  readonly searchQuery?: string;
}

export interface SidebarSessionRowSlotProps {
  readonly session: SessionInfo;
  readonly active: boolean;
  readonly running?: boolean;
  readonly onSelect: () => void;
  readonly onRename?: (title: string) => void;
  readonly onArchive?: () => void;
  readonly onDelete?: () => void;
}

export interface SidebarSectionSlotProps {
  readonly cwd?: string;
  readonly sessionFile?: string | null;
}

export interface SidebarFooterSlotProps {
  readonly cwd?: string;
  readonly sessionFile?: string | null;
  readonly onOpenSettings?: (page?: string) => void;
}

/* ── Home Slot Owner Props ── */

export interface HomeHeroSlotProps {
  readonly cwd?: string;
  readonly workspaceOptions?: readonly string[];
}

export interface HomeQuickActionSlotProps {
  readonly cwd: string;
  readonly sessionFile: string | null;
  readonly prefillComposer: (prompt: string) => void;
  readonly sendPrompt: (prompt: string) => void;
}

export interface HomeSectionSlotProps {
  readonly cwd?: string;
  readonly sessionFile?: string | null;
}

/* ── Conversation Slot Owner Props ── */

export interface ConversationHeaderSlotProps {
  readonly cwd?: string;
  readonly sessionFile?: string | null;
}

export interface ConversationTranscriptSlotProps {
  readonly cwd?: string;
  readonly sessionFile?: string | null;
  readonly messages?: readonly UiMessage[];
  readonly isStreaming?: boolean;
  readonly isCompacting?: boolean;
  readonly retryStatus?: string | null;
  readonly compact?: boolean;
}

export interface ConversationTurnSlotProps {
  readonly cwd?: string;
  readonly sessionFile?: string | null;
  readonly turnIndex: number;
  readonly userMessage?: UiMessage;
  readonly assistantMessages: readonly UiMessage[];
  readonly isStreaming: boolean;
  readonly isLastTurn: boolean;
  readonly isLastUserTurn?: boolean;
}

export interface ConversationMessageSlotProps {
  readonly cwd?: string;
  readonly sessionFile?: string | null;
  readonly message: UiMessage;
  readonly isStreaming?: boolean;
  readonly isLast?: boolean;
  readonly isLastUserTurn?: boolean;
  readonly turnStartedAt?: number;
  readonly footer?: ReactNode;
  readonly compact?: boolean;
  readonly onRewind?: (message: UiMessage) => void;
  readonly onEditAndResend?: (entryId: string, text: string) => void;
}

export interface ConversationMessageActionSlotProps {
  readonly cwd: string;
  readonly sessionFile: string | null;
  readonly message: UiMessage;
  readonly contentText: string;
}

export interface ConversationThinkingSlotProps {
  readonly cwd?: string;
  readonly sessionFile?: string | null;
  readonly message: UiMessage;
  readonly thinking: string;
  readonly isStreaming?: boolean;
  readonly workSteps?: readonly WorkStep[];
}

export interface ConversationToolCallSlotProps {
  readonly cwd?: string;
  readonly sessionFile?: string | null;
  readonly call: UiToolCall;
  readonly state: "running" | "error" | "ok";
  readonly messageId?: string;
}

export interface ConversationCodeBlockSlotProps {
  readonly cwd?: string;
  readonly sessionFile?: string | null;
  readonly language: string;
  readonly code: string;
  readonly isStreaming?: boolean;
}

export interface ConversationTurnFooterSlotProps {
  readonly cwd?: string;
  readonly sessionFile?: string | null;
  readonly message: UiMessage;
  readonly durationMs?: number;
}

export interface ConversationComposerDockSlotProps {
  readonly cwd?: string;
  readonly sessionFile?: string | null;
  readonly variant?: "task-start" | "follow-up";
  readonly isolated?: boolean;
}

export interface ConversationApprovalDialogSlotProps {
  readonly cwd?: string;
  readonly sessionFile?: string | null;
  readonly request: ExtensionUIRequest;
  readonly onAnswer: (requestId: string, value: unknown) => void;
}

/* ── Composer Slot Owner Props ── */

export interface ComposerSlotBaseProps {
  readonly cwd?: string;
  readonly sessionFile?: string | null;
  readonly variant?: "task-start" | "follow-up";
  readonly sessionKey?: string;
}

export interface ComposerMainSlotProps extends ComposerSlotBaseProps {
  readonly isolated?: boolean;
  readonly isStreaming?: boolean;
  readonly pendingApproval?: boolean;
  readonly onSend?: (text: string, attachments?: AttachmentPayload[]) => void | Promise<boolean>;
}

export interface ComposerAttachmentsSlotProps extends ComposerSlotBaseProps {
  readonly attachments: readonly AttachmentPayload[];
  readonly onRemove?: (index: number) => void;
}

export interface ComposerInputSlotProps extends ComposerSlotBaseProps {
  readonly placeholder?: string;
  readonly disabled?: boolean;
  readonly onSubmit?: () => void;
}

export interface ComposerStatusSlotProps extends ComposerSlotBaseProps {
  readonly position?: "before-model" | "after-model";
}

/* ── Workbench Slot Owner Props ── */

export interface WorkbenchSlotBaseProps {
  readonly cwd?: string;
  readonly sessionFile?: string | null;
}

export interface WorkbenchTilingGridSlotProps extends WorkbenchSlotBaseProps {
  readonly openPanes?: readonly string[];
  readonly maximizedPaneId?: string | null;
}

export interface WorkbenchPaneSlotProps extends WorkbenchSlotBaseProps {
  readonly paneId: string;
  readonly active: boolean;
  readonly maximized?: boolean;
  readonly onClose?: () => void;
}

export interface WorkbenchFileViewerSlotProps extends WorkbenchSlotBaseProps {
  readonly path: string;
  readonly content: string;
  readonly isBinary: boolean;
  readonly mimeType?: string;
  readonly dataBase64?: string;
  readonly size: number;
  readonly truncated?: boolean;
}

export interface WorkbenchBottomTabSlotProps extends WorkbenchSlotBaseProps {
  readonly tabId: string;
  readonly active: boolean;
}

/* ── Settings & Hub Slot Owner Props ── */

export interface SettingsShellSlotProps {
  readonly open?: boolean;
  readonly page?: string;
  readonly cwd?: string;
  readonly sessionFile?: string | null;
  readonly onClose?: () => void;
  readonly onSelectPage?: (page: string) => void;
}

export interface SettingsPageSlotProps {
  readonly cwd?: string;
  readonly sessionFile?: string | null;
  readonly page: string;
  readonly closeSettings: () => void;
}

export interface SettingsSectionSlotProps {
  readonly cwd?: string;
  readonly sessionFile?: string | null;
  readonly page: string;
  readonly closeSettings: () => void;
}

export interface HubPageSlotProps {
  readonly cwd?: string;
  readonly sessionFile?: string | null;
  readonly pageId: string;
  readonly onClose?: () => void;
}

/* ── Canonical Core SlotMap Declaration Merge ── */

export interface CoreSlotMap {
  // Shell / Root
  root: SlotSpec<CoreRootSlotProps, "single", "root">;
  "shell.menubar": SlotSpec<CoreShellMenubarProps, "single", "root">;
  "shell.sidebar": SlotSpec<CoreShellSidebarProps, "single", "root">;
  "shell.topbar": SlotSpec<CoreShellTopbarProps, "single", "root">;
  "shell.stage": SlotSpec<CoreShellStageProps, "chain", "session-maybe">;
  "shell.workbench.right": SlotSpec<CoreWorkbenchRightProps, "single", "session-maybe">;
  "shell.workbench.bottom": SlotSpec<CoreWorkbenchBottomProps, "single", "session-maybe">;
  "shell.statusbar": SlotSpec<CoreStatusbarProps, "list", "session-maybe">;
  "shell.overlays": SlotSpec<CoreShellOverlayProps, "list", "root">;
  "shell.modals": SlotSpec<CoreShellModalProps, "list", "root">;
  // Sidebar
  "sidebar.header": SlotSpec<SidebarHeaderSlotProps, "single", "root">;
  "sidebar.nav": SlotSpec<SidebarNavSlotProps, "list", "root">;
  "sidebar.threads": SlotSpec<SidebarThreadsSlotProps, "single", "root">;
  "sidebar.sessionRow": SlotSpec<SidebarSessionRowSlotProps, "chain", "root">;
  "sidebar.sections": SlotSpec<SidebarSectionSlotProps, "list", "root">;
  "sidebar.footer": SlotSpec<SidebarFooterSlotProps, "single", "root">;
  // Home
  "home.hero": SlotSpec<HomeHeroSlotProps, "single", "root">;
  "home.quickActions": SlotSpec<HomeQuickActionSlotProps, "list", "root">;
  "home.sections": SlotSpec<HomeSectionSlotProps, "list", "root">;
  // Conversation
  "conversation.header": SlotSpec<ConversationHeaderSlotProps, "list", "session">;
  "conversation.transcript": SlotSpec<ConversationTranscriptSlotProps, "single", "session">;
  "conversation.turn": SlotSpec<ConversationTurnSlotProps, "chain", "session">;
  "conversation.message": SlotSpec<ConversationMessageSlotProps, "chain", "session">;
  "conversation.message.actions": SlotSpec<ConversationMessageActionSlotProps, "list", "session">;
  "conversation.thinking": SlotSpec<ConversationThinkingSlotProps, "chain", "session">;
  "conversation.toolCall": SlotSpec<ConversationToolCallSlotProps, "keyed", "session">;
  "conversation.markdown.codeBlock": SlotSpec<ConversationCodeBlockSlotProps, "keyed", "session">;
  "conversation.turnFooter": SlotSpec<ConversationTurnFooterSlotProps, "list", "session">;
  "conversation.composerDock": SlotSpec<ConversationComposerDockSlotProps, "single", "session-maybe">;
  "conversation.approvalDialog": SlotSpec<ConversationApprovalDialogSlotProps, "chain", "session">;
  // Composer
  "composer.main": SlotSpec<ComposerMainSlotProps, "chain", "session-maybe">;
  "composer.banners": SlotSpec<ComposerSlotBaseProps, "list", "session-maybe">;
  "composer.attachments": SlotSpec<ComposerAttachmentsSlotProps, "single", "session-maybe">;
  "composer.input": SlotSpec<ComposerInputSlotProps, "single", "session-maybe">;
  "composer.toolbar": SlotSpec<ComposerSlotBaseProps, "list", "session-maybe">;
  "composer.status": SlotSpec<ComposerStatusSlotProps, "list", "session-maybe">;
  // Workbench
  "workbench.topbarControls": SlotSpec<WorkbenchSlotBaseProps, "list", "session-maybe">;
  "workbench.tilingGrid": SlotSpec<WorkbenchTilingGridSlotProps, "single", "session-maybe">;
  "workbench.panes": SlotSpec<WorkbenchPaneSlotProps, "keyed", "session-maybe">;
  "workbench.fileViewer": SlotSpec<WorkbenchFileViewerSlotProps, "keyed", "session-maybe">;
  "workbench.inspector.sections": SlotSpec<WorkbenchSlotBaseProps, "list", "session-maybe">;
  "workbench.bottom.tabs": SlotSpec<WorkbenchBottomTabSlotProps, "keyed", "session-maybe">;
  // Settings & Hub
  "settings.shell": SlotSpec<SettingsShellSlotProps, "single", "root">;
  "settings.pages": SlotSpec<SettingsPageSlotProps, "keyed", "root">;
  "settings.sections": SlotSpec<SettingsSectionSlotProps, "list", "root">;
  "hub.pages": SlotSpec<HubPageSlotProps, "keyed", "root">;
}

export type CoreSlotKey = keyof CoreSlotMap;

/** Runtime specification table mirroring `CoreSlotMap` (`kind` and `scope` for every core slot). */
export const CORE_SLOT_SPECS: Readonly<Record<CoreSlotKey, ChildSlotDecl>> = {
  root: { kind: "single", scope: "root" },
  "shell.menubar": { kind: "single", scope: "root" },
  "shell.sidebar": { kind: "single", scope: "root" },
  "shell.topbar": { kind: "single", scope: "root" },
  "shell.stage": { kind: "chain", scope: "session-maybe" },
  "shell.workbench.right": { kind: "single", scope: "session-maybe" },
  "shell.workbench.bottom": { kind: "single", scope: "session-maybe" },
  "shell.statusbar": { kind: "list", scope: "session-maybe" },
  "shell.overlays": { kind: "list", scope: "root" },
  "shell.modals": { kind: "list", scope: "root" },
  "sidebar.header": { kind: "single", scope: "root" },
  "sidebar.nav": { kind: "list", scope: "root" },
  "sidebar.threads": { kind: "single", scope: "root" },
  "sidebar.sessionRow": { kind: "chain", scope: "root" },
  "sidebar.sections": { kind: "list", scope: "root" },
  "sidebar.footer": { kind: "single", scope: "root" },
  "home.hero": { kind: "single", scope: "root" },
  "home.quickActions": { kind: "list", scope: "root" },
  "home.sections": { kind: "list", scope: "root" },
  "conversation.header": { kind: "list", scope: "session" },
  "conversation.transcript": { kind: "single", scope: "session" },
  "conversation.turn": { kind: "chain", scope: "session" },
  "conversation.message": { kind: "chain", scope: "session" },
  "conversation.message.actions": { kind: "list", scope: "session" },
  "conversation.thinking": { kind: "chain", scope: "session" },
  "conversation.toolCall": { kind: "keyed", scope: "session" },
  "conversation.markdown.codeBlock": { kind: "keyed", scope: "session" },
  "conversation.turnFooter": { kind: "list", scope: "session" },
  "conversation.composerDock": { kind: "single", scope: "session-maybe" },
  "conversation.approvalDialog": { kind: "chain", scope: "session" },
  "composer.main": { kind: "chain", scope: "session-maybe" },
  "composer.banners": { kind: "list", scope: "session-maybe" },
  "composer.attachments": { kind: "single", scope: "session-maybe" },
  "composer.input": { kind: "single", scope: "session-maybe" },
  "composer.toolbar": { kind: "list", scope: "session-maybe" },
  "composer.status": { kind: "list", scope: "session-maybe" },
  "workbench.topbarControls": { kind: "list", scope: "session-maybe" },
  "workbench.tilingGrid": { kind: "single", scope: "session-maybe" },
  "workbench.panes": { kind: "keyed", scope: "session-maybe" },
  "workbench.fileViewer": { kind: "keyed", scope: "session-maybe" },
  "workbench.inspector.sections": { kind: "list", scope: "session-maybe" },
  "workbench.bottom.tabs": { kind: "keyed", scope: "session-maybe" },
  "settings.shell": { kind: "single", scope: "root" },
  "settings.pages": { kind: "keyed", scope: "root" },
  "settings.sections": { kind: "list", scope: "root" },
  "hub.pages": { kind: "keyed", scope: "root" },
};

declare module "./index" {
  // eslint-disable-next-line @typescript-eslint/no-empty-object-type -- Augments root SlotMap with canonical ADR 0023 core slots.
  interface SlotMap extends CoreSlotMap {}
}

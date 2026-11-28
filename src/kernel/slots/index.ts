/**
 * Authoritative `@qianji/client-slots` frontend microkernel slot engine (ADR 0023 §2).
 */

/* eslint-disable @typescript-eslint/no-empty-object-type --
   Declaration-merged registries live at the package root so builtin and
   external plugins augment them via `declare module "@qianji/client-slots"`. */

/** Declaration-merged map of typed slot keys to their `SlotSpec` definitions. */
export interface SlotMap {
  "bot.connector.sections": {
    readonly kind: "keyed";
    readonly scope: "root";
    readonly props: {
      readonly connectorId: string;
      readonly pluginId?: string;
      readonly connected: boolean;
    };
  };
}

/** Declaration-merged map of reusable component factories (`registerFactory` / `renderFactory`). */
export interface SlotFactoryMap {
  "bot.rail": { readonly props: { readonly active?: boolean }; readonly scope: "root" };
  "bot.stage": { readonly props: { readonly active?: boolean; readonly cwd?: string }; readonly scope: "root" };
}

/** Declaration-merged map of optional i18n locale namespaces and message keys. */
export interface LocaleNamespaceMap {}

/** Declaration-merged map of optional resource URI schemes to resolved payload types. */
export interface ResourceProtocolMap {}

/* eslint-enable @typescript-eslint/no-empty-object-type */

export {
  SlotOwnershipError,
  StaleAuthorizationError,
  type AnyFactoryKey,
  type AnySlotKey,
  type BoundRenderFactoryFn,
  type BoundRenderSlotChainFn,
  type BoundRenderSlotFn,
  type ChildSlotDecl,
  type ChildrenDecl,
  type FactoryPropsOf,
  type FactoryScopeOf,
  type GlobalStandardProps,
  type KnownFactoryKey,
  type KnownSlotKey,
  type LocaleNamespaceKey,
  type PluginTier,
  type RenderFactoryOptions,
  type RenderSlotChainOptions,
  type RenderSlotOptions,
  type ResourceProtocolKey,
  type ResourceValueOf,
  type SessionMaybeStandardProps,
  type SessionStandardProps,
  type SlotCandidateSummary,
  type SlotChainSelector,
  type SlotComponentProps,
  type SlotEntryRecord,
  type SlotFactoryEntryRecord,
  type SlotFactoryRegistrationInput,
  type SlotFactorySpec,
  type SlotInspection,
  type SlotKind,
  type SlotKindOf,
  type SlotPropsOf,
  type SlotRegistrationInput,
  type SlotScope,
  type SlotScopeAdapter,
  type SlotScopeOf,
  type SlotScopeTargetMap,
  type SlotSpec,
  type SlotWrapperComponent,
  type SlotWrapperInput,
  type SlotWrapperProps,
  type SlotWrapperRecord,
  type SlotWrapperRegistrationInput,
  type StandardPropsForScope,
  type TranslateFn,
} from "./types";

export {
  AbdicationTracker,
  resolveDefaultPluginCycle,
  type AbdicateParams,
  type AbdicationCycle,
  type AbdicationCycleProvider,
  type AbdicationListener,
  type AbdicationRecord,
  type AbdicationTrackerOptions,
} from "./abdication";

export {
  clientSlotsRegistry,
  electSlotCandidates,
  matchesRouteKey,
  mirrorContributionToSlot,
  SlotAuthorization,
  SlotRegistry,
  tierWeight,
  type LegacyContributionMirrorItem,
  type RankedSlotCandidate,
  type SlotRegistryOptions,
} from "./registry";

export { ClientSlotsService } from "./service";
export {
  CORE_SLOT_SPECS,
  type ComposerAttachmentsSlotProps,
  type ComposerInputSlotProps,
  type ComposerMainSlotProps,
  type ComposerSlotBaseProps,
  type ComposerStatusSlotProps,
  type ConversationApprovalDialogSlotProps,
  type ConversationCodeBlockSlotProps,
  type ConversationComposerDockSlotProps,
  type ConversationHeaderSlotProps,
  type ConversationMessageActionSlotProps,
  type ConversationMessageSlotProps,
  type ConversationThinkingSlotProps,
  type ConversationToolCallSlotProps,
  type ConversationTranscriptSlotProps,
  type ConversationTurnFooterSlotProps,
  type ConversationTurnSlotProps,
  type CoreRootSlotProps,
  type CoreShellMenubarProps,
  type CoreShellModalProps,
  type CoreShellOverlayProps,
  type CoreShellSidebarProps,
  type CoreShellStageProps,
  type CoreShellTopbarProps,
  type CoreSlotKey,
  type CoreSlotMap,
  type CoreStatusbarProps,
  type CoreWorkbenchBottomProps,
  type CoreWorkbenchRightProps,
  type HomeHeroSlotProps,
  type HomeQuickActionSlotProps,
  type HomeSectionSlotProps,
  type HubPageSlotProps,
  type SettingsPageSlotProps,
  type SettingsSectionSlotProps,
  type SettingsShellSlotProps,
  type SidebarFooterSlotProps,
  type SidebarHeaderSlotProps,
  type SidebarNavSlotProps,
  type SidebarSectionSlotProps,
  type SidebarSessionRowSlotProps,
  type SidebarThreadsSlotProps,
  type WorkbenchBottomTabSlotProps,
  type WorkbenchFileViewerSlotProps,
  type WorkbenchPaneSlotProps,
  type WorkbenchSlotBaseProps,
  type WorkbenchTilingGridSlotProps,
} from "./coreSlotMap";

export {
  createBoundRenderers,
  createResourceCell,
  resolveChainItems,
  SessionArea,
  SessionProvider,
  SlotFactoryHost,
  SlotHost,
  SlotKernelErrorBoundary,
  SlotKernelProvider,
  SlotRoot,
  useResource,
  useSlotScope,
  WrapperErrorBoundary,
  type ResourceCell,
  type ResourceServiceLike,
  type SessionAreaProps,
  type SlotFactoryHostProps,
  type SlotHostProps,
  type SlotKernelErrorBoundaryProps,
  type SlotKernelProviderProps,
  type WrapperErrorBoundaryProps,
} from "./renderer";

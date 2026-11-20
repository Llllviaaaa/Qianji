/**
 * Built-in `core-settings` plugin barrel (`src/builtin-plugins/core-settings/index.ts`).
 */
export {
  BUILTIN_SETTINGS_PAGE_META,
  CORE_SETTINGS_PLUGIN_ID,
  CoreSettingsModalHost,
  CoreSettingsShell,
  coreSettingsPlugin,
  normalizeSettingsPageKey,
  type BuiltinSettingsPageMeta,
} from "./CoreSettingsPlugin";
export {
  AppearanceSettingsSlotPage,
  GeneralSettingsSlotPage,
  ProvidersSettingsSlotPage,
} from "./CoreSettingsBuiltinPages";
export {
  PluginsSettingsSlotPage,
  PluginsSlotsShortcutSection,
} from "./PluginsSettingsPages";
export { SlotCardRow, type SlotCardRowProps } from "./SlotCardRow";
export {
  SlotOwnershipPanel,
  type SafeModeControlLike,
  type SlotOwnershipPanelProps,
} from "./SlotOwnershipPanel";
export {
  CORE_SLOT_METADATA_MAP,
  buildSlotOwnershipRows,
  filterSlotOwnershipRows,
  formatScopeLabel,
  formatSlotKindLabel,
  formatTierLabel,
  type CoreSlotDescriptorMeta,
  type EnrichedSlotCandidate,
  type SlotFilterKind,
  type SlotOwnershipRow,
} from "./slotCatalogMetadata";

/**
 * Public entry point for Qianji's built-in `core-workbench` client plugin (ADR 0023 Wave 2B).
 */
export { CORE_WORKBENCH_PLUGIN_ID, coreWorkbenchPlugin, default } from "./CoreWorkbenchPlugin";
export { CoreCodeWorkspacePane } from "./CoreCodeWorkspacePane";
export {
  CoreInspectorSections,
  InspectorContextSection,
  InspectorDiagnosticsSection,
  InspectorEnvSection,
  InspectorExtensionsSection,
  InspectorOutputsSection,
} from "./CoreInspectorSections";
export { CoreBottomTerminalTab, CoreTerminalPane } from "./CoreTerminalPane";
export {
  CoreChromeTopbarButtons,
  CorePrimaryTopbarButtons,
  CoreTopbarControls,
} from "./CoreTopbarControls";
export { CoreWorkbenchBottom } from "./CoreWorkbenchBottom";
export { CoreWorkbenchRight, CoreWorkbenchTilingGrid } from "./CoreWorkbenchRight";
export {
  buildEffectiveTree,
  computeTileLayout,
  detectPaneDropZone,
  filterRegisteredPanes,
  isPaneRegistered,
  listRegisteredBottomTabIds,
  listRegisteredExtensionPaneIds,
  resolvePaneTitle,
  type ComputedTileLayout,
  type NormalizedRect,
  type WorkbenchTileSash,
} from "./tilingHelpers";

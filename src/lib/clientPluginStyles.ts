/**
 * Compatibility facade delegating to the microkernel style runtime
 * (`src/kernel/runtime/pluginStyles.ts`, ADR 0016 & ADR 0023).
 */
export {
  currentStyleSeq,
  injectPluginGlobalStyle,
  injectPluginScopedStyle,
  installPluginStyleGlobals,
  pruneStaleBundleStyles,
  removeAllPluginScopedStyles,
  removeAllPluginStyles,
  rollbackBundleScopedStyles,
  rollbackBundleStyles,
  snapshotBundleScopedStyles,
  snapshotBundleStyles,
  wrapPluginGlobalCss,
  wrapPluginScopedCss,
  type PluginStyleGlobalHost,
  type PluginStyleMode,
  type PluginStyleSnapshotEntry,
} from "../kernel/runtime/pluginStyles";

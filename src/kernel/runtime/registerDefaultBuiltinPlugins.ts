/**
 * Authoritative registry of all 13 Vite-bundled built-in client plugins
 * (8 core `canDisable: false` plugins + 5 feature `canDisable: true` plugins,
 * ADR 0023 §1 & §6).
 *
 * Lives under `src/kernel/runtime/` rather than `src/builtin-plugins/` so the
 * strict ESLint no-sibling-import boundary on `src/builtin-plugins/**` stays
 * 100% intact without any exception.
 */
import { BOT_MODE_PLUGIN_ID, botModePlugin } from "../../builtin-plugins/bot-mode";
import { CODE_REVIEW_PLUGIN_ID, codeReviewPlugin } from "../../builtin-plugins/code-review";
import { CORE_COMPOSER_PLUGIN_ID, coreComposerPlugin } from "../../builtin-plugins/core-composer";
import { CORE_CONVERSATION_PLUGIN_ID, coreConversationPlugin } from "../../builtin-plugins/core-conversation";
import { CORE_HOME_PLUGIN_ID, coreHomePlugin } from "../../builtin-plugins/core-home";
import { CORE_HUBS_PLUGIN_ID, coreHubsPlugin } from "../../builtin-plugins/core-hubs";
import { CORE_SETTINGS_PLUGIN_ID, coreSettingsPlugin } from "../../builtin-plugins/core-settings";
import { CORE_SHELL_PLUGIN_ID, coreShellPlugin } from "../../builtin-plugins/core-shell";
import { CORE_SIDEBAR_PLUGIN_ID, coreSidebarPlugin } from "../../builtin-plugins/core-sidebar";
import { CORE_WORKBENCH_PLUGIN_ID, coreWorkbenchPlugin } from "../../builtin-plugins/core-workbench";
import { DIAGRAM_VIEWER_PLUGIN_ID, diagramViewerPlugin } from "../../builtin-plugins/diagram-viewer";
import { INTELLIGENT_UI_PLUGIN_ID, intelligentUiPlugin } from "../../builtin-plugins/intelligent-ui";
import { SIDE_CHAT_PLUGIN_ID, sideChatPlugin } from "../../builtin-plugins/side-chat";
import { WEB_PREVIEW_PLUGIN_ID, webPreviewPlugin } from "../../builtin-plugins/web-preview";
import type { BuiltinCorePluginDescriptor } from "./builtinCorePlugins";

/** The 8 non-disableable built-in core UI plugins (overridable by same-ID user/workspace plugins). */
export const DEFAULT_CORE_UI_PLUGINS: readonly BuiltinCorePluginDescriptor[] = [
  { id: CORE_SHELL_PLUGIN_ID, plugin: coreShellPlugin, canDisable: false },
  { id: CORE_SIDEBAR_PLUGIN_ID, plugin: coreSidebarPlugin, canDisable: false },
  { id: CORE_HOME_PLUGIN_ID, plugin: coreHomePlugin, canDisable: false },
  { id: CORE_CONVERSATION_PLUGIN_ID, plugin: coreConversationPlugin, canDisable: false },
  { id: CORE_COMPOSER_PLUGIN_ID, plugin: coreComposerPlugin, canDisable: false },
  { id: CORE_WORKBENCH_PLUGIN_ID, plugin: coreWorkbenchPlugin, canDisable: false },
  { id: CORE_SETTINGS_PLUGIN_ID, plugin: coreSettingsPlugin, canDisable: false },
  { id: CORE_HUBS_PLUGIN_ID, plugin: coreHubsPlugin, canDisable: false },
];

/** The 5 disableable built-in feature plugins (replacing legacy `builtinPluginGatesStore`). */
export const DEFAULT_BUILTIN_FEATURE_PLUGINS: readonly BuiltinCorePluginDescriptor[] = [
  { id: CODE_REVIEW_PLUGIN_ID, plugin: codeReviewPlugin, canDisable: true, defaultEnabled: true },
  { id: WEB_PREVIEW_PLUGIN_ID, plugin: webPreviewPlugin, canDisable: true, defaultEnabled: true },
  { id: SIDE_CHAT_PLUGIN_ID, plugin: sideChatPlugin, canDisable: true, defaultEnabled: true },
  {
    id: DIAGRAM_VIEWER_PLUGIN_ID,
    plugin: diagramViewerPlugin,
    canDisable: true,
    defaultEnabled: true,
    defaultConfig: { enableMermaid: true, enablePlantUml: true },
  },
  { id: INTELLIGENT_UI_PLUGIN_ID, plugin: intelligentUiPlugin, canDisable: true, defaultEnabled: true },
  { id: BOT_MODE_PLUGIN_ID, plugin: botModePlugin, canDisable: true, defaultEnabled: true },
];

/** All 13 default Vite-bundled built-in client plugins mounted during microkernel boot. */
export const DEFAULT_BUILTIN_CLIENT_PLUGINS: readonly BuiltinCorePluginDescriptor[] = [
  ...DEFAULT_CORE_UI_PLUGINS,
  ...DEFAULT_BUILTIN_FEATURE_PLUGINS,
];

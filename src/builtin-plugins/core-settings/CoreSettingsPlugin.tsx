/**
 * Built-in `core-settings` Cordis microkernel plugin (ADR 0023 §5 & §7 Phase 4).
 *
 * - Registers onto `shell.modals` (list), rendering when `navigationService.settingsOpen === true`.
 * - Declares `children` from `CORE_SLOT_SPECS` for `settings.shell` (single),
 *   `settings.pages` (keyed), and `settings.sections` (list).
 * - Registers default `settings.shell`, built-in keyed pages (`general`, `appearance`,
 *   `providers`, `plugins`, `slots`), and the `"plugins"` convenience card linking to `"slots"`.
 */
import type { ReactElement } from "react";
import type { Context, Plugin } from "@deepseek-ai/cordis";
import { CORE_SLOT_SPECS, type SettingsPageSlotProps, type SlotComponentProps } from "@qianji/client-slots";
import {
  AppearanceSettingsSlotPage,
  GeneralSettingsSlotPage,
  ProvidersSettingsSlotPage,
} from "./CoreSettingsBuiltinPages";
import {
  BUILTIN_SETTINGS_PAGE_META,
  CoreSettingsModalHost,
  CoreSettingsShell,
  normalizeSettingsPageKey,
  type BuiltinSettingsPageMeta,
} from "./CoreSettingsShell";
import { PluginsSettingsSlotPage, PluginsSlotsShortcutSection } from "./PluginsSettingsPages";
import { SlotOwnershipPanel } from "./SlotOwnershipPanel";

export const CORE_SETTINGS_PLUGIN_ID = "core-settings";

export {
  BUILTIN_SETTINGS_PAGE_META,
  CoreSettingsModalHost,
  CoreSettingsShell,
  normalizeSettingsPageKey,
  type BuiltinSettingsPageMeta,
};

type PageCompProps = SlotComponentProps<SettingsPageSlotProps, "root">;

function SlotsSettingsSlotPage({ ctx }: PageCompProps): ReactElement {
  return <SlotOwnershipPanel ctx={ctx} />;
}

/** Built-in `core-settings` Cordis microkernel plugin. */
export const coreSettingsPlugin: Plugin = {
  name: CORE_SETTINGS_PLUGIN_ID,
  inject: ["slots", "navigationService", "sessionService", "workspaceService", "themeService"],
  apply(ctx: Context): void {
    ctx.slots.register("shell.modals", {
      id: `${CORE_SETTINGS_PLUGIN_ID}:modal-host`,
      pluginId: CORE_SETTINGS_PLUGIN_ID,
      tier: "builtin",
      order: 10,
      children: {
        "settings.shell": CORE_SLOT_SPECS["settings.shell"],
      },
      component: CoreSettingsModalHost,
    });

    ctx.slots.register("settings.shell", {
      id: `${CORE_SETTINGS_PLUGIN_ID}:shell`,
      pluginId: CORE_SETTINGS_PLUGIN_ID,
      tier: "builtin",
      priority: 0,
      children: {
        "settings.pages": CORE_SLOT_SPECS["settings.pages"],
        "settings.sections": CORE_SLOT_SPECS["settings.sections"],
      },
      component: CoreSettingsShell,
    });

    ctx.slots.register("settings.pages", {
      id: `${CORE_SETTINGS_PLUGIN_ID}:page:general`,
      pluginId: CORE_SETTINGS_PLUGIN_ID,
      tier: "builtin",
      priority: 0,
      key: "general",
      component: GeneralSettingsSlotPage,
    });

    ctx.slots.register("settings.pages", {
      id: `${CORE_SETTINGS_PLUGIN_ID}:page:appearance`,
      pluginId: CORE_SETTINGS_PLUGIN_ID,
      tier: "builtin",
      priority: 0,
      key: "appearance",
      component: AppearanceSettingsSlotPage,
    });

    ctx.slots.register("settings.pages", {
      id: `${CORE_SETTINGS_PLUGIN_ID}:page:providers`,
      pluginId: CORE_SETTINGS_PLUGIN_ID,
      tier: "builtin",
      priority: 0,
      key: "providers",
      component: ProvidersSettingsSlotPage,
    });

    ctx.slots.register("settings.pages", {
      id: `${CORE_SETTINGS_PLUGIN_ID}:page:plugins`,
      pluginId: CORE_SETTINGS_PLUGIN_ID,
      tier: "builtin",
      priority: 0,
      key: "plugins",
      component: PluginsSettingsSlotPage,
    });

    ctx.slots.register("settings.pages", {
      id: `${CORE_SETTINGS_PLUGIN_ID}:page:slots`,
      pluginId: CORE_SETTINGS_PLUGIN_ID,
      tier: "builtin",
      priority: 0,
      key: ["slots", "plugin:slots"],
      component: SlotsSettingsSlotPage,
    });

    ctx.slots.register("settings.sections", {
      id: `${CORE_SETTINGS_PLUGIN_ID}:section:plugins-slots-shortcut`,
      pluginId: CORE_SETTINGS_PLUGIN_ID,
      tier: "builtin",
      order: 20,
      component: PluginsSlotsShortcutSection,
    });
  },
};

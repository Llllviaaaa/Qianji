/**
 * Built-in `core-composer` Cordis client plugin (ADR 0023 Wave 2B).
 *
 * Registers Qianji's default composer onto `"composer.main"` (chain, low
 * builtin priority `-100`, always matching as fallback so higher-priority
 * plugins can temporarily take over with `overlay: true` while preserving
 * underlying draft & DOM state), claims child slots `composer.banners`,
 * `composer.attachments`, `composer.input`, `composer.toolbar`, and
 * `composer.status`, and provides default built-in implementations for each.
 */
import type { Context, Plugin } from "@deepseek-ai/cordis";
import { CORE_SLOT_SPECS } from "@qianji/client-slots";
import { CoreComposerInput } from "./CoreComposerInput";
import { CoreComposerMain } from "./CoreComposerPlugin";
import {
  CoreComposerAttachments,
  CoreComposerBanners,
  CoreComposerStatus,
  CoreComposerToolbar,
} from "./CoreComposerSlots";

export const CORE_COMPOSER_PLUGIN_ID = "core-composer";

export {
  CoreComposerAttachments,
  CoreComposerBanners,
  CoreComposerInput,
  CoreComposerMain,
  CoreComposerStatus,
  CoreComposerToolbar,
};

export const coreComposerPlugin: Plugin.Object = {
  name: CORE_COMPOSER_PLUGIN_ID,
  inject: [
    "slots",
    "composerService",
    "sessionService",
    "workspaceService",
    "themeService",
    "navigationService",
  ],
  apply(ctx: Context): void {
    ctx.slots.register("composer.main", {
      id: `${CORE_COMPOSER_PLUGIN_ID}:main`,
      pluginId: CORE_COMPOSER_PLUGIN_ID,
      tier: "builtin",
      priority: -100,
      select: () => true,
      children: {
        "composer.banners": CORE_SLOT_SPECS["composer.banners"],
        "composer.attachments": CORE_SLOT_SPECS["composer.attachments"],
        "composer.input": CORE_SLOT_SPECS["composer.input"],
        "composer.toolbar": CORE_SLOT_SPECS["composer.toolbar"],
        "composer.status": CORE_SLOT_SPECS["composer.status"],
      },
      component: CoreComposerMain,
    });

    ctx.slots.register("composer.banners", {
      id: `${CORE_COMPOSER_PLUGIN_ID}:banners:legacy`,
      pluginId: CORE_COMPOSER_PLUGIN_ID,
      tier: "builtin",
      order: 100,
      component: CoreComposerBanners,
    });

    ctx.slots.register("composer.attachments", {
      id: `${CORE_COMPOSER_PLUGIN_ID}:attachments`,
      pluginId: CORE_COMPOSER_PLUGIN_ID,
      tier: "builtin",
      priority: -100,
      component: CoreComposerAttachments,
    });

    ctx.slots.register("composer.input", {
      id: `${CORE_COMPOSER_PLUGIN_ID}:input`,
      pluginId: CORE_COMPOSER_PLUGIN_ID,
      tier: "builtin",
      priority: -100,
      component: CoreComposerInput,
    });

    ctx.slots.register("composer.toolbar", {
      id: `${CORE_COMPOSER_PLUGIN_ID}:toolbar`,
      pluginId: CORE_COMPOSER_PLUGIN_ID,
      tier: "builtin",
      order: 10,
      component: CoreComposerToolbar,
    });

    ctx.slots.register("composer.status", {
      id: `${CORE_COMPOSER_PLUGIN_ID}:status`,
      pluginId: CORE_COMPOSER_PLUGIN_ID,
      tier: "builtin",
      order: 10,
      component: CoreComposerStatus,
    });
  },
};

import type { Context, Plugin } from "@deepseek-ai/cordis";
import { CORE_SLOT_SPECS, type CoreShellStageProps } from "@qianji/client-slots";
import { CoreHomeHero, CoreHomeStage } from "./CoreHomePlugin";

export const CORE_HOME_PLUGIN_ID = "core-home";

export { CoreHomeHero, CoreHomeStage };

function selectHomeStage(ownerProps: CoreShellStageProps): boolean {
  if (ownerProps.hubView !== null && ownerProps.hubView !== undefined) return false;
  if (ownerProps.route?.kind === "hub" || ownerProps.route?.kind === "plugin-page") return false;
  if (ownerProps.draftMode === true) return true;
  if (ownerProps.draftMode === false) return false;
  if (ownerProps.route?.kind === "home") return true;
  if (ownerProps.route?.kind === "session") return false;
  return ownerProps.sessionFile === null || ownerProps.sessionFile === undefined;
}

export const coreHomePlugin: Plugin.Object = {
  name: CORE_HOME_PLUGIN_ID,
  inject: [
    "slots",
    "navigationService",
    "sessionService",
    "workspaceService",
    "composerService",
    "themeService",
  ],
  apply(ctx: Context) {
    ctx.slots.register("shell.stage", {
      id: `${CORE_HOME_PLUGIN_ID}:stage`,
      pluginId: CORE_HOME_PLUGIN_ID,
      tier: "builtin",
      priority: 0,
      select: selectHomeStage,
      children: {
        "home.hero": CORE_SLOT_SPECS["home.hero"],
        "home.quickActions": CORE_SLOT_SPECS["home.quickActions"],
        "home.sections": CORE_SLOT_SPECS["home.sections"],
      },
      component: CoreHomeStage,
    });

    ctx.slots.register("home.hero", {
      id: `${CORE_HOME_PLUGIN_ID}:hero`,
      pluginId: CORE_HOME_PLUGIN_ID,
      tier: "builtin",
      priority: 0,
      component: CoreHomeHero,
    });
  },
};

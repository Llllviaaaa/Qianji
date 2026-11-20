import type { Context, Plugin } from "@deepseek-ai/cordis";
import type { NavigationHubView } from "@qianji/client";
import { CORE_SLOT_SPECS, type CoreShellStageProps } from "@qianji/client-slots";
import { CoreHubsStage } from "./CoreHubsPlugin";
import { PluginsHubPageView } from "./PluginsHubPageView";
import { ScheduledTasksHubPage } from "./ScheduledTasksHubPage";

export const CORE_HUBS_PLUGIN_ID = "core-hubs";

export { CoreHubsStage, PluginsHubPageView, ScheduledTasksHubPage };

function selectHubStage(ownerProps: CoreShellStageProps): NavigationHubView | false {
  if (ownerProps.hubView !== null && ownerProps.hubView !== undefined) {
    return ownerProps.hubView;
  }
  if (ownerProps.route?.kind === "hub") {
    return ownerProps.route.view;
  }
  if (ownerProps.route?.kind === "plugin-page") {
    return `plugin:${ownerProps.route.pageId}`;
  }
  return false;
}

export const coreHubsPlugin: Plugin.Object = {
  name: CORE_HUBS_PLUGIN_ID,
  inject: [
    "slots",
    "navigationService",
    "sessionService",
    "workspaceService",
    "rpcService",
  ],
  apply(ctx: Context) {
    ctx.slots.register("shell.stage", {
      id: `${CORE_HUBS_PLUGIN_ID}:stage`,
      pluginId: CORE_HUBS_PLUGIN_ID,
      tier: "builtin",
      priority: 0,
      select: selectHubStage,
      children: {
        "hub.pages": CORE_SLOT_SPECS["hub.pages"],
      },
      component: CoreHubsStage,
    });

    ctx.slots.register("hub.pages", {
      id: `${CORE_HUBS_PLUGIN_ID}:page:scheduled`,
      pluginId: CORE_HUBS_PLUGIN_ID,
      tier: "builtin",
      priority: 0,
      key: "scheduled",
      component: ScheduledTasksHubPage,
    });

    ctx.slots.register("hub.pages", {
      id: `${CORE_HUBS_PLUGIN_ID}:page:plugins`,
      pluginId: CORE_HUBS_PLUGIN_ID,
      tier: "builtin",
      priority: 0,
      key: "plugins",
      component: PluginsHubPageView,
    });
  },
};

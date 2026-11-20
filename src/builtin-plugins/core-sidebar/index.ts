import type { Context, Plugin } from "@deepseek-ai/cordis";
import { CORE_SLOT_SPECS } from "@qianji/client-slots";
import { CoreSidebarHeader, CoreSidebarPrimaryNav, SidebarPluginNavItems } from "./CoreSidebarHeaderNav";
import { CoreSidebarFooter, CoreSidebarRoot } from "./CoreSidebarPlugin";
import { CoreSidebarSessionRow, CoreSidebarThreads } from "./CoreSidebarThreads";

export const CORE_SIDEBAR_PLUGIN_ID = "core-sidebar";

export {
  CoreSidebarFooter,
  CoreSidebarHeader,
  CoreSidebarPrimaryNav,
  CoreSidebarRoot,
  CoreSidebarSessionRow,
  CoreSidebarThreads,
  SidebarPluginNavItems,
};

export const coreSidebarPlugin: Plugin.Object = {
  name: CORE_SIDEBAR_PLUGIN_ID,
  inject: [
    "slots",
    "navigationService",
    "sessionService",
    "workspaceService",
    "themeService",
    "menuService",
  ],
  apply(ctx: Context) {
    ctx.slots.register("shell.sidebar", {
      id: `${CORE_SIDEBAR_PLUGIN_ID}:sidebar`,
      pluginId: CORE_SIDEBAR_PLUGIN_ID,
      tier: "builtin",
      priority: 0,
      children: {
        "sidebar.header": CORE_SLOT_SPECS["sidebar.header"],
        "sidebar.nav": CORE_SLOT_SPECS["sidebar.nav"],
        "sidebar.threads": CORE_SLOT_SPECS["sidebar.threads"],
        "sidebar.sessionRow": CORE_SLOT_SPECS["sidebar.sessionRow"],
        "sidebar.sections": CORE_SLOT_SPECS["sidebar.sections"],
        "sidebar.footer": CORE_SLOT_SPECS["sidebar.footer"],
      },
      component: CoreSidebarRoot,
    });

    ctx.slots.register("sidebar.header", {
      id: `${CORE_SIDEBAR_PLUGIN_ID}:header`,
      pluginId: CORE_SIDEBAR_PLUGIN_ID,
      tier: "builtin",
      priority: 0,
      component: CoreSidebarHeader,
    });

    ctx.slots.register("sidebar.nav", {
      id: `${CORE_SIDEBAR_PLUGIN_ID}:nav`,
      pluginId: CORE_SIDEBAR_PLUGIN_ID,
      tier: "builtin",
      order: 10,
      component: CoreSidebarPrimaryNav,
    });

    ctx.slots.register("sidebar.threads", {
      id: `${CORE_SIDEBAR_PLUGIN_ID}:threads`,
      pluginId: CORE_SIDEBAR_PLUGIN_ID,
      tier: "builtin",
      priority: 0,
      component: CoreSidebarThreads,
    });

    ctx.slots.register("sidebar.sessionRow", {
      id: `${CORE_SIDEBAR_PLUGIN_ID}:session-row`,
      pluginId: CORE_SIDEBAR_PLUGIN_ID,
      tier: "builtin",
      priority: 0,
      select: () => true,
      component: CoreSidebarSessionRow,
    });

    ctx.slots.register("sidebar.footer", {
      id: `${CORE_SIDEBAR_PLUGIN_ID}:footer`,
      pluginId: CORE_SIDEBAR_PLUGIN_ID,
      tier: "builtin",
      priority: 0,
      component: CoreSidebarFooter,
    });
  },
};

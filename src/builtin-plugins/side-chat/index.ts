/**
 * Built-in `side-chat` Cordis client plugin (`src/builtin-plugins/side-chat/index.ts`, ADR 0023).
 *
 * Eliminates the fake `sideChatEnabled` gate by registering its keyed `"side-chat"`
 * pane (wrapped in `<SessionArea sessionId={...}>`) into `workbench.panes` and
 * its topbar toggle into `workbench.topbarControls`.
 */
import type { Context, Plugin } from "@deepseek-ai/cordis";
import { SideChatTab, SideChatTopbarButton } from "./SideChatTab";

export const SIDE_CHAT_PLUGIN_ID = "side-chat";

export const sideChatPlugin: Plugin = {
  name: SIDE_CHAT_PLUGIN_ID,
  inject: ["slots", "workbenchService", "sessionService", "workspaceService"],
  apply(ctx: Context): void {
    ctx.slots.register("workbench.panes", {
      id: `${SIDE_CHAT_PLUGIN_ID}:pane`,
      key: "side-chat",
      priority: 0,
      component: SideChatTab,
    });

    ctx.slots.register("workbench.topbarControls", {
      id: `${SIDE_CHAT_PLUGIN_ID}:topbar`,
      order: 50,
      component: SideChatTopbarButton,
    });
  },
};

export { SideChatTab, SideChatTopbarButton };
export default sideChatPlugin;

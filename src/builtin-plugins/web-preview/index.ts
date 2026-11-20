/**
 * Built-in `web-preview` Cordis client plugin (`src/builtin-plugins/web-preview/index.ts`, ADR 0023).
 *
 * Eliminates the fake `webPreviewEnabled` gate by registering its keyed `"preview"`
 * pane into `workbench.panes` and its topbar toggle into `workbench.topbarControls`.
 */
import type { Context, Plugin } from "@deepseek-ai/cordis";
import { BrowserPreviewTab, sanitizePreviewUrl, WebPreviewTopbarButton } from "./BrowserPreviewTab";

export const WEB_PREVIEW_PLUGIN_ID = "web-preview";

export const webPreviewPlugin: Plugin = {
  name: WEB_PREVIEW_PLUGIN_ID,
  inject: ["slots", "workbenchService", "workspaceService"],
  apply(ctx: Context): void {
    ctx.slots.register("workbench.panes", {
      id: `${WEB_PREVIEW_PLUGIN_ID}:pane`,
      key: "preview",
      priority: 0,
      component: BrowserPreviewTab,
    });

    ctx.slots.register("workbench.topbarControls", {
      id: `${WEB_PREVIEW_PLUGIN_ID}:topbar`,
      order: 20,
      component: WebPreviewTopbarButton,
    });
  },
};

export { BrowserPreviewTab, sanitizePreviewUrl, WebPreviewTopbarButton };
export default webPreviewPlugin;

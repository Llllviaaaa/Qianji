/**
 * Built-in `code-review` Cordis client plugin (`src/builtin-plugins/code-review/index.ts`, ADR 0023).
 *
 * Eliminates the fake `codeReviewEnabled` gate by registering its keyed `"review"`
 * pane into `workbench.panes` and its topbar toggle into `workbench.topbarControls`.
 */
import type { Context, Plugin } from "@deepseek-ai/cordis";
import { CodeReviewTopbarButton, ReviewDiffTab } from "./ReviewDiffTab";

export const CODE_REVIEW_PLUGIN_ID = "code-review";

export const codeReviewPlugin: Plugin = {
  name: CODE_REVIEW_PLUGIN_ID,
  inject: ["slots", "workbenchService", "workspaceService", "sessionService"],
  apply(ctx: Context): void {
    ctx.slots.register("workbench.panes", {
      id: `${CODE_REVIEW_PLUGIN_ID}:pane`,
      key: "review",
      priority: 0,
      component: ReviewDiffTab,
    });

    ctx.slots.register("workbench.topbarControls", {
      id: `${CODE_REVIEW_PLUGIN_ID}:topbar`,
      order: 10,
      component: CodeReviewTopbarButton,
    });
  },
};

export { CodeReviewTopbarButton, ReviewDiffTab };
export default codeReviewPlugin;

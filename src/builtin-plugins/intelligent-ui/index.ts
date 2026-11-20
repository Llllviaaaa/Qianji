/**
 * Built-in `intelligent-ui` Cordis client plugin (`src/builtin-plugins/intelligent-ui/index.ts`, ADR 0023).
 *
 * Registers its keyed `"intelligent-ui-canvas"` pane into `workbench.panes` and
 * observes `sessionService` within its own Cordis Fiber to open the canvas
 * automatically when a live streaming turn emits an HTML `render_ui` widget.
 */
import type { Context, Plugin } from "@deepseek-ai/cordis";
import type { ConversationToolCallSlotProps, SlotComponentProps } from "@qianji/client-slots";
import { deriveSessionWidgets } from "./artifactParser";
import { IntelligentUiCanvasTab } from "./IntelligentUiCanvasTab";

export const INTELLIGENT_UI_PLUGIN_ID = "intelligent-ui";
export const INTELLIGENT_UI_CANVAS_PANE_ID = "intelligent-ui-canvas";

function IntelligentUiInlineToolCall({
  call,
  messageId,
  renderFactory,
}: SlotComponentProps<ConversationToolCallSlotProps, "session">) {
  return renderFactory("host.intelligentUi.inlineCard", {
    call,
    ...(messageId === undefined ? {} : { messageId }),
  });
}

export const intelligentUiPlugin: Plugin = {
  name: INTELLIGENT_UI_PLUGIN_ID,
  inject: ["slots", "workbenchService", "sessionService", "composerService"],
  apply(ctx: Context): void {
    ctx.slots.register("workbench.panes", {
      id: `${INTELLIGENT_UI_PLUGIN_ID}:canvas-pane`,
      key: INTELLIGENT_UI_CANVAS_PANE_ID,
      priority: 0,
      component: IntelligentUiCanvasTab,
    });

    ctx.slots.register("conversation.toolCall", {
      id: `${INTELLIGENT_UI_PLUGIN_ID}:inline-tool`,
      key: ["render_ui", "update_ui"],
      priority: 0,
      component: IntelligentUiInlineToolCall,
    });

    const seenHtmlArtifacts = new Set<string>();
    const initial = ctx.sessionService.getSnapshot();
    for (const grp of deriveSessionWidgets(initial.messages)) {
      if (grp.latest.engine === "html") {
        seenHtmlArtifacts.add(`${initial.sessionFile ?? "draft"}::${grp.id}::v${grp.latest.version}`);
      }
    }

    const unsubscribe = ctx.sessionService.subscribe(() => {
      const snap = ctx.sessionService.getSnapshot();
      if (snap.messages.length === 0) return;
      for (const grp of deriveSessionWidgets(snap.messages)) {
        if (grp.latest.engine !== "html") continue;
        const key = `${snap.sessionFile ?? "draft"}::${grp.id}::v${grp.latest.version}`;
        if (!seenHtmlArtifacts.has(key)) {
          seenHtmlArtifacts.add(key);
          if (snap.isStreaming) {
            ctx.workbenchService.openPane(INTELLIGENT_UI_CANVAS_PANE_ID);
          }
        }
      }
    });

    ctx.effect(() => () => {
      unsubscribe();
      seenHtmlArtifacts.clear();
    });
  },
};

export { IntelligentUiCanvasTab };
export default intelligentUiPlugin;

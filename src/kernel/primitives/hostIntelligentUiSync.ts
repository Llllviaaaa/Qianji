/**
 * Auto-open sync for live streaming HTML `render_ui` widgets into the Right
 * Workbench Canvas (`intelligent-ui-canvas`), gated by live `SlotRegistry`.
 */
import { deriveSessionIntelligentUis, INTELLIGENT_UI_CANVAS_TAB_ID } from "../../lib/intelligentUi";
import { groupTranscriptMessages } from "../../lib/transcriptTurns";
import { useAppStore } from "../../store";
import { useIntelligentUiStore } from "../../stores/intelligentUiStore";
import { useWorkbenchStore } from "../../stores/workbenchStore";
import type { UiMessage } from "../../types";
import { isWorkbenchPaneAvailable } from "../runtime/featureSlotQueries";

export function installIntelligentUiAutoOpenSync(): () => void {
  let trackedSessionFile: string | null = useAppStore.getState().sessionFile;
  let seenHtmlKeys = new Set<string>();
  let lastMessagesRef = useAppStore.getState().messages;

  const collectHtmlKeys = (messages: readonly UiMessage[]) => {
    const summary = deriveSessionIntelligentUis(groupTranscriptMessages([...messages]));
    const entries: Array<{ key: string; widgetId: string }> = [];
    for (const grp of summary.orderedGroups) {
      for (const ver of grp.versions) {
        if (ver.engine === "html") {
          entries.push({ key: `${grp.id}:v${ver.version}`, widgetId: grp.id });
        }
      }
    }
    return entries;
  };

  for (const item of collectHtmlKeys(lastMessagesRef)) {
    seenHtmlKeys.add(item.key);
  }

  return useAppStore.subscribe((state) => {
    if (state.sessionFile !== trackedSessionFile) {
      trackedSessionFile = state.sessionFile;
      seenHtmlKeys = new Set(collectHtmlKeys(state.messages).map((item) => item.key));
      lastMessagesRef = state.messages;
      return;
    }
    if (state.messages === lastMessagesRef) return;
    lastMessagesRef = state.messages;

    const currentItems = collectHtmlKeys(state.messages);
    const newlyArrived = currentItems.filter((item) => !seenHtmlKeys.has(item.key));
    for (const item of newlyArrived) {
      seenHtmlKeys.add(item.key);
    }

    if (newlyArrived.length === 0 || !state.isStreaming) return;
    if (!useIntelligentUiStore.getState().pluginEnabled) return;
    if (!isWorkbenchPaneAvailable(INTELLIGENT_UI_CANVAS_TAB_ID)) return;

    const latest = newlyArrived[newlyArrived.length - 1];
    if (latest !== undefined) {
      useIntelligentUiStore.getState().setSelectedWidgetId(latest.widgetId);
      useWorkbenchStore.getState().openTab(INTELLIGENT_UI_CANVAS_TAB_ID);
    }
  });
}

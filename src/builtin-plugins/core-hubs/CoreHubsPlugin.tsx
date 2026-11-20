import { useCallback, useSyncExternalStore, type ReactNode } from "react";
import {
  useClientContributions,
  useFrontendService,
  useNavigationState,
  useSessionState,
  useWorkspaceState,
  type NavigationHubView,
  type WorkbenchSlotContext,
} from "@qianji/client";
import {
  SlotKernelErrorBoundary,
  type CoreShellStageProps,
  type SlotComponentProps,
} from "@qianji/client-slots";

const NOOP_UNSUB = (): void => undefined;

function LegacyHubPageBody({
  renderFn,
  context,
}: {
  readonly renderFn: (ctx: WorkbenchSlotContext) => ReactNode;
  readonly context: WorkbenchSlotContext;
}): ReactNode {
  return renderFn(context);
}

export function CoreHubsStage(
  props: SlotComponentProps<CoreShellStageProps, "session-maybe", unknown, NavigationHubView>,
) {
  const { renderSlot, ctx, selected } = props;
  const navigationService = useFrontendService("navigationService", ctx);
  const navSnap = useNavigationState(ctx);
  const sessionSnap = useSessionState(ctx);
  const workspaceSnap = useWorkspaceState(ctx);
  const contributions = useClientContributions();

  const slotsRegistry = ctx?.slots?.registry;
  const subscribeSlots = useCallback(
    (listener: () => void) => (slotsRegistry === undefined ? NOOP_UNSUB : slotsRegistry.subscribe(listener)),
    [slotsRegistry],
  );
  const getSlotsVersion = useCallback(
    () => (slotsRegistry === undefined ? 0 : slotsRegistry.getVersion()),
    [slotsRegistry],
  );
  useSyncExternalStore(subscribeSlots, getSlotsVersion, getSlotsVersion);

  const activeHub = selected ?? props.hubView ?? navSnap?.hubView ?? null;
  if (activeHub === null) return null;

  const cwd = props.cwd ?? workspaceSnap?.cwd ?? sessionSnap?.cwd ?? "";
  const sessionFile = props.sessionFile !== undefined ? props.sessionFile : (sessionSnap?.sessionFile ?? null);
  const handleClose = () => navigationService?.setHubView(null);

  if (activeHub.startsWith("plugin:")) {
    const targetPageId = activeHub.slice("plugin:".length);
    const hasShortKey = (slotsRegistry?.getKeyedCandidates("hub.pages", targetPageId).length ?? 0) > 0;
    const hasPrefixedKey = !hasShortKey && (slotsRegistry?.getKeyedCandidates("hub.pages", activeHub).length ?? 0) > 0;
    if (hasShortKey || hasPrefixedKey) {
      const routeKey = hasShortKey ? targetPageId : activeHub;
      return (
        <div className="pid-plugin-page-stage" data-core-plugin="core-hubs" data-hub-page={targetPageId}>
          {renderSlot(
            "hub.pages",
            { cwd, sessionFile, pageId: targetPageId, onClose: handleClose },
            { key: routeKey },
          )}
        </div>
      );
    }

    const legacyPage = contributions.pages.find((page) => page.id === targetPageId);
    if (legacyPage !== undefined) {
      const resolvedPluginId = legacyPage.pluginId ?? "builtin";
      return (
        <div className="pid-plugin-page-stage" data-core-plugin="core-hubs" data-hub-page={targetPageId}>
          <div
            data-qj-plugin={resolvedPluginId}
            data-qj-slot="pages"
            data-qj-legacy-slot="pages"
            data-qj-entry={legacyPage.id}
            style={{ display: "contents" }}
          >
            <SlotKernelErrorBoundary
              pluginId={resolvedPluginId}
              entryId={`legacy:pages:${legacyPage.id}`}
              slotKey="pages"
            >
              <LegacyHubPageBody renderFn={legacyPage.render} context={{ cwd, sessionFile }} />
            </SlotKernelErrorBoundary>
          </div>
        </div>
      );
    }

    return (
      <div className="pid-plugin-page-stage" data-core-plugin="core-hubs" data-hub-page={targetPageId}>
        <div style={{ padding: 24 }}>
          <p>未找到插件页面：{targetPageId}</p>
          <button type="button" onClick={handleClose}>
            返回对话
          </button>
        </div>
      </div>
    );
  }

  return (
    <>
      {renderSlot(
        "hub.pages",
        { cwd, sessionFile, pageId: activeHub, onClose: handleClose },
        { key: activeHub },
      )}
    </>
  );
}

import { useCallback, useState, useSyncExternalStore, type ReactNode } from "react";
import { ShieldAlert, ShieldCheck } from "lucide-react";
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

function HubWorkspaceTrustBanner({
  workspace,
  trusted,
  hasProjectPlugins,
  hasProjectConfig,
  pluginIds,
  onTrust,
  onOpenPlugins,
}: {
  readonly workspace: string;
  readonly trusted: boolean;
  readonly hasProjectPlugins: boolean;
  readonly hasProjectConfig: boolean;
  readonly pluginIds: readonly string[];
  readonly onTrust: () => Promise<void>;
  readonly onOpenPlugins: () => void;
}): ReactNode {
  const [dismissedWorkspace, setDismissedWorkspace] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  if (
    workspace.trim() === "" ||
    dismissedWorkspace === workspace ||
    trusted ||
    (!hasProjectPlugins && !hasProjectConfig)
  ) {
    return null;
  }

  const summary =
    pluginIds.length > 0
      ? `检测到当前项目包含 ${pluginIds.length} 个项目级插件（${pluginIds.join("、")}），出于安全保护默认暂未运行。`
      : "检测到当前项目包含项目级插件配置（.qianji/harness.json），出于安全保护默认暂未生效。";

  return (
    <div className="workspace-trust-banner" role="region" aria-label="工作区插件信任提示">
      <div className="workspace-trust-copy">
        <ShieldAlert size={16} />
        <span>{summary}</span>
      </div>
      <div className="workspace-trust-actions">
        <button type="button" className="plugin-mini-button" onClick={onOpenPlugins}>
          查看详情
        </button>
        <button
          type="button"
          className="plugin-mini-button"
          onClick={() => setDismissedWorkspace(workspace)}
        >
          暂不信任
        </button>
        <button
          type="button"
          className="primary-button"
          disabled={pending}
          onClick={() => {
            setPending(true);
            void onTrust().finally(() => setPending(false));
          }}
        >
          <ShieldCheck size={14} />
          <span>{pending ? "正在启用…" : "信任并启用项目插件"}</span>
        </button>
      </div>
    </div>
  );
}

export function CoreHubsStage(
  props: SlotComponentProps<CoreShellStageProps, "session-maybe", unknown, NavigationHubView>,
) {
  const { renderSlot, ctx, selected } = props;
  const navigationService = useFrontendService("navigationService", ctx);
  const workspaceService = useFrontendService("workspaceService", ctx);
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
  const trust = workspaceSnap?.trust;
  const trustBanner =
    activeHub !== "plugins" && trust !== undefined ? (
      <HubWorkspaceTrustBanner
        workspace={cwd}
        trusted={trust.trusted}
        hasProjectPlugins={trust.hasProjectPlugins}
        hasProjectConfig={trust.hasProjectConfig}
        pluginIds={trust.pluginIds}
        onOpenPlugins={() => navigationService?.navigate({ kind: "hub", view: "plugins" })}
        onTrust={async () => {
          if (workspaceService === undefined) return;
          try {
            await workspaceService.setWorkspaceTrust(cwd, true);
            navigationService?.showToast("已信任工作区并启用项目级插件", "info");
          } catch (error) {
            const msg = error instanceof Error ? error.message : String(error);
            navigationService?.showToast(`信任工作区失败：${msg}`, "error");
          }
        }}
      />
    ) : null;

  if (activeHub.startsWith("plugin:")) {
    const targetPageId = activeHub.slice("plugin:".length);
    const hasShortKey = (slotsRegistry?.getKeyedCandidates("hub.pages", targetPageId).length ?? 0) > 0;
    const hasPrefixedKey = !hasShortKey && (slotsRegistry?.getKeyedCandidates("hub.pages", activeHub).length ?? 0) > 0;
    if (hasShortKey || hasPrefixedKey) {
      const routeKey = hasShortKey ? targetPageId : activeHub;
      return (
        <>
          {trustBanner}
          <div className="pid-plugin-page-stage" data-core-plugin="core-hubs" data-hub-page={targetPageId}>
            {renderSlot(
              "hub.pages",
              { cwd, sessionFile, pageId: targetPageId, onClose: handleClose },
              { key: routeKey },
            )}
          </div>
        </>
      );
    }

    const legacyPage = contributions.pages.find((page) => page.id === targetPageId);
    if (legacyPage !== undefined) {
      const resolvedPluginId = legacyPage.pluginId ?? "builtin";
      return (
        <>
          {trustBanner}
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
        </>
      );
    }

    return (
      <>
        {trustBanner}
        <div className="pid-plugin-page-stage" data-core-plugin="core-hubs" data-hub-page={targetPageId}>
          <div style={{ padding: 24 }}>
            <p>未找到插件页面：{targetPageId}</p>
            <button type="button" onClick={handleClose}>
              返回对话
            </button>
          </div>
        </div>
      </>
    );
  }

  return (
    <>
      {trustBanner}
      {renderSlot(
        "hub.pages",
        { cwd, sessionFile, pageId: activeHub, onClose: handleClose },
        { key: activeHub },
      )}
    </>
  );
}

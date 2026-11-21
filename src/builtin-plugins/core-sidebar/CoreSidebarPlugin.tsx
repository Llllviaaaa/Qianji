import { useCallback, useSyncExternalStore } from "react";
import { Settings } from "lucide-react";
import {
  useClientContributions,
  useFrontendService,
  useNavigationState,
  useSessionState,
  useThemeState,
  useWorkspaceState,
} from "@qianji/client";
import type {
  CoreShellSidebarProps,
  SidebarFooterSlotProps,
  SlotComponentProps,
} from "@qianji/client-slots";
import { dispatchSidebarClosePopovers, dispatchSidebarClosePreview, LegacySidebarSectionHost } from "./sidebarHelpers";

const NOOP_UNSUB = (): void => undefined;

export function CoreSidebarFooter(props: SlotComponentProps<SidebarFooterSlotProps, "root">) {
  const { ctx } = props;
  const navigationService = useFrontendService("navigationService", ctx);
  const themeSnap = useThemeState(ctx);
  const settingsShortcut = themeSnap?.shortcutSettings || "Ctrl+,";

  const handleOpenSettings = () => {
    dispatchSidebarClosePopovers();
    dispatchSidebarClosePreview();
    if (props.onOpenSettings !== undefined) {
      props.onOpenSettings("general");
    } else {
      navigationService?.openSettings("general");
    }
  };

  return (
    <div className="sidebar-footer codex-footer">
      <button
        type="button"
        className="footer-account dsh-claude-account-btn"
        onClick={handleOpenSettings}
        title={settingsShortcut ? `设置 (${settingsShortcut})` : "设置"}
        aria-label="设置"
      >
        <Settings size={15} strokeWidth={1.7} aria-hidden="true" />
        <span className="dsh-claude-account-user">设置</span>
        {settingsShortcut !== "" && (
          <span className="sidebar-footer-shortcut" aria-hidden="true">
            {settingsShortcut}
          </span>
        )}
      </button>
    </div>
  );
}

export function CoreSidebarRoot(props: SlotComponentProps<CoreShellSidebarProps, "root">) {
  const { renderSlot, ctx } = props;
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

  const cwd = workspaceSnap?.cwd ?? sessionSnap?.cwd ?? "";
  const sessionFile = sessionSnap?.sessionFile ?? null;
  const activeHub = navSnap?.hubView ?? null;
  const hasSlotSections = (slotsRegistry?.getEntries("sidebar.sections").length ?? 0) > 0;
  const hasPluginSections = hasSlotSections || contributions.leftSidebar.length > 0;

  return (
    <aside
      className={`sidebar codex-sidebar${props.visible === false ? " sidebar-hover-preview" : ""}`}
      data-slot="sidebar"
      data-core-plugin="core-sidebar"
      data-sidebar-mode={props.visible === false ? "preview" : "pinned"}
    >
      {renderSlot("sidebar.header", {
        cwd,
        onNewTask: () => navigationService?.navigate({ kind: "home", workspace: cwd }),
      })}

      <nav className="sidebar-main-nav">
        {renderSlot("sidebar.nav", {
          cwd,
          sessionFile,
          activeView: activeHub,
        })}
      </nav>

      {renderSlot("sidebar.threads", {
        cwd,
        activeSessionFile: sessionFile,
      })}

      {hasPluginSections && (
        <div className="pid-sidebar-plugin-slot" data-slot="sidebar-plugins">
          {renderSlot("sidebar.sections", { cwd, sessionFile })}
          {contributions.leftSidebar.map((section) => (
            <div key={section.id} className="pid-sidebar-plugin-section">
              <LegacySidebarSectionHost
                id={section.id}
                pluginId={section.pluginId}
                renderFn={section.render}
                context={{ cwd, sessionFile }}
              />
            </div>
          ))}
        </div>
      )}

      {renderSlot("sidebar.footer", {
        cwd,
        sessionFile,
        onOpenSettings: (page?: string) => navigationService?.openSettings(page ?? "general"),
      })}
    </aside>
  );
}

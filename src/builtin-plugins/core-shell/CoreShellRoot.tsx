import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  useSyncExternalStore,
} from "react";
import {
  useClientContributions,
  useFrontendService,
  useNavigationState,
  useRpcState,
  useSessionState,
  useThemeState,
  useWorkbenchState,
  useWorkspaceState,
} from "@qianji/client";
import type { CoreRootSlotProps, SlotComponentProps } from "@qianji/client-slots";
import {
  clampPanelSize,
  LegacyContributionHost,
  resolveActiveSessionTitle,
  SIDEBAR_BOUNDS,
} from "./shellHelpers";
import { useCorePanelResize } from "./useCorePanelResize";

const NOOP_UNSUB = (): void => undefined;

export function CoreShellRoot(props: SlotComponentProps<CoreRootSlotProps, "root">) {
  const { renderSlot, renderSlotChain, ctx } = props;

  const navigationService = useFrontendService("navigationService", ctx);
  const themeService = useFrontendService("themeService", ctx);
  const rpcService = useFrontendService("rpcService", ctx);

  const navSnap = useNavigationState(ctx);
  const sessionSnap = useSessionState(ctx);
  const workspaceSnap = useWorkspaceState(ctx);
  const workbenchSnap = useWorkbenchState(ctx);
  const themeSnap = useThemeState(ctx);
  const rpcSnap = useRpcState(ctx);
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

  const [sidebarHoverPreview, setSidebarHoverPreview] = useState(false);
  const [hoverCloseScheduled, setHoverCloseScheduled] = useState(false);
  const [sidebarSearchActive, setSidebarSearchActive] = useState(false);

  const sidebarPinned = navSnap?.sidebarVisible ?? true;
  const sidebarWidth = navSnap?.sidebarWidth ?? SIDEBAR_BOUNDS.fallback;
  const settingsOpen = navSnap?.settingsOpen ?? false;
  const hubView = navSnap?.hubView ?? null;
  const draftMode = navSnap?.draftMode ?? true;
  const activeRoute = navSnap?.activeRoute ?? { kind: "home" as const, workspace: workspaceSnap?.cwd ?? "" };
  const toasts = navSnap?.toasts ?? [];

  const effectiveCwd = draftMode
    ? (workspaceSnap?.draftWorkspace || workspaceSnap?.cwd || sessionSnap?.cwd || "")
    : (workspaceSnap?.cwd || sessionSnap?.cwd || workspaceSnap?.draftWorkspace || "");
  const sessionFile = sessionSnap?.sessionFile ?? null;
  const rightOpen = workbenchSnap?.rightOpen ?? false;
  const bottomOpen = workbenchSnap?.bottomOpen ?? false;
  const layoutScale = themeSnap?.resolvedScale ?? 1;

  const [isNarrowViewport, setIsNarrowViewport] = useState(() => {
    if (typeof window === "undefined") return false;
    return window.innerWidth > 0 && window.innerHeight > 0 && window.innerWidth / layoutScale <= 760;
  });

  useEffect(() => {
    if (typeof window === "undefined") return undefined;
    const syncViewport = () => {
      if (window.innerWidth <= 0 || window.innerHeight <= 0) return;
      setIsNarrowViewport(window.innerWidth / layoutScale <= 760);
    };
    const raf = typeof window.requestAnimationFrame === "function"
      ? window.requestAnimationFrame(syncViewport)
      : null;
    window.addEventListener("resize", syncViewport);
    return () => {
      if (raf !== null && typeof window.cancelAnimationFrame === "function") {
        window.cancelAnimationFrame(raf);
      }
      window.removeEventListener("resize", syncViewport);
    };
  }, [layoutScale]);

  const sidebarVisible = sidebarPinned && !isNarrowViewport;

  const resolvedTitle = useMemo(
    () =>
      resolveActiveSessionTitle({
        sessions: sessionSnap?.sessions ?? [],
        sessionFile,
        sessionId: sessionSnap?.sessionId ?? null,
        sessionName: sessionSnap?.sessionName ?? null,
        messages: sessionSnap?.messages ?? [],
      }),
    [sessionFile, sessionSnap?.messages, sessionSnap?.sessionId, sessionSnap?.sessionName, sessionSnap?.sessions],
  );

  // Sync window focus chrome & desktop layout styling attribute.
  useEffect(() => {
    if (typeof document === "undefined" || typeof window === "undefined") return undefined;
    const rootEl = document.documentElement;
    document.body?.setAttribute("data-dsh-claude-style", "");
    const syncWindowBlur = () => {
      rootEl.toggleAttribute("data-window-blur", !document.hasFocus());
    };
    syncWindowBlur();
    window.addEventListener("focus", syncWindowBlur);
    window.addEventListener("blur", syncWindowBlur);
    return () => {
      window.removeEventListener("focus", syncWindowBlur);
      window.removeEventListener("blur", syncWindowBlur);
    };
  }, []);

  // Apply active appearance palette & UI scale through themeService whenever theme snapshot updates.
  useEffect(() => {
    themeService?.applyToDocument();
  }, [themeService, themeSnap]);

  useEffect(() => {
    if (!hoverCloseScheduled || typeof window === "undefined") return undefined;
    const timer = window.setTimeout(() => {
      setHoverCloseScheduled(false);
      setSidebarHoverPreview(false);
    }, 180);
    return () => window.clearTimeout(timer);
  }, [hoverCloseScheduled]);

  const cancelHoverClose = useCallback(() => {
    setHoverCloseScheduled(false);
  }, []);

  const showHoverPreview = useCallback(() => {
    setHoverCloseScheduled(false);
    setSidebarHoverPreview(true);
  }, []);

  const scheduleHoverClose = useCallback(() => {
    if (sidebarSearchActive) return;
    if (typeof window === "undefined") {
      setSidebarHoverPreview(false);
      setHoverCloseScheduled(false);
      return;
    }
    setHoverCloseScheduled(true);
  }, [sidebarSearchActive]);

  const handleToggleSidebar = useCallback(() => {
    setHoverCloseScheduled(false);
    if (isNarrowViewport) {
      setSidebarHoverPreview((prev) => !prev);
      return;
    }
    setSidebarHoverPreview(false);
    navigationService?.toggleSidebar();
  }, [isNarrowViewport, navigationService]);

  useEffect(() => {
    if (typeof window === "undefined") return undefined;
    const onPin = () => {
      setHoverCloseScheduled(false);
      setSidebarHoverPreview(false);
      navigationService?.setSidebarVisible(true);
    };
    const onClosePreview = () => {
      setHoverCloseScheduled(false);
      setSidebarHoverPreview(false);
    };
    const onToggleRequest = (event: Event) => {
      event.preventDefault();
      handleToggleSidebar();
    };
    const onSearchOpen = () => {
      setHoverCloseScheduled(false);
      if (!sidebarVisible) {
        setSidebarHoverPreview(true);
      }
      (window as Window & { __qianjiSidebarSearchPending?: boolean }).__qianjiSidebarSearchPending = true;
      const dispatchSearch = () => {
        window.dispatchEvent(new CustomEvent("qianji:sidebar-search-request"));
      };
      if (typeof window.requestAnimationFrame === "function") {
        window.requestAnimationFrame(() => window.requestAnimationFrame(dispatchSearch));
      } else {
        dispatchSearch();
      }
    };
    const onSearchActive = (event: Event) => {
      const active = (event as CustomEvent<boolean>).detail === true;
      setSidebarSearchActive(active);
      if (active) setHoverCloseScheduled(false);
    };
    window.addEventListener("qianji:sidebar-pin", onPin);
    window.addEventListener("qianji:sidebar-close-preview", onClosePreview);
    window.addEventListener("qianji:sidebar-toggle-request", onToggleRequest);
    window.addEventListener("qianji:sidebar-search-open", onSearchOpen);
    window.addEventListener("qianji:sidebar-search-active", onSearchActive);
    return () => {
      window.removeEventListener("qianji:sidebar-pin", onPin);
      window.removeEventListener("qianji:sidebar-close-preview", onClosePreview);
      window.removeEventListener("qianji:sidebar-toggle-request", onToggleRequest);
      window.removeEventListener("qianji:sidebar-search-open", onSearchOpen);
      window.removeEventListener("qianji:sidebar-search-active", onSearchActive);
    };
  }, [handleToggleSidebar, navigationService, sidebarVisible]);

  // Dismiss hover-preview sidebar on outside pointerdown or Escape.
  useEffect(() => {
    if (!sidebarHoverPreview || sidebarVisible || typeof document === "undefined" || typeof window === "undefined") {
      return undefined;
    }
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as Element | null;
      if (target !== null && target.closest(".primary-sidebar-panel, [data-sidebar-toggle], .sidebar-hover-zone")) {
        return;
      }
      setHoverCloseScheduled(false);
      setSidebarHoverPreview(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !event.defaultPrevented) {
        setHoverCloseScheduled(false);
        setSidebarHoverPreview(false);
      }
    };
    document.addEventListener("pointerdown", onPointerDown);
    window.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [sidebarHoverPreview, sidebarVisible]);

  const handleSidebarWidthChange = useCallback(
    (nextWidth: number) => {
      navigationService?.setSidebarWidth(clampPanelSize(nextWidth, SIDEBAR_BOUNDS));
    },
    [navigationService],
  );

  const resize = useCorePanelResize({
    sidebarWidth,
    sidebarVisible,
    layoutScale,
    onSidebarWidthChange: handleSidebarWidthChange,
  });

  const sidebarRendered = sidebarVisible || sidebarHoverPreview;
  const hasSlotStatusbarItems = (slotsRegistry?.getEntries("shell.statusbar").length ?? 0) > 0;
  const leftLegacyStatusItems = contributions.statusBarItems.filter((item) => item.align !== "right");
  const rightLegacyStatusItems = contributions.statusBarItems.filter((item) => item.align === "right");
  const showStatusbar = hasSlotStatusbarItems || contributions.statusBarItems.length > 0;

  return (
    <div
      className="app-shell codex-shot"
      data-core-plugin="core-shell"
      data-safe-mode={props.safeMode ? "true" : undefined}
      style={{ ["--sidebar-width" as string]: `${sidebarWidth}px` }}
    >
      {renderSlot("shell.menubar", {
        title: resolvedTitle,
        sidebarVisible,
        onToggleSidebar: handleToggleSidebar,
      })}

      <div
        className="workspace-shell"
        style={{
          ["--sidebar-width" as string]: `${sidebarWidth}px`,
          ["--workspace-panel-width" as string]: `${resize.workspacePanelWidth}px`,
        }}
      >
        {!sidebarVisible && !settingsOpen && (
          <div
            aria-hidden="true"
            className="sidebar-hover-zone"
            onMouseEnter={showHoverPreview}
            onMouseLeave={scheduleHoverClose}
          />
        )}

        <div
          className={`primary-sidebar-panel${sidebarRendered ? " open" : ""}${!sidebarVisible && sidebarHoverPreview ? " hover-preview" : ""}`}
          data-panel=""
          data-sidebar-panel-state={sidebarVisible ? "pinned" : sidebarHoverPreview ? "preview" : "closed"}
          onMouseEnter={cancelHoverClose}
          onMouseLeave={!sidebarVisible ? scheduleHoverClose : undefined}
        >
          {sidebarRendered &&
            renderSlot("shell.sidebar", {
              visible: sidebarVisible,
              width: sidebarWidth,
              onResize: handleSidebarWidthChange,
            })}
        </div>

        {sidebarVisible && (
          <div
            className="sidebar-resizer"
            role="separator"
            aria-orientation="vertical"
            aria-label="调整侧栏宽度"
            aria-valuemin={SIDEBAR_BOUNDS.min}
            aria-valuemax={SIDEBAR_BOUNDS.max}
            aria-valuenow={Math.round(sidebarWidth)}
            tabIndex={0}
            onPointerDown={resize.beginSidebarResize}
            onKeyDown={resize.resizeSidebarWithKeyboard}
          />
        )}

        <div className="work-surface">
          <div className="stage-canvas">
            {renderSlot("shell.topbar", {
              cwd: effectiveCwd,
              sessionFile,
              title: resolvedTitle,
            })}

            <div className="work-body">
              <main className="main-stage">
                {renderSlotChain("shell.stage", {
                  route: activeRoute,
                  cwd: effectiveCwd,
                  sessionFile,
                  hubView,
                  draftMode,
                })}
              </main>
            </div>

            {renderSlot("shell.workbench.bottom", {
              cwd: effectiveCwd,
              sessionFile,
              open: bottomOpen,
              activeTab: workbenchSnap?.activeBottomTab ?? "terminal",
            })}

            {showStatusbar && (
              <footer className="qj-workspace-statusbar" role="status" aria-label="工作区状态栏">
                <div style={{ display: "inline-flex", alignItems: "center", gap: "10px", minWidth: 0 }}>
                  {renderSlot("shell.statusbar", { cwd: effectiveCwd, sessionFile, align: "left" })}
                  {leftLegacyStatusItems.map((item) => (
                    <LegacyContributionHost
                      key={item.id}
                      id={item.id}
                      pluginId={item.pluginId}
                      slotKey="status.bar"
                      renderFn={item.render}
                      context={{ cwd: effectiveCwd, sessionFile }}
                      compact
                    />
                  ))}
                </div>
                <div style={{ display: "inline-flex", alignItems: "center", gap: "10px", minWidth: 0 }}>
                  {renderSlot("shell.statusbar", { cwd: effectiveCwd, sessionFile, align: "right" })}
                  {rightLegacyStatusItems.map((item) => (
                    <LegacyContributionHost
                      key={item.id}
                      id={item.id}
                      pluginId={item.pluginId}
                      slotKey="status.bar"
                      renderFn={item.render}
                      context={{ cwd: effectiveCwd, sessionFile }}
                      compact
                    />
                  ))}
                </div>
              </footer>
            )}
          </div>

          {renderSlot("shell.workbench.right", {
            cwd: effectiveCwd,
            sessionFile,
            open: rightOpen,
            maximized: workbenchSnap?.rightMaximized ?? false,
          })}
        </div>
      </div>

      {/* Global overlays slot root enforces pointer-events: none (ADR 0016 / ADR 0023) */}
      <div
        className="client-plugin-overlay-slot"
        data-slot="shell.overlays"
        style={{ pointerEvents: "none" }}
      >
        {renderSlot("shell.overlays", { cwd: effectiveCwd, sessionFile })}
        {contributions.overlays.map((overlay) => (
          <LegacyContributionHost
            key={overlay.id}
            id={overlay.id}
            pluginId={overlay.pluginId}
            slotKey="overlays"
            renderFn={overlay.render}
            context={{ cwd: effectiveCwd, sessionFile }}
          />
        ))}
      </div>

      {renderSlot("shell.modals", { cwd: effectiveCwd, sessionFile })}

      {rpcSnap !== undefined && rpcSnap.hostStatus !== "connected" && (
        <div
          className={`host-status-banner${rpcSnap.hostStatus === "failed" ? " failed" : ""}`}
          role="status"
        >
          <span>
            {rpcSnap.hostStatus === "failed"
              ? "Harness 多次崩溃，已停止自动重启"
              : "Harness 已断开，正在重连…"}
          </span>
          {rpcSnap.hostStatus === "failed" && (
            <button type="button" onClick={() => void rpcService?.restartHost()}>
              重新启动
            </button>
          )}
        </div>
      )}

      <div className="toast-stack" aria-live="polite">
        {toasts.map((toast) => (
          <button
            key={toast.id}
            type="button"
            className={`toast ${toast.kind}`}
            onClick={() => navigationService?.dismissToast(toast.id)}
          >
            {toast.message}
          </button>
        ))}
      </div>
    </div>
  );
}

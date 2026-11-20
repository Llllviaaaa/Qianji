/**
 * Dynamic tiling grid registered on `workbench.tilingGrid`, owning keyed
 * `workbench.panes` (`src/builtin-plugins/core-workbench/CoreWorkbenchTilingGrid.tsx`, ADR 0023).
 */
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type PointerEvent as ReactPointerEvent,
  type ReactElement,
} from "react";
import { createPortal } from "react-dom";
import {
  Columns2,
  Maximize2,
  Minimize2,
  PanelRight,
  Plus,
  RefreshCw,
  Rows2,
  X,
} from "lucide-react";
import {
  useClientContributions,
  useFrontendService,
  useSessionState,
  useWorkbenchState,
  useWorkspaceState,
  type PaneDropZone,
} from "@qianji/client";
import type {
  SlotComponentProps,
  WorkbenchTilingGridSlotProps,
} from "@qianji/client-slots";
import {
  buildEffectiveTree,
  computeTileLayout,
  filterRegisteredPanes,
  hitTestPaneTarget,
  isPaneRegistered,
  LegacyContributionHost,
  resolvePaneTitle,
  useSlotRegistryVersion,
  type WorkbenchTileSash,
} from "./tilingHelpers";

interface ActivePaneDrag {
  readonly sourceId: string;
  readonly title: string;
  readonly targetId: string | null;
  readonly zone: PaneDropZone | null;
  readonly clientX: number;
  readonly clientY: number;
}

const DROP_ZONE_LABELS: Readonly<Record<PaneDropZone, string>> = {
  top: "上方分屏",
  bottom: "下方分屏",
  left: "左侧并排",
  right: "右侧并排",
  swap: "互换位置",
};

/** Dynamic tiling grid registered on `workbench.tilingGrid`, owning child slot `workbench.panes`. */
export function CoreWorkbenchTilingGrid({
  cwd: propCwd,
  sessionFile: propSessionFile,
  openPanes: propOpenPanes,
  maximizedPaneId: propMaximizedPaneId,
  renderSlot,
  ctx,
}: SlotComponentProps<WorkbenchTilingGridSlotProps, "session-maybe">): ReactElement | null {
  const workbench = useWorkbenchState(ctx);
  const workspace = useWorkspaceState(ctx);
  const session = useSessionState(ctx);
  const workbenchService = useFrontendService("workbenchService", ctx);
  const workspaceService = useFrontendService("workspaceService", ctx);
  const contributions = useClientContributions();
  const registry = ctx?.get("slots")?.registry;
  useSlotRegistryVersion(registry);

  const cwd = propCwd ?? workspace?.cwd ?? "";
  const sessionFile = propSessionFile !== undefined ? propSessionFile : (session?.sessionFile ?? null);
  const rawOpenPanes = propOpenPanes ?? workbench?.openPanes ?? [];
  const activePanes = filterRegisteredPanes(rawOpenPanes, registry, contributions.rightWorkbenchTabs);
  const maximizedPaneId = propMaximizedPaneId !== undefined ? propMaximizedPaneId : (workbench?.maximizedPaneId ?? null);
  const rightMaximized = workbench?.rightMaximized ?? false;
  const inspectorOpen = workbench?.inspectorOpen ?? false;
  const twoPaneDirection = workbench?.twoPaneDirection ?? "vertical";
  const fileDrawerOpen = workbench?.fileDrawerOpen ?? true;
  const git = workspace?.git ?? null;

  const [terminalVisited, setTerminalVisited] = useState(false);
  const [sideChatVisited, setSideChatVisited] = useState(false);
  const [prevSessionFile, setPrevSessionFile] = useState<string | null>(sessionFile);
  const [dragState, setDragState] = useState<ActivePaneDrag | null>(null);
  const gridRef = useRef<HTMLDivElement>(null);
  const dragCleanupRef = useRef<(() => void) | null>(null);

  if (activePanes.includes("terminal") && !terminalVisited) setTerminalVisited(true);
  if (activePanes.includes("side-chat") && !sideChatVisited) setSideChatVisited(true);
  if (prevSessionFile !== sessionFile) {
    setPrevSessionFile(sessionFile);
    if (!activePanes.includes("side-chat") && sideChatVisited) {
      setSideChatVisited(false);
    }
  }

  useEffect(() => () => {
    dragCleanupRef.current?.();
  }, []);

  const effectiveTree = buildEffectiveTree(workbench?.layoutTree ?? null, activePanes);
  const tileLayout = computeTileLayout(effectiveTree);
  const isPaneMaximized = maximizedPaneId !== null && activePanes.includes(maximizedPaneId);
  const fullMaximized = rightMaximized || isPaneMaximized;
  const visibleMaximizedId = isPaneMaximized
    ? maximizedPaneId
    : fullMaximized && activePanes.length > 0
      ? (activePanes[0] ?? null)
      : null;

  const beginSashDrag = useCallback((sash: WorkbenchTileSash, event: ReactPointerEvent<HTMLDivElement>) => {
    const el = gridRef.current;
    if (el === null || workbenchService === undefined) return;
    event.preventDefault();
    const rect = el.getBoundingClientRect();
    document.body.classList.add("workspace-is-resizing");

    const onMove = (moveEvent: PointerEvent) => {
      if (sash.direction === "horizontal") {
        const spanPx = sash.container.width * rect.width;
        const startPx = rect.left + sash.container.left * rect.width;
        workbenchService.setSplitNodeRatio(sash.id, spanPx > 0 ? (moveEvent.clientX - startPx) / spanPx : 0.5);
        return;
      }
      const spanPx = sash.container.height * rect.height;
      const startPx = rect.top + sash.container.top * rect.height;
      workbenchService.setSplitNodeRatio(sash.id, spanPx > 0 ? (moveEvent.clientY - startPx) / spanPx : 0.5);
    };
    const cleanup = () => {
      document.body.classList.remove("workspace-is-resizing");
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", cleanup);
      window.removeEventListener("pointercancel", cleanup);
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", cleanup);
    window.addEventListener("pointercancel", cleanup);
  }, [workbenchService]);

  const beginPaneHeaderDrag = useCallback((
    paneId: string,
    title: string,
    event: ReactPointerEvent<HTMLElement>,
  ) => {
    if (event.button !== 0 || activePanes.length < 2 || fullMaximized || workbenchService === undefined) return;
    const originEl = event.target instanceof Element ? event.target : null;
    if (originEl?.closest("button, input, a, select, textarea, [role='button']") !== null) return;

    dragCleanupRef.current?.();
    const startX = event.clientX;
    const startY = event.clientY;
    let activated = false;
    let latestTarget: { targetId: string | null; zone: PaneDropZone | null } = { targetId: null, zone: null };

    const cleanup = () => {
      document.body.classList.remove("workbench-pane-dragging");
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onCancel);
      window.removeEventListener("keydown", onKeyDown);
      dragCleanupRef.current = null;
      setDragState(null);
    };

    const onMove = (moveEvent: PointerEvent) => {
      if (!activated) {
        if (Math.hypot(moveEvent.clientX - startX, moveEvent.clientY - startY) < 6) return;
        activated = true;
        document.body.classList.add("workbench-pane-dragging");
      }
      latestTarget = hitTestPaneTarget(gridRef.current, paneId, moveEvent.clientX, moveEvent.clientY);
      setDragState({
        sourceId: paneId,
        title,
        targetId: latestTarget.targetId,
        zone: latestTarget.zone,
        clientX: moveEvent.clientX,
        clientY: moveEvent.clientY,
      });
    };

    const onUp = () => {
      const drop = latestTarget;
      const shouldCommit = activated && drop.targetId !== null && drop.targetId !== paneId && drop.zone !== null;
      cleanup();
      if (shouldCommit && drop.targetId !== null && drop.zone !== null) {
        workbenchService.swapOrDockPanes(paneId, drop.targetId, drop.zone);
      }
    };

    const onCancel = () => cleanup();
    const onKeyDown = (keyEvent: KeyboardEvent) => {
      if (keyEvent.key === "Escape") {
        keyEvent.preventDefault();
        cleanup();
      }
    };

    dragCleanupRef.current = cleanup;
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onCancel);
    window.addEventListener("keydown", onKeyDown);
  }, [activePanes.length, fullMaximized, workbenchService]);

  // Keep visited Terminal & SideChat mounted silently ONLY while still registered in `workbench.panes`.
  const persistentPaneIds = [...activePanes];
  if (terminalVisited && isPaneRegistered(registry, "terminal") && !persistentPaneIds.includes("terminal")) {
    persistentPaneIds.push("terminal");
  }
  if (sideChatVisited && isPaneRegistered(registry, "side-chat") && !persistentPaneIds.includes("side-chat")) {
    persistentPaneIds.push("side-chat");
  }

  if (persistentPaneIds.length === 0) return null;

  const placementForPane = (paneId: string): CSSProperties | undefined => {
    if (visibleMaximizedId !== null) {
      return paneId === visibleMaximizedId ? { position: "absolute", inset: 0 } : undefined;
    }
    const r = tileLayout.panes[paneId];
    if (r === undefined) return undefined;
    return {
      position: "absolute",
      left: `${r.left * 100}%`,
      top: `${r.top * 100}%`,
      width: `${r.width * 100}%`,
      height: `${r.height * 100}%`,
    };
  };

  return (
    <>
      <div
        ref={gridRef}
        className="pid-wb-panes-grid"
        hidden={activePanes.length === 0}
        data-pane-count={activePanes.length}
        data-has-horizontal-split={tileLayout.hasHorizontalSplit ? "true" : "false"}
      >
        {visibleMaximizedId === null && tileLayout.sashes.map((sash) => {
          const isHorizontal = sash.direction === "horizontal";
          return (
            <div
              key={sash.id}
              className={`pid-wb-tile-sash ${isHorizontal ? "is-horizontal" : "is-vertical"}`}
              role="separator"
              aria-orientation={isHorizontal ? "vertical" : "horizontal"}
              aria-label={isHorizontal ? "调整左右面板宽度比例" : "调整上下面板高度比例"}
              style={
                isHorizontal
                  ? { left: `${sash.offset * 100}%`, top: `${sash.start * 100}%`, height: `${sash.span * 100}%` }
                  : { top: `${sash.offset * 100}%`, left: `${sash.start * 100}%`, width: `${sash.span * 100}%` }
              }
              onPointerDown={(event) => beginSashDrag(sash, event)}
            />
          );
        })}

        {persistentPaneIds.map((paneId) => {
          const isOpen = activePanes.includes(paneId);
          const visible = visibleMaximizedId !== null ? paneId === visibleMaximizedId : isOpen;
          const paneMaximized = visibleMaximizedId === paneId && fullMaximized;
          const title = resolvePaneTitle(paneId, contributions.rightWorkbenchTabs);
          const dropZone = dragState?.targetId === paneId ? dragState.zone : null;
          const isDragging = dragState?.sourceId === paneId;
          const soleDismissible = !inspectorOpen && activePanes.length === 1;
          const closeTitle = soleDismissible ? "隐藏工作台 (Ctrl+Alt+B)" : `关闭${title}`;
          const maxTitle = paneMaximized ? "还原宽度" : "最大化工作台";
          const legacyTab = contributions.rightWorkbenchTabs.find((tab) => tab.id === paneId);
          const reviewCount = git?.files.length ?? 0;

          const legacyFallback =
            legacyTab !== undefined ? (
              <LegacyContributionHost
                pluginId={legacyTab.pluginId ?? legacyTab.id}
                entryId={legacyTab.id}
                slotKey="rightWorkbenchTabs"
                renderFn={legacyTab.render}
                context={{ cwd, sessionFile }}
              />
            ) : null;

          return (
            <section
              key={paneId}
              className={`pid-wb-grid-pane${dropZone !== null ? ` drop-${dropZone}` : ""}${isDragging ? " is-dragging" : ""}`}
              data-pane-id={paneId}
              aria-label={title}
              hidden={!visible}
              style={visible ? placementForPane(paneId) : { display: "none" }}
            >
              {dropZone !== null && (
                <div className={`pid-wb-drop-indicator zone-${dropZone}`} aria-hidden="true">
                  <span className="pid-wb-drop-badge">{DROP_ZONE_LABELS[dropZone]}</span>
                </div>
              )}
              {paneId !== "preview" && (
                <header
                  className="pid-wb-pane-header"
                  onPointerDown={(event) => beginPaneHeaderDrag(paneId, title, event)}
                >
                  <div className="pid-wb-pane-title-group">
                    <span className="pid-wb-pane-title">{title}</span>
                    {paneId === "review" && reviewCount > 0 && <span className="pid-wb-pane-count">{reviewCount}</span>}
                    {paneId === "terminal" && (
                      <button type="button" className="pid-wb-icon-btn" title="新建终端标签页" aria-label="新建终端标签页" onClick={() => workbenchService?.bumpTerminalCreateNonce()}>
                        <Plus size={14} />
                      </button>
                    )}
                  </div>
                  <div className="pid-wb-pane-actions">
                    {paneId === "review" && git?.isRepository === true && (
                      <button type="button" className="pid-wb-icon-btn" title="刷新 Git 变更" aria-label="刷新 Git 变更" onClick={() => void workspaceService?.refreshGit(cwd)}>
                        <RefreshCw size={12.5} />
                      </button>
                    )}
                    {(paneId === "files" || paneId === "editor" || paneId === "code") && (
                      <button
                        type="button"
                        className={`pid-wb-icon-btn${fileDrawerOpen ? " active" : ""}`}
                        title={fileDrawerOpen ? "收起文件树" : "展开文件树"}
                        aria-label={fileDrawerOpen ? "收起文件树" : "展开文件树"}
                        aria-pressed={fileDrawerOpen}
                        onClick={() => workbenchService?.toggleFileDrawer()}
                      >
                        <PanelRight size={13.5} />
                      </button>
                    )}
                    {activePanes.length === 2 && !paneMaximized && (
                      <button
                        type="button"
                        className="pid-wb-icon-btn"
                        title={twoPaneDirection === "horizontal" ? "切换为上下分屏" : "切换为左右分屏"}
                        aria-label={twoPaneDirection === "horizontal" ? "切换为上下分屏" : "切换为左右分屏"}
                        onClick={() => workbenchService?.setTwoPaneDirection(twoPaneDirection === "horizontal" ? "vertical" : "horizontal")}
                      >
                        {twoPaneDirection === "horizontal" ? <Rows2 size={13} /> : <Columns2 size={13} />}
                      </button>
                    )}
                    <button type="button" className="pid-wb-icon-btn" title={maxTitle} aria-label={maxTitle} aria-pressed={paneMaximized} onClick={() => workbenchService?.toggleMaximizePane(paneId)}>
                      {paneMaximized ? <Minimize2 size={13} /> : <Maximize2 size={13} />}
                    </button>
                    <button type="button" className="pid-wb-icon-btn" title={closeTitle} aria-label={closeTitle} onClick={() => workbenchService?.closePane(paneId)}>
                      <X size={13} />
                    </button>
                  </div>
                </header>
              )}
              <div className="pid-wb-pane-content">
                {renderSlot(
                  "workbench.panes",
                  {
                    cwd,
                    sessionFile,
                    paneId,
                    active: visible,
                    maximized: paneMaximized,
                    onClose: () => workbenchService?.closePane(paneId),
                  },
                  { key: paneId, fallback: legacyFallback },
                )}
              </div>
            </section>
          );
        })}
      </div>
      {dragState !== null && typeof document !== "undefined" && document.body !== null && createPortal(
        <div
          className="pid-wb-drag-ghost"
          style={{ left: `${dragState.clientX + 14}px`, top: `${dragState.clientY + 14}px` }}
          aria-hidden="true"
        >
          {dragState.title}
        </div>,
        document.body,
      )}
    </>
  );
}

import {
  useCallback, useEffect, useRef, useState,
  type CSSProperties, type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent,
} from "react";
import { createPortal } from "react-dom";
import { useSyncOnChange } from "../../hooks/useSyncOnChange";
import type { CodeReviewScope } from "../../lib/codeReview";
import { useClientContributions } from "../../lib/clientContributions";
import { useBuiltinPluginGatesStore } from "../../stores/builtinPluginGatesStore";
import {
  computeTileLayout,
  detectPaneDropZone,
  filterAllowedPanes,
  hasPaneInTree,
  insertPaneIntoTree,
  pruneTreeToAllowed,
  useWorkbenchLayoutStore,
  type PaneDropZone,
  type WorkbenchTileNode,
  type WorkbenchTileSash,
} from "../../stores/workbenchLayoutStore";
import { useWorkbenchStore } from "../../stores/workbenchStore";
import type { GitSnapshot } from "../../types";
import { TaskSummaryTab } from "./TaskSummaryTab";
import { WorkbenchPaneFrame } from "./WorkbenchPaneFrame";
export { WorkbenchTopbarControls, type WorkbenchTopbarControlsProps } from "./WorkbenchTopbarControls";

export interface RightWorkbenchProps {
  cwd: string;
  sessionFile: string | null;
  width: number;
  git: GitSnapshot | null;
  onRefreshGit: () => Promise<void>;
  onRestoreFiles: (paths?: string[]) => Promise<void>;
  onRequestReview: (scope?: CodeReviewScope) => void;
  onAddToChat?: (path: string) => void;
  resize: {
    onPointerDown: (event: ReactPointerEvent<HTMLDivElement>) => void;
    onKeyDown: (event: ReactKeyboardEvent<HTMLDivElement>) => void;
    min: number;
    max: number;
  };
}

interface ActivePaneDrag {
  sourceId: string;
  title: string;
  targetId: string | null;
  zone: PaneDropZone | null;
  clientX: number;
  clientY: number;
}

function buildEffectiveTree(
  layoutTree: WorkbenchTileNode | null,
  activePanes: readonly string[],
): WorkbenchTileNode | null {
  const allowed = new Set(activePanes);
  let tree = pruneTreeToAllowed(layoutTree, allowed);
  for (const id of activePanes) {
    if (!hasPaneInTree(tree, id)) {
      tree = insertPaneIntoTree(tree, id);
    }
  }
  return tree;
}

function hitTestPaneTarget(
  gridEl: HTMLDivElement | null,
  sourceId: string,
  clientX: number,
  clientY: number,
): { targetId: string | null; zone: PaneDropZone | null } {
  if (!gridEl) return { targetId: null, zone: null };
  for (const el of gridEl.querySelectorAll<HTMLElement>("[data-pane-id]")) {
    const candidateId = el.dataset.paneId;
    if (!candidateId || candidateId === sourceId || el.hidden || el.style.display === "none") continue;
    const rect = el.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) continue;
    if (clientX < rect.left || clientX > rect.right || clientY < rect.top || clientY > rect.bottom) continue;
    return {
      targetId: candidateId,
      zone: detectPaneDropZone((clientX - rect.left) / rect.width, (clientY - rect.top) / rect.height),
    };
  }
  return { targetId: null, zone: null };
}

export function RightWorkbench({
  cwd,
  sessionFile,
  width,
  git,
  onRefreshGit,
  onRestoreFiles,
  onRequestReview,
  onAddToChat,
  resize,
}: RightWorkbenchProps) {
  const rightOpen = useWorkbenchStore((state) => state.rightOpen);
  const rightMaximized = useWorkbenchStore((state) => state.rightMaximized);

  const layoutTree = useWorkbenchLayoutStore((state) => state.layoutTree);
  const openPanes = useWorkbenchLayoutStore((state) => state.openPanes);
  const inspectorOpen = useWorkbenchLayoutStore((state) => state.inspectorOpen);
  const maximizedPaneId = useWorkbenchLayoutStore((state) => state.maximizedPaneId);
  const twoPaneDirection = useWorkbenchLayoutStore((state) => state.twoPaneDirection);
  const setSplitNodeRatio = useWorkbenchLayoutStore((state) => state.setSplitNodeRatio);
  const swapOrDockPanes = useWorkbenchLayoutStore((state) => state.swapOrDockPanes);

  const codeReviewEnabled = useBuiltinPluginGatesStore((state) => state.codeReviewEnabled);
  const sideChatEnabled = useBuiltinPluginGatesStore((state) => state.sideChatEnabled);
  const webPreviewEnabled = useBuiltinPluginGatesStore((state) => state.webPreviewEnabled);
  const contributions = useClientContributions();

  const [sideChatVisited, setSideChatVisited] = useState(false);
  const [terminalVisited, setTerminalVisited] = useState(false);
  const [dragState, setDragState] = useState<ActivePaneDrag | null>(null);
  const gridRef = useRef<HTMLDivElement>(null);
  const dragCleanupRef = useRef<(() => void) | null>(null);

  const activePanes = filterAllowedPanes(openPanes);
  const activePanesKey = activePanes.join("|");
  const isPaneMaximizedNow = maximizedPaneId !== null && activePanes.includes(maximizedPaneId);
  const effectiveTree = buildEffectiveTree(layoutTree, activePanes);
  const tileLayout = computeTileLayout(effectiveTree);
  const isFloatingInspector = !rightMaximized && !isPaneMaximizedNow && inspectorOpen && tileLayout.hasHorizontalSplit;

  useEffect(() => () => {
    dragCleanupRef.current?.();
  }, []);

  useEffect(() => {
    if (!isFloatingInspector) return;
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target instanceof Element ? event.target : null;
      if (target?.closest(".pid-wb-inspector-popover, .pid-wb-topbar-controls")) return;
      useWorkbenchLayoutStore.getState().setInspectorOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented) return;
      event.preventDefault();
      useWorkbenchLayoutStore.getState().setInspectorOpen(false);
    };
    document.addEventListener("pointerdown", onPointerDown);
    window.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [isFloatingInspector]);

  useSyncOnChange([activePanesKey], () => {
    if (activePanes.includes("side-chat")) setSideChatVisited(true);
    if (activePanes.includes("terminal")) setTerminalVisited(true);
  });

  useSyncOnChange([sessionFile], () => {
    if (!activePanes.includes("side-chat")) setSideChatVisited(false);
  });

  const beginSashDrag = useCallback((sash: WorkbenchTileSash, event: ReactPointerEvent<HTMLDivElement>) => {
    const el = gridRef.current;
    if (!el) return;
    event.preventDefault();
    const rect = el.getBoundingClientRect();
    document.body.classList.add("workspace-is-resizing");

    const onMove = (moveEvent: PointerEvent) => {
      if (sash.direction === "horizontal") {
        const spanPx = sash.container.width * rect.width;
        const startPx = rect.left + sash.container.left * rect.width;
        setSplitNodeRatio(sash.id, spanPx > 0 ? (moveEvent.clientX - startPx) / spanPx : 0.5);
        return;
      }
      const spanPx = sash.container.height * rect.height;
      const startPx = rect.top + sash.container.top * rect.height;
      setSplitNodeRatio(sash.id, spanPx > 0 ? (moveEvent.clientY - startPx) / spanPx : 0.5);
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
  }, [setSplitNodeRatio]);

  const fullMaximizedNow = rightMaximized || isPaneMaximizedNow;
  const beginPaneHeaderDrag = useCallback((
    paneId: string,
    title: string,
    event: ReactPointerEvent<HTMLElement>,
  ) => {
    if (event.button !== 0 || activePanes.length < 2 || fullMaximizedNow) return;
    const originEl = event.target instanceof Element ? event.target : null;
    if (originEl?.closest("button, input, a, select, textarea, [role='button']")) return;

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
      const shouldCommit = activated && drop.targetId && drop.targetId !== paneId && drop.zone;
      cleanup();
      if (shouldCommit && drop.targetId && drop.zone) {
        swapOrDockPanes(paneId, drop.targetId, drop.zone);
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
  }, [activePanes.length, fullMaximizedNow, swapOrDockPanes]);

  if (!rightOpen || (!inspectorOpen && activePanes.length === 0)) return null;

  const isPaneMaximized = maximizedPaneId !== null && activePanes.includes(maximizedPaneId);
  const fullMaximized = rightMaximized || isPaneMaximized;
  const visibleMaximizedId = isPaneMaximized
    ? maximizedPaneId
    : fullMaximized && activePanes.length > 0
      ? (activePanes[0] ?? null)
      : null;

  const inspectorMode = fullMaximized
    ? "closed"
    : !inspectorOpen
      ? "closed"
      : activePanes.length === 0
        ? "sole"
        : tileLayout.hasHorizontalSplit
          ? "floating"
          : "docked";

  const effectiveWidth = inspectorMode === "sole"
    ? Math.min(268, resize.max)
    : tileLayout.hasHorizontalSplit
      ? Math.min(resize.max, Math.max(width, Math.round(resize.max * 0.78)))
      : inspectorMode === "docked"
        ? Math.min(resize.max, Math.max(width, 720))
        : Math.min(width, resize.max);

  // Keep Terminal & SideChat mounted silently in `.pid-wb-panes-grid` once visited so Shells / Side Chat never reset.
  const persistentPaneIds = [...activePanes];
  if (terminalVisited && !persistentPaneIds.includes("terminal")) persistentPaneIds.push("terminal");
  if (sideChatVisited && sideChatEnabled && !persistentPaneIds.includes("side-chat")) persistentPaneIds.push("side-chat");

  const placementForPane = (paneId: string): CSSProperties | undefined => {
    if (visibleMaximizedId) {
      return paneId === visibleMaximizedId ? { position: "absolute", inset: 0 } : undefined;
    }
    const r = tileLayout.panes[paneId];
    if (!r) return undefined;
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
      {!fullMaximized && (
        <div
          className="pid-right-resizer"
          role="separator"
          aria-orientation="vertical"
          aria-label="调整右侧工作台宽度"
          aria-valuemin={Math.round(resize.min)}
          aria-valuemax={Math.round(resize.max)}
          aria-valuenow={Math.round(effectiveWidth)}
          tabIndex={0}
          onPointerDown={resize.onPointerDown}
          onKeyDown={resize.onKeyDown}
        />
      )}
      <aside
        className={`pid-right-workbench is-mode-${inspectorMode}${fullMaximized ? " maximized" : ""}`}
        data-rightbar-col=""
        style={fullMaximized ? undefined : { width: `${Math.round(effectiveWidth)}px` }}
        aria-label="右侧工作台"
      >
        {inspectorMode === "floating" && (
          <div className="pid-wb-inspector-popover" role="region" aria-label="环境与上下文检查器">
            <TaskSummaryTab cwd={cwd} sessionFile={sessionFile} />
          </div>
        )}
        <div className="pid-wb-stage">
          {inspectorMode === "sole" && (
            <div className="pid-wb-inspector-sole">
              <TaskSummaryTab cwd={cwd} sessionFile={sessionFile} />
            </div>
          )}
          {inspectorMode === "docked" && (
            <div className="pid-wb-inspector-docked" aria-label="环境与上下文检查器">
              <TaskSummaryTab cwd={cwd} sessionFile={sessionFile} />
            </div>
          )}

          {(activePanes.length > 0 || persistentPaneIds.length > 0) && (
            <div
              ref={gridRef}
              className="pid-wb-panes-grid"
              hidden={activePanes.length === 0}
              data-pane-count={activePanes.length}
              data-has-horizontal-split={tileLayout.hasHorizontalSplit ? "true" : "false"}
            >
              {!visibleMaximizedId && tileLayout.sashes.map((sash) => {
                const isHorizontal = sash.direction === "horizontal";
                return (
                  <div
                    key={sash.id}
                    className={`pid-wb-tile-sash ${isHorizontal ? "is-horizontal" : "is-vertical"}`}
                    role="separator"
                    aria-orientation={isHorizontal ? "vertical" : "horizontal"}
                    aria-label={isHorizontal ? "调整左右面板宽度比例" : "调整上下面板高度比例"}
                    style={isHorizontal
                      ? { left: `${sash.offset * 100}%`, top: `${sash.start * 100}%`, height: `${sash.span * 100}%` }
                      : { top: `${sash.offset * 100}%`, left: `${sash.start * 100}%`, width: `${sash.span * 100}%` }}
                    onPointerDown={(event) => beginSashDrag(sash, event)}
                  />
                );
              })}
              {persistentPaneIds.map((paneId) => {
                const isOpen = activePanes.includes(paneId);
                const visible = visibleMaximizedId ? paneId === visibleMaximizedId : isOpen;
                return (
                  <WorkbenchPaneFrame
                    key={paneId}
                    paneId={paneId}
                    visible={visible}
                    maximized={visibleMaximizedId === paneId && fullMaximized}
                    soleDismissiblePane={!inspectorOpen && activePanes.length === 1}
                    canFlipTwoPane={activePanes.length === 2}
                    twoPaneDirection={twoPaneDirection}
                    gridStyle={placementForPane(paneId)}
                    cwd={cwd}
                    sessionFile={sessionFile}
                    git={git}
                    codeReviewEnabled={codeReviewEnabled}
                    webPreviewEnabled={webPreviewEnabled}
                    sideChatEnabled={sideChatEnabled}
                    pluginTabs={contributions.rightWorkbenchTabs}
                    isDragging={dragState?.sourceId === paneId}
                    dropZone={dragState?.targetId === paneId ? dragState.zone : null}
                    onHeaderPointerDown={beginPaneHeaderDrag}
                    onRefreshGit={onRefreshGit}
                    onRestoreFiles={onRestoreFiles}
                    onRequestReview={onRequestReview}
                    onAddToChat={onAddToChat}
                  />
                );
              })}
            </div>
          )}
        </div>
      </aside>
      {dragState && typeof document !== "undefined" && createPortal(
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

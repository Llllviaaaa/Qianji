import {
  useCallback, useEffect, useRef, useState,
  type CSSProperties, type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent,
} from "react";
import { useSyncOnChange } from "../../hooks/useSyncOnChange";
import type { CodeReviewScope } from "../../lib/codeReview";
import { useClientContributions } from "../../lib/clientContributions";
import { useBuiltinPluginGatesStore } from "../../stores/builtinPluginGatesStore";
import {
  computeGridColumns,
  filterAllowedPanes,
  useWorkbenchLayoutStore,
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

  const openPanes = useWorkbenchLayoutStore((state) => state.openPanes);
  const inspectorOpen = useWorkbenchLayoutStore((state) => state.inspectorOpen);
  const maximizedPaneId = useWorkbenchLayoutStore((state) => state.maximizedPaneId);
  const twoPaneDirection = useWorkbenchLayoutStore((state) => state.twoPaneDirection);
  const leftColumnCount = useWorkbenchLayoutStore((state) => state.leftColumnCount);
  const colRatio = useWorkbenchLayoutStore((state) => state.colRatio);
  const leftRowRatio = useWorkbenchLayoutStore((state) => state.leftRowRatio);
  const setColRatio = useWorkbenchLayoutStore((state) => state.setColRatio);
  const setLeftRowRatio = useWorkbenchLayoutStore((state) => state.setLeftRowRatio);
  const swapOrDockPanes = useWorkbenchLayoutStore((state) => state.swapOrDockPanes);

  const codeReviewEnabled = useBuiltinPluginGatesStore((state) => state.codeReviewEnabled);
  const sideChatEnabled = useBuiltinPluginGatesStore((state) => state.sideChatEnabled);
  const webPreviewEnabled = useBuiltinPluginGatesStore((state) => state.webPreviewEnabled);
  const contributions = useClientContributions();

  const [sideChatVisited, setSideChatVisited] = useState(false);
  const [terminalVisited, setTerminalVisited] = useState(false);
  const [draggingPaneId, setDraggingPaneId] = useState<string | null>(null);
  const gridRef = useRef<HTMLDivElement>(null);

  const activePanes = filterAllowedPanes(openPanes);
  const activePanesKey = activePanes.join("|");
  const isPaneMaximizedNow = maximizedPaneId !== null && activePanes.includes(maximizedPaneId);
  const columnsNow = computeGridColumns(activePanes, twoPaneDirection, leftColumnCount);
  const isFloatingInspector = !rightMaximized && !isPaneMaximizedNow && inspectorOpen && columnsNow.hasCol2;

  useEffect(() => {
    if (!isFloatingInspector) return;
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target instanceof Element ? event.target : null;
      if (target?.closest('.pid-wb-inspector-popover, [data-wb-tab="summary"]')) return;
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

  const beginGridSplitDrag = useCallback((axis: "col" | "row", event: ReactPointerEvent<HTMLDivElement>) => {
    const el = gridRef.current;
    if (!el) return;
    event.preventDefault();
    const rect = el.getBoundingClientRect();
    document.body.classList.add("workspace-is-resizing");

    const onMove = (moveEvent: PointerEvent) => {
      if (axis === "col") {
        setColRatio(rect.width > 0 ? (moveEvent.clientX - rect.left) / rect.width : 0.5);
      } else {
        setLeftRowRatio(rect.height > 0 ? (moveEvent.clientY - rect.top) / rect.height : 0.5);
      }
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
  }, [setColRatio, setLeftRowRatio]);

  if (!rightOpen || (!inspectorOpen && activePanes.length === 0)) return null;

  const isPaneMaximized = maximizedPaneId !== null && activePanes.includes(maximizedPaneId);
  const fullMaximized = rightMaximized || isPaneMaximized;
  const visibleMaximizedId = isPaneMaximized
    ? maximizedPaneId
    : fullMaximized && activePanes.length > 0
      ? (activePanes[0] ?? null)
      : null;

  const columns = computeGridColumns(activePanes, twoPaneDirection, leftColumnCount);
  const inspectorMode = fullMaximized
    ? "closed"
    : !inspectorOpen
      ? "closed"
      : activePanes.length === 0
        ? "sole"
        : columns.hasCol2
          ? "floating"
          : "docked";

  const effectiveWidth = inspectorMode === "sole"
    ? Math.min(width, 272)
    : columns.hasCol2
      ? Math.max(width, Math.min(resize.max, 980))
      : inspectorMode === "docked"
        ? Math.max(width, Math.min(resize.max, 840))
        : width;

  // Keep Terminal & SideChat mounted silently in `.pid-wb-panes-grid` once visited so Shells / Side Chat never reset.
  const persistentPaneIds = [...activePanes];
  if (terminalVisited && !persistentPaneIds.includes("terminal")) persistentPaneIds.push("terminal");
  if (sideChatVisited && sideChatEnabled && !persistentPaneIds.includes("side-chat")) persistentPaneIds.push("side-chat");

  const maxRows = visibleMaximizedId
    ? 1
    : Math.max(1, columns.col1.length, columns.col2.length);

  const gridTemplateColumns = !visibleMaximizedId && columns.hasCol2
    ? `minmax(0, ${colRatio}fr) 1px minmax(0, ${1 - colRatio}fr)`
    : "minmax(0, 1fr)";

  const gridTemplateRows = visibleMaximizedId || maxRows === 1
    ? "minmax(0, 1fr)"
    : maxRows === 2
      ? `minmax(0, ${leftRowRatio}fr) 1px minmax(0, ${1 - leftRowRatio}fr)`
      : Array.from({ length: maxRows }, () => "minmax(0, 1fr)").join(" 1px ");

  const placementForPane = (paneId: string): CSSProperties | undefined => {
    if (visibleMaximizedId) {
      return paneId === visibleMaximizedId ? { gridColumn: "1", gridRow: "1" } : undefined;
    }
    const c1Idx = columns.col1.indexOf(paneId);
    if (c1Idx >= 0) {
      const spanAllRows = columns.col1.length === 1 && maxRows > 1;
      return {
        gridColumn: "1",
        gridRow: spanAllRows ? `1 / ${maxRows * 2}` : String(c1Idx * 2 + 1),
      };
    }
    const c2Idx = columns.col2.indexOf(paneId);
    if (c2Idx >= 0) {
      const spanAllRows = columns.col2.length === 1 && maxRows > 1;
      return {
        gridColumn: "3",
        gridRow: spanAllRows ? `1 / ${maxRows * 2}` : String(c2Idx * 2 + 1),
      };
    }
    return undefined;
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
          {inspectorMode === "floating" && (
            <div className="pid-wb-inspector-popover" role="region" aria-label="环境与上下文检查器">
              <TaskSummaryTab cwd={cwd} sessionFile={sessionFile} />
            </div>
          )}

          {(activePanes.length > 0 || persistentPaneIds.length > 0) && (
            <div
              ref={gridRef}
              className="pid-wb-panes-grid"
              hidden={activePanes.length === 0}
              data-pane-count={activePanes.length}
              style={{ gridTemplateColumns, gridTemplateRows }}
            >
              {!visibleMaximizedId && columns.hasCol2 && (
                <div
                  className="pid-wb-grid-splitter is-col"
                  role="separator"
                  aria-orientation="vertical"
                  aria-label="调整左右面板宽度比例"
                  style={{ gridColumn: "2", gridRow: maxRows > 1 ? `1 / ${maxRows * 2}` : "1" }}
                  onPointerDown={(event) => beginGridSplitDrag("col", event)}
                />
              )}
              {!visibleMaximizedId && maxRows === 2 && (
                <div
                  className="pid-wb-grid-splitter is-row"
                  role="separator"
                  aria-orientation="horizontal"
                  aria-label="调整上下面板高度比例"
                  style={{
                    gridColumn: columns.col1.length === 2 && columns.col2.length === 2
                      ? "1 / 4"
                      : columns.col1.length === 2
                        ? "1"
                        : "3",
                    gridRow: "2",
                  }}
                  onPointerDown={(event) => beginGridSplitDrag("row", event)}
                />
              )}
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
                    draggingPaneId={draggingPaneId}
                    onDragStartPane={setDraggingPaneId}
                    onDragEndPane={() => setDraggingPaneId(null)}
                    onDropOnPane={swapOrDockPanes}
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
    </>
  );
}

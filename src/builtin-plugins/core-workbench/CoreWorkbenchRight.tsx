/**
 * Built-in right workbench container registered on `shell.workbench.right`
 * (`src/builtin-plugins/core-workbench/CoreWorkbenchRight.tsx`, ADR 0023).
 *
 * Delegates tiling grid rendering to `workbench.tilingGrid` and inspector
 * sections to `workbench.inspector.sections` with zero hardcoded feature gates.
 */
import {
  useCallback,
  useEffect,
  useState,
  type PointerEvent as ReactPointerEvent,
  type ReactElement,
} from "react";
import {
  useClientContributions,
  useFrontendService,
  useSessionState,
  useWorkbenchState,
  useWorkspaceState,
} from "@qianji/client";
import type {
  CoreWorkbenchRightProps,
  SlotComponentProps,
} from "@qianji/client-slots";
import {
  buildEffectiveTree,
  computeTileLayout,
  filterRegisteredPanes,
  useSlotRegistryVersion,
} from "./tilingHelpers";

export { CoreWorkbenchTilingGrid } from "./CoreWorkbenchTilingGrid";

const MIN_RIGHT_WIDTH = 268;
const MAX_RIGHT_WIDTH = 1080;
const DEFAULT_RIGHT_WIDTH = 460;

function clampRightWidth(width: number): number {
  return Math.min(MAX_RIGHT_WIDTH, Math.max(MIN_RIGHT_WIDTH, Math.round(width)));
}

/** Right workbench shell registered on `shell.workbench.right`. */
export function CoreWorkbenchRight({
  cwd: propCwd,
  sessionFile: propSessionFile,
  open: propOpen,
  maximized: propMaximized,
  renderSlot,
  ctx,
}: SlotComponentProps<CoreWorkbenchRightProps, "session-maybe">): ReactElement | null {
  const workbench = useWorkbenchState(ctx);
  const workspace = useWorkspaceState(ctx);
  const session = useSessionState(ctx);
  const workbenchService = useFrontendService("workbenchService", ctx);
  const contributions = useClientContributions();
  const registry = ctx?.get("slots")?.registry;
  useSlotRegistryVersion(registry);

  const [panelWidth, setPanelWidth] = useState(DEFAULT_RIGHT_WIDTH);

  const rightOpen = propOpen ?? workbench?.rightOpen ?? false;
  const rightMaximized = propMaximized ?? workbench?.rightMaximized ?? false;
  const inspectorOpen = workbench?.inspectorOpen ?? false;
  const maximizedPaneId = workbench?.maximizedPaneId ?? null;
  const cwd = propCwd ?? workspace?.cwd ?? "";
  const sessionFile = propSessionFile !== undefined ? propSessionFile : (session?.sessionFile ?? null);

  const activePanes = filterRegisteredPanes(
    workbench?.openPanes ?? [],
    registry,
    contributions.rightWorkbenchTabs,
  );
  const effectiveTree = buildEffectiveTree(workbench?.layoutTree ?? null, activePanes);
  const tileLayout = computeTileLayout(effectiveTree);
  const isPaneMaximized = maximizedPaneId !== null && activePanes.includes(maximizedPaneId);
  const fullMaximized = rightMaximized || isPaneMaximized;
  const isFloatingInspector = !fullMaximized && inspectorOpen && tileLayout.hasHorizontalSplit;

  useEffect(() => {
    if (!isFloatingInspector || workbenchService === undefined) return;
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target instanceof Element ? event.target : null;
      if (target?.closest(".pid-wb-inspector-popover, .pid-wb-topbar-controls") !== null) return;
      workbenchService.setInspectorOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented) return;
      event.preventDefault();
      workbenchService.setInspectorOpen(false);
    };
    document.addEventListener("pointerdown", onPointerDown);
    window.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [isFloatingInspector, workbenchService]);

  const beginWidthResize = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    event.preventDefault();
    const startX = event.clientX;
    const startWidth = panelWidth;
    document.body.classList.add("workspace-is-resizing");
    const onMove = (moveEvent: PointerEvent) => {
      setPanelWidth(clampRightWidth(startWidth + (startX - moveEvent.clientX)));
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
  }, [panelWidth]);

  if (!rightOpen || (!inspectorOpen && activePanes.length === 0)) return null;

  const inspectorMode = fullMaximized
    ? "closed"
    : !inspectorOpen
      ? "closed"
      : activePanes.length === 0
        ? "sole"
        : tileLayout.hasHorizontalSplit
          ? "floating"
          : "docked";

  const effectiveWidth =
    inspectorMode === "sole"
      ? MIN_RIGHT_WIDTH
      : tileLayout.hasHorizontalSplit
        ? Math.min(MAX_RIGHT_WIDTH, Math.max(panelWidth, 780))
        : inspectorMode === "docked"
          ? Math.min(MAX_RIGHT_WIDTH, Math.max(panelWidth, 720))
          : panelWidth;

  const renderInspector = (): ReactElement => (
    <div className="pid-wb-pane pid-wb-inspector-pane">
      <div className="pid-wb-scroll pid-wb-inspector-scroll">
        {renderSlot("workbench.inspector.sections", { cwd, sessionFile })}
      </div>
    </div>
  );

  return (
    <>
      {!fullMaximized && (
        <div
          className="pid-right-resizer"
          role="separator"
          aria-orientation="vertical"
          aria-label="调整右侧工作台宽度"
          aria-valuemin={MIN_RIGHT_WIDTH}
          aria-valuemax={MAX_RIGHT_WIDTH}
          aria-valuenow={effectiveWidth}
          tabIndex={0}
          onPointerDown={beginWidthResize}
          onKeyDown={(event) => {
            if (event.key === "ArrowLeft") {
              event.preventDefault();
              setPanelWidth((prev) => clampRightWidth(prev + 24));
            } else if (event.key === "ArrowRight") {
              event.preventDefault();
              setPanelWidth((prev) => clampRightWidth(prev - 24));
            }
          }}
        />
      )}
      <aside
        className={`pid-right-workbench is-mode-${inspectorMode}${fullMaximized ? " maximized" : ""}`}
        data-core-workbench="right"
        data-rightbar-col=""
        style={fullMaximized ? undefined : { width: `${effectiveWidth}px` }}
        aria-label="右侧工作台"
      >
        {inspectorMode === "floating" && (
          <div className="pid-wb-inspector-popover" role="region" aria-label="环境与上下文检查器">
            {renderInspector()}
          </div>
        )}
        <div className="pid-wb-stage">
          {inspectorMode === "sole" && <div className="pid-wb-inspector-sole">{renderInspector()}</div>}
          {inspectorMode === "docked" && (
            <div className="pid-wb-inspector-docked" aria-label="环境与上下文检查器">
              {renderInspector()}
            </div>
          )}
          {renderSlot("workbench.tilingGrid", {
            cwd,
            sessionFile,
            openPanes: activePanes,
            maximizedPaneId,
          })}
        </div>
      </aside>
    </>
  );
}

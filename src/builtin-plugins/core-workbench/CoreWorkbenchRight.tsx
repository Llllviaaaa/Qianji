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
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
  type ReactElement,
} from "react";
import {
  useClientContributions,
  useFrontendService,
  useSessionState,
  useThemeState,
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

const WORKSPACE_PANEL_WIDTH_KEY = "qianji:workspace-panel-width";
const MIN_RIGHT_WIDTH = 268;
const MAX_RIGHT_WIDTH = 1080;
const DEFAULT_RIGHT_WIDTH = 460;

function maxViewportRightWidth(layoutScale = 1): number {
  if (typeof window === "undefined" || window.innerWidth <= 0) return MAX_RIGHT_WIDTH;
  const logicalViewport = window.innerWidth / (layoutScale > 0 ? layoutScale : 1);
  return Math.min(MAX_RIGHT_WIDTH, Math.max(MIN_RIGHT_WIDTH, Math.round(logicalViewport - 360)));
}

function clampRightWidth(width: number, layoutScale = 1): number {
  return Math.min(maxViewportRightWidth(layoutScale), Math.max(MIN_RIGHT_WIDTH, Math.round(width)));
}

function readPersistedRightWidth(): number {
  if (typeof window === "undefined") return DEFAULT_RIGHT_WIDTH;
  try {
    const raw = window.localStorage.getItem(WORKSPACE_PANEL_WIDTH_KEY);
    if (raw === null) return DEFAULT_RIGHT_WIDTH;
    const parsed = Number(raw);
    return Number.isFinite(parsed) && parsed > 0 ? clampRightWidth(parsed) : DEFAULT_RIGHT_WIDTH;
  } catch {
    return DEFAULT_RIGHT_WIDTH;
  }
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
  const theme = useThemeState(ctx);
  const workbenchService = useFrontendService("workbenchService", ctx);
  const contributions = useClientContributions();
  const registry = ctx?.get("slots")?.registry;
  useSlotRegistryVersion(registry);

  const layoutScale = theme?.resolvedScale ?? 1;
  const [panelWidth, setPanelWidth] = useState(readPersistedRightWidth);
  const resizeCleanupRef = useRef<(() => void) | null>(null);

  useEffect(() => {
    if (typeof window === "undefined") return;
    try {
      window.localStorage.setItem(WORKSPACE_PANEL_WIDTH_KEY, String(panelWidth));
    } catch {
      // Ignore storage write errors.
    }
  }, [panelWidth]);

  useEffect(
    () => () => {
      resizeCleanupRef.current?.();
    },
    [],
  );

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

  const inspectorMode = fullMaximized
    ? "closed"
    : !inspectorOpen
      ? "closed"
      : activePanes.length === 0
        ? "sole"
        : tileLayout.hasHorizontalSplit
          ? "floating"
          : "docked";

  const maxAllowedWidth = maxViewportRightWidth(layoutScale);
  const effectiveWidth =
    inspectorMode === "sole"
      ? MIN_RIGHT_WIDTH
      : tileLayout.hasHorizontalSplit
        ? Math.min(maxAllowedWidth, Math.max(panelWidth, 780))
        : inspectorMode === "docked"
          ? Math.min(maxAllowedWidth, Math.max(panelWidth, 720))
          : clampRightWidth(panelWidth, layoutScale);

  const beginWidthResize = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    event.preventDefault();
    resizeCleanupRef.current?.();
    const handleEl = event.currentTarget;
    const pointerId = event.pointerId;
    try {
      handleEl.setPointerCapture?.(pointerId);
    } catch {
      // Ignore synthetic events without capture support.
    }
    const startX = event.clientX;
    const startWidth = effectiveWidth;
    const scale = layoutScale > 0 ? layoutScale : 1;
    document.body.classList.add("workspace-is-resizing");
    const onMove = (moveEvent: PointerEvent) => {
      setPanelWidth(clampRightWidth(startWidth + (startX - moveEvent.clientX) / scale, scale));
    };
    const cleanup = () => {
      document.body.classList.remove("workspace-is-resizing");
      try {
        handleEl.releasePointerCapture?.(pointerId);
      } catch {
        // Ignore release errors.
      }
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", cleanup);
      window.removeEventListener("pointercancel", cleanup);
      resizeCleanupRef.current = null;
    };
    resizeCleanupRef.current = cleanup;
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", cleanup);
    window.addEventListener("pointercancel", cleanup);
  }, [effectiveWidth, layoutScale]);

  if (!rightOpen || (!inspectorOpen && activePanes.length === 0)) return null;

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
            const step = event.shiftKey ? 48 : 16;
            if (event.key === "ArrowLeft") {
              event.preventDefault();
              setPanelWidth((prev) => clampRightWidth(prev + step));
            } else if (event.key === "ArrowRight") {
              event.preventDefault();
              setPanelWidth((prev) => clampRightWidth(prev - step));
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

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
} from "react";
import {
  clampPanelSize,
  readStoredPanelSize,
  resolveWorkspacePanelMaxWidth,
  SIDEBAR_BOUNDS,
  WORKSPACE_PANEL_BOUNDS,
  WORKSPACE_PANEL_WIDTH_KEY,
  writeStoredPanelSize,
} from "./shellHelpers";

export function useCorePanelResize({
  sidebarWidth,
  sidebarVisible,
  layoutScale,
  onSidebarWidthChange,
}: {
  readonly sidebarWidth: number;
  readonly sidebarVisible: boolean;
  readonly layoutScale: number;
  readonly onSidebarWidthChange: (nextWidth: number) => void;
}) {
  const [workspacePanelWidth, setWorkspacePanelWidth] = useState(() =>
    readStoredPanelSize(WORKSPACE_PANEL_WIDTH_KEY, WORKSPACE_PANEL_BOUNDS),
  );
  const cleanupRef = useRef<(() => void) | null>(null);

  useEffect(
    () => () => {
      cleanupRef.current?.();
      cleanupRef.current = null;
    },
    [],
  );

  const beginSidebarResize = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      if (event.button !== 0 || typeof window === "undefined") return;
      event.preventDefault();
      cleanupRef.current?.();
      const handleEl = event.currentTarget;
      const pointerId = event.pointerId;
      try {
        handleEl.setPointerCapture?.(pointerId);
      } catch {
        // Synthetic pointer events in tests may not support capture.
      }
      const startX = event.clientX;
      const startWidth = sidebarWidth;
      const body = document.body;
      body?.classList.add("sidebar-is-resizing");
      const prevCursor = body?.style.cursor ?? "";
      const prevUserSelect = body?.style.userSelect ?? "";
      if (body !== null) {
        body.style.cursor = "col-resize";
        body.style.userSelect = "none";
      }
      const onMove = (moveEvent: PointerEvent) => {
        const delta = (moveEvent.clientX - startX) / (layoutScale || 1);
        onSidebarWidthChange(clampPanelSize(startWidth + delta, SIDEBAR_BOUNDS));
      };
      const finish = () => {
        body?.classList.remove("sidebar-is-resizing");
        if (body !== null) {
          body.style.cursor = prevCursor;
          body.style.userSelect = prevUserSelect;
        }
        try {
          handleEl.releasePointerCapture?.(pointerId);
        } catch {
          // Ignore release errors after pointercancel.
        }
        window.removeEventListener("pointermove", onMove);
        window.removeEventListener("pointerup", finish);
        window.removeEventListener("pointercancel", finish);
        if (cleanupRef.current === finish) cleanupRef.current = null;
      };
      cleanupRef.current = finish;
      window.addEventListener("pointermove", onMove);
      window.addEventListener("pointerup", finish);
      window.addEventListener("pointercancel", finish);
    },
    [layoutScale, onSidebarWidthChange, sidebarWidth],
  );

  const resizeSidebarWithKeyboard = useCallback(
    (event: ReactKeyboardEvent<HTMLDivElement>) => {
      if (event.key === "ArrowLeft") {
        event.preventDefault();
        onSidebarWidthChange(clampPanelSize(sidebarWidth - SIDEBAR_BOUNDS.step, SIDEBAR_BOUNDS));
      } else if (event.key === "ArrowRight") {
        event.preventDefault();
        onSidebarWidthChange(clampPanelSize(sidebarWidth + SIDEBAR_BOUNDS.step, SIDEBAR_BOUNDS));
      } else if (event.key === "Home") {
        event.preventDefault();
        onSidebarWidthChange(SIDEBAR_BOUNDS.min);
      } else if (event.key === "End") {
        event.preventDefault();
        onSidebarWidthChange(SIDEBAR_BOUNDS.max);
      }
    },
    [onSidebarWidthChange, sidebarWidth],
  );

  const updateWorkspacePanelWidth = useCallback(
    (nextWidth: number) => {
      const viewportWidth = typeof window !== "undefined" ? window.innerWidth : 1440;
      const maxWidth = resolveWorkspacePanelMaxWidth(viewportWidth, layoutScale, sidebarVisible ? sidebarWidth : 0);
      const clamped = clampPanelSize(nextWidth, WORKSPACE_PANEL_BOUNDS, maxWidth);
      setWorkspacePanelWidth(clamped);
      writeStoredPanelSize(WORKSPACE_PANEL_WIDTH_KEY, clamped);
    },
    [layoutScale, sidebarVisible, sidebarWidth],
  );

  const beginWorkspaceResize = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      if (event.button !== 0 || typeof window === "undefined") return;
      event.preventDefault();
      cleanupRef.current?.();
      const handleEl = event.currentTarget;
      const pointerId = event.pointerId;
      try {
        handleEl.setPointerCapture?.(pointerId);
      } catch {
        // Ignore synthetic capture failures.
      }
      const startX = event.clientX;
      const startWidth = workspacePanelWidth;
      const body = document.body;
      body?.classList.add("sidebar-is-resizing");
      const prevCursor = body?.style.cursor ?? "";
      const prevUserSelect = body?.style.userSelect ?? "";
      if (body !== null) {
        body.style.cursor = "col-resize";
        body.style.userSelect = "none";
      }
      const onMove = (moveEvent: PointerEvent) => {
        const delta = (startX - moveEvent.clientX) / (layoutScale || 1);
        updateWorkspacePanelWidth(startWidth + delta);
      };
      const finish = () => {
        body?.classList.remove("sidebar-is-resizing");
        if (body !== null) {
          body.style.cursor = prevCursor;
          body.style.userSelect = prevUserSelect;
        }
        try {
          handleEl.releasePointerCapture?.(pointerId);
        } catch {
          // Ignore release failures.
        }
        window.removeEventListener("pointermove", onMove);
        window.removeEventListener("pointerup", finish);
        window.removeEventListener("pointercancel", finish);
        if (cleanupRef.current === finish) cleanupRef.current = null;
      };
      cleanupRef.current = finish;
      window.addEventListener("pointermove", onMove);
      window.addEventListener("pointerup", finish);
      window.addEventListener("pointercancel", finish);
    },
    [layoutScale, updateWorkspacePanelWidth, workspacePanelWidth],
  );

  const resizeWorkspaceWithKeyboard = useCallback(
    (event: ReactKeyboardEvent<HTMLDivElement>) => {
      if (event.key === "ArrowLeft") {
        event.preventDefault();
        updateWorkspacePanelWidth(workspacePanelWidth + WORKSPACE_PANEL_BOUNDS.step);
      } else if (event.key === "ArrowRight") {
        event.preventDefault();
        updateWorkspacePanelWidth(workspacePanelWidth - WORKSPACE_PANEL_BOUNDS.step);
      }
    },
    [updateWorkspacePanelWidth, workspacePanelWidth],
  );

  return {
    workspacePanelWidth,
    beginSidebarResize,
    resizeSidebarWithKeyboard,
    beginWorkspaceResize,
    resizeWorkspaceWithKeyboard,
  };
}

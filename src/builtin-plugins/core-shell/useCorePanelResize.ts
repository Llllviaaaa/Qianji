import {
  useCallback,
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

  const beginSidebarResize = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      if (event.button !== 0 || typeof window === "undefined") return;
      event.preventDefault();
      const startX = event.clientX;
      const startWidth = sidebarWidth;
      document.documentElement.classList.add("sidebar-is-resizing");
      const onMove = (moveEvent: PointerEvent) => {
        const delta = (moveEvent.clientX - startX) / (layoutScale || 1);
        onSidebarWidthChange(clampPanelSize(startWidth + delta, SIDEBAR_BOUNDS));
      };
      const onUp = () => {
        document.documentElement.classList.remove("sidebar-is-resizing");
        window.removeEventListener("pointermove", onMove);
        window.removeEventListener("pointerup", onUp);
      };
      window.addEventListener("pointermove", onMove);
      window.addEventListener("pointerup", onUp);
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
      const startX = event.clientX;
      const startWidth = workspacePanelWidth;
      document.documentElement.classList.add("workspace-is-resizing");
      const onMove = (moveEvent: PointerEvent) => {
        const delta = (startX - moveEvent.clientX) / (layoutScale || 1);
        updateWorkspacePanelWidth(startWidth + delta);
      };
      const onUp = () => {
        document.documentElement.classList.remove("workspace-is-resizing");
        window.removeEventListener("pointermove", onMove);
        window.removeEventListener("pointerup", onUp);
      };
      window.addEventListener("pointermove", onMove);
      window.addEventListener("pointerup", onUp);
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

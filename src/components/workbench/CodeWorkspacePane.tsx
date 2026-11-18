import { Suspense, lazy, useCallback, useMemo } from "react";
import { useWorkbenchLayoutStore } from "../../stores/workbenchLayoutStore";
import { matchesWorkbenchFileCwd, useWorkbenchStore } from "../../stores/workbenchStore";
import { WorkspaceFilesTab } from "./WorkspaceFilesTab";

const LazyCodeEditorTab = lazy(() =>
  import("./CodeEditorTab").then((mod) => ({ default: mod.CodeEditorTab })),
);

export interface CodeWorkspacePaneProps {
  cwd: string;
  paneTab: string;
  isSecondary?: boolean;
  onAddToChat?: (path: string) => void;
}

export function CodeWorkspacePane({
  cwd,
  paneTab,
  isSecondary = false,
  onAddToChat,
}: CodeWorkspacePaneProps) {
  const openFiles = useWorkbenchStore((state) => state.openFiles);
  const fileDrawerOpen = useWorkbenchLayoutStore((state) => state.fileDrawerOpen);
  const setFileDrawerOpen = useWorkbenchLayoutStore((state) => state.setFileDrawerOpen);

  const workspaceFiles = useMemo(
    () => openFiles.filter((item) => matchesWorkbenchFileCwd(item.cwd, cwd)),
    [cwd, openFiles],
  );

  const drawerVisible = fileDrawerOpen || paneTab === "files";

  const handleToggleDrawer = useCallback(() => {
    if (drawerVisible) {
      setFileDrawerOpen(false);
      if (paneTab === "files") {
        if (isSecondary) {
          useWorkbenchLayoutStore.getState().setSecondaryTab("editor");
        } else {
          useWorkbenchStore.getState().openTab("editor");
        }
      }
      return;
    }
    setFileDrawerOpen(true);
  }, [drawerVisible, isSecondary, paneTab, setFileDrawerOpen]);

  if (workspaceFiles.length === 0) {
    return <WorkspaceFilesTab cwd={cwd} onAddToChat={onAddToChat} />;
  }

  return (
    <div className="pid-wb-code-workspace">
      {drawerVisible && (
        <div className="pid-wb-file-drawer" aria-label="工作区文件抽屉">
          <WorkspaceFilesTab cwd={cwd} onAddToChat={onAddToChat} />
        </div>
      )}
      <div className="pid-wb-code-main">
        <Suspense fallback={<div className="pid-wb-empty">正在加载编辑器…</div>}>
          <LazyCodeEditorTab
            cwd={cwd}
            fileDrawerOpen={drawerVisible}
            onToggleFileDrawer={handleToggleDrawer}
          />
        </Suspense>
      </div>
    </div>
  );
}

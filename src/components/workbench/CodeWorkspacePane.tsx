import { Suspense, lazy, useMemo } from "react";
import { Folder } from "lucide-react";
import { useWorkbenchLayoutStore } from "../../stores/workbenchLayoutStore";
import { matchesWorkbenchFileCwd, useWorkbenchStore } from "../../stores/workbenchStore";
import { WorkspaceFilesTab } from "./WorkspaceFilesTab";

const LazyCodeEditorTab = lazy(() =>
  import("./CodeEditorTab").then((mod) => ({ default: mod.CodeEditorTab })),
);

export interface CodeWorkspacePaneProps {
  cwd: string;
  onAddToChat?: (path: string) => void;
}

export function CodeWorkspacePane({ cwd, onAddToChat }: CodeWorkspacePaneProps) {
  const openFiles = useWorkbenchStore((state) => state.openFiles);
  const fileDrawerOpen = useWorkbenchLayoutStore((state) => state.fileDrawerOpen);
  const setFileDrawerOpen = useWorkbenchLayoutStore((state) => state.setFileDrawerOpen);

  const workspaceFiles = useMemo(
    () => openFiles.filter((item) => matchesWorkbenchFileCwd(item.cwd, cwd)),
    [cwd, openFiles],
  );

  const hasOpenFiles = workspaceFiles.length > 0;

  return (
    <div
      className={`pid-wb-code-workspace${hasOpenFiles ? " has-open-files" : " is-empty-editor"}${fileDrawerOpen ? " has-tree" : ""}`}
    >
      <div className={`pid-wb-code-main${hasOpenFiles ? "" : " is-empty"}`}>
        {hasOpenFiles ? (
          <Suspense fallback={<div className="pid-wb-empty">正在加载编辑器…</div>}>
            <LazyCodeEditorTab cwd={cwd} />
          </Suspense>
        ) : (
          <div className="pid-wb-empty pid-wb-claude-empty">
            <Folder size={22} strokeWidth={1.45} className="pid-wb-empty-icon" />
            <strong>打开的文件将显示在此处</strong>
            <p>
              {fileDrawerOpen
                ? "在右侧文件树中选择文件，或点击对话中的文件路径。"
                : "点击对话中的文件路径，或展开右侧文件树选择文件。"}
            </p>
            {!fileDrawerOpen && (
              <button type="button" className="pid-wb-btn small" onClick={() => setFileDrawerOpen(true)}>
                展开文件树
              </button>
            )}
          </div>
        )}
      </div>

      {fileDrawerOpen && (
        <div className="pid-wb-file-tree-rail" aria-label="工作区文件树">
          <WorkspaceFilesTab cwd={cwd} onAddToChat={onAddToChat} />
        </div>
      )}
    </div>
  );
}

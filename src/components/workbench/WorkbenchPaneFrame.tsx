import { useState, type CSSProperties, type DragEvent } from "react";
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
import type { CodeReviewScope } from "../../lib/codeReview";
import type { ClientWorkbenchTabContribution } from "../../lib/clientContributions";
import {
  useWorkbenchLayoutStore,
  type PaneDropZone,
} from "../../stores/workbenchLayoutStore";
import { useWorkbenchStore } from "../../stores/workbenchStore";
import type { GitSnapshot } from "../../types";
import { WorkbenchPaneBody } from "./WorkbenchPaneBody";

export interface WorkbenchPaneFrameProps {
  paneId: string;
  visible: boolean;
  maximized: boolean;
  soleDismissiblePane: boolean;
  canFlipTwoPane: boolean;
  twoPaneDirection: "horizontal" | "vertical";
  gridStyle?: CSSProperties;
  cwd: string;
  sessionFile: string | null;
  git: GitSnapshot | null;
  codeReviewEnabled: boolean;
  webPreviewEnabled: boolean;
  sideChatEnabled: boolean;
  pluginTabs: readonly ClientWorkbenchTabContribution[];
  draggingPaneId: string | null;
  onDragStartPane: (paneId: string) => void;
  onDragEndPane: () => void;
  onDropOnPane: (sourceId: string, targetId: string, zone: PaneDropZone) => void;
  onRefreshGit: () => Promise<void>;
  onRestoreFiles: (paths?: string[]) => Promise<void>;
  onRequestReview: (scope?: CodeReviewScope) => void;
  onAddToChat?: (path: string) => void;
}

function resolvePaneTitle(paneId: string, pluginTabs: readonly ClientWorkbenchTabContribution[]): string {
  switch (paneId) {
    case "review":
      return "代码变更";
    case "preview":
      return "浏览器预览";
    case "files":
    case "editor":
      return "工作区文件";
    case "terminal":
      return "终端";
    case "side-chat":
      return "侧边对话";
    default:
      return pluginTabs.find((tab) => tab.id === paneId)?.label ?? paneId;
  }
}

export function WorkbenchPaneFrame({
  paneId,
  visible,
  maximized,
  soleDismissiblePane,
  canFlipTwoPane,
  twoPaneDirection,
  gridStyle,
  cwd,
  sessionFile,
  git,
  codeReviewEnabled,
  webPreviewEnabled,
  sideChatEnabled,
  pluginTabs,
  draggingPaneId,
  onDragStartPane,
  onDragEndPane,
  onDropOnPane,
  onRefreshGit,
  onRestoreFiles,
  onRequestReview,
  onAddToChat,
}: WorkbenchPaneFrameProps) {
  const fileDrawerOpen = useWorkbenchLayoutStore((state) => state.fileDrawerOpen);
  const toggleFileDrawer = useWorkbenchLayoutStore((state) => state.toggleFileDrawer);
  const setTwoPaneDirection = useWorkbenchLayoutStore((state) => state.setTwoPaneDirection);
  const toggleMaximizePane = useWorkbenchLayoutStore((state) => state.toggleMaximizePane);
  const closePane = useWorkbenchLayoutStore((state) => state.closePane);

  const [dropZone, setDropZone] = useState<PaneDropZone | null>(null);

  const title = resolvePaneTitle(paneId, pluginTabs);
  const reviewCount = git?.files.length ?? 0;

  const computeDropZone = (event: DragEvent<HTMLElement>): PaneDropZone => {
    if (!canFlipTwoPane) return "swap";
    const rect = event.currentTarget.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return "swap";
    const relX = (event.clientX - rect.left) / rect.width;
    const relY = (event.clientY - rect.top) / rect.height;
    if (relX < 0.24) return "left";
    if (relX > 0.76) return "right";
    if (relY < 0.24) return "top";
    if (relY > 0.76) return "bottom";
    return "swap";
  };

  const handleHeaderDragStart = (event: DragEvent<HTMLElement>) => {
    if (!visible) return;
    const target = event.target instanceof Element ? event.target : null;
    if (target?.closest("button, input")) {
      event.preventDefault();
      return;
    }
    event.dataTransfer.effectAllowed = "move";
    event.dataTransfer.setData("text/plain", paneId);
    onDragStartPane(paneId);
  };

  const handleDragOver = (event: DragEvent<HTMLElement>) => {
    if (!visible || !draggingPaneId || draggingPaneId === paneId) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = "move";
    const nextZone = computeDropZone(event);
    if (nextZone !== dropZone) setDropZone(nextZone);
  };

  const handleDrop = (event: DragEvent<HTMLElement>) => {
    if (!visible) return;
    event.preventDefault();
    const source = draggingPaneId || event.dataTransfer.getData("text/plain");
    const zone = dropZone ?? "swap";
    setDropZone(null);
    if (source && source !== paneId) {
      onDropOnPane(source, paneId, zone);
    }
    onDragEndPane();
  };

  const closeTitle = soleDismissiblePane ? "隐藏工作台 (Ctrl+Alt+B)" : `关闭${title}`;
  const maxTitle = maximized ? "还原宽度" : "最大化工作台";

  const sharedWindowControls = (
    <>
      {canFlipTwoPane && !maximized && (
        <button
          type="button"
          className="pid-wb-icon-btn"
          title={twoPaneDirection === "horizontal" ? "切换为上下分屏" : "切换为左右分屏"}
          aria-label={twoPaneDirection === "horizontal" ? "切换为上下分屏" : "切换为左右分屏"}
          onClick={() => setTwoPaneDirection(twoPaneDirection === "horizontal" ? "vertical" : "horizontal")}
        >
          {twoPaneDirection === "horizontal" ? <Rows2 size={13} /> : <Columns2 size={13} />}
        </button>
      )}
      <button
        type="button"
        className="pid-wb-icon-btn"
        title={maxTitle}
        aria-label={maxTitle}
        aria-pressed={maximized}
        onClick={() => toggleMaximizePane(paneId)}
      >
        {maximized ? <Minimize2 size={13} /> : <Maximize2 size={13} />}
      </button>
      <button
        type="button"
        className="pid-wb-icon-btn"
        title={closeTitle}
        aria-label={closeTitle}
        onClick={() => closePane(paneId)}
      >
        <X size={13} />
      </button>
    </>
  );

  return (
    <section
      className={`pid-wb-grid-pane${dropZone ? ` drop-${dropZone}` : ""}${draggingPaneId === paneId ? " is-dragging" : ""}`}
      data-pane-id={paneId}
      aria-label={title}
      hidden={!visible}
      style={visible ? gridStyle : { display: "none" }}
      onDragOver={handleDragOver}
      onDragLeave={() => {
        if (dropZone !== null) setDropZone(null);
      }}
      onDrop={handleDrop}
    >
      {paneId !== "preview" && (
        <header
          className="pid-wb-pane-header"
          draggable={visible}
          onDragStart={handleHeaderDragStart}
          onDragEnd={() => {
            setDropZone(null);
            onDragEndPane();
          }}
        >
          <div className="pid-wb-pane-title-group">
            <span className="pid-wb-pane-title">{title}</span>
            {paneId === "review" && reviewCount > 0 && (
              <span className="pid-wb-pane-count">{reviewCount}</span>
            )}
            {paneId === "terminal" && (
              <button
                type="button"
                className="pid-wb-icon-btn"
                title="新建终端标签页"
                aria-label="新建终端标签页"
                onClick={() => useWorkbenchStore.getState().bumpTerminalCreateNonce()}
              >
                <Plus size={14} />
              </button>
            )}
          </div>

          <div className="pid-wb-pane-actions">
            {paneId === "review" && git?.isRepository && (
              <button
                type="button"
                className="pid-wb-icon-btn"
                title="刷新 Git 变更"
                aria-label="刷新 Git 变更"
                onClick={() => void onRefreshGit()}
              >
                <RefreshCw size={12.5} />
              </button>
            )}
            {paneId === "files" && (
              <button
                type="button"
                className={`pid-wb-icon-btn${fileDrawerOpen ? " active" : ""}`}
                title={fileDrawerOpen ? "收起文件树" : "展开文件树"}
                aria-label={fileDrawerOpen ? "收起文件树" : "展开文件树"}
                aria-pressed={fileDrawerOpen}
                onClick={toggleFileDrawer}
              >
                <PanelRight size={13.5} />
              </button>
            )}
            {sharedWindowControls}
          </div>
        </header>
      )}

      <div className="pid-wb-pane-content">
        <WorkbenchPaneBody
          paneTab={paneId}
          isVisible={visible}
          cwd={cwd}
          sessionFile={sessionFile}
          git={git}
          codeReviewEnabled={codeReviewEnabled}
          webPreviewEnabled={webPreviewEnabled}
          sideChatEnabled={sideChatEnabled}
          pluginTabs={pluginTabs}
          paneControls={paneId === "preview" ? sharedWindowControls : undefined}
          draggableHeader={paneId === "preview" && visible}
          onHeaderDragStart={paneId === "preview" ? handleHeaderDragStart : undefined}
          onHeaderDragEnd={paneId === "preview" ? () => { setDropZone(null); onDragEndPane(); } : undefined}
          onRefreshGit={onRefreshGit}
          onRestoreFiles={onRestoreFiles}
          onRequestReview={onRequestReview}
          onAddToChat={onAddToChat}
        />
      </div>
    </section>
  );
}

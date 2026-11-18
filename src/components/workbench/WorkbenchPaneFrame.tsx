import type { CSSProperties, PointerEvent as ReactPointerEvent } from "react";
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
  isDragging: boolean;
  dropZone: PaneDropZone | null;
  onHeaderPointerDown: (paneId: string, title: string, event: ReactPointerEvent<HTMLElement>) => void;
  onRefreshGit: () => Promise<void>;
  onRestoreFiles: (paths?: string[]) => Promise<void>;
  onRequestReview: (scope?: CodeReviewScope) => void;
  onAddToChat?: (path: string) => void;
}

const DROP_ZONE_LABELS: Record<PaneDropZone, string> = {
  top: "上方分屏",
  bottom: "下方分屏",
  left: "左侧并排",
  right: "右侧并排",
  swap: "互换位置",
};

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
  isDragging,
  dropZone,
  onHeaderPointerDown,
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

  const title = resolvePaneTitle(paneId, pluginTabs);
  const reviewCount = git?.files.length ?? 0;

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
      className={`pid-wb-grid-pane${dropZone ? ` drop-${dropZone}` : ""}${isDragging ? " is-dragging" : ""}`}
      data-pane-id={paneId}
      aria-label={title}
      hidden={!visible}
      style={visible ? gridStyle : { display: "none" }}
    >
      {dropZone !== null && (
        <div className={`pid-wb-drop-indicator zone-${dropZone}`} aria-hidden="true">
          <span className="pid-wb-drop-badge">{DROP_ZONE_LABELS[dropZone]}</span>
        </div>
      )}
      {paneId !== "preview" && (
        <header
          className="pid-wb-pane-header"
          onPointerDown={(event) => onHeaderPointerDown(paneId, title, event)}
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
          onHeaderPointerDown={
            paneId === "preview"
              ? (event) => onHeaderPointerDown(paneId, title, event)
              : undefined
          }
          onRefreshGit={onRefreshGit}
          onRestoreFiles={onRestoreFiles}
          onRequestReview={onRequestReview}
          onAddToChat={onAddToChat}
        />
      </div>
    </section>
  );
}

import { Suspense, lazy, type DragEvent, type ReactNode } from "react";
import type { CodeReviewScope } from "../../lib/codeReview";
import type { ClientWorkbenchTabContribution } from "../../lib/clientContributions";
import { isCodePaneTab } from "../../stores/workbenchLayoutStore";
import type { GitSnapshot } from "../../types";
import { SideChatTab } from "../SideChatTab";
import { SlotEntryHost } from "../common/ErrorBoundary";
import { BrowserPreviewTab } from "./BrowserPreviewTab";
import { CodeWorkspacePane } from "./CodeWorkspacePane";
import { ReviewDiffTab } from "./ReviewDiffTab";
import { TaskSummaryTab } from "./TaskSummaryTab";

const LazyTerminalPanel = lazy(() =>
  import("./TerminalPanel").then((mod) => ({ default: mod.TerminalPanel })),
);

export interface WorkbenchPaneBodyProps {
  paneTab: string;
  isVisible?: boolean;
  cwd: string;
  sessionFile: string | null;
  git: GitSnapshot | null;
  codeReviewEnabled: boolean;
  webPreviewEnabled: boolean;
  sideChatEnabled: boolean;
  pluginTabs: readonly ClientWorkbenchTabContribution[];
  paneControls?: ReactNode;
  draggableHeader?: boolean;
  onHeaderDragStart?: (event: DragEvent<HTMLElement>) => void;
  onHeaderDragEnd?: () => void;
  onRefreshGit: () => Promise<void>;
  onRestoreFiles: (paths?: string[]) => Promise<void>;
  onRequestReview: (scope?: CodeReviewScope) => void;
  onAddToChat?: (path: string) => void;
}

export function WorkbenchPaneBody({
  paneTab,
  isVisible = true,
  cwd,
  sessionFile,
  git,
  codeReviewEnabled,
  webPreviewEnabled,
  sideChatEnabled,
  pluginTabs,
  paneControls,
  draggableHeader,
  onHeaderDragStart,
  onHeaderDragEnd,
  onRefreshGit,
  onRestoreFiles,
  onRequestReview,
  onAddToChat,
}: WorkbenchPaneBodyProps) {
  const activePluginTab = pluginTabs.find((tab) => tab.id === paneTab);
  const renderCode = isCodePaneTab(paneTab);

  return (
    <>
      {paneTab === "summary" && <TaskSummaryTab cwd={cwd} sessionFile={sessionFile} />}
      {renderCode && <CodeWorkspacePane cwd={cwd} onAddToChat={onAddToChat} />}
      {codeReviewEnabled && paneTab === "review" && (
        <ReviewDiffTab
          cwd={cwd}
          git={git}
          onRefreshGit={onRefreshGit}
          onRestoreFiles={onRestoreFiles}
          onRequestReview={onRequestReview}
        />
      )}
      {webPreviewEnabled && paneTab === "preview" && (
        <BrowserPreviewTab
          cwd={cwd}
          paneControls={paneControls}
          draggableHeader={draggableHeader}
          onHeaderDragStart={onHeaderDragStart}
          onHeaderDragEnd={onHeaderDragEnd}
        />
      )}
      {paneTab === "terminal" && (
        <Suspense fallback={<div className="pid-wb-empty">正在加载集成终端…</div>}>
          <LazyTerminalPanel cwd={cwd} visible={isVisible} compactHeader />
        </Suspense>
      )}
      {sideChatEnabled && paneTab === "side-chat" && (
        <div className="pid-wb-sidechat-host" hidden={!isVisible}>
          <SideChatTab
            key={sessionFile ?? "draft"}
            sessionFile={sessionFile ?? ""}
            fallbackCwd={cwd}
            tabId={`side-${sessionFile ?? "draft"}`}
            visible={isVisible}
          />
        </div>
      )}
      {activePluginTab && (
        <SlotEntryHost
          entry={activePluginTab}
          context={{ cwd, sessionFile }}
          slotName="rightWorkbenchTabs"
        />
      )}
    </>
  );
}

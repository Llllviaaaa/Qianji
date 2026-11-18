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

export interface WorkbenchPaneBodyProps {
  paneTab: string;
  isSecondary?: boolean;
  cwd: string;
  sessionFile: string | null;
  git: GitSnapshot | null;
  codeReviewEnabled: boolean;
  webPreviewEnabled: boolean;
  sideChatEnabled: boolean;
  mountSideChat: boolean;
  pluginTabs: readonly ClientWorkbenchTabContribution[];
  onRefreshGit: () => Promise<void>;
  onRestoreFiles: (paths?: string[]) => Promise<void>;
  onRequestReview: (scope?: CodeReviewScope) => void;
  onAddToChat?: (path: string) => void;
}

export function WorkbenchPaneBody({
  paneTab,
  isSecondary = false,
  cwd,
  sessionFile,
  git,
  codeReviewEnabled,
  webPreviewEnabled,
  sideChatEnabled,
  mountSideChat,
  pluginTabs,
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
      {renderCode && (
        <CodeWorkspacePane cwd={cwd} paneTab={paneTab} isSecondary={isSecondary} onAddToChat={onAddToChat} />
      )}
      {codeReviewEnabled && paneTab === "review" && (
        <ReviewDiffTab
          cwd={cwd}
          git={git}
          onRefreshGit={onRefreshGit}
          onRestoreFiles={onRestoreFiles}
          onRequestReview={onRequestReview}
        />
      )}
      {webPreviewEnabled && paneTab === "preview" && <BrowserPreviewTab cwd={cwd} />}
      {sideChatEnabled && !isSecondary && mountSideChat && (
        <div className="pid-wb-sidechat-host" hidden={paneTab !== "side-chat"}>
          <SideChatTab
            key={sessionFile ?? "draft"}
            sessionFile={sessionFile ?? ""}
            fallbackCwd={cwd}
            tabId={`side-${sessionFile ?? "draft"}`}
            visible={paneTab === "side-chat"}
          />
        </div>
      )}
      {sideChatEnabled && isSecondary && paneTab === "side-chat" && (
        <div className="pid-wb-sidechat-host">
          <SideChatTab
            key={`split-${sessionFile ?? "draft"}`}
            sessionFile={sessionFile ?? ""}
            fallbackCwd={cwd}
            tabId={`side-split-${sessionFile ?? "draft"}`}
            visible
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

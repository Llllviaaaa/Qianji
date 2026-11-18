import {
  useCallback, useEffect, useMemo, useRef, useState,
  type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent, type ReactNode, type WheelEvent as ReactWheelEvent,
} from "react";
import { LayoutGroup, motion } from "motion/react";
import {
  Activity, Columns2, FileCode2, GitCompare, Globe, Maximize2, MessageSquare, Minimize2, Rows2, X,
} from "lucide-react";
import { DockBottomIcon, DockRightIcon } from "../common/ChromeIcons";
import { useSyncOnChange } from "../../hooks/useSyncOnChange";
import type { CodeReviewScope } from "../../lib/codeReview";
import { useClientContributions } from "../../lib/clientContributions";
import { useBuiltinPluginGatesStore } from "../../stores/builtinPluginGatesStore";
import {
  isCodePaneTab,
  pickSecondaryTab,
  useWorkbenchLayoutStore,
} from "../../stores/workbenchLayoutStore";
import { matchesWorkbenchFileCwd, useWorkbenchStore } from "../../stores/workbenchStore";
import type { GitSnapshot } from "../../types";
import { SlotEntryHost } from "../common/ErrorBoundary";
import { WorkbenchPaneBody } from "./WorkbenchPaneBody";

export interface WorkbenchTopbarControlsProps {
  cwd: string;
  sessionFile: string | null;
}

export function WorkbenchTopbarControls({ cwd, sessionFile }: WorkbenchTopbarControlsProps) {
  const rightOpen = useWorkbenchStore((state) => state.rightOpen);
  const bottomOpen = useWorkbenchStore((state) => state.bottomOpen);
  const toggleRight = useWorkbenchStore((state) => state.toggleRight);
  const toggleBottom = useWorkbenchStore((state) => state.toggleBottom);
  const contributions = useClientContributions();

  return (
    <div className="pid-wb-topbar-controls">
      {contributions.topbarActions.map((action) => (
        <span key={action.id} className="pid-wb-plugin-action">
          <SlotEntryHost entry={action} context={{ cwd, sessionFile }} slotName="topbarActions" compact />
        </span>
      ))}
      <button
        type="button"
        className={`icon-button${bottomOpen ? " active" : ""}`}
        title="切换底部终端面板 (Ctrl+J)"
        aria-pressed={bottomOpen}
        onClick={toggleBottom}
      >
        <DockBottomIcon open={bottomOpen} size={15} />
      </button>
      <button
        type="button"
        className={`icon-button${rightOpen ? " active" : ""}`}
        title="切换右侧工作台 (Ctrl+Alt+B)"
        aria-pressed={rightOpen}
        onClick={toggleRight}
      >
        <DockRightIcon open={rightOpen} size={15} />
      </button>
    </div>
  );
}

export interface RightWorkbenchProps {
  cwd: string;
  sessionFile: string | null;
  width: number;
  git: GitSnapshot | null;
  onRefreshGit: () => Promise<void>;
  onRestoreFiles: (paths?: string[]) => Promise<void>;
  onRequestReview: (scope?: CodeReviewScope) => void;
  onAddToChat?: (path: string) => void;
  resize: {
    onPointerDown: (event: ReactPointerEvent<HTMLDivElement>) => void;
    onKeyDown: (event: ReactKeyboardEvent<HTMLDivElement>) => void;
    min: number;
    max: number;
  };
}

export function RightWorkbench({
  cwd,
  sessionFile,
  width,
  git,
  onRefreshGit,
  onRestoreFiles,
  onRequestReview,
  onAddToChat,
  resize,
}: RightWorkbenchProps) {
  const rightOpen = useWorkbenchStore((state) => state.rightOpen);
  const rightMaximized = useWorkbenchStore((state) => state.rightMaximized);
  const activeTab = useWorkbenchStore((state) => state.activeTab);
  const openFiles = useWorkbenchStore((state) => state.openFiles);
  const openFilesCount = useMemo(
    () => openFiles.filter((file) => matchesWorkbenchFileCwd(file.cwd, cwd)).length,
    [cwd, openFiles],
  );
  const openTab = useWorkbenchStore((state) => state.openTab);
  const setRightOpen = useWorkbenchStore((state) => state.setRightOpen);
  const toggleRightMaximized = useWorkbenchStore((state) => state.toggleRightMaximized);

  const splitOpen = useWorkbenchLayoutStore((state) => state.splitOpen);
  const splitDirection = useWorkbenchLayoutStore((state) => state.splitDirection);
  const secondaryTab = useWorkbenchLayoutStore((state) => state.secondaryTab);
  const splitRatio = useWorkbenchLayoutStore((state) => state.splitRatio);
  const toggleSplit = useWorkbenchLayoutStore((state) => state.toggleSplit);
  const setSplitDirection = useWorkbenchLayoutStore((state) => state.setSplitDirection);
  const setSecondaryTab = useWorkbenchLayoutStore((state) => state.setSecondaryTab);
  const setSplitRatio = useWorkbenchLayoutStore((state) => state.setSplitRatio);
  const closeSplit = useWorkbenchLayoutStore((state) => state.closeSplit);

  const codeReviewEnabled = useBuiltinPluginGatesStore((state) => state.codeReviewEnabled);
  const webPreviewEnabled = useBuiltinPluginGatesStore((state) => state.webPreviewEnabled);
  const sideChatEnabled = useBuiltinPluginGatesStore((state) => state.sideChatEnabled);
  const contributions = useClientContributions();

  const [sideChatVisited, setSideChatVisited] = useState(false);
  const [scrollState, setScrollState] = useState({ left: false, right: false });
  const tabsRef = useRef<HTMLDivElement>(null);
  const splitGridRef = useRef<HTMLDivElement>(null);

  useSyncOnChange([activeTab], () => {
    if (activeTab === "side-chat") setSideChatVisited(true);
  });

  useSyncOnChange([sessionFile], () => {
    if (activeTab !== "side-chat") setSideChatVisited(false);
  });

  const updateScrollEdges = useCallback(() => {
    const el = tabsRef.current;
    if (!el) return;
    const left = el.scrollLeft > 2;
    const right = el.scrollLeft + el.clientWidth < el.scrollWidth - 2;
    setScrollState((prev) => (prev.left === left && prev.right === right ? prev : { left, right }));
  }, []);

  useEffect(() => {
    if (!rightOpen) return;
    const el = tabsRef.current;
    if (!el) return;
    const frame = window.requestAnimationFrame(() => {
      el.querySelector<HTMLElement>('[role="tab"][aria-selected="true"]')?.scrollIntoView({
        block: "nearest",
        inline: "nearest",
      });
      updateScrollEdges();
    });
    const observer = typeof ResizeObserver !== "undefined" ? new ResizeObserver(() => updateScrollEdges()) : null;
    observer?.observe(el);
    return () => {
      window.cancelAnimationFrame(frame);
      observer?.disconnect();
    };
  }, [activeTab, contributions.rightWorkbenchTabs.length, openFilesCount, rightMaximized, rightOpen, updateScrollEdges, width]);

  const handleTabsWheel = useCallback((event: ReactWheelEvent<HTMLDivElement>) => {
    const el = tabsRef.current;
    if (!el || el.scrollWidth <= el.clientWidth) return;
    if (Math.abs(event.deltaY) > Math.abs(event.deltaX)) {
      el.scrollLeft += event.deltaY;
      updateScrollEdges();
    }
  }, [updateScrollEdges]);

  const handleSplitterPointerDown = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    const gridEl = splitGridRef.current;
    if (!gridEl) return;
    event.preventDefault();
    const rect = gridEl.getBoundingClientRect();
    document.body.classList.add("workspace-is-resizing");

    const onMove = (moveEvent: PointerEvent) => {
      const next = splitDirection === "horizontal"
        ? (rect.width > 0 ? (moveEvent.clientX - rect.left) / rect.width : 0.5)
        : (rect.height > 0 ? (moveEvent.clientY - rect.top) / rect.height : 0.5);
      setSplitRatio(next);
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
  }, [setSplitRatio, splitDirection]);

  const effectiveSecondaryTab = useMemo(() => {
    const conflict = secondaryTab === activeTab
      || (isCodePaneTab(secondaryTab) && isCodePaneTab(activeTab))
      || (secondaryTab === "review" && !codeReviewEnabled)
      || (secondaryTab === "preview" && !webPreviewEnabled)
      || (secondaryTab === "side-chat" && (!sideChatEnabled || activeTab === "side-chat"));
    return conflict ? pickSecondaryTab(activeTab) : secondaryTab;
  }, [activeTab, codeReviewEnabled, secondaryTab, sideChatEnabled, webPreviewEnabled]);

  if (!rightOpen) return null;

  const reviewCount = git?.files.length ?? 0;
  const isCodeActive = isCodePaneTab(activeTab);
  const mountSideChat = sideChatVisited || activeTab === "side-chat";
  const tabsClassName = [
    "pid-wb-tabs",
    "pid-wb-capsule-track",
    scrollState.left ? "has-overflow-left" : "",
    scrollState.right ? "has-overflow-right" : "",
  ].filter(Boolean).join(" ");

  const primaryTabs: Array<{
    id: string;
    dataTab: string;
    label: string;
    icon: ReactNode;
    title: string;
    active: boolean;
    count?: number;
  }> = [
    { id: "summary", dataTab: "summary", label: "概览", icon: <Activity size={13} />, title: "任务进度、工作目录与上下文探针", active: activeTab === "summary" },
    { id: "files", dataTab: "files", label: "代码", icon: <FileCode2 size={13} />, title: "工作区文件树与代码编辑器", active: isCodeActive, count: openFilesCount },
    ...(codeReviewEnabled ? [{ id: "review", dataTab: "review", label: "审查", icon: <GitCompare size={13} />, title: "代码变更与行内审查", active: activeTab === "review", count: reviewCount }] : []),
    ...(webPreviewEnabled ? [{ id: "preview", dataTab: "preview", label: "预览", icon: <Globe size={13} />, title: "Web 与浏览器预览 (Ctrl+T)", active: activeTab === "preview" }] : []),
    ...(sideChatEnabled ? [{ id: "side-chat", dataTab: "side-chat", label: "侧问", icon: <MessageSquare size={13} />, title: "基于当前会话分叉的独立侧边对话", active: activeTab === "side-chat" }] : []),
    ...contributions.rightWorkbenchTabs.map((tab) => ({ id: tab.id, dataTab: tab.id, label: tab.label, icon: tab.icon, title: tab.label, active: activeTab === tab.id })),
  ];

  const secondaryOptions = [
    { id: "summary", label: "概览" },
    { id: "editor", label: "代码" },
    ...(codeReviewEnabled ? [{ id: "review", label: "审查" }] : []),
    ...(webPreviewEnabled ? [{ id: "preview", label: "预览" }] : []),
    ...(sideChatEnabled && activeTab !== "side-chat" ? [{ id: "side-chat", label: "侧问" }] : []),
    ...contributions.rightWorkbenchTabs.map((tab) => ({ id: tab.id, label: tab.label })),
  ].filter((opt) => opt.id !== activeTab && !(isCodePaneTab(opt.id) && isCodeActive));

  const gridStyle = splitOpen
    ? (splitDirection === "horizontal"
      ? { gridTemplateColumns: `minmax(0, ${splitRatio}fr) 5px minmax(0, ${1 - splitRatio}fr)` }
      : { gridTemplateRows: `minmax(0, ${splitRatio}fr) 5px minmax(0, ${1 - splitRatio}fr)` })
    : undefined;

  const paneProps = {
    cwd, sessionFile, git, codeReviewEnabled, webPreviewEnabled, sideChatEnabled,
    pluginTabs: contributions.rightWorkbenchTabs, onRefreshGit, onRestoreFiles, onRequestReview, onAddToChat,
  };

  return (
    <>
      {!rightMaximized && (
        <div
          className="pid-right-resizer"
          role="separator"
          aria-orientation="vertical"
          aria-label="调整右侧工作台宽度"
          aria-valuemin={Math.round(resize.min)}
          aria-valuemax={Math.round(resize.max)}
          aria-valuenow={Math.round(width)}
          tabIndex={0}
          onPointerDown={resize.onPointerDown}
          onKeyDown={resize.onKeyDown}
        />
      )}
      <aside
        className={`pid-right-workbench${rightMaximized ? " maximized" : ""}${splitOpen ? " is-split" : ""}`}
        data-rightbar-col=""
        style={rightMaximized ? undefined : { width: `${Math.round(width)}px` }}
        aria-label="右侧工作台"
      >
        <header className="pid-wb-header pid-wb-claude-header">
          <LayoutGroup id="pid-wb-header-tabs">
            <div ref={tabsRef} className={tabsClassName} role="tablist" aria-label="工作台视图" onScroll={updateScrollEdges} onWheel={handleTabsWheel}>
              {primaryTabs.map((tab) => (
                <button
                  key={tab.id}
                  type="button"
                  role="tab"
                  data-wb-tab={tab.dataTab}
                  aria-selected={tab.active}
                  className={`pid-wb-tab-btn${tab.active ? " active" : ""}`}
                  title={tab.title}
                  onClick={() => {
                    if (tab.id === "files") {
                      const layout = useWorkbenchLayoutStore.getState();
                      if (isCodeActive && openFilesCount > 0 && (layout.fileDrawerOpen || activeTab === "files")) {
                        layout.setFileDrawerOpen(false);
                        openTab("editor");
                        return;
                      }
                      layout.setFileDrawerOpen(true);
                    }
                    openTab(tab.id);
                  }}
                >
                  {tab.active && <motion.span layoutId="pid-wb-active-pill" className="pid-wb-tab-pill" transition={{ type: "spring", stiffness: 520, damping: 38 }} />}
                  {tab.icon}
                  <span>{tab.label}</span>
                  {typeof tab.count === "number" && tab.count > 0 && <em className="pid-wb-tab-count">{tab.count}</em>}
                </button>
              ))}
            </div>
          </LayoutGroup>

          <div className="pid-wb-window-btns">
            <button
              type="button"
              className={`pid-wb-icon-btn${splitOpen ? " active" : ""}`}
              title={splitOpen ? "关闭分屏" : "分屏并排查看"}
              aria-label={splitOpen ? "关闭分屏" : "分屏并排查看"}
              aria-pressed={splitOpen}
              onClick={() => toggleSplit(activeTab, width, rightMaximized)}
            >
              {splitOpen && splitDirection === "vertical" ? <Rows2 size={13} /> : <Columns2 size={13} />}
            </button>
            <button
              type="button"
              className="pid-wb-icon-btn"
              title={rightMaximized ? "还原宽度" : "最大化工作台"}
              onClick={toggleRightMaximized}
            >
              {rightMaximized ? <Minimize2 size={13} /> : <Maximize2 size={13} />}
            </button>
            <button
              type="button"
              className="pid-wb-icon-btn"
              title="隐藏工作台 (Ctrl+Alt+B)"
              onClick={() => setRightOpen(false)}
            >
              <X size={14} />
            </button>
          </div>
        </header>

        <div className="pid-wb-body">
          {!splitOpen ? (
            <WorkbenchPaneBody paneTab={activeTab} mountSideChat={mountSideChat} {...paneProps} />
          ) : (
            <div ref={splitGridRef} className="pid-wb-dual-grid" data-split-dir={splitDirection} style={gridStyle}>
              <div className="pid-wb-split-pane-slot is-primary">
                <WorkbenchPaneBody paneTab={activeTab} mountSideChat={mountSideChat} {...paneProps} />
              </div>
              <div
                className="pid-wb-pane-splitter"
                role="separator"
                aria-orientation={splitDirection === "horizontal" ? "vertical" : "horizontal"}
                aria-label="调整分屏比例"
                tabIndex={0}
                onPointerDown={handleSplitterPointerDown}
                onKeyDown={(event) => {
                  if (event.key === "ArrowLeft" || event.key === "ArrowUp") {
                    event.preventDefault();
                    setSplitRatio(splitRatio - 0.05);
                  } else if (event.key === "ArrowRight" || event.key === "ArrowDown") {
                    event.preventDefault();
                    setSplitRatio(splitRatio + 0.05);
                  }
                }}
              />
              <div className="pid-wb-split-pane-slot is-secondary" aria-label="分屏副面板">
                <div className="pid-wb-secondary-header">
                  <div className="pid-wb-secondary-pills" role="tablist" aria-label="副面板视图">
                    {secondaryOptions.map((opt) => (
                      <button
                        key={opt.id}
                        type="button"
                        role="tab"
                        aria-selected={effectiveSecondaryTab === opt.id}
                        className={`pid-wb-pill${effectiveSecondaryTab === opt.id ? " active" : ""}`}
                        onClick={() => setSecondaryTab(opt.id)}
                      >
                        {opt.label}
                      </button>
                    ))}
                  </div>
                  <div className="pid-wb-subbar-actions">
                    <button
                      type="button"
                      className="pid-wb-icon-btn"
                      title={splitDirection === "horizontal" ? "切换为上下分屏" : "切换为左右分屏"}
                      onClick={() => setSplitDirection(splitDirection === "horizontal" ? "vertical" : "horizontal")}
                    >
                      {splitDirection === "horizontal" ? <Rows2 size={12} /> : <Columns2 size={12} />}
                    </button>
                    <button type="button" className="pid-wb-icon-btn" title="关闭副面板" onClick={closeSplit}>
                      <X size={12} />
                    </button>
                  </div>
                </div>
                <div className="pid-wb-secondary-body">
                  <WorkbenchPaneBody paneTab={effectiveSecondaryTab} isSecondary mountSideChat={false} {...paneProps} />
                </div>
              </div>
            </div>
          )}
        </div>
      </aside>
    </>
  );
}

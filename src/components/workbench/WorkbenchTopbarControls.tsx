import {
  FileCode2,
  GitCompare,
  Globe,
  MessageSquare,
  Puzzle,
  SquareTerminal,
} from "lucide-react";
import { DockBottomIcon, DockRightIcon } from "../common/ChromeIcons";
import { useClientContributions } from "../../lib/clientContributions";
import { useBuiltinPluginGatesStore } from "../../stores/builtinPluginGatesStore";
import {
  filterAllowedPanes,
  useWorkbenchLayoutStore,
} from "../../stores/workbenchLayoutStore";
import { useWorkbenchStore } from "../../stores/workbenchStore";

export interface WorkbenchTopbarControlsProps {
  onBeforeOpen?: () => void;
}

export function WorkbenchTopbarControls({ onBeforeOpen }: WorkbenchTopbarControlsProps) {
  const rightOpen = useWorkbenchStore((state) => state.rightOpen);
  const bottomOpen = useWorkbenchStore((state) => state.bottomOpen);
  const toggleBottom = useWorkbenchStore((state) => state.toggleBottom);

  const openPanes = useWorkbenchLayoutStore((state) => state.openPanes);
  const inspectorOpen = useWorkbenchLayoutStore((state) => state.inspectorOpen);
  const togglePane = useWorkbenchLayoutStore((state) => state.togglePane);
  const toggleInspector = useWorkbenchLayoutStore((state) => state.toggleInspector);

  const codeReviewEnabled = useBuiltinPluginGatesStore((state) => state.codeReviewEnabled);
  const webPreviewEnabled = useBuiltinPluginGatesStore((state) => state.webPreviewEnabled);
  const sideChatEnabled = useBuiltinPluginGatesStore((state) => state.sideChatEnabled);
  const contributions = useClientContributions();

  const activePanes = filterAllowedPanes(openPanes);
  const showBottomControl = bottomOpen || contributions.bottomPanelTabs.length > 0;

  const handleTogglePane = (id: string) => {
    if (!activePanes.includes(id)) onBeforeOpen?.();
    togglePane(id);
  };

  const handleToggleInspector = () => {
    if (!inspectorOpen) onBeforeOpen?.();
    toggleInspector();
  };

  const inspectorLabel = !rightOpen
    ? "切换右侧工作台 (Ctrl+Alt+B)"
    : inspectorOpen && activePanes.length === 0
      ? "隐藏工作台 (Ctrl+Alt+B)"
      : "切换环境与上下文栏 (Ctrl+Alt+B)";

  return (
    <div className="pid-wb-topbar-controls" role="toolbar" aria-label="工作区面板开关">
      {codeReviewEnabled && (
        <button
          type="button"
          data-wb-tab="review"
          className={`pid-wb-top-toggle${activePanes.includes("review") ? " active" : ""}`}
          title="代码变更 (Changes)"
          aria-label="代码变更"
          aria-pressed={activePanes.includes("review")}
          onClick={() => handleTogglePane("review")}
        >
          <GitCompare size={15} strokeWidth={1.65} />
        </button>
      )}
      {webPreviewEnabled && (
        <button
          type="button"
          data-wb-tab="preview"
          className={`pid-wb-top-toggle${activePanes.includes("preview") ? " active" : ""}`}
          title="浏览器预览 (Ctrl+T)"
          aria-label="浏览器预览"
          aria-pressed={activePanes.includes("preview")}
          onClick={() => handleTogglePane("preview")}
        >
          <Globe size={15} strokeWidth={1.65} />
        </button>
      )}
      <button
        type="button"
        data-wb-tab="files"
        className={`pid-wb-top-toggle${activePanes.includes("files") ? " active" : ""}`}
        title="工作区文件 (Files)"
        aria-label="工作区文件"
        aria-pressed={activePanes.includes("files")}
        onClick={() => handleTogglePane("files")}
      >
        <FileCode2 size={15} strokeWidth={1.65} />
      </button>
      <button
        type="button"
        data-wb-tab="terminal"
        className={`pid-wb-top-toggle${activePanes.includes("terminal") ? " active" : ""}`}
        title="集成终端 (Ctrl+J)"
        aria-label="集成终端"
        aria-pressed={activePanes.includes("terminal")}
        onClick={() => handleTogglePane("terminal")}
      >
        <SquareTerminal size={15} strokeWidth={1.65} />
      </button>
      {sideChatEnabled && (
        <button
          type="button"
          data-wb-tab="side-chat"
          className={`pid-wb-top-toggle${activePanes.includes("side-chat") ? " active" : ""}`}
          title="侧边对话"
          aria-label="侧边对话"
          aria-pressed={activePanes.includes("side-chat")}
          onClick={() => handleTogglePane("side-chat")}
        >
          <MessageSquare size={14} strokeWidth={1.65} />
        </button>
      )}
      {contributions.rightWorkbenchTabs.map((tab) => (
        <button
          key={tab.id}
          type="button"
          data-wb-tab={tab.id}
          className={`pid-wb-top-toggle${activePanes.includes(tab.id) ? " active" : ""}`}
          title={tab.label}
          aria-label={tab.label}
          aria-pressed={activePanes.includes(tab.id)}
          onClick={() => handleTogglePane(tab.id)}
        >
          {tab.icon ?? <Puzzle size={14} strokeWidth={1.65} />}
        </button>
      ))}
      {showBottomControl && (
        <button
          type="button"
          className={`pid-wb-top-toggle${bottomOpen ? " active" : ""}`}
          title="切换底部扩展面板"
          aria-label="切换底部扩展面板"
          aria-pressed={bottomOpen}
          onClick={toggleBottom}
        >
          <DockBottomIcon open={bottomOpen} size={15} />
        </button>
      )}
      <button
        type="button"
        data-wb-tab="summary"
        className={`pid-wb-top-toggle${inspectorOpen ? " active" : ""}`}
        title={inspectorLabel}
        aria-label={inspectorLabel}
        aria-pressed={inspectorOpen}
        onClick={handleToggleInspector}
      >
        <DockRightIcon open={inspectorOpen} size={15} />
      </button>
    </div>
  );
}

/**
 * `OpenMausBot`-Style Minimal `BotComputerStudioPane` (Single 40px Header!).
 *
 * Header (1 row ONLY, exact `OpenMausBot` `ComputerPanel.tsx` L1214-1255):
 * - Left: `⚙️` Settings icon button (`data-testid="computer-open-settings-btn"`)
 * - Center: Pill tab bar `[ 桌面 | 浏览器 | 终端 | 文件 ]` (`data-testid="computer-view-tabs"`)
 * - Right: `✕` Close button (`data-testid="computer-close-btn"`)
 */
import type { ReactElement } from "react";
import type { Context } from "@deepseek-ai/cordis";
import { FolderOpen, Globe, Monitor, Settings, Terminal, X } from "lucide-react";
import type { BotComputerViewTab } from "@qianji/protocol";
import { openBotModal } from "../botStore";
import { BotComputerDesktopTab } from "./BotComputerDesktopTab";
import { BotComputerFilesView } from "./BotComputerFilesView";
import { BotComputerViewport } from "./BotComputerViewport";
import { BotComputerXtermView } from "./BotComputerXtermView";
import { closeComputerStudio } from "./computerStudioStore";
import { useComputerStudio } from "./useComputerStudio";

const VIEW_TABS: ReadonlyArray<{
  readonly id: BotComputerViewTab;
  readonly label: string;
  readonly Icon: typeof Monitor;
}> = [
  { id: "desktop", label: "桌面", Icon: Monitor },
  { id: "browser", label: "浏览器", Icon: Globe },
  { id: "terminal", label: "终端", Icon: Terminal },
  { id: "files", label: "文件", Icon: FolderOpen },
];

export function BotComputerStudioPane({
  ctx,
  onClose,
  inModal = false,
}: {
  readonly ctx?: Context;
  readonly onClose?: () => void;
  readonly inModal?: boolean;
}): ReactElement {
  const studio = useComputerStudio(ctx);
  const { snapshot: snap } = studio;

  const handleClose = () => {
    if (onClose) {
      onClose();
      return;
    }
    closeComputerStudio();
  };

  const latestStep =
    snap.timeline.length > 0 ? snap.timeline[snap.timeline.length - 1] : undefined;
  const liveRunningTab =
    latestStep?.status === "running" ? latestStep.tab : undefined;

  return (
    <aside
      data-computer-panel=""
      data-testid="bot-computer-studio-pane"
      data-active-engine={snap.activeEngine}
      data-active-tab={snap.activeTab}
      className={`qj-cs-pane${inModal ? " is-modal" : ""}`}
      aria-label="千机的电脑面板"
    >
      <header className="qj-cs-minimal-header">
        <button
          type="button"
          data-testid="computer-open-settings-btn"
          className="qj-cs-header-icon-btn left"
          title="电脑环境与服务器设置"
          aria-label="电脑环境与服务器设置"
          onClick={() => openBotModal("settings", "server", { returnToCurrent: inModal })}
        >
          <Settings size={16} strokeWidth={1.8} />
        </button>

        <div
          className="qj-cs-pill-tabs"
          role="tablist"
          aria-label="千机的电脑视图"
          data-testid="computer-view-tabs"
        >
          {VIEW_TABS.map(({ id, label, Icon }) => {
            const active = snap.activeTab === id;
            const isLiveTab = liveRunningTab === id;
            return (
              <button
                key={id}
                type="button"
                role="tab"
                aria-selected={active}
                data-testid={`computer-tab-${id}`}
                className={`qj-cs-pill-tab${active ? " active" : ""}`}
                onClick={() => void studio.selectStudio({ tab: id })}
              >
                <Icon size={12.5} strokeWidth={1.85} aria-hidden="true" />
                <span>{label}</span>
                {isLiveTab && <span className="qj-cs-live-dot" aria-hidden="true" />}
              </button>
            );
          })}
        </div>

        <button
          type="button"
          data-computer-panel-close=""
          data-testid="computer-close-btn"
          className="qj-cs-header-icon-btn right"
          title="关闭电脑面板"
          aria-label="关闭电脑面板"
          onClick={handleClose}
        >
          <X size={16.5} strokeWidth={1.85} />
        </button>
      </header>

      <div className="qj-cs-body">
        {snap.activeTab === "desktop" ? (
          <BotComputerDesktopTab ctx={ctx} />
        ) : snap.activeTab === "browser" ? (
          <BotComputerViewport ctx={ctx} />
        ) : snap.activeTab === "terminal" ? (
          <BotComputerXtermView ctx={ctx} />
        ) : (
          <BotComputerFilesView ctx={ctx} />
        )}
      </div>
    </aside>
  );
}

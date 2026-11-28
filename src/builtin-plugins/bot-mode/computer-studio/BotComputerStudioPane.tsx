/**
 * Suna / Manus / Muse-grade 「千机的电脑 (Qianji's Computer)」 Studio Pane (`BotComputerStudioPane`).
 *
 * Mounts both as a resizable side-by-side split pane in `BotStage` (`studioOpen === true`)
 * and inside `modal === "live-view"` (`data-testid="bot-liveview-modal"` compatibility).
 */
import type { ReactElement } from "react";
import type { Context } from "@deepseek-ai/cordis";
import {
  Check,
  Cloud,
  Cpu,
  Eye,
  FileText,
  FolderOpen,
  Globe,
  Hand,
  Laptop,
  Monitor,
  NotebookPen,
  RefreshCw,
  Settings,
  ShieldCheck,
  Terminal,
  X,
} from "lucide-react";
import type { BotComputerEngineId, BotComputerViewTab } from "@qianji/protocol";
import { openBotModal } from "../botStore";
import { BotComputerTerminalAndFiles } from "./BotComputerTerminalAndFiles";
import { BotComputerTimelineBar } from "./BotComputerTimelineBar";
import { BotComputerViewport } from "./BotComputerViewport";
import {
  closeComputerStudio,
  COMPUTER_ENGINE_CARDS,
  setComputerScrubIndex,
} from "./computerStudioStore";
import { useComputerStudio } from "./useComputerStudio";

const VIEW_TABS: ReadonlyArray<{
  readonly id: BotComputerViewTab;
  readonly label: string;
  readonly Icon: typeof Monitor;
}> = [
  { id: "desktop", label: "桌面全景", Icon: Monitor },
  { id: "browser", label: "浏览器", Icon: Globe },
  { id: "terminal", label: "终端", Icon: Terminal },
  { id: "files", label: "文件", Icon: FolderOpen },
];

function renderEngineIcon(id: BotComputerEngineId): ReactElement {
  if (id === "local-linux") return <Cpu size={13.5} />;
  if (id === "local-win-pip") return <Monitor size={13.5} />;
  if (id === "remote-vm") return <Cloud size={13.5} />;
  return <Laptop size={13.5} />;
}

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
  const { snapshot: snap, ui } = studio;

  const handleClose = () => {
    if (onClose) {
      onClose();
      return;
    }
    closeComputerStudio();
  };

  const isTakeoverActive = snap.takeover.status === "active";
  const isTakeoverRequested = snap.takeover.status === "requested";

  const winPip = snap.localWinPip;
  const winPipModeBadge =
    winPip?.backend === "rdp-child-session" || winPip?.childSessionEnabled === true
      ? "RDP 子会话 · 独立焦点不抢鼠标"
      : `Win32 第二桌面 (${winPip?.desktopName ?? "QianjiBotDesktop"}) · 当前账号派生不抢鼠标`;

  const isRemoteEngine =
    snap.activeEngine === "remote-vm" || snap.activeEngine === "remote-pc";
  const expectedRemoteKind = snap.activeEngine === "remote-vm" ? "ssh-vm" : "companion-pc";
  const matchingRemoteNodes = snap.remoteNodes.filter((n) => n.kind === expectedRemoteKind);
  const activeRemoteNode =
    matchingRemoteNodes.find((n) => n.id === snap.activeRemoteNodeId) ??
    matchingRemoteNodes[0];

  return (
    <section
      data-testid="bot-computer-studio-pane"
      data-active-engine={snap.activeEngine}
      data-active-tab={snap.activeTab}
      className={`qj-cs-pane${inModal ? " is-modal" : ""}`}
      aria-label="千机的电脑实时工作台"
    >
      <header className="qj-cs-header">
        <div className="qj-cs-title-row">
          <div className="qj-cs-brand">
            <span className="qj-cs-brand-dot" />
            <h2 className="qj-cs-title">千机的电脑</h2>
            <span className="qj-cs-subtitle-pill">
              {isTakeoverActive
                ? "人工接管控制中"
                : isTakeoverRequested
                  ? "等待人工验证"
                  : ui.scrubIndex !== null
                    ? "时间轴回放"
                    : "实时同步"}
            </span>
          </div>

          <div className="qj-cs-title-actions">
            <button
              type="button"
              data-testid="computer-open-settings-btn"
              className="qj-cs-icon-btn"
              title="虚拟服务器与 2×2 电脑环境配置"
              aria-label="虚拟服务器设置"
              onClick={() => openBotModal("settings", "server", { returnToCurrent: inModal })}
            >
              <Settings size={14.5} />
            </button>
            <button
              type="button"
              data-testid="computer-close-btn"
              className="qj-cs-icon-btn"
              title="关闭千机的电脑面板"
              aria-label="关闭千机的电脑面板"
              onClick={handleClose}
            >
              <X size={15.5} />
            </button>
          </div>
        </div>

        <div
          className="qj-cs-engine-grid"
          role="radiogroup"
          aria-label="2×2 虚拟电脑引擎切换"
          data-testid="computer-engine-switcher"
        >
          {COMPUTER_ENGINE_CARDS.map((card) => {
            const active = snap.activeEngine === card.id;
            return (
              <button
                key={card.id}
                type="button"
                role="radio"
                aria-checked={active}
                data-testid={`computer-engine-${card.id}`}
                data-engine-id={card.id}
                className={`qj-cs-engine-btn${active ? " active" : ""}`}
                onClick={() => void studio.selectStudio({ engine: card.id })}
              >
                <span className="qj-cs-engine-icon">{renderEngineIcon(card.id)}</span>
                <span className="qj-cs-engine-copy">
                  <span className="qj-cs-engine-title">{card.title}</span>
                  <span className="qj-cs-engine-sub">{card.subtitle}</span>
                </span>
              </button>
            );
          })}
        </div>

        {snap.activeEngine === "local-win-pip" && (
          <div className="qj-cs-subtoolbar" data-testid="win-pip-quick-bar">
            <span className="qj-cs-nonhijack-badge" data-testid="win-pip-nonhijack-badge">
              <ShieldCheck size={12} />
              <span>{winPipModeBadge}</span>
            </span>
            <div className="qj-cs-quick-launches">
              <button
                type="button"
                data-testid="win-pip-launch-browser"
                className="qj-cs-pill-btn xs"
                onClick={() =>
                  void studio.runEngineAction({
                    engine: "local-win-pip",
                    action: "launch-app",
                    launchKind: "browser",
                    appOrUrl: "https://example.com",
                  })
                }
              >
                <Globe size={11.5} />
                <span>隔离浏览器</span>
              </button>
              <button
                type="button"
                data-testid="win-pip-launch-explorer"
                className="qj-cs-pill-btn xs"
                onClick={() =>
                  void studio.runEngineAction({
                    engine: "local-win-pip",
                    action: "launch-app",
                    launchKind: "app",
                    appOrUrl: "explorer.exe",
                  })
                }
              >
                <FolderOpen size={11.5} />
                <span>资源管理器</span>
              </button>
              <button
                type="button"
                data-testid="win-pip-launch-notepad"
                className="qj-cs-pill-btn xs"
                onClick={() =>
                  void studio.runEngineAction({
                    engine: "local-win-pip",
                    action: "launch-app",
                    launchKind: "app",
                    appOrUrl: "notepad.exe",
                  })
                }
              >
                <NotebookPen size={11.5} />
                <span>记事本</span>
              </button>
            </div>
          </div>
        )}

        {isRemoteEngine && activeRemoteNode !== undefined && (
          <div className="qj-cs-subtoolbar" data-testid="remote-node-lease-bar">
            <div className="qj-cs-remote-select-wrap">
              {matchingRemoteNodes.length > 1 ? (
                <select
                  aria-label="选择远程电脑节点"
                  className="qj-cs-node-select"
                  value={activeRemoteNode.id}
                  onChange={(e) =>
                    void studio.selectStudio({ activeRemoteNodeId: e.target.value })
                  }
                >
                  {matchingRemoteNodes.map((node) => (
                    <option key={node.id} value={node.id}>
                      {node.alias} ({node.host})
                    </option>
                  ))}
                </select>
              ) : (
                <span className="qj-cs-nonhijack-badge">
                  <FileText size={11.5} />
                  <span>
                    {activeRemoteNode.alias} · {activeRemoteNode.host}:{activeRemoteNode.port}
                  </span>
                </span>
              )}
              <span className="qj-cs-lease-tag qj-tabular">
                自治租约 #{activeRemoteNode.autonomyLease.lastSeq}
                {activeRemoteNode.autonomyLease.queuedOfflineEvents > 0
                  ? ` · 待回放 ${activeRemoteNode.autonomyLease.queuedOfflineEvents} 条`
                  : ""}
              </span>
            </div>
            <button
              type="button"
              data-testid="remote-sync-lease-btn"
              className="qj-cs-pill-btn xs"
              onClick={() =>
                void studio.runEngineAction({
                  engine: snap.activeEngine,
                  action: "sync-autonomy-lease",
                  remoteNodeId: activeRemoteNode.id,
                })
              }
            >
              <RefreshCw size={11.5} />
              <span>同步租约</span>
            </button>
          </div>
        )}

        <div className="qj-cs-controls-row">
          <div
            className="qj-cs-tabs"
            role="tablist"
            aria-label="电脑工作台视图切换"
            data-testid="computer-view-tabs"
          >
            {VIEW_TABS.map(({ id, label, Icon }) => {
              const active = snap.activeTab === id;
              return (
                <button
                  key={id}
                  type="button"
                  role="tab"
                  aria-selected={active}
                  data-testid={`computer-tab-${id}`}
                  className={`qj-cs-tab-btn${active ? " active" : ""}`}
                  onClick={() => void studio.selectStudio({ tab: id })}
                >
                  <Icon size={13} />
                  <span>{label}</span>
                </button>
              );
            })}
          </div>

          <div className="qj-cs-right-controls">
            <button
              type="button"
              data-testid="computer-autofollow-toggle"
              aria-pressed={snap.autoFollow}
              className={`qj-cs-pill-btn xs${snap.autoFollow ? " active-soft" : ""}`}
              onClick={() => {
                const next = !snap.autoFollow;
                if (next) setComputerScrubIndex(null);
                void studio.selectStudio({ autoFollow: next });
              }}
              title="开启后自动跟随千机当前正在执行的浏览器/终端/文件标签页"
            >
              <Eye size={12} />
              <span>自动跟随</span>
            </button>

            <button
              type="button"
              data-testid="computer-takeover-btn"
              className={`qj-cs-takeover-cta${isTakeoverActive ? " is-active" : isTakeoverRequested ? " is-requested" : ""}`}
              onClick={() =>
                void studio.triggerTakeover({
                  action: isTakeoverActive ? "release" : "start",
                  engine: snap.activeEngine,
                  tab: snap.activeTab,
                })
              }
            >
              {isTakeoverActive ? (
                <>
                  <Check size={13} strokeWidth={2.2} />
                  <span>✓ 已完成，交还千机</span>
                </>
              ) : (
                <>
                  <Hand size={13} />
                  <span>🤚 接管控制</span>
                </>
              )}
            </button>
          </div>
        </div>
      </header>

      <div className="qj-cs-body">
        {snap.activeTab === "desktop" || snap.activeTab === "browser" ? (
          <BotComputerViewport ctx={ctx} />
        ) : (
          <BotComputerTerminalAndFiles ctx={ctx} mode={snap.activeTab} />
        )}
      </div>

      <BotComputerTimelineBar />
    </section>
  );
}

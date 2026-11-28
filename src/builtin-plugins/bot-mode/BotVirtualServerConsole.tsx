/**
 * `2x2` Unified Virtual Computer & Server Console (`虚拟服务器` tab in Bot Settings).
 *
 * Coordinates Local (`本地 Linux GUI 沙盒` + `本地 Windows 多开虚拟桌面 · 当前账号派生不抢鼠标`)
 * and Remote (`远程 Linux 虚拟机 SSH` + `远程个人电脑节点 Mac mini/PC + 离线自治租约`).
 */
import type { ReactElement } from "react";
import type { Context } from "@deepseek-ai/cordis";
import { HardDrive, MonitorPlay, Server } from "lucide-react";
import { closeActiveBotModal, useBotController, useBotSnapshot, useBotUiState } from "./botStore";
import { BotVirtualServerLocalSection } from "./computer-studio/BotVirtualServerLocalSection";
import { BotVirtualServerRemoteSection } from "./computer-studio/BotVirtualServerRemoteSection";
import { COMPUTER_ENGINE_CARDS, openComputerStudio } from "./computer-studio/computerStudioStore";
import { useComputerStudio } from "./computer-studio/useComputerStudio";

export function VirtualServerConsole({ ctx }: { readonly ctx?: Context }): ReactElement {
  const ui = useBotUiState();
  const snapshot = useBotSnapshot();
  const ctrl = useBotController(ctx);
  const studio = useComputerStudio(ctx);
  const vs = snapshot.virtualServer;

  const modes = [
    {
      id: "local" as const,
      Icon: HardDrive,
      title: "本地虚拟电脑（WSL2 Linux 沙盒 + Win 多开副屏）",
      desc: "兼顾 WSL2 ext4 隔离容器与当前 Windows 账号派生的多开虚拟桌面，全程后台运行不抢鼠标",
    },
    {
      id: "remote" as const,
      Icon: Server,
      title: "远端虚拟电脑（SSH 云主机 + 个人电脑自治节点）",
      desc: "连接云服务器或闲置家用 Mac mini / PC，支持离线自治租约，合盖断网后依然持续守护推进",
    },
  ];

  return (
    <div className="qj-bset-stack" data-testid="bot-vserver-console">
      <div className="qj-bset-grid-2">
        {modes.map((m) => {
          const active = vs.mode === m.id;
          return (
            <button
              key={m.id}
              type="button"
              data-vserver-mode={m.id}
              onClick={() => void ctrl.configureServer({ mode: m.id })}
              className={`qj-bset-mode-card${active ? " active" : ""}`}
            >
              <div className="qj-bset-mode-top">
                <span className="qj-bset-mode-icon">
                  <m.Icon size={16} />
                </span>
                <span className={`qj-bset-mode-pill${active ? " active" : ""}`}>
                  {active ? "当前运行环境" : "切换至此环境"}
                </span>
              </div>
              <div className="qj-bset-mode-title">{m.title}</div>
              <div className="qj-bset-mode-desc">{m.desc}</div>
            </button>
          );
        })}
      </div>

      <div className="qj-bset-card qj-bset-card-pad" data-testid="vserver-2x2-matrix-bar">
        <div className="qj-bset-row-top">
          <div className="qj-bset-row-copy">
            <div className="qj-bset-row-title">2×2「千机的电脑」默认工作台引擎</div>
            <div className="qj-bset-row-desc">
              一键切换千机执行桌面、浏览器、持久终端与文件操作时默认挂载的虚拟电脑底座
            </div>
          </div>
          <button
            type="button"
            data-testid="vserver-open-studio-btn"
            className="qj-bset-btn primary sm"
            onClick={() => {
              closeActiveBotModal();
              openComputerStudio();
            }}
          >
            <MonitorPlay size={13} />
            <span>进入千机的电脑</span>
          </button>
        </div>

        <div className="qj-cs-settings-matrix">
          {COMPUTER_ENGINE_CARDS.map((card) => {
            const selected = studio.snapshot.activeEngine === card.id;
            return (
              <button
                key={card.id}
                type="button"
                data-testid={`vserver-matrix-${card.id}`}
                className={`qj-cs-matrix-chip${selected ? " active" : ""}`}
                onClick={() => {
                  const targetMode = card.group === "remote" ? "remote" : "local";
                  if (vs.mode !== targetMode) {
                    void ctrl.configureServer({ mode: targetMode });
                  }
                  void studio.selectStudio({ engine: card.id });
                }}
              >
                <span className="qj-cs-matrix-chip-t">{card.title}</span>
                <span className="qj-cs-matrix-chip-s">{card.subtitle}</span>
              </button>
            );
          })}
        </div>
      </div>

      {ui.serverFeedback !== null && (
        <div className="qj-bset-callout">{ui.serverFeedback}</div>
      )}

      {vs.mode === "local" ? (
        <BotVirtualServerLocalSection ctx={ctx} />
      ) : (
        <BotVirtualServerRemoteSection ctx={ctx} />
      )}
    </div>
  );
}

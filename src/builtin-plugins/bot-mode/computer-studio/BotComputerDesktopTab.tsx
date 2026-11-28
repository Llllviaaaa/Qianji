/**
 * Tab 1 — `桌面` (`BotComputerDesktopTab`), crafted 1:1 after `OpenMausBot` `ComputerPanel.tsx`.
 *
 * Layout:
 * 1. Subtle caption row: `千机的屏幕` + right status label (`本地 Linux 桌面` / `Win 独立子会话` / `远程电脑` / `● 人工控制中`)
 * 2. `16:10` rounded dark screen card (`#111214`):
 *    - Linux / Remote VNC (`vncWsUrl`): real `@novnc/novnc` `BotVncCanvas` + fullscreen workspace
 *    - Linux not provisioned: calm centered state + `[启动 Linux 桌面]`
 *    - Windows Multi-Session (`local-win-pip`): `childSessionEnabled === false` onboarding,
 *      `signOutRequired === true` re-login prompt, or ready preview + `[↗ 打开独立桌面窗口]`
 * 3. 2-Button Action Row directly below screen: `[↗ 打开完整桌面 / 🤚 接管控制]` (or `[✓ 交还千机]`) + `[☾ 休眠]`
 * 4. `运行位置` (`Runs on`) card with clean 4-segment pill control + conditional remote node row.
 */
import type { ReactElement } from "react";
import type { Context } from "@deepseek-ai/cordis";
import {
  Check,
  ExternalLink,
  Hand,
  Loader2,
  Monitor,
  Moon,
  RefreshCw,
  ShieldAlert,
} from "lucide-react";
import { openBotModal } from "../botStore";
import { BotVncCanvas } from "./BotVncCanvas";
import {
  COMPUTER_ENGINE_CARDS,
  getEngineCardMeta,
  patchComputerStudioUi,
} from "./computerStudioStore";
import { useComputerStudio } from "./useComputerStudio";

export function BotComputerDesktopTab({ ctx }: { readonly ctx?: Context }): ReactElement {
  const studio = useComputerStudio(ctx);
  const { snapshot: snap, ui } = studio;

  const engineMeta = getEngineCardMeta(snap.activeEngine);
  const isTakeoverActive = snap.takeover.status === "active";
  const isTakeoverRequested = snap.takeover.status === "requested";

  const linuxStatus = snap.localLinux;
  const winStatus = snap.localWinPip;

  const isRemoteEngine = snap.activeEngine === "remote-vm" || snap.activeEngine === "remote-pc";
  const expectedRemoteKind = snap.activeEngine === "remote-vm" ? "ssh-vm" : "companion-pc";
  const matchingRemoteNodes = snap.remoteNodes.filter((n) => n.kind === expectedRemoteKind);
  const activeRemoteNode =
    matchingRemoteNodes.find((n) => n.id === snap.activeRemoteNodeId) ?? matchingRemoteNodes[0];

  const vncWsUrl =
    snap.activeEngine === "local-linux"
      ? linuxStatus?.vncReady !== false
        ? linuxStatus?.vncWsUrl
        : undefined
      : isRemoteEngine
        ? activeRemoteNode?.vncWsUrl
        : undefined;
  const hasVncStream = typeof vncWsUrl === "string" && vncWsUrl.trim() !== "";

  const frameForEngine =
    snap.latestFrame !== undefined && snap.latestFrame.engine === snap.activeEngine && snap.latestFrame.dataBase64 !== ""
      ? `data:${snap.latestFrame.mimeType};base64,${snap.latestFrame.dataBase64}`
      : null;

  const winChildReady =
    snap.activeEngine === "local-win-pip" &&
    winStatus?.childSessionEnabled === true &&
    winStatus.signOutRequired !== true;

  const handleTakeControl = () => {
    void studio.triggerTakeover({
      action: "start",
      engine: snap.activeEngine,
      tab: "desktop",
    });
  };

  const handleHandBack = () => {
    patchComputerStudioUi({ expandedDesktop: false });
    void studio.triggerTakeover({
      action: "release",
      engine: snap.activeEngine,
      tab: "desktop",
    });
  };

  const handlePrimaryDesktopAction = () => {
    if (isTakeoverActive) {
      handleHandBack();
      return;
    }
    if (hasVncStream) {
      handleTakeControl();
      patchComputerStudioUi({ expandedDesktop: true });
      return;
    }
    if (winChildReady) {
      void studio.runEngineAction({ engine: "local-win-pip", action: "open-native-desktop" });
      handleTakeControl();
      return;
    }
    handleTakeControl();
  };

  const isProvisioningLinux = ui.busyAction === "provision-linux-gui" || ui.busyAction === "start";
  const isEnablingWin = ui.busyAction === "enable-win-child-session";
  const isOpeningNativeWin = ui.busyAction === "open-native-desktop";
  const isSleeping = ui.busyAction === "stop";

  return (
    <div className="qj-cs-desktop-scroll" data-testid="computer-desktop-tab">
      <div className="qj-cs-caption-row">
        <span className="qj-cs-caption-title">千机的屏幕</span>
        {isTakeoverActive ? (
          <span className="qj-cs-caption-live" data-testid="computer-desktop-status-label">
            <span className="qj-cs-live-dot" aria-hidden="true" />
            <span>人工控制中</span>
          </span>
        ) : (
          <span className="qj-cs-caption-meta" data-testid="computer-desktop-status-label">
            {engineMeta.statusLabel}
          </span>
        )}
      </div>

      <div
        data-testid="computer-desktop-screen-card"
        className={`qj-cs-screen-card${isTakeoverActive ? " is-in-control" : isTakeoverRequested ? " is-requested" : ""}`}
      >
        {hasVncStream && vncWsUrl !== undefined ? (
          <BotVncCanvas
            wsUrl={vncWsUrl}
            isTakeoverActive={isTakeoverActive}
            posterSrc={frameForEngine}
            expanded={ui.expandedDesktop}
            onExpandedChange={(expanded) => patchComputerStudioUi({ expandedDesktop: expanded })}
            onTakeControl={handleTakeControl}
            onHandBack={handleHandBack}
          />
        ) : snap.activeEngine === "local-linux" ? (
          linuxStatus?.guiReady === true && frameForEngine !== null ? (
            <button
              type="button"
              className="qj-cs-preview-open-btn"
              onClick={handleTakeControl}
              title="点击接管本地 Linux 桌面"
            >
              <img src={frameForEngine} alt="千机的屏幕" className="qj-cs-screen-img" />
              <span className="qj-cs-screen-corner-pill">
                <Hand size={11.5} />
                <span>接管</span>
              </span>
            </button>
          ) : (
            <div className="qj-cs-screen-empty" data-testid="computer-linux-unprovisioned">
              {isProvisioningLinux ? (
                <Loader2 size={22} className="animate-spin" />
              ) : (
                <Monitor size={22} strokeWidth={1.7} />
              )}
              <span className="qj-cs-screen-empty-title">
                {isProvisioningLinux
                  ? (linuxStatus?.provisioningStep ?? "正在启动本地 Linux 桌面…")
                  : "本地 Linux 桌面尚未启动"}
              </span>
              <button
                type="button"
                data-testid="computer-start-linux-btn"
                disabled={isProvisioningLinux}
                className="qj-cs-screen-primary-btn"
                onClick={() =>
                  void studio.runEngineAction({ engine: "local-linux", action: "provision-linux-gui" })
                }
              >
                {isProvisioningLinux ? "正在启动…" : "启动 Linux 桌面"}
              </button>
            </div>
          )
        ) : snap.activeEngine === "local-win-pip" ? (
          winStatus?.childSessionEnabled !== true ? (
            <div className="qj-cs-screen-empty" data-testid="computer-win-child-disabled">
              <Monitor size={22} strokeWidth={1.7} />
              <p className="qj-cs-screen-empty-desc">
                首次使用需管理员开启系统 Child Sessions（开启后注销并重新登录一次 Windows 即可免密直连原生 Win11 桌面）
              </p>
              <button
                type="button"
                data-testid="computer-enable-win-desktop-btn"
                disabled={isEnablingWin}
                className="qj-cs-screen-primary-btn"
                onClick={() =>
                  void studio.runEngineAction({
                    engine: "local-win-pip",
                    action: "enable-win-child-session",
                  })
                }
              >
                {isEnablingWin ? "正在开启…" : "开启 Windows 独立桌面"}
              </button>
            </div>
          ) : winStatus.signOutRequired === true ? (
            <div className="qj-cs-screen-empty" data-testid="computer-win-signout-required">
              <Monitor size={22} strokeWidth={1.7} />
              <p className="qj-cs-screen-empty-desc">
                已开启系统 Child Sessions，请注销并重新登录一次 Windows 以激活免密独立桌面
              </p>
            </div>
          ) : (
            <div className="qj-cs-win-ready-stage" data-testid="computer-win-child-ready">
              {frameForEngine !== null ? (
                <img src={frameForEngine} alt="Windows 独立子会话实时画面" className="qj-cs-screen-img" />
              ) : (
                <div className="qj-cs-win-ready-backdrop">
                  <Monitor size={22} strokeWidth={1.7} />
                  <span>
                    {winStatus.viewerOpen
                      ? "Windows 11 独立桌面窗口已打开（与当前桌面完全隔离、互不抢鼠标）"
                      : winStatus.childSessionActive
                        ? "Windows 11 独立子会话运行中（与当前桌面完全隔离、互不抢鼠标）"
                        : "Windows 11 独立子会话已就绪（与当前桌面完全隔离、互不抢鼠标）"}
                  </span>
                </div>
              )}
              <button
                type="button"
                data-testid="computer-open-native-win-btn"
                disabled={isOpeningNativeWin}
                className="qj-cs-screen-primary-btn overlay"
                onClick={() =>
                  void studio.runEngineAction({
                    engine: "local-win-pip",
                    action: "open-native-desktop",
                  })
                }
              >
                <ExternalLink size={13} />
                <span>↗ 打开独立桌面窗口</span>
              </button>
            </div>
          )
        ) : frameForEngine !== null ? (
          <img src={frameForEngine} alt="远程电脑画面" className="qj-cs-screen-img" />
        ) : (
          <div className="qj-cs-screen-empty" data-testid="computer-remote-empty">
            <Monitor size={22} strokeWidth={1.7} />
            <span className="qj-cs-screen-empty-title">
              {activeRemoteNode !== undefined
                ? `${activeRemoteNode.alias} (${activeRemoteNode.host})`
                : "尚未配置远程电脑"}
            </span>
            <button
              type="button"
              className="qj-cs-screen-secondary-btn"
              onClick={() => openBotModal("settings", "server")}
            >
              配置远程连接
            </button>
          </div>
        )}
      </div>

      {isTakeoverRequested && (
        <div className="qj-cs-inline-takeover-card" data-testid="computer-takeover-prompt">
          <div className="qj-cs-inline-takeover-copy">
            <ShieldAlert size={14} />
            <span>
              {snap.takeover.reason || "需要人工协助完成登录或验证"}
              {snap.takeover.targetUrlOrApp ? `（${snap.takeover.targetUrlOrApp}）` : ""}
            </span>
          </div>
          <button
            type="button"
            data-testid="computer-accept-takeover-btn"
            className="qj-cs-screen-primary-btn sm"
            onClick={handleTakeControl}
          >
            立即接管
          </button>
        </div>
      )}

      <div className="qj-cs-action-row" data-testid="computer-desktop-actions">
        <button
          type="button"
          data-testid="computer-takeover-btn"
          className={`qj-cs-action-btn flex-main${isTakeoverActive ? " is-active" : ""}`}
          onClick={handlePrimaryDesktopAction}
        >
          {isTakeoverActive ? (
            <>
              <Check size={14} strokeWidth={2.1} />
              <span>✓ 交还千机</span>
            </>
          ) : hasVncStream || winChildReady ? (
            <>
              <ExternalLink size={14} />
              <span>↗ 打开完整桌面</span>
            </>
          ) : (
            <>
              <Hand size={14} />
              <span>🤚 接管控制</span>
            </>
          )}
        </button>

        <button
          type="button"
          data-testid="computer-sleep-btn"
          disabled={isSleeping}
          className="qj-cs-action-btn compact"
          onClick={() => void studio.runEngineAction({ engine: snap.activeEngine, action: "stop" })}
        >
          {isSleeping ? <Loader2 size={13.5} className="animate-spin" /> : <Moon size={13.5} />}
          <span>休眠</span>
        </button>
      </div>

      <div className="qj-cs-runs-on-card" data-testid="computer-engine-switcher">
        <div className="qj-cs-runs-on-title">运行位置</div>
        <p className="qj-cs-runs-on-sub">选择千机操作软件与浏览网页的电脑环境。</p>

        <div className="qj-cs-runs-on-seg" role="radiogroup" aria-label="运行位置切换">
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
                className={`qj-cs-runs-on-seg-btn${active ? " active" : ""}`}
                onClick={() => void studio.selectStudio({ engine: card.id })}
              >
                {card.pillLabel}
              </button>
            );
          })}
        </div>

        {isRemoteEngine && (
          <div className="qj-cs-runs-on-remote-row" data-testid="remote-node-lease-bar">
            {matchingRemoteNodes.length > 0 && activeRemoteNode !== undefined ? (
              <>
                <select
                  aria-label="选择远程电脑节点"
                  className="qj-cs-node-select"
                  value={activeRemoteNode.id}
                  onChange={(e) => void studio.selectStudio({ activeRemoteNodeId: e.target.value })}
                >
                  {matchingRemoteNodes.map((node) => (
                    <option key={node.id} value={node.id}>
                      {node.alias} ({node.host})
                    </option>
                  ))}
                </select>
                <span className="qj-cs-lease-tag qj-tabular">
                  租约 #{activeRemoteNode.autonomyLease.lastSeq}
                </span>
                <button
                  type="button"
                  data-testid="remote-sync-lease-btn"
                  className="qj-cs-node-sync-btn"
                  title="同步离线自治租约"
                  onClick={() =>
                    void studio.runEngineAction({
                      engine: snap.activeEngine,
                      action: "sync-autonomy-lease",
                      remoteNodeId: activeRemoteNode.id,
                    })
                  }
                >
                  <RefreshCw size={12} />
                </button>
              </>
            ) : (
              <button
                type="button"
                className="qj-cs-runs-on-link"
                onClick={() => openBotModal("settings", "server")}
              >
                前往设置添加远程节点 →
              </button>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

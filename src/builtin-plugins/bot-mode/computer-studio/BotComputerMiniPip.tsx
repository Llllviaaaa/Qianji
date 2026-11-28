/**
 * `236×148` Live Mini PiP Monitor Card (`BotComputerMiniPip`) inside `BotCompanionPanel`.
 *
 * Displays active engine badge (`Linux 桌面` / `Win 多开副屏` / `远程 VM` / `远程电脑`),
 * live stream frame or active terminal tail, smooth AI cursor dot, amber breathing pulse
 * when `takeover.status !== "idle"`, and 1-click expand into the side-by-side Computer Studio.
 */
import type { ReactElement } from "react";
import { Hand, Maximize2, Monitor, Terminal } from "lucide-react";
import {
  getEngineCardMeta,
  openComputerStudio,
  toggleComputerStudio,
  useComputerStudioSnapshot,
  useComputerStudioUi,
} from "./computerStudioStore";

export function BotComputerMiniPip(): ReactElement {
  const snap = useComputerStudioSnapshot();
  const ui = useComputerStudioUi();

  const engineMeta = getEngineCardMeta(snap.activeEngine);
  const frame = snap.latestFrame;
  const cursor = ui.latestPointer ?? frame?.cursor;
  const takeoverStatus = snap.takeover.status;
  const isTakeoverAlert = takeoverStatus !== "idle";

  const latestStep =
    snap.timeline.length > 0 ? snap.timeline[snap.timeline.length - 1] : undefined;
  const ptySnippet =
    ui.ptyBufferByEngine[snap.activeEngine] ||
    snap.pty?.outputTail ||
    latestStep?.terminalSnippet ||
    "";

  const cursorLeftPct =
    cursor !== undefined && cursor.viewportWidth > 0
      ? Math.max(4, Math.min(96, (cursor.x / cursor.viewportWidth) * 100))
      : null;
  const cursorTopPct =
    cursor !== undefined && cursor.viewportHeight > 0
      ? Math.max(8, Math.min(92, (cursor.y / cursor.viewportHeight) * 100))
      : null;

  const statusText =
    takeoverStatus === "requested"
      ? snap.takeover.reason || "等待人工接管验证"
      : takeoverStatus === "active"
        ? "人工接管控制中"
        : latestStep?.title || frame?.title || "千机的电脑待命中";

  return (
    <div className="qj-cs-pip-wrap">
      <div
        data-testid="bot-computer-mini-pip"
        data-engine={snap.activeEngine}
        data-takeover={takeoverStatus}
        className={`qj-cs-pip-card${isTakeoverAlert ? " is-takeover-alert" : ""}${ui.studioOpen ? " is-open" : ""}`}
        role="button"
        tabIndex={0}
        aria-label={`千机的电脑实时小窗（${engineMeta.badgeLabel}）`}
        onClick={() => openComputerStudio()}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            openComputerStudio();
          }
        }}
      >
        <div className="qj-cs-pip-top">
          <span className="qj-cs-pip-engine-badge" data-testid="bot-mini-pip-engine-badge">
            <span className={`qj-cs-pip-dot${isTakeoverAlert ? " is-amber" : ""}`} />
            <span>{engineMeta.badgeLabel}</span>
          </span>

          {isTakeoverAlert ? (
            <span className="qj-cs-pip-takeover-tag">
              <Hand size={10.5} />
              <span>{takeoverStatus === "requested" ? "待接管" : "接管中"}</span>
            </span>
          ) : (
            <span className="qj-cs-pip-tab-tag">
              {snap.activeTab === "terminal" ? (
                <Terminal size={10.5} />
              ) : (
                <Monitor size={10.5} />
              )}
              <span>{snap.activeTab.toUpperCase()}</span>
            </span>
          )}
        </div>

        <div className="qj-cs-pip-screen">
          {frame !== undefined && frame.dataBase64 !== "" && snap.activeTab !== "terminal" ? (
            <img
              src={`data:${frame.mimeType};base64,${frame.dataBase64}`}
              alt={frame.title || "千机的电脑画面"}
              className="qj-cs-pip-img"
            />
          ) : ptySnippet.trim() !== "" ? (
            <pre className="qj-cs-pip-terminal" data-testid="bot-mini-pip-terminal">
              {ptySnippet.trim().slice(-220)}
            </pre>
          ) : (
            <div className="qj-cs-pip-standby">
              <Monitor size={18} strokeWidth={1.7} />
              <span>{engineMeta.subtitle}</span>
            </div>
          )}

          {cursorLeftPct !== null && cursorTopPct !== null && (
            <span
              data-testid="bot-mini-pip-cursor"
              className="qj-cs-pip-cursor"
              style={{ left: `${cursorLeftPct}%`, top: `${cursorTopPct}%` }}
            />
          )}
        </div>

        <div className="qj-cs-pip-bottom">
          <span className="qj-cs-pip-caption">{statusText}</span>
          <button
            type="button"
            data-testid="bot-mini-pip-expand-btn"
            className="qj-cs-pip-expand-btn"
            title={ui.studioOpen ? "收起分身电脑面板" : "展开分身电脑分屏"}
            aria-label={ui.studioOpen ? "收起分身电脑面板" : "展开分身电脑分屏"}
            onClick={(e) => {
              e.stopPropagation();
              toggleComputerStudio();
            }}
          >
            <Maximize2 size={11.5} strokeWidth={2} />
          </button>
        </div>
      </div>
    </div>
  );
}

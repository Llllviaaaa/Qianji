/**
 * Live Viewport, AI Virtual Cursor Overlay & Direct Canvas Takeover (`BotComputerViewport`).
 */
import {
  useRef,
  useState,
  type ClipboardEvent as ReactClipboardEvent,
  type FormEvent,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactElement,
  type WheelEvent as ReactWheelEvent,
} from "react";
import type { Context } from "@deepseek-ai/cordis";
import { Globe, Hand, Lock, Monitor, RefreshCw, ShieldAlert, X } from "lucide-react";
import { setComputerScrubIndex } from "./computerStudioStore";
import {
  buildKeyInputEvent,
  buildMouseInputEvent,
  buildPasteInputEvent,
  buildWheelInputEvent,
} from "./computerViewportInput";
import { useComputerStudio } from "./useComputerStudio";

export function BotComputerViewport({ ctx }: { readonly ctx?: Context }): ReactElement {
  const studio = useComputerStudio(ctx);
  const { snapshot: snap, ui } = studio;

  const isScrubbing = ui.scrubIndex !== null && snap.timeline[ui.scrubIndex] !== undefined;
  const scrubStep = ui.scrubIndex !== null ? snap.timeline[ui.scrubIndex] : undefined;

  const liveUrl = snap.latestFrame?.url ?? "";
  const [urlSyncKey, setUrlSyncKey] = useState(liveUrl);
  const [urlDraft, setUrlDraft] = useState(liveUrl || "https://example.com");
  if (urlSyncKey !== liveUrl && liveUrl !== "") {
    setUrlSyncKey(liveUrl);
    setUrlDraft(liveUrl);
  }

  const surfaceRef = useRef<HTMLDivElement | null>(null);
  const lastMoveTsRef = useRef<number>(0);

  const vpWidth = snap.latestFrame?.width ?? 1280;
  const vpHeight = snap.latestFrame?.height ?? 800;
  const resolutionLabel =
    snap.latestFrame !== undefined
      ? `${snap.latestFrame.width}×${snap.latestFrame.height}`
      : snap.activeEngine === "local-win-pip"
        ? (snap.localWinPip?.resolution ?? "1280×800")
        : (snap.localLinux?.resolution ?? "1280×800");

  const takeover = snap.takeover;
  const isTakeoverRequested = takeover.status === "requested";
  const isTakeoverActive = takeover.status === "active" && !isScrubbing;

  const displayImageSrc = isScrubbing
    ? scrubStep?.thumbnailBase64
      ? `data:image/png;base64,${scrubStep.thumbnailBase64}`
      : null
    : snap.latestFrame?.dataBase64
      ? `data:${snap.latestFrame.mimeType};base64,${snap.latestFrame.dataBase64}`
      : null;

  const activeCursor = isScrubbing
    ? scrubStep?.cursor
    : (ui.latestPointer ?? snap.latestFrame?.cursor);

  const cursorLeftPct =
    activeCursor !== undefined && activeCursor.viewportWidth > 0
      ? Math.max(2, Math.min(98, (activeCursor.x / activeCursor.viewportWidth) * 100))
      : null;
  const cursorTopPct =
    activeCursor !== undefined && activeCursor.viewportHeight > 0
      ? Math.max(2, Math.min(98, (activeCursor.y / activeCursor.viewportHeight) * 100))
      : null;

  const handleUrlSubmit = (e: FormEvent) => {
    e.preventDefault();
    const trimmed = urlDraft.trim();
    if (trimmed === "") return;
    setComputerScrubIndex(null);
    void studio.navigateUrl(trimmed);
  };

  const handlePointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (!isTakeoverActive) return;
    e.currentTarget.focus();
    void studio.sendInput(
      buildMouseInputEvent({
        mouseAction: "down",
        button: e.button,
        clientX: e.clientX,
        clientY: e.clientY,
        rect: e.currentTarget.getBoundingClientRect(),
        vpWidth,
        vpHeight,
        modifiers: e,
      }),
    );
  };

  const handlePointerMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (!isTakeoverActive) return;
    const now = Date.now();
    if (lastMoveTsRef.current !== 0 && now - lastMoveTsRef.current < 45) return;
    lastMoveTsRef.current = now;
    void studio.sendInput(
      buildMouseInputEvent({
        mouseAction: "move",
        clientX: e.clientX,
        clientY: e.clientY,
        rect: e.currentTarget.getBoundingClientRect(),
        vpWidth,
        vpHeight,
        modifiers: e,
      }),
    );
  };

  const handlePointerUp = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (!isTakeoverActive) return;
    void studio.sendInput(
      buildMouseInputEvent({
        mouseAction: "up",
        button: e.button,
        clientX: e.clientX,
        clientY: e.clientY,
        rect: e.currentTarget.getBoundingClientRect(),
        vpWidth,
        vpHeight,
        modifiers: e,
      }),
    );
  };

  const handleDoubleClick = (e: ReactMouseEvent<HTMLDivElement>) => {
    if (!isTakeoverActive) return;
    void studio.sendInput(
      buildMouseInputEvent({
        mouseAction: "double-click",
        button: 0,
        clientX: e.clientX,
        clientY: e.clientY,
        rect: e.currentTarget.getBoundingClientRect(),
        vpWidth,
        vpHeight,
        modifiers: e,
      }),
    );
  };

  const handleWheel = (e: ReactWheelEvent<HTMLDivElement>) => {
    if (!isTakeoverActive) return;
    const wheelEvt = buildWheelInputEvent({
      deltaX: e.deltaX,
      deltaY: e.deltaY,
      clientX: e.clientX,
      clientY: e.clientY,
      rect: e.currentTarget.getBoundingClientRect(),
      vpWidth,
      vpHeight,
      modifiers: e,
    });
    if (wheelEvt !== null) void studio.sendInput(wheelEvt);
  };

  const handleKeyDown = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    if (!isTakeoverActive) return;
    const keyEvt = buildKeyInputEvent(e);
    if (keyEvt === "allow-native-paste") return;
    e.preventDefault();
    e.stopPropagation();
    void studio.sendInput(keyEvt);
  };

  const handlePaste = (e: ReactClipboardEvent<HTMLDivElement>) => {
    if (!isTakeoverActive) return;
    const pasteEvt = buildPasteInputEvent(e.clipboardData.getData("text/plain"));
    if (pasteEvt === null) return;
    e.preventDefault();
    e.stopPropagation();
    void studio.sendInput(pasteEvt);
  };

  const winOpenWindows = snap.localWinPip?.openWindows ?? [];

  return (
    <div className="qj-cs-viewport-wrap">
      {snap.activeTab === "browser" ? (
        <form className="qj-cs-address-bar" data-testid="computer-browser-url-form" onSubmit={handleUrlSubmit}>
          <span className="qj-cs-url-icon"><Globe size={13.5} /></span>
          <input
            type="text"
            aria-label="分身浏览器地址栏"
            value={urlDraft}
            onChange={(e) => setUrlDraft(e.target.value)}
            placeholder="输入网址（隔离 Profile，Cookie 与登录态独立保存）…"
            className="qj-cs-url-input"
          />
          <button type="submit" className="qj-cs-pill-btn primary xs" disabled={ui.busyAction === "navigate"}>
            前往
          </button>
          <button
            type="button"
            className="qj-cs-icon-btn sm"
            title="刷新实时画面"
            aria-label="刷新实时画面"
            onClick={() => void studio.refreshSnapshot(true)}
          >
            <RefreshCw size={13} />
          </button>
        </form>
      ) : (
        <div className="qj-cs-window-bar" data-testid="computer-desktop-window-bar">
          <div className="qj-cs-window-chips">
            {snap.activeEngine === "local-win-pip" && winOpenWindows.length > 0 ? (
              winOpenWindows.map((win) => (
                <span key={win.hwnd} className="qj-cs-win-chip" data-testid="computer-win-chip">
                  <Monitor size={11.5} />
                  <span className="qj-cs-win-chip-title">{win.title}</span>
                  <button
                    type="button"
                    aria-label={`关闭窗口 ${win.title}`}
                    className="qj-cs-win-chip-close"
                    onClick={() =>
                      void studio.runEngineAction({ engine: "local-win-pip", action: "close-window", hwnd: win.hwnd })
                    }
                  >
                    <X size={11} />
                  </button>
                </span>
              ))
            ) : (
              <span className="qj-cs-win-chip muted">
                <Monitor size={11.5} />
                <span>
                  {snap.activeEngine === "local-linux"
                    ? `Linux X11 ${snap.localLinux?.display ?? ":99"}`
                    : snap.activeEngine === "local-win-pip"
                      ? `副屏桌面 ${snap.localWinPip?.desktopName ?? "QianjiBotDesktop"}`
                      : "远端桌面会话"}
                </span>
              </span>
            )}
          </div>
          <div className="qj-cs-window-bar-right">
            <span className="qj-cs-res-badge qj-tabular" data-testid="computer-resolution-badge">
              {resolutionLabel}
            </span>
            <button
              type="button"
              className="qj-cs-icon-btn sm"
              title="刷新桌面画面"
              aria-label="刷新桌面画面"
              onClick={() => void studio.refreshSnapshot(true)}
            >
              <RefreshCw size={13} />
            </button>
          </div>
        </div>
      )}

      <div
        ref={surfaceRef}
        data-testid="computer-interactive-surface"
        data-escape-layer={isTakeoverActive ? "takeover" : undefined}
        data-takeover-status={takeover.status}
        tabIndex={isTakeoverActive ? 0 : -1}
        role={isTakeoverActive ? "application" : "region"}
        aria-label={isTakeoverActive ? "人工接管实时交互画布（键鼠与剪贴板直连虚拟电脑）" : "千机的电脑实时监控画布"}
        className={[
          "qj-cs-stage",
          isTakeoverRequested ? "is-takeover-requested" : "",
          isTakeoverActive ? "is-takeover-active" : "",
          isScrubbing ? "is-scrubbing" : "",
        ].filter(Boolean).join(" ")}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
        onDoubleClick={handleDoubleClick}
        onContextMenu={(e) => { if (isTakeoverActive) e.preventDefault(); }}
        onWheel={handleWheel}
        onKeyDown={handleKeyDown}
        onPaste={handlePaste}
      >
        {isTakeoverActive && (
          <div className="qj-cs-takeover-active-banner" data-testid="computer-takeover-active-banner">
            <Lock size={12} />
            <span>人工接管中 · 点击画面直接键入或粘贴凭据（直连虚拟电脑，零大模型泄露）</span>
          </div>
        )}

        {isScrubbing && scrubStep !== undefined && (
          <div className="qj-cs-scrub-banner">
            <span>历史回放 · {scrubStep.title}</span>
            <button type="button" className="qj-cs-pill-btn xs" onClick={() => setComputerScrubIndex(null)}>
              返回实时
            </button>
          </div>
        )}

        {displayImageSrc !== null ? (
          <img
            src={displayImageSrc}
            alt={isScrubbing ? (scrubStep?.title ?? "历史步骤快照") : (snap.latestFrame?.title ?? "千机的电脑实时画面")}
            draggable={false}
            className="qj-cs-frame-img"
            data-testid="computer-viewport-frame"
          />
        ) : (
          <div className="qj-cs-stage-placeholder" data-testid="computer-viewport-placeholder">
            <Monitor size={28} strokeWidth={1.6} />
            <div className="qj-cs-placeholder-title">{snap.latestFrame?.title || "千机的电脑视觉画布已就绪"}</div>
            <div className="qj-cs-placeholder-sub">
              {snap.activeTab === "browser"
                ? "千机打开网页或在上方地址栏前往站点时，实时帧与虚拟光标将在此同步呈现"
                : "千机操作独立桌面窗口或启动多开应用时，不会抢占你当前正在使用的鼠标焦点"}
            </div>
          </div>
        )}

        {!isTakeoverActive && cursorLeftPct !== null && cursorTopPct !== null && activeCursor !== undefined && (
          <div
            data-testid="computer-ai-cursor"
            data-pointer-action={activeCursor.action}
            className="qj-cs-ai-cursor"
            style={{ left: `${cursorLeftPct}%`, top: `${cursorTopPct}%` }}
          >
            {(activeCursor.action === "click" || activeCursor.action === "double-click") && (
              <span key={`ripple-${ui.pointerClickSeq}`} className="qj-cs-cursor-ripple" data-testid="computer-ai-cursor-ripple" />
            )}
            <svg width="18" height="18" viewBox="0 0 20 20" fill="none" aria-hidden="true" className="qj-cs-cursor-arrow">
              <path
                d="M3.2 2.4L16.6 9.1L10.3 11.1L7.9 17.2L3.2 2.4Z"
                fill="var(--qj-brand-primary)"
                stroke="#ffffff"
                strokeWidth="1.5"
                strokeLinejoin="round"
              />
            </svg>
            <span className="qj-cs-cursor-pill">{activeCursor.label || "千机"}</span>
          </div>
        )}

        {isTakeoverRequested && (
          <div className="qj-cs-takeover-prompt" data-testid="computer-takeover-prompt">
            <div className="qj-cs-takeover-prompt-head">
              <ShieldAlert size={16} />
              <span>需要人工协助验证</span>
            </div>
            <p className="qj-cs-takeover-prompt-desc">
              {takeover.reason || "检测到登录、二次验证或人机校验页面，请临时接管画面完成后交还千机。"}
              {takeover.targetUrlOrApp ? `（${takeover.targetUrlOrApp}）` : ""}
            </p>
            <button
              type="button"
              data-testid="computer-accept-takeover-btn"
              className="qj-cs-pill-btn amber"
              onClick={() => {
                void studio.triggerTakeover({ action: "start", engine: snap.activeEngine, tab: snap.activeTab });
                surfaceRef.current?.focus();
              }}
            >
              <Hand size={13.5} />
              <span>立即在画面中接管</span>
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

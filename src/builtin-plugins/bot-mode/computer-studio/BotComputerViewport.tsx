/**
 * Tab 2 — `浏览器` (`BotComputerViewport`).
 *
 * Clean compact URL bar + `16:10` (`aspect-ratio: 16 / 10`) dark frame container (`#111214`)
 * with ZERO white letterbox bars, pixel-accurate mouse coordinates computed strictly from
 * `imgRef.current.getBoundingClientRect()`, smooth AI virtual cursor overlay, direct
 * pointer/wheel/key/paste takeover input, and compact bottom `BotComputerTimelineBar`
 * when timeline steps exist.
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
import { Check, Globe, Hand, Lock, RefreshCw, ShieldAlert } from "lucide-react";
import { BotComputerTimelineBar } from "./BotComputerTimelineBar";
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
  const imgRef = useRef<HTMLImageElement | null>(null);
  const lastMoveTsRef = useRef<number>(0);

  const vpWidth = snap.latestFrame?.width ?? 1280;
  const vpHeight = snap.latestFrame?.height ?? 800;

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

  const getImgRect = () => imgRef.current?.getBoundingClientRect() ?? null;

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
        imgRect: getImgRect(),
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
        imgRect: getImgRect(),
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
        imgRect: getImgRect(),
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
        imgRect: getImgRect(),
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
      imgRect: getImgRect(),
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

  return (
    <div className="qj-cs-browser-wrap" data-testid="computer-browser-tab">
      <div className="qj-cs-browser-main">
        <form className="qj-cs-address-bar" data-testid="computer-browser-url-form" onSubmit={handleUrlSubmit}>
          <span className="qj-cs-url-icon"><Globe size={13.5} /></span>
          <input
            type="text"
            aria-label="分身浏览器地址栏"
            value={urlDraft}
            onChange={(e) => setUrlDraft(e.target.value)}
            placeholder="输入网址前往…"
            className="qj-cs-url-input"
          />
          <button
            type="button"
            data-testid="computer-takeover-btn"
            className={`qj-cs-browser-takeover-btn${isTakeoverActive ? " is-active" : isTakeoverRequested ? " is-requested" : ""}`}
            onClick={() => {
              const nextAction = isTakeoverActive ? "release" : "start";
              void studio.triggerTakeover({ action: nextAction, engine: snap.activeEngine, tab: "browser" });
              if (nextAction === "start") surfaceRef.current?.focus();
            }}
          >
            {isTakeoverActive ? (
              <>
                <Check size={12} strokeWidth={2.2} />
                <span>✓ 交还千机</span>
              </>
            ) : (
              <>
                <Hand size={12} />
                <span>🤚 接管登录</span>
              </>
            )}
          </button>
          <button
            type="button"
            className="qj-cs-icon-btn sm"
            title="刷新页面画面"
            aria-label="刷新页面画面"
            onClick={() => void studio.refreshSnapshot(true)}
          >
            <RefreshCw size={13} />
          </button>
        </form>

        <div
          ref={surfaceRef}
          data-testid="computer-interactive-surface"
          data-escape-layer={isTakeoverActive ? "takeover" : undefined}
          data-takeover-status={takeover.status}
          tabIndex={isTakeoverActive ? 0 : -1}
          role={isTakeoverActive ? "application" : "region"}
          aria-label={isTakeoverActive ? "人工接管浏览器画布" : "千机的浏览器实时画面"}
          className={[
            "qj-cs-browser-stage",
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
              <Lock size={11.5} />
              <span>正在接管登录 · 直接点击画面输入或粘贴</span>
            </div>
          )}

          {isScrubbing && scrubStep !== undefined && (
            <div className="qj-cs-scrub-banner">
              <span>历史回放 · {scrubStep.title}</span>
              <button type="button" className="qj-cs-scrub-return-btn" onClick={() => setComputerScrubIndex(null)}>
                返回实时
              </button>
            </div>
          )}

          {displayImageSrc !== null ? (
            <img
              ref={imgRef}
              src={displayImageSrc}
              alt={isScrubbing ? (scrubStep?.title ?? "历史快照") : (snap.latestFrame?.title ?? "千机浏览器画面")}
              draggable={false}
              className="qj-cs-browser-frame-img"
              data-testid="computer-viewport-frame"
            />
          ) : (
            <div className="qj-cs-screen-empty" data-testid="computer-viewport-placeholder">
              <Globe size={22} strokeWidth={1.7} />
              <span className="qj-cs-screen-empty-title">
                {snap.latestFrame?.title || "浏览器就绪"}
              </span>
              <span className="qj-cs-screen-empty-desc">
                千机浏览网页或在上方地址栏输入网址时，16:10 实时页面与光标在此同步显示。
              </span>
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
                <ShieldAlert size={15} />
                <span>需要人工协助登录</span>
              </div>
              <p className="qj-cs-takeover-prompt-desc">
                {takeover.reason || "检测到登录或人机验证页面，请临时接管完成后交还千机。"}
                {takeover.targetUrlOrApp ? `（${takeover.targetUrlOrApp}）` : ""}
              </p>
              <button
                type="button"
                data-testid="computer-accept-takeover-btn"
                className="qj-cs-screen-primary-btn"
                onClick={() => {
                  void studio.triggerTakeover({ action: "start", engine: snap.activeEngine, tab: "browser" });
                  surfaceRef.current?.focus();
                }}
              >
                <Hand size={13} />
                <span>立即在画面中接管</span>
              </button>
            </div>
          )}
        </div>
      </div>

      {snap.timeline.length > 0 && <BotComputerTimelineBar />}
    </div>
  );
}

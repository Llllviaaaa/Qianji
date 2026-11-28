// eslint-disable-next-line @typescript-eslint/triple-slash-reference
/// <reference path="./novnc.d.ts" />
/**
 * Real `@novnc/novnc` RFB canvas (`BotVncCanvas`), ported from `OpenMausBot` `LiveDesktop.tsx`.
 *
 * Supports scaled `16:10` embedded desktop streaming (`viewOnly = !isTakeoverActive`),
 * `Ctrl+V`/`Cmd+V` clipboard forwarding, Unicode `typeOnDesktop`, and expandable
 * `fixed inset-0 z-50` full-window workspace (`[千机的桌面 · 正在控制 · 文本发送框 · 退出全屏 · ✓ 交还千机]`).
 */
import { useEffect, useRef, useState, type ReactElement } from "react";
import { Check, Hand, Loader2, Maximize2, Minimize2, RefreshCw, Send } from "lucide-react";
import type RFB from "@novnc/novnc";
import { openDesktopRfb, typeOnDesktop } from "./vncConnection";

type VncConnectionState = "connecting" | "connected" | "disconnected";

function canMountDomRfb(): boolean {
  if (typeof window === "undefined" || typeof WebSocket === "undefined") return false;
  if (typeof navigator !== "undefined" && /jsdom/i.test(navigator.userAgent)) return false;
  return true;
}

export function BotVncCanvas(props: {
  readonly wsUrl: string;
  readonly isTakeoverActive: boolean;
  readonly posterSrc: string | null;
  readonly expanded: boolean;
  readonly onExpandedChange: (expanded: boolean) => void;
  readonly onTakeControl: () => void;
  readonly onHandBack: () => void;
  readonly handingBack?: boolean;
}): ReactElement {
  const {
    wsUrl,
    isTakeoverActive,
    posterSrc,
    expanded,
    onExpandedChange,
    onTakeControl,
    onHandBack,
    handingBack = false,
  } = props;

  const screenRef = useRef<HTMLDivElement | null>(null);
  const rfbRef = useRef<RFB | null>(null);
  const liveOnceRef = useRef(false);
  const viewOnlyInitRef = useRef(!isTakeoverActive);
  const [attempt, setAttempt] = useState(0);
  const [textDraft, setTextDraft] = useState("");
  const connKey = `${wsUrl}:${attempt}`;
  const [connRecord, setConnRecord] = useState<{
    readonly key: string;
    readonly state: "connected" | "disconnected";
  } | null>(null);

  const connection: VncConnectionState =
    connRecord !== null && connRecord.key === connKey ? connRecord.state : "connecting";

  useEffect(() => {
    viewOnlyInitRef.current = !isTakeoverActive;
    if (rfbRef.current !== null) {
      rfbRef.current.viewOnly = !isTakeoverActive;
      if (isTakeoverActive) {
        rfbRef.current.focus({ preventScroll: true });
      }
    }
  }, [isTakeoverActive]);

  useEffect(() => {
    const container = screenRef.current;
    if (container === null || !canMountDomRfb()) return undefined;

    const controller = new AbortController();
    let activeClient: RFB | undefined;
    let retryTimer: ReturnType<typeof setTimeout> | undefined;

    const markDisconnected = () => {
      if (controller.signal.aborted) return;
      setConnRecord({ key: connKey, state: "disconnected" });
      if (liveOnceRef.current && attempt === 0) {
        retryTimer = setTimeout(() => setAttempt(1), 1_000);
      }
    };

    void openDesktopRfb(container, wsUrl, {
      viewOnly: viewOnlyInitRef.current,
      signal: controller.signal,
      events: {
        connected: () => {
          liveOnceRef.current = true;
          setConnRecord({ key: connKey, state: "connected" });
        },
        disconnected: markDisconnected,
      },
    }).then(
      (connected) => {
        if (controller.signal.aborted) {
          connected.disconnect();
          return;
        }
        connected.viewOnly = viewOnlyInitRef.current;
        activeClient = connected;
        rfbRef.current = connected;
      },
      () => {
        markDisconnected();
      },
    );

    return () => {
      controller.abort();
      if (retryTimer !== undefined) clearTimeout(retryTimer);
      activeClient?.disconnect();
      if (rfbRef.current === activeClient) rfbRef.current = null;
    };
  }, [attempt, connKey, wsUrl]);

  useEffect(() => {
    if (connection === "connected" && isTakeoverActive) {
      rfbRef.current?.focus({ preventScroll: true });
    }
  }, [connection, expanded, isTakeoverActive]);

  return (
    <div
      data-live-desktop=""
      data-testid="computer-vnc-canvas"
      data-vnc-url={wsUrl}
      data-state={connection}
      data-view-only={isTakeoverActive ? "false" : "true"}
      data-expanded={expanded ? "true" : undefined}
      className={expanded ? "qj-cs-vnc-expanded" : "qj-cs-vnc-inline"}
      onKeyDown={(event) => {
        if (expanded && event.key === "Escape" && !(event.target instanceof HTMLCanvasElement)) {
          onExpandedChange(false);
        }
      }}
    >
      {expanded && (
        <header className="qj-cs-vnc-expanded-header" data-testid="computer-vnc-expanded-header">
          <span className="qj-cs-vnc-expanded-title">千机的桌面</span>
          {isTakeoverActive ? (
            <span className="qj-cs-vnc-status-pill">
              <span className="qj-cs-live-dot" aria-hidden="true" />
              <span>正在控制</span>
            </span>
          ) : (
            <button type="button" className="qj-cs-vnc-bar-btn" onClick={onTakeControl}>
              <Hand size={13} />
              <span>接管控制</span>
            </button>
          )}

          <form
            className="qj-cs-vnc-type-form"
            onSubmit={(event) => {
              event.preventDefault();
              if (rfbRef.current === null || connection !== "connected" || textDraft === "") return;
              if (!isTakeoverActive) onTakeControl();
              rfbRef.current.viewOnly = false;
              typeOnDesktop(rfbRef.current, textDraft);
              setTextDraft("");
            }}
          >
            <input
              type="text"
              value={textDraft}
              onChange={(event) => setTextDraft(event.target.value)}
              maxLength={4096}
              autoComplete="off"
              spellCheck={false}
              placeholder="发送文本到桌面…"
              aria-label="发送文本到桌面"
              className="qj-cs-vnc-type-input"
            />
            <button
              type="submit"
              disabled={connection !== "connected" || textDraft === ""}
              title="发送文本"
              aria-label="发送文本"
              className="qj-cs-vnc-bar-btn"
            >
              <Send size={13} />
            </button>
          </form>

          <button
            type="button"
            data-testid="computer-vnc-exit-fullscreen-btn"
            className="qj-cs-vnc-bar-btn"
            onClick={() => onExpandedChange(false)}
          >
            <Minimize2 size={13.5} />
            <span>退出全屏</span>
          </button>

          <button
            type="button"
            data-testid="computer-vnc-handback-btn"
            disabled={handingBack}
            className="qj-cs-vnc-bar-btn primary"
            onClick={onHandBack}
          >
            {handingBack ? <Loader2 size={13.5} className="animate-spin" /> : <Check size={13.5} />}
            <span>✓ 交还千机</span>
          </button>
        </header>
      )}

      <div className="qj-cs-vnc-stage">
        {posterSrc !== null && connection !== "connected" && (
          <img src={posterSrc} alt="" aria-hidden="true" className="qj-cs-vnc-poster" />
        )}
        <div
          ref={screenRef}
          role="application"
          aria-label="千机的桌面"
          data-testid="computer-vnc-screen"
          className="qj-cs-vnc-mount"
        />

        {!expanded && (
          <button
            type="button"
            data-testid="computer-vnc-expand-btn"
            title="全屏打开完整桌面"
            aria-label="全屏打开完整桌面"
            className="qj-cs-screen-corner-pill"
            onClick={() => {
              if (!isTakeoverActive) onTakeControl();
              onExpandedChange(true);
            }}
          >
            <Maximize2 size={11.5} />
            <span>全屏</span>
          </button>
        )}

        {connection === "connecting" && (
          <div role="status" className="qj-cs-vnc-overlay">
            <Loader2 size={16} className="animate-spin" />
            <span>正在连接桌面画面…</span>
          </div>
        )}

        {connection === "disconnected" && (
          <div role="alert" className="qj-cs-vnc-disconnected">
            <span>桌面实时连接已中断</span>
            <button
              type="button"
              className="qj-cs-vnc-bar-btn"
              onClick={() => setAttempt((prev) => prev + 1)}
            >
              <RefreshCw size={12.5} />
              <span>重新连接</span>
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

/**
 * Tab 3 — `终端` (`BotComputerXtermView`).
 *
 * Dynamically imports and mounts REAL `@xterm/xterm` + `@xterm/addon-fit` +
 * `@xterm/addon-web-links` (following `CoreTerminalPane.tsx`), wired directly to
 * `bot.computer.pty.open/write/resize` and `"bot/computer"` `{ kind: "pty" }` chunks,
 * while degrading gracefully in SSR / headless jsdom Vitest environments.
 */
import { useEffect, useRef, useState, type FormEvent, type ReactElement } from "react";
import type { Context } from "@deepseek-ai/cordis";
import { Eraser, RotateCcw, Send, Terminal as TerminalIcon } from "lucide-react";
import type { BotComputerEngineId } from "@qianji/protocol";
import { computerStudioUiStore } from "./computerStudioStore";
import { useComputerStudio } from "./useComputerStudio";

export interface XtermLikeInstance {
  readonly cols: number;
  readonly rows: number;
  write(data: string): void;
  clear(): void;
  dispose(): void;
  onData(listener: (data: string) => void): { dispose(): void };
}

export interface FitAddonLike {
  fit(): void;
}

export function canMountRealXterm(): boolean {
  if (typeof window === "undefined" || typeof document === "undefined") return false;
  if (typeof navigator !== "undefined" && /jsdom/i.test(navigator.userAgent)) return false;
  return true;
}

/**
 * Connects an initialized `xterm.js` instance + `FitAddon` to the reactive PTY buffer
 * store and `bot.computer.pty.{open,write,resize}` callbacks.
 */
export function attachPtyXtermSession(options: {
  readonly container: HTMLElement;
  readonly engine: BotComputerEngineId;
  readonly term: XtermLikeInstance;
  readonly fitAddon: FitAddonLike;
  readonly openPty: (cwd?: string, cols?: number, rows?: number) => Promise<unknown>;
  readonly writePty: (data: string) => Promise<unknown>;
  readonly resizePty: (cols: number, rows: number) => Promise<unknown>;
}): () => void {
  const { container, engine, term, fitAddon, openPty, writePty, resizePty } = options;

  try {
    fitAddon.fit();
  } catch {
    // Container may have zero size before layout settles.
  }

  let writtenOffset = 0;
  const initialBuf = computerStudioUiStore.get().ptyBufferByEngine[engine] ?? "";
  if (initialBuf !== "") {
    term.write(initialBuf);
    writtenOffset = initialBuf.length;
  }

  const unsubscribeStore = computerStudioUiStore.subscribe(() => {
    const nextBuf = computerStudioUiStore.get().ptyBufferByEngine[engine] ?? "";
    if (nextBuf.length < writtenOffset) {
      if (nextBuf === "") {
        term.clear();
        writtenOffset = 0;
      } else {
        term.clear();
        term.write(nextBuf);
        writtenOffset = nextBuf.length;
      }
      return;
    }
    if (nextBuf.length > writtenOffset) {
      const delta = nextBuf.slice(writtenOffset);
      writtenOffset = nextBuf.length;
      term.write(delta);
    }
  });

  const dataSub = term.onData((data) => {
    void writePty(data);
  });

  void openPty(undefined, Math.max(20, term.cols || 80), Math.max(6, term.rows || 24));

  const resizeObserver =
    typeof ResizeObserver !== "undefined"
      ? new ResizeObserver(() => {
          if (container.clientWidth === 0 || container.clientHeight === 0) return;
          try {
            fitAddon.fit();
            void resizePty(Math.max(20, term.cols || 80), Math.max(6, term.rows || 24));
          } catch {
            // Ignore transient layout error.
          }
        })
      : null;
  resizeObserver?.observe(container);

  return () => {
    resizeObserver?.disconnect();
    unsubscribeStore();
    dataSub.dispose();
    term.dispose();
  };
}

export function BotComputerXtermView({ ctx }: { readonly ctx?: Context }): ReactElement {
  const studio = useComputerStudio(ctx);
  const { snapshot: snap, ui, openPty, writePty, resizePty, clearPtyLocal } = studio;

  const hostRef = useRef<HTMLDivElement | null>(null);
  const termRef = useRef<XtermLikeInstance | null>(null);
  const activeEngine = snap.activeEngine;
  const [mountedEngine, setMountedEngine] = useState<BotComputerEngineId | null>(null);
  const [fallbackInput, setFallbackInput] = useState("");

  const xtermReady = mountedEngine === activeEngine;
  const hasPtyForEngine = snap.pty?.engine === activeEngine && snap.pty.alive;
  const cwdLabel = snap.pty?.engine === activeEngine ? snap.pty.cwd : "/workspace";

  useEffect(() => {
    const container = hostRef.current;
    if (container === null || !canMountRealXterm()) {
      if (!hasPtyForEngine) void openPty();
      return undefined;
    }

    let disposed = false;
    let cleanupSession: (() => void) | undefined;

    void Promise.all([
      import("@xterm/xterm"),
      import("@xterm/addon-fit"),
      import("@xterm/addon-web-links"),
      import("@xterm/xterm/css/xterm.css").catch(() => undefined),
    ])
      .then(([{ Terminal }, { FitAddon }, { WebLinksAddon }]) => {
        if (disposed || hostRef.current === null) return;
        const term = new Terminal({
          cursorBlink: true,
          convertEol: true,
          fontSize: 12.5,
          lineHeight: 1.36,
          fontFamily: '"JetBrains Mono Variable", ui-monospace, Consolas, monospace',
          scrollback: 5000,
          theme: {
            background: "#111214",
            foreground: "#e5e7eb",
            cursor: "#60a5fa",
            selectionBackground: "rgba(96, 165, 250, 0.28)",
          },
        });
        const fitAddon = new FitAddon();
        term.loadAddon(fitAddon);
        term.loadAddon(new WebLinksAddon());
        term.open(hostRef.current);
        termRef.current = term;
        setMountedEngine(activeEngine);

        cleanupSession = attachPtyXtermSession({
          container: hostRef.current,
          engine: activeEngine,
          term,
          fitAddon,
          openPty,
          writePty,
          resizePty,
        });
      })
      .catch(() => {
        if (!disposed) void openPty();
      });

    return () => {
      disposed = true;
      termRef.current = null;
      cleanupSession?.();
    };
  }, [activeEngine, hasPtyForEngine, openPty, resizePty, writePty]);

  const scrubStep = ui.scrubIndex !== null ? snap.timeline[ui.scrubIndex] : undefined;
  const liveBuffer = ui.ptyBufferByEngine[activeEngine] || snap.pty?.outputTail || "";
  const fallbackText =
    scrubStep?.terminalSnippet ??
    (liveBuffer !== "" ? liveBuffer : `$ cd ${cwdLabel}\n`);

  const handleFallbackSubmit = (e: FormEvent) => {
    e.preventDefault();
    const raw = fallbackInput.trim();
    if (raw === "") return;
    setFallbackInput("");
    void writePty(`${raw}\n`);
  };

  return (
    <div className="qj-cs-term-wrap" data-testid="computer-terminal-view">
      <div className="qj-cs-term-head">
        <div className="qj-cs-term-meta">
          <TerminalIcon size={13} />
          <span className="qj-cs-term-cwd" data-testid="computer-pty-cwd">
            {cwdLabel}
          </span>
          <span className={`qj-cs-pty-badge${hasPtyForEngine ? " is-alive" : ""}`}>
            {hasPtyForEngine ? "在线" : "连接中"}
          </span>
        </div>
        <div className="qj-cs-term-actions">
          <button
            type="button"
            data-testid="computer-pty-clear-btn"
            className="qj-cs-icon-btn sm"
            title="清屏"
            aria-label="清屏"
            onClick={() => {
              clearPtyLocal(activeEngine);
              termRef.current?.clear();
            }}
          >
            <Eraser size={13} />
          </button>
          <button
            type="button"
            data-testid="computer-pty-reconnect-btn"
            className="qj-cs-icon-btn sm"
            title="重连终端"
            aria-label="重连终端"
            onClick={() =>
              void openPty(
                cwdLabel,
                termRef.current?.cols ?? 100,
                termRef.current?.rows ?? 28,
              )
            }
          >
            <RotateCcw size={13} />
          </button>
        </div>
      </div>

      <div className="qj-cs-xterm-card">
        <div
          ref={hostRef}
          data-testid="computer-xterm-host"
          data-xterm-mounted={xtermReady ? "true" : "false"}
          className="qj-cs-xterm-mount"
          hidden={!xtermReady}
        />
        {!xtermReady && (
          <pre className="qj-cs-pty-fallback" data-testid="computer-pty-output">
            {fallbackText}
          </pre>
        )}
      </div>

      {!xtermReady && (
        <form className="qj-cs-pty-form" data-testid="computer-pty-form" onSubmit={handleFallbackSubmit}>
          <span className="qj-cs-pty-prompt">{activeEngine === "local-win-pip" ? "PS>" : "$"}</span>
          <input
            type="text"
            aria-label="分身终端命令输入"
            value={fallbackInput}
            onChange={(e) => setFallbackInput(e.target.value)}
            placeholder="输入命令执行…"
            className="qj-cs-pty-input"
          />
          <button
            type="submit"
            data-testid="computer-pty-send-btn"
            className="qj-cs-icon-btn sm"
            disabled={fallbackInput.trim() === ""}
            title="运行命令"
            aria-label="运行命令"
          >
            <Send size={13} />
          </button>
        </form>
      )}
    </div>
  );
}

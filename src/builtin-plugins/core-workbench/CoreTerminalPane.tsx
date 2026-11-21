/**
 * Built-in `"terminal"` workbench pane & bottom terminal tab (`CoreTerminalPane`, ADR 0023).
 *
 * Uses xterm.js (`@xterm/xterm`) + Tauri PTY commands when running inside the
 * desktop shell, and degrades cleanly in browser/SSR/headless test environments.
 */
import { useCallback, useEffect, useRef, useState, type ReactElement } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { Plus, TerminalSquare, X } from "lucide-react";
import { useWorkbenchState, useWorkspaceState } from "@qianji/client";
import type {
  SlotComponentProps,
  WorkbenchBottomTabSlotProps,
  WorkbenchPaneSlotProps,
} from "@qianji/client-slots";

interface TerminalTabSession {
  readonly id: string;
  readonly title: string;
  readonly cwd: string;
  readonly shell: string;
  readonly exitCode?: number | null;
}

let terminalSeq = 0;

function nextTerminalId(): string {
  terminalSeq += 1;
  return `cw-pty-${Date.now().toString(36)}-${terminalSeq}`;
}

function isTauriDesktop(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

function workspaceShortName(cwd: string): string {
  const cleaned = cwd.replace(/[\\/]+$/, "");
  return cleaned.split(/[\\/]/).pop() || cwd;
}

function TerminalViewport({
  session,
  selected,
  visible,
  onExited,
}: {
  readonly session: TerminalTabSession;
  readonly selected: boolean;
  readonly visible: boolean;
  readonly onExited: (id: string, exitCode: number | null) => void;
}): ReactElement {
  const hostRef = useRef<HTMLDivElement>(null);
  const onExitedRef = useRef(onExited);

  useEffect(() => {
    onExitedRef.current = onExited;
  }, [onExited]);

  useEffect(() => {
    const container = hostRef.current;
    if (container === null || !isTauriDesktop()) return;

    let disposed = false;
    let disposeTerm: (() => void) | undefined;
    const unlisteners: UnlistenFn[] = [];

    void Promise.all([
      import("@xterm/xterm"),
      import("@xterm/addon-fit"),
      import("@xterm/addon-web-links"),
    ])
      .then(async ([{ Terminal }, { FitAddon }, { WebLinksAddon }]) => {
        if (disposed || container === null) return;
        const term = new Terminal({
          cursorBlink: true,
          fontSize: 12.5,
          lineHeight: 1.35,
          scrollback: 5000,
        });
        const fitAddon = new FitAddon();
        term.loadAddon(fitAddon);
        term.loadAddon(new WebLinksAddon());
        term.open(container);
        try {
          fitAddon.fit();
        } catch {
          // Container may have zero size while hidden.
        }

        const dataSub = term.onData((data) => {
          void invoke("terminal_write", { id: session.id, data }).catch(() => undefined);
        });

        const unlistenOut = await listen<{ id: string; data: string }>("terminal-output", (event) => {
          if (!disposed && event.payload.id === session.id) {
            term.write(event.payload.data);
          }
        });
        const unlistenExit = await listen<{ id: string; exitCode: number | null }>("terminal-exit", (event) => {
          if (!disposed && event.payload.id === session.id) {
            onExitedRef.current(session.id, event.payload.exitCode);
          }
        });
        unlisteners.push(unlistenOut, unlistenExit);

        await invoke("terminal_create", {
          id: session.id,
          cwd: session.cwd,
          shell: session.shell,
          cols: Math.max(20, term.cols || 80),
          rows: Math.max(6, term.rows || 24),
        }).catch(() => undefined);

        const resizeObserver =
          typeof ResizeObserver !== "undefined"
            ? new ResizeObserver(() => {
                if (disposed || container.clientWidth === 0 || container.clientHeight === 0) return;
                try {
                  fitAddon.fit();
                  void invoke("terminal_resize", {
                    id: session.id,
                    cols: Math.max(20, term.cols),
                    rows: Math.max(6, term.rows),
                  }).catch(() => undefined);
                } catch {
                  // Ignore transient resize errors.
                }
              })
            : null;
        resizeObserver?.observe(container);

        disposeTerm = () => {
          resizeObserver?.disconnect();
          dataSub.dispose();
          void invoke("terminal_close", { id: session.id }).catch(() => undefined);
          term.dispose();
        };
      })
      .catch(() => undefined);

    return () => {
      disposed = true;
      for (const stop of unlisteners) stop();
      disposeTerm?.();
    };
  }, [session.cwd, session.id, session.shell]);

  return (
    <div
      ref={hostRef}
      className="pid-wb-xterm-viewport"
      data-terminal-id={session.id}
      data-terminal-visible={visible && selected ? "true" : "false"}
      hidden={!selected}
    />
  );
}

function TerminalPanelBody({
  cwd,
  visible,
  compactHeader,
  terminalCreateNonce,
}: {
  readonly cwd: string;
  readonly visible: boolean;
  readonly compactHeader: boolean;
  readonly terminalCreateNonce: number;
}): ReactElement {
  const [shells, setShells] = useState<readonly string[]>(() => (isTauriDesktop() ? [] : ["default"]));
  const [sessions, setSessions] = useState<readonly TerminalTabSession[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [handledNonce, setHandledNonce] = useState(terminalCreateNonce);

  useEffect(() => {
    if (!isTauriDesktop()) return;
    let cancelled = false;
    void invoke<string[]>("terminal_shells")
      .then((list) => {
        if (!cancelled) setShells(list);
      })
      .catch(() => {
        if (!cancelled) setShells([]);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const defaultShell = shells[0] ?? "";

  const createSession = useCallback(() => {
    if (cwd === "" || defaultShell === "") return;
    const id = nextTerminalId();
    const label = defaultShell.split(/[\\/]/).pop()?.replace(/\.exe$/i, "") || "终端";
    const repo = workspaceShortName(cwd);
    setSessions((prev) => [
      ...prev,
      { id, title: `${label} ${prev.length + 1} · ${repo}`, cwd, shell: defaultShell },
    ]);
    setActiveId(id);
  }, [cwd, defaultShell]);

  if (terminalCreateNonce > handledNonce) {
    setHandledNonce(terminalCreateNonce);
    if (visible && cwd !== "" && defaultShell !== "") {
      const id = `cw-pty-nonce-${terminalCreateNonce}`;
      const label = defaultShell.split(/[\\/]/).pop()?.replace(/\.exe$/i, "") || "终端";
      const repo = workspaceShortName(cwd);
      setSessions((prev) => {
        if (prev.some((item) => item.id === id)) return prev;
        return [...prev, { id, title: `${label} ${prev.length + 1} · ${repo}`, cwd, shell: defaultShell }];
      });
      setActiveId(id);
    }
  }

  const handleClose = useCallback((id: string) => {
    setSessions((prev) => {
      const next = prev.filter((item) => item.id !== id);
      setActiveId((cur) => (cur === id ? (next[0]?.id ?? null) : cur));
      return next;
    });
  }, []);

  const handleExited = useCallback((id: string, exitCode: number | null) => {
    setSessions((prev) => prev.map((item) => (item.id === id ? { ...item, exitCode } : item)));
  }, []);

  if (cwd === "") {
    return <div className="pid-wb-empty" data-core-workbench-pane="terminal">选择工作区后即可打开集成终端。</div>;
  }

  const resolvedActiveId =
    activeId !== null && sessions.some((item) => item.id === activeId)
      ? activeId
      : (sessions[0]?.id ?? null);
  const showTabs = !compactHeader || sessions.length > 1;

  return (
    <div className="pid-wb-terminal-wrap" data-core-workbench-pane="terminal">
      {showTabs && (
        <div className="pid-wb-terminal-tabs">
          <div className="pid-wb-terminal-tab-list" role="tablist" aria-label="终端会话">
            {sessions.map((item) => {
              const active = item.id === resolvedActiveId;
              return (
                <div key={item.id} role="tab" aria-selected={active} className={`pid-wb-editor-tab${active ? " active" : ""}`}>
                  <button type="button" className="pid-wb-editor-tab-label" onClick={() => setActiveId(item.id)}>
                    <TerminalSquare size={12} />
                    <span>{item.title}</span>
                  </button>
                  <button
                    type="button"
                    className="pid-wb-editor-tab-close"
                    title="关闭此终端"
                    onClick={() => handleClose(item.id)}
                  >
                    <X size={12} />
                  </button>
                </div>
              );
            })}
          </div>
          <button
            type="button"
            className="pid-wb-icon-btn"
            title="新建终端标签页"
            disabled={defaultShell === ""}
            onClick={createSession}
          >
            <Plus size={13} />
          </button>
        </div>
      )}
      <div className="pid-wb-terminal-stage">
        {sessions.length === 0 ? (
          <div className="pid-wb-empty">
            <TerminalSquare size={18} className="pid-wb-empty-icon" />
            <button type="button" className="pid-wb-btn" disabled={defaultShell === ""} onClick={createSession}>
              <Plus size={13} />
              <span>在 {workspaceShortName(cwd)} 中新建终端</span>
            </button>
          </div>
        ) : (
          sessions.map((item) => (
            <TerminalViewport
              key={item.id}
              session={item}
              selected={item.id === resolvedActiveId}
              visible={visible}
              onExited={handleExited}
            />
          ))
        )}
      </div>
    </div>
  );
}

/** Right-workbench keyed `"terminal"` pane. */
export function CoreTerminalPane({
  cwd: propCwd,
  active,
  renderFactory,
  ctx,
}: SlotComponentProps<WorkbenchPaneSlotProps, "session-maybe">): ReactElement {
  const workspace = useWorkspaceState(ctx);
  const workbench = useWorkbenchState(ctx);
  const cwd = propCwd ?? workspace?.cwd ?? "";
  return renderFactory(
    "host.workbench.terminal",
    { cwd, visible: active, compactHeader: true },
    {
      fallback: (
        <TerminalPanelBody
          cwd={cwd}
          visible={active}
          compactHeader
          terminalCreateNonce={workbench?.terminalCreateNonce ?? 0}
        />
      ),
    },
  ) as ReactElement;
}

/** Bottom-drawer keyed `"terminal"` tab. */
export function CoreBottomTerminalTab({
  cwd: propCwd,
  active,
  renderFactory,
  ctx,
}: SlotComponentProps<WorkbenchBottomTabSlotProps, "session-maybe">): ReactElement {
  const workspace = useWorkspaceState(ctx);
  const workbench = useWorkbenchState(ctx);
  const cwd = propCwd ?? workspace?.cwd ?? "";
  return renderFactory(
    "host.workbench.terminal",
    { cwd, visible: active, compactHeader: false },
    {
      fallback: (
        <TerminalPanelBody
          cwd={cwd}
          visible={active}
          compactHeader={false}
          terminalCreateNonce={workbench?.terminalCreateNonce ?? 0}
        />
      ),
    },
  ) as ReactElement;
}

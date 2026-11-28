/**
 * Stateful Interactive PTY Console (`terminal`) & `/workspace` File Explorer (`files`)
 * for `BotComputerStudioPane`.
 */
import {
  useEffect,
  useState,
  type FormEvent,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactElement,
} from "react";
import type { Context } from "@deepseek-ai/cordis";
import {
  ArrowUp,
  Eraser,
  FileCode,
  FileText,
  Folder,
  Image as ImageIcon,
  RefreshCw,
  RotateCcw,
  Send,
  ShieldCheck,
  Terminal,
} from "lucide-react";
import type { BotComputerFileEntry } from "@qianji/protocol";
import { getEngineCardMeta, patchComputerStudioUi } from "./computerStudioStore";
import { useComputerStudio } from "./useComputerStudio";

function formatFileSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return "-";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function resolveParentDir(cwd: string): string {
  const normalized = cwd.replace(/\\/g, "/").replace(/\/+$/, "");
  if (normalized === "" || normalized === "/") return "/";
  const idx = normalized.lastIndexOf("/");
  if (idx <= 0) return "/";
  return normalized.slice(0, idx);
}

function sortFileEntries(entries: readonly BotComputerFileEntry[]): BotComputerFileEntry[] {
  return [...entries].sort((a, b) => {
    if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
    return a.name.localeCompare(b.name, "zh-CN");
  });
}

export function BotComputerTerminalAndFiles({
  ctx,
  mode,
}: {
  readonly ctx?: Context;
  readonly mode: "terminal" | "files";
}): ReactElement {
  const studio = useComputerStudio(ctx);
  const { snapshot: snap, ui, openPty, listFiles } = studio;

  const [cmdDraft, setCmdDraft] = useState("");
  const [cmdHistory, setCmdHistory] = useState<readonly string[]>([]);
  const [historyIdx, setHistoryIdx] = useState<number>(-1);

  const activeEngine = snap.activeEngine;
  const hasPtyForEngine = snap.pty?.engine === activeEngine && snap.pty.alive;

  useEffect(() => {
    if (mode === "terminal" && !hasPtyForEngine) {
      void openPty();
    }
  }, [activeEngine, hasPtyForEngine, mode, openPty]);

  useEffect(() => {
    if (mode === "files" && ui.filesEntries.length === 0) {
      void listFiles(ui.filesCwd || snap.filesCwd || "/workspace");
    }
  }, [activeEngine, listFiles, mode, snap.filesCwd, ui.filesCwd, ui.filesEntries.length]);

  if (mode === "terminal") {
    const engineMeta = getEngineCardMeta(activeEngine);
    const scrubStep =
      ui.scrubIndex !== null ? snap.timeline[ui.scrubIndex] : undefined;
    const liveBuffer =
      ui.ptyBufferByEngine[activeEngine] || snap.pty?.outputTail || "";
    const renderedOutput =
      scrubStep?.terminalSnippet ??
      (liveBuffer !== ""
        ? liveBuffer
        : `[${engineMeta.title}] 持久 PTY 终端已就绪（目录与环境变量跨指令保持）。\n输入命令回车即可交互执行。`);
    const cwdLabel =
      snap.pty?.engine === activeEngine ? snap.pty.cwd : "/workspace";
    const promptSymbol = activeEngine === "local-win-pip" ? "PS>" : "$";

    const handlePtySubmit = (e: FormEvent) => {
      e.preventDefault();
      const raw = cmdDraft;
      if (raw.trim() === "") return;
      setCmdHistory((prev) => [...prev.slice(-39), raw]);
      setHistoryIdx(-1);
      setCmdDraft("");
      void studio.writePty(`${raw}\n`);
    };

    const handleCmdKeyDown = (e: ReactKeyboardEvent<HTMLInputElement>) => {
      if (e.ctrlKey && e.key.toLowerCase() === "c" && cmdDraft === "") {
        e.preventDefault();
        void studio.writePty("\x03");
        return;
      }
      if (e.key === "ArrowUp" && cmdHistory.length > 0) {
        e.preventDefault();
        const nextIdx =
          historyIdx < 0 ? cmdHistory.length - 1 : Math.max(0, historyIdx - 1);
        setHistoryIdx(nextIdx);
        setCmdDraft(cmdHistory[nextIdx] ?? "");
      } else if (e.key === "ArrowDown" && historyIdx >= 0) {
        e.preventDefault();
        if (historyIdx >= cmdHistory.length - 1) {
          setHistoryIdx(-1);
          setCmdDraft("");
        } else {
          const nextIdx = historyIdx + 1;
          setHistoryIdx(nextIdx);
          setCmdDraft(cmdHistory[nextIdx] ?? "");
        }
      }
    };

    return (
      <div className="qj-cs-term-wrap" data-testid="computer-terminal-view">
        <div className="qj-cs-term-head">
          <div className="qj-cs-term-meta">
            <Terminal size={13.5} />
            <span className="qj-cs-term-cwd" data-testid="computer-pty-cwd">
              {cwdLabel}
            </span>
            <span className={`qj-cs-pty-badge${hasPtyForEngine ? " is-alive" : ""}`}>
              {hasPtyForEngine ? "持久会话在线" : "待连接"}
            </span>
          </div>
          <div className="qj-cs-term-actions">
            <button
              type="button"
              data-testid="computer-pty-clear-btn"
              className="qj-cs-pill-btn xs"
              onClick={() => studio.clearPtyLocal(activeEngine)}
            >
              <Eraser size={12} />
              <span>清屏</span>
            </button>
            <button
              type="button"
              data-testid="computer-pty-reconnect-btn"
              className="qj-cs-pill-btn xs"
              onClick={() => void studio.openPty(cwdLabel)}
            >
              <RotateCcw size={12} />
              <span>重连终端</span>
            </button>
          </div>
        </div>

        <pre className="qj-cs-pty-output" data-testid="computer-pty-output">
          {renderedOutput}
        </pre>

        <form
          className="qj-cs-pty-form"
          data-testid="computer-pty-form"
          onSubmit={handlePtySubmit}
        >
          <span className="qj-cs-pty-prompt">{promptSymbol}</span>
          <input
            type="text"
            aria-label="分身终端命令输入"
            value={cmdDraft}
            onChange={(e) => setCmdDraft(e.target.value)}
            onKeyDown={handleCmdKeyDown}
            placeholder="输入命令（支持 cd 状态保持、上下键历史与 Ctrl+C 中断）…"
            className="qj-cs-pty-input"
          />
          <button
            type="submit"
            data-testid="computer-pty-send-btn"
            className="qj-cs-pill-btn primary xs"
            disabled={cmdDraft.trim() === ""}
          >
            <Send size={12} />
            <span>运行</span>
          </button>
        </form>
      </div>
    );
  }

  const cwd = ui.filesCwd || snap.filesCwd || "/workspace";
  const entries = sortFileEntries(
    ui.filesEntries.length > 0 ? ui.filesEntries : (snap.files ?? []),
  );
  const fileRead = ui.selectedFileRead;
  const fencedCount = snap.localWinPip?.fencedRoots.length ?? 0;

  return (
    <div className="qj-cs-files-wrap" data-testid="computer-files-view">
      <div className="qj-cs-files-toolbar">
        <div className="qj-cs-files-path-group">
          <button
            type="button"
            data-testid="computer-files-up-btn"
            className="qj-cs-icon-btn sm"
            title="返回上级目录"
            aria-label="返回上级目录"
            onClick={() => void studio.listFiles(resolveParentDir(cwd))}
          >
            <ArrowUp size={13.5} />
          </button>
          <span className="qj-cs-files-cwd" data-testid="computer-files-cwd">
            {cwd}
          </span>
          {activeEngine === "local-win-pip" && (
            <span className="qj-cs-fence-badge" title="Sentinel 受控路径围栏已开启">
              <ShieldCheck size={11.5} />
              <span>路径围栏 ({fencedCount || 1})</span>
            </span>
          )}
        </div>
        <button
          type="button"
          data-testid="computer-files-refresh-btn"
          className="qj-cs-icon-btn sm"
          title="刷新目录"
          aria-label="刷新目录"
          onClick={() => void studio.listFiles(cwd)}
        >
          <RefreshCw size={13} />
        </button>
      </div>

      <div className="qj-cs-files-split">
        <div className="qj-cs-files-list" data-testid="computer-files-list">
          {entries.length === 0 ? (
            <div className="qj-cs-files-empty">
              {ui.busyAction === "files.list" ? "正在读取目录…" : "当前工作区目录暂无文件"}
            </div>
          ) : (
            entries.map((entry) => {
              const selected = ui.selectedFilePath === entry.path;
              return (
                <button
                  key={entry.path}
                  type="button"
                  data-testid="computer-file-entry"
                  data-entry-path={entry.path}
                  className={`qj-cs-file-row${selected ? " active" : ""}`}
                  onClick={() => {
                    if (entry.isDir) {
                      patchComputerStudioUi({
                        selectedFilePath: null,
                        selectedFileRead: null,
                      });
                      void studio.listFiles(entry.path);
                    } else {
                      void studio.readFile(entry.path);
                    }
                  }}
                >
                  <span className={`qj-cs-file-icon${entry.isDir ? " is-dir" : ""}`}>
                    {entry.isDir ? (
                      <Folder size={14} />
                    ) : entry.mimeType?.startsWith("image/") ? (
                      <ImageIcon size={14} />
                    ) : /\.(ts|tsx|js|py|rs|json|sh)$/i.test(entry.name) ? (
                      <FileCode size={14} />
                    ) : (
                      <FileText size={14} />
                    )}
                  </span>
                  <span className="qj-cs-file-name">{entry.name}</span>
                  <span className="qj-cs-file-size qj-tabular">
                    {entry.isDir ? "目录" : formatFileSize(entry.sizeBytes)}
                  </span>
                </button>
              );
            })
          )}
        </div>

        <div className="qj-cs-file-preview" data-testid="computer-file-preview">
          {fileRead === null ? (
            <div className="qj-cs-preview-empty">
              选择左侧文件即可在线预览文本、Markdown 或图片产物
            </div>
          ) : fileRead.mimeType?.startsWith("image/") && fileRead.dataBase64 ? (
            <div className="qj-cs-preview-media">
              <div className="qj-cs-preview-head">{fileRead.path}</div>
              <img
                src={`data:${fileRead.mimeType};base64,${fileRead.dataBase64}`}
                alt={fileRead.path}
                className="qj-cs-preview-img"
              />
            </div>
          ) : !fileRead.isBinary && fileRead.content !== undefined ? (
            <div className="qj-cs-preview-doc">
              <div className="qj-cs-preview-head">
                <span>{fileRead.path}</span>
                <span className="qj-tabular">{formatFileSize(fileRead.sizeBytes)}</span>
              </div>
              <pre className="qj-cs-preview-pre">{fileRead.content}</pre>
            </div>
          ) : (
            <div className="qj-cs-preview-empty">
              二进制文件（{formatFileSize(fileRead.sizeBytes)}）· {fileRead.path}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

/**
 * Tab 4 — `文件` (`BotComputerFilesView`).
 *
 * Clean `/workspace` directory browser & inline text/markdown/image preview
 * designed to fit cleanly inside the `380px–680px` right Computer panel.
 */
import { useEffect, type ReactElement } from "react";
import type { Context } from "@deepseek-ai/cordis";
import {
  ArrowUp,
  FileCode,
  FileText,
  Folder,
  Image as ImageIcon,
  RefreshCw,
  ShieldCheck,
  X,
} from "lucide-react";
import type { BotComputerFileEntry } from "@qianji/protocol";
import { patchComputerStudioUi } from "./computerStudioStore";
import { useComputerStudio } from "./useComputerStudio";

function formatFileSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return "-";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function resolveParentDir(cwd: string, localFenced: boolean): string {
  const normalized = cwd.replace(/\\/g, "/").replace(/\/+$/, "");
  if (localFenced) {
    if (normalized === "" || normalized === "/" || normalized === "/workspace") {
      return "/workspace";
    }
    if (/^\/shared\/[^/]+$/.test(normalized)) {
      return "/workspace";
    }
  }
  if (normalized === "" || normalized === "/") return "/";
  const idx = normalized.lastIndexOf("/");
  if (idx <= 0) return localFenced ? "/workspace" : "/";
  return normalized.slice(0, idx);
}

function sortFileEntries(entries: readonly BotComputerFileEntry[]): BotComputerFileEntry[] {
  return [...entries].sort((a, b) => {
    if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
    return a.name.localeCompare(b.name, "zh-CN");
  });
}

export function BotComputerFilesView({ ctx }: { readonly ctx?: Context }): ReactElement {
  const studio = useComputerStudio(ctx);
  const { snapshot: snap, ui, listFiles, readFile } = studio;

  const activeEngine = snap.activeEngine;
  const isLocalFenced = activeEngine === "local-linux" || activeEngine === "local-win-pip";
  const cwd = ui.filesCwd || snap.filesCwd || (isLocalFenced ? "/workspace" : "~/.qianji-vm/workspace");

  useEffect(() => {
    if (ui.filesEntries.length === 0) {
      const preferred = ui.filesCwd !== "" ? ui.filesCwd : undefined;
      void listFiles(preferred);
    }
  }, [activeEngine, listFiles, ui.filesCwd, ui.filesEntries.length]);

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
            onClick={() => void listFiles(resolveParentDir(cwd, isLocalFenced))}
          >
            <ArrowUp size={13.5} />
          </button>
          <span className="qj-cs-files-cwd" data-testid="computer-files-cwd">
            {cwd}
          </span>
          {activeEngine === "local-win-pip" && (
            <span className="qj-cs-fence-badge" title="Sentinel 受控路径围栏已开启">
              <ShieldCheck size={11.5} />
              <span>围栏 ({fencedCount || 1})</span>
            </span>
          )}
        </div>
        <button
          type="button"
          data-testid="computer-files-refresh-btn"
          className="qj-cs-icon-btn sm"
          title="刷新目录"
          aria-label="刷新目录"
          onClick={() => void listFiles(cwd)}
        >
          <RefreshCw size={13} />
        </button>
      </div>

      <div className={`qj-cs-files-stack${fileRead !== null ? " has-preview" : ""}`}>
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
                      void listFiles(entry.path);
                    } else {
                      void readFile(entry.path);
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
              点击上方文件即可在线预览文本、Markdown 或图片
            </div>
          ) : (
            <div className="qj-cs-preview-doc">
              <div className="qj-cs-preview-head">
                <span className="qj-cs-preview-path">{fileRead.path}</span>
                <div className="qj-cs-preview-head-right">
                  <span className="qj-tabular">{formatFileSize(fileRead.sizeBytes)}</span>
                  <button
                    type="button"
                    className="qj-cs-icon-btn xs"
                    title="关闭文件预览"
                    aria-label="关闭文件预览"
                    onClick={() =>
                      patchComputerStudioUi({ selectedFilePath: null, selectedFileRead: null })
                    }
                  >
                    <X size={12} />
                  </button>
                </div>
              </div>
              {fileRead.mimeType?.startsWith("image/") && fileRead.dataBase64 ? (
                <img
                  src={`data:${fileRead.mimeType};base64,${fileRead.dataBase64}`}
                  alt={fileRead.path}
                  className="qj-cs-preview-img"
                />
              ) : !fileRead.isBinary && fileRead.content !== undefined ? (
                <pre className="qj-cs-preview-pre">{fileRead.content}</pre>
              ) : (
                <div className="qj-cs-preview-empty">
                  二进制文件（{formatFileSize(fileRead.sizeBytes)}）
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

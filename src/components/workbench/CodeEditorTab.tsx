import { Suspense, lazy, useCallback, useEffect, useMemo, useState } from "react";
import { openUrl } from "@tauri-apps/plugin-opener";
import {
  Code2,
  Columns2,
  ExternalLink,
  Eye,
  FileCode2,
  FolderOpen,
  RefreshCw,
  RotateCcw,
  Save,
  X,
} from "lucide-react";
import { SlotEntryHost } from "../common/ErrorBoundary";
import { useFileActions } from "../WorkspaceOpeners";
import { agent } from "../../lib/agent";
import { matchFileViewer, useClientContributions } from "../../lib/clientContributions";
import { describeError } from "../../lib/errors";
import { resolveWorkspacePath } from "../../lib/workspaceEditors";
import { useAppStore } from "../../store";
import {
  matchesWorkbenchFileCwd,
  previewKindForPath,
  resolveWorkspaceActiveFilePath,
  resolveWorkspacePreviewUrl,
  useWorkbenchStore,
  type OpenWorkbenchFile,
  type WorkbenchFileViewMode,
} from "../../stores/workbenchStore";
import { DynamicDocumentPreview } from "./DynamicDocumentPreview";

const LazyCodeMirrorSurface = lazy(() => import("./CodeMirrorSurface"));

export interface CodeEditorTabProps {
  cwd: string;
}

export function CodeEditorTab({ cwd }: CodeEditorTabProps) {
  const openFiles = useWorkbenchStore((state) => state.openFiles);
  const preferredPath = useWorkbenchStore((state) => resolveWorkspaceActiveFilePath(state, cwd));
  const sessionFile = useAppStore((state) => state.sessionFile);
  const contributions = useClientContributions();
  const fileActions = useFileActions();
  const inTauri = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

  const workspaceFiles = useMemo(
    () => openFiles.filter((item) => matchesWorkbenchFileCwd(item.cwd, cwd)),
    [cwd, openFiles],
  );
  const activeFile = workspaceFiles.find((item) => item.path === preferredPath) ?? workspaceFiles[0] ?? null;

  const [previewUrlEntry, setPreviewUrlEntry] = useState<{ key: string; url: string | null } | null>(null);
  const [previewNonce, setPreviewNonce] = useState(0);

  const previewKind = activeFile ? previewKindForPath(activeFile.path) : null;
  const isPdfFile = activeFile?.mimeType === "application/pdf" || /\.pdf$/i.test(activeFile?.path ?? "");
  const effectiveFileCwd = activeFile?.cwd || cwd;
  const needsLoopbackUrl = previewKind === "html" || previewKind === "svg" || isPdfFile;
  const activePreviewKey = activeFile && effectiveFileCwd && needsLoopbackUrl
    ? `${effectiveFileCwd}::${activeFile.path}`
    : null;
  const previewHttpUrl = activePreviewKey && previewUrlEntry?.key === activePreviewKey
    ? previewUrlEntry.url
    : null;

  useEffect(() => {
    if (!activePreviewKey || !activeFile || !effectiveFileCwd) return;
    let cancelled = false;
    void resolveWorkspacePreviewUrl(effectiveFileCwd, activeFile.path).then((url) => {
      if (!cancelled) setPreviewUrlEntry({ key: activePreviewKey, url });
    });
    return () => {
      cancelled = true;
    };
  }, [activeFile, activePreviewKey, effectiveFileCwd]);

  const handleOpenExternalDefault = useCallback(() => {
    if (!activeFile) return;
    if (fileActions) {
      fileActions.openWithDefaultApp(activeFile.path);
      return;
    }
    if (!inTauri) return;
    const absolute = resolveWorkspacePath(effectiveFileCwd, activeFile.path);
    void agent.openFileInDefaultApp(absolute).catch((error) => {
      useAppStore.getState().showToast(`无法在外部默认应用中打开：${describeError(error)}`, "error");
    });
  }, [activeFile, effectiveFileCwd, fileActions, inTauri]);

  const handleRevealInExplorer = useCallback(() => {
    if (!activeFile) return;
    if (fileActions) {
      fileActions.reveal(activeFile.path);
      return;
    }
    if (!inTauri) return;
    const absolute = resolveWorkspacePath(effectiveFileCwd, activeFile.path);
    void agent.revealPathInFileManager(absolute).catch((error) => {
      useAppStore.getState().showToast(`无法在资源管理器中显示：${describeError(error)}`, "error");
    });
  }, [activeFile, effectiveFileCwd, fileActions, inTauri]);

  const handleSave = useCallback(async () => {
    if (!activeFile || !effectiveFileCwd) return;
    const saved = await useWorkbenchStore.getState().saveFile(effectiveFileCwd, activeFile.path);
    if (saved) {
      setPreviewNonce((n) => n + 1);
      useAppStore.getState().showToast(`已保存 ${activeFile.path.split("/").pop() ?? activeFile.path}`, "info");
      void useAppStore.getState().refreshGit();
    }
  }, [activeFile, effectiveFileCwd]);

  const handleReload = useCallback(() => {
    if (!activeFile || !effectiveFileCwd) return;
    if (
      activeFile.content !== activeFile.savedContent
      && !window.confirm(`放弃 ${activeFile.path} 的未保存修改并重新加载？`)
    ) {
      return;
    }
    setPreviewNonce((n) => n + 1);
    void useWorkbenchStore.getState().reloadFile(effectiveFileCwd, activeFile.path);
  }, [activeFile, effectiveFileCwd]);

  const handleCloseTab = useCallback((file: OpenWorkbenchFile) => {
    if (
      file.content !== file.savedContent
      && !window.confirm(`关闭 ${file.path}？未保存的修改将丢失。`)
    ) {
      return;
    }
    useWorkbenchStore.getState().closeFile(file.path, file.cwd || cwd);
  }, [cwd]);

  if (!activeFile) {
    return (
      <div className="pid-wb-empty">
        <FileCode2 size={22} className="pid-wb-empty-icon" />
        <p>尚未打开任何文件</p>
        <button
          type="button"
          className="pid-wb-btn"
          onClick={() => useWorkbenchStore.getState().openFilesTab()}
        >
          <FolderOpen size={13} />
          <span>从文件树选择文件</span>
        </button>
      </div>
    );
  }

  const customViewer = matchFileViewer(contributions.fileViewers, {
    path: activeFile.path,
    mimeType: activeFile.mimeType,
  });
  const isDirty = activeFile.content !== activeFile.savedContent;
  const canRenderPreview = customViewer !== undefined || (previewKind !== null && (!activeFile.isBinary || previewKind === "svg"));
  const defaultMode: WorkbenchFileViewMode =
    customViewer !== undefined || previewKind === "html" || previewKind === "svg" ? "preview" : "code";
  const effectiveMode: WorkbenchFileViewMode = !canRenderPreview
    ? "code"
    : activeFile.isBinary
      ? "preview"
      : (activeFile.viewMode ?? defaultMode);
  const showBrowserExternal = effectiveMode !== "code" && (previewKind === "html" || previewKind === "svg");
  const pdfSrc = previewHttpUrl ?? (activeFile.data ? `data:application/pdf;base64,${activeFile.data}` : null);

  const setMode = (mode: WorkbenchFileViewMode) => {
    useWorkbenchStore.getState().setFileViewMode(activeFile.path, mode, effectiveFileCwd);
  };

  return (
    <div className="pid-wb-pane">
      <div
        className="pid-wb-editor-tabs"
        role="tablist"
        aria-label="已打开文件"
        onWheel={(event) => {
          const el = event.currentTarget;
          if (el.scrollWidth > el.clientWidth && Math.abs(event.deltaY) > Math.abs(event.deltaX)) {
            el.scrollLeft += event.deltaY;
          }
        }}
      >
        {workspaceFiles.map((file) => {
          const dirty = file.content !== file.savedContent;
          const active = file.path === activeFile.path;
          const fileName = file.path.split("/").pop() || file.path;
          return (
            <div
              key={`${file.cwd ?? ""}::${file.path}`}
              role="tab"
              aria-selected={active}
              className={`pid-wb-editor-tab${active ? " active" : ""}`}
              title={file.path}
            >
              <button
                type="button"
                className="pid-wb-editor-tab-label"
                onClick={() => useWorkbenchStore.getState().selectFile(file.path, file.cwd || cwd)}
              >
                <span>{fileName}</span>
                {dirty && <span className="pid-wb-dirty-dot" aria-label="未保存" />}
              </button>
              <button
                type="button"
                className="pid-wb-editor-tab-close"
                title="关闭文件"
                onClick={() => handleCloseTab(file)}
              >
                <X size={12} />
              </button>
            </div>
          );
        })}
      </div>

      <div className="pid-wb-subbar">
        <span className="pid-wb-filepath" title={activeFile.path}>{activeFile.path}</span>
        <div className="pid-wb-subbar-actions">
          {canRenderPreview && !activeFile.isBinary && (
            <div className="pid-wb-view-seg" role="tablist" aria-label="文件视图模式">
              <button
                type="button"
                role="tab"
                aria-selected={effectiveMode === "preview"}
                className={`pid-wb-view-seg-btn${effectiveMode === "preview" ? " active" : ""}`}
                title="动态渲染预览"
                onClick={() => setMode("preview")}
              >
                <Eye size={12} />
                <span>预览</span>
              </button>
              <button
                type="button"
                role="tab"
                aria-selected={effectiveMode === "split"}
                className={`pid-wb-view-seg-btn${effectiveMode === "split" ? " active" : ""}`}
                title="源码与实时预览分栏"
                onClick={() => setMode("split")}
              >
                <Columns2 size={12} />
                <span>分栏</span>
              </button>
              <button
                type="button"
                role="tab"
                aria-selected={effectiveMode === "code"}
                className={`pid-wb-view-seg-btn${effectiveMode === "code" ? " active" : ""}`}
                title="编辑源码"
                onClick={() => setMode("code")}
              >
                <Code2 size={12} />
                <span>源码</span>
              </button>
            </div>
          )}

          {showBrowserExternal ? (
            <>
              <button
                type="button"
                className="pid-wb-icon-btn"
                title="重新运行动态预览"
                aria-label="刷新预览"
                onClick={() => setPreviewNonce((n) => n + 1)}
              >
                <RefreshCw size={13} />
              </button>
              <button
                type="button"
                className="pid-wb-icon-btn"
                title={previewHttpUrl ? "在外部浏览器中打开" : "使用系统默认应用打开"}
                aria-label={previewHttpUrl ? "在外部浏览器中打开" : "使用系统默认应用打开"}
                onClick={() => {
                  if (previewHttpUrl) {
                    void openUrl(previewHttpUrl).catch((error) => {
                      useAppStore.getState().showToast(`打开外部浏览器失败：${describeError(error)}`, "error");
                    });
                  } else {
                    handleOpenExternalDefault();
                  }
                }}
              >
                <ExternalLink size={13} />
              </button>
            </>
          ) : (
            <button
              type="button"
              className="pid-wb-icon-btn"
              title="使用系统默认应用打开"
              aria-label="使用系统默认应用打开"
              onClick={handleOpenExternalDefault}
            >
              <ExternalLink size={13} />
            </button>
          )}

          <button
            type="button"
            className="pid-wb-icon-btn"
            title="在文件资源管理器中显示"
            aria-label="在文件资源管理器中显示"
            onClick={handleRevealInExplorer}
          >
            <FolderOpen size={13} />
          </button>

          {activeFile.truncated && (
            <span className="pid-wb-badge warn" title="大文件已截断为只读预览">只读（大文件截断）</span>
          )}
          <button
            type="button"
            className="pid-wb-icon-btn"
            title="从磁盘重新加载"
            onClick={handleReload}
          >
            <RotateCcw size={13} />
          </button>
          {!activeFile.isBinary && !activeFile.truncated && (
            <button
              type="button"
              className={`pid-wb-btn small${isDirty ? " primary" : ""}`}
              disabled={!isDirty || Boolean(activeFile.saving)}
              title="保存文件 (Ctrl+S)"
              onClick={() => void handleSave()}
            >
              <Save size={12} />
              <span>{activeFile.saving ? "保存中…" : "保存"}</span>
            </button>
          )}
        </div>
      </div>

      <div className="pid-wb-editor-body">
        {activeFile.loading ? (
          <div className="pid-wb-empty">正在读取 {activeFile.path}…</div>
        ) : activeFile.error ? (
          <div className="pid-wb-empty error">
            <p>{activeFile.error}</p>
            <div className="pid-wb-subbar-actions">
              <button type="button" className="pid-wb-btn" onClick={handleOpenExternalDefault}>
                <ExternalLink size={13} />
                <span>使用系统默认应用打开</span>
              </button>
              <button type="button" className="pid-wb-btn" onClick={handleRevealInExplorer}>
                <FolderOpen size={13} />
                <span>在文件资源管理器中显示</span>
              </button>
            </div>
          </div>
        ) : canRenderPreview && effectiveMode === "preview" && customViewer !== undefined ? (
          <SlotEntryHost
            entry={customViewer}
            context={{
              cwd: effectiveFileCwd,
              sessionFile,
              path: activeFile.path,
              content: activeFile.content,
              isBinary: activeFile.isBinary,
              mimeType: activeFile.mimeType,
              dataBase64: activeFile.data,
              size: activeFile.size,
            }}
            slotName="file.viewer"
            className="pid-wb-plugin-file-viewer"
            style={{ height: "100%", overflow: "auto" }}
          />
        ) : canRenderPreview && previewKind !== null && effectiveMode === "preview" ? (
          <DynamicDocumentPreview
            file={activeFile}
            kind={previewKind}
            previewHttpUrl={previewHttpUrl}
            reloadNonce={previewNonce}
          />
        ) : canRenderPreview && effectiveMode === "split" && (customViewer !== undefined || previewKind !== null) ? (
          <div className="pid-wb-split-view">
            <div className="pid-wb-split-pane is-code">
              <Suspense fallback={<div className="pid-wb-empty">正在加载编辑器…</div>}>
                <LazyCodeMirrorSurface cwd={effectiveFileCwd} file={activeFile} onSave={() => void handleSave()} />
              </Suspense>
            </div>
            <div className="pid-wb-split-pane is-preview">
              {customViewer !== undefined ? (
                <SlotEntryHost
                  entry={customViewer}
                  context={{
                    cwd: effectiveFileCwd,
                    sessionFile,
                    path: activeFile.path,
                    content: activeFile.content,
                    isBinary: activeFile.isBinary,
                    mimeType: activeFile.mimeType,
                    dataBase64: activeFile.data,
                    size: activeFile.size,
                  }}
                  slotName="file.viewer"
                  className="pid-wb-plugin-file-viewer"
                  style={{ height: "100%", overflow: "auto" }}
                />
              ) : previewKind !== null ? (
                <DynamicDocumentPreview
                  file={activeFile}
                  kind={previewKind}
                  previewHttpUrl={previewHttpUrl}
                  reloadNonce={previewNonce}
                />
              ) : null}
            </div>
          </div>
        ) : activeFile.isBinary ? (
          activeFile.mimeType?.startsWith("image/") && activeFile.data ? (
            <div className="pid-wb-image-preview">
              <img
                src={`data:${activeFile.mimeType};base64,${activeFile.data}`}
                alt={activeFile.path}
              />
            </div>
          ) : isPdfFile && pdfSrc ? (
            <div className="pid-wb-preview-stage" data-workbench-preview="pdf">
              <iframe
                key={`${activeFile.cwd ?? ""}::${activeFile.path}:pdf:${previewNonce}`}
                className="pid-wb-iframe"
                src={pdfSrc}
                title={`PDF 预览 ${activeFile.path}`}
              />
            </div>
          ) : (
            <div className="pid-wb-empty">
              <p>二进制文件无法直接作为文本编辑（{(activeFile.size / 1024).toFixed(1)} KB）</p>
              <div className="pid-wb-subbar-actions">
                <button type="button" className="pid-wb-btn primary" onClick={handleOpenExternalDefault}>
                  <ExternalLink size={13} />
                  <span>使用系统默认应用打开</span>
                </button>
                <button type="button" className="pid-wb-btn" onClick={handleRevealInExplorer}>
                  <FolderOpen size={13} />
                  <span>在文件资源管理器中显示</span>
                </button>
              </div>
            </div>
          )
        ) : (
          <Suspense fallback={<div className="pid-wb-empty">正在加载编辑器…</div>}>
            <LazyCodeMirrorSurface cwd={effectiveFileCwd} file={activeFile} onSave={() => void handleSave()} />
          </Suspense>
        )}
      </div>
    </div>
  );
}

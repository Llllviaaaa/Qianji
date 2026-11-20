/**
 * Built-in `"files"` / `"editor"` / `"code"` workbench pane (`CoreCodeWorkspacePane`, ADR 0023).
 *
 * Owns child slot `workbench.fileViewer` (`keyed`) so custom file viewer plugins
 * (e.g. `diagram-viewer` for `.mmd`/`.puml`) render automatically inside the
 * editor preview stage, with fallback to legacy `contributions.fileViewers` and
 * built-in text/markdown/image preview.
 */
import { useCallback, useMemo, useState, type ReactElement } from "react";
import { Code2, Columns2, ExternalLink, Eye, Folder, Save, X } from "lucide-react";
import {
  showToast,
  useClientContributions,
  useFrontendService,
  useSessionState,
  useWorkbenchState,
  useWorkspaceState,
  type ClientFileViewerContribution,
  type OpenWorkbenchFile,
} from "@qianji/client";
import { Markdown } from "@qianji/client-primitives";
import type {
  SlotComponentProps,
  WorkbenchFileViewerSlotProps,
  WorkbenchPaneSlotProps,
} from "@qianji/client-slots";
import { CoreWorkspaceFileTree } from "./CoreWorkspaceFileTree";
import { LegacyContributionHost, useSlotRegistryVersion } from "./tilingHelpers";

const EMPTY_OPEN_FILES: readonly OpenWorkbenchFile[] = [];

function normalizePathKey(p: string): string {
  return p.trim().replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
}

function sameWorkspaceCwd(fileCwd: string | undefined, cwd: string): boolean {
  if (fileCwd === undefined || fileCwd === "" || cwd === "") return true;
  return normalizePathKey(fileCwd) === normalizePathKey(cwd);
}

function extractExtension(filePath: string): string {
  const clean = filePath.trim().toLowerCase();
  const dot = clean.lastIndexOf(".");
  return dot >= 0 ? clean.slice(dot) : "";
}

function matchLegacyViewer(
  viewers: readonly ClientFileViewerContribution[],
  path: string,
  mimeType?: string,
): ClientFileViewerContribution | undefined {
  const ext = extractExtension(path).replace(/^\./, "");
  const lowerMime = mimeType?.trim().toLowerCase() ?? "";
  for (const viewer of viewers) {
    if (viewer.extensions !== undefined && ext !== "") {
      for (const raw of viewer.extensions) {
        if (raw.trim().toLowerCase().replace(/^\./, "") === ext) return viewer;
      }
    }
    if (viewer.mimeTypes !== undefined && lowerMime !== "") {
      for (const raw of viewer.mimeTypes) {
        const pattern = raw.trim().toLowerCase();
        if (pattern.endsWith("/*") && lowerMime.startsWith(pattern.slice(0, -1))) return viewer;
        if (lowerMime === pattern) return viewer;
      }
    }
  }
  return undefined;
}

/** Core `"files"` / `"editor"` / `"code"` workbench pane. */
export function CoreCodeWorkspacePane({
  cwd: propCwd,
  sessionFile: propSessionFile,
  renderSlot,
  ctx,
}: SlotComponentProps<WorkbenchPaneSlotProps, "session-maybe">): ReactElement {
  const workbench = useWorkbenchState(ctx);
  const workspace = useWorkspaceState(ctx);
  const session = useSessionState(ctx);
  const workbenchService = useFrontendService("workbenchService", ctx);
  const workspaceService = useFrontendService("workspaceService", ctx);
  const contributions = useClientContributions();
  const registry = ctx?.get("slots")?.registry;
  useSlotRegistryVersion(registry);

  const cwd = propCwd ?? workspace?.cwd ?? "";
  const sessionFile = propSessionFile !== undefined ? propSessionFile : (session?.sessionFile ?? null);
  const fileDrawerOpen = workbench?.fileDrawerOpen ?? true;
  const openFiles = workbench?.openFiles ?? EMPTY_OPEN_FILES;

  const workspaceFiles = useMemo(
    () => openFiles.filter((item) => sameWorkspaceCwd(item.cwd, cwd)),
    [cwd, openFiles],
  );
  const activeFile: OpenWorkbenchFile | null =
    workspaceFiles.find((item) => item.path === workbench?.activeFilePath) ?? workspaceFiles[0] ?? null;

  const [viewModeByPath, setViewModeByPath] = useState<Record<string, "preview" | "split" | "code">>({});

  const handleSave = useCallback(async () => {
    if (activeFile === null || workbenchService === undefined) return;
    const saved = await workbenchService.saveFile(activeFile.path, activeFile.cwd || cwd);
    if (saved) {
      showToast(`已保存 ${activeFile.path.split(/[\\/]/).pop() ?? activeFile.path}`, "info");
      void workspaceService?.refreshGit(cwd);
    }
  }, [activeFile, cwd, workbenchService, workspaceService]);

  const fileExt = activeFile !== null ? extractExtension(activeFile.path) : "";
  const hasActiveViewerForKey = (routeKey: string): boolean => {
    if (registry === undefined || routeKey === "") return false;
    return registry
      .getKeyedCandidates("workbench.fileViewer", routeKey)
      .some((entry) => !registry.abdication.isAbdicated("workbench.fileViewer", entry.id, entry.pluginId));
  };
  const hasExtSlotViewer = activeFile !== null && hasActiveViewerForKey(fileExt);
  const hasPathSlotViewer = activeFile !== null && hasActiveViewerForKey(activeFile.path);
  const hasSlotViewer = hasExtSlotViewer || hasPathSlotViewer;
  const slotViewerKey = activeFile === null ? "" : hasExtSlotViewer ? fileExt : activeFile.path;
  const legacyViewer =
    activeFile !== null && !hasSlotViewer
      ? matchLegacyViewer(contributions.fileViewers, activeFile.path, activeFile.mimeType)
      : undefined;
  const isMarkdown = fileExt === ".md" || fileExt === ".markdown";
  const isImage = activeFile?.isBinary === true && activeFile.mimeType?.startsWith("image/") === true;
  const canPreview = hasSlotViewer || legacyViewer !== undefined || isMarkdown || isImage;
  const defaultMode: "preview" | "code" = hasSlotViewer || legacyViewer !== undefined || isImage ? "preview" : "code";
  const effectiveMode: "preview" | "split" | "code" = !canPreview
    ? "code"
    : activeFile?.isBinary === true
      ? "preview"
      : (activeFile !== null ? viewModeByPath[activeFile.path] : undefined) ?? defaultMode;

  const renderPreviewBody = (file: OpenWorkbenchFile): ReactElement => {
    if (hasSlotViewer) {
      const viewerProps: WorkbenchFileViewerSlotProps = {
        cwd: file.cwd || cwd,
        sessionFile,
        path: file.path,
        content: file.content,
        isBinary: file.isBinary,
        ...(file.mimeType === undefined ? {} : { mimeType: file.mimeType }),
        ...(file.data === undefined ? {} : { dataBase64: file.data }),
        size: file.size,
        ...(file.truncated === undefined ? {} : { truncated: file.truncated }),
      };
      return (
        <div className="pid-wb-plugin-file-viewer" data-file-viewer-slot={slotViewerKey} style={{ height: "100%", overflow: "auto" }}>
          {renderSlot("workbench.fileViewer", viewerProps, { key: slotViewerKey })}
        </div>
      );
    }
    if (legacyViewer !== undefined) {
      return (
        <div className="pid-wb-plugin-file-viewer" style={{ height: "100%", overflow: "auto" }}>
          <LegacyContributionHost
            pluginId={legacyViewer.pluginId ?? legacyViewer.id}
            entryId={legacyViewer.id}
            slotKey="file.viewer"
            renderFn={legacyViewer.render}
            context={{
              cwd: file.cwd || cwd,
              sessionFile,
              path: file.path,
              content: file.content,
              isBinary: file.isBinary,
              mimeType: file.mimeType,
              dataBase64: file.data,
              size: file.size,
            }}
          />
        </div>
      );
    }
    if (isImage && file.data !== undefined) {
      return (
        <div className="pid-wb-image-preview">
          <img src={`data:${file.mimeType ?? "image/png"};base64,${file.data}`} alt={file.path} />
        </div>
      );
    }
    if (isMarkdown) {
      return (
        <div className="pid-wb-scroll" style={{ padding: "12px 16px" }}>
          <Markdown content={file.content} />
        </div>
      );
    }
    return <pre className="pid-wb-code-preview">{file.content}</pre>;
  };

  const renderCodeEditor = (file: OpenWorkbenchFile): ReactElement => (
    <textarea
      className="pid-wb-code-textarea"
      aria-label={`编辑 ${file.path}`}
      value={file.content}
      readOnly={file.truncated === true}
      onChange={(event) => workbenchService?.updateFileContent(file.path, event.target.value, file.cwd || cwd)}
      onKeyDown={(event) => {
        if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "s") {
          event.preventDefault();
          void handleSave();
        }
      }}
      style={{
        width: "100%",
        height: "100%",
        border: "none",
        resize: "none",
        padding: "12px",
        fontFamily: "var(--qj-font-mono, monospace)",
        fontSize: "12.5px",
        lineHeight: 1.5,
        background: "transparent",
        color: "inherit",
        outline: "none",
      }}
    />
  );

  const hasOpenFiles = activeFile !== null;
  const isDirty = activeFile !== null && activeFile.content !== activeFile.savedContent;

  return (
    <div
      className={`pid-wb-code-workspace${hasOpenFiles ? " has-open-files" : " is-empty-editor"}${fileDrawerOpen ? " has-tree" : ""}`}
      data-core-workbench-pane="files"
    >
      <div className={`pid-wb-code-main${hasOpenFiles ? "" : " is-empty"}`}>
        {activeFile !== null ? (
          <div className="pid-wb-pane">
            <div className="pid-wb-editor-tabs" role="tablist" aria-label="已打开文件">
              {workspaceFiles.map((file) => {
                const dirty = file.content !== file.savedContent;
                const active = file.path === activeFile.path;
                const fileName = file.path.split(/[\\/]/).pop() ?? file.path;
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
                      onClick={() => workbenchService?.selectFile(file.path, file.cwd || cwd)}
                    >
                      <span>{fileName}</span>
                      {dirty && <span className="pid-wb-dirty-dot" aria-label="未保存" />}
                    </button>
                    <button
                      type="button"
                      className="pid-wb-editor-tab-close"
                      title="关闭文件"
                      onClick={() => workbenchService?.closeFile(file.path, file.cwd || cwd)}
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
                {canPreview && !activeFile.isBinary && (
                  <div className="pid-wb-view-seg" role="tablist" aria-label="文件视图模式">
                    <button
                      type="button"
                      role="tab"
                      aria-selected={effectiveMode === "preview"}
                      className={`pid-wb-view-seg-btn${effectiveMode === "preview" ? " active" : ""}`}
                      onClick={() => setViewModeByPath((prev) => ({ ...prev, [activeFile.path]: "preview" }))}
                    >
                      <Eye size={12} />
                      <span>预览</span>
                    </button>
                    <button
                      type="button"
                      role="tab"
                      aria-selected={effectiveMode === "split"}
                      className={`pid-wb-view-seg-btn${effectiveMode === "split" ? " active" : ""}`}
                      onClick={() => setViewModeByPath((prev) => ({ ...prev, [activeFile.path]: "split" }))}
                    >
                      <Columns2 size={12} />
                      <span>分栏</span>
                    </button>
                    <button
                      type="button"
                      role="tab"
                      aria-selected={effectiveMode === "code"}
                      className={`pid-wb-view-seg-btn${effectiveMode === "code" ? " active" : ""}`}
                      onClick={() => setViewModeByPath((prev) => ({ ...prev, [activeFile.path]: "code" }))}
                    >
                      <Code2 size={12} />
                      <span>源码</span>
                    </button>
                  </div>
                )}
                <button
                  type="button"
                  className="pid-wb-icon-btn"
                  title="在外部默认应用中打开"
                  onClick={() => void workspaceService?.openExternal(activeFile.path)}
                >
                  <ExternalLink size={13} />
                </button>
                {!activeFile.isBinary && activeFile.truncated !== true && (
                  <button
                    type="button"
                    className={`pid-wb-btn small${isDirty ? " primary" : ""}`}
                    disabled={!isDirty || activeFile.saving === true}
                    title="保存文件 (Ctrl+S)"
                    onClick={() => void handleSave()}
                  >
                    <Save size={12} />
                    <span>{activeFile.saving === true ? "保存中…" : "保存"}</span>
                  </button>
                )}
              </div>
            </div>

            <div className="pid-wb-editor-body">
              {activeFile.loading === true ? (
                <div className="pid-wb-empty">正在读取 {activeFile.path}…</div>
              ) : activeFile.error !== undefined && activeFile.error !== "" ? (
                <div className="pid-wb-empty error">{activeFile.error}</div>
              ) : effectiveMode === "preview" && canPreview ? (
                renderPreviewBody(activeFile)
              ) : effectiveMode === "split" && canPreview ? (
                <div className="pid-wb-split-view">
                  <div className="pid-wb-split-pane is-code">{renderCodeEditor(activeFile)}</div>
                  <div className="pid-wb-split-pane is-preview">{renderPreviewBody(activeFile)}</div>
                </div>
              ) : activeFile.isBinary ? (
                <div className="pid-wb-empty">
                  <p>二进制文件无法直接作为文本编辑（{(activeFile.size / 1024).toFixed(1)} KB）</p>
                </div>
              ) : (
                renderCodeEditor(activeFile)
              )}
            </div>
          </div>
        ) : (
          <div className="pid-wb-empty pid-wb-claude-empty">
            <Folder size={22} strokeWidth={1.45} className="pid-wb-empty-icon" />
            <strong>打开的文件将显示在此处</strong>
            <p>
              {fileDrawerOpen
                ? "在右侧文件树中选择文件，或点击对话中的文件路径。"
                : "点击对话中的文件路径，或展开右侧文件树选择文件。"}
            </p>
            {!fileDrawerOpen && (
              <button
                type="button"
                className="pid-wb-btn small"
                onClick={() => workbenchService?.setFileDrawerOpen(true)}
              >
                展开文件树
              </button>
            )}
          </div>
        )}
      </div>

      {fileDrawerOpen && (
        <CoreWorkspaceFileTree
          cwd={cwd}
          activeFilePath={activeFile?.path ?? null}
          workspaceService={workspaceService}
          workbenchService={workbenchService}
        />
      )}
    </div>
  );
}

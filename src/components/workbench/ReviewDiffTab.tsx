import { useCallback, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { GitBranch, Minus, Plus, RefreshCw, RotateCcw, Sparkles } from "lucide-react";
import { agent } from "../../lib/agent";
import { deriveLatestCodeReviewComments, type CodeReviewScope } from "../../lib/codeReview";
import {
  OVERSIZED_DIFF_THRESHOLD,
  diffStats,
  displayPath,
  parseUnifiedDiff,
  unifiedSegments,
  type ParsedDiffFile,
} from "../../lib/diffView";
import { describeError } from "../../lib/errors";
import { changesEditedBy, sessionEditedPaths } from "../../lib/sessionEdits";
import { useAppStore } from "../../store";
import {
  selectDraftCommentsForCwd,
  useWorkbenchLayoutStore,
} from "../../stores/workbenchLayoutStore";
import { useWorkbenchStore } from "../../stores/workbenchStore";
import type { GitFileChange, GitSnapshot } from "../../types";
import { DiffFileCard, type ComposingCommentTarget } from "./DiffFileCard";
import { DraftReviewSubmitBar, normalizeReviewPath } from "./DiffInlineComments";

export interface ReviewDiffTabProps {
  cwd: string;
  git: GitSnapshot | null;
  onRefreshGit: () => Promise<void>;
  onRestoreFiles: (paths?: string[]) => Promise<void>;
  onRequestReview: (scope?: CodeReviewScope) => void;
}

type DiffFilter = "uncommitted" | "session" | "staged" | "unstaged" | "base-branch";

function resolvedFilePath(file: ParsedDiffFile): string {
  const next = displayPath(file.newPath);
  if (next && next !== "/dev/null") return next;
  return displayPath(file.oldPath);
}

/** Fast 32-bit FNV-1a content fingerprint so equal-length diff edits never collide in React Query. */
function hashDiffSignature(diffText: string | undefined, files: readonly GitFileChange[] | undefined): string {
  let hash = 0x811c9dc5;
  const raw = diffText ?? "";
  for (let i = 0; i < raw.length; i += 1) {
    hash ^= raw.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  for (const file of files ?? []) {
    const entry = `${file.status}:${Number(Boolean(file.staged))}:${Number(Boolean(file.unstaged))}:${file.path}`;
    for (let i = 0; i < entry.length; i += 1) {
      hash ^= entry.charCodeAt(i);
      hash = Math.imul(hash, 0x01000193);
    }
  }
  return `${raw.length}:${files?.length ?? 0}:${(hash >>> 0).toString(16)}`;
}

export function ReviewDiffTab({
  cwd,
  git,
  onRefreshGit,
  onRestoreFiles,
  onRequestReview,
}: ReviewDiffTabProps) {
  const [filter, setFilter] = useState<DiffFilter>("uncommitted");
  const [collapsedPaths, setCollapsedPaths] = useState<Record<string, boolean>>({});
  const [expandedOversized, setExpandedOversized] = useState<Record<string, boolean>>({});
  const [busyPath, setBusyPath] = useState<string | null>(null);
  const [composingTarget, setComposingTarget] = useState<ComposingCommentTarget | null>(null);

  const messages = useAppStore((state) => state.messages);
  const draftComments = useWorkbenchLayoutStore((state) => selectDraftCommentsForCwd(state, cwd));
  const upsertDraftComment = useWorkbenchLayoutStore((state) => state.upsertDraftComment);
  const removeDraftComment = useWorkbenchLayoutStore((state) => state.removeDraftComment);
  const clearDraftComments = useWorkbenchLayoutStore((state) => state.clearDraftComments);

  const diffSignature = useMemo(
    () => hashDiffSignature(git?.diff, git?.files),
    [git?.diff, git?.files],
  );

  const defaultBranchQuery = useQuery({
    queryKey: ["workbench-default-branch", cwd],
    queryFn: () => agent.gitDefaultBranch(cwd),
    enabled: Boolean(cwd) && Boolean(git?.isRepository),
    staleTime: 60_000,
  });

  const baseBranch = defaultBranchQuery.data && defaultBranchQuery.data !== git?.branch
    ? defaultBranchQuery.data
    : null;
  const effectiveFilter: DiffFilter = filter === "base-branch" && !baseBranch ? "uncommitted" : filter;

  const filteredSnapshotQuery = useQuery({
    queryKey: ["workbench-review", cwd, effectiveFilter, baseBranch ?? "", diffSignature],
    queryFn: () => {
      if (effectiveFilter === "base-branch" && baseBranch) {
        return agent.gitCompare(cwd, baseBranch);
      }
      return agent.gitReviewSnapshot(cwd, effectiveFilter === "staged" ? "staged" : "unstaged");
    },
    enabled: Boolean(cwd) && Boolean(git?.isRepository) && (
      effectiveFilter === "staged"
      || effectiveFilter === "unstaged"
      || (effectiveFilter === "base-branch" && Boolean(baseBranch))
    ),
    staleTime: 3_000,
  });

  const sessionChangedFiles = useMemo(
    () => changesEditedBy(git?.files ?? [], sessionEditedPaths(messages)),
    [git?.files, messages],
  );
  const sessionPathSet = useMemo(
    () => new Set(sessionChangedFiles.map((file) => normalizeReviewPath(file.path))),
    [sessionChangedFiles],
  );

  const activeSnapshot = (effectiveFilter === "uncommitted" || effectiveFilter === "session")
    ? git
    : (filteredSnapshotQuery.data ?? null);

  const preparedFiles = useMemo(() => {
    const rawDiff = activeSnapshot?.diff ?? "";
    if (!rawDiff.trim()) return [];
    const parsed = parseUnifiedDiff(rawDiff).files.map((file) => {
      const path = resolvedFilePath(file);
      const segments = unifiedSegments(file);
      const stats = diffStats(segments);
      const totalRows = segments.reduce(
        (sum, seg) => sum + (seg.kind === "hunk" ? seg.rows.length : 1),
        0,
      );
      return { file, path, segments, stats, totalRows };
    });
    if (effectiveFilter === "session") {
      return parsed.filter((item) => sessionPathSet.has(normalizeReviewPath(item.path)));
    }
    return parsed;
  }, [activeSnapshot?.diff, effectiveFilter, sessionPathSet]);

  const fileChangeMap = useMemo(() => {
    const map = new Map<string, GitFileChange>();
    for (const file of git?.files ?? []) {
      map.set(file.path.replace(/\\/g, "/"), file);
    }
    return map;
  }, [git?.files]);

  const activeReviewScope = useMemo<CodeReviewScope>(
    () => (effectiveFilter === "base-branch" && baseBranch
      ? { mode: "base-branch", baseBranch }
      : { mode: "uncommitted" }),
    [baseBranch, effectiveFilter],
  );

  const aiComments = useMemo(
    () => deriveLatestCodeReviewComments(messages, activeReviewScope),
    [activeReviewScope, messages],
  );

  const handleRefresh = useCallback(async () => {
    await onRefreshGit();
    if (effectiveFilter === "staged" || effectiveFilter === "unstaged" || effectiveFilter === "base-branch") {
      await filteredSnapshotQuery.refetch();
    }
  }, [effectiveFilter, filteredSnapshotQuery, onRefreshGit]);

  const handleStageToggle = useCallback(async (path: string, stage: boolean) => {
    if (!cwd) return;
    setBusyPath(path);
    try {
      if (stage) await agent.gitStageFiles(cwd, [path]);
      else await agent.gitUnstageFiles(cwd, [path]);
      await handleRefresh();
    } catch (error) {
      useAppStore.getState().showToast(describeError(error), "error");
    } finally {
      setBusyPath(null);
    }
  }, [cwd, handleRefresh]);

  if (!cwd) {
    return (
      <div className="pid-wb-empty pid-wb-claude-empty">
        <strong>选择工作区后查看变更</strong>
        <p>在左侧选择项目目录后，将自动跟踪代码改动。</p>
      </div>
    );
  }

  if (!git?.isRepository) {
    return (
      <div className="pid-wb-empty pid-wb-claude-empty">
        <strong>需要 Git 仓库</strong>
        <p>未在当前会话目录检测到 Git 版本库。</p>
      </div>
    );
  }

  const allFiles = git.files;
  if (allFiles.length === 0 && !baseBranch) {
    return (
      <div className="pid-wb-empty pid-wb-claude-empty">
        <strong>当前无代码变更</strong>
        <p>工作区暂无未提交改动，文件修改后将显示在这里。</p>
      </div>
    );
  }
  const stagedCount = allFiles.filter((file) => file.staged).length;
  const unstagedCount = allFiles.filter((file) => file.unstaged || file.untracked).length;
  const filteredFiles = effectiveFilter === "staged"
    ? allFiles.filter((file) => file.staged)
    : effectiveFilter === "unstaged"
      ? allFiles.filter((file) => file.unstaged || file.untracked)
      : effectiveFilter === "session"
        ? sessionChangedFiles
        : effectiveFilter === "base-branch"
          ? (activeSnapshot?.files ?? [])
          : allFiles;

  const isLoadingFiltered = (
    effectiveFilter === "staged" || effectiveFilter === "unstaged" || effectiveFilter === "base-branch"
  ) && filteredSnapshotQuery.isLoading;

  const canRunAiReview = effectiveFilter === "base-branch"
    ? (filteredFiles.length > 0 || preparedFiles.length > 0)
    : allFiles.length > 0;

  return (
    <div className="pid-wb-pane">
      <div className="pid-wb-subbar">
        <div className="pid-wb-filter-pills" role="tablist" aria-label="变更范围">
          <button
            type="button"
            className={`pid-wb-pill${effectiveFilter === "uncommitted" ? " active" : ""}`}
            onClick={() => setFilter("uncommitted")}
          >
            全部 ({allFiles.length})
          </button>
          {(sessionChangedFiles.length > 0 || effectiveFilter === "session") && (
            <button
              type="button"
              className={`pid-wb-pill${effectiveFilter === "session" ? " active" : ""}`}
              onClick={() => setFilter("session")}
            >
              本会话 ({sessionChangedFiles.length})
            </button>
          )}
          <button
            type="button"
            className={`pid-wb-pill${effectiveFilter === "staged" ? " active" : ""}`}
            onClick={() => setFilter("staged")}
          >
            已暂存 ({stagedCount})
          </button>
          <button
            type="button"
            className={`pid-wb-pill${effectiveFilter === "unstaged" ? " active" : ""}`}
            onClick={() => setFilter("unstaged")}
          >
            未暂存 ({unstagedCount})
          </button>
          {baseBranch && (
            <button
              type="button"
              className={`pid-wb-pill${effectiveFilter === "base-branch" ? " active" : ""}`}
              onClick={() => setFilter("base-branch")}
            >
              对比 {baseBranch}
            </button>
          )}
        </div>
        <div className="pid-wb-subbar-actions">
          <button
            type="button"
            className="pid-wb-btn small"
            disabled={!canRunAiReview}
            title="使用 AI 审查当前变更"
            onClick={() => onRequestReview(activeReviewScope)}
          >
            <Sparkles size={12} />
            <span>AI 审查</span>
          </button>
          <button
            type="button"
            className="pid-wb-icon-btn"
            title="刷新变更"
            onClick={() => void handleRefresh()}
          >
            <RefreshCw size={13} />
          </button>
        </div>
      </div>

      {git.branch && (
        <div className="pid-wb-meta-strip">
          <GitBranch size={12} />
          <span>{git.branch}</span>
          {effectiveFilter === "base-branch" && baseBranch && (
            <span className="pid-wb-muted">← {baseBranch}</span>
          )}
          {git.sync?.upstream && (
            <span className="pid-wb-muted">
              ↑{git.sync.ahead} ↓{git.sync.behind} ({git.sync.upstream})
            </span>
          )}
          {aiComments.length > 0 && (
            <span className="pid-wb-badge" style={{ marginLeft: "auto" }}>
              AI 发现 {aiComments.length} 处问题
            </span>
          )}
        </div>
      )}

      <div className="pid-wb-scroll">
        {isLoadingFiltered ? (
          <div className="pid-wb-empty">正在读取变更详情…</div>
        ) : effectiveFilter !== "base-branch" && allFiles.length === 0 ? (
          <div className="pid-wb-empty">工作区干净，没有未提交的更改。</div>
        ) : filteredFiles.length === 0 && preparedFiles.length === 0 ? (
          <div className="pid-wb-empty">
            {effectiveFilter === "staged"
              ? "当前没有已暂存的更改。"
              : effectiveFilter === "unstaged"
                ? "当前没有未暂存的更改。"
                : effectiveFilter === "session"
                  ? "当前会话尚未通过编辑工具改动工作区文件。"
                  : `当前分支与 ${baseBranch ?? "主分支"} 相比没有差异。`}
          </div>
        ) : preparedFiles.length === 0 ? (
          <div className="pid-wb-section">
            {filteredFiles.map((change) => (
              <div key={change.path} className="pid-wb-diff-card">
                <div className="pid-wb-diff-header">
                  <button
                    type="button"
                    className="pid-wb-diff-title"
                    onClick={() => void useWorkbenchStore.getState().openFile(cwd, change.path)}
                  >
                    <span className="pid-wb-status-tag">{change.status}</span>
                    <span>{change.path}</span>
                  </button>
                  {effectiveFilter !== "base-branch" && (
                    <div className="pid-wb-subbar-actions">
                      {!change.staged && (
                        <button
                          type="button"
                          className="pid-wb-icon-btn"
                          disabled={busyPath === change.path}
                          title="暂存文件"
                          onClick={() => void handleStageToggle(change.path, true)}
                        >
                          <Plus size={13} />
                        </button>
                      )}
                      {change.staged && (
                        <button
                          type="button"
                          className="pid-wb-icon-btn"
                          disabled={busyPath === change.path}
                          title="取消暂存"
                          onClick={() => void handleStageToggle(change.path, false)}
                        >
                          <Minus size={13} />
                        </button>
                      )}
                      <button
                        type="button"
                        className="pid-wb-icon-btn"
                        title="放弃更改"
                        onClick={() => void onRestoreFiles([change.path])}
                      >
                        <RotateCcw size={13} />
                      </button>
                    </div>
                  )}
                </div>
              </div>
            ))}
          </div>
        ) : (
          <div className="pid-wb-diff-list">
            {preparedFiles.map(({ file, path, segments, stats, totalRows }) => {
              const normalized = path.replace(/\\/g, "/");
              return (
                <DiffFileCard
                  key={`${file.oldPath}->${file.newPath}`}
                  cwd={cwd}
                  file={file}
                  path={path}
                  segments={segments}
                  stats={stats}
                  totalRows={totalRows}
                  isOversized={totalRows > OVERSIZED_DIFF_THRESHOLD && !expandedOversized[path]}
                  collapsed={Boolean(collapsedPaths[path])}
                  allowGitActions={effectiveFilter !== "base-branch"}
                  statusEntry={fileChangeMap.get(normalized)}
                  busy={busyPath === path}
                  draftComments={draftComments}
                  aiComments={aiComments}
                  composingTarget={composingTarget}
                  onToggleCollapse={() => setCollapsedPaths((prev) => ({ ...prev, [path]: !prev[path] }))}
                  onExpandOversized={() => setExpandedOversized((prev) => ({ ...prev, [path]: true }))}
                  onStageToggle={(stage) => void handleStageToggle(path, stage)}
                  onRestoreFile={() => void onRestoreFiles([path])}
                  onStartCompose={setComposingTarget}
                  onSaveDraft={(body, rowLine, rowSide, lineText, editingId) => {
                    upsertDraftComment(cwd, {
                      id: editingId,
                      file: path,
                      line: rowLine,
                      side: rowSide,
                      lineText,
                      body,
                    });
                    setComposingTarget(null);
                  }}
                  onCancelCompose={() => setComposingTarget(null)}
                  onDeleteDraft={(id) => removeDraftComment(cwd, id)}
                />
              );
            })}
          </div>
        )}
      </div>

      <DraftReviewSubmitBar comments={draftComments} onClear={() => clearDraftComments(cwd)} />
    </div>
  );
}

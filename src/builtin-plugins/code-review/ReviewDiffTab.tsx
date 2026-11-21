/**
 * Built-in `code-review` workbench pane (`ReviewDiffTab`) & topbar toggle button (ADR 0023).
 *
 * Wired strictly via `@qianji/client` Frontend Cordis Services — zero internal
 * store imports or host component traversals.
 */
import { useMemo, useState, type ReactElement } from "react";
import { GitBranch, RefreshCw, RotateCcw, Send, Sparkles } from "lucide-react";
import {
  sendChatPrompt,
  showToast,
  useFrontendService,
  useSessionState,
  useWorkbenchState,
  useWorkspaceState,
  type UiMessage,
} from "@qianji/client";
import type {
  SlotComponentProps,
  WorkbenchPaneSlotProps,
  WorkbenchSlotBaseProps,
} from "@qianji/client-slots";
import { DiffFileItemCard, type ComposeTarget } from "./DiffFileItemCard";
import {
  deriveAiReviewComments,
  deriveSessionEditedPaths,
  formatDraftCommentsPrompt,
  matchesReviewPath,
  normalizeReviewPath,
  OVERSIZED_DIFF_THRESHOLD,
  parseUnifiedDiff,
  type LocalDraftComment,
} from "./diffUtils";

type DiffFilter = "uncommitted" | "session" | "staged" | "unstaged";

const EMPTY_MESSAGES: readonly UiMessage[] = [];

function ChangesDiffIcon({ size = 15 }: { readonly size?: number }): ReactElement {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <rect x="2.25" y="2.25" width="11.5" height="11.5" rx="2.4" stroke="currentColor" strokeWidth="1.25" />
      <path d="M5.5 6H10.5M8 4.4V7.6" stroke="currentColor" strokeWidth="1.25" strokeLinecap="round" />
      <path d="M5.5 10.6H10.5" stroke="currentColor" strokeWidth="1.25" strokeLinecap="round" />
    </svg>
  );
}

/** Topbar toggle button registered onto `workbench.topbarControls` by `code-review`. */
export function CodeReviewTopbarButton({
  ctx,
}: SlotComponentProps<WorkbenchSlotBaseProps, "session-maybe">): ReactElement {
  const workbench = useWorkbenchState(ctx);
  const workbenchService = useFrontendService("workbenchService", ctx);
  const isOpen = (workbench?.openPanes ?? []).includes("review");

  return (
    <button
      type="button"
      data-wb-tab="review"
      data-plugin-topbar="code-review"
      className={`pid-wb-top-toggle${isOpen ? " active" : ""}`}
      title="代码变更 (Changes)"
      aria-label="代码变更"
      aria-pressed={isOpen}
      onClick={() => workbenchService?.togglePane("review")}
    >
      <ChangesDiffIcon size={15} />
    </button>
  );
}

/** Keyed `"review"` pane rendered inside `workbench.panes`. */
export function ReviewDiffTab(
  props: SlotComponentProps<WorkbenchPaneSlotProps, "session-maybe">,
): ReactElement {
  const workspace = useWorkspaceState(props.ctx);
  const cwd = props.cwd ?? workspace?.cwd ?? "";
  return props.renderFactory(
    "host.workbench.review",
    { cwd },
    { fallback: <ReviewDiffTabFallback {...props} /> },
  ) as ReactElement;
}

function ReviewDiffTabFallback({
  cwd: propCwd,
  ctx,
}: SlotComponentProps<WorkbenchPaneSlotProps, "session-maybe">): ReactElement {
  const workspace = useWorkspaceState(ctx);
  const session = useSessionState(ctx);
  const workspaceService = useFrontendService("workspaceService", ctx);
  const workbenchService = useFrontendService("workbenchService", ctx);
  const composerService = useFrontendService("composerService", ctx);

  const cwd = propCwd ?? workspace?.cwd ?? "";
  const git = workspace?.git ?? null;
  const messages = session?.messages ?? EMPTY_MESSAGES;

  const [filter, setFilter] = useState<DiffFilter>("uncommitted");
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});
  const [expandedOversized, setExpandedOversized] = useState<Record<string, boolean>>({});
  const [draftComments, setDraftComments] = useState<readonly LocalDraftComment[]>([]);
  const [composing, setComposing] = useState<ComposeTarget | null>(null);
  const [composeText, setComposeText] = useState("");
  const [sending, setSending] = useState(false);

  const sessionPaths = useMemo(() => deriveSessionEditedPaths(messages), [messages]);
  const aiComments = useMemo(() => deriveAiReviewComments(messages), [messages]);
  const parsedFiles = useMemo(() => parseUnifiedDiff(git?.diff ?? ""), [git?.diff]);

  const handleRequestAiReview = () => {
    const prompt = "请审查当前未提交的代码更改，重点检查潜在缺陷、边界条件与回归风险，并使用 ::code-comment 标出具体位置。";
    void sendChatPrompt(prompt);
    showToast("已发起 AI 代码审查", "info");
  };

  const handleSaveComment = () => {
    if (composing === null || composeText.trim() === "") return;
    const created: LocalDraftComment = {
      id: `cr-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
      file: composing.file,
      line: composing.line,
      side: composing.side,
      lineText: composing.lineText,
      body: composeText.trim(),
    };
    setDraftComments((prev) => [...prev, created]);
    setComposing(null);
    setComposeText("");
  };

  const handleSendDrafts = async (prefillOnly: boolean) => {
    const prompt = formatDraftCommentsPrompt(draftComments);
    if (prompt === "" || sending) return;
    if (prefillOnly) {
      if (composerService !== undefined) {
        composerService.prefill(prompt);
        showToast("已填入对话输入框", "info");
      } else {
        await sendChatPrompt(prompt, { prefillOnly: true });
      }
      return;
    }
    setSending(true);
    try {
      const sent = await sendChatPrompt(prompt, { behavior: "followUp" });
      if (sent) {
        setDraftComments([]);
        showToast("已将行内审查批注发送给 Agent", "info");
      }
    } finally {
      setSending(false);
    }
  };

  if (cwd === "") {
    return (
      <div className="pid-wb-empty pid-wb-claude-empty" data-feature-pane="code-review">
        <strong>选择工作区后查看变更</strong>
        <p>在左侧选择项目目录后，将自动跟踪代码改动。</p>
      </div>
    );
  }

  if (git?.isRepository !== true) {
    return (
      <div className="pid-wb-empty pid-wb-claude-empty" data-feature-pane="code-review">
        <strong>需要 Git 仓库</strong>
        <p>未在当前会话目录检测到 Git 版本库。</p>
      </div>
    );
  }

  const allFiles = git.files;
  const stagedFiles = allFiles.filter((file) => file.staged === true);
  const unstagedFiles = allFiles.filter((file) => file.unstaged === true || file.untracked === true);
  const sessionFiles = allFiles.filter((file) => sessionPaths.has(normalizeReviewPath(file.path)));

  const visibleChanges =
    filter === "staged"
      ? stagedFiles
      : filter === "unstaged"
        ? unstagedFiles
        : filter === "session"
          ? sessionFiles
          : allFiles;

  const visiblePathSet = new Set(visibleChanges.map((file) => normalizeReviewPath(file.path)));
  const visibleDiffs =
    filter === "uncommitted"
      ? parsedFiles
      : parsedFiles.filter((item) => visiblePathSet.has(normalizeReviewPath(item.path)));

  return (
    <div className="pid-wb-pane" data-feature-pane="code-review">
      <div className="pid-wb-subbar">
        <div className="pid-wb-filter-pills" role="tablist" aria-label="变更范围">
          <button type="button" className={`pid-wb-pill${filter === "uncommitted" ? " active" : ""}`} onClick={() => setFilter("uncommitted")}>
            全部 ({allFiles.length})
          </button>
          {(sessionFiles.length > 0 || filter === "session") && (
            <button type="button" className={`pid-wb-pill${filter === "session" ? " active" : ""}`} onClick={() => setFilter("session")}>
              本会话 ({sessionFiles.length})
            </button>
          )}
          <button type="button" className={`pid-wb-pill${filter === "staged" ? " active" : ""}`} onClick={() => setFilter("staged")}>
            已暂存 ({stagedFiles.length})
          </button>
          <button type="button" className={`pid-wb-pill${filter === "unstaged" ? " active" : ""}`} onClick={() => setFilter("unstaged")}>
            未暂存 ({unstagedFiles.length})
          </button>
        </div>
        <div className="pid-wb-subbar-actions">
          <button
            type="button"
            className="pid-wb-btn small"
            disabled={allFiles.length === 0}
            title="使用 AI 审查当前变更"
            onClick={handleRequestAiReview}
          >
            <Sparkles size={12} />
            <span>AI 审查</span>
          </button>
          <button type="button" className="pid-wb-icon-btn" title="刷新变更" onClick={() => void workspaceService?.refreshGit(cwd)}>
            <RefreshCw size={13} />
          </button>
        </div>
      </div>

      {git.branch !== undefined && git.branch !== "" && (
        <div className="pid-wb-meta-strip">
          <GitBranch size={12} />
          <span>{git.branch}</span>
          {git.sync?.upstream !== undefined && git.sync.upstream !== "" && (
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
        {allFiles.length === 0 ? (
          <div className="pid-wb-empty pid-wb-claude-empty">
            <strong>当前无代码变更</strong>
            <p>工作区暂无未提交改动，文件修改后将显示在这里。</p>
          </div>
        ) : visibleDiffs.length === 0 ? (
          <div className="pid-wb-section">
            {visibleChanges.length === 0 ? (
              <div className="pid-wb-empty">当前筛选范围内没有变更。</div>
            ) : (
              visibleChanges.map((change) => (
                <div key={change.path} className="pid-wb-diff-card">
                  <div className="pid-wb-diff-header">
                    <button
                      type="button"
                      className="pid-wb-diff-title"
                      onClick={() => void workbenchService?.openFile(change.path, { cwd })}
                    >
                      <span className="pid-wb-status-tag">{change.status}</span>
                      <span>{change.path}</span>
                    </button>
                    <button
                      type="button"
                      className="pid-wb-icon-btn"
                      title="放弃更改"
                      onClick={() => void workspaceService?.restoreGitFiles([change.path], cwd)}
                    >
                      <RotateCcw size={13} />
                    </button>
                  </div>
                </div>
              ))
            )}
          </div>
        ) : (
          <div className="pid-wb-diff-list">
            {visibleDiffs.map((file) => (
              <DiffFileItemCard
                key={`${file.oldPath}->${file.newPath}`}
                file={file}
                collapsed={collapsed[file.path] === true}
                isOversized={file.totalRows > OVERSIZED_DIFF_THRESHOLD && expandedOversized[file.path] !== true}
                aiComments={aiComments.filter((item) => matchesReviewPath(item.file, file.path))}
                draftComments={draftComments.filter((item) => matchesReviewPath(item.file, file.path))}
                composing={composing}
                composeText={composeText}
                onToggleCollapse={() => setCollapsed((prev) => ({ ...prev, [file.path]: prev[file.path] !== true }))}
                onExpandOversized={() => setExpandedOversized((prev) => ({ ...prev, [file.path]: true }))}
                onOpenFile={() => void workbenchService?.openFile(file.path, { cwd })}
                onRestoreFile={() => void workspaceService?.restoreGitFiles([file.path], cwd)}
                onStartCompose={(target) => {
                  setComposing(target);
                  setComposeText("");
                }}
                onChangeComposeText={setComposeText}
                onCancelCompose={() => setComposing(null)}
                onSaveCompose={handleSaveComment}
                onDeleteDraft={(id) => setDraftComments((prev) => prev.filter((item) => item.id !== id))}
              />
            ))}
          </div>
        )}
      </div>

      {draftComments.length > 0 && (
        <div className="pid-wb-review-submit-bar" role="region" aria-label="批注汇总操作栏">
          <div className="pid-wb-review-submit-info">
            <span className="pid-wb-badge">{draftComments.length} 条批注</span>
          </div>
          <div className="pid-wb-subbar-actions">
            <button type="button" className="pid-wb-btn small" onClick={() => setDraftComments([])}>
              清空
            </button>
            <button type="button" className="pid-wb-btn small" onClick={() => void handleSendDrafts(true)}>
              填入输入框
            </button>
            <button
              type="button"
              className="pid-wb-btn small primary"
              disabled={sending}
              onClick={() => void handleSendDrafts(false)}
            >
              <Send size={12} />
              <span>{sending ? "发送中…" : "发送给 Agent 修改"}</span>
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

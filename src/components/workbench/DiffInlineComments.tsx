import { useState, type KeyboardEvent } from "react";
import { Check, MessageSquarePlus, Pencil, Send, Sparkles, Trash2, X } from "lucide-react";
import type { CodeReviewComment } from "../../lib/codeReview";
import {
  dispatchWorkbenchPrompt,
  formatDraftDiffCommentsPrompt,
  type DraftDiffComment,
} from "../../stores/workbenchLayoutStore";

export function normalizeReviewPath(path: string): string {
  return path.trim().replace(/\\/g, "/").replace(/^\.\//, "").toLowerCase();
}

export function matchesDiffCommentPath(commentFile: string, diffFilePath: string): boolean {
  const left = normalizeReviewPath(commentFile);
  const right = normalizeReviewPath(diffFilePath);
  if (!left || !right) return false;
  return left === right || left.endsWith(`/${right}`) || right.endsWith(`/${left}`);
}

export function partitionAiCommentsForFile(
  comments: readonly CodeReviewComment[],
  diffFilePath: string,
): { byLine: Map<number, CodeReviewComment[]>; fileLevel: CodeReviewComment[] } {
  const byLine = new Map<number, CodeReviewComment[]>();
  const fileLevel: CodeReviewComment[] = [];
  for (const comment of comments) {
    if (!matchesDiffCommentPath(comment.file, diffFilePath)) continue;
    if (comment.start !== null && comment.start > 0) {
      const bucket = byLine.get(comment.start);
      if (bucket) bucket.push(comment);
      else byLine.set(comment.start, [comment]);
    } else {
      fileLevel.push(comment);
    }
  }
  return { byLine, fileLevel };
}

export interface InlineCommentComposerProps {
  file: string;
  line: number;
  side: "new" | "old";
  initialValue?: string;
  onSave: (body: string) => void;
  onCancel: () => void;
}

export function InlineCommentComposer({
  file,
  line,
  side,
  initialValue = "",
  onSave,
  onCancel,
}: InlineCommentComposerProps) {
  const [body, setBody] = useState(initialValue);

  const submit = () => {
    const trimmed = body.trim();
    if (!trimmed) return;
    onSave(trimmed);
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if ((event.ctrlKey || event.metaKey) && event.key === "Enter") {
      event.preventDefault();
      submit();
    } else if (event.key === "Escape") {
      event.preventDefault();
      onCancel();
    }
  };

  return (
    <div className="pid-wb-inline-comment-box is-composer" role="region" aria-label={`在 ${file} 第 ${line} 行添加批注`}>
      <div className="pid-wb-inline-comment-head">
        <span className="pid-wb-inline-comment-tag">
          <MessageSquarePlus size={12} />
          <span>{side === "old" ? `旧行 ${line}` : `第 ${line} 行`}批注</span>
        </span>
        <button
          type="button"
          className="pid-wb-icon-btn"
          title="取消 (Esc)"
          onClick={onCancel}
        >
          <X size={12} />
        </button>
      </div>
      <textarea
        autoFocus
        rows={2}
        className="pid-wb-inline-comment-input"
        placeholder="描述希望 Agent 修改的内容（Ctrl+Enter 保存）…"
        value={body}
        onChange={(event) => setBody(event.target.value)}
        onKeyDown={handleKeyDown}
      />
      <div className="pid-wb-inline-comment-actions">
        <button type="button" className="pid-wb-btn small" onClick={onCancel}>
          取消
        </button>
        <button
          type="button"
          className="pid-wb-btn small primary"
          disabled={body.trim() === ""}
          onClick={submit}
        >
          <Check size={12} />
          <span>保存批注</span>
        </button>
      </div>
    </div>
  );
}

export interface UserDraftCommentCardProps {
  comment: DraftDiffComment;
  onEdit: () => void;
  onDelete: () => void;
}

export function UserDraftCommentCard({ comment, onEdit, onDelete }: UserDraftCommentCardProps) {
  return (
    <div className="pid-wb-inline-comment-box is-user">
      <div className="pid-wb-inline-comment-head">
        <span className="pid-wb-inline-comment-tag">
          <MessageSquarePlus size={12} />
          <span>待发送批注 · {comment.side === "old" ? `旧 L${comment.line}` : `L${comment.line}`}</span>
        </span>
        <div className="pid-wb-subbar-actions">
          <button type="button" className="pid-wb-icon-btn" title="编辑批注" onClick={onEdit}>
            <Pencil size={11} />
          </button>
          <button type="button" className="pid-wb-icon-btn" title="删除批注" onClick={onDelete}>
            <Trash2 size={11} />
          </button>
        </div>
      </div>
      <p className="pid-wb-inline-comment-body">{comment.body}</p>
    </div>
  );
}

export interface AiReviewCommentCardProps {
  comment: CodeReviewComment;
}

export function AiReviewCommentCard({ comment }: AiReviewCommentCardProps) {
  const lineLabel = comment.start !== null
    ? comment.end && comment.end !== comment.start
      ? `L${comment.start}-${comment.end}`
      : `L${comment.start}`
    : null;

  const handleAskAgentToFix = () => {
    const loc = lineLabel ? `${comment.file}:${lineLabel}` : comment.file;
    const prompt = [
      `请修复代码审查中指出的问题（${loc}）：`,
      `**${comment.title}**`,
      comment.body,
    ].join("\n\n");
    void dispatchWorkbenchPrompt(prompt);
  };

  return (
    <div className="pid-wb-inline-comment-box is-ai" data-ai-review-comment={comment.id}>
      <div className="pid-wb-inline-comment-head">
        <span className="pid-wb-inline-comment-tag is-ai">
          <Sparkles size={12} />
          {comment.priority !== null && (
            <span className={`pid-wb-priority-pill p${Math.min(Math.max(comment.priority, 0), 3)}`}>
              P{comment.priority}
            </span>
          )}
          <span>{comment.title}</span>
          {lineLabel && <span className="pid-wb-muted">{lineLabel}</span>}
        </span>
        <button
          type="button"
          className="pid-wb-btn small"
          onClick={handleAskAgentToFix}
        >
          让 Agent 修复
        </button>
      </div>
      <p className="pid-wb-inline-comment-body">{comment.body}</p>
    </div>
  );
}

export interface DraftReviewSubmitBarProps {
  comments: readonly DraftDiffComment[];
  onClear: () => void;
}

export function DraftReviewSubmitBar({ comments, onClear }: DraftReviewSubmitBarProps) {
  const [sending, setSending] = useState(false);

  if (comments.length === 0) return null;

  const prompt = formatDraftDiffCommentsPrompt(comments);

  const handleSend = async () => {
    if (sending) return;
    setSending(true);
    try {
      const sent = await dispatchWorkbenchPrompt(prompt);
      if (sent) onClear();
    } finally {
      setSending(false);
    }
  };

  return (
    <div className="pid-wb-review-submit-bar" role="region" aria-label="批注汇总操作栏">
      <div className="pid-wb-review-submit-info">
        <span className="pid-wb-badge">{comments.length} 条批注</span>
        <span className="pid-wb-muted">将合并为一轮指令发给当前对话</span>
      </div>
      <div className="pid-wb-subbar-actions">
        <button type="button" className="pid-wb-btn small" onClick={onClear}>
          清空
        </button>
        <button
          type="button"
          className="pid-wb-btn small"
          onClick={() => void dispatchWorkbenchPrompt(prompt, { prefillOnly: true })}
        >
          填入输入框
        </button>
        <button
          type="button"
          className="pid-wb-btn small primary"
          disabled={sending}
          onClick={() => void handleSend()}
        >
          <Send size={12} />
          <span>{sending ? "发送中…" : "发送给 Agent 修改"}</span>
        </button>
      </div>
    </div>
  );
}

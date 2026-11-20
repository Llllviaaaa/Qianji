/**
 * Per-file unified diff card with inline AI findings and user draft comments
 * (`src/builtin-plugins/code-review/DiffFileItemCard.tsx`, ADR 0023).
 */
import { Fragment, type ReactElement } from "react";
import {
  Check,
  ChevronDown,
  ChevronRight,
  FileCode2,
  MessageSquarePlus,
  Plus,
  RotateCcw,
  Sparkles,
  Trash2,
  X,
} from "lucide-react";
import type {
  AiCodeReviewComment,
  LocalDraftComment,
  ParsedDiffFile,
} from "./diffUtils";

export interface ComposeTarget {
  readonly file: string;
  readonly line: number;
  readonly side: "new" | "old";
  readonly lineText: string;
}

export interface DiffFileItemCardProps {
  readonly file: ParsedDiffFile;
  readonly collapsed: boolean;
  readonly isOversized: boolean;
  readonly aiComments: readonly AiCodeReviewComment[];
  readonly draftComments: readonly LocalDraftComment[];
  readonly composing: ComposeTarget | null;
  readonly composeText: string;
  readonly onToggleCollapse: () => void;
  readonly onExpandOversized: () => void;
  readonly onOpenFile: () => void;
  readonly onRestoreFile: () => void;
  readonly onStartCompose: (target: ComposeTarget) => void;
  readonly onChangeComposeText: (text: string) => void;
  readonly onCancelCompose: () => void;
  readonly onSaveCompose: () => void;
  readonly onDeleteDraft: (id: string) => void;
}

export function DiffFileItemCard({
  file,
  collapsed,
  isOversized,
  aiComments,
  draftComments,
  composing,
  composeText,
  onToggleCollapse,
  onExpandOversized,
  onOpenFile,
  onRestoreFile,
  onStartCompose,
  onChangeComposeText,
  onCancelCompose,
  onSaveCompose,
  onDeleteDraft,
}: DiffFileItemCardProps): ReactElement {
  return (
    <div className="pid-wb-diff-card">
      <div className="pid-wb-diff-header">
        <button type="button" className="pid-wb-diff-title" onClick={onToggleCollapse}>
          {collapsed ? <ChevronRight size={13} /> : <ChevronDown size={13} />}
          <span className="pid-wb-diff-path" title={file.path}>{file.path}</span>
          {(file.added > 0 || file.deleted > 0) && (
            <span className="pid-wb-diff-counts">
              {file.added > 0 && <em className="add">+{file.added}</em>}
              {file.deleted > 0 && <em className="del">−{file.deleted}</em>}
            </span>
          )}
          {draftComments.length > 0 && <span className="pid-wb-badge">{draftComments.length} 批注</span>}
        </button>
        <div className="pid-wb-subbar-actions">
          <button type="button" className="pid-wb-icon-btn" title="在编辑器中打开" onClick={onOpenFile}>
            <FileCode2 size={13} />
          </button>
          <button type="button" className="pid-wb-icon-btn" title="放弃此文件更改" onClick={onRestoreFile}>
            <RotateCcw size={13} />
          </button>
        </div>
      </div>

      {!collapsed && (
        file.binary ? (
          <div className="pid-wb-diff-notice">二进制文件已更改</div>
        ) : isOversized ? (
          <div className="pid-wb-diff-notice">
            <span>差异较大（{file.totalRows} 行），已默认折叠。</span>
            <button type="button" className="pid-wb-btn small" onClick={onExpandOversized}>
              展开完整差异
            </button>
          </div>
        ) : (
          <div className="pid-wb-diff-table">
            {aiComments.map((comment) => (
              <div key={comment.id} className="pid-wb-inline-comment-box is-ai">
                <div className="pid-wb-inline-comment-head">
                  <span className="pid-wb-inline-comment-tag is-ai">
                    <Sparkles size={12} />
                    <span>{comment.title}</span>
                  </span>
                </div>
                <p className="pid-wb-inline-comment-body">{comment.body}</p>
              </div>
            ))}
            {file.hunks.map((hunk, hIdx) => (
              <Fragment key={`h-${hIdx}`}>
                {hunk.rows.map((row, rIdx) => {
                  const line = row.newLine ?? row.oldLine ?? 1;
                  const side: "new" | "old" = row.newLine !== undefined ? "new" : "old";
                  const lineDrafts = draftComments.filter((d) => d.line === line && d.side === side);
                  const isComposingHere =
                    composing !== null &&
                    composing.file === file.path &&
                    composing.line === line &&
                    composing.side === side;

                  return (
                    <Fragment key={`r-${hIdx}-${rIdx}`}>
                      <div className={`pid-wb-diff-row kind-${row.kind}`}>
                        {row.kind !== "meta" ? (
                          <button
                            type="button"
                            className="pid-wb-diff-comment-trigger"
                            title={`在第 ${line} 行添加批注`}
                            onClick={() => onStartCompose({ file: file.path, line, side, lineText: row.text })}
                          >
                            <Plus size={11} />
                          </button>
                        ) : (
                          <span />
                        )}
                        <span className="pid-wb-diff-ln">{row.oldLine ?? ""}</span>
                        <span className="pid-wb-diff-ln">{row.newLine ?? ""}</span>
                        <span className="pid-wb-diff-sign">
                          {row.kind === "add" ? "+" : row.kind === "del" ? "−" : " "}
                        </span>
                        <span className="pid-wb-diff-code">{row.text}</span>
                      </div>
                      {lineDrafts.map((draft) => (
                        <div key={draft.id} className="pid-wb-inline-comment-box is-user">
                          <div className="pid-wb-inline-comment-head">
                            <span className="pid-wb-inline-comment-tag">
                              <MessageSquarePlus size={12} />
                              <span>待发送批注 · L{draft.line}</span>
                            </span>
                            <button
                              type="button"
                              className="pid-wb-icon-btn"
                              title="删除批注"
                              onClick={() => onDeleteDraft(draft.id)}
                            >
                              <Trash2 size={11} />
                            </button>
                          </div>
                          <p className="pid-wb-inline-comment-body">{draft.body}</p>
                        </div>
                      ))}
                      {isComposingHere && (
                        <div className="pid-wb-inline-comment-box is-composer">
                          <div className="pid-wb-inline-comment-head">
                            <span>第 {line} 行批注</span>
                            <button type="button" className="pid-wb-icon-btn" onClick={onCancelCompose}>
                              <X size={12} />
                            </button>
                          </div>
                          <textarea
                            rows={2}
                            className="pid-wb-inline-comment-input"
                            placeholder="描述希望 Agent 修改的内容…"
                            value={composeText}
                            onChange={(event) => onChangeComposeText(event.target.value)}
                          />
                          <div className="pid-wb-inline-comment-actions">
                            <button type="button" className="pid-wb-btn small" onClick={onCancelCompose}>
                              取消
                            </button>
                            <button
                              type="button"
                              className="pid-wb-btn small primary"
                              disabled={composeText.trim() === ""}
                              onClick={onSaveCompose}
                            >
                              <Check size={12} />
                              <span>保存批注</span>
                            </button>
                          </div>
                        </div>
                      )}
                    </Fragment>
                  );
                })}
              </Fragment>
            ))}
          </div>
        )
      )}
    </div>
  );
}

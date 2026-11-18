import { Fragment } from "react";
import { ChevronDown, ChevronRight, FileCode2, Minus, Plus, RotateCcw } from "lucide-react";
import type { CodeReviewComment } from "../../lib/codeReview";
import type { DiffSegment, ParsedDiffFile } from "../../lib/diffView";
import type { DraftDiffComment } from "../../stores/workbenchLayoutStore";
import { useWorkbenchStore } from "../../stores/workbenchStore";
import type { GitFileChange } from "../../types";
import {
  AiReviewCommentCard,
  InlineCommentComposer,
  UserDraftCommentCard,
  matchesDiffCommentPath,
  partitionAiCommentsForFile,
} from "./DiffInlineComments";

export interface ComposingCommentTarget {
  file: string;
  line: number;
  side: "new" | "old";
  lineText: string;
  editingId?: string;
  initialValue?: string;
}

export interface DiffFileCardProps {
  cwd: string;
  file: ParsedDiffFile;
  path: string;
  segments: readonly DiffSegment[];
  stats: { added: number; deleted: number };
  totalRows: number;
  isOversized: boolean;
  collapsed: boolean;
  allowGitActions: boolean;
  statusEntry?: GitFileChange;
  busy: boolean;
  draftComments: readonly DraftDiffComment[];
  aiComments: readonly CodeReviewComment[];
  composingTarget: ComposingCommentTarget | null;
  onToggleCollapse: () => void;
  onExpandOversized: () => void;
  onStageToggle: (stage: boolean) => void;
  onRestoreFile: () => void;
  onStartCompose: (target: ComposingCommentTarget) => void;
  onSaveDraft: (body: string, rowLine: number, rowSide: "new" | "old", lineText: string, editingId?: string) => void;
  onCancelCompose: () => void;
  onDeleteDraft: (id: string) => void;
}

export function DiffFileCard({
  cwd,
  file,
  path,
  segments,
  stats,
  totalRows,
  isOversized,
  collapsed,
  allowGitActions,
  statusEntry,
  busy,
  draftComments,
  aiComments,
  composingTarget,
  onToggleCollapse,
  onExpandOversized,
  onStageToggle,
  onRestoreFile,
  onStartCompose,
  onSaveDraft,
  onCancelCompose,
  onDeleteDraft,
}: DiffFileCardProps) {
  const fileDrafts = draftComments.filter((item) => matchesDiffCommentPath(item.file, path));
  const { byLine: aiByLine, fileLevel: aiFileLevel } = partitionAiCommentsForFile(aiComments, path);

  const displayedNewLines = new Set<number>();
  const displayedOldLines = new Set<number>();
  for (const seg of segments) {
    if (seg.kind !== "hunk") continue;
    for (const r of seg.rows) {
      if (r.newLine !== undefined) displayedNewLines.add(r.newLine);
      if (r.oldLine !== undefined) displayedOldLines.add(r.oldLine);
    }
  }
  const unanchoredAiComments = [...aiFileLevel];
  for (const [lineNum, items] of aiByLine.entries()) {
    if (!displayedNewLines.has(lineNum) && !displayedOldLines.has(lineNum)) {
      unanchoredAiComments.push(...items);
    }
  }

  return (
    <div className="pid-wb-diff-card">
      <div className="pid-wb-diff-header">
        <button type="button" className="pid-wb-diff-title" onClick={onToggleCollapse}>
          {collapsed ? <ChevronRight size={13} /> : <ChevronDown size={13} />}
          <span className="pid-wb-diff-path" title={path}>{path}</span>
          {(stats.added > 0 || stats.deleted > 0) && (
            <span className="pid-wb-diff-counts">
              {stats.added > 0 && <em className="add">+{stats.added}</em>}
              {stats.deleted > 0 && <em className="del">−{stats.deleted}</em>}
            </span>
          )}
          {fileDrafts.length > 0 && <span className="pid-wb-badge">{fileDrafts.length} 批注</span>}
        </button>
        <div className="pid-wb-subbar-actions">
          <button
            type="button"
            className="pid-wb-icon-btn"
            title="在编辑器中打开"
            onClick={() => void useWorkbenchStore.getState().openFile(cwd, path)}
          >
            <FileCode2 size={13} />
          </button>
          {allowGitActions && statusEntry && !statusEntry.staged && (
            <button
              type="button"
              className="pid-wb-icon-btn"
              disabled={busy}
              title="暂存文件"
              onClick={() => onStageToggle(true)}
            >
              <Plus size={13} />
            </button>
          )}
          {allowGitActions && statusEntry?.staged && (
            <button
              type="button"
              className="pid-wb-icon-btn"
              disabled={busy}
              title="取消暂存"
              onClick={() => onStageToggle(false)}
            >
              <Minus size={13} />
            </button>
          )}
          {allowGitActions && (
            <button
              type="button"
              className="pid-wb-icon-btn"
              title="放弃此文件更改"
              onClick={onRestoreFile}
            >
              <RotateCcw size={13} />
            </button>
          )}
        </div>
      </div>

      {!collapsed && (
        <>
          {unanchoredAiComments.length > 0 && (
            <div className="pid-wb-inline-comments-stack">
              {unanchoredAiComments.map((comment) => (
                <AiReviewCommentCard key={comment.id} comment={comment} />
              ))}
            </div>
          )}
          {file.binary ? (
            <div className="pid-wb-diff-notice">二进制文件已更改</div>
          ) : isOversized ? (
            <div className="pid-wb-diff-notice">
              <span>差异较大（{totalRows} 行），已默认折叠。</span>
              <button type="button" className="pid-wb-btn small" onClick={onExpandOversized}>
                展开完整差异
              </button>
            </div>
          ) : (
            <div className="pid-wb-diff-table">
              {segments.map((segment, segIndex) => (
                segment.kind === "fold" ? (
                  <div key={`fold-${segIndex}`} className="pid-wb-diff-fold">
                    ⋯ 隐藏 {segment.count} 行未更改上下文（{segment.newStart}–{segment.newEnd}）
                  </div>
                ) : (
                  segment.rows.map((row, rowIndex) => {
                    const rowLine = row.newLine ?? row.oldLine ?? 1;
                    const rowSide: "new" | "old" = row.newLine !== undefined ? "new" : "old";
                    const canComment = row.kind !== "meta";
                    const aiLineKey = row.newLine ?? (
                      row.oldLine !== undefined && !displayedNewLines.has(row.oldLine)
                        ? row.oldLine
                        : undefined
                    );
                    const lineAiComments = aiLineKey !== undefined ? (aiByLine.get(aiLineKey) ?? []) : [];
                    const lineDrafts = canComment
                      ? fileDrafts.filter((item) => item.line === rowLine && item.side === rowSide)
                      : [];
                    const isComposingHere = canComment
                      && composingTarget !== null
                      && matchesDiffCommentPath(composingTarget.file, path)
                      && composingTarget.line === rowLine
                      && composingTarget.side === rowSide;

                    return (
                      <Fragment key={`r-${segIndex}-${rowIndex}`}>
                        <div
                          className={`pid-wb-diff-row kind-${row.kind}${row.kind === "mod" ? (row.newLine !== undefined ? " side-add" : " side-del") : ""}`}
                        >
                          {canComment ? (
                            <button
                              type="button"
                              className="pid-wb-diff-comment-trigger"
                              title={`在第 ${rowLine} 行添加批注`}
                              aria-label="添加行内批注"
                              onClick={() => onStartCompose({
                                file: path,
                                line: rowLine,
                                side: rowSide,
                                lineText: row.text,
                              })}
                            >
                              <Plus size={11} />
                            </button>
                          ) : (
                            <span />
                          )}
                          <span className="pid-wb-diff-ln">{row.oldLine ?? ""}</span>
                          <span className="pid-wb-diff-ln">{row.newLine ?? ""}</span>
                          <span className="pid-wb-diff-sign">
                            {row.kind === "add" || (row.kind === "mod" && row.newLine !== undefined)
                              ? "+"
                              : row.kind === "del" || (row.kind === "mod" && row.oldLine !== undefined)
                                ? "−"
                                : " "}
                          </span>
                          <span className="pid-wb-diff-code">{row.text}</span>
                        </div>
                        {lineAiComments.map((comment) => (
                          <AiReviewCommentCard key={comment.id} comment={comment} />
                        ))}
                        {lineDrafts.map((draft) => (
                          <UserDraftCommentCard
                            key={draft.id}
                            comment={draft}
                            onEdit={() => onStartCompose({
                              file: draft.file,
                              line: draft.line,
                              side: draft.side,
                              lineText: draft.lineText,
                              editingId: draft.id,
                              initialValue: draft.body,
                            })}
                            onDelete={() => onDeleteDraft(draft.id)}
                          />
                        ))}
                        {isComposingHere && composingTarget && (
                          <InlineCommentComposer
                            file={path}
                            line={rowLine}
                            side={rowSide}
                            initialValue={composingTarget.initialValue}
                            onSave={(body) => onSaveDraft(body, rowLine, rowSide, row.text, composingTarget.editingId)}
                            onCancel={onCancelCompose}
                          />
                        )}
                      </Fragment>
                    );
                  })
                )
              ))}
            </div>
          )}
        </>
      )}
    </div>
  );
}

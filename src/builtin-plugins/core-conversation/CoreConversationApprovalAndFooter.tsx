/**
 * Built-in default slot components for `conversation.approvalDialog` and
 * `conversation.turnFooter` (ADR 0023 `core-conversation`).
 */
import { useState, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from "react";
import {
  ArrowRight,
  Check,
  ChevronDown,
  CircleHelp,
  FileDiff,
  ShieldCheck,
  X,
} from "lucide-react";
import { useFrontendService, useWorkspaceState } from "@qianji/client";
import type {
  ConversationApprovalDialogSlotProps,
  ConversationTurnFooterSlotProps,
  SlotComponentProps,
} from "@qianji/client-slots";
import {
  diffLineClass,
  fileBaseName,
  fileFolderOf,
  parseConfirmDiffMessage,
} from "./conversationHelpers";

const VISIBLE_CHANGE_FILES = 4;

/* ── conversation.approvalDialog: ExtensionDialog ── */

export function CoreApprovalDialog({
  request,
  onAnswer,
  renderFactory,
}: SlotComponentProps<ConversationApprovalDialogSlotProps, "session">): ReactNode {
  const initialValue = request.method === "editor" ? (request.prefill ?? "") : "";
  const [value, setValue] = useState(initialValue);
  const [selected, setSelected] = useState<string | null>(null);
  const [shownRequestId, setShownRequestId] = useState(request.id);

  if (shownRequestId !== request.id) {
    setShownRequestId(request.id);
    setValue(initialValue);
    setSelected(null);
  }

  if (
    request.method === "notify" ||
    request.method === "setStatus" ||
    request.method === "setWidget" ||
    request.method === "setTitle" ||
    request.method === "set_editor_text"
  ) {
    return null;
  }

  const cancel = () => {
    onAnswer(request.id, request.method === "confirm" ? { confirmed: false } : { cancelled: true });
  };

  const submit = () => {
    if (request.method === "confirm") {
      onAnswer(request.id, { confirmed: true });
      return;
    }
    if (request.method === "select") {
      if (selected !== null) onAnswer(request.id, { value: selected });
      return;
    }
    onAnswer(request.id, { value });
  };

  const handleDialogKeyDown = (event: ReactKeyboardEvent<HTMLElement>) => {
    if (event.key === "Escape") {
      event.preventDefault();
      cancel();
      return;
    }
    if (request.method !== "select" || event.altKey || event.ctrlKey || event.metaKey) return;
    const optionIndex = Number(event.key) - 1;
    if (
      Number.isInteger(optionIndex) &&
      optionIndex >= 0 &&
      optionIndex < Math.min(request.options.length, 9)
    ) {
      const picked = request.options[optionIndex];
      if (picked !== undefined) {
        event.preventDefault();
        setSelected(picked);
      }
    }
  };

  const handleFieldKeyDown = (event: ReactKeyboardEvent<HTMLInputElement | HTMLTextAreaElement>) => {
    const shouldSubmit =
      request.method === "editor"
        ? event.key === "Enter" && (event.ctrlKey || event.metaKey)
        : event.key === "Enter" && !event.shiftKey;
    if (!shouldSubmit || event.nativeEvent.isComposing) return;
    event.preventDefault();
    submit();
  };

  const isConfirm = request.method === "confirm";
  const submitDisabled = request.method === "select" && selected === null;
  const shortcut =
    request.method === "select"
      ? "1-9 选择"
      : request.method === "editor"
        ? "Ctrl+Enter 提交"
        : request.method === "input"
          ? "Enter 提交"
          : null;

  const fallbackDialog = (
    <section
      className={`question-card question-${request.method}`}
      role="dialog"
      aria-label={request.title}
      onKeyDown={handleDialogKeyDown}
    >
      <header className="question-card-header">
        <span className="question-kind">
          {isConfirm ? <ShieldCheck size={14} /> : <CircleHelp size={14} />}
          {isConfirm ? "需要确认" : "需要你的回答"}
        </span>
        {shortcut !== null && <span className="question-shortcut">{shortcut}</span>}
      </header>

      <h2>{request.title}</h2>

      {request.method === "confirm" && (() => {
        const parsed = parseConfirmDiffMessage(request.message);
        if (parsed.diffLines === null) {
          return <div className="question-message">{request.message}</div>;
        }
        return (
          <div className="question-message question-message-diff">
            {parsed.before !== "" && <p className="question-diff-summary">{parsed.before}</p>}
            <div className="question-diff-preview" role="region" aria-label="变更预览">
              {parsed.diffLines.map((line, lineIndex) => (
                <div key={`${lineIndex}-${line.slice(0, 12)}`} className={diffLineClass(line)}>
                  {line || " "}
                </div>
              ))}
            </div>
            {parsed.after !== "" && <p className="question-diff-summary">{parsed.after}</p>}
          </div>
        );
      })()}

      {request.method === "select" && (
        <div className="question-options" role="radiogroup" aria-label={request.title}>
          {request.options.map((option, index) => {
            const active = selected === option;
            return (
              <button
                key={option}
                type="button"
                role="radio"
                aria-checked={active}
                autoFocus={index === 0}
                className={`question-option ${active ? "active" : ""}`}
                onClick={() => setSelected(option)}
                onDoubleClick={() => onAnswer(request.id, { value: option })}
              >
                <span className="question-option-indicator">{active && <Check size={11} strokeWidth={2.5} />}</span>
                <span>{option}</span>
                {index < 9 && <kbd>{index + 1}</kbd>}
              </button>
            );
          })}
        </div>
      )}

      {request.method === "input" && (
        <input
          autoFocus
          className="question-field"
          value={value}
          placeholder={request.placeholder}
          onChange={(event) => setValue(event.target.value)}
          onKeyDown={handleFieldKeyDown}
        />
      )}

      {request.method === "editor" && (
        <textarea
          autoFocus
          className="question-field"
          rows={7}
          value={value}
          onChange={(event) => setValue(event.target.value)}
          onKeyDown={handleFieldKeyDown}
        />
      )}

      <footer className="question-footer">
        <button type="button" className="secondary-button" onClick={cancel}>
          <X size={14} />
          {isConfirm ? "拒绝" : "取消"}
        </button>
        <button type="button" className="primary-button" disabled={submitDisabled} onClick={submit}>
          {isConfirm ? <Check size={14} /> : <ArrowRight size={14} />}
          {isConfirm ? "允许一次" : "提交回答"}
        </button>
      </footer>
    </section>
  );

  return renderFactory(
    "host.conversation.approvalDialog",
    { request, onAnswer },
    { fallback: fallbackDialog },
  );
}

/* ── conversation.turnFooter: SessionChangeCard ── */

export function CoreSessionChangeCard({
  cwd: ownerCwd,
  renderFactory,
}: SlotComponentProps<ConversationTurnFooterSlotProps, "session">): ReactNode {
  const workspaceState = useWorkspaceState();
  const workspaceService = useFrontendService("workspaceService");
  const workbenchService = useFrontendService("workbenchService");
  const [open, setOpen] = useState(true);
  const [showAll, setShowAll] = useState(false);

  const files = workspaceState?.git?.files ?? [];
  const targetCwd = ownerCwd ?? workspaceState?.cwd ?? "";
  const single = files.length === 1;
  const firstFile = files[0];
  const visible = showAll ? files : files.slice(0, VISIBLE_CHANGE_FILES);

  const openFile = (path: string) => {
    void workbenchService?.openFile(path, targetCwd !== "" ? { cwd: targetCwd } : undefined);
  };

  const fallbackCard =
    files.length === 0 ? null : (
      <section className="conversation-change-card" aria-label="本任务的变更" data-open={!single && open ? "" : undefined}>
        <div className="conversation-change-heading">
          <button
            type="button"
            className="conversation-change-open"
            onClick={() => (single && firstFile !== undefined ? openFile(firstFile.path) : setOpen((v) => !v))}
            title={single && firstFile !== undefined ? firstFile.path : open ? "收起文件列表" : "展开文件列表"}
            aria-expanded={single ? undefined : open}
          >
            <span className="conversation-change-icon">
              <FileDiff size={15} strokeWidth={1.7} />
            </span>
            <div>
              <strong>
                {single && firstFile !== undefined
                  ? `已编辑 ${fileBaseName(firstFile.path)}`
                  : `已编辑 ${files.length} 个文件`}
              </strong>
            </div>
            {!single && <ChevronDown className="conversation-change-chevron" size={14} strokeWidth={1.8} aria-hidden="true" />}
          </button>
          <button
            type="button"
            className="change-card-secondary"
            onClick={() => {
              const paths = files.map((file) => file.path);
              const label = paths.length === 1 ? (paths[0] ?? "") : `${paths.length} 个文件`;
              if (typeof window !== "undefined" && !window.confirm(`撤销对 ${label} 的本地更改？未提交的改动将丢失。`)) {
                return;
              }
              void workspaceService?.restoreGitFiles(
                paths,
                targetCwd !== "" ? targetCwd : undefined,
              );
            }}
          >
            撤销
          </button>
          <button type="button" onClick={() => workbenchService?.openReview()}>
            审核
          </button>
        </div>
        {!single && open && (
          <ul className="conversation-change-files">
            {visible.map((file) => {
              const folder = fileFolderOf(file.path);
              return (
                <li key={file.path}>
                  <button type="button" onClick={() => openFile(file.path)} title={file.path}>
                    <span className="conversation-change-file-name">{fileBaseName(file.path)}</span>
                    {folder !== "" && <span className="conversation-change-file-folder">{folder}</span>}
                  </button>
                </li>
              );
            })}
            {files.length > VISIBLE_CHANGE_FILES && (
              <li>
                <button
                  type="button"
                  className="conversation-change-more"
                  onClick={() => setShowAll((value) => !value)}
                >
                  {showAll ? "收起" : `再显示 ${files.length - VISIBLE_CHANGE_FILES} 个文件`}
                </button>
              </li>
            )}
          </ul>
        )}
      </section>
    );

  return renderFactory(
    "host.conversation.sessionChangeCard",
    { cwd: targetCwd },
    { fallback: fallbackCard },
  );
}

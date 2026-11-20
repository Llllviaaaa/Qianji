/**
 * Built-in user message row and copy action button for `conversation.message`
 * (ADR 0023 `core-conversation`).
 */
import { useRef, useState, type ReactNode } from "react";
import { ArrowUp, Check, Copy, LoaderCircle, Pencil, RotateCcw } from "lucide-react";
import { useThemeState, type UiMessage } from "@qianji/client";
import type { BoundRenderSlotFn } from "@qianji/client-slots";

export function CopyActionButton({
  text,
  title = "复制",
}: {
  readonly text: string;
  readonly title?: string;
}): ReactNode {
  const [copied, setCopied] = useState(false);

  const handleCopy = () => {
    if (copied || typeof navigator === "undefined" || navigator.clipboard === undefined) return;
    void navigator.clipboard
      .writeText(text)
      .then(() => {
        setCopied(true);
        if (typeof window !== "undefined") {
          window.setTimeout(() => setCopied(false), 1000);
        }
      })
      .catch(() => undefined);
  };

  return (
    <button
      type="button"
      className="dshc-action"
      title={copied ? "已复制" : title}
      aria-label={copied ? "已复制" : "复制"}
      onClick={handleCopy}
    >
      {copied ? <Check size={14} /> : <Copy size={14} />}
    </button>
  );
}

export function CoreUserMessageRow({
  message,
  cwd,
  sessionFile,
  sessionId,
  clockLabel,
  onRewind,
  onEditAndResend,
  renderSlot,
}: {
  readonly message: UiMessage;
  readonly cwd: string;
  readonly sessionFile: string | null;
  readonly sessionId: string;
  readonly clockLabel: string;
  readonly onRewind?: (message: UiMessage) => void;
  readonly onEditAndResend?: (entryId: string, text: string) => void;
  readonly renderSlot: BoundRenderSlotFn;
}): ReactNode {
  const themeState = useThemeState();
  const requireCtrlEnter = themeState?.requireCtrlEnter === true;
  const [editing, setEditing] = useState(false);
  const [editDraft, setEditDraft] = useState(message.content);
  const [submittingEdit, setSubmittingEdit] = useState(false);
  const [rewinding, setRewinding] = useState(false);
  const editTextareaRef = useRef<HTMLTextAreaElement>(null);

  const canEdit =
    onEditAndResend !== undefined && typeof message.entryId === "string" && message.entryId !== "";

  const handleSubmitEdit = () => {
    if (submittingEdit || !canEdit || editDraft.trim() === "" || message.entryId === undefined) return;
    setSubmittingEdit(true);
    try {
      onEditAndResend(message.entryId, editDraft);
      setEditing(false);
    } finally {
      setSubmittingEdit(false);
    }
  };

  const handleRewind = () => {
    if (rewinding || onRewind === undefined) return;
    setRewinding(true);
    try {
      onRewind(message);
    } finally {
      setRewinding(false);
    }
  };

  if (editing) {
    return (
      <article
        className="dshc-flow dshc-user-row is-editing"
        data-chat-flow-kind="user"
        data-session-id={sessionId}
        data-message-id={message.id}
        id={`message-${message.id}`}
      >
        <div className="message-edit-card">
          <textarea
            ref={editTextareaRef}
            className="message-edit-input"
            aria-label="编辑消息"
            rows={2}
            value={editDraft}
            disabled={submittingEdit}
            onChange={(event) => setEditDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) return;
              if (event.key === "Escape") {
                event.preventDefault();
                setEditing(false);
                return;
              }
              const mod = event.ctrlKey || event.metaKey;
              const isEnterKey = event.key === "Enter" || (mod && event.key === "\n");
              if (!isEnterKey) return;
              const shouldSubmit = requireCtrlEnter
                ? mod && !event.altKey && !event.shiftKey
                : !mod && !event.altKey && !event.shiftKey;
              if (shouldSubmit) {
                event.preventDefault();
                handleSubmitEdit();
                return;
              }
              const shouldInsertNewline = requireCtrlEnter
                ? event.altKey && !mod && !event.shiftKey
                : (mod || event.altKey) && !event.shiftKey;
              if (shouldInsertNewline) {
                event.preventDefault();
                const start = Math.max(0, Math.min(editDraft.length, event.currentTarget.selectionStart ?? editDraft.length));
                const end = Math.max(start, Math.min(editDraft.length, event.currentTarget.selectionEnd ?? start));
                const nextDraft = `${editDraft.slice(0, start)}\n${editDraft.slice(end)}`;
                const nextCaret = start + 1;
                setEditDraft(nextDraft);
                if (typeof window !== "undefined" && typeof window.requestAnimationFrame === "function") {
                  window.requestAnimationFrame(() => {
                    const el = editTextareaRef.current;
                    if (el !== null) {
                      el.setSelectionRange(nextCaret, nextCaret);
                    }
                  });
                }
              }
            }}
          />
          <div className="message-edit-actions">
            <button
              type="button"
              className="message-edit-cancel"
              disabled={submittingEdit}
              onClick={() => setEditing(false)}
            >
              取消
            </button>
            <button
              type="button"
              className="message-edit-submit"
              title="从此消息重新发送"
              disabled={submittingEdit || editDraft.trim() === ""}
              onClick={handleSubmitEdit}
            >
              <ArrowUp size={14} strokeWidth={2} />
              <span>{submittingEdit ? "发送中" : "发送"}</span>
            </button>
          </div>
        </div>
      </article>
    );
  }

  return (
    <article
      className="dshc-flow dshc-user-row"
      data-chat-flow-kind="user"
      data-session-id={sessionId}
      data-message-id={message.id}
      id={`message-${message.id}`}
    >
      <div className="dshc-user-stack">
        {message.images !== undefined && message.images.length > 0 && (
          <div className="dshc-attachment-row" data-message-attachments="">
            {message.images.map((image, index) => (
              <img key={index} src={`data:${image.mimeType};base64,${image.data}`} alt={`附件 ${index + 1}`} />
            ))}
          </div>
        )}
        {message.content !== "" && (
          <div className="dshc-bubble">
            <div className="dshc-bubble-text">{message.content}</div>
          </div>
        )}
      </div>
      <div className="dshc-actions dshc-user-actions" data-clock="start">
        {clockLabel !== "" && <span className="dshc-time-start">{clockLabel}</span>}
        <CopyActionButton text={message.content} />
        {canEdit && (
          <button
            type="button"
            className="dshc-action"
            title="编辑消息"
            aria-label="编辑消息"
            onClick={() => {
              setEditDraft(message.content);
              setEditing(true);
            }}
          >
            <Pencil size={14} />
          </button>
        )}
        {onRewind !== undefined && (
          <button
            type="button"
            className="dshc-action"
            title="回退消息和改动"
            aria-label="回退消息和改动"
            disabled={rewinding}
            onClick={handleRewind}
          >
            {rewinding ? <LoaderCircle className="spin" size={14} /> : <RotateCcw size={14} />}
          </button>
        )}
        {renderSlot("conversation.message.actions", {
          cwd,
          sessionFile,
          message,
          contentText: message.content,
        })}
      </div>
    </article>
  );
}

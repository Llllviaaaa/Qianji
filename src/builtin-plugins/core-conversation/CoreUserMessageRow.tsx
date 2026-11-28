/**
 * Built-in user message row and copy action button for `conversation.message`
 * (ADR 0023 `core-conversation`).
 */
import { useMemo, useRef, useState, type ReactNode } from "react";
import { ArrowUp, Check, Copy, FileText, LoaderCircle, Pencil, RotateCcw, Sparkles } from "lucide-react";
import { useFrontendService, useSessionState, useThemeState, type UiMessage } from "@qianji/client";
import type { BoundRenderSlotFn } from "@qianji/client-slots";

const CORE_SLASH_RE = /^\/([a-zA-Z0-9][a-zA-Z0-9:_-]*)(?:\s+([\s\S]*))?$/;
const CORE_ATTACHED_FILES_RE = /(?:^|\r?\n\r?\n)附加的本地文件：\r?\n((?:- .+(?:\r?\n|$))+)\s*$/;

function renderCoreUserContent(rawContent: string, skillSlugs: ReadonlySet<string>): {
  body: ReactNode;
  files: Array<{ fileName: string; path: string }>;
  hasBubble: boolean;
} {
  let text = rawContent;
  const files: Array<{ fileName: string; path: string }> = [];
  const attachMatch = CORE_ATTACHED_FILES_RE.exec(text);
  if (attachMatch?.[1] !== undefined) {
    for (const rawLine of attachMatch[1].split(/\r?\n/)) {
      const line = rawLine.trim();
      if (!line.startsWith("- ")) continue;
      const idx = line.indexOf(": ");
      if (idx > 2) {
        files.push({ fileName: line.slice(2, idx).trim(), path: line.slice(idx + 2).trim() });
      }
    }
    if (files.length > 0) text = text.slice(0, attachMatch.index).trimEnd();
  }

  const trimmed = text.trim();
  if (trimmed === "") return { body: null, files, hasBubble: false };
  const match = CORE_SLASH_RE.exec(trimmed);
  if (match?.[1] === undefined) return { body: text, files, hasBubble: true };

  const cmdName = match[1];
  const cmdArgs = (match[2] ?? "").trim();
  const lower = cmdName.toLowerCase();
  if (cmdName === "goal" && cmdArgs !== "") {
    return {
      files,
      hasBubble: true,
      body: (
        <>
          <span className="qj-cmd-pill is-goal">🎯 /goal</span>{" "}
          <span className="qj-cmd-objective">{cmdArgs}</span>
        </>
      ),
    };
  }
  if ((lower.startsWith("skill:") && cmdName.length > 6) || skillSlugs.has(lower)) {
    const slug = lower.startsWith("skill:") ? cmdName.slice(6) : cmdName;
    return {
      files,
      hasBubble: true,
      body: (
        <>
          <span className="qj-cmd-pill is-skill" data-skill={slug}>
            <Sparkles size={11} strokeWidth={2.1} className="qj-cmd-pill-icon" aria-hidden="true" />
            <span className="qj-cmd-skill-badge">技能</span>
            <span className="qj-cmd-skill-name">{slug}</span>
          </span>
          {cmdArgs !== "" ? <>{" "}<span className="qj-cmd-args">{cmdArgs}</span></> : null}
        </>
      ),
    };
  }
  return {
    files,
    hasBubble: true,
    body: (
      <>
        <span className="qj-cmd-pill">/{cmdName}</span>
        {cmdArgs !== "" ? <>{" "}<span className="qj-cmd-args">{cmdArgs}</span></> : null}
      </>
    ),
  };
}

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
  const sessionState = useSessionState();
  const workbenchService = useFrontendService("workbenchService");
  const requireCtrlEnter = themeState?.requireCtrlEnter === true;
  const skillSlugs = useMemo(() => {
    const slugs = new Set<string>();
    for (const cmd of sessionState?.commands ?? []) {
      if (cmd.name.startsWith("skill:")) slugs.add(cmd.name.slice(6).toLowerCase());
      else if (cmd.source === "skill") slugs.add(cmd.name.toLowerCase());
    }
    return slugs;
  }, [sessionState?.commands]);
  const parsedContent = useMemo(
    () => renderCoreUserContent(message.content, skillSlugs),
    [message.content, skillSlugs],
  );
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
        {((message.images !== undefined && message.images.length > 0) || parsedContent.files.length > 0) && (
          <div className="dshc-attachment-row" data-message-attachments="">
            {message.images?.map((image, index) => (
              <img key={index} src={`data:${image.mimeType};base64,${image.data}`} alt={`附件 ${index + 1}`} />
            ))}
            {parsedContent.files.map((file, idx) => (
              <button
                key={`${file.path}-${idx}`}
                type="button"
                className="dshc-file-attachment-chip is-clickable"
                title={file.path}
                onClick={() => void workbenchService?.openFile(file.path, cwd !== "" ? { cwd } : undefined)}
              >
                <FileText size={13.5} strokeWidth={1.8} className="dshc-file-attachment-icon" aria-hidden="true" />
                <span className="dshc-file-attachment-name">{file.fileName}</span>
              </button>
            ))}
          </div>
        )}
        {parsedContent.hasBubble && (
          <div className="dshc-bubble">
            <div className="dshc-bubble-text">{parsedContent.body}</div>
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

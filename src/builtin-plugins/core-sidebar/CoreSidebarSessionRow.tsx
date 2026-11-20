import { useState } from "react";
import { Archive, Check, Pencil, X } from "lucide-react";
import type { SidebarSessionRowSlotProps, SlotComponentProps } from "@qianji/client-slots";
import { compactRelativeTime, formatSessionTitle } from "./sidebarHelpers";

export function CoreSidebarSessionRow(props: SlotComponentProps<SidebarSessionRowSlotProps, "root">) {
  const { session, active, running = false, onSelect, onRename, onArchive } = props;
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const title = formatSessionTitle(session);

  if (editing) {
    return (
      <div className={`thread-row-shell is-editing${active ? " active" : ""}`}>
        <form
          className="thread-rename-editor"
          onSubmit={(event) => {
            event.preventDefault();
            setEditing(false);
            const trimmed = draft.trim();
            if (trimmed !== "") onRename?.(trimmed);
          }}
        >
          <input
            autoFocus
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Escape") {
                event.stopPropagation();
                setEditing(false);
              }
            }}
            aria-label="会话名称"
          />
          <button type="submit" title="保存" aria-label="保存">
            <Check size={13} />
          </button>
          <button type="button" title="取消" aria-label="取消" onClick={() => setEditing(false)}>
            <X size={13} />
          </button>
        </form>
      </div>
    );
  }

  return (
    <div className={`thread-row-shell${active ? " active" : ""}`}>
      <div className="thread-row-bar">
        <button
          type="button"
          className={`thread-row${active ? " active" : ""}`}
          onClick={onSelect}
          title={title}
        >
          {running && <span className="thread-status" data-status="running" title="运行中" />}
          <span className="thread-title">{title}</span>
          <span className="thread-row-time">{compactRelativeTime(session)}</span>
        </button>
        <div className="thread-row-actions">
          {onRename !== undefined && (
            <button
              type="button"
              title="重命名对话"
              aria-label="重命名对话"
              onClick={(event) => {
                event.stopPropagation();
                setDraft(title);
                setEditing(true);
              }}
            >
              <Pencil size={12} />
            </button>
          )}
          {onArchive !== undefined && (
            <button
              type="button"
              title="归档对话"
              aria-label="归档对话"
              onClick={(event) => {
                event.stopPropagation();
                onArchive();
              }}
            >
              <Archive size={13} />
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

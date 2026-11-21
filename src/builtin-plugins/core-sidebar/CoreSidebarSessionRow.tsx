import { useState } from "react";
import { Archive, Check, MoreHorizontal, Pencil, Pin, X } from "lucide-react";
import type { SidebarSessionRowSlotProps, SlotComponentProps } from "@qianji/client-slots";
import { compactRelativeTime, formatSessionTitle } from "./sidebarHelpers";

export function CoreSidebarSessionRow(props: SlotComponentProps<SidebarSessionRowSlotProps, "root">) {
  const {
    session,
    active,
    running = false,
    approval = false,
    pinned = false,
    projectLabel,
    snippet,
    menuOpen = false,
    editing: controlledEditing,
    renameDraft: controlledDraft,
    onChangeRenameDraft,
    onCommitRename,
    onCancelRename,
    onSelect,
    onTogglePinned,
    onRename,
    onArchive,
    onOpenMenu,
    onContextMenu,
  } = props;

  const [localEditing, setLocalEditing] = useState(false);
  const [localDraft, setLocalDraft] = useState("");
  const title = formatSessionTitle(session);
  const isEditing = controlledEditing ?? localEditing;
  const draft = controlledEditing !== undefined ? (controlledDraft ?? "") : localDraft;

  if (isEditing) {
    return (
      <div className={`thread-row-shell is-editing${active ? " active" : ""}`}>
        <form
          className="thread-rename-editor"
          onSubmit={(event) => {
            event.preventDefault();
            if (controlledEditing !== undefined) {
              onCommitRename?.();
            } else {
              setLocalEditing(false);
              const trimmed = localDraft.trim();
              if (trimmed !== "") onRename?.(trimmed);
            }
          }}
        >
          <input
            autoFocus
            value={draft}
            onChange={(event) => {
              if (controlledEditing !== undefined) {
                onChangeRenameDraft?.(event.target.value);
              } else {
                setLocalDraft(event.target.value);
              }
            }}
            onKeyDown={(event) => {
              if (event.key === "Escape") {
                event.stopPropagation();
                if (controlledEditing !== undefined) onCancelRename?.();
                else setLocalEditing(false);
              }
            }}
            aria-label="会话名称"
          />
          <button type="submit" title="保存" aria-label="保存">
            <Check size={13} />
          </button>
          <button
            type="button"
            title="取消"
            aria-label="取消"
            onClick={() => {
              if (controlledEditing !== undefined) onCancelRename?.();
              else setLocalEditing(false);
            }}
          >
            <X size={13} />
          </button>
        </form>
      </div>
    );
  }

  const status = approval ? "approval" : running ? "running" : active ? "active" : "idle";
  const hasSnippet = typeof snippet === "string" && snippet.trim() !== "";

  return (
    <div
      className={`thread-row-shell${active ? " active" : ""}${pinned ? " is-pinned" : ""}${menuOpen ? " is-menu-open" : ""}${hasSnippet ? " has-snippet" : ""}`}
      onContextMenu={onContextMenu}
    >
      <div className="thread-row-bar">
        <button
          type="button"
          className={`thread-row${active ? " active" : ""}`}
          onClick={onSelect}
          title={title}
        >
          {approval || running ? (
            <span
              className="thread-status"
              data-status={status}
              title={approval ? "等待审批" : "运行中"}
            />
          ) : pinned ? (
            <Pin className="thread-pin-indicator" size={11} aria-label="已置顶" />
          ) : null}
          <span className="thread-title">{title}</span>
          {projectLabel !== undefined && projectLabel !== "" && (
            <span className="thread-project-tag">{projectLabel}</span>
          )}
          {approval ? (
            <span className="thread-row-time thread-row-badge">待审批</span>
          ) : (
            <span className="thread-row-time">{compactRelativeTime(session)}</span>
          )}
        </button>
        <div className="thread-row-actions">
          {onTogglePinned !== undefined && (
            <button
              type="button"
              className={pinned ? "is-pinned" : ""}
              title={pinned ? "取消置顶" : "置顶对话"}
              aria-label={pinned ? "取消置顶对话" : "置顶对话"}
              onClick={(event) => {
                event.stopPropagation();
                onTogglePinned();
              }}
            >
              <Pin size={13} />
            </button>
          )}
          {onOpenMenu === undefined && onRename !== undefined && (
            <button
              type="button"
              title="重命名对话"
              aria-label="重命名对话"
              onClick={(event) => {
                event.stopPropagation();
                setLocalDraft(title);
                setLocalEditing(true);
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
          {onOpenMenu !== undefined && (
            <button
              type="button"
              title="更多操作"
              aria-label="更多会话操作"
              onClick={(event) => {
                event.stopPropagation();
                onOpenMenu(event);
              }}
            >
              <MoreHorizontal size={13} />
            </button>
          )}
        </div>
      </div>
      {hasSnippet && (
        <button
          type="button"
          className="thread-search-snippet"
          onClick={onSelect}
          title={snippet}
        >
          {snippet}
        </button>
      )}
    </div>
  );
}

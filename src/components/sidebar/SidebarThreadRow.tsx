import type { MouseEvent as ReactMouseEvent } from "react";
import { Archive, Check, MoreHorizontal, Pin, X } from "lucide-react";
import { sessionTitle } from "../../lib/sessionTitle";
import type { SessionInfo } from "../../types";
import { compactRelativeTime } from "./sidebarHelpers";

export interface SidebarThreadRowProps {
  session: SessionInfo;
  active: boolean;
  running: boolean;
  approval: boolean;
  pinned: boolean;
  /** Compact workspace label shown in time-grouped ("recent") mode. */
  projectLabel?: string;
  /** Search hit excerpt shown under the title while filtering. */
  snippet?: string;
  menuOpen?: boolean;
  editing?: boolean;
  renameDraft?: string;
  onChangeRenameDraft?: (next: string) => void;
  onCommitRename?: () => void;
  onCancelRename?: () => void;
  onOpen: () => void;
  onTogglePinned: () => void;
  onArchive: () => void;
  onOpenMenu?: (event: ReactMouseEvent<HTMLElement>) => void;
  /** Right-click (or the context-menu key) on the row. */
  onContextMenu: (event: ReactMouseEvent<HTMLElement>) => void;
}

/** One session row in the primary sidebar, with in-flow hover actions and inline rename. */
export function SidebarThreadRow({
  session,
  active,
  running,
  approval,
  pinned,
  projectLabel,
  snippet,
  menuOpen = false,
  editing = false,
  renameDraft = "",
  onChangeRenameDraft,
  onCommitRename,
  onCancelRename,
  onOpen,
  onTogglePinned,
  onArchive,
  onOpenMenu,
  onContextMenu,
}: SidebarThreadRowProps) {
  if (editing) {
    return (
      <div className={`thread-row-shell is-editing${active ? " active" : ""}`}>
        <form
          className="thread-rename-editor"
          onSubmit={(event) => {
            event.preventDefault();
            onCommitRename?.();
          }}
        >
          <input
            autoFocus
            value={renameDraft}
            onChange={(event) => onChangeRenameDraft?.(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Escape") {
                event.stopPropagation();
                onCancelRename?.();
              }
            }}
            aria-label="会话名称"
          />
          <button type="submit" title="保存" aria-label="保存"><Check size={13} /></button>
          <button type="button" title="取消" aria-label="取消" onClick={() => onCancelRename?.()}><X size={13} /></button>
        </form>
      </div>
    );
  }

  const title = sessionTitle(session);
  const status = approval ? "approval" : running ? "running" : active ? "active" : "idle";
  return (
    <div
      className={`thread-row-shell${active ? " active" : ""}${pinned ? " is-pinned" : ""}${menuOpen ? " is-menu-open" : ""}${snippet ? " has-snippet" : ""}`}
      onContextMenu={onContextMenu}
    >
      <div className="thread-row-bar">
        <button
          type="button"
          className={`thread-row${active ? " active" : ""}`}
          onClick={onOpen}
          title={title}
        >
          {(approval || running) ? (
            <span
              className="thread-status"
              data-status={status}
              title={approval ? "等待审批" : "运行中"}
            />
          ) : pinned ? (
            <Pin className="thread-pin-indicator" size={11} aria-label="已置顶" />
          ) : null}
          <span className="thread-title">{title}</span>
          {projectLabel && <span className="thread-project-tag">{projectLabel}</span>}
          {approval
            ? <span className="thread-row-time thread-row-badge">待审批</span>
            : <span className="thread-row-time">{compactRelativeTime(session)}</span>}
        </button>
        <div className="thread-row-actions">
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
          {onOpenMenu && (
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
      {snippet && (
        <button
          type="button"
          className="thread-search-snippet"
          onClick={onOpen}
          title={snippet}
        >
          {snippet}
        </button>
      )}
    </div>
  );
}

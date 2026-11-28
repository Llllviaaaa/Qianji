/**
 * Modular Header, Popover Menus & Conversation Rows for `BotSideChatDrawer` (`BotSideDrawerMenus.tsx`).
 */
import { useState, type ReactElement } from "react";
import {
  Archive,
  ArchiveRestore,
  ArrowUpRight,
  Check,
  MoreHorizontal,
  PanelLeftClose,
  Pencil,
  Pin,
  PinOff,
  Search,
  Trash2,
  X,
} from "lucide-react";
import type { BotSideThreadInfo } from "@qianji/protocol";
import { stripBotThinking } from "./BotChatThreadWidgets";

export interface ExtendedSideThread extends BotSideThreadInfo {
  readonly pinned?: boolean;
  readonly archived?: boolean;
  readonly status?: "idle" | "running" | "awaiting-approval" | "error";
  readonly source?: "chat" | "scheduled" | "space" | "handoff";
  readonly scheduledTaskId?: string;
}

export function formatSideThreadDate(updatedAt: number, nowMs: number = Date.now()): string {
  if (!Number.isFinite(updatedAt) || updatedAt <= 0) return "";
  const now = new Date(nowMs);
  const dt = new Date(updatedAt);
  const startToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const startTarget = new Date(dt.getFullYear(), dt.getMonth(), dt.getDate()).getTime();
  const dayDiff = Math.round((startToday - startTarget) / 86_400_000);
  if (dayDiff === 0) return "今天";
  if (dayDiff === 1) return "昨天";
  return `${String(dt.getMonth() + 1).padStart(2, "0")}月${String(dt.getDate()).padStart(2, "0")}日`;
}

export function BotDrawerTopBar(props: {
  readonly filterText: string;
  readonly optionsOpen: boolean;
  readonly pinned: boolean;
  readonly showArchived: boolean;
  readonly archivedCount: number;
  readonly onFilterChange: (next: string) => void;
  readonly onToggleOptions: () => void;
  readonly onTogglePinned: () => void;
  readonly onToggleShowArchived: () => void;
  readonly onCollapse: () => void;
}): ReactElement {
  const {
    filterText,
    optionsOpen,
    pinned,
    showArchived,
    archivedCount,
    onFilterChange,
    onToggleOptions,
    onTogglePinned,
    onToggleShowArchived,
    onCollapse,
  } = props;

  return (
    <div className="qj-muse-drawer-top">
      <div className="qj-muse-drawer-search">
        <Search size={14.5} strokeWidth={1.85} aria-hidden="true" />
        <input
          type="text"
          value={filterText}
          onChange={(e) => onFilterChange(e.target.value)}
          placeholder="搜索对话"
          aria-label="搜索聊天"
        />
        {filterText !== "" && (
          <button
            type="button"
            className="qj-drawer-search-clear"
            aria-label="清空搜索"
            onClick={() => onFilterChange("")}
          >
            <X size={13} strokeWidth={2} />
          </button>
        )}
      </div>

      <div className="qj-drawer-options-anchor">
        <button
          type="button"
          className={`qj-muse-drawer-icon-btn${optionsOpen ? " active" : ""}`}
          title="旁聊选项"
          aria-label="旁聊选项"
          data-testid="bot-drawer-options-btn"
          onClick={onToggleOptions}
        >
          <MoreHorizontal size={16} strokeWidth={1.85} />
        </button>

        {optionsOpen && (
          <div
            className="qj-drawer-popover qj-drawer-options-popover"
            role="menu"
            aria-label="旁聊选项菜单"
            data-testid="bot-drawer-options-menu"
          >
            <button
              type="button"
              role="menuitemcheckbox"
              aria-checked={pinned}
              className="qj-drawer-menu-item"
              onClick={onTogglePinned}
            >
              <span>保持显示聊天面板</span>
              <span className={`qj-drawer-check-slot${pinned ? " checked" : ""}`}>
                {pinned && <Check size={14} strokeWidth={2.2} />}
              </span>
            </button>

            <button
              type="button"
              role="menuitemcheckbox"
              aria-checked={showArchived}
              className="qj-drawer-menu-item"
              onClick={onToggleShowArchived}
            >
              <span className="qj-drawer-menu-label-wrap">
                <span>显示已归档的聊天</span>
                {archivedCount > 0 && <span className="qj-drawer-count-pill">{archivedCount}</span>}
              </span>
              <span className={`qj-drawer-check-slot${showArchived ? " checked" : ""}`}>
                {showArchived && <Check size={14} strokeWidth={2.2} />}
              </span>
            </button>
          </div>
        )}
      </div>

      <button
        type="button"
        className="qj-muse-drawer-icon-btn"
        title="收起聊天列表"
        aria-label="收起聊天列表"
        onClick={onCollapse}
      >
        <PanelLeftClose size={16} strokeWidth={1.8} />
      </button>
    </div>
  );
}

export function BotDrawerThreadRow(props: {
  readonly thread: ExtendedSideThread;
  readonly active: boolean;
  readonly menuOpen: boolean;
  readonly isRenaming: boolean;
  readonly renameDraft: string;
  readonly onSelect: () => void;
  readonly onToggleMenu: () => void;
  readonly onCloseMenu: () => void;
  readonly onStartRename: () => void;
  readonly onRenameDraftChange: (val: string) => void;
  readonly onCommitRename: () => void;
  readonly onCancelRename: () => void;
  readonly onTogglePin: () => void;
  readonly onToggleArchive: () => void;
  readonly onHandoff: () => void;
  readonly onDelete: () => void;
}): ReactElement {
  const {
    thread,
    active,
    menuOpen,
    isRenaming,
    renameDraft,
    onSelect,
    onToggleMenu,
    onCloseMenu,
    onStartRename,
    onRenameDraftChange,
    onCommitRename,
    onCancelRename,
    onTogglePin,
    onToggleArchive,
    onHandoff,
    onDelete,
  } = props;

  const [confirmDelete, setConfirmDelete] = useState(false);
  const cleanSnippet = thread.snippet ? stripBotThinking(thread.snippet).replace(/\s+/g, " ").trim() : "";
  const dateLabel = formatSideThreadDate(thread.updatedAt);

  return (
    <div
      className={`qj-muse-drawer-row qj-drawer-thread-row${active ? " active" : ""}${menuOpen ? " menu-open" : ""}`}
      data-testid="bot-drawer-thread-row"
    >
      {isRenaming ? (
        <div className="qj-drawer-rename-wrap">
          <input
            type="text"
            className="qj-drawer-rename-input"
            value={renameDraft}
            autoFocus
            aria-label="重命名旁聊"
            onChange={(e) => onRenameDraftChange(e.target.value)}
            onBlur={onCommitRename}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                onCommitRename();
              } else if (e.key === "Escape") {
                e.preventDefault();
                onCancelRename();
              }
            }}
          />
        </div>
      ) : (
        <button
          type="button"
          className="qj-muse-drawer-link qj-drawer-thread-btn"
          title={thread.title}
          onClick={onSelect}
          onDoubleClick={(e) => {
            e.preventDefault();
            onStartRename();
          }}
        >
          <span className="qj-drawer-thread-top">
            {thread.status === "running" && <span className="qj-drawer-status-dot running" aria-hidden="true" />}
            <span className="qj-drawer-thread-title">{thread.title}</span>
            {thread.source === "scheduled" && <span className="qj-drawer-mini-tag">定时</span>}
            {thread.archived === true && <span className="qj-drawer-mini-tag muted">已归档</span>}
          </span>
          {cleanSnippet !== "" && <span className="qj-drawer-thread-snippet">{cleanSnippet}</span>}
        </button>
      )}

      {!isRenaming && (
        <div className="qj-drawer-row-tail">
          {dateLabel !== "" && <span className="qj-drawer-row-date">{dateLabel}</span>}
          <button
            type="button"
            className="qj-drawer-more-btn"
            title="更多对话操作"
            aria-label={`更多对话操作 ${thread.title}`}
            data-testid="bot-drawer-thread-more"
            onClick={(e) => {
              e.stopPropagation();
              setConfirmDelete(false);
              onToggleMenu();
            }}
          >
            <MoreHorizontal size={14} strokeWidth={1.9} />
          </button>
        </div>
      )}

      {menuOpen && (
        <div
          className="qj-drawer-popover qj-drawer-thread-popover"
          role="menu"
          aria-label={`${thread.title} 操作菜单`}
          onMouseLeave={() => {
            setConfirmDelete(false);
            onCloseMenu();
          }}
        >
          <button
            type="button"
            role="menuitem"
            className="qj-drawer-menu-item"
            onClick={() => {
              onCloseMenu();
              onTogglePin();
            }}
          >
            <span>{thread.pinned ? "取消置顶" : "置顶"}</span>
            {thread.pinned ? <PinOff size={13.5} /> : <Pin size={13.5} />}
          </button>

          <button
            type="button"
            role="menuitem"
            className="qj-drawer-menu-item"
            onClick={() => {
              onCloseMenu();
              onStartRename();
            }}
          >
            <span>重命名</span>
            <Pencil size={13.5} />
          </button>

          <button
            type="button"
            role="menuitem"
            className="qj-drawer-menu-item"
            onClick={() => {
              onCloseMenu();
              onToggleArchive();
            }}
          >
            <span>{thread.archived ? "取消归档" : "归档"}</span>
            {thread.archived ? <ArchiveRestore size={13.5} /> : <Archive size={13.5} />}
          </button>

          <button
            type="button"
            role="menuitem"
            className="qj-drawer-menu-item"
            onClick={() => {
              onCloseMenu();
              onHandoff();
            }}
          >
            <span>在工作台中打开</span>
            <ArrowUpRight size={13.5} />
          </button>

          <div className="qj-drawer-menu-sep" />

          <button
            type="button"
            role="menuitem"
            aria-label={confirmDelete ? `确认删除旁聊 ${thread.title}` : `删除旁聊 ${thread.title}`}
            className={`qj-drawer-menu-item danger${confirmDelete ? " confirming" : ""}`}
            onClick={(e) => {
              e.stopPropagation();
              if (!confirmDelete) {
                setConfirmDelete(true);
                return;
              }
              setConfirmDelete(false);
              onCloseMenu();
              onDelete();
            }}
          >
            <span>{confirmDelete ? "再次点击确认删除" : "删除"}</span>
            <Trash2 size={13.5} />
          </button>
        </div>
      )}
    </div>
  );
}

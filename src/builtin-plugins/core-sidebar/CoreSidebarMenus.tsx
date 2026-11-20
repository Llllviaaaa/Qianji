import {
  Archive,
  ArchiveRestore,
  Check,
  ChevronLeft,
  FolderOpen,
  FolderPlus,
  ListFilter,
  Pin,
  Trash2,
} from "lucide-react";
import type { ClientMenuLocation, ResolvedMenuItem } from "@qianji/client";
import {
  formatSessionTitle,
  repoName,
  sameLocalPath,
  type SidebarGroupMode,
  type SidebarSessionItem,
} from "./sidebarHelpers";

export function SidebarProjectsHeader({
  workspaceView,
  groupMode,
  filterMenuOpen,
  onToggleFilterMenu,
  onSelectGroupMode,
  onToggleArchivedView,
  onBackFromArchived,
  onPickFolder,
}: {
  readonly workspaceView: "active" | "archived";
  readonly groupMode: SidebarGroupMode;
  readonly filterMenuOpen: boolean;
  readonly onToggleFilterMenu: () => void;
  readonly onSelectGroupMode: (mode: SidebarGroupMode) => void;
  readonly onToggleArchivedView: () => void;
  readonly onBackFromArchived: () => void;
  readonly onPickFolder: () => void;
}) {
  return (
    <div className="sidebar-projects-header" data-ws-view={workspaceView}>
      {workspaceView === "archived" ? (
        <button
          type="button"
          className="sidebar-projects-back"
          title="返回会话列表"
          onClick={onBackFromArchived}
        >
          <ChevronLeft size={13} strokeWidth={1.8} />
          <span>已归档</span>
        </button>
      ) : (
        <span className="sidebar-projects-label">{groupMode === "recent" ? "最近" : "工作区"}</span>
      )}
      <div className="sidebar-projects-tools">
        <button
          type="button"
          className={filterMenuOpen ? "active" : ""}
          title="筛选与分组"
          aria-label="筛选与分组"
          aria-expanded={filterMenuOpen}
          onClick={onToggleFilterMenu}
        >
          <ListFilter size={14} strokeWidth={1.8} />
        </button>
        <button
          type="button"
          title="打开项目文件夹"
          aria-label="打开项目文件夹"
          onClick={onPickFolder}
        >
          <FolderPlus size={14} strokeWidth={1.8} />
        </button>
      </div>

      {filterMenuOpen && (
        <div className="sidebar-popover sidebar-filter-menu" data-sidebar-popover="" role="menu">
          <div className="sidebar-popover-caption">分组方式</div>
          {([["project", "按项目"], ["recent", "按时间"]] as const).map(([mode, label]) => (
            <button
              key={mode}
              type="button"
              role="menuitemradio"
              aria-checked={workspaceView === "active" && groupMode === mode}
              onClick={() => onSelectGroupMode(mode)}
            >
              <span>{label}</span>
              {workspaceView === "active" && groupMode === mode && <Check size={14} />}
            </button>
          ))}
          <div className="sidebar-popover-separator" />
          <button
            type="button"
            role="menuitemradio"
            aria-checked={workspaceView === "archived"}
            onClick={onToggleArchivedView}
          >
            <span>已归档会话</span>
            {workspaceView === "archived" && <Check size={14} />}
          </button>
        </div>
      )}
    </div>
  );
}

export function SidebarArchivedList({
  loading,
  sessions,
  onOpen,
  onRestore,
  onDelete,
}: {
  readonly loading: boolean;
  readonly sessions: readonly SidebarSessionItem[];
  readonly onOpen: (session: SidebarSessionItem) => void;
  readonly onRestore: (session: SidebarSessionItem) => void;
  readonly onDelete: (session: SidebarSessionItem) => void;
}) {
  return (
    <div className="dsh-claude-archive-list">
      {loading ? (
        <div className="dsh-claude-archive-status">正在加载…</div>
      ) : sessions.length === 0 ? (
        <div className="dsh-claude-archive-status">没有已归档的会话</div>
      ) : (
        sessions.map((session) => (
          <div key={session.file} className="dsh-claude-archive-row">
            <button
              type="button"
              className="dsh-claude-archive-open"
              onClick={() => onOpen(session)}
            >
              <span className="dsh-claude-archive-title">{formatSessionTitle(session)}</span>
              <span className="dsh-claude-archive-project">{repoName(session.cwd)}</span>
            </button>
            <div className="dsh-claude-archive-actions">
              <button
                type="button"
                className="dsh-claude-archive-restore"
                title="取消归档"
                aria-label="取消归档"
                onClick={() => onRestore(session)}
              >
                <ArchiveRestore size={14} />
              </button>
              <button
                type="button"
                className="dsh-claude-archive-delete"
                title="删除会话"
                aria-label="删除会话"
                onClick={() => onDelete(session)}
              >
                <Trash2 size={14} />
              </button>
            </div>
          </div>
        ))
      )}
    </div>
  );
}

export function SidebarContextMenus<
  P extends ClientMenuLocation = "sidebar.project",
  T extends ClientMenuLocation = "sidebar.thread",
>({
  projectMenu,
  projectItems,
  onOpenProjectFolder,
  onCloseProjectMenu,
  threadMenu,
  threadItems,
  pinnedFiles,
  onTogglePinned,
  onArchiveSession,
  onDeleteSession,
  onCloseThreadMenu,
}: {
  readonly projectMenu: { workspace: string; top: number } | null;
  readonly projectItems: readonly ResolvedMenuItem<P>[];
  readonly onOpenProjectFolder: (workspace: string) => void;
  readonly onCloseProjectMenu: () => void;
  readonly threadMenu: { session: SidebarSessionItem; top: number } | null;
  readonly threadItems: readonly ResolvedMenuItem<T>[];
  readonly pinnedFiles: readonly string[];
  readonly onTogglePinned: (file: string) => void;
  readonly onArchiveSession: (session: SidebarSessionItem) => void;
  readonly onDeleteSession: (session: SidebarSessionItem) => void;
  readonly onCloseThreadMenu: () => void;
}) {
  return (
    <>
      {projectMenu !== null && (
        <div
          className="sidebar-popover project-context-menu"
          style={{ top: projectMenu.top }}
          data-sidebar-popover=""
          role="menu"
        >
          <button
            type="button"
            onClick={() => {
              onOpenProjectFolder(projectMenu.workspace);
              onCloseProjectMenu();
            }}
          >
            <FolderOpen size={14} />在资源管理器中打开
          </button>
          {projectItems.length > 0 && <div className="sidebar-popover-separator" />}
          {projectItems.map((item) => (
            <button
              key={item.id}
              type="button"
              className={item.danger ? "danger" : undefined}
              disabled={item.disabled}
              onClick={() => {
                onCloseProjectMenu();
                item.select();
              }}
            >
              {item.label}
            </button>
          ))}
        </div>
      )}

      {threadMenu !== null && (
        <div
          className="sidebar-popover project-context-menu thread-context-menu"
          style={{ top: threadMenu.top }}
          data-sidebar-popover=""
          role="menu"
        >
          <button
            type="button"
            onClick={() => {
              onTogglePinned(threadMenu.session.file);
              onCloseThreadMenu();
            }}
          >
            <Pin size={14} />
            {pinnedFiles.some((file) => sameLocalPath(file, threadMenu.session.file)) ? "取消置顶对话" : "置顶对话"}
          </button>
          <button
            type="button"
            onClick={() => {
              onArchiveSession(threadMenu.session);
              onCloseThreadMenu();
            }}
          >
            <Archive size={14} />归档对话
          </button>
          {threadItems.length > 0 && <div className="sidebar-popover-separator" />}
          {threadItems.map((item) => (
            <button
              key={item.id}
              type="button"
              className={item.danger ? "danger" : undefined}
              disabled={item.disabled}
              onClick={() => {
                onCloseThreadMenu();
                item.select();
              }}
            >
              {item.label}
            </button>
          ))}
          <div className="sidebar-popover-separator" />
          <button
            type="button"
            className="danger"
            onClick={() => {
              onDeleteSession(threadMenu.session);
              onCloseThreadMenu();
            }}
          >
            <Trash2 size={14} />删除对话
          </button>
        </div>
      )}
    </>
  );
}

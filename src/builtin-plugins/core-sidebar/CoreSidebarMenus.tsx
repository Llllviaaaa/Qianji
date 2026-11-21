import { useEffect, useLayoutEffect, useRef } from "react";
import {
  Archive,
  ArchiveRestore,
  Check,
  ChevronLeft,
  FolderOpen,
  FolderPlus,
  GitBranch,
  ListFilter,
  Pencil,
  Pin,
  SlidersHorizontal,
  Trash2,
  X,
} from "lucide-react";
import type { ClientMenuLocation, ResolvedMenuItem } from "@qianji/client";
import {
  compactRelativeTime,
  formatSessionTitle,
  repoName,
  sameLocalPath,
  type SidebarGroupMode,
  type SidebarSessionItem,
} from "./sidebarHelpers";

const MIN_MENU_TOP = 54;
const MENU_BOTTOM_MARGIN = 8;

function useClampedPopover(
  ref: React.RefObject<HTMLDivElement | null>,
  top: number | null,
  onClose: () => void,
): void {
  useLayoutEffect(() => {
    if (top === null) return;
    const element = ref.current;
    const container = element?.parentElement;
    if (element === null || container === null || container === undefined) return;
    const maxTop = container.clientHeight - element.offsetHeight - MENU_BOTTOM_MARGIN;
    element.style.top = `${Math.max(MIN_MENU_TOP, Math.min(top, maxTop))}px`;
  }, [ref, top]);

  useEffect(() => {
    if (top === null || typeof document === "undefined") return undefined;
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as Node | null;
      if (target !== null && ref.current !== null && ref.current.contains(target)) return;
      onClose();
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopPropagation();
      onClose();
    };
    document.addEventListener("pointerdown", onPointerDown, true);
    window.addEventListener("keydown", onKeyDown, true);
    window.addEventListener("blur", onClose);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown, true);
      window.removeEventListener("keydown", onKeyDown, true);
      window.removeEventListener("blur", onClose);
    };
  }, [onClose, ref, top]);
}

export function SidebarProjectsHeader({
  workspaceView,
  groupMode,
  filterMenuOpen,
  onToggleFilterMenu,
  onCloseFilterMenu,
  onSelectGroupMode,
  onToggleArchivedView,
  onBackFromArchived,
  onPickFolder,
}: {
  readonly workspaceView: "active" | "archived";
  readonly groupMode: SidebarGroupMode;
  readonly filterMenuOpen: boolean;
  readonly onToggleFilterMenu: () => void;
  readonly onCloseFilterMenu: () => void;
  readonly onSelectGroupMode: (mode: SidebarGroupMode) => void;
  readonly onToggleArchivedView: () => void;
  readonly onBackFromArchived: () => void;
  readonly onPickFolder: () => void;
}) {
  const headerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!filterMenuOpen || typeof document === "undefined") return undefined;
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as Node | null;
      if (target !== null && headerRef.current !== null && headerRef.current.contains(target)) return;
      onCloseFilterMenu();
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        onCloseFilterMenu();
      }
    };
    document.addEventListener("pointerdown", onPointerDown, true);
    document.addEventListener("keydown", onKeyDown, true);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown, true);
      document.removeEventListener("keydown", onKeyDown, true);
    };
  }, [filterMenuOpen, onCloseFilterMenu]);

  return (
    <div ref={headerRef} className="sidebar-projects-header" data-ws-view={workspaceView}>
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
  displayProjectName,
  onOpen,
  onRestore,
  onDelete,
}: {
  readonly loading: boolean;
  readonly sessions: readonly SidebarSessionItem[];
  readonly displayProjectName: (workspace: string) => string;
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
        sessions.map((session) => {
          const title = formatSessionTitle(session);
          return (
            <div key={session.file} className="dsh-claude-archive-row">
              <button
                type="button"
                className="dsh-claude-archive-open"
                title={title}
                onClick={() => onOpen(session)}
              >
                <span className="dsh-claude-archive-title">{title}</span>
                <span className="dsh-claude-archive-project">
                  {displayProjectName(session.cwd) || repoName(session.cwd)}
                </span>
                <span className="dsh-claude-archive-time">{compactRelativeTime(session)}</span>
              </button>
              <div className="dsh-claude-archive-actions">
                <span className="dsh-claude-archive-action">
                  <button
                    type="button"
                    className="dsh-claude-archive-restore"
                    title="取消归档"
                    aria-label="取消归档"
                    onClick={() => onRestore(session)}
                  >
                    <ArchiveRestore size={14} />
                  </button>
                </span>
                <span className="dsh-claude-archive-action">
                  <button
                    type="button"
                    className="dsh-claude-archive-delete"
                    title="删除会话"
                    aria-label="删除会话"
                    onClick={() => onDelete(session)}
                  >
                    <Trash2 size={14} />
                  </button>
                </span>
              </div>
            </div>
          );
        })
      )}
    </div>
  );
}

export function SidebarContextMenus<
  P extends ClientMenuLocation = "sidebar.project",
  T extends ClientMenuLocation = "sidebar.thread",
>({
  projectMenu,
  projectPinned,
  projectItems,
  onTogglePinProject,
  onOpenProjectFolder,
  onCreateWorktree,
  onBeginRenameProject,
  onArchiveProject,
  onRemoveProject,
  onCloseProjectMenu,
  threadMenu,
  threadItems,
  pinnedFiles,
  onBeginRenameSession,
  onTogglePinned,
  onArchiveSession,
  onDeleteSession,
  onCloseThreadMenu,
}: {
  readonly projectMenu: { workspace: string; top: number } | null;
  readonly projectPinned: boolean;
  readonly projectItems: readonly ResolvedMenuItem<P>[];
  readonly onTogglePinProject: (workspace: string) => void;
  readonly onOpenProjectFolder: (workspace: string) => void;
  readonly onCreateWorktree: (workspace: string) => void;
  readonly onBeginRenameProject: (workspace: string) => void;
  readonly onArchiveProject: (workspace: string) => void;
  readonly onRemoveProject: (workspace: string) => void;
  readonly onCloseProjectMenu: () => void;
  readonly threadMenu: { session: SidebarSessionItem; top: number } | null;
  readonly threadItems: readonly ResolvedMenuItem<T>[];
  readonly pinnedFiles: readonly string[];
  readonly onBeginRenameSession: (session: SidebarSessionItem) => void;
  readonly onTogglePinned: (file: string) => void;
  readonly onArchiveSession: (session: SidebarSessionItem) => void;
  readonly onDeleteSession: (session: SidebarSessionItem) => void;
  readonly onCloseThreadMenu: () => void;
}) {
  const projectMenuRef = useRef<HTMLDivElement>(null);
  const threadMenuRef = useRef<HTMLDivElement>(null);

  useClampedPopover(projectMenuRef, projectMenu?.top ?? null, onCloseProjectMenu);
  useClampedPopover(threadMenuRef, threadMenu?.top ?? null, onCloseThreadMenu);

  return (
    <>
      {projectMenu !== null && (
        <div
          ref={projectMenuRef}
          className="sidebar-popover project-context-menu"
          style={{ top: projectMenu.top }}
          data-sidebar-popover=""
          role="menu"
        >
          <button
            type="button"
            role="menuitem"
            onClick={() => {
              onTogglePinProject(projectMenu.workspace);
              onCloseProjectMenu();
            }}
          >
            <Pin size={15} />
            {projectPinned ? "取消置顶项目" : "置顶项目"}
          </button>
          <button
            type="button"
            role="menuitem"
            onClick={() => {
              onOpenProjectFolder(projectMenu.workspace);
              onCloseProjectMenu();
            }}
          >
            <FolderOpen size={15} />
            在资源管理器中打开
          </button>
          <button
            type="button"
            role="menuitem"
            onClick={() => {
              onCreateWorktree(projectMenu.workspace);
              onCloseProjectMenu();
            }}
          >
            <GitBranch size={15} />
            创建永久工作树
          </button>
          <button
            type="button"
            role="menuitem"
            onClick={() => {
              onBeginRenameProject(projectMenu.workspace);
              onCloseProjectMenu();
            }}
          >
            <SlidersHorizontal size={15} />
            编辑项目
          </button>
          <button
            type="button"
            role="menuitem"
            onClick={() => {
              onArchiveProject(projectMenu.workspace);
              onCloseProjectMenu();
            }}
          >
            <Archive size={15} />
            归档聊天
          </button>
          {projectItems.length > 0 && <div className="sidebar-popover-separator" />}
          {projectItems.map((item) => (
            <button
              key={item.id}
              type="button"
              role="menuitem"
              className={item.danger ? "danger" : undefined}
              disabled={item.disabled}
              onClick={() => {
                onCloseProjectMenu();
                item.select();
              }}
            >
              {item.icon}
              <span>{item.label}</span>
              {item.shortcut !== undefined && item.shortcut !== "" && (
                <span className="menu-item-shortcut">{item.shortcut}</span>
              )}
            </button>
          ))}
          <div className="sidebar-popover-separator" />
          <button
            type="button"
            role="menuitem"
            className="danger"
            onClick={() => {
              onRemoveProject(projectMenu.workspace);
              onCloseProjectMenu();
            }}
          >
            <X size={15} />
            移除本地项目
          </button>
        </div>
      )}

      {threadMenu !== null && (
        <div
          ref={threadMenuRef}
          className="sidebar-popover project-context-menu thread-context-menu"
          style={{ top: threadMenu.top }}
          data-sidebar-popover=""
          role="menu"
          onContextMenu={(event) => event.preventDefault()}
        >
          <button
            type="button"
            role="menuitem"
            onClick={() => {
              onBeginRenameSession(threadMenu.session);
              onCloseThreadMenu();
            }}
          >
            <Pencil size={14} />
            重命名对话
          </button>
          <button
            type="button"
            role="menuitem"
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
            role="menuitem"
            onClick={() => {
              onArchiveSession(threadMenu.session);
              onCloseThreadMenu();
            }}
          >
            <Archive size={14} />
            归档对话
          </button>
          {threadItems.length > 0 && <div className="sidebar-popover-separator" />}
          {threadItems.map((item) => (
            <button
              key={item.id}
              type="button"
              role="menuitem"
              className={item.danger ? "danger" : undefined}
              disabled={item.disabled}
              onClick={() => {
                onCloseThreadMenu();
                item.select();
              }}
            >
              {item.icon}
              <span>{item.label}</span>
              {item.shortcut !== undefined && item.shortcut !== "" && (
                <span className="menu-item-shortcut">{item.shortcut}</span>
              )}
            </button>
          ))}
          <div className="sidebar-popover-separator" />
          <button
            type="button"
            role="menuitem"
            className="danger"
            onClick={() => {
              onDeleteSession(threadMenu.session);
              onCloseThreadMenu();
            }}
          >
            <Trash2 size={14} />
            删除对话
          </button>
        </div>
      )}
    </>
  );
}

import type { MouseEvent as ReactMouseEvent, ReactNode } from "react";
import {
  Check,
  ChevronDown,
  Folder,
  MoreHorizontal,
  Pin,
  SquarePen,
  X,
} from "lucide-react";
import {
  sameLocalPath,
  VISIBLE_THREADS_PER_PROJECT,
  visibleProjectSessions,
  type SidebarSessionItem,
} from "./sidebarHelpers";

export function CoreSidebarProjectSection({
  workspace,
  chats,
  projectName,
  projectPinned,
  isCurrentWorkspace,
  isMenuOpen,
  collapsed,
  expanded,
  trimmedQuery,
  isEditing,
  aliasDraft,
  runningSessionFiles,
  approvalSessionFiles,
  isImportantSession,
  onChangeAliasDraft,
  onCommitRename,
  onCancelRename,
  onToggleCollapse,
  onSelectProject,
  onNewProjectSession,
  onOpenProjectMenu,
  onToggleExpand,
  renderSessionRow,
}: {
  readonly workspace: string;
  readonly chats: readonly SidebarSessionItem[];
  readonly projectName: string;
  readonly projectPinned: boolean;
  readonly isCurrentWorkspace: boolean;
  readonly isMenuOpen: boolean;
  readonly collapsed: boolean;
  readonly expanded: boolean;
  readonly trimmedQuery: string;
  readonly isEditing: boolean;
  readonly aliasDraft: string;
  readonly runningSessionFiles: readonly string[];
  readonly approvalSessionFiles: readonly string[];
  readonly isImportantSession: (session: SidebarSessionItem) => boolean;
  readonly onChangeAliasDraft: (next: string) => void;
  readonly onCommitRename: () => void;
  readonly onCancelRename: () => void;
  readonly onToggleCollapse: () => void;
  readonly onSelectProject: () => void;
  readonly onNewProjectSession: () => void;
  readonly onOpenProjectMenu: (event: ReactMouseEvent<HTMLButtonElement>) => void;
  readonly onToggleExpand: () => void;
  readonly renderSessionRow: (session: SidebarSessionItem) => ReactNode;
}) {
  const projectStatus = chats.some((session) =>
    approvalSessionFiles.some((file) => sameLocalPath(file, session.file)),
  )
    ? "approval"
    : chats.some((session) => runningSessionFiles.some((file) => sameLocalPath(file, session.file)))
      ? "running"
      : null;

  const showAll = trimmedQuery !== "" || expanded;
  const { visible: visibleChats, hiddenCount } = visibleProjectSessions(
    chats,
    showAll,
    isImportantSession,
    VISIBLE_THREADS_PER_PROJECT,
  );
  const canCollapse =
    trimmedQuery === "" &&
    expanded &&
    visibleProjectSessions(chats, false, isImportantSession, VISIBLE_THREADS_PER_PROJECT).hiddenCount > 0;

  return (
    <section
      className={`project-block${isCurrentWorkspace ? " is-current" : ""}${isMenuOpen ? " is-menu-open" : ""}`}
      data-workspace={workspace}
      data-pinned={projectPinned ? "true" : "false"}
    >
      <div className="project-header-row">
        {isEditing ? (
          <form
            className="project-rename-editor"
            onSubmit={(event) => {
              event.preventDefault();
              onCommitRename();
            }}
          >
            <input
              autoFocus
              value={aliasDraft}
              onChange={(event) => onChangeAliasDraft(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Escape") {
                  event.stopPropagation();
                  onCancelRename();
                }
              }}
              aria-label="项目名称"
            />
            <button type="submit" title="保存" aria-label="保存">
              <Check size={14} />
            </button>
            <button type="button" title="取消" aria-label="取消" onClick={onCancelRename}>
              <X size={14} />
            </button>
          </form>
        ) : (
          <>
            {chats.length > 0 ? (
              <button
                type="button"
                className={`project-collapse-toggle${collapsed ? " is-collapsed" : ""}`}
                title={collapsed ? "展开会话" : "折叠会话"}
                aria-label={`${collapsed ? "展开" : "折叠"} ${projectName} 的会话`}
                aria-expanded={!collapsed}
                onClick={(event) => {
                  event.stopPropagation();
                  onToggleCollapse();
                }}
              >
                <Folder className="project-folder-glyph" size={14} strokeWidth={1.75} aria-hidden="true" />
                <ChevronDown className="project-chevron-glyph" size={13.5} strokeWidth={1.9} aria-hidden="true" />
              </button>
            ) : (
              <span className="project-folder-static" aria-hidden="true">
                <Folder size={14} strokeWidth={1.75} />
              </span>
            )}
            <button
              type="button"
              className="project-header"
              title={workspace}
              onClick={onSelectProject}
            >
              {projectPinned && <Pin className="project-pin-indicator" size={11} aria-label="已置顶项目" />}
              <span className="project-name">{projectName}</span>
              {collapsed && projectStatus !== null && (
                <span
                  className="project-status"
                  data-status={projectStatus}
                  title={projectStatus === "approval" ? "有等待审批的会话" : "有运行中的会话"}
                />
              )}
              {collapsed && chats.length > 0 && <span className="project-count">{chats.length}</span>}
            </button>
            <div className="project-actions">
              <button
                type="button"
                title="在此项目中新建对话"
                aria-label={`在 ${projectName} 中新建对话`}
                onClick={(event) => {
                  event.stopPropagation();
                  onNewProjectSession();
                }}
              >
                <SquarePen size={13.5} />
              </button>
              <button
                type="button"
                title="项目操作"
                aria-label={`${projectName} 项目操作`}
                onClick={(event) => {
                  event.stopPropagation();
                  onOpenProjectMenu(event);
                }}
              >
                <MoreHorizontal size={14} />
              </button>
            </div>
          </>
        )}
      </div>

      {!collapsed && chats.length > 0 && (
        <div className="thread-list">
          {visibleChats.map((session) => renderSessionRow(session))}
          {trimmedQuery === "" && (hiddenCount > 0 || canCollapse) && (
            <button type="button" className="expand-threads" onClick={onToggleExpand}>
              {expanded ? "收起" : `展开其余 ${hiddenCount} 个会话`}
            </button>
          )}
        </div>
      )}
    </section>
  );
}

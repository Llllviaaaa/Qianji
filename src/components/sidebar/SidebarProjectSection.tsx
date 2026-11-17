import type { MouseEvent as ReactMouseEvent, PointerEvent as ReactPointerEvent, ReactNode } from "react";
import {
  Check,
  ChevronDown,
  Folder,
  MoreHorizontal,
  Pin,
  SquarePen,
  X,
} from "lucide-react";
import { sameLocalPath } from "../../lib/pathIdentity";
import type { ProjectConfig, SessionInfo } from "../../types";
import {
  pathsEqual,
  VISIBLE_THREADS_PER_PROJECT,
  visibleProjectSessions,
  type ProjectDropTarget,
} from "./sidebarHelpers";

export interface SidebarProjectSectionProps {
  workspace: string;
  chats: SessionInfo[];
  cwd: string;
  trimmedQuery: string;
  newTaskActive: boolean;
  currentSessionFile: string | null;
  runningSessionFiles: string[];
  approvalSessionFiles: string[];
  collapsed: boolean;
  expanded: boolean;
  setExpandedProjects: React.Dispatch<React.SetStateAction<Record<string, boolean>>>;
  setProjectCollapsed: (workspace: string, collapsed: boolean) => void;
  projectConfig: ProjectConfig;
  projectName: string;
  menuOpen: boolean;
  isEditing: boolean;
  aliasDraft: string;
  setAliasDraft: (next: string) => void;
  setEditingProject: (next: string | null) => void;
  finishProjectRename: () => void;
  isDragging: boolean;
  dropPosition: ProjectDropTarget["position"] | undefined;
  consumeSuppressedProjectClick: () => boolean;
  startProjectDrag: (event: ReactPointerEvent<HTMLDivElement>, workspace: string, pinned: boolean) => void;
  openProjectMenu: (event: ReactMouseEvent<HTMLButtonElement>, workspace: string) => void;
  closePopovers: () => void;
  onOpenProject: (workspace: string) => void;
  onNewProjectSession: (workspace: string) => void;
  renderThreadRow: (session: SessionInfo) => ReactNode;
}

export function SidebarProjectSection({
  workspace,
  chats,
  cwd,
  trimmedQuery,
  newTaskActive,
  currentSessionFile,
  runningSessionFiles,
  approvalSessionFiles,
  collapsed,
  expanded,
  setExpandedProjects,
  setProjectCollapsed,
  projectConfig,
  projectName,
  menuOpen,
  isEditing,
  aliasDraft,
  setAliasDraft,
  setEditingProject,
  finishProjectRename,
  isDragging,
  dropPosition,
  consumeSuppressedProjectClick,
  startProjectDrag,
  openProjectMenu,
  closePopovers,
  onOpenProject,
  onNewProjectSession,
  renderThreadRow,
}: SidebarProjectSectionProps) {
  const projectPinned = projectConfig.pinned;
  const projectStatus = chats.some((session) => approvalSessionFiles.some((file) => sameLocalPath(file, session.file)))
    ? "approval"
    : chats.some((session) => runningSessionFiles.some((file) => sameLocalPath(file, session.file)))
      ? "running"
      : null;

  const isImportantSession = (session: SessionInfo) => (
    (!newTaskActive && sameLocalPath(session.file, currentSessionFile))
    || runningSessionFiles.some((file) => sameLocalPath(file, session.file))
    || approvalSessionFiles.some((file) => sameLocalPath(file, session.file))
  );

  const showAll = Boolean(trimmedQuery) || expanded;
  const { visible: visibleChats, hiddenCount } = visibleProjectSessions(
    chats,
    showAll,
    isImportantSession,
    VISIBLE_THREADS_PER_PROJECT,
  );
  const canCollapse = !trimmedQuery
    && expanded
    && visibleProjectSessions(chats, false, isImportantSession, VISIBLE_THREADS_PER_PROJECT).hiddenCount > 0;

  return (
    <section
      className={`project-block${cwd && pathsEqual(workspace, cwd) ? " is-current" : ""}${isDragging ? " is-dragging" : ""}${menuOpen ? " is-menu-open" : ""}`}
      data-workspace={workspace}
      data-pinned={projectPinned ? "true" : "false"}
      data-drop-position={dropPosition}
    >
      <div
        className="project-header-row"
        onPointerDown={(event) => startProjectDrag(event, workspace, projectPinned)}
      >
        {isEditing ? (
          <form className="project-rename-editor" onSubmit={(event) => { event.preventDefault(); finishProjectRename(); }}>
            <input
              autoFocus
              value={aliasDraft}
              onChange={(event) => setAliasDraft(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Escape") setEditingProject(null);
              }}
              aria-label="项目名称"
            />
            <button type="submit" title="保存" aria-label="保存"><Check size={14} /></button>
            <button type="button" title="取消" aria-label="取消" onClick={() => setEditingProject(null)}><X size={14} /></button>
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
                  setProjectCollapsed(workspace, !collapsed);
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
              onClick={(event) => {
                if (consumeSuppressedProjectClick()) {
                  event.preventDefault();
                  event.stopPropagation();
                  return;
                }
                closePopovers();
                setProjectCollapsed(workspace, false);
                onOpenProject(workspace);
              }}
            >
              <span className="project-name">{projectName}</span>
              {projectPinned && <Pin className="project-pinned-mark" size={11} aria-label="已置顶项目" />}
              {collapsed && projectStatus && (
                <span
                  className="thread-status project-status"
                  data-status={projectStatus}
                  title={projectStatus === "approval" ? "有会话等待审批" : "有会话正在运行"}
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
                  closePopovers();
                  onNewProjectSession(workspace);
                }}
              >
                <SquarePen size={13.5} />
              </button>
              <button
                type="button"
                title="项目操作"
                aria-label={`${projectName} 项目操作`}
                onClick={(event) => openProjectMenu(event, workspace)}
              >
                <MoreHorizontal size={14} />
              </button>
            </div>
          </>
        )}
      </div>
      {!collapsed && chats.length > 0 && (
        <div className="thread-list">
          {visibleChats.map(renderThreadRow)}
          {!trimmedQuery && (hiddenCount > 0 || canCollapse) && (
            <button
              type="button"
              className="expand-threads"
              onClick={() => setExpandedProjects((current) => ({ ...current, [workspace]: !current[workspace] }))}
            >
              {expanded ? "收起" : `展开其余 ${hiddenCount} 个会话`}
            </button>
          )}
        </div>
      )}
    </section>
  );
}

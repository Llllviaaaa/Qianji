import type { MouseEvent as ReactMouseEvent, PointerEvent as ReactPointerEvent } from "react";
import { ArchiveRestore, Trash2 } from "lucide-react";
import { agent } from "../../lib/agent";
import { sameLocalPath } from "../../lib/pathIdentity";
import { sessionTitle } from "../../lib/sessionTitle";
import type { ProjectConfig, SessionInfo } from "../../types";
import {
  compactRelativeTime,
  groupSessionsByTimeBucket,
  pathsEqual,
  VISIBLE_RECENT_THREADS,
  visibleProjectSessions,
  type ProjectDropTarget,
  type SidebarGroupMode,
} from "./sidebarHelpers";
import { SidebarProjectSection } from "./SidebarProjectSection";
import { SidebarThreadRow } from "./SidebarThreadRow";

export interface SidebarThreadAndProjectListsProps {
  workspaceView: "active" | "archived";
  setWorkspaceView: (next: "active" | "archived") => void;
  groupMode: SidebarGroupMode;
  query: string;
  setQuery: (next: string) => void;
  trimmedQuery: string;
  cwd: string;
  newTaskActive: boolean;
  currentSessionFile: string | null;
  runningSessionFiles: string[];
  approvalSessionFiles: string[];
  pinnedSessionFiles: string[];
  togglePinnedSession: (file: string) => void;
  unpinSession: (file: string) => void;
  snippetByFile: Map<string, string>;
  archivedLoading: boolean;
  archivedSessions: SessionInfo[];
  refetchArchived: () => Promise<unknown>;
  onSessionRestored: () => void;
  groups: Array<[string, SessionInfo[]]>;
  recentSessions: SessionInfo[];
  recentExpanded: boolean;
  setRecentExpanded: React.Dispatch<React.SetStateAction<boolean>>;
  expandedProjects: Record<string, boolean>;
  setExpandedProjects: React.Dispatch<React.SetStateAction<Record<string, boolean>>>;
  collapsedProjectPaths: string[];
  setProjectCollapsed: (workspace: string, collapsed: boolean) => void;
  projectConfig: (workspace: string) => ProjectConfig;
  displayProjectName: (workspace: string) => string;
  projectMenuWorkspace: string | null;
  openThreadMenuFile: string | null;
  editingProject: string | null;
  setEditingProject: (next: string | null) => void;
  aliasDraft: string;
  setAliasDraft: (next: string) => void;
  finishProjectRename: () => void;
  editingSessionFile: string | null;
  setEditingSessionFile: (next: string | null) => void;
  sessionTitleDraft: string;
  setSessionTitleDraft: (next: string) => void;
  finishSessionRename: () => void;
  draggingWorkspace: string | null;
  projectDropTarget: ProjectDropTarget | null;
  consumeSuppressedProjectClick: () => boolean;
  startProjectDrag: (event: ReactPointerEvent<HTMLDivElement>, workspace: string, pinned: boolean) => void;
  openProjectMenu: (event: ReactMouseEvent<HTMLButtonElement>, workspace: string) => void;
  openThreadMenu: (event: ReactMouseEvent<HTMLElement>, session: SessionInfo) => void;
  closePopovers: () => void;
  onOpenSession: (session: SessionInfo) => void;
  onArchiveSession: (session: SessionInfo) => void | Promise<void>;
  onOpenProject: (workspace: string) => void;
  onNewProjectSession: (workspace: string) => void;
  onPickFolder: () => void;
}

export function SidebarThreadAndProjectLists({
  workspaceView,
  setWorkspaceView,
  groupMode,
  query,
  setQuery,
  trimmedQuery,
  cwd,
  newTaskActive,
  currentSessionFile,
  runningSessionFiles,
  approvalSessionFiles,
  pinnedSessionFiles,
  togglePinnedSession,
  unpinSession,
  snippetByFile,
  archivedLoading,
  archivedSessions,
  refetchArchived,
  onSessionRestored,
  groups,
  recentSessions,
  recentExpanded,
  setRecentExpanded,
  expandedProjects,
  setExpandedProjects,
  collapsedProjectPaths,
  setProjectCollapsed,
  projectConfig,
  displayProjectName,
  projectMenuWorkspace,
  openThreadMenuFile,
  editingProject,
  setEditingProject,
  aliasDraft,
  setAliasDraft,
  finishProjectRename,
  editingSessionFile,
  setEditingSessionFile,
  sessionTitleDraft,
  setSessionTitleDraft,
  finishSessionRename,
  draggingWorkspace,
  projectDropTarget,
  consumeSuppressedProjectClick,
  startProjectDrag,
  openProjectMenu,
  openThreadMenu,
  closePopovers,
  onOpenSession,
  onArchiveSession,
  onOpenProject,
  onNewProjectSession,
  onPickFolder,
}: SidebarThreadAndProjectListsProps) {
  const isImportantSession = (session: SessionInfo) => (
    (!newTaskActive && sameLocalPath(session.file, currentSessionFile))
    || runningSessionFiles.some((file) => sameLocalPath(file, session.file))
    || approvalSessionFiles.some((file) => sameLocalPath(file, session.file))
  );

  const renderThreadRow = (session: SessionInfo, projectLabel?: string) => {
    const openTargetSession = () => {
      closePopovers();
      setQuery("");
      setProjectCollapsed(session.cwd, false);
      onOpenSession(session);
    };
    const isEditing = Boolean(editingSessionFile && sameLocalPath(session.file, editingSessionFile));
    return (
      <SidebarThreadRow
        key={session.file}
        session={session}
        active={!newTaskActive && sameLocalPath(session.file, currentSessionFile)}
        running={runningSessionFiles.some((file) => sameLocalPath(file, session.file))}
        approval={approvalSessionFiles.some((file) => sameLocalPath(file, session.file))}
        pinned={pinnedSessionFiles.some((file) => sameLocalPath(file, session.file))}
        projectLabel={projectLabel}
        snippet={trimmedQuery ? snippetByFile.get(session.file) : undefined}
        menuOpen={Boolean(openThreadMenuFile && sameLocalPath(session.file, openThreadMenuFile))}
        editing={isEditing}
        renameDraft={isEditing ? sessionTitleDraft : ""}
        onChangeRenameDraft={setSessionTitleDraft}
        onCommitRename={finishSessionRename}
        onCancelRename={() => setEditingSessionFile(null)}
        onOpen={openTargetSession}
        onTogglePinned={() => togglePinnedSession(session.file)}
        onArchive={() => {
          void onArchiveSession(session);
        }}
        onOpenMenu={(event) => openThreadMenu(event, session)}
        onContextMenu={(event) => openThreadMenu(event, session)}
      />
    );
  };

  const renderRecentList = () => {
    const showAllRecent = recentExpanded || Boolean(trimmedQuery);
    const { visible: visibleRecent, hiddenCount: hiddenRecentCount } = visibleProjectSessions(
      recentSessions,
      showAllRecent,
      isImportantSession,
      VISIBLE_RECENT_THREADS,
    );
    const canCollapseRecent = !trimmedQuery
      && recentExpanded
      && visibleProjectSessions(recentSessions, false, isImportantSession, VISIBLE_RECENT_THREADS).hiddenCount > 0;
    const buckets = groupSessionsByTimeBucket(visibleRecent, pinnedSessionFiles);

    return (
      <div className="thread-list-recent">
        {buckets.map((bucket) => (
          <section key={bucket.id} className="thread-bucket-section">
            <div className="thread-bucket-label">{bucket.label}</div>
            <div className="thread-list">
              {bucket.sessions.map((session) => renderThreadRow(session, displayProjectName(session.cwd)))}
            </div>
          </section>
        ))}
        {!trimmedQuery && (hiddenRecentCount > 0 || canCollapseRecent) && (
          <button type="button" className="expand-threads" onClick={() => setRecentExpanded((value) => !value)}>
            {recentExpanded ? "收起" : `展开其余 ${hiddenRecentCount} 个会话`}
          </button>
        )}
      </div>
    );
  };

  return (
    <div className="sidebar-scroll" data-dsh-claude-ws-view={workspaceView}>
      {workspaceView === "archived" ? (
        <div className="dsh-claude-archive-list">
          {archivedLoading ? (
            <div className="dsh-claude-archive-status">正在加载…</div>
          ) : archivedSessions.length === 0 ? (
            <div className="dsh-claude-archive-status">没有已归档的会话</div>
          ) : (
            archivedSessions.map((session) => (
              <div key={session.file} className="dsh-claude-archive-row">
                <button
                  type="button"
                  className="dsh-claude-archive-open"
                  title={sessionTitle(session)}
                  onClick={() => {
                    closePopovers();
                    setQuery("");
                    setWorkspaceView("active");
                    onOpenSession(session);
                  }}
                >
                  <span className="dsh-claude-archive-title">{sessionTitle(session)}</span>
                  <span className="dsh-claude-archive-project">{displayProjectName(session.cwd)}</span>
                  <span className="dsh-claude-archive-time">{compactRelativeTime(session)}</span>
                </button>
                <div className="dsh-claude-archive-actions">
                  <span className="dsh-claude-archive-action">
                    <button
                      type="button"
                      className="dsh-claude-archive-restore"
                      title="取消归档"
                      aria-label="取消归档"
                      onClick={(event) => {
                        event.stopPropagation();
                        void agent.restoreSession(session.file).then(() => {
                          void refetchArchived();
                          onSessionRestored();
                          window.dispatchEvent(new Event("qianji:projects-changed"));
                        });
                      }}
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
                      onClick={(event) => {
                        event.stopPropagation();
                        unpinSession(session.file);
                        void agent.deleteSession(session.file).then(() => {
                          void refetchArchived();
                        });
                      }}
                    >
                      <Trash2 size={14} />
                    </button>
                  </span>
                </div>
              </div>
            ))
          )}
        </div>
      ) : groups.length === 0 ? (
        <div className="sidebar-empty">
          <span>{query ? "没有匹配项" : "打开项目以开始"}</span>
          <button type="button" className="text-link" onClick={onPickFolder}>选择文件夹</button>
        </div>
      ) : groupMode === "recent" ? (
        renderRecentList()
      ) : (
        groups.map(([workspace, chats]) => {
          const collapsed = !trimmedQuery && collapsedProjectPaths.some((path) => pathsEqual(path, workspace));
          const expanded = Boolean(trimmedQuery) || Boolean(expandedProjects[workspace]);
          const isDragging = draggingWorkspace !== null && pathsEqual(draggingWorkspace, workspace);
          const dropPosition = projectDropTarget && pathsEqual(projectDropTarget.workspace, workspace)
            ? projectDropTarget.position
            : undefined;
          const menuOpen = Boolean(projectMenuWorkspace && pathsEqual(projectMenuWorkspace, workspace));

          return (
            <SidebarProjectSection
              key={workspace}
              workspace={workspace}
              chats={chats}
              cwd={cwd}
              trimmedQuery={trimmedQuery}
              newTaskActive={newTaskActive}
              currentSessionFile={currentSessionFile}
              runningSessionFiles={runningSessionFiles}
              approvalSessionFiles={approvalSessionFiles}
              collapsed={collapsed}
              expanded={expanded}
              setExpandedProjects={setExpandedProjects}
              setProjectCollapsed={setProjectCollapsed}
              projectConfig={projectConfig(workspace)}
              projectName={displayProjectName(workspace)}
              menuOpen={menuOpen}
              isEditing={editingProject === workspace}
              aliasDraft={aliasDraft}
              setAliasDraft={setAliasDraft}
              setEditingProject={setEditingProject}
              finishProjectRename={finishProjectRename}
              isDragging={isDragging}
              dropPosition={dropPosition}
              consumeSuppressedProjectClick={consumeSuppressedProjectClick}
              startProjectDrag={startProjectDrag}
              openProjectMenu={openProjectMenu}
              closePopovers={closePopovers}
              onOpenProject={onOpenProject}
              onNewProjectSession={onNewProjectSession}
              renderThreadRow={(session) => renderThreadRow(session)}
            />
          );
        })
      )}
    </div>
  );
}

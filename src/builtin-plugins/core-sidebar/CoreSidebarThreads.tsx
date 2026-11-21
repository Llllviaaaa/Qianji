import type { MouseEvent as ReactMouseEvent } from "react";
import { useFrontendService, useMenusState } from "@qianji/client";
import {
  SlotHost,
  type SidebarThreadsSlotProps,
  type SlotComponentProps,
} from "@qianji/client-slots";
import {
  SidebarArchivedList,
  SidebarContextMenus,
  SidebarProjectsHeader,
} from "./CoreSidebarMenus";
import { CoreSidebarProjectSection } from "./CoreSidebarProjectSection";
import { CoreSidebarSessionRow } from "./CoreSidebarSessionRow";
import {
  dispatchSidebarClosePreview,
  formatSessionTitle,
  groupSessionsByTimeBucket,
  sameLocalPath,
  VISIBLE_RECENT_THREADS,
  visibleProjectSessions,
  type SidebarSessionItem,
} from "./sidebarHelpers";
import { useCoreSidebarThreads } from "./useCoreSidebarThreads";

export { CoreSidebarSessionRow };

function computeMenuTop(event: ReactMouseEvent<HTMLElement>): number {
  const sidebar = event.currentTarget.closest<HTMLElement>("[data-slot='sidebar']");
  const sidebarTop = sidebar?.getBoundingClientRect().top ?? 0;
  return Math.max(54, event.clientY - sidebarTop - 7);
}

export function CoreSidebarThreads(props: SlotComponentProps<SidebarThreadsSlotProps, "root">) {
  const menuService = useFrontendService("menuService", props.ctx);
  useMenusState(props.ctx);
  const state = useCoreSidebarThreads(props);

  const renderSessionRow = (session: SidebarSessionItem, projectLabel?: string) => {
    const isActive = !state.newTaskActive && sameLocalPath(session.file, state.activeSessionFile);
    const isRunning = state.runningSessionFiles.some((file) => sameLocalPath(file, session.file));
    const isApproval = state.approvalSessionFiles.some((file) => sameLocalPath(file, session.file));
    const isPinned = state.pinnedFiles.some((file) => sameLocalPath(file, session.file));
    const snippet =
      state.trimmedQuery !== ""
        ? state.snippetByFile.get(session.file.replace(/\\/g, "/").toLowerCase())
        : undefined;
    const isEditing =
      state.editingSessionFile !== null && sameLocalPath(session.file, state.editingSessionFile);
    const isMenuOpen =
      state.threadMenu !== null && sameLocalPath(state.threadMenu.session.file, session.file);

    const openMenu = (event: ReactMouseEvent<HTMLElement>) => {
      event.preventDefault();
      event.stopPropagation();
      state.setProjectMenu(null);
      state.setFilterMenuOpen(false);
      state.setThreadMenu({ session, top: computeMenuTop(event) });
    };

    return (
      <div key={session.file} style={{ display: "contents" }}>
        <SlotHost
          slotKey="sidebar.sessionRow"
          kind="chain"
          scope="root"
          props={{
            session,
            active: isActive,
            running: isRunning,
            approval: isApproval,
            pinned: isPinned,
            ...(projectLabel === undefined ? {} : { projectLabel }),
            ...(snippet === undefined ? {} : { snippet }),
            menuOpen: isMenuOpen,
            editing: isEditing,
            renameDraft: isEditing ? state.sessionTitleDraft : "",
            onChangeRenameDraft: state.setSessionTitleDraft,
            onCommitRename: state.commitSessionRename,
            onCancelRename: () => state.setEditingSessionFile(null),
            onSelect: () => state.handleOpenSession(session),
            onTogglePinned: () => state.togglePinned(session.file),
            onRename: (nextTitle: string) => void state.sessionService?.renameSession(nextTitle, session.file),
            onArchive: () => state.handleArchiveSession(session),
            onDelete: () => state.handleDeleteSession(session),
            onOpenMenu: openMenu,
            onContextMenu: openMenu,
          }}
        />
      </div>
    );
  };

  const projectMenuChats =
    state.projectMenu !== null
      ? (state.groups.find(([ws]) => sameLocalPath(ws, state.projectMenu?.workspace))?.[1] ?? [])
      : [];
  const projectPluginItems =
    state.projectMenu !== null
      ? (menuService?.getItems("sidebar.project", {
          workspace: state.projectMenu.workspace,
          sessionFiles: projectMenuChats.map((item) => item.file),
        }) ?? [])
      : [];
  const threadPluginItems =
    state.threadMenu !== null
      ? (menuService?.getItems("sidebar.thread", {
          cwd: state.threadMenu.session.cwd,
          sessionFile: state.threadMenu.session.file,
          title: formatSessionTitle(state.threadMenu.session),
        }) ?? [])
      : [];

  const showAllRecent = state.recentExpanded || state.trimmedQuery !== "";
  const { visible: visibleRecent, hiddenCount: hiddenRecentCount } = visibleProjectSessions(
    state.recentSessions,
    showAllRecent,
    state.isImportantSession,
    VISIBLE_RECENT_THREADS,
  );
  const canCollapseRecent =
    state.trimmedQuery === "" &&
    state.recentExpanded &&
    visibleProjectSessions(
      state.recentSessions,
      false,
      state.isImportantSession,
      VISIBLE_RECENT_THREADS,
    ).hiddenCount > 0;

  return (
    <>
      <SidebarProjectsHeader
        workspaceView={state.workspaceView}
        groupMode={state.groupMode}
        filterMenuOpen={state.filterMenuOpen}
        onToggleFilterMenu={() => {
          state.setProjectMenu(null);
          state.setThreadMenu(null);
          state.setFilterMenuOpen((prev) => !prev);
        }}
        onCloseFilterMenu={() => state.setFilterMenuOpen(false)}
        onSelectGroupMode={state.selectGroupMode}
        onToggleArchivedView={() => {
          const nextView = state.workspaceView === "archived" ? "active" : "archived";
          if (nextView === "archived") state.setArchivedLoading(true);
          state.setWorkspaceView(nextView);
          state.setFilterMenuOpen(false);
        }}
        onBackFromArchived={() => state.setWorkspaceView("active")}
        onPickFolder={() => {
          state.setFilterMenuOpen(false);
          void state.workspaceService?.pickFolder().then((selected) => {
            if (selected) {
              dispatchSidebarClosePreview();
              state.navigationService?.navigate({ kind: "home", workspace: selected });
            }
          });
        }}
      />

      <div className="sidebar-scroll" data-dsh-claude-ws-view={state.workspaceView}>
        {state.workspaceView === "archived" ? (
          <SidebarArchivedList
            loading={state.archivedLoading}
            sessions={state.filteredArchivedSessions}
            displayProjectName={state.displayProjectName}
            onOpen={(session) => {
              state.setWorkspaceView("active");
              state.handleOpenSession(session);
            }}
            onRestore={(session) => {
              void state.sessionService
                ?.restoreSession(session.file)
                .then(() => {
                  state.setArchivedSessions((prev) => prev.filter((item) => item.file !== session.file));
                  state.navigationService?.showToast("已恢复对话", "info");
                })
                .catch((error) => {
                  const msg = error instanceof Error ? error.message : String(error);
                  state.navigationService?.showToast(`恢复失败：${msg}`, "error");
                });
            }}
            onDelete={(session) => {
              void state.sessionService
                ?.deleteSession(session.file)
                .then(() => {
                  state.setArchivedSessions((prev) => prev.filter((item) => item.file !== session.file));
                  state.navigationService?.showToast("已删除对话", "info");
                })
                .catch((error) => {
                  const msg = error instanceof Error ? error.message : String(error);
                  state.navigationService?.showToast(`删除失败：${msg}`, "error");
                });
            }}
          />
        ) : state.groups.length === 0 ? (
          <div className="sidebar-empty">
            <span>{state.trimmedQuery !== "" ? "没有匹配项" : "打开项目以开始"}</span>
            <button
              type="button"
              className="text-link"
              onClick={() => {
                void state.workspaceService?.pickFolder().then((selected) => {
                  if (selected) {
                    dispatchSidebarClosePreview();
                    state.navigationService?.navigate({ kind: "home", workspace: selected });
                  }
                });
              }}
            >
              选择文件夹
            </button>
          </div>
        ) : state.groupMode === "recent" ? (
          <div className="thread-list-recent">
            {groupSessionsByTimeBucket(visibleRecent, state.pinnedFiles).map((bucket) => (
              <section key={bucket.id} className="thread-bucket-section">
                <div className="thread-bucket-label">{bucket.label}</div>
                <div className="thread-list">
                  {bucket.sessions.map((session) =>
                    renderSessionRow(session, state.displayProjectName(session.cwd)),
                  )}
                </div>
              </section>
            ))}
            {state.trimmedQuery === "" && (hiddenRecentCount > 0 || canCollapseRecent) && (
              <button
                type="button"
                className="expand-threads"
                onClick={() => state.setRecentExpanded((prev) => !prev)}
              >
                {state.recentExpanded ? "收起" : `展开其余 ${hiddenRecentCount} 个会话`}
              </button>
            )}
          </div>
        ) : (
          state.groups.map(([workspace, chats]) => {
            const cfg = state.projectConfigFor(workspace);
            const collapsed =
              state.trimmedQuery === "" &&
              state.collapsedProjects.some((p) => sameLocalPath(p, workspace));
            return (
              <CoreSidebarProjectSection
                key={workspace}
                workspace={workspace}
                chats={chats}
                projectName={state.displayProjectName(workspace)}
                projectPinned={cfg.pinned}
                isCurrentWorkspace={sameLocalPath(workspace, state.activeCwd)}
                isMenuOpen={
                  state.projectMenu !== null && sameLocalPath(state.projectMenu.workspace, workspace)
                }
                collapsed={collapsed}
                expanded={Boolean(state.expandedProjects[workspace])}
                trimmedQuery={state.trimmedQuery}
                isEditing={
                  state.editingProject !== null && sameLocalPath(state.editingProject, workspace)
                }
                aliasDraft={state.aliasDraft}
                runningSessionFiles={state.runningSessionFiles}
                approvalSessionFiles={state.approvalSessionFiles}
                isImportantSession={state.isImportantSession}
                onChangeAliasDraft={state.setAliasDraft}
                onCommitRename={state.handleCommitProjectRename}
                onCancelRename={() => state.setEditingProject(null)}
                onToggleCollapse={() => state.toggleCollapsedProject(workspace)}
                onSelectProject={() => {
                  state.setProjectMenu(null);
                  state.setThreadMenu(null);
                  if (collapsed) state.toggleCollapsedProject(workspace);
                  dispatchSidebarClosePreview();
                  state.workspaceService?.selectWorkspace(workspace);
                  state.navigationService?.navigate({ kind: "home", workspace });
                }}
                onNewProjectSession={() => {
                  state.setProjectMenu(null);
                  state.setThreadMenu(null);
                  dispatchSidebarClosePreview();
                  state.workspaceService?.selectWorkspace(workspace);
                  state.navigationService?.navigate({ kind: "home", workspace });
                }}
                onOpenProjectMenu={(event) => {
                  state.setThreadMenu(null);
                  state.setFilterMenuOpen(false);
                  state.setProjectMenu((prev) =>
                    prev !== null && sameLocalPath(prev.workspace, workspace)
                      ? null
                      : { workspace, top: computeMenuTop(event) },
                  );
                }}
                onToggleExpand={() =>
                  state.setExpandedProjects((prev) => ({ ...prev, [workspace]: !prev[workspace] }))
                }
                renderSessionRow={(session) => renderSessionRow(session)}
              />
            );
          })
        )}
      </div>

      <SidebarContextMenus
        projectMenu={state.projectMenu}
        projectPinned={
          state.projectMenu !== null && state.projectConfigFor(state.projectMenu.workspace).pinned
        }
        projectItems={projectPluginItems}
        onTogglePinProject={state.handleTogglePinProject}
        onOpenProjectFolder={(workspace) => void state.workspaceService?.openInFileManager(workspace)}
        onCreateWorktree={state.handleCreateWorktree}
        onBeginRenameProject={(workspace) => {
          state.setEditingSessionFile(null);
          state.setEditingProject(workspace);
          state.setAliasDraft(state.displayProjectName(workspace));
        }}
        onArchiveProject={state.handleArchiveProject}
        onRemoveProject={state.handleRemoveProject}
        onCloseProjectMenu={() => state.setProjectMenu(null)}
        threadMenu={state.threadMenu}
        threadItems={threadPluginItems}
        pinnedFiles={state.pinnedFiles}
        onBeginRenameSession={(session) => {
          state.setEditingProject(null);
          state.setEditingSessionFile(session.file);
          state.setSessionTitleDraft(formatSessionTitle(session));
        }}
        onTogglePinned={state.togglePinned}
        onArchiveSession={state.handleArchiveSession}
        onDeleteSession={state.handleDeleteSession}
        onCloseThreadMenu={() => state.setThreadMenu(null)}
      />
    </>
  );
}

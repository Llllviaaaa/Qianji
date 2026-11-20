import { useEffect, useMemo, useState, type MouseEvent as ReactMouseEvent } from "react";
import {
  ChevronDown,
  ChevronRight,
  Folder,
  MoreHorizontal,
  Plus,
} from "lucide-react";
import {
  useFrontendService,
  useMenusState,
  useNavigationState,
  useSessionState,
  useWorkspaceState,
} from "@qianji/client";
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
import { CoreSidebarSessionRow } from "./CoreSidebarSessionRow";
import {
  buildSidebarProjectGroups,
  COLLAPSED_PROJECTS_KEY,
  formatSessionTitle,
  groupSessionsByTimeBucket,
  PINNED_SESSIONS_KEY,
  readGroupMode,
  readStringList,
  repoName,
  sameLocalPath,
  sortSidebarSessions,
  VISIBLE_RECENT_THREADS,
  VISIBLE_THREADS_PER_PROJECT,
  writeGroupMode,
  writeStringList,
  type SidebarGroupMode,
  type SidebarSessionItem,
} from "./sidebarHelpers";

export { CoreSidebarSessionRow };

export function CoreSidebarThreads(props: SlotComponentProps<SidebarThreadsSlotProps, "root">) {
  const { ctx } = props;
  const navigationService = useFrontendService("navigationService", ctx);
  const sessionService = useFrontendService("sessionService", ctx);
  const workspaceService = useFrontendService("workspaceService", ctx);
  const menuService = useFrontendService("menuService", ctx);

  const navSnap = useNavigationState(ctx);
  const sessionSnap = useSessionState(ctx);
  const workspaceSnap = useWorkspaceState(ctx);
  useMenusState(ctx);

  const [query, setQuery] = useState(props.searchQuery ?? "");
  const [workspaceView, setWorkspaceView] = useState<"active" | "archived">("active");
  const [groupMode, setGroupMode] = useState<SidebarGroupMode>(() => readGroupMode());
  const [filterMenuOpen, setFilterMenuOpen] = useState(false);
  const [pinnedFiles, setPinnedFiles] = useState<string[]>(() => readStringList(PINNED_SESSIONS_KEY));
  const [collapsedProjects, setCollapsedProjects] = useState<string[]>(() => readStringList(COLLAPSED_PROJECTS_KEY));
  const [expandedProjects, setExpandedProjects] = useState<Record<string, boolean>>({});
  const [recentExpanded, setRecentExpanded] = useState(false);
  const [archivedSessions, setArchivedSessions] = useState<SidebarSessionItem[]>([]);
  const [archivedLoading, setArchivedLoading] = useState(false);
  const [projectMenu, setProjectMenu] = useState<{ workspace: string; top: number } | null>(null);
  const [threadMenu, setThreadMenu] = useState<{ session: SidebarSessionItem; top: number } | null>(null);
  const [ftsMatches, setFtsMatches] = useState<{
    readonly query: string;
    readonly items: ReadonlyArray<{ readonly file: string; readonly cwd: string; readonly snippet: string; readonly title: string }>;
  }>({ query: "", items: [] });

  useEffect(() => {
    if (typeof window === "undefined") return undefined;
    const onQuery = (event: Event) => {
      const custom = event as CustomEvent<string>;
      if (typeof custom.detail === "string") setQuery(custom.detail);
    };
    window.addEventListener("qianji:sidebar-search-query", onQuery);
    return () => window.removeEventListener("qianji:sidebar-search-query", onQuery);
  }, []);

  useEffect(() => {
    if (workspaceView !== "archived" || sessionService === undefined) return undefined;
    let cancelled = false;
    void (async () => {
      try {
        const list = await sessionService.listArchivedSessions();
        if (!cancelled) {
          setArchivedSessions(list);
          setArchivedLoading(false);
        }
      } catch {
        if (!cancelled) setArchivedLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [sessionService, workspaceView]);

  const effectiveQuery = props.searchQuery !== undefined && props.searchQuery !== "" ? props.searchQuery : query;
  const trimmedQuery = effectiveQuery.trim();

  useEffect(() => {
    if (trimmedQuery === "" || sessionService === undefined) return undefined;
    let cancelled = false;
    const timer = typeof window !== "undefined"
      ? window.setTimeout(() => {
          void sessionService
            .searchSessions(trimmedQuery, { limit: 24 })
            .then((matches) => {
              if (cancelled) return;
              setFtsMatches({
                query: trimmedQuery,
                items: matches.map((m) => ({
                  file: m.session.file,
                  cwd: m.session.cwd,
                  snippet: m.snippet,
                  title: m.session.name || m.session.firstMessage || m.session.file,
                })),
              });
            })
            .catch(() => undefined);
        }, 80)
      : undefined;
    return () => {
      cancelled = true;
      if (timer !== undefined && typeof window !== "undefined") window.clearTimeout(timer);
    };
  }, [sessionService, trimmedQuery]);

  const activeFtsMatches = useMemo(
    () => (trimmedQuery !== "" && ftsMatches.query === trimmedQuery ? ftsMatches.items : []),
    [ftsMatches, trimmedQuery],
  );
  const snippetByFile = useMemo(() => {
    const map = new Map<string, string>();
    for (const item of activeFtsMatches) {
      if (item.snippet.trim() !== "") map.set(item.file.replace(/\\/g, "/").toLowerCase(), item.snippet);
    }
    return map;
  }, [activeFtsMatches]);

  const sessions = useMemo(() => sessionSnap?.sessions ?? [], [sessionSnap?.sessions]);
  const projects = useMemo(() => workspaceSnap?.projects ?? [], [workspaceSnap?.projects]);
  const activeSessionFile = props.activeSessionFile !== undefined
    ? props.activeSessionFile
    : (sessionSnap?.sessionFile ?? null);
  const activeCwd = props.cwd ?? workspaceSnap?.cwd ?? sessionSnap?.cwd ?? "";
  const newTaskActive = (navSnap?.newTask ?? true) && (navSnap?.hubView ?? null) === null;
  const isStreaming = sessionSnap?.isStreaming ?? false;

  const groups = useMemo(() => {
    const base = buildSidebarProjectGroups({ query: effectiveQuery, sessions, projects, pinnedFiles });
    if (activeFtsMatches.length === 0) return base;
    const existingFiles = new Set(base.flatMap(([, chats]) => chats.map((c) => c.file.replace(/\\/g, "/").toLowerCase())));
    const byWorkspace = new Map<string, SidebarSessionItem[]>(base.map(([ws, chats]) => [ws, [...chats]]));
    for (const match of activeFtsMatches) {
      const key = match.file.replace(/\\/g, "/").toLowerCase();
      if (existingFiles.has(key)) continue;
      const found = sessions.find((s) => sameLocalPath(s.file, match.file));
      if (found === undefined) continue;
      existingFiles.add(key);
      const list = byWorkspace.get(found.cwd) ?? [];
      list.push(found);
      byWorkspace.set(found.cwd, list);
    }
    return [...byWorkspace.entries()];
  }, [activeFtsMatches, effectiveQuery, pinnedFiles, projects, sessions]);
  const recentSessions = useMemo(
    () => sortSidebarSessions(groups.flatMap(([, chats]) => chats), pinnedFiles),
    [groups, pinnedFiles],
  );

  const togglePinned = (file: string) => {
    setPinnedFiles((prev) => {
      const exists = prev.some((item) => sameLocalPath(item, file));
      const next = exists ? prev.filter((item) => !sameLocalPath(item, file)) : [file, ...prev];
      writeStringList(PINNED_SESSIONS_KEY, next);
      return next;
    });
  };

  const toggleCollapsedProject = (workspace: string) => {
    setCollapsedProjects((prev) => {
      const exists = prev.some((item) => sameLocalPath(item, workspace));
      const next = exists ? prev.filter((item) => !sameLocalPath(item, workspace)) : [...prev, workspace];
      writeStringList(COLLAPSED_PROJECTS_KEY, next);
      return next;
    });
  };

  const handleOpenSession = (session: SidebarSessionItem) => {
    setProjectMenu(null);
    setThreadMenu(null);
    navigationService?.navigate({ kind: "session", cwd: session.cwd, file: session.file });
  };

  const handleArchiveSession = (session: SidebarSessionItem) => {
    void sessionService?.archiveSession(session.file).then(() => {
      navigationService?.forgetSessions([session.file]);
      navigationService?.showToast("已归档对话", "info");
    });
  };

  const handleDeleteSession = (session: SidebarSessionItem) => {
    void sessionService?.deleteSession(session.file).then(() => {
      navigationService?.forgetSessions([session.file]);
      navigationService?.showToast("已删除对话", "info");
    });
  };

  const renderSessionRow = (session: SidebarSessionItem) => {
    const isActive = !newTaskActive && sameLocalPath(session.file, activeSessionFile);
    const isRunning = isStreaming && sameLocalPath(session.file, activeSessionFile);
    const snippet = snippetByFile.get(session.file.replace(/\\/g, "/").toLowerCase());
    return (
      <div
        key={session.file}
        onContextMenu={(event: ReactMouseEvent<HTMLDivElement>) => {
          event.preventDefault();
          setProjectMenu(null);
          setThreadMenu({ session, top: Math.max(54, event.clientY - 40) });
        }}
      >
        <SlotHost
          slotKey="sidebar.sessionRow"
          kind="chain"
          scope="root"
          props={{
            session,
            active: isActive,
            running: isRunning,
            onSelect: () => handleOpenSession(session),
            onRename: (nextTitle: string) => void sessionService?.renameSession(nextTitle, session.file),
            onArchive: () => handleArchiveSession(session),
            onDelete: () => handleDeleteSession(session),
          }}
        />
        {snippet !== undefined && snippet !== "" && (
          <button
            type="button"
            className="thread-search-snippet"
            onClick={() => handleOpenSession(session)}
          >
            {snippet}
          </button>
        )}
      </div>
    );
  };

  const projectMenuChats = projectMenu !== null
    ? (groups.find(([workspace]) => sameLocalPath(workspace, projectMenu.workspace))?.[1] ?? [])
    : [];
  const projectPluginItems = projectMenu !== null
    ? (menuService?.getItems("sidebar.project", {
        workspace: projectMenu.workspace,
        sessionFiles: projectMenuChats.map((item) => item.file),
      }) ?? [])
    : [];
  const threadPluginItems = threadMenu !== null
    ? (menuService?.getItems("sidebar.thread", {
        cwd: threadMenu.session.cwd,
        sessionFile: threadMenu.session.file,
        title: formatSessionTitle(threadMenu.session),
      }) ?? [])
    : [];

  return (
    <>
      <SidebarProjectsHeader
        workspaceView={workspaceView}
        groupMode={groupMode}
        filterMenuOpen={filterMenuOpen}
        onToggleFilterMenu={() => setFilterMenuOpen((prev) => !prev)}
        onSelectGroupMode={(mode) => {
          setGroupMode(mode);
          writeGroupMode(mode);
          setWorkspaceView("active");
          setFilterMenuOpen(false);
        }}
        onToggleArchivedView={() => {
          const nextView = workspaceView === "archived" ? "active" : "archived";
          if (nextView === "archived") setArchivedLoading(true);
          setWorkspaceView(nextView);
          setFilterMenuOpen(false);
        }}
        onBackFromArchived={() => setWorkspaceView("active")}
        onPickFolder={() => {
          setFilterMenuOpen(false);
          void workspaceService?.pickFolder().then((selected) => {
            if (selected) navigationService?.navigate({ kind: "home", workspace: selected });
          });
        }}
      />

      <div className="sidebar-scroll" data-dsh-claude-ws-view={workspaceView}>
        {workspaceView === "archived" ? (
          <SidebarArchivedList
            loading={archivedLoading}
            sessions={archivedSessions}
            onOpen={(session) => {
              setWorkspaceView("active");
              handleOpenSession(session);
            }}
            onRestore={(session) => {
              void sessionService?.restoreSession(session.file).then(() => {
                setArchivedSessions((prev) => prev.filter((item) => item.file !== session.file));
              });
            }}
            onDelete={(session) => {
              void sessionService?.deleteSession(session.file).then(() => {
                setArchivedSessions((prev) => prev.filter((item) => item.file !== session.file));
              });
            }}
          />
        ) : groups.length === 0 ? (
          <div className="sidebar-empty">
            <span>{trimmedQuery !== "" ? "没有匹配项" : "打开项目以开始"}</span>
            <button
              type="button"
              className="text-link"
              onClick={() => {
                void workspaceService?.pickFolder().then((selected) => {
                  if (selected) navigationService?.navigate({ kind: "home", workspace: selected });
                });
              }}
            >
              选择文件夹
            </button>
          </div>
        ) : groupMode === "recent" ? (
          <div className="thread-list-recent">
            {groupSessionsByTimeBucket(
              recentExpanded || trimmedQuery !== ""
                ? recentSessions
                : recentSessions.slice(0, VISIBLE_RECENT_THREADS),
              pinnedFiles,
            ).map((bucket) => (
              <section key={bucket.id} className="thread-bucket-section">
                <div className="thread-bucket-label">{bucket.label}</div>
                <div className="thread-list">{bucket.sessions.map((session) => renderSessionRow(session))}</div>
              </section>
            ))}
            {trimmedQuery === "" && recentSessions.length > VISIBLE_RECENT_THREADS && (
              <button type="button" className="expand-threads" onClick={() => setRecentExpanded((prev) => !prev)}>
                {recentExpanded ? "收起" : `展开其余 ${recentSessions.length - VISIBLE_RECENT_THREADS} 个会话`}
              </button>
            )}
          </div>
        ) : (
          groups.map(([workspace, chats]) => {
            const collapsed = trimmedQuery === "" && collapsedProjects.some((p) => sameLocalPath(p, workspace));
            const expanded = trimmedQuery !== "" || Boolean(expandedProjects[workspace]);
            const visibleChats = expanded ? chats : chats.slice(0, VISIBLE_THREADS_PER_PROJECT);
            const hiddenCount = Math.max(0, chats.length - visibleChats.length);
            const isCurrentWorkspace = sameLocalPath(workspace, activeCwd);

            return (
              <section key={workspace} className={`project-group${isCurrentWorkspace ? " active" : ""}`}>
                <div className="project-header">
                  <button
                    type="button"
                    className="project-toggle"
                    onClick={() => toggleCollapsedProject(workspace)}
                    aria-expanded={!collapsed}
                  >
                    {collapsed ? <ChevronRight size={13} /> : <ChevronDown size={13} />}
                    <Folder size={13} />
                    <span className="project-name">{repoName(workspace)}</span>
                  </button>
                  <div className="project-actions">
                    <button
                      type="button"
                      title="在此项目中新建会话"
                      aria-label="在此项目中新建会话"
                      onClick={() => {
                        workspaceService?.selectWorkspace(workspace);
                        navigationService?.navigate({ kind: "home", workspace });
                      }}
                    >
                      <Plus size={13} />
                    </button>
                    <button
                      type="button"
                      title="项目操作"
                      aria-label="项目操作"
                      onClick={(event) => {
                        event.stopPropagation();
                        setThreadMenu(null);
                        setProjectMenu((prev) =>
                          prev !== null && sameLocalPath(prev.workspace, workspace)
                            ? null
                            : { workspace, top: Math.max(54, event.clientY - 40) },
                        );
                      }}
                    >
                      <MoreHorizontal size={13} />
                    </button>
                  </div>
                </div>

                {!collapsed && (
                  <div className="thread-list">
                    {visibleChats.map((session) => renderSessionRow(session))}
                    {hiddenCount > 0 && (
                      <button
                        type="button"
                        className="expand-threads"
                        onClick={() => setExpandedProjects((prev) => ({ ...prev, [workspace]: true }))}
                      >
                        展开其余 {hiddenCount} 个会话
                      </button>
                    )}
                  </div>
                )}
              </section>
            );
          })
        )}
      </div>

      <SidebarContextMenus
        projectMenu={projectMenu}
        projectItems={projectPluginItems}
        onOpenProjectFolder={(workspace) => void workspaceService?.openInFileManager(workspace, { reveal: true })}
        onCloseProjectMenu={() => setProjectMenu(null)}
        threadMenu={threadMenu}
        threadItems={threadPluginItems}
        pinnedFiles={pinnedFiles}
        onTogglePinned={togglePinned}
        onArchiveSession={handleArchiveSession}
        onDeleteSession={handleDeleteSession}
        onCloseThreadMenu={() => setThreadMenu(null)}
      />
    </>
  );
}

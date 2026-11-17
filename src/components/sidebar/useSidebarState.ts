import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  type MouseEvent as ReactMouseEvent,
} from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useSyncOnChange } from "../../hooks/useSyncOnChange";
import { agent } from "../../lib/agent";
import { sameLocalPath } from "../../lib/pathIdentity";
import { queryKeys } from "../../lib/queries";
import { sessionTitle } from "../../lib/sessionTitle";
import {
  reconcileSidebarOrder,
  type SidebarOrder,
} from "../../lib/sidebarProjectOrder";
import type { AppNotification, ProjectConfig, SessionInfo } from "../../types";
import {
  buildSidebarProjectGroups,
  COLLAPSED_PROJECTS_KEY,
  GROUP_MODE_KEY,
  NO_PROJECTS,
  pathsEqual,
  PINNED_SESSIONS_KEY,
  readGroupMode,
  readStringList,
  repoName,
  sameOrder,
  sessionTimestamp,
  SIDEBAR_PROJECT_ORDER_KEY,
  type PositionedProjectMenu,
  type SidebarGroupMode,
} from "./sidebarHelpers";
import { sortSidebarSessions } from "../../lib/sidebarProjectOrder";
import { useProjectDragOrder } from "./useProjectDragOrder";

export interface UseSidebarStateOptions {
  sidebarRef: React.RefObject<HTMLElement | null>;
  searchInputRef: React.RefObject<HTMLInputElement | null>;
  sessions: SessionInfo[];
  currentSessionFile: string | null;
  notifications: AppNotification[];
  searchRequested: boolean;
  onSearchRequestHandled?: () => void;
}

export function useSidebarState({
  sidebarRef,
  searchInputRef,
  sessions,
  currentSessionFile,
  notifications,
  searchRequested,
  onSearchRequestHandled,
}: UseSidebarStateOptions) {
  const [query, setQuery] = useState("");
  const [debouncedQuery, setDebouncedQuery] = useState("");
  const [searchOpen, setSearchOpen] = useState(false);
  const [notificationsOpen, setNotificationsOpen] = useState(false);
  const [workspaceView, setWorkspaceView] = useState<"active" | "archived">("active");
  const [groupMode, setGroupMode] = useState<SidebarGroupMode>(readGroupMode);
  useEffect(() => {
    try {
      window.localStorage.setItem(GROUP_MODE_KEY, groupMode);
    } catch {
      // ignore storage errors
    }
  }, [groupMode]);

  const [recentExpanded, setRecentExpanded] = useState(false);
  const [filterMenuOpen, setFilterMenuOpen] = useState(false);
  const [expandedProjects, setExpandedProjects] = useState<Record<string, boolean>>({});
  const [collapsedProjectPaths, setCollapsedProjectPaths] = useState(() => readStringList(COLLAPSED_PROJECTS_KEY));
  useEffect(() => {
    window.localStorage.setItem(COLLAPSED_PROJECTS_KEY, JSON.stringify(collapsedProjectPaths));
  }, [collapsedProjectPaths]);

  const [pinnedSessionFiles, setPinnedSessionFiles] = useState(() => readStringList(PINNED_SESSIONS_KEY));
  useEffect(() => {
    try {
      window.localStorage.setItem(PINNED_SESSIONS_KEY, JSON.stringify(pinnedSessionFiles));
    } catch {
      // ignore storage errors
    }
  }, [pinnedSessionFiles]);
  const [persistedOrder, setPersistedOrder] = useState<SidebarOrder>(() => ({
    sessions: [],
    workspaces: readStringList(SIDEBAR_PROJECT_ORDER_KEY),
  }));
  const [projectMenu, setProjectMenu] = useState<PositionedProjectMenu | null>(null);
  const [editingProject, setEditingProject] = useState<string | null>(null);
  const [aliasDraft, setAliasDraft] = useState("");
  const [editingSessionFile, setEditingSessionFile] = useState<string | null>(null);
  const [sessionTitleDraft, setSessionTitleDraft] = useState("");
  const [expandedForSession, setExpandedForSession] = useState<string | null>(null);

  const queryClient = useQueryClient();
  const projectsQuery = useQuery({
    queryKey: queryKeys.projects(),
    queryFn: () => agent.listProjects().catch((): ProjectConfig[] => []),
  });
  const archivedSessionsQuery = useQuery({
    queryKey: ["claude-sidebar-archived-sessions"],
    queryFn: () => agent.listArchivedSessions().catch((): SessionInfo[] => []),
    enabled: workspaceView === "archived",
  });

  useSyncOnChange([query], () => {
    if (query.trim() === "") {
      setDebouncedQuery("");
    }
  });
  useEffect(() => {
    if (query.trim() === "") return;
    const timer = window.setTimeout(() => {
      setDebouncedQuery(query);
    }, 180);
    return () => window.clearTimeout(timer);
  }, [query]);

  const trimmedQuery = query.trim();
  const debouncedTrimmedQuery = debouncedQuery.trim();
  const sessionSearchQuery = useQuery({
    queryKey: queryKeys.sessionSearch(debouncedTrimmedQuery, workspaceView === "archived"),
    queryFn: () => agent.searchSessions(debouncedTrimmedQuery, { includeArchived: workspaceView === "archived", limit: 50 }),
    enabled: debouncedTrimmedQuery.length > 0,
    placeholderData: (previous) => previous,
  });

  const snippetByFile = useMemo(() => {
    if (!debouncedTrimmedQuery) return new Map<string, string>();
    return new Map((sessionSearchQuery.data ?? []).map((hit) => [hit.session.file, hit.snippet]));
  }, [debouncedTrimmedQuery, sessionSearchQuery.data]);

  const archivedSessions = useMemo(() => {
    const allArchived = [...(archivedSessionsQuery.data ?? [])].sort(
      (left, right) => sessionTimestamp(right) - sessionTimestamp(left),
    );
    if (!trimmedQuery) return allArchived;
    const lower = trimmedQuery.toLowerCase();
    return allArchived.filter((session) => {
      const haystack = `${sessionTitle(session)} ${repoName(session.cwd)} ${session.cwd}`.toLowerCase();
      return haystack.includes(lower) || snippetByFile.has(session.file);
    });
  }, [archivedSessionsQuery.data, snippetByFile, trimmedQuery]);

  const projectConfigs = projectsQuery.data ?? NO_PROJECTS;
  const setProjectConfigs = useCallback(
    (update: (current: ProjectConfig[]) => ProjectConfig[]) =>
      queryClient.setQueryData<ProjectConfig[]>(queryKeys.projects(), (current) => update(current ?? [])),
    [queryClient],
  );
  const loadProjectConfigs = useCallback(
    () => queryClient.invalidateQueries({ queryKey: queryKeys.projects() }),
    [queryClient],
  );

  const visibleProjectPaths = useMemo(
    () => projectConfigs.filter((c) => !c.hidden && Boolean(c.path.trim())).map((c) => c.path),
    [projectConfigs],
  );
  const sidebarOrder = useMemo(
    () => reconcileSidebarOrder(persistedOrder, sessions, visibleProjectPaths),
    [persistedOrder, sessions, visibleProjectPaths],
  );

  useSyncOnChange([sidebarOrder], () => {
    if (sameOrder(sidebarOrder.workspaces, persistedOrder.workspaces)) return;
    setPersistedOrder(sidebarOrder);
  });
  useEffect(() => {
    window.localStorage.setItem(SIDEBAR_PROJECT_ORDER_KEY, JSON.stringify(persistedOrder.workspaces));
  }, [persistedOrder.workspaces]);

  const projectConfig = useCallback(
    (workspace: string): ProjectConfig => projectConfigs.find((project) => pathsEqual(project.path, workspace)) ?? {
      path: workspace,
      name: "",
      pinned: false,
      hidden: false,
    },
    [projectConfigs],
  );
  const displayProjectName = useCallback(
    (workspace: string) => projectConfig(workspace).name.trim() || repoName(workspace),
    [projectConfig],
  );

  const setProjectCollapsed = useCallback((workspace: string, collapsed: boolean) => {
    setCollapsedProjectPaths((current) => {
      const withoutWorkspace = current.filter((path) => !pathsEqual(path, workspace));
      return collapsed ? [...withoutWorkspace, workspace] : withoutWorkspace;
    });
  }, []);

  const groups = useMemo(
    () => buildSidebarProjectGroups({
      query,
      sessions,
      projectConfigs,
      snippetByFile,
      workspaceView,
      searchHits: sessionSearchQuery.data,
      pinnedSessionFiles,
      workspaceOrder: sidebarOrder.workspaces,
    }),
    [pinnedSessionFiles, projectConfigs, query, sessionSearchQuery.data, sessions, sidebarOrder.workspaces, snippetByFile, workspaceView],
  );

  const recentSessions = useMemo(
    () => sortSidebarSessions(groups.flatMap(([, chats]) => chats), pinnedSessionFiles),
    [groups, pinnedSessionFiles],
  );

  const unreadNotificationCount = useMemo(
    () => notifications.reduce((count, item) => count + Number(!item.read), 0),
    [notifications],
  );

  const closePopovers = useCallback(() => {
    setNotificationsOpen(false);
    setSearchOpen(false);
    setProjectMenu(null);
    setFilterMenuOpen(false);
  }, []);

  const drag = useProjectDragOrder({
    sidebarRef,
    trimmedQuery,
    groups,
    projectConfig,
    sidebarOrder,
    setPersistedOrder,
    closePopovers,
  });

  const togglePinnedSession = useCallback((file: string) => {
    setPinnedSessionFiles((current) => (
      current.some((item) => pathsEqual(item, file))
        ? current.filter((item) => !pathsEqual(item, file))
        : [...current, file]
    ));
  }, []);

  const unpinSession = useCallback((file: string) => {
    setPinnedSessionFiles((current) => current.filter((item) => !pathsEqual(item, file)));
  }, []);

  const updateProjectConfig = async (workspace: string, changes: Partial<ProjectConfig>) => {
    const next = { ...projectConfig(workspace), ...changes, path: workspace };
    setProjectConfigs((current) => {
      const existingIndex = current.findIndex((project) => pathsEqual(project.path, workspace));
      if (existingIndex < 0) return [...current, next];
      return current.map((project, index) => (index === existingIndex ? next : project));
    });
    try {
      await agent.saveProject(next);
    } catch {
      await loadProjectConfigs();
    }
  };

  const openProjectMenu = (event: ReactMouseEvent<HTMLButtonElement>, workspace: string) => {
    event.stopPropagation();
    const sidebarRect = sidebarRef.current?.getBoundingClientRect();
    const buttonRect = event.currentTarget.getBoundingClientRect();
    const top = sidebarRect
      ? Math.max(54, Math.min(buttonRect.top - sidebarRect.top - 7, sidebarRect.height - 260))
      : 54;
    setProjectMenu((current) => (current?.workspace === workspace ? null : { workspace, top }));
    setNotificationsOpen(false);
    setSearchOpen(false);
  };

  const beginProjectRename = (workspace: string) => {
    setProjectMenu(null);
    setEditingSessionFile(null);
    setEditingProject(workspace);
    setAliasDraft(displayProjectName(workspace));
  };

  const finishProjectRename = () => {
    if (!editingProject) return;
    const alias = aliasDraft.trim();
    void updateProjectConfig(editingProject, { name: alias === repoName(editingProject) ? "" : alias });
    setEditingProject(null);
  };

  const beginSessionRename = useCallback((session: SessionInfo) => {
    closePopovers();
    setEditingProject(null);
    setEditingSessionFile(session.file);
    setSessionTitleDraft(sessionTitle(session));
  }, [closePopovers]);

  const finishSessionRename = useCallback((
    onRenameSession?: (session: SessionInfo, nextTitle: string) => void | Promise<void>,
  ) => {
    if (!editingSessionFile) return;
    const target = sessions.find((session) => sameLocalPath(session.file, editingSessionFile));
    const nextTitle = sessionTitleDraft.trim();
    setEditingSessionFile(null);
    if (!target || !nextTitle || nextTitle === sessionTitle(target)) return;
    void onRenameSession?.(target, nextTitle);
  }, [editingSessionFile, sessionTitleDraft, sessions]);

  const removeProject = async (workspace: string) => {
    setProjectMenu(null);
    setPersistedOrder((current) => ({
      ...current,
      workspaces: current.workspaces.filter((path) => !pathsEqual(path, workspace)),
    }));
    setProjectConfigs((current) => (current.some((project) => pathsEqual(project.path, workspace))
      ? current.map((project) => (pathsEqual(project.path, workspace) ? { ...project, hidden: true } : project))
      : [...current, { path: workspace, name: "", pinned: false, hidden: true }]));
    try {
      await agent.removeLocalProject(workspace);
    } catch {
      await loadProjectConfigs();
    }
  };

  useEffect(() => {
    const hasOpenPopover = notificationsOpen || searchOpen || projectMenu || editingProject || editingSessionFile || filterMenuOpen;
    if (!hasOpenPopover) return;
    const closeOnOutsidePointer = (event: PointerEvent) => {
      if (!sidebarRef.current?.contains(event.target as Node)) {
        closePopovers();
        setEditingProject(null);
        setEditingSessionFile(null);
      }
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      if (filterMenuOpen || projectMenu) closePopovers();
      if (editingSessionFile) setEditingSessionFile(null);
    };
    document.addEventListener("pointerdown", closeOnOutsidePointer);
    document.addEventListener("keydown", closeOnEscape);
    return () => {
      document.removeEventListener("pointerdown", closeOnOutsidePointer);
      document.removeEventListener("keydown", closeOnEscape);
    };
  }, [closePopovers, editingProject, editingSessionFile, filterMenuOpen, notificationsOpen, projectMenu, searchOpen, sidebarRef]);

  useSyncOnChange([searchRequested], () => {
    if (!searchRequested) return;
    setSearchOpen(true);
    setNotificationsOpen(false);
    setProjectMenu(null);
  });
  useEffect(() => {
    if (!searchRequested) return;
    searchInputRef.current?.focus();
    searchInputRef.current?.select();
    onSearchRequestHandled?.();
  }, [onSearchRequestHandled, searchInputRef, searchRequested]);

  useEffect(() => {
    const reload = () => void loadProjectConfigs();
    window.addEventListener("qianji:projects-changed", reload);
    return () => window.removeEventListener("qianji:projects-changed", reload);
  }, [loadProjectConfigs]);

  useSyncOnChange([currentSessionFile, sessions], () => {
    if (!currentSessionFile || expandedForSession === currentSessionFile) return;
    const activeSession = sessions.find((session) => sameLocalPath(session.file, currentSessionFile));
    if (!activeSession) return;
    setExpandedForSession(currentSessionFile);
    setProjectCollapsed(activeSession.cwd, false);
  });

  return {
    query, setQuery, trimmedQuery, searchOpen, setSearchOpen,
    notificationsOpen, setNotificationsOpen, workspaceView, setWorkspaceView, groupMode, setGroupMode,
    recentExpanded, setRecentExpanded, filterMenuOpen, setFilterMenuOpen, expandedProjects, setExpandedProjects,
    collapsedProjectPaths, pinnedSessionFiles, togglePinnedSession, unpinSession, projectMenu, setProjectMenu,
    editingProject, setEditingProject, aliasDraft, setAliasDraft,
    editingSessionFile, setEditingSessionFile, sessionTitleDraft, setSessionTitleDraft,
    archivedSessionsQuery, archivedSessions, snippetByFile, groups, recentSessions, unreadNotificationCount,
    projectConfig, displayProjectName, setProjectCollapsed, closePopovers, updateProjectConfig,
    openProjectMenu, beginProjectRename, finishProjectRename, beginSessionRename, finishSessionRename,
    removeProject, ...drag,
  };
}

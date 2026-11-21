import { useCallback, useEffect, useMemo, useState } from "react";
import {
  useFrontendService,
  useNavigationState,
  useSessionState,
  useWorkspaceState,
} from "@qianji/client";
import type { SidebarThreadsSlotProps, SlotComponentProps } from "@qianji/client-slots";
import {
  ACTIVE_RUNTIME_KEY,
  buildSidebarProjectGroups,
  COLLAPSED_PROJECTS_KEY,
  dispatchSidebarClearSearch,
  dispatchSidebarClosePopovers,
  dispatchSidebarClosePreview,
  formatSessionTitle,
  LAST_TASK_KEY,
  PINNED_SESSIONS_KEY,
  readGroupMode,
  readStringList,
  repoName,
  sameLocalPath,
  sessionTimestamp,
  SIDEBAR_PROJECT_ORDER_KEY,
  sortSidebarSessions,
  writeGroupMode,
  writeStringList,
  type SidebarGroupMode,
  type SidebarProjectItem,
  type SidebarSessionItem,
} from "./sidebarHelpers";

export function useCoreSidebarThreads(props: SlotComponentProps<SidebarThreadsSlotProps, "root">) {
  const { ctx } = props;
  const navigationService = useFrontendService("navigationService", ctx);
  const sessionService = useFrontendService("sessionService", ctx);
  const workspaceService = useFrontendService("workspaceService", ctx);

  const navSnap = useNavigationState(ctx);
  const sessionSnap = useSessionState(ctx);
  const workspaceSnap = useWorkspaceState(ctx);

  const [query, setQuery] = useState(props.searchQuery ?? "");
  const [workspaceView, setWorkspaceView] = useState<"active" | "archived">("active");
  const [groupMode, setGroupMode] = useState<SidebarGroupMode>(() => readGroupMode());
  const [filterMenuOpen, setFilterMenuOpen] = useState(false);
  const [pinnedFiles, setPinnedFiles] = useState<string[]>(() => readStringList(PINNED_SESSIONS_KEY));
  const [collapsedProjects, setCollapsedProjects] = useState<string[]>(() => readStringList(COLLAPSED_PROJECTS_KEY));
  const [workspaceOrder, setWorkspaceOrder] = useState<string[]>(() => readStringList(SIDEBAR_PROJECT_ORDER_KEY));
  const [expandedProjects, setExpandedProjects] = useState<Record<string, boolean>>({});
  const [recentExpanded, setRecentExpanded] = useState(false);
  const [archivedSessions, setArchivedSessions] = useState<SidebarSessionItem[]>([]);
  const [archivedLoading, setArchivedLoading] = useState(false);
  const [projectMenu, setProjectMenu] = useState<{ workspace: string; top: number } | null>(null);
  const [threadMenu, setThreadMenu] = useState<{ session: SidebarSessionItem; top: number } | null>(null);
  const [editingProject, setEditingProject] = useState<string | null>(null);
  const [aliasDraft, setAliasDraft] = useState("");
  const [editingSessionFile, setEditingSessionFile] = useState<string | null>(null);
  const [sessionTitleDraft, setSessionTitleDraft] = useState("");
  const [ftsMatches, setFtsMatches] = useState<{
    readonly query: string;
    readonly includeArchived: boolean;
    readonly items: ReadonlyArray<{ readonly session: SidebarSessionItem; readonly snippet: string }>;
  }>({ query: "", includeArchived: false, items: [] });

  useEffect(() => {
    if (typeof window === "undefined") return undefined;
    const onQuery = (event: Event) => {
      const custom = event as CustomEvent<string>;
      if (typeof custom.detail === "string") setQuery(custom.detail);
    };
    const onClosePopovers = () => {
      setFilterMenuOpen(false);
      setProjectMenu(null);
      setThreadMenu(null);
    };
    window.addEventListener("qianji:sidebar-search-query", onQuery);
    window.addEventListener("qianji:sidebar-close-popovers", onClosePopovers);
    return () => {
      window.removeEventListener("qianji:sidebar-search-query", onQuery);
      window.removeEventListener("qianji:sidebar-close-popovers", onClosePopovers);
    };
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
  const includeArchivedSearch = workspaceView === "archived";

  useEffect(() => {
    if (trimmedQuery === "" || sessionService === undefined) return undefined;
    let cancelled = false;
    const timer =
      typeof window !== "undefined"
        ? window.setTimeout(() => {
            void sessionService
              .searchSessions(trimmedQuery, { includeArchived: includeArchivedSearch, limit: 50 })
              .then((matches) => {
                if (cancelled) return;
                setFtsMatches({
                  query: trimmedQuery,
                  includeArchived: includeArchivedSearch,
                  items: matches.map((m) => ({ session: m.session, snippet: m.snippet })),
                });
              })
              .catch(() => undefined);
          }, 120)
        : undefined;
    return () => {
      cancelled = true;
      if (timer !== undefined && typeof window !== "undefined") window.clearTimeout(timer);
    };
  }, [includeArchivedSearch, sessionService, trimmedQuery]);

  const activeFtsMatches = useMemo(
    () =>
      trimmedQuery !== "" &&
      ftsMatches.query === trimmedQuery &&
      ftsMatches.includeArchived === includeArchivedSearch
        ? ftsMatches.items
        : [],
    [ftsMatches, includeArchivedSearch, trimmedQuery],
  );
  const snippetByFile = useMemo(() => {
    const map = new Map<string, string>();
    for (const item of activeFtsMatches) {
      if (item.snippet.trim() !== "") {
        map.set(item.session.file.replace(/\\/g, "/").toLowerCase(), item.snippet);
      }
    }
    return map;
  }, [activeFtsMatches]);

  const sessions = useMemo(() => sessionSnap?.sessions ?? [], [sessionSnap?.sessions]);
  const projects = useMemo(() => workspaceSnap?.projects ?? [], [workspaceSnap?.projects]);
  const runningSessionFiles = useMemo(() => sessionSnap?.runningSessionFiles ?? [], [sessionSnap?.runningSessionFiles]);
  const approvalSessionFiles = useMemo(() => sessionSnap?.approvalSessionFiles ?? [], [sessionSnap?.approvalSessionFiles]);
  const activeSessionFile =
    props.activeSessionFile !== undefined ? props.activeSessionFile : (sessionSnap?.sessionFile ?? null);
  const activeCwd = props.cwd ?? workspaceSnap?.cwd ?? sessionSnap?.cwd ?? "";
  const newTaskActive = (navSnap?.newTask ?? true) && (navSnap?.hubView ?? null) === null;

  const projectConfigFor = useCallback(
    (workspace: string): SidebarProjectItem =>
      projects.find((project) => sameLocalPath(project.path, workspace)) ?? {
        path: workspace,
        name: "",
        pinned: false,
        hidden: false,
      },
    [projects],
  );
  const displayProjectName = useCallback(
    (workspace: string) => projectConfigFor(workspace).name.trim() || repoName(workspace),
    [projectConfigFor],
  );

  const groups = useMemo(() => {
    const base = buildSidebarProjectGroups({
      query: effectiveQuery,
      sessions,
      projects,
      pinnedFiles,
      workspaceOrder,
    });
    if (activeFtsMatches.length === 0 || includeArchivedSearch) return base;
    const existingFiles = new Set(
      base.flatMap(([, chats]) => chats.map((c) => c.file.replace(/\\/g, "/").toLowerCase())),
    );
    const byWorkspace = new Map<string, SidebarSessionItem[]>(base.map(([ws, chats]) => [ws, [...chats]]));
    for (const match of activeFtsMatches) {
      const key = match.session.file.replace(/\\/g, "/").toLowerCase();
      if (existingFiles.has(key)) continue;
      const cfg = projects.find((p) => sameLocalPath(p.path, match.session.cwd));
      if (cfg?.hidden) continue;
      const resolved = sessions.find((s) => sameLocalPath(s.file, match.session.file)) ?? match.session;
      existingFiles.add(key);
      const wsKey =
        [...byWorkspace.keys()].find((existing) => sameLocalPath(existing, resolved.cwd)) ??
        cfg?.path.trim() ??
        resolved.cwd;
      const list = byWorkspace.get(wsKey) ?? [];
      list.push(resolved);
      byWorkspace.set(wsKey, list);
    }
    return [...byWorkspace.entries()];
  }, [activeFtsMatches, effectiveQuery, includeArchivedSearch, pinnedFiles, projects, sessions, workspaceOrder]);

  const recentSessions = useMemo(
    () => sortSidebarSessions(groups.flatMap(([, chats]) => chats), pinnedFiles),
    [groups, pinnedFiles],
  );

  const filteredArchivedSessions = useMemo(() => {
    const sorted = [...archivedSessions].sort((a, b) => sessionTimestamp(b) - sessionTimestamp(a));
    if (trimmedQuery === "") return sorted;
    const lower = trimmedQuery.toLowerCase();
    return sorted.filter((session) => {
      const key = session.file.replace(/\\/g, "/").toLowerCase();
      const haystack = `${formatSessionTitle(session)} ${displayProjectName(session.cwd)} ${session.cwd}`.toLowerCase();
      return haystack.includes(lower) || snippetByFile.has(key);
    });
  }, [archivedSessions, displayProjectName, snippetByFile, trimmedQuery]);

  const isImportantSession = useCallback(
    (session: SidebarSessionItem) =>
      (!newTaskActive && sameLocalPath(session.file, activeSessionFile)) ||
      runningSessionFiles.some((file) => sameLocalPath(file, session.file)) ||
      approvalSessionFiles.some((file) => sameLocalPath(file, session.file)),
    [activeSessionFile, approvalSessionFiles, newTaskActive, runningSessionFiles],
  );

  const unpinSession = useCallback((file: string) => {
    setPinnedFiles((prev) => {
      const next = prev.filter((item) => !sameLocalPath(item, file));
      if (next.length !== prev.length) writeStringList(PINNED_SESSIONS_KEY, next);
      return next;
    });
  }, []);

  const togglePinned = useCallback((file: string) => {
    setPinnedFiles((prev) => {
      const exists = prev.some((item) => sameLocalPath(item, file));
      const next = exists ? prev.filter((item) => !sameLocalPath(item, file)) : [file, ...prev];
      writeStringList(PINNED_SESSIONS_KEY, next);
      return next;
    });
  }, []);

  const toggleCollapsedProject = useCallback((workspace: string) => {
    setCollapsedProjects((prev) => {
      const exists = prev.some((item) => sameLocalPath(item, workspace));
      const next = exists ? prev.filter((item) => !sameLocalPath(item, workspace)) : [...prev, workspace];
      writeStringList(COLLAPSED_PROJECTS_KEY, next);
      return next;
    });
  }, []);

  const selectGroupMode = useCallback((mode: SidebarGroupMode) => {
    setGroupMode(mode);
    writeGroupMode(mode);
    setWorkspaceView("active");
    setFilterMenuOpen(false);
  }, []);

  const handleOpenSession = useCallback(
    (session: SidebarSessionItem) => {
      setProjectMenu(null);
      setThreadMenu(null);
      setQuery("");
      dispatchSidebarClearSearch();
      dispatchSidebarClosePopovers();
      dispatchSidebarClosePreview();
      setCollapsedProjects((prev) => {
        if (!prev.some((p) => sameLocalPath(p, session.cwd))) return prev;
        const next = prev.filter((p) => !sameLocalPath(p, session.cwd));
        writeStringList(COLLAPSED_PROJECTS_KEY, next);
        return next;
      });
      navigationService?.navigate({ kind: "session", cwd: session.cwd, file: session.file });
    },
    [navigationService],
  );

  const cleanupAfterRemovedActive = useCallback(
    (session: SidebarSessionItem) => {
      unpinSession(session.file);
      navigationService?.forgetSessions([session.file]);
      if (sameLocalPath(session.file, activeSessionFile)) {
        try {
          window.localStorage.removeItem(ACTIVE_RUNTIME_KEY);
          window.localStorage.removeItem(LAST_TASK_KEY);
        } catch {
          // Ignore storage errors.
        }
        navigationService?.navigate({ kind: "home", workspace: session.cwd || activeCwd });
      }
    },
    [activeCwd, activeSessionFile, navigationService, unpinSession],
  );

  const handleArchiveSession = useCallback(
    (session: SidebarSessionItem) => {
      if (sessionService === undefined) return;
      void sessionService
        .archiveSession(session.file)
        .then(() => {
          cleanupAfterRemovedActive(session);
          navigationService?.showToast("已归档对话", "info");
        })
        .catch((error) => {
          const msg = error instanceof Error ? error.message : String(error);
          navigationService?.showToast(`归档失败：${msg}`, "error");
        });
    },
    [cleanupAfterRemovedActive, navigationService, sessionService],
  );

  const handleDeleteSession = useCallback(
    (session: SidebarSessionItem) => {
      if (sessionService === undefined) return;
      void sessionService
        .deleteSession(session.file)
        .then(() => {
          cleanupAfterRemovedActive(session);
          navigationService?.showToast("已删除对话", "info");
        })
        .catch((error) => {
          const msg = error instanceof Error ? error.message : String(error);
          navigationService?.showToast(`删除失败：${msg}`, "error");
        });
    },
    [cleanupAfterRemovedActive, navigationService, sessionService],
  );

  const handleTogglePinProject = useCallback(
    (workspace: string) => {
      if (workspaceService === undefined) return;
      const cfg = projectConfigFor(workspace);
      void workspaceService.saveProject({ ...cfg, path: workspace, pinned: !cfg.pinned }).catch((error) => {
        const msg = error instanceof Error ? error.message : String(error);
        navigationService?.showToast(`更新项目置顶失败：${msg}`, "error");
      });
    },
    [navigationService, projectConfigFor, workspaceService],
  );

  const handleCreateWorktree = useCallback(
    (workspace: string) => {
      if (workspaceService === undefined) return;
      void workspaceService
        .createWorktree(workspace)
        .then((createdPath) => {
          dispatchSidebarClosePreview();
          navigationService?.navigate({ kind: "home", workspace: createdPath });
          navigationService?.showToast("已创建永久工作树", "info");
        })
        .catch((error) => {
          const msg = error instanceof Error ? error.message : String(error);
          navigationService?.showToast(`创建工作树失败：${msg}`, "error");
        });
    },
    [navigationService, workspaceService],
  );

  const handleCommitProjectRename = useCallback(() => {
    if (editingProject === null || workspaceService === undefined) {
      setEditingProject(null);
      return;
    }
    const target = editingProject;
    const alias = aliasDraft.trim();
    const cfg = projectConfigFor(target);
    setEditingProject(null);
    void workspaceService
      .saveProject({ ...cfg, path: target, name: alias === repoName(target) ? "" : alias })
      .catch((error) => {
        const msg = error instanceof Error ? error.message : String(error);
        navigationService?.showToast(`重命名项目失败：${msg}`, "error");
      });
  }, [aliasDraft, editingProject, navigationService, projectConfigFor, workspaceService]);

  const handleArchiveProject = useCallback(
    (workspace: string) => {
      if (sessionService === undefined) return;
      const chats = groups.find(([ws]) => sameLocalPath(ws, workspace))?.[1] ?? [];
      if (chats.length === 0) return;
      void Promise.all(chats.map((chat) => sessionService.archiveSession(chat.file)))
        .then(() => {
          for (const chat of chats) cleanupAfterRemovedActive(chat);
          navigationService?.showToast(`已归档 ${chats.length} 个会话`, "info");
        })
        .catch((error) => {
          const msg = error instanceof Error ? error.message : String(error);
          navigationService?.showToast(`批量归档失败：${msg}`, "error");
        });
    },
    [cleanupAfterRemovedActive, groups, navigationService, sessionService],
  );

  const handleRemoveProject = useCallback(
    (workspace: string) => {
      if (workspaceService === undefined) return;
      setWorkspaceOrder((prev) => {
        const next = prev.filter((ws) => !sameLocalPath(ws, workspace));
        writeStringList(SIDEBAR_PROJECT_ORDER_KEY, next);
        return next;
      });
      void workspaceService.removeLocalProject(workspace).catch((error) => {
        const msg = error instanceof Error ? error.message : String(error);
        navigationService?.showToast(`移除本地项目失败：${msg}`, "error");
      });
    },
    [navigationService, workspaceService],
  );

  const commitSessionRename = useCallback(() => {
    if (editingSessionFile === null) return;
    const target = sessions.find((s) => sameLocalPath(s.file, editingSessionFile));
    const nextTitle = sessionTitleDraft.trim();
    setEditingSessionFile(null);
    if (target === undefined || nextTitle === "" || nextTitle === formatSessionTitle(target)) return;
    void sessionService?.renameSession(nextTitle, target.file).catch((error) => {
      const msg = error instanceof Error ? error.message : String(error);
      navigationService?.showToast(`重命名对话失败：${msg}`, "error");
    });
  }, [editingSessionFile, navigationService, sessionService, sessionTitleDraft, sessions]);

  return {
    navigationService,
    sessionService,
    workspaceService,
    workspaceView,
    setWorkspaceView,
    groupMode,
    selectGroupMode,
    filterMenuOpen,
    setFilterMenuOpen,
    pinnedFiles,
    collapsedProjects,
    expandedProjects,
    setExpandedProjects,
    recentExpanded,
    setRecentExpanded,
    archivedLoading,
    setArchivedLoading,
    setArchivedSessions,
    projectMenu,
    setProjectMenu,
    threadMenu,
    setThreadMenu,
    editingProject,
    setEditingProject,
    aliasDraft,
    setAliasDraft,
    editingSessionFile,
    setEditingSessionFile,
    sessionTitleDraft,
    setSessionTitleDraft,
    trimmedQuery,
    snippetByFile,
    runningSessionFiles,
    approvalSessionFiles,
    activeSessionFile,
    activeCwd,
    newTaskActive,
    projectConfigFor,
    displayProjectName,
    groups,
    recentSessions,
    filteredArchivedSessions,
    isImportantSession,
    togglePinned,
    toggleCollapsedProject,
    handleOpenSession,
    handleArchiveSession,
    handleDeleteSession,
    handleTogglePinProject,
    handleCreateWorktree,
    handleCommitProjectRename,
    handleArchiveProject,
    handleRemoveProject,
    commitSessionRename,
  };
}

import type { ProjectConfig, SessionInfo } from "../types";

export type SidebarProjectGroup = [workspace: string, sessions: SessionInfo[]];

function normalizedPath(path: string): string {
  return path.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
}

function sessionRecencyMs(session: SessionInfo): number {
  if (typeof session.updatedAt === "number" && Number.isFinite(session.updatedAt)) {
    return session.updatedAt;
  }
  const created = session.createdAt ? Date.parse(session.createdAt) : NaN;
  return Number.isFinite(created) ? created : 0;
}

export function reconcileSidebarSessionOrder(
  previous: string[],
  sessions: SessionInfo[],
): string[] {
  const available = new Map(sessions.map((session) => [normalizedPath(session.file), session.file]));
  const retained = previous
    .map((file) => available.get(normalizedPath(file)))
    .filter((file): file is string => Boolean(file));
  const retainedKeys = new Set(retained.map(normalizedPath));
  const added = sessions
    .map((session) => session.file)
    .filter((file) => !retainedKeys.has(normalizedPath(file)));
  return [...added, ...retained];
}

/** What the sidebar remembers between refreshes and restarts. */
export interface SidebarOrder {
  /** Legacy field kept for compatibility while workspace order stays fixed across refreshes. */
  sessions: string[];
  /** Normalized workspace paths, in the fixed order the sidebar lists them. */
  workspaces: string[];
}

/**
 * Updates the remembered workspace order against the sessions and registered projects now listed.
 *
 * Existing workspaces keep their fixed slots once discovered: sending messages or
 * archiving sessions inside a workspace never moves it. Newly opened or discovered
 * workspaces are inserted at the top of the unpinned list so fresh projects are
 * immediately reachable while manual drag-and-drop ordering remains preserved.
 */
export function reconcileSidebarOrder(
  previous: SidebarOrder,
  sessions: SessionInfo[],
  extraWorkspaces: readonly string[] = [],
): SidebarOrder {
  const normalizedExtra = [
    ...new Set(extraWorkspaces.map(normalizedPath).filter(Boolean)),
  ];
  if (sessions.length === 0) {
    if (normalizedExtra.length === 0) return previous;
    // Wait for sessions before seeding an empty workspace order from legacy session-only state.
    if (previous.workspaces.length === 0 && previous.sessions.length > 0) return previous;
    const retainedOnly = [...new Set(previous.workspaces.map(normalizedPath).filter(Boolean))];
    const listedOnly = new Set(retainedOnly);
    const addedOnly = normalizedExtra.filter((workspace) => !listedOnly.has(workspace));
    if (addedOnly.length === 0 && retainedOnly.length === previous.workspaces.length) return previous;
    return {
      sessions: previous.sessions,
      workspaces: retainedOnly.length > 0 ? [...addedOnly, ...retainedOnly] : addedOnly,
    };
  }

  const sessionOrder = reconcileSidebarSessionOrder(previous.sessions, sessions);
  const workspaceByFile = new Map(
    sessions.map((session) => [normalizedPath(session.file), normalizedPath(session.cwd)]),
  );
  const workspacesOf = (files: readonly string[]) => [
    ...new Set(files.map((file) => workspaceByFile.get(normalizedPath(file)) ?? "").filter(Boolean)),
  ];
  const retained = [...new Set(previous.workspaces.map(normalizedPath).filter(Boolean))];

  if (retained.length === 0) {
    const seededFiles = previous.sessions.length > 0
      ? sessionOrder
      : sortSidebarSessions(sessions, []).map((session) => session.file);
    const seeded = workspacesOf(seededFiles);
    const seededSet = new Set(seeded);
    const extraNew = normalizedExtra.filter((workspace) => !seededSet.has(workspace));
    return {
      sessions: sessionOrder,
      workspaces: [...extraNew, ...seeded],
    };
  }

  const listed = new Set(retained);
  const addedFromProjects = normalizedExtra.filter((workspace) => !listed.has(workspace));
  for (const workspace of addedFromProjects) listed.add(workspace);
  const recencySortedFiles = sortSidebarSessions(sessions, []).map((session) => session.file);
  const addedFromSessions = workspacesOf(recencySortedFiles).filter((workspace) => !listed.has(workspace));
  return {
    sessions: sessionOrder,
    workspaces: [...addedFromProjects, ...addedFromSessions, ...retained],
  };
}

/** Moves `sourceWorkspace` directly before or after `targetWorkspace` while preserving all other slots. */
export function reorderSidebarWorkspaces(
  workspaces: readonly string[],
  sourceWorkspace: string,
  targetWorkspace: string,
  position: "before" | "after" = "before",
): string[] {
  const source = normalizedPath(sourceWorkspace);
  const target = normalizedPath(targetWorkspace);
  const unique = [...new Set(workspaces.map(normalizedPath).filter(Boolean))];
  if (!source || !target || source === target) return unique;
  if (!unique.includes(source)) unique.push(source);
  if (!unique.includes(target)) unique.push(target);
  const withoutSource = unique.filter((workspace) => workspace !== source);
  const targetIndex = withoutSource.indexOf(target);
  if (targetIndex < 0) return unique;
  const insertIndex = position === "after" ? targetIndex + 1 : targetIndex;
  return [
    ...withoutSource.slice(0, insertIndex),
    source,
    ...withoutSource.slice(insertIndex),
  ];
}

/** Sorts sessions with pinned sessions first, then strictly descending by last conversation activity. */
export function sortSidebarSessions(
  sessions: readonly SessionInfo[],
  pinnedFiles: readonly string[],
): SessionInfo[] {
  const pinned = new Set(pinnedFiles.map(normalizedPath));
  const sourceRank = new Map(sessions.map((session, index) => [normalizedPath(session.file), index]));
  return [...sessions].sort((a, b) => {
    const pinDifference = Number(pinned.has(normalizedPath(b.file)))
      - Number(pinned.has(normalizedPath(a.file)));
    if (pinDifference !== 0) return pinDifference;
    const timeDifference = sessionRecencyMs(b) - sessionRecencyMs(a);
    if (timeDifference !== 0) return timeDifference;
    return (sourceRank.get(normalizedPath(a.file)) ?? Number.MAX_SAFE_INTEGER)
      - (sourceRank.get(normalizedPath(b.file)) ?? Number.MAX_SAFE_INTEGER);
  });
}

export function sortSidebarProjectGroups(
  groups: SidebarProjectGroup[],
  projectConfigs: ProjectConfig[],
  workspaceOrder: string[] = [],
): SidebarProjectGroup[] {
  const pinnedProjects = new Set(
    projectConfigs
      .filter((project) => project.pinned)
      .map((project) => normalizedPath(project.path)),
  );
  const workspaceRank = new Map(workspaceOrder.map((workspace, index) => [normalizedPath(workspace), index]));
  const sourceRank = new Map(groups.map(([workspace], index) => [normalizedPath(workspace), index]));

  return [...groups].sort((a, b) => {
    const pinDifference = Number(pinnedProjects.has(normalizedPath(b[0])))
      - Number(pinnedProjects.has(normalizedPath(a[0])));
    if (pinDifference !== 0) return pinDifference;

    const rankA = workspaceRank.get(normalizedPath(a[0]));
    const rankB = workspaceRank.get(normalizedPath(b[0]));
    if (rankA !== undefined && rankB !== undefined) return rankA - rankB;
    if (rankA !== undefined) return -1;
    if (rankB !== undefined) return 1;

    const newestA = a[1].reduce((max, item) => Math.max(max, sessionRecencyMs(item)), 0);
    const newestB = b[1].reduce((max, item) => Math.max(max, sessionRecencyMs(item)), 0);
    if (newestA !== newestB) return newestB - newestA;

    return (sourceRank.get(normalizedPath(a[0])) ?? Number.MAX_SAFE_INTEGER)
      - (sourceRank.get(normalizedPath(b[0])) ?? Number.MAX_SAFE_INTEGER);
  });
}

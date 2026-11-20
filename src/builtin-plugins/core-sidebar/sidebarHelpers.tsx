import type { ReactNode } from "react";
import { SlotKernelErrorBoundary } from "@qianji/client-slots";
import type {
  NavigationSnapshot,
  SessionServiceSnapshot,
  WorkspaceServiceSnapshot,
} from "@qianji/client";

export type SidebarSessionItem = SessionServiceSnapshot["sessions"][number];
export type SidebarNotificationItem = NavigationSnapshot["notifications"][number];
export type SidebarProjectItem = WorkspaceServiceSnapshot["projects"][number];
export type SidebarGroupMode = "project" | "recent";

export const PINNED_SESSIONS_KEY = "qianji:pinned-sessions";
export const COLLAPSED_PROJECTS_KEY = "qianji:collapsed-projects";
export const GROUP_MODE_KEY = "qianji:sidebar-group-mode";
export const VISIBLE_THREADS_PER_PROJECT = 5;
export const VISIBLE_RECENT_THREADS = 15;

export interface TimeBucketGroup {
  readonly id: string;
  readonly label: string;
  readonly sessions: SidebarSessionItem[];
}

export function normalizeLocalPath(path: string | null | undefined): string {
  if (!path) return "";
  return path.trim().replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
}

export function sameLocalPath(left: string | null | undefined, right: string | null | undefined): boolean {
  const a = normalizeLocalPath(left);
  const b = normalizeLocalPath(right);
  return a !== "" && a === b;
}

export function repoName(path: string): string {
  if (!path) return "未知项目";
  if (path.toLowerCase().endsWith("quick-chat")) return "快速对话";
  if (/^https?:\/\//i.test(path)) {
    try {
      const parsed = new URL(path);
      return parsed.pathname.split("/").filter(Boolean).pop() || parsed.hostname;
    } catch {
      return "远程项目";
    }
  }
  return path.split(/[\\/]/).filter(Boolean).pop() || path;
}

export function formatSessionTitle(session: SidebarSessionItem): string {
  const explicit = session.name?.trim();
  if (explicit) return explicit;
  const first = session.firstMessage?.trim();
  if (first) return first.replace(/\s+/g, " ").slice(0, 72);
  return "新对话";
}

export function sessionTimestamp(session: SidebarSessionItem): number {
  return session.updatedAt || (session.createdAt ? Date.parse(session.createdAt) : 0) || 0;
}

export function compactRelativeTime(session: SidebarSessionItem, now = Date.now()): string {
  const timestamp = sessionTimestamp(session);
  if (!timestamp) return "";
  const minutes = Math.floor(Math.max(0, now - timestamp) / 60_000);
  if (minutes < 1) return "刚刚";
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d`;
  const date = new Date(timestamp);
  const nowDate = new Date(now);
  const pad2 = (value: number) => String(value).padStart(2, "0");
  if (date.getFullYear() === nowDate.getFullYear()) {
    return `${pad2(date.getMonth() + 1)}/${pad2(date.getDate())}`;
  }
  return `${String(date.getFullYear()).slice(-2)}/${pad2(date.getMonth() + 1)}`;
}

export function readStringList(key: string): string[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = window.localStorage.getItem(key);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === "string") : [];
  } catch {
    return [];
  }
}

export function writeStringList(key: string, items: readonly string[]): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(key, JSON.stringify(items));
  } catch {
    // Ignore storage write errors in restricted environments.
  }
}

export function readGroupMode(): SidebarGroupMode {
  if (typeof window === "undefined") return "project";
  try {
    return window.localStorage.getItem(GROUP_MODE_KEY) === "recent" ? "recent" : "project";
  } catch {
    return "project";
  }
}

export function writeGroupMode(mode: SidebarGroupMode): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(GROUP_MODE_KEY, mode);
  } catch {
    // Ignore storage write errors.
  }
}

export function sortSidebarSessions(
  sessions: readonly SidebarSessionItem[],
  pinnedFiles: readonly string[],
): SidebarSessionItem[] {
  const pinnedSet = new Set(pinnedFiles.map((file) => normalizeLocalPath(file)));
  return [...sessions].sort((left, right) => {
    const leftPinned = pinnedSet.has(normalizeLocalPath(left.file)) ? 1 : 0;
    const rightPinned = pinnedSet.has(normalizeLocalPath(right.file)) ? 1 : 0;
    if (leftPinned !== rightPinned) return rightPinned - leftPinned;
    return sessionTimestamp(right) - sessionTimestamp(left);
  });
}

export function groupSessionsByTimeBucket(
  sessions: readonly SidebarSessionItem[],
  pinnedFiles: readonly string[],
  now = Date.now(),
): TimeBucketGroup[] {
  const pinnedSet = new Set(pinnedFiles.map((file) => normalizeLocalPath(file)));
  const nowDate = new Date(now);
  const y = nowDate.getFullYear();
  const m = nowDate.getMonth();
  const d = nowDate.getDate();
  const startOfToday = new Date(y, m, d).getTime();
  const startOfYesterday = new Date(y, m, d - 1).getTime();
  const startOf7Days = new Date(y, m, d - 6).getTime();
  const startOf30Days = new Date(y, m, d - 29).getTime();

  const buckets: TimeBucketGroup[] = [
    { id: "pinned", label: "置顶", sessions: [] },
    { id: "today", label: "今天", sessions: [] },
    { id: "yesterday", label: "昨天", sessions: [] },
    { id: "week", label: "过去 7 天", sessions: [] },
    { id: "month", label: "过去 30 天", sessions: [] },
    { id: "older", label: "更早", sessions: [] },
  ];

  for (const session of sortSidebarSessions(sessions, pinnedFiles)) {
    if (pinnedSet.has(normalizeLocalPath(session.file))) {
      buckets[0]?.sessions.push(session);
      continue;
    }
    const ts = sessionTimestamp(session);
    if (ts >= startOfToday) buckets[1]?.sessions.push(session);
    else if (ts >= startOfYesterday) buckets[2]?.sessions.push(session);
    else if (ts >= startOf7Days) buckets[3]?.sessions.push(session);
    else if (ts >= startOf30Days) buckets[4]?.sessions.push(session);
    else buckets[5]?.sessions.push(session);
  }
  return buckets.filter((bucket) => bucket.sessions.length > 0);
}

export function buildSidebarProjectGroups(options: {
  readonly query: string;
  readonly sessions: readonly SidebarSessionItem[];
  readonly projects: readonly SidebarProjectItem[];
  readonly pinnedFiles: readonly string[];
}): Array<[string, SidebarSessionItem[]]> {
  const normalizedQuery = options.query.trim().toLowerCase();
  const map = new Map<string, SidebarSessionItem[]>();

  const canonicalKey = (rawWorkspace: string): string => {
    if (!rawWorkspace) return "未知项目";
    for (const existing of map.keys()) {
      if (sameLocalPath(existing, rawWorkspace)) return existing;
    }
    const configured = options.projects.find((project) => sameLocalPath(project.path, rawWorkspace));
    return configured?.path.trim() || rawWorkspace;
  };

  for (const session of options.sessions) {
    const config = options.projects.find((project) => sameLocalPath(project.path, session.cwd));
    if (config?.hidden) continue;
    const title = formatSessionTitle(session);
    const projectName = config?.name.trim() || repoName(session.cwd);
    const haystack = `${title} ${projectName} ${session.cwd}`.toLowerCase();
    if (normalizedQuery !== "" && !haystack.includes(normalizedQuery)) continue;
    const key = canonicalKey(session.cwd);
    const bucket = map.get(key) ?? [];
    bucket.push(session);
    map.set(key, bucket);
  }

  for (const project of options.projects) {
    if (project.hidden || project.path.trim() === "") continue;
    if ([...map.keys()].some((existing) => sameLocalPath(existing, project.path))) continue;
    const projectName = project.name.trim() || repoName(project.path);
    const haystack = `${projectName} ${project.path}`.toLowerCase();
    if (normalizedQuery !== "" && !haystack.includes(normalizedQuery)) continue;
    map.set(project.path, []);
  }

  const entries: Array<[string, SidebarSessionItem[]]> = [];
  for (const [workspace, chats] of map.entries()) {
    entries.push([workspace, sortSidebarSessions(chats, options.pinnedFiles)]);
  }

  return entries.sort(([leftPath, leftChats], [rightPath, rightChats]) => {
    const leftPinned = options.projects.find((p) => sameLocalPath(p.path, leftPath))?.pinned === true ? 1 : 0;
    const rightPinned = options.projects.find((p) => sameLocalPath(p.path, rightPath))?.pinned === true ? 1 : 0;
    if (leftPinned !== rightPinned) return rightPinned - leftPinned;
    const leftLatest = leftChats[0] ? sessionTimestamp(leftChats[0]) : 0;
    const rightLatest = rightChats[0] ? sessionTimestamp(rightChats[0]) : 0;
    if (leftLatest !== rightLatest) return rightLatest - leftLatest;
    return repoName(leftPath).localeCompare(repoName(rightPath));
  });
}

function LegacySidebarBody<C>({
  renderFn,
  context,
}: {
  readonly renderFn: (ctx: C) => ReactNode;
  readonly context: C;
}): ReactNode {
  return renderFn(context);
}

export function LegacySidebarSectionHost<C>({
  id,
  pluginId,
  renderFn,
  context,
}: {
  readonly id: string;
  readonly pluginId?: string;
  readonly renderFn: (ctx: C) => ReactNode;
  readonly context: C;
}): ReactNode {
  const resolvedPluginId = pluginId ?? "builtin";
  return (
    <div data-qj-plugin={resolvedPluginId} data-qj-legacy-slot="leftSidebar" style={{ display: "contents" }}>
      <SlotKernelErrorBoundary
        pluginId={resolvedPluginId}
        entryId={`legacy:leftSidebar:${id}`}
        slotKey="leftSidebar"
      >
        <LegacySidebarBody renderFn={renderFn} context={context} />
      </SlotKernelErrorBoundary>
    </div>
  );
}

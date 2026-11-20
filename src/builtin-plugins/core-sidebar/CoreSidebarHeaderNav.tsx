import { useEffect, useRef, useState } from "react";
import {
  Bell,
  Boxes,
  Check,
  CheckCircle2,
  ChevronDown,
  ChevronUp,
  Clock3,
  MessageCircleQuestion,
  Plus,
  Puzzle,
  Search,
  ShieldCheck,
  X,
} from "lucide-react";
import {
  useClientContributions,
  useFrontendService,
  useNavigationState,
  useSessionState,
  useWorkspaceState,
  type ClientPageContribution,
  type NavigationHubView,
} from "@qianji/client";
import type {
  SidebarHeaderSlotProps,
  SidebarNavSlotProps,
  SlotComponentProps,
} from "@qianji/client-slots";
import { sameLocalPath } from "./sidebarHelpers";

const COLLAPSED_PLUGIN_PAGE_LIMIT = 3;
const COLLAPSED_PLUGIN_PAGE_HEAD = 2;

export function dispatchSidebarSearchQuery(query: string): void {
  if (typeof window !== "undefined") {
    window.dispatchEvent(new CustomEvent("qianji:sidebar-search-query", { detail: query }));
  }
}

export function CoreSidebarHeader(props: SlotComponentProps<SidebarHeaderSlotProps, "root">) {
  const { ctx } = props;
  const navigationService = useFrontendService("navigationService", ctx);
  const navSnap = useNavigationState(ctx);
  const sessionSnap = useSessionState(ctx);
  const workspaceSnap = useWorkspaceState(ctx);

  const [searchOpen, setSearchOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [notificationsOpen, setNotificationsOpen] = useState(false);
  const searchInputRef = useRef<HTMLInputElement>(null);

  const notifications = navSnap?.notifications ?? [];
  const sessions = sessionSnap?.sessions ?? [];
  const cwd = props.cwd ?? workspaceSnap?.cwd ?? sessionSnap?.cwd ?? "";
  const unreadCount = notifications.filter((item) => !item.read).length;

  useEffect(() => {
    if (typeof window === "undefined") return undefined;
    const onSearchRequested = () => {
      setSearchOpen(true);
      setNotificationsOpen(false);
      window.requestAnimationFrame(() => searchInputRef.current?.focus());
    };
    window.addEventListener("qianji:sidebar-search-request", onSearchRequested);
    return () => window.removeEventListener("qianji:sidebar-search-request", onSearchRequested);
  }, []);

  const updateQuery = (next: string) => {
    setQuery(next);
    dispatchSidebarSearchQuery(next);
  };

  const handleNewTask = () => {
    setNotificationsOpen(false);
    if (props.onNewTask !== undefined) {
      props.onNewTask();
    } else {
      navigationService?.navigate({ kind: "home", workspace: cwd });
    }
  };

  return (
    <>
      <div className="sidebar-brand-row" data-dsh-claude-search-row="">
        <button
          type="button"
          className="codex-brand"
          onClick={handleNewTask}
          title="千机"
        >
          <span className="dsh-claude-brand-mark" aria-hidden="true" />
          <span className="codex-brand-name">千机</span>
        </button>

        <div className="sidebar-brand-actions">
          <button
            type="button"
            className={`icon-button ${searchOpen || query !== "" ? "active" : ""}`}
            title={query !== "" ? `搜索：${query} (Ctrl+K)` : "搜索会话与项目 (Ctrl+K)"}
            aria-label="搜索会话与项目"
            aria-expanded={searchOpen}
            onClick={() => {
              setSearchOpen((prev) => !prev);
              setNotificationsOpen(false);
            }}
          >
            <Search size={15} strokeWidth={1.7} />
          </button>

          <button
            type="button"
            className={`icon-button notification-button ${notificationsOpen ? "active" : ""}`}
            title="通知"
            aria-label="通知"
            aria-expanded={notificationsOpen}
            onClick={() => {
              setNotificationsOpen((prev) => !prev);
              setSearchOpen(false);
            }}
          >
            <Bell size={15} strokeWidth={1.7} />
            {unreadCount > 0 && <span className="notification-dot" />}
          </button>
        </div>
      </div>

      {searchOpen && (
        <label className="session-search sidebar-search-popover" data-sidebar-popover="">
          <Search size={13} />
          <input
            ref={searchInputRef}
            autoFocus
            value={query}
            onChange={(event) => updateQuery(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Escape") {
                event.preventDefault();
                event.stopPropagation();
                setSearchOpen(false);
                updateQuery("");
              }
            }}
            placeholder="搜索会话标题、正文或项目…"
          />
        </label>
      )}

      {notificationsOpen && (
        <div className="sidebar-popover sidebar-notifications" data-sidebar-popover="">
          <div className="sidebar-popover-heading">
            <strong>通知</strong>
            {unreadCount > 0 && (
              <button
                type="button"
                onClick={() => navigationService?.markAllNotificationsRead()}
                title="全部标为已读"
              >
                <Check size={13} />
                全部已读
              </button>
            )}
          </div>
          {notifications.length === 0 ? (
            <div className="sidebar-notification-empty">暂无新通知</div>
          ) : (
            notifications.map((notification) => (
              <div
                key={notification.id}
                className={`sidebar-notification-row${notification.read ? "" : " unread"}`}
              >
                <button
                  type="button"
                  className="sidebar-notification-open"
                  onClick={() => {
                    setNotificationsOpen(false);
                    navigationService?.markNotificationRead(notification.id);
                    const targetSession = notification.sessionFile
                      ? sessions.find((item) => sameLocalPath(item.file, notification.sessionFile))
                      : undefined;
                    if (targetSession !== undefined) {
                      navigationService?.navigate({
                        kind: "session",
                        cwd: targetSession.cwd,
                        file: targetSession.file,
                      });
                    } else if (notification.cwd) {
                      navigationService?.navigate({ kind: "home", workspace: notification.cwd });
                    }
                  }}
                >
                  <span className={`sidebar-notification-icon ${notification.kind}`}>
                    {notification.kind === "completion" ? (
                      <CheckCircle2 size={15} />
                    ) : notification.kind === "approval" ? (
                      <ShieldCheck size={15} />
                    ) : (
                      <MessageCircleQuestion size={15} />
                    )}
                  </span>
                  <span className="sidebar-notification-copy">
                    <strong>{notification.title}</strong>
                    <small>{notification.body}</small>
                  </span>
                </button>
                <button
                  type="button"
                  className="sidebar-notification-dismiss"
                  title="移除通知"
                  aria-label="移除通知"
                  onClick={() => navigationService?.dismissNotification(notification.id)}
                >
                  <X size={13} />
                </button>
              </div>
            ))
          )}
        </div>
      )}
    </>
  );
}

export function SidebarPluginNavItems({
  pages,
  activeHub,
  onSelectPage,
}: {
  readonly pages: readonly ClientPageContribution[];
  readonly activeHub: NavigationHubView | null;
  readonly onSelectPage: (pageId: string) => void;
}) {
  const [expanded, setExpanded] = useState(false);

  if (pages.length === 0) return null;

  const hasOverflow = pages.length > COLLAPSED_PLUGIN_PAGE_LIMIT;
  const activePageId =
    typeof activeHub === "string" && activeHub.startsWith("plugin:")
      ? activeHub.slice("plugin:".length)
      : undefined;
  const activeIndex = activePageId !== undefined ? pages.findIndex((page) => page.id === activePageId) : -1;
  const activeExtra = activeIndex >= COLLAPSED_PLUGIN_PAGE_HEAD ? pages[activeIndex] : undefined;

  const visiblePages =
    !hasOverflow || expanded
      ? pages
      : activeExtra !== undefined
        ? [...pages.slice(0, COLLAPSED_PLUGIN_PAGE_HEAD), activeExtra]
        : pages.slice(0, COLLAPSED_PLUGIN_PAGE_HEAD);

  const hiddenCount = pages.length - visiblePages.length;

  return (
    <>
      {visiblePages.map((page) => {
        const isActive = activeHub === `plugin:${page.id}`;
        return (
          <button
            key={page.id}
            type="button"
            className={`nav-item pid-sidebar-plugin-nav-btn${isActive ? " active" : ""}`}
            data-qj-contributed-by={page.pluginId ?? "builtin"}
            onClick={() => onSelectPage(page.id)}
          >
            {page.icon ?? <Puzzle size={15} strokeWidth={1.75} aria-hidden="true" />}
            <span className="pid-sidebar-plugin-nav-label">{page.label}</span>
          </button>
        );
      })}
      {hasOverflow && (
        <button
          type="button"
          className="nav-item pid-sidebar-plugin-more-btn"
          aria-expanded={expanded}
          onClick={() => setExpanded((prev) => !prev)}
        >
          {expanded ? (
            <ChevronUp size={14} strokeWidth={1.75} aria-hidden="true" />
          ) : (
            <ChevronDown size={14} strokeWidth={1.75} aria-hidden="true" />
          )}
          <span className="pid-sidebar-plugin-nav-label">
            {expanded ? "收起扩展" : `更多扩展 (${hiddenCount})`}
          </span>
        </button>
      )}
    </>
  );
}

export function CoreSidebarPrimaryNav(props: SlotComponentProps<SidebarNavSlotProps, "root">) {
  const { ctx } = props;
  const navigationService = useFrontendService("navigationService", ctx);
  const navSnap = useNavigationState(ctx);
  const workspaceSnap = useWorkspaceState(ctx);
  const contributions = useClientContributions();

  const cwd = props.cwd ?? workspaceSnap?.cwd ?? "";
  const activeHub = navSnap?.hubView ?? null;
  const newTaskActive = (navSnap?.newTask ?? true) && activeHub === null;

  return (
    <>
      <button
        type="button"
        className={`nav-item dsh-claude-new-session ${newTaskActive ? "active" : ""}`}
        onClick={() => navigationService?.navigate({ kind: "home", workspace: cwd })}
      >
        <Plus size={15} strokeWidth={1.85} aria-hidden="true" />
        <span className="dsh-claude-new-session-label">新会话</span>
        <span className="dsh-claude-new-session-shortcut" aria-hidden="true">
          Ctrl+Shift+N
        </span>
      </button>

      <button
        type="button"
        className={`nav-item ${activeHub === "scheduled" ? "active" : ""}`}
        onClick={() => navigationService?.navigate({ kind: "hub", view: "scheduled" })}
      >
        <Clock3 size={15} strokeWidth={1.75} />
        <span>定时任务</span>
      </button>

      <button
        type="button"
        className={`nav-item ${activeHub === "plugins" ? "active" : ""}`}
        onClick={() => navigationService?.navigate({ kind: "hub", view: "plugins" })}
      >
        <Boxes size={15} strokeWidth={1.75} />
        <span>扩展插件</span>
      </button>

      <SidebarPluginNavItems
        pages={contributions.pages}
        activeHub={activeHub}
        onSelectPage={(pageId) => navigationService?.openPluginPage(pageId)}
      />
    </>
  );
}

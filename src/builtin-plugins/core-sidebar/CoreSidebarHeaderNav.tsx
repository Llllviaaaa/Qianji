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
  Pin,
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
  useThemeState,
  useWorkspaceState,
  type ClientPageContribution,
  type NavigationHubView,
} from "@qianji/client";
import type {
  SidebarHeaderSlotProps,
  SidebarNavSlotProps,
  SlotComponentProps,
} from "@qianji/client-slots";
import {
  compactTimestamp,
  dispatchSidebarClosePopovers,
  dispatchSidebarClosePreview,
  dispatchSidebarSearchActive,
  sameLocalPath,
} from "./sidebarHelpers";

const COLLAPSED_PLUGIN_PAGE_LIMIT = 3;
const COLLAPSED_PLUGIN_PAGE_HEAD = 2;

export function dispatchSidebarSearchQuery(query: string): void {
  if (typeof window !== "undefined") {
    window.dispatchEvent(new CustomEvent("qianji:sidebar-search-query", { detail: query }));
  }
}

function readIsNarrowViewport(): boolean {
  return typeof window !== "undefined" && window.innerWidth > 0 && window.innerWidth <= 760;
}

export function CoreSidebarHeader(props: SlotComponentProps<SidebarHeaderSlotProps, "root">) {
  const { ctx } = props;
  const navigationService = useFrontendService("navigationService", ctx);
  const navSnap = useNavigationState(ctx);
  const sessionSnap = useSessionState(ctx);
  const workspaceSnap = useWorkspaceState(ctx);
  const themeSnap = useThemeState(ctx);

  const [searchOpen, setSearchOpen] = useState(() => {
    if (typeof window === "undefined") return false;
    const win = window as Window & { __qianjiSidebarSearchPending?: boolean };
    if (win.__qianjiSidebarSearchPending === true) {
      win.__qianjiSidebarSearchPending = false;
      return true;
    }
    return false;
  });
  const [query, setQuery] = useState("");
  const [notificationsOpen, setNotificationsOpen] = useState(false);
  const [isNarrow, setIsNarrow] = useState(readIsNarrowViewport);
  const searchInputRef = useRef<HTMLInputElement>(null);

  const notifications = navSnap?.notifications ?? [];
  const sessions = sessionSnap?.sessions ?? [];
  const cwd = props.cwd ?? workspaceSnap?.cwd ?? sessionSnap?.cwd ?? "";
  const unreadCount = notifications.filter((item) => !item.read).length;
  const sidebarPinned = navSnap?.sidebarVisible ?? true;
  const isPreviewMode = !sidebarPinned || isNarrow;
  const toggleSidebarShortcut = themeSnap?.shortcutToggleSidebar || "Ctrl+B";

  useEffect(() => {
    if (typeof window === "undefined") return undefined;
    const onResize = () => setIsNarrow(readIsNarrowViewport());
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

  useEffect(() => {
    dispatchSidebarSearchActive(searchOpen);
    if (searchOpen && typeof window !== "undefined" && typeof window.requestAnimationFrame === "function") {
      window.requestAnimationFrame(() => searchInputRef.current?.focus());
    }
  }, [searchOpen]);

  useEffect(() => {
    if (typeof window === "undefined") return undefined;
    const onSearchRequested = () => {
      const win = window as Window & { __qianjiSidebarSearchPending?: boolean };
      win.__qianjiSidebarSearchPending = false;
      setSearchOpen(true);
      setNotificationsOpen(false);
      window.requestAnimationFrame(() => searchInputRef.current?.focus());
    };
    const onClearSearch = () => {
      setQuery("");
      setSearchOpen(false);
      dispatchSidebarSearchQuery("");
    };
    const onClosePopovers = () => {
      setSearchOpen(false);
      setNotificationsOpen(false);
    };
    window.addEventListener("qianji:sidebar-search-request", onSearchRequested);
    window.addEventListener("qianji:sidebar-clear-search", onClearSearch);
    window.addEventListener("qianji:sidebar-close-popovers", onClosePopovers);
    return () => {
      window.removeEventListener("qianji:sidebar-search-request", onSearchRequested);
      window.removeEventListener("qianji:sidebar-clear-search", onClearSearch);
      window.removeEventListener("qianji:sidebar-close-popovers", onClosePopovers);
    };
  }, []);

  useEffect(() => {
    if ((!searchOpen && !notificationsOpen) || typeof document === "undefined") return undefined;
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as Element | null;
      if (target === null) return;
      if (searchOpen && target.closest('[data-slot="sidebar"]') === null) {
        setSearchOpen(false);
      }
      if (notificationsOpen && target.closest("[data-sidebar-popover], .sidebar-brand-actions") === null) {
        setNotificationsOpen(false);
      }
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      if (notificationsOpen) {
        event.preventDefault();
        event.stopPropagation();
        setNotificationsOpen(false);
      } else if (searchOpen) {
        event.preventDefault();
        event.stopPropagation();
        setSearchOpen(false);
      }
    };
    document.addEventListener("pointerdown", onPointerDown, true);
    document.addEventListener("keydown", onKeyDown, true);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown, true);
      document.removeEventListener("keydown", onKeyDown, true);
    };
  }, [notificationsOpen, searchOpen]);

  const updateQuery = (next: string) => {
    setQuery(next);
    dispatchSidebarSearchQuery(next);
  };

  const handleNewTask = () => {
    setNotificationsOpen(false);
    dispatchSidebarClosePopovers();
    dispatchSidebarClosePreview();
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
          {isPreviewMode && !isNarrow && (
            <button
              type="button"
              className="icon-button sidebar-pin-button"
              title={`固定侧栏 (${toggleSidebarShortcut})`}
              aria-label="固定侧栏"
              onClick={() => {
                if (typeof window !== "undefined") {
                  window.dispatchEvent(new Event("qianji:sidebar-pin"));
                }
              }}
            >
              <Pin size={14} strokeWidth={1.75} />
            </button>
          )}
          {isPreviewMode && isNarrow && (
            <button
              type="button"
              className="icon-button sidebar-close-button"
              title="收起侧栏"
              aria-label="收起侧栏"
              onClick={dispatchSidebarClosePreview}
            >
              <X size={14} strokeWidth={1.75} />
            </button>
          )}
          <button
            type="button"
            className={`icon-button ${searchOpen || query !== "" ? "active" : ""}`}
            title={query !== "" ? `搜索：${query} (Ctrl+K)` : "搜索会话与项目 (Ctrl+K)"}
            aria-label="搜索会话与项目"
            aria-expanded={searchOpen}
            onClick={() => {
              const next = !searchOpen;
              dispatchSidebarClosePopovers();
              setSearchOpen(next);
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
              const next = !notificationsOpen;
              dispatchSidebarClosePopovers();
              setNotificationsOpen(next);
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
          {query !== "" && (
            <button
              type="button"
              className="session-search-clear"
              aria-label="清空搜索"
              onClick={() => { updateQuery(""); searchInputRef.current?.focus(); }}
            >
              <X size={12} />
            </button>
          )}
        </label>
      )}

      {notificationsOpen && (
        <div className="sidebar-popover sidebar-notifications" data-sidebar-popover="">
          <div className="sidebar-popover-heading">
            <strong>通知</strong>
            {unreadCount > 0 && (
              <button type="button" onClick={() => navigationService?.markAllNotificationsRead()} title="全部标为已读">
                <Check size={13} />
                全部已读
              </button>
            )}
          </div>
          {notifications.length === 0 ? (
            <div className="sidebar-notification-empty">暂无新通知</div>
          ) : (
            notifications.map((notification) => {
              const timeLabel = compactTimestamp(notification.createdAt);
              return (
                <div key={notification.id} className={`sidebar-notification-row${notification.read ? "" : " unread"}`}>
                  <button
                    type="button"
                    className="sidebar-notification-open"
                    onClick={() => {
                      setNotificationsOpen(false);
                      dispatchSidebarClosePreview();
                      navigationService?.markNotificationRead(notification.id);
                      const targetSession = notification.sessionFile
                        ? sessions.find((item) => sameLocalPath(item.file, notification.sessionFile))
                        : undefined;
                      if (targetSession !== undefined) {
                        navigationService?.navigate({ kind: "session", cwd: targetSession.cwd, file: targetSession.file });
                      } else if (notification.cwd) {
                        navigationService?.navigate({ kind: "home", workspace: notification.cwd });
                      } else {
                        navigationService?.showToast("该会话已不存在", "info");
                      }
                    }}
                  >
                    <span className={`sidebar-notification-icon ${notification.kind}`}>
                      {notification.kind === "completion" ? <CheckCircle2 size={15} /> : notification.kind === "approval" ? <ShieldCheck size={15} /> : <MessageCircleQuestion size={15} />}
                    </span>
                    <span className="sidebar-notification-copy">
                      <strong>
                        <span>{notification.title}</span>
                        {timeLabel !== "" && <span className="sidebar-notification-time">{timeLabel}</span>}
                      </strong>
                      <small>{notification.body}</small>
                    </span>
                  </button>
                  <button type="button" className="sidebar-notification-dismiss" title="移除通知" aria-label="移除通知" onClick={() => navigationService?.dismissNotification(notification.id)}>
                    <X size={13} />
                  </button>
                </div>
              );
            })
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
  const themeSnap = useThemeState(ctx);
  const contributions = useClientContributions();

  const cwd = props.cwd ?? workspaceSnap?.cwd ?? "";
  const activeHub = navSnap?.hubView ?? null;
  const newTaskActive = (navSnap?.newTask ?? true) && activeHub === null;
  const newChatShortcut = themeSnap?.shortcutNewChat || "Ctrl+Shift+N";

  const closeOverlays = () => {
    dispatchSidebarClosePopovers();
    dispatchSidebarClosePreview();
  };

  return (
    <>
      <button
        type="button"
        className={`nav-item dsh-claude-new-session ${newTaskActive ? "active" : ""}`}
        onClick={() => {
          closeOverlays();
          navigationService?.navigate({ kind: "home", workspace: cwd });
        }}
      >
        <Plus size={15} strokeWidth={1.85} aria-hidden="true" />
        <span className="dsh-claude-new-session-label">新会话</span>
        {newChatShortcut !== "" && (
          <span className="dsh-claude-new-session-shortcut" aria-hidden="true">
            {newChatShortcut}
          </span>
        )}
      </button>

      <button
        type="button"
        className={`nav-item ${activeHub === "scheduled" ? "active" : ""}`}
        onClick={() => {
          closeOverlays();
          navigationService?.navigate({ kind: "hub", view: "scheduled" });
        }}
      >
        <Clock3 size={15} strokeWidth={1.75} />
        <span>定时任务</span>
      </button>

      <button
        type="button"
        className={`nav-item ${activeHub === "plugins" ? "active" : ""}`}
        onClick={() => {
          closeOverlays();
          navigationService?.navigate({ kind: "hub", view: "plugins" });
        }}
      >
        <Boxes size={15} strokeWidth={1.75} />
        <span>扩展插件</span>
      </button>

      <SidebarPluginNavItems
        pages={contributions.pages}
        activeHub={activeHub}
        onSelectPage={(pageId) => {
          closeOverlays();
          navigationService?.openPluginPage(pageId);
        }}
      />
    </>
  );
}

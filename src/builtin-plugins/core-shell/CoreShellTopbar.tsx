import { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { ChevronDown, Menu } from "lucide-react";
import {
  useClientContributions,
  useFrontendService,
  useMenusState,
  useNavigationState,
  useSessionState,
  useThemeState,
  useWorkspaceState,
} from "@qianji/client";
import type { CoreShellTopbarProps, SlotComponentProps } from "@qianji/client-slots";
import { BotHandoffReturnChip } from "./CoreShellModeSwitch";
import { aggregateDiffStats, LegacyContributionHost, resolveActiveSessionTitle } from "./shellHelpers";

const NOOP_UNSUB = (): void => undefined;

export function CoreShellTopbar(props: SlotComponentProps<CoreShellTopbarProps, "root">) {
  const { ctx, renderFactory } = props;
  const navigationService = useFrontendService("navigationService", ctx);
  const sessionService = useFrontendService("sessionService", ctx);
  const workspaceService = useFrontendService("workspaceService", ctx);
  const workbenchService = useFrontendService("workbenchService", ctx);
  const menuService = useFrontendService("menuService", ctx);

  const navSnap = useNavigationState(ctx);
  const sessionSnap = useSessionState(ctx);
  const workspaceSnap = useWorkspaceState(ctx);
  const themeSnap = useThemeState(ctx);
  useMenusState(ctx);
  const contributions = useClientContributions();

  const slotsRegistry = ctx?.slots?.registry;
  const subscribeSlots = useCallback(
    (listener: () => void) => (slotsRegistry === undefined ? NOOP_UNSUB : slotsRegistry.subscribe(listener)),
    [slotsRegistry],
  );
  const getSlotsVersion = useCallback(
    () => (slotsRegistry === undefined ? 0 : slotsRegistry.getVersion()),
    [slotsRegistry],
  );
  useSyncExternalStore(subscribeSlots, getSlotsVersion, getSlotsVersion);
  const codeReviewAvailable =
    slotsRegistry === undefined ||
    slotsRegistry.getKeyedCandidates("workbench.panes", "review").length > 0;

  const [moreOpen, setMoreOpen] = useState(false);
  const [editingTitle, setEditingTitle] = useState(false);
  const [titleDraft, setTitleDraft] = useState("");

  useEffect(() => {
    if (!moreOpen || typeof document === "undefined" || typeof window === "undefined") {
      return undefined;
    }
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as Element | null;
      if (target !== null && !target.closest(".title-actions")) {
        setMoreOpen(false);
      }
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !event.defaultPrevented) {
        setMoreOpen(false);
      }
    };
    document.addEventListener("pointerdown", onPointerDown);
    window.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [moreOpen]);

  const sidebarVisible = navSnap?.sidebarVisible ?? true;
  const newTask = navSnap?.newTask ?? true;
  const hubView = navSnap?.hubView ?? null;
  const cwd = props.cwd ?? workspaceSnap?.cwd ?? sessionSnap?.cwd ?? "";
  const sessionFile = props.sessionFile !== undefined ? props.sessionFile : (sessionSnap?.sessionFile ?? null);
  const connected = sessionSnap?.connection === "running";
  const isStreaming = sessionSnap?.isStreaming ?? false;
  const git = workspaceSnap?.git ?? null;

  const resolvedTitle = useMemo(() => {
    if (props.title !== undefined && props.title.trim() !== "") return props.title;
    return resolveActiveSessionTitle({
      sessions: sessionSnap?.sessions ?? [],
      sessionFile,
      sessionId: sessionSnap?.sessionId ?? null,
      sessionName: sessionSnap?.sessionName ?? null,
      messages: sessionSnap?.messages ?? [],
    });
  }, [props.title, sessionFile, sessionSnap?.messages, sessionSnap?.sessionId, sessionSnap?.sessionName, sessionSnap?.sessions]);

  const reviewFileCount = git?.files.length ?? 0;
  const gitDiffStats = useMemo(() => aggregateDiffStats(git?.diff), [git?.diff]);
  const threadMoreItems = menuService?.getItems("thread.more", { cwd, sessionFile }) ?? [];

  const hasActiveBotHandoff = (navSnap?.activeBotHandoff ?? null) !== null;
  const hasHomeChrome = !sidebarVisible || contributions.topbarActions.length > 0 || hasActiveBotHandoff;
  if (newTask && hubView === null && !hasHomeChrome) {
    return null;
  }

  const displayTitle = editingTitle ? titleDraft : resolvedTitle;

  const beginEditTitle = () => {
    if (!connected) return;
    setTitleDraft(resolvedTitle);
    setEditingTitle(true);
  };

  const commitTitle = () => {
    setEditingTitle(false);
    const trimmed = titleDraft.trim();
    if (trimmed !== "" && trimmed !== resolvedTitle) {
      void sessionService?.renameSession(trimmed);
    }
  };

  const toggleSidebarShortcut = themeSnap?.shortcutToggleSidebar || "Ctrl+B";
  const hasMessages = (sessionSnap?.messages.length ?? 0) > 0;

  return (
    <header className={`topbar ${newTask && hubView === null ? "topbar-home" : ""}`} data-tauri-drag-region="">
      <div className="topbar-left" data-tauri-drag-region="">
        {!sidebarVisible && (
          <button
            type="button"
            className="icon-button"
            data-sidebar-toggle=""
            onClick={() => {
              if (typeof window !== "undefined") {
                window.dispatchEvent(new CustomEvent("qianji:sidebar-toggle-request"));
              } else {
                navigationService?.toggleSidebar();
              }
            }}
            title={`切换侧栏 (${toggleSidebarShortcut})`}
            aria-label="切换侧栏"
          >
            <Menu size={17} />
          </button>
        )}

        <BotHandoffReturnChip ctx={ctx} />

        {!newTask && hubView === null && (
          <div className="thread-title-cluster">
            {editingTitle && connected ? (
              <input
                autoFocus
                className="title-input"
                value={titleDraft}
                onChange={(event) => setTitleDraft(event.target.value)}
                onBlur={commitTitle}
                onKeyDown={(event) => {
                  if (event.key === "Enter") event.currentTarget.blur();
                  if (event.key === "Escape") {
                    event.preventDefault();
                    event.stopPropagation();
                    setTitleDraft(resolvedTitle);
                    setEditingTitle(false);
                  }
                }}
              />
            ) : (
              <button
                type="button"
                className="chat-title"
                onClick={beginEditTitle}
                title={displayTitle}
              >
                <span>{displayTitle}</span>
              </button>
            )}

            <div className="topbar-menu-wrap title-actions">
              <button
                type="button"
                className="icon-button title-more"
                title="线程操作"
                aria-label="线程操作"
                onClick={() => setMoreOpen((value) => !value)}
              >
                <ChevronDown size={14} strokeWidth={1.75} />
              </button>

              {moreOpen && (
                <div className="topbar-menu title-menu">
                  <button
                    type="button"
                    onClick={() => {
                      setMoreOpen(false);
                      navigationService?.navigate({ kind: "home", workspace: cwd });
                    }}
                  >
                    新对话
                  </button>
                  <button
                    type="button"
                    disabled={cwd === ""}
                    onClick={() => {
                      setMoreOpen(false);
                      if (typeof window !== "undefined") {
                        window.dispatchEvent(new CustomEvent("qianji:open-workspace-preferred", { detail: { cwd } }));
                      } else {
                        void workspaceService?.openInFileManager(cwd);
                      }
                    }}
                  >
                    打开工作区目录
                  </button>
                  <button
                    type="button"
                    disabled={cwd === "" || git === null}
                    onClick={() => {
                      setMoreOpen(false);
                      if (cwd === "") return;
                      void workspaceService
                        ?.createWorktree(cwd)
                        .then((worktreePath) => sessionService?.connect(worktreePath))
                        .catch((error) => {
                          const msg = error instanceof Error ? error.message : String(error);
                          navigationService?.showToast(`创建 Worktree 失败：${msg}`, "error");
                        });
                    }}
                  >
                    新建 Worktree 任务
                  </button>
                  <button
                    type="button"
                    disabled={!connected || !hasMessages}
                    onClick={() => {
                      setMoreOpen(false);
                      if (typeof window !== "undefined") {
                        window.dispatchEvent(new CustomEvent("qianji:export-markdown-request"));
                      }
                    }}
                  >
                    导出为 Markdown...
                  </button>
                  <button
                    type="button"
                    disabled={!connected}
                    onClick={() => {
                      setMoreOpen(false);
                      void sessionService?.clone();
                    }}
                  >
                    克隆当前分支
                  </button>
                  <button
                    type="button"
                    disabled={!connected || isStreaming}
                    onClick={() => {
                      setMoreOpen(false);
                      void sessionService?.fork();
                    }}
                  >
                    从最新检查点分叉
                  </button>
                  <button
                    type="button"
                    disabled={!connected || isStreaming}
                    onClick={() => {
                      setMoreOpen(false);
                      void sessionService?.compact();
                    }}
                  >
                    压缩上下文
                  </button>
                  <button
                    type="button"
                    disabled={sessionFile === null || isStreaming}
                    onClick={() => {
                      setMoreOpen(false);
                      if (sessionFile === null) return;
                      void sessionService
                        ?.archiveSession(sessionFile)
                        .then(() => {
                          try {
                            if (typeof window !== "undefined") {
                              window.localStorage.removeItem("qianji:active-runtime");
                              window.localStorage.removeItem("qianji:last-task");
                            }
                          } catch {
                            // Ignore restricted storage environments.
                          }
                          navigationService?.forgetSessions([sessionFile]);
                          navigationService?.navigate({ kind: "home", workspace: cwd });
                          navigationService?.showToast("已归档对话", "info");
                        })
                        .catch((error) => {
                          const msg = error instanceof Error ? error.message : String(error);
                          navigationService?.showToast(`归档失败：${msg}`, "error");
                        });
                    }}
                  >
                    归档任务
                  </button>
                  {threadMoreItems.length > 0 && <div className="menu-separator" />}
                  {threadMoreItems.map((item) => (
                    <button
                      key={item.id}
                      type="button"
                      role="menuitem"
                      className={item.danger ? "danger" : undefined}
                      disabled={item.disabled}
                      data-qj-plugin={item.pluginId ?? "builtin"}
                      onClick={() => {
                        setMoreOpen(false);
                        item.select();
                      }}
                    >
                      {item.label}
                    </button>
                  ))}
                  <div className="menu-separator" />
                  <button
                    type="button"
                    onClick={() => {
                      setMoreOpen(false);
                      navigationService?.openSettings("general");
                    }}
                  >
                    设置
                  </button>
                  <button
                    type="button"
                    disabled={!connected}
                    onClick={() => {
                      setMoreOpen(false);
                      void sessionService?.disconnect();
                    }}
                  >
                    断开连接
                  </button>
                </div>
              )}
            </div>
          </div>
        )}
      </div>

      <div className="topbar-right" data-tauri-drag-region="">
        {hubView === null && (
          <div className="panel-toggles codex-layout-chrome">
            {!newTask && codeReviewAvailable && reviewFileCount > 0 && (
              <div className="main-pane-controls">
                <button
                  type="button"
                  className="title-diff-chip topbar-diff-chip"
                  title={`${reviewFileCount} 个文件有未提交的变更`}
                  aria-label={`审查 ${reviewFileCount} 个文件的变更`}
                  onClick={() => {
                    navigationService?.setHubView(null);
                    workbenchService?.openReview();
                  }}
                >
                  {gitDiffStats.additions > 0 && <em>+{gitDiffStats.additions.toLocaleString()}</em>}
                  {gitDiffStats.deletions > 0 && <b>−{gitDiffStats.deletions.toLocaleString()}</b>}
                  {gitDiffStats.additions === 0 && gitDiffStats.deletions === 0 && <span>{reviewFileCount} 个文件</span>}
                </button>
              </div>
            )}

            {!newTask && cwd !== "" && git !== null && renderFactory("host.shell.gitAction", { cwd })}

            {contributions.topbarActions.length > 0 && (
              <div className="workspace-pane-controls">
                {contributions.topbarActions.map((action) => (
                  <span key={action.id} className="pid-wb-plugin-action">
                    <LegacyContributionHost
                      id={action.id}
                      pluginId={action.pluginId}
                      slotKey="topbarActions"
                      renderFn={action.render}
                      context={{ cwd, sessionFile }}
                      compact
                    />
                  </span>
                ))}
              </div>
            )}
          </div>
        )}
      </div>
    </header>
  );
}

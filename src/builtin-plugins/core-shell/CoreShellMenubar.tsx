import { useEffect, useState } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { ArrowLeft, ArrowRight, Minus, Square, X } from "lucide-react";
import {
  useFrontendService,
  useMenusState,
  useNavigationState,
  useSessionState,
  useThemeState,
  useWorkspaceState,
  type ClientMenuLocation,
  type ResolvedMenuItem,
} from "@qianji/client";
import type { CoreShellMenubarProps, SlotComponentProps } from "@qianji/client-slots";
import {
  DockLeftIcon,
  TRANSCRIPT_DENSITY_LABELS,
  TRANSCRIPT_DENSITY_ORDER,
} from "./shellHelpers";

type AppMenuKey = "file" | "edit" | "view" | "help" | "tools";

const BUILTIN_MENUS: readonly AppMenuKey[] = ["file", "edit", "view", "help"];
const MENU_LABELS: Readonly<Record<AppMenuKey, string>> = {
  file: "文件",
  edit: "编辑",
  view: "视图",
  help: "帮助",
  tools: "工具",
};

function renderPluginMenuItems<L extends ClientMenuLocation>(
  items: readonly ResolvedMenuItem<L>[],
  onClose: () => void,
  withSeparator: boolean,
) {
  if (items.length === 0) return null;
  return (
    <>
      {withSeparator && <div className="menu-separator" />}
      {items.map((item) => (
        <button
          key={item.id}
          type="button"
          role="menuitem"
          className={item.danger ? "danger" : undefined}
          disabled={item.disabled}
          data-qj-plugin={item.pluginId ?? "builtin"}
          onClick={() => {
            onClose();
            item.select();
          }}
        >
          {item.label}
          {item.shortcut ? `  ${item.shortcut}` : ""}
        </button>
      ))}
    </>
  );
}

export function CoreShellMenubar(props: SlotComponentProps<CoreShellMenubarProps, "root">) {
  const navigationService = useFrontendService("navigationService", props.ctx);
  const workspaceService = useFrontendService("workspaceService", props.ctx);
  const workbenchService = useFrontendService("workbenchService", props.ctx);
  const themeService = useFrontendService("themeService", props.ctx);
  const menuService = useFrontendService("menuService", props.ctx);

  const navSnap = useNavigationState(props.ctx);
  const sessionSnap = useSessionState(props.ctx);
  const workspaceSnap = useWorkspaceState(props.ctx);
  const themeSnap = useThemeState(props.ctx);
  useMenusState(props.ctx);

  const [appMenu, setAppMenu] = useState<AppMenuKey | null>(null);

  const sidebarVisible = props.sidebarVisible ?? navSnap?.sidebarVisible ?? true;
  const settingsOpen = navSnap?.settingsOpen ?? false;
  const canNavigateBack = navSnap?.canGoBack ?? false;
  const canNavigateForward = navSnap?.canGoForward ?? false;
  const cwd = workspaceSnap?.cwd ?? sessionSnap?.cwd ?? "";
  const sessionFile = sessionSnap?.sessionFile ?? null;
  const connected = sessionSnap?.connection === "running";
  const transcriptDensity = themeSnap?.transcriptDensity ?? "normal";

  const isTauri = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
  const appWindow = isTauri ? getCurrentWindow() : null;

  useEffect(() => {
    if (appMenu === null || typeof document === "undefined" || typeof window === "undefined") {
      return undefined;
    }
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as Element | null;
      if (target !== null && !target.closest(".app-menu-bar, .app-menu-dropdown")) {
        setAppMenu(null);
      }
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !event.defaultPrevented) {
        setAppMenu(null);
      }
    };
    document.addEventListener("pointerdown", onPointerDown);
    window.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [appMenu]);

  const hasToolsMenu = menuService?.hasItems("menubar.tools") ?? false;
  const menus: readonly AppMenuKey[] = hasToolsMenu ? [...BUILTIN_MENUS, "tools"] : BUILTIN_MENUS;
  const closeMenu = () => setAppMenu(null);

  const getMenuItems = (location: Extract<ClientMenuLocation, `menubar.${string}`>) =>
    menuService?.getItems(location, { cwd, sessionFile }) ?? [];

  const handleToggleSidebar = () => {
    if (props.onToggleSidebar !== undefined) {
      props.onToggleSidebar();
    } else {
      navigationService?.toggleSidebar();
    }
  };

  const sidebarToggleLabel = sidebarVisible ? "隐藏侧栏" : "显示侧栏";
  const toggleSidebarShortcut = themeSnap?.shortcutToggleSidebar || "Ctrl+B";

  return (
    <div className="window-menubar" data-tauri-drag-region="">
      <div className="window-menubar-left" data-tauri-drag-region="">
        <button
          type="button"
          className="window-nav-button"
          data-sidebar-toggle=""
          onClick={handleToggleSidebar}
          title={`${sidebarToggleLabel} (${toggleSidebarShortcut})`}
          aria-label={sidebarToggleLabel}
        >
          <DockLeftIcon open={sidebarVisible} size={15} />
        </button>
        <button
          type="button"
          className="window-nav-button"
          disabled={!settingsOpen && !canNavigateBack}
          onClick={() => {
            if (settingsOpen) navigationService?.closeSettings();
            else navigationService?.goBack();
          }}
          title="后退"
          aria-label="后退"
        >
          <ArrowLeft size={15} strokeWidth={1.6} />
        </button>
        <button
          type="button"
          className="window-nav-button"
          disabled={settingsOpen || !canNavigateForward}
          onClick={() => navigationService?.goForward()}
          title="前进"
          aria-label="前进"
        >
          <ArrowRight size={15} strokeWidth={1.6} />
        </button>

        <div className="app-menu-bar">
          {menus.map((menu) => (
            <button
              type="button"
              key={menu}
              className={`app-menu-trigger ${appMenu === menu ? "active" : ""}`}
              onClick={() => setAppMenu((current) => (current === menu ? null : menu))}
            >
              {MENU_LABELS[menu]}
            </button>
          ))}
        </div>

        {appMenu !== null && (
          <div className={`app-menu-dropdown menu-${appMenu}`}>
            {appMenu === "file" && (
              <>
                <button
                  type="button"
                  onClick={() => {
                    closeMenu();
                    navigationService?.closeSettings();
                    navigationService?.navigate({ kind: "home", workspace: cwd });
                  }}
                >
                  新对话
                </button>
                <button
                  type="button"
                  onClick={() => {
                    closeMenu();
                    navigationService?.closeSettings();
                    void workspaceService?.pickFolder().then((selected) => {
                      if (selected) {
                        navigationService?.navigate({ kind: "home", workspace: selected });
                      }
                    });
                  }}
                >
                  打开项目...
                </button>
                <button
                  type="button"
                  disabled={cwd === ""}
                  onClick={() => {
                    closeMenu();
                    void workspaceService?.openInFileManager(cwd);
                  }}
                >
                  在文件资源管理器中打开  Ctrl+Shift+O
                </button>
                {renderPluginMenuItems(getMenuItems("menubar.file"), closeMenu, true)}
                <div className="menu-separator" />
                <button
                  type="button"
                  onClick={() => {
                    closeMenu();
                    void appWindow?.close();
                  }}
                >
                  退出
                </button>
              </>
            )}

            {appMenu === "edit" && (
              <>
                <button
                  type="button"
                  onClick={() => {
                    closeMenu();
                    if (typeof document !== "undefined") document.execCommand("undo");
                  }}
                >
                  撤销
                </button>
                <button
                  type="button"
                  onClick={() => {
                    closeMenu();
                    if (typeof document !== "undefined") document.execCommand("redo");
                  }}
                >
                  重做
                </button>
                <div className="menu-separator" />
                <button
                  type="button"
                  onClick={() => {
                    closeMenu();
                    if (typeof document !== "undefined") document.execCommand("selectAll");
                  }}
                >
                  全选
                </button>
                {renderPluginMenuItems(getMenuItems("menubar.edit"), closeMenu, true)}
              </>
            )}

            {appMenu === "view" && (
              <>
                <button
                  type="button"
                  onClick={() => {
                    closeMenu();
                    handleToggleSidebar();
                  }}
                >
                  {sidebarVisible ? "隐藏侧栏" : "显示侧栏"}
                </button>
                {TRANSCRIPT_DENSITY_ORDER.map((density) => (
                  <button
                    key={density}
                    type="button"
                    onClick={() => {
                      closeMenu();
                      void themeService?.setTranscriptDensity(density);
                    }}
                  >
                    对话{TRANSCRIPT_DENSITY_LABELS[density]}
                    {transcriptDensity === density ? " ✓" : ""}
                    {density === "normal" ? "  Ctrl+O" : ""}
                  </button>
                ))}
                <div className="menu-separator" />
                <button
                  type="button"
                  onClick={() => {
                    closeMenu();
                    navigationService?.closeSettings();
                    navigationService?.setHubView(null);
                    workbenchService?.toggleInspector();
                  }}
                >
                  右侧工作台  Ctrl+Alt+B
                </button>
                <button
                  type="button"
                  onClick={() => {
                    closeMenu();
                    navigationService?.closeSettings();
                    navigationService?.setHubView(null);
                    workbenchService?.toggleBottom();
                  }}
                >
                  底部面板  Ctrl+J
                </button>
                <button
                  type="button"
                  onClick={() => {
                    closeMenu();
                    navigationService?.openSettings("appearance");
                  }}
                >
                  外观设置
                </button>
                <div className="menu-separator" />
                <button
                  type="button"
                  onClick={() => {
                    closeMenu();
                    navigationService?.closeSettings();
                    navigationService?.navigate({ kind: "hub", view: "plugins" });
                  }}
                >
                  扩展插件
                </button>
                {renderPluginMenuItems(getMenuItems("menubar.view"), closeMenu, true)}
              </>
            )}

            {appMenu === "help" && (
              <>
                <button
                  type="button"
                  onClick={() => {
                    closeMenu();
                    void workspaceService?.openExternal("https://github.com/Llllviaaaa/Qianji");
                  }}
                >
                  项目主页
                </button>
                <button
                  type="button"
                  disabled={!connected && cwd === ""}
                  onClick={() => {
                    closeMenu();
                    navigationService?.closeSettings();
                    navigationService?.setHubView(null);
                    workbenchService?.openSummary("diagnostics");
                  }}
                >
                  诊断日志
                </button>
                {renderPluginMenuItems(getMenuItems("menubar.help"), closeMenu, true)}
              </>
            )}

            {appMenu === "tools" && renderPluginMenuItems(getMenuItems("menubar.tools"), closeMenu, false)}
          </div>
        )}
      </div>

      <div className="window-menubar-right" data-tauri-drag-region="">
        <div className="window-controls">
          <button
            type="button"
            className="window-control"
            onClick={() => void appWindow?.minimize()}
            title="最小化"
            aria-label="最小化窗口"
          >
            <Minus size={15} strokeWidth={1.6} />
          </button>
          <button
            type="button"
            className="window-control"
            onClick={() => void appWindow?.toggleMaximize()}
            title="最大化或还原"
            aria-label="最大化或还原窗口"
          >
            <Square size={12} strokeWidth={1.5} />
          </button>
          <button
            type="button"
            className="window-control close"
            onClick={() => void appWindow?.close()}
            title="关闭"
            aria-label="关闭窗口"
          >
            <X size={16} strokeWidth={1.6} />
          </button>
        </div>
      </div>
    </div>
  );
}

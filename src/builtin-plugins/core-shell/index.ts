import type { Context, Plugin } from "@deepseek-ai/cordis";
import { CORE_SLOT_SPECS } from "@qianji/client-slots";
import { CoreShellMenubar } from "./CoreShellMenubar";
import { CoreShellRoot } from "./CoreShellRoot";
import { CoreShellTopbar } from "./CoreShellTopbar";

export const CORE_SHELL_PLUGIN_ID = "core-shell";

export { CoreShellMenubar, CoreShellRoot, CoreShellTopbar };

export const coreShellPlugin: Plugin.Object = {
  name: CORE_SHELL_PLUGIN_ID,
  inject: [
    "slots",
    "sessionService",
    "workspaceService",
    "composerService",
    "workbenchService",
    "navigationService",
    "themeService",
    "shortcutService",
    "menuService",
    "rpcService",
  ],
  apply(ctx: Context) {
    ctx.slots.register("root", {
      id: `${CORE_SHELL_PLUGIN_ID}:root`,
      pluginId: CORE_SHELL_PLUGIN_ID,
      tier: "builtin",
      priority: 0,
      children: {
        "shell.menubar": CORE_SLOT_SPECS["shell.menubar"],
        "shell.sidebar": CORE_SLOT_SPECS["shell.sidebar"],
        "shell.topbar": CORE_SLOT_SPECS["shell.topbar"],
        "shell.stage": CORE_SLOT_SPECS["shell.stage"],
        "shell.workbench.right": CORE_SLOT_SPECS["shell.workbench.right"],
        "shell.workbench.bottom": CORE_SLOT_SPECS["shell.workbench.bottom"],
        "shell.statusbar": CORE_SLOT_SPECS["shell.statusbar"],
        "shell.overlays": CORE_SLOT_SPECS["shell.overlays"],
        "shell.modals": CORE_SLOT_SPECS["shell.modals"],
      },
      component: CoreShellRoot,
    });

    ctx.slots.register("shell.menubar", {
      id: `${CORE_SHELL_PLUGIN_ID}:menubar`,
      pluginId: CORE_SHELL_PLUGIN_ID,
      tier: "builtin",
      priority: 0,
      component: CoreShellMenubar,
    });

    ctx.slots.register("shell.topbar", {
      id: `${CORE_SHELL_PLUGIN_ID}:topbar`,
      pluginId: CORE_SHELL_PLUGIN_ID,
      tier: "builtin",
      priority: 0,
      children: {
        "workbench.topbarControls": CORE_SLOT_SPECS["workbench.topbarControls"],
      },
      component: CoreShellTopbar,
    });

    // Global shell shortcuts wired through ShortcutService (automatically disposed on Fiber unmount).
    let activeToggleKey = ctx.themeService.getSnapshot().shortcutToggleSidebar || "Ctrl+B";
    let disposeToggleShortcut = ctx.shortcutService.register({
      id: `${CORE_SHELL_PLUGIN_ID}:toggle-sidebar`,
      pluginId: CORE_SHELL_PLUGIN_ID,
      key: activeToggleKey,
      label: "切换左侧栏",
      when: (sc) => !sc.inEditable && !sc.inTerminal && !ctx.navigationService.getSnapshot().settingsOpen,
      run: () => {
        ctx.navigationService.toggleSidebar();
      },
    });
    const offThemeShortcut = ctx.themeService.subscribe(() => {
      const nextKey = ctx.themeService.getSnapshot().shortcutToggleSidebar || "Ctrl+B";
      if (nextKey === activeToggleKey) return;
      activeToggleKey = nextKey;
      disposeToggleShortcut();
      disposeToggleShortcut = ctx.shortcutService.register({
        id: `${CORE_SHELL_PLUGIN_ID}:toggle-sidebar`,
        pluginId: CORE_SHELL_PLUGIN_ID,
        key: activeToggleKey,
        label: "切换左侧栏",
        when: (sc) => !sc.inEditable && !sc.inTerminal && !ctx.navigationService.getSnapshot().settingsOpen,
        run: () => {
          ctx.navigationService.toggleSidebar();
        },
      });
    });
    ctx.effect(() => () => {
      offThemeShortcut();
      disposeToggleShortcut();
    });

    ctx.shortcutService.register({
      id: `${CORE_SHELL_PLUGIN_ID}:open-settings`,
      pluginId: CORE_SHELL_PLUGIN_ID,
      key: "Ctrl+,",
      label: "打开设置",
      allowInEditable: true,
      run: () => {
        ctx.navigationService.openSettings("general");
      },
    });

    ctx.shortcutService.register({
      id: `${CORE_SHELL_PLUGIN_ID}:new-task`,
      pluginId: CORE_SHELL_PLUGIN_ID,
      key: "Ctrl+Shift+N",
      label: "新建对话",
      allowInEditable: true,
      run: () => {
        ctx.navigationService.closeSettings();
        const cwd = ctx.workspaceService.getSnapshot().cwd;
        ctx.navigationService.navigate({ kind: "home", workspace: cwd });
      },
    });

    ctx.shortcutService.register({
      id: `${CORE_SHELL_PLUGIN_ID}:sidebar-search`,
      pluginId: CORE_SHELL_PLUGIN_ID,
      key: "Ctrl+K",
      label: "搜索会话与项目",
      when: (sc) => !sc.inTerminal && !ctx.navigationService.getSnapshot().settingsOpen,
      run: () => {
        ctx.navigationService.setSidebarVisible(true);
        if (typeof window !== "undefined") {
          window.dispatchEvent(new CustomEvent("qianji:sidebar-search-request"));
        }
      },
    });

    ctx.shortcutService.register({
      id: `${CORE_SHELL_PLUGIN_ID}:cycle-density`,
      pluginId: CORE_SHELL_PLUGIN_ID,
      key: "Ctrl+O",
      label: "切换对话密度",
      when: (sc) => !sc.inTerminal && !ctx.navigationService.getSnapshot().settingsOpen,
      run: async () => {
        await ctx.themeService.cycleTranscriptDensity();
      },
    });

    ctx.shortcutService.register({
      id: `${CORE_SHELL_PLUGIN_ID}:toggle-bottom`,
      pluginId: CORE_SHELL_PLUGIN_ID,
      key: "Ctrl+J",
      label: "切换底部工作台",
      when: (sc) => !sc.inTerminal,
      run: () => {
        ctx.navigationService.closeSettings();
        ctx.navigationService.setHubView(null);
        ctx.workbenchService.toggleBottom();
      },
    });

    ctx.shortcutService.register({
      id: `${CORE_SHELL_PLUGIN_ID}:toggle-inspector`,
      pluginId: CORE_SHELL_PLUGIN_ID,
      key: "Ctrl+Alt+B",
      label: "切换右侧工作台",
      allowInEditable: true,
      run: () => {
        ctx.navigationService.closeSettings();
        ctx.navigationService.setHubView(null);
        ctx.workbenchService.toggleInspector();
      },
    });

    ctx.shortcutService.register({
      id: `${CORE_SHELL_PLUGIN_ID}:open-workspace`,
      pluginId: CORE_SHELL_PLUGIN_ID,
      key: "Ctrl+Shift+O",
      label: "在文件资源管理器中打开工作区",
      when: (sc) => !sc.inTerminal && ctx.workspaceService.getSnapshot().cwd !== "",
      run: async () => {
        await ctx.workspaceService.openInFileManager();
      },
    });

    ctx.shortcutService.register({
      id: `${CORE_SHELL_PLUGIN_ID}:open-review`,
      pluginId: CORE_SHELL_PLUGIN_ID,
      key: "Ctrl+Shift+G",
      label: "打开代码变更审查",
      when: (sc) => !sc.inTerminal,
      run: () => {
        ctx.navigationService.closeSettings();
        ctx.navigationService.setHubView(null);
        ctx.workbenchService.openReview();
      },
    });

    // Notify user non-blockingly when a slot override abdicates back to fallback (ADR 0023 §5.1).
    ctx.slots.onAbdicate((record) => {
      if (record.fallbackPluginId === undefined) return;
      try {
        ctx.navigationService.showToast(
          `插件 "${record.pluginId}" 在槽位 ${record.slotKey} 渲染异常，已自动退让至 ${record.fallbackPluginId}`,
          "warning",
        );
      } catch {
        // Ignore toast timer errors when running in headless SSR environments without `window`.
      }
    });
  },
};

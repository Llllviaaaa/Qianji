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
      children: {
        "workbench.topbarControls": CORE_SLOT_SPECS["workbench.topbarControls"],
      },
      component: CoreShellMenubar,
    });

    ctx.slots.register("shell.topbar", {
      id: `${CORE_SHELL_PLUGIN_ID}:topbar`,
      pluginId: CORE_SHELL_PLUGIN_ID,
      tier: "builtin",
      priority: 0,
      component: CoreShellTopbar,
    });

    const dispatchTerminalShortcut = () => {
      ctx.navigationService.closeSettings();
      ctx.navigationService.setHubView(null);
      if (typeof window !== "undefined") {
        window.dispatchEvent(new CustomEvent("qianji:toggle-terminal-shortcut"));
      } else {
        ctx.workbenchService.toggleBottom();
      }
    };

    const isPaneAvailable = (paneId: string): boolean => {
      const reg = ctx.slots?.registry;
      if (reg === undefined) return true;
      return reg.getKeyedCandidates("workbench.panes", paneId).length > 0;
    };

    const isBotStageActive = (): boolean => {
      const reg = ctx.slots?.registry;
      if (reg === undefined || reg.getFactoryCandidates("bot.stage").length === 0) return false;
      return ctx.navigationService.getSnapshot().shellMode === "bot";
    };

    const isBotStageMounted = (): boolean => {
      const reg = ctx.slots?.registry;
      return reg !== undefined && reg.getFactoryCandidates("bot.stage").length > 0;
    };

    // Dynamically re-bind all 6 user-customizable shortcuts whenever themeService settings change.
    const registerDynamicShortcuts = (): {
      readonly keysSig: string;
      readonly dispose: () => void;
    } => {
      const snap = ctx.themeService.getSnapshot();
      const kToggleSidebar = snap.shortcutToggleSidebar || "Ctrl+B";
      const kToggleShellMode = snap.shortcutToggleShellMode || "Ctrl+Shift+M";
      const kSettings = snap.shortcutSettings || "Ctrl+,";
      const kNewChat = snap.shortcutNewChat || "Ctrl+Shift+N";
      const kTerminal = snap.shortcutTerminal || "Ctrl+Shift+T";
      const kChanges = snap.shortcutChanges || "Ctrl+Shift+G";
      const keysSig = [kToggleSidebar, kToggleShellMode, kSettings, kNewChat, kTerminal, kChanges].join("|");

      const disposers = [
        ctx.shortcutService.register({
          id: `${CORE_SHELL_PLUGIN_ID}:toggle-shell-mode`,
          pluginId: CORE_SHELL_PLUGIN_ID,
          key: kToggleShellMode,
          label: "切换 Agent / Bot 形态",
          allowInEditable: true,
          when: () => isBotStageMounted(),
          run: () => {
            ctx.navigationService.toggleShellMode();
          },
        }),
        ctx.shortcutService.register({
          id: `${CORE_SHELL_PLUGIN_ID}:toggle-sidebar`,
          pluginId: CORE_SHELL_PLUGIN_ID,
          key: kToggleSidebar,
          label: "切换左侧栏",
          when: (sc) =>
            !isBotStageActive() &&
            !sc.inEditable &&
            !sc.inTerminal &&
            !ctx.navigationService.getSnapshot().settingsOpen,
          run: () => {
            if (typeof window !== "undefined") {
              const ev = new CustomEvent("qianji:sidebar-toggle-request", { cancelable: true });
              window.dispatchEvent(ev);
              if (!ev.defaultPrevented) {
                ctx.navigationService.toggleSidebar();
              }
            } else {
              ctx.navigationService.toggleSidebar();
            }
          },
        }),
        ctx.shortcutService.register({
          id: `${CORE_SHELL_PLUGIN_ID}:open-settings`,
          pluginId: CORE_SHELL_PLUGIN_ID,
          key: kSettings,
          label: "打开设置",
          allowInEditable: true,
          run: () => {
            if (isBotStageActive() && typeof window !== "undefined") {
              const ev = new CustomEvent("qianji:bot-open-settings", { cancelable: true });
              window.dispatchEvent(ev);
              if (ev.defaultPrevented) return;
            }
            ctx.navigationService.openSettings("general");
          },
        }),
        ctx.shortcutService.register({
          id: `${CORE_SHELL_PLUGIN_ID}:new-task`,
          pluginId: CORE_SHELL_PLUGIN_ID,
          key: kNewChat,
          label: "新建对话",
          allowInEditable: true,
          run: () => {
            ctx.navigationService.closeSettings();
            const cwd = ctx.workspaceService.getSnapshot().cwd;
            ctx.navigationService.navigate({ kind: "home", workspace: cwd });
          },
        }),
        ctx.shortcutService.register({
          id: `${CORE_SHELL_PLUGIN_ID}:toggle-terminal-custom`,
          pluginId: CORE_SHELL_PLUGIN_ID,
          key: kTerminal,
          label: "切换集成终端",
          allowInEditable: true,
          when: (sc) => !sc.inTerminal,
          run: dispatchTerminalShortcut,
        }),
        ctx.shortcutService.register({
          id: `${CORE_SHELL_PLUGIN_ID}:open-review`,
          pluginId: CORE_SHELL_PLUGIN_ID,
          key: kChanges,
          label: "打开代码变更审查",
          allowInEditable: true,
          when: (sc) => !sc.inTerminal && isPaneAvailable("review"),
          run: () => {
            ctx.navigationService.closeSettings();
            ctx.navigationService.setHubView(null);
            ctx.workbenchService.openReview();
          },
        }),
      ];

      return {
        keysSig,
        dispose: () => {
          for (const d of disposers) d();
        },
      };
    };

    let dynamicShortcuts = registerDynamicShortcuts();
    const offThemeShortcut = ctx.themeService.subscribe(() => {
      const snap = ctx.themeService.getSnapshot();
      const nextSig = [
        snap.shortcutToggleSidebar || "Ctrl+B",
        snap.shortcutToggleShellMode || "Ctrl+Shift+M",
        snap.shortcutSettings || "Ctrl+,",
        snap.shortcutNewChat || "Ctrl+Shift+N",
        snap.shortcutTerminal || "Ctrl+Shift+T",
        snap.shortcutChanges || "Ctrl+Shift+G",
      ].join("|");
      if (nextSig === dynamicShortcuts.keysSig) return;
      dynamicShortcuts.dispose();
      dynamicShortcuts = registerDynamicShortcuts();
    });
    ctx.effect(() => () => {
      offThemeShortcut();
      dynamicShortcuts.dispose();
    });

    ctx.shortcutService.register({
      id: `${CORE_SHELL_PLUGIN_ID}:sidebar-search`,
      pluginId: CORE_SHELL_PLUGIN_ID,
      key: "Ctrl+K",
      label: "搜索会话与项目",
      allowInEditable: true,
      when: (sc) => !isBotStageActive() && !sc.inTerminal && !ctx.navigationService.getSnapshot().settingsOpen,
      run: () => {
        if (typeof window !== "undefined") {
          window.dispatchEvent(new CustomEvent("qianji:sidebar-search-open"));
        } else {
          ctx.navigationService.setSidebarVisible(true);
        }
      },
    });

    ctx.shortcutService.register({
      id: `${CORE_SHELL_PLUGIN_ID}:cycle-density`,
      pluginId: CORE_SHELL_PLUGIN_ID,
      key: "Ctrl+O",
      label: "切换对话密度",
      allowInEditable: true,
      when: (sc) => !sc.inTerminal && !ctx.navigationService.getSnapshot().settingsOpen,
      run: async () => {
        await ctx.themeService.cycleTranscriptDensity();
      },
    });

    ctx.shortcutService.register({
      id: `${CORE_SHELL_PLUGIN_ID}:toggle-terminal-ctrl-j`,
      pluginId: CORE_SHELL_PLUGIN_ID,
      key: "Ctrl+J",
      label: "切换集成终端",
      allowInEditable: true,
      when: (sc) => !isBotStageActive() && !sc.inTerminal,
      run: dispatchTerminalShortcut,
    });

    ctx.shortcutService.register({
      id: `${CORE_SHELL_PLUGIN_ID}:toggle-terminal-backquote`,
      pluginId: CORE_SHELL_PLUGIN_ID,
      key: "Ctrl+`",
      label: "切换集成终端",
      allowInEditable: true,
      when: (sc) => !sc.inTerminal,
      run: dispatchTerminalShortcut,
    });

    ctx.shortcutService.register({
      id: `${CORE_SHELL_PLUGIN_ID}:open-browser-preview`,
      pluginId: CORE_SHELL_PLUGIN_ID,
      key: "Ctrl+T",
      label: "打开网页预览",
      allowInEditable: true,
      when: (sc) => !sc.inTerminal && isPaneAvailable("preview"),
      run: () => {
        ctx.navigationService.closeSettings();
        ctx.navigationService.setHubView(null);
        ctx.workbenchService.openPane("preview");
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
      label: "打开工作区目录",
      allowInEditable: true,
      when: (sc) => !sc.inTerminal && ctx.workspaceService.getSnapshot().cwd !== "",
      run: async () => {
        if (typeof window !== "undefined") {
          window.dispatchEvent(
            new CustomEvent("qianji:open-workspace-preferred", {
              detail: { cwd: ctx.workspaceService.getSnapshot().cwd },
            }),
          );
        } else {
          await ctx.workspaceService.openInFileManager();
        }
      },
    });

    ctx.effect(() => {
      if (typeof window === "undefined") return () => undefined;
      const onSetMode = (event: Event) => {
        const detail = (event as CustomEvent<string>).detail;
        if (detail === "bot" || detail === "agent") {
          ctx.navigationService.setShellMode(detail);
        }
      };
      window.addEventListener("qianji:set-shell-mode", onSetMode);
      return () => window.removeEventListener("qianji:set-shell-mode", onSetMode);
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

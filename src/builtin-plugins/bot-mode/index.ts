/**
 * Built-in `bot-mode` feature plugin (`src/builtin-plugins/bot-mode/index.ts`).
 *
 * Registers `bot.rail` and `bot.stage` component factories plus Bot-scoped
 * shortcuts (`Ctrl+K` global search, `Ctrl+J` side-chat drawer toggle, and
 * `qianji:bot-open-settings` interception) while adhering 100% to ADR 0023
 * external-plugin import parity.
 */
import type { Context, Plugin } from "@deepseek-ai/cordis";
import { BotLeftRail } from "./BotLeftRail";
import { BotStage } from "./BotStage";
import { botUiStore, openBotModal, patchBotUi } from "./botStore";

export const BOT_MODE_PLUGIN_ID = "bot-mode";
export { BotLeftRail, BotStage };

export const botModePlugin: Plugin.Object = {
  name: BOT_MODE_PLUGIN_ID,
  inject: [
    "slots",
    "sessionService",
    "workspaceService",
    "workbenchService",
    "navigationService",
    "shortcutService",
    "rpcService",
  ],
  apply(ctx: Context) {
    ctx.slots.registerFactory("bot.rail", {
      id: `${BOT_MODE_PLUGIN_ID}:rail`,
      pluginId: BOT_MODE_PLUGIN_ID,
      tier: "builtin",
      priority: 0,
      scope: "root",
      component: BotLeftRail,
    });

    ctx.slots.registerFactory("bot.stage", {
      id: `${BOT_MODE_PLUGIN_ID}:stage`,
      pluginId: BOT_MODE_PLUGIN_ID,
      tier: "builtin",
      priority: 0,
      scope: "root",
      component: BotStage,
    });

    const isBotActive = (): boolean => ctx.navigationService.getSnapshot().shellMode === "bot";

    ctx.shortcutService.register({
      id: `${BOT_MODE_PLUGIN_ID}:search`,
      pluginId: BOT_MODE_PLUGIN_ID,
      key: "Ctrl+K",
      label: "Bot 全局搜索",
      allowInEditable: true,
      when: (sc) => isBotActive() && !sc.inTerminal,
      run: () => {
        openBotModal("search");
      },
    });

    ctx.shortcutService.register({
      id: `${BOT_MODE_PLUGIN_ID}:toggle-side-drawer`,
      pluginId: BOT_MODE_PLUGIN_ID,
      key: "Ctrl+J",
      label: "切换旁聊抽屉",
      allowInEditable: true,
      when: (sc) => isBotActive() && !sc.inTerminal,
      run: () => {
        const cur = botUiStore.get();
        patchBotUi({ activeView: "chat", chatDrawerOpen: !cur.chatDrawerOpen });
      },
    });

    ctx.shortcutService.register({
      id: `${BOT_MODE_PLUGIN_ID}:shortcuts`,
      pluginId: BOT_MODE_PLUGIN_ID,
      key: "Ctrl+/",
      label: "查看键盘快捷键",
      allowInEditable: false,
      when: (sc) => isBotActive() && !sc.inTerminal,
      run: () => {
        openBotModal("shortcuts");
      },
    });
  },
};

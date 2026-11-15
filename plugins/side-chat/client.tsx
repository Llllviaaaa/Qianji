import type { Context } from "@deepseek-ai/cordis";
import { openWorkbenchTab } from "@qianji/client";

export const name = "side-chat";
export const inject = ["contributions"];

export interface SideChatConfig {
  enableShortcut?: boolean;
}

export function apply(ctx: Context, rawConfig: SideChatConfig = {}): void {
  ctx.contributions.registerSlashInterceptor({
    id: "side-chat:slash",
    order: 25,
    onSlashCommand: (cmd, rawArgs) => {
      const normalized = cmd.toLowerCase();
      if (normalized !== "side" && normalized !== "btw") return false;
      openWorkbenchTab("side-chat");
      return rawArgs.trim() === "";
    },
  });

  ctx.contributions.registerMenuItem({
    id: "side-chat:thread-menu",
    location: "thread.more",
    label: "打开侧边分支对话",
    shortcut: "Ctrl+Alt+S",
    order: 40,
    when: ({ sessionFile }) => Boolean(sessionFile),
    onSelect: () => {
      openWorkbenchTab("side-chat");
    },
  });

  if (rawConfig.enableShortcut !== false) {
    ctx.contributions.registerKeybinding({
      id: "side-chat:toggle",
      key: "Ctrl+Alt+S",
      label: "打开侧边分支对话",
      order: 20,
      run: () => {
        openWorkbenchTab("side-chat");
      },
    });
  }
}

export default {
  name,
  inject,
  apply,
};

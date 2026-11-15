import type { Context } from "@deepseek-ai/cordis";
import { openWorkbenchTab } from "@qianji/client";

export const name = "web-preview";
export const inject = ["contributions"];

export function apply(ctx: Context): void {
  ctx.contributions.registerSlashInterceptor({
    id: "web-preview:slash",
    order: 20,
    onSlashCommand: (cmd, rawArgs) => {
      if (cmd.toLowerCase() !== "preview") return false;
      if (rawArgs.trim() === "") {
        openWorkbenchTab("preview");
        return true;
      }
      return false;
    },
  });
}

export default {
  name,
  inject,
  apply,
};

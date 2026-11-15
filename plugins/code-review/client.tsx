import type { Context } from "@deepseek-ai/cordis";
import { openWorkbenchTab, sendChatPrompt } from "@qianji/client";
import { GitCompare, Sparkles } from "lucide-react";

export const name = "code-review";
export const inject = ["contributions"];

export function apply(ctx: Context): void {
  ctx.contributions.registerMenuItem({
    id: "code-review:open-panel-tools",
    location: "menubar.tools",
    label: "打开代码审查面板",
    icon: <GitCompare size={13} />,
    order: 20,
    onSelect: () => {
      openWorkbenchTab("review");
    },
  });

  ctx.contributions.registerMenuItem({
    id: "code-review:run-ai-review-tools",
    location: "menubar.tools",
    label: "AI 审查未提交变更",
    icon: <Sparkles size={13} />,
    order: 21,
    onSelect: () => {
      void sendChatPrompt("/review");
    },
  });

  ctx.contributions.registerMenuItem({
    id: "code-review:thread-open-review",
    location: "thread.more",
    label: "打开代码审查面板",
    order: 35,
    onSelect: () => {
      openWorkbenchTab("review");
    },
  });

  ctx.contributions.registerMenuItem({
    id: "code-review:file-context-review",
    location: "file.context",
    label: "请 AI 审查此文件",
    order: 30,
    when: ({ path }) => path.trim() !== "",
    onSelect: ({ path }) => {
      void sendChatPrompt(
        `请使用 code_review_diff 或读取工具重点审查文件 \`${path}\` 的变更与潜在问题，并给出可落地的修复建议。`,
        { prefillOnly: true },
      );
    },
  });
}

export default {
  name,
  inject,
  apply,
};

import type { Context } from "@deepseek-ai/cordis";
import { Code2, GitCompare, Sparkles, Zap } from "lucide-react";

export const name = "quick-prompts";
export const inject = ["contributions"];

export interface QuickPromptsConfig {
  sendImmediately?: boolean;
  showArchitecture?: boolean;
  showBugHunt?: boolean;
  showGitReview?: boolean;
  customLabel?: string;
  customPrompt?: string;
}

const ARCH_PROMPT = "梳理当前项目的核心目录架构，指出值得优先优化的模块。";
const BUG_PROMPT = "排查当前项目里值得优先修复的潜在缺陷或边界情况，并给出修复建议。";
const GIT_PROMPT = "检查当前工作区的 Git 未提交变更，总结风险点并给出改进建议。";

export function apply(ctx: Context, rawConfig: QuickPromptsConfig = {}): void {
  const sendImmediately = rawConfig.sendImmediately === true;
  const triggerPrompt = (
    prompt: string,
    actions: { prefillComposer: (text: string) => void; sendPrompt: (text: string) => void },
  ) => {
    if (sendImmediately) {
      actions.sendPrompt(prompt);
    } else {
      actions.prefillComposer(prompt);
    }
  };

  if (rawConfig.showArchitecture !== false) {
    ctx.contributions.registerHomeQuickAction({
      id: "quick-prompts:architecture",
      label: "梳理项目架构",
      icon: <Code2 size={13} strokeWidth={1.8} />,
      prompt: ARCH_PROMPT,
      order: 10,
      onSelect: (actions) => triggerPrompt(ARCH_PROMPT, actions),
    });
  }

  if (rawConfig.showBugHunt !== false) {
    ctx.contributions.registerHomeQuickAction({
      id: "quick-prompts:bug-hunt",
      label: "排查潜在缺陷",
      icon: <Sparkles size={13} strokeWidth={1.8} />,
      prompt: BUG_PROMPT,
      order: 20,
      onSelect: (actions) => triggerPrompt(BUG_PROMPT, actions),
    });
  }

  if (rawConfig.showGitReview !== false) {
    ctx.contributions.registerHomeQuickAction({
      id: "quick-prompts:git-review",
      label: "审查未提交变更",
      icon: <GitCompare size={13} strokeWidth={1.8} />,
      prompt: GIT_PROMPT,
      order: 30,
      onSelect: (actions) => triggerPrompt(GIT_PROMPT, actions),
    });
  }

  const customLabel = typeof rawConfig.customLabel === "string" ? rawConfig.customLabel.trim() : "";
  const customPrompt = typeof rawConfig.customPrompt === "string" ? rawConfig.customPrompt.trim() : "";
  if (customLabel !== "" && customPrompt !== "") {
    ctx.contributions.registerHomeQuickAction({
      id: "quick-prompts:custom",
      label: customLabel,
      icon: <Zap size={13} strokeWidth={1.8} />,
      prompt: customPrompt,
      order: 40,
      onSelect: (actions) => triggerPrompt(customPrompt, actions),
    });
  }
}

export default {
  name,
  inject,
  apply,
};

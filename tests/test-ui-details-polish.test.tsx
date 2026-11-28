import { createElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it } from "vitest";
import { BotChatMessageStream } from "../src/builtin-plugins/bot-mode/BotChatMessageStream";
import { filterVisibleBotMessages } from "../src/builtin-plugins/bot-mode/BotChatThreadWidgets";
import {
  BotActiveDirectiveChip,
  BotSlashPopover,
  extractCommittedDraftDirective,
  filterBotSlashCommands,
  type BotSlashCommandItem,
} from "../src/builtin-plugins/bot-mode/BotSlashPopover";
import { BotUserBubbleRow } from "../src/builtin-plugins/bot-mode/BotUserBubble";
import {
  ComposerDirectiveBar,
  resolveActiveComposerDirective,
} from "../src/components/composer/ComposerDirectiveBar";
import { UserMessageRow } from "../src/components/message/UserMessageRow";
import { summarizeProcessGroup } from "../src/components/message/messageHelpers";
import { parseStructuredUserMessage } from "../src/components/message/userBubbleContent";
import { toolRowCopy } from "../src/components/ToolCall";
import { presentToolCall } from "../src/lib/toolPresentation";
import { useAppStore } from "../src/store";
import type { SlashCommand, UiMessage, UiToolCall } from "../src/types";

function syncStoreInitial<T extends object>(store: { getState: () => T; getInitialState: () => T }): () => void {
  const init = store.getInitialState();
  const backup = { ...init };
  Object.assign(init, store.getState());
  return () => {
    for (const key of Object.keys(init) as Array<keyof T>) {
      if (!(key in backup)) delete init[key];
    }
    Object.assign(init, backup);
  };
}

function renderWithAppStore(node: ReactNode): string {
  const restore = syncStoreInitial(useAppStore);
  try {
    return renderToStaticMarkup(node);
  } finally {
    restore();
  }
}

afterEach(() => {
  useAppStore.setState({
    commands: [],
    messages: [],
  });
});

describe("Agent Mode structured user bubbles, skill pills, mentions & file chips", () => {
  const sampleCommands: SlashCommand[] = [
    { name: "plan", description: "查看或管理执行计划", source: "plan" },
    { name: "skill:frontend-design", description: "构建高审美前端界面与排版细节", source: "skill" },
  ];

  const makeUserMessage = (content: string): UiMessage => ({
    id: "u-rich-1",
    role: "user",
    content,
    timestamp: 1_700_000_000_000,
  });

  it("renders dedicated skill pills for /skill:<slug> and bare /<knownSkill> in UserMessageRow", () => {
    useAppStore.setState({ commands: sampleCommands });

    const explicitSkillHtml = renderWithAppStore(
      createElement(UserMessageRow, {
        message: makeUserMessage("/skill:frontend-design 优化所有气泡细节"),
        editing: false,
        requireCtrlEnter: false,
        slotCwd: "/repo",
        slotSessionFile: null,
      }),
    );
    expect(explicitSkillHtml).toContain('class="qj-cmd-pill is-skill"');
    expect(explicitSkillHtml).toContain('data-skill="frontend-design"');
    expect(explicitSkillHtml).toContain("技能");
    expect(explicitSkillHtml).toContain("frontend-design");
    expect(explicitSkillHtml).toContain("优化所有气泡细节");

    const bareSkillHtml = renderWithAppStore(
      createElement(UserMessageRow, {
        message: makeUserMessage("/frontend-design 检查深色模式对比度"),
        editing: false,
        requireCtrlEnter: false,
        slotCwd: "/repo",
        slotSessionFile: null,
      }),
    );
    expect(bareSkillHtml).toContain('class="qj-cmd-pill is-skill"');
    expect(bareSkillHtml).toContain('data-skill="frontend-design"');
    expect(bareSkillHtml).toContain("检查深色模式对比度");
  });

  it("parses quotes, connector headers, @file mentions, and detaches trailing local file attachments", () => {
    const raw = [
      "> 上一轮关于间距和圆角的结论",
      "",
      "[已关联连接器上下文: Gmail, GitHub]",
      '/skill:frontend-design 请对照 @src/App.tsx 和 @"src/components/Message.tsx" 优化',
      "",
      "附加的本地文件：",
      "- tokens.css: D:\\repo\\src\\styles\\tokens.css",
      "- spec.pdf: D:\\repo\\docs\\spec.pdf",
    ].join("\n");

    const parsed = parseStructuredUserMessage(raw, new Set(["frontend-design"]));
    expect(parsed.quotedText).toBe("上一轮关于间距和圆角的结论");
    expect(parsed.connectors).toEqual(["Gmail", "GitHub"]);
    expect(parsed.directive).toMatchObject({
      kind: "skill",
      displayName: "frontend-design",
    });
    expect(parsed.attachedFiles).toEqual([
      { fileName: "tokens.css", path: "D:\\repo\\src\\styles\\tokens.css", ext: "CSS" },
      { fileName: "spec.pdf", path: "D:\\repo\\docs\\spec.pdf", ext: "PDF" },
    ]);

    const html = renderWithAppStore(
      createElement(UserMessageRow, {
        message: makeUserMessage(raw),
        editing: false,
        requireCtrlEnter: false,
        slotCwd: "/repo",
        slotSessionFile: null,
      }),
    );
    expect(html).toContain('class="qj-user-quote-card"');
    expect(html).toContain("上一轮关于间距和圆角的结论");
    expect(html).toContain('class="qj-user-connector-pill"');
    expect(html).toContain("Gmail");
    expect(html).toContain("GitHub");
    expect(html).toContain('class="qj-mention-pill"');
    expect(html).toContain("App.tsx");
    expect(html).toContain("Message.tsx");
    expect(html).toContain('class="dshc-file-attachment-chip"');
    expect(html).toContain("tokens.css");
    expect(html).toContain("CSS");
    expect(html).not.toContain("附加的本地文件：");
    expect(html).not.toContain("[已关联连接器上下文:");
  });
});

describe("Composer active skill & command directive bar", () => {
  const commands: SlashCommand[] = [
    { name: "plan", description: "拆解并跟踪多步执行计划", source: "plan" },
    { name: "skill:frontend-design", description: "打造精致独特的界面视觉体系", source: "skill" },
  ];

  it("ignores uncommitted slash prefixes and renders dismissible directive bar once committed with space", () => {
    expect(resolveActiveComposerDirective("/skill:frontend-design", commands)).toBeNull();
    expect(resolveActiveComposerDirective("普通文本 /plan 测试", commands)).toBeNull();

    const skillDir = resolveActiveComposerDirective("/frontend-design 优化对话页", commands);
    expect(skillDir).toMatchObject({
      kind: "skill",
      badgeLabel: "技能",
      displayName: "frontend-design",
      description: "打造精致独特的界面视觉体系",
      remainingText: "优化对话页",
    });

    const goalDir = resolveActiveComposerDirective("/goal 全量跑通验收", commands);
    expect(goalDir).toMatchObject({
      kind: "command",
      badgeLabel: "长程目标",
      displayName: "/goal",
      remainingText: "全量跑通验收",
    });

    const barHtml = renderToStaticMarkup(
      createElement(ComposerDirectiveBar, {
        text: "/skill:frontend-design 优化对话页",
        commands,
        onClear: () => undefined,
      }),
    );
    expect(barHtml).toContain('data-testid="composer-directive-bar"');
    expect(barHtml).toContain('data-kind="skill"');
    expect(barHtml).toContain("frontend-design");
    expect(barHtml).toContain("打造精致独特的界面视觉体系");
  });
});

describe("Bot Mode structured user bubbles, / skill popover & assistant skill provenance", () => {
  const botCommands: BotSlashCommandItem[] = [
    { name: "clear", description: "清空当前对话并开启新话题", source: "builtin" },
    { name: "plan", description: "查看执行计划", source: "plan" },
    { name: "skill:frontend-design", description: "高审美前端与组件设计规范", source: "skill" },
    { name: "mcp-github-pr", description: "查询 GitHub PR 状态", source: "mcp" },
  ];

  it("renders rich BotUserBubbleRow with quote, branded @App connector pills, skill pill, mentions & file chips", () => {
    const raw = [
      "> 今晚九点发布新版本",
      "",
      "[已关联连接器上下文: Gmail、GitHub]",
      "/frontend-design 帮我审阅 @src/styles/bot-mode.css 的圆角与阴影",
      "",
      "附加的本地文件：",
      "- preview.png: D:\\shots\\preview.png",
    ].join("\n");

    const html = renderToStaticMarkup(
      createElement(BotUserBubbleRow, {
        content: raw,
        knownSkills: new Set(["frontend-design"]),
        onCopy: () => undefined,
        onQuote: () => undefined,
      }),
    );
    expect(html).toContain('class="qj-user-quote-card"');
    expect(html).toContain("今晚九点发布新版本");
    expect(html).toContain('class="qj-user-connector-pill"');
    expect(html).toContain("@Gmail");
    expect(html).toContain("@GitHub");
    expect(html).toContain('class="qj-cmd-pill is-skill"');
    expect(html).toContain("frontend-design");
    expect(html).toContain('class="qj-mention-pill"');
    expect(html).toContain("bot-mode.css");
    expect(html).toContain('class="dshc-file-attachment-chip"');
    expect(html).toContain("preview.png");
    expect(html).not.toContain("附加的本地文件：");
  });

  it("groups and filters Bot / commands & skills and renders active directive chip", () => {
    const grouped = filterBotSlashCommands(botCommands, "");
    expect(grouped.map((c) => c.name)).toEqual([
      "clear",
      "plan",
      "skill:frontend-design",
      "mcp-github-pr",
    ]);

    const skillFiltered = filterBotSlashCommands(botCommands, "front");
    expect(skillFiltered.map((c) => c.name)).toEqual(["skill:frontend-design"]);

    const popoverHtml = renderToStaticMarkup(
      createElement(BotSlashPopover, {
        matches: grouped,
        activeIndex: 2,
        query: "",
        listboxId: "bot-slash-test",
        onHoverIndex: () => undefined,
        onSelect: () => undefined,
      }),
    );
    expect(popoverHtml).toContain('data-testid="bot-slash-popover"');
    expect(popoverHtml).toContain("常用指令");
    expect(popoverHtml).toContain("工作区技能");
    expect(popoverHtml).toContain("连接器与扩展");
    expect(popoverHtml).toContain("/skill:");
    expect(popoverHtml).toContain("frontend-design");

    const committed = extractCommittedDraftDirective("/skill:frontend-design 优化气泡细节", botCommands);
    expect(committed).not.toBeNull();
    if (committed !== null) {
      expect(committed).toMatchObject({
        kind: "skill",
        displayName: "frontend-design",
        remainingDraft: "优化气泡细节",
      });
      const chipHtml = renderToStaticMarkup(
        createElement(BotActiveDirectiveChip, {
          directive: committed,
          onClear: () => undefined,
        }),
      );
      expect(chipHtml).toContain('data-testid="bot-composer-directive-chip"');
      expect(chipHtml).toContain("技能");
      expect(chipHtml).toContain("frontend-design");
    }
  });

  it("surfaces settled assistant skill provenance badge when SKILL.md was read during the turn", () => {
    const turnMessages = [
      { id: "u1", role: "user", content: "/skill:frontend-design 优化聊天窗口" },
      {
        id: "a1",
        role: "assistant",
        content: "",
        toolCalls: [
          {
            id: "tc-skill",
            name: "read",
            args: { path: "C:\\Users\\yht\\.gemini\\config\\skills\\frontend-design\\SKILL.md" },
          },
        ],
      },
      {
        id: "a2",
        role: "assistant",
        model: "claude-sonnet-4.6",
        content: "已完成聊天窗口的胶囊标签与层次优化。",
      },
    ];

    const streamingVisible = filterVisibleBotMessages(turnMessages, true);
    const streamingHtml = renderToStaticMarkup(
      createElement(BotChatMessageStream, {
        isMain: true,
        topTitle: "聊天",
        isHydratingHistory: false,
        isEmptyChat: false,
        isStreaming: true,
        showTrailingThinking: false,
        visibleMessages: streamingVisible,
        embeddedTasks: [],
        runtimeError: null,
        reactedIds: {},
        moreMsgId: null,
        onToggleReaction: () => undefined,
        onQuote: () => undefined,
        onToggleMore: () => undefined,
        onCloseMore: () => undefined,
        onCopy: () => undefined,
        onBranchSideChat: () => undefined,
        onOpenInWorkbench: () => undefined,
        onSelectQuickOption: () => undefined,
        onTriggerHandoff: () => undefined,
        onOpenModels: () => undefined,
      }),
    );
    expect(streamingHtml).not.toContain('data-testid="bot-msg-skill-tag"');

    const settledVisible = filterVisibleBotMessages(turnMessages, false);
    const settledHtml = renderToStaticMarkup(
      createElement(BotChatMessageStream, {
        isMain: true,
        topTitle: "聊天",
        isHydratingHistory: false,
        isEmptyChat: false,
        isStreaming: false,
        showTrailingThinking: false,
        visibleMessages: settledVisible,
        embeddedTasks: [],
        runtimeError: null,
        reactedIds: {},
        moreMsgId: null,
        onToggleReaction: () => undefined,
        onQuote: () => undefined,
        onToggleMore: () => undefined,
        onCloseMore: () => undefined,
        onCopy: () => undefined,
        onBranchSideChat: () => undefined,
        onOpenInWorkbench: () => undefined,
        onSelectQuickOption: () => undefined,
        onTriggerHandoff: () => undefined,
        onOpenModels: () => undefined,
      }),
    );
    expect(settledHtml).toContain('data-testid="bot-msg-skill-tag"');
    expect(settledHtml).toContain('title="本轮回复已启用技能：frontend-design"');
    expect(settledHtml).toContain("<span>frontend-design</span>");
  });
});

describe("Skill SKILL.md read & Qianji builtin meta-tool presentation", () => {
  const makeCall = (name: string, args: Record<string, unknown>): UiToolCall => ({
    id: `tc-${name}`,
    name,
    args,
    running: false,
  });

  it("presents SKILL.md reads as kind=skill with clean skill slug and process summary", () => {
    const skillRead = makeCall("read", {
      path: "C:\\Users\\yht\\.gemini\\config\\skills\\frontend-design\\SKILL.md",
    });
    const presented = presentToolCall(skillRead);
    expect(presented).toMatchObject({
      kind: "skill",
      title: "加载技能",
      detail: "frontend-design",
      heading: "加载技能 · frontend-design",
    });
    expect(toolRowCopy(presented, skillRead)).toEqual({
      title: "加载技能",
      summary: "frontend-design",
    });
    expect(summarizeProcessGroup(1, [skillRead])).toBe("执行 1 次思考，启用技能 frontend-design");
  });

  it("localizes activate_tools, qianji_inspect, plugin_manager, and ask_question instead of generic 工具调用", () => {
    expect(presentToolCall(makeCall("activate_tools", { names: ["plugin_manager", "qianji_inspect"] }))).toMatchObject({
      title: "加载扩展工具",
      detail: "plugin_manager, qianji_inspect",
    });
    expect(presentToolCall(makeCall("qianji_inspect", { topic: "client_slots" }))).toMatchObject({
      title: "检查宿主架构",
      detail: "client_slots",
    });
    expect(presentToolCall(makeCall("plugin_manager", { action: "verify", pluginId: "demo-skin" }))).toMatchObject({
      title: "管理扩展插件",
      detail: "verify · demo-skin",
    });
    expect(
      presentToolCall(makeCall("ask_question", { questions: [{ question: "请选择配色方向" }] })),
    ).toMatchObject({
      title: "向你提问确认",
      detail: "请选择配色方向",
    });
  });
});

/**
 * Frontend microkernel integration tests for Qianji Bot Mode (`bot-mode` + `core-shell`):
 * 1. Dual-mounted `Agent ⇄ Bot` shell attributes, `#mode-pill` capsule, `72px` `bot.rail`, & `bot.stage`.
 * 2. Clean 1:1 Muse state across `聊天` / `旁聊抽屉` / `动态` / `点子` / `目标` / `资源库` / `创建空间`.
 * 3. Companion tabs (`动态` / `批准` / `身份` / `邮箱`), 9-tab Settings, and Virtual Server console.
 * 4. Bidirectional `Bot ⇄ Agent` task handoff (`#handoff-ribbon` + `bot-handoff-return` chip).
 */
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it } from "vitest";
import { Context } from "@deepseek-ai/cordis";
import { ClientSlotsService, SlotRegistry, SlotRoot } from "@qianji/client-slots";
import { BOT_MODE_PLUGIN_ID, botModePlugin } from "../src/builtin-plugins/bot-mode";
import {
  botDataStore,
  botUiStore,
  closeActiveBotModal,
  FALLBACK_BOT_SNAPSHOT,
  INITIAL_BOT_UI_STATE,
  openBotConnector,
  openBotLiveView,
  openBotModal,
  openHostSettingsFromBot,
  patchBotUi,
} from "../src/builtin-plugins/bot-mode/botStore";
import { triggerCharacterPoke } from "../src/builtin-plugins/bot-mode/botCharacterState";
import { BotChatMessageStream } from "../src/builtin-plugins/bot-mode/BotChatMessageStream";
import { filterVisibleBotMessages, stripBotThinking } from "../src/builtin-plugins/bot-mode/BotChatThreadWidgets";
import { CORE_SHELL_PLUGIN_ID, coreShellPlugin } from "../src/builtin-plugins/core-shell";
import { registerFrontendServices } from "../src/kernel/services";

async function createBotShellHarness(options?: { enableBotPlugin?: boolean }) {
  const root = new Context();
  const registry = new SlotRegistry();
  await root.plugin(ClientSlotsService, registry);
  await registerFrontendServices(root, { shortcutTarget: null });
  const shellFiber = await root.plugin(coreShellPlugin);

  let botFiber: Awaited<ReturnType<typeof root.plugin>> | null = null;
  if (options?.enableBotPlugin !== false) {
    botFiber = await root.plugin(botModePlugin);
  }

  const renderHtml = () =>
    renderToStaticMarkup(createElement(SlotRoot, { registry, ctx: root }));

  return {
    root,
    registry,
    renderHtml,
    disableBot: async () => {
      if (botFiber) {
        await botFiber.dispose();
        botFiber = null;
      }
    },
    dispose: async () => {
      if (botFiber) await botFiber.dispose();
      await shellFiber.dispose();
    },
  };
}

describe("Bot Mode Frontend Microkernel & 1:1 Muse Integration", () => {
  const cleanups: Array<() => Promise<void>> = [];

  afterEach(async () => {
    botUiStore.set(INITIAL_BOT_UI_STATE);
    botDataStore.set(FALLBACK_BOT_SNAPSHOT);
    while (cleanups.length > 0) {
      const fn = cleanups.pop();
      if (fn) await fn();
    }
  });

  it("mounts Agent mode by default with #mode-pill and clean 1:1 Muse Bot stage", async () => {
    const harness = await createBotShellHarness();
    cleanups.push(harness.dispose);

    expect(harness.registry.getFactoryCandidates("bot.rail")[0]?.pluginId).toBe(BOT_MODE_PLUGIN_ID);
    expect(harness.registry.getFactoryCandidates("bot.stage")[0]?.pluginId).toBe(BOT_MODE_PLUGIN_ID);
    expect(harness.registry.getEntries("root")[0]?.pluginId).toBe(CORE_SHELL_PLUGIN_ID);

    const agentHtml = harness.renderHtml();
    expect(agentHtml).toContain('data-shell-mode="agent"');
    expect(agentHtml).toContain('data-bot-available="true"');
    expect(agentHtml).toContain('id="mode-pill"');
    expect(agentHtml).toContain('data-mode="agent"');
    expect(agentHtml).toContain('data-testid="bot-left-rail"');
    expect(agentHtml).toContain('data-testid="bot-stage"');

    harness.root.navigationService.toggleShellMode();
    expect(harness.root.navigationService.getSnapshot().shellMode).toBe("bot");

    const botHtml = harness.renderHtml();
    expect(botHtml).toContain('data-shell-mode="bot"');
    expect(botHtml).toContain('data-mode="bot"');
    expect(botHtml).toContain('data-testid="bot-character-stage"');
    expect(botHtml).not.toContain('data-testid="bot-mini-screen"');
    expect(botHtml).not.toContain('data-testid="bot-computer-preview"');
    expect(botHtml).not.toContain('data-testid="bot-awareness-grid"');
    expect(botHtml).not.toContain('data-testid="bot-interact-bar"');
    expect(botHtml).not.toContain('data-testid="bot-emote-strip"');
    expect(botHtml).toContain('data-testid="bot-vserver-pill"');
    expect(botHtml).toContain('id="btn-toggle-chat-drawer"');
    expect(botHtml).toContain('data-expression="calm"');
    expect(botHtml).toContain('data-action="idle"');
    expect(botHtml).toContain("已连接");
    expect(botHtml).not.toContain("PR #142");
    expect(botHtml).not.toContain("Qianji-Engine");
    expect(botHtml).not.toContain("Updated main companion conversation");

    // Open Muse slide-out side-chat drawer
    patchBotUi({ chatDrawerOpen: true });
    const drawerHtml = harness.renderHtml();
    expect(drawerHtml).toContain('data-testid="bot-side-drawer"');
    expect(drawerHtml).toContain("主要聊天");
    expect(drawerHtml).toContain("旁聊");

    // Composer draft typing engages curious listening state & @App chip renders cleanly
    patchBotUi({ composerDraft: "帮我看看今天邮件", composerApps: ["github"] });
    const typingHtml = harness.renderHtml();
    expect(typingHtml).toContain('data-expression="curious"');
    expect(typingHtml).toContain('data-action="nod"');
    expect(typingHtml).toContain('data-testid="composer-plus-btn"');
    expect(typingHtml).toContain('data-testid="composer-app-chip-github"');
    expect(typingHtml).toContain("@GitHub");

    // Poke & combo pet trigger interactive wave + celebrate
    triggerCharacterPoke(0);
    expect(harness.renderHtml()).toContain('data-action="wave"');
    triggerCharacterPoke(1);
    triggerCharacterPoke(2);
    expect(harness.renderHtml()).toContain('data-action="celebrate"');

    // Strip <think>, <thinking>, <thought>, orphan prefill closing tags, and partial streaming tags at EOF
    expect(stripBotThinking("<think>先想一下</think>\n今晚没有安排。")).toBe("今晚没有安排。");
    expect(stripBotThinking("<thinking>The bash tool is running in PowerShell...</thinking>\n查好了，一切正常。")).toBe("查好了，一切正常。");
    expect(stripBotThinking("<THINKING>\n大写多行思考\n</THINKING>\n最终结论。")).toBe("最终结论。");
    expect(stripBotThinking("<thought>推理步骤</thought>简短答复")).toBe("简短答复");
    expect(stripBotThinking("<think>正在推演中")).toBe("");
    expect(stripBotThinking("<thinking>The bash tool is running in PowerShell without close")).toBe("");
    expect(stripBotThinking("先说结论前缀。<thinking>中间夹杂内部独白</thinking>再补一句。")).toBe("先说结论前缀。再补一句。");
    expect(stripBotThinking("Prefill orphan reasoning before close</thinking>\n真正的对外回复。")).toBe("真正的对外回复。");
    expect(stripBotThinking("<thinking>内部思考</thinking>带杂散闭合标签</thinking>正文</think>")).toBe("带杂散闭合标签正文");
    expect(stripBotThinking("<thinking>未闭合思考里出现 </think> 也不能泄漏后续内容")).toBe("");
    expect(stripBotThinking("<thinkin")).toBe("");
    expect(stripBotThinking("流式正文末尾半截标签</thinki")).toBe("流式正文末尾半截标签");
    expect(stripBotThinking("1 < 2 且 a < b")).toBe("1 < 2 且 a < b");

    const filteredIdle = filterVisibleBotMessages(
      [
        { role: "user", content: "你好" },
        { role: "assistant", content: "" },
        { role: "assistant", content: "<thinking>内部判断</thinking>" },
        { role: "assistant", content: "在的，今晚日程空着。" },
      ],
      false,
    );
    expect(filteredIdle).toHaveLength(2);
    expect(filteredIdle[1]?.content).toBe("在的，今晚日程空着。");

    const filteredStreaming = filterVisibleBotMessages(
      [
        { role: "user", content: "你好" },
        { role: "assistant", content: "" },
      ],
      true,
    );
    expect(filteredStreaming).toHaveLength(2);

    // Multi-step tool-loop collapsing in Bot chat (streaming vs settled + aborted fallback)
    const renderStreamMarkup = (
      rawMessages: ReadonlyArray<{ id: string; role: string; content: string; model?: string; toolCalls?: readonly unknown[] }>,
      streaming: boolean,
    ) => {
      const visible = filterVisibleBotMessages(rawMessages, streaming);
      const lastVis = visible[visible.length - 1];
      const showTrailingThinking = streaming && (lastVis === undefined || lastVis.role === "user");
      return renderToStaticMarkup(
        createElement(BotChatMessageStream, {
          isMain: true,
          topTitle: "聊天",
          isHydratingHistory: false,
          isEmptyChat: visible.length === 0 && !streaming,
          isStreaming: streaming,
          showTrailingThinking,
          visibleMessages: visible,
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
    };

    // Before first assistant sub-message arrives while streaming -> exactly 1 typing indicator
    const userOnlyStreamHtml = renderStreamMarkup([{ id: "u1", role: "user", content: "检查工作区状态" }], true);
    expect(userOnlyStreamHtml.split('data-testid="bot-live-thinking"').length - 1).toBe(1);

    // During multi-step tool execution + <thinking> -> pre-tool narration & <thinking> suppressed, exactly 1 typing indicator
    const midToolMessages = [
      { id: "u1", role: "user", content: "检查工作区状态" },
      {
        id: "a1",
        role: "assistant",
        content: "我先调用 PowerShell 检查一下目录…",
        toolCalls: [{ id: "tc-1", name: "bash" }],
      },
      {
        id: "a2",
        role: "assistant",
        content: "<thinking>The bash tool is running in PowerShell...</thinking>\n再检查一下进程…",
        toolCalls: [{ id: "tc-2", name: "bash" }],
      },
      {
        id: "a3",
        role: "assistant",
        content: "<thinking>正在汇总最终答复",
      },
    ];
    const midToolStreamHtml = renderStreamMarkup(midToolMessages, true);
    expect(midToolStreamHtml.split('data-testid="bot-live-thinking"').length - 1).toBe(1);
    expect(midToolStreamHtml.split('class="qj-sanctuary-bubble-bot"').length - 1).toBe(0);
    expect(midToolStreamHtml).not.toContain("我先调用 PowerShell");
    expect(midToolStreamHtml).not.toContain("The bash tool is running");
    expect(midToolStreamHtml).not.toContain("再检查一下进程");

    // Once final post-tool prose arrives & settles -> 1 clean final bubble, 0 typing indicators, 0 intermediate leaks
    const settledToolMessages = [
      ...midToolMessages.slice(0, 3),
      {
        id: "a3",
        role: "assistant",
        model: "grok-4.7",
        content: "<thinking>汇总完毕</thinking>\n工作区目录与后台进程均正常。",
      },
    ];
    const settledToolHtml = renderStreamMarkup(settledToolMessages, false);
    expect(settledToolHtml.split('data-testid="bot-live-thinking"').length - 1).toBe(0);
    expect(settledToolHtml.split('class="qj-sanctuary-bubble-bot"').length - 1).toBe(1);
    expect(settledToolHtml).toContain("工作区目录与后台进程均正常。");
    expect(settledToolHtml).toContain("grok-4.7");
    expect(settledToolHtml).not.toContain("我先调用 PowerShell");
    expect(settledToolHtml).not.toContain("The bash tool is running");
    expect(settledToolHtml).not.toContain("汇总完毕");

    // Settled turn aborted/max-turns after tool narration with no post-tool message preserves latest non-empty prose
    const abortedAfterTool = filterVisibleBotMessages(
      [
        { id: "u1", role: "user", content: "执行两步任务" },
        {
          id: "a1",
          role: "assistant",
          content: "<thinking>第一步</thinking>\n已完成第一步备份，后续执行已中止。",
          toolCalls: [{ id: "tc-1", name: "bash" }],
        },
      ],
      false,
    );
    expect(abortedAfterTool).toHaveLength(2);
    expect(abortedAfterTool[1]?.content).toBe("已完成第一步备份，后续执行已中止。");
  });

  it("renders all 1:1 Muse views, Companion tabs, and 9-tab Settings / Virtual Server console", async () => {
    const harness = await createBotShellHarness();
    cleanups.push(harness.dispose);
    harness.root.navigationService.setShellMode("bot", { persist: false });

    expect(harness.renderHtml()).not.toContain("qj-bot-side-popover");

    patchBotUi({ activeView: "feed" });
    expect(harness.renderHtml()).toContain("还没有主动动态简报");

    patchBotUi({ activeView: "ideas" });
    expect(harness.renderHtml()).toContain("点子");

    patchBotUi({ activeView: "goals" });
    expect(harness.renderHtml()).toContain("创建目标");
    expect(harness.renderHtml()).toContain("追踪");

    patchBotUi({ activeView: "library", libSection: "sysfiles" });
    expect(harness.renderHtml()).toContain("系统文件");
    expect(harness.renderHtml()).toContain("SOUL.md");
    expect(harness.renderHtml()).toContain("MEMORY.md");

    patchBotUi({ activeView: "spaces" });
    expect(harness.renderHtml()).toContain("我想创建一个空间，关于 ");

    // Companion tabs on chat view: Approvals, Identity, Inbox
    patchBotUi({ activeView: "chat", rightTab: "approvals" });
    expect(harness.renderHtml()).toContain("暂无批准记录");

    patchBotUi({ rightTab: "identity" });
    expect(harness.renderHtml()).toContain("SOUL");
    expect(harness.renderHtml()).toContain("记忆");

    patchBotUi({ rightTab: "inbox" });
    expect(harness.renderHtml()).toContain("为千机提供邮箱");
    expect(harness.renderHtml()).toContain("创建邮箱");

    // 9-tab Settings: General Workspace, Virtual Server Storage, & Muse/GrokBot Connectors Directory
    openBotModal("settings", "general");
    const generalHtml = harness.renderHtml();
    expect(generalHtml).toContain("分身主工作区目录 (/workspace)");

    openBotModal("settings", "server");
    const localServerHtml = harness.renderHtml();
    expect(localServerHtml).toContain('data-testid="bot-settings-modal"');
    expect(localServerHtml).toContain("一键重置环境");
    expect(localServerHtml).toContain("虚拟磁盘与容器存储位置（释放 C 盘空间）");
    expect(localServerHtml).toContain("声音和虚拟形象");

    botDataStore.set((prev) => ({
      ...prev,
      virtualServer: { ...prev.virtualServer, mode: "remote" },
    }));
    const remoteServerHtml = harness.renderHtml();
    expect(remoteServerHtml).toContain("远端虚拟服务器地址");
    expect(remoteServerHtml).toContain("一键初始化环境");

    openBotModal("settings", "connectors");
    const connectorsHtml = harness.renderHtml();
    expect(connectorsHtml).toContain('data-testid="bot-connectors-directory"');
    expect(connectorsHtml).toContain("精选推荐");
    expect(connectorsHtml).toContain("办公与协作");
    expect(connectorsHtml).toContain("研发与设计");
    expect(connectorsHtml).toContain("Gmail");
    expect(connectorsHtml).toContain("Google 云端硬盘");
    expect(connectorsHtml).toContain("GitHub");
    expect(connectorsHtml).toContain("Notion");
    expect(connectorsHtml).toContain("Linear");
    expect(connectorsHtml).toContain("Figma");
    expect(connectorsHtml).toContain("Excalidraw");
    expect(connectorsHtml).toContain("管理插件");
    expect(connectorsHtml).toContain("添加自定义 MCP");

    openBotModal("settings", "plugins");
    const botPluginsHtml = harness.renderHtml();
    expect(botPluginsHtml).toContain('data-testid="bot-plugins-settings-pane"');
    expect(botPluginsHtml).toContain("插件与双端共享");

    // Unconnected view has 1-click 连接 CTA and zero inline credential input boxes
    openBotConnector("notion");
    const notionUnconnHtml = harness.renderHtml();
    expect(notionUnconnHtml).toContain('data-testid="connector-detail-notion"');
    expect(notionUnconnHtml).toContain('data-testid="connect-app-btn"');
    expect(notionUnconnHtml).toContain("关于此连接器");
    expect(notionUnconnHtml).toContain("试试这样问");
    const notionStart = notionUnconnHtml.indexOf('data-testid="connector-detail-notion"');
    const notionEnd = notionUnconnHtml.indexOf("</section>", notionStart);
    expect(notionUnconnHtml.slice(notionStart, notionEnd)).not.toContain("<input");

    // Connected view renders Muse + ChatGPT 4-tier Default Policy & granular per-action permissions
    botDataStore.set((prev) => ({
      ...prev,
      connectorConfigs: {
        ...prev.connectorConfigs,
        appPolicies: {
          github: { connected: true, authKind: "browser", accountLabel: "@qianji-dev", policy: "low-risk-auto" },
        },
      },
    }));
    openBotConnector("github");
    const githubConnHtml = harness.renderHtml();
    expect(githubConnHtml).toContain('data-testid="connector-detail-github"');
    expect(githubConnHtml).toContain("已连接的账户");
    expect(githubConnHtml).toContain("@qianji-dev");
    expect(githubConnHtml).toContain("默认权限");
    expect(githubConnHtml).toContain("始终询问");
    expect(githubConnHtml).toContain("允许使用低风险工具（默认）");
    expect(githubConnHtml).toContain("细分操作权限");
    expect(githubConnHtml).toContain("读取权限");
    expect(githubConnHtml).toContain("写入和删除权限");
    expect(githubConnHtml).toContain("断开连接");

    openBotConnector("custom-mcp");
    const customMcpHtml = harness.renderHtml();
    expect(customMcpHtml).toContain('data-testid="bot-custom-mcp-sheet"');
    expect(customMcpHtml).toContain("添加自定义 MCP 服务器");
    expect(customMcpHtml).toContain("OAuth 2.1 自动网页授权");

    // Dual-mode toggle (`弹窗视图 ⇄ 页面视图`), origin-aware breadcrumbs & reversible sub-modals
    patchBotUi({ settingsPageMode: true });
    const pageSettingsHtml = harness.renderHtml();
    expect(pageSettingsHtml).toContain("返回分身");
    expect(pageSettingsHtml).toContain("弹窗视图");
    patchBotUi({ settingsPageMode: false });

    openBotConnector("slack", "channels");
    const slackFromChannelsHtml = harness.renderHtml();
    expect(slackFromChannelsHtml).toContain("返回消息渠道");

    openBotModal("settings", "server");
    openBotLiveView(undefined, { returnToCurrent: true });
    expect(botUiStore.get().modal).toBe("live-view");
    expect(botUiStore.get().returnModal).toBe("settings");
    closeActiveBotModal();
    expect(botUiStore.get().modal).toBe("settings");
    expect(botUiStore.get().settingsTab).toBe("server");

    openHostSettingsFromBot(harness.root.navigationService, "providers");
    expect(harness.root.navigationService.getSnapshot().shellMode).toBe("bot");
    expect(harness.root.navigationService.getSnapshot().settingsOpen).toBe(true);
    expect(botUiStore.get().suspendedForHostSettings).toBe(true);
  });

  it("supports bidirectional Bot ⇄ Agent task handoff and falls back cleanly when bot-mode is disabled", async () => {
    const harness = await createBotShellHarness();
    cleanups.push(harness.dispose);
    harness.root.navigationService.setShellMode("bot", { persist: false });

    harness.root.navigationService.beginBotHandoff({
      id: "space-arch-review",
      title: "核心架构演进看板",
      kindLabel: "常驻空间",
      summary: "从 Bot 空间移交至 Agent 工作台深度推进",
      targetCwd: "",
    });
    expect(harness.root.navigationService.getSnapshot().shellMode).toBe("agent");

    const handoffAgentHtml = harness.renderHtml();
    expect(handoffAgentHtml).toContain('data-shell-mode="agent"');
    expect(handoffAgentHtml).toContain('id="handoff-ribbon"');
    expect(handoffAgentHtml).toContain('data-testid="bot-handoff-return"');
    expect(handoffAgentHtml).toContain("← 完成并回传 Bot");

    harness.root.navigationService.finishBotHandoff("已将完成摘要回传千机 Bot");
    expect(harness.root.navigationService.getSnapshot().shellMode).toBe("bot");
    expect(harness.root.navigationService.getSnapshot().activeBotHandoff).toBeNull();

    await harness.disableBot();
    const disabledHtml = harness.renderHtml();
    expect(disabledHtml).toContain('data-shell-mode="agent"');
    expect(disabledHtml).not.toContain('id="mode-pill"');
    expect(disabledHtml).not.toContain('data-testid="bot-stage"');
  });
});

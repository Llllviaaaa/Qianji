/**
 * Comprehensive V2 verification suite for Qianji Bot Mode's 1:1+ Meta Muse Discovery
 * (`动态` Editions & HTML Widgets, `点子` Blueprint Preview Modal & Undo, `目标` Chat-First
 * Co-Planning & Month-Grouped Archive, Resizable Split Main Chat, and Bubble Quick Options, `<= 450L`).
 */
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Context } from "@deepseek-ai/cordis";
import { ClientSlotsService, SlotRegistry, SlotRoot } from "@qianji/client-slots";
import type { BotFeedItem, BotGoalItem } from "@qianji/protocol";
import { botModePlugin } from "../src/builtin-plugins/bot-mode";
import { BotAssistantBubbleRow, extractBotQuickOptions } from "../src/builtin-plugins/bot-mode/BotChatThreadWidgets";
import { resolvePendingAutoSend } from "../src/builtin-plugins/bot-mode/BotChatView";
import { BotFeedView, BotGoalDetailModal, BotGoalsView, BotIdeasView } from "../src/builtin-plugins/bot-mode/BotDiscoveryViews";
import { buildFeedWidgetSrcDoc } from "../src/builtin-plugins/bot-mode/BotFeedModals";
import { BotIdeaDetailModal } from "../src/builtin-plugins/bot-mode/BotIdeaDetailModal";
import {
  botDataStore, botUiStore, clampSplitChatWidth, discussInBot, FALLBACK_BOT_SNAPSHOT,
  formatFeedEditionLabel, formatFeedExactTimestamp, formatFeedRelativeTime,
  groupCompletedGoalsByMonth, groupGoalTimelineByDate, INITIAL_BOT_UI_STATE,
  patchBotUi, sortActiveGoals, startInBotNow, useBotController,
} from "../src/builtin-plugins/bot-mode/botStore";
import { coreShellPlugin } from "../src/builtin-plugins/core-shell";
import { registerFrontendServices } from "../src/kernel/services";

const FIXED_FRI_NIGHT = new Date(2026, 10, 27, 21, 21, 0, 0).getTime(); // Fri 2026-11-27 21:21

async function createDiscoveryHarness(
  rpcResponder?: (method: string, params?: Record<string, unknown>) => unknown,
) {
  const root = new Context();
  const registry = new SlotRegistry();
  await root.plugin(ClientSlotsService, registry);
  await registerFrontendServices(root, { shortcutTarget: null });
  const rpcCalls: Array<{ method: string; params: Record<string, unknown> | undefined }> = [];
  const toasts: string[] = [];
  vi.spyOn(root.rpcService, "call").mockImplementation(
    async <T,>(method: string, params?: Record<string, unknown>) => {
      rpcCalls.push({ method, params });
      if (rpcResponder) {
        const custom = rpcResponder(method, params);
        if (custom !== undefined) return custom as T;
      }
      return {} as T;
    },
  );
  vi.spyOn(root.navigationService, "showToast").mockImplementation((msg: string) => {
    toasts.push(msg);
  });
  const shellFiber = await root.plugin(coreShellPlugin);
  const botFiber = await root.plugin(botModePlugin);

  let latestCtrl: ReturnType<typeof useBotController> | null = null;
  function ControllerProbe() {
    latestCtrl = useBotController(root);
    return null;
  }

  return {
    root,
    rpcCalls,
    toasts,
    getController: () => {
      renderToStaticMarkup(createElement(ControllerProbe));
      if (latestCtrl === null) throw new Error("Failed to capture useBotController");
      return latestCtrl;
    },
    renderShellHtml: () => renderToStaticMarkup(createElement(SlotRoot, { registry, ctx: root })),
    dispose: async () => {
      await botFiber.dispose();
      await shellFiber.dispose();
    },
  };
}

describe("V2 Meta Muse Discovery (`动态` / `点子` / `目标`), Resizable Split Chat & Quick Options", () => {
  const cleanups: Array<() => Promise<void>> = [];

  afterEach(async () => {
    vi.restoreAllMocks();
    botUiStore.set(INITIAL_BOT_UI_STATE);
    botDataStore.set(FALLBACK_BOT_SNAPSHOT);
    while (cleanups.length > 0) {
      const fn = cleanups.pop();
      if (fn) await fn();
    }
  });

  it("parses [[options: ...]] bubble quick replies and formats timestamps, editions, and month archives", () => {
    const parsed = extractBotQuickOptions("要不要我帮你查一下那张发票？\n\n[[options: 好，帮我查发票 | 不用，我自己看]]");
    expect(parsed.cleanBody).toBe("要不要我帮你查一下那张发票？");
    expect(parsed.options).toEqual(["好，帮我查发票", "不用，我自己看"]);
    expect(extractBotQuickOptions("正在流式输出\n[[options: 是我").cleanBody).toBe("正在流式输出");
    expect(extractBotQuickOptions("普通回复无按钮")).toEqual({ cleanBody: "普通回复无按钮", options: [] });

    const bubbleHtml = renderToStaticMarkup(
      createElement(BotAssistantBubbleRow, {
        msgId: "m-opt",
        cleanContent: "检测到新登录，是你吗？\n[[options: 是我 | 不是我]]",
        isStreaming: false,
        reacted: false,
        moreOpen: false,
        onToggleReaction: () => undefined,
        onQuote: () => undefined,
        onToggleMore: () => undefined,
        onCloseMore: () => undefined,
        onCopy: () => undefined,
        onBranchSideChat: () => undefined,
        onOpenInWorkbench: () => undefined,
        onSelectQuickOption: () => undefined,
      }),
    );
    expect(bubbleHtml).toContain('data-testid="bot-bubble-option"');
    expect(bubbleHtml).toContain("是我");
    expect(bubbleHtml).toContain("不是我");
    expect(bubbleHtml).not.toContain("[[options:");

    const created23mAgo = FIXED_FRI_NIGHT - 23 * 60_000;
    expect(formatFeedRelativeTime(created23mAgo, "旧标签", FIXED_FRI_NIGHT)).toBe("23分钟前");
    expect(formatFeedExactTimestamp(created23mAgo)).toBe("11月27日星期五 20:58");
    expect(formatFeedEditionLabel("morning")).toBe("早刊");
    expect(formatFeedEditionLabel("evening")).toBe("晚刊");
    expect(formatFeedEditionLabel("adhoc", "硬件快讯")).toBe("硬件快讯");

    const archiveGoals: BotGoalItem[] = [
      {
        id: "cg-oct", title: "RTX Spark 发布会要点早报", category: "兴趣", summary: "已归档",
        status: "completed", updatedAt: new Date(2026, 9, 18, 9, 0).getTime(), completedAt: new Date(2026, 9, 18, 9, 0).getTime(),
      },
      {
        id: "cg-nov", title: "ChatGPT Business 续费席位核对提醒", category: "金融", summary: "已归档",
        status: "completed", updatedAt: new Date(2026, 10, 24, 10, 0).getTime(), completedAt: new Date(2026, 10, 24, 10, 0).getTime(),
      },
    ];
    const monthGroups = groupCompletedGoalsByMonth(archiveGoals);
    expect(monthGroups.map((g) => g.monthLabel)).toEqual(["2026年11月", "2026年10月"]);
    expect(monthGroups[0]?.items[0]?.id).toBe("cg-nov");
  });

  it("wires Resizable Split Main Chat (`打开并排聊天` <-> `最大化` + resizer clamping `340..620px`)", async () => {
    const harness = await createDiscoveryHarness();
    cleanups.push(harness.dispose);
    harness.root.navigationService.setShellMode("bot", { persist: false });

    expect(clampSplitChatWidth(200)).toBe(340);
    expect(clampSplitChatWidth(480)).toBe(480);
    expect(clampSplitChatWidth(900)).toBe(620);

    patchBotUi({ activeView: "feed" });
    const closedHtml = harness.renderShellHtml();
    expect(closedHtml).toContain('data-testid="bot-open-split-chat"');
    expect(closedHtml).not.toContain('data-testid="bot-maximize-discovery"');
    expect(closedHtml).not.toContain('data-testid="bot-split-chat-pane"');

    discussInBot("详细对比华硕与英伟达 GB10 方案差异");
    patchBotUi({ splitChatWidth: 512 });
    expect(botUiStore.get()).toMatchObject({
      activeView: "feed",
      splitChatOpen: true,
      splitChatWidth: 512,
      composerDraft: "详细对比华硕与英伟达 GB10 方案差异",
    });

    const splitHtml = harness.renderShellHtml();
    expect(splitHtml).toContain('data-testid="bot-split-chat-pane"');
    expect(splitHtml).toContain("width:512px");
    expect(splitHtml).toContain('data-testid="bot-split-resizer"');
    expect(splitHtml).toContain('aria-label="调整面板大小"');
    expect(splitHtml).toContain('data-testid="bot-maximize-discovery"');
    expect(splitHtml).toContain('aria-label="最大化"');
    expect(splitHtml).not.toContain('data-testid="bot-topbar-character-badge"');
    expect(splitHtml).toContain("通话");

    patchBotUi({ activeView: "goals", splitChatOpen: false });
    startInBotNow("我想设定一个健康目标");
    expect(botUiStore.get()).toMatchObject({
      activeView: "goals",
      splitChatOpen: true,
      pendingAutoSendPrompt: "我想设定一个健康目标",
    });

    patchBotUi({ splitChatWidth: 999 });
    expect(botUiStore.get().splitChatWidth).toBe(620);

    expect(
      resolvePendingAutoSend({
        pendingPrompt: "自动发送指令",
        canAttach: true,
        hasHandle: true,
        handlePhase: "ready",
        isStreaming: false,
        desiredProvider: "deepseek",
        desiredModelId: "deepseek-chat",
      }),
    ).toBe("send");
  });

  it("renders Feed V2 inline Markdown links, standalone `为何我创建这篇帖子` dialog, sandboxed HTML widget, and Lightbox", async () => {
    const harness = await createDiscoveryHarness();
    cleanups.push(harness.dispose);
    const ctrl = harness.getController();

    patchBotUi({ activeView: "feed" });
    const emptyFeedHtml = renderToStaticMarkup(createElement(BotFeedView, { ctx: harness.root }));
    expect(emptyFeedHtml).toContain("还没有主动动态简报");
    expect(emptyFeedHtml).toContain("生成今日专属动态刊");

    await ctrl.generateFeedEdition("morning");
    expect(harness.rpcCalls.some((c) => c.method === "bot.feed.generateEdition")).toBe(true);

    const lightSrcDoc = buildFeedWidgetSrcDoc("<div>Widget<script>evil()</script></div>", "light");
    const darkSrcDoc = buildFeedWidgetSrcDoc("<div>Widget</div>", "dark");
    expect(lightSrcDoc).toContain("--hatch-widget-surface: #ffffff;");
    expect(lightSrcDoc).not.toContain("<script>");
    expect(darkSrcDoc).toContain("--hatch-widget-surface: #222428;");

    const sampleFeed: BotFeedItem[] = [
      {
        id: "f-qwen", icon: "cpu", title: "Qwen3.5 27B 自己改权重后更准了", editionKind: "morning",
        timeLabel: "27分钟前",
        body: "[27B 的 Qwen3.5](https://example.com/qwen)自己改了权重，在没见过的问题上高了 6.6 分。",
        actionLabel: "讨论", actionKind: "discuss", seedPrompt: "聊聊 Qwen3.5 自改权重机制",
        createdAt: FIXED_FRI_NIGHT - 27 * 60_000,
        reason: "你在本地跑模型时一直看重尺寸和实际效果，这个自己改权重的路子正好落在那条线上。",
        attachment: { kind: "hero_image", heroImageUrl: "https://example.com/qwen-cover.jpg", imageAlt: "Qwen3.5 论文封面", aspectRatio: 1.78 },
      },
      {
        id: "f-widget", icon: "laptop", title: "同款 GB10 芯片，华硕版比英伟达便宜约 1,000 美元",
        origin: "idea", actionLabel: "立即开始", actionKind: "start", timeLabel: "2小时前",
        body: "[华硕 Ascent GX10](https://example.com/gx10)用同一颗 GB10 芯片标价 $5,849.99。",
        seedPrompt: "对比三款 GB10 工作站配置", createdAt: FIXED_FRI_NIGHT - 2 * 3_600_000,
        attachment: { kind: "widget", widgetTitle: "同款 GB10 · 128GB", widgetHtml: '<div class="gb10-table">华硕 Ascent GX10 · $5,849.99</div>' },
      },
    ];
    botDataStore.set((prev) => ({ ...prev, feed: sampleFeed }));

    const feedHtml = renderToStaticMarkup(
      createElement(BotFeedView, {
        ctx: harness.root,
        initialWhyItemId: "f-qwen",
        initialInstructionsOpen: true,
        initialLightbox: { images: [{ url: "https://example.com/qwen-cover.jpg", alt: "Qwen3.5 论文封面" }], index: 0 },
      }),
    );
    expect(feedHtml).toContain("早刊");
    expect(feedHtml).toContain('href="https://example.com/qwen"');
    expect(feedHtml).toContain("27B 的 Qwen3.5");
    expect(feedHtml).toContain('data-testid="feed-hero-f-qwen"');
    expect(feedHtml).toContain('data-testid="feed-html-widget"');
    expect(feedHtml).toContain('sandbox=""');
    expect(feedHtml).toContain('data-testid="feed-why-dialog"');
    expect(feedHtml).toContain('aria-label="为何我创建这篇帖子"');
    expect(feedHtml).toContain("你在本地跑模型时一直看重尺寸和实际效果");
    expect(feedHtml).toContain('data-testid="feed-image-lightbox"');
    expect(feedHtml).toContain('aria-label="全屏查看图片"');
    expect(feedHtml).toContain('aria-label="动态版块说明"');
  });

  it("opens `<BotIdeaDetailModal>` (`包含哪些内容` + `如何运作` + `bot.ideas.launch`) and restores dismissed ideas via Undo", async () => {
    const harness = await createDiscoveryHarness((method) => {
      if (method === "bot.ideas.launch") {
        return {
          ok: true,
          idea: null,
          launchPrompt: "已装配个人千机面板空间与早间定时任务，请汇报初始化结果。",
          snapshot: botDataStore.get(),
        };
      }
      return undefined;
    });
    cleanups.push(harness.dispose);
    const ctrl = harness.getController();

    patchBotUi({ activeView: "ideas", activeIdeaId: "idea-space-board" });
    const ideasHtml = renderToStaticMarkup(
      createElement(BotIdeasView, { ctx: harness.root, initialOpenMenuId: "idea-health-check" }),
    );
    expect(ideasHtml).toContain("空间 + 定期任务");
    expect(ideasHtml).toContain('data-testid="idea-detail-modal"');
    expect(ideasHtml).toContain("包含哪些内容");
    expect(ideasHtml).toContain("如何运作");
    expect(ideasHtml).toContain('data-testid="idea-cap-ready-icon"');
    expect(ideasHtml).toContain('data-testid="idea-modal-more-btn"');
    expect(ideasHtml).toContain('data-testid="idea-modal-launch-btn"');
    expect(/<button\b[^>]*>(?:(?!<\/button>)[\s\S])*<button\b/i.test(ideasHtml)).toBe(false);

    const modalMenuHtml = renderToStaticMarkup(
      createElement(BotIdeaDetailModal, { ctx: harness.root, initialMoreOpen: true }),
    );
    expect(modalMenuHtml).toContain("更多类似内容");
    expect(modalMenuHtml).toContain("不感兴趣");

    await ctrl.launchIdea("idea-space-board");
    expect(harness.rpcCalls.some((c) => c.method === "bot.ideas.launch")).toBe(true);
    expect(botUiStore.get()).toMatchObject({
      activeIdeaId: null,
      splitChatOpen: true,
      pendingAutoSendPrompt: "已装配个人千机面板空间与早间定时任务，请汇报初始化结果。",
    });

    await ctrl.feedbackIdea("idea-cost-plan", "not_interested");
    expect(botUiStore.get().lastDismissedIdea?.id).toBe("idea-cost-plan");
    const undoHtml = renderToStaticMarkup(createElement(BotIdeasView, { ctx: harness.root }));
    expect(undoHtml).toContain('data-testid="idea-undo-banner"');
    expect(undoHtml).toContain("已隐藏该点子");
    expect(undoHtml).toContain('data-testid="idea-undo-btn"');

    await ctrl.restoreIdea("idea-cost-plan");
    expect(harness.rpcCalls.some((c) => c.method === "bot.ideas.restore")).toBe(true);
    expect(botUiStore.get().lastDismissedIdea).toBeNull();
    expect(botDataStore.get().ideaSections.flatMap((s) => s.items).some((it) => it.id === "idea-cost-plan")).toBe(true);
  });

  it("renders Goals V2 Chat-First Co-Planning Dialog, secondary quick entry, Detail Timeline, and Month-Grouped Completed Archive", async () => {
    const harness = await createDiscoveryHarness();
    cleanups.push(harness.dispose);
    const ctrl = harness.getController();

    const created = await ctrl.createGoal("ChatGPT Business 续费扣款失败", "金融", {
      summary: "已准备好发票核对清单，等确认登录即可核对 11 月 24 日发票",
      subGoals: ["核对 11 月发票", "更新备用付款方式"],
    });
    const goalId = created?.id ?? "";

    botDataStore.set((prev) => ({
      ...prev,
      goals: [
        ...prev.goals,
        {
          id: "done-nov", title: "Google 家人群组问题提醒", category: "人际关系", summary: "已闭环",
          status: "completed", updatedAt: new Date(2026, 10, 20, 12, 0).getTime(), completedAt: new Date(2026, 10, 20, 12, 0).getTime(),
        },
        {
          id: "done-oct", title: "RTX Spark 发布会要点早报", category: "兴趣", summary: "已闭环",
          status: "completed", updatedAt: new Date(2026, 9, 15, 9, 0).getTime(), completedAt: new Date(2026, 9, 15, 9, 0).getTime(),
        },
      ],
    }));

    expect(sortActiveGoals(botDataStore.get().goals, false).map((g) => g.id)).toEqual([goalId]);
    const activeFirst = botDataStore.get().goals[0];
    expect(activeFirst).toBeDefined();
    if (activeFirst) {
      expect(groupGoalTimelineByDate(activeFirst, FIXED_FRI_NIGHT)[0]?.items).toBeDefined();
    }

    const interviewHtml = renderToStaticMarkup(
      createElement(BotGoalsView, { ctx: harness.root, initialSelectedCat: "健康", initialDirectInputOpen: true }),
    );
    expect(interviewHtml).toContain('data-testid="goal-interview-dialog"');
    expect(interviewHtml).toContain('aria-label="创建健康目标"');
    expect(interviewHtml).toContain("首先，我们将在聊天中一起完善目标。");
    expect(interviewHtml).toContain('data-testid="goal-interview-start-btn"');
    expect(interviewHtml).toContain('data-testid="goal-direct-toggle-btn"');
    expect(interviewHtml).toContain("已知明确目标？直接快速录入");
    expect(interviewHtml).toContain('data-testid="goal-create-input"');
    expect(interviewHtml).toContain('data-testid="goal-create-submit-btn"');

    const otherCatHtml = renderToStaticMarkup(createElement(BotGoalsView, { ctx: harness.root, initialSelectedCat: "其他" }));
    expect(otherCatHtml).toContain('aria-label="创建新目标"');

    patchBotUi({ activeGoalId: goalId });
    await ctrl.updateGoal({ id: goalId, addSubGoal: "确认退款周期" });
    const detailHtml = renderToStaticMarkup(createElement(BotGoalDetailModal, { ctx: harness.root }));
    expect(detailHtml).toContain('aria-label="目标详情"');
    expect(detailHtml).toContain("0/3");
    expect(detailHtml).toContain("确认退款周期");
    expect(detailHtml).toContain("TODAY");

    patchBotUi({ activeGoalId: null });
    const completedHtml = renderToStaticMarkup(
      createElement(BotGoalsView, {
        ctx: harness.root,
        initialCompletedModalOpen: true,
        initialOpenCompletedMenuId: "done-nov",
      }),
    );
    expect(completedHtml).toContain('data-testid="completed-goals-modal"');
    expect(completedHtml).toContain("2026年11月");
    expect(completedHtml).toContain("2026年10月");
    expect(completedHtml).toContain("Google 家人群组问题提醒");
    expect(completedHtml).toContain("RTX Spark 发布会要点早报");
    expect(completedHtml).toContain("重新激活");
    expect(completedHtml).toContain("查看详情");
    expect(completedHtml).toContain("删除");
  });
});

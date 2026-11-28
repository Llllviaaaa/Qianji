/**
 * End-to-end regression suite for the 3 Bot Mode upgrades:
 * 1. Muse-grade right-sidebar historical task summary (0-tool Q&A filtering,
 *    Markdown/apology stripping, dynamic `今天`/`昨天`/`M月D日` date buckets,
 *    same-turn Goal/Space side-effect consolidation, quiet patrol deduplication,
 *    and 3-tier `BotActivityDetailModal` with formatted Markdown `finishMessage`).
 * 2. Native Bot Model & Provider Settings (`模型与密钥` tab mounting `host.settings.providers`
 *    in-place, zero jump to Agent settings, and `null` clearing of `modelConfig.primary`).
 * 3. First-class Host + Client Plugin Connectors (`ctx.connectors.register`, custom `icon` /
 *    `authMode: "browser"`, Composer `+` `@App` menu, Settings badge/breadcrumb, Permissions
 *    tab, and `bot.connector.sections` client slot).
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Context } from "@deepseek-ai/cordis";
import { afterEach, describe, expect, it } from "vitest";
import { AgentLoop } from "@qianji/agent-loop";
import { ClientSlotsService, SlotRegistry, SlotRoot } from "@qianji/client-slots";
import { Credentials, LlmService, type LlmRequest, type StreamChunk } from "@qianji/llm";
import type { BotActivityGroup, BotPluginConnectorCatalogItem } from "@qianji/protocol";
import { Sessions } from "@qianji/session";
import { SystemPrompt } from "@qianji/system-prompt";
import { Tools, textOutput } from "@qianji/tools";
import { Ui } from "@qianji/ui";
import { BotCompanionHarness, BotStateStore } from "../packages/host/src/bot/index";
import { createBotHarnessHost } from "../packages/host/src/bot/harness/bot-tools-host";
import {
  formatActivityDateBucket,
  regroupAndSanitizeActivities,
  stripMarkdownFormatting,
} from "../packages/host/src/bot/store-activity-helpers";
import { HostConnectorsService } from "../packages/host/src/plugin-connectors";
import { parseManifestConnectors } from "../packages/host/src/plugin-scopes";
import { botModePlugin } from "../src/builtin-plugins/bot-mode";
import {
  botDataStore,
  botUiStore,
  FALLBACK_BOT_SNAPSHOT,
  INITIAL_BOT_UI_STATE,
  openBotActivityDetail,
  openBotConnector,
  openBotModal,
  patchBotUi,
} from "../src/builtin-plugins/bot-mode/botStore";
import { coreShellPlugin } from "../src/builtin-plugins/core-shell";
import { registerHostComponentFactories } from "../src/kernel/primitives/hostComponentFactories";
import { registerFrontendServices } from "../src/kernel/services";

function textChunks(text: string): StreamChunk[] {
  return [
    { type: "text-delta", index: 0, text },
    { type: "usage", usage: { inputTokens: 12, outputTokens: 18 } },
    { type: "finish", reason: "stop" },
  ];
}

function toolCallChunks(id: string, name: string, args: Record<string, unknown>): StreamChunk[] {
  return [
    { type: "tool-call-start", index: 0, id, name },
    { type: "tool-call-delta", index: 0, argumentsDelta: JSON.stringify(args) },
    { type: "usage", usage: { inputTokens: 14, outputTokens: 16 } },
    { type: "finish", reason: "tool-use" },
  ];
}

describe("Bot Mode Muse Task Summary, Native Model Settings & Plugin Connectors", () => {
  const cleanups: Array<() => Promise<void> | void> = [];

  afterEach(async () => {
    botUiStore.set(INITIAL_BOT_UI_STATE);
    botDataStore.set(FALLBACK_BOT_SNAPSHOT);
    while (cleanups.length > 0) {
      const fn = cleanups.pop();
      if (fn) await fn();
    }
  });

  it("strips Markdown/apologies, buckets dates dynamically, deduplicates quiet patrols, and merges same-minute Goal/Space orphans", () => {
    const cleaned = stripMarkdownFormatting(
      "是我理解错了，抱歉。**DeepSeek-V4.1-Flash-1017** 是官方在线版本，调用名写 `deepseek-flash`，详见 [官方定价页](https://api-docs.deepseek.com)。\n| 闲时 | $0.003 |\n| --- | --- |\n[[options: 立即切换 | 稍后再看]]",
    );
    expect(cleaned).not.toContain("**");
    expect(cleaned).not.toContain("`");
    expect(cleaned).not.toContain("是我理解错了");
    expect(cleaned).not.toContain("[[options:");
    expect(cleaned).toContain("DeepSeek-V4.1-Flash-1017");
    expect(cleaned).toContain("官方定价页");

    const now = new Date(2026, 10, 28, 14, 0, 0).getTime(); // Nov 28, 2026
    const yesterday = new Date(2026, 10, 27, 21, 30, 0).getTime();
    const olderSameYear = new Date(2026, 10, 20, 9, 15, 0).getTime();
    expect(formatActivityDateBucket(now - 3600_000, now)).toBe("今天");
    expect(formatActivityDateBucket(yesterday, now)).toBe("昨天");
    expect(formatActivityDateBucket(olderSameYear, now)).toBe("11月20日");

    const legacyGroups: BotActivityGroup[] = [
      {
        date: "今天",
        items: [
          {
            id: "act-qa-noise",
            dateGroup: "今天",
            title: "我说的是deepseek v4.1 fla…",
            description: "是我理解错了，抱歉。**DeepSeek-V4.1-Flash-1017**…",
            timeLabel: "10:04",
            createdAt: now - 60_000,
            sessionId: "sess-main",
            turnStartSeq: 12,
            kind: "chat",
          },
          {
            id: "act-quiet-2",
            dateGroup: "今天",
            title: "专注期静默收纳巡检动态",
            description: "已是深夜时段",
            timeLabel: "02:30",
            createdAt: now - 300_000,
          },
          {
            id: "act-quiet-1",
            dateGroup: "今天",
            title: "专注期静默收纳巡检动态",
            description: "已是深夜时段",
            timeLabel: "02:00",
            createdAt: now - 600_000,
          },
          {
            id: "act-space-orphan",
            dateGroup: "今天",
            title: "创建常驻空间：千机 Bot 环境配置",
            description: "追踪共享目录配置",
            timeLabel: "09:59",
            createdAt: yesterday + 2000,
          },
          {
            id: "act-goal-orphan",
            dateGroup: "今天",
            title: "设定长期目标：修复共享目录双副本生成",
            description: "效率提升",
            timeLabel: "09:59",
            createdAt: yesterday + 1000,
          },
          {
            id: "act-parent-turn",
            dateGroup: "今天",
            title: "排查共享目录两份副本",
            description: "复查 `/workspace` 与 `/shared` 挂载，**未见重复副本**。",
            timeLabel: "09:59",
            createdAt: yesterday,
            sessionId: "sess-main",
            turnStartSeq: 4,
            kind: "chat",
          },
        ],
      },
    ];

    const sanitized = regroupAndSanitizeActivities(legacyGroups, now);
    expect(sanitized.map((g) => g.date)).toEqual(["今天", "昨天"]);

    const todayItems = sanitized.find((g) => g.date === "今天")?.items ?? [];
    expect(todayItems.some((i) => i.id === "act-qa-noise")).toBe(false);
    expect(todayItems.filter((i) => i.title === "专注期静默收纳巡检动态")).toHaveLength(1);

    const yesterdayItems = sanitized.find((g) => g.date === "昨天")?.items ?? [];
    expect(yesterdayItems).toHaveLength(1);
    expect(yesterdayItems[0]?.id).toBe("act-parent-turn");
    expect(yesterdayItems[0]?.description).not.toContain("**");
    expect(yesterdayItems[0]?.description).not.toContain("`");
    expect(yesterdayItems[0]?.steps?.map((s) => s.iconKind)).toEqual(["space", "goal"]);
  });

  it("skips 0-tool Q&A in activityGroups, consolidates reflection Goal+Space onto tool turns, and clears primary model via null", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "qj-bot-muse-e2e-"));
    const ctx = new Context();
    cleanups.push(async () => {
      await ctx.fiber.dispose();
      rmSync(dataDir, { recursive: true, force: true });
    });

    const defaultModel = { provider: "mock", model: "default-v1" };
    const overrideModel = { provider: "mock", model: "custom-pro-v2" };
    await ctx.plugin(Credentials);
    await ctx.plugin(LlmService, { maxAttempts: 1 });
    await ctx.plugin(Sessions);
    await ctx.plugin(Ui);
    await ctx.plugin(Tools);
    await ctx.plugin(SystemPrompt);
    await ctx.plugin(AgentLoop);

    ctx.llm.registerAdapter(
      { id: "mock", name: "Mock LLM", api: "mock", baseUrl: "http://mock.local" },
      {
        async *stream(req: LlmRequest): AsyncIterable<StreamChunk> {
          if (req.sessionId?.endsWith(":reflect")) {
            const promptText = req.messages[0]?.content
              .flatMap((b) => (b.type === "text" ? [b.text] : []))
              .join("\n") ?? "";
            if (promptText.includes("本轮调用工具：（无）")) {
              for (const c of textChunks(
                JSON.stringify({
                  taskTitle: "解答 DeepSeek 定价",
                  taskSummary: "给出了闲时与高峰 API 单价对比。",
                  sideChatTitle: "DeepSeek 定价咨询",
                  preferences: [],
                  goals: [],
                  ideas: [],
                  space: null,
                }),
              )) {
                yield c;
              }
              return;
            }
            for (const c of textChunks(
              JSON.stringify({
                taskTitle: "排查挂载目录双副本问题",
                taskSummary: "检查挂载点确认无重复生成，等待你提供报错路径。",
                sideChatTitle: null,
                preferences: [],
                goals: [
                  {
                    title: "根治共享目录双副本",
                    category: "效率提升",
                    summary: "等待确认具体重复文件路径",
                    momentumStatus: "waiting_user",
                  },
                ],
                ideas: [],
                space: { title: "Bot 容器挂载排查", description: "记录目录映射与排查日志" },
              }),
            )) {
              yield c;
            }
            return;
          }

          const lastMsg = req.messages.at(-1);
          const userTxt =
            lastMsg?.role === "user"
              ? lastMsg.content.flatMap((b) => (b.type === "text" ? [b.text] : [])).join("\n")
              : "";
          if (userTxt.includes("排查共享目录")) {
            for (const c of toolCallChunks("tc-ls-1", "bash", { command: "ls -la /workspace" })) yield c;
            return;
          }
          for (const c of textChunks(
            "是我理解错了，抱歉。已完成 `/workspace` 目录检查，**未发现重复副本**。\n\n[[options: 发送具体路径 | 稍后处理]]",
          )) {
            yield c;
          }
        },
      },
    );

    ctx.tools.register({
      name: "bash",
      description: "Run bash",
      parameters: { type: "object", properties: { command: { type: "string" } }, required: ["command"] },
      execute: async () => textOutput("total 4\ndrwxr-xr-x 2 root root 4096 workspace"),
    });

    const store = new BotStateStore(
      ctx.sessions,
      { dataDir, distroName: "qianji-bot-unit-noop", displayName: "千机", defaultModel: () => defaultModel },
      ctx.credentials,
    );
    const hostBridge = createBotHarnessHost(store, () => undefined);
    const harness = new BotCompanionHarness(ctx, hostBridge);

    // 1. Test explicit primary model override -> clear back to defaultModel via `primary: null`
    await store.configureProactive({ modelConfig: { primary: overrideModel } });
    const snapOverride = await store.snapshot();
    expect(snapOverride.modelConfig.primary).toEqual(overrideModel);
    const mainSess = await ctx.sessions.get(snapOverride.mainSessionId);
    expect(mainSess?.state().model).toEqual(overrideModel);

    const snapCleared = await store.configureProactive({ modelConfig: { primary: null } });
    expect(snapCleared.modelConfig.primary).toBeUndefined();
    expect(mainSess?.state().model).toEqual(defaultModel);

    if (!mainSess) return;

    // 2. Pure 0-tool Q&A turn on main chat -> MUST NOT create an activity card!
    harness.prompt(mainSess, [{ type: "text", text: "我说的是 deepseek v4.1 flash 1017 的价格" }]);
    await harness.idle(mainSess.id);
    await new Promise((r) => setTimeout(r, 80));
    expect((await store.snapshot()).activityGroups).toHaveLength(0);

    // 3. Tool-backed turn with reflection creating Goal + Space -> ONE consolidated activity card with child steps!
    harness.prompt(mainSess, [{ type: "text", text: "请帮我排查共享目录为什么有两份副本" }]);
    await harness.idle(mainSess.id);

    await expect.poll(async () => (await store.snapshot()).goals.length).toBe(1);
    const snapAfterTool = await store.snapshot();
    const allActivities = snapAfterTool.activityGroups.flatMap((g) => g.items);
    expect(allActivities).toHaveLength(1);
    expect(allActivities[0]?.title).toBe("排查挂载目录双副本问题");
    expect(allActivities[0]?.statusTitle).toBe("等待确认");
    expect(allActivities[0]?.description).not.toContain("**");
    expect(allActivities[0]?.finishMessage).toContain("**未发现重复副本**");

    const trace = await store.getActivityTrace({ activityId: allActivities[0]?.id });
    const middleSteps = trace.steps.filter((s) => s.kind === "tool");
    expect(middleSteps.map((s) => s.toolName)).toEqual([
      "bash",
      "bot_manage_goal",
      "bot_manage_space",
    ]);
    expect(middleSteps[1]?.groupLabel).toBe("自动沉淀与跟进");
  });

  it("mounts native Bot Models tab (zero jump to Agent providers), surfaces plugin connectors everywhere, and renders client connector slots", async () => {
    const root = new Context();
    const registry = new SlotRegistry();
    await root.plugin(ClientSlotsService, registry);
    await registerFrontendServices(root, { shortcutTarget: null });
    const disposeHostFactories = registerHostComponentFactories(root.slots);
    const shellFiber = await root.plugin(coreShellPlugin);
    const botFiber = await root.plugin(botModePlugin);

    // Register a dynamic Client plugin slot section for a custom plugin connector `feishu_wiki`
    const disposeCustomSlot = root.slots.register("bot.connector.sections", {
      id: "ext-feishu:connector-panel",
      pluginId: "ext-feishu",
      tier: "user",
      key: "feishu_wiki",
      component: ({ connectorId, connected }) =>
        createElement(
          "div",
          { "data-testid": "custom-plugin-connector-slot" },
          `飞书知识库自定义面板 (${connectorId}:${connected ? "online" : "offline"})`,
        ),
    });

    cleanups.push(async () => {
      disposeCustomSlot();
      disposeHostFactories();
      await botFiber.dispose();
      await shellFiber.dispose();
    });

    // Verify Host connector manifest & runtime registration preserve icon, iconBg, authMode, and browserAuthUrl
    const parsedManifest = parseManifestConnectors(
      [
        {
          id: "feishu_wiki",
          name: "飞书企业知识库",
          tagline: "检索飞书文档与多维表格并生成周报",
          category: "office",
          icon: "📘",
          iconBg: "#EFF6FF",
          authMode: "browser",
          browserAuthUrl: "https://www.feishu.cn/",
          featured: true,
        },
      ],
      "飞书插件团队",
    );
    expect(parsedManifest?.[0]?.icon).toBe("📘");
    expect(parsedManifest?.[0]?.authMode).toBe("browser");
    expect(parsedManifest?.[0]?.browserAuthUrl).toBe("https://www.feishu.cn/");

    const hostConnCtx = new Context();
    await hostConnCtx.plugin(HostConnectorsService);
    let changeFired = 0;
    hostConnCtx.connectors.onChange(() => {
      changeFired += 1;
    });
    const disposeHostConn = hostConnCtx.connectors.register({
      id: "feishu_wiki",
      name: "飞书企业知识库",
      icon: "📘",
      authMode: "browser",
      browserAuthUrl: "https://www.feishu.cn/",
    });
    expect(changeFired).toBe(1);
    const firstStored = hostConnCtx.connectors.list()[0];
    expect(firstStored).toBeDefined();
    if (firstStored) {
      expect(hostConnCtx.connectors.toManifest(firstStored, "ext").icon).toBe("📘");
    }
    disposeHostConn();
    await hostConnCtx.fiber.dispose();

    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const renderHtml = () =>
      renderToStaticMarkup(
        createElement(
          QueryClientProvider,
          { client: queryClient },
          createElement(SlotRoot, { registry, ctx: root }),
        ),
      );
    root.navigationService.setShellMode("bot", { persist: false });

    // 1. Native Bot Models & Providers tab renders `host.settings.providers` inside Bot Settings without opening Host Settings
    openBotModal("settings", "models");
    const modelsTabHtml = renderHtml();
    expect(modelsTabHtml).toContain('data-testid="bot-models-settings-pane"');
    expect(modelsTabHtml).toContain('data-testid="bot-primary-model-select"');
    expect(modelsTabHtml).toContain('data-testid="bot-patrol-model-select"');
    expect(modelsTabHtml).toContain('data-testid="bot-embedded-providers-host"');
    expect(root.navigationService.getSnapshot().settingsOpen).toBe(false);

    // 2. Inject plugin connector into reactive Bot state and verify ALL Bot surfaces
    const firstConnectorManifest = parsedManifest?.[0];
    expect(firstConnectorManifest).toBeDefined();
    if (!firstConnectorManifest) return;
    const mockPluginItem: BotPluginConnectorCatalogItem = {
      pluginId: "ext-feishu",
      pluginName: "飞书扩展插件",
      pluginEnabled: true,
      pluginBotEnabled: true,
      connector: firstConnectorManifest,
      tools: [{ name: "feishu_search_docs", rawName: "feishu_search_docs", description: "搜索飞书知识库", readOnly: true }],
    };
    botDataStore.set((prev) => ({
      ...prev,
      connectorConfigs: {
        ...prev.connectorConfigs,
        appPolicies: {
          feishu_wiki: {
            connected: true,
            authKind: "browser",
            accountLabel: "team@feishu.cn",
            policy: "read-only-auto",
          },
        },
      },
      activityGroups: [
        {
          date: "今天",
          items: [
            {
              id: "act-trace-1",
              dateGroup: "今天",
              title: "检索飞书周报规范",
              subtitle: "已提取 3 条周报模板要点，等待确认采用版本",
              description: "已提取 3 条周报模板要点，等待确认采用版本",
              statusTitle: "等待确认",
              finishMessage: "### 提炼结论\n\n- **模板 A**：适合研发迭代\n- **模板 B**：适合跨部门同步",
              timeLabel: "10:15",
              createdAt: Date.now(),
              kind: "browser",
              status: "completed",
            },
          ],
        },
      ],
    }));
    patchBotUi({ pluginConnectors: [mockPluginItem] });

    // Connectors directory + Settings rail badge
    openBotModal("settings", "connectors");
    const dirHtml = renderHtml();
    expect(dirHtml).toContain("飞书企业知识库");
    expect(dirHtml).toContain("📘");

    // Browser isolation tab & Permissions tab both include the plugin connector
    openBotModal("settings", "browser");
    expect(renderHtml()).toContain("飞书企业知识库");
    openBotModal("settings", "permissions");
    const permHtml = renderHtml();
    expect(permHtml).toContain("飞书企业知识库");
    expect(permHtml).toContain("team@feishu.cn");

    // Connector detail view renders breadcrumb + custom client slot `bot.connector.sections`
    openBotConnector("feishu_wiki");
    const detailHtml = renderHtml();
    expect(detailHtml).toContain("飞书企业知识库");
    expect(detailHtml).toContain('data-testid="custom-plugin-connector-slot"');
    expect(detailHtml).toContain("飞书知识库自定义面板 (feishu_wiki:online)");

    // Chat view topbar model button & `@飞书企业知识库` composer chip + Muse activity detail modal
    patchBotUi({ modal: null, activeView: "chat", composerApps: ["feishu_wiki"] });
    const chatHtml = renderHtml();
    expect(chatHtml).toContain('data-testid="bot-topbar-model-btn"');
    expect(chatHtml).toContain("@飞书企业知识库");
    expect(chatHtml).toContain("等待确认 · 10:15");

    const firstAct = botDataStore.get().activityGroups[0]?.items[0];
    expect(firstAct).toBeDefined();
    if (firstAct) openBotActivityDetail(firstAct);
    const traceHtml = renderHtml();
    expect(traceHtml).toContain('data-testid="bot-activity-detail-modal"');
    expect(traceHtml).toContain("等待确认");
    expect(traceHtml).toContain("已提取 3 条周报模板要点，等待确认采用版本");
    expect(traceHtml).toContain("提炼结论");
    expect(traceHtml).not.toContain("qianji-bot run");
  });
});

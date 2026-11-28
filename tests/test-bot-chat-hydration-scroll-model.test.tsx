/**
 * Regression tests for the 3 real-world Bot Mode chat lifecycle fixes:
 * 1. Cold-start history hydration when `SessionService.retain()` is first acquired
 *    with `autoStart: false` and then retained with `autoStart: true` (plus pre-ready
 *    `setModel` preservation instead of overwriting with stale session model).
 * 2. Authoritative Bot model routing (`BotCompanionHarness` + `BotStateStore.resolvePrimaryModel`
 *    + `<active_model>` anti-poisoning prompt block) so switching to Grok never calls
 *    a stale `deepseek-v4` model or hallucinates old model identity from prior turns.
 * 3. `resolveEffectiveBotModel` priority order, inline Topbar quick model switcher,
 *    and `hideDefaultPreferences` in `BotModelsSettingsPane`.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Context } from "@deepseek-ai/cordis";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ClientSlotsService, SlotRegistry, SlotRoot } from "@qianji/client-slots";
import { Credentials, LlmService, type LlmRequest, type StreamChunk } from "@qianji/llm";
import { Sessions } from "@qianji/session";
import { SystemPrompt } from "@qianji/system-prompt";
import { Tools } from "@qianji/tools";
import { Ui } from "@qianji/ui";
import { BotCompanionHarness, BotStateStore } from "../packages/host/src/bot/index";
import { createBotHarnessHost } from "../packages/host/src/bot/harness/bot-tools-host";
import { botModePlugin } from "../src/builtin-plugins/bot-mode";
import { BotChatFloatingTopbar } from "../src/builtin-plugins/bot-mode/BotChatThreadWidgets";
import {
  botDataStore,
  botUiStore,
  FALLBACK_BOT_SNAPSHOT,
  INITIAL_BOT_UI_STATE,
  openBotModal,
} from "../src/builtin-plugins/bot-mode/botStore";
import { resolveEffectiveBotModel } from "../src/builtin-plugins/bot-mode/useBotChatScroll";
import { coreShellPlugin } from "../src/builtin-plugins/core-shell";
import { registerHostComponentFactories } from "../src/kernel/primitives/hostComponentFactories";
import { registerFrontendServices } from "../src/kernel/services";
import { harnessRuntimes } from "../src/lib/harnessRuntime";

function textChunks(text: string): StreamChunk[] {
  return [
    { type: "text-delta", index: 0, text },
    { type: "usage", usage: { inputTokens: 10, outputTokens: 12 } },
    { type: "finish", reason: "stop" },
  ];
}

describe("Bot Chat History Hydration, Model Routing Single Source of Truth & Topbar Switcher", () => {
  const cleanups: Array<() => Promise<void> | void> = [];

  afterEach(async () => {
    vi.restoreAllMocks();
    botUiStore.set(INITIAL_BOT_UI_STATE);
    botDataStore.set(FALLBACK_BOT_SNAPSHOT);
    while (cleanups.length > 0) {
      const fn = cleanups.pop();
      if (fn) await fn();
    }
  });

  it("activates pooled SessionHandle when second retainer passes autoStart:true and preserves pre-ready setModel(Grok) over stale Host model", async () => {
    const startSpy = vi.spyOn(harnessRuntimes, "start").mockResolvedValue({
      runtimeId: "harness:rt-bot-main",
      sessionLoaded: true,
      sessionForked: false,
    });
    vi.spyOn(harnessRuntimes, "state").mockResolvedValue({
      sessionId: "sess-bot-main",
      sessionFile: "harness:sess-bot-main",
      isStreaming: false,
      isCompacting: false,
      thinkingLevel: "off",
      // Simulate stale DeepSeek model persisted in older session JSONL
      model: { id: "deepseek-v4-flash", name: "DeepSeek V4 Flash", provider: "deepseek" },
    });
    vi.spyOn(harnessRuntimes, "models").mockResolvedValue([
      { id: "deepseek-v4-flash", name: "DeepSeek V4 Flash", provider: "deepseek" },
      { id: "grok-4.7", name: "Grok 4.7", provider: "xai" },
    ]);
    vi.spyOn(harnessRuntimes, "commands").mockResolvedValue([]);
    vi.spyOn(harnessRuntimes, "messages").mockResolvedValue([
      { id: "m-1", role: "user", content: "之前的历史提问", timestamp: 1000 },
      { id: "m-2", role: "assistant", content: "之前的历史回复", model: "deepseek-v4-flash", timestamp: 1005 },
    ]);
    const setModelSpy = vi.spyOn(harnessRuntimes, "setModel").mockImplementation(async (_rid, provider, id) => ({
      id,
      name: id === "grok-4.7" ? "Grok 4.7" : id,
      provider,
    }));
    vi.spyOn(harnessRuntimes, "setPermission").mockResolvedValue(undefined);
    vi.spyOn(harnessRuntimes, "stop").mockResolvedValue(undefined);

    const root = new Context();
    await registerFrontendServices(root, { shortcutTarget: null });
    cleanups.push(() => root.fiber.dispose());

    // 1. First retainer (e.g. companion panel) retains with autoStart: false
    const passiveHandle = root.sessionService.retain("harness:sess-bot-main", {
      isolated: false,
      autoStart: false,
      cwd: "D:/bot-ws",
    });
    expect(startSpy).not.toHaveBeenCalled();
    expect(passiveHandle.getSnapshot().messages).toHaveLength(0);

    // Caller sets Grok BEFORE runtime finishes starting
    void passiveHandle.setModel({ id: "grok-4.7", name: "Grok 4.7", provider: "xai" });

    // 2. Second retainer (`BotChatColumn`) retains same pool key with autoStart: true
    const chatHandle = root.sessionService.retain("harness:sess-bot-main", {
      isolated: false,
      autoStart: true,
      cwd: "D:/bot-ws",
    });

    await vi.waitFor(() => {
      expect(chatHandle.getSnapshot().phase).toBe("ready");
    });

    // History hydrated immediately on open without needing sendMessage!
    expect(startSpy).toHaveBeenCalledTimes(1);
    expect(chatHandle.getSnapshot().messages).toHaveLength(2);
    expect(chatHandle.getSnapshot().messages[0]?.content).toBe("之前的历史提问");

    // Pre-ready Grok choice overrode stale DeepSeek V4 on Host!
    expect(setModelSpy).toHaveBeenCalledWith("harness:rt-bot-main", "xai", "grok-4.7");
    expect(chatHandle.getSnapshot().model?.provider).toBe("xai");
    expect(chatHandle.getSnapshot().model?.id).toBe("grok-4.7");

    passiveHandle.release();
    chatHandle.release();
  });

  it("enforces Bot primary & desktop default model in BotCompanionHarness over stale session model and injects <active_model>", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "qj-bot-grok-routing-"));
    const ctx = new Context();
    cleanups.push(async () => {
      await ctx.fiber.dispose();
      rmSync(dataDir, { recursive: true, force: true });
    });

    await ctx.plugin(Credentials);
    await ctx.plugin(LlmService, { maxAttempts: 1 });
    await ctx.plugin(Sessions);
    await ctx.plugin(Ui);
    await ctx.plugin(Tools);
    await ctx.plugin(SystemPrompt);

    const capturedRequests: LlmRequest[] = [];
    ctx.llm.registerAdapter(
      { id: "deepseek", name: "DeepSeek", api: "mock-ds", baseUrl: "http://ds.local" },
      {
        async *stream(req: LlmRequest): AsyncIterable<StreamChunk> {
          if (!req.sessionId?.endsWith(":reflect")) capturedRequests.push(req);
          for (const c of textChunks("我是 DeepSeek V4 Flash")) yield c;
        },
      },
    );
    ctx.llm.registerAdapter(
      { id: "xai", name: "xAI", api: "mock-xai", baseUrl: "http://xai.local" },
      {
        async *stream(req: LlmRequest): AsyncIterable<StreamChunk> {
          if (!req.sessionId?.endsWith(":reflect")) capturedRequests.push(req);
          for (const c of textChunks("我现在运行在 Grok 4.7 上。")) yield c;
        },
      },
    );

    let currentDesktopDefault: { provider: string; model: string } | undefined = {
      provider: "deepseek",
      model: "deepseek-v4-flash",
    };

    const store = new BotStateStore(ctx.sessions, {
      dataDir,
      displayName: "千机",
      serverMode: "local",
      distroName: "qianji-bot-unit-noop",
      defaultModel: () => currentDesktopDefault,
    });
    const host = createBotHarnessHost(store, () => undefined);
    const harness = new BotCompanionHarness(ctx, host);

    const snap0 = await store.snapshot();
    const mainSession = await ctx.sessions.get(snap0.mainSessionId);
    expect(mainSession).toBeDefined();
    if (!mainSession) return;

    // Turn 1 runs on DeepSeek V4 Flash and writes "我是 DeepSeek V4 Flash" into transcript
    harness.prompt(mainSession, [{ type: "text", text: "说明当前所用模型" }]);
    await harness.idle(mainSession.id);
    expect(capturedRequests[0]?.provider).toBe("deepseek");
    expect(capturedRequests[0]?.model).toBe("deepseek-v4-flash");

    // User switches global desktop default model to Grok 4.7 (with modelConfig.primary unset = "跟随默认模型")
    currentDesktopDefault = { provider: "xai", model: "grok-4.7" };

    // Turn 2 MUST automatically switch mainSession from stale DeepSeek V4 to xai/grok-4.7 AND inject <active_model>!
    harness.prompt(mainSession, [{ type: "text", text: "现在我用的是什么模型？" }]);
    await harness.idle(mainSession.id);

    const turn2Req = capturedRequests[1];
    expect(turn2Req?.provider).toBe("xai");
    expect(turn2Req?.model).toBe("grok-4.7");
    expect(turn2Req?.system).toContain("<active_model>");
    expect(turn2Req?.system).toContain('provider="xai", model="grok-4.7"');
    expect(mainSession.state().model).toEqual({ provider: "xai", model: "grok-4.7" });
  });

  it("resolves effective Bot model cleanly, hides duplicate DefaultPreferencesCard in Bot settings, and renders Topbar switcher", async () => {
    const models = [
      { id: "deepseek-v4-flash", name: "DeepSeek V4 Flash", provider: "deepseek" },
      { id: "grok-4.7", name: "Grok 4.7", provider: "xai" },
    ];

    // 1. Explicit Bot primary wins over everything
    const explicit = resolveEffectiveBotModel({
      modelConfig: { primary: { provider: "xai", model: "grok-4.7" } },
      settingsProvider: "deepseek",
      settingsModel: "deepseek-v4-flash",
      sessionModel: models[0],
      availableModels: models,
    });
    expect(explicit.provider).toBe("xai");
    expect(explicit.modelId).toBe("grok-4.7");
    expect(explicit.label).toBe("Grok 4.7");

    // 2. When Bot primary is unset ("跟随默认"), settings.provider/model wins over stale Agent sessionModel
    const settingsFallback = resolveEffectiveBotModel({
      modelConfig: {},
      settingsProvider: "xai",
      settingsModel: "grok-4.7",
      sessionModel: models[0],
      availableModels: models,
    });
    expect(settingsFallback.provider).toBe("xai");
    expect(settingsFallback.modelId).toBe("grok-4.7");

    // 3. Topbar renders model label with quick-switcher trigger
    const topbarHtml = renderToStaticMarkup(
      createElement(BotChatFloatingTopbar, {
        topTitle: "聊天",
        isMain: true,
        drawerVisible: false,
        compactSplit: false,
        rightPanelOpen: true,
        voiceCallActive: false,
        pendingApprovalsCount: 0,
        modelLabel: "Grok 4.7",
        availableModels: models,
        selectedPrimaryKey: "xai::grok-4.7",
        onSelectPrimaryModel: () => undefined,
        onOpenDrawer: () => undefined,
        onOpenModels: () => undefined,
        onOpenApprovals: () => undefined,
        onToggleVoice: () => undefined,
        onOpenRightPanel: () => undefined,
      }),
    );
    expect(topbarHtml).toContain('data-testid="bot-topbar-model-btn"');
    expect(topbarHtml).toContain("Grok 4.7");

    // 4. BotModelsSettingsPane hides duplicate DefaultPreferencesCard ("默认偏好")
    const root = new Context();
    const registry = new SlotRegistry();
    await root.plugin(ClientSlotsService, registry);
    await registerFrontendServices(root, { shortcutTarget: null });
    const disposeHostFactories = registerHostComponentFactories(registry);
    const shellFiber = await root.plugin(coreShellPlugin);
    const botFiber = await root.plugin(botModePlugin);
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    cleanups.push(async () => {
      queryClient.clear();
      await botFiber.dispose();
      await shellFiber.dispose();
      disposeHostFactories();
    });

    root.navigationService.setShellMode("bot");
    openBotModal("settings", "models");

    const html = renderToStaticMarkup(
      createElement(
        QueryClientProvider,
        { client: queryClient },
        createElement(SlotRoot, { registry, ctx: root }),
      ),
    );
    expect(html).toContain('data-testid="bot-models-settings-pane"');
    expect(html).toContain("服务商与 API 密钥");
    expect(html).not.toContain("默认对话模型");
  });
});

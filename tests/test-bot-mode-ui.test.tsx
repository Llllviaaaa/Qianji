/**
 * Frontend microkernel integration tests for Qianji Bot Mode (`bot-mode` + `core-shell`):
 * 1. Dual-mounted `Agent ⇄ Bot` shell attributes, `#mode-pill` capsule, `bot.rail` & `bot.stage` factories.
 * 2. Clean zero-demo-data initial state across all Bot views & Companion tabs.
 * 3. 9-tab Bot Settings (`760px × 520px`), Local & Remote Virtual Server console, and `SOUL.md` / `MEMORY.md` editors.
 * 4. Bidirectional `Bot ⇄ Agent` task handoff (`#handoff-ribbon` + `bot-handoff-return` chip).
 * 5. Disabling `bot-mode` cleanly removes Bot factories and hides `#mode-pill`.
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
  FALLBACK_BOT_SNAPSHOT,
  INITIAL_BOT_UI_STATE,
  openBotModal,
  patchBotUi,
} from "../src/builtin-plugins/bot-mode/botStore";
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

describe("Bot Mode Frontend Microkernel & Silk Morphing Integration", () => {
  const cleanups: Array<() => Promise<void>> = [];

  afterEach(async () => {
    botUiStore.set(INITIAL_BOT_UI_STATE);
    botDataStore.set(FALLBACK_BOT_SNAPSHOT);
    while (cleanups.length > 0) {
      const fn = cleanups.pop();
      if (fn) await fn();
    }
  });

  it("mounts Agent mode by default with #mode-pill and clean zero-fake-data Bot stage, then morphs to Bot mode", async () => {
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

    // Toggle to Bot mode via navigationService
    harness.root.navigationService.toggleShellMode();
    expect(harness.root.navigationService.getSnapshot().shellMode).toBe("bot");

    const botHtml = harness.renderHtml();
    expect(botHtml).toContain('data-shell-mode="bot"');
    expect(botHtml).toContain('data-mode="bot"');
    expect(botHtml).toContain("WSL2 本地容器");
    // Ensure zero prototype example strings leak into fresh UI
    expect(botHtml).not.toContain("PR #142");
    expect(botHtml).not.toContain("Qianji-Engine");
  });

  it("renders all Bot views, Side-Chat drawer, Companion tabs, and 9-tab Settings / Virtual Server console", async () => {
    const harness = await createBotShellHarness();
    cleanups.push(harness.dispose);
    harness.root.navigationService.setShellMode("bot", { persist: false });

    patchBotUi({ chatDrawerOpen: true });
    expect(harness.renderHtml()).toContain("qj-bot-drawer-wrap open");

    patchBotUi({ activeView: "feed" });
    expect(harness.renderHtml()).toContain("还没有主动动态简报");

    patchBotUi({ activeView: "ideas" });
    expect(harness.renderHtml()).toContain("点子");

    patchBotUi({ activeView: "goals" });
    expect(harness.renderHtml()).toContain("创建目标");

    patchBotUi({ activeView: "library", libSection: "sysfiles" });
    expect(harness.renderHtml()).toContain("系统文件");
    expect(harness.renderHtml()).toContain("SOUL.md");

    patchBotUi({ activeView: "spaces" });
    expect(harness.renderHtml()).toContain("在左侧对话输入主题即可实时生成空间");

    // Companion tabs on chat view: Approvals, Identity, Inbox
    patchBotUi({ activeView: "chat", rightTab: "approvals" });
    expect(harness.renderHtml()).toContain("暂无待批准记录");

    patchBotUi({ rightTab: "identity" });
    expect(harness.renderHtml()).toContain("SOUL");

    patchBotUi({ rightTab: "inbox" });
    expect(harness.renderHtml()).toContain("创建邮箱");

    // 9-tab Settings & Virtual Server Console (Local & Remote modes)
    openBotModal("settings", "server");
    const localServerHtml = harness.renderHtml();
    expect(localServerHtml).toContain('data-testid="bot-settings-modal"');
    expect(localServerHtml).toContain("一键重置环境");
    expect(localServerHtml).toContain("声音和虚拟形象");

    botDataStore.set((prev) => ({
      ...prev,
      virtualServer: { ...prev.virtualServer, mode: "remote" },
    }));
    const remoteServerHtml = harness.renderHtml();
    expect(remoteServerHtml).toContain("远端虚拟服务器地址");
    expect(remoteServerHtml).toContain("一键初始化环境");
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

    // Disabling bot-mode removes factories, hides #mode-pill, and restores Agent mode
    await harness.disableBot();
    const disabledHtml = harness.renderHtml();
    expect(disabledHtml).toContain('data-shell-mode="agent"');
    expect(disabledHtml).not.toContain('id="mode-pill"');
    expect(disabledHtml).not.toContain('data-testid="bot-stage"');
  });
});

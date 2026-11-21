/**
 * Frontend microkernel integration tests for Qianji Bot Mode (`bot-mode` + `core-shell`):
 * 1. Dual-mounted `Agent ⇄ Bot` shell attributes, `#mode-pill` capsule, `bot.rail` & `bot.stage` factories.
 * 2. All Bot views (`chat`, `feed`, `ideas`, `goals`, `library`, `spaces`) + Companion tabs (`activity`, `approvals`, `identity`, `inbox`).
 * 3. Virtual Server console (`本地虚拟服务器` & `远端虚拟服务器`) and `SOUL.md` / `MEMORY.md` modal editors.
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
    botUiStore.set({
      activeView: "chat",
      chatDrawerOpen: false,
      activeSessionId: null,
      rightPanelOpen: true,
      rightTab: "activity",
      libSection: "spaces",
      modal: null,
      settingsTab: "profile",
      modalNonce: 0,
      moreMenuOpen: false,
      composerDraft: "",
      quotedText: null,
      voiceCallActive: false,
      heartbeatEnabled: true,
      memoryDraftContent: "# MEMORY.md\n",
      serverFeedback: null,
    });
    botDataStore.set(FALLBACK_BOT_SNAPSHOT);
    while (cleanups.length > 0) {
      const fn = cleanups.pop();
      if (fn) await fn();
    }
  });

  it("mounts Agent mode by default with #mode-pill and dual-mounted Bot rail/stage, then morphs to Bot mode", async () => {
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
    expect(botHtml).toContain("在 Agent 工作台中打开");
    expect(botHtml).toContain("本地虚拟服务器");
  });

  it("renders all Bot views, Side-Chat drawer, Companion tabs, and Virtual Server console", async () => {
    const harness = await createBotShellHarness();
    cleanups.push(harness.dispose);
    harness.root.navigationService.setShellMode("bot", { persist: false });

    patchBotUi({ chatDrawerOpen: true });
    expect(harness.renderHtml()).toContain("qj-bot-drawer open");

    patchBotUi({ activeView: "feed" });
    expect(harness.renderHtml()).toContain("主动动态与每日简报");

    patchBotUi({ activeView: "ideas" });
    expect(harness.renderHtml()).toContain("一起探索新点子");

    patchBotUi({ activeView: "goals" });
    expect(harness.renderHtml()).toContain("长期目标与里程碑");

    patchBotUi({ activeView: "library", libSection: "system" });
    expect(harness.renderHtml()).toContain("SOUL.md · 灵魂与行为契约");

    patchBotUi({ activeView: "spaces" });
    expect(harness.renderHtml()).toContain("用一句话生成持久交互空间");

    // Companion tabs: Approvals, Identity, Inbox
    patchBotUi({ rightTab: "approvals" });
    expect(harness.renderHtml()).toContain("发送每周进展摘要至团队归档频道");

    patchBotUi({ rightTab: "identity" });
    expect(harness.renderHtml()).toContain("查看 / 编辑 SOUL.md");

    patchBotUi({ rightTab: "inbox" });
    expect(harness.renderHtml()).toContain("一键开通收件箱");

    // Virtual Server Console (Local & Remote modes)
    openBotModal("settings", "vserver");
    const localServerHtml = harness.renderHtml();
    expect(localServerHtml).toContain('data-testid="bot-settings-modal"');
    expect(localServerHtml).toContain("恢复干净快照（保留身份与记忆）");

    botDataStore.set((prev) => ({
      ...prev,
      virtualServer: { ...prev.virtualServer, mode: "remote" },
    }));
    const remoteServerHtml = harness.renderHtml();
    expect(remoteServerHtml).toContain("远端虚拟服务器连接配置");
    expect(remoteServerHtml).toContain("一键初始化远端环境并同步记忆");
  });

  it("supports bidirectional Bot ⇄ Agent task handoff and falls back cleanly when bot-mode is disabled", async () => {
    const harness = await createBotShellHarness();
    cleanups.push(harness.dispose);
    harness.root.navigationService.setShellMode("bot", { persist: false });

    const task = FALLBACK_BOT_SNAPSHOT.embeddedTasks[0];
    expect(task).toBeDefined();
    if (!task) return;

    harness.root.navigationService.beginBotHandoff(task);
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

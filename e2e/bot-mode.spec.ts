import { expect, test, textReply } from "./fixtures.ts";

test("Agent ⇄ Bot 1:1 Muse layout matches Agent palette, opens Side-Chat drawer, wires Virtual Server & Spaces CRUD, and completes bidirectional handoff", async ({
  app,
  harness,
}) => {
  await app.setViewportSize({ width: 1440, height: 900 });

  const modePill = app.locator("#mode-pill");
  await expect(modePill).toBeVisible();
  await expect(modePill).toHaveAttribute("data-mode", "agent");

  const agentMetrics = await app.evaluate(() => {
    const pill = document.querySelector("#mode-pill")?.getBoundingClientRect();
    const winCtrls = document.querySelector(".window-controls")?.getBoundingClientRect();
    const menubar = document.querySelector(".window-menubar")?.getBoundingClientRect();
    const stageBg = getComputedStyle(document.querySelector(".stage-canvas") as Element).backgroundColor;
    return {
      pillRight: pill?.right ?? 0,
      pillTop: pill?.top ?? 0,
      winRight: winCtrls?.right ?? 0,
      winTop: winCtrls?.top ?? 0,
      menubarHeight: menubar?.height ?? 0,
      stageBg,
    };
  });

  // Switch to Bot mode via centered mode pill
  await app.locator('#mode-pill [data-mode-tab="bot"]').click();
  await expect(app.locator(".app-shell")).toHaveAttribute("data-shell-mode", "bot");
  await expect(modePill).toHaveAttribute("data-mode", "bot");
  await app.waitForTimeout(360);

  // Verify zero prototype demo conversations & removed dashboard clutter
  await expect(app.locator("#pane-bot")).not.toContainText("PR #142");
  const charStage = app.getByTestId("bot-character-stage");
  await expect(charStage).toBeVisible();
  await expect(app.getByTestId("bot-emote-strip")).toHaveCount(0);
  await expect(app.getByTestId("bot-interact-bar")).toHaveCount(0);
  await expect(app.getByTestId("bot-mini-screen")).toHaveCount(0);
  await expect(app.getByTestId("bot-computer-preview")).toHaveCount(0);
  await expect(app.getByTestId("bot-awareness-grid")).toHaveCount(0);
  await expect(app.getByTestId("bot-vserver-pill")).toBeVisible();
  await expect(charStage).toHaveAttribute("data-expression", /^(calm|sleepy)$/);
  await expect(charStage).toHaveAttribute("data-action", "idle");
  await expect(app.getByTestId("bot-hero-orb")).toBeVisible();

  // Clicking / petting plush avatar triggers happy wave + 3-hit celebrate combo
  const plushBust = charStage.locator("button.qj-char-rig");
  await plushBust.click();
  await expect(charStage).toHaveAttribute("data-expression", "happy");
  await plushBust.click();
  await plushBust.click();
  await expect(charStage).toHaveAttribute("data-action", "celebrate");

  // Typing in composer triggers curious expression, clearing restores calm/sleepy baseline
  const chatInput = app.locator("#muse-msg-input");
  await chatInput.click();
  await chatInput.fill("今天帮我巡检工作区");
  await expect(charStage).toHaveAttribute("data-expression", "curious");
  await expect(charStage).toHaveAttribute("data-action", "nod");
  await chatInput.fill("");
  await expect(charStage).toHaveAttribute("data-expression", /^(calm|sleepy)$/);

  // Toggle right companion panel closed & back open while empty hero is mounted
  await app.locator("#btn-toggle-right-panel").click();
  await expect(app.getByTestId("bot-hero-character")).toBeVisible();
  await app.locator("#btn-toggle-right-panel").click();
  await expect(app.getByTestId("bot-hero-orb")).toBeVisible();

  // Send a real message and verify `<think>` reasoning block is stripped in both Muse bubble and Search modal
  harness.provider.push(textReply("<think>先查看工作区</think>工作区一切正常，随时准备协助。"));
  await chatInput.fill("帮我查看一下状态");
  await chatInput.press("Enter");
  await expect(app.locator(".qj-sanctuary-bubble-bot").first()).toContainText("工作区一切正常，随时准备协助。");
  await expect(app.locator("#pane-bot")).not.toContainText("先查看工作区");
  await app.locator('[data-bot-nav="search"]').click();
  await expect(app.locator(".qj-muse-search-modal")).toContainText("工作区一切正常");
  await expect(app.locator(".qj-muse-search-modal")).not.toContainText("先查看工作区");
  await app.keyboard.press("Escape");

  // Toggle slide-out Muse side-chat drawer
  await app.locator("#btn-toggle-chat-drawer").click();
  await expect(app.getByTestId("bot-side-drawer")).toBeVisible();
  await app.getByRole("button", { name: "收起聊天列表" }).click();
  await expect(app.getByTestId("bot-side-drawer")).toHaveCount(0);

  // Verify Bot background color matches Agent stage background and 72px Muse dock
  const botMetrics = await app.evaluate(() => {
    const pill = document.querySelector("#mode-pill")?.getBoundingClientRect();
    const winCtrls = document.querySelector(".window-controls")?.getBoundingClientRect();
    const railPanel = document.querySelector(".primary-sidebar-panel")?.getBoundingClientRect();
    const islandDock = document.querySelector('[data-testid="bot-left-rail"]')?.getBoundingClientRect();
    const menubar = document.querySelector(".window-menubar")?.getBoundingClientRect();
    const botStage = document.querySelector("#pane-bot") as Element;
    const botBg = getComputedStyle(botStage).backgroundColor;
    return {
      pillRight: pill?.right ?? 0,
      pillTop: pill?.top ?? 0,
      winRight: winCtrls?.right ?? 0,
      winTop: winCtrls?.top ?? 0,
      railPanelWidth: railPanel?.width ?? 0,
      islandWidth: islandDock?.width ?? 0,
      menubarHeight: menubar?.height ?? 0,
      botBg,
    };
  });

  expect(Math.round(agentMetrics.menubarHeight)).toBe(34);
  expect(Math.round(botMetrics.menubarHeight)).toBe(34);
  expect(Math.abs(botMetrics.pillRight - agentMetrics.pillRight)).toBeLessThanOrEqual(1);
  expect(Math.abs(botMetrics.pillTop - agentMetrics.pillTop)).toBeLessThanOrEqual(1);
  expect(Math.abs(botMetrics.winRight - agentMetrics.winRight)).toBeLessThanOrEqual(1);
  expect(Math.abs(botMetrics.winTop - agentMetrics.winTop)).toBeLessThanOrEqual(1);
  expect(Math.round(botMetrics.railPanelWidth)).toBe(0);
  expect(Math.round(botMetrics.islandWidth)).toBe(72);
  expect(botMetrics.botBg).toBe(agentMetrics.stageBg);

  // Open Avatar Settings via companion portrait pencil badge & switch character preset
  await app.locator("#btn-edit-avatar").click();
  const settingsModal = app.getByTestId("bot-settings-modal");
  await expect(settingsModal).toBeVisible();
  await expect(settingsModal.getByText("云白·虹彩绘师")).toBeVisible();
  await expect(settingsModal.getByText("暖珀·晴空学妹")).toBeVisible();
  await expect(settingsModal.getByText("星黛·秘境司书")).toBeVisible();
  await settingsModal.getByText("暖珀·晴空学妹").click();
  await app.getByRole("button", { name: "关闭设置" }).click();
  await expect(charStage).toHaveAttribute("data-preset", "warm-felt");

  // Open Virtual Server settings via companion status line & toggle Local <-> Remote
  await app.getByTestId("bot-vserver-pill").click();
  await expect(settingsModal).toBeVisible();
  await expect(app.getByText("一键重置环境")).toBeVisible();
  await app.locator('[data-vserver-mode="remote"]').click();
  await expect(app.getByText("远端虚拟服务器地址")).toBeVisible();
  await app.getByRole("button", { name: "关闭设置" }).click();
  await expect(app.getByTestId("bot-vserver-pill")).toContainText("远端虚拟服务器");

  // Create a real Space via `创建空间`, open it in `资源库`, and hand off to Agent Workbench
  await app.locator('[data-bot-nav="spaces"]').click();
  const spaceInput = app.locator("#muse-msg-input");
  await spaceInput.fill("我想创建一个空间，关于 千机双形态体验验证");
  await spaceInput.press("Enter");
  await expect(app.getByText("千机双形态体验验证").first()).toBeVisible();

  await app.locator('[data-bot-nav="library"]').click();
  await app.getByText("千机双形态体验验证").first().click();
  await app.getByRole("button", { name: /在 Agent 工作台中打开/ }).click();

  await expect(app.locator(".app-shell")).toHaveAttribute("data-shell-mode", "agent");
  await expect(app.getByTestId("bot-handoff-return")).toBeVisible();

  await app.getByTestId("bot-handoff-return").getByRole("button", { name: /完成并回传 Bot/ }).click();
  await expect(app.locator(".app-shell")).toHaveAttribute("data-shell-mode", "bot");
});

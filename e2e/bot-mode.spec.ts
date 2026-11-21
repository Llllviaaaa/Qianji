import { expect, test } from "./fixtures.ts";

test("Agent ⇄ Bot silk spatial morphing keeps top-right controls stationary, wires Virtual Server RPCs, and completes bidirectional handoff", async ({
  app,
}) => {
  await app.setViewportSize({ width: 1440, height: 900 });

  const modePill = app.locator("#mode-pill");
  await expect(modePill).toBeVisible();
  await expect(modePill).toHaveAttribute("data-mode", "agent");

  const agentCoords = await app.evaluate(() => {
    const pill = document.querySelector("#mode-pill")?.getBoundingClientRect();
    const winCtrls = document.querySelector(".window-controls")?.getBoundingClientRect();
    return {
      pillRight: pill?.right ?? 0,
      pillTop: pill?.top ?? 0,
      winRight: winCtrls?.right ?? 0,
      winTop: winCtrls?.top ?? 0,
    };
  });

  // Switch to Bot mode via top-right spring capsule
  await app.locator('#mode-pill [data-mode-tab="bot"]').click();
  await expect(app.locator(".app-shell")).toHaveAttribute("data-shell-mode", "bot");
  await expect(modePill).toHaveAttribute("data-mode", "bot");
  await app.waitForTimeout(520);

  const botCoords = await app.evaluate(() => {
    const pill = document.querySelector("#mode-pill")?.getBoundingClientRect();
    const winCtrls = document.querySelector(".window-controls")?.getBoundingClientRect();
    const railPanel = document.querySelector(".primary-sidebar-panel")?.getBoundingClientRect();
    return {
      pillRight: pill?.right ?? 0,
      pillTop: pill?.top ?? 0,
      winRight: winCtrls?.right ?? 0,
      winTop: winCtrls?.top ?? 0,
      railWidth: railPanel?.width ?? 0,
    };
  });

  // Top-right `[ Agent | Bot ]` and window controls stay stationary (`<= 1px` delta)
  expect(Math.abs(botCoords.pillRight - agentCoords.pillRight)).toBeLessThanOrEqual(1);
  expect(Math.abs(botCoords.pillTop - agentCoords.pillTop)).toBeLessThanOrEqual(1);
  expect(Math.abs(botCoords.winRight - agentCoords.winRight)).toBeLessThanOrEqual(1);
  expect(Math.abs(botCoords.winTop - agentCoords.winTop)).toBeLessThanOrEqual(1);
  expect(Math.round(botCoords.railWidth)).toBe(68);

  // Open Virtual Server console via companion status pill & test Local <-> Remote Virtual Server
  await app.getByTestId("bot-vserver-pill").click();
  await expect(app.getByTestId("bot-settings-modal")).toBeVisible();
  await expect(app.getByText("恢复干净快照（保留身份与记忆）")).toBeVisible();

  await app.locator('[data-vserver-mode="remote"]').click();
  await expect(app.getByText("远端虚拟服务器连接配置")).toBeVisible();
  await app.getByRole("button", { name: "关闭设置" }).click();
  await expect(app.getByTestId("bot-vserver-pill")).toContainText("远端虚拟服务器");

  // Trigger Bot -> Agent context handoff and return summary back to Bot
  await app.getByTestId("bot-handoff-card").first().getByRole("button", { name: /在 Agent 工作台中打开/ }).click();
  await expect(app.locator(".app-shell")).toHaveAttribute("data-shell-mode", "agent");
  await expect(app.getByTestId("bot-handoff-return")).toBeVisible();

  await app.getByTestId("bot-handoff-return").getByRole("button", { name: /完成并回传 Bot/ }).click();
  await expect(app.locator(".app-shell")).toHaveAttribute("data-shell-mode", "bot");
});

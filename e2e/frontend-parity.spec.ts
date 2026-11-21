import { composer, expect, send, settled, test, textReply } from "./fixtures.ts";

test("full Plugins Hub, Composer slash & @ mention menus, popover Escape dismissal, Settings @layer theme, and Inspector parity", async ({
  app,
  harness,
}) => {
  await app.setViewportSize({ width: 1440, height: 900 });

  // 1. Active theme CSS variables live inside @layer components <style>, never inline style blocking @layer plugin-skin.
  const themeLayerCheck = await app.evaluate(() => {
    const styleEl = document.getElementById("qianji-active-theme-vars");
    const inlineBrand = document.documentElement.style.getPropertyValue("--qj-brand-primary");
    return {
      hasLayerStyle: Boolean(styleEl?.textContent?.includes("@layer components")),
      hasBrandToken: Boolean(styleEl?.textContent?.includes("--qj-brand-primary")),
      inlineBrand,
    };
  });
  expect(themeLayerCheck.hasLayerStyle).toBe(true);
  expect(themeLayerCheck.hasBrandToken).toBe(true);
  expect(themeLayerCheck.inlineBrand).toBe("");

  // 2. Composer `/` slash menu renders full production `.command-menu-list` with un-truncated command names.
  await composer(app).fill("/doc");
  const slashMenu = app.locator(".command-menu .command-menu-list");
  await expect(slashMenu).toBeVisible();
  await expect(slashMenu).toContainText("/doctor");
  await composer(app).press("Escape");
  await expect(slashMenu).toHaveCount(0);

  // 3. Composer `@` mention menu searches workspace files (`notes.txt`) and inserts reference.
  await composer(app).fill("@note");
  const mentionMenu = app.locator(".mention-menu .command-menu-list");
  await expect(mentionMenu).toBeVisible();
  await expect(mentionMenu).toContainText("notes.txt");
  await mentionMenu.getByRole("option", { name: /notes\.txt/ }).click();
  await expect(composer(app)).toHaveValue(/@notes\.txt\s/);
  await composer(app).fill("");

  // 4. Composer `+` menu exposes file attachment item and dismisses on Escape.
  await app.locator(".composer-add-trigger").click();
  const actionsMenu = app.locator(".composer-actions-menu");
  await expect(actionsMenu).toBeVisible();
  await expect(actionsMenu).toContainText("文件或图片");
  await app.keyboard.press("Escape");
  await expect(actionsMenu).toHaveCount(0);

  // 5. Plugins Hub renders full production PluginsSettingsPanel with "安装插件".
  await app.getByRole("button", { name: "扩展插件" }).click();
  await expect(app.getByRole("button", { name: "安装插件" })).toBeVisible();
  await app.getByRole("button", { name: "新会话" }).click();

  // 6. Settings defaults to page mode (`is-page`, no legacy `.settings-modal`) and switches to modal immediately.
  await app.getByRole("button", { name: "设置" }).click();
  const settingsShell = app.locator("[data-testid='core-settings-shell']");
  await expect(settingsShell).toBeVisible();
  await expect(settingsShell).toHaveClass(/is-page/);
  await expect(settingsShell).not.toHaveClass(/settings-modal/);
  await settingsShell.locator(".settings-mode-toggle-btn").click();
  await expect(settingsShell).toHaveClass(/is-modal/);
  await app.keyboard.press("Escape");
  await expect(settingsShell).toHaveCount(0);

  // 7. Send one message, verify Inspector renders Connectors & Diagnostics filters, and Sidebar project menu has full items.
  harness.provider.push(textReply("Parity check completed."));
  await send(app, "check full parity");
  await settled(app);

  await app.locator('.window-menubar-right .pid-wb-topbar-controls [data-wb-tab="summary"]').click();
  const rightWorkbench = app.locator(".pid-right-workbench");
  await expect(rightWorkbench).toBeVisible();
  await expect(rightWorkbench).toContainText("连接器");
  await rightWorkbench.locator(".pid-wb-diag-toggle").click();
  await expect(rightWorkbench.locator(".pid-wb-filter-pills")).toContainText("警告");
  await expect(rightWorkbench.locator(".pid-wb-filter-pills")).toContainText("错误");

  // Sidebar project `...` menu contains full actions and closes on Escape.
  const projectHeaderRow = app.locator(".sidebar-scroll .project-block .project-header-row").first();
  await projectHeaderRow.hover();
  await projectHeaderRow.getByRole("button", { name: /项目操作/ }).click();
  const projectMenu = app.locator(".project-context-menu");
  await expect(projectMenu).toBeVisible();
  await expect(projectMenu).toContainText("置顶项目");
  await expect(projectMenu).toContainText("创建永久工作树");
  await expect(projectMenu).toContainText("编辑项目");
  await expect(projectMenu).toContainText("移除本地项目");
  await app.keyboard.press("Escape");
  await expect(projectMenu).toHaveCount(0);
});

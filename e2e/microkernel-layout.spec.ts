import { expect, test, textReply } from "./fixtures.ts";

test("primary sidebar stretches full height, pins Settings footer at bottom, and styles project rows", async ({ app, harness }) => {
  await app.setViewportSize({ width: 1440, height: 900 });

  // Send one quick message so the workspace project & session row appear in the left sidebar.
  harness.provider.push(textReply("Sidebar layout check reply."));
  const homeComposer = app.locator(".dsh-claude-home-composer-wrap .composer-area.codex-composer");
  await expect(homeComposer).toBeVisible();

  const homeMetrics = await app.evaluate(() => {
    const vh = window.innerHeight;
    const panel = document.querySelector(".primary-sidebar-panel") as HTMLElement | null;
    const sidebar = document.querySelector(".primary-sidebar-panel .sidebar.codex-sidebar") as HTMLElement | null;
    const scroll = document.querySelector(".sidebar-scroll") as HTMLElement | null;
    const footer = document.querySelector(".sidebar-footer.codex-footer") as HTMLElement | null;
    const composer = document.querySelector(".dsh-claude-home-composer-wrap .composer-area.codex-composer") as HTMLElement | null;
    return {
      vh,
      panelHeight: panel?.getBoundingClientRect().height ?? 0,
      sidebarHeight: sidebar?.getBoundingClientRect().height ?? 0,
      scrollHeight: scroll?.getBoundingClientRect().height ?? 0,
      footerTop: footer?.getBoundingClientRect().top ?? 0,
      footerBottom: footer?.getBoundingClientRect().bottom ?? 0,
      composerWidth: composer?.getBoundingClientRect().width ?? 0,
    };
  });

  expect(homeMetrics.panelHeight).toBeGreaterThanOrEqual(homeMetrics.vh - 60);
  expect(homeMetrics.sidebarHeight).toBeGreaterThanOrEqual(homeMetrics.panelHeight - 4);
  expect(homeMetrics.scrollHeight).toBeGreaterThanOrEqual(300);
  expect(homeMetrics.footerTop).toBeGreaterThanOrEqual(homeMetrics.vh - 90);
  expect(homeMetrics.footerBottom).toBeLessThanOrEqual(homeMetrics.vh + 2);
  expect(homeMetrics.composerWidth).toBeGreaterThanOrEqual(520);

  // Trigger a conversation so we verify project-block / project-header-row and conversation composer layout too.
  const input = app.locator("textarea").first();
  await input.fill("check sidebar layout");
  await input.press("Enter");
  await expect(app.getByText("Sidebar layout check reply.")).toBeVisible();

  await expect(app.locator(".sidebar-scroll .project-block")).toHaveCount(1);
  await expect(app.locator(".sidebar-scroll .project-block .project-header-row")).toHaveCount(1);

  const threadMetrics = await app.evaluate(() => {
    const vh = window.innerHeight;
    const projectRow = document.querySelector(".sidebar-scroll .project-block .project-header-row") as HTMLElement | null;
    const threadRow = document.querySelector(".sidebar-scroll .project-block .thread-row-shell") as HTMLElement | null;
    const footer = document.querySelector(".sidebar-footer.codex-footer") as HTMLElement | null;
    const composer = document.querySelector(".main-stage .composer-dock .composer-area.codex-composer") as HTMLElement | null;
    return {
      vh,
      projectRowHeight: projectRow?.getBoundingClientRect().height ?? 0,
      threadRowHeight: threadRow?.getBoundingClientRect().height ?? 0,
      footerTop: footer?.getBoundingClientRect().top ?? 0,
      composerWidth: composer?.getBoundingClientRect().width ?? 0,
    };
  });

  expect(threadMetrics.projectRowHeight).toBeGreaterThanOrEqual(24);
  expect(threadMetrics.threadRowHeight).toBeGreaterThanOrEqual(26);
  expect(threadMetrics.footerTop).toBeGreaterThanOrEqual(threadMetrics.vh - 90);
  expect(threadMetrics.composerWidth).toBeGreaterThanOrEqual(520);
});

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Page } from "@playwright/test";
import { expect, send, settled, test, textReply } from "./fixtures.ts";

/**
 * One client plugin reaching every host surface that used to be closed to plugins:
 * Settings pages/sections, the window menubar, the thread "…" menu, the session and
 * file right-click menus, global keybindings, and Markdown fence renderers.
 */
const CLIENT_SOURCE = `
import type { Context } from "@deepseek-ai/cordis";
import { openSettingsPage } from "@qianji/client";

const mark = (key: string, value: string) => {
  document.documentElement.dataset[key] = value;
};

const PAGE_CSS = \`
.ext-settings-layout {
  display: grid;
  grid-template-columns: 140px minmax(0, 1fr);
  gap: 16px;
  padding: 12px;
  border-radius: 14px;
  background-color: rgb(7, 193, 96);
  color: rgb(255, 255, 255);
}
.ext-brand-title {
  font-size: 20px;
  letter-spacing: 2px;
}
.ext-primary-btn {
  padding: 0 12px;
  min-height: 32px;
  border-radius: 8px;
  font-size: 12.5px;
  font-weight: 600;
  color: var(--qj-brand-contrast, #fff);
  background: var(--qj-brand-primary);
}
.ext-section-pill {
  display: inline-flex;
  padding: 4px 10px;
  border-radius: 999px;
  background-color: rgb(51, 112, 255);
  color: rgb(255, 255, 255);
}
\`;

export const name = "e2e-ext-points-client";
export const inject = ["contributions", "styles"];
export function apply(ctx: Context) {
  ctx.styles.inject(PAGE_CSS, "e2e-ext-points-settings");

  ctx.contributions.registerSettingsPage({
    id: "ext-points",
    label: "扩展点演示",
    subtitle: "插件贡献的设置页",
    wide: true,
    render: ({ page }) => (
      <div className="ext-settings-layout" data-testid="ext-settings-page">
        <span className="ext-brand-title" data-testid="ext-brand-title">设置页内容@{page}</span>
        <button type="button" className="ext-primary-btn" data-testid="ext-primary-btn">填写应用凭据</button>
      </div>
    ),
  });
  ctx.contributions.registerSettingsSection({
    id: "ext-general-card",
    page: "general",
    title: "扩展点卡片",
    render: () => <p className="ext-section-pill" data-testid="ext-general-section">通用页插件卡片</p>,
  });
  ctx.contributions.registerMenuItem({
    id: "ext-tools",
    location: "menubar.tools",
    label: "演示工具项",
    onSelect: () => mark("extTool", "ran"),
  });
  ctx.contributions.registerMenuItem({
    id: "ext-help",
    location: "menubar.help",
    label: "打开扩展点设置",
    onSelect: () => { openSettingsPage("ext-points"); },
  });
  ctx.contributions.registerMenuItem({
    id: "ext-thread",
    location: "thread.more",
    label: "插件线程项",
    onSelect: ({ sessionFile }) => mark("extThread", sessionFile ?? "none"),
  });
  ctx.contributions.registerMenuItem({
    id: "ext-session",
    location: "sidebar.thread",
    label: "插件会话项",
    onSelect: ({ title }) => mark("extSession", title),
  });
  ctx.contributions.registerMenuItem({
    id: "ext-file",
    location: "file.context",
    label: "插件文件项",
    onSelect: ({ path }) => mark("extFile", path),
  });
  ctx.contributions.registerKeybinding({
    id: "ext-key",
    key: "Ctrl+Alt+Y",
    run: () => mark("extKey", "pressed"),
  });
  ctx.contributions.registerCodeBlockRenderer({
    id: "ext-fence",
    languages: ["extchart"],
    render: ({ code }) => <div data-testid="ext-fence">图表:{code}</div>,
  });
}
`;

const dataset = (app: Page, key: string) => app.evaluate((name) => document.documentElement.dataset[name], key);

async function installPlugin(app: Page, pluginDir: string): Promise<void> {
  await app.getByRole("button", { name: "设置" }).click();
  await app.locator(".settings-nav-scroll").getByRole("button", { name: "插件" }).click();
  await app.getByRole("button", { name: "安装插件" }).click();
  const dialog = app.getByRole("dialog", { name: "安装插件" });
  await dialog.getByLabel("本地插件目录路径").fill(pluginDir);
  await dialog.getByRole("button", { name: "立即安装并加载" }).click();
  await expect(dialog).toHaveCount(0);
  await expect(app.locator('article[data-plugin-id="e2e-ext-points"]')).toContainText("运行中");
}

test("a client plugin extends settings, menus, keybindings, file and session menus, and Markdown fences", async ({ app, harness }) => {
  const pluginDir = mkdtempSync(join(tmpdir(), "qj-e2e-ext-points-"));
  try {
    writeFileSync(join(pluginDir, "package.json"), JSON.stringify({
      name: "e2e-ext-points",
      version: "1.0.0",
      qianji: { name: "E2E 扩展点插件", client: "./client.tsx" },
    }, null, 2));
    writeFileSync(join(pluginDir, "client.tsx"), CLIENT_SOURCE);
    await installPlugin(app, pluginDir);

    // Settings: plugin card hides duplicate inline 配置 (since it contributes a Settings page),
    // while its enabled toggle switch renders with the theme brand accent (not black).
    const extCard = app.locator('article[data-plugin-id="e2e-ext-points"]');
    await expect(extCard.getByRole("button", { name: "配置" })).toHaveCount(0);
    const switchBg = await extCard.locator("button.settings-switch.on").evaluate((el) => window.getComputedStyle(el).backgroundColor);
    expect(switchBg).toBe("rgb(0, 110, 228)");
    const nav = app.locator(".settings-nav-scroll");
    await expect(nav.locator(".settings-nav-group-label")).toHaveText("扩展");
    await nav.getByRole("button", { name: "扩展点演示" }).click();
    const extPage = app.getByTestId("ext-settings-page");
    await expect(extPage).toContainText("设置页内容@plugin:ext-points");
    await expect(app.locator(".settings-header-sub")).toHaveText("插件贡献的设置页");
    // Scoped plugin CSS (`@layer plugin-ui { @scope ([data-qj-plugin="e2e-ext-points"]) }`)
    // must apply inside legacy `registerSettingsPage` surfaces, and legacy resets must not
    // clobber plugin button `color`, `font-size`, `font-weight`, or `letter-spacing`.
    const pageStyle = await extPage.evaluate((el) => {
      const style = window.getComputedStyle(el);
      const scope = el.closest("[data-qj-plugin]");
      const btn = el.querySelector<HTMLButtonElement>('[data-testid="ext-primary-btn"]');
      const btnStyle = btn ? window.getComputedStyle(btn) : null;
      const title = el.querySelector<HTMLElement>('[data-testid="ext-brand-title"]');
      const titleStyle = title ? window.getComputedStyle(title) : null;
      return {
        pluginId: scope?.getAttribute("data-qj-plugin"),
        slot: scope?.getAttribute("data-qj-slot"),
        display: style.display,
        backgroundColor: style.backgroundColor,
        borderRadius: style.borderRadius,
        btnBackground: btnStyle?.backgroundColor,
        btnColor: btnStyle?.color,
        btnFontSize: btnStyle?.fontSize,
        btnFontWeight: btnStyle?.fontWeight,
        titleLetterSpacing: titleStyle?.letterSpacing,
      };
    });
    expect(pageStyle).toEqual({
      pluginId: "e2e-ext-points",
      slot: "settings.pages",
      display: "grid",
      backgroundColor: "rgb(7, 193, 96)",
      borderRadius: "14px",
      btnBackground: "rgb(0, 110, 228)",
      btnColor: "rgb(255, 255, 255)",
      btnFontSize: "12.5px",
      btnFontWeight: "600",
      titleLetterSpacing: "2px",
    });
    await nav.getByRole("button", { name: "通用" }).click();
    await expect(app.locator(".settings-plugin-section h2")).toHaveText("扩展点卡片");
    const extSection = app.getByTestId("ext-general-section");
    await expect(extSection).toBeVisible();
    const sectionStyle = await extSection.evaluate((el) => {
      const style = window.getComputedStyle(el);
      const scope = el.closest("[data-qj-plugin]");
      return {
        pluginId: scope?.getAttribute("data-qj-plugin"),
        slot: scope?.getAttribute("data-qj-slot"),
        backgroundColor: style.backgroundColor,
        color: style.color,
      };
    });
    expect(sectionStyle).toEqual({
      pluginId: "e2e-ext-points",
      slot: "settings.sections",
      backgroundColor: "rgb(51, 112, 255)",
      color: "rgb(255, 255, 255)",
    });
    await app.getByRole("button", { name: "返回应用" }).first().click();
    await expect(nav).toHaveCount(0);

    // Menubar: the 工具 menu appears for plugin items; a 帮助 item opens the plugin settings page.
    const menubar = app.locator(".app-menu-bar");
    await menubar.getByRole("button", { name: "工具" }).click();
    await app.locator(".app-menu-dropdown").getByRole("menuitem", { name: "演示工具项" }).click();
    await expect.poll(() => dataset(app, "extTool")).toBe("ran");
    await menubar.getByRole("button", { name: "帮助" }).click();
    await app.locator(".app-menu-dropdown").getByRole("menuitem", { name: "打开扩展点设置" }).click();
    await expect(app.getByTestId("ext-settings-page")).toBeVisible();
    await app.getByRole("button", { name: "返回应用" }).first().click();

    // Keybinding: fires outside text fields.
    await app.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
    await app.keyboard.press("Control+Alt+KeyY");
    await expect.poll(() => dataset(app, "extKey")).toBe("pressed");

    // Workbench file tree: right-click shows plugin file items.
    await app.getByRole("button", { name: "切换右侧工作台 (Ctrl+Alt+B)" }).click();
    await app.locator('[data-wb-tab="files"]').click();
    await app.locator(".pid-wb-tree-row", { hasText: "notes.txt" }).click({ button: "right" });
    await app.locator(".file-context-menu").getByRole("menuitem", { name: "插件文件项" }).click();
    await expect.poll(() => dataset(app, "extFile")).toContain("notes.txt");

    // Markdown: a fence in a reply is rendered by the plugin.
    harness.provider.push(textReply("Here is the chart:\n\n```extchart\n1 2 3\n```"));
    await send(app, "画一个图");
    await settled(app);
    await expect(app.getByTestId("ext-fence")).toHaveText("图表:1 2 3");

    // Thread "…" menu in the top bar.
    await app.getByTitle("线程操作").click();
    await app.locator(".title-menu").getByRole("menuitem", { name: "插件线程项" }).click();
    await expect.poll(() => dataset(app, "extThread")).toMatch(/\S/);
    expect(await dataset(app, "extThread")).not.toBe("none");

    // Session row right-click: built-in pin/archive plus the plugin item.
    await app.locator(".thread-row-shell").first().click({ button: "right" });
    const sessionMenu = app.locator(".thread-context-menu");
    await expect(sessionMenu.getByRole("menuitem", { name: "置顶对话" })).toBeVisible();
    await expect(sessionMenu.getByRole("menuitem", { name: "归档对话" })).toBeVisible();
    await sessionMenu.getByRole("menuitem", { name: "插件会话项" }).click();
    await expect(sessionMenu).toHaveCount(0);
    await expect.poll(() => dataset(app, "extSession")).toMatch(/\S/);
  } finally {
    rmSync(pluginDir, { recursive: true, force: true });
  }
});

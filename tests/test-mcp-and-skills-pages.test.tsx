import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createElement, createRef } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CommandListResult, CommandRunResult } from "@qianji/protocol";
import { builtinPluginDefinitions, corePlugins } from "../packages/host/src/agent-plugins.ts";
import { readEffectiveHarnessConfig } from "../packages/host/src/harness-config.ts";
import { createHost, type Host } from "../packages/host/src/host.ts";
import { PluginManager } from "../packages/host/src/plugin-manager.ts";
import * as pluginsRpc from "../packages/host/src/plugins-rpc.ts";
import { PluginsHubPage } from "../src/components/PluginsHubPage";
import { SettingsModal } from "../src/components/SettingsModal";
import { BUILTIN_SETTINGS_NAV } from "../src/components/settings/settingsNavigation";
import { SidebarHeaderAndPopovers, type SidebarHeaderAndPopoversProps } from "../src/components/sidebar/SidebarHeaderAndPopovers";
import { bindShellNavigation, requestOpenSettings, resolveSettingsPageId } from "../src/lib/shellBridge";
import { withQueryClient } from "./support/withQueryClient";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repoSkillsDir = join(repoRoot, "skills");

let tempRoot = "";
let host: Host | undefined;
let manager: PluginManager | undefined;

afterEach(async () => {
  await manager?.dispose();
  manager = undefined;
  await host?.stop();
  host = undefined;
  if (tempRoot !== "") {
    rmSync(tempRoot, { recursive: true, force: true });
    tempRoot = "";
  }
});

async function callRpc<T>(target: Host, method: string, params?: unknown): Promise<T> {
  const handler = (
    target.ctx.rpc as unknown as {
      handlers: Map<string, (p: unknown, c: { signal: AbortSignal }) => unknown>;
    }
  ).handlers.get(method);
  if (handler === undefined) throw new Error(`RPC method not found: ${method}`);
  return (await handler(params, { signal: new AbortController().signal })) as T;
}

function makeSidebarHeaderProps(
  overrides: Partial<SidebarHeaderAndPopoversProps> = {},
): SidebarHeaderAndPopoversProps {
  return {
    query: "",
    setQuery: () => undefined,
    searchOpen: false,
    setSearchOpen: () => undefined,
    searchInputRef: createRef<HTMLInputElement>(),
    notificationsOpen: false,
    setNotificationsOpen: () => undefined,
    unreadNotificationCount: 0,
    notifications: [],
    onMarkAllNotificationsRead: () => undefined,
    onOpenNotification: () => undefined,
    onDismissNotification: () => undefined,
    newTaskActive: false,
    activeHub: null,
    onNewSession: () => undefined,
    onOpenScheduled: () => undefined,
    workspaceView: "active",
    setWorkspaceView: () => undefined,
    groupMode: "recent",
    setGroupMode: () => undefined,
    filterMenuOpen: false,
    setFilterMenuOpen: () => undefined,
    closePopovers: () => undefined,
    clearProjectMenu: () => undefined,
    onPickFolder: () => undefined,
    ...overrides,
  };
}

describe("Unified Plugins Hub, MCP and Skills navigation", () => {
  it("consolidates BUILTIN_SETTINGS_NAV while preserving mcp/skills shellBridge compatibility", () => {
    expect(BUILTIN_SETTINGS_NAV.map((item) => item.id)).toEqual([
      "general",
      "appearance",
      "providers",
      "plugins",
    ]);
    const pluginsNav = BUILTIN_SETTINGS_NAV.find((item) => item.id === "plugins");
    expect(pluginsNav?.wide).toBe(true);
    expect(resolveSettingsPageId("mcp")).toBe("mcp");
    expect(resolveSettingsPageId("skills")).toBe("skills");

    const openSettings = vi.fn();
    const dispose = bindShellNavigation({ openSettings, openHubPage: () => undefined });
    try {
      expect(requestOpenSettings("mcp")).toBe(true);
      expect(requestOpenSettings("skills")).toBe(true);
      expect(openSettings).toHaveBeenNthCalledWith(1, "mcp");
      expect(openSettings).toHaveBeenNthCalledWith(2, "skills");
    } finally {
      dispose();
    }
  });

  it("renders unified PluginsSettingsPanel in SettingsModal across plugins, skills, and mcp initialPage", () => {
    const mcpHtml = renderToStaticMarkup(withQueryClient(createElement(SettingsModal, {
      settings: null,
      cwd: "/repo",
      initialPage: "mcp",
      onSave: () => undefined,
      onClose: () => undefined,
    })));
    expect(mcpHtml).toContain("扩展插件");
    expect(mcpHtml).toContain("Agent 技能");
    expect(mcpHtml).toContain("MCP 服务");
    expect(mcpHtml).toContain("MCP 服务桥接");
    expect(mcpHtml).toContain("工具调用安全确认");
    expect(mcpHtml).toContain("已配置服务器");
    expect(mcpHtml).toContain("一键挂载官方常用连接器");
    expect(mcpHtml).toContain("在线资源与提示词模板");

    const skillsHtml = renderToStaticMarkup(withQueryClient(createElement(SettingsModal, {
      settings: null,
      cwd: "/repo",
      initialPage: "skills",
      onSave: () => undefined,
      onClose: () => undefined,
    })));
    expect(skillsHtml).toContain("搜索技能名称、触发描述、/skill 指令或 SKILL.md 路径…");

    const pluginsHtml = renderToStaticMarkup(withQueryClient(createElement(SettingsModal, {
      settings: null,
      cwd: "/repo",
      initialPage: "plugins",
      onSave: () => undefined,
      onClose: () => undefined,
    })));
    expect(pluginsHtml).toContain("扩展插件");
    expect(pluginsHtml).toContain("官方插件");
    expect(pluginsHtml).toContain("项目级");
  });

  it("renders a single 扩展插件 sidebar button wired to main-stage navigation", () => {
    const withPluginsHtml = renderToStaticMarkup(withQueryClient(createElement(
      SidebarHeaderAndPopovers,
      makeSidebarHeaderProps({ onOpenPlugins: () => undefined, activeHub: "plugins" }),
    )));
    expect(withPluginsHtml).toContain("扩展插件");
    expect(withPluginsHtml).toContain("nav-item active");
    expect(withPluginsHtml).not.toContain("MCP 服务");
    expect(withPluginsHtml).not.toContain(">技能<");

    const withoutPluginsHtml = renderToStaticMarkup(withQueryClient(createElement(
      SidebarHeaderAndPopovers,
      makeSidebarHeaderProps({ onOpenPlugins: undefined }),
    )));
    expect(withoutPluginsHtml).not.toContain("扩展插件");
    expect(withoutPluginsHtml).not.toContain("MCP 服务");
  });

  it("renders standalone PluginsHubPage with unified module tabs and plugin filter tabs", () => {
    const hubHtml = renderToStaticMarkup(withQueryClient(createElement(PluginsHubPage, {
      cwd: "/repo",
    })));
    expect(hubHtml).toContain("扩展插件");
    expect(hubHtml).toContain("Agent 技能");
    expect(hubHtml).toContain("MCP 服务");
    expect(hubHtml).toContain("全部");
    expect(hubHtml).toContain("官方插件");
    expect(hubHtml).toContain("核心能力");
    expect(hubHtml).toContain("已安装");
    expect(hubHtml).toContain("项目级");
  });
});

describe("Host /mcp and /skills slash commands", () => {
  it("lists and executes /mcp and /skills built-in commands alongside enabled skills", async () => {
    tempRoot = mkdtempSync(join(tmpdir(), "qj-mcp-skills-cmd-"));
    const dataDir = join(tempRoot, "data");
    const workspace = join(tempRoot, "workspace");
    mkdirSync(dataDir, { recursive: true });
    mkdirSync(workspace, { recursive: true });

    const managerRef: { current: PluginManager | undefined } = { current: undefined };
    host = createHost({
      version: "0.3.0-test",
      dataDir,
      plugins: corePlugins(),
    });
    await host.start();

    manager = new PluginManager(host.ctx, {
      dataDir,
      version: "0.3.0-test",
      builtins: (ws) =>
        builtinPluginDefinitions(dataDir, readEffectiveHarnessConfig(dataDir, ws).config, {
          bundledSkillsDirs: [repoSkillsDir],
          gateway: {
            pageOrigins: [],
            token: Buffer.alloc(32, 7).toString("base64url"),
            manager: () => managerRef.current,
          },
        }),
    });
    managerRef.current = manager;
    await host.ctx.plugin(pluginsRpc, { manager });
    await manager.sync();

    const listed = await callRpc<CommandListResult>(host, "command.list", { cwd: workspace });
    expect(listed.commands).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: "mcp", source: "builtin" }),
      expect.objectContaining({ name: "skills", source: "builtin" }),
      expect.objectContaining({ name: "skill:qianji-plugin-development", source: "skill" }),
    ]));

    const mcpRun = await callRpc<CommandRunResult>(host, "command.run", {
      name: "mcp",
      cwd: workspace,
    });
    expect(mcpRun.handled).toBe(true);
    expect(mcpRun.output ?? "").toContain("MCP");

    const skillsRun = await callRpc<CommandRunResult>(host, "command.run", {
      name: "skills",
      cwd: workspace,
    });
    expect(skillsRun.handled).toBe(true);
    expect(skillsRun.output ?? "").toContain("已启用 Agent 技能");
    expect(skillsRun.output ?? "").toContain("/skill:qianji-plugin-development");
  });
});

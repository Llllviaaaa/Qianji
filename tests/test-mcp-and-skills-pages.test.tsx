import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createElement, createRef, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { QueryClientProvider } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  CommandListResult,
  CommandRunResult,
  PluginInfo,
  PluginMutationResult,
  SkillInfo,
  SkillListResult,
  SkillReadResult,
} from "@qianji/protocol";
import { builtinPluginDefinitions, corePlugins } from "../packages/host/src/agent-plugins.ts";
import { readEffectiveHarnessConfig } from "../packages/host/src/harness-config.ts";
import { createHost, type Host } from "../packages/host/src/host.ts";
import { PluginManager } from "../packages/host/src/plugin-manager.ts";
import { verifyPluginDirectory } from "../packages/host/src/plugin-verify.ts";
import * as pluginsRpc from "../packages/host/src/plugins-rpc.ts";
import { PluginsHubPage } from "../src/components/PluginsHubPage";
import { SettingsModal } from "../src/components/SettingsModal";
import { BUILTIN_SETTINGS_NAV } from "../src/components/settings/settingsNavigation";
import { SidebarHeaderAndPopovers, type SidebarHeaderAndPopoversProps } from "../src/components/sidebar/SidebarHeaderAndPopovers";
import { queryKeys } from "../src/lib/queries";
import { createQueryClient } from "../src/lib/queryClient";
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

function renderWithExtensionFixtures(cwd: string, element: ReactElement): string {
  const client = createQueryClient();
  const samplePlugins: PluginInfo[] = [
    {
      id: "mcp",
      name: "MCP 连接器 (mcp)",
      description: "连接 STDIO / HTTP MCP 服务器",
      version: "0.3.0",
      tier: "builtin",
      status: "active",
      enabled: true,
      overridesBuiltin: false,
      removable: false,
      hasHost: true,
      hasClient: false,
      watch: false,
    },
    {
      id: "prompt-context",
      name: "上下文与技能管理 (prompt-context)",
      description: "AGENTS.md、Rules 与 Agent Skills",
      version: "0.3.0",
      tier: "builtin",
      status: "active",
      enabled: true,
      overridesBuiltin: false,
      removable: false,
      hasHost: true,
      hasClient: false,
      watch: false,
    },
  ];
  const sampleSkills: SkillInfo[] = [
    {
      name: "deploy-check",
      description: "Release checklist",
      path: "/plugins/demo-pack/skills/deploy-check/SKILL.md",
      scope: "user",
      enabled: true,
      trusted: true,
      readOnly: true,
      pluginId: "demo-pack",
    },
    {
      name: "user-note",
      description: "Personal workflow",
      path: "/data/skills/user-note/SKILL.md",
      scope: "user",
      enabled: true,
      trusted: true,
    },
  ];
  client.setQueryData(queryKeys.plugins(cwd), samplePlugins);
  client.setQueryData(queryKeys.mcpStatus(), []);
  client.setQueryData(queryKeys.skills(cwd), sampleSkills);
  return renderToStaticMarkup(createElement(QueryClientProvider, { client }, element));
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

  it("renders unified PluginsSettingsPanel without top module tabs and auto-expands mcp / prompt-context drawers", () => {
    const mcpHtml = renderWithExtensionFixtures("/repo", createElement(SettingsModal, {
      settings: null,
      cwd: "/repo",
      initialPage: "mcp",
      onSave: () => undefined,
      onClose: () => undefined,
    }));
    expect(mcpHtml).toContain("扩展插件");
    expect(mcpHtml).not.toContain("aria-label=\"扩展能力模块\"");
    expect(mcpHtml).not.toContain("打开 MCP 服务面板");
    expect(mcpHtml).toContain("工具调用安全确认");
    expect(mcpHtml).toContain("已配置服务器");
    expect(mcpHtml).toContain("一键挂载官方常用连接器");
    expect(mcpHtml).toContain("高级能力探测（Resources · Prompts）");
    expect(mcpHtml).not.toContain("搜索技能、/skill 命令或插件来源…");

    const skillsHtml = renderWithExtensionFixtures("/repo", createElement(SettingsModal, {
      settings: null,
      cwd: "/repo",
      initialPage: "skills",
      onSave: () => undefined,
      onClose: () => undefined,
    }));
    expect(skillsHtml).not.toContain("aria-label=\"扩展能力模块\"");
    expect(skillsHtml).toContain("插件附带 1 项");
    expect(skillsHtml).toContain("搜索技能、/skill 命令或插件来源…");
    expect(skillsHtml).toContain("插件 · demo-pack");
    expect(skillsHtml).not.toContain("工具调用安全确认");

    const pluginsHtml = renderWithExtensionFixtures("/repo", createElement(SettingsModal, {
      settings: null,
      cwd: "/repo",
      initialPage: "plugins",
      onSave: () => undefined,
      onClose: () => undefined,
    }));
    expect(pluginsHtml).toContain("扩展插件");
    expect(pluginsHtml).not.toContain("aria-label=\"扩展能力模块\"");
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

  it("renders standalone PluginsHubPage with plugin filter tabs and no 3-module sub-tab bar", () => {
    const hubHtml = renderToStaticMarkup(withQueryClient(createElement(PluginsHubPage, {
      cwd: "/repo",
    })));
    expect(hubHtml).not.toContain("aria-label=\"扩展能力模块\"");
    expect(hubHtml).toContain("全部");
    expect(hubHtml).toContain("官方插件");
    expect(hubHtml).toContain("核心能力");
    expect(hubHtml).toContain("已安装");
    expect(hubHtml).toContain("项目级");
  });
});

describe("Host /mcp and /skills slash commands & companion plugin skills", () => {
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

  it("mounts companion skills from zero-code plugins and enforces read-only lifecycle", async () => {
    tempRoot = mkdtempSync(join(tmpdir(), "qj-plugin-skills-"));
    const dataDir = join(tempRoot, "data");
    const workspace = join(tempRoot, "workspace");
    const pluginDir = join(tempRoot, "team-playbook");
    const skillDir = join(pluginDir, "skills", "deploy-check");
    mkdirSync(dataDir, { recursive: true });
    mkdirSync(workspace, { recursive: true });
    mkdirSync(skillDir, { recursive: true });

    writeFileSync(
      join(pluginDir, "package.json"),
      JSON.stringify({
        name: "qianji-plugin-team-playbook",
        version: "0.1.0",
        qianji: {
          id: "team-playbook",
          name: "Team Playbook",
          skills: "./skills",
        },
      }),
      "utf8",
    );
    const skillFile = join(skillDir, "SKILL.md");
    writeFileSync(
      skillFile,
      "---\nname: deploy-check\ndescription: Pre-deploy verification checklist\n---\nCheck CI and migrations.\n",
      "utf8",
    );

    const report = await verifyPluginDirectory(pluginDir);
    expect(report.ok).toBe(true);
    expect(report.hasHost).toBe(false);
    expect(report.hasClient).toBe(false);
    expect(report.hasSkills).toBe(true);

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
          pluginManager: () => managerRef.current,
          bundledSkillsDirs: [repoSkillsDir],
          gateway: {
            pageOrigins: [],
            token: Buffer.alloc(32, 8).toString("base64url"),
            manager: () => managerRef.current,
          },
        }),
    });
    managerRef.current = manager;
    await host.ctx.plugin(pluginsRpc, { manager });
    await manager.sync();

    const installed = await callRpc<PluginMutationResult>(host, "plugin.install", {
      channel: "local",
      spec: pluginDir,
      link: true,
    });
    expect(installed.plugins).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "team-playbook", status: "active", hasSkills: true }),
    ]));

    const skillsAfterInstall = await callRpc<SkillListResult>(host, "skill.list", { cwd: workspace });
    const mountedSkill = skillsAfterInstall.skills.find((item) => item.name === "deploy-check");
    expect(mountedSkill).toMatchObject({
      name: "deploy-check",
      pluginId: "team-playbook",
      readOnly: true,
      enabled: true,
    });

    const cmdsAfterInstall = await callRpc<CommandListResult>(host, "command.list", { cwd: workspace });
    expect(cmdsAfterInstall.commands).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: "skill:deploy-check", source: "skill" }),
    ]));

    const readResult = await callRpc<SkillReadResult>(host, "skill.read", {
      path: skillFile,
      cwd: workspace,
    });
    expect(readResult.content).toContain("Check CI and migrations.");

    await expect(
      callRpc(host, "skill.save", {
        path: skillFile,
        content: "---\ndescription: modified\n---\nhacked\n",
        cwd: workspace,
      }),
    ).rejects.toThrow();
    await expect(
      callRpc(host, "skill.delete", { path: skillFile, cwd: workspace }),
    ).rejects.toThrow();

    const toggledOff = await callRpc<SkillListResult>(host, "skill.toggle", {
      path: skillFile,
      enabled: false,
      cwd: workspace,
    });
    expect(toggledOff.skills.find((item) => item.name === "deploy-check")?.enabled).toBe(false);
    const cmdsAfterToggleOff = await callRpc<CommandListResult>(host, "command.list", { cwd: workspace });
    expect(cmdsAfterToggleOff.commands.some((item) => item.name === "skill:deploy-check")).toBe(false);

    await callRpc<SkillListResult>(host, "skill.toggle", {
      path: skillFile,
      enabled: true,
      cwd: workspace,
    });

    await callRpc<PluginMutationResult>(host, "plugin.disable", { id: "team-playbook" });
    const skillsAfterDisable = await callRpc<SkillListResult>(host, "skill.list", { cwd: workspace });
    expect(skillsAfterDisable.skills.some((item) => item.name === "deploy-check")).toBe(false);
    const cmdsAfterDisable = await callRpc<CommandListResult>(host, "command.list", { cwd: workspace });
    expect(cmdsAfterDisable.commands.some((item) => item.name === "skill:deploy-check")).toBe(false);
  });
});

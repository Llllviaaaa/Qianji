/**
 * Built-in capability & policy feature plugin definitions mounted by `PluginManager`
 * (extracted from `agent-plugins.ts` to keep every module comfortably below the
 * repository's 500-line file-size budget).
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Context } from "@deepseek-ai/cordis";
import * as browser from "@qianji/browser";
import * as computer from "@qianji/computer";
import * as hooks from "@qianji/hooks";
import * as intelligentUi from "@qianji/intelligent-ui";
import type { Credentials } from "@qianji/llm";
import { Mcp, type Config as McpPluginConfig, type McpServerConfig } from "@qianji/mcp";
import * as memory from "@qianji/memory";
import { Permissions } from "@qianji/permissions";
import * as plan from "@qianji/plan";
import * as promptContext from "@qianji/prompt-context";
import { Schedule } from "@qianji/schedule";
import * as subagents from "@qianji/subagents";
import * as swarm from "@qianji/swarm";
import * as toolGuards from "@qianji/tool-guards";
import * as toolOutput from "@qianji/tool-output";
import type { BuiltinPluginDefinition, FeatureOptions } from "./agent-plugins.ts";
import * as botPlugin from "./bot/index.ts";
import { resolveDesktopBundledSkillRoots, resolveDesktopPluginTypesDir } from "./control.ts";
import type { HarnessConfig } from "./harness-config.ts";
import { bashSandboxPlugin } from "./host-plugins.ts";
import { McpOAuthTokenStore } from "./mcp-oauth-store.ts";
import * as pluginDevTools from "./plugin-dev-tools.ts";
import * as providers from "./providers.ts";
import { readSecretFile, type McpServerSecrets } from "./secrets.ts";

const mcpHostPlugin = {
  name: "qianji-mcp-host",
  inject: ["sessions", "tools", "ui"],
  apply(ctx: Context, cfg: McpPluginConfig) {
    const authProvider = new McpOAuthTokenStore(() => ctx.get("credentials") as Credentials | undefined);
    ctx.plugin(Mcp, { ...cfg, authProvider });
  },
};

/** MCP servers with their env and headers from the desktop's encrypted secrets, in memory only. */
export function withMcpSecrets(servers: readonly McpServerConfig[], secrets: Record<string, McpServerSecrets>): McpServerConfig[] {
  return servers.map((server) => {
    const stored = secrets[server.id];
    if (stored === undefined) return server;
    return { ...server, env: { ...server.env, ...stored.env }, headers: { ...server.headers, ...stored.headers } };
  });
}

function fileRevision(file: string): string {
  try {
    return readFileSync(file, "utf8");
  } catch {
    return "";
  }
}

/** Built-in capability & policy plugins configured via `harness.json` and `providers.json`. */
export function builtinFeatureDefinitions(dataDir: string, config: HarnessConfig, options: FeatureOptions = {}): BuiltinPluginDefinition[] {
  const providersFile = join(dataDir, "providers.json");
  const permissions = options.permission === undefined ? config.permissions : { ...config.permissions, defaultPermission: options.permission };
  const { secretsFile, ...mcpConfig } = config.mcp;
  const mcpSecrets = secretsFile !== undefined && options.codec !== undefined
    ? readSecretFile<Record<string, McpServerSecrets>>(secretsFile, options.codec)
    : {};

  const definitions: Array<BuiltinPluginDefinition | false> = [
    {
      id: "providers",
      name: "模型服务商路由 (providers)",
      description: "加载 providers.json 并按已启用协议插件动态实例化模型适配器与密钥解析",
      // The file's text is part of the config so an edited providers.json reloads the adapters.
      enabled: true,
      hasHost: true,
      hasClient: false,
      plugin: providers,
      inject: ["llm", "credentials"],
      config: {
        file: providersFile,
        revision: fileRevision(providersFile),
        ...(options.autoRegisterBuiltinProtocols === undefined ? {} : { autoRegisterBuiltinProtocols: options.autoRegisterBuiltinProtocols }),
        ...(config.llm === undefined ? {} : { llm: config.llm }),
      },
    },
    {
      id: "permissions",
      name: "工具权限策略 (permissions)",
      description: "执行会话读写、命令白名单与自定义工具审批门禁",
      enabled: true,
      hasHost: true,
      hasClient: false,
      plugin: Permissions,
      inject: ["sessions", "tools", "ui", "systemPrompt"],
      provides: ["permissions"],
      config: permissions,
    },
    {
      id: "prompt-context",
      name: "上下文与技能管理 (prompt-context)",
      description: "注入工作区上下文（AGENTS.md / CLAUDE.md / .local 与 @path 引用）、路径规则（rules）、技能与 /init 指令",
      enabled: true,
      hasHost: true,
      hasClient: false,
      plugin: promptContext,
      inject: ["systemPrompt"],
      config: {
        dataDir,
        contextFiles: config.contextFiles.enabled,
        instructions: config.prompt.instructions,
        bundledSkillsDirs: options.bundledSkillsDirs ?? (() => resolveDesktopBundledSkillRoots()),
        pluginSkills: (cwd?: string) => {
          const manager = options.pluginManager?.();
          if (!manager) return [];
          return manager.activeSkillRoots(cwd, "agent").map((root) => ({
            pluginId: root.pluginId,
            dir: root.dir,
            scope: root.tier === "workspace" ? "project" : root.tier === "builtin" ? "builtin" : "user",
          }));
        },
      },
    },
    {
      id: "plugin-dev-tools",
      name: "Agent 插件自省与开发工具 (plugin-dev-tools)",
      description: "提供免审运行时自省工具 qianji_inspect 与按需加载的插件生命周期管理工具 plugin_manager",
      enabled: true,
      hasHost: true,
      hasClient: false,
      plugin: pluginDevTools,
      inject: ["tools", "sessions", "ui"],
      config: {
        manager: options.pluginManager ?? (() => undefined),
        pluginTypesDir: options.pluginTypesDir ?? (() => resolveDesktopPluginTypesDir()),
      },
    },
    {
      id: "tool-output",
      name: "工具输出上限 (tool-output)",
      description: "截断超长的工具输出，全文存到 spill 目录，避免一次工具调用撑爆上下文",
      enabled: true,
      hasHost: true,
      hasClient: false,
      plugin: toolOutput,
      inject: ["tools"],
      config: { spillDir: join(dataDir, "spill") },
    },
    {
      id: "tool-guards",
      name: "工具调用保护 (tool-guards)",
      description: "给工具调用设时限，并在模型连续重复完全相同的调用时提醒它换个办法",
      enabled: true,
      hasHost: true,
      hasClient: false,
      plugin: toolGuards,
      inject: ["tools"],
      config: {},
    },
    {
      id: "plan",
      name: "任务计划追踪 (plan)",
      description: "提供 update_plan 工具并在对话提示词中维护分步计划状态",
      enabled: config.plan.enabled,
      hasHost: true,
      hasClient: false,
      plugin: plan,
      inject: ["sessions", "tools", "systemPrompt"],
    },
    {
      id: "intelligent-ui",
      name: "Intelligent UI 交互式界面 (intelligent-ui)",
      description: "支持在对话流内生成可交互计算器、动态图表、参数表单与安全沙箱微应用，支持多版本切换与右侧画布展开",
      enabled: config.intelligentUi.enabled,
      hasHost: true,
      hasClient: true,
      plugin: intelligentUi,
      inject: ["sessions", "tools", "systemPrompt"],
    },
    {
      id: "bot-mode",
      name: "千机常驻分身 (bot-mode)",
      description: "提供常驻主聊天与旁聊、SOUL 人格契约、异步批准队列、主动情报流与本地/远端虚拟服务器管控服务",
      enabled: config.bot.enabled !== false,
      hasHost: true,
      hasClient: true,
      plugin: botPlugin,
      inject: ["sessions", "tools"],
      provides: ["botHarness"],
      config: Object.assign(
        {
          dataDir,
          ...(options.scheduler === undefined ? {} : { defaultModel: options.scheduler.defaultModel }),
          ...(options.pluginManager === undefined ? {} : { pluginManager: options.pluginManager }),
          ...((config.computer.helper ?? options.computerHelper) === undefined
            ? {}
            : { computerHelperPath: config.computer.helper ?? options.computerHelper }),
        },
        Object.fromEntries(
          (["displayName", "avatarPreset", "serverMode", "localCpuCores", "localMemoryGb", "localDiskGb", "autoSleepIdle", "remoteHost", "remotePort", "remoteUser", "remoteWorkDir", "workspaceDir", "storageDir"] as const)
            .flatMap((k) => (config.bot[k] === undefined ? [] : [[k, config.bot[k]]])),
        ),
      ),
    },
    {
      id: "memory",
      name: "本地长期记忆 (memory)",
      description: "维护并向系统提示词注入持久化的全局与项目记忆文件",
      enabled: true,
      hasHost: true,
      hasClient: false,
      plugin: memory,
      inject: ["tools", "systemPrompt"],
      config: {
        file: config.memory.file ?? join(dataDir, "memory.md"),
        userEnabled: config.memory.enabled,
        projectEnabled: config.memory.projectEnabled ?? config.memory.enabled,
        ...(config.memory.inlineMaxChars === undefined ? {} : { inlineMaxChars: config.memory.inlineMaxChars }),
        ...(options.isWorkspaceTrusted === undefined ? {} : { isTrusted: options.isWorkspaceTrusted }),
      },
    },
    {
      id: "subagents",
      name: "并行子代理 (subagents)",
      description: "支持派发受并发控制的子会话代理执行独立探索或编码子任务",
      enabled: config.subagents.enabled,
      hasHost: true,
      hasClient: false,
      plugin: subagents,
      inject: ["sessions", "agents", "tools"],
      config: config.subagents,
    },
    {
      id: "swarm",
      name: "多智能体蜂群协同 (swarm)",
      description: "提供协调者与具名成员编排、零轮询消息板门铃唤醒、共享任务看板、角色级 Git Worktree 隔离与卡死看门狗",
      enabled: true,
      canDisable: true,
      canOverride: true,
      hasHost: true,
      hasClient: true,
      plugin: swarm,
      inject: ["sessions", "agents", "tools", "commands", "systemPrompt"],
      provides: ["swarm"],
      config: { dataDir },
    },
    {
      id: "mcp",
      name: "MCP 服务器桥接 (mcp)",
      description: "连接 STDIO 与 HTTP MCP 服务器并将其工具暴露给模型",
      enabled: config.mcp.enabled !== false,
      hasHost: true,
      hasClient: false,
      plugin: mcpHostPlugin,
      inject: ["sessions", "tools", "ui"],
      provides: ["mcp"],
      config: { ...mcpConfig, servers: withMcpSecrets(mcpConfig.servers ?? [], mcpSecrets) },
    },
    {
      id: "computer",
      name: "本机桌面控制 (computer)",
      description: "提供桌面截图、窗口焦点与键鼠自动化工具",
      enabled: config.computer.enabled,
      hasHost: true,
      hasClient: false,
      plugin: computer,
      inject: ["tools", "ui", "sessions"],
      config: { ...config.computer, helper: config.computer.helper ?? options.computerHelper },
    },
    {
      id: "browser",
      name: "内置自动化浏览器 (browser)",
      description: "基于本机 Edge/Chrome CDP 提供网页浏览与交互工具",
      enabled: config.browser.enabled,
      hasHost: true,
      hasClient: false,
      plugin: browser,
      inject: ["tools", "ui", "sessions"],
      config: config.browser,
    },
    {
      id: "hooks",
      name: "生命周期命令钩子 (hooks)",
      description: "在会话轮次与工具执行前后触发用户自定义脚本",
      enabled: true,
      hasHost: true,
      hasClient: false,
      plugin: hooks,
      config: config.hooks,
    },
    {
      id: "sandbox",
      name: "Windows 轻量沙箱 (sandbox)",
      description: "为 bash 工具启用环境变量脱敏、Job Object 进程数限制与高危系统命令拦截",
      enabled: config.sandbox.enabled,
      hasHost: true,
      hasClient: false,
      plugin: bashSandboxPlugin,
      inject: ["tools", "sessions"],
    },
    options.scheduler !== undefined && {
      id: "schedule",
      name: "本地定时任务 (schedule)",
      description: "按周期调度后台无人值守会话并记录运行历史",
      enabled: config.schedule.enabled,
      hasHost: true,
      hasClient: false,
      plugin: Schedule,
      inject: ["sessions", "agents", "ui"],
      provides: ["schedule"],
      config: {
        tasksFile: join(dataDir, "schedules.json"),
        runsFile: join(dataDir, "schedule-runs.jsonl"),
        defaultModel: options.scheduler.defaultModel,
      },
    },
  ];
  return definitions.filter((entry): entry is BuiltinPluginDefinition => entry !== false);
}

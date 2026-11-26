/**
 * Minimal pure-spine Core + isomorphic pluggable plugin catalog.
 *
 * `corePlugins()` contains ONLY the 7 pure in-memory buses (credentials slot,
 * LLM slot, in-memory sessions, UI bus, tool bus, slash command bus, and system
 * prompt builder). The agent execution loop (`agent-loop`) and every concrete
 * model protocol, pricing catalog, storage backend, full-text search index,
 * filesystem/shell tool, Git checkpointing, security policy, and HTTP/WebSocket
 * RPC gateway are first-class `PluginManager`-managed plugins (`builtinPluginDefinitions`).
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Plugin } from "@deepseek-ai/cordis";
import { AgentLoop } from "@qianji/agent-loop";
import * as browser from "@qianji/browser";
import * as checkpoints from "@qianji/checkpoints";
import { Commands } from "@qianji/commands";
import * as computer from "@qianji/computer";
import * as hooks from "@qianji/hooks";
import * as intelligentUi from "@qianji/intelligent-ui";
import { Credentials, LlmService, type LlmServiceConfig } from "@qianji/llm";
import * as llmAnthropic from "@qianji/llm-anthropic";
import * as llmGemini from "@qianji/llm-gemini";
import * as llmOpenaiCompat from "@qianji/llm-openai-compat";
import * as llmOpenaiResponses from "@qianji/llm-openai-responses";
import { Mcp, type McpServerConfig } from "@qianji/mcp";
import * as memory from "@qianji/memory";
import { Permissions, type PermissionMode } from "@qianji/permissions";
import * as plan from "@qianji/plan";
import { Pricing } from "@qianji/pricing";
import * as promptContext from "@qianji/prompt-context";
import { Schedule } from "@qianji/schedule";
import { Sessions } from "@qianji/session";
import * as sessionJsonl from "@qianji/session-jsonl";
import * as sessionSearchFts from "@qianji/session-search-fts";
import * as subagents from "@qianji/subagents";
import { SystemPrompt } from "@qianji/system-prompt";
import * as toolBash from "@qianji/tool-bash";
import * as toolFs from "@qianji/tool-fs";
import * as toolGuards from "@qianji/tool-guards";
import * as toolOutput from "@qianji/tool-output";
import { Tools } from "@qianji/tools";
import { Ui } from "@qianji/ui";
import * as botPlugin from "./bot/index.ts";
import { resolveDesktopBundledSkillRoots, resolveDesktopPluginTypesDir } from "./control.ts";
import { gatewayRpcDefinitions } from "./gateway-rpc-plugins.ts";
import { bashSandboxPlugin, secretStore } from "./host-plugins.ts";
import type { HarnessConfig } from "./harness-config.ts";
import type { PluginEntry } from "./host.ts";
import * as pluginDevTools from "./plugin-dev-tools.ts";
import type { PluginManager } from "./plugin-manager.ts";
import * as providers from "./providers.ts";
import type { ReloadableEntry } from "./reloadable.ts";
import { RpcGateway } from "./rpc.ts";
import { readSecretFile, type McpServerSecrets, type SecretCodec } from "./secrets.ts";
import { WebServer } from "./web-server.ts";

export interface CoreOptions {
  /** DPAPI, when the host runs in Bun on Windows; `{ secret }` refs then resolve against secrets.dat. */
  codec?: SecretCodec;
  /** Optional `LlmService` configuration (retry budgets, `fallbackModels`, `fallbackCooldownMs`). */
  llm?: LlmServiceConfig;
}

/** Minimal 7-bus pure in-memory Core spine. */
export function corePlugins(_dataDir?: string, options?: CoreOptions): PluginEntry[] {
  const llmEntry: PluginEntry = options?.llm === undefined ? [LlmService] : [LlmService, options.llm];
  return [[Credentials], llmEntry, [Sessions], [Ui], [Tools], [Commands], [SystemPrompt]];
}

export interface GatewayOptions {
  pageOrigins: readonly string[];
  token: string;
  defaultModel?: () => { provider: string; model: string } | undefined;
  manager?: () => PluginManager | undefined;
  reload?: () => Promise<string[]>;
}

export interface FeatureOptions {
  /** Overrides the configured default permission mode (headless `--permission`). */
  permission?: PermissionMode;
  /** Run scheduled tasks: only the long-running host does, never a headless run. */
  scheduler?: { defaultModel: () => { provider: string; model: string } | undefined };
  /** Where the computer helper is when harness.json does not say (`PID_COMPUTER_HELPER`). */
  computerHelper?: string;
  /** Decrypts the desktop's MCP secrets file, when one is configured. */
  codec?: SecretCodec;
  /** Optional workspace trust checker for project-scoped memory. */
  isWorkspaceTrusted?: (cwd: string) => boolean;
  /** When false, `providers` relies strictly on mounted `llm-*` protocol plugins. */
  autoRegisterBuiltinProtocols?: boolean;
  /** Optional bundled read-only skill roots (`skills/` in dev or `bundled-skills/` in release). */
  bundledSkillsDirs?: readonly string[] | (() => readonly string[]);
  /** Optional live `PluginManager` getter for `qianji_inspect` and `plugin_manager`. */
  pluginManager?: () => PluginManager | undefined;
  /** Optional path to generated offline `plugin-types/` declarations for `scaffold`. */
  pluginTypesDir?: string | (() => string | undefined);
}

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

export interface BuiltinPluginDefinition {
  id: string;
  name: string;
  description: string;
  enabled: boolean;
  /** False when disabling this built-in would sever core execution or the active HTTP/RPC control plane. */
  canDisable?: boolean;
  /** True when a user/workspace plugin with the same `id` may override this built-in (defaults to `canDisable !== false`). */
  canOverride?: boolean;
  hasHost: boolean;
  hasClient: boolean;
  plugin: Plugin;
  config?: unknown;
  inject?: readonly string[];
  provides?: readonly string[];
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
          return manager.activeSkillRoots(cwd).map((root) => ({
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
      config: {
        dataDir,
        ...(config.bot.displayName === undefined ? {} : { displayName: config.bot.displayName }),
        ...(config.bot.avatarPreset === undefined ? {} : { avatarPreset: config.bot.avatarPreset }),
        ...(config.bot.serverMode === undefined ? {} : { serverMode: config.bot.serverMode }),
        ...(config.bot.localCpuCores === undefined ? {} : { localCpuCores: config.bot.localCpuCores }),
        ...(config.bot.localMemoryGb === undefined ? {} : { localMemoryGb: config.bot.localMemoryGb }),
        ...(config.bot.localDiskGb === undefined ? {} : { localDiskGb: config.bot.localDiskGb }),
        ...(config.bot.autoSleepIdle === undefined ? {} : { autoSleepIdle: config.bot.autoSleepIdle }),
        ...(config.bot.remoteHost === undefined ? {} : { remoteHost: config.bot.remoteHost }),
        ...(config.bot.remotePort === undefined ? {} : { remotePort: config.bot.remotePort }),
        ...(config.bot.remoteUser === undefined ? {} : { remoteUser: config.bot.remoteUser }),
        ...(config.bot.remoteWorkDir === undefined ? {} : { remoteWorkDir: config.bot.remoteWorkDir }),
      },
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
      id: "mcp",
      name: "MCP 服务器桥接 (mcp)",
      description: "连接 STDIO 与 HTTP MCP 服务器并将其工具暴露给模型",
      enabled: config.mcp.enabled !== false,
      hasHost: true,
      hasClient: false,
      plugin: Mcp,
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

/**
 * Complete isomorphic catalog of ALL built-in plugins managed by `PluginManager`.
 */
export function builtinPluginDefinitions(
  dataDir: string,
  config: HarnessConfig,
  options: CoreOptions & FeatureOptions & { gateway?: GatewayOptions } = {},
): BuiltinPluginDefinition[] {
  const gateway = options.gateway;
  const baseDefinitions: Array<BuiltinPluginDefinition | false> = [
    gateway !== undefined && {
      id: "web-server",
      name: "本地 HTTP 静态与升级网关 (web-server)",
      description: "提供受来源门禁保护的本地回环 HTTP 路由与 WebSocket 升级入口",
      enabled: true,
      canDisable: false,
      hasHost: true,
      hasClient: false,
      plugin: WebServer,
      provides: ["webServer"],
      config: { pageOrigins: gateway.pageOrigins },
    },
    gateway !== undefined && {
      id: "rpc-gateway",
      name: "JSON-RPC 通信网关 (rpc-gateway)",
      description: "通过令牌鉴权 WebSocket 向客户端与外部工具暴露标准 JSON-RPC 总线",
      enabled: true,
      canDisable: false,
      hasHost: true,
      hasClient: false,
      plugin: RpcGateway,
      inject: ["webServer", "hostInfo"],
      provides: ["rpc"],
      config: { token: gateway.token },
    },
    options.codec !== undefined && {
      id: "secret-store",
      name: "系统加密凭据库 (secret-store)",
      description: "解析 secrets.dat 中受系统 DPAPI 加密保护的模型与服务密钥引用",
      enabled: true,
      hasHost: true,
      hasClient: false,
      plugin: secretStore,
      inject: ["credentials"],
      config: { file: join(dataDir, "secrets.dat"), codec: options.codec },
    },
    {
      id: "agent-loop",
      name: "Agent 主循环引擎 (agent-loop)",
      description: "驱动流式模型推理、并行工具编排、上下文自动压缩与引导排队的核心执行循环",
      enabled: true,
      canDisable: false,
      canOverride: true,
      hasHost: true,
      hasClient: false,
      plugin: AgentLoop,
      inject: ["llm", "sessions", "tools", "systemPrompt"],
      provides: ["agents"],
      ...(config.agentLoop === undefined ? {} : { config: config.agentLoop }),
    },
    {
      id: "llm-openai-compat",
      name: "OpenAI Chat Completions 协议 (llm-openai-compat)",
      description: "为 OpenAI 兼容接口（DeepSeek / Qwen / Ollama / vLLM 等）提供流式适配器",
      enabled: true,
      hasHost: true,
      hasClient: false,
      plugin: llmOpenaiCompat,
      inject: ["llm", "credentials"],
    },
    {
      id: "llm-openai-responses",
      name: "OpenAI Responses 协议 (llm-openai-responses)",
      description: "为 OpenAI Responses API（GPT-5 / o-series 等）提供流式推理适配器",
      enabled: true,
      hasHost: true,
      hasClient: false,
      plugin: llmOpenaiResponses,
      inject: ["llm", "credentials"],
    },
    {
      id: "llm-anthropic",
      name: "Anthropic Messages 协议 (llm-anthropic)",
      description: "为 Claude 系列模型提供原生 Messages 流式与缓存适配器",
      enabled: true,
      hasHost: true,
      hasClient: false,
      plugin: llmAnthropic,
      inject: ["llm", "credentials"],
    },
    {
      id: "llm-gemini",
      name: "Google Gemini 协议 (llm-gemini)",
      description: "为 Gemini 系列模型提供原生 GenerateContent 流式适配器",
      enabled: true,
      hasHost: true,
      hasClient: false,
      plugin: llmGemini,
      inject: ["llm", "credentials"],
    },
    {
      id: "pricing",
      name: "离线模型计费估算 (pricing)",
      description: "监听模型调用用量并结合内置或自定义费率表估算会话成本",
      enabled: true,
      hasHost: true,
      hasClient: false,
      plugin: Pricing,
      provides: ["pricing"],
    },
    {
      id: "session-jsonl",
      name: "JSONL 会话持久化 (session-jsonl)",
      description: "将会话事件以纯顺序追加 JSONL 方式写入本地磁盘，零主线程阻塞",
      enabled: true,
      hasHost: true,
      hasClient: false,
      plugin: sessionJsonl,
      inject: ["sessions"],
      config: { dir: join(dataDir, "sessions") },
    },
    {
      id: "session-search-fts",
      name: "异步全文检索索引 (session-search-fts)",
      description: "在后台防抖增量构建 SQLite FTS5 中英双语全文检索索引，随时可独立停用",
      enabled: true,
      hasHost: true,
      hasClient: false,
      plugin: sessionSearchFts,
      inject: ["sessions"],
      provides: ["sessionSearch"],
      config: { sessionsDir: join(dataDir, "sessions"), indexFile: join(dataDir, "index.sqlite") },
    },
    {
      id: "tool-fs",
      name: "本地文件读写工具集 (tool-fs)",
      description: "提供 read、write、edit、ls、find 与 grep 本地工作区文件工具",
      enabled: true,
      hasHost: true,
      hasClient: false,
      plugin: toolFs,
      inject: ["tools"],
    },
    {
      id: "tool-bash",
      name: "本地命令执行工具 (tool-bash)",
      description: "提供 bash 命令行执行工具与沙箱配置文件生成接口",
      enabled: true,
      hasHost: true,
      hasClient: false,
      plugin: toolBash,
      inject: ["tools"],
      config: { spillDir: join(dataDir, "spill") },
    },
    {
      id: "checkpoints",
      name: "Git 代码快照回退 (checkpoints)",
      description: "在每轮可写任务前自动创建无侵入 Git 快照，支持按消息一键查看差异与回滚",
      enabled: true,
      hasHost: true,
      hasClient: false,
      plugin: checkpoints,
      inject: ["sessions", "agents"],
    },
    ...builtinFeatureDefinitions(dataDir, config, {
      ...options,
      ...(options.pluginManager === undefined && gateway?.manager !== undefined ? { pluginManager: gateway.manager } : {}),
      autoRegisterBuiltinProtocols: false,
    }),
    ...gatewayRpcDefinitions(dataDir, gateway, options),
  ];
  return baseDefinitions.filter((entry): entry is BuiltinPluginDefinition => entry !== false);
}

/** The configured feature plugins, keyed so a reload only touches what changed. */
export function featureEntries(dataDir: string, config: HarnessConfig, options: FeatureOptions = {}): ReloadableEntry[] {
  return builtinFeatureDefinitions(dataDir, config, options)
    .filter((entry) => entry.enabled)
    .map((entry) => ({ key: entry.id, plugin: entry.plugin, ...(entry.config === undefined ? {} : { config: entry.config }) }));
}

/** Core spine and full built-in plugin set at once, for direct programmatic hosts/tests. */
export function agentPlugins(dataDir: string, options: CoreOptions & FeatureOptions & { config: HarnessConfig }): PluginEntry[] {
  const llm = options.llm ?? options.config.llm;
  return [
    ...corePlugins(dataDir, llm === undefined ? options : { ...options, llm }),
    ...builtinPluginDefinitions(dataDir, options.config, options)
      .filter((entry) => entry.enabled)
      .map((entry): PluginEntry => [entry.plugin, entry.config]),
  ];
}

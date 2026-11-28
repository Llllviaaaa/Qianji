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
import { join } from "node:path";
import type { Plugin } from "@deepseek-ai/cordis";
import { AgentLoop } from "@qianji/agent-loop";
import * as checkpoints from "@qianji/checkpoints";
import { Commands } from "@qianji/commands";
import { Credentials, LlmService, type LlmServiceConfig } from "@qianji/llm";
import * as llmAnthropic from "@qianji/llm-anthropic";
import * as llmGemini from "@qianji/llm-gemini";
import * as llmOpenaiCompat from "@qianji/llm-openai-compat";
import * as llmOpenaiResponses from "@qianji/llm-openai-responses";
import type { PermissionMode } from "@qianji/permissions";
import { Pricing } from "@qianji/pricing";
import { Sessions } from "@qianji/session";
import * as sessionJsonl from "@qianji/session-jsonl";
import * as sessionSearchFts from "@qianji/session-search-fts";
import { SystemPrompt } from "@qianji/system-prompt";
import * as toolBash from "@qianji/tool-bash";
import * as toolFs from "@qianji/tool-fs";
import { Tools } from "@qianji/tools";
import { Ui } from "@qianji/ui";
import { builtinFeatureDefinitions, withMcpSecrets } from "./builtin-feature-defs.ts";
import { gatewayRpcDefinitions } from "./gateway-rpc-plugins.ts";
import type { HarnessConfig } from "./harness-config.ts";
import { secretStore } from "./host-plugins.ts";
import type { PluginEntry } from "./host.ts";
import type { PluginManager } from "./plugin-manager.ts";
import type { ReloadableEntry } from "./reloadable.ts";
import { RpcGateway } from "./rpc.ts";
import type { SecretCodec } from "./secrets.ts";
import * as swarmRpcPlugin from "./swarm-rpc.ts";
import { WebServer } from "./web-server.ts";

export { builtinFeatureDefinitions, swarmRpcPlugin, withMcpSecrets };

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
    gateway !== undefined && {
      id: "swarm-rpc",
      name: "多智能体蜂群 RPC 服务 (swarm-rpc)",
      description: "暴露 swarm.* 控制接口并推送实时蜂群状态、看板与消息板通知",
      enabled: true,
      hasHost: true,
      hasClient: false,
      plugin: swarmRpcPlugin,
      inject: ["rpc", "swarm"],
    },
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
export function agentPlugins(
  dataDir: string,
  options: CoreOptions & FeatureOptions & { config: HarnessConfig; gateway?: GatewayOptions },
): PluginEntry[] {
  const llm = options.llm ?? options.config.llm;
  return [
    ...corePlugins(dataDir, llm === undefined ? options : { ...options, llm }),
    ...builtinPluginDefinitions(dataDir, options.config, options)
      .filter((entry) => entry.enabled)
      .map((entry): PluginEntry => [entry.plugin, entry.config]),
  ];
}

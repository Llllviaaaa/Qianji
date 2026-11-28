/**
 * HTTP/WebSocket RPC gateway endpoint plugin definitions mounted by `builtinPluginDefinitions`.
 * Extracted to keep `agent-plugins.ts` within the repository's 500-line module budget.
 */
import { join } from "node:path";
import type { BuiltinPluginDefinition, CoreOptions, FeatureOptions, GatewayOptions } from "./agent-plugins.ts";
import * as commandsRpc from "./commands-rpc.ts";
import * as diagnostics from "./diagnostics.ts";
import { configRpcPlugin } from "./host-plugins.ts";
import * as llmRpc from "./llm-rpc.ts";
import * as providerAdmin from "./provider-admin.ts";
import * as sessionsRpc from "./sessions-rpc.ts";
import * as uiRpc from "./ui-rpc.ts";
import * as workbenchRpc from "./workbench-rpc.ts";

export function gatewayRpcDefinitions(
  dataDir: string,
  gateway: GatewayOptions | undefined,
  options: CoreOptions & FeatureOptions,
): Array<BuiltinPluginDefinition | false> {
  const providersFile = join(dataDir, "providers.json");
  return [
    gateway !== undefined && {
      id: "sessions-rpc",
      name: "会话与用量 RPC 服务 (sessions-rpc)",
      description: "暴露 session.*、model.* 与 usage.summary 会话控制接口",
      enabled: true,
      hasHost: true,
      hasClient: false,
      plugin: sessionsRpc,
      inject: ["rpc", "sessions", "agents", "llm"],
      config: gateway.defaultModel === undefined ? {} : { defaultModel: gateway.defaultModel },
    },
    gateway !== undefined && {
      id: "commands-rpc",
      name: "斜杠命令 RPC 服务 (commands-rpc)",
      description: "暴露 command.list 与 command.execute 斜杠命令接口",
      enabled: true,
      hasHost: true,
      hasClient: false,
      plugin: commandsRpc,
      inject: ["rpc", "commands"],
      config: gateway.manager === undefined ? {} : { manager: gateway.manager },
    },
    gateway !== undefined && {
      id: "ui-rpc",
      name: "交互审批 RPC 服务 (ui-rpc)",
      description: "暴露 ui.pending 与 ui.respond 工具审批及询问回传接口",
      enabled: true,
      hasHost: true,
      hasClient: false,
      plugin: uiRpc,
      inject: ["rpc", "ui"],
    },
    gateway !== undefined && {
      id: "diagnostics",
      name: "宿主诊断与日志服务 (diagnostics)",
      description: "暴露 diagnostics.logs 与 diagnostics.export 宿主运行诊断接口",
      enabled: true,
      hasHost: true,
      hasClient: false,
      plugin: diagnostics,
      inject: ["rpc", "hostInfo"],
    },
    gateway !== undefined && {
      id: "llm-rpc",
      name: "直连模型补全 RPC 服务 (llm-rpc)",
      description: "暴露 llm.complete 轻量单轮补全接口（如会话自动命名与提交摘要）",
      enabled: true,
      hasHost: true,
      hasClient: false,
      plugin: llmRpc,
      inject: ["rpc", "llm"],
      config: gateway.defaultModel === undefined ? {} : { defaultModel: gateway.defaultModel },
    },
    gateway !== undefined && {
      id: "provider-admin",
      name: "模型服务商管理接口 (provider-admin)",
      description: "暴露 provider.save、provider.delete 与在线连接测试管理接口",
      enabled: true,
      hasHost: true,
      hasClient: false,
      plugin: providerAdmin,
      inject: ["rpc", "credentials"],
      config: {
        file: providersFile,
        secretsFile: join(dataDir, "secrets.dat"),
        ...(options.codec === undefined ? {} : { codec: options.codec }),
        reload: gateway.reload ?? (async () => []),
      },
    },
    gateway?.reload !== undefined && {
      id: "config-rpc",
      name: "配置热重载接口 (config-rpc)",
      description: "暴露 config.reload 触发插件与配置同步",
      enabled: true,
      hasHost: true,
      hasClient: false,
      plugin: configRpcPlugin,
      inject: ["rpc"],
      config: { reload: gateway.reload },
    },
    gateway !== undefined && {
      id: "workbench",
      name: "原生工作台联动 (workbench)",
      description: "提供 sidebar_open 工具与 workbench/open 工作台面板联动通知",
      enabled: true,
      hasHost: true,
      hasClient: false,
      plugin: workbenchRpc,
      inject: ["rpc", "tools", "sessions"],
    },
  ];
}

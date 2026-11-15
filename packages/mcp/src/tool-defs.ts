/**
 * Extracted MCP tool definition builders, permission gating, and server resolution
 * helpers for `@qianji/mcp`.
 */
import type { Context } from "@deepseek-ai/cordis";
import type { Session } from "@qianji/session";
import { textOutput, type ToolDefinition, type ToolEnv, type ToolOutput } from "@qianji/tools";
import {
  promptListMarkdown,
  promptResultMarkdown,
  resourceContent,
  resourceListMarkdown,
  resultContent,
  toolName,
  type ConnectedServer,
  type McpServerConfig as BaseMcpServerConfig,
} from "./client.ts";

export interface McpServerConfig extends BaseMcpServerConfig {
  /** Explicitly defer (or keep eager) this server's tools behind `activate_tools`. */
  deferTools?: boolean;
}

export const AUTO_DEFER_TOOL_THRESHOLD = 8;

export interface BuildMcpToolsOptions {
  ctx: Context;
  connected: readonly ConnectedServer[];
  subscriptions: Map<string, Set<string>>;
  confirmTools?: boolean;
  defaultDeferTools?: boolean;
}

/** Resolves a target MCP server from candidates by id/name, or picks the sole candidate. */
export function resolveMcpServer(
  requestedId: string | undefined,
  candidates: ConnectedServer[],
  capability: string,
): ConnectedServer {
  const requested = requestedId?.trim();
  if (requested) {
    const match = candidates.find((server) => server.config.id === requested || server.config.name === requested);
    if (match) return match;
    throw new Error(
      `没有找到支持${capability}的 MCP 服务器“${requested}”。可用：${candidates.map((server) => server.config.id).join(", ") || "无"}`,
    );
  }
  if (candidates.length === 1 && candidates[0] !== undefined) return candidates[0];
  if (candidates.length === 0) throw new Error(`没有已连接且支持${capability}的 MCP 服务器`);
  throw new Error(`请指定 serverId。可用：${candidates.map((server) => server.config.id).join(", ")}`);
}

async function getEffectiveMode(ctx: Context, sessionId: string): Promise<string> {
  const permissions = ctx.get("permissions") as { modes(session: Session): { effective: string } } | undefined;
  const session = await ctx.sessions.get(sessionId);
  return session === undefined || permissions === undefined ? "ask" : permissions.modes(session).effective;
}

interface GateOptions {
  trusted: boolean;
  confirmTools: boolean | undefined;
  readOnlyMessage: string;
  skipConfirmWhenTrusted: boolean;
  title: string;
  message: string | (() => string);
  refusal: string;
}

async function gateMcpExecution(ctx: Context, env: ToolEnv, options: GateOptions): Promise<ToolOutput | undefined> {
  const mode = await getEffectiveMode(ctx, env.sessionId);
  if (mode === "read-only" && !options.trusted) {
    return textOutput(options.readOnlyMessage, true);
  }
  if ((options.skipConfirmWhenTrusted && options.trusted) || options.confirmTools === false || mode === "full-access") {
    return undefined;
  }
  const body = typeof options.message === "function" ? options.message() : options.message;
  const allowed = await ctx.ui.confirm(env.sessionId, options.title, body, env.signal);
  return allowed ? undefined : textOutput(options.refusal, true);
}

/** Builds a Qianji `ToolDefinition` wrapping a remote server's MCP tool. */
export function buildRemoteToolDefinition(
  ctx: Context,
  server: ConnectedServer,
  remote: ConnectedServer["tools"][number],
  name: string,
  options: { confirmTools?: boolean; defaultDeferTools?: boolean },
): ToolDefinition {
  const label = server.config.name || server.config.id;
  const parameters =
    remote.inputSchema?.type === "object"
      ? (remote.inputSchema as ToolDefinition["parameters"])
      : { type: "object" as const, properties: {}, additionalProperties: true };
  const serverDefer = (server.config as McpServerConfig).deferTools;
  const deferred = serverDefer ?? options.defaultDeferTools ?? server.tools.length > AUTO_DEFER_TOOL_THRESHOLD;

  return {
    name,
    description: `[MCP: ${label}] ${remote.description || remote.name}`,
    parameters,
    group: `mcp_${server.config.id}`,
    groupDescription: `MCP tools from server "${server.config.id}"`,
    deferred,
    execute: async (args: Record<string, unknown>, env: ToolEnv) => {
      const trusted = server.config.trustedReadOnly && remote.annotations?.destructiveHint !== true;
      const refused = await gateMcpExecution(ctx, env, {
        trusted,
        confirmTools: options.confirmTools,
        readOnlyMessage: "只读模式阻止了未标记为受信任只读的 MCP 工具",
        skipConfirmWhenTrusted: false,
        title: `允许 MCP 工具？${label}`,
        message: () => `${remote.name}\n${JSON.stringify(args, null, 2).slice(0, 1800)}`,
        refusal: "用户拒绝了 MCP 工具调用",
      });
      if (refused) return refused;
      const result = await server.client.callTool(remote.name, args, env.signal);
      return {
        content: resultContent(result),
        ...(result.isError ? { isError: true } : {}),
        details: { serverId: server.config.id, toolName: remote.name, structuredContent: result.structuredContent },
      };
    },
  };
}

/** Builds built-in MCP resource and prompt tool definitions for connected servers. */
export function buildResourceAndPromptToolDefinitions(options: BuildMcpToolsOptions): Array<ToolDefinition<never>> {
  const { ctx, subscriptions, confirmTools } = options;
  const connectedList = [...options.connected];
  const resourceServers = connectedList.filter((server) => Boolean(server.capabilities.resources));
  const subscribable = resourceServers.filter((server) => server.capabilities.resources?.subscribe === true);
  const promptServers = connectedList.filter((server) => Boolean(server.capabilities.prompts));
  const serverId = { type: "string", description: "MCP server ID; optional when exactly one server supports this" };
  const labelOf = (server: ConnectedServer): string => server.config.name || server.config.id;
  const gateCapabilities = (env: ToolEnv, trusted: boolean, title: string, message: string, refusal: string) =>
    gateMcpExecution(ctx, env, {
      trusted,
      confirmTools,
      readOnlyMessage: "只读模式只允许访问已标记为受信任只读的 MCP 服务器",
      skipConfirmWhenTrusted: true,
      title,
      message,
      refusal,
    });

  const definitions: Array<ToolDefinition<never>> = [];
  const pushDef = <A extends Record<string, unknown>>(def: ToolDefinition<A>): void => {
    definitions.push(def as unknown as ToolDefinition<never>);
  };

  if (resourceServers.length > 0) {
    pushDef({
      name: "mcp_list_resources",
      description: "List read-only resources advertised by a connected MCP server.",
      parameters: { type: "object", properties: { serverId } },
      execute: async ({ serverId: requested }: { serverId?: string }, env: ToolEnv) => {
        const server = resolveMcpServer(requested, resourceServers, "资源");
        const refused = await gateCapabilities(env, server.config.trustedReadOnly, "允许读取 MCP 资源列表？", labelOf(server), "用户拒绝了 MCP 资源读取");
        if (refused) return refused;
        const resources = await server.client.listResources();
        return { content: [{ type: "text", text: resourceListMarkdown(server, resources) }], details: { serverId: server.config.id, resources } };
      },
    });

    pushDef({
      name: "mcp_read_resource",
      description: "Read a resource URI from a connected MCP server.",
      parameters: { type: "object", properties: { serverId, uri: { type: "string", description: "Exact URI returned by mcp_list_resources" } }, required: ["uri"] },
      execute: async ({ serverId: requested, uri }: { serverId?: string; uri: string }, env: ToolEnv) => {
        const server = resolveMcpServer(requested, resourceServers, "资源");
        const refused = await gateCapabilities(env, server.config.trustedReadOnly, "允许读取 MCP 资源？", `${labelOf(server)}\n${uri}`, "用户拒绝了 MCP 资源读取");
        if (refused) return refused;
        return { content: resourceContent(await server.client.readResource(uri)), details: { serverId: server.config.id, uri } };
      },
    });
  }

  if (subscribable.length > 0) {
    pushDef({
      name: "mcp_subscribe_resource",
      description: "Subscribe to updates for a resource URI on an MCP server that advertises subscription support.",
      parameters: { type: "object", properties: { serverId, uri: { type: "string", description: "Exact resource URI to subscribe to" } }, required: ["uri"] },
      execute: async ({ serverId: requested, uri }: { serverId?: string; uri: string }, env: ToolEnv) => {
        const server = resolveMcpServer(requested, subscribable, "资源订阅");
        const refused = await gateCapabilities(env, server.config.trustedReadOnly, "允许订阅 MCP 资源？", `${labelOf(server)}\n${uri}`, "用户拒绝了 MCP 资源订阅");
        if (refused) return refused;
        await server.client.subscribeResource(uri);
        const set = subscriptions.get(server.config.id) ?? new Set<string>();
        set.add(uri);
        subscriptions.set(server.config.id, set);
        return { content: [{ type: "text", text: `已订阅 MCP 资源：${labelOf(server)}\n${uri}` }], details: { serverId: server.config.id, uri, subscribed: true } };
      },
    });

    pushDef({
      name: "mcp_unsubscribe_resource",
      description: "Stop live updates for a previously subscribed MCP resource URI.",
      parameters: { type: "object", properties: { serverId, uri: { type: "string", description: "Exact subscribed resource URI" } }, required: ["uri"] },
      execute: async ({ serverId: requested, uri }: { serverId?: string; uri: string }) => {
        const server = resolveMcpServer(requested, subscribable, "资源订阅");
        const set = subscriptions.get(server.config.id);
        if (!set?.has(uri)) return { content: [{ type: "text", text: `该资源当前未订阅：${uri}` }], details: { serverId: server.config.id, uri, subscribed: false } };
        await server.client.unsubscribeResource(uri);
        set.delete(uri);
        if (set.size === 0) subscriptions.delete(server.config.id);
        return { content: [{ type: "text", text: `已取消订阅 MCP 资源：${labelOf(server)}\n${uri}` }], details: { serverId: server.config.id, uri, subscribed: false } };
      },
    });
  }

  if (promptServers.length > 0) {
    pushDef({
      name: "mcp_list_prompts",
      description: "List prompt templates advertised by a connected MCP server.",
      parameters: { type: "object", properties: { serverId } },
      execute: async ({ serverId: requested }: { serverId?: string }, env: ToolEnv) => {
        const server = resolveMcpServer(requested, promptServers, "提示词");
        const refused = await gateCapabilities(env, server.config.trustedReadOnly, "允许读取 MCP 提示词列表？", labelOf(server), "用户拒绝了 MCP 提示词读取");
        if (refused) return refused;
        const prompts = await server.client.listPrompts();
        return { content: [{ type: "text", text: promptListMarkdown(server, prompts) }], details: { serverId: server.config.id, prompts } };
      },
    });

    pushDef({
      name: "mcp_get_prompt",
      description: "Resolve a prompt template from a connected MCP server with string arguments.",
      parameters: {
        type: "object",
        properties: { serverId, name: { type: "string", description: "Prompt name returned by mcp_list_prompts" }, arguments: { type: "object", additionalProperties: { type: "string" } } },
        required: ["name"],
      },
      execute: async ({ serverId: requested, name, arguments: args }: { serverId?: string; name: string; arguments?: Record<string, string> }, env: ToolEnv) => {
        const server = resolveMcpServer(requested, promptServers, "提示词");
        const refused = await gateCapabilities(env, server.config.trustedReadOnly, "允许读取 MCP 提示词？", `${labelOf(server)}\n${name}`, "用户拒绝了 MCP 提示词读取");
        if (refused) return refused;
        const result = await server.client.getPrompt(name, args ?? {});
        return { content: [{ type: "text", text: promptResultMarkdown(server, name, result) }], details: { serverId: server.config.id, name } };
      },
    });
  }

  return definitions;
}

/** Collects all remote server tools plus capability-gated resource and prompt tools. */
export function buildAllMcpToolDefinitions(options: BuildMcpToolsOptions): Array<ToolDefinition<never>> {
  const used = new Set<string>();
  const defs: Array<ToolDefinition<never>> = [];
  for (const server of options.connected) {
    for (const remote of server.tools) {
      defs.push(
        buildRemoteToolDefinition(options.ctx, server, remote, toolName(server.config.id, remote.name, used), {
          ...(options.confirmTools === undefined ? {} : { confirmTools: options.confirmTools }),
          ...(options.defaultDeferTools === undefined ? {} : { defaultDeferTools: options.defaultDeferTools }),
        }) as unknown as ToolDefinition<never>,
      );
    }
  }
  defs.push(...buildResourceAndPromptToolDefinitions(options));
  return defs;
}

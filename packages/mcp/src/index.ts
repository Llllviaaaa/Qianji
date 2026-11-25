/**
 * MCP servers as tools (ADR 0010). The `mcp` service connects the enabled
 * servers in the background when the host starts and registers each remote
 * tool as `mcp__<server>__<tool>`, plus `mcp_list_resources`,
 * `mcp_read_resource`, `mcp_(un)subscribe_resource`, `mcp_list_prompts` and
 * `mcp_get_prompt` when a connected server supports them.
 *
 * `notifications/tools/list_changed` refreshes that server's tools live
 * without restarting the Host; unexpected STDIO server exits trigger bounded
 * exponential-backoff reconnection, and `reconnect()` lets the UI or slash
 * commands reconnect on demand.
 */
import { Context, Service } from "@deepseek-ai/cordis";
import "@qianji/commands";
import {
  ErrorCode,
  type McpGetPromptResult,
  type McpPromptsResult,
  type McpReadResourceResult,
  type McpResourcesResult,
  type McpServerStatus,
  type McpStatusResult,
} from "@qianji/protocol";
import { RpcError } from "@qianji/rpc";
import "@qianji/session";
import "@qianji/tools";
import "@qianji/ui";
import {
  createClient,
  errorText,
  promptResultMarkdown,
  resourceContent,
  type ConnectedServer,
  type McpPrompt,
  type McpResource,
  type ServerStatus,
} from "./client.ts";
import { registerAllMcpTools, resolveMcpServer, type McpServerConfig } from "./tool-defs.ts";

export {
  createClient,
  errorText,
  parseSse,
  promptListMarkdown,
  promptResultMarkdown,
  PROTOCOL_VERSION,
  resourceContent,
  resourceListMarkdown,
  resultContent,
  safeEnvironment,
  SUPPORTED_PROTOCOL_VERSIONS,
  toolName,
  type ConnectedServer,
  type JsonRpcMessage,
  type McpCapabilities,
  type McpClient,
  type McpConnectResult,
  type McpNotificationHandler,
  type McpPrompt,
  type McpPromptResult,
  type McpResource,
  type McpResourceContents,
  type McpTool,
  type McpToolResult,
  type ServerStatus,
} from "./client.ts";
export { AUTO_DEFER_TOOL_THRESHOLD, type McpServerConfig } from "./tool-defs.ts";

declare module "@deepseek-ai/cordis" {
  interface Context {
    mcp: Mcp;
  }

  interface Events {
    "mcp/changed"(): void;
  }
}

export interface Config {
  servers?: McpServerConfig[];
  /** Ask before each MCP call unless the session has full access. Default true. */
  confirmTools?: boolean;
  /** Backoff schedule in ms when a connected STDIO server exits unexpectedly. */
  reconnectDelaysMs?: readonly number[];
  /** Default tool deferral policy when a server does not specify `deferTools`. */
  deferTools?: boolean;
}

export interface ListedMcpResource extends McpResource {
  serverId: string;
  serverName: string;
}

export interface ListedMcpPrompt extends McpPrompt {
  serverId: string;
  serverName: string;
}

const DEFAULT_RECONNECT_DELAYS_MS: readonly number[] = [1_000, 2_000, 4_000];

const CHANGE_NOTICES: Record<string, string> = {
  "notifications/resources/list_changed": "资源列表已变化，可重新调用 mcp_list_resources。",
  "notifications/prompts/list_changed": "提示词列表已变化，可重新调用 mcp_list_prompts。",
};

export class Mcp extends Service {
  static inject = ["sessions", "tools", "ui"];
  static provide = "mcp";

  /** Settles once every configured server has connected or failed. */
  readonly ready: Promise<void>;
  private readonly enabledConfigs: McpServerConfig[];
  private readonly statusMap = new Map<string, ServerStatus>();
  private readonly connected = new Map<string, ConnectedServer>();
  private readonly subscriptions = new Map<string, Set<string>>();
  private readonly disposers: Array<() => void> = [];
  private readonly reconnectTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly refreshLocks = new Map<string, Promise<void>>();
  private closed = false;

  constructor(ctx: Context, private readonly config: Config = {}) {
    super(ctx, "mcp");
    this.enabledConfigs = (config.servers ?? []).filter((server) => server.enabled);
    ctx.effect(() => () => {
      this.closed = true;
      for (const timer of this.reconnectTimers.values()) clearTimeout(timer);
      this.reconnectTimers.clear();
      for (const dispose of this.disposers.splice(0)) dispose();
      for (const server of this.connected.values()) server.client.close();
      this.connected.clear();
    }, "mcp: servers");
    this.registerSlashCommands(ctx);
    this.ready = this.connectAll(this.enabledConfigs);
    this.registerRpcMethods(ctx);
  }

  statuses(): ServerStatus[] {
    const ordered: ServerStatus[] = [];
    for (const cfg of this.enabledConfigs) {
      const status = this.statusMap.get(cfg.id);
      if (status !== undefined) ordered.push({ ...status });
    }
    for (const [id, status] of this.statusMap) {
      if (!this.enabledConfigs.some((cfg) => cfg.id === id)) {
        ordered.push({ ...status });
      }
    }
    return ordered;
  }

  /** Reconnect one configured server by `id` (or all enabled servers when omitted). */
  async reconnect(serverId?: string): Promise<ServerStatus[]> {
    await this.ready;
    if (this.closed) return this.statuses();
    const targets = serverId !== undefined && serverId.trim() !== ""
      ? this.enabledConfigs.filter((cfg) => cfg.id === serverId.trim() || cfg.name === serverId.trim())
      : [...this.enabledConfigs];
    if (serverId !== undefined && serverId.trim() !== "" && targets.length === 0) {
      throw new Error(`未找到已启用的 MCP 服务器“${serverId}”`);
    }
    for (const cfg of targets) {
      this.clearReconnectTimer(cfg.id);
      const existing = this.connected.get(cfg.id);
      if (existing !== undefined) {
        this.connected.delete(cfg.id);
        existing.client.close();
      }
    }
    const attempts = await Promise.all(targets.map((cfg) => this.connect(cfg)));
    if (this.closed) {
      for (const server of attempts) server?.client.close();
      return this.statuses();
    }
    for (const server of attempts) {
      if (server === null) continue;
      this.connected.set(server.config.id, server);
      this.recordConnectedStatus(server);
      await this.resubscribe(server);
    }
    this.rebuildToolRegistrations();
    this.ctx.emit("mcp/changed");
    return this.statuses();
  }

  async listAllResources(serverId?: string): Promise<ListedMcpResource[]> {
    await this.ready;
    const resourceServers = [...this.connected.values()].filter((server) => Boolean(server.capabilities.resources));
    const targets = serverId && serverId.trim() !== ""
      ? [resolveMcpServer(serverId, resourceServers, "资源")]
      : resourceServers;
    const lists = await Promise.all(targets.map(async (server) => {
      const items = await server.client.listResources();
      return items.map((item): ListedMcpResource => ({
        ...item,
        serverId: server.config.id,
        serverName: server.config.name || server.config.id,
      }));
    }));
    return lists.flat();
  }

  async readServerResource(serverId: string | undefined, uri: string): Promise<{ serverId: string; uri: string; text: string }> {
    await this.ready;
    const resourceServers = [...this.connected.values()].filter((server) => Boolean(server.capabilities.resources));
    const server = resolveMcpServer(serverId, resourceServers, "资源");
    const blocks = resourceContent(await server.client.readResource(uri));
    const text = blocks.map((block) => (block.type === "text" ? block.text : `[图片资源 ${block.mimeType}]`)).join("\n\n");
    return { serverId: server.config.id, uri, text };
  }

  async listAllPrompts(serverId?: string): Promise<ListedMcpPrompt[]> {
    await this.ready;
    const promptServers = [...this.connected.values()].filter((server) => Boolean(server.capabilities.prompts));
    const targets = serverId && serverId.trim() !== ""
      ? [resolveMcpServer(serverId, promptServers, "提示词")]
      : promptServers;
    const lists = await Promise.all(targets.map(async (server) => {
      const items = await server.client.listPrompts();
      return items.map((item): ListedMcpPrompt => ({
        ...item,
        serverId: server.config.id,
        serverName: server.config.name || server.config.id,
      }));
    }));
    return lists.flat();
  }

  async getServerPrompt(serverId: string | undefined, name: string, args: Record<string, string> = {}): Promise<{ serverId: string; name: string; markdown: string }> {
    await this.ready;
    const promptServers = [...this.connected.values()].filter((server) => Boolean(server.capabilities.prompts));
    const server = resolveMcpServer(serverId, promptServers, "提示词");
    const resolved = await server.client.getPrompt(name, args);
    return {
      serverId: server.config.id,
      name,
      markdown: promptResultMarkdown(server, name, resolved),
    };
  }

  private clearReconnectTimer(serverId: string): void {
    const timer = this.reconnectTimers.get(serverId);
    if (timer !== undefined) {
      clearTimeout(timer);
      this.reconnectTimers.delete(serverId);
    }
  }

  private recordConnectedStatus(server: ConnectedServer): void {
    this.statusMap.set(server.config.id, {
      config: server.config,
      connected: true,
      toolCount: server.tools.length,
      protocolVersion: server.protocolVersion,
      hasResources: Boolean(server.capabilities.resources),
      hasPrompts: Boolean(server.capabilities.prompts),
    });
  }

  private async resubscribe(server: ConnectedServer): Promise<void> {
    if (server.capabilities.resources?.subscribe !== true) return;
    const uris = this.subscriptions.get(server.config.id);
    if (!uris || uris.size === 0) return;
    for (const uri of uris) {
      await server.client.subscribeResource(uri).catch(() => undefined);
    }
  }

  private async connectAll(configured: McpServerConfig[]): Promise<void> {
    const attempts = await Promise.all(configured.map((config) => this.connect(config)));
    if (this.closed) {
      for (const server of attempts) server?.client.close();
      return;
    }
    for (const server of attempts) {
      if (server === null) continue;
      this.connected.set(server.config.id, server);
      this.recordConnectedStatus(server);
    }
    this.rebuildToolRegistrations();
  }

  private async refreshServerTools(serverId: string): Promise<void> {
    const previous = this.refreshLocks.get(serverId) ?? Promise.resolve();
    const next = previous.catch(() => undefined).then(async () => {
      if (this.closed) return;
      const server = this.connected.get(serverId);
      if (server === undefined) return;
      const label = server.config.name || server.config.id;
      try {
        const tools = await server.client.listTools();
        if (this.closed || this.connected.get(serverId) !== server) return;
        server.tools = tools;
        this.recordConnectedStatus(server);
        this.rebuildToolRegistrations();
        this.ctx.ui.notify(undefined, `MCP 通知 · ${label}\n工具列表已动态刷新（当前 ${tools.length} 个工具）。`, "info");
        this.ctx.emit("mcp/changed");
      } catch (error) {
        this.ctx.logger("mcp").warn("failed to refresh tools for %s: %s", label, errorText(error));
      }
    });
    this.refreshLocks.set(serverId, next);
    await next;
  }

  private handleUnexpectedDisconnect(config: McpServerConfig, closedClient: ConnectedServer["client"], error: Error): void {
    if (this.closed) return;
    const current = this.connected.get(config.id);
    if (current === undefined || current.client !== closedClient) return;
    this.connected.delete(config.id);
    this.statusMap.set(config.id, {
      config,
      connected: false,
      toolCount: 0,
      error: errorText(error),
    });
    this.rebuildToolRegistrations();
    this.ctx.emit("mcp/changed");
    this.scheduleBackoffReconnect(config, 0);
  }

  private scheduleBackoffReconnect(config: McpServerConfig, attempt: number): void {
    const delays = this.config.reconnectDelaysMs ?? DEFAULT_RECONNECT_DELAYS_MS;
    if (this.closed || attempt >= delays.length) return;
    this.clearReconnectTimer(config.id);
    const delay = delays[attempt] ?? 1_000;
    const timer = setTimeout(() => {
      this.reconnectTimers.delete(config.id);
      if (this.closed || this.connected.has(config.id)) return;
      void this.connect(config).then(async (reconnected) => {
        if (this.closed) {
          reconnected?.client.close();
          return;
        }
        if (reconnected === null) {
          this.scheduleBackoffReconnect(config, attempt + 1);
          return;
        }
        this.connected.set(config.id, reconnected);
        this.recordConnectedStatus(reconnected);
        await this.resubscribe(reconnected);
        this.rebuildToolRegistrations();
        this.ctx.emit("mcp/changed");
      });
    }, delay);
    timer.unref?.();
    this.reconnectTimers.set(config.id, timer);
  }

  private async connect(config: McpServerConfig): Promise<ConnectedServer | null> {
    const client = createClient(config);
    const label = config.name || config.id;
    client.setNotificationHandler(async (message) => {
      if (message.method === "notifications/resources/updated") {
        const uri = typeof message.params?.uri === "string" ? message.params.uri : "";
        if (uri !== "" && this.subscriptions.get(config.id)?.has(uri)) {
          this.ctx.ui.notify(undefined, `MCP 资源已更新 · ${label}\n${uri}`, "info");
        }
        return;
      }
      if (message.method === "notifications/tools/list_changed") {
        await this.refreshServerTools(config.id);
        return;
      }
      const notice = message.method === undefined ? undefined : CHANGE_NOTICES[message.method];
      if (notice !== undefined) this.ctx.ui.notify(undefined, `MCP 通知 · ${label}\n${notice}`, "info");
    });
    client.setDisconnectHandler?.((error) => this.handleUnexpectedDisconnect(config, client, error));
    try {
      const connection = await client.connect();
      const declared = Object.keys(connection.capabilities).length > 0;
      const tools = connection.capabilities.tools || !declared ? await client.listTools() : [];
      return { config, client, tools, ...connection };
    } catch (error) {
      client.close();
      this.statusMap.set(config.id, { config, connected: false, toolCount: 0, error: errorText(error) });
      this.ctx.logger("mcp").warn("%s did not connect: %s", label, errorText(error));
      return null;
    }
  }

  private rebuildToolRegistrations(): void {
    if (this.closed) return;
    for (const dispose of this.disposers.splice(0)) dispose();
    this.disposers.push(
      ...registerAllMcpTools({
        ctx: this.ctx,
        connected: [...this.connected.values()],
        subscriptions: this.subscriptions,
        ...(this.config.confirmTools === undefined ? {} : { confirmTools: this.config.confirmTools }),
        ...(this.config.deferTools === undefined ? {} : { defaultDeferTools: this.config.deferTools }),
      }),
    );
  }

  private registerSlashCommands(ctx: Context): void {
    const formatStatuses = (): string => {
      const list = this.statuses();
      if (list.length === 0) return "### MCP 服务器状态\n\n尚未启用任何 MCP 服务器。";
      const rows = list.map((status) => {
        const label = status.config.name || status.config.id;
        const state = status.connected ? `已连接（${status.toolCount} 个工具）` : `未连接（${status.error || "连接失败"}）`;
        const caps = [
          status.hasResources ? "资源" : null,
          status.hasPrompts ? "提示词" : null,
          status.protocolVersion ? `协议 ${status.protocolVersion}` : null,
        ].filter(Boolean).join(" · ");
        return `- **${label}** (\`${status.config.id}\`, ${status.config.transport.toUpperCase()})：${state}${caps ? ` — ${caps}` : ""}`;
      });
      return `### MCP 服务器状态\n\n${rows.join("\n")}`;
    };

    ctx.inject(["commands"], (inner) => {
      const disposers = [
        inner.commands.register({
          name: "mcp-status",
          description: "查看 MCP 服务器连接状态、协议版本与工具数量",
          source: "mcp",
          async execute() {
            await inner.mcp.ready;
            return { output: formatStatuses() };
          },
        }),
        inner.commands.register({
          name: "mcp-diagnose",
          description: "诊断已启用的 MCP 服务器连接状态（等同 /mcp-status）",
          source: "mcp",
          async execute() {
            await inner.mcp.ready;
            return { output: formatStatuses() };
          },
        }),
        inner.commands.register({
          name: "mcp-resources",
          description: "列出已连接 MCP 服务器提供的只读资源",
          argsHint: "[serverId]",
          source: "mcp",
          async execute(rawArgs) {
            await inner.mcp.ready;
            const serverId = rawArgs.trim() || undefined;
            const resources = await inner.mcp.listAllResources(serverId);
            if (resources.length === 0) return { output: "### MCP 资源\n\n没有发现可用资源。" };
            const lines = resources.map((item) => {
              const title = item.title || item.name || item.uri;
              const meta = [item.serverName, item.mimeType, item.description].filter(Boolean).join(" · ");
              return `- **${title}** — \`${item.uri}\`${meta ? `（${meta}）` : ""}`;
            });
            return { output: `### MCP 资源列表\n\n${lines.join("\n")}` };
          },
        }),
        inner.commands.register({
          name: "mcp-read",
          description: "读取指定 MCP 资源 URI 的内容",
          argsHint: "[serverId] <uri>",
          source: "mcp",
          async execute(rawArgs) {
            const parts = rawArgs.trim().split(/\s+/).filter(Boolean);
            if (parts.length === 0) return { output: "用法：`/mcp-read [serverId] <uri>`", isError: true };
            const [first, second] = parts;
            const uri = second !== undefined ? second : (first ?? "");
            const serverId = second !== undefined ? first : undefined;
            const read = await inner.mcp.readServerResource(serverId, uri);
            return { output: read.text };
          },
        }),
        inner.commands.register({
          name: "mcp-prompts",
          description: "列出或解析 MCP 服务器的提示词模板",
          argsHint: "[serverId] [promptName]",
          source: "mcp",
          async execute(rawArgs) {
            const parts = rawArgs.trim().split(/\s+/).filter(Boolean);
            if (parts.length <= 1) {
              const prompts = await inner.mcp.listAllPrompts(parts[0]);
              if (prompts.length === 0) return { output: "### MCP 提示词\n\n没有发现可用提示词模板。" };
              const lines = prompts.map((item) => {
                const args = (item.arguments ?? []).map((arg) => `${arg.name}${arg.required ? "*" : ""}`).join(", ");
                return `- **${item.title || item.name}** (\`${item.serverId}\`)${item.description ? `：${item.description}` : ""}${args ? ` — 参数：\`${args}\`` : ""}`;
              });
              return { output: `### MCP 提示词模板\n\n${lines.join("\n")}` };
            }
            const [serverId, promptName] = parts;
            const resolved = await inner.mcp.getServerPrompt(serverId, promptName ?? "");
            return { output: resolved.markdown };
          },
        }),
      ];
      inner.effect(() => () => {
        for (const dispose of disposers) dispose();
      }, "mcp: slash commands");
    });
  }

  private registerRpcMethods(ctx: Context): void {
    ctx.inject(["rpc"], (rpcCtx) => {
      let rpcActive = true;
      rpcCtx.effect(() => () => {
        rpcActive = false;
      }, "mcp: rpc scope");

      const recordOf = (params: unknown): Record<string, unknown> => {
        if (params === undefined || params === null) return {};
        if (typeof params !== "object" || Array.isArray(params)) {
          throw new RpcError(ErrorCode.InvalidParams, "params must be an object");
        }
        return params as Record<string, unknown>;
      };
      const optionalStr = (p: Record<string, unknown>, key: string): string | undefined => {
        const raw = p[key];
        if (raw === undefined) return undefined;
        if (typeof raw !== "string") throw new RpcError(ErrorCode.InvalidParams, `${key} must be a string`);
        const trimmed = raw.trim();
        return trimmed === "" ? undefined : trimmed;
      };
      const requiredStr = (p: Record<string, unknown>, key: string): string => {
        const value = optionalStr(p, key);
        if (value === undefined) throw new RpcError(ErrorCode.InvalidParams, `${key} must be a non-empty string`);
        return value;
      };
      const formatMcpStatuses = (): McpServerStatus[] =>
        this.statuses().map(({ config, connected, toolCount, protocolVersion, hasResources, hasPrompts, error }) => ({
          id: config.id,
          name: config.name || config.id,
          transport: config.transport,
          connected,
          toolCount,
          ...(protocolVersion === undefined ? {} : { protocolVersion }),
          resources: hasResources === true,
          prompts: hasPrompts === true,
          ...(error === undefined ? {} : { error }),
        }));

      rpcCtx.on("mcp/changed", () => {
        if (rpcActive && !this.closed) {
          rpcCtx.rpc.broadcast("mcp/changed", { servers: formatMcpStatuses() });
        }
      });
      void this.ready.then(() => {
        if (rpcActive && !this.closed) {
          rpcCtx.rpc.broadcast("mcp/changed", { servers: formatMcpStatuses() });
        }
      });

      const methods: Record<string, (params: unknown) => unknown> = {
        "mcp.status": async (): Promise<McpStatusResult> => {
          await this.ready;
          return { servers: formatMcpStatuses() };
        },

        "mcp.reconnect": async (params): Promise<McpStatusResult> => {
          const p = recordOf(params);
          const serverId = optionalStr(p, "serverId");
          try {
            await this.reconnect(serverId);
          } catch (error) {
            throw new RpcError(ErrorCode.InvalidParams, error instanceof Error ? error.message : String(error));
          }
          return { servers: formatMcpStatuses() };
        },

        "mcp.resources": async (params): Promise<McpResourcesResult> => {
          const p = recordOf(params);
          const serverId = optionalStr(p, "serverId");
          try {
            const resources = await this.listAllResources(serverId);
            return { resources };
          } catch (error) {
            throw new RpcError(ErrorCode.InvalidParams, error instanceof Error ? error.message : String(error));
          }
        },

        "mcp.readResource": async (params): Promise<McpReadResourceResult> => {
          const p = recordOf(params);
          const serverId = optionalStr(p, "serverId");
          const uri = requiredStr(p, "uri");
          try {
            return await this.readServerResource(serverId, uri);
          } catch (error) {
            throw new RpcError(ErrorCode.InvalidParams, error instanceof Error ? error.message : String(error));
          }
        },

        "mcp.prompts": async (params): Promise<McpPromptsResult> => {
          const p = recordOf(params);
          const serverId = optionalStr(p, "serverId");
          try {
            const prompts = await this.listAllPrompts(serverId);
            return { prompts };
          } catch (error) {
            throw new RpcError(ErrorCode.InvalidParams, error instanceof Error ? error.message : String(error));
          }
        },

        "mcp.getPrompt": async (params): Promise<McpGetPromptResult> => {
          const p = recordOf(params);
          const serverId = optionalStr(p, "serverId");
          const name = requiredStr(p, "name");
          const rawArgs = p.arguments;
          const args: Record<string, string> = {};
          if (rawArgs !== undefined) {
            if (typeof rawArgs !== "object" || rawArgs === null || Array.isArray(rawArgs)) {
              throw new RpcError(ErrorCode.InvalidParams, "arguments must be a string map");
            }
            for (const [key, value] of Object.entries(rawArgs as Record<string, unknown>)) {
              if (typeof value === "string") args[key] = value;
            }
          }
          try {
            return await this.getServerPrompt(serverId, name, args);
          } catch (error) {
            throw new RpcError(ErrorCode.InvalidParams, error instanceof Error ? error.message : String(error));
          }
        },
      };

      for (const [method, handler] of Object.entries(methods)) {
        rpcCtx.effect(() => rpcCtx.rpc.method(method, handler), `mcp: ${method}`);
      }
    });
  }
}

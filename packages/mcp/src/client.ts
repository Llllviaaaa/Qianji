/**
 * MCP client core contracts, STDIO transport, and formatting utilities (`packages/mcp/src/client.ts`).
 * Streamable HTTP transport lives in `./http-client.ts`.
 */
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { StringDecoder } from "node:string_decoder";
import { HttpMcpClient } from "./http-client.ts";

export const PROTOCOL_VERSION = "2025-11-25";
export const SUPPORTED_PROTOCOL_VERSIONS = new Set(["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"]);

export interface McpServerConfig {
  id: string;
  name: string;
  enabled: boolean;
  transport: "stdio" | "http";
  command: string;
  args: string[];
  cwd: string;
  env: Record<string, string>;
  inheritEnvironment: boolean;
  url: string;
  headers: Record<string, string>;
  trustedReadOnly: boolean;
}

export interface McpHttpAuthProvider {
  /** Resolve dynamic HTTP auth headers (e.g. Keychain Bearer token, proactively refreshed when near expiry). */
  headers(serverId: string, url: string): Promise<Record<string, string> | undefined>;
  /** Handle HTTP 401 Unauthorized by refreshing credentials and returning updated headers for one retry. */
  onUnauthorized?(serverId: string, url: string, wwwAuthenticate?: string): Promise<Record<string, string> | undefined>;
}

export interface McpTool {
  name: string;
  title?: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
  annotations?: { readOnlyHint?: boolean; destructiveHint?: boolean; [key: string]: unknown };
}

export interface McpToolResult {
  content?: Array<Record<string, unknown>>;
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
}

export interface McpCapabilities {
  tools?: Record<string, unknown>;
  resources?: { subscribe?: boolean; listChanged?: boolean; [key: string]: unknown };
  prompts?: { listChanged?: boolean; [key: string]: unknown };
  [key: string]: unknown;
}

export interface McpConnectResult {
  protocolVersion: string;
  capabilities: McpCapabilities;
}

export interface McpResource {
  uri: string;
  name?: string;
  title?: string;
  description?: string;
  mimeType?: string;
}

export interface McpResourceContents {
  uri: string;
  mimeType?: string;
  text?: string;
  blob?: string;
}

export interface McpPrompt {
  name: string;
  title?: string;
  description?: string;
  arguments?: Array<{ name: string; description?: string; required?: boolean }>;
}

export interface McpPromptResult {
  description?: string;
  messages?: Array<{ role?: string; content?: Record<string, unknown> }>;
}

export interface JsonRpcMessage {
  jsonrpc: "2.0";
  id?: number | string | null;
  method?: string;
  params?: Record<string, unknown>;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

export interface ConnectedServer {
  config: McpServerConfig;
  client: McpClient;
  tools: McpTool[];
  protocolVersion: string;
  capabilities: McpCapabilities;
}

export type McpNotificationHandler = (message: JsonRpcMessage) => void | Promise<void>;

export interface ServerStatus {
  config: McpServerConfig;
  connected: boolean;
  toolCount: number;
  protocolVersion?: string;
  hasResources?: boolean;
  hasPrompts?: boolean;
  error?: string;
}

export interface McpClient {
  connect(): Promise<McpConnectResult>;
  setNotificationHandler(handler: McpNotificationHandler): void;
  setDisconnectHandler?(handler: (error: Error) => void): void;
  listTools(): Promise<McpTool[]>;
  callTool(name: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<McpToolResult>;
  listResources(): Promise<McpResource[]>;
  readResource(uri: string): Promise<{ contents?: McpResourceContents[] }>;
  subscribeResource(uri: string): Promise<void>;
  unsubscribeResource(uri: string): Promise<void>;
  listPrompts(): Promise<McpPrompt[]>;
  getPrompt(name: string, args: Record<string, string>): Promise<McpPromptResult>;
  close(): void;
}

export function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function safeEnvironment(config: McpServerConfig): NodeJS.ProcessEnv {
  const sensitive = /(api.?key|token|secret|password|credential|authorization|cookie)/i;
  const inherited = config.inheritEnvironment
    ? { ...process.env }
    : Object.fromEntries(Object.entries(process.env).filter(([key]) => !sensitive.test(key)));
  delete inherited.PIDESKTOP_MCP_CONFIG;
  delete inherited.PIDESKTOP_MCP_CONFIG_B64;
  return { ...inherited, ...config.env };
}

function commandForWindows(command: string, args: string[]): { command: string; args: string[]; shell: boolean } {
  if (process.platform !== "win32") return { command, args, shell: false };
  const needsShell = /\.(cmd|bat|ps1)$/i.test(command) || !/[\\/]/.test(command);
  return { command, args, shell: needsShell };
}

class StdioMcpClient implements McpClient {
  private child: ChildProcessWithoutNullStreams | null = null;
  private nextId = 1;
  private pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void; timeout: ReturnType<typeof setTimeout> }>();
  private buffer = "";
  private decoder = new StringDecoder("utf8");
  private closing = false;
  private initialized = false;
  private stderrTail = "";
  private notificationHandler: McpNotificationHandler | undefined;
  private disconnectHandler: ((error: Error) => void) | undefined;

  constructor(private config: McpServerConfig) {}

  async connect(): Promise<McpConnectResult> {
    const launch = commandForWindows(this.config.command, this.config.args || []);
    this.child = spawn(launch.command, launch.args, {
      cwd: this.config.cwd || undefined,
      env: safeEnvironment(this.config),
      shell: launch.shell,
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.child.stdout.on("data", (chunk) => this.consume(this.decoder.write(chunk)));
    this.child.stdout.on("end", () => this.consume(this.decoder.end()));
    this.child.stderr.on("data", (chunk) => {
      this.stderrTail = (this.stderrTail + chunk.toString()).slice(-4000);
    });
    this.child.once("error", (error) => this.failAll(error));
    this.child.once("close", (code) => {
      if (!this.closing) {
        const err = new Error(this.stderrTail.trim() || `MCP server exited with code ${code}`);
        this.failAll(err);
        if (this.initialized) this.disconnectHandler?.(err);
      }
    });
    const result = await this.request("initialize", {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: "Qianji", version: "0.4.0" },
    }) as { protocolVersion?: string; capabilities?: McpCapabilities };
    const negotiated = result.protocolVersion || PROTOCOL_VERSION;
    if (!SUPPORTED_PROTOCOL_VERSIONS.has(negotiated)) {
      throw new Error(`MCP server selected unsupported protocol version ${negotiated}`);
    }
    this.notify("notifications/initialized");
    this.initialized = true;
    return { protocolVersion: negotiated, capabilities: result.capabilities || {} };
  }

  async listTools(): Promise<McpTool[]> {
    const tools: McpTool[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < 50; page += 1) {
      const result = await this.request("tools/list", cursor ? { cursor } : {}) as { tools?: McpTool[]; nextCursor?: string };
      tools.push(...(result.tools || []));
      cursor = result.nextCursor;
      if (!cursor) return tools;
    }
    throw new Error("MCP tools/list exceeded 50 pages");
  }

  async callTool(name: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<McpToolResult> {
    return this.request("tools/call", { name, arguments: args }, 120_000, signal) as Promise<McpToolResult>;
  }

  setNotificationHandler(handler: McpNotificationHandler): void {
    this.notificationHandler = handler;
  }

  setDisconnectHandler(handler: (error: Error) => void): void {
    this.disconnectHandler = handler;
    void this.disconnectHandler;
  }

  async listResources(): Promise<McpResource[]> {
    return this.listPaginated<McpResource>("resources/list", "resources");
  }

  async readResource(uri: string): Promise<{ contents?: McpResourceContents[] }> {
    return this.request("resources/read", { uri }) as Promise<{ contents?: McpResourceContents[] }>;
  }

  async subscribeResource(uri: string): Promise<void> {
    await this.request("resources/subscribe", { uri });
  }

  async unsubscribeResource(uri: string): Promise<void> {
    await this.request("resources/unsubscribe", { uri });
  }

  async listPrompts(): Promise<McpPrompt[]> {
    return this.listPaginated<McpPrompt>("prompts/list", "prompts");
  }

  async getPrompt(name: string, args: Record<string, string>): Promise<McpPromptResult> {
    return this.request("prompts/get", { name, arguments: args }) as Promise<McpPromptResult>;
  }

  close(): void {
    this.closing = true;
    this.failAll(new Error("MCP connection closed"));
    const child = this.child;
    child?.stdin.end();
    setTimeout(() => child?.kill(), 1000);
    this.child = null;
  }

  private request(method: string, params: Record<string, unknown>, timeoutMs = 20_000, signal?: AbortSignal): Promise<unknown> {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`MCP request timed out: ${method}`));
      }, timeoutMs);
      const abort = () => {
        const entry = this.pending.get(id);
        if (!entry) return;
        try {
          this.notify("notifications/cancelled", { requestId: id, reason: "Qianji tool call cancelled" });
        } catch {
          // The connection may already be closing.
        }
        clearTimeout(entry.timeout);
        this.pending.delete(id);
        reject(new Error(`MCP request cancelled: ${method}`));
      };
      signal?.addEventListener("abort", abort, { once: true });
      this.pending.set(id, {
        timeout,
        resolve: (value) => {
          signal?.removeEventListener("abort", abort);
          resolve(value);
        },
        reject: (error) => {
          signal?.removeEventListener("abort", abort);
          reject(error);
        },
      });
      try {
        this.send({ jsonrpc: "2.0", id, method, params });
      } catch (error) {
        clearTimeout(timeout);
        this.pending.delete(id);
        signal?.removeEventListener("abort", abort);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  private async listPaginated<T>(method: string, field: string): Promise<T[]> {
    const items: T[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < 50; page += 1) {
      const result = await this.request(method, cursor ? { cursor } : {}) as Record<string, unknown> & { nextCursor?: string };
      const pageItems = result[field];
      if (Array.isArray(pageItems)) items.push(...pageItems as T[]);
      cursor = result.nextCursor;
      if (!cursor) return items;
    }
    throw new Error(`${method} exceeded 50 pages`);
  }

  private notify(method: string, params?: Record<string, unknown>): void {
    this.send({ jsonrpc: "2.0", method, ...(params ? { params } : {}) });
  }

  private send(message: JsonRpcMessage): void {
    if (!this.child?.stdin.writable) throw new Error("MCP stdio connection is not writable");
    this.child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  private consume(chunk: string): void {
    this.buffer += chunk;
    while (true) {
      const newline = this.buffer.indexOf("\n");
      if (newline < 0) return;
      const line = this.buffer.slice(0, newline).replace(/\r$/, "");
      this.buffer = this.buffer.slice(newline + 1);
      if (!line.trim()) continue;
      let message: JsonRpcMessage;
      try {
        message = JSON.parse(line) as JsonRpcMessage;
      } catch {
        this.failAll(new Error(`MCP server wrote invalid JSON to stdout: ${line.slice(0, 300)}`));
        continue;
      }
      if (message.id !== undefined && message.id !== null && (message.result !== undefined || message.error)) {
        const id = Number(message.id);
        const pending = this.pending.get(id);
        if (!pending) continue;
        clearTimeout(pending.timeout);
        this.pending.delete(id);
        if (message.error) pending.reject(new Error(`MCP ${message.error.code}: ${message.error.message}`));
        else pending.resolve(message.result);
        continue;
      }
      if (message.id !== undefined && message.method) {
        this.send({ jsonrpc: "2.0", id: message.id, error: { code: -32601, message: "Qianji does not support this MCP client request" } });
        continue;
      }
      if (message.method && message.id === undefined) {
        void Promise.resolve(this.notificationHandler?.(message)).catch((error) => {
          console.error(`MCP notification handler failed: ${errorText(error)}`);
        });
      }
    }
  }

  private failAll(error: Error): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timeout);
      pending.reject(error);
    }
    this.pending.clear();
  }
}

export function parseSse(body: string): JsonRpcMessage[] {
  const messages: JsonRpcMessage[] = [];
  for (const event of body.split(/\r?\n\r?\n/)) {
    const data = event.split(/\r?\n/)
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).trimStart())
      .join("\n");
    if (!data) continue;
    messages.push(JSON.parse(data) as JsonRpcMessage);
  }
  return messages;
}

export function createClient(config: McpServerConfig, authProvider?: McpHttpAuthProvider): McpClient {
  return config.transport === "http" ? new HttpMcpClient(config, authProvider) : new StdioMcpClient(config);
}

export function toolName(serverId: string, remoteName: string, used: Set<string>): string {
  const clean = (value: string) => value.toLowerCase().replace(/[^a-z0-9_-]+/g, "_").replace(/^_+|_+$/g, "");
  const base = `mcp__${clean(serverId) || "server"}__${clean(remoteName) || "tool"}`.slice(0, 120);
  let candidate = base;
  let suffix = 2;
  while (used.has(candidate)) candidate = `${base.slice(0, 115)}_${suffix++}`;
  used.add(candidate);
  return candidate;
}

export function resultContent(result: McpToolResult): Array<{ type: "text"; text: string } | { type: "image"; data: string; mimeType: string }> {
  const content: Array<{ type: "text"; text: string } | { type: "image"; data: string; mimeType: string }> = [];
  for (const item of result.content || []) {
    if (item.type === "text" && typeof item.text === "string") content.push({ type: "text", text: item.text });
    else if (item.type === "image" && typeof item.data === "string" && typeof item.mimeType === "string") {
      content.push({ type: "image", data: item.data, mimeType: item.mimeType });
    } else if (item.type === "resource" && item.resource && typeof item.resource === "object") {
      const resource = item.resource as Record<string, unknown>;
      content.push({ type: "text", text: typeof resource.text === "string" ? resource.text : `[MCP 资源] ${String(resource.uri || "")}` });
    } else if (item.type === "resource_link") {
      content.push({ type: "text", text: `[MCP 资源链接] ${String(item.title || item.name || "")} ${String(item.uri || "")}`.trim() });
    } else {
      content.push({ type: "text", text: JSON.stringify(item) });
    }
  }
  if (!content.length && result.structuredContent) content.push({ type: "text", text: JSON.stringify(result.structuredContent, null, 2) });
  if (!content.length) content.push({ type: "text", text: "MCP 工具执行完成。" });
  return content;
}

export function resourceContent(result: { contents?: McpResourceContents[] }): Array<{ type: "text"; text: string } | { type: "image"; data: string; mimeType: string }> {
  const content: Array<{ type: "text"; text: string } | { type: "image"; data: string; mimeType: string }> = [];
  for (const resource of result.contents || []) {
    if (typeof resource.text === "string") {
      const limit = 200_000;
      const suffix = resource.text.length > limit ? `\n\n[内容已截断：原始长度 ${resource.text.length.toLocaleString()} 字符]` : "";
      content.push({ type: "text", text: `资源：${resource.uri}\n\n${resource.text.slice(0, limit)}${suffix}` });
    } else if (typeof resource.blob === "string" && resource.mimeType?.startsWith("image/")) {
      content.push({ type: "image", data: resource.blob, mimeType: resource.mimeType });
    } else if (typeof resource.blob === "string") {
      content.push({ type: "text", text: `资源：${resource.uri}\n二进制内容 · ${resource.mimeType || "application/octet-stream"} · ${resource.blob.length} 个 Base64 字符` });
    }
  }
  return content.length ? content : [{ type: "text", text: "MCP 服务器返回了空资源。" }];
}

export function resourceListMarkdown(server: ConnectedServer, resources: McpResource[]): string {
  const title = server.config.name || server.config.id;
  if (!resources.length) return `### MCP 资源 · ${title}\n\n该服务器没有返回资源。`;
  return `### MCP 资源 · ${title}\n\n${resources.map((resource) => {
    const label = resource.title || resource.name || resource.uri;
    const metadata = [resource.mimeType, resource.description].filter(Boolean).join(" · ");
    return `- **${label}**\n  - URI: \`${resource.uri}\`${metadata ? `\n  - ${metadata}` : ""}`;
  }).join("\n")}`;
}

export function promptListMarkdown(server: ConnectedServer, prompts: McpPrompt[]): string {
  const title = server.config.name || server.config.id;
  if (!prompts.length) return `### MCP 提示词 · ${title}\n\n该服务器没有返回提示词。`;
  return `### MCP 提示词 · ${title}\n\n${prompts.map((prompt) => {
    const args = (prompt.arguments || []).map((arg) => `${arg.name}${arg.required ? "*" : ""}`).join(", ");
    return `- **${prompt.title || prompt.name}**${prompt.description ? `：${prompt.description}` : ""}${args ? `\n  - 参数：${args}` : ""}`;
  }).join("\n")}`;
}

export function promptResultMarkdown(server: ConnectedServer, name: string, result: McpPromptResult): string {
  const messages = (result.messages || []).map((message) => {
    const raw = message.content || {};
    const body = typeof raw.text === "string" ? raw.text : JSON.stringify(raw, null, 2);
    return `#### ${message.role || "message"}\n\n${body}`;
  }).join("\n\n");
  return `### MCP 提示词 · ${server.config.name || server.config.id} / ${name}${result.description ? `\n\n${result.description}` : ""}${messages ? `\n\n${messages}` : "\n\n服务器返回了空提示词。"}`;
}

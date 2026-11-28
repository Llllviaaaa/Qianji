/**
 * Streamable HTTP MCP transport with dynamic OAuth 2.1 Bearer header injection
 * and transparent `401 Unauthorized` token refresh retry (`packages/mcp/src/http-client.ts`).
 */
import {
  errorText,
  parseSse,
  PROTOCOL_VERSION,
  SUPPORTED_PROTOCOL_VERSIONS,
  type JsonRpcMessage,
  type McpCapabilities,
  type McpClient,
  type McpConnectResult,
  type McpHttpAuthProvider,
  type McpNotificationHandler,
  type McpPrompt,
  type McpPromptResult,
  type McpResource,
  type McpResourceContents,
  type McpServerConfig,
  type McpTool,
  type McpToolResult,
} from "./client.ts";

export class HttpMcpClient implements McpClient {
  private nextId = 1;
  private sessionId: string | undefined;
  private negotiatedVersion: string | undefined;
  private notificationHandler: McpNotificationHandler | undefined;
  private disconnectHandler: ((error: Error) => void) | undefined;
  private eventStreamAbort: AbortController | undefined;
  private eventStreamTask: Promise<void> | undefined;
  private reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  private reconnectWake: (() => void) | undefined;
  private closing = false;

  constructor(
    private readonly config: McpServerConfig,
    private readonly authProvider?: McpHttpAuthProvider,
  ) {}

  async connect(): Promise<McpConnectResult> {
    const result = await this.request("initialize", {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: "Qianji", version: "0.4.0" },
    }) as { protocolVersion?: string; capabilities?: McpCapabilities };
    this.negotiatedVersion = result.protocolVersion || PROTOCOL_VERSION;
    if (!SUPPORTED_PROTOCOL_VERSIONS.has(this.negotiatedVersion)) {
      throw new Error(`MCP server selected unsupported protocol version ${this.negotiatedVersion}`);
    }
    await this.notification("notifications/initialized");
    this.startEventStream();
    return { protocolVersion: this.negotiatedVersion, capabilities: result.capabilities || {} };
  }

  setNotificationHandler(handler: McpNotificationHandler): void {
    this.notificationHandler = handler;
  }

  setDisconnectHandler(handler: (error: Error) => void): void {
    this.disconnectHandler = handler;
    void this.disconnectHandler;
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
    return this.request("tools/call", { name, arguments: args }, signal, 120_000) as Promise<McpToolResult>;
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
    this.eventStreamAbort?.abort();
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectWake?.();
    this.reconnectTimer = undefined;
    this.reconnectWake = undefined;
    if (!this.sessionId) return;
    const closingSessionId = this.sessionId;
    this.sessionId = undefined;
    void (async () => {
      const dynamic = await this.authProvider?.headers(this.config.id, this.config.url).catch(() => undefined);
      const headers: Record<string, string> = {
        ...this.config.headers,
        ...dynamic,
        "mcp-session-id": closingSessionId,
      };
      if (this.negotiatedVersion) headers["mcp-protocol-version"] = this.negotiatedVersion;
      await fetch(this.config.url, { method: "DELETE", headers }).catch(() => undefined);
    })();
  }

  private async request(method: string, params: Record<string, unknown>, signal?: AbortSignal, timeoutMs = 20_000): Promise<unknown> {
    const id = this.nextId++;
    const message: JsonRpcMessage = { jsonrpc: "2.0", id, method, params };
    const response = await this.post(message, signal, timeoutMs);
    for (const entry of response) {
      if (entry.method && entry.id === undefined) this.dispatchNotification(entry);
    }
    const matched = response.find((entry) => entry.id === id);
    if (!matched) throw new Error(`MCP HTTP response did not include request ${id}`);
    if (matched.error) throw new Error(`MCP ${matched.error.code}: ${matched.error.message}`);
    return matched.result;
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

  private async notification(method: string, params?: Record<string, unknown>): Promise<void> {
    await this.post({ jsonrpc: "2.0", method, ...(params ? { params } : {}) }, undefined, 20_000);
  }

  private async resolveAuthHeaders(): Promise<Record<string, string>> {
    const dynamic = await this.authProvider?.headers(this.config.id, this.config.url);
    return { ...this.config.headers, ...dynamic };
  }

  private async post(
    message: JsonRpcMessage,
    signal?: AbortSignal,
    timeoutMs = 20_000,
    retriedAfterRefresh = false,
  ): Promise<JsonRpcMessage[]> {
    const timeoutController = new AbortController();
    const timeout = setTimeout(() => timeoutController.abort(), timeoutMs);
    const abort = () => timeoutController.abort();
    signal?.addEventListener("abort", abort, { once: true });
    try {
      const authHeaders = await this.resolveAuthHeaders();
      const headers: Record<string, string> = {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        ...authHeaders,
      };
      if (this.sessionId) headers["mcp-session-id"] = this.sessionId;
      if (this.negotiatedVersion) headers["mcp-protocol-version"] = this.negotiatedVersion;
      const response = await fetch(this.config.url, {
        method: "POST",
        headers,
        body: JSON.stringify(message),
        signal: timeoutController.signal,
      });
      if (response.status === 401 && !retriedAfterRefresh && this.authProvider?.onUnauthorized) {
        const wwwAuth = response.headers.get("www-authenticate") ?? undefined;
        const refreshed = await this.authProvider.onUnauthorized(this.config.id, this.config.url, wwwAuth);
        if (refreshed) {
          return await this.post(message, signal, timeoutMs, true);
        }
      }
      const nextSessionId = response.headers.get("mcp-session-id");
      if (nextSessionId) this.sessionId = nextSessionId;
      if (response.status === 202) return [];
      const body = await response.text();
      if (!response.ok) throw new Error(`MCP HTTP ${response.status}: ${body.slice(0, 500)}`);
      const contentType = response.headers.get("content-type") || "";
      if (contentType.includes("text/event-stream")) return parseSse(body);
      const parsed = JSON.parse(body) as JsonRpcMessage | JsonRpcMessage[];
      return Array.isArray(parsed) ? parsed : [parsed];
    } catch (error) {
      if (timeoutController.signal.aborted) {
        throw new Error("MCP HTTP request timed out or was cancelled", { cause: error });
      }
      throw error;
    } finally {
      clearTimeout(timeout);
      signal?.removeEventListener("abort", abort);
    }
  }

  private dispatchNotification(message: JsonRpcMessage): void {
    void Promise.resolve(this.notificationHandler?.(message)).catch((error) => {
      console.error(`MCP notification handler failed: ${errorText(error)}`);
    });
  }

  private startEventStream(): void {
    if (!this.sessionId || this.eventStreamTask || this.closing) return;
    this.eventStreamTask = this.consumeEventStream().finally(() => {
      this.eventStreamTask = undefined;
    });
  }

  private async consumeEventStream(): Promise<void> {
    let retryMs = 750;
    while (!this.closing && this.sessionId) {
      const controller = new AbortController();
      this.eventStreamAbort = controller;
      try {
        const authHeaders = await this.resolveAuthHeaders();
        const headers: Record<string, string> = {
          accept: "text/event-stream",
          ...authHeaders,
          "mcp-session-id": this.sessionId,
        };
        if (this.negotiatedVersion) headers["mcp-protocol-version"] = this.negotiatedVersion;
        const response = await fetch(this.config.url, { method: "GET", headers, signal: controller.signal });
        if (response.status === 401 && this.authProvider?.onUnauthorized) {
          await this.authProvider.onUnauthorized(
            this.config.id,
            this.config.url,
            response.headers.get("www-authenticate") ?? undefined,
          );
        }
        if (response.status === 404 || response.status === 405) return;
        if (!response.ok) throw new Error(`MCP HTTP event stream returned ${response.status}`);
        if (!(response.headers.get("content-type") || "").includes("text/event-stream") || !response.body) return;
        retryMs = 750;
        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";
        while (!this.closing) {
          const { value, done } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          while (true) {
            const boundary = buffer.search(/\r?\n\r?\n/);
            if (boundary < 0) break;
            const separator = buffer.slice(boundary).match(/^\r?\n\r?\n/)?.[0] || "\n\n";
            const event = buffer.slice(0, boundary);
            buffer = buffer.slice(boundary + separator.length);
            for (const message of parseSse(`${event}\n\n`)) this.dispatchNotification(message);
          }
        }
        buffer += decoder.decode();
        for (const message of parseSse(buffer)) this.dispatchNotification(message);
      } catch (error) {
        if (this.closing || controller.signal.aborted) return;
        console.error(`MCP HTTP event stream disconnected: ${errorText(error)}`);
      } finally {
        if (this.eventStreamAbort === controller) this.eventStreamAbort = undefined;
      }
      await this.waitForReconnect(retryMs);
      retryMs = Math.min(retryMs * 2, 10_000);
    }
  }

  private waitForReconnect(delayMs: number): Promise<void> {
    if (this.closing) return Promise.resolve();
    return new Promise((resolve) => {
      this.reconnectWake = resolve;
      this.reconnectTimer = setTimeout(() => {
        this.reconnectTimer = undefined;
        this.reconnectWake = undefined;
        resolve();
      }, delayMs);
    });
  }
}

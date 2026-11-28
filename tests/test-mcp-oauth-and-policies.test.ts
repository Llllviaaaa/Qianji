/**
 * Integration tests for Bot Mode Connectors 2.0 backend:
 * 1. Full OAuth 2.1 Discovery + RFC 7591 Dynamic Client Registration + S256 PKCE loopback exchange.
 * 2. MCP per-tool policy enforcement (`allow` / `ask` -> approval queue / `deny`) in Bot sessions.
 */
import { createHash } from "node:crypto";
import { createServer as createHttpServer } from "node:http";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { Service, type Context } from "@deepseek-ai/cordis";
import { AgentLoop } from "@qianji/agent-loop";
import { cleanupOrphanedBrowserProfile } from "@qianji/browser";
import { Credentials, LlmService } from "@qianji/llm";
import * as promptContext from "@qianji/prompt-context";
import type { RpcHandler, RpcService } from "@qianji/rpc";
import { Sessions } from "@qianji/session";
import { SystemPrompt } from "@qianji/system-prompt";
import { textOutput, Tools } from "@qianji/tools";
import { Ui } from "@qianji/ui";
import * as botPlugin from "../packages/host/src/bot/index";
import { discoverMcpOAuthMetadata, runMcpOAuthFlow } from "../packages/host/src/bot/connectors/mcp-oauth";
import { createHost } from "../packages/host/src/host";
import { PluginManager } from "../packages/host/src/plugin-manager";
import * as pluginsRpc from "../packages/host/src/plugins-rpc";
import * as sessionsRpc from "../packages/host/src/sessions-rpc";

class SpyRpc extends Service implements RpcService {
  static provide = "rpc";
  private readonly handlers = new Map<string, RpcHandler>();

  constructor(ctx: Context) {
    super(ctx, "rpc");
  }

  method(name: string, handler: RpcHandler): () => void {
    this.handlers.set(name, handler);
    return () => {
      if (this.handlers.get(name) === handler) this.handlers.delete(name);
    };
  }

  methods(): string[] {
    return ["initialize", ...this.handlers.keys()];
  }

  broadcast(): void {}

  async invoke<T>(name: string, params: unknown = {}): Promise<T> {
    const fn = this.handlers.get(name);
    if (!fn) throw new Error(`RPC method not registered: ${name}`);
    return (await fn(params, { signal: new AbortController().signal, notify: () => undefined })) as T;
  }
}

describe("Bot Connectors 2.0: OAuth 2.1 PKCE & Granular MCP Policies", () => {
  const cleanups: Array<() => Promise<void> | void> = [];

  afterEach(async () => {
    while (cleanups.length > 0) {
      const fn = cleanups.pop();
      if (fn) await fn();
    }
  });

  it("completes RFC 8414 discovery + RFC 7591 client registration + S256 PKCE loopback token exchange", async () => {
    let seenChallenge = "";
    let verifiedVerifier = false;
    let baseUrl = "";

    const srv = createHttpServer(async (req, res) => {
      const reqUrl = new URL(req.url ?? "/", baseUrl);
      if (reqUrl.pathname === "/.well-known/oauth-authorization-server") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            issuer: baseUrl,
            authorization_endpoint: `${baseUrl}/authorize`,
            token_endpoint: `${baseUrl}/token`,
            registration_endpoint: `${baseUrl}/register`,
          }),
        );
        return;
      }
      if (reqUrl.pathname === "/register" && req.method === "POST") {
        res.writeHead(201, { "content-type": "application/json" });
        res.end(JSON.stringify({ client_id: "dyn-client-qianji" }));
        return;
      }
      if (reqUrl.pathname === "/token" && req.method === "POST") {
        const chunks: Buffer[] = [];
        for await (const c of req) chunks.push(c as Buffer);
        const params = new URLSearchParams(Buffer.concat(chunks).toString("utf8"));
        const verifier = params.get("code_verifier") ?? "";
        const computed = createHash("sha256")
          .update(verifier)
          .digest("base64")
          .replace(/\+/g, "-")
          .replace(/\//g, "_")
          .replace(/=+$/g, "");
        verifiedVerifier = computed === seenChallenge && params.get("client_id") === "dyn-client-qianji";
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ access_token: "example_oauth_access_tok_123", token_type: "Bearer" }));
        return;
      }
      res.writeHead(404).end();
    });
    await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
    const addr = srv.address();
    baseUrl = `http://127.0.0.1:${typeof addr === "object" && addr ? addr.port : 0}`;
    cleanups.push(() => new Promise<void>((r) => srv.close(() => r())));

    const result = await runMcpOAuthFlow(`${baseUrl}/mcp`, {
      openBrowser: async (authUrl) => {
        const u = new URL(authUrl);
        seenChallenge = u.searchParams.get("code_challenge") ?? "";
        const redirect = u.searchParams.get("redirect_uri") ?? "";
        const state = u.searchParams.get("state") ?? "";
        await fetch(`${redirect}?code=auth_code_xyz&state=${encodeURIComponent(state)}`);
      },
    });

    expect(verifiedVerifier).toBe(true);
    expect(result.accessToken).toBe("example_oauth_access_tok_123");
    expect(result.tokenType).toBe("Bearer");
  });

  it("discovers path-scoped RFC 9728 protected-resource metadata before root fallback", async () => {
    let baseUrl = "";
    const srv = createHttpServer((req, res) => {
      const reqUrl = new URL(req.url ?? "/", baseUrl);
      if (reqUrl.pathname === "/.well-known/oauth-protected-resource/mcp") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ resource: `${baseUrl}/mcp`, authorization_servers: [`${baseUrl}/auth`] }));
        return;
      }
      if (reqUrl.pathname === "/.well-known/oauth-authorization-server") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            issuer: `${baseUrl}/auth`,
            authorization_endpoint: `${baseUrl}/authorize`,
            token_endpoint: `${baseUrl}/token`,
            registration_endpoint: `${baseUrl}/oauth/register`,
          }),
        );
        return;
      }
      res.writeHead(404).end();
    });
    await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
    const addr = srv.address();
    baseUrl = `http://127.0.0.1:${typeof addr === "object" && addr ? addr.port : 0}`;
    cleanups.push(() => new Promise<void>((r) => srv.close(() => r())));

    const meta = await discoverMcpOAuthMetadata(`${baseUrl}/mcp`);
    expect(meta.registrationEndpoint).toBe(`${baseUrl}/oauth/register`);
  });

  it("recovers orphaned browser profile locks left by dead processes", async () => {
    const profileDir = mkdtempSync(join(tmpdir(), "qj-browser-lock-"));
    cleanups.push(() => rmSync(profileDir, { recursive: true, force: true }));

    const lockFile = join(profileDir, ".qianji-browser.lock");
    const portFile = join(profileDir, "DevToolsActivePort");
    writeFileSync(lockFile, "99999999\n", "utf8");
    writeFileSync(portFile, "65499\n/devtools/browser/dead\n", "utf8");

    await cleanupOrphanedBrowserProfile(profileDir);
    expect(existsSync(lockFile)).toBe(false);
    expect(existsSync(portFile)).toBe(false);
  });

  it("discovers MCP tools via RPC and enforces allow / ask / deny per-tool overrides in Bot sessions", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "qj-mcp-policy-"));
    cleanups.push(() => rmSync(dataDir, { recursive: true, force: true }));

    const host = createHost({
      version: "0.3.0-test",
      dataDir,
      plugins: [
        [Credentials],
        [LlmService],
        [Sessions],
        [Ui],
        [Tools],
        [SystemPrompt],
        [SpyRpc],
        [promptContext, { dataDir }],
        [AgentLoop],
        [sessionsRpc],
        [botPlugin, { dataDir, displayName: "千机", serverMode: "local", distroName: "qianji-bot-unit-noop" }],
      ],
    });
    await host.start();
    cleanups.push(() => host.stop());

    let writeExecCount = 0;
    host.ctx.tools.register({
      name: "mcp__preset-mcp-linear__search_issues",
      description: "[MCP: Linear] 查询 Linear Issue",
      group: "mcp_preset-mcp-linear",
      readOnly: true,
      parameters: { type: "object", properties: { q: { type: "string" } } },
      execute: async () => textOutput("found 2 issues"),
    });
    host.ctx.tools.register({
      name: "mcp__preset-mcp-linear__create_issue",
      description: "[MCP: Linear] 创建 Linear Issue",
      group: "mcp_preset-mcp-linear",
      readOnly: false,
      parameters: { type: "object", properties: { title: { type: "string" } } },
      execute: async () => {
        writeExecCount += 1;
        return textOutput("created issue");
      },
    });

    const rpc = host.ctx.rpc as unknown as SpyRpc;
    const discovered = await rpc.invoke<{ tools: Array<{ rawName: string; readOnly: boolean }> }>("bot.connector.mcpTools", {
      serverId: "preset-mcp-linear",
    });
    expect(discovered.tools).toHaveLength(2);
    expect(discovered.tools.some((t) => t.rawName === "search_issues" && t.readOnly)).toBe(true);

    const snap0 = await rpc.invoke<{ mainSessionId: string }>("bot.getSnapshot", {});
    await rpc.invoke("bot.configure", {
      appPolicies: {
        linear: {
          connected: true,
          authKind: "oauth",
          policy: "low-risk-auto",
          actionPermissions: {
            "mcp__preset-mcp-linear__search_issues": "allow",
            "mcp__preset-mcp-linear__create_issue": "ask",
          },
        },
      },
    });

    const signal = new AbortController().signal;
    const readOut = await host.ctx.tools.execute(
      { id: "c1", name: "mcp__preset-mcp-linear__search_issues", args: { q: "bug" } },
      { sessionId: snap0.mainSessionId, cwd: dataDir, signal },
    );
    expect(readOut.isError).toBeFalsy();
    expect(JSON.stringify(readOut.content)).toContain("found 2 issues");

    const askOut = await host.ctx.tools.execute(
      { id: "c2", name: "mcp__preset-mcp-linear__create_issue", args: { title: "Fix OAuth" } },
      { sessionId: snap0.mainSessionId, cwd: dataDir, signal },
    );
    expect(askOut.isError).toBe(true);
    expect(writeExecCount).toBe(0);

    const snap1 = await rpc.invoke<{ pendingApprovals: Array<{ title: string }> }>("bot.getSnapshot", {});
    expect(snap1.pendingApprovals.some((a) => a.title.includes("linear"))).toBe(true);

    await rpc.invoke("bot.configure", {
      appPolicies: { linear: { policy: "strict-read-only", connected: true } },
    });
    const denyOut = await host.ctx.tools.execute(
      { id: "c3", name: "mcp__preset-mcp-linear__create_issue", args: { title: "Blocked" } },
      { sessionId: snap0.mainSessionId, cwd: dataDir, signal },
    );
    expect(JSON.stringify(denyOut.content)).toContain("权限策略已禁用");
  });

  it("isolates legacy external plugins to Agent by default, and governs Plugin-contributed Connectors across Bot & Agent", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "qj-plugin-connector-"));
    const legacyDir = mkdtempSync(join(tmpdir(), "qj-ext-legacy-"));
    const connPluginDir = mkdtempSync(join(tmpdir(), "qj-ext-yuque-"));
    cleanups.push(() => {
      rmSync(dataDir, { recursive: true, force: true });
      rmSync(legacyDir, { recursive: true, force: true });
      rmSync(connPluginDir, { recursive: true, force: true });
    });

    // 1. Legacy plugin without `qianji.targets` -> defaults to Agent=true, Bot=false
    writeFileSync(
      join(legacyDir, "package.json"),
      JSON.stringify({
        name: "legacy-coding-helper",
        version: "0.1.0",
        type: "module",
        qianji: { id: "legacy-coding-helper", name: "Legacy Helper", host: "./index.ts", inject: ["tools"] },
      }),
    );
    writeFileSync(
      join(legacyDir, "index.ts"),
      `import { textOutput } from "@qianji/tools";
export const name = "legacy-coding-helper";
export const inject = ["tools"];
export function apply(ctx) {
  ctx.tools.register({
    name: "legacy_ide_lint",
    description: "IDE-only lint tool",
    readOnly: true,
    parameters: { type: "object", properties: {} },
    execute: async () => textOutput("lint-ok"),
  });
}
`,
    );

    // 2. Connector plugin contributing `yuque` via `qianji.connectors` + `ctx.connectors.register`
    writeFileSync(
      join(connPluginDir, "package.json"),
      JSON.stringify({
        name: "yuque-plugin",
        version: "0.1.0",
        type: "module",
        qianji: {
          id: "yuque-plugin",
          name: "语雀连接器插件",
          host: "./index.ts",
          targets: ["agent", "bot"],
          inject: ["tools", "connectors"],
          connectors: [
            { id: "yuque", name: "语雀", tagline: "检索并经批准写入语雀文档", category: "office" },
          ],
        },
      }),
    );
    writeFileSync(
      join(connPluginDir, "index.ts"),
      `import { textOutput } from "@qianji/tools";
export const name = "yuque-plugin";
export const inject = ["tools", "connectors"];
export function apply(ctx) {
  ctx.connectors.register({
    id: "yuque",
    name: "语雀",
    async connect() {
      return { connected: true, accountLabel: "team@yuque" };
    },
  });
  ctx.tools.register({
    name: "yuque_read_doc",
    description: "读取语雀文档",
    readOnly: true,
    parameters: { type: "object", properties: {} },
    execute: async () => textOutput("yuque-doc-content"),
  });
  ctx.tools.register({
    name: "yuque_write_doc",
    description: "更新语雀文档",
    readOnly: false,
    parameters: { type: "object", properties: {} },
    execute: async () => textOutput("yuque-written"),
  });
}
`,
    );

    const managerHolder: { current: PluginManager | undefined } = { current: undefined };
    const host = createHost({
      version: "0.3.0-test",
      dataDir,
      plugins: [
        [Credentials],
        [LlmService],
        [Sessions],
        [Ui],
        [Tools],
        [SystemPrompt],
        [SpyRpc],
        [promptContext, { dataDir }],
        [AgentLoop],
        [sessionsRpc],
        [botPlugin, { dataDir, displayName: "千机", serverMode: "local", distroName: "qianji-bot-unit-noop", pluginManager: () => managerHolder.current }],
      ],
    });
    await host.start();
    const manager = new PluginManager(host.ctx, { dataDir, version: "0.3.0-test" });
    managerHolder.current = manager;
    host.ctx.plugin(pluginsRpc, { manager });
    cleanups.push(async () => {
      await host.stop();
    });

    await manager.install({ channel: "local", spec: legacyDir, link: true, watch: false });
    await manager.install({ channel: "local", spec: connPluginDir, link: true, watch: false });

    const rpc = host.ctx.rpc as unknown as SpyRpc;
    const botSnap = await rpc.invoke<{ mainSessionId: string }>("bot.getSnapshot", {});
    const agentSess = await host.ctx.sessions.create({ cwd: dataDir });

    // Legacy plugin is visible to Agent, hidden from Bot by default
    expect(host.ctx.tools.schemas(agentSess.id).some((t) => t.name === "legacy_ide_lint")).toBe(true);
    expect(host.ctx.tools.schemas(botSnap.mainSessionId).some((t) => t.name === "legacy_ide_lint")).toBe(false);

    // User opts legacy plugin into Bot via `plugin.setScope`
    await rpc.invoke("plugin.setScope", { id: "legacy-coding-helper", mode: "bot", enabled: true });
    expect(host.ctx.tools.schemas(botSnap.mainSessionId).some((t) => t.name === "legacy_ide_lint")).toBe(true);

    // Unconnected connector plugin hides its tools in Bot until connected, while appearing in pluginCatalog
    const catalogRes = await rpc.invoke<{ items: Array<{ connector: { id: string } }> }>("bot.connector.pluginCatalog", {});
    expect(catalogRes.items.some((i) => i.connector.id === "yuque")).toBe(true);
    expect(host.ctx.tools.schemas(botSnap.mainSessionId).some((t) => t.name === "yuque_read_doc")).toBe(false);

    // Connect `yuque` in Bot Connectors -> tools appear in Bot, read succeeds, write queues into Bot Approvals
    const connRes = await rpc.invoke<{ status: string; accountLabel: string }>("bot.connector.pluginConnect", {
      pluginId: "yuque-plugin",
      connectorId: "yuque",
    });
    expect(connRes.status).toBe("connected");
    expect(connRes.accountLabel).toBe("team@yuque");
    expect(host.ctx.tools.schemas(botSnap.mainSessionId).some((t) => t.name === "yuque_read_doc")).toBe(true);

    const signal = new AbortController().signal;
    const readRes = await host.ctx.tools.execute(
      { id: "y1", name: "yuque_read_doc", args: {} },
      { sessionId: botSnap.mainSessionId, cwd: dataDir, signal },
    );
    expect(readRes.isError).toBeFalsy();
    expect(JSON.stringify(readRes.content)).toContain("yuque-doc-content");

    const writeRes = await host.ctx.tools.execute(
      { id: "y2", name: "yuque_write_doc", args: {} },
      { sessionId: botSnap.mainSessionId, cwd: dataDir, signal },
    );
    expect(writeRes.isError).toBe(true);
    const snapAfter = await rpc.invoke<{ pendingApprovals: Array<{ title: string }> }>("bot.getSnapshot", {});
    expect(snapAfter.pendingApprovals.some((a) => a.title.includes("yuque"))).toBe(true);
  });
});

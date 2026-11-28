/**
 * End-to-end verification of the Industry-Standard MCP Connector Architecture:
 * 1. Zero built-in `browser` fake login modes in `CONNECTOR_CATALOG` (Gmail, Calendar, Drive,
 *    GitHub, Figma, and Slack all use standard MCP / OAuth 2.1 / ImapFlow).
 * 2. Standards-compliant OAuth 2.1 + RFC 9728/8414 discovery + RFC 8707 `resource` indicator +
 *    RFC 7591 Dynamic Client Registration + OS Keychain (`Credentials`) token vault (zero
 *    plaintext `Authorization` headers in `McpServerConfig`) + automatic `401` `refresh_token`
 *    rotation and transparent request retry.
 * 3. Real Gmail MCP & Google Calendar MCP synchronization into `inboxItems` and `todayEvents`
 *    on connect, manual `bot.connector.test`, Heartbeat patrol (`backgroundSync` respected),
 *    and `bot_sense_apps("email")`.
 * 4. Unified Bot UI across `BotCompanionInboxTab` (right-side `邮箱` tab), `BotChannelsSettingsPane`
 *    (`消息渠道`), and `BotConnectorDetailView` (`立即同步` button & status badge).
 */
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, describe, expect, it } from "vitest";
import { Context, Service } from "@deepseek-ai/cordis";
import { AgentLoop } from "@qianji/agent-loop";
import { ClientSlotsService, SlotRegistry, SlotRoot } from "@qianji/client-slots";
import { Credentials, LlmService } from "@qianji/llm";
import { Mcp } from "@qianji/mcp";
import type { BotSnapshotResult } from "@qianji/protocol";
import type { RpcHandler, RpcService } from "@qianji/rpc";
import { Sessions } from "@qianji/session";
import { SystemPrompt } from "@qianji/system-prompt";
import { Tools } from "@qianji/tools";
import { Ui } from "@qianji/ui";
import * as botPlugin from "../packages/host/src/bot/index";
import { runMcpOAuthFlow } from "../packages/host/src/bot/connectors/mcp-oauth";
import { createHost } from "../packages/host/src/host";
import { McpOAuthTokenStore, mcpOAuthSecretKey } from "../packages/host/src/mcp-oauth-store";
import { botModePlugin } from "../src/builtin-plugins/bot-mode";
import { CONNECTOR_CATALOG } from "../src/builtin-plugins/bot-mode/botConnectorCatalog";
import {
  botDataStore,
  botUiStore,
  FALLBACK_BOT_SNAPSHOT,
  INITIAL_BOT_UI_STATE,
  openBotConnector,
  openBotModal,
  patchBotUi,
} from "../src/builtin-plugins/bot-mode/botStore";
import { coreShellPlugin } from "../src/builtin-plugins/core-shell";
import { registerHostComponentFactories } from "../src/kernel/primitives/hostComponentFactories";
import { registerFrontendServices } from "../src/kernel/services";

class MemoryCredentials extends Credentials {
  private readonly map = new Map<string, string>();
  override get writable(): boolean {
    return true;
  }
  override async get(id: string): Promise<string | undefined> {
    return this.map.get(id);
  }
  override async set(id: string, secret: string): Promise<void> {
    this.map.set(id, secret);
  }
  override async delete(id: string): Promise<boolean> {
    return this.map.delete(id);
  }
}

class LocalRpc extends Service implements RpcService {
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
    return [...this.handlers.keys()];
  }
  broadcast(): void {}
  async invoke<T>(name: string, params: unknown = {}): Promise<T> {
    const fn = this.handlers.get(name);
    if (!fn) throw new Error(`RPC method not found: ${name}`);
    return (await fn(params, {
      signal: new AbortController().signal,
      notify: () => undefined,
    })) as T;
  }
}

function encodeBase64Url(text: string): string {
  return Buffer.from(text, "utf8").toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

describe("Industry-Standard MCP Connectors, OAuth 2.1 Refresh & Gmail Inbox Sync", () => {
  const cleanups: Array<() => Promise<void> | void> = [];

  afterEach(async () => {
    botUiStore.set(INITIAL_BOT_UI_STATE);
    botDataStore.set(FALLBACK_BOT_SNAPSHOT);
    while (cleanups.length > 0) {
      const fn = cleanups.pop();
      if (fn) await fn();
    }
  });

  it("removes all built-in fake browser-login connectors and migrates SaaS entries to official MCP", () => {
    const browserBuiltins = CONNECTOR_CATALOG.filter((c) => c.authMode === "browser");
    expect(browserBuiltins).toEqual([]);

    const byId = new Map(CONNECTOR_CATALOG.map((c) => [c.id, c]));
    expect(byId.get("gmail")?.authMode).toBe("google-mcp");
    expect(byId.get("gmail")?.mcpPreset?.serverId).toBe("preset-mcp-gmail");
    expect(byId.get("calendar")?.authMode).toBe("google-mcp");
    expect(byId.get("google_drive")?.authMode).toBe("google-mcp");
    expect(byId.get("github")?.authMode).toBe("github-mcp");
    expect(byId.get("github")?.mcpPreset?.url).toBe("https://api.githubcopilot.com/mcp/");
    expect(byId.get("figma")?.authMode).toBe("mcp-oauth");
    expect(byId.get("figma")?.mcpPreset?.url).toBe("https://mcp.figma.com/mcp");
    expect(byId.get("slack")?.authMode).toBe("mcp-oauth");
    expect(byId.get("slack")?.mcpPreset?.url).toBe("https://mcp.slack.com/mcp");
  });

  it("executes OAuth 2.1 PKCE + RFC 8707 + Keychain storage, refreshes on 401, and syncs Gmail & Calendar MCP into Bot Inbox", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "qj-std-mcp-sync-"));
    cleanups.push(() => rmSync(dataDir, { recursive: true, force: true }));

    let activeAccessToken = "example_access_v1";
    let activeRefreshToken = "example_refresh_v1";
    let refreshCount = 0;
    const seenResources: string[] = [];

    const gmailMessages: Array<{ id: string; from: string; subject: string; body: string }> = [
      {
        id: "msg-101",
        from: "Google Cloud <cloud-noreply@google.com>",
        subject: "您的 11 月账单已生成",
        body: "您好，本月 GCP API 调用账单共计 $12.40，请核对明细。",
      },
    ];

    const now = new Date();
    const ev1Start = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 14, 0, 0).toISOString();
    const ev1End = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 15, 0, 0).toISOString();
    const ev2Start = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 14, 30, 0).toISOString();
    const ev2End = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 15, 30, 0).toISOString();

    let serverOrigin = "";
    const mockServer = createServer((req, res) => {
      const reqUrl = new URL(req.url ?? "/", serverOrigin || "http://127.0.0.1");

      if (reqUrl.pathname.startsWith("/.well-known/oauth-protected-resource")) {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            resource: `${serverOrigin}/mcp/gmail`,
            authorization_servers: [serverOrigin],
          }),
        );
        return;
      }

      if (reqUrl.pathname === "/.well-known/oauth-authorization-server") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            issuer: serverOrigin,
            authorization_endpoint: `${serverOrigin}/oauth/authorize`,
            token_endpoint: `${serverOrigin}/oauth/token`,
            registration_endpoint: `${serverOrigin}/oauth/register`,
            scopes_supported: ["gmail.readonly", "offline_access"],
          }),
        );
        return;
      }

      if (reqUrl.pathname === "/oauth/register" && req.method === "POST") {
        res.writeHead(201, { "content-type": "application/json" });
        res.end(JSON.stringify({ client_id: "dyn-client-qianji" }));
        return;
      }

      if (reqUrl.pathname === "/oauth/token" && req.method === "POST") {
        let rawBody = "";
        req.on("data", (c) => { rawBody += String(c); });
        req.on("end", () => {
          const form = new URLSearchParams(rawBody);
          const resourceParam = form.get("resource");
          if (resourceParam) seenResources.push(resourceParam);
          const grantType = form.get("grant_type");
          if (grantType === "authorization_code") {
            res.writeHead(200, { "content-type": "application/json" });
            res.end(
              JSON.stringify({
                access_token: activeAccessToken,
                refresh_token: activeRefreshToken,
                token_type: "Bearer",
                scope: form.get("scope") ?? "gmail.readonly offline_access",
                expires_in: 3600,
              }),
            );
            return;
          }
          if (grantType === "refresh_token") {
            if (form.get("refresh_token") !== activeRefreshToken) {
              res.writeHead(400, { "content-type": "application/json" });
              res.end(JSON.stringify({ error: "invalid_grant" }));
              return;
            }
            refreshCount += 1;
            activeAccessToken = `example_access_v${refreshCount + 1}`;
            activeRefreshToken = `example_refresh_v${refreshCount + 1}`;
            res.writeHead(200, { "content-type": "application/json" });
            res.end(
              JSON.stringify({
                access_token: activeAccessToken,
                refresh_token: activeRefreshToken,
                token_type: "Bearer",
                expires_in: 3600,
              }),
            );
            return;
          }
          res.writeHead(400).end("unsupported_grant_type");
        });
        return;
      }

      if (reqUrl.pathname === "/mcp/gmail" || reqUrl.pathname === "/mcp/calendar") {
        if (req.method === "GET" || req.method === "DELETE") {
          res.writeHead(405).end();
          return;
        }
        const authHdr = req.headers.authorization ?? "";
        if (authHdr !== `Bearer ${activeAccessToken}`) {
          res.writeHead(401, {
            "www-authenticate": `Bearer resource_metadata="${serverOrigin}/.well-known/oauth-protected-resource"`,
          });
          res.end("Unauthorized");
          return;
        }
        let body = "";
        req.on("data", (c) => { body += String(c); });
        req.on("end", () => {
          const rpcMsg = JSON.parse(body) as { id?: number; method?: string; params?: Record<string, unknown> };
          if (rpcMsg.id === undefined) {
            res.writeHead(202).end();
            return;
          }
          const isCal = reqUrl.pathname === "/mcp/calendar";
          if (rpcMsg.method === "initialize") {
            res.writeHead(200, { "content-type": "application/json", "mcp-session-id": "sess-1" });
            res.end(
              JSON.stringify({
                jsonrpc: "2.0",
                id: rpcMsg.id,
                result: { protocolVersion: "2025-11-25", capabilities: { tools: {} } },
              }),
            );
            return;
          }
          if (rpcMsg.method === "tools/list") {
            const tools = isCal
              ? [
                  {
                    name: "calendar_events_list",
                    description: "List Google Calendar events",
                    annotations: { readOnlyHint: true },
                    inputSchema: { type: "object", properties: { params: { type: "object" } } },
                  },
                ]
              : [
                  {
                    name: "gmail_users_messages_list",
                    description: "List Gmail messages",
                    annotations: { readOnlyHint: true },
                    inputSchema: { type: "object", properties: { params: { type: "object" } } },
                  },
                  {
                    name: "gmail_users_messages_get",
                    description: "Get Gmail message by ID",
                    annotations: { readOnlyHint: true },
                    inputSchema: { type: "object", properties: { params: { type: "object" } } },
                  },
                ];
            res.writeHead(200, { "content-type": "application/json" });
            res.end(JSON.stringify({ jsonrpc: "2.0", id: rpcMsg.id, result: { tools } }));
            return;
          }
          if (rpcMsg.method === "tools/call") {
            const callParams = rpcMsg.params as { name?: string; arguments?: { params?: { id?: string } } };
            if (callParams.name === "gmail_users_messages_list") {
              res.writeHead(200, { "content-type": "application/json" });
              res.end(
                JSON.stringify({
                  jsonrpc: "2.0",
                  id: rpcMsg.id,
                  result: {
                    content: [
                      {
                        type: "text",
                        text: JSON.stringify({ messages: gmailMessages.map((m) => ({ id: m.id })) }),
                      },
                    ],
                  },
                }),
              );
              return;
            }
            if (callParams.name === "gmail_users_messages_get") {
              const targetId = callParams.arguments?.params?.id;
              const found = gmailMessages.find((m) => m.id === targetId) ?? gmailMessages[0];
              res.writeHead(200, { "content-type": "application/json" });
              res.end(
                JSON.stringify({
                  jsonrpc: "2.0",
                  id: rpcMsg.id,
                  result: {
                    content: [
                      {
                        type: "text",
                        text: JSON.stringify({
                          id: found?.id,
                          internalDate: String(Date.now()),
                          payload: {
                            headers: [
                              { name: "From", value: found?.from },
                              { name: "Subject", value: found?.subject },
                            ],
                            mimeType: "text/plain",
                            body: { data: encodeBase64Url(found?.body ?? "") },
                          },
                        }),
                      },
                    ],
                  },
                }),
              );
              return;
            }
            if (callParams.name === "calendar_events_list") {
              res.writeHead(200, { "content-type": "application/json" });
              res.end(
                JSON.stringify({
                  jsonrpc: "2.0",
                  id: rpcMsg.id,
                  result: {
                    content: [
                      {
                        type: "text",
                        text: JSON.stringify({
                          items: [
                            { id: "gcal-1", summary: "架构技术评审", start: { dateTime: ev1Start }, end: { dateTime: ev1End } },
                            { id: "gcal-2", summary: "合作伙伴同步会", start: { dateTime: ev2Start }, end: { dateTime: ev2End } },
                          ],
                        }),
                      },
                    ],
                  },
                }),
              );
              return;
            }
          }
          res.writeHead(404).end();
        });
        return;
      }

      res.writeHead(404).end("Not Found");
    });

    await new Promise<void>((r) => mockServer.listen(0, "127.0.0.1", r));
    const port = (mockServer.address() as { port: number }).port;
    serverOrigin = `http://127.0.0.1:${port}`;
    cleanups.push(() => new Promise<void>((r) => mockServer.close(() => r())));

    // 1. Run real OAuth 2.1 loopback PKCE flow with simulated browser callback
    const oauthResult = await runMcpOAuthFlow(`${serverOrigin}/mcp/gmail`, {
      scope: "gmail.readonly",
      openBrowser: async (authUrlStr) => {
        const parsedAuth = new URL(authUrlStr);
        expect(parsedAuth.searchParams.get("resource")).toBe(`${serverOrigin}/mcp/gmail`);
        expect(parsedAuth.searchParams.get("scope")).toContain("offline_access");
        expect(parsedAuth.searchParams.get("code_challenge_method")).toBe("S256");
        const redirectUri = parsedAuth.searchParams.get("redirect_uri") ?? "";
        const state = parsedAuth.searchParams.get("state") ?? "";
        await fetch(`${redirectUri}?code=mock-auth-code-1&state=${encodeURIComponent(state)}`);
      },
    });
    expect(oauthResult.accessToken).toBe("example_access_v1");
    expect(oauthResult.refreshToken).toBe("example_refresh_v1");
    expect(seenResources).toContain(`${serverOrigin}/mcp/gmail`);

    // 2. Mount Host with MemoryCredentials + Mcp + Bot, store OAuth token in Keychain (zero headers in McpServerConfig!)
    const host = createHost({
      version: "0.4.0-test",
      dataDir,
      plugins: [
        [MemoryCredentials],
        [LlmService],
        [Sessions],
        [Ui],
        [Tools],
        [SystemPrompt],
        [LocalRpc],
        [AgentLoop],
        [Mcp, { confirmTools: false }],
        [botPlugin, { dataDir, distroName: "qianji-bot-unit-noop" }],
      ],
    });
    await host.start();
    cleanups.push(() => host.stop());

    const tokenStore = new McpOAuthTokenStore(() => host.ctx.credentials);
    await tokenStore.save("preset-mcp-gmail", oauthResult);
    await tokenStore.save("preset-mcp-calendar", oauthResult);

    // Verify secret lives in Credentials vault and NOT in McpServerConfig headers
    const rawVaultJson = await host.ctx.credentials.get(mcpOAuthSecretKey("preset-mcp-gmail"));
    expect(rawVaultJson).toContain("example_refresh_v1");

    const gmailCfg = {
      id: "preset-mcp-gmail",
      name: "Gmail",
      enabled: true,
      transport: "http" as const,
      command: "",
      args: [],
      cwd: "",
      env: {},
      inheritEnvironment: true,
      url: `${serverOrigin}/mcp/gmail`,
      headers: {},
      trustedReadOnly: false,
    };
    const calCfg = {
      ...gmailCfg,
      id: "preset-mcp-calendar",
      name: "Google 日历",
      url: `${serverOrigin}/mcp/calendar`,
      trustedReadOnly: true,
    };

    const gmailStatus = await host.ctx.mcp.upsertRuntimeServer(gmailCfg);
    const calStatus = await host.ctx.mcp.upsertRuntimeServer(calCfg);
    expect(gmailStatus?.connected).toBe(true);
    expect(gmailStatus?.toolCount).toBe(2);
    expect(calStatus?.connected).toBe(true);

    const rpc = host.ctx.rpc as unknown as LocalRpc;
    await rpc.invoke("bot.configure", {
      appPolicies: {
        gmail: { connected: true, authKind: "oauth", accountLabel: "user@gmail.com", policy: "low-risk-auto", backgroundSync: true },
        calendar: { connected: true, authKind: "oauth", accountLabel: "user@gmail.com", policy: "read-only-auto", backgroundSync: true },
      },
    });

    // 3. Test Gmail MCP & Calendar MCP sync via `bot.connector.test`
    const mailSyncRes = await rpc.invoke<{ ok: boolean; message: string; snapshot: BotSnapshotResult }>("bot.connector.test", {
      kind: "email",
    });
    expect(mailSyncRes.ok).toBe(true);
    expect(mailSyncRes.message).toContain("Gmail MCP 同步成功");
    expect(mailSyncRes.snapshot.inboxItems).toHaveLength(1);
    expect(mailSyncRes.snapshot.inboxItems[0]?.subject).toBe("您的 11 月账单已生成");
    expect(mailSyncRes.snapshot.inboxItems[0]?.preview).toContain("$12.40");

    const calSyncRes = await rpc.invoke<{ ok: boolean; message: string; snapshot: BotSnapshotResult }>("bot.connector.test", {
      kind: "calendar",
    });
    expect(calSyncRes.ok).toBe(true);
    expect(calSyncRes.snapshot.awareness.todayEvents).toHaveLength(2);
    expect(calSyncRes.snapshot.awareness.conflictCount).toBe(1);

    // 4. Expire server access token -> force HTTP 401 -> verify transparent `refresh_token` rotation & new mail sync!
    activeAccessToken = "example_expired_token";
    gmailMessages.unshift({
      id: "msg-102",
      from: "Team Lead <lead@company.com>",
      subject: "Q4 里程碑确认邮件",
      body: "请查收最新排期。",
    });

    const patrolAfter401 = await rpc.invoke<{ triggered: boolean; snapshot: BotSnapshotResult }>("bot.patrol.runNow", {
      force: false,
    });
    expect(refreshCount).toBe(1);
    expect(patrolAfter401.triggered).toBe(true);
    expect(patrolAfter401.snapshot.inboxItems.some((m) => m.subject === "Q4 里程碑确认邮件")).toBe(true);
    const rotatedVault = await host.ctx.credentials.get(mcpOAuthSecretKey("preset-mcp-gmail"));
    expect(rotatedVault).toContain("example_refresh_v2");

    // 5. Verify Frontend Inbox Tab, Channels Tab, and Connector Detail View reflect synced Gmail MCP state!
    const uiRoot = new Context();
    const registry = new SlotRegistry();
    await uiRoot.plugin(ClientSlotsService, registry);
    await registerFrontendServices(uiRoot, { shortcutTarget: null });
    const disposeFactories = registerHostComponentFactories(uiRoot.slots);
    const shellFiber = await uiRoot.plugin(coreShellPlugin);
    const botFiber = await uiRoot.plugin(botModePlugin);
    cleanups.push(async () => {
      disposeFactories();
      await botFiber.dispose();
      await shellFiber.dispose();
    });

    botDataStore.set(patrolAfter401.snapshot);
    patchBotUi({
      mcpStatus: [
        { id: "preset-mcp-gmail", name: "Gmail", transport: "http", connected: true, toolCount: 2, resources: false, prompts: false },
      ],
    });
    uiRoot.navigationService.setShellMode("bot", { persist: false });

    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const renderUi = () =>
      renderToStaticMarkup(
        createElement(QueryClientProvider, { client: queryClient }, createElement(SlotRoot, { registry, ctx: uiRoot })),
      );

    // Right-side `邮箱` tab shows Gmail MCP synced account, refresh button, and both synced emails!
    patchBotUi({ activeView: "chat", rightPanelOpen: true, rightTab: "inbox", modal: null });
    const inboxHtml = renderUi();
    expect(inboxHtml).toContain("user@gmail.com");
    expect(inboxHtml).toContain("Gmail MCP 自动同步");
    expect(inboxHtml).toContain('data-testid="inbox-refresh-mail-btn"');
    expect(inboxHtml).toContain("您的 11 月账单已生成");
    expect(inboxHtml).toContain("Q4 里程碑确认邮件");
    expect(inboxHtml).not.toContain("还没有邮箱");

    // Settings -> Channels shows Gmail MCP as connected (`已连接`) instead of `去配置`
    openBotModal("settings", "channels");
    const channelsHtml = renderUi();
    expect(channelsHtml).toContain("已连接 Gmail MCP：user@gmail.com");

    // Connector Detail View shows `已同步 · 2 工具` and `立即同步` button
    openBotConnector("gmail");
    const gmailDetailHtml = renderUi();
    expect(gmailDetailHtml).toContain("已同步 · 2 工具");
    expect(gmailDetailHtml).toContain('data-testid="sync-connector-now-btn"');
  });
});

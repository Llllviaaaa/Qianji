/**
 * Standard MCP OAuth 2.1, Google Workspace (`gws mcp`), and GitHub (`gh` CLI + Official MCP)
 * JSON-RPC handlers for Bot Connectors (`packages/host/src/bot/bot-connector-rpc.ts`).
 */
import type { Context } from "@deepseek-ai/cordis";
import type { Credentials } from "@qianji/llm";
import type { Mcp, McpServerConfig } from "@qianji/mcp";
import {
  ErrorCode,
  type BotConnectorTestKind,
  type BotMcpDiscoveredTool,
} from "@qianji/protocol";
import { RpcError } from "@qianji/rpc";
import type { McpOAuthTokenStore } from "../mcp-oauth-store.ts";
import { runMcpOAuthFlow } from "./connectors/mcp-oauth.ts";
import {
  buildGwsStdioMcpConfig,
  connectorToGwsService,
  detectGitHubCliToken,
  probeGwsCli,
  readStoredGwsClientEnv,
  runGwsInteractiveLogin,
} from "./connectors/standard-cli-mcp.ts";
import type { BotStateStore } from "./store.ts";

type Params = Record<string, unknown>;

function asObject(raw: unknown): Params {
  if (raw === undefined || raw === null) return {};
  if (typeof raw !== "object" || Array.isArray(raw)) {
    throw new RpcError(ErrorCode.InvalidParams, "params must be an object");
  }
  return raw as Params;
}

function reqString(p: Params, key: string): string {
  const val = p[key];
  if (typeof val !== "string" || val.trim() === "") {
    throw new RpcError(ErrorCode.InvalidParams, `${key} must be a non-empty string`);
  }
  return val.trim();
}

function optString(p: Params, key: string): string | undefined {
  const val = p[key];
  return typeof val === "string" && val.trim() !== "" ? val.trim() : undefined;
}

function rethrowRpcError(err: unknown): never {
  if (err instanceof RpcError) throw err;
  throw new RpcError(ErrorCode.InternalError, err instanceof Error ? err.message : String(err));
}

const VALID_CONNECTOR_KINDS = new Set<BotConnectorTestKind>([
  "email",
  "calendar",
  "processes",
  "meetings_im",
  "meeting_notes",
  "telegram",
  "feishu",
  "github",
  "notion",
  "slack",
  "custom_webhook",
]);

function resolveServerId(connectorId: string, explicitServerId?: string): string {
  if (explicitServerId) return explicitServerId;
  if (connectorId.startsWith("bot-mcp-") || connectorId.startsWith("preset-mcp-")) {
    return connectorId;
  }
  return `preset-mcp-${connectorId}`;
}

export function registerBotConnectorRpcMethods(
  rpcCtx: Context,
  store: BotStateStore,
  mcpOAuthStore: McpOAuthTokenStore,
  notifyUpdated: (reason: string) => void,
): void {
  const getMcp = (): Mcp | undefined => rpcCtx.get("mcp") as Mcp | undefined;
  const getCredentials = (): Credentials | undefined => rpcCtx.get("credentials") as Credentials | undefined;

  rpcCtx.rpc.method("bot.connector.test", async (raw) => {
    const p = asObject(raw);
    const rawKind = reqString(p, "kind");
    if (!VALID_CONNECTOR_KINDS.has(rawKind as BotConnectorTestKind)) {
      throw new RpcError(ErrorCode.InvalidParams, `Unknown connector kind: ${rawKind}`);
    }
    const res = await store.testConnector(rawKind as BotConnectorTestKind);
    notifyUpdated("connector-tested");
    return res;
  });

  rpcCtx.rpc.method("bot.connector.oauth", async (raw, ctx) => {
    const p = asObject(raw);
    const connectorId = reqString(p, "connectorId");
    const mcpUrl = reqString(p, "mcpUrl");
    const serverId = resolveServerId(connectorId, optString(p, "serverId"));
    const trustedReadOnly = p.trustedReadOnly === true;
    const displayName = optString(p, "name") ?? connectorId;
    try {
      const oauth = await runMcpOAuthFlow(mcpUrl, {
        signal: ctx.signal,
        ...(optString(p, "clientId") ? { clientId: optString(p, "clientId") } : {}),
        ...(optString(p, "clientSecret") ? { clientSecret: optString(p, "clientSecret") } : {}),
        ...(optString(p, "scope") ? { scope: optString(p, "scope") } : {}),
      });
      await mcpOAuthStore.save(serverId, oauth);

      const serverConfig: McpServerConfig = {
        id: serverId,
        name: displayName,
        enabled: true,
        transport: "http",
        command: "",
        args: [],
        cwd: "",
        env: {},
        inheritEnvironment: true,
        url: mcpUrl,
        headers: {},
        trustedReadOnly,
      };
      await getMcp()?.upsertRuntimeServer(serverConfig).catch(() => undefined);

      await store.configureProactive({
        appPolicies: {
          [connectorId]: {
            connected: true,
            authKind: "oauth",
            accountLabel: `${oauth.issuer} · OAuth 2.1`,
            connectedAt: Date.now(),
            policy: trustedReadOnly ? "read-only-auto" : "low-risk-auto",
            backgroundSync: true,
          },
        },
      });
      if (connectorId === "gmail" || connectorId === "calendar") {
        await store.collectConnectorDelta().catch(() => undefined);
        store.persist();
      }
      const snapshot = await store.snapshot();
      notifyUpdated("connector-oauth-connected");
      return {
        ok: true,
        serverId,
        issuer: oauth.issuer,
        serverConfig,
        snapshot,
      };
    } catch (err) {
      rethrowRpcError(err);
    }
  });

  rpcCtx.rpc.method("bot.connector.oauthSaveBearer", async (raw) => {
    const p = asObject(raw);
    const serverId = reqString(p, "serverId");
    const token = reqString(p, "token");
    const cleanToken = token.replace(/^Bearer\s+/i, "").trim();
    await mcpOAuthStore.saveStaticBearer(serverId, cleanToken, optString(p, "issuer") ?? "bearer-token");
    return { ok: true };
  });

  rpcCtx.rpc.method("bot.connector.oauthDisconnect", async (raw) => {
    const p = asObject(raw);
    const serverId = reqString(p, "serverId");
    const connectorId = optString(p, "connectorId");
    await mcpOAuthStore.delete(serverId);
    await getMcp()
      ?.upsertRuntimeServer({
        id: serverId,
        name: serverId,
        enabled: false,
        transport: "http",
        command: "",
        args: [],
        cwd: "",
        env: {},
        inheritEnvironment: true,
        url: "",
        headers: {},
        trustedReadOnly: false,
      })
      .catch(() => undefined);
    if (connectorId) {
      await store.configureProactive({ appPolicies: { [connectorId]: null } });
    }
    const snapshot = await store.snapshot();
    notifyUpdated("connector-oauth-disconnected");
    return { ok: true, snapshot };
  });

  rpcCtx.rpc.method("bot.connector.googleMcpStatus", async () => {
    try {
      return await probeGwsCli(getCredentials());
    } catch (err) {
      rethrowRpcError(err);
    }
  });

  rpcCtx.rpc.method("bot.connector.googleMcpConnect", async (raw, ctx) => {
    const p = asObject(raw);
    const rawId = reqString(p, "connectorId");
    if (rawId !== "gmail" && rawId !== "calendar" && rawId !== "google_drive") {
      throw new RpcError(ErrorCode.InvalidParams, `Unsupported Google Workspace connector: ${rawId}`);
    }
    const interactive = p.interactive === true;
    const clientId = optString(p, "clientId");
    const clientSecret = optString(p, "clientSecret");

    try {
      const creds = getCredentials();
      let probe = await probeGwsCli(creds);
      if (!probe.authenticated) {
        if (!interactive) {
          return { status: "needs_setup", probe };
        }
        const loginRes = await runGwsInteractiveLogin({
          services: [connectorToGwsService(rawId)],
          credentials: creds,
          clientId,
          clientSecret,
          signal: ctx.signal,
        });
        probe = loginRes.probe;
      }

      const clientEnv = await readStoredGwsClientEnv(creds);
      const runtimeServer = buildGwsStdioMcpConfig(rawId, probe, clientEnv);
      const publicServerConfig: McpServerConfig = { ...runtimeServer, env: {} };
      await getMcp()?.upsertRuntimeServer(runtimeServer).catch(() => undefined);

      const accountLabel = probe.accountEmail || "Google Workspace (gws MCP)";
      await store.configureProactive({
        appPolicies: {
          [rawId]: {
            connected: true,
            authKind: "mcp",
            accountLabel,
            connectedAt: Date.now(),
            policy: rawId === "gmail" ? "low-risk-auto" : "read-only-auto",
            backgroundSync: true,
          },
        },
      });
      if (rawId === "gmail" || rawId === "calendar") {
        await store.collectConnectorDelta().catch(() => undefined);
        store.persist();
      }
      const snapshot = await store.snapshot();
      notifyUpdated("connector-google-mcp-connected");
      return {
        status: "connected",
        accountLabel,
        serverConfig: publicServerConfig,
        snapshot,
      };
    } catch (err) {
      rethrowRpcError(err);
    }
  });

  rpcCtx.rpc.method("bot.connector.githubAutoConnect", async () => {
    try {
      const detected = await detectGitHubCliToken();
      if (!detected) {
        return { status: "needs_auth" };
      }
      const serverId = "preset-mcp-github";
      await mcpOAuthStore.saveStaticBearer(serverId, detected.token, "github-cli");
      const serverConfig: McpServerConfig = {
        id: serverId,
        name: "GitHub",
        enabled: true,
        transport: "http",
        command: "",
        args: [],
        cwd: "",
        env: {},
        inheritEnvironment: true,
        url: "https://api.githubcopilot.com/mcp/",
        headers: {},
        trustedReadOnly: false,
      };
      await getMcp()?.upsertRuntimeServer(serverConfig).catch(() => undefined);

      const accountLabel = detected.login ? `@${detected.login}` : "GitHub CLI";
      await store.configureProactive({
        github: { enabled: true, token: detected.token },
        appPolicies: {
          github: {
            connected: true,
            authKind: "mcp",
            accountLabel,
            connectedAt: Date.now(),
            policy: "low-risk-auto",
            backgroundSync: true,
          },
        },
      });
      await store.testConnector("github").catch(() => undefined);
      const snapshot = await store.snapshot();
      notifyUpdated("connector-github-connected");
      return {
        status: "connected",
        accountLabel,
        serverConfig,
        snapshot,
      };
    } catch (err) {
      rethrowRpcError(err);
    }
  });

  rpcCtx.rpc.method("bot.connector.mcpTools", async (raw) => {
    const p = asObject(raw);
    const serverId = reqString(p, "serverId");
    const targetGroup = `mcp_${serverId}`;
    const tools =
      (
        rpcCtx.get("tools") as
          | { listDefinitions?: () => Array<{ name: string; description: string; group?: string; readOnly?: boolean }> }
          | undefined
      )?.listDefinitions?.() ?? [];
    const prefix = `mcp__${serverId.toLowerCase().replace(/[^a-z0-9_-]+/g, "_")}__`;
    const list: BotMcpDiscoveredTool[] = tools
      .filter((t) => t.group === targetGroup)
      .map((t) => ({
        name: t.name,
        rawName: t.name.startsWith(prefix) ? t.name.slice(prefix.length) : t.name,
        description: t.description.replace(/^\[MCP:\s*[^\]]+\]\s*/, ""),
        readOnly: t.readOnly === true,
      }));
    return { tools: list };
  });
}

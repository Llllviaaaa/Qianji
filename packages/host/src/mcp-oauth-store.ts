/**
 * OS-Keychain-backed MCP OAuth 2.1 & Bearer credential vault (`packages/host/src/mcp-oauth-store.ts`).
 *
 * Persists OAuth token sets (`accessToken`, `refreshToken`, `clientId`, `tokenEndpoint`,
 * `resource`, `expiresAt`) in `Credentials` (`mcp-oauth/<serverId>`) so tokens never
 * enter plaintext `settings.json`, and implements `McpHttpAuthProvider` with single-flight
 * proactive pre-expiry renewal and reactive `401 Unauthorized` refresh retry.
 */
import type { Credentials } from "@qianji/llm";
import type { McpHttpAuthProvider } from "@qianji/mcp";
import { refreshMcpOAuthToken, type McpOAuthTokenRecord } from "./bot/connectors/mcp-oauth.ts";

const KEY_PREFIX = "mcp-oauth/";
const EXPIRY_SKEW_MS = 60_000;

export function mcpOAuthSecretKey(serverId: string): string {
  return `${KEY_PREFIX}${serverId.trim()}`;
}

export class McpOAuthTokenStore implements McpHttpAuthProvider {
  private readonly cache = new Map<string, McpOAuthTokenRecord>();
  private readonly inflightRefresh = new Map<string, Promise<McpOAuthTokenRecord | undefined>>();

  constructor(
    private readonly getCredentials: () => Credentials | undefined,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  async save(serverId: string, record: McpOAuthTokenRecord): Promise<void> {
    const id = serverId.trim();
    if (!id) return;
    this.cache.set(id, record);
    const creds = this.getCredentials();
    if (creds?.writable) {
      await creds.set(mcpOAuthSecretKey(id), JSON.stringify(record)).catch(() => undefined);
    }
  }

  async saveStaticBearer(serverId: string, accessToken: string, issuer = "static-bearer"): Promise<void> {
    await this.save(serverId, {
      accessToken: accessToken.trim(),
      tokenType: "Bearer",
      issuer,
      tokenEndpoint: "",
      clientId: "",
    });
  }

  async load(serverId: string): Promise<McpOAuthTokenRecord | undefined> {
    const id = serverId.trim();
    if (!id) return undefined;
    const cached = this.cache.get(id);
    if (cached) return cached;
    const creds = this.getCredentials();
    if (!creds) return undefined;
    const raw = await creds.get(mcpOAuthSecretKey(id)).catch(() => undefined);
    if (!raw) return undefined;
    try {
      const parsed = JSON.parse(raw) as Partial<McpOAuthTokenRecord>;
      if (typeof parsed.accessToken !== "string" || !parsed.accessToken) return undefined;
      const record: McpOAuthTokenRecord = {
        accessToken: parsed.accessToken,
        ...(typeof parsed.refreshToken === "string" && parsed.refreshToken ? { refreshToken: parsed.refreshToken } : {}),
        tokenType: typeof parsed.tokenType === "string" && parsed.tokenType ? parsed.tokenType : "Bearer",
        ...(typeof parsed.scope === "string" ? { scope: parsed.scope } : {}),
        issuer: typeof parsed.issuer === "string" ? parsed.issuer : "",
        tokenEndpoint: typeof parsed.tokenEndpoint === "string" ? parsed.tokenEndpoint : "",
        clientId: typeof parsed.clientId === "string" ? parsed.clientId : "",
        ...(typeof parsed.clientSecret === "string" && parsed.clientSecret ? { clientSecret: parsed.clientSecret } : {}),
        ...(typeof parsed.resource === "string" && parsed.resource ? { resource: parsed.resource } : {}),
        ...(typeof parsed.expiresAt === "number" ? { expiresAt: parsed.expiresAt } : {}),
      };
      this.cache.set(id, record);
      return record;
    } catch {
      return undefined;
    }
  }

  async delete(serverId: string): Promise<void> {
    const id = serverId.trim();
    if (!id) return;
    this.cache.delete(id);
    const creds = this.getCredentials();
    if (creds?.writable) {
      await creds.delete(mcpOAuthSecretKey(id)).catch(() => false);
    }
  }

  private async refreshSingleFlight(serverId: string, current: McpOAuthTokenRecord): Promise<McpOAuthTokenRecord | undefined> {
    const existing = this.inflightRefresh.get(serverId);
    if (existing) return existing;
    const task = (async () => {
      try {
        const next = await refreshMcpOAuthToken(current, this.fetchImpl);
        await this.save(serverId, next);
        return next;
      } catch {
        return undefined;
      } finally {
        this.inflightRefresh.delete(serverId);
      }
    })();
    this.inflightRefresh.set(serverId, task);
    return task;
  }

  async headers(serverId: string, _url: string): Promise<Record<string, string> | undefined> {
    let record = await this.load(serverId);
    if (!record) return undefined;
    if (
      record.expiresAt !== undefined &&
      record.refreshToken &&
      record.tokenEndpoint &&
      record.expiresAt - Date.now() <= EXPIRY_SKEW_MS
    ) {
      const refreshed = await this.refreshSingleFlight(serverId, record);
      if (refreshed) record = refreshed;
    }
    return {
      Authorization: `${record.tokenType || "Bearer"} ${record.accessToken}`,
    };
  }

  async onUnauthorized(serverId: string, _url: string): Promise<Record<string, string> | undefined> {
    const record = await this.load(serverId);
    if (!record?.refreshToken || !record.tokenEndpoint) return undefined;
    const refreshed = await this.refreshSingleFlight(serverId, record);
    if (!refreshed) return undefined;
    return {
      Authorization: `${refreshed.tokenType || "Bearer"} ${refreshed.accessToken}`,
    };
  }
}

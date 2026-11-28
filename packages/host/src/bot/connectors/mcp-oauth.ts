/**
 * Standards-compliant OAuth 2.1 + RFC 8414/9728 Metadata Discovery + RFC 8707
 * Resource Indicators + RFC 7591 Dynamic Client Registration + S256 PKCE +
 * `refresh_token` rotation for Remote MCP servers (`packages/host/src/bot/connectors/mcp-oauth.ts`).
 */
import { createHash, randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import { createServer } from "node:http";

export interface McpOAuthMetadata {
  issuer: string;
  authorizationEndpoint: string;
  tokenEndpoint: string;
  registrationEndpoint?: string;
  scopesSupported?: string[];
  resource?: string;
}

export interface McpOAuthTokenRecord {
  accessToken: string;
  refreshToken?: string;
  tokenType: string;
  scope?: string;
  issuer: string;
  tokenEndpoint: string;
  clientId: string;
  clientSecret?: string;
  resource?: string;
  expiresAt?: number;
}

export type McpOAuthResult = McpOAuthTokenRecord & {
  expiresIn?: number;
};

export type BrowserOpener = (url: string) => void | Promise<void>;

function base64Url(buf: Buffer): string {
  return buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

export function defaultOpenSystemBrowser(url: string): void {
  if (process.platform === "win32") {
    const child = spawn("rundll32.exe", ["url.dll,FileProtocolHandler", url], {
      detached: true,
      stdio: "ignore",
      windowsHide: true,
    });
    child.unref();
    return;
  }
  const cmd = process.platform === "darwin" ? "open" : "xdg-open";
  const child = spawn(cmd, [url], { detached: true, stdio: "ignore" });
  child.unref();
}

async function fetchJsonSafe(url: string, fetchImpl: typeof fetch = fetch): Promise<Record<string, unknown> | null> {
  try {
    const res = await fetchImpl(url, { signal: AbortSignal.timeout(8_000) });
    if (!res.ok) return null;
    const ct = res.headers.get("content-type") ?? "";
    if (!ct.includes("json")) return null;
    return (await res.json()) as Record<string, unknown>;
  } catch {
    return null;
  }
}

export function canonicalMcpResourceUri(mcpUrl: string): string {
  const parsed = new URL(mcpUrl);
  parsed.hash = "";
  return parsed.toString();
}

export async function discoverMcpOAuthMetadata(
  mcpUrl: string,
  fetchImpl: typeof fetch = fetch,
): Promise<McpOAuthMetadata> {
  const parsed = new URL(mcpUrl);
  const origin = parsed.origin;
  const canonicalResource = canonicalMcpResourceUri(mcpUrl);

  let authServerIssuer = origin;
  let resourceFromMetadata: string | undefined;

  const pathScoped =
    parsed.pathname && parsed.pathname !== "/"
      ? await fetchJsonSafe(`${origin}/.well-known/oauth-protected-resource${parsed.pathname}`, fetchImpl)
      : null;
  let protectedResource = pathScoped ?? (await fetchJsonSafe(`${origin}/.well-known/oauth-protected-resource`, fetchImpl));

  if (!protectedResource) {
    try {
      const probe = await fetchImpl(mcpUrl, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }),
        signal: AbortSignal.timeout(6_000),
      });
      const www = probe.headers.get("www-authenticate") ?? "";
      const rmMatch = /resource_metadata="([^"]+)"/i.exec(www);
      if (rmMatch?.[1]) {
        protectedResource = await fetchJsonSafe(rmMatch[1], fetchImpl);
      }
    } catch {
      // Ignore probe failure and continue with standard well-known paths.
    }
  }

  if (protectedResource) {
    if (typeof protectedResource.resource === "string" && protectedResource.resource.trim() !== "") {
      resourceFromMetadata = protectedResource.resource.trim();
    } else {
      resourceFromMetadata = canonicalResource;
    }
    const prAuthServers = Array.isArray(protectedResource.authorization_servers)
      ? protectedResource.authorization_servers
      : [];
    if (typeof prAuthServers[0] === "string" && prAuthServers[0].trim() !== "") {
      authServerIssuer = prAuthServers[0].trim().replace(/\/+$/, "");
    }
  }

  const issuerUrl = new URL(authServerIssuer);
  const issuerOrigin = issuerUrl.origin;
  const issuerPath = issuerUrl.pathname && issuerUrl.pathname !== "/" ? issuerUrl.pathname : "";

  const meta =
    (issuerPath
      ? await fetchJsonSafe(`${issuerOrigin}/.well-known/oauth-authorization-server${issuerPath}`, fetchImpl)
      : null) ??
    (await fetchJsonSafe(`${issuerOrigin}/.well-known/oauth-authorization-server`, fetchImpl)) ??
    (issuerPath
      ? await fetchJsonSafe(`${issuerOrigin}${issuerPath}/.well-known/openid-configuration`, fetchImpl)
      : null) ??
    (await fetchJsonSafe(`${issuerOrigin}/.well-known/openid-configuration`, fetchImpl));

  if (
    !meta ||
    typeof meta.authorization_endpoint !== "string" ||
    typeof meta.token_endpoint !== "string"
  ) {
    throw new Error(`该 MCP 服务 (${origin}) 未公开 OAuth 2.1 自动发现元数据`);
  }

  return {
    issuer: typeof meta.issuer === "string" ? meta.issuer : authServerIssuer,
    authorizationEndpoint: meta.authorization_endpoint,
    tokenEndpoint: meta.token_endpoint,
    ...(typeof meta.registration_endpoint === "string" ? { registrationEndpoint: meta.registration_endpoint } : {}),
    ...(Array.isArray(meta.scopes_supported)
      ? { scopesSupported: meta.scopes_supported.filter((s): s is string => typeof s === "string") }
      : {}),
    ...(resourceFromMetadata ? { resource: resourceFromMetadata } : {}),
  };
}

function escapeHtml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function negotiateScope(explicitScope: string | undefined, scopesSupported: readonly string[] | undefined): string | undefined {
  const parts = (explicitScope ?? "").split(/\s+/).map((s) => s.trim()).filter(Boolean);
  if (scopesSupported?.includes("offline_access") && !parts.includes("offline_access")) {
    parts.push("offline_access");
  }
  return parts.length > 0 ? parts.join(" ") : undefined;
}

export async function runMcpOAuthFlow(
  mcpUrl: string,
  options?: {
    signal?: AbortSignal;
    timeoutMs?: number;
    openBrowser?: BrowserOpener;
    clientId?: string;
    clientSecret?: string;
    scope?: string;
    fetchImpl?: typeof fetch;
  },
): Promise<McpOAuthResult> {
  const fetchImpl = options?.fetchImpl ?? fetch;
  const meta = await discoverMcpOAuthMetadata(mcpUrl, fetchImpl);
  const timeoutMs = options?.timeoutMs ?? 180_000;
  const verifier = base64Url(randomBytes(32));
  const challenge = base64Url(createHash("sha256").update(verifier).digest());
  const state = base64Url(randomBytes(24));

  let resolveCode!: (value: { code: string; redirectUri: string }) => void;
  let rejectCode!: (reason: Error) => void;
  const codePromise = new Promise<{ code: string; redirectUri: string }>((res, rej) => {
    resolveCode = res;
    rejectCode = rej;
  });

  const server = createServer((req, res) => {
    const reqUrl = new URL(req.url ?? "/", "http://127.0.0.1");
    if (reqUrl.pathname !== "/oauth/callback") {
      res.writeHead(404).end("Not Found");
      return;
    }
    const errParam = reqUrl.searchParams.get("error");
    const errDesc = reqUrl.searchParams.get("error_description");
    if (errParam) {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(
        `<!doctype html><meta charset="utf-8"><body style="font-family:sans-serif;padding:40px;text-align:center"><h2>授权未完成</h2><p>${escapeHtml(errDesc || errParam)}</p></body>`,
      );
      rejectCode(new Error(errDesc || errParam));
      return;
    }
    const code = reqUrl.searchParams.get("code");
    const retState = reqUrl.searchParams.get("state");
    if (!code || retState !== state) {
      res.writeHead(400, { "content-type": "text/html; charset=utf-8" });
      res.end("<!doctype html><meta charset=\"utf-8\"><body>授权校验失败（state 不匹配）</body>");
      rejectCode(new Error("OAuth 回调缺少授权码或 state 校验失败"));
      return;
    }
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(
      "<!doctype html><meta charset=\"utf-8\"><body style=\"font-family:system-ui,sans-serif;padding:48px;text-align:center\"><h2>授权成功，已连接至千机 (Qianji)</h2><p>你可以关闭此标签页并返回千机桌面端。</p></body>",
    );
    resolveCode({ code, redirectUri });
  });

  await new Promise<void>((res, rej) => {
    server.once("error", rej);
    server.listen(0, "127.0.0.1", () => res());
  });
  const addr = server.address();
  const port = typeof addr === "object" && addr ? addr.port : 0;
  const redirectUri = `http://127.0.0.1:${port}/oauth/callback`;

  const timer = setTimeout(() => {
    rejectCode(new Error("浏览器 OAuth 授权超时（180 秒），请重试"));
  }, timeoutMs);
  timer.unref?.();

  const onAbort = () => rejectCode(new Error("用户已取消 OAuth 授权"));
  options?.signal?.addEventListener("abort", onAbort, { once: true });

  try {
    let clientId = options?.clientId?.trim() || "";
    let clientSecret = options?.clientSecret?.trim() || undefined;
    if (!clientId) {
      if (!meta.registrationEndpoint) {
        throw new Error(
          `该 MCP 服务 (${meta.issuer}) 未启用动态客户端注册 (RFC 7591)，请填入 OAuth Client ID（或使用已预审的 MCP 网关）`,
        );
      }
      const regRes = await fetchImpl(meta.registrationEndpoint, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          client_name: "Qianji Desktop",
          redirect_uris: [redirectUri],
          grant_types: ["authorization_code", "refresh_token"],
          response_types: ["code"],
          token_endpoint_auth_method: "none",
        }),
        signal: AbortSignal.timeout(10_000),
      });
      if (!regRes.ok) {
        throw new Error(`OAuth 客户端注册失败：HTTP ${regRes.status}`);
      }
      const regJson = (await regRes.json()) as { client_id?: string; client_secret?: string };
      if (!regJson.client_id) {
        throw new Error("OAuth 动态注册响应缺少 client_id");
      }
      clientId = regJson.client_id;
      if (regJson.client_secret) clientSecret = regJson.client_secret;
    }

    const authUrl = new URL(meta.authorizationEndpoint);
    authUrl.searchParams.set("response_type", "code");
    authUrl.searchParams.set("client_id", clientId);
    authUrl.searchParams.set("redirect_uri", redirectUri);
    authUrl.searchParams.set("state", state);
    authUrl.searchParams.set("code_challenge", challenge);
    authUrl.searchParams.set("code_challenge_method", "S256");
    if (meta.resource) {
      authUrl.searchParams.set("resource", meta.resource);
    }
    const resolvedScope = negotiateScope(options?.scope, meta.scopesSupported);
    if (resolvedScope) {
      authUrl.searchParams.set("scope", resolvedScope);
    }
    if (authUrl.hostname.endsWith("google.com")) {
      authUrl.searchParams.set("access_type", "offline");
      authUrl.searchParams.set("prompt", "consent");
    }

    const opener = options?.openBrowser ?? defaultOpenSystemBrowser;
    await opener(authUrl.toString());

    const { code } = await codePromise;
    const tokenBody = new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: redirectUri,
      client_id: clientId,
      code_verifier: verifier,
    });
    if (clientSecret) tokenBody.set("client_secret", clientSecret);
    if (meta.resource) tokenBody.set("resource", meta.resource);

    const tokenRes = await fetchImpl(meta.tokenEndpoint, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
      body: tokenBody.toString(),
      signal: AbortSignal.timeout(12_000),
    });
    if (!tokenRes.ok) {
      const text = await tokenRes.text().catch(() => "");
      throw new Error(`换取访问令牌失败：HTTP ${tokenRes.status} ${text.slice(0, 180)}`);
    }
    const tokenJson = (await tokenRes.json()) as {
      access_token?: string;
      refresh_token?: string;
      token_type?: string;
      scope?: string;
      expires_in?: number;
    };
    if (!tokenJson.access_token) {
      throw new Error("OAuth 令牌响应缺少 access_token");
    }
    const expiresIn = typeof tokenJson.expires_in === "number" && tokenJson.expires_in > 0 ? tokenJson.expires_in : undefined;
    return {
      accessToken: tokenJson.access_token,
      ...(tokenJson.refresh_token ? { refreshToken: tokenJson.refresh_token } : {}),
      tokenType: tokenJson.token_type || "Bearer",
      ...(tokenJson.scope ?? resolvedScope ? { scope: tokenJson.scope ?? resolvedScope } : {}),
      issuer: meta.issuer,
      tokenEndpoint: meta.tokenEndpoint,
      clientId,
      ...(clientSecret ? { clientSecret } : {}),
      ...(meta.resource ? { resource: meta.resource } : {}),
      ...(expiresIn !== undefined ? { expiresIn, expiresAt: Date.now() + expiresIn * 1_000 } : {}),
    };
  } finally {
    clearTimeout(timer);
    options?.signal?.removeEventListener("abort", onAbort);
    server.close();
  }
}

export async function refreshMcpOAuthToken(
  record: McpOAuthTokenRecord,
  fetchImpl: typeof fetch = fetch,
): Promise<McpOAuthTokenRecord> {
  if (!record.refreshToken || !record.tokenEndpoint || !record.clientId) {
    throw new Error("缺少 refresh_token 或 token_endpoint，无法自动续期");
  }
  const body = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: record.refreshToken,
    client_id: record.clientId,
  });
  if (record.clientSecret) body.set("client_secret", record.clientSecret);
  if (record.resource) body.set("resource", record.resource);
  if (record.scope) body.set("scope", record.scope);

  const res = await fetchImpl(record.tokenEndpoint, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
    body: body.toString(),
    signal: AbortSignal.timeout(12_000),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`OAuth 令牌刷新失败：HTTP ${res.status} ${text.slice(0, 180)}`);
  }
  const json = (await res.json()) as {
    access_token?: string;
    refresh_token?: string;
    token_type?: string;
    scope?: string;
    expires_in?: number;
  };
  if (!json.access_token) {
    throw new Error("OAuth 令牌刷新响应缺少 access_token");
  }
  const expiresIn = typeof json.expires_in === "number" && json.expires_in > 0 ? json.expires_in : undefined;
  return {
    ...record,
    accessToken: json.access_token,
    refreshToken: json.refresh_token || record.refreshToken,
    tokenType: json.token_type || record.tokenType || "Bearer",
    scope: json.scope ?? record.scope,
    ...(expiresIn !== undefined ? { expiresAt: Date.now() + expiresIn * 1_000 } : {}),
  };
}

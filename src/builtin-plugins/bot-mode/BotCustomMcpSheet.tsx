/**
 * Grok & ChatGPT-style Custom MCP Server configuration sheet (`BotCustomMcpSheet.tsx`).
 * Supports OAuth 2.1 auto-discovery/PKCE (Keychain-stored), no-auth, Bearer/Headers, and STDIO.
 */
import { useState, type FormEvent, type ReactElement } from "react";
import type { Context } from "@deepseek-ai/cordis";
import { Plus, Trash2 } from "lucide-react";
import { useAppStore, useFrontendService } from "@qianji/client";
import { Switch } from "@qianji/client-primitives";
import type { McpServerConfig, McpServerStatus } from "@qianji/protocol";
import { ConnectorBrandIcon } from "./BotConnectorLogos";

interface HeaderPair {
  readonly id: string;
  readonly key: string;
  readonly value: string;
}

export function BotCustomMcpSheet({
  ctx,
  existingServer,
  existingStatus,
  onBack,
}: {
  readonly ctx?: Context;
  readonly existingServer?: McpServerConfig;
  readonly existingStatus?: McpServerStatus;
  readonly onBack: () => void;
}): ReactElement {
  const rpcService = useFrontendService("rpcService", ctx);
  const navigationService = useFrontendService("navigationService", ctx);
  const appSettings = useAppStore((s) => s.settings);
  const saveAppSettings = useAppStore((s) => s.saveSettings);

  const [transport, setTransport] = useState<"http" | "stdio">(existingServer?.transport ?? "http");
  const [authType, setAuthType] = useState<"oauth" | "none" | "token">(
    existingServer?.headers?.Authorization ? "token" : "oauth",
  );
  const [name, setName] = useState(existingServer?.name ?? "");
  const [url, setUrl] = useState(existingServer?.url ?? "");
  const [command, setCommand] = useState(
    existingServer ? [existingServer.command, ...existingServer.args].filter(Boolean).join(" ") : "",
  );
  const [oauthClientId, setOauthClientId] = useState("");
  const [oauthClientSecret, setOauthClientSecret] = useState("");
  const [bearerToken, setBearerToken] = useState("");
  const [headers, setHeaders] = useState<HeaderPair[]>(() => {
    if (!existingServer?.headers) return [{ id: "h-0", key: "", value: "" }];
    const entries = Object.entries(existingServer.headers).filter(([k]) => k.toLowerCase() !== "authorization");
    return entries.length > 0
      ? entries.map(([key, value], idx) => ({ id: `h-${idx}`, key, value }))
      : [{ id: "h-0", key: "", value: "" }];
  });
  const [trustedReadOnly, setTrustedReadOnly] = useState(existingServer?.trustedReadOnly ?? false);
  const [busy, setBusy] = useState(false);

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    const cleanName = name.trim();
    if (!cleanName || !appSettings) return;
    if (transport === "http" && !/^https?:\/\//i.test(url.trim())) {
      navigationService?.showToast("请填写有效的 https:// MCP 服务器 URL", "warning");
      return;
    }
    if (transport === "stdio" && command.trim() === "") {
      navigationService?.showToast("请填写本地 STDIO 启动命令", "warning");
      return;
    }

    setBusy(true);
    try {
      const serverId = existingServer?.id ?? `bot-mcp-${Date.now().toString(36)}`;
      const nextHeaders: Record<string, string> = {};
      if (transport === "http" && authType === "oauth" && rpcService) {
        await rpcService.call("bot.connector.oauth", {
          connectorId: serverId,
          serverId,
          name: cleanName,
          mcpUrl: url.trim(),
          trustedReadOnly,
          ...(oauthClientId.trim() ? { clientId: oauthClientId.trim() } : {}),
          ...(oauthClientSecret.trim() ? { clientSecret: oauthClientSecret.trim() } : {}),
        });
      } else {
        for (const pair of headers) {
          const k = pair.key.trim();
          const v = pair.value.trim();
          if (k && v) nextHeaders[k] = v;
        }
        if (bearerToken.trim() !== "" && rpcService) {
          await rpcService.call("bot.connector.oauthSaveBearer", {
            serverId,
            token: bearerToken.trim(),
          });
        } else if (authType === "token" && existingServer?.headers?.Authorization) {
          nextHeaders.Authorization = existingServer.headers.Authorization;
        }
      }

      const cmdParts = command.trim().split(/\s+/);
      const nextServer: McpServerConfig = {
        id: serverId,
        name: cleanName,
        enabled: true,
        transport,
        command: transport === "stdio" ? (cmdParts[0] ?? "") : "",
        args: transport === "stdio" ? cmdParts.slice(1) : [],
        cwd: existingServer?.cwd ?? "",
        env: existingServer?.env ?? {},
        inheritEnvironment: true,
        url: transport === "http" ? url.trim() : "",
        headers: nextHeaders,
        trustedReadOnly,
      };

      await saveAppSettings({
        ...appSettings,
        mcpEnabled: true,
        mcpServers: [...appSettings.mcpServers.filter((s) => s.id !== serverId), nextServer],
      });
      await rpcService?.call("mcp.reconnect", { serverId }).catch(() => undefined);
      navigationService?.showToast(`已保存并连接 MCP 服务「${cleanName}」`, "info");
      onBack();
    } catch (err) {
      navigationService?.showToast(err instanceof Error ? err.message : "MCP 连接或 OAuth 授权失败", "warning");
    } finally {
      setBusy(false);
    }
  };

  const handleDelete = async () => {
    if (!existingServer || !appSettings) return;
    await rpcService?.call("bot.connector.oauthDisconnect", { serverId: existingServer.id }).catch(() => undefined);
    await saveAppSettings({
      ...appSettings,
      mcpServers: appSettings.mcpServers.filter((s) => s.id !== existingServer.id),
    });
    await rpcService?.call("mcp.reconnect", {}).catch(() => undefined);
    navigationService?.showToast(`已移除自定义 MCP「${existingServer.name}」`, "info");
    onBack();
  };

  return (
    <div className="qj-conn-detail-wrap" data-testid="bot-custom-mcp-sheet">
      <div className="qj-conn-hero-card">
        <div className="qj-conn-hero-row">
          <div className="qj-conn-hero-left">
            <ConnectorBrandIcon id="mcp" size={48} />
            <div>
              <div className="qj-conn-hero-title-row">
                <h3 className="qj-conn-hero-title">{existingServer ? existingServer.name : "添加自定义 MCP 服务器"}</h3>
                {existingStatus && (
                  <span className={`qj-conn-status-badge${existingStatus.connected ? " online" : ""}`}>
                    {existingStatus.connected ? `已连接 · ${existingStatus.toolCount} 工具` : "未连接"}
                  </span>
                )}
              </div>
              <p className="qj-conn-hero-desc">
                支持官方标准 OAuth 2.1 自动网页授权（Keychain 托管与自动续期）、公开免鉴权 Remote MCP 或本地 STDIO。
              </p>
            </div>
          </div>
          {existingServer && (
            <button type="button" className="qj-soft-btn qj-conn-danger-pill" onClick={() => void handleDelete()}>移除</button>
          )}
        </div>
      </div>

      <form className="qj-conn-section-card" onSubmit={(e) => void handleSubmit(e)}>
        <div className="qj-conn-seg-tabs" role="tablist" aria-label="MCP 传输协议">
          <button type="button" role="tab" aria-selected={transport === "http"} className={`qj-conn-seg-tab${transport === "http" ? " active" : ""}`} onClick={() => setTransport("http")}>
            远程服务器 (HTTP / SSE)
          </button>
          <button type="button" role="tab" aria-selected={transport === "stdio"} className={`qj-conn-seg-tab${transport === "stdio" ? " active" : ""}`} onClick={() => setTransport("stdio")}>
            本地命令行 (STDIO)
          </button>
        </div>

        <label className="qj-conn-field">
          <span>名称</span>
          <input type="text" required aria-label="自定义 MCP 名称" placeholder="例如：Supabase / Composio / 内部文档" value={name} onChange={(e) => setName(e.target.value)} className="qj-conn-input" />
        </label>

        {transport === "http" ? (
          <>
            <label className="qj-conn-field">
              <span>MCP 服务器 URL</span>
              <input type="url" required aria-label="MCP 服务器 URL" placeholder="https://mcp.example.com/mcp" value={url} onChange={(e) => setUrl(e.target.value)} className="qj-conn-input mono" />
            </label>
            <label className="qj-conn-field">
              <span>身份验证</span>
              <select aria-label="MCP 身份验证方式" value={authType} onChange={(e) => setAuthType(e.target.value as "oauth" | "none" | "token")} className="qj-conn-input">
                <option value="oauth">OAuth 2.1 自动网页授权（推荐）</option>
                <option value="none">无需认证（公开服务）</option>
                <option value="token">Bearer Token / 自定义请求头</option>
              </select>
            </label>
            {authType === "oauth" && (
              <div className="qj-conn-grid-2">
                <input type="text" aria-label="OAuth Client ID（可选）" placeholder="Client ID（支持 RFC 7591 可留空）" value={oauthClientId} onChange={(e) => setOauthClientId(e.target.value)} className="qj-conn-input mono" />
                <input type="password" aria-label="OAuth Client Secret（可选）" placeholder="Client Secret（可选，加密存储）" value={oauthClientSecret} onChange={(e) => setOauthClientSecret(e.target.value)} className="qj-conn-input" />
              </div>
            )}
            {authType === "token" && (
              <>
                <label className="qj-conn-field">
                  <span>Bearer Token（加密存入 Keychain）</span>
                  <input type="password" aria-label="MCP Bearer Token" placeholder="输入 API Key 或 Token" value={bearerToken} onChange={(e) => setBearerToken(e.target.value)} className="qj-conn-input" />
                </label>
                <div className="qj-conn-field">
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                    <span>自定义请求头 (Headers)</span>
                    <button type="button" className="qj-conn-inline-link" onClick={() => setHeaders((prev) => [...prev, { id: `h-${Date.now()}`, key: "", value: "" }])}>
                      <Plus size={12} /> 添加请求头
                    </button>
                  </div>
                  {headers.map((pair, idx) => (
                    <div key={pair.id} style={{ display: "grid", gridTemplateColumns: "1fr 1fr auto", gap: 8 }}>
                      <input type="text" aria-label={`请求头键 ${idx + 1}`} placeholder="Header Name" value={pair.key} onChange={(e) => setHeaders((p) => p.map((x) => (x.id === pair.id ? { ...x, key: e.target.value } : x)))} className="qj-conn-input mono" />
                      <input type="text" aria-label={`请求头值 ${idx + 1}`} placeholder="Header Value" value={pair.value} onChange={(e) => setHeaders((p) => p.map((x) => (x.id === pair.id ? { ...x, value: e.target.value } : x)))} className="qj-conn-input" />
                      <button type="button" aria-label="删除请求头" disabled={headers.length <= 1} className="qj-soft-btn" style={{ width: 32, height: 34, display: "grid", placeItems: "center" }} onClick={() => setHeaders((p) => p.filter((x) => x.id !== pair.id))}>
                        <Trash2 size={13} />
                      </button>
                    </div>
                  ))}
                </div>
              </>
            )}
          </>
        ) : (
          <label className="qj-conn-field">
            <span>启动命令 (STDIO)</span>
            <input type="text" required aria-label="MCP STDIO 启动命令" placeholder="npx -y @modelcontextprotocol/server-filesystem D:/Notes" value={command} onChange={(e) => setCommand(e.target.value)} className="qj-conn-input mono" />
          </label>
        )}

        <div className="qj-conn-toggle-row">
          <div>
            <div style={{ fontSize: 13, fontWeight: 540 }}>视为只读低风险工具</div>
            <div style={{ fontSize: 11.5, color: "var(--qj-text-secondary)" }}>仅检索/只读工具自动放行，修改类调用仍经右侧「批准」栏确认。</div>
          </div>
          <Switch checked={trustedReadOnly} onCheckedChange={setTrustedReadOnly} aria-label="视为只读低风险工具" />
        </div>

        <div style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
          <button type="button" className="qj-soft-btn qj-conn-pill-btn" onClick={onBack}>取消</button>
          <button type="submit" disabled={busy} className="qj-primary-pill-btn qj-conn-pill-btn">
            {busy ? "正在连接…" : authType === "oauth" && transport === "http" ? "打开浏览器授权并连接" : "添加并连接 MCP"}
          </button>
        </div>
      </form>
    </div>
  );
}

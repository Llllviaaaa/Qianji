/**
 * Standard Google Workspace MCP Connection Wizard (`BotGoogleMcpModal.tsx`).
 *
 * Supports the two industry-standard MCP connection paths without custom browser scraping:
 * 1. Remote OAuth 2.1 MCP Server (Composio / Pipedream / Official `*.googleapis.com` with PKCE + Keychain refresh)
 * 2. Official `@googleworkspace/cli` (`gws mcp`) Local STDIO MCP Server
 */
import { useEffect, useState, type FormEvent, type ReactElement } from "react";
import type { Context } from "@deepseek-ai/cordis";
import { Terminal, Globe, X } from "lucide-react";
import { useAppStore, useFrontendService } from "@qianji/client";
import type { BotSnapshotResult, McpServerConfig } from "@qianji/protocol";
import { botDataStore } from "./botStore";

interface GwsStatusPayload {
  readonly gwsInstalled?: boolean;
  readonly npxAvailable?: boolean;
  readonly hasClientConfig?: boolean;
  readonly authenticated?: boolean;
  readonly accountEmail?: string;
}

export function BotGoogleMcpModal({
  open,
  connectorId,
  connectorName,
  defaultMcpUrl,
  trustedReadOnly,
  ctx,
  onClose,
}: {
  readonly open: boolean;
  readonly connectorId: "gmail" | "calendar" | "google_drive";
  readonly connectorName: string;
  readonly defaultMcpUrl: string;
  readonly trustedReadOnly: boolean;
  readonly ctx?: Context;
  readonly onClose: () => void;
}): ReactElement | null {
  const rpcService = useFrontendService("rpcService", ctx);
  const navigationService = useFrontendService("navigationService", ctx);
  const appSettings = useAppStore((s) => s.settings);
  const saveAppSettings = useAppStore((s) => s.saveSettings);

  const [mode, setMode] = useState<"gws" | "remote">("gws");
  const [mcpUrl, setMcpUrl] = useState(defaultMcpUrl);
  const [clientId, setClientId] = useState("");
  const [clientSecret, setClientSecret] = useState("");
  const [gwsStatus, setGwsStatus] = useState<GwsStatusPayload | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!open || !rpcService) return undefined;
    let cancelled = false;
    rpcService
      .call<GwsStatusPayload>("bot.connector.googleMcpStatus", {})
      .then((res) => {
        if (!cancelled && res) setGwsStatus(res);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [open, rpcService]);

  useEffect(() => {
    if (!open || typeof window === "undefined") return undefined;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.stopPropagation();
        onClose();
      }
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [open, onClose]);

  if (!open) return null;

  const persistMcpServer = async (serverConfig: McpServerConfig) => {
    if (!appSettings) return;
    await saveAppSettings({
      ...appSettings,
      mcpEnabled: true,
      mcpServers: [...appSettings.mcpServers.filter((s) => s.id !== serverConfig.id), serverConfig],
    });
    await rpcService?.call("mcp.reconnect", { serverId: serverConfig.id }).catch(() => undefined);
  };

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    if (!rpcService || !appSettings) return;
    setBusy(true);
    try {
      if (mode === "gws") {
        const res = await rpcService.call<{
          status: string;
          accountLabel?: string;
          serverConfig?: McpServerConfig;
          snapshot?: BotSnapshotResult;
        }>("bot.connector.googleMcpConnect", {
          connectorId,
          interactive: true,
          ...(clientId.trim() ? { clientId: clientId.trim() } : {}),
          ...(clientSecret.trim() ? { clientSecret: clientSecret.trim() } : {}),
        });
        if (res.serverConfig) await persistMcpServer(res.serverConfig);
        if (res.snapshot) botDataStore.set(res.snapshot);
        navigationService?.showToast(
          `已通过 Google 官方 MCP 连接并同步 ${connectorName}${res.accountLabel ? `（${res.accountLabel}）` : ""}`,
          "info",
        );
        onClose();
        return;
      }

      const cleanUrl = mcpUrl.trim();
      if (!/^https?:\/\//i.test(cleanUrl)) {
        navigationService?.showToast("请填写有效的 https:// Remote MCP 地址", "warning");
        return;
      }
      const res = await rpcService.call<{
        ok: boolean;
        issuer: string;
        serverConfig: McpServerConfig;
        snapshot?: BotSnapshotResult;
      }>("bot.connector.oauth", {
        connectorId,
        serverId: `preset-mcp-${connectorId}`,
        name: connectorName,
        mcpUrl: cleanUrl,
        trustedReadOnly,
        ...(clientId.trim() ? { clientId: clientId.trim() } : {}),
        ...(clientSecret.trim() ? { clientSecret: clientSecret.trim() } : {}),
      });
      await persistMcpServer(res.serverConfig);
      if (res.snapshot) botDataStore.set(res.snapshot);
      navigationService?.showToast(`已完成 OAuth 2.1 授权并接入 ${connectorName} MCP`, "info");
      onClose();
    } catch (err) {
      navigationService?.showToast(err instanceof Error ? err.message : "Google MCP 连接失败", "warning");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="qj-bot-modal-backdrop" data-escape-layer="" onClick={onClose} style={{ zIndex: 380 }}>
      <div className="qj-bot-dialog qj-muse-compact-modal" onClick={(e) => e.stopPropagation()}>
        <div className="qj-muse-modal-head">
          <span className="qj-muse-modal-title">连接 {connectorName}（标准 MCP）</span>
          <button type="button" aria-label="关闭弹窗" className="qj-muse-modal-close" onClick={onClose}>
            <X size={16} />
          </button>
        </div>

        <form onSubmit={(e) => void handleSubmit(e)} style={{ display: "flex", flexDirection: "column", gap: 10 }}>
          <div className="qj-conn-seg-tabs" role="tablist" aria-label="Google MCP 接入方式">
            <button
              type="button"
              role="tab"
              aria-selected={mode === "gws"}
              className={`qj-conn-seg-tab${mode === "gws" ? " active" : ""}`}
              onClick={() => setMode("gws")}
            >
              <Terminal size={12.5} style={{ display: "inline", marginRight: 4 }} />
              官方 gws CLI (本地 MCP)
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={mode === "remote"}
              className={`qj-conn-seg-tab${mode === "remote" ? " active" : ""}`}
              onClick={() => setMode("remote")}
            >
              <Globe size={12.5} style={{ display: "inline", marginRight: 4 }} />
              Remote MCP (OAuth 2.1)
            </button>
          </div>

          {mode === "gws" ? (
            <>
              <p className="qj-conn-hint">
                调用 Google 官方开源的 <code>@googleworkspace/cli</code> (<code>gws mcp</code>) 在本地建立标准 MCP 通道，令牌由系统安全托管并自动同步收件箱与日程。
                {gwsStatus && (
                  <span style={{ display: "block", marginTop: 4 }}>
                    本机环境：{gwsStatus.gwsInstalled ? "已安装 gws" : gwsStatus.npxAvailable ? "Node npx 就绪（自动拉起）" : "未检测到 Node/gws"} ·{" "}
                    {gwsStatus.hasClientConfig ? "已检测到本地 OAuth 凭据" : "需填入 Google OAuth Client ID"}
                  </span>
                )}
              </p>
              <input
                type="text"
                aria-label="Google OAuth Client ID"
                placeholder={gwsStatus?.hasClientConfig ? "Client ID（本地已配置，留空直接复用）" : "Google Cloud OAuth Client ID (xxx.apps.googleusercontent.com)"}
                value={clientId}
                onChange={(e) => setClientId(e.target.value)}
                className="qj-conn-input mono"
              />
              <input
                type="password"
                aria-label="Google OAuth Client Secret"
                placeholder="Google Cloud OAuth Client Secret（加密存入系统保险箱）"
                value={clientSecret}
                onChange={(e) => setClientSecret(e.target.value)}
                className="qj-conn-input"
              />
            </>
          ) : (
            <>
              <p className="qj-conn-hint">
                支持接入任意符合 MCP OAuth 2.1 规范的远程端点（填入 Composio / Pipedream 托管网关 URL 可免填 Client ID 一键授权；直连 Google 官方 <code>*.googleapis.com</code> 需填入桌面端 Client ID）。
              </p>
              <input
                type="url"
                required
                aria-label="Remote MCP URL"
                placeholder="https://gmailmcp.googleapis.com/mcp 或托管网关 URL"
                value={mcpUrl}
                onChange={(e) => setMcpUrl(e.target.value)}
                className="qj-conn-input mono"
              />
              <input
                type="text"
                aria-label="OAuth Client ID（可选）"
                placeholder="OAuth Client ID（支持动态注册 RFC 7591 的网关可留空）"
                value={clientId}
                onChange={(e) => setClientId(e.target.value)}
                className="qj-conn-input mono"
              />
              <input
                type="password"
                aria-label="OAuth Client Secret（可选）"
                placeholder="OAuth Client Secret（可选，加密存入系统保险箱）"
                value={clientSecret}
                onChange={(e) => setClientSecret(e.target.value)}
                className="qj-conn-input"
              />
            </>
          )}

          <div className="qj-muse-modal-foot">
            <button type="button" className="qj-soft-btn qj-conn-pill-btn" onClick={onClose}>
              取消
            </button>
            <button type="submit" disabled={busy} className="qj-primary-pill-btn qj-conn-pill-btn">
              {busy ? "正在打开浏览器授权…" : "授权并连接 MCP"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

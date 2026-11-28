/**
 * 1:1 Grok Unconnected View & Meta Muse / ChatGPT Connected Config Page
 * (`BotConnectorDetailView.tsx`). Zero inline credential/host input boxes.
 */
import { useEffect, useState, type ReactElement } from "react";
import type { Context } from "@deepseek-ai/cordis";
import { ArrowLeft, ArrowUpRight } from "lucide-react";
import { useAppStore, useFrontendService } from "@qianji/client";
import { SlotHost } from "@qianji/client-slots";
import type {
  BotActionPermissionLevel,
  BotConnectorPermission,
  BotConnectorPolicyTier,
  BotMcpDiscoveredTool,
  McpServerConfig,
  McpServerStatus,
} from "@qianji/protocol";
import { CONNECTOR_CATALOG, resolveConnectorState, type ConnectorCatalogEntry } from "./botConnectorCatalog";
import { ConnectorBrandIcon } from "./BotConnectorLogos";
import { BotConnectorModal, type ConnectorModalKind } from "./BotConnectorModals";
import { BotConnectorPermissionSection } from "./BotConnectorPermissionSection";
import { BotPluginConfigModal } from "./BotPluginsSettingsPane";
import { patchBotUi, useBotController, useBotSnapshot, useBotUiState } from "./botStore";

const nowMs = (): number => Date.now();

export function BotConnectorDetailView({
  connectorId,
  pluginEntry,
  onPluginMutated,
  ctx,
  mcpStatus,
  onBack,
}: {
  readonly connectorId: string;
  readonly pluginEntry?: ConnectorCatalogEntry;
  readonly onPluginMutated?: () => void;
  readonly ctx?: Context;
  readonly mcpStatus: readonly McpServerStatus[];
  readonly onBack: () => void;
}): ReactElement {
  const ui = useBotUiState();
  const snapshot = useBotSnapshot();
  const ctrl = useBotController(ctx);
  const rpcService = useFrontendService("rpcService", ctx);
  const workspaceService = useFrontendService("workspaceService", ctx);
  const navigationService = useFrontendService("navigationService", ctx);
  const appSettings = useAppStore((s) => s.settings);
  const saveAppSettings = useAppStore((s) => s.saveSettings);

  const [oauthBusy, setOauthBusy] = useState(false);
  const [browserPending, setBrowserPending] = useState(false);
  const [browserVerifying, setBrowserVerifying] = useState(false);
  const [pluginConfigOpen, setPluginConfigOpen] = useState(false);
  const [pluginConfigHint, setPluginConfigHint] = useState<string | undefined>(undefined);
  const [modalKind, setModalKind] = useState<ConnectorModalKind>(null);
  const [discoveredTools, setDiscoveredTools] = useState<readonly BotMcpDiscoveredTool[]>([]);

  const entry = pluginEntry ?? CONNECTOR_CATALOG.find((c) => c.id === connectorId);
  const mcpServerId = entry?.mcpPreset?.serverId;

  useEffect(() => {
    if (!rpcService || !mcpServerId) return undefined;
    let cancelled = false;
    rpcService
      .call<{ tools?: BotMcpDiscoveredTool[] }>("bot.connector.mcpTools", { serverId: mcpServerId })
      .then((res) => {
        if (!cancelled && Array.isArray(res?.tools)) setDiscoveredTools(res.tools);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [mcpServerId, mcpStatus, rpcService]);

  useEffect(() => {
    if (!rpcService || !entry || entry.authMode !== "browser") return undefined;
    return rpcService.onNotification("bot/browserAuth", (raw) => {
      const payload = raw as { connectorId?: string; status?: string; accountLabel?: string } | undefined;
      if (payload?.connectorId !== entry.id) return;
      setBrowserPending(false);
      setBrowserVerifying(false);
      if (payload.status === "connected") {
        navigationService?.showToast(`已成功连接 ${entry.name}${payload.accountLabel ? `（${payload.accountLabel}）` : ""}`, "info");
      }
    });
  }, [entry, navigationService, rpcService]);

  if (!entry) {
    return (
      <div className="qj-conn-detail-wrap">
        <button type="button" className="qj-conn-back-btn" onClick={onBack}>
          <ArrowLeft size={14} /> 返回连接器
        </button>
      </div>
    );
  }

  const state = resolveConnectorState(entry, snapshot, mcpStatus, appSettings?.mcpServers ?? []);

  const savePresetMcp = async (headers: Record<string, string>) => {
    if (!appSettings || !entry.mcpPreset) return;
    const nextServer: McpServerConfig = {
      id: entry.mcpPreset.serverId,
      name: entry.mcpPreset.name,
      enabled: true,
      transport: "http",
      command: "",
      args: [],
      cwd: "",
      env: {},
      inheritEnvironment: true,
      url: entry.mcpPreset.url,
      headers,
      trustedReadOnly: entry.mcpPreset.trustedReadOnly,
    };
    await saveAppSettings({
      ...appSettings,
      mcpEnabled: true,
      mcpServers: [...appSettings.mcpServers.filter((s) => s.id !== entry.mcpPreset?.serverId), nextServer],
    });
    await rpcService?.call("mcp.reconnect", { serverId: entry.mcpPreset.serverId }).catch(() => undefined);
  };

  const connectOneClick = async (forceInteractive = false) => {
    if (entry.authMode === "mcp-oauth" && entry.mcpPreset) {
      if (!appSettings || !rpcService) return;
      setOauthBusy(true);
      try {
        const res = await rpcService.call<{ accessToken: string; tokenType: string }>("bot.connector.oauth", {
          connectorId: entry.id,
          mcpUrl: entry.mcpPreset.url,
        });
        await savePresetMcp({ Authorization: `${res.tokenType || "Bearer"} ${res.accessToken}` });
        navigationService?.showToast(`已完成官方 OAuth 授权并连接 ${entry.name}`, "info");
      } catch (err) {
        navigationService?.showToast(err instanceof Error ? err.message : "OAuth 授权未完成", "warning");
      } finally {
        setOauthBusy(false);
      }
      return;
    }

    if (entry.authMode === "mcp-direct" && entry.mcpPreset) {
      await savePresetMcp({});
      await ctrl.configureBot({
        appPolicies: {
          [entry.id]: {
            connected: true,
            authKind: "mcp",
            accountLabel: entry.mcpPreset.url,
            connectedAt: nowMs(),
            policy: entry.mcpPreset.trustedReadOnly ? "read-only-auto" : "low-risk-auto",
          },
        },
      });
      navigationService?.showToast(`已连接 ${entry.name}`, "info");
      return;
    }

    if (entry.authMode === "browser") {
      if (!rpcService) return;
      setOauthBusy(true);
      try {
        const res = await rpcService.call<{ status: string; accountLabel?: string }>("bot.connector.browserAuthStart", {
          connectorId: entry.id,
          forceInteractive,
        });
        if (res.status === "connected") {
          setBrowserPending(false);
          navigationService?.showToast(`已连接 ${entry.name}${res.accountLabel ? `（${res.accountLabel}）` : ""}`, "info");
        } else {
          setBrowserPending(true);
        }
      } catch (err) {
        navigationService?.showToast(err instanceof Error ? err.message : "未能启动安全登录窗口", "warning");
      } finally {
        setOauthBusy(false);
      }
      return;
    }

    if (entry.authMode === "plugin" && entry.pluginItem) {
      if (!rpcService) return;
      setOauthBusy(true);
      try {
        const res = await rpcService.call<{ status: string; accountLabel?: string; message?: string }>(
          "bot.connector.pluginConnect",
          {
            pluginId: entry.pluginItem.pluginId,
            connectorId: entry.id,
            forceInteractive,
          },
        );
        onPluginMutated?.();
        if (res.status === "needs_config") {
          setPluginConfigHint(res.message || "请完成插件所需参数后继续连接");
          setPluginConfigOpen(true);
        } else {
          navigationService?.showToast(`已连接插件连接器「${entry.name}」`, "info");
        }
      } catch (err) {
        navigationService?.showToast(err instanceof Error ? err.message : "插件连接失败", "warning");
      } finally {
        setOauthBusy(false);
      }
      return;
    }

    if (entry.authMode === "folder-picker") {
      const picked = await workspaceService?.pickFolder().catch(() => null);
      if (!picked?.trim()) return;
      await ctrl.configureBot({
        meetingsIm: { meetingNotesEnabled: true, meetingNotesDir: picked.trim() },
        appPolicies: { [entry.id]: { connected: true, authKind: "local", accountLabel: picked.trim(), connectedAt: nowMs(), policy: "read-only-auto" } },
      });
      await ctrl.testConnector("meeting_notes");
      return;
    }

    setModalKind(entry.authMode === "imap-modal" ? "imap" : "webhook");
  };

  const confirmBrowserAuth = async () => {
    if (!rpcService) return;
    setBrowserVerifying(true);
    try {
      const res = await rpcService.call<{ status: string; accountLabel?: string; message?: string }>(
        "bot.connector.browserAuthComplete",
        { connectorId: entry.id },
      );
      if (res.status === "connected") {
        setBrowserPending(false);
        navigationService?.showToast(`已连接 ${entry.name}${res.accountLabel ? `（${res.accountLabel}）` : ""}`, "info");
      } else {
        navigationService?.showToast(res.message || "尚未检测到登录完成，请在弹出窗口中登录", "warning");
      }
    } catch (err) {
      navigationService?.showToast(err instanceof Error ? err.message : "验证登录状态失败", "warning");
    } finally {
      setBrowserVerifying(false);
    }
  };

  const cancelBrowserAuth = async () => {
    setBrowserPending(false);
    await rpcService?.call("bot.connector.browserAuthCancel", {}).catch(() => undefined);
  };

  const handleDisconnect = async () => {
    void rpcService?.call("bot.connector.browserAuthCancel", {}).catch(() => undefined);
    setBrowserPending(false);
    if (entry.authMode === "plugin") {
      await rpcService?.call("bot.connector.pluginDisconnect", { connectorId: entry.id }).catch(() => undefined);
      onPluginMutated?.();
      navigationService?.showToast(`已断开「${entry.name}」`, "info");
      return;
    }
    await ctrl.configureBot({
      appPolicies: { [entry.id]: null },
      ...(entry.id === "github" ? { github: { enabled: false } } : {}),
      ...(entry.id === "notion" ? { notion: { enabled: false } } : {}),
      ...(entry.id === "calendar" ? { calendar: { enabled: false } } : {}),
      ...(entry.id === "slack" ? { slack: { enabled: false } } : {}),
      ...(entry.id === "meeting_notes" ? { meetingsIm: { meetingNotesEnabled: false } } : {}),
      ...(entry.id === "custom_webhook" ? { customWebhook: { enabled: false } } : {}),
      ...(entry.id === "gmail" || entry.id === "outlook" || entry.id === "imap_email" ? { email: { enabled: false } } : {}),
    });
    if (entry.mcpPreset && appSettings) {
      await saveAppSettings({
        ...appSettings,
        mcpServers: appSettings.mcpServers.filter((s) => s.id !== entry.mcpPreset?.serverId),
      });
      await rpcService?.call("mcp.reconnect", {}).catch(() => undefined);
    }
    navigationService?.showToast(`已断开「${entry.name}」`, "info");
  };

  const updatePolicyTier = async (tier: BotConnectorPolicyTier) => {
    const legacyPerm: BotConnectorPermission = tier === "strict-read-only" ? "read-only" : "ask-write";
    await ctrl.configureBot({
      appPolicies: { [entry.id]: { policy: tier, connected: true } },
      ...(entry.id === "github" ? { github: { permission: legacyPerm } } : {}),
      ...(entry.id === "notion" ? { notion: { permission: legacyPerm } } : {}),
      ...(entry.id === "slack" ? { slack: { permission: legacyPerm } } : {}),
      ...(entry.id === "custom_webhook" ? { customWebhook: { permission: legacyPerm } } : {}),
      ...(entry.id === "gmail" || entry.id === "outlook" || entry.id === "imap_email" ? { email: { permission: legacyPerm } } : {}),
    });
  };

  const updateActionPerm = async (capId: string, level: BotActionPermissionLevel) => {
    await ctrl.configureBot({
      appPolicies: { [entry.id]: { policy: state.policyTier, actionPermissions: { [capId]: level } } },
    });
  };

  const tryInChat = (promptText: string) => {
    const nextApps = ui.composerApps.includes(entry.id) ? ui.composerApps : [...ui.composerApps, entry.id];
    patchBotUi({ activeView: "chat", activeSessionId: null, composerApps: nextApps, composerDraft: promptText, modal: null });
  };

  const actionRows =
    discoveredTools.length > 0
      ? discoveredTools.map((t) => ({
          id: t.name,
          label: t.description || t.rawName,
          kind: (t.readOnly ? "read" : "write") as "read" | "write",
          defaultPerm: (t.readOnly ? "allow" : "ask") as BotActionPermissionLevel,
        }))
      : entry.capabilities;

  return (
    <div className="qj-conn-detail-wrap" data-testid={`connector-detail-${entry.id}`}>
      <div className="qj-conn-hero-card">
        <div className="qj-conn-hero-row">
          <div className="qj-conn-hero-left">
            <ConnectorBrandIcon id={entry.id} icon={entry.icon} iconBg={entry.iconBg} size={48} />
            <div style={{ minWidth: 0 }}>
              <div className="qj-conn-hero-title-row">
                <h3 className="qj-conn-hero-title">{entry.name}</h3>
                <span className="qj-conn-meta-pill">{entry.publisher}</span>
                {state.connected && <span className="qj-conn-status-badge online">{state.statusLabel}</span>}
              </div>
              <p className="qj-conn-hero-desc">{entry.description}</p>
            </div>
          </div>

          {!state.connected ? (
            <button
              type="button"
              data-testid="connect-app-btn"
              disabled={oauthBusy || browserVerifying || ui.serverBusy}
              className="qj-primary-pill-btn qj-conn-connect-cta"
              onClick={() => void connectOneClick()}
            >
              {oauthBusy || browserVerifying ? "正在授权…" : "连接"}
            </button>
          ) : (
            <button
              type="button"
              className="qj-primary-pill-btn qj-conn-connect-cta"
              onClick={() => tryInChat(entry.starterPrompts[0] ?? `使用 @${entry.name} 处理最新动态`)}
            >
              <span>在聊天中试用</span>
              <ArrowUpRight size={13} />
            </button>
          )}
        </div>
        {!state.connected && browserPending && (
          <div className="qj-conn-liveview-bar" data-testid="browser-auth-waiting-bar">
            <span>请在弹出的安全浏览器窗口中登录 {entry.name}。完成后关闭窗口，或点击右侧确认。</span>
            <div style={{ display: "flex", gap: 6, flexShrink: 0 }}>
              <button type="button" data-testid="confirm-browser-auth-btn" className="qj-primary-pill-btn qj-conn-pill-btn" disabled={browserVerifying} onClick={() => void confirmBrowserAuth()}>
                {browserVerifying ? "验证中…" : "✓ 我已完成登录"}
              </button>
              <button type="button" className="qj-soft-btn qj-conn-pill-btn" disabled={oauthBusy || browserVerifying} onClick={() => void connectOneClick(true)}>
                重新打开
              </button>
              <button type="button" className="qj-soft-btn qj-conn-pill-btn" disabled={browserVerifying} onClick={() => void cancelBrowserAuth()}>
                取消
              </button>
            </div>
          </div>
        )}
        {state.lastError && <div className="qj-connector-card-err">{state.lastError}</div>}
      </div>

      {!state.connected ? (
        <>
          <div className="qj-conn-section-card">
            <div className="qj-conn-section-title">关于此连接器</div>
            <div className="qj-conn-about-grid">
              <div>
                <div className="qj-conn-about-item-t">随时启用与撤回权限</div>
                <div className="qj-conn-about-item-d">{entry.tagline}</div>
              </div>
              <div>
                <div className="qj-conn-about-item-t">本地隐私与审批守护</div>
                <div className="qj-conn-about-item-d">凭据加密存放于本地保险箱；任何写入与外发动作默认须经你批准。</div>
              </div>
            </div>
          </div>

          <div className="qj-conn-section-card">
            <div className="qj-conn-section-title">试试这样问</div>
            <div className="qj-conn-prompt-list">
              {entry.starterPrompts.map((p) => (
                <div key={p} className="qj-conn-prompt-static">@{entry.name} · {p}</div>
              ))}
            </div>
          </div>

          <div className="qj-conn-info-table">
            <div><span>授权方式</span><span>{entry.authLabel}</span></div>
            <div><span>开发者</span><span>{entry.publisher}</span></div>
            <div><span>类别</span><span>{entry.categoryLabel}</span></div>
          </div>
        </>
      ) : (
        <>
          <div className="qj-conn-section-card">
            <div className="qj-conn-section-title">已连接的账户</div>
            <div className="qj-conn-account-row">
              <div>
                <div style={{ fontSize: 13.5, fontWeight: 560 }}>{state.accountLabel || `${entry.name}（已授权）`}</div>
                <div className="qj-conn-hint">授权方式：{state.authMethodUsed}</div>
              </div>
              <div style={{ display: "flex", gap: 8 }}>
                <button type="button" className="qj-soft-btn qj-conn-pill-btn" onClick={() => void connectOneClick(true)}>
                  重新授权
                </button>
                {entry.authMode === "plugin" && entry.pluginItem && (
                  <button
                    type="button"
                    className="qj-soft-btn qj-conn-pill-btn"
                    onClick={() => {
                      setPluginConfigHint(undefined);
                      setPluginConfigOpen(true);
                    }}
                  >
                    插件参数配置
                  </button>
                )}
                {(entry.id === "gmail" || entry.id === "outlook" || entry.id === "github" || entry.id === "calendar") && (
                  <button
                    type="button"
                    className="qj-soft-btn qj-conn-pill-btn"
                    onClick={() =>
                      setModalKind(
                        entry.id === "github" ? "github-sync" : entry.id === "calendar" ? "calendar-sync" : "imap",
                      )
                    }
                  >
                    后台同步配置
                  </button>
                )}
              </div>
            </div>
          </div>

          <BotConnectorPermissionSection
            entryId={entry.id}
            readOnlyOnly={state.readOnlyOnly}
            policyTier={state.policyTier}
            appPolicy={state.appPolicy}
            actionRows={actionRows}
            onSelectTier={(tier) => void updatePolicyTier(tier)}
            onUpdateActionPerm={(capId, level) => void updateActionPerm(capId, level)}
            onResetDefaults={() => void ctrl.configureBot({ appPolicies: { [entry.id]: { policy: state.policyTier, actionPermissions: {} } } })}
            onToggleBackgroundSync={(enabled) => void ctrl.configureBot({ appPolicies: { [entry.id]: { policy: state.policyTier, backgroundSync: enabled } } })}
          />

          <div className="qj-conn-section-card">
            <div className="qj-conn-section-title">关于</div>
            <div className="qj-conn-info-table">
              <div><span>关联日期</span><span>{state.connectedAt ? new Date(state.connectedAt).toLocaleDateString("zh-CN") : "已启用"}</span></div>
              <div><span>类别</span><span>{entry.categoryLabel}</span></div>
              <div><span>开发者</span><span>{entry.publisher}</span></div>
              <div><span>授权方式</span><span>{state.authMethodUsed}</span></div>
            </div>
            <div style={{ display: "flex", justifyContent: "flex-end", paddingTop: 4 }}>
              <button type="button" className="qj-soft-btn qj-conn-danger-pill" onClick={() => void handleDisconnect()}>断开连接</button>
            </div>
          </div>
        </>
      )}

      <SlotHost
        slotKey="bot.connector.sections"
        kind="keyed"
        scope="root"
        routeKey={entry.id}
        mode="all"
        registry={ctx?.slots?.registry}
        rootCtx={ctx}
        props={{ connectorId: entry.id, pluginId: entry.pluginItem?.pluginId, connected: state.connected }}
      />

      <BotConnectorModal kind={modalKind} defaultEmailPreset={entry.id === "outlook" ? "outlook" : entry.id === "gmail" ? "gmail" : "qq"} ctx={ctx} onClose={() => setModalKind(null)} />

      {pluginConfigOpen && entry.pluginItem && (
        <BotPluginConfigModal
          pluginId={entry.pluginItem.pluginId}
          pluginName={entry.pluginItem.pluginName}
          configSchema={entry.pluginItem.configSchema}
          initialConfig={entry.pluginItem.config}
          ctx={ctx}
          hintMessage={pluginConfigHint}
          onSaved={async () => {
            onPluginMutated?.();
            if (!state.connected) await connectOneClick();
          }}
          onClose={() => setPluginConfigOpen(false)}
        />
      )}
    </div>
  );
}

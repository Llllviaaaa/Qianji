/**
 * 1:1 Grok Unconnected View & Meta Muse / ChatGPT Connected Config Page
 * (`BotConnectorDetailView.tsx`). Zero inline credential/host input boxes.
 */
import { useEffect, useState, type ReactElement } from "react";
import type { Context } from "@deepseek-ai/cordis";
import { ArrowLeft, ArrowUpRight, RefreshCw } from "lucide-react";
import { useAppStore, useFrontendService } from "@qianji/client";
import { SlotHost } from "@qianji/client-slots";
import type {
  BotActionPermissionLevel,
  BotConnectorTestKind,
  BotMcpDiscoveredTool,
  McpServerStatus,
} from "@qianji/protocol";
import { CONNECTOR_CATALOG, resolveConnectorState, type ConnectorCatalogEntry } from "./botConnectorCatalog";
import { ConnectorBrandIcon } from "./BotConnectorLogos";
import { BotConnectorModal } from "./BotConnectorModals";
import { BotConnectorPermissionSection } from "./BotConnectorPermissionSection";
import { BotGoogleMcpModal } from "./BotGoogleMcpModal";
import { BotPluginConfigModal } from "./BotPluginsSettingsPane";
import { patchBotUi, useBotController, useBotSnapshot, useBotUiState } from "./botStore";
import { useBotConnectorActions } from "./useBotConnectorActions";

function resolveSyncTestKind(id: string): BotConnectorTestKind | null {
  if (id === "gmail" || id === "outlook" || id === "imap_email") return "email";
  if (id === "calendar") return "calendar";
  if (id === "github") return "github";
  if (id === "notion") return "notion";
  return null;
}

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
  const appSettings = useAppStore((s) => s.settings);

  const [discoveredTools, setDiscoveredTools] = useState<readonly BotMcpDiscoveredTool[]>([]);

  const entry = pluginEntry ?? CONNECTOR_CATALOG.find((c) => c.id === connectorId);
  const mcpServerId = entry?.mcpPreset?.serverId;
  const state = entry
    ? resolveConnectorState(entry, snapshot, mcpStatus, appSettings?.mcpServers ?? [])
    : undefined;

  const actions = useBotConnectorActions({
    entry,
    state,
    ctx,
    onPluginMutated,
  });

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

  if (!entry || !state) {
    return (
      <div className="qj-conn-detail-wrap">
        <button type="button" className="qj-conn-back-btn" onClick={onBack}>
          <ArrowLeft size={14} /> 返回连接器
        </button>
      </div>
    );
  }

  const syncKind = resolveSyncTestKind(entry.id);

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
              disabled={actions.oauthBusy || ui.serverBusy}
              className="qj-primary-pill-btn qj-conn-connect-cta"
              onClick={() => void actions.connectOneClick()}
            >
              {actions.oauthBusy ? "正在授权…" : "连接"}
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
                <div className="qj-conn-about-item-d">OAuth 令牌与凭据加密存放于系统 Keychain；写入与外发动作默认须经你批准。</div>
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
                <div className="qj-conn-hint">
                  授权方式：{state.authMethodUsed}
                  {state.lastSyncAt
                    ? ` · 最近同步 ${new Date(state.lastSyncAt).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit", hour12: false })}`
                    : ""}
                </div>
              </div>
              <div style={{ display: "flex", gap: 8 }}>
                {syncKind && (
                  <button
                    type="button"
                    data-testid="sync-connector-now-btn"
                    disabled={ui.serverBusy}
                    className="qj-soft-btn qj-conn-pill-btn"
                    onClick={() => void ctrl.testConnector(syncKind)}
                  >
                    <RefreshCw size={12} />
                    <span>立即同步</span>
                  </button>
                )}
                <button type="button" className="qj-soft-btn qj-conn-pill-btn" onClick={() => void actions.connectOneClick(true)}>
                  重新授权
                </button>
                {entry.pluginItem && (
                  <button
                    type="button"
                    className="qj-soft-btn qj-conn-pill-btn"
                    onClick={() => {
                      actions.setPluginConfigHint(undefined);
                      actions.setPluginConfigOpen(true);
                    }}
                  >
                    插件参数配置
                  </button>
                )}
                {(entry.id === "calendar" || entry.id === "github") && (
                  <button
                    type="button"
                    className="qj-soft-btn qj-conn-pill-btn"
                    onClick={() => actions.setModalKind(entry.id === "github" ? "github-sync" : "calendar-sync")}
                  >
                    {entry.id === "calendar" ? "ICS 订阅源" : "PAT 同步配置"}
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
            onSelectTier={(tier) => void actions.updatePolicyTier(tier)}
            onUpdateActionPerm={(capId, level) => void actions.updateActionPerm(capId, level)}
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
              <button type="button" className="qj-soft-btn qj-conn-danger-pill" onClick={() => void actions.handleDisconnect()}>断开连接</button>
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

      <BotConnectorModal kind={actions.modalKind} defaultEmailPreset={entry.id === "outlook" ? "outlook" : "qq"} ctx={ctx} onClose={() => actions.setModalKind(null)} />

      {(entry.id === "gmail" || entry.id === "calendar" || entry.id === "google_drive") && entry.mcpPreset && (
        <BotGoogleMcpModal
          open={actions.googleModalOpen}
          connectorId={entry.id}
          connectorName={entry.name}
          defaultMcpUrl={entry.mcpPreset.url}
          trustedReadOnly={entry.mcpPreset.trustedReadOnly}
          ctx={ctx}
          onClose={() => actions.setGoogleModalOpen(false)}
        />
      )}

      {actions.pluginConfigOpen && entry.pluginItem && (
        <BotPluginConfigModal
          pluginId={entry.pluginItem.pluginId}
          pluginName={entry.pluginItem.pluginName}
          configSchema={entry.pluginItem.configSchema}
          initialConfig={entry.pluginItem.config}
          ctx={ctx}
          hintMessage={actions.pluginConfigHint}
          onSaved={async () => {
            onPluginMutated?.();
            if (!state.connected) await actions.connectOneClick();
          }}
          onClose={() => actions.setPluginConfigOpen(false)}
        />
      )}
    </div>
  );
}

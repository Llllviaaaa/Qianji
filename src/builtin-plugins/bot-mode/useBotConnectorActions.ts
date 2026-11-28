/**
 * Connection, OAuth 2.1, Google Workspace MCP, GitHub CLI, and permission mutation
 * controller hook for `BotConnectorDetailView` (`useBotConnectorActions.ts`).
 */
import { useState } from "react";
import type { Context } from "@deepseek-ai/cordis";
import { useAppStore, useFrontendService } from "@qianji/client";
import type {
  BotActionPermissionLevel,
  BotConnectorPermission,
  BotConnectorPolicyTier,
  BotSnapshotResult,
  McpServerConfig,
} from "@qianji/protocol";
import type { ConnectorCatalogEntry, ResolvedConnectorState } from "./botConnectorCatalog";
import type { ConnectorModalKind } from "./BotConnectorModals";
import { botDataStore, useBotController } from "./botStore";

const nowMs = (): number => Date.now();

export function useBotConnectorActions({
  entry,
  state,
  ctx,
  onPluginMutated,
}: {
  readonly entry: ConnectorCatalogEntry | undefined;
  readonly state: ResolvedConnectorState | undefined;
  readonly ctx?: Context;
  readonly onPluginMutated?: () => void;
}) {
  const ctrl = useBotController(ctx);
  const rpcService = useFrontendService("rpcService", ctx);
  const workspaceService = useFrontendService("workspaceService", ctx);
  const navigationService = useFrontendService("navigationService", ctx);
  const appSettings = useAppStore((s) => s.settings);
  const saveAppSettings = useAppStore((s) => s.saveSettings);

  const [oauthBusy, setOauthBusy] = useState(false);
  const [googleModalOpen, setGoogleModalOpen] = useState(false);
  const [pluginConfigOpen, setPluginConfigOpen] = useState(false);
  const [pluginConfigHint, setPluginConfigHint] = useState<string | undefined>(undefined);
  const [modalKind, setModalKind] = useState<ConnectorModalKind>(null);

  const saveMcpServerConfig = async (serverConfig: McpServerConfig) => {
    if (!appSettings) return;
    await saveAppSettings({
      ...appSettings,
      mcpEnabled: true,
      mcpServers: [...appSettings.mcpServers.filter((s) => s.id !== serverConfig.id), serverConfig],
    });
    await rpcService?.call("mcp.reconnect", { serverId: serverConfig.id }).catch(() => undefined);
  };

  const connectOneClick = async (forceInteractive = false) => {
    if (!entry) return;

    if (entry.authMode === "google-mcp" && entry.mcpPreset) {
      if (!rpcService) return;
      if (forceInteractive) {
        setGoogleModalOpen(true);
        return;
      }
      setOauthBusy(true);
      try {
        const res = await rpcService.call<{
          status: string;
          accountLabel?: string;
          serverConfig?: McpServerConfig;
          snapshot?: BotSnapshotResult;
        }>("bot.connector.googleMcpConnect", {
          connectorId: entry.id,
          interactive: false,
        });
        if (res.status === "connected" && res.serverConfig) {
          await saveMcpServerConfig(res.serverConfig);
          if (res.snapshot) botDataStore.set(res.snapshot);
          navigationService?.showToast(
            `已连接并同步 ${entry.name}${res.accountLabel ? `（${res.accountLabel}）` : ""}`,
            "info",
          );
        } else {
          setGoogleModalOpen(true);
        }
      } catch {
        setGoogleModalOpen(true);
      } finally {
        setOauthBusy(false);
      }
      return;
    }

    if (entry.authMode === "github-mcp" && entry.mcpPreset) {
      if (!rpcService) return;
      if (forceInteractive) {
        setModalKind("github-sync");
        return;
      }
      setOauthBusy(true);
      try {
        const ghRes = await rpcService.call<{
          status: string;
          accountLabel?: string;
          serverConfig?: McpServerConfig;
          snapshot?: BotSnapshotResult;
        }>("bot.connector.githubAutoConnect", {});
        if (ghRes.status === "connected" && ghRes.serverConfig) {
          await saveMcpServerConfig(ghRes.serverConfig);
          if (ghRes.snapshot) botDataStore.set(ghRes.snapshot);
          navigationService?.showToast(`已复用 GitHub CLI 登录态连接（${ghRes.accountLabel ?? "GitHub"}）`, "info");
          return;
        }
        try {
          const oauthRes = await rpcService.call<{
            ok: boolean;
            serverConfig: McpServerConfig;
            snapshot?: BotSnapshotResult;
          }>("bot.connector.oauth", {
            connectorId: entry.id,
            serverId: entry.mcpPreset.serverId,
            name: entry.name,
            mcpUrl: entry.mcpPreset.url,
            trustedReadOnly: entry.mcpPreset.trustedReadOnly,
          });
          await saveMcpServerConfig(oauthRes.serverConfig);
          if (oauthRes.snapshot) botDataStore.set(oauthRes.snapshot);
          navigationService?.showToast("已通过官方 OAuth 2.1 连接 GitHub MCP", "info");
        } catch {
          setModalKind("github-sync");
        }
      } finally {
        setOauthBusy(false);
      }
      return;
    }

    if (entry.authMode === "mcp-oauth" && entry.mcpPreset) {
      if (!appSettings || !rpcService) return;
      setOauthBusy(true);
      try {
        const res = await rpcService.call<{
          ok: boolean;
          serverConfig: McpServerConfig;
          snapshot?: BotSnapshotResult;
        }>("bot.connector.oauth", {
          connectorId: entry.id,
          serverId: entry.mcpPreset.serverId,
          name: entry.name,
          mcpUrl: entry.mcpPreset.url,
          trustedReadOnly: entry.mcpPreset.trustedReadOnly,
        });
        await saveMcpServerConfig(res.serverConfig);
        if (res.snapshot) botDataStore.set(res.snapshot);
        navigationService?.showToast(`已完成官方 OAuth 2.1 授权并连接 ${entry.name}`, "info");
      } catch (err) {
        navigationService?.showToast(err instanceof Error ? err.message : "OAuth 授权未完成", "warning");
      } finally {
        setOauthBusy(false);
      }
      return;
    }

    if (entry.authMode === "mcp-direct" && entry.mcpPreset) {
      await saveMcpServerConfig({
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
        headers: {},
        trustedReadOnly: entry.mcpPreset.trustedReadOnly,
      });
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

    if ((entry.authMode === "plugin" || entry.authMode === "browser") && entry.pluginItem) {
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
        appPolicies: {
          [entry.id]: {
            connected: true,
            authKind: "local",
            accountLabel: picked.trim(),
            connectedAt: nowMs(),
            policy: "read-only-auto",
          },
        },
      });
      await ctrl.testConnector("meeting_notes");
      return;
    }

    setModalKind(entry.authMode === "imap-modal" ? "imap" : "webhook");
  };

  const handleDisconnect = async () => {
    if (!entry) return;
    if ((entry.authMode === "plugin" || entry.authMode === "browser") && entry.pluginItem) {
      await rpcService?.call("bot.connector.pluginDisconnect", { connectorId: entry.id }).catch(() => undefined);
      onPluginMutated?.();
      navigationService?.showToast(`已断开「${entry.name}」`, "info");
      return;
    }
    if (entry.mcpPreset) {
      await rpcService
        ?.call("bot.connector.oauthDisconnect", {
          serverId: entry.mcpPreset.serverId,
          connectorId: entry.id,
        })
        .catch(() => undefined);
      if (appSettings) {
        await saveAppSettings({
          ...appSettings,
          mcpServers: appSettings.mcpServers.filter((s) => s.id !== entry.mcpPreset?.serverId),
        });
        await rpcService?.call("mcp.reconnect", {}).catch(() => undefined);
      }
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
    navigationService?.showToast(`已断开「${entry.name}」`, "info");
  };

  const updatePolicyTier = async (tier: BotConnectorPolicyTier) => {
    if (!entry) return;
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
    if (!entry || !state) return;
    await ctrl.configureBot({
      appPolicies: { [entry.id]: { policy: state.policyTier, actionPermissions: { [capId]: level } } },
    });
  };

  return {
    oauthBusy,
    googleModalOpen,
    setGoogleModalOpen,
    pluginConfigOpen,
    setPluginConfigOpen,
    pluginConfigHint,
    setPluginConfigHint,
    modalKind,
    setModalKind,
    connectOneClick,
    handleDisconnect,
    updatePolicyTier,
    updateActionPerm,
  };
}

/**
 * Runtime connection, MCP status & sync state resolver for Bot Mode connectors (`botConnectorState.ts`).
 */
import type {
  BotConnectedAppPolicy,
  BotConnectorPolicyTier,
  BotSnapshotResult,
  McpServerConfig,
  McpServerStatus,
} from "@qianji/protocol";
import type { ConnectorCatalogEntry } from "./botConnectorCatalog";

export interface ResolvedConnectorState {
  readonly connected: boolean;
  readonly statusLabel: string;
  readonly accountLabel?: string;
  readonly connectedAt?: number;
  readonly lastSyncAt?: number;
  readonly authMethodUsed: string;
  readonly policyTier: BotConnectorPolicyTier;
  readonly appPolicy?: BotConnectedAppPolicy;
  readonly readOnlyOnly: boolean;
  readonly lastError?: string;
  readonly mcpToolCount?: number;
}

function legacyPermToTier(perm?: "read-only" | "ask-write"): BotConnectorPolicyTier {
  return perm === "read-only" ? "strict-read-only" : "low-risk-auto";
}

function formatSyncShort(ts?: number): string | undefined {
  if (!ts || !Number.isFinite(ts)) return undefined;
  const d = new Date(ts);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${p(d.getHours())}:${p(d.getMinutes())}`;
}

export function resolveConnectorState(
  entry: ConnectorCatalogEntry,
  snapshot: BotSnapshotResult,
  mcpStatus: readonly McpServerStatus[],
  mcpServers: readonly McpServerConfig[],
): ResolvedConnectorState {
  const cfgs = snapshot.connectorConfigs;
  const appPol = cfgs.appPolicies?.[entry.id];
  const hasWriteCaps = entry.capabilities.some((c) => c.kind === "write");

  const preset = entry.mcpPreset;
  const presetCfg = preset ? mcpServers.find((s) => s.id === preset.serverId) : undefined;
  const presetSt = preset ? mcpStatus.find((s) => s.id === preset.serverId) : undefined;

  if (entry.id === "gmail") {
    const em = cfgs.email;
    const isImap = em.enabled && em.preset === "gmail" && (Boolean(em.emailAddress) || Boolean(em.hasPassword));
    const mcpEnabled = Boolean(presetCfg?.enabled);
    const connected = Boolean(appPol?.connected) || mcpEnabled || isImap;
    const lastSyncAt = appPol?.lastSyncAt ?? (isImap ? em.lastSyncAt : undefined);
    const syncTime = formatSyncShort(lastSyncAt);
    const statusLabel = presetSt?.connected
      ? `已同步 · ${presetSt.toolCount} 工具`
      : syncTime
        ? `已同步 ${syncTime}`
        : presetCfg?.enabled && presetSt && !presetSt.connected
          ? "MCP 重连中"
          : connected
            ? "已连接"
            : "未连接";
    return {
      connected,
      statusLabel,
      accountLabel: appPol?.accountLabel || (isImap ? em.emailAddress : presetCfg ? `${presetCfg.name}` : undefined),
      connectedAt: appPol?.connectedAt,
      lastSyncAt,
      authMethodUsed:
        presetCfg?.transport === "stdio"
          ? "Google Workspace CLI (gws MCP)"
          : isImap && !appPol?.connected
            ? "标准 IMAP / 授权码"
            : "OAuth 2.1 (Gmail MCP)",
      policyTier: appPol?.policy ?? (isImap ? legacyPermToTier(em.permission) : "low-risk-auto"),
      appPolicy: appPol,
      readOnlyOnly: false,
      lastError: presetSt?.error ?? appPol?.lastError ?? (isImap ? em.lastError : undefined),
      mcpToolCount: presetSt?.toolCount,
    };
  }

  if (entry.id === "calendar") {
    const cal = cfgs.calendar;
    const isIcs = cal.enabled && (Boolean(cal.icsUrl.trim()) || Boolean(cal.localIcsPath.trim()));
    const mcpEnabled = Boolean(presetCfg?.enabled);
    const connected = Boolean(appPol?.connected) || mcpEnabled || isIcs;
    const lastSyncAt = appPol?.lastSyncAt ?? (isIcs ? cal.lastSyncAt : undefined);
    const statusLabel = presetSt?.connected
      ? `已同步 · 今日 ${snapshot.awareness.todayEvents.length} 项`
      : isIcs
        ? `今日 ${snapshot.awareness.todayEvents.length} 项日程`
        : connected
          ? "已连接"
          : "未连接";
    return {
      connected,
      statusLabel,
      accountLabel: appPol?.accountLabel || (isIcs ? "ICS 日历订阅" : presetCfg?.name),
      connectedAt: appPol?.connectedAt,
      lastSyncAt,
      authMethodUsed:
        presetCfg?.transport === "stdio"
          ? "Google Workspace CLI (gws MCP)"
          : isIcs && !appPol?.connected && !mcpEnabled
            ? "ICS 订阅同步"
            : "OAuth 2.1 (Google Calendar MCP)",
      policyTier: appPol?.policy ?? "read-only-auto",
      appPolicy: appPol,
      readOnlyOnly: true,
      lastError: presetSt?.error ?? appPol?.lastError ?? cal.lastError,
      mcpToolCount: presetSt?.toolCount,
    };
  }

  if (entry.id === "github") {
    const gh = cfgs.github ?? { enabled: false, permission: "read-only" as const, watchedRepos: [], hasToken: false };
    const isNative = gh.enabled && (gh.watchedRepos.length > 0 || Boolean(gh.hasToken));
    const mcpEnabled = Boolean(presetCfg?.enabled);
    const connected = Boolean(appPol?.connected) || mcpEnabled || isNative;
    const lastSyncAt = gh.lastSyncAt ?? appPol?.lastSyncAt;
    return {
      connected,
      statusLabel: presetSt?.connected
        ? `已连接 · ${presetSt.toolCount} 工具`
        : connected
          ? gh.watchedRepos.length > 0
            ? `盯守 ${gh.watchedRepos.length} 个仓库`
            : "已连接"
          : "未连接",
      accountLabel: appPol?.accountLabel || gh.watchedRepos.join(", ") || undefined,
      connectedAt: appPol?.connectedAt,
      lastSyncAt,
      authMethodUsed: mcpEnabled ? "GitHub 官方 MCP / CLI" : "GitHub Token Sync",
      policyTier: appPol?.policy ?? (isNative ? legacyPermToTier(gh.permission) : "low-risk-auto"),
      appPolicy: appPol,
      readOnlyOnly: false,
      lastError: presetSt?.error ?? gh.lastError,
      mcpToolCount: presetSt?.toolCount,
    };
  }

  if (entry.id === "slack") {
    const sl = cfgs.slack ?? { enabled: false, permission: "ask-write" as const, channelLabel: "", hasWebhookUrl: false };
    const isWebhook = sl.enabled && Boolean(sl.hasWebhookUrl);
    const mcpEnabled = Boolean(presetCfg?.enabled);
    const connected = Boolean(appPol?.connected) || mcpEnabled || isWebhook;
    return {
      connected,
      statusLabel: presetSt?.connected ? `已连接 · ${presetSt.toolCount} 工具` : connected ? "已连接" : "未连接",
      accountLabel: appPol?.accountLabel || sl.channelLabel || (mcpEnabled ? "Slack MCP" : undefined),
      connectedAt: appPol?.connectedAt,
      lastSyncAt: sl.lastSyncAt ?? appPol?.lastSyncAt,
      authMethodUsed: isWebhook && !mcpEnabled ? "Incoming Webhook" : "官方 OAuth 2.1 (MCP)",
      policyTier: appPol?.policy ?? (isWebhook ? legacyPermToTier(sl.permission) : "low-risk-auto"),
      appPolicy: appPol,
      readOnlyOnly: false,
      lastError: presetSt?.error ?? sl.lastError,
      mcpToolCount: presetSt?.toolCount,
    };
  }

  if (preset) {
    const mcpConnected = Boolean(presetCfg?.enabled);
    const connected =
      Boolean(appPol?.connected) ||
      mcpConnected ||
      (entry.id === "notion" && Boolean(cfgs.notion?.enabled && cfgs.notion.hasToken));
    const policyTier = appPol?.policy ?? (presetCfg?.trustedReadOnly ? "strict-read-only" : "low-risk-auto");
    return {
      connected,
      statusLabel: presetSt?.connected
        ? `已连接 · ${presetSt.toolCount} 工具`
        : connected
          ? "已连接"
          : "未连接",
      accountLabel: appPol?.accountLabel || (mcpConnected ? `${preset.name} MCP` : undefined),
      connectedAt: appPol?.connectedAt,
      lastSyncAt: appPol?.lastSyncAt ?? (entry.id === "notion" ? cfgs.notion?.lastSyncAt : undefined),
      authMethodUsed:
        presetCfg?.transport === "stdio"
          ? "Google Workspace CLI (gws MCP)"
          : entry.authMode === "mcp-direct"
            ? "MCP 免密钥直连"
            : "官方 OAuth 2.1 (MCP)",
      policyTier,
      appPolicy: appPol,
      readOnlyOnly: !hasWriteCaps,
      lastError: presetSt?.error ?? appPol?.lastError ?? (entry.id === "notion" ? cfgs.notion?.lastError : undefined),
      mcpToolCount: presetSt?.toolCount,
    };
  }

  if (entry.id === "outlook" || entry.id === "imap_email") {
    const em = cfgs.email;
    const isMatched =
      entry.id === "outlook"
        ? em.enabled && em.preset === "outlook" && Boolean(em.emailAddress)
        : em.enabled && (em.preset === "qq" || em.preset === "163" || em.preset === "custom") && Boolean(em.emailAddress);
    const connected = Boolean(appPol?.connected) || isMatched;
    return {
      connected,
      statusLabel: connected ? "已同步" : "未连接",
      accountLabel: appPol?.accountLabel || (isMatched ? em.emailAddress : undefined),
      connectedAt: appPol?.connectedAt,
      lastSyncAt: em.lastSyncAt,
      authMethodUsed: "标准 ImapFlow / SMTP",
      policyTier: appPol?.policy ?? legacyPermToTier(em.permission),
      appPolicy: appPol,
      readOnlyOnly: false,
      lastError: em.lastError,
    };
  }

  if (entry.id === "meeting_notes") {
    const m = cfgs.meetingsIm;
    const connected = m.meetingNotesEnabled && m.meetingNotesDir.trim() !== "";
    return {
      connected,
      statusLabel: connected ? "正在监听目录" : "未连接",
      accountLabel: m.meetingNotesDir || undefined,
      connectedAt: appPol?.connectedAt,
      lastSyncAt: m.lastSyncAt,
      authMethodUsed: "本地目录监听",
      policyTier: "read-only-auto",
      appPolicy: appPol,
      readOnlyOnly: true,
    };
  }

  if (entry.authMode === "plugin" && entry.pluginItem) {
    const pItem = entry.pluginItem;
    const connected = Boolean(appPol?.connected) && pItem.pluginEnabled && pItem.pluginBotEnabled;
    const toolCount = pItem.tools.length;
    return {
      connected,
      statusLabel: connected ? (toolCount > 0 ? `已连接 · ${toolCount} 工具` : "已连接") : "未连接",
      accountLabel: appPol?.accountLabel || pItem.runtimeAccountLabel || undefined,
      connectedAt: appPol?.connectedAt,
      lastSyncAt: appPol?.lastSyncAt,
      authMethodUsed: `插件 · ${pItem.pluginName}`,
      policyTier: appPol?.policy ?? (hasWriteCaps ? "low-risk-auto" : "read-only-auto"),
      appPolicy: appPol,
      readOnlyOnly: !hasWriteCaps,
      lastError: pItem.runtimeError,
      mcpToolCount: toolCount,
    };
  }

  if (entry.authMode === "browser") {
    const connected = Boolean(appPol?.connected);
    return {
      connected,
      statusLabel: connected ? "已连接" : "未连接",
      accountLabel: appPol?.accountLabel,
      connectedAt: appPol?.connectedAt,
      authMethodUsed: entry.authLabel,
      policyTier: appPol?.policy ?? (hasWriteCaps ? "low-risk-auto" : "read-only-auto"),
      appPolicy: appPol,
      readOnlyOnly: !hasWriteCaps,
    };
  }

  const wh = cfgs.customWebhook ?? { enabled: false, permission: "ask-write" as const, label: "", endpointUrl: "" };
  const connected = wh.enabled && Boolean(wh.endpointUrl.trim());
  return {
    connected,
    statusLabel: connected ? "已连接" : "未连接",
    accountLabel: wh.endpointUrl || undefined,
    connectedAt: appPol?.connectedAt,
    lastSyncAt: wh.lastSyncAt,
    authMethodUsed: "HTTPS Webhook",
    policyTier: appPol?.policy ?? legacyPermToTier(wh.permission),
    appPolicy: appPol,
    readOnlyOnly: false,
    lastError: wh.lastError,
  };
}

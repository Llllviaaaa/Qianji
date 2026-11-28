/**
 * Runtime connection & permission state resolver for Bot Mode connectors (`botConnectorState.ts`).
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

  if (preset) {
    const mcpConnected = Boolean(presetCfg?.enabled);
    const connected = Boolean(appPol?.connected) || mcpConnected || (entry.id === "notion" && Boolean(cfgs.notion?.enabled && cfgs.notion.hasToken));
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
      authMethodUsed: entry.authMode === "mcp-oauth" ? "OAuth 2.1 (MCP)" : "MCP 免密钥直连",
      policyTier,
      appPolicy: appPol,
      readOnlyOnly: !hasWriteCaps,
      lastError: presetSt?.error ?? (entry.id === "notion" ? cfgs.notion?.lastError : undefined),
      mcpToolCount: presetSt?.toolCount,
    };
  }

  if (entry.id === "gmail" || entry.id === "outlook") {
    const em = cfgs.email;
    const isThis = em.enabled && em.preset === entry.id && (Boolean(em.emailAddress) || Boolean(em.hasPassword));
    const connected = Boolean(appPol?.connected) || isThis;
    const policyTier = appPol?.policy ?? (isThis ? legacyPermToTier(em.permission) : "low-risk-auto");
    return {
      connected,
      statusLabel: connected ? "已连接" : "未连接",
      accountLabel: appPol?.accountLabel || (isThis ? em.emailAddress : undefined),
      connectedAt: appPol?.connectedAt,
      authMethodUsed: isThis && !appPol?.connected ? "IMAP / 授权码" : "独立安全浏览器会话",
      policyTier,
      appPolicy: appPol,
      readOnlyOnly: false,
      lastError: isThis ? em.lastError : undefined,
    };
  }

  if (entry.id === "imap_email") {
    const em = cfgs.email;
    const connected = em.enabled && (em.preset === "qq" || em.preset === "163" || em.preset === "custom") && Boolean(em.emailAddress);
    return {
      connected,
      statusLabel: connected ? "已连接" : "未连接",
      accountLabel: connected ? em.emailAddress : undefined,
      connectedAt: appPol?.connectedAt,
      authMethodUsed: "IMAP / SMTP SSL",
      policyTier: appPol?.policy ?? legacyPermToTier(em.permission),
      appPolicy: appPol,
      readOnlyOnly: false,
      lastError: em.lastError,
    };
  }

  if (entry.id === "calendar") {
    const cal = cfgs.calendar;
    const isIcs = cal.enabled && (Boolean(cal.icsUrl.trim()) || Boolean(cal.localIcsPath.trim()));
    const connected = Boolean(appPol?.connected) || isIcs;
    return {
      connected,
      statusLabel: isIcs ? `今日 ${snapshot.awareness.todayEvents.length} 项日程` : connected ? "已连接" : "未连接",
      accountLabel: appPol?.accountLabel || (cal.icsUrl ? "ICS 日历订阅" : undefined),
      connectedAt: appPol?.connectedAt,
      authMethodUsed: isIcs && !appPol?.connected ? "ICS 订阅同步" : "Google 网页会话",
      policyTier: appPol?.policy ?? "read-only-auto",
      appPolicy: appPol,
      readOnlyOnly: true,
      lastError: cal.lastError,
    };
  }

  if (entry.id === "github") {
    const gh = cfgs.github ?? { enabled: false, permission: "read-only" as const, watchedRepos: [], hasToken: false };
    const isNative = gh.enabled && (gh.watchedRepos.length > 0 || Boolean(gh.hasToken));
    const connected = Boolean(appPol?.connected) || isNative;
    return {
      connected,
      statusLabel: connected ? (gh.watchedRepos.length > 0 ? `盯守 ${gh.watchedRepos.length} 个仓库` : "已连接") : "未连接",
      accountLabel: appPol?.accountLabel || gh.watchedRepos.join(", ") || undefined,
      connectedAt: appPol?.connectedAt,
      authMethodUsed: isNative && !appPol?.connected ? "GitHub Token Sync" : "GitHub 网页会话",
      policyTier: appPol?.policy ?? (isNative ? legacyPermToTier(gh.permission) : "low-risk-auto"),
      appPolicy: appPol,
      readOnlyOnly: false,
      lastError: gh.lastError,
    };
  }

  if (entry.id === "slack") {
    const sl = cfgs.slack ?? { enabled: false, permission: "ask-write" as const, channelLabel: "", hasWebhookUrl: false };
    const isNative = sl.enabled && Boolean(sl.hasWebhookUrl);
    const connected = Boolean(appPol?.connected) || isNative;
    return {
      connected,
      statusLabel: connected ? "已连接" : "未连接",
      accountLabel: appPol?.accountLabel || sl.channelLabel || undefined,
      connectedAt: appPol?.connectedAt,
      authMethodUsed: isNative && !appPol?.connected ? "Incoming Webhook" : "Slack 网页会话",
      policyTier: appPol?.policy ?? (isNative ? legacyPermToTier(sl.permission) : "low-risk-auto"),
      appPolicy: appPol,
      readOnlyOnly: false,
      lastError: sl.lastError,
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
    authMethodUsed: "HTTPS Webhook",
    policyTier: appPol?.policy ?? legacyPermToTier(wh.permission),
    appPolicy: appPol,
    readOnlyOnly: false,
    lastError: wh.lastError,
  };
}

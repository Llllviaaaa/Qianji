/**
 * Connector wire protocol contracts for Qianji Bot Mode (`@qianji/protocol`).
 *
 * Covers built-in productivity connectors (Email, Calendar, Process Sensor,
 * Meeting Notes/IM), cloud app catalog connectors (GitHub, Notion, Slack),
 * custom Webhook/Zapier automation, and granular Read-Only vs. Ask-Write
 * permission controls.
 */

import type { PluginConnectorManifest } from "./plugin-methods.ts";

export type BotConnectorPermission = "read-only" | "ask-write";

export type BotConnectorPolicyTier =
  | "always-ask"
  | "read-only-auto"
  | "low-risk-auto"
  | "strict-read-only";

export type BotActionPermissionLevel = "allow" | "ask" | "deny";

export interface BotConnectedAppPolicy {
  connected?: boolean;
  authKind?: "oauth" | "browser" | "mcp" | "local" | "api" | "plugin";
  accountLabel?: string;
  connectedAt?: number;
  policy: BotConnectorPolicyTier;
  actionPermissions?: Record<string, BotActionPermissionLevel>;
  backgroundSync?: boolean;
}

export interface BotMcpDiscoveredTool {
  name: string;
  rawName: string;
  description: string;
  readOnly: boolean;
}

export interface BotPluginConnectorCatalogItem {
  pluginId: string;
  pluginName: string;
  pluginEnabled: boolean;
  pluginBotEnabled: boolean;
  configSchema?: Record<string, unknown>;
  config?: Record<string, unknown>;
  connector: PluginConnectorManifest;
  tools: BotMcpDiscoveredTool[];
  runtimeConnected?: boolean;
  runtimeAccountLabel?: string;
  runtimeError?: string;
}

export type BotConnectorTestKind =
  | "email"
  | "calendar"
  | "processes"
  | "meetings_im"
  | "meeting_notes"
  | "telegram"
  | "feishu"
  | "github"
  | "notion"
  | "slack"
  | "custom_webhook";

export interface BotConnectorItem {
  id: string;
  name: string;
  description: string;
  enabled: boolean;
  permission?: BotConnectorPermission;
}

export type BotEmailPreset = "qq" | "163" | "gmail" | "outlook" | "custom";

export interface BotEmailConnectorConfig {
  enabled: boolean;
  permission?: BotConnectorPermission;
  preset: BotEmailPreset;
  emailAddress: string;
  imapHost: string;
  imapPort: number;
  imapTls: boolean;
  smtpHost: string;
  smtpPort: number;
  smtpTls: boolean;
  hasPassword?: boolean;
  lastSyncAt?: number;
  lastError?: string;
}

export interface BotCalendarConnectorConfig {
  enabled: boolean;
  icsUrl: string;
  localIcsPath: string;
  leadMinutes: number;
  lastSyncAt?: number;
  lastError?: string;
}

export interface BotProcessSensorConfig {
  enabled: boolean;
  watchedProcesses: string[];
  lateNightCareEnabled: boolean;
}

export interface BotMeetingsImConfig {
  permission?: BotConnectorPermission;
  telegramPermission?: BotConnectorPermission;
  feishuPermission?: BotConnectorPermission;
  meetingNotesEnabled: boolean;
  meetingNotesDir: string;
  telegramEnabled: boolean;
  telegramChatId: string;
  telegramApiBase?: string;
  hasTelegramToken?: boolean;
  feishuEnabled: boolean;
  hasFeishuWebhook?: boolean;
  lastSyncAt?: number;
  lastError?: string;
}

export interface BotGitHubConnectorConfig {
  enabled: boolean;
  permission: BotConnectorPermission;
  watchedRepos: string[];
  apiBase?: string;
  hasToken?: boolean;
  lastSyncAt?: number;
  lastError?: string;
}

export interface BotNotionConnectorConfig {
  enabled: boolean;
  permission: BotConnectorPermission;
  parentPageId: string;
  apiBase?: string;
  hasToken?: boolean;
  lastSyncAt?: number;
  lastError?: string;
}

export interface BotSlackConnectorConfig {
  enabled: boolean;
  permission: BotConnectorPermission;
  channelLabel: string;
  hasWebhookUrl?: boolean;
  lastSyncAt?: number;
  lastError?: string;
}

export interface BotCustomWebhookConnectorConfig {
  enabled: boolean;
  permission: BotConnectorPermission;
  label: string;
  endpointUrl: string;
  hasBearerToken?: boolean;
  lastSyncAt?: number;
  lastError?: string;
}

export interface BotConnectorsConfig {
  email: BotEmailConnectorConfig;
  calendar: BotCalendarConnectorConfig;
  processSensor: BotProcessSensorConfig;
  meetingsIm: BotMeetingsImConfig;
  github?: BotGitHubConnectorConfig;
  notion?: BotNotionConnectorConfig;
  slack?: BotSlackConnectorConfig;
  customWebhook?: BotCustomWebhookConnectorConfig;
  appPolicies?: Record<string, BotConnectedAppPolicy>;
}

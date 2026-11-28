/**
 * Proactive companion settings, encrypted connector secrets & reflection helpers
 * for `BotStateStore` (`packages/host/src/bot/store-proactive.ts`).
 */
import { existsSync, readFileSync } from "node:fs";
import type { Credentials } from "@qianji/llm";
import type {
  BotCalendarConnectorConfig,
  BotConnectedAppPolicy,
  BotConnectorsConfig,
  BotCustomWebhookConnectorConfig,
  BotEmailConnectorConfig,
  BotEmailPreset,
  BotGitHubConnectorConfig,
  BotMeetingsImConfig,
  BotModelConfig,
  BotNotionConnectorConfig,
  BotPacingConfig,
  BotProcessSensorConfig,
  BotSlackConnectorConfig,
  PendingBotApproval,
} from "@qianji/protocol";
import type { ConnectorSecrets } from "./connectors/connector-hub.ts";
import { resolveEmailPreset } from "./connectors/email-connector.ts";
import {
  buildDefaultConnectorsConfig,
  buildDefaultPacingConfig,
  type PersistedBotState,
} from "./defaults.ts";
import { writeFileAtomic } from "./workspace-scanner.ts";

export const EMAIL_SECRET_ID = "bot/email-password";
export const TELEGRAM_SECRET_ID = "bot/telegram-token";
export const FEISHU_SECRET_ID = "bot/feishu-webhook";
export const GITHUB_SECRET_ID = "bot/github-token";
export const NOTION_SECRET_ID = "bot/notion-token";
export const SLACK_SECRET_ID = "bot/slack-webhook";
export const WEBHOOK_SECRET_ID = "bot/custom-webhook-token";

export interface BotProactivePatch {
  workspaceDir?: string;
  modelConfig?: {
    primary?: BotModelConfig["primary"] | null;
    patrol?: BotModelConfig["patrol"] | null;
  };
  pacing?: Partial<BotPacingConfig>;
  email?: Partial<BotEmailConnectorConfig> & { password?: string };
  calendar?: Partial<BotCalendarConnectorConfig>;
  processSensor?: Partial<BotProcessSensorConfig>;
  meetingsIm?: Partial<BotMeetingsImConfig> & { telegramToken?: string; feishuWebhook?: string };
  github?: Partial<BotGitHubConnectorConfig> & { token?: string };
  notion?: Partial<BotNotionConnectorConfig> & { token?: string };
  slack?: Partial<BotSlackConnectorConfig> & { webhookUrl?: string };
  customWebhook?: Partial<BotCustomWebhookConnectorConfig> & { bearerToken?: string };
  appPolicies?: Record<string, Partial<BotConnectedAppPolicy> | null>;
}

export class BotSecretVault {
  private readonly cache = new Map<string, string>();

  constructor(private readonly credentials?: Credentials) {}

  async set(id: string, value: string | undefined): Promise<void> {
    if (value === undefined) return;
    if (value === "") {
      this.cache.delete(id);
      if (this.credentials?.writable) {
        await this.credentials.delete(id).catch(() => false);
      }
      return;
    }
    this.cache.set(id, value);
    if (this.credentials?.writable) {
      await this.credentials.set(id, value).catch(() => undefined);
    }
  }

  async get(id: string): Promise<string | undefined> {
    const cached = this.cache.get(id);
    if (cached !== undefined) return cached;
    if (this.credentials) {
      const stored = await this.credentials.get(id).catch(() => undefined);
      if (stored !== undefined && stored !== "") return stored;
    }
    return undefined;
  }

  async has(id: string): Promise<boolean> {
    return (await this.get(id)) !== undefined;
  }
}

export async function readConnectorSecrets(vault: BotSecretVault): Promise<ConnectorSecrets> {
  const [emailPassword, telegramToken, feishuWebhook, githubToken, notionToken, slackWebhook, customWebhookToken] =
    await Promise.all([
      vault.get(EMAIL_SECRET_ID),
      vault.get(TELEGRAM_SECRET_ID),
      vault.get(FEISHU_SECRET_ID),
      vault.get(GITHUB_SECRET_ID),
      vault.get(NOTION_SECRET_ID),
      vault.get(SLACK_SECRET_ID),
      vault.get(WEBHOOK_SECRET_ID),
    ]);
  return { emailPassword, telegramToken, feishuWebhook, githubToken, notionToken, slackWebhook, customWebhookToken };
}

export async function applyConnectorSecretPatch(vault: BotSecretVault, patch: BotProactivePatch): Promise<void> {
  if (typeof patch.email?.password === "string") await vault.set(EMAIL_SECRET_ID, patch.email.password);
  if (typeof patch.meetingsIm?.telegramToken === "string") await vault.set(TELEGRAM_SECRET_ID, patch.meetingsIm.telegramToken);
  if (typeof patch.meetingsIm?.feishuWebhook === "string") await vault.set(FEISHU_SECRET_ID, patch.meetingsIm.feishuWebhook);
  if (typeof patch.github?.token === "string") await vault.set(GITHUB_SECRET_ID, patch.github.token);
  if (typeof patch.notion?.token === "string") await vault.set(NOTION_SECRET_ID, patch.notion.token);
  if (typeof patch.slack?.webhookUrl === "string") await vault.set(SLACK_SECRET_ID, patch.slack.webhookUrl);
  if (typeof patch.customWebhook?.bearerToken === "string") await vault.set(WEBHOOK_SECRET_ID, patch.customWebhook.bearerToken);
}

export async function populateConnectorSecretFlags(vault: BotSecretVault, cfg: BotConnectorsConfig): Promise<void> {
  const [hasPw, hasTg, hasFeishu, hasGh, hasNotion, hasSlack, hasWh] = await Promise.all([
    vault.has(EMAIL_SECRET_ID),
    vault.has(TELEGRAM_SECRET_ID),
    vault.has(FEISHU_SECRET_ID),
    vault.has(GITHUB_SECRET_ID),
    vault.has(NOTION_SECRET_ID),
    vault.has(SLACK_SECRET_ID),
    vault.has(WEBHOOK_SECRET_ID),
  ]);
  cfg.email.hasPassword = hasPw;
  cfg.meetingsIm.hasTelegramToken = hasTg;
  cfg.meetingsIm.hasFeishuWebhook = hasFeishu;
  if (cfg.github) cfg.github.hasToken = hasGh;
  if (cfg.notion) cfg.notion.hasToken = hasNotion;
  if (cfg.slack) cfg.slack.hasWebhookUrl = hasSlack;
  if (cfg.customWebhook) cfg.customWebhook.hasBearerToken = hasWh;
}

export function seedPersistedBotSessionIds(stateFile: string, target: Set<string>): void {
  if (!existsSync(stateFile)) return;
  try {
    const raw = JSON.parse(readFileSync(stateFile, "utf8")) as Partial<PersistedBotState>;
    if (typeof raw.mainSessionId === "string" && raw.mainSessionId) target.add(raw.mainSessionId);
    for (const sc of raw.sideThreads ?? []) {
      if (typeof sc?.sessionId === "string" && sc.sessionId) target.add(sc.sessionId);
    }
  } catch {
    // Ignore malformed or missing state file until ensureLoaded repairs it
  }
}

export function readPersistedAppConnectedSync(stateFile: string, connectorId: string): boolean {
  if (!existsSync(stateFile)) return false;
  try {
    const raw = JSON.parse(readFileSync(stateFile, "utf8")) as Partial<PersistedBotState>;
    return raw.connectorConfigs?.appPolicies?.[connectorId]?.connected === true;
  } catch {
    return false;
  }
}

export function isConnectorWriteAllowed(
  st: PersistedBotState,
  kind: NonNullable<PendingBotApproval["kind"]>,
): boolean {
  const cfg = st.connectorConfigs ?? buildDefaultConnectorsConfig();
  const policyBlocks = (id: string) => cfg.appPolicies?.[id]?.policy === "strict-read-only";
  switch (kind) {
    case "send-email":
      return cfg.email.permission !== "read-only" && !policyBlocks("gmail") && !policyBlocks("outlook");
    case "send-telegram":
      return (cfg.meetingsIm.telegramPermission ?? cfg.meetingsIm.permission) !== "read-only" && !policyBlocks("telegram");
    case "send-feishu":
      return (cfg.meetingsIm.feishuPermission ?? cfg.meetingsIm.permission) !== "read-only" && !policyBlocks("feishu");
    case "send-slack":
      return cfg.slack?.permission !== "read-only" && !policyBlocks("slack");
    case "github-comment":
      return cfg.github?.permission !== "read-only" && !policyBlocks("github");
    case "notion-page":
      return cfg.notion?.permission !== "read-only" && !policyBlocks("notion");
    case "trigger-webhook":
      return cfg.customWebhook?.permission !== "read-only" && !policyBlocks("custom_webhook");
    case "shell":
      return true;
  }
}

export function applyBotProactivePatch(st: PersistedBotState, patch: BotProactivePatch): void {
  const defaults = buildDefaultConnectorsConfig();
  if (!st.pacing) st.pacing = buildDefaultPacingConfig();
  if (!st.connectorConfigs) st.connectorConfigs = defaults;
  if (!st.modelConfig) st.modelConfig = {};

  if (typeof patch.workspaceDir === "string") {
    const trimmed = patch.workspaceDir.trim();
    st.customWorkspaceDir = trimmed !== "" ? trimmed : undefined;
  }

  if (patch.modelConfig) {
    const nextPrimary =
      patch.modelConfig.primary === null ||
      (patch.modelConfig.primary !== undefined && (!patch.modelConfig.primary.provider || !patch.modelConfig.primary.model))
        ? undefined
        : patch.modelConfig.primary !== undefined
          ? patch.modelConfig.primary
          : st.modelConfig.primary;
    const nextPatrol =
      patch.modelConfig.patrol === null ||
      (patch.modelConfig.patrol !== undefined && (!patch.modelConfig.patrol.provider || !patch.modelConfig.patrol.model))
        ? undefined
        : patch.modelConfig.patrol !== undefined
          ? patch.modelConfig.patrol
          : st.modelConfig.patrol;
    st.modelConfig = {
      ...(nextPrimary ? { primary: nextPrimary } : {}),
      ...(nextPatrol ? { patrol: nextPatrol } : {}),
    };
  }

  if (patch.pacing) {
    st.pacing = {
      ...st.pacing,
      ...patch.pacing,
      heartbeatIntervalMinutes: Math.max(1, patch.pacing.heartbeatIntervalMinutes ?? st.pacing.heartbeatIntervalMinutes),
    };
  }

  if (patch.email) {
    const { password: _pw, ...emailRest } = patch.email;
    const prevPreset = st.connectorConfigs.email.preset;
    const nextPreset: BotEmailPreset = emailRest.preset ?? prevPreset;
    const presetDefaults = emailRest.preset && emailRest.preset !== prevPreset && emailRest.preset !== "custom"
      ? resolveEmailPreset(nextPreset)
      : {};
    st.connectorConfigs.email = {
      ...st.connectorConfigs.email,
      ...presetDefaults,
      ...emailRest,
      preset: nextPreset,
    };
  }

  if (patch.calendar) {
    st.connectorConfigs.calendar = {
      ...st.connectorConfigs.calendar,
      ...patch.calendar,
      leadMinutes: Math.max(1, patch.calendar.leadMinutes ?? st.connectorConfigs.calendar.leadMinutes),
    };
    const calItem = st.connectors.find((c) => c.id === "calendar");
    if (calItem) calItem.enabled = st.connectorConfigs.calendar.enabled;
  }

  if (patch.processSensor) {
    st.connectorConfigs.processSensor = {
      ...st.connectorConfigs.processSensor,
      ...patch.processSensor,
      watchedProcesses: (patch.processSensor.watchedProcesses ?? st.connectorConfigs.processSensor.watchedProcesses)
        .map((s) => s.trim())
        .filter(Boolean),
    };
  }

  if (patch.meetingsIm) {
    const { telegramToken: _t, feishuWebhook: _f, ...rest } = patch.meetingsIm;
    st.connectorConfigs.meetingsIm = {
      ...st.connectorConfigs.meetingsIm,
      ...rest,
    };
  }

  if (patch.github) {
    const { token: _t, ...rest } = patch.github;
    const cur = st.connectorConfigs.github ?? defaults.github ?? { enabled: false, permission: "read-only", watchedRepos: [] };
    st.connectorConfigs.github = {
      ...cur,
      ...rest,
      watchedRepos: (rest.watchedRepos ?? cur.watchedRepos).map((r) => r.trim()).filter(Boolean),
    };
  }

  if (patch.notion) {
    const { token: _t, ...rest } = patch.notion;
    const cur = st.connectorConfigs.notion ?? defaults.notion ?? { enabled: false, permission: "read-only", parentPageId: "" };
    st.connectorConfigs.notion = { ...cur, ...rest };
  }

  if (patch.slack) {
    const { webhookUrl: _w, ...rest } = patch.slack;
    const cur = st.connectorConfigs.slack ?? defaults.slack ?? { enabled: false, permission: "ask-write", channelLabel: "" };
    st.connectorConfigs.slack = { ...cur, ...rest };
  }

  if (patch.customWebhook) {
    const { bearerToken: _b, ...rest } = patch.customWebhook;
    const cur = st.connectorConfigs.customWebhook ?? defaults.customWebhook ?? { enabled: false, permission: "ask-write", label: "Zapier / 自定义 Webhook", endpointUrl: "" };
    st.connectorConfigs.customWebhook = { ...cur, ...rest };
  }

  if (patch.appPolicies) {
    const curMap = { ...(st.connectorConfigs.appPolicies ?? {}) };
    for (const [id, entry] of Object.entries(patch.appPolicies)) {
      if (entry === null) {
        delete curMap[id];
        continue;
      }
      const prev = curMap[id] ?? { policy: "low-risk-auto" };
      curMap[id] = {
        ...prev,
        ...entry,
        ...(entry.actionPermissions
          ? { actionPermissions: { ...(prev.actionPermissions ?? {}), ...entry.actionPermissions } }
          : prev.actionPermissions
            ? { actionPermissions: prev.actionPermissions }
            : {}),
      };
    }
    st.connectorConfigs.appPolicies = curMap;
  }
}

export function rememberPreferenceEntry(
  st: PersistedBotState,
  memoryFile: string,
  preference: string,
): boolean {
  const clean = preference.trim().replace(/^[-*]\s+/, "");
  if (clean === "") return false;
  if (st.learnedPreferences.some((p) => p.toLowerCase() === clean.toLowerCase())) {
    return false;
  }
  st.learnedPreferences = [clean, ...st.learnedPreferences].slice(0, 20);
  try {
    const existing = existsSync(memoryFile) ? readFileSync(memoryFile, "utf8") : "# MEMORY.md\n";
    if (!existing.includes(clean)) {
      const next = `${existing.trimEnd()}\n- ${clean}\n`;
      writeFileAtomic(memoryFile, next, 0o600);
    }
  } catch {
    // Keep memory state even if disk write fails.
  }
  return true;
}

export function mutateWatchedProcessList(
  st: PersistedBotState,
  processName: string,
  remove = false,
): string[] {
  if (!st.connectorConfigs) st.connectorConfigs = buildDefaultConnectorsConfig();
  const clean = processName.trim();
  if (clean === "") return st.connectorConfigs.processSensor.watchedProcesses;
  const current = st.connectorConfigs.processSensor.watchedProcesses;
  if (remove) {
    st.connectorConfigs.processSensor.watchedProcesses = current.filter(
      (p) => p.toLowerCase() !== clean.toLowerCase(),
    );
  } else if (!current.some((p) => p.toLowerCase() === clean.toLowerCase())) {
    st.connectorConfigs.processSensor.watchedProcesses = [...current, clean];
  }
  return st.connectorConfigs.processSensor.watchedProcesses;
}
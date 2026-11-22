/**
 * Proactive companion settings, encrypted connector secrets & reflection helpers
 * for `BotStateStore` (`packages/host/src/bot/store-proactive.ts`).
 */
import { existsSync, readFileSync } from "node:fs";
import type { Credentials } from "@qianji/llm";
import type {
  BotCalendarConnectorConfig,
  BotEmailConnectorConfig,
  BotEmailPreset,
  BotMeetingsImConfig,
  BotModelConfig,
  BotPacingConfig,
  BotProcessSensorConfig,
} from "@qianji/protocol";
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

export interface BotProactivePatch {
  modelConfig?: BotModelConfig;
  pacing?: Partial<BotPacingConfig>;
  email?: Partial<BotEmailConnectorConfig> & { password?: string };
  calendar?: Partial<BotCalendarConnectorConfig>;
  processSensor?: Partial<BotProcessSensorConfig>;
  meetingsIm?: Partial<BotMeetingsImConfig> & { telegramToken?: string; feishuWebhook?: string };
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

export function applyBotProactivePatch(st: PersistedBotState, patch: BotProactivePatch): void {
  if (!st.pacing) st.pacing = buildDefaultPacingConfig();
  if (!st.connectorConfigs) st.connectorConfigs = buildDefaultConnectorsConfig();
  if (!st.modelConfig) st.modelConfig = {};

  if (patch.modelConfig) {
    st.modelConfig = {
      ...(patch.modelConfig.primary !== undefined ? { primary: patch.modelConfig.primary } : st.modelConfig.primary ? { primary: st.modelConfig.primary } : {}),
      ...(patch.modelConfig.patrol !== undefined ? { patrol: patch.modelConfig.patrol } : st.modelConfig.patrol ? { patrol: st.modelConfig.patrol } : {}),
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
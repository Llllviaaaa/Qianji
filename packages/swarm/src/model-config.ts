/**
 * Global (`<dataDir>/swarms/config.json`) & per-swarm role model configuration,
 * `ctx.llm` available-model enumeration, role model + effort resolution priority,
 * and live waiting-member hot-swap (`@qianji/swarm`).
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Context } from "@deepseek-ai/cordis";
import type { ModelInfo } from "@qianji/llm";
import type {
  SwarmAvailableModelInfo,
  SwarmConfigGetParams,
  SwarmConfigGetResult,
  SwarmConfigUpdateParams,
  SwarmConfigUpdateResult,
  SwarmMemberInfo,
  SwarmMemberRole,
  SwarmModelSettings,
  SwarmRoleModelConfig,
  SwarmSnapshotResult,
} from "@qianji/protocol";
import type { Session } from "@qianji/session";
import { parseModelSpec, type ManagedSwarm } from "./state.ts";

export const SWARM_MEMBER_ROLES: readonly SwarmMemberRole[] = [
  "coordinator",
  "planner",
  "explorer",
  "worker",
  "verifier",
  "monitor",
] as const;

let configTmpSeq = 0;

export function swarmGlobalConfigPath(dataDir: string): string {
  return join(dataDir, "swarms", "config.json");
}

export function sanitizeRoleModelConfig(raw: unknown): SwarmRoleModelConfig | undefined {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return undefined;
  const obj = raw as Record<string, unknown>;
  const rawModel = typeof obj.model === "string" ? obj.model.trim() : "";
  const rawProvider = typeof obj.provider === "string" ? obj.provider.trim() : "";
  if (rawModel === "") return undefined;

  let provider = rawProvider;
  let model = rawModel;
  if (provider === "") {
    const slash = rawModel.indexOf("/");
    if (slash > 0 && slash < rawModel.length - 1) {
      provider = rawModel.slice(0, slash).trim();
      model = rawModel.slice(slash + 1).trim();
    }
  }
  if (provider === "" || model === "") return undefined;

  const rawEffort = typeof obj.effort === "string" ? obj.effort.trim() : "";
  const effort = rawEffort !== "" && rawEffort !== "default" ? rawEffort : undefined;
  return {
    provider,
    model,
    ...(effort === undefined ? {} : { effort }),
  };
}

export function sanitizeRoleModelsMap(
  raw: unknown,
): Partial<Record<SwarmMemberRole, SwarmRoleModelConfig>> {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return {};
  const obj = raw as Record<string, unknown>;
  const out: Partial<Record<SwarmMemberRole, SwarmRoleModelConfig>> = {};
  for (const role of SWARM_MEMBER_ROLES) {
    const cleaned = sanitizeRoleModelConfig(obj[role]);
    if (cleaned !== undefined) out[role] = cleaned;
  }
  return out;
}

export function sanitizeSwarmModelSettings(raw: unknown): SwarmModelSettings {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return { roleModels: {} };
  }
  const obj = raw as Record<string, unknown>;
  const defaultWorkerModel = sanitizeRoleModelConfig(obj.defaultWorkerModel);
  const roleModels = sanitizeRoleModelsMap(obj.roleModels);
  return {
    ...(defaultWorkerModel === undefined ? {} : { defaultWorkerModel }),
    roleModels,
  };
}

export function cloneRoleModelsMap(
  map: Partial<Record<SwarmMemberRole, SwarmRoleModelConfig>> | undefined,
): Partial<Record<SwarmMemberRole, SwarmRoleModelConfig>> | undefined {
  if (map === undefined) return undefined;
  const out: Partial<Record<SwarmMemberRole, SwarmRoleModelConfig>> = {};
  for (const role of SWARM_MEMBER_ROLES) {
    const entry = map[role];
    if (entry !== undefined) out[role] = { ...entry };
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

export function cloneSwarmModelSettings(settings: SwarmModelSettings): SwarmModelSettings {
  const roleModels = cloneRoleModelsMap(settings.roleModels) ?? {};
  return {
    ...(settings.defaultWorkerModel != null
      ? { defaultWorkerModel: { ...settings.defaultWorkerModel } }
      : {}),
    roleModels,
  };
}

export function loadSwarmGlobalConfig(dataDir: string | undefined): SwarmModelSettings {
  if (dataDir === undefined || dataDir.trim() === "") return { roleModels: {} };
  const filePath = swarmGlobalConfigPath(dataDir);
  if (!existsSync(filePath)) return { roleModels: {} };
  try {
    return sanitizeSwarmModelSettings(JSON.parse(readFileSync(filePath, "utf8")));
  } catch {
    return { roleModels: {} };
  }
}

export function saveSwarmGlobalConfig(
  dataDir: string | undefined,
  settings: SwarmModelSettings,
): void {
  if (dataDir === undefined || dataDir.trim() === "") return;
  try {
    const filePath = swarmGlobalConfigPath(dataDir);
    mkdirSync(dirname(filePath), { recursive: true });
    configTmpSeq += 1;
    const tmpPath = `${filePath}.tmp-${process.pid}-${configTmpSeq}`;
    writeFileSync(tmpPath, JSON.stringify(settings, null, 2), "utf8");
    renameSync(tmpPath, filePath);
  } catch {
    // Best-effort atomic write so transient filesystem contention never crashes a run.
  }
}

function readConfiguredProviderModels(dataDir: string | undefined): Map<string, ModelInfo[]> {
  const map = new Map<string, ModelInfo[]>();
  if (dataDir === undefined || dataDir.trim() === "") return map;
  const providersFile = join(dataDir, "providers.json");
  if (!existsSync(providersFile)) return map;
  try {
    const parsed = JSON.parse(readFileSync(providersFile, "utf8")) as {
      providers?: Array<{ id?: unknown; models?: unknown }>;
    };
    if (!Array.isArray(parsed?.providers)) return map;
    for (const entry of parsed.providers) {
      if (typeof entry?.id !== "string" || !Array.isArray(entry.models) || entry.models.length === 0) {
        continue;
      }
      const valid = (entry.models as unknown[]).filter(
        (m): m is ModelInfo =>
          typeof m === "object" && m !== null && typeof (m as { id?: unknown }).id === "string",
      );
      if (valid.length > 0) map.set(entry.id, valid);
    }
  } catch {
    // Ignore unreadable providers.json and fall back to ctx.llm.listModels().
  }
  return map;
}

export async function listAvailableSwarmModels(
  ctx: Context,
  dataDir?: string,
): Promise<SwarmAvailableModelInfo[]> {
  const llm = ctx.get("llm");
  const providers = llm?.listProviders() ?? [];
  if (llm === undefined || providers.length === 0) return [];

  const configuredByProvider = readConfiguredProviderModels(dataDir);
  const perProvider = await Promise.all(
    providers.map(async (provider) => {
      const explicit = configuredByProvider.get(provider.id);
      const models = explicit !== undefined
        ? explicit
        : await llm.listModels(provider.id, AbortSignal.timeout(4_000)).catch(() => []);
      return models.map((m): SwarmAvailableModelInfo => ({
        provider: provider.id,
        providerName: provider.name.trim() !== "" ? provider.name : provider.id,
        id: m.id,
        name: m.name !== undefined && m.name.trim() !== "" ? m.name.trim() : m.id,
        reasoning: m.reasoning === true,
      }));
    }),
  );
  return perProvider.flat();
}

export function resolveCoordinatorRoleModel(
  runRoleModels: Partial<Record<SwarmMemberRole, SwarmRoleModelConfig>> | undefined,
  globalConfig: SwarmModelSettings,
): SwarmRoleModelConfig | undefined {
  return runRoleModels?.coordinator ?? globalConfig.roleModels.coordinator;
}

export function resolveWorkerRoleModel(params: {
  role: SwarmMemberRole;
  explicitModel?: string;
  explicitProvider?: string;
  explicitEffort?: string;
  runRoleModels?: Partial<Record<SwarmMemberRole, SwarmRoleModelConfig>>;
  globalConfig: SwarmModelSettings;
  coordinatorFallback: { provider: string; model: string };
}): { provider: string; model: string; effort?: string } {
  if (params.explicitModel !== undefined && params.explicitModel.trim() !== "") {
    const parsed = parseModelSpec(params.explicitModel, params.explicitProvider, params.coordinatorFallback);
    const effort = params.explicitEffort !== undefined && params.explicitEffort.trim() !== ""
      ? params.explicitEffort.trim()
      : undefined;
    return {
      provider: parsed.provider,
      model: parsed.model,
      ...(effort === undefined ? {} : { effort }),
    };
  }

  const configured =
    params.runRoleModels?.[params.role]
    ?? params.globalConfig.roleModels[params.role]
    ?? (params.role !== "coordinator" ? (params.globalConfig.defaultWorkerModel ?? undefined) : undefined);

  if (configured !== undefined) {
    return {
      provider: configured.provider,
      model: configured.model,
      ...(configured.effort === undefined ? {} : { effort: configured.effort }),
    };
  }

  return {
    provider: params.coordinatorFallback.provider,
    model: params.coordinatorFallback.model,
  };
}

export function applyRoleModelToSessionAndInfo(
  ctx: Context,
  session: Session | undefined,
  info: SwarmMemberInfo,
  roleCfg: SwarmRoleModelConfig,
): boolean {
  if (session !== undefined && ctx.agents.status(session.id).running) {
    return false;
  }
  if (session !== undefined) {
    const curState = session.state();
    if (curState.model?.provider !== roleCfg.provider || curState.model?.model !== roleCfg.model) {
      session.setModel({ provider: roleCfg.provider, model: roleCfg.model });
    }
    if (roleCfg.effort !== undefined && curState.effort !== roleCfg.effort) {
      session.setEffort(roleCfg.effort);
    }
  }
  info.provider = roleCfg.provider;
  info.model = roleCfg.model;
  if (roleCfg.effort !== undefined) {
    info.effort = roleCfg.effort;
  } else {
    delete info.effort;
  }
  return true;
}

export async function applyRoleModelsToWaitingMembers(
  ctx: Context,
  swarm: ManagedSwarm,
  globalConfig: SwarmModelSettings,
): Promise<boolean> {
  let mutated = false;
  for (const member of swarm.members.values()) {
    if (member.info.killed) continue;
    if (member.info.state !== "waiting" && member.info.state !== "stopped") continue;
    if (member.info.sessionId !== "" && ctx.agents.status(member.info.sessionId).running) continue;

    const roleCfg = member.info.role === "coordinator"
      ? resolveCoordinatorRoleModel(swarm.run.roleModels, globalConfig)
      : (
          swarm.run.roleModels?.[member.info.role]
          ?? globalConfig.roleModels[member.info.role]
          ?? (globalConfig.defaultWorkerModel ?? undefined)
        );
    if (roleCfg === undefined) continue;

    const session = member.bound?.session
      ?? (member.info.sessionId !== "" ? await ctx.sessions.get(member.info.sessionId) : undefined);
    if (applyRoleModelToSessionAndInfo(ctx, session, member.info, roleCfg)) {
      ctx.emit("swarm/memberDelta", { swarmId: swarm.run.id, member: { ...member.info } });
      mutated = true;
    }
  }
  return mutated;
}

export async function executeGetSwarmConfig(
  ctx: Context,
  dataDir: string | undefined,
  globalConfig: SwarmModelSettings,
  swarms: ReadonlyMap<string, ManagedSwarm>,
  params: SwarmConfigGetParams = {},
): Promise<SwarmConfigGetResult> {
  const swarmId = params.swarmId?.trim() ?? "";
  const swarm = swarmId !== "" ? swarms.get(swarmId) : undefined;
  const sessionOverrides = cloneRoleModelsMap(swarm?.run.roleModels);
  const availableModels = await listAvailableSwarmModels(ctx, dataDir);
  return {
    globalConfig: cloneSwarmModelSettings(globalConfig),
    ...(sessionOverrides === undefined ? {} : { sessionOverrides }),
    availableModels,
  };
}

export async function executeUpdateSwarmConfig(deps: {
  ctx: Context;
  dataDir: string | undefined;
  getGlobalConfig: () => SwarmModelSettings;
  setGlobalConfig: (next: SwarmModelSettings) => void;
  requireSwarm: (swarmId: string) => ManagedSwarm;
  persistAndNotify: (swarm: ManagedSwarm, now?: number) => SwarmSnapshotResult;
  params: SwarmConfigUpdateParams;
}): Promise<SwarmConfigUpdateResult> {
  const { ctx, dataDir, params } = deps;
  if (params.globalConfig !== undefined) {
    const nextGlobal = sanitizeSwarmModelSettings(params.globalConfig);
    deps.setGlobalConfig(nextGlobal);
    saveSwarmGlobalConfig(dataDir, nextGlobal);
  }

  const currentGlobal = deps.getGlobalConfig();
  const swarmId = params.swarmId?.trim() ?? "";
  let targetSwarm: ManagedSwarm | undefined;
  let snapshot: SwarmSnapshotResult | undefined;

  if (swarmId !== "") {
    targetSwarm = deps.requireSwarm(swarmId);
    if (params.sessionOverrides !== undefined) {
      const cleaned = sanitizeRoleModelsMap(params.sessionOverrides);
      if (Object.keys(cleaned).length > 0) {
        targetSwarm.run.roleModels = cleaned;
      } else {
        delete targetSwarm.run.roleModels;
      }
    }
    if (params.applyToWaitingMembers === true) {
      await applyRoleModelsToWaitingMembers(ctx, targetSwarm, currentGlobal);
    }
    snapshot = deps.persistAndNotify(targetSwarm);
  }

  const globalSnapshot = cloneSwarmModelSettings(currentGlobal);
  const sessionOverrides = cloneRoleModelsMap(targetSwarm?.run.roleModels);
  ctx.emit("swarm/configUpdated", {
    globalConfig: globalSnapshot,
    ...(targetSwarm === undefined ? {} : { swarmId: targetSwarm.run.id }),
    ...(sessionOverrides === undefined ? {} : { sessionOverrides }),
  });

  return {
    globalConfig: globalSnapshot,
    ...(sessionOverrides === undefined ? {} : { sessionOverrides }),
    ...(snapshot === undefined ? {} : { snapshot }),
  };
}

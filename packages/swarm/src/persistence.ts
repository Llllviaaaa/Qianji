/**
 * Crash-resilient disk state persistence (`<dataDir>/swarms/<swarmId>/state.json`)
 * and `working -> stopped -> revive` restart hydration (`@qianji/swarm`).
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type {
  SwarmAlertInfo,
  SwarmBoardMessage,
  SwarmMemberInfo,
  SwarmMemberRole,
  SwarmRoleModelConfig,
  SwarmRunInfo,
  SwarmRunStatus,
  SwarmTaskItem,
} from "@qianji/protocol";
import type { PreparedWorktree } from "@qianji/subagents";
import { cloneRoleModelsMap, sanitizeRoleModelsMap } from "./model-config.ts";
import { clonePlanOverview, sanitizePlanOverview } from "./outcomes.ts";

export interface PersistedMemberRecord {
  info: SwarmMemberInfo;
  prepared?: PreparedWorktree;
}

export interface PersistedSwarmManifest {
  version: 1;
  id: string;
  title: string;
  goal: string;
  cwd: string;
  coordinatorSessionId: string;
  status: SwarmRunStatus;
  roleModels?: Partial<Record<SwarmMemberRole, SwarmRoleModelConfig>>;
  createdAt: number;
  updatedAt: number;
}

export interface PersistedSwarmState {
  version: 1;
  run: SwarmRunInfo;
  members: PersistedMemberRecord[];
  tasks: SwarmTaskItem[];
  messages: SwarmBoardMessage[];
  alerts: SwarmAlertInfo[];
}

let stateTmpSeq = 0;

export function swarmStatePath(dataDir: string, swarmId: string): string {
  return join(dataDir, "swarms", swarmId, "state.json");
}

export function swarmManifestPath(dataDir: string, swarmId: string): string {
  return join(dataDir, "swarms", swarmId, "manifest.json");
}

function writeJsonAtomic(filePath: string, payload: unknown): void {
  mkdirSync(dirname(filePath), { recursive: true });
  stateTmpSeq += 1;
  const tmpPath = `${filePath}.tmp-${process.pid}-${stateTmpSeq}`;
  writeFileSync(tmpPath, JSON.stringify(payload, null, 2), "utf8");
  renameSync(tmpPath, filePath);
}

export function savePersistedSwarm(dataDir: string | undefined, state: PersistedSwarmState): void {
  if (dataDir === undefined || dataDir.trim() === "") return;
  try {
    const roleModels = cloneRoleModelsMap(state.run.roleModels);
    const plan = clonePlanOverview(state.run.plan);
    const persistedState: PersistedSwarmState = {
      ...state,
      run: {
        ...state.run,
        ...(roleModels === undefined ? {} : { roleModels }),
        ...(plan === undefined ? {} : { plan }),
      },
    };
    const manifest: PersistedSwarmManifest = {
      version: 1,
      id: state.run.id,
      title: state.run.title,
      goal: state.run.goal,
      cwd: state.run.cwd,
      coordinatorSessionId: state.run.coordinatorSessionId,
      status: state.run.status,
      ...(roleModels === undefined ? {} : { roleModels }),
      createdAt: state.run.createdAt,
      updatedAt: state.run.updatedAt,
    };
    writeJsonAtomic(swarmManifestPath(dataDir, state.run.id), manifest);
    writeJsonAtomic(swarmStatePath(dataDir, state.run.id), persistedState);
  } catch {
    // Persistence is best-effort so transient filesystem contention never crashes a run.
  }
}

export function loadPersistedSwarms(dataDir: string | undefined): PersistedSwarmState[] {
  if (dataDir === undefined || dataDir.trim() === "") return [];
  const swarmsRoot = join(dataDir, "swarms");
  if (!existsSync(swarmsRoot)) return [];

  const loaded: PersistedSwarmState[] = [];
  for (const entry of readdirSync(swarmsRoot, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const filePath = join(swarmsRoot, entry.name, "state.json");
    if (!existsSync(filePath)) continue;
    try {
      const parsed = JSON.parse(readFileSync(filePath, "utf8")) as PersistedSwarmState;
      if (parsed?.version !== 1 || parsed.run?.id === undefined) continue;
      // On Host restart, no worker turn is running in-memory anymore:
      // transition active/parked workers to `stopped` so an `@mention` or `revive` reloads them cleanly.
      const members = parsed.members.map((record): PersistedMemberRecord => {
        const info = { ...record.info, channels: [...record.info.channels], usage: { ...record.info.usage } };
        if (!info.killed && info.role !== "coordinator" && info.state !== "stopped") {
          info.state = "stopped";
          delete info.currentTool;
          delete info.currentStep;
          delete info.parkedSinceSeq;
        } else if (info.role === "coordinator" && info.state === "working") {
          info.state = "waiting";
          delete info.currentTool;
          delete info.currentStep;
        }
        const prepared = record.prepared !== undefined && existsSync(record.prepared.wtRoot)
          ? { ...record.prepared }
          : undefined;
        if (prepared === undefined && info.workspaceMode !== "inherit") {
          delete info.worktreePath;
        }
        return { info, ...(prepared === undefined ? {} : { prepared }) };
      });
      const manifestPath = join(swarmsRoot, entry.name, "manifest.json");
      let manifestRoleModels: Partial<Record<SwarmMemberRole, SwarmRoleModelConfig>> | undefined;
      if (existsSync(manifestPath)) {
        try {
          const manifestParsed = JSON.parse(readFileSync(manifestPath, "utf8")) as PersistedSwarmManifest;
          manifestRoleModels = cloneRoleModelsMap(sanitizeRoleModelsMap(manifestParsed?.roleModels));
        } catch {
          // Fall back to state.json roleModels if manifest.json is unreadable.
        }
      }
      const hydratedRoleModels = manifestRoleModels ?? cloneRoleModelsMap(sanitizeRoleModelsMap(parsed.run.roleModels));
      const hydratedPlan = sanitizePlanOverview(parsed.run.plan);
      const nextRun: SwarmRunInfo = {
        ...parsed.run,
        channels: parsed.run.channels.map((ch) => ({ ...ch, subscriberNames: [...ch.subscriberNames] })),
      };
      if (hydratedRoleModels !== undefined) {
        nextRun.roleModels = hydratedRoleModels;
      } else {
        delete nextRun.roleModels;
      }
      if (hydratedPlan !== undefined) {
        nextRun.plan = hydratedPlan;
      } else {
        delete nextRun.plan;
      }
      loaded.push({
        version: 1,
        run: nextRun,
        members,
        tasks: parsed.tasks.map((t) => ({ ...t, dependsOn: [...t.dependsOn], ownedFiles: [...t.ownedFiles] })),
        messages: parsed.messages.map((m) => ({ ...m, mentions: [...m.mentions], channelMentions: [...m.channelMentions] })),
        alerts: parsed.alerts.map((a) => ({ ...a })),
      });
    } catch {
      // Skip corrupted state file rather than blocking Host startup.
    }
  }
  return loaded.sort((a, b) => a.run.createdAt - b.run.createdAt);
}

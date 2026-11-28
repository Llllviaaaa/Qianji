/**
 * Dynamic Bot workspace & Virtual Server storage resolution and non-destructive
 * migration helpers (`packages/host/src/bot/storage-paths.ts`).
 *
 * Metadata (`state.json`, `SOUL.md`) stays anchored under `<dataDir>/bot/` so
 * Host startup discovery never breaks, while heavy VM assets (`wsl-instance/`,
 * `vm-cache/`, `shared-copies/`, `browser-profile/`) and primary `/workspace`
 * (`botWorkspaceDir`) can move cleanly off the system drive.
 */
import { cpSync, existsSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";
import type { Session, SessionEvent, Sessions } from "@qianji/session";
import type { PersistedBotState } from "./defaults.ts";

const WORKSPACE_SKIP_DIRS = new Set(["tmp", "cache", ".temp", "node_modules"]);
const RELOCATABLE_STORAGE_SUBDIRS = ["vm-cache", "shared-copies", "browser-profile"] as const;

function normCmp(p: string): string {
  const resolved = resolve(p);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

function isNestedPath(a: string, b: string): boolean {
  const relAB = relative(resolve(a), resolve(b));
  const relBA = relative(resolve(b), resolve(a));
  const insideAB = relAB === "" || (!relAB.startsWith("..") && !isAbsolute(relAB));
  const insideBA = relBA === "" || (!relBA.startsWith("..") && !isAbsolute(relBA));
  return insideAB || insideBA;
}

function copyMissingTree(srcDir: string, dstDir: string, skipDirs: ReadonlySet<string>): void {
  if (!existsSync(srcDir)) return;
  mkdirSync(dstDir, { recursive: true });
  let entries;
  try {
    entries = readdirSync(srcDir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (entry.isDirectory() && skipDirs.has(entry.name)) continue;
    const src = join(srcDir, entry.name);
    const dst = join(dstDir, entry.name);
    if (entry.isDirectory()) {
      copyMissingTree(src, dst, skipDirs);
    } else if (entry.isFile() && !existsSync(dst)) {
      cpSync(src, dst, { force: false, errorOnExist: false });
    }
  }
}

export function resolveBotStorageDir(dataDir: string, customStorageDir?: string): string {
  const trimmed = customStorageDir?.trim() ?? "";
  return trimmed !== "" ? resolve(trimmed) : join(dataDir, "bot");
}

export function resolveBotWorkspaceDir(
  dataDir: string,
  customWorkspaceDir?: string,
  customStorageDir?: string,
): string {
  const trimmedWs = customWorkspaceDir?.trim() ?? "";
  if (trimmedWs !== "") return resolve(trimmedWs);
  const trimmedStorage = customStorageDir?.trim() ?? "";
  if (trimmedStorage !== "") return join(resolve(trimmedStorage), "workspace");
  return join(dataDir, "bot-workspace");
}

export function migrateWorkspaceArtifacts(prevDir: string, nextDir: string): void {
  mkdirSync(nextDir, { recursive: true });
  if (normCmp(prevDir) === normCmp(nextDir) || !existsSync(prevDir) || isNestedPath(prevDir, nextDir)) {
    return;
  }
  copyMissingTree(prevDir, nextDir, WORKSPACE_SKIP_DIRS);
}

/**
 * Moves only VM/browser subdirectories (`vm-cache`, `shared-copies`, `browser-profile`)
 * from `prevStorageDir` to `nextStorageDir`. Never removes `prevStorageDir` wholesale
 * because `<dataDir>/bot/` also holds `state.json` and `SOUL.md`.
 */
export function migrateStorageSubdirs(prevStorageDir: string, nextStorageDir: string): void {
  mkdirSync(nextStorageDir, { recursive: true });
  if (normCmp(prevStorageDir) === normCmp(nextStorageDir)) return;
  for (const sub of RELOCATABLE_STORAGE_SUBDIRS) {
    const src = join(prevStorageDir, sub);
    const dst = join(nextStorageDir, sub);
    if (!existsSync(src)) continue;
    if (!isNestedPath(src, dst)) {
      copyMissingTree(src, dst, new Set());
      rmSync(src, { recursive: true, force: true });
    }
  }
}

function cloneEventsWithSeq(events: readonly SessionEvent[]): SessionEvent[] {
  return events.map((ev, idx) => ({ ...ev, seq: idx + 1 }) as SessionEvent);
}

export async function relocateBotSessions(params: {
  sessions: Sessions;
  st: PersistedBotState;
  prevWorkspaceDir: string;
  nextWorkspaceDir: string;
  botSessionIds: Set<string>;
  resolveModel: () => { provider: string; model: string } | undefined;
  ensureFullAccess: (session: Session) => void;
}): Promise<boolean> {
  const { sessions, st, prevWorkspaceDir, nextWorkspaceDir, botSessionIds, resolveModel, ensureFullAccess } = params;
  let mutated = false;

  const migrateSession = async (sessionId: string): Promise<Session | undefined> => {
    const existing = await sessions.get(sessionId).catch(() => undefined);
    if (!existing) return undefined;
    if (normCmp(existing.header.cwd) === normCmp(nextWorkspaceDir)) return existing;
    const clonedEvents = cloneEventsWithSeq(existing.events);
    const nextSess = sessions.create({
      cwd: nextWorkspaceDir,
      side: true,
      events: clonedEvents,
    });
    ensureFullAccess(nextSess);
    if (nextSess.state().model === undefined) {
      const chosen = resolveModel();
      if (chosen?.provider && chosen?.model) {
        nextSess.setModel({ provider: chosen.provider, model: chosen.model });
      }
    }
    botSessionIds.add(nextSess.id);
    botSessionIds.delete(existing.id);
    await sessions.delete(existing.id).catch(() => false);
    mutated = true;
    return nextSess;
  };

  const nextMain = await migrateSession(st.mainSessionId);
  if (nextMain && nextMain.id !== st.mainSessionId) {
    st.mainSessionId = nextMain.id;
  }

  for (const side of st.sideThreads) {
    const nextSide = await migrateSession(side.sessionId);
    if (nextSide && nextSide.id !== side.sessionId) {
      side.sessionId = nextSide.id;
      side.sessionFile = `harness:${nextSide.id}`;
    }
  }

  const prevNorm = normCmp(prevWorkspaceDir);
  for (const sp of st.spaces) {
    if (sp.handoff && (!sp.handoff.targetCwd || normCmp(sp.handoff.targetCwd) === prevNorm)) {
      sp.handoff.targetCwd = nextWorkspaceDir;
      mutated = true;
    }
  }
  for (const goal of st.goals) {
    if (goal.handoff && (!goal.handoff.targetCwd || normCmp(goal.handoff.targetCwd) === prevNorm)) {
      goal.handoff.targetCwd = nextWorkspaceDir;
      mutated = true;
    }
  }

  return mutated;
}

export async function syncBotRuntimePaths(params: {
  sessions: Sessions;
  st: PersistedBotState;
  prevWorkspaceDir: string;
  nextWorkspaceDir: string;
  prevStorageDir: string;
  nextStorageDir: string;
  migrateFiles: boolean;
  botSessionIds: Set<string>;
  resolveModel: () => { provider: string; model: string } | undefined;
  ensureFullAccess: (session: Session) => void;
  relocateStorage: (nextStorageDir: string, nextWorkspaceDir: string) => Promise<void>;
  setWslPaths: (next: { storageDir: string; botWorkspaceDir: string }) => void;
  setLiveViewPaths: (next: { storageDir: string; botWorkspaceDir: string }) => Promise<void>;
}): Promise<void> {
  const {
    sessions,
    st,
    prevWorkspaceDir,
    nextWorkspaceDir,
    prevStorageDir,
    nextStorageDir,
    migrateFiles,
    botSessionIds,
    resolveModel,
    ensureFullAccess,
    relocateStorage,
    setWslPaths,
    setLiveViewPaths,
  } = params;
  mkdirSync(nextWorkspaceDir, { recursive: true });
  mkdirSync(nextStorageDir, { recursive: true });
  if (migrateFiles && prevWorkspaceDir !== nextWorkspaceDir) {
    migrateWorkspaceArtifacts(prevWorkspaceDir, nextWorkspaceDir);
  }
  if (migrateFiles && prevStorageDir !== nextStorageDir) {
    await relocateStorage(nextStorageDir, nextWorkspaceDir);
  } else {
    setWslPaths({ storageDir: nextStorageDir, botWorkspaceDir: nextWorkspaceDir });
  }
  await setLiveViewPaths({ storageDir: nextStorageDir, botWorkspaceDir: nextWorkspaceDir });
  await relocateBotSessions({
    sessions,
    st,
    prevWorkspaceDir,
    nextWorkspaceDir,
    botSessionIds,
    resolveModel,
    ensureFullAccess,
  });
}

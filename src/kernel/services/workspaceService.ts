/**
 * Frontend Cordis `workspaceService` (ADR 0023 Phase 2).
 *
 * Wraps active workspace directory, project options, Git snapshot/restore,
 * workspace trust status, directory/file IO, and external opener actions.
 */
import { Context, Service } from "@deepseek-ai/cordis";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { openUrl } from "@tauri-apps/plugin-opener";
import type {
  WorkspaceTrustChangedNotification,
  WorkspaceTrustEntry,
  WorkspaceTrustListResult,
} from "@qianji/protocol";
import { agent } from "../../lib/agent";
import { harnessRuntimes } from "../../lib/harnessRuntime";
import { normalizeLocalPath, sameLocalPath } from "../../lib/pathIdentity";
import { pluginClient } from "../../lib/pluginClient";
import { useAppStore } from "../../store";
import type {
  GitSnapshot,
  ProjectConfig,
  WorkspaceDirEntry,
  WorkspaceFileContent,
} from "../../types";
import {
  isTauriEnvironment,
  ServiceEmitter,
  shallowEqualArray,
  shallowEqualObject,
  trackContextEffect,
} from "./shared";

declare module "@deepseek-ai/cordis" {
  interface Context {
    workspaceService: WorkspaceService;
  }
}

const LAST_WORKSPACE_KEY = "qianji:last-workspace";

export interface WorkspaceTrustStatus {
  readonly workspace: string;
  readonly trusted: boolean;
  readonly hasProjectPlugins: boolean;
  readonly hasProjectConfig: boolean;
  readonly pluginIds: readonly string[];
  readonly trustedList: readonly WorkspaceTrustEntry[];
}

export interface WorkspaceServiceSnapshot {
  readonly cwd: string;
  readonly draftWorkspace: string;
  readonly workspaceOptions: readonly string[];
  readonly projects: readonly ProjectConfig[];
  readonly git: GitSnapshot | null;
  readonly trust: WorkspaceTrustStatus;
  readonly connected: boolean;
  readonly hostConnected: boolean;
}

function readStoredWorkspace(): string {
  try {
    return typeof window !== "undefined" ? window.localStorage.getItem(LAST_WORKSPACE_KEY) ?? "" : "";
  } catch {
    return "";
  }
}

function writeStoredWorkspace(workspace: string): void {
  try {
    if (typeof window !== "undefined") {
      window.localStorage.setItem(LAST_WORKSPACE_KEY, workspace);
    }
  } catch {
    // Ignore storage write errors in restricted webviews.
  }
}

function dedupeWorkspaces(paths: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of paths) {
    const trimmed = raw.trim();
    if (trimmed === "") continue;
    const key = normalizeLocalPath(trimmed);
    if (key === "" || seen.has(key)) continue;
    seen.add(key);
    out.push(trimmed);
  }
  return out;
}

function defaultTrustStatus(workspace: string, trustedList: readonly WorkspaceTrustEntry[] = []): WorkspaceTrustStatus {
  const trusted = workspace !== "" && trustedList.some((entry) => sameLocalPath(entry.path, workspace));
  return {
    workspace,
    trusted,
    hasProjectPlugins: false,
    hasProjectConfig: false,
    pluginIds: [],
    trustedList,
  };
}

function trustFromListResult(
  workspace: string,
  result: WorkspaceTrustListResult,
): { readonly status: WorkspaceTrustStatus; readonly canonicalWorkspace: string } {
  const current = result.current;
  if (current !== undefined) {
    return {
      status: {
        // Keep the caller's workspace string so snapshot lookup stays aligned even when
        // Host canonicalizes symlinks or Windows 8.3 short paths (`RUNNER~1` -> `runneradmin`).
        workspace: workspace !== "" ? workspace : current.workspace,
        trusted: current.trusted,
        hasProjectPlugins: current.hasProjectPlugins,
        hasProjectConfig: current.hasProjectConfig,
        pluginIds: [...current.pluginIds],
        trustedList: [...result.trusted],
      },
      canonicalWorkspace: current.workspace,
    };
  }
  return {
    status: defaultTrustStatus(workspace, result.trusted),
    canonicalWorkspace: workspace,
  };
}

interface WorkspaceInternalState {
  draftWorkspace: string;
  projects: readonly ProjectConfig[];
  overrideGit: { cwd: string; snapshot: GitSnapshot | null } | null;
  trust: WorkspaceTrustStatus;
  trustCanonicalWorkspace: string;
  trustSeq: number;
  snapshot: WorkspaceServiceSnapshot;
  readonly emitter: ServiceEmitter;
}

export class WorkspaceService extends Service {
  static provide = "workspaceService";
  private readonly internal: WorkspaceInternalState;

  constructor(ctx: Context) {
    super(ctx, "workspaceService");
    const initialDraft = readStoredWorkspace();
    const initialCwd = useAppStore.getState().cwd || initialDraft;
    this.internal = {
      draftWorkspace: initialDraft,
      projects: [],
      overrideGit: null,
      trust: defaultTrustStatus(initialCwd),
      trustCanonicalWorkspace: initialCwd,
      trustSeq: 0,
      snapshot: null as unknown as WorkspaceServiceSnapshot,
      emitter: new ServiceEmitter("workspaceService"),
    };
    this.internal.snapshot = this.computeSnapshot();

    const syncSnapshot = () => {
      const next = this.computeSnapshot();
      const prev = this.internal.snapshot;
      const unchanged =
        prev.cwd === next.cwd
        && prev.draftWorkspace === next.draftWorkspace
        && prev.git === next.git
        && prev.connected === next.connected
        && prev.hostConnected === next.hostConnected
        && prev.projects === next.projects
        && shallowEqualArray(prev.workspaceOptions, next.workspaceOptions)
        && shallowEqualObject(prev.trust, next.trust);
      if (!unchanged) {
        this.internal.snapshot = next;
        this.internal.emitter.emit();
      }
    };

    const offStore = useAppStore.subscribe(() => {
      const storeCwd = useAppStore.getState().cwd;
      if (
        storeCwd
        && !sameLocalPath(this.internal.trust.workspace, storeCwd)
        && !sameLocalPath(this.internal.trustCanonicalWorkspace, storeCwd)
      ) {
        this.internal.trust = defaultTrustStatus(storeCwd, this.internal.trust.trustedList);
        this.internal.trustCanonicalWorkspace = storeCwd;
      }
      syncSnapshot();
    });

    const offTrust = harnessRuntimes.onNotification(
      "workspace/trustChanged",
      (rawParams) => {
        const payload = rawParams as WorkspaceTrustChangedNotification | undefined;
        if (!payload || typeof payload !== "object") return;
        const activeCwd = this.effectiveCwd();
        const trustedList = Array.isArray(payload.trustedList) ? payload.trustedList : this.internal.trust.trustedList;
        const matchesActive =
          activeCwd !== ""
          && (sameLocalPath(payload.workspace, activeCwd)
            || sameLocalPath(payload.workspace, this.internal.trustCanonicalWorkspace));
        if (matchesActive) {
          this.internal.trust = {
            ...this.internal.trust,
            workspace: activeCwd,
            trusted: payload.trusted === true,
            trustedList: [...trustedList],
          };
          this.internal.trustCanonicalWorkspace = payload.workspace;
        } else {
          this.internal.trust = defaultTrustStatus(activeCwd, trustedList);
          this.internal.trustCanonicalWorkspace = activeCwd;
        }
        syncSnapshot();
      },
      { eagerConnect: false },
    );

    const offPluginChanged = pluginClient.onChanged(() => {
      void this.refreshTrust().catch(() => undefined);
    });

    const onProjectsChanged = () => {
      void this.refreshProjects();
    };
    if (typeof window !== "undefined" && typeof window.addEventListener === "function") {
      window.addEventListener("qianji:projects-changed", onProjectsChanged);
    }

    ctx.effect(() => () => {
      offStore();
      offTrust();
      offPluginChanged();
      if (typeof window !== "undefined" && typeof window.removeEventListener === "function") {
        window.removeEventListener("qianji:projects-changed", onProjectsChanged);
      }
      this.internal.emitter.clear();
    });
  }

  private effectiveCwd(): string {
    const appCwd = useAppStore.getState().cwd;
    return appCwd || this.internal.draftWorkspace;
  }

  private computeSnapshot(): WorkspaceServiceSnapshot {
    const app = useAppStore.getState();
    const cwd = app.cwd || this.internal.draftWorkspace;
    const options = dedupeWorkspaces([
      this.internal.draftWorkspace,
      app.cwd,
      ...this.internal.projects.filter((project) => !project.hidden).map((project) => project.path),
      ...app.sessions.map((session) => session.cwd),
    ]);
    const git = app.git
      ?? (this.internal.overrideGit !== null && sameLocalPath(this.internal.overrideGit.cwd, cwd)
        ? this.internal.overrideGit.snapshot
        : null);
    const trustMatchesCwd =
      sameLocalPath(this.internal.trust.workspace, cwd)
      || sameLocalPath(this.internal.trustCanonicalWorkspace, cwd);
    const trust = trustMatchesCwd
      ? this.internal.trust
      : defaultTrustStatus(cwd, this.internal.trust.trustedList);

    return {
      cwd,
      draftWorkspace: this.internal.draftWorkspace,
      workspaceOptions: options,
      projects: this.internal.projects,
      git,
      trust,
      connected: app.connection === "running",
      hostConnected: app.hostStatus === "connected",
    };
  }

  private publish(): void {
    const next = this.computeSnapshot();
    const prev = this.internal.snapshot;
    const unchanged =
      prev.cwd === next.cwd
      && prev.draftWorkspace === next.draftWorkspace
      && prev.git === next.git
      && prev.connected === next.connected
      && prev.hostConnected === next.hostConnected
      && prev.projects === next.projects
      && shallowEqualArray(prev.workspaceOptions, next.workspaceOptions)
      && shallowEqualObject(prev.trust, next.trust);
    if (!unchanged) {
      this.internal.snapshot = next;
      this.internal.emitter.emit();
    }
  }

  getSnapshot(): WorkspaceServiceSnapshot {
    return this.internal.snapshot;
  }

  subscribe(listener: () => void): () => void {
    const rawUnsub = this.internal.emitter.add(listener);
    return trackContextEffect(this.ctx, rawUnsub);
  }

  syncDraftWorkspace(workspace: string): void {
    const trimmed = workspace.trim();
    if (trimmed === this.internal.draftWorkspace) return;
    this.internal.draftWorkspace = trimmed;
    if (trimmed !== "") {
      writeStoredWorkspace(trimmed);
    }
    this.publish();
  }

  clearDraftWorkspace(): void {
    if (this.internal.draftWorkspace === "") return;
    this.internal.draftWorkspace = "";
    this.publish();
  }

  selectWorkspace(workspace: string): void {
    const trimmed = workspace.trim();
    if (trimmed === "") return;
    this.internal.draftWorkspace = trimmed;
    writeStoredWorkspace(trimmed);
    if (
      !sameLocalPath(this.internal.trust.workspace, trimmed)
      && !sameLocalPath(this.internal.trustCanonicalWorkspace, trimmed)
    ) {
      this.internal.trust = defaultTrustStatus(trimmed, this.internal.trust.trustedList);
      this.internal.trustCanonicalWorkspace = trimmed;
    }
    this.publish();
    if (isTauriEnvironment()) {
      void agent
        .registerProject(trimmed)
        .then(() => {
          if (typeof window !== "undefined") {
            window.dispatchEvent(new Event("qianji:projects-changed"));
          }
        })
        .catch(() => undefined);
    }
  }

  async pickFolder(): Promise<string | null> {
    if (!isTauriEnvironment()) return null;
    const selected = await openDialog({ directory: true, multiple: false, title: "打开工作区" });
    if (typeof selected !== "string" || selected.trim() === "") return null;
    this.selectWorkspace(selected);
    return selected;
  }

  async refreshProjects(): Promise<readonly ProjectConfig[]> {
    if (!isTauriEnvironment()) return this.internal.projects;
    try {
      const projects = await agent.listProjects();
      // Preserve hidden projects in the catalog so Sidebar can filter out sessions of removed projects.
      this.internal.projects = [...projects];
      this.publish();
    } catch {
      // Keep last known project list when backend is unavailable.
    }
    return this.internal.projects;
  }

  async refreshTrust(workspace?: string): Promise<WorkspaceTrustStatus> {
    const target = (workspace ?? this.effectiveCwd()).trim();
    const seq = ++this.internal.trustSeq;
    const result = await pluginClient.trustList(target || undefined);
    const resolved = trustFromListResult(target, result);
    if (seq === this.internal.trustSeq) {
      this.internal.trust = resolved.status;
      this.internal.trustCanonicalWorkspace = resolved.canonicalWorkspace;
      this.publish();
    }
    return this.internal.trust;
  }

  async setWorkspaceTrust(workspace: string, trusted: boolean): Promise<WorkspaceTrustStatus> {
    const target = workspace.trim();
    const seq = ++this.internal.trustSeq;
    const result = await pluginClient.setTrust({ workspace: target, trusted });
    const resolved = trustFromListResult(target, result);
    if (seq === this.internal.trustSeq) {
      this.internal.trust = resolved.status;
      this.internal.trustCanonicalWorkspace = resolved.canonicalWorkspace;
      this.publish();
    }
    return this.internal.trust;
  }

  async refreshGit(cwd?: string): Promise<GitSnapshot | null> {
    const app = useAppStore.getState();
    const target = (cwd ?? this.effectiveCwd()).trim();
    if (target === "") return null;
    if (app.cwd !== "" && sameLocalPath(app.cwd, target)) {
      await app.refreshGit();
      this.publish();
      return useAppStore.getState().git;
    }
    const snapshot = await agent.gitSnapshot(target);
    this.internal.overrideGit = { cwd: target, snapshot };
    this.publish();
    return snapshot;
  }

  async restoreGitFiles(paths: string[], cwd?: string): Promise<void> {
    const target = (cwd ?? this.effectiveCwd()).trim();
    if (target === "" || paths.length === 0) return;
    await agent.gitRestoreFiles(target, paths);
    await this.refreshGit(target);
  }

  async listDir(path?: string, cwd?: string): Promise<WorkspaceDirEntry[]> {
    const target = (cwd ?? this.effectiveCwd()).trim();
    if (target === "") return [];
    return agent.listWorkspaceDir(target, path);
  }

  async readFile(path: string, cwd?: string): Promise<WorkspaceFileContent> {
    const target = (cwd ?? this.effectiveCwd()).trim();
    return agent.readWorkspaceFile(target, path);
  }

  async writeFile(path: string, content: string, cwd?: string): Promise<void> {
    const target = (cwd ?? this.effectiveCwd()).trim();
    await agent.writeWorkspaceFile(target, path, content);
  }

  async openExternal(target: string): Promise<void> {
    const trimmed = target.trim();
    if (trimmed === "") return;
    const isUrl = /^(?:https?:\/\/|mailto:)/i.test(trimmed);
    if (isUrl) {
      if (isTauriEnvironment()) {
        await openUrl(trimmed);
      } else if (typeof window !== "undefined" && typeof window.open === "function") {
        window.open(trimmed, "_blank", "noopener,noreferrer");
      }
      return;
    }
    await agent.openFileInDefaultApp(trimmed);
  }

  async openInFileManager(path?: string, options?: { reveal?: boolean }): Promise<void> {
    const target = (path ?? this.effectiveCwd()).trim();
    if (target === "") return;
    if (options?.reveal === true) {
      await agent.revealPathInFileManager(target);
      return;
    }
    await agent.openWorkspaceInFileManager(target);
  }

  async stageGitFiles(paths: string[], cwd?: string): Promise<void> {
    const target = (cwd ?? this.effectiveCwd()).trim();
    if (target === "" || paths.length === 0) return;
    await agent.gitStageFiles(target, paths);
    await this.refreshGit(target);
  }

  async unstageGitFiles(paths: string[], cwd?: string): Promise<void> {
    const target = (cwd ?? this.effectiveCwd()).trim();
    if (target === "" || paths.length === 0) return;
    await agent.gitUnstageFiles(target, paths);
    await this.refreshGit(target);
  }

  async createWorktree(cwd?: string, branch?: string): Promise<string> {
    const target = (cwd ?? this.effectiveCwd()).trim();
    const created = await agent.createWorktree(target, branch);
    this.selectWorkspace(created.path);
    return created.path;
  }

  async quickChatDir(): Promise<string> {
    return agent.quickChatDir();
  }

  async saveProject(project: ProjectConfig): Promise<void> {
    await agent.saveProject(project);
    await this.refreshProjects();
  }

  async removeLocalProject(path: string): Promise<void> {
    await agent.removeLocalProject(path);
    await this.refreshProjects();
  }
}

/**
 * Role-tiered workspace isolation (`inherit` | `share` | `branch`), live Git
 * worktree unified diff inspection, baseline-advancing patch merge, and
 * unmerged-work protection before worker `kill` (`@qianji/swarm`).
 */
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  SwarmMemberRole,
  SwarmWorkspaceMode,
  SwarmWorktreeDiffResult,
  SwarmWorktreeMergeSummary,
} from "@qianji/protocol";
import {
  applyOrSaveWorktreePatch,
  cleanupWorktree,
  collectWorktreePatch,
  prepareIsolatedWorktree,
  type CollectedWorktreePatch,
  type PreparedWorktree,
} from "@qianji/subagents";

const MAX_DIFF_PREVIEW_BYTES = 200_000;

export interface MemberWorkspaceHandle {
  workspaceMode: SwarmWorkspaceMode;
  sessionCwd: string;
  prepared?: PreparedWorktree;
  branchName?: string;
  fallbackReason?: string;
}

/**
 * User Decision A2:
 * - Read/coordination roles (`coordinator`, `explorer`, `planner`, `verifier`, `monitor`) -> `"inherit"`
 * - Coding role (`worker`) -> `"share"` (isolated Git worktree, falling back to `"inherit"` in non-Git folders)
 */
export function resolveDefaultWorkspaceMode(role: SwarmMemberRole): SwarmWorkspaceMode {
  return role === "worker" ? "share" : "inherit";
}

function runGitSimple(
  cwd: string,
  args: readonly string[],
  env: NodeJS.ProcessEnv = process.env,
): Promise<{ ok: boolean; stdout: string; stderr: string }> {
  return new Promise((resolvePromise) => {
    const child = spawn("git", args, {
      cwd,
      env,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    let settled = false;
    const finish = (ok: boolean) => {
      if (settled) return;
      settled = true;
      resolvePromise({
        ok,
        stdout: Buffer.concat(out).toString("utf8").trim(),
        stderr: Buffer.concat(err).toString("utf8").trim(),
      });
    };
    child.stdout.on("data", (chunk: Buffer) => out.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => err.push(chunk));
    child.once("error", () => finish(false));
    child.once("close", (code) => finish(code === 0));
  });
}

function isNonGitFallbackError(errorMessage: string): boolean {
  return /Git repository|initial commit \(HEAD\)|not a git repository/i.test(errorMessage);
}

export async function prepareMemberWorkspace(options: {
  cwd: string;
  swarmId: string;
  memberName: string;
  role: SwarmMemberRole;
  requestedMode?: SwarmWorkspaceMode;
  dataDir?: string;
  branchPrefix?: string;
  signal?: AbortSignal;
}): Promise<MemberWorkspaceHandle> {
  const mode = options.requestedMode ?? resolveDefaultWorkspaceMode(options.role);
  if (mode === "inherit") {
    return { workspaceMode: "inherit", sessionCwd: options.cwd };
  }

  const baseDir = options.dataDir !== undefined && options.dataDir.trim() !== ""
    ? options.dataDir
    : join(tmpdir(), "qianji-swarms");
  const targetDir = join(baseDir, "swarms", options.swarmId, "worktrees", options.memberName);

  const prep = await prepareIsolatedWorktree(
    options.cwd,
    `${options.swarmId}-${options.memberName}`,
    options.signal,
    targetDir,
  );
  if (!prep.ok) {
    if (isNonGitFallbackError(prep.error)) {
      return {
        workspaceMode: "inherit",
        sessionCwd: options.cwd,
        fallbackReason: prep.error,
      };
    }
    throw new Error(prep.error);
  }

  if (mode === "branch") {
    const rawPrefix = (options.branchPrefix ?? "").trim().replace(/\/+$/, "");
    const prefixPart = rawPrefix === "" ? "" : `${rawPrefix}/`;
    const branchName = `${prefixPart}swarm/${options.swarmId}/${options.memberName}`;
    const checkout = await runGitSimple(prep.worktree.wtRoot, ["checkout", "-B", branchName]);
    if (!checkout.ok) {
      await cleanupWorktree(prep.worktree.repoRoot, prep.worktree.wtRoot);
      throw new Error(checkout.stderr || `Failed to create swarm branch ${branchName}`);
    }
    return {
      workspaceMode: "branch",
      sessionCwd: prep.worktree.sessionCwd,
      prepared: prep.worktree,
      branchName,
    };
  }

  return {
    workspaceMode: "share",
    sessionCwd: prep.worktree.sessionCwd,
    prepared: prep.worktree,
  };
}

async function advanceWorktreeBaseline(wtRoot: string, prevBaseHead: string): Promise<string> {
  const commitEnv: NodeJS.ProcessEnv = {
    ...process.env,
    GIT_AUTHOR_NAME: "Qianji Swarm",
    GIT_AUTHOR_EMAIL: "swarm@qianji.local",
    GIT_COMMITTER_NAME: "Qianji Swarm",
    GIT_COMMITTER_EMAIL: "swarm@qianji.local",
  };
  await runGitSimple(wtRoot, ["add", "-A"], commitEnv);
  const tree = await runGitSimple(wtRoot, ["write-tree"], commitEnv);
  if (!tree.ok || tree.stdout === "") return prevBaseHead;
  const commit = await runGitSimple(
    wtRoot,
    ["commit-tree", tree.stdout, "-p", prevBaseHead, "-m", "qianji-swarm-merged-baseline"],
    commitEnv,
  );
  if (!commit.ok || commit.stdout === "") return prevBaseHead;
  await runGitSimple(wtRoot, ["update-ref", "HEAD", commit.stdout], commitEnv);
  return commit.stdout;
}

export async function inspectMemberWorktree(options: {
  swarmId: string;
  memberName: string;
  sessionId: string;
  handle: MemberWorkspaceHandle;
}): Promise<{ diff: SwarmWorktreeDiffResult; collected: CollectedWorktreePatch }> {
  const { swarmId, memberName, sessionId, handle } = options;
  if (handle.workspaceMode === "inherit" || handle.prepared === undefined) {
    return {
      diff: {
        swarmId,
        memberName,
        workspaceMode: handle.workspaceMode,
        empty: true,
        changedFiles: [],
        diffText: "",
      },
      collected: { empty: true, changedFiles: [] },
    };
  }

  const collected = await collectWorktreePatch({
    wtRoot: handle.prepared.wtRoot,
    baseHead: handle.prepared.baseHead,
    childId: sessionId,
  });

  let diffText = "";
  if (!collected.empty && collected.patchBuffer !== undefined) {
    if (collected.patchBuffer.length > MAX_DIFF_PREVIEW_BYTES) {
      diffText = `${collected.patchBuffer.subarray(0, MAX_DIFF_PREVIEW_BYTES).toString("utf8")}\n\n... [Diff truncated at ${MAX_DIFF_PREVIEW_BYTES} bytes]`;
    } else {
      diffText = collected.patchBuffer.toString("utf8");
    }
  }

  return {
    diff: {
      swarmId,
      memberName,
      workspaceMode: handle.workspaceMode,
      worktreePath: handle.prepared.wtRoot,
      ...(handle.branchName === undefined ? {} : { branchName: handle.branchName }),
      empty: collected.empty,
      changedFiles: collected.changedFiles,
      diffText,
    },
    collected,
  };
}

export async function mergeMemberWorktree(options: {
  memberName: string;
  sessionId: string;
  handle: MemberWorkspaceHandle;
  applyChanges?: boolean;
}): Promise<SwarmWorktreeMergeSummary> {
  const { memberName, sessionId, handle } = options;
  if (handle.workspaceMode === "inherit" || handle.prepared === undefined) {
    return { changedFiles: [], applied: true };
  }
  const collected = await collectWorktreePatch({
    wtRoot: handle.prepared.wtRoot,
    baseHead: handle.prepared.baseHead,
    childId: sessionId,
  });
  if (collected.empty || collected.patchBuffer === undefined) {
    return { changedFiles: [], applied: true };
  }
  const res = await applyOrSaveWorktreePatch({
    repoRoot: handle.prepared.repoRoot,
    label: memberName,
    childId: sessionId,
    changedFiles: collected.changedFiles,
    patchBuffer: collected.patchBuffer,
    applyChanges: options.applyChanges !== false,
  });
  if (res.applied) {
    handle.prepared.baseHead = await advanceWorktreeBaseline(
      handle.prepared.wtRoot,
      handle.prepared.baseHead,
    );
  }
  return res;
}

export async function cleanupMemberWorkspace(handle: MemberWorkspaceHandle): Promise<void> {
  if (handle.prepared !== undefined) {
    await cleanupWorktree(handle.prepared.repoRoot, handle.prepared.wtRoot);
  }
}

/**
 * Isolated Git Worktree lifecycle and patch extraction/application for
 * parallel `workspace-write` subagents, with dirty working-tree inheritance.
 */
import { spawn } from "node:child_process";
import { copyFileSync, lstatSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";

const MAX_UNTRACKED_FILE_BYTES = 1_048_576;

export interface PreparedWorktree {
  repoRoot: string;
  wtRoot: string;
  baseHead: string;
  sessionCwd: string;
}

export interface CollectedWorktreePatch {
  empty: boolean;
  changedFiles: string[];
  patchBuffer?: Buffer;
}

export interface WorktreePatchResult {
  changedFiles: string[];
  applied: boolean;
  conflict?: boolean;
  patchFile?: string;
  reason?: string;
}

interface GitResult {
  ok: boolean;
  stdout: Buffer;
  stderr: string;
}

function runGit(
  cwd: string,
  args: readonly string[],
  options: { env?: NodeJS.ProcessEnv; input?: Buffer; signal?: AbortSignal } = {},
): Promise<GitResult> {
  return new Promise((resolvePromise) => {
    const child = spawn("git", args, {
      cwd,
      env: options.env ?? process.env,
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
    });
    const outChunks: Buffer[] = [];
    const errChunks: Buffer[] = [];
    let settled = false;
    const finish = (ok: boolean) => {
      if (settled) return;
      settled = true;
      options.signal?.removeEventListener("abort", onAbort);
      resolvePromise({
        ok,
        stdout: Buffer.concat(outChunks),
        stderr: Buffer.concat(errChunks).toString("utf8").trim(),
      });
    };
    const onAbort = () => {
      try { child.kill(); } catch { /* ignore */ }
      finish(false);
    };
    options.signal?.addEventListener("abort", onAbort, { once: true });
    child.stdout.on("data", (chunk: Buffer) => outChunks.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => errChunks.push(chunk));
    child.once("error", () => finish(false));
    child.once("close", (code) => finish(code === 0));
    if (options.input !== undefined) child.stdin.write(options.input);
    child.stdin.end();
  });
}

function sanitizeLabel(label: string): string {
  return label.toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "") || "subagent";
}

function savePatchFile(repoRoot: string, label: string, childId: string, patchBuffer: Buffer): string {
  const dir = join(repoRoot, ".qianji", "subagent-patches");
  mkdirSync(dir, { recursive: true });
  const shortId = childId.replace(/[^a-zA-Z0-9_-]/g, "").slice(-8) || "run";
  const file = join(dir, `${sanitizeLabel(label)}-${shortId}.patch`);
  writeFileSync(file, patchBuffer);
  return file;
}

async function syncDirtyParentState(
  repoRoot: string,
  wtRoot: string,
  headSha: string,
  signal?: AbortSignal,
): Promise<string> {
  let dirty = false;
  const trackedDiff = await runGit(repoRoot, ["diff", "--binary", "HEAD"], { signal });
  if (trackedDiff.ok && trackedDiff.stdout.length > 0) {
    const applied = await runGit(wtRoot, ["apply", "--binary", "--whitespace=nowarn", "-"], {
      input: trackedDiff.stdout,
      signal,
    });
    if (applied.ok) dirty = true;
  }

  const untracked = await runGit(repoRoot, ["ls-files", "-z", "--others", "--exclude-standard"], { signal });
  if (untracked.ok && untracked.stdout.length > 0) {
    const relPaths = untracked.stdout.toString("utf8").split("\0").filter(Boolean);
    for (const relPath of relPaths) {
      const normalized = relPath.replace(/\\/g, "/");
      if (normalized.startsWith(".qianji/subagent-patches/")) continue;
      const src = join(repoRoot, relPath);
      try {
        const stat = lstatSync(src);
        if (!stat.isFile() || stat.size > MAX_UNTRACKED_FILE_BYTES) continue;
        const dest = join(wtRoot, relPath);
        mkdirSync(dirname(dest), { recursive: true });
        copyFileSync(src, dest);
        dirty = true;
      } catch {
        // Ignore transient files deleted concurrently in the parent workspace.
      }
    }
  }

  if (!dirty) return headSha;

  const commitEnv: NodeJS.ProcessEnv = {
    ...process.env,
    GIT_AUTHOR_NAME: "Qianji",
    GIT_AUTHOR_EMAIL: "subagent@qianji.local",
    GIT_COMMITTER_NAME: "Qianji",
    GIT_COMMITTER_EMAIL: "subagent@qianji.local",
  };
  await runGit(wtRoot, ["add", "-A"], { env: commitEnv, signal });
  const tree = await runGit(wtRoot, ["write-tree"], { env: commitEnv, signal });
  const treeSha = tree.stdout.toString("utf8").trim();
  if (!tree.ok || treeSha === "") return headSha;

  const commit = await runGit(wtRoot, ["commit-tree", treeSha, "-p", headSha, "-m", "qianji-worktree-baseline"], {
    env: commitEnv,
    signal,
  });
  const commitSha = commit.stdout.toString("utf8").trim();
  if (!commit.ok || commitSha === "") return treeSha;

  await runGit(wtRoot, ["update-ref", "--no-deref", "HEAD", commitSha], { env: commitEnv, signal });
  return commitSha;
}

export async function prepareIsolatedWorktree(
  cwd: string,
  id: string,
  signal?: AbortSignal,
): Promise<{ ok: true; worktree: PreparedWorktree } | { ok: false; error: string }> {
  const top = await runGit(cwd, ["rev-parse", "--show-toplevel"], { signal });
  if (!top.ok) {
    return { ok: false, error: top.stderr || "Worktree isolation requires a Git repository." };
  }
  const repoRoot = resolve(top.stdout.toString("utf8").trim());
  const head = await runGit(repoRoot, ["rev-parse", "--verify", "HEAD"], { signal });
  if (!head.ok) {
    return { ok: false, error: head.stderr || "Worktree isolation requires an initial commit (HEAD)." };
  }
  const headSha = head.stdout.toString("utf8").trim();
  const relSubdir = relative(repoRoot, resolve(cwd));
  const safeId = sanitizeLabel(id).slice(-12);
  const wtRoot = mkdtempSync(join(tmpdir(), `qianji-subagent-${safeId}-`));
  const added = await runGit(repoRoot, ["worktree", "add", "--detach", wtRoot, headSha], { signal });
  if (!added.ok) {
    rmSync(wtRoot, { recursive: true, force: true });
    return { ok: false, error: added.stderr || "Failed to create temporary Git worktree." };
  }
  const baseHead = await syncDirtyParentState(repoRoot, wtRoot, headSha, signal);
  const sessionCwd = relSubdir === "" || relSubdir === "." || relSubdir.startsWith("..")
    ? wtRoot
    : join(wtRoot, relSubdir);
  return { ok: true, worktree: { repoRoot, wtRoot, baseHead, sessionCwd } };
}

export async function collectWorktreePatch(options: {
  wtRoot: string;
  baseHead: string;
  childId: string;
}): Promise<CollectedWorktreePatch> {
  const safeId = options.childId.replace(/[^a-zA-Z0-9_-]/g, "");
  const tempIndex = join(tmpdir(), `qianji-wt-idx-${safeId}-${Date.now()}`);
  const wtEnv = { ...process.env, GIT_INDEX_FILE: tempIndex };
  try {
    await runGit(options.wtRoot, ["read-tree", options.baseHead], { env: wtEnv });
    await runGit(options.wtRoot, ["add", "-A"], { env: wtEnv });
    const tree = await runGit(options.wtRoot, ["write-tree"], { env: wtEnv });
    if (!tree.ok) return { empty: true, changedFiles: [] };
    const treeSha = tree.stdout.toString("utf8").trim();
    if (treeSha === "") return { empty: true, changedFiles: [] };
    const names = await runGit(options.wtRoot, ["diff", "--name-only", options.baseHead, treeSha]);
    const changedFiles = names.stdout
      .toString("utf8")
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean);
    if (changedFiles.length === 0) return { empty: true, changedFiles: [] };
    const diff = await runGit(options.wtRoot, ["diff", "--binary", options.baseHead, treeSha]);
    if (!diff.ok || diff.stdout.length === 0) return { empty: true, changedFiles: [] };
    return { empty: false, changedFiles, patchBuffer: diff.stdout };
  } finally {
    rmSync(tempIndex, { force: true });
  }
}

export async function applyOrSaveWorktreePatch(options: {
  repoRoot: string;
  label: string;
  childId: string;
  changedFiles: string[];
  patchBuffer: Buffer;
  applyChanges: boolean;
}): Promise<WorktreePatchResult> {
  const { repoRoot, label, childId, changedFiles, patchBuffer, applyChanges } = options;
  if (!applyChanges) {
    const patchFile = savePatchFile(repoRoot, label, childId, patchBuffer);
    return { changedFiles, applied: false, patchFile };
  }
  const check = await runGit(repoRoot, ["apply", "--check", "--binary", "--whitespace=nowarn", "-"], { input: patchBuffer });
  if (!check.ok) {
    const patchFile = savePatchFile(repoRoot, label, childId, patchBuffer);
    return {
      changedFiles,
      applied: false,
      conflict: true,
      patchFile,
      reason: check.stderr || "Patch check conflicted with current workspace state.",
    };
  }
  const applied = await runGit(repoRoot, ["apply", "--binary", "--whitespace=nowarn", "-"], { input: patchBuffer });
  if (!applied.ok) {
    const patchFile = savePatchFile(repoRoot, label, childId, patchBuffer);
    return {
      changedFiles,
      applied: false,
      conflict: true,
      patchFile,
      reason: applied.stderr || "git apply failed.",
    };
  }
  return { changedFiles, applied: true };
}

export async function cleanupWorktree(repoRoot: string, wtRoot: string): Promise<void> {
  await runGit(repoRoot, ["worktree", "remove", "--force", wtRoot]);
  await runGit(repoRoot, ["worktree", "prune"]);
  rmSync(wtRoot, { recursive: true, force: true });
}

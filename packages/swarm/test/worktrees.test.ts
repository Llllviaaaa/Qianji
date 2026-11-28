import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Context } from "@deepseek-ai/cordis";
import { AgentLoop } from "@qianji/agent-loop";
import { Commands } from "@qianji/commands";
import { Credentials, LlmService } from "@qianji/llm";
import { Sessions } from "@qianji/session";
import { SystemPrompt } from "@qianji/system-prompt";
import { ScriptedProvider, textReply, toolReply, useScriptedProvider } from "@qianji/testkit";
import { textOutput, Tools } from "@qianji/tools";
import { Ui } from "@qianji/ui";
import { afterEach, describe, expect, it } from "vitest";
import { SwarmService } from "../src/index.ts";

function initTempGitRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "qj-swarm-git-"));
  const env = {
    ...process.env,
    GIT_AUTHOR_NAME: "Test",
    GIT_AUTHOR_EMAIL: "test@qianji.local",
    GIT_COMMITTER_NAME: "Test",
    GIT_COMMITTER_EMAIL: "test@qianji.local",
  };
  execFileSync("git", ["init"], { cwd: dir, env, stdio: "ignore" });
  writeFileSync(join(dir, "feature.ts"), "export const base = 1;\n", "utf8");
  execFileSync("git", ["add", "-A"], { cwd: dir, env, stdio: "ignore" });
  execFileSync("git", ["commit", "-m", "initial"], { cwd: dir, env, stdio: "ignore" });
  return dir;
}

describe("Role-tiered workspace isolation, live diff, unmerged kill protection, and merge", () => {
  const tempDirs: string[] = [];
  afterEach(() => {
    for (const dir of tempDirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("defaults explorer/verifier to inherit, worker to share worktree in Git repos, supports branch mode, and falls back to inherit in non-Git folders", async () => {
    const repoDir = initTempGitRepo();
    const nonGitDir = mkdtempSync(join(tmpdir(), "qj-swarm-plain-"));
    const dataDir = mkdtempSync(join(tmpdir(), "qj-swarm-data-"));
    tempDirs.push(repoDir, nonGitDir, dataDir);

    const ctx = new Context();
    await ctx.plugin(Credentials);
    await ctx.plugin(LlmService, { maxAttempts: 1 });
    await ctx.plugin(Sessions);
    await ctx.plugin(Ui);
    await ctx.plugin(Tools);
    await ctx.plugin(Commands);
    await ctx.plugin(SystemPrompt);
    await ctx.plugin(AgentLoop);

    // Register minimal tools so our scripted worker/verifier can exercise role allowlists & confinement
    for (const name of ["read", "grep", "find", "ls", "bash", "diagnostics"]) {
      ctx.tools.register({
        name,
        description: name,
        parameters: { type: "object" },
        execute: () => textOutput(`${name} ok`),
      });
    }
    ctx.tools.register({
      name: "write",
      description: "Write file in session cwd",
      parameters: {
        type: "object",
        properties: { path: { type: "string" }, content: { type: "string" } },
        required: ["path", "content"],
      },
      execute(args, env) {
        const target = join(env.cwd, String(args.path));
        writeFileSync(target, String(args.content), "utf8");
        return textOutput(`Wrote ${target}`);
      },
    });

    const provider = new ScriptedProvider();
    useScriptedProvider(ctx, provider, "anthropic");
    await ctx.plugin(SwarmService, { dataDir, branchPrefix: "feat", watchdogIntervalMs: 60_000 });

    try {
      // 1) Non-Git directory gracefully falls back to `inherit` for `worker`
      provider.push(textReply("Done in plain folder."));
      const plainSwarm = await ctx.swarm.createSwarm({ goal: "Plain folder work", cwd: nonGitDir });
      const [plainWorker] = await ctx.swarm.addMember({
        swarmId: plainSwarm.run.id,
        name: "plain-worker",
        role: "worker",
        brief: "Work without git",
      });
      expect(plainWorker?.workspaceMode).toBe("inherit");
      await ctx.agents.idle(plainWorker?.sessionId ?? "");

      // 2) Git repository: `verifier` defaults to `inherit` (with shell verification allowed), `worker` defaults to `share`
      const gitSwarm = await ctx.swarm.createSwarm({ goal: "Implement feature in git", cwd: repoDir });
      const swarmId = gitSwarm.run.id;

      provider.push(textReply("Verifier ready."));
      const [verifier] = await ctx.swarm.addMember({
        swarmId,
        name: "gate-verifier",
        role: "verifier",
        brief: "Verify feature",
      });
      expect(verifier?.workspaceMode).toBe("inherit");
      expect(ctx.tools.allows(verifier?.sessionId, "bash")).toBe(true);
      expect(ctx.tools.allows(verifier?.sessionId, "write")).toBe(false);
      await ctx.agents.idle(verifier?.sessionId ?? "");

      // 3) Branch mode creates named branch `feat/swarm/<swarmId>/branch-dev`
      provider.push(textReply("Branch worker ready."));
      const [branchDev] = await ctx.swarm.addMember({
        swarmId,
        name: "branch-dev",
        role: "worker",
        workspaceMode: "branch",
        brief: "Prepare branch",
      });
      expect(branchDev?.workspaceMode).toBe("branch");
      expect(branchDev?.branchName).toBe(`feat/swarm/${swarmId}/branch-dev`);
      await ctx.agents.idle(branchDev?.sessionId ?? "");
      await ctx.swarm.controlMember({ swarmId, name: "branch-dev", action: "kill" });

      // 4) Default `share` worker writes `feature.ts` inside isolated worktree (and escape outside is blocked!)
      provider.push(
        toolReply([
          { id: "c1", name: "write", args: { path: "feature.ts", content: "export const base = 1;\nexport const added = 42;\n" } },
          { id: "c2", name: "write", args: { path: "../../escape.txt", content: "blocked" } },
        ]),
        textReply("Edited feature.ts inside isolated worktree."),
      );

      const [author] = await ctx.swarm.addMember({
        swarmId,
        name: "author",
        role: "worker",
        brief: "Add export to feature.ts",
      });
      expect(author?.workspaceMode).toBe("share");
      const expectedWtPath = join(dataDir, "swarms", swarmId, "worktrees", "author");
      expect(author?.worktreePath).toBe(expectedWtPath);
      expect(existsSync(expectedWtPath)).toBe(true);
      await ctx.agents.idle(author?.sessionId ?? "");

      // Main repo `feature.ts` is still untouched while worktree has the edit!
      expect(readFileSync(join(repoDir, "feature.ts"), "utf8")).toBe("export const base = 1;\n");

      // Escape write outside worktree was denied by confinement guard
      const authorSession = await ctx.sessions.get(author?.sessionId ?? "");
      const escapeResult = authorSession?.events.find(
        (ev) => ev.type === "tool-result" && ev.data.callId === "c2",
      );
      expect(escapeResult?.type === "tool-result" && escapeResult.data.isError).toBe(true);

      // Live worktree diff shows `feature.ts` and `+export const added = 42;`
      const diff = await ctx.swarm.getWorktreeDiff(swarmId, "author");
      expect(diff.empty).toBe(false);
      expect(diff.changedFiles).toEqual(["feature.ts"]);
      expect(diff.diffText).toContain("+export const added = 42;");

      // Unmerged `kill` is refused when `forceKillUnmerged` is not set!
      const refusedKill = await ctx.swarm.controlMember({
        swarmId,
        name: "author",
        action: "kill",
      });
      expect(refusedKill.ok).toBe(false);
      expect(refusedKill.message).toContain("unmerged file");

      // Merge worktree applies patch cleanly to `repoDir` and resets changedFileCount to 0!
      const merged = await ctx.swarm.controlMember({
        swarmId,
        name: "author",
        action: "mergeWorktree",
        applyChanges: true,
      });
      expect(merged.ok).toBe(true);
      expect(merged.mergeResult?.applied).toBe(true);
      expect(readFileSync(join(repoDir, "feature.ts"), "utf8")).toContain("export const added = 42;");

      // Now `kill` succeeds cleanly and cleans up the worktree directory!
      const killed = await ctx.swarm.controlMember({
        swarmId,
        name: "author",
        action: "kill",
      });
      expect(killed.ok).toBe(true);
      expect(killed.member?.killed).toBe(true);
      expect(existsSync(expectedWtPath)).toBe(false);
      expect(ctx.swarm.isActiveWorkerSession(author?.sessionId ?? "")).toBe(false);
    } finally {
      await ctx.fiber.dispose();
    }
  });
});

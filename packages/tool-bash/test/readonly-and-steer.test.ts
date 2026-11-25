import { mkdtempSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Context } from "@deepseek-ai/cordis";
import { afterAll, describe, expect, it } from "vitest";
import { Sessions } from "@qianji/session";
import { Tools, type ToolEnv } from "@qianji/tools";
import * as toolBash from "../src/index.ts";
import { bashTool, BackgroundProcessManager, bgProcessTool, findShell, isReadOnlyShellCommand } from "../src/index.ts";

const shell = findShell();
const cwd = mkdtempSync(join(tmpdir(), "qianji-bash-ro-"));

afterAll(async () => {
  try {
    await rm(cwd, { recursive: true, force: true, maxRetries: 15, retryDelay: 200 });
  } catch {
    // Ignore transient child handle cleanup delay on Windows.
  }
});

describe("isReadOnlyShellCommand & bash/bg_process concurrency", () => {
  it("accepts single, piped, and chained read-only commands", () => {
    const safeCommands = [
      "ls -la",
      "pwd",
      "cat package.json",
      "head -n 20 README.md",
      "tail -n 50 app.log",
      "wc -l src/index.ts",
      "which git",
      'rg "isConcurrencySafe" packages/tools',
      "grep -rn needle src/",
      'find packages -maxdepth 2 -name "*.ts"',
      "git status --short",
      "git diff HEAD~1 -- packages/tools",
      "git log --oneline -n 5",
      "git show HEAD:package.json",
      "git rev-parse HEAD",
      "git branch --show-current",
      "git branch -a",
      "git -C packages/tools status",
      "git diff | head -n 40 | wc -l",
      "pwd && git status && ls src",
      "rg 'foo > bar' src/index.ts", // `>` inside single quotes is literal, not a redirect
    ];
    for (const cmd of safeCommands) {
      expect(isReadOnlyShellCommand(cmd), cmd).toBe(true);
    }
  });

  it("rejects redirects, command substitutions, mutating flags, tee, and mixed chains", () => {
    const unsafeCommands = [
      "",
      "   ",
      "ls > out.txt",
      "cat a.txt >> b.txt",
      "cat < input.txt",
      "git status | tee status.log",
      "echo $(whoami)",
      'ls "$(rm -rf build)"',
      "ls `uname -a`",
      "git status && rm -rf dist",
      "ls ; touch pwned",
      "git status || npm install",
      "git branch -D feature",
      "git branch -d feature",
      "git branch -m old new",
      "git branch new-branch-name",
      "git -c core.fsmonitor=evil status",
      "git diff --output=/tmp/patch.diff",
      "find . -name '*.tmp' -delete",
      "find . -exec rm {} +",
      "rg --pre=evil pattern",
      "tail -f server.log",
      "sleep 5 &",
      "(ls && rm a)",
      "FOO=bar git status",
    ];
    for (const cmd of unsafeCommands) {
      expect(isReadOnlyShellCommand(cmd), cmd).toBe(false);
    }
  });

  it("wires isConcurrencySafe into bash and bg_process", () => {
    const bash = bashTool({ shell });
    expect(bash.isConcurrencySafe?.({ command: "git status" })).toBe(true);
    expect(bash.isConcurrencySafe?.({ command: "git status", background: true })).toBe(false);
    expect(bash.isConcurrencySafe?.({ command: "npm test" })).toBe(false);

    const bg = bgProcessTool(new BackgroundProcessManager());
    expect(bg.isConcurrencySafe?.({ action: "list" })).toBe(true);
    expect(bg.isConcurrencySafe?.({ action: "logs", id: "bg-1" })).toBe(true);
    expect(bg.isConcurrencySafe?.({ action: "wait", id: "bg-1" })).toBe(true);
    expect(bg.isConcurrencySafe?.({ action: "stop", id: "bg-1" })).toBe(false);
  });

  it.skipIf(shell === undefined)("wakes bg_process(wait) early on steeringSignal without killing the process", async () => {
    const ctx = new Context();
    await ctx.plugin(Sessions);
    await ctx.plugin(Tools);
    await ctx.plugin(toolBash, { shell });
    try {
      const session = ctx.sessions.create({ cwd });
      const baseEnv: ToolEnv = { sessionId: session.id, cwd, signal: new AbortController().signal };

      const started = await ctx.tools.execute(
        { id: "s1", name: "bash", args: { command: "echo boot-ok; sleep 10", background: true, waitMs: 200 } },
        baseEnv,
      );
      const bgId = (started.details as { id?: string } | undefined)?.id ?? "";
      expect(bgId).toMatch(/^bg-/);

      const steerController = new AbortController();
      setTimeout(() => steerController.abort(), 120);
      const t0 = Date.now();
      const waited = await ctx.tools.execute(
        { id: "w1", name: "bg_process", args: { action: "wait", id: bgId, timeoutMs: 10_000 } },
        { ...baseEnv, steeringSignal: steerController.signal },
      );
      const elapsed = Date.now() - t0;
      expect(elapsed).toBeLessThan(2_500);
      expect(waited.isError).toBe(false);
      const text = waited.content.map((b) => (b.type === "text" ? b.text : "")).join("");
      expect(text).toContain("status=running");
      expect(text).toContain("boot-ok");
      expect(text).toContain("steering");

      // Confirm background process is still alive after steering wakeup, then stop it cleanly.
      const logsAfter = await ctx.tools.execute(
        { id: "l1", name: "bg_process", args: { action: "logs", id: bgId } },
        baseEnv,
      );
      expect(logsAfter.content.map((b) => (b.type === "text" ? b.text : "")).join("")).toContain("status=running");
      await ctx.tools.execute({ id: "st1", name: "bg_process", args: { action: "stop", id: bgId } }, baseEnv);
    } finally {
      await ctx.fiber.dispose();
    }
  });
});

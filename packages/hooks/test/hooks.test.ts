import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Context } from "@deepseek-ai/cordis";
import { afterEach, describe, expect, it } from "vitest";
import { Sessions } from "@qianji/session";
import { Tools, textOutput } from "@qianji/tools";
import { Ui } from "@qianji/ui";
import * as hooks from "../src/index.ts";
import { executeHook, hookEnvironment, type DesktopHookConfig } from "../src/index.ts";

let dir = "";
afterEach(() => {
  // A hook process can still hold the directory as its cwd for a moment after
  // its output lands (EBUSY on Windows); a temp directory left behind is fine.
  try {
    rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  } catch {
    // Left for the OS to clean up.
  }
});

const node = JSON.stringify(process.execPath);
const hook = (overrides: Partial<DesktopHookConfig>): DesktopHookConfig => ({
  id: overrides.id ?? "h", name: overrides.name ?? "hook", enabled: true, event: "tool_call", command: "", timeoutSeconds: 10, blocking: false, ...overrides,
});

describe("hooks", () => {
  it("blocks a tool call when a blocking hook fails, and records results", async () => {
    dir = mkdtempSync(join(tmpdir(), "pid-hooks-"));
    const log = join(dir, "results.jsonl");
    // Scripts in files: an inline `node -e` does not survive cmd.exe's quoting.
    const guard = join(dir, "guard.cjs");
    writeFileSync(guard, "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{if(JSON.parse(s).payload.input.command.includes('push')){console.log('no pushing');process.exit(1)}})");
    const record = join(dir, "record.cjs");
    writeFileSync(record, `let s='';process.stdin.on('data',d=>s+=d).on('end',()=>require('fs').appendFileSync(${JSON.stringify(log)},s+String.fromCharCode(10)))`);
    const ctx = new Context();
    await ctx.plugin(Sessions);
    await ctx.plugin(Ui);
    await ctx.plugin(Tools);
    await ctx.plugin(hooks, {
      hooks: [
        hook({ id: "guard", event: "tool_call", blocking: true, command: `${node} ${JSON.stringify(guard)}` }),
        hook({ id: "record", event: "tool_result", command: `${node} ${JSON.stringify(record)}` }),
      ],
    });
    ctx.tools.register({ name: "bash", description: "", parameters: { type: "object" }, execute: () => textOutput("ran") });
    const env = { sessionId: "s", cwd: dir, signal: new AbortController().signal };

    expect(await ctx.tools.execute({ id: "1", name: "bash", args: { command: "git push" } }, env)).toEqual(textOutput("Denied: hook: no pushing", true));
    expect(await ctx.tools.execute({ id: "2", name: "bash", args: { command: "git status" } }, env)).toEqual(textOutput("ran"));
    await expect.poll(() => { try { return readFileSync(log, "utf8").trim().split("\n").length; } catch { return 0; } }).toBe(2);
    const recorded = readFileSync(log, "utf8").trim().split("\n").map((line) => JSON.parse(line));
    expect(recorded.map((entry) => [entry.event, entry.payload.toolCallId, entry.payload.isError])).toEqual([["tool_result", "1", true], ["tool_result", "2", false]]);
    await ctx.fiber.dispose();
  });

  it("keeps secrets out of hook environments unless asked", () => {
    const env = { PATH: "/bin", OPENAI_API_KEY: "k", GITHUB_TOKEN: "t" };
    expect(Object.keys(hookEnvironment(false, "tool_call", "/w", env)).sort()).toEqual(["PATH", "PIDESKTOP_HOOK_EVENT", "PIDESKTOP_WORKSPACE"]);
    expect(hookEnvironment(true, "tool_call", "/w", env).OPENAI_API_KEY).toBe("k");
  });

  it("ignores an invalid configuration", async () => {
    const ctx = new Context();
    await ctx.plugin(Sessions);
    await ctx.plugin(Ui);
    await ctx.plugin(Tools);
    await ctx.plugin(hooks, { hooks: [hook({ command: "" })] });
    ctx.tools.register({ name: "bash", description: "", parameters: { type: "object" }, execute: () => textOutput("ran") });
    expect(await ctx.tools.execute({ id: "1", name: "bash", args: {} }, { sessionId: "s", cwd: ".", signal: new AbortController().signal })).toEqual(textOutput("ran"));
  });

  it("supports stop hooks blocking via exit code 2 or JSON decision, and tool_result additionalContext injection", async () => {
    dir = mkdtempSync(join(tmpdir(), "pid-hooks-stop-"));
    const exit2Hook = join(dir, "stop-exit2.cjs");
    writeFileSync(exit2Hook, "process.stderr.write('Run unit tests before finishing.');process.exit(2);");

    const jsonBlockHook = join(dir, "stop-json.cjs");
    writeFileSync(
      jsonBlockHook,
      "process.stdout.write(JSON.stringify({ decision: 'block', reason: 'Verify lint cleanly.' }));",
    );

    const postToolHook = join(dir, "post-tool.cjs");
    writeFileSync(
      postToolHook,
      "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{const p=JSON.parse(s).payload;if(p.toolName==='edit'){process.stdout.write(JSON.stringify({additionalContext:'Remember to update snapshots if intentional.'}))}});",
    );

    // Direct executeHook check for exitCode, stdout, stderr
    const rawExec = await executeHook(
      hook({ id: "raw", event: "stop", command: `${node} ${JSON.stringify(exit2Hook)}` }),
      "stop",
      { turn: 1 },
      dir,
      false,
    );
    expect(rawExec.ok).toBe(false);
    expect(rawExec.exitCode).toBe(2);
    expect(rawExec.stderr).toBe("Run unit tests before finishing.");

    const ctx = new Context();
    await ctx.plugin(Sessions);
    await ctx.plugin(Ui);
    await ctx.plugin(Tools);
    await ctx.plugin(hooks, {
      hooks: [
        hook({ id: "s1", event: "stop", command: `${node} ${JSON.stringify(exit2Hook)}` }),
        hook({ id: "s2", event: "stop", command: `${node} ${JSON.stringify(jsonBlockHook)}` }),
        hook({ id: "tr1", event: "tool_result", command: `${node} ${JSON.stringify(postToolHook)}` }),
      ],
    });
    ctx.tools.register({ name: "edit", description: "", parameters: { type: "object" }, execute: () => textOutput("edited file") });
    ctx.tools.register({ name: "read", description: "", parameters: { type: "object" }, execute: () => textOutput("read file") });

    const session = ctx.sessions.create({ cwd: dir });
    const stopNudge = await ctx.serial("agent/before-stop", session, { turn: 1, stop: "stop", hasText: true });
    expect(stopNudge).toBe("Run unit tests before finishing.\n\nVerify lint cleanly.");

    const env = { sessionId: session.id, cwd: dir, signal: new AbortController().signal };
    const edited = await ctx.tools.execute({ id: "c-edit", name: "edit", args: {} }, env);
    expect(edited).toEqual({
      content: [
        { type: "text", text: "edited file" },
        { type: "text", text: "\n\nRemember to update snapshots if intentional." },
      ],
    });

    const readOut = await ctx.tools.execute({ id: "c-read", name: "read", args: {} }, env);
    expect(readOut).toEqual(textOutput("read file"));

    await ctx.fiber.dispose();
  });
});

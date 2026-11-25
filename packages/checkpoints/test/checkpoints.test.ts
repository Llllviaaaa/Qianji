import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Context } from "@deepseek-ai/cordis";
import { afterEach, describe, expect, it } from "vitest";
import { Sessions } from "@qianji/session";
import { Tools, textOutput } from "@qianji/tools";
import * as checkpoints from "../src/index.ts";
import { checkpointFor, checkpointsOf, diffCheckpoint, restoreCheckpoint, takeCheckpoint } from "../src/index.ts";

let dir = "";
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function repo(): string {
  dir = mkdtempSync(join(tmpdir(), "pid-checkpoints-"));
  const git = (...args: string[]) => execFileSync("git", args, { cwd: dir, windowsHide: true });
  git("init", "-q");
  git("config", "user.email", "test@example.com");
  git("config", "user.name", "Test");
  git("config", "commit.gpgsign", "false");
  git("config", "core.autocrlf", "false");
  writeFileSync(join(dir, "a.txt"), "one\n");
  git("add", "a.txt");
  git("commit", "-q", "-m", "init");
  return dir;
}

describe("checkpoints", () => {
  it("snapshots before a run and restores the files", async () => {
    const cwd = repo();
    const ctx = new Context();
    await ctx.plugin(Sessions);
    const session = ctx.sessions.create({ cwd });
    const user = session.append("user", { content: [{ type: "text", text: "change a.txt" }] });

    const record = await takeCheckpoint(session);
    expect(record?.userSeq).toBe(user.seq);
    expect(await takeCheckpoint(session)).toBeUndefined();
    expect(checkpointsOf(session)).toHaveLength(1);

    writeFileSync(join(cwd, "a.txt"), "two\n");
    writeFileSync(join(cwd, "b.txt"), "new\n");
    const found = checkpointFor(session, user.seq);
    if (found === undefined) throw new Error("no checkpoint");
    expect(await diffCheckpoint(found)).toMatchObject({ changed: true, files: ["a.txt", "b.txt"] });
    await restoreCheckpoint(found);
    expect(readFileSync(join(cwd, "a.txt"), "utf8")).toBe("one\n");
    expect((await diffCheckpoint(found)).changed).toBe(false);

    // The ref lives in the repository under Qianji's checkpoint namespace.
    expect(execFileSync("git", ["for-each-ref", "refs/qianji/checkpoints"], { cwd, encoding: "utf8" })).toContain(found.checkpoint.ref);
    await ctx.fiber.dispose();
  });

  it("checkpoints on agent/before-start unless the session is read-only", async () => {
    const cwd = repo();
    const ctx = new Context();
    await ctx.plugin(Sessions);
    ctx.provide("agents", {});
    let effective = "ask";
    ctx.provide("permissions", { modes: () => ({ effective }) });
    await ctx.plugin(checkpoints);
    const session = ctx.sessions.create({ cwd });
    session.append("user", { content: [{ type: "text", text: "go" }] });
    effective = "read-only";
    await ctx.serial("agent/before-start", session);
    expect(checkpointsOf(session)).toHaveLength(0);
    effective = "ask";
    await ctx.serial("agent/before-start", session);
    expect(checkpointsOf(session)).toHaveLength(1);
    await ctx.fiber.dispose();
  });

  it("does nothing outside a git repository", async () => {
    dir = mkdtempSync(join(tmpdir(), "pid-checkpoints-"));
    const ctx = new Context();
    await ctx.plugin(Sessions);
    const session = ctx.sessions.create({ cwd: dir });
    session.append("user", { content: [{ type: "text", text: "go" }] });
    expect(await takeCheckpoint(session)).toBeUndefined();
    await ctx.fiber.dispose();
  });

  it("lazily captures per-turn snapshots on turn >= 2 before mutating tools while keeping initial userSeq lookup intact", async () => {
    const cwd = repo();
    const ctx = new Context();
    await ctx.plugin(Sessions);
    await ctx.plugin(Tools);
    ctx.provide("agents", { status: () => ({ running: false }) });
    let effective = "workspace-write";
    ctx.provide("permissions", { modes: () => ({ effective }) });
    await ctx.plugin(checkpoints);

    ctx.tools.register<{ path: string }>({
      name: "read_file",
      readOnly: true,
      description: "Read",
      parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
      execute: () => textOutput("read"),
    });
    ctx.tools.register<{ content: string }>({
      name: "write_file",
      description: "Write",
      parameters: { type: "object", properties: { content: { type: "string" } }, required: ["content"] },
      execute: ({ content }) => {
        writeFileSync(join(cwd, "a.txt"), content);
        return textOutput("written");
      },
    });

    const session = ctx.sessions.create({ cwd });
    const user = session.append("user", { content: [{ type: "text", text: "multi-turn edits" }] });
    const env = { sessionId: session.id, cwd, signal: new AbortController().signal };

    // Turn 1: initial snapshot via before-start, no extra turn snapshot on turn 1 tool call
    await ctx.serial("agent/before-start", session);
    await ctx.serial("agent/turn-start", session, 1);
    await ctx.tools.execute({ id: "t1-w", name: "write_file", args: { content: "after-turn-1\n" } }, env);
    expect(checkpointsOf(session)).toHaveLength(1);
    expect(checkpointsOf(session)[0]?.turn).toBeUndefined();

    // Turn 2: readOnly tool takes NO snapshot; first mutating tool lazily captures turn=2 snapshot ("after-turn-1\n")
    await ctx.serial("agent/turn-start", session, 2);
    await ctx.tools.execute({ id: "t2-r", name: "read_file", args: { path: "a.txt" } }, env);
    expect(checkpointsOf(session)).toHaveLength(1);

    await ctx.tools.execute({ id: "t2-w1", name: "write_file", args: { content: "after-turn-2a\n" } }, env);
    await ctx.tools.execute({ id: "t2-w2", name: "write_file", args: { content: "after-turn-2b\n" } }, env);
    expect(checkpointsOf(session)).toHaveLength(2);
    expect(checkpointsOf(session)[1]?.turn).toBe(2);

    // Turn 3 in read-only mode takes NO snapshot; switching back on Turn 4 captures turn=4 snapshot
    await ctx.serial("agent/turn-start", session, 3);
    effective = "read-only";
    await ctx.tools.execute({ id: "t3-w", name: "write_file", args: { content: "after-turn-3\n" } }, env);
    expect(checkpointsOf(session)).toHaveLength(2);

    effective = "workspace-write";
    await ctx.serial("agent/turn-start", session, 4);
    await ctx.tools.execute({ id: "t4-w", name: "write_file", args: { content: "after-turn-4\n" } }, env);
    expect(checkpointsOf(session)).toHaveLength(3);
    expect(checkpointsOf(session)[2]?.turn).toBe(4);

    // Restoring turn=2 snapshot puts a.txt back to how it was at the start of turn 2 ("after-turn-1\n")
    const turn2Record = checkpointFor(session, user.seq, 2);
    expect(turn2Record?.turn).toBe(2);
    if (turn2Record === undefined) throw new Error("missing turn 2 checkpoint");
    await restoreCheckpoint(turn2Record);
    expect(readFileSync(join(cwd, "a.txt"), "utf8")).toBe("after-turn-1\n");

    // Omitting `turn` in checkpointFor still finds the initial pre-run snapshot ("one\n")
    const initialRecord = checkpointFor(session, user.seq);
    expect(initialRecord?.turn).toBeUndefined();
    if (initialRecord === undefined) throw new Error("missing initial checkpoint");
    await restoreCheckpoint(initialRecord);
    expect(readFileSync(join(cwd, "a.txt"), "utf8")).toBe("one\n");

    // Settling clears turn state so out-of-band tool execution does not snapshot stale turns
    await ctx.parallel("agent/settled", session, "done");
    await ctx.tools.execute({ id: "post-settle", name: "write_file", args: { content: "post\n" } }, env);
    expect(checkpointsOf(session)).toHaveLength(3);

    await ctx.fiber.dispose();
  });
});

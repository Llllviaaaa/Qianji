import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Context } from "@deepseek-ai/cordis";
import { afterEach, describe, expect, it } from "vitest";
import { AgentLoop } from "@qianji/agent-loop";
import { LlmService, type LlmRequest } from "@qianji/llm";
import { Permissions } from "@qianji/permissions";
import { Sessions } from "@qianji/session";
import { SystemPrompt } from "@qianji/system-prompt";
import { ScriptedProvider, textReply, toolReply, useScriptedProvider } from "@qianji/testkit";
import { Tools, textOutput } from "@qianji/tools";
import { Ui, type PendingUiRequest } from "@qianji/ui";
import * as subagents from "../src/index.ts";

let ctx: Context | undefined;
const tempDirs: string[] = [];

afterEach(async () => {
  await ctx?.fiber.dispose();
  ctx = undefined;
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
  }
});

describe("Phase 2 subagent enhancements & collab lifecycle", () => {
  it("inherits uncommitted tracked modifications and untracked files in isolateWorktree and applies only net subagent changes", async () => {
    const repo = mkdtempSync(join(tmpdir(), "qianji-dirty-wt-"));
    tempDirs.push(repo);
    execFileSync("git", ["init"], { cwd: repo });
    execFileSync("git", ["config", "user.email", "test@qianji.local"], { cwd: repo });
    execFileSync("git", ["config", "user.name", "Test"], { cwd: repo });
    writeFileSync(join(repo, "tracked.txt"), "committed-v1\n");
    writeFileSync(join(repo, "untouched-dirty.txt"), "committed-untouched\n");
    execFileSync("git", ["add", "-A"], { cwd: repo });
    execFileSync("git", ["commit", "-m", "init"], { cwd: repo });

    // Dirty uncommitted edits + untracked file in parent workspace!
    writeFileSync(join(repo, "tracked.txt"), "dirty-parent-v2\n");
    writeFileSync(join(repo, "untouched-dirty.txt"), "dirty-untouched-v2\n");
    writeFileSync(join(repo, "draft.txt"), "parent-untracked\n");

    ctx = new Context();
    await ctx.plugin(LlmService, { maxAttempts: 1 });
    await ctx.plugin(Sessions);
    await ctx.plugin(Tools);
    await ctx.plugin(SystemPrompt);
    await ctx.plugin(AgentLoop);
    await ctx.plugin(subagents, { concurrency: 1 });

    const observedInWorktree: Record<string, string> = {};
    ctx.tools.register({
      name: "read",
      description: "read",
      parameters: { type: "object" },
      execute: (args, env) => {
        const rel = String(args.path);
        const content = readFileSync(join(env.cwd, rel), "utf8").replace(/\r\n/g, "\n");
        observedInWorktree[rel] = content;
        return textOutput(content);
      },
    });
    ctx.tools.register({
      name: "write",
      description: "write",
      parameters: { type: "object" },
      execute: (args, env) => {
        const target = join(env.cwd, String(args.path));
        mkdirSync(join(env.cwd), { recursive: true });
        writeFileSync(target, String(args.content));
        return textOutput("ok");
      },
    });
    for (const name of ["grep", "find", "ls", "edit"]) {
      ctx.tools.register({ name, description: name, parameters: { type: "object" }, execute: () => textOutput("ok") });
    }

    let step = 0;
    const provider = new ScriptedProvider([
      () => {
        step += 1;
        return toolReply([
          { id: "r1", name: "read", args: { path: "tracked.txt" } },
          { id: "r2", name: "read", args: { path: "draft.txt" } },
          { id: "w1", name: "write", args: { path: "tracked.txt", content: "dirty-parent-v2\nsubagent-v3\n" } },
          { id: "w2", name: "write", args: { path: "draft.txt", content: "parent-untracked\nsubagent-added\n" } },
        ]);
      },
      () => textReply("Updated dirty files cleanly."),
    ]);
    useScriptedProvider(ctx, provider);

    const parent = ctx.sessions.create({ cwd: repo });
    parent.append("model", { provider: "scripted", model: "m" });

    const out = await ctx.tools.execute(
      {
        id: "call-dirty",
        name: "delegate_task",
        args: {
          permission: "workspace-write",
          isolateWorktree: true,
          task: "extend tracked.txt and draft.txt",
          role: "worker",
        },
      },
      { sessionId: parent.id, cwd: repo, signal: new AbortController().signal, callId: "call-dirty" },
    );

    expect(out.isError).toBe(false);
    expect(step).toBe(1);
    expect(observedInWorktree["tracked.txt"]).toBe("dirty-parent-v2\n");
    expect(observedInWorktree["draft.txt"]).toBe("parent-untracked\n");

    const details = out.details as { results: subagents.SubagentResult[] };
    expect(details.results[0]?.patch).toMatchObject({
      applied: true,
      changedFiles: ["draft.txt", "tracked.txt"],
    });
    expect(readFileSync(join(repo, "tracked.txt"), "utf8").replace(/\r\n/g, "\n")).toBe("dirty-parent-v2\nsubagent-v3\n");
    expect(readFileSync(join(repo, "draft.txt"), "utf8").replace(/\r\n/g, "\n")).toBe("parent-untracked\nsubagent-added\n");
    expect(readFileSync(join(repo, "untouched-dirty.txt"), "utf8").replace(/\r\n/g, "\n")).toBe("dirty-untouched-v2\n");
  });

  it("runs allowShell child bash commands without extra ui.confirm modals while still blocking outside-workspace writes and force-push", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "qianji-shell-trust-"));
    tempDirs.push(workspace);

    ctx = new Context();
    await ctx.plugin(LlmService, { maxAttempts: 1 });
    await ctx.plugin(Sessions);
    await ctx.plugin(Ui);
    await ctx.plugin(Tools);
    await ctx.plugin(SystemPrompt);
    await ctx.plugin(Permissions, { defaultPermission: "workspace-write", alwaysConfirmShell: true });
    await ctx.plugin(AgentLoop);
    await ctx.plugin(subagents, { concurrency: 1 });

    const uiPrompts: PendingUiRequest[] = [];
    ctx.ui.attach({
      request: (pending) => {
        uiPrompts.push(pending);
        // Approve parent's single delegate_task confirmation; child must NOT trigger any ui.confirm!
        ctx?.ui.respond(pending.requestId, pending.request.title.includes("子代理"));
      },
      cancel: () => {},
      notify: () => {},
    });

    ctx.tools.register({
      name: "bash",
      description: "bash",
      parameters: { type: "object" },
      execute: (args) => textOutput(`ran: ${String(args.command)}`),
    });
    ctx.tools.register({
      name: "write",
      description: "write",
      parameters: { type: "object" },
      execute: (args) => textOutput(`wrote: ${String(args.path)}`),
    });
    ctx.tools.register({
      name: "custom_readonly_probe",
      description: "readonly probe",
      readOnly: true,
      parameters: { type: "object" },
      execute: () => textOutput("probe-ok"),
    });
    for (const name of ["read", "grep", "find", "ls", "edit", "diagnostics"]) {
      ctx.tools.register({ name, description: name, parameters: { type: "object" }, execute: () => textOutput("ok") });
    }

    const provider = new ScriptedProvider([
      () =>
        toolReply([
          { id: "c1", name: "bash", args: { command: "npm test" } },
          { id: "c2", name: "bash", args: { command: "git push --force origin main" } },
          { id: "c3", name: "write", args: { path: "../outside-escape.txt", content: "bad" } },
          { id: "c4", name: "custom_readonly_probe", args: {} },
        ]),
      () => textReply("Verification finished."),
    ]);
    useScriptedProvider(ctx, provider);

    const parent = ctx.sessions.create({ cwd: workspace });
    parent.append("model", { provider: "scripted", model: "m" });

    const out = await ctx.tools.execute(
      {
        id: "del-1",
        name: "delegate_task",
        args: {
          permission: "workspace-write",
          allowShell: true,
          role: "worker",
          task: "verify with bash",
        },
      },
      { sessionId: parent.id, cwd: workspace, signal: new AbortController().signal, callId: "del-1" },
    );

    expect(out.isError).toBe(false);
    // Only the 1 parent confirmation for delegate_task occurred; 0 child shell confirmations!
    expect(uiPrompts).toHaveLength(1);

    const childSummary = (await ctx.sessions.list()).find((s) => s.parent?.sessionId === parent.id);
    const childSession = await ctx.sessions.get(childSummary?.id ?? "");
    const results = (childSession?.events ?? []).filter((e) => e.type === "tool-result");
    expect(results[0]?.data).toMatchObject({ isError: false, content: [{ type: "text", text: "ran: npm test" }] });
    expect(results[1]?.data).toMatchObject({ isError: true });
    expect(JSON.stringify(results[1]?.data.content)).toContain("强制推送");
    expect(results[2]?.data).toMatchObject({ isError: true });
    expect(JSON.stringify(results[2]?.data.content)).toContain("outside workspace");
    expect(results[3]?.data).toMatchObject({ isError: false, content: [{ type: "text", text: "probe-ok" }] });
  });

  it("clones settled parent conversation prefix when forkContext is true", async () => {
    ctx = new Context();
    await ctx.plugin(LlmService, { maxAttempts: 1 });
    await ctx.plugin(Sessions);
    await ctx.plugin(Tools);
    await ctx.plugin(SystemPrompt);
    await ctx.plugin(AgentLoop);
    await ctx.plugin(subagents, { concurrency: 1 });
    for (const name of ["read", "grep", "find", "ls"]) {
      ctx.tools.register({ name, description: name, parameters: { type: "object" }, execute: () => textOutput("ok") });
    }

    const observedRequests: LlmRequest[] = [];
    const provider = new ScriptedProvider([
      (req) => {
        observedRequests.push(req);
        return textReply("Reviewed using forked context.");
      },
    ]);
    useScriptedProvider(ctx, provider);

    const parent = ctx.sessions.create({ cwd: "/repo" });
    parent.append("model", { provider: "scripted", model: "m" });
    parent.append("user", { content: [{ type: "text", text: "Earlier architectural context: module X owns auth." }] });
    parent.append("assistant", {
      content: [{ type: "text", text: "Understood, module X owns auth." }],
      model: { provider: "scripted", model: "m" },
      usage: { inputTokens: 10, outputTokens: 5, cacheReadTokens: 0, cacheWriteTokens: 0 },
      stop: "stop",
    });
    // Simulate in-flight assistant turn invoking delegate_task (no tool-result yet).
    parent.append("assistant", {
      content: [{ type: "tool-call", id: "inflight-del", name: "delegate_task", arguments: { task: "review", forkContext: true } }],
      model: { provider: "scripted", model: "m" },
      usage: { inputTokens: 15, outputTokens: 8, cacheReadTokens: 0, cacheWriteTokens: 0 },
      stop: "tool-use",
    });
    parent.append("tool-call", { callId: "inflight-del", name: "delegate_task", args: { task: "review", forkContext: true } });

    const out = await ctx.tools.execute(
      { id: "inflight-del", name: "delegate_task", args: { task: "Check auth invariants", role: "reviewer", forkContext: true } },
      { sessionId: parent.id, cwd: "/repo", signal: new AbortController().signal, callId: "inflight-del" },
    );

    expect(out.isError).toBe(false);
    expect(observedRequests).toHaveLength(1);
    const msgs = observedRequests[0]?.messages ?? [];
    expect(msgs.map((m) => m.role)).toEqual(["user", "assistant", "user"]);
    expect(JSON.stringify(msgs[0])).toContain("module X owns auth");
    expect(JSON.stringify(msgs[2])).toContain("Check auth invariants");
  });

  it("manages spawn_agent -> send_input -> wait_agent -> close_agent lifecycle, steering wakeups, and before-stop quiescence barrier", async () => {
    ctx = new Context();
    await ctx.plugin(LlmService, { maxAttempts: 1 });
    await ctx.plugin(Sessions);
    await ctx.plugin(Ui);
    await ctx.plugin(Tools);
    await ctx.plugin(SystemPrompt);
    await ctx.plugin(Permissions, { defaultPermission: "workspace-write" });
    await ctx.plugin(AgentLoop);
    await ctx.plugin(subagents, { maxActiveAgents: 2, maxDepth: 2 });
    const uiPrompts: PendingUiRequest[] = [];
    ctx.ui.attach({
      request: (pending) => {
        uiPrompts.push(pending);
        ctx?.ui.respond(pending.requestId, true);
      },
      cancel: () => {},
      notify: () => {},
    });
    for (const name of ["read", "grep", "find", "ls"]) {
      ctx.tools.register({ name, description: name, parameters: { type: "object" }, execute: () => textOutput("ok") });
    }

    const parent = ctx.sessions.create({ cwd: "/repo" });
    parent.append("model", { provider: "scripted", model: "m" });

    // Collab tools are deferred under group "subagents" so default session schemas stay clean.
    const defaultNames = ctx.tools.schemas(parent.id).map((t) => t.name);
    expect(defaultNames).toContain("delegate_task");
    expect(defaultNames).not.toContain("spawn_agent");

    let releaseFirstTurn: (() => void) | undefined;
    const firstTurnGate = new Promise<void>((resolve) => {
      releaseFirstTurn = resolve;
    });

    let callNum = 0;
    const provider = new ScriptedProvider([
      async function* () {
        callNum += 1;
        await firstTurnGate;
        yield { type: "text-delta", index: 0, text: "initial-background-finding" };
        yield { type: "finish", reason: "stop" };
      },
      async function* () {
        callNum += 1;
        yield { type: "text-delta", index: 0, text: "followup-background-finding" };
        yield { type: "finish", reason: "stop" };
      },
      async function* () {
        callNum += 1;
        yield { type: "text-delta", index: 0, text: "second-agent-done" };
        yield { type: "finish", reason: "stop" };
      },
    ]);
    useScriptedProvider(ctx, provider);

    const baseEnv = { sessionId: parent.id, cwd: "/repo", signal: new AbortController().signal };

    // 1. Spawn agent 1 (returns running immediately while gated).
    const spawned = await ctx.tools.execute(
      { id: "s1", name: "spawn_agent", args: { task: "scan auth", role: "explorer", label: "auth-scan" } },
      baseEnv,
    );
    expect(spawned.isError).toBeUndefined();
    const { agentId } = spawned.details as { agentId: string; status: string };
    expect(agentId).toBeTruthy();

    // 2. Quiescence barrier (`agent/before-stop`) blocks parent from stopping while child is running!
    const nudgeWhileRunning = await ctx.serial("agent/before-stop", parent, { turn: 1, stop: "stop", hasText: true });
    expect(nudgeWhileRunning).toContain(agentId);
    expect(nudgeWhileRunning).toContain("wait_agent");

    // 3. `wait_agent` wakes early when `steeringSignal` aborts!
    const steerAbort = new AbortController();
    const steerWaitPromise = ctx.tools.execute(
      { id: "w-steer", name: "wait_agent", args: { agentIds: [agentId] } },
      { ...baseEnv, steeringSignal: steerAbort.signal } as never,
    );
    setTimeout(() => steerAbort.abort(), 15);
    const steeredWait = await steerWaitPromise;
    expect((steeredWait.details as { steered: boolean }).steered).toBe(true);

    // 4. Release child's first turn and wait via `wait_agent` (zero-poll event wakeup).
    releaseFirstTurn?.();
    const waited1 = await ctx.tools.execute(
      { id: "w1", name: "wait_agent", args: { agentIds: [agentId], mode: "all" } },
      baseEnv,
    );
    const snap1 = (waited1.details as { agents: Array<{ status: string; output: string }> }).agents[0];
    expect(snap1).toMatchObject({ status: "done", output: "initial-background-finding" });

    // Once child has settled, before-stop barrier allows parent to finish cleanly.
    const nudgeAfterSettled = await ctx.serial("agent/before-stop", parent, { turn: 2, stop: "stop", hasText: true });
    expect(nudgeAfterSettled).toBeUndefined();

    // 5. `send_input` resumes the persistent child session and preserves prior context.
    await ctx.tools.execute(
      { id: "in1", name: "send_input", args: { agentId, message: "now check token expiry" } },
      baseEnv,
    );
    const waited2 = await ctx.tools.execute(
      { id: "w2", name: "wait_agent", args: { agentIds: [agentId] } },
      baseEnv,
    );
    const snap2 = (waited2.details as { agents: Array<{ status: string; output: string }> }).agents[0];
    expect(snap2).toMatchObject({ status: "done", output: "followup-background-finding" });

    // 6. Enforce `maxActiveAgents = 2` cap, then free slot with `close_agent`.
    const spawned2 = await ctx.tools.execute(
      { id: "s2", name: "spawn_agent", args: { task: "second agent" } },
      baseEnv,
    );
    expect(spawned2.isError).toBeUndefined();
    const overCap = await ctx.tools.execute(
      { id: "s3", name: "spawn_agent", args: { task: "third agent over cap" } },
      baseEnv,
    );
    expect(overCap.isError).toBe(true);
    expect(JSON.stringify(overCap.content)).toContain("Maximum active background subagents (2)");

    const closed = await ctx.tools.execute(
      { id: "cl1", name: "close_agent", args: { agentId } },
      baseEnv,
    );
    expect(closed.details).toMatchObject({ agentId, status: "closed" });
    expect(uiPrompts).toHaveLength(0);
    expect(callNum).toBeGreaterThanOrEqual(2);
  });

  it("blocks send_input to workspace-write subagent and saves (instead of applying) worktree patch on close_agent when parent switches to read-only", async () => {
    const repo = mkdtempSync(join(tmpdir(), "qianji-collab-ro-"));
    tempDirs.push(repo);
    execFileSync("git", ["init"], { cwd: repo });
    execFileSync("git", ["config", "user.email", "test@qianji.local"], { cwd: repo });
    execFileSync("git", ["config", "user.name", "Test"], { cwd: repo });
    writeFileSync(join(repo, "file.txt"), "original\n");
    execFileSync("git", ["add", "-A"], { cwd: repo });
    execFileSync("git", ["commit", "-m", "init"], { cwd: repo });

    ctx = new Context();
    await ctx.plugin(LlmService, { maxAttempts: 1 });
    await ctx.plugin(Sessions);
    await ctx.plugin(Ui);
    await ctx.plugin(Tools);
    await ctx.plugin(SystemPrompt);
    await ctx.plugin(Permissions, { defaultPermission: "full-access" });
    await ctx.plugin(AgentLoop);
    await ctx.plugin(subagents, { maxActiveAgents: 2 });
    ctx.tools.register({
      name: "write",
      description: "write",
      parameters: { type: "object" },
      execute: (args, env) => {
        writeFileSync(join(env.cwd, String(args.path)), String(args.content));
        return textOutput("wrote");
      },
    });
    for (const name of ["read", "grep", "find", "ls", "edit"]) {
      ctx.tools.register({ name, description: name, parameters: { type: "object" }, execute: () => textOutput("ok") });
    }

    const provider = new ScriptedProvider([
      () => toolReply([{ id: "w1", name: "write", args: { path: "file.txt", content: "modified-in-worktree\n" } }]),
      () => textReply("Edited in worktree."),
    ]);
    useScriptedProvider(ctx, provider);

    const parent = ctx.sessions.create({ cwd: repo });
    parent.append("model", { provider: "scripted", model: "m" });
    const baseEnv = { sessionId: parent.id, cwd: repo, signal: new AbortController().signal };

    const spawned = await ctx.tools.execute(
      { id: "sp-w", name: "spawn_agent", args: { task: "edit file", role: "worker", permission: "workspace-write", isolateWorktree: true } },
      baseEnv,
    );
    const { agentId } = spawned.details as { agentId: string };
    await ctx.tools.execute({ id: "wt-wait", name: "wait_agent", args: { agentIds: [agentId] } }, baseEnv);

    // Switch parent session to read-only mode before send_input and close_agent!
    ctx.permissions.set(parent, { permission: "read-only" });

    const deniedInput = await ctx.tools.execute(
      { id: "in-ro", name: "send_input", args: { agentId, message: "edit more" } },
      baseEnv,
    );
    expect(deniedInput.isError).toBe(true);
    expect(JSON.stringify(deniedInput.content)).toContain("read-only mode");

    const closed = await ctx.tools.execute(
      { id: "cl-ro", name: "close_agent", args: { agentId, applyChanges: true } },
      baseEnv,
    );
    const closeDetails = closed.details as { patch?: { applied: boolean; patchFile?: string } };
    expect(closeDetails.patch?.applied).toBe(false);
    expect(closeDetails.patch?.patchFile).toBeTruthy();
    expect(readFileSync(join(repo, "file.txt"), "utf8").replace(/\r\n/g, "\n")).toBe("original\n");
  });
});

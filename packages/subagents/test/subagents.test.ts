import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Context } from "@deepseek-ai/cordis";
import { afterEach, describe, expect, it } from "vitest";
import { AgentLoop } from "@qianji/agent-loop";
import { LlmService, type LlmRequest } from "@qianji/llm";
import { Sessions } from "@qianji/session";
import { SystemPrompt } from "@qianji/system-prompt";
import { ScriptedProvider, textReply, toolReply, useScriptedProvider } from "@qianji/testkit";
import { Tools, textOutput } from "@qianji/tools";
import { Ui } from "@qianji/ui";
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

async function setup(reply: (request: LlmRequest) => ReturnType<typeof textReply>, config: subagents.Config = { concurrency: 2 }) {
  ctx = new Context();
  await ctx.plugin(LlmService, { maxAttempts: 1 });
  await ctx.plugin(Sessions);
  await ctx.plugin(Tools);
  await ctx.plugin(SystemPrompt);
  await ctx.plugin(AgentLoop);
  await ctx.plugin(subagents, config);
  for (const name of ["read", "grep", "find", "ls", "edit", "write", "bash", "diagnostics"]) {
    ctx.tools.register({ name, description: name, parameters: { type: "object" }, execute: () => textOutput(`${name} ran`) });
  }
  const provider = new ScriptedProvider(Array.from({ length: 20 }, () => reply));
  useScriptedProvider(ctx, provider);
  const parent = ctx.sessions.create({ cwd: "/repo" });
  parent.append("model", { provider: "scripted", model: "m" });
  return { ctx, provider, parent };
}

const env = (sessionId: string, signal = new AbortController().signal) => ({ sessionId, cwd: "/repo", signal, callId: "call-1" });

describe("delegate_task", () => {
  it("runs tasks as restricted child sessions and returns their answers", async () => {
    const { ctx: c, provider, parent } = await setup((request) => {
      const prompt = request.messages[0]?.role === "user" && request.messages[0].content[0]?.type === "text" ? request.messages[0].content[0].text : "";
      return textReply(prompt.includes("find the bug") ? "Bug is in a.ts" : "Plan: three steps");
    });
    const live: unknown[] = [];
    c.on("session/delta", (session, _seq, delta) => {
      if (session === parent) live.push(delta);
    });
    const output = await c.tools.execute({
      id: "call-1",
      name: "delegate_task",
      args: { tasks: [{ label: "bug", task: "find the bug" }, { label: "plan", task: "plan the fix", role: "planner" }] },
    }, env(parent.id));

    expect(output.isError).toBe(false);
    const text = output.content[0]?.type === "text" ? output.content[0].text : "";
    expect(text).toContain("2/2 subagents completed.");
    expect(text).toContain("### bug (explorer) - completed\n\nBug is in a.ts");
    expect(text).toContain("### plan (planner) - completed\n\nPlan: three steps");

    const children = (await c.sessions.list()).filter((summary) => summary.parent?.sessionId === parent.id);
    expect(children).toHaveLength(2);
    expect(children.every((child) => child.parent?.callId === "call-1")).toBe(true);
    for (const request of provider.requests) expect(request.tools?.map((tool) => tool.name)).toEqual(["find", "grep", "ls", "read"]);
    expect(live.at(-1)).toMatchObject({ type: "subagents", callId: "call-1", permission: "read-only", tasks: [{ status: "completed" }, { status: "completed" }] });
    // The restriction ends with the run.
    expect(c.tools.schemas(children[0]?.id).map((tool) => tool.name)).toContain("bash");
  });

  it("lets a workspace-write worker edit but never run commands", async () => {
    const { ctx: c, provider, parent } = await setup(() => textReply("Done."));
    await c.tools.execute({ id: "call-1", name: "delegate_task", args: { task: "fix it", role: "worker", permission: "workspace-write" } }, env(parent.id));
    expect(provider.requests[0]?.tools?.map((tool) => tool.name)).toEqual(["edit", "find", "grep", "ls", "read", "write"]);
  });

  it("refuses a call the child cannot see and reports failures", async () => {
    let first = true;
    const { ctx: c, parent } = await setup(() => {
      if (first) {
        first = false;
        return toolReply([{ id: "x", name: "bash", args: {} }]);
      }
      return [{ type: "finish", reason: "error", error: { kind: "server", message: "down", retryable: false } }];
    });
    const output = await c.tools.execute({ id: "call-1", name: "delegate_task", args: { task: "try" } }, env(parent.id));
    expect(output.isError).toBe(true);
    const child = (await c.sessions.list()).find((summary) => summary.parent !== undefined);
    const childSession = await c.sessions.get(child?.id ?? "");
    const result = childSession?.events.find((event) => event.type === "tool-result");
    expect(result?.data).toMatchObject({ isError: true, content: [{ type: "text", text: 'Unknown tool "bash".' }] });
    expect(output.content[0]?.type === "text" ? output.content[0].text : "").toContain("Subagent ended: error");
  });

  it("validates its input", async () => {
    const { ctx: c, parent } = await setup(() => textReply("x"));
    const output = await c.tools.execute({ id: "call-1", name: "delegate_task", args: {} }, env(parent.id));
    expect(output).toEqual(textOutput("At least one delegated task is required", true));
  });
});

describe("structured subagent results", () => {
  const schema = {
    type: "object",
    properties: {
      files: { type: "array", items: { type: "string" }, minItems: 1 },
      risk: { type: "string", enum: ["low", "high"] },
    },
    required: ["files", "risk"],
    additionalProperties: false,
  };
  const lastUserText = (request: LlmRequest): string => {
    const last = request.messages.findLast((message) => message.role === "user");
    const block = last?.role === "user" ? last.content[0] : undefined;
    return block?.type === "text" ? block.text : "";
  };
  const outputText = (output: Awaited<ReturnType<Context["tools"]["execute"]>>) => (output.content[0]?.type === "text" ? output.content[0].text : "");

  it("asks for JSON matching the schema and returns it as data", async () => {
    const prompts: string[] = [];
    const { ctx: c, parent } = await setup((request) => {
      prompts.push(lastUserText(request));
      return textReply('```json\n{"files": ["a.ts"], "risk": "low"}\n```');
    });
    const output = await c.tools.execute({ id: "call-1", name: "delegate_task", args: { task: "list risky files", outputSchema: schema } }, env(parent.id));
    expect(output.isError).toBe(false);
    expect(prompts[0]).toContain("matches this JSON Schema");
    expect(prompts[0]).toContain('"additionalProperties": false');
    expect(outputText(output)).toContain('```json\n{\n  "files": [\n    "a.ts"\n  ],\n  "risk": "low"\n}\n```');
    const details = output.details as { results: Array<{ structured?: unknown }> };
    expect(details.results[0]?.structured).toEqual({ files: ["a.ts"], risk: "low" });
  });

  it("gives the subagent one chance to fix a reply that does not fit", async () => {
    const prompts: string[] = [];
    const { ctx: c, parent } = await setup((request) => {
      prompts.push(lastUserText(request));
      return textReply(prompts.length === 1 ? "The risky file is a.ts." : '{"files": ["a.ts"], "risk": "high"}');
    });
    const output = await c.tools.execute({ id: "call-1", name: "delegate_task", args: { task: "list risky files", outputSchema: schema } }, env(parent.id));
    expect(output.isError).toBe(false);
    expect(prompts).toHaveLength(2);
    expect(prompts[1]).toContain("was not valid JSON");
    expect((output.details as { results: Array<{ structured?: unknown }> }).results[0]?.structured).toEqual({ files: ["a.ts"], risk: "high" });
  });

  it("fails the task when the corrected reply still does not fit", async () => {
    const { ctx: c, parent } = await setup(() => textReply('{"files": [], "risk": "medium"}'));
    const output = await c.tools.execute({ id: "call-1", name: "delegate_task", args: { task: "list risky files", outputSchema: schema } }, env(parent.id));
    expect(output.isError).toBe(true);
    expect(outputText(output)).toContain("Structured result rejected: it did not match the schema: $.files should have at least 1 items");
  });

  it("rejects an outputSchema that is not an object", async () => {
    const { ctx: c, parent } = await setup(() => textReply("x"));
    const output = await c.tools.execute({ id: "call-1", name: "delegate_task", args: { task: "x", outputSchema: ["nope"] } }, env(parent.id));
    expect(output.isError).toBe(true);
  });

  it("checks the schema subset tools use", () => {
    expect(subagents.schemaProblem(schema, { files: ["a"], risk: "low" })).toBeUndefined();
    expect(subagents.schemaProblem(schema, { files: ["a"] })).toBe("$.risk is missing");
    expect(subagents.schemaProblem(schema, { files: [1], risk: "low" })).toBe("$.files[0] should be string, not integer");
    expect(subagents.schemaProblem(schema, { files: ["a"], risk: "low", extra: true })).toBe("$.extra is not allowed");
    expect(subagents.schemaProblem({ type: ["number", "null"] }, null)).toBeUndefined();
    expect(subagents.schemaProblem({ type: "number" }, 3)).toBeUndefined();
    expect(subagents.schemaProblem({ type: "integer" }, 2.5)).toBe("$ should be integer, not number");
    expect(subagents.schemaProblem({ const: "x" }, "y")).toBe('$ should be "x"');
    expect(subagents.parseJsonAnswer("  ```\n[1, 2]\n```  ")).toEqual({ ok: true, value: [1, 2] });
    expect(subagents.parseJsonAnswer("")).toEqual({ ok: false, error: "the reply was empty" });
  });
});

describe("ADR 0022 subagent enhancements", () => {
  it("routes per-role model and effort and gates verification shell tools via allowShell", async () => {
    const { ctx: c, provider, parent } = await setup(() => textReply("OK."), {
      concurrency: 2,
      roleModels: {
        explorer: { provider: "scripted", model: "fast-explorer", effort: "low" },
        worker: { provider: "scripted", model: "strong-worker", effort: "high" },
      },
    });
    await c.tools.execute({
      id: "call-1",
      name: "delegate_task",
      args: {
        permission: "workspace-write",
        allowShell: true,
        tasks: [
          { label: "exp", role: "explorer", task: "explore" },
          { label: "wrk", role: "worker", task: "work" },
        ],
      },
    }, env(parent.id));

    expect(provider.requests.map((r) => ({ model: r.model, effort: r.effort }))).toEqual([
      { model: "fast-explorer", effort: "low" },
      { model: "strong-worker", effort: "high" },
    ]);
    for (const req of provider.requests) {
      expect(req.tools?.map((t) => t.name)).toEqual(["bash", "diagnostics", "edit", "find", "grep", "ls", "read", "write"]);
    }
  });

  it("blocks allowShell when config.allowShell is false or permission is read-only", async () => {
    const { ctx: c, provider, parent } = await setup(() => textReply("OK."), { concurrency: 1, allowShell: false });
    await c.tools.execute({
      id: "call-1",
      name: "delegate_task",
      args: { permission: "workspace-write", allowShell: true, task: "work", role: "worker" },
    }, env(parent.id));
    expect(provider.requests[0]?.tools?.map((t) => t.name)).toEqual(["edit", "find", "grep", "ls", "read", "write"]);
  });

  it("propagates unattended state from parent to child session", async () => {
    ctx = new Context();
    await ctx.plugin(LlmService, { maxAttempts: 1 });
    await ctx.plugin(Sessions);
    await ctx.plugin(Ui);
    await ctx.plugin(Tools);
    await ctx.plugin(SystemPrompt);
    await ctx.plugin(AgentLoop);
    await ctx.plugin(subagents, { concurrency: 1 });
    ctx.ui.attach({ request: () => {}, cancel: () => {}, notify: () => {} });
    const observedCanAsk: boolean[] = [];
    ctx.tools.register({
      name: "read",
      description: "read",
      parameters: { type: "object" },
      execute: (_args, toolEnv) => {
        observedCanAsk.push(ctx?.ui.canAsk(toolEnv.sessionId) ?? true);
        return textOutput("ok");
      },
    });
    let step = 0;
    useScriptedProvider(ctx, new ScriptedProvider([
      () => { step += 1; return step === 1 ? toolReply([{ id: "r1", name: "read", args: {} }]) : textReply("Done."); },
      () => textReply("Done."),
    ]));
    const parent = ctx.sessions.create({ cwd: "/repo" });
    parent.append("model", { provider: "scripted", model: "m" });
    const dispose = ctx.ui.markUnattended(parent.id);
    try {
      await ctx.tools.execute({ id: "c1", name: "delegate_task", args: { task: "read file" } }, env(parent.id));
    } finally {
      dispose();
    }
    expect(observedCanAsk).toEqual([false]);
  });

  it("runs parallel workspace-write workers in isolated Git worktrees, applies clean patches, and saves conflicts", async () => {
    const repo = mkdtempSync(join(tmpdir(), "qianji-wt-repo-"));
    tempDirs.push(repo);
    execFileSync("git", ["init"], { cwd: repo });
    execFileSync("git", ["config", "user.email", "test@qianji.local"], { cwd: repo });
    execFileSync("git", ["config", "user.name", "Test"], { cwd: repo });
    writeFileSync(join(repo, "shared.txt"), "base-line\n");
    execFileSync("git", ["add", "-A"], { cwd: repo });
    execFileSync("git", ["commit", "-m", "init"], { cwd: repo });

    ctx = new Context();
    await ctx.plugin(LlmService, { maxAttempts: 1 });
    await ctx.plugin(Sessions);
    await ctx.plugin(Tools);
    await ctx.plugin(SystemPrompt);
    await ctx.plugin(AgentLoop);
    await ctx.plugin(subagents, { concurrency: 2 });
    ctx.tools.register({
      name: "write",
      description: "write",
      parameters: { type: "object" },
      execute: (args, toolEnv) => {
        const target = join(toolEnv.cwd, String(args.path));
        mkdirSync(join(toolEnv.cwd), { recursive: true });
        writeFileSync(target, String(args.content));
        return textOutput(`wrote ${String(args.path)}`);
      },
    });
    for (const name of ["read", "grep", "find", "ls", "edit"]) {
      ctx.tools.register({ name, description: name, parameters: { type: "object" }, execute: () => textOutput("ok") });
    }

    const calls: string[] = [];
    const provider = new ScriptedProvider(Array.from({ length: 12 }, () => (request: LlmRequest) => {
      const prompt = request.messages[0]?.role === "user" && request.messages[0].content[0]?.type === "text" ? request.messages[0].content[0].text : "";
      const hasToolRes = request.messages.some((m) => m.role === "tool-result");
      if (hasToolRes) return textReply("Committed edits in worktree.");
      if (prompt.includes("task-alpha")) {
        calls.push("alpha");
        return toolReply([{ id: "a1", name: "write", args: { path: "alpha.txt", content: "alpha\n" } }]);
      }
      if (prompt.includes("task-beta")) {
        calls.push("beta");
        return toolReply([{ id: "b1", name: "write", args: { path: "shared.txt", content: "beta-override\n" } }]);
      }
      return toolReply([{ id: "g1", name: "write", args: { path: "shared.txt", content: "gamma-conflict\n" } }]);
    }));
    useScriptedProvider(ctx, provider);

    const parent = ctx.sessions.create({ cwd: repo });
    parent.append("model", { provider: "scripted", model: "m" });
    const out = await ctx.tools.execute({
      id: "wt-1",
      name: "delegate_task",
      args: {
        permission: "workspace-write",
        isolateWorktree: true,
        tasks: [
          { label: "alpha", role: "worker", task: "task-alpha" },
          { label: "beta", role: "worker", task: "task-beta" },
          { label: "gamma", role: "worker", task: "task-gamma" },
        ],
      },
    }, { sessionId: parent.id, cwd: repo, signal: new AbortController().signal, callId: "wt-1" });

    expect(out.isError).toBe(false);
    expect(readFileSync(join(repo, "alpha.txt"), "utf8").replace(/\r\n/g, "\n")).toBe("alpha\n");
    expect(readFileSync(join(repo, "shared.txt"), "utf8").replace(/\r\n/g, "\n")).toBe("beta-override\n");
    const details = out.details as { results: subagents.SubagentResult[] };
    expect(details.results[0]?.patch).toMatchObject({ applied: true, changedFiles: ["alpha.txt"] });
    expect(details.results[1]?.patch).toMatchObject({ applied: true, changedFiles: ["shared.txt"] });
    expect(details.results[2]?.patch?.conflict).toBe(true);
    expect(details.results[2]?.patch?.patchFile && existsSync(details.results[2].patch.patchFile)).toBe(true);
    // No lingering worktrees remain in git worktree list.
    const wtList = execFileSync("git", ["worktree", "list", "--porcelain"], { cwd: repo, encoding: "utf8" });
    expect(wtList.trim().split("\n\n")).toHaveLength(1);
  });
});

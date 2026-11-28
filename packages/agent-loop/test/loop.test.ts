/**
 * Golden tests of the loop: each scenario runs against a scripted provider
 * and compares the resulting session log with test/golden/<name>.jsonl.
 */
import { Context } from "@deepseek-ai/cordis";
import { afterEach, describe, expect, it } from "vitest";
import { AgentBusyError, type AgentDelta } from "@qianji/agent";
import { LlmService } from "@qianji/llm";
import { COMPACTION_CONTINUE_SUFFIX, COMPACTION_PREFIX, Sessions, type Session } from "@qianji/session";
import { SystemPrompt } from "@qianji/system-prompt";
import { ScriptedProvider, errorReply, goldenLog, textReply, toolReply, useScriptedProvider, type ScriptedOptions, type ScriptedReply } from "@qianji/testkit";
import { Tools, textOutput } from "@qianji/tools";
import {
  AgentLoop,
  COMPACTION_REQUEST,
  DEFAULT_MAX_TURNS,
  EMPTY_TURN_CONTINUATION_PROMPT,
  FORKED_COMPACTION_REQUEST,
  LENGTH_CONTINUATION_PROMPT,
  buildCompactionWorkingSetAddendum,
  prepareSummaryMessages,
  serializeConversation,
  shrinkForSummary,
  type AgentLoopConfig,
} from "../src/index.ts";

interface Harness {
  ctx: Context;
  provider: ScriptedProvider;
  session: Session;
  deltas: AgentDelta[];
  /** Resolves the pending `slow` tool call. */
  release: () => void;
  /** Settles once a `slow` call has started. */
  slowStarted: Promise<void>;
}

let current: Context | undefined;

afterEach(async () => {
  await current?.fiber.dispose();
  current = undefined;
});

async function setup(replies: ScriptedReply[], options: { scripted?: ScriptedOptions; loop?: AgentLoopConfig } = {}): Promise<Harness> {
  const ctx = new Context();
  current = ctx;
  await ctx.plugin(LlmService, { maxAttempts: 1, baseDelayMs: 0 });
  await ctx.plugin(Sessions);
  await ctx.plugin(Tools);
  await ctx.plugin(SystemPrompt);
  await ctx.plugin(AgentLoop, options.loop ?? {});
  const provider = new ScriptedProvider(replies, options.scripted);
  useScriptedProvider(ctx, provider);
  ctx.systemPrompt.section("test", () => "You are under test.");

  let release = () => {};
  let started = () => {};
  const slowStarted = new Promise<void>((resolve) => { started = resolve; });
  ctx.tools.register<{ text: string }>({
    name: "echo",
    description: "Echo text back",
    parameters: { type: "object", properties: { text: { type: "string" } }, required: ["text"] },
    execute: ({ text }) => textOutput(text),
  });
  ctx.tools.register({
    name: "slow",
    description: "Wait until released or aborted",
    parameters: { type: "object", properties: {} },
    execute: (_args, env) => new Promise((resolve) => {
      started();
      release = () => resolve(textOutput("released"));
      env.signal.addEventListener("abort", () => resolve(textOutput("aborted", true)), { once: true });
    }),
  });

  const session = ctx.sessions.create({ cwd: "/work" });
  session.append("model", { provider: "scripted", model: "test-model" });
  const deltas: AgentDelta[] = [];
  ctx.on("session/delta", (from, _seq, delta) => {
    if (from === session) deltas.push(delta as AgentDelta);
  });
  return { ctx, provider, session, deltas, release: () => release(), slowStarted };
}

const text = (value: string) => [{ type: "text" as const, text: value }];

function waitForDelta(harness: Harness, match: (delta: AgentDelta) => boolean): Promise<void> {
  return new Promise((resolve) => {
    const dispose = harness.ctx.on("session/delta", (from, _seq, delta) => {
      if (from === harness.session && match(delta as AgentDelta)) {
        dispose();
        resolve();
      }
    });
  });
}

async function run(harness: Harness, prompt: string): Promise<void> {
  harness.ctx.agents.prompt(harness.session, text(prompt));
  await harness.ctx.agents.idle(harness.session.id);
}

const golden = (name: string) => `./golden/${name}.jsonl`;

describe("agent loop", () => {
  it("answers a prompt with text", async () => {
    const harness = await setup([textReply("Hello!")]);
    await run(harness, "Hi");
    await expect(goldenLog(harness.session)).toMatchFileSnapshot(golden("text-reply"));
    expect(harness.deltas.map((delta) => delta.type)).toEqual([
      "agent-start", "turn-start", "llm-start", "llm-chunk", "llm-chunk", "llm-chunk", "agent-end",
    ]);
    expect(harness.deltas.at(-1)).toEqual({ type: "agent-end", outcome: "done" });
    const [request] = harness.provider.requests;
    expect(request?.system).toBe("You are under test.");
    expect(request?.tools?.map((tool) => tool.name)).toEqual(["echo", "slow"]);
  });

  it("runs requested tools in parallel and appends results in call order", async () => {
    const harness = await setup([
      toolReply([
        { id: "call-1", name: "echo", args: { text: "one" } },
        { id: "call-2", name: "echo", args: { text: "two" } },
        { id: "call-3", name: "missing", args: {} },
      ], "Let me check."),
      textReply("Both said hi."),
    ]);
    await run(harness, "Echo twice");
    await expect(goldenLog(harness.session)).toMatchFileSnapshot(golden("parallel-tools"));
    const second = harness.provider.requests[1];
    expect(second?.messages.map((message) => message.role)).toEqual(["user", "assistant", "tool-result", "tool-result", "tool-result"]);
  });

  it("reports invalid tool arguments to the model instead of running the tool", async () => {
    const harness = await setup([
      toolReply([{ id: "call-1", name: "echo", args: { text: 42 } }]),
      textReply("Sorry."),
    ]);
    await run(harness, "Echo a number");
    await expect(goldenLog(harness.session)).toMatchFileSnapshot(golden("invalid-arguments"));
  });

  it("delivers a steering message after the running tools finish", async () => {
    const harness = await setup([
      toolReply([{ id: "call-1", name: "slow", args: {} }]),
      textReply("Changed course."),
    ]);
    harness.ctx.agents.prompt(harness.session, text("Start"));
    await harness.slowStarted;
    expect(harness.ctx.agents.steer(harness.session, text("Actually, stop"))).toBeUndefined();
    expect(harness.ctx.agents.status(harness.session.id)).toMatchObject({ running: true, runningTools: [{ callId: "call-1", name: "slow" }], queue: { steer: 1, followUp: 0 } });
    harness.release();
    await harness.ctx.agents.idle(harness.session.id);
    await expect(goldenLog(harness.session)).toMatchFileSnapshot(golden("steer"));
  });

  it("delivers a follow-up once the model would stop", async () => {
    const harness = await setup([textReply("First."), textReply("Second.")], { scripted: { chunkDelayMs: 5 } });
    harness.ctx.agents.prompt(harness.session, text("One"));
    harness.ctx.agents.followUp(harness.session, text("Two"));
    await harness.ctx.agents.idle(harness.session.id);
    await expect(goldenLog(harness.session)).toMatchFileSnapshot(golden("follow-up"));
  });

  it("starts a run when steered or followed up while idle", async () => {
    const harness = await setup([textReply("Ok.")]);
    expect(harness.ctx.agents.followUp(harness.session, text("Hello"))?.seq).toBe(2);
    await harness.ctx.agents.idle(harness.session.id);
    expect(harness.session.lastSeq).toBe(3);
  });

  it("refuses a second prompt while running", async () => {
    const harness = await setup([textReply("Slow.")], { scripted: { chunkDelayMs: 5 } });
    harness.ctx.agents.prompt(harness.session, text("One"));
    expect(() => harness.ctx.agents.prompt(harness.session, text("Two"))).toThrow(AgentBusyError);
    await harness.ctx.agents.idle(harness.session.id);
  });

  it("keeps the partial reply when aborted mid-stream", async () => {
    const harness = await setup([[
      { type: "text-delta", index: 0, text: "Partial" },
      { type: "text-delta", index: 0, text: " never" },
      { type: "tool-call-start", index: 1, id: "call-1", name: "echo" },
      { type: "finish", reason: "tool-use" },
    ]], { scripted: { chunkDelayMs: 5 } });
    const firstChunk = waitForDelta(harness, (delta) => delta.type === "llm-chunk");
    harness.ctx.agents.prompt(harness.session, text("Go"));
    await firstChunk;
    await harness.ctx.agents.abort(harness.session.id);
    await expect(goldenLog(harness.session)).toMatchFileSnapshot(golden("abort-stream"));
    expect(harness.deltas.at(-1)).toEqual({ type: "agent-end", outcome: "aborted" });
  });

  it("stops running tools when aborted", async () => {
    const harness = await setup([toolReply([{ id: "call-1", name: "slow", args: {} }])]);
    harness.ctx.agents.prompt(harness.session, text("Start"));
    await harness.slowStarted;
    await harness.ctx.agents.abort(harness.session.id);
    await expect(goldenLog(harness.session)).toMatchFileSnapshot(golden("abort-tool"));
  });

  it("records a provider error and stops", async () => {
    const harness = await setup([errorReply({ kind: "auth", message: "bad key", status: 401, retryable: false })]);
    await run(harness, "Hi");
    await expect(goldenLog(harness.session)).toMatchFileSnapshot(golden("provider-error"));
    expect(harness.deltas.at(-1)).toEqual({ type: "agent-end", outcome: "error" });
  });

  it("compacts and retries once when the context is too long", async () => {
    const harness = await setup([
      errorReply({ kind: "context-length", message: "too long", status: 400, retryable: false }),
      textReply("The user said hi."),
      textReply("Hello again."),
    ]);
    await run(harness, "Hi");
    await expect(goldenLog(harness.session)).toMatchFileSnapshot(golden("context-length"));
    const [, summaryCall, retry] = harness.provider.requests;
    expect(summaryCall?.tools).toBeUndefined();
    expect(summaryCall?.messages.at(-1)).toEqual({ role: "user", content: text(COMPACTION_REQUEST) });
    expect(retry?.messages).toEqual([
      { role: "user", content: text(`${COMPACTION_PREFIX}The user said hi.${COMPACTION_CONTINUE_SUFFIX}`) },
    ]);
  });

  it("compacts on request, keeping the latest turn", async () => {
    const harness = await setup([textReply("One."), textReply("Two."), textReply("Summary of one.")]);
    await run(harness, "First");
    await run(harness, "Second");
    const event = await harness.ctx.agents.compact(harness.session);
    expect(event?.data).toEqual({ throughSeq: 3, summary: "Summary of one." });
    expect(harness.session.state().messages).toEqual([
      { role: "user", content: text(`${COMPACTION_PREFIX}Summary of one.`) },
      { role: "user", content: text("Second") },
      { role: "assistant", content: text("Two.") },
    ]);
  });

  it("compacts early once a call used most of the model's context window, keeping the new prompt", async () => {
    const harness = await setup([
      textReply("One.", { inputTokens: 85_000, outputTokens: 5 }),
      textReply("Summary of one."),
      textReply("Two."),
    ]);
    let lookups = 0;
    Object.assign(harness.provider, {
      listModels: async () => {
        lookups += 1;
        return [{ id: "test-model", contextWindow: 100_000 }];
      },
    });
    await run(harness, "First");
    await run(harness, "Second");
    const [, summaryCall, answer] = harness.provider.requests;
    expect(summaryCall?.messages.at(-1)).toEqual({ role: "user", content: text(FORKED_COMPACTION_REQUEST) });
    expect(summaryCall?.messages.some((message) => JSON.stringify(message).includes("Second"))).toBe(false);
    expect(answer?.messages).toEqual([
      { role: "user", content: text(`${COMPACTION_PREFIX}Summary of one.`) },
      { role: "user", content: text("Second") },
    ]);
    // The window is looked up once and remembered.
    expect(lookups).toBe(1);
  });

  it("does not compact early when the window is unknown or the ratio is off", async () => {
    const unknown = await setup([textReply("One.", { inputTokens: 1_000_000, outputTokens: 5 }), textReply("Two.")]);
    await run(unknown, "First");
    await run(unknown, "Second");
    expect(unknown.provider.requests).toHaveLength(2);

    const off = await setup([textReply("One.", { inputTokens: 85_000, outputTokens: 5 }), textReply("Two.")], { loop: { compactAtContextRatio: 0 } });
    Object.assign(off.provider, { listModels: async () => [{ id: "test-model", contextWindow: 100_000 }] });
    await run(off, "First");
    await run(off, "Second");
    expect(off.provider.requests).toHaveLength(2);

    // A small context is never compacted, so its window is not even looked up.
    const small = await setup([textReply("One."), textReply("Two.")]);
    let lookups = 0;
    Object.assign(small.provider, { listModels: async () => { lookups += 1; return [{ id: "test-model", contextWindow: 100 }]; } });
    await run(small, "First");
    await run(small, "Second");
    expect(small.provider.requests).toHaveLength(2);
    expect(lookups).toBe(0);
  });

  it("clips the history further when even the summary request is too long", async () => {
    const tooLong = errorReply({ kind: "context-length", message: "too long", status: 400, retryable: false });
    const huge = "x".repeat(50_000);
    const harness = await setup([
      toolReply([{ id: "call-1", name: "echo", args: { text: huge } }]),
      tooLong,
      tooLong,
      textReply("Summary."),
      textReply("Done."),
    ]);
    await run(harness, "Go");
    const [, , verbatim, clipped, retry] = harness.provider.requests;
    const size = (request: typeof verbatim) => JSON.stringify(request?.messages ?? []).length;
    expect(size(verbatim)).toBeGreaterThan(100_000);
    expect(size(clipped)).toBeLessThan(30_000);
    expect(JSON.stringify(clipped?.messages)).toContain("characters omitted");
    expect(retry?.messages).toEqual([{ role: "user", content: text(`${COMPACTION_PREFIX}Summary.${COMPACTION_CONTINUE_SUFFIX}`) }]);
    expect(harness.deltas.at(-1)).toEqual({ type: "agent-end", outcome: "done" });
  });

  it("shrinks long text, tool arguments and images for a summary, but not the model's own text", () => {
    const long = "a".repeat(5_000);
    const shrunk = shrinkForSummary([
      { role: "user", content: [{ type: "text", text: long }, { type: "image", mimeType: "image/png", data: "AAAA" }] },
      { role: "assistant", content: [{ type: "text", text: long }, { type: "tool-call", id: "c", name: "write", arguments: { path: "a.ts", content: long, edits: [{ newText: long }] } }] },
      { role: "tool-result", callId: "c", content: [{ type: "text", text: "short" }], isError: false },
    ], 1_000);
    expect(shrunk[0]?.content).toEqual([
      { type: "text", text: `${"a".repeat(500)}\n[… 4000 characters omitted …]\n${"a".repeat(500)}` },
      { type: "text", text: "[image omitted]" },
    ]);
    const assistant = shrunk[1]?.content;
    expect(assistant?.[0]).toEqual({ type: "text", text: long });
    expect(JSON.stringify(assistant?.[1]).length).toBeLessThan(3_000);
    expect(assistant?.[1]).toMatchObject({ type: "tool-call", arguments: { path: "a.ts" } });
    expect(shrunk[2]?.content).toEqual([{ type: "text", text: "short" }]);
  });

  it("stops after the turn limit", async () => {
    const harness = await setup([
      toolReply([{ id: "call-1", name: "echo", args: { text: "a" } }]),
      toolReply([{ id: "call-2", name: "echo", args: { text: "b" } }]),
    ], { loop: { maxTurns: 2 } });
    await run(harness, "Loop");
    expect(harness.deltas.at(-1)).toEqual({ type: "agent-end", outcome: "max-turns" });
    expect(harness.provider.remaining).toBe(0);
  });

  it("fires the lifecycle events in order", async () => {
    const harness = await setup([toolReply([{ id: "call-1", name: "echo", args: { text: "a" } }]), textReply("Done.")]);
    const seen: string[] = [];
    harness.ctx.on("agent/before-start", () => void seen.push("before-start"));
    harness.ctx.on("agent/turn-start", (_session, turn) => void seen.push(`turn-start ${turn}`));
    harness.ctx.on("agent/turn-end", (_session, turn) => void seen.push(`turn-end ${turn}`));
    harness.ctx.on("agent/settled", async (_session, outcome) => void seen.push(`settled ${outcome}`));
    harness.ctx.on("tools/pre-execute", (call) => (call.name === "echo" ? { deny: true, reason: "not today" } : undefined));
    await run(harness, "Go");
    expect(seen).toEqual(["before-start", "turn-start 1", "turn-end 1", "turn-start 2", "turn-end 2", "settled done"]);
    const result = harness.session.events.find((event) => event.type === "tool-result");
    expect(result?.data).toMatchObject({ isError: true, content: text("Denied: not today") });
  });

  it("continues automatically on finish_reason length and bounds repeated truncations", async () => {
    const truncated = [{ type: "text-delta" as const, index: 0, text: "Working on it..." }, { type: "finish" as const, reason: "length" as const }];
    const harness = await setup([
      truncated,
      toolReply([{ id: "call-1", name: "echo", args: { text: "ok" } }]),
      textReply("All finished."),
    ]);
    await run(harness, "Complete multi-step task");
    expect(harness.deltas.at(-1)).toEqual({ type: "agent-end", outcome: "done" });
    expect(harness.provider.requests).toHaveLength(3);
    expect(harness.provider.requests[1]?.messages.at(-1)).toEqual({ role: "user", content: text(LENGTH_CONTINUATION_PROMPT) });

    // Bounded at MAX_LENGTH_CONTINUATIONS (3): initial + 3 retries = 4 calls total
    const bounded = await setup([truncated, truncated, truncated, truncated, textReply("unreachable")]);
    await run(bounded, "Truncate repeatedly");
    expect(bounded.deltas.at(-1)).toEqual({ type: "agent-end", outcome: "done" });
    expect(bounded.provider.requests).toHaveLength(4);
  });

  it("retries automatically when a model stops with thinking only or empty text", async () => {
    const thinkingOnly = [
      { type: "thinking-delta" as const, index: 0, text: "thinking without acting" },
      { type: "finish" as const, reason: "stop" as const },
    ];
    const harness = await setup([
      thinkingOnly,
      textReply("Here is the answer."),
    ]);
    await run(harness, "Investigate");
    expect(harness.deltas.at(-1)).toEqual({ type: "agent-end", outcome: "done" });
    expect(harness.provider.requests).toHaveLength(2);
    expect(harness.provider.requests[1]?.messages.at(-1)).toEqual({
      role: "user",
      content: [...text("Investigate"), ...text(`\n\n${EMPTY_TURN_CONTINUATION_PROMPT}`)],
    });
  });

  it("nudges continuation via agent/before-stop and stops after the bound when no tools run", async () => {
    const harness = await setup([
      textReply("I will check a.ts next."),
      toolReply([{ id: "call-1", name: "echo", args: { text: "checked" } }]),
      textReply("Done after checking."),
    ]);
    let stopChecks = 0;
    harness.ctx.on("agent/before-stop", () => {
      stopChecks += 1;
      return stopChecks === 1 ? "Continue executing with tools instead of stopping." : undefined;
    });
    await run(harness, "Check a.ts");
    expect(stopChecks).toBe(2);
    expect(harness.provider.requests).toHaveLength(3);
    expect(harness.deltas.at(-1)).toEqual({ type: "agent-end", outcome: "done" });

    // Bounded by MAX_PLUGIN_CONTINUATIONS (2) even if listener always returns a nudge
    const capped = await setup([textReply("1"), textReply("2"), textReply("3"), textReply("4")]);
    capped.ctx.on("agent/before-stop", () => "Keep going");
    await run(capped, "Stop test");
    expect(capped.provider.requests).toHaveLength(3);
    expect(capped.deltas.at(-1)).toEqual({ type: "agent-end", outcome: "done" });
  });

  it("performs mid-run sliding compaction keeping the newest complete step verbatim", async () => {
    const heavyStep2 = [
      ...toolReply([{ id: "call-2", name: "echo", args: { text: "step-2-recent" } }]).slice(0, -2),
      { type: "usage" as const, usage: { inputTokens: 90_000, outputTokens: 100 } },
      { type: "finish" as const, reason: "tool-use" as const },
    ];
    const harness = await setup([
      toolReply([{ id: "call-1", name: "echo", args: { text: "step-1" } }]),
      heavyStep2,
      textReply("Earlier step-1 done."),
      textReply("Final answer."),
    ], {
      loop: { compactAboveTokens: 50_000, keepRecentTokens: 500 },
    });
    await run(harness, "Investigate two steps");
    // Requests: [turn 1, turn 2, sliding summary call (at start of turn 3), turn 3]
    expect(harness.provider.requests).toHaveLength(4);
    const [, , summaryCall, resumedCall] = harness.provider.requests;
    expect(JSON.stringify(summaryCall?.messages)).toContain("step-1");
    expect(JSON.stringify(summaryCall?.messages)).not.toContain("step-2-recent");
    expect(resumedCall?.messages[0]).toEqual({
      role: "user",
      content: text(`${COMPACTION_PREFIX}Earlier step-1 done.${COMPACTION_CONTINUE_SUFFIX}`),
    });
    expect(JSON.stringify(resumedCall?.messages.slice(1))).toContain("step-2-recent");
    expect(JSON.stringify(resumedCall?.messages.slice(1))).not.toContain("step-1");
    expect(harness.deltas.at(-1)).toEqual({ type: "agent-end", outcome: "done" });
  });

  it("partitions consecutive readOnly tools into concurrent batches with serial write barriers", async () => {
    const harness = await setup([
      toolReply([
        { id: "c1", name: "read_a", args: {} },
        { id: "c2", name: "read_b", args: {} },
        { id: "c3", name: "write_x", args: {} },
        { id: "c4", name: "read_c", args: {} },
      ]),
      textReply("All done."),
    ]);

    const timeline: string[] = [];
    const gates = new Map<string, () => void>();
    const started = new Map<string, Promise<void>>();
    const makeGateTool = (name: string, readOnly: boolean, out: string) => {
      let markStarted = () => {};
      started.set(name, new Promise<void>((resolve) => { markStarted = resolve; }));
      harness.ctx.tools.register({
        name,
        readOnly,
        description: name,
        parameters: { type: "object", properties: {} },
        execute: () => new Promise((resolve) => {
          timeline.push(`start:${name}`);
          markStarted();
          gates.set(name, () => {
            timeline.push(`end:${name}`);
            resolve(textOutput(out));
          });
        }),
      });
    };

    makeGateTool("read_a", true, "a");
    makeGateTool("read_b", true, "b");
    makeGateTool("write_x", false, "x");
    makeGateTool("read_c", true, "c");

    harness.ctx.agents.prompt(harness.session, text("Run batch"));

    // Both consecutive readOnly tools overlap concurrently before write_x starts.
    await Promise.all([started.get("read_a"), started.get("read_b")]);
    expect(timeline).toEqual(["start:read_a", "start:read_b"]);

    gates.get("read_a")?.();
    gates.get("read_b")?.();
    await started.get("write_x");
    expect(timeline.slice(0, 5)).toEqual(["start:read_a", "start:read_b", "end:read_a", "end:read_b", "start:write_x"]);
    expect(timeline).not.toContain("start:read_c");

    gates.get("write_x")?.();
    await started.get("read_c");
    expect(timeline.slice(5, 7)).toEqual(["end:write_x", "start:read_c"]);

    gates.get("read_c")?.();
    await harness.ctx.agents.idle(harness.session.id);

    expect(timeline).toEqual([
      "start:read_a",
      "start:read_b",
      "end:read_a",
      "end:read_b",
      "start:write_x",
      "end:write_x",
      "start:read_c",
      "end:read_c",
    ]);

    const toolCalls = harness.session.events.filter((event) => event.type === "tool-call").map((event) => event.data.callId);
    const toolResults = harness.session.events
      .filter((event) => event.type === "tool-result")
      .map((event) => ({ callId: event.data.callId, text: event.data.content[0]?.type === "text" ? event.data.content[0].text : "" }));
    expect(toolCalls).toEqual(["c1", "c2", "c3", "c4"]);
    expect(toolResults).toEqual([
      { callId: "c1", text: "a" },
      { callId: "c2", text: "b" },
      { callId: "c3", text: "x" },
      { callId: "c4", text: "c" },
    ]);
  });

  it("emits an error tool-result for every tool-call even when ctx.tools.execute rejects unexpectedly", async () => {
    const harness = await setup([
      toolReply([
        { id: "c1", name: "read_ok", args: {} },
        { id: "c2", name: "read_boom", args: {} },
        { id: "c3", name: "echo", args: { text: "tail" } },
      ]),
      textReply("Recovered."),
    ]);

    harness.ctx.tools.register({
      name: "read_ok",
      readOnly: true,
      description: "Read ok",
      parameters: { type: "object", properties: {} },
      execute: () => textOutput("ok"),
    });
    harness.ctx.tools.register({
      name: "read_boom",
      readOnly: true,
      description: "Read boom",
      parameters: { type: "object", properties: {} },
      execute: () => textOutput("never"),
    });

    const origExecute = harness.ctx.tools.execute.bind(harness.ctx.tools);
    harness.ctx.tools.execute = async (call, env) => {
      if (call.name === "read_boom") throw new Error("unexpected execute rejection");
      return origExecute(call, env);
    };

    await run(harness, "Trigger rejection");

    const calls = harness.session.events.filter((event) => event.type === "tool-call");
    const results = harness.session.events.filter((event) => event.type === "tool-result");
    expect(calls.map((event) => event.data.callId)).toEqual(["c1", "c2", "c3"]);
    expect(results.map((event) => ({ callId: event.data.callId, isError: event.data.isError }))).toEqual([
      { callId: "c1", isError: false },
      { callId: "c2", isError: true },
      { callId: "c3", isError: false },
    ]);
    expect(results[1]?.data.content[0]).toEqual({ type: "text", text: "read_boom failed: unexpected execute rejection" });
    expect(harness.ctx.agents.status(harness.session.id)).toMatchObject({ running: false, runningTools: [] });
    const toolEnds = harness.deltas.filter((delta) => delta.type === "tool-end");
    expect(toolEnds).toHaveLength(3);
    expect(toolEnds.slice(0, 2)).toEqual(expect.arrayContaining([
      { type: "tool-end", callId: "c1", isError: false },
      { type: "tool-end", callId: "c2", isError: true },
    ]));
    expect(toolEnds[2]).toEqual({ type: "tool-end", callId: "c3", isError: false });
  });

  it("rehydrates touched file paths and latest update_plan items after compaction while leaving echo-only compactions unchanged", async () => {
    const echoOnlyEvents = [
      { seq: 1, ts: "t", type: "user" as const, data: { content: text("hi") } },
      { seq: 2, ts: "t", type: "tool-call" as const, data: { callId: "c1", name: "echo", args: { text: "ok" } } },
    ];
    expect(buildCompactionWorkingSetAddendum(echoOnlyEvents, 2)).toBe("");

    const richEvents = [
      { seq: 1, ts: "t", type: "tool-call" as const, data: { callId: "c1", name: "read", args: { path: "src/old.ts" } } },
      { seq: 2, ts: "t", type: "tool-call" as const, data: { callId: "c2", name: "read", args: { path: "src/a.ts" } } },
      { seq: 3, ts: "t", type: "tool-call" as const, data: { callId: "c3", name: "edit", args: { path: "src/a.ts" } } },
      { seq: 4, ts: "t", type: "tool-call" as const, data: { callId: "c4", name: "write", args: { file_path: "src/b.ts" } } },
      { seq: 5, ts: "t", type: "tool-call" as const, data: { callId: "c5", name: "read", args: { path: "src/c.ts" } } },
      { seq: 6, ts: "t", type: "tool-call" as const, data: { callId: "c6", name: "read", args: { path: "src/d.ts" } } },
      { seq: 7, ts: "t", type: "tool-call" as const, data: { callId: "c7", name: "read", args: { path: "src/e.ts" } } },
      { seq: 8, ts: "t", type: "tool-call" as const, data: { callId: "c8", name: "read", args: { path: "src/f.ts" } } },
      { seq: 9, ts: "t", type: "tool-call" as const, data: { callId: "c9", name: "read", args: { path: "src/g.ts" } } },
      { seq: 10, ts: "t", type: "tool-call" as const, data: { callId: "c10", name: "read", args: { path: "src/h.ts" } } },
      { seq: 11, ts: "t", type: "tool-call" as const, data: { callId: "c11", name: "update_plan", args: { items: [{ id: "0", text: "Stale plan", status: "pending" }] } } },
      { seq: 12, ts: "t", type: "tool-call" as const, data: { callId: "c12", name: "update_plan", args: { plan: [{ step: "Finish edit", status: "in_progress" }, { step: "Run tests", status: "pending" }] } } },
      { seq: 13, ts: "t", type: "tool-call" as const, data: { callId: "c13", name: "write", args: { path: "src/after-through-seq.ts" } } },
    ];
    const addendum = buildCompactionWorkingSetAddendum(richEvents, 12);
    expect(addendum).toContain("[Working-set context]");
    expect(addendum).toContain("src/a.ts (modified)");
    expect(addendum).toContain("src/b.ts (modified)");
    expect(addendum).toContain("src/h.ts (read)");
    expect(addendum).not.toContain("src/old.ts");
    expect(addendum).not.toContain("src/after-through-seq.ts");
    expect(addendum).toContain("Finish edit");
    expect(addendum).toContain("Run tests");
    expect(addendum).not.toContain("Stale plan");

    const harness = await setup([
      toolReply([
        { id: "c1", name: "read", args: { path: "src/main.ts" } },
        { id: "c2", name: "edit", args: { path: "src/main.ts" } },
        { id: "c3", name: "update_plan", args: { items: [{ id: "p1", text: "Patch main", status: "completed" }, { id: "p2", text: "Verify", status: "in_progress" }] } },
      ]),
      textReply("Updated main."),
      textReply("Follow-up reply."),
      textReply("Concise summary."),
    ]);
    harness.ctx.tools.register<{ path: string }>({
      name: "read",
      readOnly: true,
      description: "Read",
      parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
      execute: ({ path }) => textOutput(`read:${path}`),
    });
    harness.ctx.tools.register<{ path: string }>({
      name: "edit",
      description: "Edit",
      parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
      execute: ({ path }) => textOutput(`edited:${path}`),
    });
    harness.ctx.tools.register<{ items: unknown[] }>({
      name: "update_plan",
      description: "Plan",
      parameters: { type: "object", properties: { items: { type: "array" } }, required: ["items"] },
      execute: () => textOutput("plan updated"),
    });

    await run(harness, "First");
    await run(harness, "Second");
    const compaction = await harness.ctx.agents.compact(harness.session);
    expect(compaction?.data.summary).toContain("Concise summary.");
    expect(compaction?.data.summary).toContain("[Working-set context]");
    expect(compaction?.data.summary).toContain("src/main.ts (modified)");
    expect(compaction?.data.summary).toContain("[completed] (p1) Patch main");
    expect(compaction?.data.summary).toContain("[in_progress] (p2) Verify");
  });

  it("serializes compaction history as pure text with structured headings, omitting wire tool/image blocks", async () => {
    for (const heading of ["## Goal", "## Constraints & Preferences", "## Progress", "## Key Decisions", "## Next Steps"]) {
      expect(COMPACTION_REQUEST).toContain(heading);
    }

    const sampleMessages = [
      { role: "user" as const, content: text(`${COMPACTION_PREFIX}Earlier summary body.`) },
      {
        role: "user" as const,
        content: [
          { type: "text" as const, text: "Inspect screenshot" },
          { type: "image" as const, mimeType: "image/png", data: "BASE64DATA" },
        ],
      },
      {
        role: "assistant" as const,
        content: [
          { type: "thinking" as const, text: "internal reasoning" },
          { type: "text" as const, text: "Running tool" },
          { type: "tool-call" as const, id: "tc-1", name: "echo", arguments: { text: "hi" } },
        ],
      },
      {
        role: "tool-result" as const,
        callId: "tc-1",
        content: [
          { type: "text" as const, text: "hi" },
          { type: "image" as const, mimeType: "image/png", data: "MOREBASE64" },
        ],
        isError: false,
      },
    ];

    const prepared = prepareSummaryMessages(sampleMessages);
    expect(JSON.stringify(prepared)).not.toContain("BASE64DATA");
    expect(JSON.stringify(prepared)).toContain("[image omitted]");

    const serialized = serializeConversation(sampleMessages);
    expect(serialized).toHaveLength(1);
    expect(serialized[0]?.role).toBe("user");
    const serializedText = serialized[0]?.content.map((b) => (b.type === "text" ? b.text : "")).join("\n") ?? "";
    expect(serializedText).toContain("<previous-summary>\nEarlier summary body.\n</previous-summary>");
    expect(serializedText).toContain("<conversation>");
    expect(serializedText).toContain("</conversation>");
    expect(serializedText).toContain("[image omitted]");
    expect(serializedText).not.toContain("BASE64DATA");
    expect(JSON.stringify(serialized)).not.toContain('"type":"tool-call"');
    expect(JSON.stringify(serialized)).not.toContain('"type":"tool-result"');
    expect(JSON.stringify(serialized)).not.toContain('"type":"image"');

    // End-to-end 2nd compaction keeps wire messages pure text + COMPACTION_REQUEST without tools when samePrefixCompaction is disabled
    const harness = await setup([
      toolReply([{ id: "call-1", name: "echo", args: { text: "one" } }]),
      textReply("First answer."),
      textReply("Second answer."),
      textReply("Compaction #1."),
      textReply("Third answer."),
      textReply("Fourth answer."),
      textReply("Compaction #2."),
    ], { loop: { samePrefixCompaction: false } });
    await run(harness, "Prompt 1");
    await run(harness, "Prompt 2");
    await harness.ctx.agents.compact(harness.session);
    await run(harness, "Prompt 3");
    await run(harness, "Prompt 4");
    await harness.ctx.agents.compact(harness.session);

    const secondCompactionReq = harness.provider.requests.at(-1);
    expect(secondCompactionReq?.tools).toBeUndefined();
    expect(secondCompactionReq?.messages).toHaveLength(2);
    expect(secondCompactionReq?.messages.every((m) => m.role === "user")).toBe(true);
    expect(secondCompactionReq?.messages[1]).toEqual({ role: "user", content: text(COMPACTION_REQUEST) });
    const historyBlock = secondCompactionReq?.messages[0]?.content[0];
    expect(historyBlock?.type).toBe("text");
    if (historyBlock?.type === "text") {
      expect(historyBlock.text).toContain("<previous-summary>");
      expect(historyBlock.text).toContain("Compaction #1.");
      expect(historyBlock.text).toContain("<conversation>");
    }
  });

  it("carries forward working-set files and latest plan across multiple compactions", () => {
    const events = [
      { seq: 1, ts: "t", type: "tool-call" as const, data: { callId: "c0", name: "read", args: { path: "src/evicted.ts" } } },
      {
        seq: 2,
        ts: "t",
        type: "compaction" as const,
        data: {
          throughSeq: 1,
          summary: [
            "Summary #1.",
            "",
            "[Working-set context]",
            "Recent files touched:",
            "- src/f1.ts (modified)",
            "- src/f2.ts (read)",
            "- src/f3.ts (read)",
            "- src/f4.ts (read)",
            "- src/f5.ts (read)",
            "- src/evicted.ts (read)",
            "Latest plan:",
            "- [completed] (p1) Step 1",
            "- [in_progress] (p2) Step 2",
          ].join("\n"),
        },
      },
      { seq: 3, ts: "t", type: "tool-call" as const, data: { callId: "c1", name: "read", args: { path: "src/f2.ts" } } },
      { seq: 4, ts: "t", type: "tool-call" as const, data: { callId: "c2", name: "edit", args: { path: "src/f6.ts" } } },
      { seq: 5, ts: "t", type: "tool-call" as const, data: { callId: "c3", name: "write", args: { path: "src/f7.ts" } } },
      { seq: 6, ts: "t", type: "tool-call" as const, data: { callId: "c4", name: "read", args: { path: "src/f8.ts" } } },
    ];

    const addendum = buildCompactionWorkingSetAddendum(events, 6);
    expect(addendum).toContain("[Working-set context]");
    expect(addendum).not.toContain("src/evicted.ts");
    expect(addendum).toContain("src/f1.ts (modified)");
    expect(addendum).toContain("src/f2.ts (read)");
    expect(addendum).toContain("src/f6.ts (modified)");
    expect(addendum).toContain("src/f8.ts (read)");
    expect(addendum).toContain("- [completed] (p1) Step 1");
    expect(addendum).toContain("- [in_progress] (p2) Step 2");
  });

  it("includes trailing events after the last assistant turn in proactive compaction threshold checks", async () => {
    const harness = await setup([
      textReply("One.", { inputTokens: 60_000, outputTokens: 500 }),
      textReply("Summary with trailing tokens."),
      textReply("Two."),
    ]);
    Object.assign(harness.provider, {
      listModels: async () => [{ id: "test-model", contextWindow: 100_000 }],
    });

    await run(harness, "First");
    // Append a trailing tool-result whose CJK content adds ~30k estimated tokens (> 80% of 100k when combined with 60.5k)
    harness.session.append("tool-call", { callId: "c-big", name: "echo", args: { text: "x" } });
    harness.session.append("tool-result", {
      callId: "c-big",
      name: "echo",
      content: text("中".repeat(40_000)),
      isError: false,
    });
    await run(harness, "Follow-up question");

    const compactionEvents = harness.session.events.filter((e) => e.type === "compaction");
    expect(compactionEvents).toHaveLength(1);
    expect(compactionEvents[0]?.data.summary).toContain("Summary with trailing tokens.");
    const finalAnswerReq = harness.provider.requests.at(-1);
    expect(finalAnswerReq?.messages).toEqual([
      { role: "user", content: text(`${COMPACTION_PREFIX}Summary with trailing tokens.`) },
      { role: "user", content: text("Follow-up question") },
    ]);
  });

  it("preempts later tool batches on queued steer while maintaining 1:1 tool-call/result pairing", async () => {
    let slowRoStarted = () => {};
    const roStarted = new Promise<void>((resolve) => { slowRoStarted = resolve; });
    let releaseSlowRo = () => {};
    let mutCount = 0;
    let fastAfterMutCount = 0;

    const harness = await setup([
      toolReply([
        { id: "c1", name: "slow_ro", args: {} },
        { id: "c2", name: "fast_ro", args: { phase: "batch0" } },
        { id: "c3", name: "write_mut", args: {} },
        { id: "c4", name: "fast_ro", args: { phase: "batch2" } },
      ]),
      textReply("Steered course."),
    ]);

    harness.ctx.tools.register({
      name: "slow_ro",
      readOnly: true,
      description: "Slow read-only tool",
      parameters: { type: "object", properties: {} },
      execute: () => new Promise((resolve) => {
        slowRoStarted();
        releaseSlowRo = () => resolve(textOutput("slow done"));
      }),
    });
    harness.ctx.tools.register<{ phase: string }>({
      name: "fast_ro",
      readOnly: true,
      description: "Fast read-only tool",
      parameters: { type: "object", properties: { phase: { type: "string" } }, required: ["phase"] },
      execute: ({ phase }) => {
        if (phase === "batch2") fastAfterMutCount += 1;
        return textOutput(`fast:${phase}`);
      },
    });
    harness.ctx.tools.register({
      name: "write_mut",
      description: "Mutating tool",
      parameters: { type: "object", properties: {} },
      execute: () => {
        mutCount += 1;
        return textOutput("mutated");
      },
    });

    harness.ctx.agents.prompt(harness.session, text("Start multi-batch"));
    await roStarted;
    harness.ctx.agents.steer(harness.session, text("Abort remaining batches"));
    releaseSlowRo();
    await harness.ctx.agents.idle(harness.session.id);

    expect(mutCount).toBe(0);
    expect(fastAfterMutCount).toBe(0);

    const toolCalls = harness.session.events.filter((e) => e.type === "tool-call");
    const toolResults = harness.session.events.filter((e) => e.type === "tool-result");
    expect(toolCalls.map((e) => e.data.callId)).toEqual(["c1", "c2", "c3", "c4"]);
    expect(toolResults.map((e) => e.data.callId)).toEqual(["c1", "c2", "c3", "c4"]);
    expect(toolResults[0]?.data.isError).toBe(false);
    expect(toolResults[1]?.data.isError).toBe(false);
    expect(toolResults[2]?.data).toMatchObject({
      callId: "c3",
      isError: true,
      content: [{ type: "text", text: "Skipped due to queued user steering message." }],
    });
    expect(toolResults[3]?.data).toMatchObject({
      callId: "c4",
      isError: true,
      content: [{ type: "text", text: "Skipped due to queued user steering message." }],
    });

    const skippedEnds = harness.deltas.filter((d) => d.type === "tool-end" && (d.callId === "c3" || d.callId === "c4"));
    expect(skippedEnds).toEqual([
      { type: "tool-end", callId: "c3", isError: true },
      { type: "tool-end", callId: "c4", isError: true },
    ]);

    const secondReq = harness.provider.requests[1];
    expect(secondReq?.messages.at(-1)).toEqual({ role: "user", content: text("Abort remaining batches") });
  });

  it("emits live tool-progress deltas before tool-end and ignores late progress after completion", async () => {
    let savedOnProgress: ((text: string) => void) | undefined;
    const harness = await setup([
      toolReply([{ id: "c1", name: "prog", args: {} }]),
      textReply("Completed."),
    ]);

    harness.ctx.tools.register({
      name: "prog",
      description: "Tool emitting progress",
      parameters: { type: "object", properties: {} },
      execute: async (_args, env) => {
        savedOnProgress = env.onProgress;
        env.onProgress?.("step 1");
        await Promise.resolve();
        env.onProgress?.("step 2");
        return textOutput("final output");
      },
    });

    await run(harness, "Run progress tool");
    savedOnProgress?.("late update");

    const progressDeltas = harness.deltas.filter((d) => d.type === "tool-progress");
    expect(progressDeltas).toEqual([
      { type: "tool-progress", callId: "c1", name: "prog", text: "step 1" },
      { type: "tool-progress", callId: "c1", name: "prog", text: "step 2" },
    ]);

    const startIndex = harness.deltas.findIndex((d) => d.type === "tool-start" && d.callId === "c1");
    const firstProgIndex = harness.deltas.findIndex((d) => d.type === "tool-progress" && d.callId === "c1");
    const endIndex = harness.deltas.findIndex((d) => d.type === "tool-end" && d.callId === "c1");
    expect(startIndex).toBeGreaterThanOrEqual(0);
    expect(firstProgIndex).toBeGreaterThan(startIndex);
    expect(endIndex).toBeGreaterThan(firstProgIndex);
  });

  it("stops immediately when aborted mid-proactive-compaction on a multi-turn run", async () => {
    let onCompactionStarted = () => {};
    const compactionStarted = new Promise<void>((resolve) => {
      onCompactionStarted = resolve;
    });
    const harness = await setup(
      [
        textReply("Step 1.", { inputTokens: 2_000, outputTokens: 5 }),
        async function* (_request, signal) {
          let release = () => {};
          const gate = new Promise<void>((resolve) => {
            release = resolve;
          });
          signal.addEventListener("abort", release, { once: true });
          yield { type: "text-delta", index: 0, text: "Partial summary" };
          onCompactionStarted();
          await gate;
          yield { type: "finish", reason: "stop" };
        },
        textReply("Should never run after abort."),
      ],
      { loop: { compactAboveTokens: 1_000 } },
    );

    await run(harness, "First turn");
    harness.ctx.agents.prompt(harness.session, text("Multi-turn follow-up"));
    await compactionStarted;
    await harness.ctx.agents.abort(harness.session.id);

    expect(harness.deltas.at(-1)).toEqual({ type: "agent-end", outcome: "aborted" });
    expect(harness.deltas).toContainEqual({ type: "compaction-end", ok: false, aborted: true });
    expect(harness.provider.requests).toHaveLength(2);
    expect(harness.session.events.some((event) => event.type === "compaction")).toBe(false);
  });

  it("stops with aborted instead of recording a context-length error when aborted mid-emergency compaction", async () => {
    let onCompactionStarted = () => {};
    const compactionStarted = new Promise<void>((resolve) => {
      onCompactionStarted = resolve;
    });
    const harness = await setup([
      errorReply({ kind: "context-length", message: "too long", status: 400, retryable: false }),
      async function* (_request, signal) {
        let release = () => {};
        const gate = new Promise<void>((resolve) => {
          release = resolve;
        });
        signal.addEventListener("abort", release, { once: true });
        yield { type: "text-delta", index: 0, text: "Emergency summary" };
        onCompactionStarted();
        await gate;
        yield { type: "finish", reason: "stop" };
      },
    ]);

    harness.ctx.agents.prompt(harness.session, text("Overflow turn"));
    await compactionStarted;
    await harness.ctx.agents.abort(harness.session.id);

    expect(harness.deltas.at(-1)).toEqual({ type: "agent-end", outcome: "aborted" });
    expect(harness.deltas).toContainEqual({ type: "compaction-end", ok: false, aborted: true });
    expect(harness.session.events.some((event) => event.type === "assistant" && event.data.stop === "error")).toBe(false);
  });

  it("clears queued counts and skips remaining serial tool batches when aborted", async () => {
    let afterCalls = 0;
    const harness = await setup([
      toolReply([
        { id: "c1", name: "slow", args: {} },
        { id: "c2", name: "after", args: {} },
      ]),
      textReply("Should never run."),
    ]);
    harness.ctx.tools.register({
      name: "after",
      description: "Serial tool after slow",
      parameters: { type: "object", properties: {} },
      execute: () => {
        afterCalls += 1;
        return textOutput("after ran");
      },
    });

    harness.ctx.agents.prompt(harness.session, text("Run serial tools"));
    await harness.slowStarted;
    harness.ctx.agents.steer(harness.session, text("queued steer"));
    harness.ctx.agents.followUp(harness.session, text("queued followUp"));
    await harness.ctx.agents.abort(harness.session.id);

    expect(afterCalls).toBe(0);
    expect(harness.deltas).toContainEqual({ type: "queue", steer: 0, followUp: 0 });
    expect(harness.deltas.some((d) => d.type === "tool-start" && d.callId === "c2")).toBe(false);
    expect(harness.deltas.at(-1)).toEqual({ type: "agent-end", outcome: "aborted" });
    const toolResults = harness.session.events.filter((event) => event.type === "tool-result");
    expect(toolResults.map((event) => event.data.callId)).toEqual(["c1", "c2"]);
    expect(toolResults[1]?.data).toMatchObject({
      callId: "c2",
      isError: true,
      content: [{ type: "text", text: "Aborted." }],
    });
  });

  it("defaults DEFAULT_MAX_TURNS to 500 so >100 multi-step tool runs finish cleanly", async () => {
    expect(DEFAULT_MAX_TURNS).toBe(500);
    const steps = Array.from({ length: 105 }, (_, i) =>
      toolReply([{ id: `call-${i + 1}`, name: "echo", args: { text: `step-${i + 1}` } }]),
    );
    const harness = await setup([...steps, textReply("Completed 105 tool steps.")]);
    await run(harness, "Run >100 steps");
    expect(harness.deltas.at(-1)).toEqual({ type: "agent-end", outcome: "done" });
    expect(harness.provider.requests).toHaveLength(106);
  });

  it("treats closed and unclosed inline <think> text-delta turns as empty, retrying and keeping post-tool continuations on tool-result", async () => {
    const inlineClosedThink = [
      { type: "text-delta" as const, index: 0, text: "<think>let me reason silently</think>" },
      { type: "finish" as const, reason: "stop" as const },
    ];
    const inlineUnclosedThink = [
      { type: "text-delta" as const, index: 0, text: "  <think>\ntruncated thought without closing tag" },
      { type: "finish" as const, reason: "stop" as const },
    ];

    // 1. Direct prompt -> closed inline <think> -> unclosed inline <think> -> final visible prose
    const direct = await setup([
      inlineClosedThink,
      inlineUnclosedThink,
      textReply("<think>done thinking</think>\nVisible final answer."),
    ]);
    await run(direct, "Solve");
    expect(direct.deltas.at(-1)).toEqual({ type: "agent-end", outcome: "done" });
    expect(direct.provider.requests).toHaveLength(3);
    expect(direct.provider.requests[1]?.messages).toEqual([
      { role: "user", content: [...text("Solve"), ...text(`\n\n${EMPTY_TURN_CONTINUATION_PROMPT}`)] },
    ]);
    expect(direct.provider.requests[2]?.messages).toEqual([
      {
        role: "user",
        content: [
          ...text("Solve"),
          ...text(`\n\n${EMPTY_TURN_CONTINUATION_PROMPT}`),
          ...text(`\n\n${EMPTY_TURN_CONTINUATION_PROMPT}`),
        ],
      },
    ]);

    // 2. Post-tool turn emits inline <think> only -> continuation attaches to tool-result, keeping lastUserIndex at 0
    const toolWithThinking = [
      { type: "thinking-delta" as const, index: 0, text: "Inspecting via echo tool" },
      ...toolReply([{ id: "call-1", name: "echo", args: { text: "tool-ok" } }]).map((chunk) =>
        "index" in chunk ? { ...chunk, index: chunk.index + 1 } : chunk,
      ),
    ];
    const postTool = await setup([
      toolWithThinking,
      inlineClosedThink,
      textReply("Summary after tool."),
    ]);
    await run(postTool, "Inspect and summarize");
    expect(postTool.deltas.at(-1)).toEqual({ type: "agent-end", outcome: "done" });
    expect(postTool.provider.requests).toHaveLength(3);
    const thirdReqMessages = postTool.provider.requests[2]?.messages ?? [];
    expect(thirdReqMessages.map((m) => m.role)).toEqual(["user", "assistant", "tool-result"]);
    expect(thirdReqMessages.findLastIndex((m) => m.role === "user")).toBe(0);
    expect(thirdReqMessages[1]).toEqual({
      role: "assistant",
      content: [
        { type: "thinking", text: "Inspecting via echo tool" },
        { type: "tool-call", id: "call-1", name: "echo", arguments: { text: "tool-ok" } },
      ],
    });
    expect(thirdReqMessages[2]).toEqual({
      role: "tool-result",
      callId: "call-1",
      content: [
        { type: "text", text: "tool-ok" },
        { type: "text", text: `\n\n${EMPTY_TURN_CONTINUATION_PROMPT}` },
      ],
      isError: false,
    });

    // 3. <thinking>...</thinking> is also treated as inline thinking (retries instead of finishing with raw <thinking>),
    // while non-thinking XML/HTML tags (<custom>, <div>) count as visible text and finish without retry.
    const inlineThinkingTurn = await setup([
      textReply("<thinking>The bash tool is running in PowerShell...</thinking>"),
      textReply("<thinking>done</thinking>\nClean final output."),
    ]);
    await run(inlineThinkingTurn, "Run check");
    expect(inlineThinkingTurn.provider.requests).toHaveLength(2);
    expect(inlineThinkingTurn.deltas.at(-1)).toEqual({ type: "agent-end", outcome: "done" });

    const xmlVisible = await setup([textReply("<custom>custom xml output</custom>")]);
    await run(xmlVisible, "Emit XML");
    expect(xmlVisible.provider.requests).toHaveLength(1);
    expect(xmlVisible.deltas.at(-1)).toEqual({ type: "agent-end", outcome: "done" });
  });

  it("persists an assistant error event when an unexpected exception escapes the loop", async () => {
    const harness = await setup([textReply("unreachable")]);
    harness.ctx.on("agent/before-start", () => {
      throw new Error("provider credential store locked");
    });

    await run(harness, "Trigger failure");

    expect(harness.deltas.at(-1)).toEqual({ type: "agent-end", outcome: "error" });
    const assistantErrors = harness.session.events.filter(
      (event) => event.type === "assistant" && event.data.stop === "error",
    );
    expect(assistantErrors).toHaveLength(1);
    expect(assistantErrors[0]?.data).toMatchObject({
      stop: "error",
      error: {
        message: "provider credential store locked",
        retryable: false,
      },
    });
  });
});

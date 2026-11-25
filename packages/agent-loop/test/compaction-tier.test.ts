import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Context } from "@deepseek-ai/cordis";
import { afterEach, describe, expect, it } from "vitest";
import { LlmService } from "@qianji/llm";
import { COMPACTION_PREFIX, PRUNE_NAMESPACE, Sessions, type Session } from "@qianji/session";
import { SystemPrompt } from "@qianji/system-prompt";
import { ScriptedProvider, errorReply, textReply, toolReply, useScriptedProvider, type ScriptedReply } from "@qianji/testkit";
import { Tools, textOutput } from "@qianji/tools";
import {
  AgentLoop,
  COMPACTION_REQUEST,
  COMPACTION_SYSTEM,
  FORKED_COMPACTION_REQUEST,
  LENGTH_CONTINUATION_PROMPT,
  buildCompactionWorkingSetAddendum,
  type AgentLoopConfig,
} from "../src/index.ts";

const text = (value: string) => [{ type: "text" as const, text: value }];

let activeCtx: Context | undefined;
const tempDirs: string[] = [];

afterEach(async () => {
  await activeCtx?.fiber.dispose();
  activeCtx = undefined;
  for (const d of tempDirs.splice(0)) {
    rmSync(d, { recursive: true, force: true });
  }
});

async function createHarness(
  replies: ScriptedReply[],
  loopConfig: AgentLoopConfig = {},
  cwd = "/work",
): Promise<{ ctx: Context; provider: ScriptedProvider; session: Session; infoLogs: string[] }> {
  const ctx = new Context();
  activeCtx = ctx;
  const infoLogs: string[] = [];
  await ctx.plugin(LlmService, { maxAttempts: 1, baseDelayMs: 0 });
  await ctx.plugin(Sessions);
  await ctx.plugin(Tools);
  await ctx.plugin(SystemPrompt);
  await ctx.plugin(AgentLoop, loopConfig);

  ctx.logger.exporter({
    export(message) {
      if (message.name === "agent" && message.type === "info") {
        infoLogs.push(message.args.map(String).join(" "));
      }
    },
  });

  const provider = new ScriptedProvider(replies);
  useScriptedProvider(ctx, provider);
  ctx.systemPrompt.section("core", () => "System prefix invariant.");

  ctx.tools.register<{ text: string }>({
    name: "echo",
    readOnly: true,
    description: "Echo text",
    parameters: { type: "object", properties: { text: { type: "string" } }, required: ["text"] },
    execute: ({ text: val }) => textOutput(val),
  });

  const session = ctx.sessions.create({ cwd });
  session.append("model", { provider: "scripted", model: "test-model" });
  return { ctx, provider, session, infoLogs };
}

describe("two-stage compaction, active file rehydration, dynamic concurrency, and stop composition", () => {
  it("Stage 1 prunes oversized old tool results via PRUNE_NAMESPACE and skips Stage 2 LLM summary when <= 65% hysteresis", async () => {
    const hugeToolText = `${"HEAD_MARKER_".repeat(200)}${"M".repeat(120_000)}${"_TAIL_MARKER".repeat(100)}`;
    const h2 = await createHarness(
      [
        toolReply([{ id: "c-huge", name: "dump_log", args: {} }]),
        textReply("Analyzed huge output.", { inputTokens: 55_000, outputTokens: 50 }),
        textReply("Answered without Stage 2 summary!"),
      ],
      { compactAboveTokens: 50_000, keepRecentTokens: 1_000 },
    );
    h2.ctx.tools.register({
      name: "dump_log",
      readOnly: true,
      description: "Dump huge log",
      parameters: { type: "object", properties: {} },
      execute: () => textOutput(hugeToolText),
    });

    h2.ctx.agents.prompt(h2.session, text("Inspect log"));
    await h2.ctx.agents.idle(h2.session.id);

    h2.ctx.agents.prompt(h2.session, text("Follow-up after log"));
    await h2.ctx.agents.idle(h2.session.id);

    // Zero compaction events, 1 PRUNE_NAMESPACE event, and only 3 total LLM requests (no summary call!)
    expect(h2.session.events.filter((e) => e.type === "compaction")).toHaveLength(0);
    const pruneEvents = h2.session.events.filter((e) => e.type === "custom" && e.data.ns === PRUNE_NAMESPACE);
    expect(pruneEvents).toHaveLength(1);
    expect(h2.provider.requests).toHaveLength(3);

    // Raw session event keeps the full 200k+ tool output untouched for UI transcripts
    const rawToolResult = h2.session.events.find((e) => e.type === "tool-result" && e.data.callId === "c-huge");
    expect(rawToolResult?.type === "tool-result" && rawToolResult.data.content[0]?.type === "text"
      ? rawToolResult.data.content[0].text.length
      : 0).toBe(hugeToolText.length);

    // Derived request sent to model on Turn 3 has the middle-pruned replacement
    const thirdReq = h2.provider.requests[2];
    const sentToolMsg = thirdReq?.messages.find((m) => m.role === "tool-result" && m.callId === "c-huge");
    const sentText = sentToolMsg?.role === "tool-result" && sentToolMsg.content[0]?.type === "text"
      ? sentToolMsg.content[0].text
      : "";
    expect(sentText).toContain("HEAD_MARKER_");
    expect(sentText).toContain("_TAIL_MARKER");
    expect(sentText).toContain("characters pruned to relieve context pressure");
    expect(sentText.length).toBeLessThan(4_000);
  });

  it("supports cold-cache (>5min idle) opportunistic Stage 1 pruning and Turn-1 token estimation", async () => {
    const { ctx, provider, session } = await createHarness(
      [
        // Turn 1 has no prior assistant event, huge initial history exceeds compactAboveTokens -> summarizes first!
        textReply("Summary of pasted log."),
        textReply("Turn 1 answer."),
      ],
      { compactAboveTokens: 5_000 },
    );
    session.append("user", { content: text("x".repeat(40_000)) });
    ctx.agents.prompt(session, text("Analyze that"));
    await ctx.agents.idle(session.id);
    expect(provider.requests).toHaveLength(2);
    expect(session.events.some((e) => e.type === "compaction")).toBe(true);
    await ctx.fiber.dispose();

    // Cold-cache idle (> 5 min since last assistant turn, > 50% of limit) triggers Stage 1 prune without Stage 2 summary
    const cold = await createHarness(
      [textReply("Post-idle reply.")],
      { compactAboveTokens: 100_000, keepRecentTokens: 500 },
    );
    const sixMinAgo = new Date(Date.now() - 6 * 60_000).toISOString();
    cold.session.append("user", { content: text("old prompt") });
    const aOld = cold.session.append("assistant", {
      content: [{ type: "tool-call", id: "cold-c1", name: "echo", arguments: { text: "old" } }],
      model: { provider: "scripted", model: "test-model" },
      usage: { inputTokens: 55_000, outputTokens: 100, cacheReadTokens: 0, cacheWriteTokens: 0 },
      stop: "tool-use",
    });
    aOld.ts = sixMinAgo;
    cold.session.append("tool-result", {
      callId: "cold-c1",
      name: "echo",
      content: text("Z".repeat(20_000)),
      isError: false,
    });
    const aOldReply = cold.session.append("assistant", {
      content: text("Done old step."),
      model: { provider: "scripted", model: "test-model" },
      usage: { inputTokens: 60_000, outputTokens: 50, cacheReadTokens: 0, cacheWriteTokens: 0 },
      stop: "stop",
    });
    aOldReply.ts = sixMinAgo;

    cold.ctx.agents.prompt(cold.session, text("Back after 6 minutes"));
    await cold.ctx.agents.idle(cold.session.id);

    expect(cold.provider.requests).toHaveLength(1);
    expect(cold.session.events.some((e) => e.type === "custom" && e.data.ns === PRUNE_NAMESPACE)).toBe(true);
    expect(cold.session.events.some((e) => e.type === "compaction")).toBe(false);
  });

  it("Stage 2 reuses exact session prefix (system, tools, sessionId, effort) and logs cacheReadTokens telemetry", async () => {
    const { ctx, provider, session, infoLogs } = await createHarness(
      [
        textReply("Step 1 complete.", { inputTokens: 70_000, outputTokens: 100, cacheWriteTokens: 15_000 }),
        // Stage 2 same-prefix summary call hits prompt cache!
        textReply("## Goal\nShip feature.", { inputTokens: 500, outputTokens: 120, cacheReadTokens: 84_500 }),
        textReply("Step 2 complete."),
      ],
      { defaultContextWindow: 100_000 },
    );
    session.setEffort("high");

    ctx.agents.prompt(session, text("Start task"));
    await ctx.agents.idle(session.id);

    ctx.agents.prompt(session, text("Continue task"));
    await ctx.agents.idle(session.id);

    expect(provider.requests).toHaveLength(3);
    const [turn1Req, summaryReq, turn2Req] = provider.requests;
    expect(summaryReq?.sessionId).toBe(session.id);
    expect(summaryReq?.system).toBe(turn1Req?.system);
    expect(summaryReq?.tools).toEqual(turn1Req?.tools);
    expect(summaryReq?.effort).toBe("high");
    expect(summaryReq?.messages.slice(0, 2)).toEqual([
      { role: "user", content: text("Start task") },
      { role: "assistant", content: text("Step 1 complete.") },
    ]);
    expect(summaryReq?.messages.at(-1)).toEqual({ role: "user", content: text(FORKED_COMPACTION_REQUEST) });
    expect(infoLogs.some((line) => line.includes("cacheReadTokens=84500"))).toBe(true);
    expect(turn2Req?.messages[0]).toEqual({ role: "user", content: text(`${COMPACTION_PREFIX}## Goal\nShip feature.`) });
  });

  it("Stage 2 seamlessly falls back to COMPACTION_SYSTEM + serializeConversation when same-prefix errors or calls tools", async () => {
    // 1. Model mistakenly emits a tool-call on the same-prefix summary request -> falls back to serialized summary
    const accidentalTool = await createHarness([
      textReply("First reply.", { inputTokens: 90_000, outputTokens: 50 }),
      toolReply([{ id: "bad-tc", name: "echo", args: { text: "oops" } }]),
      textReply("Clean fallback summary."),
      textReply("Resumed cleanly."),
    ], { compactAboveTokens: 80_000 });

    accidentalTool.ctx.agents.prompt(accidentalTool.session, text("Do work"));
    await accidentalTool.ctx.agents.idle(accidentalTool.session.id);
    accidentalTool.ctx.agents.prompt(accidentalTool.session, text("Next step"));
    await accidentalTool.ctx.agents.idle(accidentalTool.session.id);

    expect(accidentalTool.provider.requests).toHaveLength(4);
    const [, samePrefixAttempt, fallbackAttempt] = accidentalTool.provider.requests;
    expect(samePrefixAttempt?.tools).toBeDefined();
    expect(fallbackAttempt?.system).toBe(COMPACTION_SYSTEM);
    expect(fallbackAttempt?.tools).toBeUndefined();
    expect(fallbackAttempt?.messages.at(-1)).toEqual({ role: "user", content: text(COMPACTION_REQUEST) });
    expect(accidentalTool.session.events.find((e) => e.type === "compaction")?.data).toEqual({
      throughSeq: 3,
      summary: "Clean fallback summary.",
    });
    await accidentalTool.ctx.fiber.dispose();

    // 2. Same-prefix hits context-length error -> falls back to serialized summary cleanly
    const overflowSamePrefix = await createHarness([
      textReply("First reply.", { inputTokens: 90_000, outputTokens: 50 }),
      errorReply({ kind: "context-length", message: "prompt too long", status: 400, retryable: false }),
      textReply("Serialized recovery summary."),
      textReply("Done."),
    ], { compactAboveTokens: 80_000 });

    overflowSamePrefix.ctx.agents.prompt(overflowSamePrefix.session, text("First"));
    await overflowSamePrefix.ctx.agents.idle(overflowSamePrefix.session.id);
    overflowSamePrefix.ctx.agents.prompt(overflowSamePrefix.session, text("Second"));
    await overflowSamePrefix.ctx.agents.idle(overflowSamePrefix.session.id);

    expect(overflowSamePrefix.provider.requests).toHaveLength(4);
    expect(overflowSamePrefix.session.events.find((e) => e.type === "compaction")?.data.summary).toBe("Serialized recovery summary.");
  });

  it("rehydrates up to 4 active text file excerpts from cwd while skipping missing, binary, .env, and outside-workspace paths", () => {
    const dir = mkdtempSync(join(tmpdir(), "qj-rehydrate-"));
    tempDirs.push(dir);
    const outsideDir = mkdtempSync(join(tmpdir(), "qj-outside-"));
    tempDirs.push(outsideDir);

    writeFileSync(join(dir, "f1.ts"), `export const one = "${"a".repeat(5_000)}";\n`);
    writeFileSync(join(dir, "f2.ts"), "export const two = 2;\n");
    writeFileSync(join(dir, "f3.ts"), "export const three = 3;\n");
    writeFileSync(join(dir, "f4.ts"), "export const four = 4;\n");
    writeFileSync(join(dir, "f5.ts"), "export const five = 5;\n");
    writeFileSync(join(dir, ".env"), "SECRET_KEY=top-secret\n");
    writeFileSync(join(dir, "bin.dat"), Buffer.from([0x00, 0x01, 0x02, 0xff]));
    writeFileSync(join(outsideDir, "escape.ts"), "export const escaped = true;\n");

    const events = [
      { seq: 1, ts: "t", type: "tool-call" as const, data: { callId: "1", name: "read", args: { path: "f5.ts" } } },
      { seq: 2, ts: "t", type: "tool-call" as const, data: { callId: "2", name: "read", args: { path: ".env" } } },
      { seq: 3, ts: "t", type: "tool-call" as const, data: { callId: "3", name: "read", args: { path: "bin.dat" } } },
      { seq: 4, ts: "t", type: "tool-call" as const, data: { callId: "4", name: "read", args: { path: join(outsideDir, "escape.ts") } } },
      { seq: 5, ts: "t", type: "tool-call" as const, data: { callId: "5", name: "read", args: { path: "f4.ts" } } },
      { seq: 6, ts: "t", type: "tool-call" as const, data: { callId: "6", name: "edit", args: { path: "f3.ts" } } },
      { seq: 7, ts: "t", type: "tool-call" as const, data: { callId: "7", name: "write", args: { path: "f2.ts" } } },
      { seq: 8, ts: "t", type: "tool-call" as const, data: { callId: "8", name: "edit", args: { path: "f1.ts" } } },
    ];

    const addendum = buildCompactionWorkingSetAddendum(events, 8, dir);
    expect(addendum).toContain("### Active File Excerpts");
    expect(addendum).toContain("#### f1.ts");
    expect(addendum).toContain("#### f2.ts");
    expect(addendum).toContain("#### f3.ts");
    expect(addendum).toContain("#### f4.ts");
    // Capped at 4 active file excerpts (f5.ts is 5th valid text file, omitted from excerpts)
    expect(addendum).not.toContain("#### f5.ts");
    // Secrets, binaries, and outside-workspace files are never excerpted
    expect(addendum).not.toContain("top-secret");
    expect(addendum).not.toContain("escaped = true");
    expect(addendum).toContain("[excerpt truncated]");
  });

  it("partitions dynamic isConcurrencySafe(args) calls, signals steeringSignal on steer(), escalates maxTokens once, and composes before-stop listeners", async () => {
    const timeline: string[] = [];
    let markWaitStarted = () => {};
    const waitStarted = new Promise<void>((resolve) => { markWaitStarted = resolve; });

    const truncatedAtDefault = [
      { type: "text-delta" as const, index: 0, text: "Cut off at conservative cap..." },
      { type: "usage" as const, usage: { inputTokens: 100, outputTokens: 4_096 } },
      { type: "finish" as const, reason: "length" as const },
    ];

    const { ctx, provider, session } = await createHarness(
      [
        // Turn 1: hits length at 4096 -> silently replays once with model's maxOutputTokens (32000) and calls dynamic tools!
        truncatedAtDefault,
        toolReply([
          { id: "m1", name: "multi_op", args: { mode: "read", key: "a" } },
          { id: "m2", name: "multi_op", args: { mode: "read", key: "b" } },
          { id: "m3", name: "multi_op", args: { mode: "write", key: "c" } },
        ]),
        // Turn 2: runs cooperative wait tool that wakes on steeringSignal
        toolReply([{ id: "w1", name: "coop_wait", args: {} }]),
        // Turn 3 (after steer): tries to stop -> two before-stop listeners compose -> Turn 4 finishes
        textReply("Trying to stop early."),
        // Turn 4: truncates even at escalated ceiling -> falls back to LENGTH_CONTINUATION_PROMPT -> Turn 5 finishes
        truncatedAtDefault,
        truncatedAtDefault,
        textReply("All complete after continuation."),
      ],
      { defaultMaxTokens: 4_096 },
    );

    Object.assign(provider, {
      listModels: async () => [{ id: "test-model", contextWindow: 200_000, maxOutputTokens: 32_000 }],
    });

    let r1Gate = () => {};
    let r2Gate = () => {};
    let bothReadsStarted = () => {};
    let startedReads = 0;
    const readsParallel = new Promise<void>((resolve) => { bothReadsStarted = resolve; });

    ctx.tools.register<{ mode: string; key: string }>({
      name: "multi_op",
      description: "Read/write multi-action tool",
      parameters: {
        type: "object",
        properties: { mode: { type: "string" }, key: { type: "string" } },
        required: ["mode", "key"],
      },
      isConcurrencySafe: (args) => args.mode === "read",
      execute: ({ mode, key }) => new Promise((resolve) => {
        timeline.push(`start:${mode}:${key}`);
        if (mode === "read") {
          startedReads += 1;
          if (startedReads === 2) bothReadsStarted();
          if (key === "a") r1Gate = () => { timeline.push("end:read:a"); resolve(textOutput("ra")); };
          else r2Gate = () => { timeline.push("end:read:b"); resolve(textOutput("rb")); };
        } else {
          timeline.push(`end:${mode}:${key}`);
          resolve(textOutput("wc"));
        }
      }),
    });

    ctx.tools.register({
      name: "coop_wait",
      readOnly: true,
      description: "Waits until steeringSignal aborts",
      parameters: { type: "object", properties: {} },
      execute: (_args, env) => new Promise((resolve) => {
        markWaitStarted();
        if (env.steeringSignal?.aborted) {
          resolve(textOutput("woke-immediately"));
          return;
        }
        env.steeringSignal?.addEventListener("abort", () => resolve(textOutput("woke-on-steer")), { once: true });
      }),
    });

    let listenerCalls = 0;
    ctx.on("agent/before-stop", () => {
      listenerCalls += 1;
      return listenerCalls === 1 ? "Nudge from plan plugin." : undefined;
    });
    ctx.on("agent/before-stop", () => (listenerCalls === 1 ? "Nudge from stop hook." : undefined));

    ctx.agents.prompt(session, text("Execute full v2 flow"));
    await readsParallel;
    // Both mode="read" calls overlapped before mode="write" started!
    expect(timeline).toEqual(["start:read:a", "start:read:b"]);
    r1Gate();
    r2Gate();

    await waitStarted;
    // Queueing steer aborts steeringSignal so coop_wait resolves immediately!
    ctx.agents.steer(session, text("Steer cooperative wait"));
    await ctx.agents.idle(session.id);

    expect(timeline).toEqual([
      "start:read:a",
      "start:read:b",
      "end:read:a",
      "end:read:b",
      "start:write:c",
      "end:write:c",
    ]);

    const coopResult = session.events.find((e) => e.type === "tool-result" && e.data.callId === "w1");
    expect(coopResult?.type === "tool-result" ? coopResult.data.content : undefined).toEqual(text("woke-on-steer"));

    // Verify silent maxTokens escalation on Turn 1: req[0] had maxTokens=4096, req[1] replayed with maxTokens=32000
    expect(provider.requests[0]?.maxTokens).toBe(4_096);
    expect(provider.requests[1]?.maxTokens).toBe(32_000);

    // Verify both before-stop listeners composed into a single continuation without shadowing
    const turn4Req = provider.requests[4];
    expect(JSON.stringify(turn4Req?.messages)).toContain("Nudge from plan plugin.\\n\\nNudge from stop hook.");

    // Verify Turn 4 still fell back to LENGTH_CONTINUATION_PROMPT when 32000 ceiling also truncated
    const finalReq = provider.requests.at(-1);
    expect(finalReq?.messages.at(-1)).toEqual({ role: "user", content: text(LENGTH_CONTINUATION_PROMPT) });
  });
});

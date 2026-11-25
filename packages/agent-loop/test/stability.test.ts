/**
 * Regression suite for Phase 1 Agent Loop conversation stability & truncation recovery (P1–P5).
 */
import { Context } from "@deepseek-ai/cordis";
import { afterEach, describe, expect, it } from "vitest";
import type { AgentDelta, RunOutcome } from "@qianji/agent";
import { LlmService, type StreamChunk } from "@qianji/llm";
import { Sessions, type Session } from "@qianji/session";
import { SystemPrompt } from "@qianji/system-prompt";
import {
  ScriptedProvider,
  errorReply,
  textReply,
  toolReply,
  useScriptedProvider,
  type ScriptedOptions,
  type ScriptedReply,
} from "@qianji/testkit";
import { Tools, textOutput } from "@qianji/tools";
import {
  AgentLoop,
  LENGTH_CONTINUATION_PROMPT,
  MAX_LENGTH_CONTINUATIONS,
  STEER_SKIPPED_MESSAGE,
  type AgentLoopConfig,
} from "../src/index.ts";

interface StabilityHarness {
  ctx: Context;
  provider: ScriptedProvider;
  session: Session;
  deltas: AgentDelta[];
}

let activeCtx: Context | undefined;

afterEach(async () => {
  await activeCtx?.fiber.dispose();
  activeCtx = undefined;
});

const text = (value: string) => [{ type: "text" as const, text: value }];

async function setupHarness(
  replies: ScriptedReply[],
  options: { scripted?: ScriptedOptions; loop?: AgentLoopConfig } = {},
): Promise<StabilityHarness> {
  const ctx = new Context();
  activeCtx = ctx;
  await ctx.plugin(LlmService, { maxAttempts: 1, baseDelayMs: 0 });
  await ctx.plugin(Sessions);
  await ctx.plugin(Tools);
  await ctx.plugin(SystemPrompt);
  await ctx.plugin(AgentLoop, options.loop ?? {});
  const provider = new ScriptedProvider(replies, options.scripted);
  useScriptedProvider(ctx, provider);
  ctx.systemPrompt.section("test", () => "Stability test system prompt.");
  const session = ctx.sessions.create({ cwd: "/work" });
  session.append("model", { provider: "scripted", model: "test-model" });
  const deltas: AgentDelta[] = [];
  ctx.on("session/delta", (from, _seq, delta) => {
    if (from === session) deltas.push(delta as AgentDelta);
  });
  return { ctx, provider, session, deltas };
}

function createGate(): { promise: Promise<void>; open: () => void } {
  let open = () => {};
  const promise = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { promise, open: () => open() };
}

describe("agent-loop stability & truncation recovery (P1–P5)", () => {
  describe("P1: settlement race windows & 1-per-turn followUp granularity", () => {
    it("delivers followUp and steer arriving while agent/before-stop is suspended without message loss", async () => {
      for (const mode of ["followUp", "steer"] as const) {
        const harness = await setupHarness([textReply("Turn 1."), textReply(`Turn 2 from ${mode}.`)]);
        const entered = createGate();
        const release = createGate();
        let hookCalls = 0;
        harness.ctx.on("agent/before-stop", async () => {
          hookCalls += 1;
          if (hookCalls === 1) {
            entered.open();
            await release.promise;
          }
          return undefined;
        });

        harness.ctx.agents.prompt(harness.session, text("Start"));
        await entered.promise;
        const msg = `Queued ${mode} in before-stop`;
        const ret = mode === "followUp"
          ? harness.ctx.agents.followUp(harness.session, text(msg))
          : harness.ctx.agents.steer(harness.session, text(msg));
        expect(ret).toBeUndefined();
        release.open();
        await harness.ctx.agents.idle(harness.session.id);

        expect(harness.provider.requests).toHaveLength(2);
        expect(harness.provider.requests[1]?.messages.at(-1)).toEqual({ role: "user", content: text(msg) });
        expect(harness.deltas.at(-1)).toEqual({ type: "agent-end", outcome: "done" });
        await harness.ctx.fiber.dispose();
      }
    });

    it("delivers followUp and steer arriving while session/flush is suspended and starts fresh run in agent/settled", async () => {
      const harness = await setupHarness([
        textReply("Reply 1."),
        textReply("Reply 2 after flush followUp."),
        textReply("Reply 3 after flush steer."),
        textReply("Reply 4 started in agent/settled."),
      ]);
      const enteredFlush1 = createGate();
      const releaseFlush1 = createGate();
      const enteredFlush2 = createGate();
      const releaseFlush2 = createGate();
      let flushCount = 0;
      harness.ctx.on("session/flush", async (flushedSession) => {
        if (flushedSession !== harness.session) return;
        flushCount += 1;
        if (flushCount === 1) {
          enteredFlush1.open();
          await releaseFlush1.promise;
        } else if (flushCount === 2) {
          enteredFlush2.open();
          await releaseFlush2.promise;
        }
      });

      let settledFollowUpRunStarted = false;
      const outcomes: RunOutcome[] = [];
      harness.ctx.on("agent/settled", async (settledSession, outcome) => {
        if (settledSession !== harness.session) return;
        outcomes.push(outcome);
        if (outcomes.length === 1) {
          expect(harness.ctx.agents.status(harness.session.id).running).toBe(false);
          const created = harness.ctx.agents.followUp(harness.session, text("Sent inside agent/settled"));
          expect(created?.type).toBe("user");
          settledFollowUpRunStarted = true;
        }
      });

      harness.ctx.agents.prompt(harness.session, text("First question"));
      await enteredFlush1.promise;
      expect(harness.ctx.agents.followUp(harness.session, text("FollowUp during flush"))).toBeUndefined();
      releaseFlush1.open();

      await enteredFlush2.promise;
      expect(harness.ctx.agents.steer(harness.session, text("Steer during flush"))).toBeUndefined();
      releaseFlush2.open();

      await harness.ctx.agents.idle(harness.session.id);
      expect(settledFollowUpRunStarted).toBe(true);
      await harness.ctx.agents.idle(harness.session.id);

      expect(harness.provider.requests).toHaveLength(4);
      expect(harness.provider.requests[1]?.messages.at(-1)).toEqual({ role: "user", content: text("FollowUp during flush") });
      expect(harness.provider.requests[2]?.messages.at(-1)).toEqual({ role: "user", content: text("Steer during flush") });
      expect(harness.provider.requests[3]?.messages.at(-1)).toEqual({ role: "user", content: text("Sent inside agent/settled") });
      expect(outcomes).toEqual(["done", "done"]);
    });

    it("delivers 2 queued followUps strictly one per turn across 2 separate turns", async () => {
      const streamingGate = createGate();
      const releaseStream = createGate();
      const harness = await setupHarness([
        async function* () {
          yield { type: "text-delta", index: 0, text: "Answer 1." };
          streamingGate.open();
          await releaseStream.promise;
          yield { type: "finish", reason: "stop" };
        },
        textReply("Answer 2."),
        textReply("Answer 3."),
      ]);

      harness.ctx.agents.prompt(harness.session, text("Question 1"));
      await streamingGate.promise;
      harness.ctx.agents.followUp(harness.session, text("FollowUp #1"));
      harness.ctx.agents.followUp(harness.session, text("FollowUp #2"));
      expect(harness.ctx.agents.status(harness.session.id).queue).toEqual({ steer: 0, followUp: 2 });
      releaseStream.open();
      await harness.ctx.agents.idle(harness.session.id);

      expect(harness.provider.requests).toHaveLength(3);
      const turn2Msgs = harness.provider.requests[1]?.messages ?? [];
      expect(turn2Msgs.map((m) => m.role)).toEqual(["user", "assistant", "user"]);
      expect(turn2Msgs.at(-1)).toEqual({ role: "user", content: text("FollowUp #1") });
      expect(JSON.stringify(turn2Msgs)).not.toContain("FollowUp #2");

      const turn3Msgs = harness.provider.requests[2]?.messages ?? [];
      expect(turn3Msgs.map((m) => m.role)).toEqual(["user", "assistant", "user", "assistant", "user"]);
      expect(turn3Msgs.at(-1)).toEqual({ role: "user", content: text("FollowUp #2") });
    });
  });

  describe("P2: empty / thinking-only exhaustion honesty & clean retry derivation", () => {
    it("records empty_response_exhausted error after 3 thinking-only replies and omits it on subsequent retry", async () => {
      const thinkingOnly = (n: number): StreamChunk[] => [
        { type: "thinking-delta", index: 0, text: `internal thought #${n}` },
        { type: "finish", reason: "stop" },
      ];
      const harness = await setupHarness([
        thinkingOnly(1),
        thinkingOnly(2),
        thinkingOnly(3),
        textReply("Visible answer on user retry."),
      ]);

      harness.ctx.agents.prompt(harness.session, text("Explain architecture"));
      await harness.ctx.agents.idle(harness.session.id);

      expect(harness.provider.requests).toHaveLength(3);
      expect(harness.deltas.at(-1)).toEqual({ type: "agent-end", outcome: "error" });
      const lastEvent = harness.session.events.at(-1);
      expect(lastEvent?.type).toBe("assistant");
      if (lastEvent?.type === "assistant") {
        expect(lastEvent.data).toMatchObject({
          content: [],
          stop: "error",
          error: {
            kind: "unknown",
            code: "empty_response_exhausted",
            message: "模型未返回可见正文（连续仅输出思考或空响应）。",
            retryable: true,
          },
        });
      }

      expect(harness.session.state().messages.some((m) => m.role === "assistant")).toBe(false);
      harness.ctx.agents.prompt(harness.session, text("Please retry cleanly"));
      await harness.ctx.agents.idle(harness.session.id);

      expect(harness.provider.requests).toHaveLength(4);
      const retryReqMessages = harness.provider.requests[3]?.messages ?? [];
      expect(retryReqMessages.some((m) => m.role === "assistant")).toBe(false);
      expect(retryReqMessages.at(-1)).toEqual({ role: "user", content: text("Please retry cleanly") });
      expect(harness.deltas.at(-1)).toEqual({ type: "agent-end", outcome: "done" });
    });
  });

  describe("P3: batch-0 steer preemption, bounded read-only pool, and live tool-end deltas", () => {
    it("skips batch-0 mutating tool with 0 executions when steer arrives during LLM streaming", async () => {
      const toolChunkSent = createGate();
      const releaseFinish = createGate();
      let mutatingExecutions = 0;
      const harness = await setupHarness([
        async function* () {
          yield { type: "tool-call-start", index: 0, id: "mut-1", name: "write_file" };
          yield { type: "tool-call-delta", index: 0, argumentsDelta: '{"path":"danger.ts"}' };
          toolChunkSent.open();
          await releaseFinish.promise;
          yield { type: "finish", reason: "tool-use" };
        },
        textReply("Understood, skipped file modification."),
      ]);
      harness.ctx.tools.register<{ path: string }>({
        name: "write_file",
        description: "Mutating file write",
        parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
        execute: () => {
          mutatingExecutions += 1;
          return textOutput("wrote file");
        },
      });

      harness.ctx.agents.prompt(harness.session, text("Modify danger.ts"));
      await toolChunkSent.promise;
      harness.ctx.agents.steer(harness.session, text("先别改"));
      releaseFinish.open();
      await harness.ctx.agents.idle(harness.session.id);

      expect(mutatingExecutions).toBe(0);
      const results = harness.session.events.filter((e) => e.type === "tool-result");
      expect(results).toHaveLength(1);
      expect(results[0]?.data).toMatchObject({
        callId: "mut-1",
        name: "write_file",
        isError: true,
        content: [{ type: "text", text: STEER_SKIPPED_MESSAGE }],
      });
      expect(harness.deltas.filter((d) => d.type === "tool-end")).toEqual([
        { type: "tool-end", callId: "mut-1", isError: true },
      ]);
      expect(harness.provider.requests[1]?.messages.at(-1)).toEqual({ role: "user", content: text("先别改") });
      expect(harness.deltas.at(-1)).toEqual({ type: "agent-end", outcome: "done" });
    });

    it("caps concurrent read-only tools at maxParallelTools and emits live tool-end before batch 1 completes", async () => {
      const calls = [
        ...Array.from({ length: 5 }, (_, i) => ({ id: `ro-${i + 1}`, name: "gated_ro", args: { slot: i + 1 } })),
        { id: "mut-last", name: "gated_mut", args: {} },
      ];
      const harness = await setupHarness([toolReply(calls), textReply("Batches done.")], {
        loop: { maxParallelTools: 2 },
      });

      let inFlight = 0;
      let peakInFlight = 0;
      const resolvers = new Map<number, () => void>();
      const startedSlots: number[] = [];
      const firstWaveReady = createGate();
      const thirdSlotStarted = createGate();
      const mutStarted = createGate();
      const releaseMut = createGate();

      harness.ctx.tools.register<{ slot: number }>({
        name: "gated_ro",
        readOnly: true,
        description: "Gated read-only tool",
        parameters: { type: "object", properties: { slot: { type: "number" } }, required: ["slot"] },
        execute: ({ slot }) =>
          new Promise((resolve) => {
            inFlight += 1;
            peakInFlight = Math.max(peakInFlight, inFlight);
            startedSlots.push(slot);
            if (startedSlots.length === 2) firstWaveReady.open();
            if (slot === 3) thirdSlotStarted.open();
            resolvers.set(slot, () => {
              inFlight -= 1;
              resolve(textOutput(`out-${slot}`));
            });
          }),
      });
      harness.ctx.tools.register({
        name: "gated_mut",
        description: "Slow mutating tool in batch 1",
        parameters: { type: "object", properties: {} },
        execute: async () => {
          mutStarted.open();
          await releaseMut.promise;
          return textOutput("mut-done");
        },
      });

      harness.ctx.agents.prompt(harness.session, text("Run capped pool"));
      await firstWaveReady.promise;
      expect(peakInFlight).toBe(2);
      expect(startedSlots).toEqual([1, 2]);

      resolvers.get(2)?.();
      await thirdSlotStarted.promise;
      expect(peakInFlight).toBe(2);
      expect(harness.deltas).toContainEqual({ type: "tool-end", callId: "ro-2", isError: false });

      for (const slot of [1, 3, 4, 5]) {
        while (!resolvers.has(slot)) await new Promise((r) => setTimeout(r, 1));
        resolvers.get(slot)?.();
      }

      await mutStarted.promise;
      const endsBeforeBatch1Done = harness.deltas.filter((d) => d.type === "tool-end");
      expect(endsBeforeBatch1Done).toHaveLength(5);
      expect(endsBeforeBatch1Done.some((d) => d.callId === "mut-last")).toBe(false);

      releaseMut.open();
      await harness.ctx.agents.idle(harness.session.id);

      expect(peakInFlight).toBe(2);
      expect(harness.deltas.filter((d) => d.type === "tool-end")).toHaveLength(6);
      const resultIds = harness.session.events.filter((e) => e.type === "tool-result").map((e) => e.data.callId);
      expect(resultIds).toEqual(["ro-1", "ro-2", "ro-3", "ro-4", "ro-5", "mut-last"]);
    });
  });

  describe("P4: truncated tool-call recovery on reason === 'length'", () => {
    it("strips truncated tool-call JSON on length, preserves prose, continues cleanly, and caps at MAX_LENGTH_CONTINUATIONS", async () => {
      const brokenLengthReply: StreamChunk[] = [
        { type: "text-delta", index: 0, text: "Inspecting target file now." },
        { type: "tool-call-start", index: 1, id: "trunc-1", name: "read_target" },
        { type: "tool-call-delta", index: 1, argumentsDelta: '{"path":"a' },
        { type: "finish", reason: "length" },
      ];
      let readExecutions = 0;
      const harness = await setupHarness([
        brokenLengthReply,
        toolReply([{ id: "ok-1", name: "read_target", args: { path: "a.ts" } }]),
        textReply("Inspection complete."),
      ]);
      harness.ctx.tools.register<{ path: string }>({
        name: "read_target",
        readOnly: true,
        description: "Read file",
        parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
        execute: ({ path }) => {
          readExecutions += 1;
          return textOutput(`contents:${path}`);
        },
      });

      harness.ctx.agents.prompt(harness.session, text("Read a.ts"));
      await harness.ctx.agents.idle(harness.session.id);

      expect(readExecutions).toBe(1);
      const firstAssistant = harness.session.events.find((e) => e.type === "assistant");
      expect(firstAssistant?.data).toMatchObject({
        stop: "length",
        content: [{ type: "text", text: "Inspecting target file now." }],
      });
      expect(harness.session.events.filter((e) => e.type === "tool-call").map((e) => e.data.callId)).toEqual(["ok-1"]);
      expect(harness.provider.requests[1]?.messages.at(-1)).toEqual({
        role: "user",
        content: text(LENGTH_CONTINUATION_PROMPT),
      });
      expect(harness.deltas.at(-1)).toEqual({ type: "agent-end", outcome: "done" });
      await harness.ctx.fiber.dispose();

      let cappedExecutions = 0;
      const capped = await setupHarness(Array.from({ length: MAX_LENGTH_CONTINUATIONS + 2 }, () => brokenLengthReply));
      capped.ctx.tools.register<{ path: string }>({
        name: "read_target",
        readOnly: true,
        description: "Read file",
        parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
        execute: () => {
          cappedExecutions += 1;
          return textOutput("never");
        },
      });

      capped.ctx.agents.prompt(capped.session, text("Truncate repeatedly"));
      await capped.ctx.agents.idle(capped.session.id);

      expect(cappedExecutions).toBe(0);
      expect(capped.provider.requests).toHaveLength(1 + MAX_LENGTH_CONTINUATIONS);
      expect(capped.deltas.at(-1)).toEqual({ type: "agent-end", outcome: "done" });
      const finalAssistant = capped.session.events.findLast((e) => e.type === "assistant");
      expect(finalAssistant?.data.stop).toBe("length");
      expect(finalAssistant?.data.content).toEqual([{ type: "text", text: "Inspecting target file now." }]);
    });
  });

  describe("P5: context-length error with 0 content vs partial output + unexecuted tool-call", () => {
    it("compacts & retries once on 0-content context-length, but preserves partial text and strips tool-calls when partial output exists", async () => {
      const emptyOverflow = await setupHarness([
        errorReply({ kind: "context-length", message: "context window exceeded", retryable: false }),
        textReply("Compacted summary."),
        textReply("Recovered after compaction."),
      ]);
      emptyOverflow.ctx.agents.prompt(emptyOverflow.session, text("Long prompt"));
      await emptyOverflow.ctx.agents.idle(emptyOverflow.session.id);

      expect(emptyOverflow.session.events.some((e) => e.type === "compaction")).toBe(true);
      expect(emptyOverflow.deltas.at(-1)).toEqual({ type: "agent-end", outcome: "done" });
      await emptyOverflow.ctx.fiber.dispose();

      let toolRuns = 0;
      const partialOverflowChunks: StreamChunk[] = [
        { type: "text-delta", index: 0, text: "Partial analysis before hitting context limit." },
        { type: "tool-call-start", index: 1, id: "unexec-1", name: "edit_file" },
        { type: "tool-call-delta", index: 1, argumentsDelta: '{"path":"b.ts"}' },
        {
          type: "finish",
          reason: "error",
          error: {
            kind: "context-length",
            code: "model_context_window_exceeded",
            message: "context window exceeded",
            retryable: false,
          },
        },
      ];
      const partialH = await setupHarness([partialOverflowChunks, textReply("Should not compact or continue.")]);
      partialH.ctx.tools.register<{ path: string }>({
        name: "edit_file",
        description: "Edit file",
        parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
        execute: () => {
          toolRuns += 1;
          return textOutput("edited");
        },
      });

      partialH.ctx.agents.prompt(partialH.session, text("Analyze and edit"));
      await partialH.ctx.agents.idle(partialH.session.id);

      expect(toolRuns).toBe(0);
      expect(partialH.provider.requests).toHaveLength(1);
      expect(partialH.session.events.some((e) => e.type === "compaction")).toBe(false);
      expect(partialH.session.events.some((e) => e.type === "tool-call")).toBe(false);
      expect(partialH.session.events.some((e) => e.type === "tool-result")).toBe(false);
      expect(partialH.deltas.at(-1)).toEqual({ type: "agent-end", outcome: "error" });

      const assistantEvents = partialH.session.events.filter((e) => e.type === "assistant");
      expect(assistantEvents).toHaveLength(1);
      expect(assistantEvents[0]?.data).toMatchObject({
        content: [{ type: "text", text: "Partial analysis before hitting context limit." }],
        stop: "error",
        error: { kind: "context-length", code: "model_context_window_exceeded" },
      });
    });
  });
});

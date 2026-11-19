// The Harness Host's session logs as the transcript's messages, and its live
// progress as transcript events (src/lib/transcript.ts, src/lib/hostSessions.ts),
// checked against the agent loop's golden logs.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { PersistedEvent, SessionSubscribeResult } from "@qianji/protocol";
import { effortForLevel, forkPointsOf, sessionTreeOf } from "../src/lib/hostSessions";
import {
  buildResumeEvents,
  replaySessionToUi,
  seedTranslatorFromStatus,
} from "../src/lib/harnessReplay";
import {
  TranscriptTranslator,
  currentBranch,
  historyToUi,
  planWidgetLines,
  replayToUi,
  resetStreamingAssistant,
  settleStoppedTurn,
  streamAssistant,
} from "../src/lib/transcript";

const golden = (name: string): PersistedEvent[] => readFileSync(join(import.meta.dirname, "..", "packages", "agent-loop", "test", "golden", `${name}.jsonl`), "utf8")
  .trim()
  .split("\n")
  .map((line) => ({ ...JSON.parse(line), ts: "2026-10-29T00:00:00.000Z" }));

describe("session logs as transcript messages", () => {
  it("map users, and assistants with their tool calls and results", () => {
    const messages = historyToUi(golden("parallel-tools"));
    expect(messages.map((message) => message.role)).toEqual(["user", "assistant", "assistant"]);
    expect(messages[0]).toMatchObject({ role: "user", content: "Echo twice", entryId: "2", timestamp: Date.parse("2026-10-29T00:00:00.000Z") });
    expect(messages[1]).toMatchObject({ role: "assistant", content: "Let me check.", model: "test-model", usage: { input: 10, output: 5, totalTokens: 15 }, isError: false });
    expect(messages[1].toolCalls?.map((call) => [call.id, call.name, call.args, call.running, call.isError])).toEqual([
      ["call-1", "echo", { text: "one" }, false, false],
      ["call-2", "echo", { text: "two" }, false, false],
      ["call-3", "missing", {}, false, true],
    ]);
  });

  it("show compactions, errors and aborts", () => {
    const compacted = historyToUi(golden("context-length"));
    expect(compacted.map((message) => message.role)).toEqual(["user", "notice", "assistant"]);
    expect(compacted[1]).toMatchObject({ noticeKind: "compaction" });
    expect(historyToUi(golden("provider-error"))[1]).toMatchObject({ role: "assistant", isError: true, isAborted: false, content: "bad key" });
    // Stopping a turn keeps what it wrote and is not an error.
    expect(historyToUi(golden("abort-stream"))[1]).toMatchObject({ isError: false, isAborted: true, content: "Partial" });
  });

  it("follow rewinds", () => {
    const events: PersistedEvent[] = [
      { seq: 1, ts: "t", type: "user", data: { content: [{ type: "text", text: "a" }] } },
      { seq: 2, ts: "t", type: "user", data: { content: [{ type: "text", text: "b" }] } },
      { seq: 3, ts: "t", type: "rewind", data: { toSeq: 1 } },
      { seq: 4, ts: "t", type: "user", data: { content: [{ type: "text", text: "c" }] } },
    ];
    expect(currentBranch(events).map((event) => event.seq)).toEqual([1, 4]);
  });
});

describe("live progress as transcript events", () => {
  it("streams a run with a tool call", () => {
    const translator = new TranscriptTranslator();
    const events = [
      ...translator.delta({ type: "agent-start" }),
      ...translator.delta({ type: "llm-start", provider: "p", model: "m" }),
      ...translator.delta({ type: "llm-chunk", chunk: { type: "text-delta", index: 0, text: "Reading" } }),
      ...translator.delta({ type: "llm-chunk", chunk: { type: "tool-call-start", index: 1, id: "c1", name: "read" } }),
      ...translator.delta({ type: "llm-chunk", chunk: { type: "tool-call-delta", index: 1, argumentsDelta: "{\"path\":" } }),
      ...translator.delta({ type: "llm-chunk", chunk: { type: "tool-call-delta", index: 1, argumentsDelta: "\"a.ts\"}" } }),
      ...translator.delta({ type: "llm-chunk", chunk: { type: "finish", reason: "tool-use" } }),
      ...translator.event({ seq: 3, ts: "t", type: "tool-call", data: { callId: "c1", name: "read", args: { path: "a.ts" } } }),
      ...translator.event({ seq: 4, ts: "t", type: "tool-result", data: { callId: "c1", name: "read", content: [{ type: "text", text: "x" }], isError: false } }),
      ...translator.delta({ type: "agent-end", outcome: "done" }),
    ];
    expect(events.map((event) => event.type)).toEqual([
      "turn-start",
      "assistant-start",
      "assistant-delta",
      "assistant-tool-calls",
      "assistant-tool-calls",
      "assistant-tool-calls",
      "tool-start",
      "tool-end",
      "turn-end",
    ]);
    const toolCallEvents = events.filter((event) => event.type === "assistant-tool-calls");
    expect(toolCallEvents[0]).toMatchObject({ calls: [{ id: "c1", name: "read", args: {}, running: true }] });
    expect(toolCallEvents.at(-1)).toMatchObject({ calls: [{ id: "c1", name: "read", args: { path: "a.ts" }, running: true }] });
    expect(events.find((event) => event.type === "tool-end")).toMatchObject({ callId: "c1", result: { text: "x", isError: false } });
  });

  it("shows the plan as the plan widget's lines, the queue as counts, and maps thinking levels", () => {
    const translator = new TranscriptTranslator();
    const plan = { items: [{ text: "Read", status: "completed" }, { text: "Fix", status: "in_progress" }] };
    expect(translator.delta({ type: "plan", plan })).toEqual([{ type: "plan", lines: ["计划 1/2", "[x] Read", "[>] Fix"] }]);
    expect(planWidgetLines({ items: [] })).toEqual([]);
    expect(translator.delta({ type: "queue", steer: 2, followUp: 0 })).toEqual([{ type: "queue", steering: 2, followUp: 0 }]);
    expect(
      translator.delta({
        type: "llm-chunk",
        chunk: { type: "retry", attempt: 1, maxAttempts: 5, delayMs: 2_000, effort: "medium", error: { kind: "network", message: "reset", retryable: true } },
      }),
    ).toEqual([{ type: "retry-status", text: "长流中断，已自动下调思考强度重试 1/4（2s 后） · reset…" }]);
    expect(
      translator.delta({
        type: "llm-chunk",
        chunk: {
          type: "retry",
          attempt: 2,
          maxAttempts: 5,
          delayMs: 5_000,
          error: { kind: "overloaded", status: 503, message: "sub2api returned HTTP 503: Service temporarily unavailable", retryable: true },
        },
      }),
    ).toEqual([{ type: "retry-status", text: "HTTP 503: Service temporarily unavailable · 正在重试 2/4（5s 后）…" }]);
    expect(["off", "minimal", "medium", "xhigh", "max", "ultra"].map(effortForLevel)).toEqual([
      "off",
      "minimal",
      "medium",
      "xhigh",
      "max",
      "ultra",
    ]);

    const streamed = streamAssistant([], { text: "half", thinking: "partial thought" }, 100);
    expect(streamed[0]).toMatchObject({ content: "half", thinking: "partial thought", isStreaming: true });
    const reset = resetStreamingAssistant(streamed);
    expect(reset[0]).toEqual({ id: "stream-100", role: "assistant", content: "", isStreaming: true, timestamp: 100 });
  });
});

describe("fork points and the session tree", () => {
  const events: PersistedEvent[] = [
    { seq: 1, ts: "t", type: "model", data: { provider: "p", model: "m" } },
    { seq: 2, ts: "t", type: "user", data: { content: [{ type: "text", text: "first" }] } },
    { seq: 3, ts: "t", type: "assistant", data: { content: [{ type: "text", text: "A" }] } },
    { seq: 4, ts: "t", type: "user", data: { content: [{ type: "text", text: "second" }] } },
    { seq: 5, ts: "t", type: "assistant", data: { content: [{ type: "text", text: "B" }] } },
    { seq: 6, ts: "t", type: "rewind", data: { toSeq: 3 } },
    { seq: 7, ts: "t", type: "user", data: { content: [{ type: "text", text: "again" }] } },
  ];

  it("offer the current branch's user messages as fork points", () => {
    expect(forkPointsOf(events)).toEqual([{ entryId: "2", text: "first" }, { entryId: "7", text: "again" }]);
  });

  it("keep rewound messages as a side branch of the tree", () => {
    const { tree, leafId } = sessionTreeOf(events);
    expect(leafId).toBe("7");
    const ids = (nodes: typeof tree): unknown[] => nodes.map((node) => [node.entry.id, ids(node.children)]);
    expect(ids(tree)).toEqual([["2", [["3", [["4", [["5", []]]], ["7", []]]]]]]);
    expect(tree[0]?.entry).toMatchObject({ type: "message", parentId: null, message: { role: "user" } });
  });
});

describe("mid-stream snapshot replay", () => {
  it("records tool-call timestamps in historyToUi while keeping running false", () => {
    const events: PersistedEvent[] = [
      { seq: 1, ts: "2026-10-29T00:00:00.000Z", type: "user", data: { content: [{ type: "text", text: "go" }] } },
      {
        seq: 2,
        ts: "2026-10-29T00:00:01.000Z",
        type: "assistant",
        data: {
          content: [{ type: "tool-call", id: "c1", name: "read", arguments: { path: "a.ts" } }],
          model: { provider: "p", model: "m" },
          usage: {},
          stop: "tool-use",
        },
      },
      { seq: 3, ts: "2026-10-29T00:00:02.500Z", type: "tool-call", data: { callId: "c1", name: "read", args: { path: "a.ts" } } },
    ];
    const msgs = historyToUi(events);
    expect(msgs[1]?.toolCalls?.[0]).toMatchObject({
      id: "c1",
      running: false,
      startedAt: Date.parse("2026-10-29T00:00:02.500Z"),
    });
  });

  it("marks idle incomplete turns as interrupted and preserves completed turns via replayToUi", () => {
    const incomplete: PersistedEvent[] = [
      { seq: 1, ts: "2026-10-29T00:00:00.000Z", type: "user", data: { content: [{ type: "text", text: "read" }] } },
      {
        seq: 2,
        ts: "2026-10-29T00:00:01.000Z",
        type: "assistant",
        data: {
          content: [{ type: "tool-call", id: "c1", name: "read", arguments: { path: "a.ts" } }],
          model: { provider: "p", model: "m" },
          usage: {},
          stop: "tool-use",
        },
      },
    ];
    const replayed = replayToUi(incomplete);
    expect(replayed.at(-1)).toMatchObject({ role: "assistant", isError: true });
    expect(replayed[1]?.toolCalls?.[0]).toMatchObject({ running: false, isError: true });

    const complete = replayToUi(golden("parallel-tools"), {
      running: false,
      streaming: [],
      runningTools: [],
      queue: { steer: 0, followUp: 0 },
    });
    expect(complete.map((m) => m.role)).toEqual(["user", "assistant", "assistant"]);
  });

  it("marks only active runningTools as running while preserving args and completed tools", () => {
    const replay: SessionSubscribeResult = {
      liveSeq: 4,
      events: [
        { seq: 1, ts: "2026-10-29T00:00:00.000Z", type: "user", data: { content: [{ type: "text", text: "run tools" }] } },
        {
          seq: 2,
          ts: "2026-10-29T00:00:01.000Z",
          type: "assistant",
          data: {
            content: [
              { type: "tool-call", id: "c0", name: "read", arguments: { path: "done.ts" } },
              { type: "tool-call", id: "c1", name: "write", arguments: { path: "busy.ts", content: "ok" } },
              { type: "tool-call", id: "c2", name: "write", arguments: { path: "queued.ts", content: "next" } },
            ],
            model: { provider: "p", model: "m" },
            usage: {},
            stop: "tool-use",
          },
        },
        { seq: 3, ts: "2026-10-29T00:00:02.000Z", type: "tool-call", data: { callId: "c1", name: "write", args: { path: "busy.ts" } } },
        { seq: 4, ts: "2026-10-29T00:00:03.000Z", type: "tool-result", data: { callId: "c0", name: "read", content: [{ type: "text", text: "done" }], isError: false } },
      ],
      status: {
        running: true,
        streaming: [],
        runningTools: [
          { callId: "c1", name: "write" },
          { callId: "c-extra", name: "bash" },
        ],
        queue: { steer: 1, followUp: 2 },
      },
    };
    const { messages, queueEvent } = replaySessionToUi(replay);
    expect(queueEvent).toEqual({ type: "queue", steering: 1, followUp: 2 });
    const calls = messages[1]?.toolCalls ?? [];
    expect(calls[0]).toMatchObject({ id: "c0", running: false, result: "done", isError: false });
    expect(calls[1]).toMatchObject({
      id: "c1",
      running: true,
      args: { path: "busy.ts", content: "ok" },
      startedAt: Date.parse("2026-10-29T00:00:02.000Z"),
    });
    expect(calls[2]).toMatchObject({ id: "c2", running: false });
    expect(calls[3]).toMatchObject({ id: "c-extra", name: "bash", running: true });
  });

  it("replays streaming chunks with retry reset and seeds partial tool-call arguments for live continuation", () => {
    const replay: SessionSubscribeResult = {
      liveSeq: 9,
      events: [
        { seq: 1, ts: "2026-10-29T00:00:00.000Z", type: "user", data: { content: [{ type: "text", text: "write file" }] } },
      ],
      status: {
        running: true,
        runningTools: [],
        queue: { steer: 0, followUp: 0 },
        streaming: [
          { type: "text-delta", index: 0, text: "stale attempt" },
          { type: "retry", attempt: 1, maxAttempts: 3, delayMs: 2_000, error: { kind: "network", message: "reset", retryable: true } },
          { type: "thinking-delta", index: 0, text: "Plan step" },
          { type: "text-delta", index: 1, text: "Writing " },
          { type: "tool-call-start", index: 2, id: "tc-1", name: "write" },
          { type: "tool-call-delta", index: 2, argumentsDelta: '{"path":"src/app' },
          { type: "tool-call-delta", index: 2, argumentsDelta: '.ts","content":"he' },
        ],
      },
    };
    const { messages, translator, queueEvent } = replaySessionToUi(replay);
    expect(queueEvent).toBeUndefined();
    expect(messages).toHaveLength(2);
    expect(messages[1]).toMatchObject({
      role: "assistant",
      isStreaming: true,
      thinking: "Plan step",
      content: "Writing ",
      toolCalls: [{ id: "tc-1", name: "write", args: { path: "src/app.ts" }, running: true }],
    });

    // Live chunks arriving afterwards continue assembling the partial JSON tool arguments.
    const liveEvents = [
      ...translator.delta({ type: "llm-chunk", chunk: { type: "tool-call-delta", index: 2, argumentsDelta: 'llo"}' } }),
      ...translator.delta({ type: "llm-chunk", chunk: { type: "finish", reason: "tool-use" } }),
    ];
    expect(liveEvents.at(-1)).toEqual({
      type: "assistant-tool-calls",
      calls: [{ id: "tc-1", name: "write", args: { path: "src/app.ts", content: "hello" }, running: true }],
    });

    // seedTranslatorFromStatus gives identical tool-call continuation on attach.
    const seeded = seedTranslatorFromStatus(replay.status);
    const continued = [
      ...seeded.delta({ type: "llm-chunk", chunk: { type: "tool-call-delta", index: 2, argumentsDelta: 'llo"}' } }),
      ...seeded.delta({ type: "llm-chunk", chunk: { type: "finish", reason: "tool-use" } }),
    ];
    expect(continued).toEqual([
      { type: "assistant-tool-calls", calls: [{ id: "tc-1", name: "write", args: { path: "src/app.ts", content: "hello" }, running: true }] },
    ]);
  });

  it("buildResumeEvents replays active stream cleanly onto an existing streaming bubble without duplicating text", () => {
    const translator = new TranscriptTranslator();
    const events = buildResumeEvents(
      {
        running: true,
        runningTools: [],
        queue: { steer: 1, followUp: 0 },
        streaming: [
          { type: "text-delta", index: 0, text: "Par" },
          { type: "text-delta", index: 0, text: "tial" },
        ],
      },
      translator,
    );

    // Simulate store already holding "Par" before disconnect.
    let messages = streamAssistant([], { text: "Par" }, 100);
    for (const event of events) {
      if (event.type === "retry-status") messages = resetStreamingAssistant(messages);
      else if (event.type === "assistant-delta") messages = streamAssistant(messages, { text: event.text, thinking: event.thinking });
      else if (event.type === "assistant-tool-calls") messages = streamAssistant(messages, { toolCalls: event.calls });
    }
    expect(messages).toHaveLength(1);
    expect(messages[0]?.content).toBe("Partial");
    expect(events.at(-1)).toEqual({ type: "queue", steering: 1, followUp: 0 });
  });

  it("treats aborted compaction-end as non-failed and settles stopped turns cleanly", () => {
    const translator = new TranscriptTranslator();
    expect(translator.delta({ type: "compaction-end", ok: false, aborted: true })).toEqual([
      { type: "compaction-end", failed: false },
    ]);
    expect(translator.delta({ type: "compaction-end", ok: false })).toEqual([
      { type: "compaction-end", failed: true },
    ]);

    const settled = [
      { id: "u1", role: "user" as const, content: "hi", timestamp: 1 },
      { id: "a1", role: "assistant" as const, content: "done", isStreaming: false, isAborted: false, timestamp: 2 },
    ];
    expect(settleStoppedTurn(settled)).toBe(settled);

    const withEmptyPlaceholder = [
      ...settled,
      { id: "u2", role: "user" as const, content: "next", timestamp: 3 },
      { id: "a2", role: "assistant" as const, content: "", isStreaming: true, timestamp: 4 },
    ];
    expect(settleStoppedTurn(withEmptyPlaceholder).map((m) => m.id)).toEqual(["u1", "a1", "u2"]);

    const partialWithTool = [
      { id: "u1", role: "user" as const, content: "go", timestamp: 1 },
      {
        id: "a1",
        role: "assistant" as const,
        content: "partial",
        isStreaming: true,
        toolCalls: [{ id: "c1", name: "bash", args: {}, running: true }],
        timestamp: 2,
      },
    ];
    const result = settleStoppedTurn(partialWithTool, 999);
    expect(result[1]).toMatchObject({
      isStreaming: false,
      isAborted: true,
      toolCalls: [{ id: "c1", running: false, isError: true, finishedAt: 999 }],
    });
  });
});

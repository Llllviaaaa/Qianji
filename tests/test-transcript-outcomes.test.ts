import assert from "node:assert/strict";
import type { LiveDelta, PersistedEvent } from "@qianji/protocol";
import { describe, test } from "vitest";
import { settledEmptyTurnHint } from "../src/components/message/messageHelpers";
import { assistantMessageOf, historyToUi, settleStoppedTurn, startAssistant, TranscriptTranslator } from "../src/lib/transcript";
import { groupTranscriptMessages, mergeAssistantTurn } from "../src/lib/transcriptTurns";
import type { UiMessage } from "../src/types";

describe("transcript outcome propagation & settled hints", () => {
  test("TranscriptTranslator propagates agent-end outcome", () => {
    const translator = new TranscriptTranslator();
    for (const outcome of ["done", "aborted", "error", "max-turns"] as const) {
      assert.deepEqual(
        translator.delta({ type: "agent-end", outcome } as LiveDelta),
        [{ type: "turn-end", outcome }],
      );
    }
    assert.deepEqual(
      translator.delta({ type: "agent-end" } as unknown as LiveDelta),
      [{ type: "turn-end", outcome: undefined }],
    );
  });

  test("assistantMessageOf and mergeAssistantTurn preserve stopReason", () => {
    const first = assistantMessageOf({
      seq: 2,
      ts: "2026-10-14T10:00:01.000Z",
      type: "assistant",
      data: {
        stop: "tool-use",
        content: [{ type: "tool-call", id: "call-1", name: "read", arguments: { path: "a.ts" } }],
      },
    });
    const second = assistantMessageOf({
      seq: 4,
      ts: "2026-10-14T10:00:03.000Z",
      type: "assistant",
      data: {
        stop: "stop",
        content: [{ type: "text", text: "" }],
      },
    });
    assert.equal(first.stopReason, "tool-use");
    assert.equal(second.stopReason, "stop");
    assert.equal(mergeAssistantTurn([first, second]).stopReason, "stop");
    assert.equal(mergeAssistantTurn([first]).stopReason, "tool-use");
  });

  test("settleStoppedTurn handles max-turns, pre-token aborted, uncaught error, and default user stop", () => {
    const userMsg: UiMessage = { id: "u1", role: "user", content: "run checks", timestamp: 100 };
    const completedToolAssistant: UiMessage = {
      id: "a1",
      role: "assistant",
      content: "",
      stopReason: "tool-use",
      isStreaming: false,
      isAborted: false,
      isError: false,
      toolCalls: [{ id: "c1", name: "bash", args: { command: "ls" }, result: "file.txt", isError: false, running: false }],
      timestamp: 200,
    };

    // Default user stop without outcome leaves already-settled assistant untouched if nothing is streaming.
    const untouched = settleStoppedTurn([userMsg, completedToolAssistant], 300);
    assert.equal(untouched[1]?.isAborted, false);
    assert.equal(untouched[1]?.stopReason, "tool-use");

    // Pre-token abort after tool turn drops empty Turn N+1 placeholder and marks Turn N assistant aborted.
    const withEmptyNext = startAssistant([userMsg, completedToolAssistant], 250);
    const settledAborted = settleStoppedTurn(withEmptyNext, 300, "aborted");
    assert.equal(settledAborted.length, 2);
    assert.equal(settledAborted[1]?.isAborted, true);
    assert.equal(settledAborted[1]?.isError, false);

    // max-turns sets stopReason: "max-turns" on the active turn's last assistant message and invalidates merge cache.
    const groupedBefore = groupTranscriptMessages([userMsg, completedToolAssistant]);
    assert.equal(groupedBefore[1]?.stopReason, "tool-use");
    const settledMaxTurns = settleStoppedTurn([userMsg, completedToolAssistant], 300, "max-turns");
    const groupedAfter = groupTranscriptMessages(settledMaxTurns);
    assert.equal(groupedAfter[1]?.stopReason, "max-turns");

    // Uncaught error marks last assistant message isError: true when no assistant message in turn had isError.
    const settledErrorOnExisting = settleStoppedTurn(withEmptyNext, 300, "error");
    assert.equal(settledErrorOnExisting.length, 2);
    assert.equal(settledErrorOnExisting[1]?.isError, true);
    assert.equal(settledErrorOnExisting[1]?.isAborted, false);

    // Uncaught error before any assistant reply appends an error assistant message.
    const settledErrorWithoutAssistant = settleStoppedTurn(startAssistant([userMsg], 150), 300, "error");
    assert.equal(settledErrorWithoutAssistant.length, 2);
    assert.equal(settledErrorWithoutAssistant[1]?.role, "assistant");
    assert.equal(settledErrorWithoutAssistant[1]?.isError, true);

    // Already-recorded LlmError in turn is not overwritten or duplicated.
    const recordedError: UiMessage = {
      id: "a-err",
      role: "assistant",
      content: "401 Unauthorized",
      isError: true,
      stopReason: "error",
      timestamp: 220,
    };
    const preservedError = settleStoppedTurn([userMsg, completedToolAssistant, recordedError], 300, "error");
    assert.equal(preservedError.length, 3);
    assert.equal(preservedError[1]?.isError, false);
    assert.equal(preservedError[2]?.content, "401 Unauthorized");
  });

  test("historyToUi marks tool-use turns aborted only when all tool calls failed with Aborted messages", () => {
    const events: PersistedEvent[] = [
      { seq: 1, ts: "2026-10-14T10:00:00.000Z", type: "user", data: { content: [{ type: "text", text: "turn 1" }] } },
      {
        seq: 2,
        ts: "2026-10-14T10:00:01.000Z",
        type: "assistant",
        data: {
          stop: "tool-use",
          content: [{ type: "tool-call", id: "t1", name: "bash", arguments: { command: "sleep 5" } }],
        },
      },
      {
        seq: 3,
        ts: "2026-10-14T10:00:02.000Z",
        type: "tool-result",
        data: { callId: "t1", name: "bash", isError: true, content: [{ type: "text", text: "Aborted." }] },
      },
      { seq: 4, ts: "2026-10-14T10:01:00.000Z", type: "user", data: { content: [{ type: "text", text: "turn 2" }] } },
      {
        seq: 5,
        ts: "2026-10-14T10:01:01.000Z",
        type: "assistant",
        data: {
          stop: "tool-use",
          content: [
            { type: "tool-call", id: "t2", name: "read", arguments: { path: "a.ts" } },
            { type: "tool-call", id: "t3", name: "bash", arguments: { command: "exit 1" } },
          ],
        },
      },
      {
        seq: 6,
        ts: "2026-10-14T10:01:02.000Z",
        type: "tool-result",
        data: { callId: "t2", name: "read", isError: false, content: [{ type: "text", text: "ok" }] },
      },
      {
        seq: 7,
        ts: "2026-10-14T10:01:03.000Z",
        type: "tool-result",
        data: { callId: "t3", name: "bash", isError: true, content: [{ type: "text", text: "Command exited with 1" }] },
      },
    ];

    const ui = historyToUi(events);
    assert.equal(ui[1]?.isAborted, true);
    assert.equal(ui[3]?.isAborted, false);
    assert.equal(ui[3]?.stopReason, "tool-use");
  });

  test("settledEmptyTurnHint distinguishes max-turns, tool-use, and empty model summary", () => {
    const base = {
      working: false,
      hasContent: false,
      hasProcess: true,
      hasUiWidgets: false,
      hadOnlyHiddenTools: false,
      toolCallCount: 2,
      hasTurnTelemetry: true,
    };

    assert.deepEqual(settledEmptyTurnHint({ ...base, stopReason: "max-turns" }), {
      autoOpenProcess: true,
      hint: "已达到单轮最大执行步数上限，已展开本轮执行步骤（可输入「继续」接着执行）",
    });
    assert.deepEqual(settledEmptyTurnHint({ ...base, stopReason: "tool-use" }), {
      autoOpenProcess: true,
      hint: "本轮在工具执行后提前结束，已展开本轮执行步骤（可输入「继续」接着执行）",
    });
    assert.deepEqual(settledEmptyTurnHint({ ...base, stopReason: "stop" }), {
      autoOpenProcess: true,
      hint: "模型未输出总结回复，已展开本轮执行步骤（可输入「继续」接着执行）",
    });
    assert.deepEqual(settledEmptyTurnHint({ ...base, stopReason: undefined }), {
      autoOpenProcess: true,
      hint: "模型未输出总结回复，已展开本轮执行步骤（可输入「继续」接着执行）",
    });
    assert.deepEqual(settledEmptyTurnHint({ ...base, stopReason: "max-turns", isAborted: true }), {
      autoOpenProcess: false,
      hint: null,
    });
  });
});

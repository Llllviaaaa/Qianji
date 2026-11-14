import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { Markdown } from "../src/components/Markdown";
import { Message } from "../src/components/Message";
import {
  deriveTurnPlans,
  deriveTurnPlanState,
  findLatestTurnPlanMessageId,
  type TaskPlanStatus,
} from "../src/lib/envSources";
import {
  deriveSessionIntelligentUis,
  messageMayContainIntelligentUi,
} from "../src/lib/intelligentUi";
import { splitStreamingMarkdownBlocks } from "../src/lib/streamingMarkdown";
import { groupTranscriptMessages } from "../src/lib/transcriptTurns";
import type { UiMessage } from "../src/types";
import { withQueryClient } from "./support/withQueryClient";

const REPO_ROOT = resolve(import.meta.dirname, "..");

const planCall = (id: string, statuses: TaskPlanStatus[], explanation = "") => ({
  id,
  name: "update_plan",
  args: {
    explanation,
    items: statuses.map((status, index) => ({ id: `step-${index + 1}`, text: `Step ${index + 1}`, status })),
  },
  running: false,
});

function uncachedDeriveTurnPlans(messages: UiMessage[], skipOpenTurn = false): Map<string, ReturnType<typeof deriveTurnPlans> extends Map<string, infer V> ? V : never> {
  const plans = new Map<string, ReturnType<typeof deriveTurnPlans> extends Map<string, infer V> ? V : never>();
  let end = messages.length;
  if (skipOpenTurn) {
    while (end > 0 && messages[end - 1]?.role !== "user") end -= 1;
  }
  let turnPlan: { messageId: string; plan: ReturnType<typeof deriveTurnPlans> extends Map<string, infer V> ? V : never } | null = null;
  for (let index = 0; index < end; index += 1) {
    const message = messages[index];
    if (!message) continue;
    if (message.role === "user") {
      if (turnPlan) plans.set(turnPlan.messageId, turnPlan.plan);
      turnPlan = null;
      continue;
    }
    const scratch = deriveTurnPlans([message]);
    const plan = scratch.get(message.id);
    if (plan) turnPlan = { messageId: message.id, plan };
  }
  if (turnPlan) plans.set(turnPlan.messageId, turnPlan.plan);
  return plans;
}

describe("Streaming Markdown & React Performance Hardening", () => {
  it("splits streaming markdown on outside blank lines while preserving nested and unclosed fences", () => {
    expect(splitStreamingMarkdownBlocks("")).toEqual([]);
    expect(splitStreamingMarkdownBlocks("   \n\n\t ")).toEqual([]);

    expect(splitStreamingMarkdownBlocks("Alpha\n\nBeta\n  \n\nGamma")).toEqual([
      "Alpha",
      "Beta",
      "Gamma",
    ]);

    expect(splitStreamingMarkdownBlocks("First\r\n\r\n```ts\r\nconst x = 1;\r\n\r\nconst y = 2;\r\n```\r\n\r\nLast")).toEqual([
      "First",
      "```ts\nconst x = 1;\n\nconst y = 2;\n```",
      "Last",
    ]);

    // 4-backtick outer fence must not close on inner 3-backtick lines or split on inner blank lines.
    const nestedBackticks = [
      "Intro",
      "",
      "````markdown",
      "```ts",
      "const a = 1;",
      "",
      "const b = 2;",
      "```",
      "",
      "Still inside 4-backtick fence",
      "````",
      "",
      "Outro",
    ].join("\n");
    expect(splitStreamingMarkdownBlocks(nestedBackticks)).toEqual([
      "Intro",
      [
        "````markdown",
        "```ts",
        "const a = 1;",
        "",
        "const b = 2;",
        "```",
        "",
        "Still inside 4-backtick fence",
        "````",
      ].join("\n"),
      "Outro",
    ]);

    // Tilde fence ignores inner triple backticks.
    const tildeFence = [
      "~~~md",
      "```",
      "",
      "inside tilde",
      "~~~",
      "",
      "after tilde",
    ].join("\n");
    expect(splitStreamingMarkdownBlocks(tildeFence)).toEqual([
      ["~~~md", "```", "", "inside tilde", "~~~"].join("\n"),
      "after tilde",
    ]);

    // Unclosed / streaming fence remains in the single trailing block.
    const streamingFence = "Summary\n\n```mermaid\ngraph TD\n\n  A --> B";
    expect(splitStreamingMarkdownBlocks(streamingFence)).toEqual([
      "Summary",
      "```mermaid\ngraph TD\n\n  A --> B",
    ]);

    // Inline triple-backtick code span on one line does not open a block fence.
    expect(splitStreamingMarkdownBlocks("```inline``` example\n\nNext paragraph")).toEqual([
      "```inline``` example",
      "Next paragraph",
    ]);
  });

  it("defers DiagramBlock mounting while a trailing diagram fence is streaming", () => {
    const unclosedMermaid = "```mermaid\ngraph TD\n  A --> B";
    const streamingUnclosed = renderToStaticMarkup(withQueryClient(createElement(Markdown, {
      content: unclosedMermaid,
      isStreaming: true,
    })));
    assert.match(streamingUnclosed, /class="markdown-code"/);
    assert.doesNotMatch(streamingUnclosed, /aria-label="Mermaid 图形"/);

    const closedMermaid = "```mermaid\ngraph TD\n  A --> B\n```";
    const streamingSingleBlock = renderToStaticMarkup(withQueryClient(createElement(Markdown, {
      content: closedMermaid,
      isStreaming: true,
    })));
    assert.match(streamingSingleBlock, /class="markdown-code"/);
    assert.doesNotMatch(streamingSingleBlock, /aria-label="Mermaid 图形"/);

    // Settled first diagram block mounts DiagramBlock while trailing plantuml fence stays deferred.
    const multiBlockStreaming = `${closedMermaid}\n\n\`\`\`plantuml\n@startuml\nAlice -> Bob`;
    const multiMarkup = renderToStaticMarkup(withQueryClient(createElement(Markdown, {
      content: multiBlockStreaming,
      isStreaming: true,
    })));
    assert.match(multiMarkup, /aria-label="Mermaid 图形"/);
    assert.doesNotMatch(multiMarkup, /aria-label="PlantUML 图形"/);
    assert.match(multiMarkup, /class="markdown-code"/);

    // Once streaming stops, the trailing diagram mounts normally.
    const settledMarkup = renderToStaticMarkup(withQueryClient(createElement(Markdown, {
      content: closedMermaid,
      isStreaming: false,
    })));
    assert.match(settledMarkup, /aria-label="Mermaid 图形"/);

    // Message propagates working -> Markdown isStreaming.
    const streamingMessageMarkup = renderToStaticMarkup(withQueryClient(createElement(Message, {
      message: { id: "m-stream", role: "assistant", content: closedMermaid, timestamp: 100, isStreaming: true },
    })));
    assert.doesNotMatch(streamingMessageMarkup, /aria-label="Mermaid 图形"/);
    assert.match(streamingMessageMarkup, /class="markdown-code"/);

    const settledMessageMarkup = renderToStaticMarkup(withQueryClient(createElement(Message, {
      message: { id: "m-stream", role: "assistant", content: closedMermaid, timestamp: 100, isStreaming: false },
    })));
    assert.match(settledMessageMarkup, /aria-label="Mermaid 图形"/);
  });

  it("keeps deriveSessionIntelligentUis === stable across streaming text deltas and updates on UI artifacts", () => {
    const u1: UiMessage = { id: "sui-u1", role: "user", content: "Create widget", timestamp: 10 };
    const a1Ui: UiMessage = {
      id: "sui-a1",
      role: "assistant",
      content: "Created.",
      timestamp: 20,
      toolCalls: [{
        id: "tc-render",
        name: "render_ui",
        args: {
          id: "calc",
          title: "Calc",
          engine: "declarative",
          spec: { blocks: [{ type: "stats", items: [{ label: "Total", value: 42 }] }] },
        },
        running: false,
      }],
    };
    const u2: UiMessage = { id: "sui-u2", role: "user", content: "Explain", timestamp: 30 };
    const a2Tick1: UiMessage = { id: "sui-a2", role: "assistant", content: "Part 1", isStreaming: true, timestamp: 40 };
    const a2Tick2: UiMessage = { ...a2Tick1, content: "Part 1 + Part 2" };

    expect(messageMayContainIntelligentUi(a1Ui)).toBe(true);
    expect(messageMayContainIntelligentUi(a2Tick1)).toBe(false);

    const s1 = deriveSessionIntelligentUis([u1, a1Ui, u2, a2Tick1]);
    const s2 = deriveSessionIntelligentUis([u1, a1Ui, u2, a2Tick2]);
    expect(s2).toBe(s1);
    expect(s2.turnWidgetsByMessageId).toBe(s1.turnWidgetsByMessageId);
    expect(s2.groupsById).toBe(s1.groupsById);

    // Appending a plain user + assistant message also keeps the exact cached summary reference.
    const u3: UiMessage = { id: "sui-u3", role: "user", content: "More text", timestamp: 50 };
    const a3Plain: UiMessage = { id: "sui-a3", role: "assistant", content: "Plain answer", isStreaming: true, timestamp: 60 };
    const s3 = deriveSessionIntelligentUis([u1, a1Ui, u2, a2Tick2, u3, a3Plain]);
    expect(s3).toBe(s1);

    // Emitting an intelligent-ui fence on the trailing message updates the summary.
    const a3Fence: UiMessage = {
      ...a3Plain,
      content: '```intelligent-ui\n{"id":"badge","title":"Badge","engine":"html","html":"<div>ok</div>"}\n```',
    };
    const s4 = deriveSessionIntelligentUis([u1, a1Ui, u2, a2Tick2, u3, a3Fence]);
    expect(s4).not.toBe(s1);
    expect(s4.orderedGroups.map((group) => group.id)).toEqual(["calc", "badge"]);

    // Updating via update_ui tool call updates the summary.
    const a3UpdateTool: UiMessage = {
      ...a3Plain,
      toolCalls: [{
        id: "tc-upd",
        name: "update_ui",
        args: { id: "calc", title: "Calc v2" },
        running: false,
      }],
    };
    const s5 = deriveSessionIntelligentUis([u1, a1Ui, u2, a2Tick2, u3, a3UpdateTool]);
    expect(s5.groupsById.get("calc")?.versions).toHaveLength(2);
    expect(s5.turnWidgetsByMessageId.get("sui-a3")).toEqual([{ id: "calc", version: 2, action: "update" }]);

    // Rewinding drops the trailing widgets cleanly.
    const sRewind = deriveSessionIntelligentUis([u1, a1Ui]);
    expect(sRewind.orderedGroups.map((group) => group.id)).toEqual(["calc"]);
    expect(sRewind.turnWidgetsByMessageId.has("sui-a3")).toBe(false);
  });

  it("reuses settled prefixes and preserves parity in groupTranscriptMessages and deriveTurnPlanState", () => {
    const u1: UiMessage = { id: "tp-u1", role: "user", content: "First", timestamp: 100 };
    const a1Step: UiMessage = {
      id: "tp-a1",
      role: "assistant",
      content: "Checking",
      toolCalls: [planCall("p1", ["in_progress", "pending"])],
      timestamp: 110,
    };
    const a1Planned: UiMessage = {
      id: "tp-a1-plan",
      role: "assistant",
      content: "",
      toolCalls: [planCall("p2", ["completed", "completed"], "Turn 1 done")],
      timestamp: 115,
    };
    const a1Done: UiMessage = {
      id: "tp-a1-done",
      role: "assistant",
      content: "Done 1",
      timestamp: 120,
    };
    const u2: UiMessage = { id: "tp-u2", role: "user", content: "Second", timestamp: 200 };
    const a2Step: UiMessage = {
      id: "tp-a2",
      role: "assistant",
      content: "",
      toolCalls: [planCall("p3", ["completed", "in_progress"], "Turn 2 wip")],
      timestamp: 205,
    };
    const a2Tick1: UiMessage = {
      id: "tp-a2-final",
      role: "assistant",
      content: "Streaming 1",
      isStreaming: true,
      timestamp: 210,
    };
    const a2Tick2: UiMessage = {
      ...a2Tick1,
      content: "Streaming 1 + 2",
    };

    const raw1 = [u1, a1Step, a1Planned, a1Done, u2, a2Step, a2Tick1];
    const grouped1 = groupTranscriptMessages(raw1);
    const grouped2 = groupTranscriptMessages([u1, a1Step, a1Planned, a1Done, u2, a2Step, a2Tick2]);
    expect(grouped2).toHaveLength(4);
    expect(grouped2[0]).toBe(grouped1[0]);
    expect(grouped2[1]).toBe(grouped1[1]);
    expect(grouped2[2]).toBe(grouped1[2]);
    expect(grouped2[3]).not.toBe(grouped1[3]);
    expect(grouped2[3]?.content).toBe("Streaming 1 + 2");

    // Rewinding / editing an earlier turn invalidates the settled prefix cleanly.
    const a1Edited: UiMessage = { ...a1Done, content: "Edited 1" };
    const editedGrouped = groupTranscriptMessages([u1, a1Step, a1Planned, a1Edited, u2, a2Step, a2Tick2]);
    expect(editedGrouped[1]).not.toBe(grouped1[1]);
    expect(editedGrouped[1]?.content).toBe("Edited 1");
    const shrunkGrouped = groupTranscriptMessages([u1, a1Step]);
    expect(shrunkGrouped).toHaveLength(2);
    expect(shrunkGrouped[1]?.content).toBe("");

    // deriveTurnPlanState single-pass + streaming stability + uncached parity.
    const streamingState1 = deriveTurnPlanState(grouped1, true);
    const streamingState2 = deriveTurnPlanState(grouped2, true);
    expect(streamingState1.turnPlans.get("tp-a1")?.explanation).toBe("Turn 1 done");
    expect(streamingState1.turnPlans.has("tp-a2")).toBe(false);
    expect(streamingState1.latestPlanMessageId).toBe("tp-a2");
    expect(streamingState2.turnPlans).toBe(streamingState1.turnPlans);
    expect(streamingState2.latestPlanMessageId).toBe("tp-a2");

    const settledState = deriveTurnPlanState(grouped2, false);
    expect(settledState.turnPlans.get("tp-a2")?.explanation).toBe("Turn 2 wip");
    expect(settledState.latestPlanMessageId).toBe("tp-a2");
    expect(findLatestTurnPlanMessageId(grouped2)).toBe("tp-a2");

    // Stable empty Map reuse across streaming frames with no plans.
    const plainU: UiMessage = { id: "plain-u", role: "user", content: "Hi", timestamp: 1 };
    const plainA1: UiMessage = { id: "plain-a", role: "assistant", content: "H", isStreaming: true, timestamp: 2 };
    const plainA2: UiMessage = { ...plainA1, content: "Hello" };
    const emptyState1 = deriveTurnPlanState([plainU, plainA1], true);
    const emptyState2 = deriveTurnPlanState([plainU, plainA2], true);
    expect(emptyState1.turnPlans.size).toBe(0);
    expect(emptyState2.turnPlans).toBe(emptyState1.turnPlans);
    expect(emptyState2).toBe(emptyState1);

    // Parity check against uncached derivation across split notice + rewind + no-user cases.
    const noticeSplit: UiMessage[] = [
      u1,
      a1Step,
      { id: "n1", role: "notice", noticeKind: "compaction", content: "Compacted", timestamp: 112 },
      a1Planned,
      a1Done,
      u2,
      a2Step,
      a2Tick2,
    ];
    expect(deriveTurnPlans(noticeSplit, true)).toEqual(uncachedDeriveTurnPlans(noticeSplit, true));
    expect(deriveTurnPlans(noticeSplit, false)).toEqual(uncachedDeriveTurnPlans(noticeSplit, false));
    expect(deriveTurnPlans([a1Step, a1Planned], true)).toEqual(uncachedDeriveTurnPlans([a1Step, a1Planned], true));
    expect(deriveTurnPlans([a1Step, a1Planned], false)).toEqual(uncachedDeriveTurnPlans([a1Step, a1Planned], false));
  });

  it("applies content-visibility virtualization only to settled turns via @layer components", () => {
    const perfCss = readFileSync(resolve(REPO_ROOT, "src/styles/conversation-perf.css"), "utf8");
    const indexCss = readFileSync(resolve(REPO_ROOT, "src/styles/index.css"), "utf8");

    expect(indexCss).toContain('@import "./conversation-perf.css" layer(components);');
    expect(perfCss).toContain("content-visibility: auto;");
    expect(perfCss).toContain("contain-intrinsic-size: auto 180px;");
    expect(perfCss).toContain("article.dshc-turn");
    expect(perfCss).toContain(":not([data-turn-open])");
    expect(perfCss).toContain(":not([data-dsh-claude-turn-nav-landed])");
    expect(perfCss).toContain(":not(:focus-within)");
  });
});

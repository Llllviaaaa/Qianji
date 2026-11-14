import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ConversationPlan } from "../src/components/ConversationPlan";
import { Message } from "../src/components/Message";
import {
  currentPlanStepIndex,
  deriveLiveTaskPlan,
  deriveTaskPlan,
  deriveTurnPlanState,
  deriveTurnPlans,
  type TaskPlanStatus,
} from "../src/lib/envSources";
import type { UiMessage } from "../src/types";
import { test } from "vitest";

const planCall = (id: string, statuses: TaskPlanStatus[], explanation = "") => ({
  id,
  name: "update_plan",
  args: {
    explanation,
    items: statuses.map((status, index) => ({ id: `step-${index + 1}`, text: `Step ${index + 1}`, status })),
  },
  running: false,
});

const user = (id: string, content = "Do the work."): UiMessage => ({
  id,
  role: "user",
  content,
  timestamp: 1,
});

const assistant = (
  id: string,
  toolCalls: UiMessage["toolCalls"] = [],
  content = "Done.",
  extra: Partial<UiMessage> = {},
): UiMessage => ({
  id,
  role: "assistant",
  content,
  timestamp: 2,
  toolCalls,
  ...extra,
});

const planOf = (statuses: TaskPlanStatus[], explanation = "") => {
  const plan = deriveTaskPlan([assistant("plan-owner", [planCall("plan", statuses, explanation)])]);
  assert.ok(plan);
  return plan;
};

test("turn plans", () => {
  const transcript: UiMessage[] = [
    user("u1"),
    assistant("a1", [planCall("p1", ["in_progress", "pending"]), planCall("p2", ["completed", "completed"], "Shipped")]),
    user("u2"),
    assistant("a2"),
  ];

  // A turn without update_plan carries no plan; the finished plan stays with its own turn.
  const plans = deriveTurnPlans(transcript);
  assert.deepEqual([...plans.keys()], ["a1"]);
  assert.equal(plans.get("a1")?.completed, 2);
  assert.equal(plans.get("a1")?.explanation, "Shipped");
  assert.equal(plans.has("a2"), false);
  assert.equal(deriveLiveTaskPlan(transcript), null);
  assert.equal(deriveTaskPlan(transcript)?.explanation, "Shipped", "the side panel still shows the newest plan");

  // When a notice splits one turn, only the last plan in that turn is shown.
  const split = deriveTurnPlans([
    user("u1"),
    assistant("a1", [planCall("p1", ["in_progress", "pending"])]),
    { id: "n1", role: "notice", noticeKind: "compaction", content: "Context compacted", timestamp: 3 },
    assistant("a2", [planCall("p2", ["completed", "in_progress"])]),
  ]);
  assert.deepEqual([...split.keys()], ["a2"]);

  // While the open turn streams, its plan moves to the composer and leaves the transcript.
  const streaming: UiMessage[] = [
    user("u1"),
    assistant("a1", [planCall("p1", ["completed", "completed"])]),
    user("u2"),
    assistant("a2", [planCall("p2", ["completed", "in_progress", "pending"])], ""),
  ];
  assert.deepEqual([...deriveTurnPlans(streaming, true).keys()], ["a1"]);
  assert.deepEqual([...deriveTurnPlans(streaming).keys()], ["a1", "a2"]);
  const live = deriveLiveTaskPlan(streaming);
  assert.equal(live?.steps.length, 3);
  assert.equal(live && currentPlanStepIndex(live), 1);

  // A new turn that has not planned yet shows no live plan, even if an earlier turn did.
  assert.equal(deriveLiveTaskPlan([...streaming.slice(0, 2), user("u2")]), null);

  assert.equal(currentPlanStepIndex(planOf(["completed", "pending", "pending"])), 1);
  assert.equal(currentPlanStepIndex(planOf(["completed", "completed"])), 1);
});

test("turn plan rendering", () => {
  const plan = planOf(["completed", "completed"], "Shipped the dashboard");

  // Collapsed by default: one row, no step list.
  const row = renderToStaticMarkup(createElement(ConversationPlan, { plan }));
  assert.match(row, /计划 2\/2 已完成/);
  assert.match(row, /Shipped the dashboard/);
  assert.match(row, /aria-expanded="false"/);
  assert.doesNotMatch(row, /class="plan-steps"/);
  assert.doesNotMatch(row, /在侧栏查看计划/);
  assert.match(renderToStaticMarkup(createElement(ConversationPlan, { plan, onOpenPlan: () => undefined })), /在侧栏查看计划/);

  const message = assistant("a1", [planCall("p1", ["completed", "completed"])]);
  assert.match(renderToStaticMarkup(createElement(Message, { message, plan })), /class="turn-plan"/);

  // The working turn leaves its plan to the composer.
  const working = renderToStaticMarkup(createElement(Message, {
    message: { ...message, content: "" },
    plan,
    isLastAssistant: true,
    globalStreaming: true,
  }));
  assert.doesNotMatch(working, /class="turn-plan"/);
});

test("interrupted turn continuation moves unfinished plan forward instead of duplicating on old turns", () => {
  const fourOfFive: TaskPlanStatus[] = ["completed", "completed", "completed", "completed", "in_progress"];
  const fiveOfFive: TaskPlanStatus[] = ["completed", "completed", "completed", "completed", "completed"];

  const u1 = user("u1", "Build feature");
  const a1Interrupted = assistant(
    "a1",
    [planCall("p1", fourOfFive, "Almost done")],
    "这一轮因 Harness 断开而中断",
    { isError: true },
  );
  const u2 = user("u2", "继续");
  const a2Streaming = assistant("a2", [], "", { isStreaming: true });

  // While streaming continuation with no new update_plan yet, the 4/5 plan stays live on a2 and leaves a1.
  const duringContinuation = [u1, a1Interrupted, u2, a2Streaming];
  const livePlan = deriveLiveTaskPlan(duringContinuation);
  assert.equal(livePlan?.completed, 4);
  assert.equal(livePlan?.steps.length, 5);
  assert.equal(livePlan?.explanation, "Almost done");
  assert.deepEqual([...deriveTurnPlans(duringContinuation, true).keys()], []);
  const streamingState = deriveTurnPlanState(duringContinuation, true);
  assert.equal(streamingState.latestPlanMessageId, "a2");

  // Once a2 calls update_plan (5/5) and settles, only a2 owns the plan (no stale 4/5 card on a1).
  const a2Finished = assistant("a2", [planCall("p2", fiveOfFive, "All shipped")], "Finished.");
  const afterFinish = [u1, a1Interrupted, u2, a2Finished];
  const finishedPlans = deriveTurnPlans(afterFinish, false);
  assert.deepEqual([...finishedPlans.keys()], ["a2"]);
  assert.equal(finishedPlans.get("a2")?.completed, 5);
  assert.equal(finishedPlans.get("a2")?.explanation, "All shipped");

  // If a2 stops without calling update_plan, the unfinished 4/5 plan settles on a2.
  const a2NoPlan = assistant("a2", [], "Stopped early.");
  const settledOnA2 = deriveTurnPlans([u1, a1Interrupted, u2, a2NoPlan], false);
  assert.deepEqual([...settledOnA2.keys()], ["a2"]);
  assert.equal(settledOnA2.get("a2")?.completed, 4);

  // If the thread ends right at u2 with no assistant message yet, it falls back to a1 when settled.
  const fallbackBeforeA2 = deriveTurnPlans([u1, a1Interrupted, u2], false);
  assert.deepEqual([...fallbackBeforeA2.keys()], ["a1"]);
  assert.equal(fallbackBeforeA2.get("a1")?.completed, 4);

  // An earlier finished turn stays pinned on its own message while a later unfinished plan carries over.
  const finishedTurnUser = user("u0", "Turn 0");
  const finishedTurnAssistant = assistant("a0", [planCall("p0", ["completed", "completed"], "Turn 0 done")]);
  const multiTurn = [finishedTurnUser, finishedTurnAssistant, u1, a1Interrupted, u2, a2NoPlan, user("u3", "再继续"), assistant("a3", [], "", { isStreaming: true })];
  const multiStreaming = deriveTurnPlanState(multiTurn, true);
  assert.deepEqual([...multiStreaming.turnPlans.keys()], ["a0"]);
  assert.equal(multiStreaming.latestPlanMessageId, "a3");
  const multiSettled = deriveTurnPlans(multiTurn, false);
  assert.deepEqual([...multiSettled.keys()], ["a0", "a3"]);
});

test("clearing plans via update_plan({ items: [] }) or /plan clear while ignoring partial streaming JSON", () => {
  const unfinished: TaskPlanStatus[] = ["completed", "in_progress"];
  const u1 = user("u1", "Start task");
  const a1 = assistant("a1", [planCall("p1", unfinished, "Working")]);
  const u2 = user("u2", "Drop it");

  // Partial streaming update_plan JSON `{"items":[` parses as empty items while running without details.
  const a2PartialStreaming = assistant("a2", [{
    id: "p2-streaming",
    name: "update_plan",
    args: { items: [] },
    running: true,
  }], "", { isStreaming: true });

  const duringPartial = [u1, a1, u2, a2PartialStreaming];
  assert.equal(deriveTaskPlan(duringPartial)?.explanation, "Working");
  assert.equal(deriveLiveTaskPlan(duringPartial)?.explanation, "Working");

  // Once settled (running: false), empty items clears both live and task plans.
  const a2Cleared = assistant("a2", [{
    id: "p2-settled",
    name: "update_plan",
    args: { items: [] },
    running: false,
  }], "Cleared.");

  const afterToolClear = [u1, a1, u2, a2Cleared];
  assert.equal(deriveTaskPlan(afterToolClear), null);
  assert.equal(deriveLiveTaskPlan(afterToolClear), null);
  assert.deepEqual([...deriveTurnPlans(afterToolClear, false).keys()], []);

  // Tool clear confirmed via details while still marked running also clears immediately.
  const a2DetailsCleared = assistant("a2", [{
    id: "p2-details",
    name: "update_plan",
    args: { items: [] },
    details: { items: [] },
    running: true,
  }], "");
  assert.equal(deriveTaskPlan([u1, a1, u2, a2DetailsCleared]), null);
  assert.equal(deriveLiveTaskPlan([u1, a1, u2, a2DetailsCleared]), null);

  // User `/plan clear` clears the carried unfinished plan.
  const uClear = user("u-clear", "  /plan clear  ");
  const afterSlashClear = [u1, a1, uClear, assistant("a2", [], "Plan cleared.")];
  assert.equal(deriveTaskPlan(afterSlashClear), null);
  assert.equal(deriveLiveTaskPlan(afterSlashClear), null);
  assert.deepEqual([...deriveTurnPlans(afterSlashClear, false).keys()], []);
});

import { Context } from "@deepseek-ai/cordis";
import { describe, expect, it } from "vitest";
import "@qianji/agent";
import { LlmService, type LlmRequest } from "@qianji/llm";
import { Sessions } from "@qianji/session";
import { SystemPrompt } from "@qianji/system-prompt";
import { Tools } from "@qianji/tools";
import * as plan from "../src/index.ts";
import { DRIFT_REMINDER_EVENT_THRESHOLD, planOf, setPlan } from "../src/index.ts";

describe("update_plan", () => {
  it("stores the plan in the session, follows rewinds and streams it", async () => {
    const ctx = new Context();
    await ctx.plugin(Sessions);
    await ctx.plugin(Tools);
    await ctx.plugin(plan);
    const session = ctx.sessions.create({ cwd: "/w" });
    const live: unknown[] = [];
    ctx.on("session/delta", (_session, _seq, delta) => void live.push(delta));
    const env = { sessionId: session.id, cwd: "/w", signal: new AbortController().signal };
    const items = [
      { id: "a", text: "Read code", status: "completed" },
      { id: "b", text: "Fix bug", status: "in_progress" },
    ];

    const output = await ctx.tools.execute({ id: "1", name: "update_plan", args: { items } }, env);
    expect(output.content).toEqual([{ type: "text", text: "Plan updated: 1/2 steps completed." }]);
    expect(planOf(session)).toEqual({ explanation: "", items });
    expect(live).toEqual([{ type: "plan", plan: { explanation: "", items } }]);

    const invalid = await ctx.tools.execute({ id: "2", name: "update_plan", args: { items: [...items, { id: "c", text: "Two active", status: "in_progress" }] } }, env);
    expect(invalid.isError).toBe(true);
    expect(planOf(session).items).toHaveLength(2);

    session.append("rewind", { toSeq: 0 });
    expect(planOf(session)).toEqual({ explanation: "", items: [] });
  });

  it("keeps systemPrompt byte-identical across update_plan and nudges before premature stop in agent mode", async () => {
    const ctx = new Context();
    await ctx.plugin(Sessions);
    await ctx.plugin(Tools);
    await ctx.plugin(SystemPrompt);
    await ctx.plugin(plan);
    ctx.systemPrompt.section("base", () => "STATIC SYSTEM PROMPT", { order: 0 });

    const session = ctx.sessions.create({ cwd: "/w" });
    const env = { sessionId: session.id, model: { provider: "p", model: "m" }, cwd: "/w", tools: [] };
    const baselinePrompt = await ctx.systemPrompt.build(env);
    expect(baselinePrompt).toBe("STATIC SYSTEM PROMPT");

    setPlan(session, {
      explanation: "Finish fix",
      items: [
        { id: "1", text: "Read target", status: "completed" },
        { id: "2", text: "Edit code", status: "in_progress" },
      ],
    });
    expect(await ctx.systemPrompt.build(env)).toBe(baselinePrompt);

    // First before-stop nudges once for this plan seq; second before-stop at same seq returns undefined
    const firstNudge = await ctx.serial("agent/before-stop", session, { turn: 1, stop: "stop", hasText: true });
    expect(firstNudge).toContain("[in_progress] 2: Edit code");
    expect(await ctx.serial("agent/before-stop", session, { turn: 2, stop: "stop", hasText: true })).toBeUndefined();

    // Updating the plan advances seq and re-arms the guard, except in plan/ask/read-only mode or once completed
    session.append("custom", { ns: "qianji-permissions", data: { agentMode: "plan", permission: "workspace-write" } });
    setPlan(session, {
      explanation: "",
      items: [{ id: "2", text: "Edit code", status: "pending" }],
    });
    expect(await ctx.systemPrompt.build(env)).toBe(baselinePrompt);
    expect(await ctx.serial("agent/before-stop", session, { turn: 3, stop: "stop", hasText: true })).toBeUndefined();

    session.append("custom", { ns: "qianji-permissions", data: { agentMode: "agent", permission: "workspace-write" } });
    const rearmedNudge = await ctx.serial("agent/before-stop", session, { turn: 4, stop: "stop", hasText: true });
    expect(rearmedNudge).toContain("[pending] 2: Edit code");

    setPlan(session, {
      explanation: "",
      items: [{ id: "2", text: "Edit code", status: "completed" }],
    });
    expect(await ctx.systemPrompt.build(env)).toBe(baselinePrompt);
    expect(await ctx.serial("agent/before-stop", session, { turn: 5, stop: "stop", hasText: true })).toBeUndefined();
    await ctx.fiber.dispose();
  });

  it("injects an in-memory drift reminder on llm/request only after > 12 branch events since the last plan update", async () => {
    const ctx = new Context();
    await ctx.plugin(LlmService, { maxAttempts: 1 });
    await ctx.plugin(Sessions);
    await ctx.plugin(Tools);
    await ctx.plugin(plan);

    const captured: LlmRequest[] = [];
    ctx.llm.registerAdapter(
      { id: "mock", name: "Mock", api: "mock", baseUrl: "" },
      {
        async *stream(request) {
          captured.push(request);
          yield { type: "finish", reason: "stop" };
        },
      },
    );

    const session = ctx.sessions.create({ cwd: "/w" });
    const send = async (system = "STATIC SYSTEM") => {
      const stream = ctx.llm.stream({
        provider: "mock",
        model: "m",
        sessionId: session.id,
        system,
        messages: session.state().messages,
      });
      for await (const _chunk of stream) {
        // drain
      }
      return captured.at(-1);
    };

    session.append("user", { content: [{ type: "text", text: "Start task" }] });
    setPlan(session, {
      explanation: "Keep track",
      items: [
        { id: "1", text: "Explore", status: "completed" },
        { id: "2", text: "Implement", status: "in_progress" },
      ],
    });

    const appendToolTurn = (index: number) => {
      const callId = `call-${index}`;
      session.append("assistant", {
        content: [{ type: "tool-call", id: callId, name: "read", arguments: { path: `f${index}.ts` } }],
        model: { provider: "mock", model: "m" },
        usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 },
        stop: "tool-use",
      });
      session.append("tool-result", {
        callId,
        name: "read",
        content: [{ type: "text", text: `file-${index}` }],
        isError: false,
      });
    };

    // 6 tool turns = 12 branch events after qianji-plan (threshold is > 12)
    for (let i = 1; i <= DRIFT_REMINDER_EVENT_THRESHOLD / 2; i += 1) {
      appendToolTurn(i);
    }
    const atThreshold = await send();
    expect(atThreshold?.system).toBe("STATIC SYSTEM");
    expect(JSON.stringify(atThreshold?.messages)).not.toContain("<plan-reminder>");

    // 13th event after qianji-plan crosses threshold -> appends reminder to trailing user/tool-result message
    session.append("user", { content: [{ type: "text", text: "Continue" }] });
    const afterThreshold = await send();
    expect(afterThreshold?.system).toBe("STATIC SYSTEM");
    const lastMsg = afterThreshold?.messages.at(-1);
    expect(lastMsg?.role).toBe("user");
    const lastText = lastMsg?.content.map((b) => (b.type === "text" ? b.text : "")).join("");
    expect(lastText).toContain("<plan-reminder>");
    expect(lastText).toContain("- [>] (2) Implement");
    // Session state in memory must remain untouched
    expect(JSON.stringify(session.state().messages)).not.toContain("<plan-reminder>");

    // Trailing tool-result target also receives the reminder when it is the last user/tool-result message
    appendToolTurn(7);
    const afterToolResult = await send();
    const lastToolMsg = afterToolResult?.messages.at(-1);
    expect(lastToolMsg?.role).toBe("tool-result");
    expect(lastToolMsg?.content.map((b) => (b.type === "text" ? b.text : "")).join("")).toContain("<plan-reminder>");

    // Updating the plan resets the elapsed branch event counter
    setPlan(session, {
      explanation: "Keep track",
      items: [
        { id: "1", text: "Explore", status: "completed" },
        { id: "2", text: "Implement", status: "in_progress" },
      ],
    });
    const afterPlanRefresh = await send();
    expect(JSON.stringify(afterPlanRefresh?.messages)).not.toContain("<plan-reminder>");

    // Completed plans never trigger a drift reminder even past 12 events
    setPlan(session, {
      explanation: "Done",
      items: [
        { id: "1", text: "Explore", status: "completed" },
        { id: "2", text: "Implement", status: "completed" },
      ],
    });
    for (let i = 8; i <= 14; i += 1) {
      appendToolTurn(i);
    }
    const whenCompleted = await send();
    expect(JSON.stringify(whenCompleted?.messages)).not.toContain("<plan-reminder>");

    await ctx.fiber.dispose();
  });
});

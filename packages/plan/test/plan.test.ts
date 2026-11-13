import { Context } from "@deepseek-ai/cordis";
import { describe, expect, it } from "vitest";
import "@qianji/agent";
import { Sessions } from "@qianji/session";
import { SystemPrompt } from "@qianji/system-prompt";
import { Tools } from "@qianji/tools";
import * as plan from "../src/index.ts";
import { planOf, setPlan } from "../src/index.ts";

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

  it("injects active incomplete plans into systemPrompt and nudges before premature stop in agent mode", async () => {
    const ctx = new Context();
    await ctx.plugin(Sessions);
    await ctx.plugin(Tools);
    await ctx.plugin(SystemPrompt);
    await ctx.plugin(plan);

    const session = ctx.sessions.create({ cwd: "/w" });
    const env = { sessionId: session.id, model: { provider: "p", model: "m" }, cwd: "/w", tools: [] };
    expect(await ctx.systemPrompt.build(env)).toBe("");

    setPlan(session, {
      explanation: "Finish fix",
      items: [
        { id: "1", text: "Read target", status: "completed" },
        { id: "2", text: "Edit code", status: "in_progress" },
      ],
    });
    const activePrompt = await ctx.systemPrompt.build(env);
    expect(activePrompt).toContain("Active plan (`update_plan`):");
    expect(activePrompt).toContain("- [x] (1) Read target");
    expect(activePrompt).toContain("- [>] (2) Edit code");

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
    expect(await ctx.serial("agent/before-stop", session, { turn: 3, stop: "stop", hasText: true })).toBeUndefined();

    session.append("custom", { ns: "qianji-permissions", data: { agentMode: "agent", permission: "workspace-write" } });
    const rearmedNudge = await ctx.serial("agent/before-stop", session, { turn: 4, stop: "stop", hasText: true });
    expect(rearmedNudge).toContain("[pending] 2: Edit code");

    setPlan(session, {
      explanation: "",
      items: [{ id: "2", text: "Edit code", status: "completed" }],
    });
    expect(await ctx.systemPrompt.build(env)).toBe("");
    expect(await ctx.serial("agent/before-stop", session, { turn: 5, stop: "stop", hasText: true })).toBeUndefined();
    await ctx.fiber.dispose();
  });
});

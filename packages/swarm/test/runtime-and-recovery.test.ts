import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Context } from "@deepseek-ai/cordis";
import { AgentLoop } from "@qianji/agent-loop";
import { Commands } from "@qianji/commands";
import { Credentials, LlmService } from "@qianji/llm";
import { Pricing } from "@qianji/pricing";
import { MemoryStorage, Sessions, type SessionStorage } from "@qianji/session";
import { SystemPrompt } from "@qianji/system-prompt";
import { ScriptedProvider, textReply, useScriptedProvider } from "@qianji/testkit";
import { Tools } from "@qianji/tools";
import { Ui } from "@qianji/ui";
import { afterEach, describe, expect, it } from "vitest";
import { SwarmService, type SwarmServiceOptions } from "../src/index.ts";

interface TestHarness {
  ctx: Context;
  provider: ScriptedProvider;
  storage: SessionStorage;
  stop: () => Promise<void>;
}

async function createSwarmHarness(
  options: SwarmServiceOptions = {},
  sharedStorage?: SessionStorage,
): Promise<TestHarness> {
  const ctx = new Context();
  const storage = sharedStorage ?? new MemoryStorage();
  await ctx.plugin(Credentials);
  await ctx.plugin(LlmService, { maxAttempts: 1 });
  await ctx.plugin(Sessions);
  await ctx.plugin(Ui);
  await ctx.plugin(Tools);
  await ctx.plugin(Commands);
  await ctx.plugin(SystemPrompt);
  await ctx.plugin(Pricing);
  await ctx.plugin(AgentLoop);
  ctx.sessions.registerStorage(storage);

  const provider = new ScriptedProvider();
  useScriptedProvider(ctx, provider, "anthropic");
  await ctx.plugin(SwarmService, { watchdogIntervalMs: 60_000, ...options });

  return {
    ctx,
    provider,
    storage,
    stop: async () => {
      await ctx.fiber.dispose();
    },
  };
}

describe("SwarmService runtime, doorbell wakeup, model hot-swap, watchdog, and crash recovery", () => {
  const tempDirs: string[] = [];
  afterEach(() => {
    for (const dir of tempDirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("wakes parked idle workers on @mention (ignoring backticks), tracks live cost, and hot-swaps models preserving history", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "qj-swarm-rt-"));
    tempDirs.push(cwd);
    const h = await createSwarmHarness();
    try {
      const coord = h.ctx.sessions.create({
        cwd,
        model: { provider: "anthropic", model: "claude-sonnet-4-6" },
      });

      // Unrelated session has zero swarm system-prompt injection
      const outsider = h.ctx.sessions.create({
        cwd,
        model: { provider: "anthropic", model: "claude-sonnet-4-6" },
      });
      expect(await h.ctx.systemPrompt.build({
        sessionId: outsider.id,
        cwd,
        model: { provider: "anthropic", model: "claude-sonnet-4-6" },
        tools: [],
      })).toBe("");

      // /swarm <goal> creates swarm, emits swarm/open, activates swarm tools, and returns kickoff prompt
      const openedEvents: string[] = [];
      h.ctx.on("swarm/open", (ev) => {
        if (ev.swarmId !== undefined) openedEvents.push(ev.swarmId);
      });
      const cmdRes = await h.ctx.commands.run("swarm", "Build modular parser", {
        sessionId: coord.id,
        cwd,
        signal: new AbortController().signal,
      });
      expect(cmdRes.handled).toBe(true);
      expect(cmdRes.prompt).toContain("Build modular parser");
      expect(openedEvents).toHaveLength(1);
      expect(h.ctx.tools.isActivated(coord.id, "swarm")).toBe(true);

      const swarmSnap = h.ctx.swarm.getActiveSwarmForSession(coord.id);
      expect(swarmSnap).toBeDefined();
      const swarmId = swarmSnap?.run.id ?? "";

      // Coordinator session receives dynamic swarm-protocol prompt section
      const coordPrompt = await h.ctx.systemPrompt.build({
        sessionId: coord.id,
        cwd,
        model: { provider: "anthropic", model: "claude-sonnet-4-6" },
        tools: [],
      });
      expect(coordPrompt).toContain("<swarm-coordinator");

      // Queue initial worker turn reply
      h.provider.push(
        textReply("Initial exploration complete.", {
          inputTokens: 1_000,
          outputTokens: 500,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
        }),
      );

      const [explorer] = await h.ctx.swarm.addMember({
        swarmId,
        name: "explorer-a",
        role: "explorer",
        brief: "Inspect module exports",
      });
      expect(explorer?.workspaceMode).toBe("inherit");
      await h.ctx.agents.idle(explorer?.sessionId ?? "");

      // Settled worker parks in waiting state, holds session across idle sweeps, and stays active for tool-bash
      const afterTurn1 = h.ctx.swarm.getSnapshot(swarmId);
      const expState1 = afterTurn1.members.find((m) => m.name === "explorer-a");
      expect(expState1?.state).toBe("waiting");
      expect(expState1?.usage.totalTokens).toBe(1_500);
      expect(afterTurn1.run.totalUsage.totalTokens).toBe(1_500);
      expect(afterTurn1.run.totalCostUsd).toBeGreaterThan(0);
      expect(h.ctx.swarm.isActiveWorkerSession(explorer?.sessionId ?? "")).toBe(true);
      expect(h.ctx.sessions.sweep(Date.now() + 999_999_999)).not.toContain(explorer?.sessionId);

      // Backticked `@explorer-a` must NOT wake the worker
      const noWake = await h.ctx.swarm.postBoardMessage({
        swarmId,
        sender: "coordinator",
        text: "Note: `@explorer-a` is parked at 0 tokens.",
      });
      expect(noWake.wokenMembers).toEqual([]);
      expect(h.provider.requests).toHaveLength(1);

      // Hot-swap explorer-a's model while waiting, preserving conversation history
      const switched = await h.ctx.swarm.controlMember({
        swarmId,
        name: "explorer-a",
        action: "switchModel",
        provider: "anthropic",
        model: "claude-opus-4-6",
      });
      expect(switched.ok).toBe(true);
      expect(switched.member?.model).toBe("claude-opus-4-6");

      // Real @explorer-a mention wakes the parked worker on the new model with prior history intact!
      h.provider.push(textReply("Follow-up check complete on Opus."));
      const woke = await h.ctx.swarm.postBoardMessage({
        swarmId,
        sender: "coordinator",
        text: "@explorer-a verify edge case #2",
      });
      expect(woke.wokenMembers).toEqual(["explorer-a"]);
      await h.ctx.agents.idle(explorer?.sessionId ?? "");

      expect(h.provider.requests).toHaveLength(2);
      expect(h.provider.requests[1]?.model).toBe("claude-opus-4-6");
      const secondReqText = JSON.stringify(h.provider.requests[1]?.messages ?? []);
      expect(secondReqText).toContain("Initial exploration complete.");
      expect(secondReqText).toContain("<swarm-doorbell");
    } finally {
      await h.stop();
    }
  });

  it("emits stall alerts on hung working members and idle incomplete swarms without any budget auto-pause", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "qj-swarm-wd-"));
    tempDirs.push(cwd);
    const h = await createSwarmHarness({ defaultStallTimeoutMs: 500 });
    try {
      const snap = await h.ctx.swarm.createSwarm({ goal: "Test stall watchdog", cwd, stallTimeoutMs: 500 });
      const swarmId = snap.run.id;
      h.ctx.swarm.mutateTask({
        swarmId,
        action: "create",
        title: "Unfinished task",
      });

      // 1) All non-monitor members waiting while incomplete task exists -> whole-swarm stall alert, status stays running
      const alerts1 = h.ctx.swarm.runWatchdogTick(Date.now() + 2_000);
      expect(alerts1.some((a) => a.kind === "stall")).toBe(true);
      expect(h.ctx.swarm.getSnapshot(swarmId).run.status).toBe("running");

      // Dismiss alert via controlRun
      const afterDismiss = await h.ctx.swarm.controlRun({ swarmId, action: "dismissAlert" });
      expect(afterDismiss.alerts.every((a) => a.resolved)).toBe(true);

      // 2) Hung working member exceeding stallTimeoutMs -> marked stalled + member-scoped stall alert
      let unblockStream: () => void = () => {};
      const streamGate = new Promise<void>((resolve) => {
        unblockStream = resolve;
      });
      h.provider.push(async function* (_req, signal) {
        await Promise.race([
          streamGate,
          new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true })),
        ]);
        yield { type: "text-delta", index: 0, text: "unblocked" };
        yield { type: "finish", reason: "stop" };
      });

      const [hung] = await h.ctx.swarm.addMember({
        swarmId,
        name: "slow-worker",
        role: "explorer",
        brief: "Long task",
      });
      const memberStallAlerts = h.ctx.swarm.runWatchdogTick(Date.now() + 5_000);
      expect(memberStallAlerts.some((a) => a.kind === "stall" && a.memberName === "slow-worker")).toBe(true);
      expect(h.ctx.swarm.getSnapshot(swarmId).members.find((m) => m.name === "slow-worker")?.state).toBe("stalled");

      unblockStream();
      await h.ctx.agents.idle(hung?.sessionId ?? "");
    } finally {
      await h.stop();
    }
  });

  it("recovers persisted swarms across Host restart (working -> stopped -> @mention revive) and enforces helper ownership on tools", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "qj-swarm-persist-"));
    const cwd = mkdtempSync(join(tmpdir(), "qj-swarm-persist-cwd-"));
    tempDirs.push(dataDir, cwd);
    const sharedStorage = new MemoryStorage();

    // 1) First Host instance creates swarm + two workers
    const h1 = await createSwarmHarness({ dataDir }, sharedStorage);
    let createdSwarmId: string;
    let builderSessionId: string;
    let peerSessionId: string;
    try {
      h1.provider.push(textReply("Step 1 saved before restart."), textReply("Peer ready."));
      const created = await h1.ctx.swarm.createSwarm({ goal: "Survive host restart", cwd });
      createdSwarmId = created.run.id;
      const [worker] = await h1.ctx.swarm.addMember({
        swarmId: createdSwarmId,
        name: "builder",
        role: "explorer",
        brief: "Complete step 1",
      });
      const [peer] = await h1.ctx.swarm.addMember({
        swarmId: createdSwarmId,
        name: "peer",
        role: "explorer",
        brief: "Peer helper",
      });
      builderSessionId = worker?.sessionId ?? "";
      peerSessionId = peer?.sessionId ?? "";
      await h1.ctx.agents.idle(builderSessionId);
      await h1.ctx.agents.idle(peerSessionId);

      // Peer cannot kill `builder` because `builder` was added by `coordinator`
      const killAttempt = await h1.ctx.tools.execute(
        { id: "k1", name: "swarm", args: { action: "kill", name: "builder" } },
        { sessionId: peerSessionId, cwd, signal: new AbortController().signal },
      );
      expect(killAttempt.isError).toBe(true);
    } finally {
      await h1.stop();
    }

    // 2) Second Host instance boots from same dataDir + SessionStorage: workers hydrate as `stopped`
    const h2 = await createSwarmHarness({ dataDir }, sharedStorage);
    try {
      const hydrated = h2.ctx.swarm.getSnapshot(createdSwarmId);
      const builderBefore = hydrated.members.find((m) => m.name === "builder");
      expect(builderBefore?.state).toBe("stopped");
      expect(h2.ctx.swarm.isActiveWorkerSession(builderSessionId)).toBe(false);

      // Posting @builder revives the stopped session with its prior history!
      h2.provider.push(textReply("Revived after restart and finished step 2!"));
      const postRes = await h2.ctx.swarm.postBoardMessage({
        swarmId: createdSwarmId,
        sender: "coordinator",
        text: "@builder resume step 2 now",
      });
      expect(postRes.wokenMembers).toEqual(["builder"]);
      await h2.ctx.agents.idle(builderSessionId);

      const hydratedAfter = h2.ctx.swarm.getSnapshot(createdSwarmId);
      const builderAfter = hydratedAfter.members.find((m) => m.name === "builder");
      expect(builderAfter?.state).toBe("waiting");
      expect(JSON.stringify(h2.provider.requests[0]?.messages ?? [])).toContain("Step 1 saved before restart.");
    } finally {
      await h2.stop();
    }
  });

  it("adopts top-level Coordinator session when /swarm <goal> runs from Home screen with sessionId: undefined", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "qj-swarm-home-"));
    tempDirs.push(cwd);
    const h = await createSwarmHarness();
    try {
      // 1) Home screen runs `/swarm <goal>` before any session exists (`sessionId: undefined`)
      const cmdRes = await h.ctx.commands.run("swarm", "Coordinate home-screen launch", {
        sessionId: undefined,
        cwd,
        signal: new AbortController().signal,
      });
      expect(cmdRes.handled).toBe(true);
      expect(cmdRes.prompt).toContain("Coordinate home-screen launch");

      const initialList = h.ctx.swarm.listSwarms({ cwd });
      expect(initialList.swarms).toHaveLength(1);
      const swarmId = initialList.swarms[0]?.run.id ?? "";
      expect(h.ctx.swarm.getSnapshot(swarmId).run.coordinatorSessionId).toBe("");

      // 2) Frontend immediately creates the top-level Coordinator session in `cwd` and sends kickoff prompt
      const coord = h.ctx.sessions.create({
        cwd,
        model: { provider: "anthropic", model: "claude-sonnet-4-6" },
      });
      h.provider.push(
        textReply("Coordinator plan ready.", {
          inputTokens: 800,
          outputTokens: 200,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
        }),
      );
      h.ctx.agents.prompt(coord, [{ type: "text", text: cmdRes.prompt ?? "start" }]);
      await h.ctx.agents.idle(coord.id);

      // 3) Verify coordinatorSessionId bound, <swarm-coordinator> injected, swarm tools activated, and usage rolled up!
      const snap = h.ctx.swarm.getSnapshot(swarmId);
      expect(snap.run.coordinatorSessionId).toBe(coord.id);
      const coordMember = snap.members.find((m) => m.name === "coordinator");
      expect(coordMember?.sessionId).toBe(coord.id);
      expect(coordMember?.usage.totalTokens).toBe(1_000);
      expect(coordMember?.estimatedCostUsd).toBeGreaterThan(0);
      expect(snap.run.totalUsage.totalTokens).toBe(1_000);
      expect(snap.run.totalCostUsd).toBeGreaterThan(0);
      expect(h.ctx.tools.isActivated(coord.id, "swarm")).toBe(true);
      expect(h.ctx.tools.isActivated(coord.id, "read_board")).toBe(true);
      expect(h.ctx.tools.isActivated(coord.id, "post_message")).toBe(true);
      expect(h.ctx.tools.isActivated(coord.id, "swarm_wait")).toBe(true);
      expect(h.ctx.tools.get("swarm_tasks")).toBeUndefined();
      expect(h.provider.requests[0]?.system).toContain("<swarm-coordinator");
      expect(h.provider.requests[0]?.tools?.some((t) => t.name === "swarm")).toBe(true);
      expect(h.provider.requests[0]?.tools?.some((t) => t.name === "swarm_tasks")).toBe(false);
    } finally {
      await h.stop();
    }
  });
});

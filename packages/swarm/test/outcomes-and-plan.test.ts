import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Context } from "@deepseek-ai/cordis";
import { AgentLoop } from "@qianji/agent-loop";
import { Commands } from "@qianji/commands";
import { Credentials, LlmService } from "@qianji/llm";
import { Pricing } from "@qianji/pricing";
import type { SwarmUpdatedNotification } from "@qianji/protocol";
import { MemoryStorage, Sessions, type SessionStorage } from "@qianji/session";
import { SystemPrompt } from "@qianji/system-prompt";
import { ScriptedProvider, textReply, useScriptedProvider } from "@qianji/testkit";
import { textOutput, Tools } from "@qianji/tools";
import { Ui } from "@qianji/ui";
import { afterEach, describe, expect, it } from "vitest";
import { SWARM_TOOL_NAMES, SwarmService, type SwarmServiceOptions } from "../src/index.ts";

interface OutcomeTestHarness {
  ctx: Context;
  provider: ScriptedProvider;
  storage: SessionStorage;
  stop: () => Promise<void>;
}

async function createOutcomeHarness(
  options: SwarmServiceOptions = {},
  sharedStorage?: SessionStorage,
): Promise<OutcomeTestHarness> {
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

  for (const name of ["read", "bash"]) {
    ctx.tools.register({
      name,
      description: name,
      parameters: { type: "object" },
      execute: () => textOutput(`${name} ok`),
    });
  }

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

describe("4-Tool Swarm Kernel, Outcome Threads (action:'plan'), Member States, currentStep & Screenshots", () => {
  const tempDirs: string[] = [];
  afterEach(() => {
    for (const dir of tempDirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("exposes strictly 4 swarm tools while preserving backward-compatible mutateTask service API", async () => {
    const h = await createOutcomeHarness();
    try {
      expect([...SWARM_TOOL_NAMES]).toEqual(["swarm", "read_board", "post_message", "swarm_wait"]);
      for (const toolName of SWARM_TOOL_NAMES) {
        expect(h.ctx.tools.get(toolName)).toBeDefined();
      }
      expect(h.ctx.tools.get("swarm_tasks")).toBeUndefined();

      // Backward-compatible RPC/service task mutation remains intact
      const snap = await h.ctx.swarm.createSwarm({ goal: "Compat check" });
      const mutated = h.ctx.swarm.mutateTask({
        swarmId: snap.run.id,
        action: "create",
        title: "Legacy RPC task",
      });
      expect(mutated.tasks).toHaveLength(1);
    } finally {
      await h.stop();
    }
  });

  it("synthesizes fallback plan on kickoff, enforces coordinator-only action:'plan', augments new workers, and persists plan", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "qj-swarm-plan-data-"));
    const cwd = mkdtempSync(join(tmpdir(), "qj-swarm-plan-cwd-"));
    tempDirs.push(dataDir, cwd);
    const sharedStorage = new MemoryStorage();

    const h1 = await createOutcomeHarness({ dataDir }, sharedStorage);
    let swarmId: string;
    try {
      const coord = h1.ctx.sessions.create({
        cwd,
        model: { provider: "anthropic", model: "claude-sonnet-4-6" },
      });
      const created = await h1.ctx.swarm.createSwarm({
        goal: "Upgrade parser and AST verifier",
        title: "Parser v2",
        cwd,
        coordinatorSessionId: coord.id,
      });
      swarmId = created.run.id;

      // 1) Instant kickoff fallback plan has 1 crisp thread even before workers exist
      expect(created.run.plan).toEqual({
        goalTitle: "Parser v2",
        goalLine: "Upgrade parser and AST verifier",
        tasks: {},
        threads: [
          {
            id: "main-outcome",
            title: "Parser v2",
            goal: "Upgrade parser and AST verifier",
            members: [],
          },
        ],
      });

      // 2) Adding non-observer workers + monitor observer populates 1-line brief tasks & groups non-observers
      h1.provider.push(
        textReply("Parser ready."),
        textReply("Verifier ready."),
        textReply("Monitor ready."),
      );
      const [parser] = await h1.ctx.swarm.addMember({
        swarmId,
        name: "parser",
        role: "explorer",
        brief: "- Fix lexer escape sequences\nRun unit tests after editing.",
      });
      const [verifier] = await h1.ctx.swarm.addMember({
        swarmId,
        name: "ast-verifier",
        role: "verifier",
        brief: "# Run AST & boundary checks\nReport failures to @parser.",
      });
      const [monitor] = await h1.ctx.swarm.addMember({
        swarmId,
        name: "watchdog",
        role: "monitor",
        brief: "Watch swarm health",
      });
      await h1.ctx.agents.idle(parser?.sessionId ?? "");
      await h1.ctx.agents.idle(verifier?.sessionId ?? "");
      await h1.ctx.agents.idle(monitor?.sessionId ?? "");

      const autoSnap = h1.ctx.swarm.getSnapshot(swarmId);
      expect(autoSnap.run.plan?.tasks).toEqual({
        parser: "Fix lexer escape sequences",
        "ast-verifier": "Run AST & boundary checks",
      });
      expect(autoSnap.run.plan?.threads).toEqual([
        {
          id: "main-outcome",
          title: "Parser v2",
          goal: "Upgrade parser and AST verifier",
          members: ["parser", "ast-verifier"],
        },
      ]);

      // 3) Non-coordinator worker cannot call swarm(action: "plan")
      const rejected = await h1.ctx.tools.execute(
        {
          id: "p-deny",
          name: "swarm",
          args: { action: "plan", goalTitle: "Hijack" },
        },
        { sessionId: parser?.sessionId ?? "", cwd, signal: new AbortController().signal },
      );
      expect(rejected.isError).toBe(true);

      // 4) Coordinator calls swarm(action: "plan") -> updates run.plan and emits swarm/updated
      const updates: SwarmUpdatedNotification[] = [];
      h1.ctx.on("swarm/updated", (u) => updates.push(u));

      const planRes = await h1.ctx.tools.execute(
        {
          id: "p-ok",
          name: "swarm",
          args: {
            action: "plan",
            goalTitle: "Lexer & AST Pipeline",
            goalLine: "Deliver lossless escape lexing with verified AST snapshots",
            memberTasks: {
              parser: "Implement escape & unicode lexing",
              "ast-verifier": "Verify AST golden snapshots",
            },
            threads: [
              {
                id: "lexer-ast",
                title: "Lexer & AST Verification",
                goal: "Zero regressions on escape tokens",
                members: ["parser", "ast-verifier"],
              },
            ],
          },
        },
        { sessionId: coord.id, cwd, signal: new AbortController().signal },
      );
      expect(planRes.isError).toBeUndefined();
      expect(updates.length).toBeGreaterThan(0);

      // 5) Adding a new helper not in explicit threads augments plan with a clean supplemental thread
      h1.provider.push(textReply("Bench helper ready."));
      const [bench] = await h1.ctx.swarm.addMember({
        swarmId,
        name: "bench-helper",
        role: "explorer",
        brief: "Measure tokenizer throughput",
      });
      await h1.ctx.agents.idle(bench?.sessionId ?? "");

      const augmented = h1.ctx.swarm.getSnapshot(swarmId);
      expect(augmented.run.plan?.goalTitle).toBe("Lexer & AST Pipeline");
      expect(augmented.run.plan?.tasks["bench-helper"]).toBe("Measure tokenizer throughput");
      expect(augmented.run.plan?.threads).toHaveLength(2);
      expect(augmented.run.plan?.threads[0]?.id).toBe("lexer-ast");
      expect(augmented.run.plan?.threads[1]?.members).toEqual(["bench-helper"]);
    } finally {
      await h1.stop();
    }

    // 6) Hydrates persisted explicit plan across Host restart
    const h2 = await createOutcomeHarness({ dataDir }, sharedStorage);
    try {
      const hydrated = h2.ctx.swarm.getSnapshot(swarmId);
      expect(hydrated.run.plan?.goalTitle).toBe("Lexer & AST Pipeline");
      expect(hydrated.run.plan?.threads[0]?.title).toBe("Lexer & AST Verification");
    } finally {
      await h2.stop();
    }
  });

  it("derives waitingOn, completedAt lifecycle, Screenshot: reel items, and live <=72-char currentStep", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "qj-swarm-states-"));
    tempDirs.push(cwd);
    const h = await createOutcomeHarness();
    try {
      const snap = await h.ctx.swarm.createSwarm({ goal: "Test live member states", cwd });
      const swarmId = snap.run.id;

      // Capture streaming currentStep updates via swarm/memberDelta
      const observedSteps: string[] = [];
      h.ctx.on("swarm/memberDelta", (ev) => {
        if (ev.member.name === "ui-author" && ev.member.currentStep !== undefined) {
          observedSteps.push(ev.member.currentStep);
        }
      });

      const longPath = join(
        cwd,
        "src",
        "components",
        "swarm-honeycomb-map",
        "extremely-long-nested-subfolder-name-for-truncation-check",
        "SwarmHoneycombCanvasRenderer.tsx",
      );

      h.provider.push(
        async function* () {
          yield { type: "thinking-delta", index: 0, text: "Let me plan.\n**Inspecting " };
          yield { type: "thinking-delta", index: 0, text: "SwarmView layout hierarchy**\nNow reading file." };
          yield { type: "tool-call-start", index: 1, id: "tc-1", name: "read" };
          yield {
            type: "tool-call-delta",
            index: 1,
            argumentsDelta: JSON.stringify({ path: longPath }),
          };
          yield { type: "finish", reason: "tool-use" };
        },
        textReply("Initial pass done."),
        textReply("Planner ready."),
      );

      const [author] = await h.ctx.swarm.addMember({
        swarmId,
        name: "ui-author",
        role: "explorer",
        brief: "Build honeycomb view",
      });
      const [planner] = await h.ctx.swarm.addMember({
        swarmId,
        name: "arch-planner",
        role: "planner",
        brief: "Clarify layout specs",
      });
      await h.ctx.agents.idle(author?.sessionId ?? "");
      await h.ctx.agents.idle(planner?.sessionId ?? "");

      // Verify bold thinking heading & truncated tool call summary were captured (all <= 72 chars)
      expect(observedSteps).toContain("Inspecting SwarmView layout hierarchy");
      expect(observedSteps.some((s) => s.startsWith("read src/components/swarm-honeycomb-map/"))).toBe(true);
      expect(observedSteps.every((s) => s.length <= 72)).toBe(true);

      // Once settled into waiting, currentStep is cleared!
      const settledAuthor = h.ctx.swarm.getSnapshot(swarmId).members.find((m) => m.name === "ui-author");
      expect(settledAuthor?.state).toBe("waiting");
      expect(settledAuthor?.currentStep).toBeUndefined();

      // 1) Asking @arch-planner a question (`?`) sets waitingOn = "arch-planner"
      h.provider.push(textReply("Checking question..."));
      await h.ctx.swarm.postBoardMessage({
        swarmId,
        sender: "ui-author",
        text: "@arch-planner Should completed threads drop background fill?",
      });
      await h.ctx.agents.idle(planner?.sessionId ?? "");
      expect(h.ctx.swarm.getSnapshot(swarmId).members.find((m) => m.name === "ui-author")?.waitingOn).toBe(
        "arch-planner",
      );

      // 2) When @arch-planner posts back, ui-author's waitingOn clears (and wakes ui-author)
      h.provider.push(textReply("Got answer, finishing!"));
      await h.ctx.swarm.postBoardMessage({
        swarmId,
        sender: "arch-planner",
        text: "@ui-author Yes, transparent fill for completed threads.",
      });
      await h.ctx.agents.idle(author?.sessionId ?? "");
      expect(h.ctx.swarm.getSnapshot(swarmId).members.find((m) => m.name === "ui-author")?.waitingOn).toBeUndefined();

      // 3) Posting [done] + Screenshot lines sets completedAt and populates snapshot.screenshots
      await h.ctx.swarm.postBoardMessage({
        swarmId,
        sender: "ui-author",
        text: [
          "@coordinator [done] Honeycomb & Overview landed.",
          "Screenshot: C:/artifacts/overview.png | Calm Overview with 2 outcome threads",
          "Screenshot: C:/artifacts/hive.png | Axial Honeycomb Hex Map",
        ].join("\n"),
      });

      const doneSnap = h.ctx.swarm.getSnapshot(swarmId);
      const doneAuthor = doneSnap.members.find((m) => m.name === "ui-author");
      expect(doneAuthor?.completedAt).toBeTypeOf("number");
      expect(doneSnap.screenshots).toEqual([
        {
          seq: doneSnap.run.headSeq,
          sender: "ui-author",
          path: "C:/artifacts/overview.png",
          caption: "Calm Overview with 2 outcome threads",
          createdAt: doneAuthor?.completedAt,
        },
        {
          seq: doneSnap.run.headSeq,
          sender: "ui-author",
          path: "C:/artifacts/hive.png",
          caption: "Axial Honeycomb Hex Map",
          createdAt: doneAuthor?.completedAt,
        },
      ]);

      // Summary taskCounts reflects 1 completed out of 2 non-observer workers when swarm_tasks is empty
      const summary = h.ctx.swarm.listSwarms({ cwd }).swarms[0];
      expect(summary?.taskCounts.total).toBe(2);
      expect(summary?.taskCounts.completed).toBe(1);

      // 4) Subsequent @mention waking ui-author for fixes clears completedAt while working until next [done]!
      let unblockFixTurn: () => void = () => {};
      const fixGate = new Promise<void>((resolve) => {
        unblockFixTurn = resolve;
      });
      h.provider.push(async function* () {
        await fixGate;
        yield { type: "text-delta", index: 0, text: "Fixed!" };
        yield { type: "finish", reason: "stop" };
      });

      await h.ctx.swarm.postBoardMessage({
        swarmId,
        sender: "coordinator",
        text: "@ui-author Please adjust hex stroke width to 1.5px",
      });
      expect(h.ctx.swarm.getSnapshot(swarmId).members.find((m) => m.name === "ui-author")?.completedAt).toBeUndefined();

      unblockFixTurn();
      await h.ctx.agents.idle(author?.sessionId ?? "");
    } finally {
      await h.stop();
    }
  });
});

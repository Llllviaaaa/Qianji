import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Context } from "@deepseek-ai/cordis";
import { AgentLoop } from "@qianji/agent-loop";
import { Commands } from "@qianji/commands";
import { Credentials, LlmService, type ModelInfo } from "@qianji/llm";
import { Pricing } from "@qianji/pricing";
import type { SwarmConfigUpdatedNotification } from "@qianji/protocol";
import { MemoryStorage, Sessions, type SessionStorage } from "@qianji/session";
import { SystemPrompt } from "@qianji/system-prompt";
import { ScriptedProvider, textReply } from "@qianji/testkit";
import { Tools } from "@qianji/tools";
import { Ui } from "@qianji/ui";
import { afterEach, describe, expect, it } from "vitest";
import {
  swarmGlobalConfigPath,
  swarmManifestPath,
  SwarmService,
  type SwarmServiceOptions,
} from "../src/index.ts";

interface MultiProviderHarness {
  ctx: Context;
  anthropic: ScriptedProvider;
  openai: ScriptedProvider;
  deepseek: ScriptedProvider;
  storage: SessionStorage;
  stop: () => Promise<void>;
}

function registerProviderWithCatalog(
  ctx: Context,
  id: string,
  name: string,
  provider: ScriptedProvider,
  models: ModelInfo[],
): void {
  ctx.effect(
    () =>
      ctx.llm.registerAdapter(
        { id, name, api: "scripted", baseUrl: "" },
        {
          stream: (req, sig) => provider.stream(req, sig),
          listModels: async () => models,
        },
      ),
    `test-provider:${id}`,
  );
}

async function createMultiProviderHarness(
  options: SwarmServiceOptions = {},
  sharedStorage?: SessionStorage,
): Promise<MultiProviderHarness> {
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

  const anthropic = new ScriptedProvider();
  const openai = new ScriptedProvider();
  const deepseek = new ScriptedProvider();

  registerProviderWithCatalog(ctx, "anthropic", "Anthropic", anthropic, [
    { id: "claude-opus-4-6", name: "Claude Opus 4.6", reasoning: true },
    { id: "claude-sonnet-4-6", name: "Claude Sonnet 4.6", reasoning: true },
    { id: "claude-haiku-4-5", name: "Claude Haiku 4.5", reasoning: false },
  ]);
  registerProviderWithCatalog(ctx, "openai", "OpenAI", openai, [
    { id: "gpt-5.4", name: "GPT-5.4", reasoning: true },
    { id: "gpt-4.1-mini", name: "GPT-4.1 Mini", reasoning: false },
  ]);
  registerProviderWithCatalog(ctx, "deepseek", "DeepSeek", deepseek, [
    { id: "deepseek-reasoner", name: "DeepSeek R1", reasoning: true },
  ]);

  await ctx.plugin(SwarmService, { watchdogIntervalMs: 60_000, ...options });

  return {
    ctx,
    anthropic,
    openai,
    deepseek,
    storage,
    stop: async () => {
      await ctx.fiber.dispose();
    },
  };
}

describe("Swarm per-role model configuration, persistence, resolution priority, and live hot-swap", () => {
  const tempDirs: string[] = [];
  afterEach(() => {
    for (const dir of tempDirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("persists config.json & manifest.json atomically, lists availableModels from ctx.llm, and hydrates across restarts", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "qj-swarm-cfg-"));
    const cwd = mkdtempSync(join(tmpdir(), "qj-swarm-cfg-cwd-"));
    tempDirs.push(dataDir, cwd);
    const sharedStorage = new MemoryStorage();

    const h1 = await createMultiProviderHarness({ dataDir }, sharedStorage);
    let swarmId: string;
    try {
      const initialCfg = await h1.ctx.swarm.getConfig();
      expect(initialCfg.globalConfig).toEqual({ roleModels: {} });
      expect(initialCfg.availableModels).toEqual([
        { provider: "anthropic", providerName: "Anthropic", id: "claude-opus-4-6", name: "Claude Opus 4.6", reasoning: true },
        { provider: "anthropic", providerName: "Anthropic", id: "claude-sonnet-4-6", name: "Claude Sonnet 4.6", reasoning: true },
        { provider: "anthropic", providerName: "Anthropic", id: "claude-haiku-4-5", name: "Claude Haiku 4.5", reasoning: false },
        { provider: "openai", providerName: "OpenAI", id: "gpt-5.4", name: "GPT-5.4", reasoning: true },
        { provider: "openai", providerName: "OpenAI", id: "gpt-4.1-mini", name: "GPT-4.1 Mini", reasoning: false },
        { provider: "deepseek", providerName: "DeepSeek", id: "deepseek-reasoner", name: "DeepSeek R1", reasoning: true },
      ]);

      const updatedEvents: SwarmConfigUpdatedNotification[] = [];
      h1.ctx.on("swarm/configUpdated", (ev) => {
        updatedEvents.push(ev);
      });

      const created = await h1.ctx.swarm.createSwarm({
        goal: "Persist role models",
        cwd,
        roleModels: {
          worker: { provider: "openai", model: "gpt-5.4", effort: "medium" },
        },
      });
      swarmId = created.run.id;

      await h1.ctx.swarm.updateConfig({
        globalConfig: {
          defaultWorkerModel: { provider: "openai", model: "gpt-4.1-mini" },
          roleModels: {
            coordinator: { provider: "anthropic", model: "claude-opus-4-6", effort: "high" },
            planner: { provider: "deepseek", model: "deepseek-reasoner", effort: "high" },
            explorer: { provider: "anthropic", model: "claude-haiku-4-5" },
          },
        },
        swarmId,
        sessionOverrides: {
          worker: { provider: "openai", model: "gpt-5.4", effort: "high" },
          verifier: { provider: "anthropic", model: "claude-sonnet-4-6", effort: "medium" },
        },
      });

      expect(updatedEvents).toHaveLength(1);
      expect(existsSync(swarmGlobalConfigPath(dataDir))).toBe(true);
      expect(existsSync(swarmManifestPath(dataDir, swarmId))).toBe(true);

      const diskGlobal = JSON.parse(readFileSync(swarmGlobalConfigPath(dataDir), "utf8")) as {
        roleModels?: Record<string, unknown>;
      };
      expect(diskGlobal.roleModels?.planner).toEqual({
        provider: "deepseek",
        model: "deepseek-reasoner",
        effort: "high",
      });
      const diskManifest = JSON.parse(readFileSync(swarmManifestPath(dataDir, swarmId), "utf8")) as {
        roleModels?: Record<string, unknown>;
      };
      expect(diskManifest.roleModels?.verifier).toEqual({
        provider: "anthropic",
        model: "claude-sonnet-4-6",
        effort: "medium",
      });
    } finally {
      await h1.stop();
    }

    const h2 = await createMultiProviderHarness({ dataDir }, sharedStorage);
    try {
      const hydratedCfg = await h2.ctx.swarm.getConfig({ swarmId });
      expect(hydratedCfg.globalConfig.defaultWorkerModel).toEqual({
        provider: "openai",
        model: "gpt-4.1-mini",
      });
      expect(hydratedCfg.globalConfig.roleModels.coordinator).toEqual({
        provider: "anthropic",
        model: "claude-opus-4-6",
        effort: "high",
      });
      expect(hydratedCfg.sessionOverrides).toEqual({
        worker: { provider: "openai", model: "gpt-5.4", effort: "high" },
        verifier: { provider: "anthropic", model: "claude-sonnet-4-6", effort: "medium" },
      });
    } finally {
      await h2.stop();
    }
  });

  it("resolves models + effort across coordinator / planner / explorer / worker / verifier / monitor with strict 5-tier priority", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "qj-swarm-roles-"));
    tempDirs.push(cwd);
    const h = await createMultiProviderHarness();
    try {
      await h.ctx.swarm.updateConfig({
        globalConfig: {
          defaultWorkerModel: { provider: "openai", model: "gpt-4.1-mini" },
          roleModels: {
            coordinator: { provider: "anthropic", model: "claude-opus-4-6", effort: "high" },
            planner: { provider: "deepseek", model: "deepseek-reasoner", effort: "high" },
            explorer: { provider: "anthropic", model: "claude-haiku-4-5" },
            worker: { provider: "anthropic", model: "claude-sonnet-4-6", effort: "low" },
            verifier: { provider: "openai", model: "gpt-5.4", effort: "medium" },
          },
        },
      });

      // 1) Coordinator session starts on sonnet, then createSwarm upgrades idle coordinator to configured Opus + high effort
      const coord = h.ctx.sessions.create({
        cwd,
        model: { provider: "anthropic", model: "claude-sonnet-4-6" },
      });
      const snap = await h.ctx.swarm.createSwarm({
        goal: "Full role matrix",
        cwd,
        coordinatorSessionId: coord.id,
        roleModels: {
          // Tier 2 session override beats Tier 3 global `worker` config
          worker: { provider: "openai", model: "gpt-5.4", effort: "high" },
        },
      });
      const swarmId = snap.run.id;
      expect(coord.state().model).toEqual({ provider: "anthropic", model: "claude-opus-4-6" });
      expect(coord.state().effort).toBe("high");
      const coordInfo = snap.members.find((m) => m.name === "coordinator");
      expect(coordInfo?.model).toBe("claude-opus-4-6");
      expect(coordInfo?.effort).toBe("high");

      // Coordinator system prompt instructs passing accurate role & omitting model unless explicitly requested
      const sysPrompt = await h.ctx.systemPrompt.build({
        sessionId: coord.id,
        cwd,
        model: { provider: "anthropic", model: "claude-opus-4-6" },
        tools: [],
      });
      expect(sysPrompt).toContain("ALWAYS pass the accurate `role`");
      expect(sysPrompt).toContain("leave `model`/`provider` omitted");

      // Queue replies across providers for planner, explorer, worker, verifier, monitor (fallback), and explicit override worker
      h.deepseek.push(textReply("Plan drafted."));
      h.anthropic.push(textReply("Repo explored."), textReply("Explicit model done."));
      h.openai.push(
        textReply("Worker patch ready."),
        textReply("Verification passed."),
        textReply("Monitor tick ok."),
      );

      const [planner] = await h.ctx.swarm.addMember({ swarmId, name: "arch-planner", role: "planner", brief: "Plan" });
      const [explorer] = await h.ctx.swarm.addMember({ swarmId, name: "repo-explorer", role: "explorer", brief: "Explore" });
      const [worker] = await h.ctx.swarm.addMember({ swarmId, name: "impl-worker", role: "worker", brief: "Implement" });
      const [verifier] = await h.ctx.swarm.addMember({ swarmId, name: "qa-verifier", role: "verifier", brief: "Verify" });
      // `monitor` is omitted from roleModels -> falls back to Tier 4 `defaultWorkerModel` (`openai/gpt-4.1-mini`)
      const [monitor] = await h.ctx.swarm.addMember({ swarmId, name: "watch-monitor", role: "monitor", brief: "Monitor" });
      // Tier 1 explicit `model` overrides Tier 2 session override & Tier 3 global config
      const [explicitWorker] = await h.ctx.swarm.addMember({
        swarmId,
        name: "custom-worker",
        role: "worker",
        provider: "anthropic",
        model: "claude-sonnet-4-6",
        brief: "Explicit override",
      });

      for (const m of [planner, explorer, worker, verifier, monitor, explicitWorker]) {
        await h.ctx.agents.idle(m?.sessionId ?? "");
      }

      expect(planner?.provider).toBe("deepseek");
      expect(planner?.model).toBe("deepseek-reasoner");
      expect(planner?.effort).toBe("high");
      expect(h.deepseek.requests[0]?.model).toBe("deepseek-reasoner");
      expect(h.deepseek.requests[0]?.effort).toBe("high");

      expect(explorer?.provider).toBe("anthropic");
      expect(explorer?.model).toBe("claude-haiku-4-5");
      expect(explorer?.effort).toBeUndefined();
      expect(h.anthropic.requests[0]?.model).toBe("claude-haiku-4-5");

      expect(worker?.provider).toBe("openai");
      expect(worker?.model).toBe("gpt-5.4");
      expect(worker?.effort).toBe("high");
      expect(h.openai.requests.some((r) => r.model === "gpt-5.4" && r.effort === "high")).toBe(true);

      expect(verifier?.provider).toBe("openai");
      expect(verifier?.model).toBe("gpt-5.4");
      expect(verifier?.effort).toBe("medium");
      expect(h.openai.requests.some((r) => r.model === "gpt-5.4" && r.effort === "medium")).toBe(true);

      expect(monitor?.provider).toBe("openai");
      expect(monitor?.model).toBe("gpt-4.1-mini");
      expect(h.openai.requests.some((r) => r.model === "gpt-4.1-mini")).toBe(true);

      expect(explicitWorker?.provider).toBe("anthropic");
      expect(explicitWorker?.model).toBe("claude-sonnet-4-6");
      expect(h.anthropic.requests[1]?.model).toBe("claude-sonnet-4-6");
    } finally {
      await h.stop();
    }
  });

  it("applies coordinator role model on Home-screen adoption and hot-swaps waiting members on applyToWaitingMembers: true", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "qj-swarm-hotswap-"));
    tempDirs.push(cwd);
    const h = await createMultiProviderHarness();
    try {
      await h.ctx.swarm.updateConfig({
        globalConfig: {
          roleModels: {
            coordinator: { provider: "openai", model: "gpt-5.4", effort: "high" },
            explorer: { provider: "anthropic", model: "claude-haiku-4-5" },
          },
        },
      });

      // Home-screen `/swarm <goal>` with `sessionId: undefined`, then new session created on sonnet
      const cmdRes = await h.ctx.commands.run("swarm", "Home-screen role model test", {
        sessionId: undefined,
        cwd,
        signal: new AbortController().signal,
      });
      const swarmId = h.ctx.swarm.listSwarms({ cwd }).swarms[0]?.run.id ?? "";

      const homeCoord = h.ctx.sessions.create({
        cwd,
        model: { provider: "anthropic", model: "claude-sonnet-4-6" },
      });
      h.openai.push(textReply("Coordinator ran on configured GPT-5.4 high!"));
      h.ctx.agents.prompt(homeCoord, [{ type: "text", text: cmdRes.prompt ?? "go" }]);
      await h.ctx.agents.idle(homeCoord.id);

      expect(h.openai.requests).toHaveLength(1);
      expect(h.openai.requests[0]?.model).toBe("gpt-5.4");
      expect(h.openai.requests[0]?.effort).toBe("high");

      // Spawn an explorer that finishes turn 1 and parks in `waiting` state
      h.anthropic.push(textReply("Turn 1 on Haiku."));
      const [exp] = await h.ctx.swarm.addMember({
        swarmId,
        name: "scout",
        role: "explorer",
        brief: "Initial scan",
      });
      await h.ctx.agents.idle(exp?.sessionId ?? "");
      expect(h.ctx.swarm.getSnapshot(swarmId).members.find((m) => m.name === "scout")?.state).toBe("waiting");

      // Update config with applyToWaitingMembers: true -> waiting `scout` upgrades in place to deepseek-reasoner + medium effort!
      const updated = await h.ctx.swarm.updateConfig({
        swarmId,
        sessionOverrides: {
          explorer: { provider: "deepseek", model: "deepseek-reasoner", effort: "medium" },
        },
        applyToWaitingMembers: true,
      });
      const scoutAfterUpdate = updated.snapshot?.members.find((m) => m.name === "scout");
      expect(scoutAfterUpdate?.provider).toBe("deepseek");
      expect(scoutAfterUpdate?.model).toBe("deepseek-reasoner");
      expect(scoutAfterUpdate?.effort).toBe("medium");

      // Wake `scout` via @mention -> executes turn 2 on DeepSeek R1 with effort="medium" and turn 1 history preserved!
      h.deepseek.push(textReply("Turn 2 on DeepSeek R1."));
      await h.ctx.swarm.postBoardMessage({
        swarmId,
        sender: "coordinator",
        text: "@scout run deep analysis",
      });
      await h.ctx.agents.idle(exp?.sessionId ?? "");

      expect(h.deepseek.requests).toHaveLength(1);
      expect(h.deepseek.requests[0]?.model).toBe("deepseek-reasoner");
      expect(h.deepseek.requests[0]?.effort).toBe("medium");
      expect(JSON.stringify(h.deepseek.requests[0]?.messages ?? [])).toContain("Turn 1 on Haiku.");
    } finally {
      await h.stop();
    }
  });
});

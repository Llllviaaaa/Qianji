import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ScriptedProvider, textReply, useScriptedProvider } from "@qianji/testkit";
import { agentPlugins, builtinPluginDefinitions, corePlugins } from "../src/agent-plugins.ts";
import { readHarnessConfig } from "../src/harness-config.ts";
import { createHost, type Host } from "../src/host.ts";
import { PluginManager } from "../src/plugin-manager.ts";
import * as pluginsRpc from "../src/plugins-rpc.ts";

const pageOrigin = "http://tauri.localhost";
let tempRoot = "";
let host: Host | undefined;
let manager: PluginManager | undefined;

afterEach(async () => {
  await manager?.dispose();
  manager = undefined;
  await host?.stop();
  host = undefined;
  if (tempRoot !== "") {
    rmSync(tempRoot, { recursive: true, force: true });
    tempRoot = "";
  }
});

function writeUserAgentLoop(pluginDir: string, source: string, version = "1.0.0"): void {
  mkdirSync(pluginDir, { recursive: true });
  writeFileSync(
    join(pluginDir, "package.json"),
    JSON.stringify(
      {
        name: "user-agent-loop",
        version,
        qianji: {
          id: "agent-loop",
          name: "Custom User AgentLoop",
          host: "./index.ts",
          inject: ["llm", "sessions", "tools", "systemPrompt"],
          provides: ["agents"],
        },
      },
      null,
      2,
    ),
    "utf8",
  );
  writeFileSync(join(pluginDir, "index.ts"), source, "utf8");
}

const VALID_CUSTOM_AGENT_LOOP_SOURCE = `
import { Context, Service } from "@deepseek-ai/cordis";

export default class CustomAgentLoop extends Service {
  static provide = "agents";
  static inject = ["llm", "sessions", "tools", "systemPrompt"];
  readonly marker = "user-custom-agent-loop";

  constructor(ctx: Context) {
    super(ctx, "agents");
  }

  prompt(session: { id: string; state(): { model?: { provider: string; model: string } }; append(type: string, data: unknown): unknown }, content: unknown[]) {
    const userEvent = session.append("user", { content });
    const model = session.state().model ?? { provider: "scripted", model: "m" };
    session.append("assistant", {
      content: [{ type: "text", text: "custom-agent-loop-reply" }],
      model,
      usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 },
      stop: "end-turn",
    });
    return userEvent;
  }

  steer(session: Parameters<CustomAgentLoop["prompt"]>[0], content: unknown[]) {
    return this.prompt(session, content);
  }

  followUp(session: Parameters<CustomAgentLoop["prompt"]>[0], content: unknown[]) {
    return this.prompt(session, content);
  }

  async abort() {}
  async compact() { return undefined; }
  status() { return { running: false, streaming: [], runningTools: [], queue: { steer: 0, followUp: 0 } }; }
  isBusy() { return false; }
  async idle() {}
}
`;

const BROKEN_APPLY_AGENT_LOOP_SOURCE = `
export const inject = ["llm", "sessions", "tools", "systemPrompt"];
export const provide = "agents";
export function apply() {
  throw new Error("custom agent-loop apply boom");
}
`;

describe("AgentLoop pluginization & transactional override (ADR 0023 Phase 5)", () => {
  it("keeps corePlugins() strictly to the 7 pure in-memory buses while agentPlugins() and builtinPluginDefinitions() provide agent-loop", async () => {
    expect(corePlugins()).toHaveLength(7);

    tempRoot = mkdtempSync(join(tmpdir(), "qj-core-buses-"));
    const dataDir = join(tempRoot, "data");
    mkdirSync(dataDir, { recursive: true });

    host = createHost({ version: "0.3.0-test", dataDir, plugins: corePlugins() });
    await host.start();

    expect(host.ctx.get("credentials")).toBeDefined();
    expect(host.ctx.get("llm")).toBeDefined();
    expect(host.ctx.get("sessions")).toBeDefined();
    expect(host.ctx.get("ui")).toBeDefined();
    expect(host.ctx.get("tools")).toBeDefined();
    expect(host.ctx.get("commands")).toBeDefined();
    expect(host.ctx.get("systemPrompt")).toBeDefined();
    expect(host.ctx.get("agents")).toBeUndefined();
    await host.stop();

    const cfg = readHarnessConfig(join(dataDir, "harness.json")).config;
    const builtins = builtinPluginDefinitions(dataDir, cfg);
    const agentDef = builtins.find((entry) => entry.id === "agent-loop");
    expect(agentDef).toMatchObject({
      id: "agent-loop",
      enabled: true,
      canDisable: false,
      canOverride: true,
      hasHost: true,
      hasClient: false,
      provides: ["agents"],
      inject: ["llm", "sessions", "tools", "systemPrompt"],
    });

    // Programmatic agentPlugins() continues to mount AgentLoop automatically.
    host = createHost({
      version: "0.3.0-test",
      dataDir,
      plugins: agentPlugins(dataDir, { config: cfg }),
    });
    await host.start();
    expect(host.ctx.get("agents")).toBeDefined();
  });

  it("overrides builtin agent-loop with a user-tier plugin in <dataDir>/plugins/ and restores builtin on remove", async () => {
    tempRoot = mkdtempSync(join(tmpdir(), "qj-agent-override-"));
    const dataDir = join(tempRoot, "data");
    const workDir = join(tempRoot, "work");
    mkdirSync(dataDir, { recursive: true });
    mkdirSync(workDir, { recursive: true });

    const provider = new ScriptedProvider([textReply("builtin-reply-1"), textReply("builtin-reply-2")]);
    host = createHost({
      version: "0.3.0-test",
      dataDir,
      plugins: [
        ...corePlugins(),
        [{ name: "test-scripted-llm", inject: ["llm"], apply: (ctx: never) => useScriptedProvider(ctx, provider) }],
      ],
    });
    await host.start();

    const token = "e".repeat(32);
    manager = new PluginManager(host.ctx, {
      dataDir,
      version: "0.3.0-test",
      builtins: () =>
        builtinPluginDefinitions(dataDir, readHarnessConfig(join(dataDir, "harness.json")).config, {
          gateway: { pageOrigins: [pageOrigin], token, manager: () => manager },
        }),
    });
    await host.ctx.plugin(pluginsRpc, { manager });
    await manager.sync();

    // Builtin agent-loop is active, provides agents, cannot be disabled, and drives prompts.
    const initialList = await manager.list();
    expect(initialList.find((p) => p.id === "agent-loop")).toMatchObject({
      id: "agent-loop",
      tier: "builtin",
      status: "active",
      enabled: true,
      canDisable: false,
      overridesBuiltin: false,
      provides: ["agents"],
    });
    expect(initialList.find((p) => p.id === "checkpoints")?.status).toBe("active");
    expect(initialList.find((p) => p.id === "sessions-rpc")?.status).toBe("active");
    await expect(manager.setEnabled("agent-loop", false)).rejects.toThrow(/cannot be disabled/);

    const session1 = host.ctx.sessions.create({ cwd: workDir, model: { provider: "scripted", model: "m" } });
    host.ctx.agents.prompt(session1, [{ type: "text", text: "hi builtin" }]);
    await host.ctx.agents.idle(session1.id);
    expect(JSON.stringify(session1.state().messages)).toContain("builtin-reply-1");

    // Place a user-tier plugin with id: "agent-loop" in <dataDir>/plugins/ and sync!
    const userOverrideDir = join(dataDir, "plugins", "agent-loop");
    writeUserAgentLoop(userOverrideDir, VALID_CUSTOM_AGENT_LOOP_SOURCE);
    await manager.sync({ reason: "reloaded" });

    const overriddenList = await manager.list();
    expect(overriddenList.find((p) => p.id === "agent-loop")).toMatchObject({
      id: "agent-loop",
      tier: "user",
      status: "active",
      enabled: true,
      overridesBuiltin: true,
      removable: true,
    });
    expect(overriddenList.find((p) => p.id === "checkpoints")?.status).toBe("active");
    expect(overriddenList.find((p) => p.id === "sessions-rpc")?.status).toBe("active");
    expect((host.ctx.agents as unknown as { marker?: string }).marker).toBe("user-custom-agent-loop");

    const session2 = host.ctx.sessions.create({ cwd: workDir, model: { provider: "scripted", model: "m" } });
    host.ctx.agents.prompt(session2, [{ type: "text", text: "hi custom" }]);
    await host.ctx.agents.idle(session2.id);
    expect(JSON.stringify(session2.state().messages)).toContain("custom-agent-loop-reply");

    // Removing the user override cleanly restores builtin AgentLoop.
    const removed = await manager.remove("agent-loop");
    expect(removed.plugin).toMatchObject({
      id: "agent-loop",
      tier: "builtin",
      status: "active",
      overridesBuiltin: false,
    });
    expect((host.ctx.agents as unknown as { marker?: string }).marker).toBeUndefined();

    const session3 = host.ctx.sessions.create({ cwd: workDir, model: { provider: "scripted", model: "m" } });
    host.ctx.agents.prompt(session3, [{ type: "text", text: "hi builtin again" }]);
    await host.ctx.agents.idle(session3.id);
    expect(JSON.stringify(session3.state().messages)).toContain("builtin-reply-2");
  });

  it("transactionally rolls back to builtin agent-loop if user override throws during apply() (runtime & cold boot)", async () => {
    tempRoot = mkdtempSync(join(tmpdir(), "qj-agent-rollback-"));
    const dataDir = join(tempRoot, "data");
    const workDir = join(tempRoot, "work");
    mkdirSync(dataDir, { recursive: true });
    mkdirSync(workDir, { recursive: true });

    const provider = new ScriptedProvider([textReply("survived-runtime-rollback"), textReply("survived-cold-boot-rollback")]);
    host = createHost({
      version: "0.3.0-test",
      dataDir,
      plugins: [
        ...corePlugins(),
        [{ name: "test-scripted-llm", inject: ["llm"], apply: (ctx: never) => useScriptedProvider(ctx, provider) }],
      ],
    });
    await host.start();

    const token = "f".repeat(32);
    manager = new PluginManager(host.ctx, {
      dataDir,
      version: "0.3.0-test",
      builtins: () =>
        builtinPluginDefinitions(dataDir, readHarnessConfig(join(dataDir, "harness.json")).config, {
          gateway: { pageOrigins: [pageOrigin], token, manager: () => manager },
        }),
    });
    await host.ctx.plugin(pluginsRpc, { manager });
    await manager.sync();

    // 1. Runtime override with a broken user agent-loop whose apply() throws -> rolls back to builtin!
    const userOverrideDir = join(dataDir, "plugins", "agent-loop");
    writeUserAgentLoop(userOverrideDir, BROKEN_APPLY_AGENT_LOOP_SOURCE);
    await manager.sync({ reason: "reloaded" });

    const afterFailure = await manager.list();
    const agentInfo = afterFailure.find((p) => p.id === "agent-loop");
    expect(agentInfo).toMatchObject({
      id: "agent-loop",
      tier: "builtin",
      status: "active",
      overridesBuiltin: false,
      removable: true,
    });
    expect(agentInfo?.error).toContain("rolled back");
    expect(agentInfo?.error).toContain("custom agent-loop apply boom");
    expect(afterFailure.find((p) => p.id === "checkpoints")?.status).toBe("active");
    expect(afterFailure.find((p) => p.id === "sessions-rpc")?.status).toBe("active");

    // Verify builtin AgentLoop is genuinely active and handles prompts after rollback!
    const session1 = host.ctx.sessions.create({ cwd: workDir, model: { provider: "scripted", model: "m" } });
    host.ctx.agents.prompt(session1, [{ type: "text", text: "after runtime rollback" }]);
    await host.ctx.agents.idle(session1.id);
    expect(JSON.stringify(session1.state().messages)).toContain("survived-runtime-rollback");

    // 2. Cold boot with broken user agent-loop already present in <dataDir>/plugins/ -> still rolls back to builtin!
    await manager.dispose();
    manager = undefined;
    await host.stop();
    host = undefined;

    host = createHost({
      version: "0.3.0-test",
      dataDir,
      plugins: [
        ...corePlugins(),
        [{ name: "test-scripted-llm", inject: ["llm"], apply: (ctx: never) => useScriptedProvider(ctx, provider) }],
      ],
    });
    await host.start();
    manager = new PluginManager(host.ctx, {
      dataDir,
      version: "0.3.0-test",
      builtins: () =>
        builtinPluginDefinitions(dataDir, readHarnessConfig(join(dataDir, "harness.json")).config, {
          gateway: { pageOrigins: [pageOrigin], token, manager: () => manager },
        }),
    });
    await host.ctx.plugin(pluginsRpc, { manager });
    await manager.sync();

    const coldList = await manager.list();
    expect(coldList.find((p) => p.id === "agent-loop")).toMatchObject({
      id: "agent-loop",
      tier: "builtin",
      status: "active",
    });
    expect(coldList.find((p) => p.id === "agent-loop")?.error).toContain("rolled back");
    expect(host.ctx.get("agents")).toBeDefined();

    const session2 = host.ctx.sessions.create({ cwd: workDir, model: { provider: "scripted", model: "m" } });
    host.ctx.agents.prompt(session2, [{ type: "text", text: "after cold boot rollback" }]);
    await host.ctx.agents.idle(session2.id);
    expect(JSON.stringify(session2.state().messages)).toContain("survived-cold-boot-rollback");
  });
});

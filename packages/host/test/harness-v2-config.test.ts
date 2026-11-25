import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { agentPlugins, builtinPluginDefinitions } from "../src/agent-plugins.ts";
import { readEffectiveHarnessConfig, readHarnessConfig } from "../src/harness-config.ts";
import { createHost, type Host } from "../src/host.ts";

let dir = "";
let host: Host | undefined;

afterEach(async () => {
  await host?.stop();
  host = undefined;
  if (dir !== "") {
    rmSync(dir, { recursive: true, force: true });
    dir = "";
  }
});

describe("HarnessConfig agentLoop & llm failover wiring", () => {
  it("parses agentLoop and llm sections and forwards them to AgentLoop and LlmService", async () => {
    dir = mkdtempSync(join(tmpdir(), "qj-harness-v2-cfg-"));
    const harnessFile = join(dir, "harness.json");
    writeFileSync(
      harnessFile,
      JSON.stringify({
        agentLoop: {
          maxTurns: 42,
          maxParallelTools: 6,
          keepRecentTokens: 16_000,
        },
        llm: {
          fallbackModels: ["backup/model-x", "  ", "secondary/model-y"],
          fallbackCooldownMs: 90_000,
        },
      }),
      "utf8",
    );

    const { config, problems } = readHarnessConfig(harnessFile);
    expect(problems).toEqual([]);
    expect(config.agentLoop).toEqual({
      maxTurns: 42,
      maxParallelTools: 6,
      keepRecentTokens: 16_000,
    });
    expect(config.llm).toEqual({
      fallbackModels: ["backup/model-x", "secondary/model-y"],
      fallbackCooldownMs: 90_000,
    });

    const builtins = builtinPluginDefinitions(dir, config);
    const loopDef = builtins.find((d) => d.id === "agent-loop");
    expect(loopDef?.config).toEqual(config.agentLoop);

    const effective = readEffectiveHarnessConfig(dir);
    host = createHost({
      version: "0.3.0-test",
      dataDir: dir,
      plugins: agentPlugins(dir, { config: effective.config }),
    });
    await host.start();
    expect(host.ctx.llm.failover.cooldownDurationMs).toBe(90_000);
  });
});

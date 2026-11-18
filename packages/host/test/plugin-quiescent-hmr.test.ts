import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentLoop } from "@qianji/agent-loop";
import { LlmService } from "@qianji/llm";
import { Sessions } from "@qianji/session";
import { SystemPrompt } from "@qianji/system-prompt";
import { ScriptedProvider, textReply, toolReply, useScriptedProvider } from "@qianji/testkit";
import { Tools, textOutput } from "@qianji/tools";
import { Ui } from "@qianji/ui";
import { createHost, type Host } from "../src/host.ts";
import { PluginManager } from "../src/plugin-manager.ts";
import { shouldIgnoreWatchedPath } from "../src/plugin-util.ts";
import { RpcGateway } from "../src/rpc.ts";
import { WebServer } from "../src/web-server.ts";

interface LifecycleCounter {
  mounts: number;
  disposes: number;
}

const TEST_COUNTER_PREFIX = "__qianjiQuiescentHmrCounter_";
let tempRoot = "";
let host: Host | undefined;
let manager: PluginManager | undefined;
let counterKey = "";

afterEach(async () => {
  await manager?.dispose();
  manager = undefined;
  await host?.stop();
  host = undefined;
  if (counterKey !== "") {
    delete (globalThis as Record<string, unknown>)[counterKey];
    counterKey = "";
  }
  if (tempRoot !== "") {
    rmSync(tempRoot, { recursive: true, force: true });
    tempRoot = "";
  }
});

function writeWatchedPluginSource(pluginDir: string, globalKey: string, versionTag: string): void {
  writeFileSync(
    join(pluginDir, "index.ts"),
    `
      import { textOutput } from "@qianji/tools";
      export const inject = ["tools"];
      export function apply(ctx) {
        const key = ${JSON.stringify(globalKey)};
        const store = (globalThis[key] ??= { mounts: 0, disposes: 0 });
        store.mounts += 1;
        ctx.effect(() => () => {
          store.disposes += 1;
        }, "quiescent-hmr:lifecycle");
        ctx.effect(() => ctx.tools.register({
          name: "watched_hello",
          description: "Returns current plugin version",
          parameters: { type: "object", properties: {} },
          execute: () => textOutput(${JSON.stringify(versionTag)}),
        }), "quiescent-hmr:tool");
      }
    `,
  );
}

describe("shouldIgnoreWatchedPath", () => {
  it("ignores runtime state, SQLite journals, logs, and editor swap files while keeping plugin sources", () => {
    const ignored = [
      ".git/HEAD",
      "node_modules/pkg/index.js",
      ".qianji/cache.json",
      "logs/im.log",
      "src/logs/worker.txt",
      "bridge.log",
      "state.sqlite",
      "state.sqlite3",
      "state.sqlite-wal",
      "state.sqlite-shm",
      "state.sqlite-journal",
      "bot.db",
      "bot.db-wal",
      "bot.db-shm",
      "bot.db-journal",
      "index.ts.swp",
      "index.ts.swo",
      "temp.tmp",
      "backup~",
      "daemon.pid",
      "package.lock",
      "tsconfig.tsbuildinfo",
      ".DS_Store",
      "nested\\Thumbs.db",
    ];
    for (const file of ignored) {
      expect(shouldIgnoreWatchedPath(file), `expected ${file} to be ignored`).toBe(true);
    }

    const watched = [
      "index.ts",
      "src/index.ts",
      "src/data/presets.ts",
      "client.tsx",
      "package.json",
      "assets/icon.svg",
    ];
    for (const file of watched) {
      expect(shouldIgnoreWatchedPath(file), `expected ${file} to trigger HMR`).toBe(false);
    }

    expect(shouldIgnoreWatchedPath(null)).toBe(false);
    expect(shouldIgnoreWatchedPath(undefined)).toBe(false);
    expect(shouldIgnoreWatchedPath("")).toBe(false);
  });
});

describe("PluginWatcherController quiescent HMR", () => {
  it("defers watch HMR while an AgentLoop run is active, flushes once settled, and deduplicates explicit reload()", async () => {
    tempRoot = mkdtempSync(join(tmpdir(), "qj-quiescent-hmr-"));
    const dataDir = join(tempRoot, "data");
    const workspace = join(tempRoot, "workspace");
    const pluginDir = join(tempRoot, "watched-plugin");
    mkdirSync(dataDir, { recursive: true });
    mkdirSync(workspace, { recursive: true });
    mkdirSync(pluginDir, { recursive: true });

    counterKey = `${TEST_COUNTER_PREFIX}${Date.now()}_${Math.random().toString(36).slice(2)}`;
    const counter: LifecycleCounter = { mounts: 0, disposes: 0 };
    (globalThis as Record<string, unknown>)[counterKey] = counter;

    let holdStarted: (() => void) | undefined;
    let releaseHold: (() => void) | undefined;
    const armHold = () => {
      const startedPromise = new Promise<void>((resolve) => {
        holdStarted = resolve;
      });
      const gatePromise = new Promise<void>((resolve) => {
        releaseHold = resolve;
      });
      return { startedPromise, gatePromise };
    };
    let activeHold = armHold();

    const provider = new ScriptedProvider([
      toolReply([{ id: "call-1", name: "hold_turn", args: {} }]),
      textReply("run-1-done"),
    ]);

    host = createHost({
      version: "0.3.0-test",
      dataDir,
      plugins: [
        [WebServer, { pageOrigins: [] }],
        [RpcGateway, { token: "b".repeat(32) }],
        [LlmService, { maxAttempts: 1 }],
        [Sessions],
        [Ui],
        [Tools],
        [SystemPrompt],
        [AgentLoop],
        [{ name: "scripted", inject: ["llm"], apply: (ctx: never) => useScriptedProvider(ctx, provider) }],
        [{
          name: "test-hold-tool",
          inject: ["tools"],
          apply: (ctx) => {
            ctx.effect(() => ctx.tools.register({
              name: "hold_turn",
              description: "Blocks until test releases the gate",
              parameters: { type: "object", properties: {} },
              execute: async () => {
                holdStarted?.();
                await activeHold.gatePromise;
                return textOutput("released");
              },
            }), "test-hold-tool");
          },
        }],
      ],
    });
    await host.start();

    manager = new PluginManager(host.ctx, {
      dataDir,
      version: "0.3.0-test",
      watchDebounceMs: 25,
      settledHmrGraceMs: 40,
    });
    await manager.sync();

    writeFileSync(
      join(pluginDir, "package.json"),
      JSON.stringify({
        name: "watched-plugin",
        version: "1.0.0",
        pid: { id: "watched-plugin", name: "Watched Plugin", host: "./index.ts" },
      }),
    );
    writeWatchedPluginSource(pluginDir, counterKey, "v1");

    const installed = await manager.install({ channel: "local", spec: pluginDir, link: true });
    expect(installed.plugin).toMatchObject({ id: "watched-plugin", status: "active", watch: true });
    expect(counter).toEqual({ mounts: 1, disposes: 0 });

    const session = host.ctx.sessions.create({ cwd: workspace, model: { provider: "scripted", model: "m" } });
    const execWatchedHello = () => host?.ctx.tools.execute(
      { id: "probe", name: "watched_hello", args: {} },
      { sessionId: session.id, cwd: workspace, signal: new AbortController().signal },
    );
    expect(await execWatchedHello()).toEqual({ content: [{ type: "text", text: "v1" }] });
    expect(host.ctx.agents.isBusy?.()).toBe(false);

    // 1. Start run 1 and hold inside tool execution.
    host.ctx.agents.prompt(session, [{ type: "text", text: "first task" }]);
    await activeHold.startedPromise;
    expect(host.ctx.agents.isBusy?.()).toBe(true);

    // Edit watched plugin while the run is actively executing; wait past debounce + grace window.
    writeWatchedPluginSource(pluginDir, counterKey, "v2");
    await new Promise((resolve) => setTimeout(resolve, 150));

    // Plugin must NOT have been disposed/reloaded mid-turn.
    expect(counter).toEqual({ mounts: 1, disposes: 0 });
    expect(await execWatchedHello()).toEqual({ content: [{ type: "text", text: "v1" }] });

    // Release run 1 -> deferred HMR flushes automatically after agent/settled.
    releaseHold?.();
    await host.ctx.agents.idle(session.id);
    expect(host.ctx.agents.isBusy?.()).toBe(false);

    await vi.waitFor(async () => {
      expect(counter).toEqual({ mounts: 2, disposes: 1 });
      expect(await execWatchedHello()).toEqual({ content: [{ type: "text", text: "v2" }] });
    }, { timeout: 3_000 });

    // 2. Coalescing + explicit reload() deduplication during run 2.
    activeHold = armHold();
    provider.push(
      toolReply([{ id: "call-2", name: "hold_turn", args: {} }]),
      textReply("run-2-done"),
    );
    host.ctx.agents.prompt(session, [{ type: "text", text: "second task" }]);
    await activeHold.startedPromise;

    writeWatchedPluginSource(pluginDir, counterKey, "v3");
    await new Promise((resolve) => setTimeout(resolve, 80));
    writeWatchedPluginSource(pluginDir, counterKey, "v4");
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(counter).toEqual({ mounts: 2, disposes: 1 });

    // Explicit reload takes effect immediately and clears any queued deferred HMR for that plugin.
    await manager.reload("watched-plugin");
    expect(counter).toEqual({ mounts: 3, disposes: 2 });
    expect(await execWatchedHello()).toEqual({ content: [{ type: "text", text: "v4" }] });

    releaseHold?.();
    await host.ctx.agents.idle(session.id);
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(counter).toEqual({ mounts: 3, disposes: 2 });
  });
});

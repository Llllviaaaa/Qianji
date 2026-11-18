import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import ts from "typescript";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Context, Service } from "@deepseek-ai/cordis";
import type { LlmRequest, StreamChunk } from "@qianji/llm";
import type { RpcHandler, RpcService } from "@qianji/rpc";
import { ScriptedProvider, textReply, toolReply, useScriptedProvider, type ScriptedReply } from "@qianji/testkit";
import type { ActiveSessionSnapshot, HostRpcQueryOptions, SessionStats } from "@qianji/client";
import { corePlugins } from "../packages/host/src/agent-plugins.ts";
import { createHost, type PluginEntry } from "../packages/host/src/host.ts";
import { verifyPluginDirectory } from "../packages/host/src/plugin-verify.ts";
import { generatePluginTypes } from "../scripts/generate-plugin-types.mjs";
import {
  ClientContributionRegistry,
  ClientContributionService,
  ClientStylesService,
} from "../src/lib/clientContributions.ts";

interface MockClientHarness {
  session: ActiveSessionSnapshot;
  queryData: unknown;
  lastQueryCall: {
    method: string;
    params?: Record<string, unknown>;
    options?: HostRpcQueryOptions;
  } | null;
  rpcCalls: Array<{ method: string; params?: Record<string, unknown> }>;
  refetchCount: number;
}

const mockClient: MockClientHarness = {
  session: {
    sessionId: null,
    sessionFile: null,
    cwd: "/workspace",
    isStreaming: false,
    isCompacting: false,
    model: null,
    stats: null,
    messageCount: 0,
  },
  queryData: undefined,
  lastQueryCall: null,
  rpcCalls: [],
  refetchCount: 0,
};

vi.mock("@qianji/client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@qianji/client")>();
  return {
    ...actual,
    useActiveSession: () => mockClient.session,
    useHostRpcQuery: (
      method: string,
      params?: Record<string, unknown>,
      options?: HostRpcQueryOptions,
    ) => {
      mockClient.lastQueryCall = { method, params, options };
      return {
        data: options?.enabled === false ? undefined : mockClient.queryData,
        error: null,
        loading: false,
        refetch: async () => {
          mockClient.refetchCount += 1;
        },
      };
    },
    callHostRpc: async (method: string, params?: Record<string, unknown>) => {
      mockClient.rpcCalls.push({ method, params });
      return {};
    },
    subscribeSessionActivity: () => () => undefined,
  };
});

import goalTrackerHost, {
  DEFAULT_MAX_GOAL_ROUNDS,
  GOAL_NAMESPACE,
  buildGoalRoundXml,
  reconstructSessionGoal,
  type GoalRecord,
  type GoalSnapshot,
  type GoalTrackerConfig,
} from "../plugins/goal-tracker/host.ts";
import goalTrackerClient, {
  GoalBar,
  GoalBannerView,
  formatGoalElapsed,
  formatTokenCompact,
} from "../plugins/goal-tracker/client.tsx";

const REPO_ROOT = resolve(__dirname, "..");
const GOAL_PLUGIN_DIR = resolve(REPO_ROOT, "plugins", "goal-tracker");

function resetMockClient(): void {
  mockClient.session = {
    sessionId: null,
    sessionFile: null,
    cwd: "/workspace",
    isStreaming: false,
    isCompacting: false,
    model: null,
    stats: null,
    messageCount: 0,
  };
  mockClient.queryData = undefined;
  mockClient.lastQueryCall = null;
  mockClient.rpcCalls = [];
  mockClient.refetchCount = 0;
}

interface MockStyleNode {
  tagName: string;
  textContent: string;
  isConnected: boolean;
  attributes: Map<string, string>;
  setAttribute(name: string, value: string): void;
  getAttribute(name: string): string | null;
  remove(): void;
}

function installMockDom() {
  const headChildren: MockStyleNode[] = [];
  const head = {
    children: headChildren,
    appendChild(node: MockStyleNode) {
      if (!headChildren.includes(node)) headChildren.push(node);
      node.isConnected = true;
      return node;
    },
    querySelector(selector: string): MockStyleNode | null {
      const m = /^style\[data-qj-plugin-style="([^"]+)"\]$/.exec(selector);
      if (!m) return null;
      return headChildren.find((item) => item.attributes.get("data-qj-plugin-style") === m[1]) ?? null;
    },
  };
  const mockDoc = {
    head,
    createElement(tag: string): MockStyleNode {
      const attrs = new Map<string, string>();
      const node: MockStyleNode = {
        tagName: tag.toUpperCase(),
        textContent: "",
        isConnected: false,
        attributes: attrs,
        setAttribute(k, v) {
          attrs.set(k, v);
        },
        getAttribute(k) {
          return attrs.get(k) ?? null;
        },
        remove() {
          node.isConnected = false;
          const idx = headChildren.indexOf(node);
          if (idx >= 0) headChildren.splice(idx, 1);
        },
      };
      return node;
    },
  };

  const g = globalThis as Record<string, unknown>;
  const prevDoc = g.document;
  const prevWin = g.window;
  g.document = mockDoc;
  if (prevWin === undefined) {
    g.window = {
      location: { href: "http://localhost/" },
      setTimeout: globalThis.setTimeout.bind(globalThis),
      clearTimeout: globalThis.clearTimeout.bind(globalThis),
      setInterval: globalThis.setInterval.bind(globalThis),
      clearInterval: globalThis.clearInterval.bind(globalThis),
    };
  }

  return {
    headChildren,
    restore() {
      if (prevDoc === undefined) delete g.document;
      else g.document = prevDoc;
      if (prevWin === undefined) delete g.window;
      else g.window = prevWin;
    },
  };
}

async function setupGoalHost(options?: {
  config?: GoalTrackerConfig;
  replies?: ScriptedReply[];
}) {
  const dataDir = mkdtempSync(join(tmpdir(), "qj-gt-host-"));
  const workspaceDir = mkdtempSync(join(tmpdir(), "qj-gt-ws-"));
  const handlers = new Map<string, RpcHandler>();
  const broadcasts: Array<{ method: string; params: unknown }> = [];

  class TestRpcService extends Service implements RpcService {
    static provide = "rpc";
    constructor(ctx: Context) {
      super(ctx, "rpc");
    }
    method(methodName: string, handler: RpcHandler): () => void {
      handlers.set(methodName, handler);
      return () => {
        handlers.delete(methodName);
      };
    }
    methods(): string[] {
      return [...handlers.keys()];
    }
    broadcast(methodName: string, params?: unknown): void {
      broadcasts.push({ method: methodName, params });
    }
  }

  const provider = new ScriptedProvider(options?.replies ?? []);
  const hostPlugins: PluginEntry[] = [...corePlugins(), [TestRpcService]];
  if (options?.replies !== undefined) {
    hostPlugins.push([
      {
        name: "test-scripted-llm",
        inject: ["llm"],
        apply: (ctx: Context) => {
          useScriptedProvider(ctx, provider);
        },
      },
    ]);
  }
  const host = createHost({
    version: "0.0.0-test",
    dataDir,
    plugins: hostPlugins,
  });
  await host.start();
  await host.ctx.plugin(goalTrackerHost, options?.config ?? { roundDelayMs: 0 });

  const callRpc = async <T,>(method: string, params?: Record<string, unknown>): Promise<T> => {
    const fn = handlers.get(method);
    if (!fn) throw new Error(`Missing RPC handler: ${method}`);
    return (await fn(params ?? {}, {
      signal: new AbortController().signal,
      notify: () => undefined,
    })) as T;
  };

  return {
    host,
    workspaceDir,
    provider,
    broadcasts,
    callRpc,
    async dispose() {
      await host.stop();
      rmSync(dataDir, { recursive: true, force: true });
      rmSync(workspaceDir, { recursive: true, force: true });
    },
  };
}

async function waitForCondition(predicate: () => boolean, timeoutMs = 4000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 15));
  }
  throw new Error("Timed out waiting for condition");
}

describe("goal-tracker plugin verification & offline compilation", () => {
  const disposers: Array<() => Promise<void> | void> = [];

  afterEach(async () => {
    resetMockClient();
    while (disposers.length > 0) {
      await disposers.pop()?.();
    }
  });

  it("passes verifyPluginDirectory with zero errors and compiles cleanly against generated plugin-types", async () => {
    const report = await verifyPluginDirectory(GOAL_PLUGIN_DIR);
    expect(report.errors).toEqual([]);
    expect(report.ok).toBe(true);
    expect(report.pluginId).toBe("goal-tracker");
    expect(report.hasHost).toBe(true);
    expect(report.hasClient).toBe(true);

    const tempBase = mkdtempSync(join(tmpdir(), "qj-gt-types-"));
    disposers.push(() => rmSync(tempBase, { recursive: true, force: true }));
    const typesDir = join(tempBase, "plugin-types");
    generatePluginTypes({ targetDir: typesDir });

    const entryFiles = [
      join(GOAL_PLUGIN_DIR, "host.ts").replace(/\\/g, "/"),
      join(GOAL_PLUGIN_DIR, "client.tsx").replace(/\\/g, "/"),
    ];
    for (const file of entryFiles) {
      expect(existsSync(file)).toBe(true);
    }

    const checkDir = join(tempBase, "check-goal-tracker");
    mkdirSync(checkDir, { recursive: true });
    const relTypes = relative(checkDir, typesDir).replace(/\\/g, "/");
    const nodeTypesDir = join(REPO_ROOT, "node_modules", "@types").replace(/\\/g, "/");
    const tsconfigPath = join(checkDir, "tsconfig.json");
    writeFileSync(
      tsconfigPath,
      JSON.stringify(
        {
          extends: `${relTypes}/tsconfig.plugin.json`,
          compilerOptions: {
            baseUrl: ".",
            typeRoots: [nodeTypesDir],
            types: ["node"],
            paths: {
              "react/jsx-runtime": [`${relTypes}/react/jsx-runtime.d.ts`],
              "react/jsx-dev-runtime": [`${relTypes}/react/jsx-dev-runtime.d.ts`],
              "*": [`${relTypes}/*/index.d.ts`, `${relTypes}/*`],
            },
          },
          files: entryFiles,
        },
        null,
        2,
      ),
      "utf8",
    );

    const cfg = ts.readConfigFile(tsconfigPath, ts.sys.readFile);
    expect(cfg.error).toBeUndefined();
    const parsed = ts.parseJsonConfigFileContent(cfg.config, ts.sys, checkDir);
    const program = ts.createProgram(parsed.fileNames, parsed.options);
    const diagnostics = ts
      .getPreEmitDiagnostics(program)
      .map((d) => ts.flattenDiagnosticMessageText(d.messageText, "\n"));
    expect(diagnostics).toEqual([]);
  });

  it("persists DSH 4-phase GoalRecord with CAS revision, fork disarm, and rewind rollback", async () => {
    const env = await setupGoalHost();
    disposers.push(() => env.dispose());

    const session = env.host.ctx.sessions.create({ cwd: env.workspaceDir });
    const toolEnv = {
      sessionId: session.id,
      cwd: env.workspaceDir,
      signal: new AbortController().signal,
    };

    const createRes = await env.host.ctx.tools.execute(
      {
        id: "call-1",
        name: "create_goal",
        args: {
          objective: "Rebuild DSH goal harness",
          token_budget: 120_000,
          notes: "Initial setup",
        },
      },
      toolEnv,
    );
    expect(createRes.isError).not.toBe(true);
    const seqAfterCreate = session.lastSeq;

    const initialSnap = await env.callRpc<GoalSnapshot>("goalTracker.get", { sessionId: session.id });
    expect(initialSnap.goal).toMatchObject({
      sessionId: session.id,
      objective: "Rebuild DSH goal harness",
      phase: "active",
      status: "active",
      armed: true,
      revision: 1,
      roundsStarted: 1,
      maxGoalRounds: DEFAULT_MAX_GOAL_ROUNDS,
      tokenBudget: 120_000,
      notes: "Initial setup",
    });

    // Progress update bumps revision 1 -> 2 and preserves armed: true
    const midRes = await env.host.ctx.tools.execute(
      {
        id: "call-2",
        name: "update_goal",
        args: {
          action: "progress",
          goal_id: initialSnap.goal?.id,
          revision: 1,
          notes: "Host state verified",
        },
      },
      toolEnv,
    );
    expect(midRes.isError).not.toBe(true);
    const seqAfterMid = session.lastSeq;

    // Stale CAS revision is rejected
    const staleRes = await env.host.ctx.tools.execute(
      {
        id: "call-stale",
        name: "update_goal",
        args: {
          action: "complete",
          goal_id: initialSnap.goal?.id,
          revision: 1,
        },
      },
      toolEnv,
    );
    expect(staleRes.isError).toBe(true);
    expect((staleRes.content[0] as { text: string }).text).toContain("CAS 冲突");

    // Forking preserves durable state under forked ID, safely DISARMED (`armed: false`)
    const forked = env.host.ctx.sessions.fork(session);
    const forkedSnap = await env.callRpc<GoalSnapshot>("goalTracker.get", { sessionId: forked.id });
    expect(forkedSnap.goal?.sessionId).toBe(forked.id);
    expect(forkedSnap.goal?.phase).toBe("active");
    expect(forkedSnap.goal?.armed).toBe(false);

    // Pause / Resume / Edit / Complete / Clear RPC lifecycle with CAS
    const paused = await env.callRpc<GoalSnapshot>("goalTracker.pause", {
      sessionId: session.id,
      goalId: initialSnap.goal?.id,
      revision: 2,
    });
    expect(paused.goal?.phase).toBe("paused");
    expect(paused.goal?.armed).toBe(false);
    expect(paused.goal?.revision).toBe(3);

    const resumed = await env.callRpc<GoalSnapshot>("goalTracker.resume", {
      sessionId: session.id,
      goalId: paused.goal?.id,
      revision: 3,
    });
    expect(resumed.goal?.phase).toBe("active");
    expect(resumed.goal?.armed).toBe(true);
    expect(resumed.goal?.revision).toBe(4);

    const edited = await env.callRpc<GoalSnapshot>("goalTracker.edit", {
      sessionId: session.id,
      goalId: resumed.goal?.id,
      revision: 4,
      objective: "Rebuild DSH goal harness v2",
    });
    expect(edited.goal?.objective).toBe("Rebuild DSH goal harness v2");
    expect(edited.goal?.revision).toBe(5);

    const completed = await env.callRpc<GoalSnapshot>("goalTracker.complete", {
      sessionId: session.id,
      goalId: edited.goal?.id,
      revision: 5,
    });
    expect(completed.goal?.phase).toBe("complete");
    expect(completed.goal?.armed).toBe(false);
    const seqAfterComplete = session.lastSeq;
    const latestEvt = session.events.at(-1);
    expect(latestEvt?.type === "custom" && (latestEvt.data.data as { justCompleted?: boolean }).justCompleted).toBe(true);

    const cleared = await env.callRpc<{ cleared: boolean }>("goalTracker.clear", {
      sessionId: session.id,
    });
    expect(cleared.cleared).toBe(true);
    expect((await env.callRpc<GoalSnapshot>("goalTracker.get", { sessionId: session.id })).goal).toBeNull();

    // Rewind restores historical GoalRecord and disarms active continuation
    session.append("rewind", { toSeq: seqAfterComplete, reason: "undo clear" });
    expect((await env.callRpc<GoalSnapshot>("goalTracker.get", { sessionId: session.id })).goal?.phase).toBe("complete");

    session.append("rewind", { toSeq: seqAfterMid, reason: "back to active mid" });
    const rewoundMid = await env.callRpc<GoalSnapshot>("goalTracker.get", { sessionId: session.id });
    expect(rewoundMid.goal?.phase).toBe("active");
    expect(rewoundMid.goal?.armed).toBe(false);
    expect(rewoundMid.goal?.notes).toBe("Host state verified");

    session.append("rewind", { toSeq: seqAfterCreate, reason: "back to create" });
    expect(reconstructSessionGoal(session)?.notes).toBe("Initial setup");

    session.append("rewind", { toSeq: 0, reason: "reset all" });
    expect(reconstructSessionGoal(session)).toBeNull();
  });

  it("enforces execution-period authorization and blockedAfterConsecutiveRounds threshold", async () => {
    const env = await setupGoalHost({
      config: { blockedAfterConsecutiveRounds: 3, roundDelayMs: 0 },
    });
    disposers.push(() => env.dispose());

    const session = env.host.ctx.sessions.create({ cwd: env.workspaceDir });
    const toolEnv = {
      sessionId: session.id,
      cwd: env.workspaceDir,
      signal: new AbortController().signal,
    };

    await env.host.ctx.tools.execute(
      { id: "g1", name: "create_goal", args: { objective: "Fix flaky tests", max_goal_rounds: 10 } },
      toolEnv,
    );
    const created = reconstructSessionGoal(session);
    expect(created).not.toBeNull();

    // Simulate an automated `<goal_round>` turn
    if (created !== null) {
      session.append("user", {
        content: [{ type: "text", text: buildGoalRoundXml(created), meta: true }],
      });
    }

    // Cannot replace active goal or raise max_goal_rounds during automated `<goal_round>`
    const resetAttempt = await env.host.ctx.tools.execute(
      { id: "g-reset", name: "create_goal", args: { objective: "Reset budget" } },
      toolEnv,
    );
    expect(resetAttempt.isError).toBe(true);

    const inflateAttempt = await env.host.ctx.tools.execute(
      { id: "g-inflate", name: "update_goal", args: { action: "edit", max_goal_rounds: 999 } },
      toolEnv,
    );
    expect(inflateAttempt.isError).toBe(true);

    // Round 1 blocked signal -> stays active (1/3); duplicate in same round does NOT double-count
    await env.host.ctx.tools.execute(
      { id: "b1", name: "update_goal", args: { action: "blocked", blocked_reason: "missing API key" } },
      toolEnv,
    );
    expect(reconstructSessionGoal(session)).toMatchObject({ phase: "active", consecutiveBlockCount: 1 });

    await env.host.ctx.tools.execute(
      { id: "b1-dup", name: "update_goal", args: { action: "blocked", blocked_reason: "missing API key" } },
      toolEnv,
    );
    expect(reconstructSessionGoal(session)).toMatchObject({ phase: "active", consecutiveBlockCount: 1 });

    // Advance to Round 2 and block -> stays active (2/3)
    const r1 = reconstructSessionGoal(session);
    if (r1 !== null) {
      session.append("custom", { ns: GOAL_NAMESPACE, data: { ...r1, roundsStarted: 2, revision: r1.revision + 1 } });
    }
    await env.host.ctx.tools.execute(
      { id: "b2", name: "update_goal", args: { action: "blocked", blocked_reason: "missing API key" } },
      toolEnv,
    );
    expect(reconstructSessionGoal(session)).toMatchObject({ phase: "active", consecutiveBlockCount: 2 });

    // Progress resets consecutiveBlockCount to 0; test fresh 1 -> 2 -> 3 transition
    await env.host.ctx.tools.execute(
      { id: "p-reset", name: "update_goal", args: { action: "progress", notes: "Trying workaround" } },
      toolEnv,
    );
    expect(reconstructSessionGoal(session)).toMatchObject({ phase: "active", consecutiveBlockCount: 0 });

    const r2 = reconstructSessionGoal(session);
    if (r2 !== null) {
      session.append("custom", { ns: GOAL_NAMESPACE, data: { ...r2, roundsStarted: 3, revision: r2.revision + 1 } });
    }
    await env.host.ctx.tools.execute(
      { id: "b3a", name: "update_goal", args: { action: "blocked", blocked_reason: "still missing key" } },
      toolEnv,
    );
    const r3 = reconstructSessionGoal(session);
    if (r3 !== null) {
      session.append("custom", { ns: GOAL_NAMESPACE, data: { ...r3, roundsStarted: 4, revision: r3.revision + 1 } });
    }
    await env.host.ctx.tools.execute(
      { id: "b3b", name: "update_goal", args: { action: "blocked", blocked_reason: "still missing key" } },
      toolEnv,
    );
    const r4 = reconstructSessionGoal(session);
    if (r4 !== null) {
      session.append("custom", { ns: GOAL_NAMESPACE, data: { ...r4, roundsStarted: 5, revision: r4.revision + 1 } });
    }
    await env.host.ctx.tools.execute(
      { id: "b3c", name: "update_goal", args: { action: "blocked", blocked_reason: "still missing key" } },
      toolEnv,
    );

    const finalSnap = await env.callRpc<GoalSnapshot>("goalTracker.get", { sessionId: session.id });
    expect(finalSnap.goal?.phase).toBe("blocked");
    expect(finalSnap.goal?.armed).toBe(false);
    expect(finalSnap.goal?.blockedReason).toEqual({ code: "model-blocked", message: "still missing key" });
  });

  it("runs /goal control-plane commands and promotes pre-session goals on agent/before-start", async () => {
    const env = await setupGoalHost();
    disposers.push(() => env.dispose());

    // Pre-session `/goal <objective>` -> returns `<goal_round>` XML prompt, promotes cleanly
    const preCmd = await env.host.ctx.commands.run("goal", "修复首轮会话目标绑定", {
      cwd: env.workspaceDir,
      signal: new AbortController().signal,
    });
    expect(preCmd?.prompt).toContain("<goal_round>");
    expect(preCmd?.prompt).toContain("修复首轮会话目标绑定");
    expect(preCmd?.prompt).toContain("Round: 1/256");

    const sessionA = env.host.ctx.sessions.create({ cwd: env.workspaceDir });
    sessionA.append("user", {
      content: [
        { type: "text", text: "/goal 修复首轮会话目标绑定" },
        { type: "text", text: preCmd?.prompt ?? "", meta: true },
      ],
    });
    await env.host.ctx.serial("agent/before-start", sessionA);

    const promotedA = await env.callRpc<GoalSnapshot>("goalTracker.get", { sessionId: sessionA.id });
    expect(promotedA.goal?.objective).toBe("修复首轮会话目标绑定");
    expect(promotedA.goal?.armed).toBe(true);
    expect((await env.callRpc<GoalSnapshot>("goalTracker.get", {})).goal).toBeNull();

    // Control commands: status, edit, pause, resume, done, clear
    const statusOut = await env.host.ctx.commands.run("goal", "status", {
      sessionId: sessionA.id,
      cwd: env.workspaceDir,
      signal: new AbortController().signal,
    });
    expect(statusOut?.output).toContain("进行中");
    expect(statusOut?.output).toContain("1/256");

    const editOut = await env.host.ctx.commands.run("goal", "edit 修复首轮会话目标绑定（增强版）", {
      sessionId: sessionA.id,
      cwd: env.workspaceDir,
      signal: new AbortController().signal,
    });
    expect(editOut?.output).toContain("增强版");
    expect(reconstructSessionGoal(sessionA)?.objective).toBe("修复首轮会话目标绑定（增强版）");

    const pauseOut = await env.host.ctx.commands.run("goal", "pause", {
      sessionId: sessionA.id,
      cwd: env.workspaceDir,
      signal: new AbortController().signal,
    });
    expect(pauseOut?.output).toContain("已暂停");
    expect((await env.callRpc<GoalSnapshot>("goalTracker.get", { sessionId: sessionA.id })).goal?.armed).toBe(false);

    const resumeOut = await env.host.ctx.commands.run("goal", "resume", {
      sessionId: sessionA.id,
      cwd: env.workspaceDir,
      signal: new AbortController().signal,
    });
    expect(resumeOut?.output).toContain("已恢复");
    expect((await env.callRpc<GoalSnapshot>("goalTracker.get", { sessionId: sessionA.id })).goal?.armed).toBe(true);

    const doneOut = await env.host.ctx.commands.run("goal", "done", {
      sessionId: sessionA.id,
      cwd: env.workspaceDir,
      signal: new AbortController().signal,
    });
    expect(doneOut?.output).toContain("已完成");
    expect(reconstructSessionGoal(sessionA)?.phase).toBe("complete");

    const clearOut = await env.host.ctx.commands.run("goal", "clear", {
      sessionId: sessionA.id,
      cwd: env.workspaceDir,
      signal: new AbortController().signal,
    });
    expect(clearOut?.output).toBe("已清除当前会话的长程目标追踪。");
    expect(reconstructSessionGoal(sessionA)).toBeNull();
  });

  it("drives multi-round <goal_round> loop via agent/settled until update_goal(complete) and stops on round-limit / abort / error", async () => {
    // 1. Multi-round end-to-end loop: Round 1 finishes without update_goal -> driver queues Round 2 `<goal_round>` -> Round 2 calls update_goal(complete) -> loop stops
    const env = await setupGoalHost({
      config: { roundDelayMs: 5, defaultMaxGoalRounds: 10 },
      replies: [
        textReply("已完成第一阶段代码修改。"),
        toolReply([
          { id: "tc-done", name: "update_goal", args: { action: "complete", notes: "全部测试绿灯" } },
        ]),
        textReply("目标已收尾完成。"),
      ],
    });
    disposers.push(() => env.dispose());

    const session = env.host.ctx.sessions.create({
      cwd: env.workspaceDir,
      model: { provider: "scripted", model: "test-model" },
    });

    const cmd = await env.host.ctx.commands.run("goal", "完成多轮端到端验证", {
      sessionId: session.id,
      cwd: env.workspaceDir,
      signal: new AbortController().signal,
    });
    env.host.ctx.agents.prompt(session, [
      { type: "text", text: "/goal 完成多轮端到端验证" },
      { type: "text", text: cmd?.prompt ?? "", meta: true },
    ]);

    await waitForCondition(() => reconstructSessionGoal(session)?.phase === "complete" && !env.host.ctx.agents.status(session.id).running);
    const completedGoal = reconstructSessionGoal(session);
    expect(completedGoal?.roundsStarted).toBe(2);
    expect(completedGoal?.notes).toBe("全部测试绿灯");
    // Ensure driver did not schedule Round 3 after completion
    await new Promise((r) => setTimeout(r, 40));
    expect(reconstructSessionGoal(session)?.roundsStarted).toBe(2);

    // Check `<goal_round>` synthetic user event was persisted with `meta: true`
    const goalRoundUsers = session.events.filter(
      (ev) =>
        ev.type === "user"
        && ev.data.content.every((b) => b.type === "text" && b.meta === true)
        && ev.data.content.some((b) => b.type === "text" && b.text.includes("<goal_round>")),
    );
    expect(goalRoundUsers.length).toBe(1);

    // 2. Round limit cap transitions to `blocked` (`round-limit`) and disarms
    const cappedSession = env.host.ctx.sessions.create({
      cwd: env.workspaceDir,
      model: { provider: "scripted", model: "test-model" },
    });
    await env.host.ctx.tools.execute(
      { id: "g-cap", name: "create_goal", args: { objective: "Run bounded rounds", max_goal_rounds: 1 } },
      { sessionId: cappedSession.id, cwd: env.workspaceDir, signal: new AbortController().signal },
    );
    await env.host.ctx.parallel("agent/settled", cappedSession, "done");
    await waitForCondition(() => reconstructSessionGoal(cappedSession)?.phase === "blocked");
    expect(reconstructSessionGoal(cappedSession)?.blockedReason?.code).toBe("round-limit");

    // 3. Aborted run transitions active goal to `paused` and disarms; Error transitions to `blocked`
    const abortSession = env.host.ctx.sessions.create({ cwd: env.workspaceDir });
    await env.host.ctx.tools.execute(
      { id: "g-ab", name: "create_goal", args: { objective: "Handle abort" } },
      { sessionId: abortSession.id, cwd: env.workspaceDir, signal: new AbortController().signal },
    );
    await env.host.ctx.parallel("agent/settled", abortSession, "aborted");
    const abortSnap = await env.callRpc<GoalSnapshot>("goalTracker.get", { sessionId: abortSession.id });
    expect(abortSnap.goal?.phase).toBe("paused");
    expect(abortSnap.goal?.armed).toBe(false);

    const errSession = env.host.ctx.sessions.create({ cwd: env.workspaceDir });
    await env.host.ctx.tools.execute(
      { id: "g-err", name: "create_goal", args: { objective: "Handle error" } },
      { sessionId: errSession.id, cwd: env.workspaceDir, signal: new AbortController().signal },
    );
    await env.host.ctx.parallel("agent/settled", errSession, "error");
    const errSnap = await env.callRpc<GoalSnapshot>("goalTracker.get", { sessionId: errSession.id });
    expect(errSnap.goal?.phase).toBe("blocked");
    expect(errSnap.goal?.blockedReason?.code).toBe("error");
    expect(errSnap.goal?.armed).toBe(false);
  });

  it("injects <goal-reminder> on llm/request drift (>10 events) only while active", async () => {
    const env = await setupGoalHost();
    disposers.push(() => env.dispose());

    const session = env.host.ctx.sessions.create({ cwd: env.workspaceDir });
    await env.host.ctx.tools.execute(
      { id: "g-1", name: "create_goal", args: { objective: "Ship DSH goal harness" } },
      { sessionId: session.id, cwd: env.workspaceDir, signal: new AbortController().signal },
    );

    const runLlmWaterfall = async (): Promise<LlmRequest> => {
      const req: LlmRequest = {
        provider: "mock",
        model: "mock-model",
        sessionId: session.id,
        system: "sys",
        messages: [{ role: "user", content: [{ type: "text", text: "continue working" }] }],
      };
      const stream = env.host.ctx.waterfall("llm/request", req, async function* (): AsyncGenerator<StreamChunk> {
        yield { type: "finish", reason: "stop" };
      });
      for await (const _chunk of stream) {
        // consume stream
      }
      return req;
    };

    for (let i = 0; i < 6; i += 1) {
      session.append("user", { content: [{ type: "text", text: `step ${i}` }] });
    }
    expect(JSON.stringify((await runLlmWaterfall()).messages)).not.toContain("<goal-reminder>");

    for (let i = 0; i < 6; i += 1) {
      session.append("user", { content: [{ type: "text", text: `more ${i}` }] });
    }
    const drifted = JSON.stringify((await runLlmWaterfall()).messages);
    expect(drifted).toContain("<goal-reminder>");
    expect(drifted).toContain("Ship DSH goal harness");
  });
});

describe("goal-tracker client GoalBar UX & SSR safety", () => {
  const disposers: Array<() => void> = [];

  afterEach(() => {
    resetMockClient();
    while (disposers.length > 0) {
      disposers.pop()?.();
    }
  });

  it("never queries on task-start or empty new tabs, uses zero polling, and hides completed or cross-session goals", () => {
    mockClient.session.sessionId = null;
    expect(renderToStaticMarkup(createElement(GoalBar, { variant: "follow-up" }))).toBe("");
    expect(mockClient.lastQueryCall?.options?.enabled).toBe(false);

    mockClient.session.sessionId = "sess-1";
    expect(renderToStaticMarkup(createElement(GoalBar, { variant: "task-start" }))).toBe("");
    expect(mockClient.lastQueryCall?.options?.enabled).toBe(false);

    mockClient.session.sessionId = "sess-new";
    mockClient.queryData = {
      goal: {
        id: "g-old",
        sessionId: "sess-old",
        revision: 1,
        objective: "Should never flash across tabs",
        phase: "active",
        armed: true,
        roundsStarted: 1,
        maxGoalRounds: 256,
        createdAt: Date.now() - 15_000,
        updatedAt: Date.now() - 15_000,
      },
    };
    expect(renderToStaticMarkup(createElement(GoalBar, { variant: "follow-up" }))).toBe("");
    expect(mockClient.lastQueryCall?.options?.refreshIntervalMs).toBeUndefined();

    // Completed goals hide GoalBar automatically (milestone card lives in transcript)
    mockClient.queryData = {
      goal: {
        id: "g-done",
        sessionId: "sess-new",
        revision: 3,
        objective: "Finished task",
        phase: "complete",
        armed: false,
        roundsStarted: 4,
        maxGoalRounds: 256,
        createdAt: Date.now() - 30_000,
        updatedAt: Date.now(),
        completedAt: Date.now(),
      },
    };
    expect(renderToStaticMarkup(createElement(GoalBar, { variant: "follow-up" }))).toBe("");
  });

  it("renders compact DSH GoalBar states (active, disarmed, paused, blocked) with accurate stopwatch & round counter", () => {
    expect(formatGoalElapsed(42_500)).toBe("42 秒");
    expect(formatGoalElapsed(195_000)).toBe("3 分 15 秒");
    expect(formatTokenCompact(12_400)).toBe("12k");
    expect(formatTokenCompact(8_500)).toBe("8.5k");

    const now = Date.now();
    const stats: SessionStats = {
      userMessages: 2,
      assistantMessages: 2,
      toolCalls: 4,
      toolResults: 4,
      totalMessages: 4,
      tokens: {
        input: 6_000,
        output: 2_500,
        cacheRead: 0,
        cacheWrite: 0,
        total: 8_500,
      },
      cost: 0.04,
    };

    mockClient.session = {
      sessionId: "sess-live",
      sessionFile: "harness:sess-live",
      cwd: "/workspace",
      isStreaming: true,
      isCompacting: false,
      model: { provider: "openai", id: "gpt-5" },
      stats,
      messageCount: 4,
    };
    mockClient.queryData = {
      goal: {
        id: "g-live",
        sessionId: "sess-live",
        revision: 2,
        objective: "Implement DSH-style GoalBar controller",
        phase: "active",
        armed: true,
        roundsStarted: 7,
        maxGoalRounds: 256,
        createdAt: now - 45_000,
        updatedAt: now - 20_000,
        accumulatedMs: 25_000,
        activeSince: now - 20_000,
        tokenBudget: 120_000,
      },
    };

    const activeHtml = renderToStaticMarkup(createElement(GoalBannerView, { variant: "follow-up" }));
    expect(activeHtml).toContain("进行中");
    expect(activeHtml).toContain("gt-pulse-dot");
    expect(activeHtml).toContain("Implement DSH-style GoalBar controller");
    expect(activeHtml).toContain("第 7/256 轮");
    expect(activeHtml).toContain("8.5k / 120k tok");
    expect(activeHtml).toMatch(/4[56] 秒/);
    expect(activeHtml).toContain("暂停");
    expect(activeHtml).toContain('aria-label="编辑目标"');
    expect(activeHtml).toContain('aria-label="清除目标"');
    expect(activeHtml).not.toContain("gt-checklist");

    // Disarmed active goal (e.g. reopened or forked session) renders `已挂起` + `继续` with frozen stopwatch
    mockClient.session.isStreaming = false;
    mockClient.queryData = {
      goal: {
        id: "g-disarmed",
        sessionId: "sess-live",
        revision: 3,
        objective: "Resumed from fork",
        phase: "active",
        armed: false,
        roundsStarted: 4,
        maxGoalRounds: 256,
        createdAt: now - 120_000,
        updatedAt: now - 60_000,
        accumulatedMs: 32_000,
      },
    };
    const disarmedHtml = renderToStaticMarkup(createElement(GoalBar, { variant: "follow-up" }));
    expect(disarmedHtml).toContain("已挂起");
    expect(disarmedHtml).toContain("继续");
    expect(disarmedHtml).toContain("32 秒");

    // Paused goal renders `已暂停` + `继续`
    mockClient.queryData = {
      goal: {
        id: "g-paused",
        sessionId: "sess-live",
        revision: 4,
        objective: "Paused migration",
        phase: "paused",
        armed: false,
        roundsStarted: 5,
        maxGoalRounds: 256,
        createdAt: now - 90_000,
        updatedAt: now - 30_000,
        accumulatedMs: 60_000,
      },
    };
    const pausedHtml = renderToStaticMarkup(createElement(GoalBar, { variant: "follow-up" }));
    expect(pausedHtml).toContain("已暂停");
    expect(pausedHtml).toContain("继续");
    expect(pausedHtml).toContain("1 分 0 秒");

    // Blocked goal renders `已受阻` + compact `.gt-blocker-row` + `继续`
    mockClient.queryData = {
      goal: {
        id: "g-blocked",
        sessionId: "sess-live",
        revision: 5,
        objective: "Deploy staging preview",
        phase: "blocked",
        armed: false,
        roundsStarted: 6,
        maxGoalRounds: 256,
        createdAt: now - 90_000,
        updatedAt: now - 30_000,
        accumulatedMs: 60_000,
        blockedReason: {
          code: "model-blocked",
          message: "缺少 STAGING_TOKEN 环境变量",
        },
      },
    };
    const blockedHtml = renderToStaticMarkup(createElement(GoalBar, { variant: "follow-up" }));
    expect(blockedHtml).toContain("已受阻");
    expect(blockedHtml).toContain("gt-blocker-row");
    expect(blockedHtml).toContain("缺少 STAGING_TOKEN 环境变量");
    expect(blockedHtml).toContain("继续");
  });

  it("registers goal-tracker:banner with --qj-* theme tokens and renders safely in pure Node SSR without window/document", async () => {
    const dom = installMockDom();
    disposers.push(() => dom.restore());

    const registry = new ClientContributionRegistry();
    const root = new Context();
    await root.plugin(ClientContributionService, registry);
    await root.plugin(ClientStylesService);
    disposers.push(() => {
      void root.fiber.dispose();
    });

    await root.plugin(goalTrackerClient);
    const snap = registry.getSnapshot();
    const banner = snap.composerBanners.find((b) => b.id === "goal-tracker:banner");
    expect(banner).toBeDefined();

    const injectedCss = dom.headChildren.map((n) => n.textContent).join("\n");
    expect(injectedCss).toContain("var(--qj-bg-surface)");
    expect(injectedCss).toContain("var(--qj-text-primary)");
    expect(injectedCss).toContain("var(--qj-brand-primary)");
    expect(injectedCss).toContain("var(--qj-status-warning)");

    dom.restore();
    const g = globalThis as Record<string, unknown>;
    const savedWin = g.window;
    const savedDoc = g.document;
    delete g.window;
    delete g.document;
    try {
      mockClient.session.sessionId = "sess-ssr";
      mockClient.queryData = {
        goal: {
          id: "g-ssr",
          sessionId: "sess-ssr",
          revision: 1,
          objective: "SSR render check",
          phase: "active",
          status: "active",
          armed: true,
          roundsStarted: 1,
          maxGoalRounds: 256,
          createdAt: Date.now() - 12_000,
          updatedAt: Date.now() - 12_000,
          accumulatedMs: 0,
          activeSince: Date.now() - 12_000,
          consecutiveBlockCount: 0,
        } satisfies GoalRecord & { armed: boolean },
      } satisfies GoalSnapshot;
      const ssrHtml = renderToStaticMarkup(
        createElement(() => banner?.render({ cwd: "/demo", sessionFile: "harness:sess-ssr", variant: "follow-up" }) ?? null),
      );
      expect(ssrHtml).toContain("SSR render check");
      expect(ssrHtml).toContain("第 1/256 轮");
      expect(ssrHtml).toMatch(/1[23] 秒/);
    } finally {
      if (savedWin !== undefined) g.window = savedWin;
      if (savedDoc !== undefined) g.document = savedDoc;
    }
  });
});

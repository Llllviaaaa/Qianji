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
import type { ActiveSessionSnapshot, HostRpcQueryOptions, SessionStats } from "@qianji/client";
import { corePlugins } from "../packages/host/src/agent-plugins.ts";
import { createHost } from "../packages/host/src/host.ts";
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
  GOAL_NAMESPACE,
  reconstructSessionGoal,
  type GoalRecord,
  type GoalSnapshot,
} from "../plugins/goal-tracker/host.ts";
import goalTrackerClient, {
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

async function setupGoalHost() {
  const dataDir = mkdtempSync(join(tmpdir(), "qj-gt-host-"));
  const workspaceDir = mkdtempSync(join(tmpdir(), "qj-gt-ws-"));
  const handlers = new Map<string, RpcHandler>();

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
    broadcast(): void {}
  }

  const host = createHost({
    version: "0.0.0-test",
    dataDir,
    plugins: [...corePlugins(), [TestRpcService]],
  });
  await host.start();
  await host.ctx.plugin(goalTrackerHost);

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
    callRpc,
    async dispose() {
      await host.stop();
      rmSync(dataDir, { recursive: true, force: true });
      rmSync(workspaceDir, { recursive: true, force: true });
    },
  };
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

  it("persists GoalRecord onto Session custom events, supports optional-status update_goal, criteria toggle, fork, and rewind rollback", async () => {
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
          objective: "Rebuild autonomous goal harness",
          token_budget: 120_000,
          notes: "Initial milestone setup",
          criteria: [
            { text: "Persist onto session log" },
            { id: "crit-ui", text: "Render dock banner", done: true },
          ],
        },
      },
      toolEnv,
    );
    expect(createRes.isError).not.toBe(true);
    const seqAfterCreate = session.lastSeq;

    const customEventsAfterCreate = session.events.filter(
      (ev) => ev.type === "custom" && ev.data.ns === GOAL_NAMESPACE,
    );
    expect(customEventsAfterCreate.length).toBe(1);

    const initialSnap = await env.callRpc<GoalSnapshot>("goalTracker.get", { sessionId: session.id });
    expect(initialSnap.goal?.objective).toBe("Rebuild autonomous goal harness");
    expect(initialSnap.goal?.sessionId).toBe(session.id);
    expect(initialSnap.goal?.tokenBudget).toBe(120_000);
    expect(initialSnap.goal?.notes).toBe("Initial milestone setup");
    expect(initialSnap.goal?.criteria).toEqual([
      { id: "c1", text: "Persist onto session log", done: false },
      { id: "crit-ui", text: "Render dock banner", done: true },
    ]);

    // Optional `status` in `update_goal`: updates `notes` and `criteria` while preserving `status: "active"`
    const midUpdateRes = await env.host.ctx.tools.execute(
      {
        id: "call-2",
        name: "update_goal",
        args: {
          notes: "Session persistence verified",
          criteria: [
            { id: "c1", text: "Persist onto session log", done: true },
            { id: "crit-ui", text: "Render dock banner", done: false },
            { text: "Pass vitest suite" },
          ],
        },
      },
      toolEnv,
    );
    expect(midUpdateRes.isError).not.toBe(true);
    const seqAfterMidUpdate = session.lastSeq;

    const getToolRes = await env.host.ctx.tools.execute(
      { id: "call-3", name: "get_goal", args: {} },
      toolEnv,
    );
    const parsedGet = JSON.parse((getToolRes.content[0] as { text: string }).text) as GoalRecord;
    expect(parsedGet.status).toBe("active");
    expect(parsedGet.notes).toBe("Session persistence verified");
    expect(parsedGet.maxReminds).toBe(3);
    expect(parsedGet.criteria).toEqual([
      { id: "c1", text: "Persist onto session log", done: true },
      { id: "crit-ui", text: "Render dock banner", done: false },
      { id: "c3", text: "Pass vitest suite", done: false },
    ]);

    // Toggle criterion via RPC keeps status `active`
    const toggledSnap = await env.callRpc<GoalSnapshot>("goalTracker.toggleCriterion", {
      sessionId: session.id,
      criterionId: "crit-ui",
    });
    expect(toggledSnap.goal?.status).toBe("active");
    expect(toggledSnap.goal?.criteria?.find((c) => c.id === "crit-ui")?.done).toBe(true);

    // Forking the session preserves goal state under the forked session's ID
    const forked = env.host.ctx.sessions.fork(session);
    const forkedSnap = await env.callRpc<GoalSnapshot>("goalTracker.get", { sessionId: forked.id });
    expect(forkedSnap.goal?.sessionId).toBe(forked.id);
    expect(forkedSnap.goal?.objective).toBe("Rebuild autonomous goal harness");

    // Mark complete, then clear, then verify `rewind` rolls back cleanly across every stage
    await env.host.ctx.tools.execute(
      { id: "call-4", name: "update_goal", args: { status: "complete", notes: "All checks green" } },
      toolEnv,
    );
    const seqAfterComplete = session.lastSeq;
    expect((await env.callRpc<GoalSnapshot>("goalTracker.get", { sessionId: session.id })).goal?.status).toBe(
      "complete",
    );

    const clearedRes = await env.callRpc<{ cleared: boolean }>("goalTracker.clear", {
      sessionId: session.id,
    });
    expect(clearedRes.cleared).toBe(true);
    expect((await env.callRpc<GoalSnapshot>("goalTracker.get", { sessionId: session.id })).goal).toBeNull();

    // Rewind to `seqAfterComplete` -> restores completed goal
    session.append("rewind", { toSeq: seqAfterComplete, reason: "undo clear" });
    expect((await env.callRpc<GoalSnapshot>("goalTracker.get", { sessionId: session.id })).goal?.status).toBe(
      "complete",
    );

    // Rewind to `seqAfterMidUpdate` -> restores active mid-flight goal before toggle/completion
    session.append("rewind", { toSeq: seqAfterMidUpdate, reason: "back to mid-flight" });
    const rewoundMid = reconstructSessionGoal(session);
    expect(rewoundMid?.status).toBe("active");
    expect(rewoundMid?.notes).toBe("Session persistence verified");
    expect(rewoundMid?.criteria?.find((c) => c.id === "crit-ui")?.done).toBe(false);

    // Rewind to `seqAfterCreate` -> restores initial goal
    session.append("rewind", { toSeq: seqAfterCreate, reason: "back to create" });
    expect(reconstructSessionGoal(session)?.notes).toBe("Initial milestone setup");

    // Rewind to `0` -> before goal creation -> null
    session.append("rewind", { toSeq: 0, reason: "reset all" });
    expect(reconstructSessionGoal(session)).toBeNull();
  });

  it("promotes brand-new session /goal commands on agent/before-start and handles /goal status, done, and clear", async () => {
    const env = await setupGoalHost();
    disposers.push(() => env.dispose());

    // Case 1: `/goal <objective>` invoked before sessionId exists, then promoted on `agent/before-start`
    const preSessionCmd = await env.host.ctx.commands.run("goal", "修复首轮会话目标绑定", {
      cwd: env.workspaceDir,
      signal: new AbortController().signal,
    });
    expect(preSessionCmd?.prompt).toContain("修复首轮会话目标绑定");
    expect(preSessionCmd?.prompt).toContain("criteria");

    const sessionA = env.host.ctx.sessions.create({ cwd: env.workspaceDir });
    sessionA.append("user", {
      content: [
        { type: "text", text: "/goal 修复首轮会话目标绑定" },
        { type: "text", text: preSessionCmd?.prompt ?? "", meta: true },
      ],
    });
    await env.host.ctx.serial("agent/before-start", sessionA);

    const promotedA = await env.callRpc<GoalSnapshot>("goalTracker.get", { sessionId: sessionA.id });
    expect(promotedA.goal?.objective).toBe("修复首轮会话目标绑定");
    expect(promotedA.goal?.sessionId).toBe(sessionA.id);
    // Fallback `"default"` bucket must be clean so other empty tabs never inherit it
    expect((await env.callRpc<GoalSnapshot>("goalTracker.get", {})).goal).toBeNull();

    // Case 2: Direct `/goal <objective>` user event + `meta: true` block without prior `commands.run`
    const sessionB = env.host.ctx.sessions.create({ cwd: env.workspaceDir });
    sessionB.append("user", {
      content: [
        { type: "text", text: "/goal 完成所有回归测试并通过门禁" },
        { type: "text", text: "隐藏的系统级斜杠扩展提示词，不应混入目标标题", meta: true },
      ],
    });
    await env.host.ctx.serial("agent/before-start", sessionB);

    const promotedB = reconstructSessionGoal(sessionB);
    expect(promotedB?.objective).toBe("完成所有回归测试并通过门禁");
    expect(promotedB?.status).toBe("active");

    // Add criteria & notes, then inspect `/goal status`, `/goal done`, and `/goal clear`
    await env.host.ctx.tools.execute(
      {
        id: "u-b1",
        name: "update_goal",
        args: {
          notes: "已完成 1/2 套件",
          criteria: [
            { id: "c1", text: "Unit tests green", done: true },
            { id: "c2", text: "Typecheck green", done: false },
          ],
        },
      },
      { sessionId: sessionB.id, cwd: env.workspaceDir, signal: new AbortController().signal },
    );

    const statusOut = await env.host.ctx.commands.run("goal", "status", {
      sessionId: sessionB.id,
      cwd: env.workspaceDir,
      signal: new AbortController().signal,
    });
    expect(statusOut?.output).toContain("进行中");
    expect(statusOut?.output).toContain("完成所有回归测试并通过门禁");
    expect(statusOut?.output).toContain("已完成 1/2 套件");
    expect(statusOut?.output).toContain("- [x] Unit tests green");
    expect(statusOut?.output).toContain("- [ ] Typecheck green");
    expect(statusOut?.output).toContain("0/3");

    const doneOut = await env.host.ctx.commands.run("goal", "done", {
      sessionId: sessionB.id,
      cwd: env.workspaceDir,
      signal: new AbortController().signal,
    });
    expect(doneOut?.output).toContain("已完成");
    expect(reconstructSessionGoal(sessionB)?.status).toBe("complete");

    const clearOut = await env.host.ctx.commands.run("goal", "clear", {
      sessionId: sessionB.id,
      cwd: env.workspaceDir,
      signal: new AbortController().signal,
    });
    expect(clearOut?.output).toBe("已清除当前会话的长程目标追踪。");
    expect(reconstructSessionGoal(sessionB)).toBeNull();
  });

  it("injects <goal-reminder> on llm/request drift (>10 events) and enforces 1/3..3/3 agent/before-stop audits", async () => {
    const env = await setupGoalHost();
    disposers.push(() => env.dispose());

    const session = env.host.ctx.sessions.create({ cwd: env.workspaceDir });
    await env.host.ctx.tools.execute(
      {
        id: "g-1",
        name: "create_goal",
        args: {
          objective: "Ship zero-leak slash & goal UX",
          criteria: [
            { id: "c1", text: "Verify plugin", done: true },
            { id: "c2", text: "Run vitest", done: false },
          ],
        },
      },
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

    // <= 10 events since latest `qianji-goal` event -> no `<goal-reminder>`
    for (let i = 0; i < 6; i += 1) {
      session.append("user", { content: [{ type: "text", text: `step ${i}` }] });
    }
    const earlyReq = await runLlmWaterfall();
    expect(JSON.stringify(earlyReq.messages)).not.toContain("<goal-reminder>");

    // Exceed 10 events since latest `qianji-goal` event -> `<goal-reminder>` appended
    for (let i = 0; i < 6; i += 1) {
      session.append("user", { content: [{ type: "text", text: `more ${i}` }] });
    }
    const driftedReq = await runLlmWaterfall();
    const trailingText = JSON.stringify(driftedReq.messages);
    expect(trailingText).toContain("<goal-reminder>");
    expect(trailingText).toContain("Ship zero-leak slash & goal UX");
    expect(trailingText).toContain("(c2) Run vitest");

    // `agent/before-stop` ignores non-"stop" finish reasons
    const lengthStop = await env.host.ctx.bail("agent/before-stop", session, {
      turn: 1,
      stop: "length",
      hasText: true,
    });
    expect(lengthStop).toBeUndefined();

    // `agent/before-stop` counts `1/3`, `2/3`, `3/3`, persisting `remindCount` onto `session`, then stops at 4th
    const r1 = await env.host.ctx.bail("agent/before-stop", session, {
      turn: 1,
      stop: "stop",
      hasText: true,
    });
    expect(r1).toContain("[Goal Tracker 核查 (1/3)]");
    expect(r1).toContain("Run vitest");
    expect(reconstructSessionGoal(session)?.remindCount).toBe(1);

    const r2 = await env.host.ctx.bail("agent/before-stop", session, {
      turn: 2,
      stop: "stop",
      hasText: true,
    });
    expect(r2).toContain("[Goal Tracker 核查 (2/3)]");
    expect(reconstructSessionGoal(session)?.remindCount).toBe(2);

    const r3 = await env.host.ctx.bail("agent/before-stop", session, {
      turn: 3,
      stop: "stop",
      hasText: true,
    });
    expect(r3).toContain("[Goal Tracker 核查 (3/3)]");
    expect(reconstructSessionGoal(session)?.remindCount).toBe(3);

    const r4 = await env.host.ctx.bail("agent/before-stop", session, {
      turn: 4,
      stop: "stop",
      hasText: true,
    });
    expect(r4).toBeUndefined();
  });
});

describe("goal-tracker client Dock Card UX & SSR safety", () => {
  const disposers: Array<() => void> = [];

  afterEach(() => {
    resetMockClient();
    while (disposers.length > 0) {
      disposers.pop()?.();
    }
  });

  it("never queries on task-start or empty new tabs, and hides mismatched session goals", () => {
    // 1) Empty tab (`sessionId: null`)
    mockClient.session.sessionId = null;
    const emptyHtml = renderToStaticMarkup(createElement(GoalBannerView, { variant: "follow-up" }));
    expect(emptyHtml).toBe("");
    expect(mockClient.lastQueryCall?.options?.enabled).toBe(false);

    // 2) `task-start` hero composer even if a sessionId exists
    mockClient.session.sessionId = "sess-1";
    const taskStartHtml = renderToStaticMarkup(createElement(GoalBannerView, { variant: "task-start" }));
    expect(taskStartHtml).toBe("");
    expect(mockClient.lastQueryCall?.options?.enabled).toBe(false);

    // 3) Stale RPC data belonging to another session (`sess-old` vs `sess-new`)
    mockClient.session.sessionId = "sess-new";
    mockClient.queryData = {
      goal: {
        id: "g-old",
        sessionId: "sess-old",
        objective: "Should never flash across tabs",
        status: "active",
        createdAt: Date.now() - 15_000,
        updatedAt: Date.now() - 15_000,
        remindCount: 0,
        maxReminds: 3,
      },
    };
    const crossTabHtml = renderToStaticMarkup(createElement(GoalBannerView, { variant: "follow-up" }));
    expect(crossTabHtml).toBe("");
    expect(mockClient.lastQueryCall?.options?.enabled).toBe(true);
    expect(mockClient.lastQueryCall?.params).toEqual({ sessionId: "sess-new" });
  });

  it("renders live >0s elapsed time, visible notes row, criteria progress ring, audit pill, token budget, and auto-expanded blocked checklist", () => {
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
    // Note `updatedAt === createdAt` (45s ago): previously froze at `0 秒`, now computes from `now - createdAt`!
    mockClient.queryData = {
      goal: {
        id: "g-live",
        sessionId: "sess-live",
        objective: "Implement competitor-grade Composer Dock controller",
        status: "active",
        createdAt: now - 45_000,
        updatedAt: now - 45_000,
        tokenBudget: 120_000,
        notes: "已完成 Host 持久化与回退逻辑，正在联调前端状态栏",
        criteria: [
          { id: "c1", text: "Persist onto session events", done: true },
          { id: "c2", text: "Support rewind rollback", done: true },
          { id: "c3", text: "Render visible notes row", done: false },
          { id: "c4", text: "Pass full verification suite", done: false },
        ],
        remindCount: 1,
        maxReminds: 3,
      },
    };

    const activeHtml = renderToStaticMarkup(createElement(GoalBannerView, { variant: "follow-up" }));
    expect(activeHtml).toContain("进行中");
    expect(activeHtml).toContain("gt-pulse-dot");
    expect(activeHtml).toContain("Implement competitor-grade Composer Dock controller");
    // Elapsed is > 0s (never stuck at `0 秒`)
    expect(activeHtml).not.toContain(">0 秒<");
    expect(activeHtml).toMatch(/4[56] 秒/);
    // `goal.notes` is rendered directly in visible DOM text inside `.gt-notes-row`
    expect(activeHtml).toContain('data-goal-notes=""');
    expect(activeHtml).toContain(">已完成 Host 持久化与回退逻辑，正在联调前端状态栏</span>");
    // Criteria progress pill + SVG progress ring + audit pill + token budget comparison
    expect(activeHtml).toContain("gt-ring-svg");
    expect(activeHtml).toContain("✓ 2/4");
    expect(activeHtml).toContain("核查 1/3");
    expect(activeHtml).toContain("8.5k / 120k tok");

    // Blocked status auto-expands interactive checklist & styles notes row with `.is-blocked`
    mockClient.session.isStreaming = false;
    mockClient.queryData = {
      goal: {
        id: "g-blocked",
        sessionId: "sess-live",
        objective: "Deploy staging preview",
        status: "blocked",
        createdAt: now - 90_000,
        updatedAt: now - 30_000,
        notes: "缺少 STAGING_TOKEN 环境变量，请确认是否使用测试凭据",
        criteria: [
          { id: "c1", text: "Build production bundle", done: true },
          { id: "c2", text: "Push to staging endpoint", done: false },
        ],
        remindCount: 1,
        maxReminds: 3,
      },
    };
    const blockedHtml = renderToStaticMarkup(createElement(GoalBannerView, { variant: "follow-up" }));
    expect(blockedHtml).toContain("受阻");
    expect(blockedHtml).toContain("gt-notes-row is-blocked");
    expect(blockedHtml).toContain("缺少 STAGING_TOKEN 环境变量，请确认是否使用测试凭据");
    expect(blockedHtml).toContain('role="checkbox"');
    expect(blockedHtml).toContain("Build production bundle");
    expect(blockedHtml).toContain("Push to staging endpoint");
    // Frozen elapsed for non-active goal (`90s - 30s = 60s` -> `1 分 0 秒`)
    expect(blockedHtml).toContain("1 分 0 秒");
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
    expect(injectedCss).toContain("var(--qj-status-success)");
    expect(injectedCss).toContain("var(--qj-status-warning)");

    // Pure Node SSR safety: strip both `window` and `document` and render active goal
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
          objective: "SSR render check",
          status: "active",
          createdAt: Date.now() - 12_000,
          updatedAt: Date.now() - 12_000,
          notes: "SSR visible note",
          remindCount: 0,
          maxReminds: 3,
        } satisfies GoalRecord,
      } satisfies GoalSnapshot;
      const ssrHtml = renderToStaticMarkup(
        createElement(() => banner?.render({ cwd: "/demo", sessionFile: "harness:sess-ssr", variant: "follow-up" }) ?? null),
      );
      expect(ssrHtml).toContain("SSR render check");
      expect(ssrHtml).toContain("SSR visible note");
      expect(ssrHtml).toMatch(/1[23] 秒/);
    } finally {
      if (savedWin !== undefined) g.window = savedWin;
      if (savedDoc !== undefined) g.document = savedDoc;
    }
  });
});

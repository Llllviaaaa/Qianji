/**
 * End-to-end integration tests for `BotCompanionHarness` + `BotStateStore` +
 * `@qianji/session` + `@qianji/schedule`:
 * 1. Live in-flight `"running"` -> `"completed"` sync, Stage-1 heuristic naming
 *    (zero `"完成主聊天回复"`), and Stage-2 `reflectOnSettledTurn` refinement.
 * 2. Short confirmation reply (`"可以"`) resolved from preceding assistant
 *    proposal + strict `[turnStartSeq..turnEndSeq]` trace isolation in `mainSessionId`.
 * 3. Side-chat semantic auto-titling vs. manual `userRenamed` protection.
 * 4. Conversational `bot_manage_schedule` (`create` + `toggle`) against `@qianji/schedule`.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Context } from "@deepseek-ai/cordis";
import { afterEach, describe, expect, it } from "vitest";
import { AgentLoop } from "@qianji/agent-loop";
import { Credentials, LlmService, type LlmRequest, type StreamChunk } from "@qianji/llm";
import type { BotActivityEntry, BotActivityTraceStep } from "@qianji/protocol";
import { Schedule } from "@qianji/schedule";
import { Sessions } from "@qianji/session";
import { SystemPrompt } from "@qianji/system-prompt";
import { Tools, textOutput } from "@qianji/tools";
import { Ui } from "@qianji/ui";
import { BotCompanionHarness, BotStateStore } from "../packages/host/src/bot/index";
import { createBotHarnessHost } from "../packages/host/src/bot/harness/bot-tools-host";

interface DeferredGate {
  readonly promise: Promise<void>;
  release(): void;
}

function createGate(): DeferredGate {
  let resolveFn: () => void = () => undefined;
  const promise = new Promise<void>((resolve) => {
    resolveFn = resolve;
  });
  return { promise, release: () => resolveFn() };
}

function textChunks(text: string): StreamChunk[] {
  return [
    { type: "text-delta", index: 0, text },
    { type: "usage", usage: { inputTokens: 16, outputTokens: 24 } },
    { type: "finish", reason: "stop" },
  ];
}

function toolCallChunks(id: string, name: string, args: Record<string, unknown>): StreamChunk[] {
  return [
    { type: "tool-call-start", index: 0, id, name },
    { type: "tool-call-delta", index: 0, argumentsDelta: JSON.stringify(args) },
    { type: "usage", usage: { inputTokens: 18, outputTokens: 20 } },
    { type: "finish", reason: "tool-use" },
  ];
}

function reflectJsonChunks(payload: {
  taskTitle: string | null;
  taskSummary: string | null;
  sideChatTitle?: string | null;
}): StreamChunk[] {
  return textChunks(
    JSON.stringify({
      taskTitle: payload.taskTitle,
      taskSummary: payload.taskSummary,
      sideChatTitle: payload.sideChatTitle ?? null,
      preferences: [],
      goals: [],
      space: null,
    }),
  );
}

function lastMessageRole(request: LlmRequest): string | undefined {
  return request.messages.at(-1)?.role;
}

function lastUserPromptText(request: LlmRequest): string {
  for (let i = request.messages.length - 1; i >= 0; i -= 1) {
    const msg = request.messages[i];
    if (msg?.role === "user") {
      return msg.content.flatMap((b) => (b.type === "text" ? [b.text] : [])).join("\n");
    }
  }
  return "";
}

describe("BotCompanionHarness History Sync, Per-Turn Trace Isolation & Conversational Schedule", () => {
  const cleanups: Array<() => Promise<void> | void> = [];

  afterEach(async () => {
    while (cleanups.length > 0) {
      const fn = cleanups.pop();
      if (fn !== undefined) await fn();
    }
  });

  async function createHarnessEnv(
    responder: (request: LlmRequest) => Promise<StreamChunk[]> | StreamChunk[],
    onBash?: (command: string, store: BotStateStore) => Promise<string> | string,
  ) {
    const dataDir = mkdtempSync(join(tmpdir(), "qj-bot-history-sync-"));
    const ctx = new Context();
    cleanups.push(async () => {
      await ctx.fiber.dispose();
      rmSync(dataDir, { recursive: true, force: true });
    });

    const modelRef = { provider: "mock", model: "companion-v1" };
    await ctx.plugin(Credentials);
    await ctx.plugin(LlmService, { maxAttempts: 1 });
    await ctx.plugin(Sessions);
    await ctx.plugin(Ui);
    await ctx.plugin(Tools);
    await ctx.plugin(SystemPrompt);
    await ctx.plugin(AgentLoop);
    await ctx.plugin(Schedule, {
      tasksFile: join(dataDir, "schedules.json"),
      runsFile: join(dataDir, "schedule-runs.jsonl"),
      defaultModel: modelRef,
      tickMs: 60_000,
    });

    const capturedRequests: LlmRequest[] = [];
    ctx.llm.registerAdapter(
      { id: "mock", name: "Mock Companion LLM", api: "mock", baseUrl: "http://mock.local" },
      {
        async *stream(request: LlmRequest): AsyncIterable<StreamChunk> {
          capturedRequests.push(request);
          for (const chunk of await responder(request)) yield chunk;
        },
      },
    );

    const store = new BotStateStore(
      ctx.sessions,
      { dataDir, distroName: "qianji-bot-unit-noop", displayName: "千机", defaultModel: () => modelRef },
      ctx.credentials,
    );

    ctx.tools.register({
      name: "bash",
      description: "Execute shell command",
      parameters: { type: "object", properties: { command: { type: "string" } }, required: ["command"] },
      execute: async (args) => {
        const cmd = String(args.command ?? "");
        return textOutput(onBash ? await onBash(cmd, store) : `ok: ${cmd}`);
      },
    });

    const notifications: Array<{ reason: string; extra?: Record<string, unknown> }> = [];
    const hostBridge = createBotHarnessHost(
      store,
      (reason, extra) => notifications.push({ reason, ...(extra !== undefined ? { extra } : {}) }),
      () => ctx.schedule,
    );
    const harness = new BotCompanionHarness(ctx, hostBridge);
    await store.configureProactive({ modelConfig: { primary: modelRef, patrol: modelRef } });

    return { ctx, store, harness, notifications, capturedRequests };
  }

  it("Flow 1 & Flow 2: syncs live running -> completed, refines titles via reflection, resolves '可以' confirmation, and isolates per-turn traces in mainSessionId", async () => {
    const reflectGate1 = createGate();
    const reflectGate2 = createGate();
    let reflectTurn = 0;
    let inFlightItem: BotActivityEntry | undefined;
    let inFlightTraceSteps: BotActivityTraceStep[] = [];

    const { ctx, store, harness, notifications } = await createHarnessEnv(
      async (request) => {
        if (request.sessionId?.endsWith(":reflect") === true) {
          reflectTurn += 1;
          if (reflectTurn === 1) {
            await reflectGate1.promise;
            return reflectJsonChunks({
              taskTitle: "检查仓库未提交改动与风险",
              taskSummary: "已执行 git status 核查工作区改动并评估单测回归风险。",
            });
          }
          await reflectGate2.promise;
          return reflectJsonChunks({
            taskTitle: "汇总 RTX Spark 续航与算力评测",
            taskSummary: "已抓取独立评测数据并归纳真实续航与算力表现。",
          });
        }

        const userText = lastUserPromptText(request);
        const role = lastMessageRole(request);
        if (userText.includes("未提交改动与测试风险")) {
          return role === "user"
            ? toolCallChunks("tc-turn1-git", "bash", { command: "git status -sb" })
            : textChunks("当前工作区仅有 1 处受控改动，核心单测回归风险较低。\n要不要我帮你汇总 RTX Spark 独立评测的真实续航与算力表现？");
        }
        if (userText === "可以") {
          return role === "user"
            ? toolCallChunks("tc-turn2-curl", "bash", { command: "curl -s https://reviews.example.com/rtx-spark.json" })
            : textChunks("已汇总 RTX Spark 独立评测：FP16 算力稳定释放，离电真实续航约 7 小时 40 分。");
        }
        return textChunks("收到。");
      },
      async (cmd, botStore) => {
        if (cmd === "git status -sb") {
          const liveSnap = await botStore.snapshot();
          const first = liveSnap.activityGroups[0]?.items[0];
          inFlightItem = first ? structuredClone(first) : undefined;
          if (inFlightItem !== undefined) {
            inFlightTraceSteps = (await botStore.getActivityTrace({ activityId: inFlightItem.id })).steps;
          }
          return "## main...origin/main\n M packages/host/src/bot/store.ts";
        }
        return '{"gpu":"RTX Spark","batteryHours":7.67,"tflops":148}';
      },
    );

    const initialSnap = await store.snapshot();
    const mainSession = await ctx.sessions.get(initialSnap.mainSessionId);
    expect(mainSession).toBeDefined();
    if (mainSession === undefined) return;

    // --- Flow 1: Live in-flight sync + Stage-1 heuristic + Stage-2 LLM reflection ---
    harness.prompt(mainSession, [{ type: "text", text: "请帮我检查当前仓库的未提交改动与测试风险" }]);
    await harness.idle(mainSession.id);

    expect(inFlightItem?.status).toBe("running");
    expect(inFlightItem?.turnEndSeq).toBeUndefined();
    expect(inFlightItem?.title).not.toBe("完成主聊天回复");
    expect(inFlightItem?.title).toContain("检查");
    expect(inFlightItem?.description).toContain("git status -sb");
    expect(inFlightTraceSteps.at(-1)?.status).toBe("running");
    expect(notifications.some((n) => n.reason === "turn-started")).toBe(true);
    expect(notifications.some((n) => n.reason === "turn-tool-progress")).toBe(true);

    const settledSnap1 = await store.snapshot();
    const stage1Entry1 = settledSnap1.activityGroups[0]?.items[0];
    expect(stage1Entry1?.id).toBe(inFlightItem?.id);
    expect(stage1Entry1?.status).toBe("completed");
    expect(stage1Entry1?.title).not.toBe("完成主聊天回复");
    expect(stage1Entry1?.title).toContain("检查");

    reflectGate1.release();
    await expect.poll(async () => (await store.snapshot()).activityGroups[0]?.items[0]?.title).toBe("检查仓库未提交改动与风险");
    const reflectedEntry1 = (await store.snapshot()).activityGroups[0]?.items[0];
    expect(reflectedEntry1?.description).toBe("已执行 git status 核查工作区改动并评估单测回归风险。");

    // --- Flow 2: 2-char confirmation "可以" + strict per-turn trace isolation in mainSessionId ---
    const shortReply = "可以";
    expect([...shortReply].length).toBe(2);
    harness.prompt(mainSession, [{ type: "text", text: shortReply }]);
    await harness.idle(mainSession.id);

    const stage1Snap2 = await store.snapshot();
    expect(stage1Snap2.activityGroups[0]?.items).toHaveLength(2);
    const turn2Stage1 = stage1Snap2.activityGroups[0]?.items[0];
    expect(turn2Stage1?.id).not.toBe(reflectedEntry1?.id);
    expect(turn2Stage1?.status).toBe("completed");
    expect(turn2Stage1?.title).not.toBe("可以");
    expect(turn2Stage1?.title).not.toBe("完成主聊天回复");
    expect(turn2Stage1?.title).toContain("RTX Spark");

    reflectGate2.release();
    await expect.poll(async () => (await store.snapshot()).activityGroups[0]?.items[0]?.title).toBe("汇总 RTX Spark 续航与算力评测");
    const turn2Entry = (await store.snapshot()).activityGroups[0]?.items[0];

    const turn2Trace = await store.getActivityTrace({ activityId: turn2Entry?.id });
    const turn2Tools = turn2Trace.steps.filter((s) => s.kind === "tool");
    expect(turn2Tools).toHaveLength(1);
    expect(turn2Tools[0]?.toolName).toBe("bash");
    expect(turn2Tools[0]?.commandOrInput).toBe("curl -s https://reviews.example.com/rtx-spark.json");
    expect(JSON.stringify(turn2Trace.steps)).not.toContain("git status -sb");

    const turn1Trace = await store.getActivityTrace({ activityId: reflectedEntry1?.id });
    const turn1Tools = turn1Trace.steps.filter((s) => s.kind === "tool");
    expect(turn1Tools).toHaveLength(1);
    expect(turn1Tools[0]?.commandOrInput).toBe("git status -sb");
    expect(JSON.stringify(turn1Trace.steps)).not.toContain("rtx-spark.json");
  });

  it("Flow 3: auto-refines untitled side-chat title semantically, then protects manual userRenamed title", async () => {
    let reflectCalls = 0;
    const { ctx, store, harness, notifications } = await createHarnessEnv((request) => {
      if (request.sessionId?.endsWith(":reflect") === true) {
        reflectCalls += 1;
        return reflectJsonChunks(
          reflectCalls === 1
            ? {
                taskTitle: "测算本地与云端推理成本",
                taskSummary: "对比了显卡折旧电费与 API 调用的月度成本平衡点。",
                sideChatTitle: "本地与云端推理成本对比",
              }
            : {
                taskTitle: "评估双倍并发推理开销",
                taskSummary: "并发翻倍后本地自建推理固定成本优势更显著。",
                sideChatTitle: "双倍并发推理开销评估",
              },
        );
      }
      return textChunks("已整理详细的本地硬件折旧与 API Token 成本测算表。");
    });

    const side = await store.createSideChat("新旁聊 · 20:00");
    expect(side.title).toBe("新旁聊 · 20:00");
    expect(side.userRenamed).toBeUndefined();

    const sideSession = await ctx.sessions.get(side.sessionId);
    expect(sideSession).toBeDefined();
    if (sideSession === undefined) return;

    harness.prompt(sideSession, [{ type: "text", text: "请帮我测算本地部署模型与云端 API 的月度成本差异" }]);
    await harness.idle(sideSession.id);

    await expect.poll(async () => (await store.snapshot()).sideThreads.find((t) => t.id === side.id)?.title).toBe(
      "本地与云端推理成本对比",
    );

    const renamed = await store.updateSideChat({ id: side.id, title: "我的专属命名" });
    expect(renamed?.title).toBe("我的专属命名");
    expect(renamed?.userRenamed).toBe(true);

    const prevReflectNotifs = notifications.filter((n) => n.reason === "reflection-updated").length;
    harness.prompt(sideSession, [{ type: "text", text: "如果团队日均并发翻倍，成本曲线怎么变化？" }]);
    await harness.idle(sideSession.id);

    await expect.poll(() => notifications.filter((n) => n.reason === "reflection-updated").length).toBeGreaterThan(
      prevReflectNotifs,
    );

    const afterSecondTurn = (await store.snapshot()).sideThreads.find((t) => t.id === side.id);
    expect(afterSecondTurn?.title).toBe("我的专属命名");
    expect(afterSecondTurn?.userRenamed).toBe(true);
  });

  it("Flow 4: creates and toggles Bot scheduled tasks conversationally via bot_manage_schedule with full trace", async () => {
    const { ctx, store, harness, capturedRequests } = await createHarnessEnv((request) => {
      if (request.sessionId?.endsWith(":reflect") === true) {
        return reflectJsonChunks({ taskTitle: null, taskSummary: "已完成预定任务创建与状态变更。" });
      }
      const userText = lastUserPromptText(request);
      const role = lastMessageRole(request);
      if (userText.includes("9:30")) {
        return role === "user"
          ? toolCallChunks("tc-sched-create", "bot_manage_schedule", {
              action: "create",
              name: "晨间邮件与 PR 简报",
              prompt: "汇总最新未读邮件与 GitHub PR 动态并输出晨间简报",
              frequency: "daily",
              hour: 9,
              minute: 30,
            })
          : textChunks("已为你安排每天早上 09:30 的「晨间邮件与 PR 简报」预定任务。");
      }
      if (userText.includes("暂停")) {
        return role === "user"
          ? toolCallChunks("tc-sched-toggle", "bot_manage_schedule", {
              action: "toggle",
              name: "晨间邮件与 PR 简报",
              enabled: false,
            })
          : textChunks("已将「晨间邮件与 PR 简报」暂停，需要恢复时随时告诉我。");
      }
      return textChunks("好的。");
    });

    const snap0 = await store.snapshot();
    const mainSession = await ctx.sessions.get(snap0.mainSessionId);
    expect(mainSession).toBeDefined();
    if (mainSession === undefined) return;

    harness.prompt(mainSession, [{ type: "text", text: "每天早上 9:30 帮我汇总未读邮件与 PR" }]);
    await harness.idle(mainSession.id);

    const tasksAfterCreate = ctx.schedule.list();
    expect(tasksAfterCreate).toHaveLength(1);
    const createdTask = tasksAfterCreate[0];
    expect(createdTask).toMatchObject({
      name: "晨间邮件与 PR 简报",
      scope: "bot",
      cwd: store.botWorkspaceDir,
      frequency: "daily",
      hour: 9,
      minute: 30,
      enabled: true,
    });
    expect(typeof createdTask?.nextRunAt).toBe("number");

    const createAct = (await store.snapshot()).activityGroups[0]?.items[0];
    expect(createAct?.kind).toBe("scheduled");
    expect(createAct?.title).toContain("晨间邮件与 PR 简报");
    const createTrace = await store.getActivityTrace({ activityId: createAct?.id });
    const createSchedStep = createTrace.steps.find((s) => s.kind === "tool" && s.toolName === "bot_manage_schedule");
    expect(createSchedStep?.status).toBe("completed");
    expect(createSchedStep?.output).toContain("晨间邮件与 PR 简报");

    harness.prompt(mainSession, [{ type: "text", text: "先把晨间邮件与 PR 简报暂停一下" }]);
    await harness.idle(mainSession.id);

    const togglePromptReq = capturedRequests.find(
      (r) => r.sessionId === mainSession.id && lastUserPromptText(r).includes("暂停"),
    );
    expect(togglePromptReq?.system).toContain("<scheduled_routines>");
    expect(togglePromptReq?.system).toContain("晨间邮件与 PR 简报：每天 09:30（已定时）");

    const tasksAfterToggle = ctx.schedule.list();
    expect(tasksAfterToggle).toHaveLength(1);
    expect(tasksAfterToggle[0]?.id).toBe(createdTask?.id);
    expect(tasksAfterToggle[0]?.enabled).toBe(false);
    expect(tasksAfterToggle[0]?.nextRunAt).toBeUndefined();

    const toggleAct = (await store.snapshot()).activityGroups[0]?.items[0];
    expect(toggleAct?.id).not.toBe(createAct?.id);
    const toggleTrace = await store.getActivityTrace({ activityId: toggleAct?.id });
    const toggleTools = toggleTrace.steps.filter((s) => s.kind === "tool");
    expect(toggleTools).toHaveLength(1);
    expect(toggleTools[0]?.toolName).toBe("bot_manage_schedule");
    expect(toggleTools[0]?.output).toContain("Paused Bot scheduled task");
  });
});

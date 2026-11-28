/**
 * End-to-end V2 backend & harness tests for Qianji Bot Discovery (`动态` Feed Editions & Widgets,
 * `点子` Blueprint Packages & One-Click Provisioning, `目标` Commitment State Machine & Quick Options).
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Context, Service } from "@deepseek-ai/cordis";
import { afterEach, describe, expect, it } from "vitest";
import { AgentLoop } from "@qianji/agent-loop";
import { Credentials, LlmService, type LlmRequest, type StreamChunk } from "@qianji/llm";
import type {
  BotFeedItem, BotGoalItem, BotGoalViewPrefs, BotIdeaItem, BotIdeasLaunchResult, BotSnapshotResult,
} from "@qianji/protocol";
import type { RpcHandler, RpcService } from "@qianji/rpc";
import { Schedule } from "@qianji/schedule";
import { Sessions } from "@qianji/session";
import { SystemPrompt } from "@qianji/system-prompt";
import { Tools } from "@qianji/tools";
import { Ui } from "@qianji/ui";
import { BotCompanionHarness, BotStateStore, DEFAULT_FEED_INSTRUCTIONS, ProactivePulseEngine } from "../packages/host/src/bot/index";
import { registerBotRpcMethods } from "../packages/host/src/bot/bot-rpc";
import { formatRelativeFeedTime } from "../packages/host/src/bot/store-discovery";
import { createBotHarnessHost } from "../packages/host/src/bot/harness/bot-tools-host";

class MockRpc extends Service implements RpcService {
  static provide = "rpc";
  private readonly handlers = new Map<string, RpcHandler>();
  readonly broadcasts: Array<{ method: string; params: unknown }> = [];
  constructor(ctx: Context) { super(ctx, "rpc"); }
  method(name: string, handler: RpcHandler): () => void {
    this.handlers.set(name, handler);
    return () => { if (this.handlers.get(name) === handler) this.handlers.delete(name); };
  }
  methods(): string[] { return [...this.handlers.keys()]; }
  broadcast(method: string, params?: unknown): void { this.broadcasts.push({ method, params }); }
  async invoke<T>(name: string, params: unknown = {}): Promise<T> {
    const fn = this.handlers.get(name);
    if (!fn) throw new Error(`RPC method not registered: ${name}`);
    return (await fn(params, { signal: new AbortController().signal, notify: () => undefined })) as T;
  }
}

function textChunks(text: string): StreamChunk[] {
  return [{ type: "text-delta", index: 0, text }, { type: "usage", usage: { inputTokens: 12, outputTokens: 20 } }, { type: "finish", reason: "stop" }];
}

function createMockFetch(): typeof fetch {
  return (async (input: string | URL | Request) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    if (url.includes("hn.algolia.com/api/v1/search_by_date")) {
      return new Response(JSON.stringify({
        hits: [
          { objectID: "901", title: "Qwen3-27B self-distills weights for +6.6 local coding gain", url: "https://blog.example.dev/qwen3-local", points: 342, num_comments: 94 },
          { objectID: "902", title: "vLLM FP8 KV-cache cuts workstation memory 42%", url: "https://blog.example.dev/vllm-fp8", points: 215, num_comments: 51 },
        ],
      }), { status: 200, headers: { "Content-Type": "application/json" } });
    }
    if (url.includes("api.github.com/search/repositories")) {
      return new Response(JSON.stringify({
        items: [{ full_name: "ggerganov/llama.cpp", html_url: "https://github.com/ggerganov/llama.cpp", description: "LLM inference in C/C++ with Apple & CUDA kernels", stargazers_count: 78500, language: "C++" }],
      }), { status: 200, headers: { "Content-Type": "application/json" } });
    }
    if (url === "https://blog.example.dev/qwen3-local") {
      return new Response(
        '<!doctype html><html><head><meta property="og:image" content="https://cdn.example.dev/covers/qwen3-bench.png"></head><body>Report</body></html>',
        { status: 200, headers: { "Content-Type": "text/html" } },
      );
    }
    return new Response("<html><head></head></html>", { status: 200, headers: { "Content-Type": "text/html" } });
  }) as typeof fetch;
}

describe("Bot V2 Discovery Backend, Edition Engine, Idea Blueprints & Companion Harness", () => {
  const cleanups: Array<() => Promise<void> | void> = [];
  afterEach(async () => {
    while (cleanups.length > 0) {
      const fn = cleanups.pop();
      if (fn !== undefined) await fn();
    }
  });

  async function setupEnv(options?: {
    responder?: (req: LlmRequest) => Promise<StreamChunk[]> | StreamChunk[];
    enableMockLlm?: boolean;
    fetchFn?: typeof fetch;
  }) {
    const dataDir = mkdtempSync(join(tmpdir(), "qj-bot-discovery-v2-"));
    const ctx = new Context();
    cleanups.push(async () => {
      await ctx.fiber.dispose();
      rmSync(dataDir, { recursive: true, force: true });
    });

    const modelRef = { provider: "mock", model: "companion-v1" };
    await ctx.plugin(Credentials); await ctx.plugin(LlmService, { maxAttempts: 1 });
    await ctx.plugin(Sessions); await ctx.plugin(Ui); await ctx.plugin(Tools);
    await ctx.plugin(SystemPrompt); await ctx.plugin(MockRpc); await ctx.plugin(AgentLoop);
    await ctx.plugin(Schedule, { tasksFile: join(dataDir, "schedules.json"), runsFile: join(dataDir, "schedule-runs.jsonl"), defaultModel: modelRef, tickMs: 60_000 });

    const capturedRequests: LlmRequest[] = [];
    if (options?.enableMockLlm !== false) {
      ctx.llm.registerAdapter({ id: "mock", name: "Mock Discovery LLM", api: "mock", baseUrl: "http://mock.local" }, {
        async *stream(req: LlmRequest): AsyncIterable<StreamChunk> {
          capturedRequests.push(req);
          for (const c of options?.responder ? await options.responder(req) : textChunks("收到。")) yield c;
        },
      });
    }

    const rpc = ctx.get("rpc") as unknown as MockRpc;
    const store = new BotStateStore(ctx.sessions, { dataDir, distroName: "qianji-bot-unit-noop", displayName: "千机", defaultModel: () => modelRef, processProbe: async () => [] }, ctx.credentials);
    const hostBridge = createBotHarnessHost(store, (reason, extra) => rpc.broadcast("bot/updated", { reason, ...extra }), () => ctx.schedule);
    const harness = new BotCompanionHarness(ctx, hostBridge);

    let customDelta: Awaited<ReturnType<BotStateStore["collectConnectorDelta"]>> | undefined;
    const pulse = new ProactivePulseEngine({
      ctx,
      get botWorkspaceDir() { return store.botWorkspaceDir; },
      ensureLoaded: () => store.ensureLoaded(),
      persist: () => store.persist(),
      readMemory: () => store.readMemory(),
      fetchFn: options?.fetchFn ?? createMockFetch(),
      collectDelta: async (nowMs) => customDelta ?? store.collectConnectorDelta(nowMs),
      stageOutboundDraft: async (input) => (await hostBridge.stageOutboundApproval(input)).id,
    });
    registerBotRpcMethods(ctx, store, pulse);
    if (options?.enableMockLlm !== false) {
      await store.configureProactive({ modelConfig: { primary: modelRef, patrol: modelRef } });
    }

    return {
      dataDir, ctx, rpc, store, harness, pulse, capturedRequests,
      setCustomDelta: (d: Awaited<ReturnType<BotStateStore["collectConnectorDelta"]>>) => { customDelta = d; },
    };
  }

  it("equips starter & AI ideas with V2 Blueprints, provisions Space + Schedule + Doc via bot.ideas.launch, and undoes dismissal via bot.ideas.restore", async () => {
    const { dataDir, ctx, rpc } = await setupEnv({ enableMockLlm: false });
    const snap0 = await rpc.invoke<BotSnapshotResult>("bot.getSnapshot", {});
    expect(snap0.feedInstructions).toBe(DEFAULT_FEED_INSTRUCTIONS);
    expect(snap0.goalViewPrefs).toEqual({ showSubtitles: true, autoSort: false });

    const allStarters = snap0.ideaSections.flatMap((s) => s.items);
    expect(allStarters).toHaveLength(7);
    for (const item of allStarters) {
      expect(item.sourceLabel).toBeTruthy();
      expect((item.capabilities ?? []).length).toBeGreaterThanOrEqual(1);
      expect(item.howItWorks).toBeTruthy();
      expect(item.buildStatus).toBe("not_started");
    }
    expect(snap0.ideaSections[0]?.items.every((it) => it.isFeatured === true)).toBe(true);

    // Dismiss & Undo via bot.ideas.restore
    await rpc.invoke("bot.ideas.feedback", { id: "idea-health-check", sentiment: "not_interested" });
    expect((await rpc.invoke<BotSnapshotResult>("bot.getSnapshot", {})).ideaSections.flatMap((s) => s.items.map((i) => i.id))).not.toContain("idea-health-check");

    const restored = await rpc.invoke<{ ok: true; snapshot: BotSnapshotResult }>("bot.ideas.restore", { id: "idea-health-check" });
    expect(restored.ok).toBe(true);
    expect(restored.snapshot.ideaSections.flatMap((s) => s.items.map((i) => i.id))).toContain("idea-health-check");

    // Re-dismiss one item & generate similar AI Blueprints
    await rpc.invoke("bot.ideas.feedback", { id: "idea-cost-plan", sentiment: "not_interested" });
    const moreRes = await rpc.invoke<{ ok: true; generated: BotIdeaItem[]; snapshot: BotSnapshotResult }>(
      "bot.ideas.feedback",
      { id: "idea-pre-pr", sentiment: "more_like_this" },
    );
    expect(moreRes.generated.length).toBeGreaterThanOrEqual(1);
    expect((moreRes.generated[0]?.capabilities ?? []).length).toBeGreaterThanOrEqual(1);
    expect(moreRes.generated[0]?.howItWorks).toBeTruthy();
    const aiIdeaId = moreRes.generated[0]?.id ?? "";

    // Launch bundle idea ("idea-overnight-research") -> provisions real Space + ScheduledTask (scope="bot")
    const launchBundle = await rpc.invoke<BotIdeasLaunchResult>("bot.ideas.launch", { id: "idea-overnight-research" });
    expect(launchBundle.ok).toBe(true);
    expect(launchBundle.idea?.buildStatus).toBe("installed");
    expect(launchBundle.createdSpaceId).toMatch(/^space-/);
    expect(launchBundle.createdScheduleId).toBeTruthy();
    expect(launchBundle.launchPrompt).toContain("晨间调研汇报");
    expect(launchBundle.snapshot.spaces.some((s) => s.id === launchBundle.createdSpaceId && s.title === "晨间调研汇报")).toBe(true);
    const botSchedules = ctx.schedule.list();
    expect(botSchedules.some((t) => t.id === launchBundle.createdScheduleId && t.scope === "bot" && t.name === "晨间调研早报汇总")).toBe(true);

    // Launch doc idea ("idea-pre-pr") -> writes Markdown report into 资源库
    const launchDoc = await rpc.invoke<BotIdeasLaunchResult>("bot.ideas.launch", { id: "idea-pre-pr" });
    expect(launchDoc.createdDocId).toBe("doc:docs/pre-pr-gate-summary.md");
    expect(launchDoc.snapshot.documents.some((d) => d.id === "doc:docs/pre-pr-gate-summary.md")).toBe(true);

    // Verify persistence of AI ideas, dismissedIdeaIds, installed status & legacy goals across reload
    const statePath = join(dataDir, "bot", "state.json");
    const rawPersisted = JSON.parse(readFileSync(statePath, "utf8")) as Record<string, unknown>;
    rawPersisted.goals = [
      { id: "goal-legacy-1", title: "完成季度架构演进", category: "职业", summary: "已梳理核心接口", status: "active", updatedAt: 1_700_000_000_000 },
    ];
    writeFileSync(statePath, JSON.stringify(rawPersisted, null, 2), "utf8");

    const reloadedStore = new BotStateStore(ctx.sessions, { dataDir, distroName: "qianji-bot-unit-noop" }, ctx.credentials);
    const reloadedSnap = await reloadedStore.snapshot();
    const reloadedItems = reloadedSnap.ideaSections.flatMap((s) => s.items);
    expect(reloadedItems.map((i) => i.id)).not.toContain("idea-cost-plan");
    expect(reloadedItems.map((i) => i.id)).toContain(aiIdeaId);
    expect(reloadedItems.find((i) => i.id === "idea-overnight-research")?.buildStatus).toBe("installed");
    expect(reloadedSnap.goals.find((g) => g.id === "goal-legacy-1")?.timeline?.[0]?.title).toBe("添加目标：完成季度架构演进");
  });

  it("curates V2 Feed Editions with og:image, script-free --hatch-widget-* HTML widgets, inline Markdown links, zero robotic normal logs, and [[options]]", async () => {
    const mockFetch = createMockFetch();
    const { ctx, rpc, store, pulse, setCustomDelta } = await setupEnv({
      fetchFn: mockFetch,
      responder: (req) => {
        if (req.sessionId === "bot-feed-edition") {
          return textChunks(JSON.stringify({
            units: [
              {
                title: "27B Qwen3 自蒸馏实测本地代码得分涨 6.6 分", kicker: "本地实测", category: "模型与推理",
                body: "[27B 的 Qwen3](https://blog.example.dev/qwen3-local) 通过权重自蒸馏，在未见过的代码基准上提升了 6.6 分（社区 342 热度）。相比盲目上更大参数，这条路线在不增加显存占用的前提下稳步拉高通过率。",
                reason: "我注意到你一直在评估本地模型推理性价比，这篇实测正好给你选下一个主力模型做对照。",
                sourceUrl: "https://blog.example.dev/qwen3-local", sourceLabel: "实测报告",
              },
              {
                title: "工作站本地推理三大方案显存与吞吐对比", kicker: "横向对比", category: "模型与推理",
                body: "[vLLM FP8 KV-cache](https://blog.example.dev/vllm-fp8) 将长上下文显存占用压降 42%，与 [llama.cpp](https://github.com/ggerganov/llama.cpp) 形成互补。下方小组件汇总了两种部署栈的核心指标差异。",
                reason: "结合你对单机高并发与低显存占用的关注，我把两套主流推理栈放在一起做了直观对比。",
                sourceUrl: "https://blog.example.dev/vllm-fp8", widgetTitle: "本地推理引擎 · 关键指标对比",
                widgetHtml: '<script>alert(1)</script><div style="color:var(--hatch-widget-text);background:var(--hatch-widget-surface);border:1px solid var(--hatch-widget-border)"><span style="color:var(--hatch-widget-accent)">vLLM FP8 -42% 显存</span><small style="color:var(--hatch-widget-muted);background:var(--hatch-widget-surface-muted)">吞吐领先</small></div>',
              },
            ],
          }));
        }
        return textChunks("简洁巡检结论：收到 1 封关键确认邮件并存在 1 处日程冲突，草稿已就绪。");
      },
    });

    const now = Date.now();
    expect(formatRelativeFeedTime(now - 10_000, now)).toBe("刚刚");
    expect(formatRelativeFeedTime(now - 18 * 60_000, now)).toBe("18分钟前");

    await store.createGoal({
      title: "核对云算力月度账单异常", category: "金融",
      summary: "已备好账单明细比对清单，等待确认后核查差额",
      source: "assistant_tracking", momentumStatus: "waiting_user",
    });

    const editionItems = await store.generateFeedEdition({ editionKind: "morning", force: true, ctx, fetchFn: mockFetch });
    expect(editionItems.length).toBeGreaterThanOrEqual(3);

    const heroCard = editionItems.find((it) => it.attachment?.kind === "hero_image");
    expect(heroCard?.origin).toBe("generated");
    expect(heroCard?.actionKind).toBe("discuss");
    expect(heroCard?.actionLabel).toBe("讨论");
    expect(heroCard?.editionKind).toBe("morning");
    expect(heroCard?.kicker).toBe("本地实测");
    expect(heroCard?.body).toMatch(/\[27B 的 Qwen3\]\(https:\/\/blog\.example\.dev\/qwen3-local\)/);
    expect(heroCard?.reason).toContain("我注意到你");
    if (heroCard?.attachment?.kind === "hero_image") {
      expect(heroCard.attachment.heroImageUrl).toBe("https://cdn.example.dev/covers/qwen3-bench.png");
      expect(heroCard.attachment.aspectRatio).toBe(1.78);
    }

    const widgetCard = editionItems.find((it) => it.attachment?.kind === "widget");
    expect(widgetCard).toBeDefined();
    if (widgetCard?.attachment?.kind === "widget") {
      expect(widgetCard.attachment.widgetHtml).not.toContain("<script");
      expect(widgetCard.attachment.widgetHtml).toContain("--hatch-widget-text");
      expect(widgetCard.attachment.widgetHtml).toContain("--hatch-widget-accent");
    }

    const ideaFeedCard = editionItems.find((it) => it.origin === "idea");
    expect(ideaFeedCard?.actionKind).toBe("start");
    expect(ideaFeedCard?.actionLabel).toBe("立即开始");
    expect(ideaFeedCard?.ideaId).toBeTruthy();

    // Verify RPC bot.feed.generateEdition & empty-state forced patrol NEVER emits robotic "状态 normal"
    await store.ensureLoaded().then((st) => { st.feed = []; });
    const rpcEditionRes = await rpc.invoke<{ added: number; items: BotFeedItem[]; snapshot: BotSnapshotResult }>(
      "bot.feed.generateEdition",
      { editionKind: "evening", force: true },
    );
    expect(rpcEditionRes.added).toBeGreaterThanOrEqual(2);
    expect(rpcEditionRes.items.every((i) => i.editionKind === "evening")).toBe(true);

    await store.ensureLoaded().then((st) => { st.feed = []; });
    const emptyForcePatrol = await pulse.runPatrol({ force: true });
    expect(emptyForcePatrol.triggered).toBe(true);
    expect(emptyForcePatrol.summary).not.toContain("normal");
    expect(emptyForcePatrol.summary).not.toContain("今日日程 0 项");
    const snapAfterForce = await rpc.invoke<BotSnapshotResult>("bot.getSnapshot", {});
    expect(snapAfterForce.feed.length).toBeGreaterThanOrEqual(2);
    expect(JSON.stringify(snapAfterForce.feed)).not.toContain("当前工作状态为");

    // Verify actionable patrol emits [[options: ...]] on mainSession assistant bubble + Feed like/delete
    setCustomDelta({
      newEmails: [{ uid: "88", sender: "lin@acme.dev", replyTo: "lin@acme.dev", subject: "v2.4 发布窗口确认", dateHeader: new Date().toUTCString(), preview: "请确认灰度批次", fullBody: "请今天下午前确认灰度批次。", receivedAt: now }],
      upcomingMeetings: [],
      conflicts: [{ first: "架构评审", second: "客户周会", overlapLabel: "15:00-15:30" }],
      freeBlocks: [{ startLabel: "16:00", endLabel: "17:00", minutes: 60 }],
      completedProcesses: [], newMeetingNotes: [], newTelegramMsgs: [], newGitHubItems: [], newNotionPages: [],
      lateNightReminderNeeded: false,
      awareness: {
        busyState: "normal", runningWatched: [], conflictCount: 1,
        todayEvents: [{ id: "e1", title: "架构评审", startAt: now, endAt: now + 1800_000, timeRangeLabel: "15:00-15:30" }],
      },
    });
    const saveInstRes = await rpc.invoke<{ instructions: string; snapshot: BotSnapshotResult }>(
      "bot.feed.saveInstructions",
      { instructions: "只输出高信噪比工程进展与日程风险。", refreshNow: true },
    );
    expect(saveInstRes.snapshot.feed[0]?.actionKind).toBe("start");
    const mainSess = await ctx.sessions.get(saveInstRes.snapshot.mainSessionId);
    const lastBubbleText = mainSess?.state().messages.at(-1)?.content.flatMap((b) => (b.type === "text" ? [b.text] : [])).join("\n") ?? "";
    expect(lastBubbleText).toMatch(/\[\[options:\s*好，帮我核对并发出\s*\|\s*稍后再看\]\]/);

    const liked = await rpc.invoke<{ item: BotFeedItem | null }>("bot.feed.toggleLike", { id: saveInstRes.snapshot.feed[0]?.id ?? "" });
    expect(liked.item?.liked).toBe(true);
    await rpc.invoke("bot.feed.delete", { id: saveInstRes.snapshot.feed[0]?.id ?? "" });
  });

  it("handles V2 Goals (chat_interview, momentumStatus, sub-goals, timeline) and V2 native Discovery tools", async () => {
    const { ctx, rpc, store, harness, capturedRequests } = await setupEnv({
      responder: (req) => {
        if (req.sessionId === "bot-ideas-synth") {
          return textChunks(JSON.stringify({
            ideas: [{
              icon: "🎯", title: "我可以为你核对 Rust 网关压测基线并生成火焰图摘要",
              description: "结合你正在推进的低延迟网关目标，自动汇总 P99 指标。",
              seedPrompt: "帮我汇总 Rust 网关 P99 压测基线与优化点。", reason: "结合追踪目标生成",
            }],
          }));
        }
        if (req.sessionId?.endsWith(":reflect") === true) {
          return textChunks(JSON.stringify({
            taskTitle: "立项网关延迟目标并发布对比简报", taskSummary: "已完成目标更新、简报发布与方案包提议。",
            sideChatTitle: null, preferences: [], goals: [], goalUpdates: [], ideas: [], space: null,
          }));
        }
        if (req.messages.at(-1)?.role === "user") {
          return [
            { type: "tool-call-start", index: 0, id: "tc-1", name: "bot_manage_goal" },
            { type: "tool-call-delta", index: 0, argumentsDelta: JSON.stringify({ action: "toggle_subgoal", title: "攻克网关 P99 延迟", subGoalTitle: "采集基准火焰图", summary: "火焰图已就绪，等待确认分片锁改造窗口", momentumStatus: "waiting_user", timelineTitle: "定位锁竞争热点" }) },
            { type: "tool-call-start", index: 1, id: "tc-2", name: "bot_propose_idea" },
            { type: "tool-call-delta", index: 1, argumentsDelta: JSON.stringify({ title: "给你一份无锁队列替换前后的吞吐对比脚本", description: "在隔离工作区一键跑完并发基准对比。", seedPrompt: "帮我运行无锁队列吞吐对比基准。", sourceLabel: "并发基准方案", howItWorks: "先在隔离环境跑基线，再对比分片锁吞吐并输出报告。", capabilities: [{ kind: "workbench", title: "并发压测草案", subtitle: "隔离环境执行基准对比", ready: true }] }) },
            { type: "tool-call-start", index: 2, id: "tc-3", name: "bot_publish_briefing" },
            { type: "tool-call-delta", index: 2, argumentsDelta: JSON.stringify({ title: "网关锁竞争排查简报", kicker: "压测结论", category: "性能优化", body: "[分片锁改造方案](https://example.dev/sharded-lock) 预计降低 38% 尾延迟。", actionKind: "discuss", attachment: { kind: "widget", widgetTitle: "锁方案对比", widgetHtml: '<div style="color:var(--hatch-widget-text)">-38% P99</div>' } }) },
            { type: "usage", usage: { inputTokens: 20, outputTokens: 30 } },
            { type: "finish", reason: "tool-use" },
          ];
        }
        return textChunks("已为你更新目标并同步压测对比。\n\n[[options: 立即推进分片锁改造 | 先看详细火焰图]]");
      },
    });

    const createdGoalRes = await rpc.invoke<{ goal: BotGoalItem }>("bot.goals.create", {
      title: "攻克网关 P99 延迟", category: "职业", summary: "目标将尾延迟压到 15ms 以内",
      description: "聚焦连接池与序列化锁竞争优化", source: "chat_interview", momentumStatus: "on_track",
      subGoals: ["采集基准火焰图"],
    });
    const goalId = createdGoalRes.goal.id;
    expect(createdGoalRes.goal.source).toBe("chat_interview");
    expect(createdGoalRes.goal.timeline?.[0]?.title).toBe("对话共创目标：攻克网关 P99 延迟");

    await rpc.invoke<{ goalViewPrefs: BotGoalViewPrefs }>("bot.goals.savePrefs", { showSubtitles: false, autoSort: true });
    const refreshRes = await rpc.invoke<{ added: number; snapshot: BotSnapshotResult }>("bot.ideas.refresh", {});
    expect(refreshRes.added).toBe(1);
    expect((refreshRes.snapshot.ideaSections[0]?.items[0]?.capabilities ?? []).length).toBeGreaterThanOrEqual(1);

    const mainSess = await ctx.sessions.get(refreshRes.snapshot.mainSessionId);
    expect(mainSess).toBeDefined();
    if (mainSess === undefined) return;

    harness.prompt(mainSess, [{ type: "text", text: "火焰图跑出来了，帮我更新网关目标进度并同步简报" }]);
    await harness.idle(mainSess.id);

    const turnPromptReq = capturedRequests.find((r) => r.sessionId === mainSess.id);
    expect(turnPromptReq?.system).toContain("Goal Co-Refinement Interview");
    expect(turnPromptReq?.system).toContain("[[options:");

    const afterTurnSnap = await store.snapshot();
    const updatedGoal = afterTurnSnap.goals.find((g) => g.id === goalId);
    expect(updatedGoal?.momentumStatus).toBe("waiting_user");
    expect(updatedGoal?.subGoals?.[0]?.done).toBe(true);
    const proposed = afterTurnSnap.ideaSections[0]?.items.find((i) => i.title.includes("无锁队列替换前后"));
    expect(proposed?.capabilities?.[0]?.kind).toBe("workbench");
    expect(proposed?.howItWorks).toContain("隔离环境");
    const published = afterTurnSnap.feed.find((f) => f.title === "网关锁竞争排查简报");
    expect(published?.kicker).toBe("压测结论");
    expect(published?.attachment?.kind).toBe("widget");

    const doneGoal = await rpc.invoke<{ goal: BotGoalItem | null }>("bot.goals.update", { id: goalId, status: "completed" });
    expect(doneGoal.goal?.status).toBe("completed");
    const reopenedGoal = await rpc.invoke<{ goal: BotGoalItem | null }>("bot.goals.update", { id: goalId, status: "active" });
    expect(reopenedGoal.goal?.status).toBe("active");
  });

  it("extracts assistant_tracking Goals (separating live blocker summary vs description) and Idea Blueprints during post-turn reflection", async () => {
    const { ctx, store, harness } = await setupEnv({
      responder: (req) => {
        if (req.sessionId?.endsWith(":reflect") === true) {
          return textChunks(JSON.stringify({
            taskTitle: "准备账单异常核对清单",
            taskSummary: "已整理 11 月异常扣款发票核对步骤，等待确认登录核查。",
            sideChatTitle: null,
            preferences: [],
            goals: [{
              title: "核查 SaaS 订阅异常扣款发票",
              category: "金融",
              summary: "已备好核对步骤，等待确认后继续执行",
              description: "11 月账单出现超额席位扣费，需核对席位变更记录与退款资格。",
              momentumStatus: "waiting_user",
            }],
            goalUpdates: [{
              title: "Q4 推理算力成本降低 30%",
              summary: "FP8 动态批处理上线，整体推理成本下降 34%",
              momentumStatus: "on_track",
              timelineTitle: "压测确认降本 34% 达标",
              completed: true,
            }],
            ideas: [{
              icon: "🧾",
              title: "我可以为你生成 SaaS 订阅席位与月度账单核对报告",
              description: "逐项比对近三个月账单金额与活跃席位，标出可申请退费的异常项。",
              seedPrompt: "帮我生成近三个月 SaaS 订阅席位与异常账单核对报告。",
              sourceLabel: "账单核查方案",
              howItWorks: "先读取账单通知邮件提取金额明细，再对比标准席位单价输出核对文档，最后等你确认是否提交申诉。",
              capabilities: [{ kind: "doc", title: "账单核对报告", subtitle: "近三个月扣款差异与申诉要点清单。", ready: true }],
            }],
            space: null,
          }));
        }
        return textChunks("我已经帮你把核对清单准备好了，等你方便时点一下就能继续往下查。\n\n[[options: 现在开始核对 | 晚上再提醒我]]");
      },
    });

    const existingGoal = await store.createGoal({ title: "Q4 推理算力成本降低 30%", category: "金融", summary: "正在评估 FP8 量化收益" });
    const mainSess = await ctx.sessions.get((await store.snapshot()).mainSessionId);
    expect(mainSess).toBeDefined();
    if (mainSess === undefined) return;

    harness.prompt(mainSess, [{ type: "text", text: "FP8 降本目标搞定了！另外上个月 SaaS 账单好像多扣了席位费，回头帮我盯着核对下发票" }]);
    await harness.idle(mainSess.id);

    await expect.poll(async () => (await store.snapshot()).goals.find((g) => g.id === existingGoal.id)?.status).toBe("completed");

    const snap = await store.snapshot();
    const trackedGoal = snap.goals.find((g) => g.title === "核查 SaaS 订阅异常扣款发票");
    expect(trackedGoal?.source).toBe("assistant_tracking");
    expect(trackedGoal?.momentumStatus).toBe("waiting_user");
    expect(trackedGoal?.sessionId).toBe(mainSess.id);
    expect(trackedGoal?.summary).toBe("已备好核对步骤，等待确认后继续执行");
    expect(trackedGoal?.description).toContain("11 月账单出现超额席位扣费");
    expect(trackedGoal?.timeline?.[0]?.title).toBe("自动立项追踪：核查 SaaS 订阅异常扣款发票");

    const blueprintIdea = snap.ideaSections[0]?.items.find((i) => i.title.includes("SaaS 订阅席位与月度账单"));
    expect(blueprintIdea?.sourceLabel).toBe("账单核查方案");
    expect(blueprintIdea?.capabilities?.[0]?.title).toBe("账单核对报告");
    expect(blueprintIdea?.howItWorks).toContain("先读取账单通知邮件");
    expect(blueprintIdea?.buildStatus).toBe("not_started");
  });
});

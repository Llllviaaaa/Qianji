import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { createElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { PersistedEvent } from "@qianji/protocol";
import { Composer } from "../src/components/Composer";
import { Message } from "../src/components/Message";
import { toolRowCopy } from "../src/components/ToolCall";
import { UserMessageRow } from "../src/components/message/UserMessageRow";
import { clientContributions } from "../src/lib/clientContributions";
import { HarnessRuntimes, harnessRuntimes, promptContent } from "../src/lib/harnessRuntime";
import { forkPointsOf } from "../src/lib/hostSessions";
import { classifyToolKind, presentToolCall } from "../src/lib/toolPresentation";
import {
  TranscriptTranslator,
  appendNotice,
  continuationNoticeOf,
  goalCompleteNoticeOf,
  goalRoundNoticeOf,
  historyToUi,
} from "../src/lib/transcript";
import { groupTranscriptMessages } from "../src/lib/transcriptTurns";
import { useAppStore } from "../src/store";
import type { UiMessage, UiToolCall } from "../src/types";

const REPO_ROOT = resolve(import.meta.dirname, "..");

function syncStoreInitial<T extends object>(store: { getState: () => T; getInitialState: () => T }): () => void {
  const init = store.getInitialState();
  const backup = { ...init };
  Object.assign(init, store.getState());
  return () => {
    for (const key of Object.keys(init) as Array<keyof T>) {
      if (!(key in backup)) delete init[key];
    }
    Object.assign(init, backup);
  };
}

function renderWithAppStore(node: ReactNode): string {
  const restore = syncStoreInitial(useAppStore);
  try {
    return renderToStaticMarkup(node);
  } finally {
    restore();
  }
}

afterEach(() => {
  vi.restoreAllMocks();
  useAppStore.setState({
    runtimeId: null,
    runtimes: {},
    sessionFile: null,
    sessionId: null,
    sessionName: null,
    messages: [],
    isStreaming: false,
    isCompacting: false,
    retryStatus: null,
  });
});

describe("Slash command meta-prompt separation & new-session /goal bootstrap", () => {
  it("appends meta: true text blocks in promptContent while preserving visible user text", () => {
    expect(
      promptContent({
        message: "/goal 修复所有单测",
        metaPrompt: "  [系统指令：请使用 update_goal 维护验收进度]  ",
        images: [],
      }),
    ).toEqual([
      { type: "text", text: "/goal 修复所有单测" },
      { type: "text", text: "[系统指令：请使用 update_goal 维护验收进度]", meta: true },
    ]);

    expect(
      promptContent({
        message: "普通提问",
        metaPrompt: "   ",
        images: [{ mimeType: "image/png", data: "abc" }],
      }),
    ).toEqual([
      { type: "text", text: "普通提问" },
      { type: "image", mimeType: "image/png", data: "abc" },
    ]);
  });

  it("ensures a real session before command.run when ensureSession is true", async () => {
    const calls: Array<{ method: string; params: Record<string, unknown> | undefined }> = [];
    const runtimes = new HarnessRuntimes(async () => ({
      host: { protocolVersion: "1.0", host: { version: "0.0.0" }, capabilities: { methods: [] } },
      call: async <T,>(method: string, params?: Record<string, unknown>): Promise<T> => {
        calls.push({ method, params });
        if (method === "session.create") {
          return {
            session: {
              id: "sess-new-goal",
              cwd: "/repo",
              createdAt: "2026-11-18T00:00:00.000Z",
              updatedAt: "2026-11-18T00:00:00.000Z",
              archived: false,
              lastSeq: 0,
              messageCount: 0,
              usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
            },
          } as T;
        }
        if (method === "session.subscribe") {
          return {
            events: [],
            liveSeq: 0,
            status: { running: false, streaming: [], runningTools: [], queue: { steer: 0, followUp: 0 } },
          } as T;
        }
        if (method === "command.run") {
          return { handled: true, prompt: "EXPANDED_GOAL_SYSTEM_PROMPT" } as T;
        }
        return {} as T;
      },
      onNotification: () => () => undefined,
      onClose: () => () => undefined,
      close: () => undefined,
    }));

    const { runtimeId } = await runtimes.start("/repo");
    await runtimes.runCommand(runtimeId, "goal", "status");
    expect(calls.map((c) => c.method)).toEqual(["command.run"]);
    expect(calls[0]?.params?.sessionId).toBeUndefined();

    calls.length = 0;
    const res = await runtimes.runCommand(runtimeId, "goal", "修复所有单测", { ensureSession: true });
    expect(res.prompt).toBe("EXPANDED_GOAL_SYSTEM_PROMPT");
    expect(calls.map((c) => c.method)).toEqual(["session.create", "session.subscribe", "command.run"]);
    expect(calls[2]?.params).toMatchObject({
      name: "goal",
      args: "修复所有单测",
      cwd: "/repo",
      sessionId: "sess-new-goal",
    });
    expect(runtimes.sessionFileOf(runtimeId)).toBe("harness:sess-new-goal");
    runtimes.close();
  });

  it("keeps optimistic user bubble clean on /goal while forwarding metaPrompt and syncing sessionId", async () => {
    const runCommandSpy = vi.spyOn(harnessRuntimes, "runCommand").mockResolvedValue({
      handled: true,
      prompt: "HIDDEN_META_INSTRUCTIONS_DO_NOT_SHOW_IN_UI",
    });
    vi.spyOn(harnessRuntimes, "sessionFileOf").mockReturnValue("harness:sess-goal-1");
    vi.spyOn(harnessRuntimes, "state").mockResolvedValue({
      sessionId: "sess-goal-1",
      sessionFile: "harness:sess-goal-1",
      isStreaming: false,
      isCompacting: false,
    });
    const promptSpy = vi.spyOn(harnessRuntimes, "prompt").mockResolvedValue(undefined);
    vi.spyOn(harnessRuntimes, "listSessions").mockResolvedValue([]);

    const runtimeId = "harness:test-rt-1";
    useAppStore.setState({
      runtimeId,
      cwd: "/repo",
      sessionId: null,
      sessionFile: null,
      runtimes: {
        [runtimeId]: {
          runtimeId,
          cwd: "/repo",
          sessionFile: null,
          isStreaming: false,
          status: "running",
          extensionRequest: null,
          updatedAt: 1,
        },
      },
    });

    const sent = await useAppStore.getState().sendMessage("/goal 修复所有单测");
    expect(sent).toBe(true);
    expect(runCommandSpy).toHaveBeenCalledWith(runtimeId, "goal", "修复所有单测", { ensureSession: true });
    expect(useAppStore.getState().sessionId).toBe("sess-goal-1");
    expect(useAppStore.getState().sessionFile).toBe("harness:sess-goal-1");

    const userMsg = useAppStore.getState().messages.find((m) => m.role === "user");
    expect(userMsg?.content).toBe("/goal 修复所有单测");
    expect(userMsg?.content).not.toContain("HIDDEN_META_INSTRUCTIONS");

    expect(promptSpy).toHaveBeenCalledWith(runtimeId, {
      message: "/goal 修复所有单测",
      metaPrompt: "HIDDEN_META_INSTRUCTIONS_DO_NOT_SHOW_IN_UI",
      images: [],
    });

    useAppStore.setState({ isStreaming: false });
    runCommandSpy.mockResolvedValueOnce({ handled: true, output: "当前会话暂无进行中的目标。" });
    await useAppStore.getState().sendMessage("/goal done");
    expect(runCommandSpy).toHaveBeenLastCalledWith(runtimeId, "goal", "done", { ensureSession: false });
    expect(useAppStore.getState().messages.at(-1)).toMatchObject({
      role: "notice",
      content: "当前会话暂无进行中的目标。",
    });
    expect(useAppStore.getState().messages.some((m) => m.id.startsWith("slash-user-"))).toBe(false);

    // Control-plane `/goal` subcommands run immediately even while `isStreaming: true` (never queued, never fake chat bubbles)
    useAppStore.setState({ isStreaming: true, managedFollowUpQueue: [] });
    runCommandSpy.mockResolvedValueOnce({ handled: true, output: "已暂停长程目标。" });
    const pausedOk = await useAppStore.getState().sendMessage("/goal pause", [], "followUp");
    expect(pausedOk).toBe(true);
    expect(runCommandSpy).toHaveBeenLastCalledWith(runtimeId, "goal", "pause", { ensureSession: false });
    expect(useAppStore.getState().managedFollowUpQueue).toEqual([]);
    expect(useAppStore.getState().messages.at(-1)).toMatchObject({
      role: "notice",
      content: "已暂停长程目标。",
    });
  });

  it("excludes meta: true blocks from historyToUi, live user events, and forkPointsOf", () => {
    const events: PersistedEvent[] = [
      {
        seq: 1,
        ts: "2026-11-18T00:00:00.000Z",
        type: "user",
        data: {
          content: [
            { type: "text", text: "/goal 完成重构" },
            { type: "text", text: "SYSTEM_EXPANSION_TEMPLATE", meta: true },
          ],
        },
      },
      {
        seq: 2,
        ts: "2026-11-18T00:00:02.000Z",
        type: "assistant",
        data: {
          content: [{ type: "text", text: "收到，开始执行。" }],
          model: { provider: "p", model: "m" },
          usage: {},
          stop: "stop",
        },
      },
    ];

    const ui = historyToUi(events);
    expect(ui[0]?.content).toBe("/goal 完成重构");
    expect(ui[0]?.content).not.toContain("SYSTEM_EXPANSION_TEMPLATE");
    expect(forkPointsOf(events)).toEqual([{ entryId: "1", text: "/goal 完成重构" }]);

    const translator = new TranscriptTranslator();
    const firstEvent = events[0];
    expect(firstEvent).toBeDefined();
    if (firstEvent !== undefined) {
      const translated = translator.event(firstEvent);
      expect(translated).toEqual([
        expect.objectContaining({
          type: "user",
          message: expect.objectContaining({ content: "/goal 完成重构" }),
        }),
      ]);
    }
  });
});

describe("UserMessageRow slash command pills", () => {
  const baseMessage = (content: string): UiMessage => ({
    id: "u-1",
    role: "user",
    content,
    timestamp: 1_000,
  });

  it("renders 🎯 /goal pill + objective text for /goal <objective> while keeping full edit draft", () => {
    const html = renderToStaticMarkup(
      createElement(UserMessageRow, {
        message: baseMessage("/goal 修复所有单测并验证构建"),
        editing: false,
        requireCtrlEnter: false,
        slotCwd: "/repo",
        slotSessionFile: null,
      }),
    );
    expect(html).toContain('class="qj-cmd-pill is-goal"');
    expect(html).toContain("🎯 /goal");
    expect(html).toContain('class="qj-cmd-objective"');
    expect(html).toContain("修复所有单测并验证构建");

    const editingHtml = renderToStaticMarkup(
      createElement(UserMessageRow, {
        message: baseMessage("/goal 修复所有单测并验证构建"),
        editing: true,
        requireCtrlEnter: false,
        slotCwd: "/repo",
        slotSessionFile: null,
      }),
    );
    expect(editingHtml).toContain("/goal 修复所有单测并验证构建");
  });

  it("renders standard command pills for other slash commands and ignores Unix file paths", () => {
    const reviewHtml = renderToStaticMarkup(
      createElement(UserMessageRow, {
        message: baseMessage("/review src/store/transcript.ts"),
        editing: false,
        requireCtrlEnter: false,
        slotCwd: "/repo",
        slotSessionFile: null,
      }),
    );
    expect(reviewHtml).toContain('<span class="qj-cmd-pill">/review</span>');
    expect(reviewHtml).toContain("src/store/transcript.ts");

    const bareGoalHtml = renderToStaticMarkup(
      createElement(UserMessageRow, {
        message: baseMessage("/goal"),
        editing: false,
        requireCtrlEnter: false,
        slotCwd: "/repo",
        slotSessionFile: null,
      }),
    );
    expect(bareGoalHtml).toContain('<span class="qj-cmd-pill">/goal</span>');
    expect(bareGoalHtml).not.toContain("is-goal");

    const pathHtml = renderToStaticMarkup(
      createElement(UserMessageRow, {
        message: baseMessage("/Users/alice/project/index.ts"),
        editing: false,
        requireCtrlEnter: false,
        slotCwd: "/repo",
        slotSessionFile: null,
      }),
    );
    expect(pathHtml).not.toContain("qj-cmd-pill");
  });
});

describe("before-stop continuation notice & Round 1 main answer preservation", () => {
  it("formats concise continuation labels for before-stop and ignores length/empty continuations", () => {
    expect(
      continuationNoticeOf({
        seq: 10,
        ts: "2026-11-18T00:00:05.000Z",
        type: "custom",
        data: {
          ns: "qianji-continuation",
          data: { reason: "before-stop", text: "[Goal Tracker 核查 (2/3)] 当前长程目标尚未标记完成。" },
        },
      }),
    ).toMatchObject({
      id: "host-10",
      role: "notice",
      noticeKind: "continuation",
      content: "目标自动验收核查（第 2/3 轮）",
    });

    expect(
      continuationNoticeOf({
        seq: 11,
        ts: "2026-11-18T00:00:05.000Z",
        type: "custom",
        data: {
          ns: "qianji-continuation",
          data: { reason: "before-stop", text: "[Goal Tracker 核查] 请确认目标是否完成。" },
        },
      })?.content,
    ).toBe("目标自动验收核查");

    expect(
      continuationNoticeOf({
        seq: 12,
        ts: "2026-11-18T00:00:05.000Z",
        type: "custom",
        data: {
          ns: "qianji-continuation",
          data: { reason: "before-stop", text: "Your current plan still has unfinished steps. Call update_plan." },
        },
      })?.content,
    ).toBe("计划完成度自动核查");

    expect(
      continuationNoticeOf({
        seq: 13,
        ts: "2026-11-18T00:00:05.000Z",
        type: "custom",
        data: {
          ns: "qianji-continuation",
          data: { reason: "length", text: "Continue from where you stopped." },
        },
      }),
    ).toBeNull();
  });

  it("prevents groupTranscriptMessages from swallowing Round 1 main answer into workSteps", () => {
    const events: PersistedEvent[] = [
      {
        seq: 1,
        ts: "2026-11-18T00:00:00.000Z",
        type: "user",
        data: { content: [{ type: "text", text: "/goal 完成架构改造" }] },
      },
      {
        seq: 2,
        ts: "2026-11-18T00:00:10.000Z",
        type: "assistant",
        data: {
          content: [{ type: "text", text: "## 第一轮完整架构总结\n\n已完成全部模块重构与核心改动。" }],
          model: { provider: "p", model: "m" },
          usage: { inputTokens: 100, outputTokens: 200, cacheReadTokens: 0, cacheWriteTokens: 0 },
          stop: "stop",
        },
      },
      {
        seq: 3,
        ts: "2026-11-18T00:00:10.500Z",
        type: "custom",
        data: {
          ns: "qianji-continuation",
          data: {
            reason: "before-stop",
            text: "[Goal Tracker 核查 (1/3)] 当前长程目标尚未标记完成，请核查并调用 update_goal。",
          },
        },
      },
      {
        seq: 4,
        ts: "2026-11-18T00:00:12.000Z",
        type: "assistant",
        data: {
          content: [
            { type: "tool-call", id: "tc-goal-done", name: "update_goal", arguments: { status: "complete", notes: "单测全绿" } },
          ],
          model: { provider: "p", model: "m" },
          usage: { inputTokens: 120, outputTokens: 20, cacheReadTokens: 0, cacheWriteTokens: 0 },
          stop: "tool-use",
        },
      },
      {
        seq: 5,
        ts: "2026-11-18T00:00:13.000Z",
        type: "tool-result",
        data: { callId: "tc-goal-done", name: "update_goal", content: [{ type: "text", text: "ok" }], isError: false },
      },
      {
        seq: 6,
        ts: "2026-11-18T00:00:14.000Z",
        type: "assistant",
        data: {
          content: [{ type: "text", text: "验收核查通过，目标已标记完成。" }],
          model: { provider: "p", model: "m" },
          usage: { inputTokens: 140, outputTokens: 25, cacheReadTokens: 0, cacheWriteTokens: 0 },
          stop: "stop",
        },
      },
    ];

    const grouped = groupTranscriptMessages(historyToUi(events));
    expect(grouped.map((m) => [m.role, m.noticeKind ?? null])).toEqual([
      ["user", null],
      ["assistant", null],
      ["notice", "continuation"],
      ["assistant", null],
    ]);
    expect(grouped[1]?.content).toContain("第一轮完整架构总结");
    expect(grouped[2]?.content).toBe("目标自动验收核查（第 1/3 轮）");
    expect(grouped[3]?.content).toBe("验收核查通过，目标已标记完成。");

    const round1Html = renderWithAppStore(createElement(Message, { message: grouped[1] as UiMessage }));
    expect(round1Html).toContain("dshc-answer");
    expect(round1Html).toContain("第一轮完整架构总结");

    const dividerHtml = renderWithAppStore(createElement(Message, { message: grouped[2] as UiMessage }));
    expect(dividerHtml).toContain('class="dshc-flow compaction-divider is-continuation"');
    expect(dividerHtml).toContain("↻ 目标自动验收核查（第 1/3 轮）");
    expect(dividerHtml).not.toContain("Goal Tracker 核查 (1/3)");

    // Live streaming path: appendNotice settles prior streaming assistant before appending notice
    const liveSettled = appendNotice(
      [{ id: "stream-1", role: "assistant", content: "第一轮实时回答", isStreaming: true, timestamp: 1 }],
      grouped[2] as UiMessage,
    );
    expect(liveSettled[0]?.isStreaming).toBe(false);
    expect(liveSettled[1]?.noticeKind).toBe("continuation");
  });

  it("translates DSH <goal_round> meta-only user events and goal-complete events cleanly without empty user bubbles", () => {
    const roundEvent: PersistedEvent = {
      seq: 3,
      ts: "2026-11-18T00:00:10.500Z",
      type: "user",
      data: {
        content: [
          {
            type: "text",
            text: '<goal_round>\nObjective: "完成架构改造"\nRound: 2/256\n</goal_round>',
            meta: true,
          },
        ],
      },
    };
    expect(goalRoundNoticeOf(roundEvent)).toMatchObject({
      id: "host-3",
      role: "notice",
      noticeKind: "continuation",
      content: "目标自动推进（第 2/256 轮）",
    });

    const completeEvent: PersistedEvent = {
      seq: 7,
      ts: "2026-11-18T00:00:20.000Z",
      type: "custom",
      data: {
        ns: "qianji-goal",
        data: {
          id: "g-1",
          sessionId: "s-1",
          revision: 3,
          objective: "完成架构改造",
          phase: "complete",
          justCompleted: true,
          notes: "全部测试绿灯",
        },
      },
    };
    expect(goalCompleteNoticeOf(completeEvent)).toMatchObject({
      id: "host-7",
      role: "notice",
      noticeKind: "goal-complete",
      content: "完成架构改造\n全部测试绿灯",
    });

    const events: PersistedEvent[] = [
      {
        seq: 1,
        ts: "2026-11-18T00:00:00.000Z",
        type: "user",
        data: { content: [{ type: "text", text: "/goal 完成架构改造" }] },
      },
      {
        seq: 2,
        ts: "2026-11-18T00:00:10.000Z",
        type: "assistant",
        data: {
          content: [{ type: "text", text: "第一轮主回复内容" }],
          model: { provider: "p", model: "m" },
          usage: { inputTokens: 100, outputTokens: 200, cacheReadTokens: 0, cacheWriteTokens: 0 },
          stop: "stop",
        },
      },
      roundEvent,
      {
        seq: 4,
        ts: "2026-11-18T00:00:15.000Z",
        type: "assistant",
        data: {
          content: [{ type: "text", text: "第二轮收尾确认。" }],
          model: { provider: "p", model: "m" },
          usage: { inputTokens: 120, outputTokens: 50, cacheReadTokens: 0, cacheWriteTokens: 0 },
          stop: "stop",
        },
      },
      completeEvent,
    ];

    const ui = historyToUi(events);
    expect(ui.map((m) => [m.role, m.noticeKind ?? null])).toEqual([
      ["user", null],
      ["assistant", null],
      ["notice", "continuation"],
      ["assistant", null],
      ["notice", "goal-complete"],
    ]);
    expect(forkPointsOf(events)).toEqual([{ entryId: "1", text: "/goal 完成架构改造" }]);

    const translator = new TranscriptTranslator();
    expect(translator.event(roundEvent)).toEqual([
      expect.objectContaining({
        type: "notice",
        message: expect.objectContaining({ noticeKind: "continuation", content: "目标自动推进（第 2/256 轮）" }),
      }),
    ]);

    const completeHtml = renderWithAppStore(createElement(Message, { message: ui[4] as UiMessage }));
    expect(completeHtml).toContain("goal-complete-banner");
    expect(completeHtml).toContain("目标已达成");
    expect(completeHtml).toContain("完成架构改造");
    expect(completeHtml).toContain("全部测试绿灯");
  });
});

describe("Goal milestone tool presentation & Message visibility", () => {
  const makeCall = (name: string, args: Record<string, unknown>): UiToolCall => ({
    id: `call-${name}`,
    name,
    args,
    running: false,
  });

  it("presents create_goal and update_goal as checklist plan milestones with clean titles and details", () => {
    expect(classifyToolKind("create_goal")).toBe("plan");
    expect(classifyToolKind("update_goal")).toBe("plan");

    const createCall = makeCall("create_goal", { objective: "零泄漏斜杠命令架构" });
    const createPresented = presentToolCall(createCall);
    expect(createPresented).toMatchObject({
      kind: "plan",
      title: "设定长程目标",
      detail: "零泄漏斜杠命令架构",
      heading: "设定长程目标 · 零泄漏斜杠命令架构",
    });
    expect(toolRowCopy(createPresented, createCall)).toEqual({
      title: "设定长程目标",
      summary: "零泄漏斜杠命令架构",
    });

    const completeCall = makeCall("update_goal", { status: "complete", notes: "全部测试与构建验证通过" });
    expect(presentToolCall(completeCall)).toMatchObject({
      kind: "plan",
      title: "目标已达成",
      detail: "全部测试与构建验证通过",
    });

    const blockedCall = makeCall("update_goal", { status: "blocked", notes: "等待生产环境证书" });
    expect(presentToolCall(blockedCall)).toMatchObject({
      kind: "plan",
      title: "目标受阻",
      detail: "等待生产环境证书",
    });

    const progressCall = makeCall("update_goal", { status: "active", notes: "已完成协议层改造" });
    expect(presentToolCall(progressCall)).toMatchObject({
      kind: "plan",
      title: "更新目标进展",
      detail: "已完成协议层改造",
    });

    expect(presentToolCall(makeCall("update_goal", { action: "pause", notes: "等待人工确认" }))).toMatchObject({
      kind: "plan",
      title: "暂停目标",
      detail: "等待人工确认",
    });
    expect(presentToolCall(makeCall("update_goal", { action: "resume" }))).toMatchObject({
      kind: "plan",
      title: "恢复目标",
    });
    expect(presentToolCall(makeCall("update_goal", { action: "edit", objective: "新的目标描述" }))).toMatchObject({
      kind: "plan",
      title: "修订目标",
      detail: "新的目标描述",
    });
    expect(presentToolCall(makeCall("update_goal", { action: "blocked", blocked_reason: "缺少密钥" }))).toMatchObject({
      kind: "plan",
      title: "目标受阻",
      detail: "缺少密钥",
    });
  });

  it("hides read-only get_goal while keeping create_goal and update_goal visible in Message process", () => {
    const getOnlyHtml = renderWithAppStore(
      createElement(Message, {
        message: {
          id: "a-get-only",
          role: "assistant",
          content: "已检查当前目标状态。",
          timestamp: 1_500,
          toolCalls: [{ id: "g-get", name: "get_goal", args: {}, running: false }],
        },
      }),
    );
    expect(getOnlyHtml).not.toContain('data-tool="get_goal"');
    expect(getOnlyHtml).not.toContain("展开工作过程");

    const assistantMsg: UiMessage = {
      id: "a-goal",
      role: "assistant",
      content: "正在推进长程目标。",
      isStreaming: true,
      timestamp: 2_000,
      toolCalls: [
        { id: "g-get", name: "get_goal", args: {}, running: false },
        { id: "g-create", name: "create_goal", args: { objective: "修复单测" }, running: false },
        { id: "g-update", name: "update_goal", args: { status: "complete", notes: "全部通过" }, running: false },
      ],
    };

    const html = renderWithAppStore(
      createElement(Message, {
        message: assistantMsg,
        density: "verbose",
      }),
    );
    expect(html).not.toContain('data-tool="get_goal"');
    expect(html).toContain('data-tool="create_goal"');
    expect(html).toContain("设定长程目标");
    expect(html).toContain('data-tool="update_goal"');
    expect(html).toContain("目标已达成");
  });
});

describe("Composer Dock banner elevation & @layer components CSS", () => {
  it("mounts composerBanners inside .composer-dock-banners directly above .composer-card", () => {
    const dispose = clientContributions.registerComposerBanner({
      id: "test:goal-dock-banner",
      render: () => createElement("div", { className: "mock-goal-dock" }, "GOAL_DOCK_ACTIVE"),
    });
    try {
      const html = renderWithAppStore(
        createElement(Composer, {
          isStreaming: false,
          disabled: false,
          attachments: [],
          commands: [],
          models: [],
          model: null,
          thinkingLevel: "medium",
          thinkingLevels: ["medium"],
          prefill: null,
          pendingCount: 0,
          onSend: async () => true,
          onStop: () => undefined,
          onPickAttachments: () => undefined,
          onAttachFiles: () => undefined,
          onRemoveAttachment: () => undefined,
          onModelChange: () => undefined,
          onThinkingChange: () => undefined,
          onPrefillConsumed: () => undefined,
        }),
      );

      const dockIdx = html.indexOf('class="composer-dock-banners"');
      const cardIdx = html.indexOf('data-composer-card=""');
      expect(dockIdx).toBeGreaterThan(0);
      expect(cardIdx).toBeGreaterThan(dockIdx);
      expect(html).toContain("GOAL_DOCK_ACTIVE");
    } finally {
      dispose();
    }
  });

  it("imports goal-and-commands.css in layer(components) with semantic --qj-* rules", () => {
    const indexCss = readFileSync(resolve(REPO_ROOT, "src/styles/index.css"), "utf8");
    expect(indexCss).toContain('@import "./goal-and-commands.css" layer(components);');

    const goalCss = readFileSync(resolve(REPO_ROOT, "src/styles/goal-and-commands.css"), "utf8");
    expect(goalCss).toContain(".qj-cmd-pill");
    expect(goalCss).toContain(".qj-cmd-pill.is-goal");
    expect(goalCss).toContain(".compaction-divider.is-continuation");
    expect(goalCss).toContain(".composer-dock-banners");
  });
});

// The frontend's harness adapter (src/lib/harnessRuntime.ts) against a real
// Harness Host in this process: the store's Pi commands and events over the
// real WebSocket client, with a scripted model.
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentLoop } from "@qianji/agent-loop";
import * as checkpoints from "@qianji/checkpoints";
import { LlmService } from "@qianji/llm";
import { Permissions } from "@qianji/permissions";
import * as plan from "@qianji/plan";
import { Sessions } from "@qianji/session";
import * as sessionJsonl from "@qianji/session-jsonl";
import { SystemPrompt } from "@qianji/system-prompt";
import { ScriptedProvider, textReply, toolReply, useScriptedProvider } from "@qianji/testkit";
import * as toolFs from "@qianji/tool-fs";
import { Tools } from "@qianji/tools";
import { Ui } from "@qianji/ui";
import { RpcGateway, WebServer, createHost, type Host } from "../packages/host/src/index";
import * as sessionsRpc from "../packages/host/src/sessions-rpc";
import * as uiRpc from "../packages/host/src/ui-rpc";
import { Mcp } from "@qianji/mcp";
import { Schedule } from "@qianji/schedule";
import { runFromHost, taskFromHost, taskToHost } from "../src/lib/scheduleClient";
import type { ScheduledRunInfo, SessionSubscribeResult } from "@qianji/protocol";
import { agent } from "../src/lib/agent";
import { connectHarness, type HarnessConnection } from "../src/lib/harnessClient";
import { HarnessRuntimes, harnessRuntimes, type HostStatus } from "../src/lib/harnessRuntime";
import { sessionInfoFromHost } from "../src/lib/hostSessions";
import { historyToUi, resetStreamingAssistant, startAssistant, streamAssistant, type TranscriptEvent } from "../src/lib/transcript";
import { StoreContext } from "../src/store/context";
import type { AppState } from "../src/store/types";
import type { ExtensionUIRequest, UiMessage } from "../src/types";

const token = Buffer.alloc(32, 3).toString("base64url");
let host: Host | undefined;
let runtimesInUse: HarnessRuntimes | undefined;
let dir = "";
// The session logs, outside the workspace so its checkpoints do not see them.
let logs = "";

afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  runtimesInUse?.close();
  runtimesInUse = undefined;
  await host?.stop();
  host = undefined;
  rmSync(dir, { recursive: true, force: true });
  rmSync(logs, { recursive: true, force: true });
});

async function start(provider: ScriptedProvider) {
  dir = mkdtempSync(join(tmpdir(), "pid-harness-runtime-"));
  logs = mkdtempSync(join(tmpdir(), "pid-harness-logs-"));
  writeFileSync(join(dir, "a.txt"), "hello\n");
  // A git repository, so runs take workspace checkpoints to rewind to.
  const git = (...args: string[]) => execFileSync("git", args, { cwd: dir, windowsHide: true });
  git("init", "-q");
  git("config", "user.email", "test@example.com");
  git("config", "user.name", "Test");
  git("config", "commit.gpgsign", "false");
  git("config", "core.autocrlf", "false");
  git("add", "a.txt");
  git("commit", "-q", "-m", "init");
  host = createTestHost(provider);
  await host.start();
  let port = await host.ctx.webServer.listen(0);
  // The runtimes reach the Host only while `reachable`; `latest` is their connection.
  const link = { reachable: true, latest: undefined as HarnessConnection | undefined };
  const runtimes = new HarnessRuntimes(async () => {
    if (!link.reachable) throw new Error("unreachable");
    link.latest = await connectHarness({ baseUrl: `http://127.0.0.1:${port}/`, token }, { name: "test", version: "1" });
    return link.latest;
  }, [20]);
  runtimesInUse = runtimes;
  const events: Array<[string, TranscriptEvent]> = [];
  const waiters: Array<() => void> = [];
  runtimes.subscribe((runtimeId, event) => {
    events.push([runtimeId, event]);
    for (const waiter of waiters.splice(0)) waiter();
  });
  const until = async (match: (event: TranscriptEvent) => boolean): Promise<TranscriptEvent> => {
    for (;;) {
      const found = events.find(([, event]) => match(event));
      if (found !== undefined) return found[1];
      await new Promise<void>((resolve) => waiters.push(resolve));
    }
  };
  /** The next dialog the Host (or the runtime itself) asks for. */
  const nextQuestion = async (title?: string): Promise<ExtensionUIRequest> => {
    const found = await until((event) => event.type === "ui-request" && event.request.method === "confirm" && (title === undefined || event.request.title === title));
    return (found as Extract<TranscriptEvent, { type: "ui-request" }>).request;
  };
  /**
   * Cut the runtimes off as a crash would, before the Host can say anything
   * more, and start another Host on the same data; they reach it once
   * `link.reachable` is set. Returns the new Host's base URL.
   */
  const crash = async (): Promise<string> => {
    link.reachable = false;
    link.latest?.close();
    await host?.stop();
    host = createTestHost(provider);
    await host.start();
    port = await host.ctx.webServer.listen(0);
    return `http://127.0.0.1:${port}/`;
  };
  return { runtimes, events, until, nextQuestion, crash, link };
}

function createTestHost(provider: ScriptedProvider): Host {
  return createHost({
    version: "0",
    dataDir: dir,
    plugins: [
      [WebServer, { pageOrigins: [] }],
      [RpcGateway, { token }],
      [LlmService, { maxAttempts: 1 }],
      [Sessions],
      // On disk, so a Host started again on the same data finds the sessions.
      [sessionJsonl, { dir: logs }],
      [Ui],
      [Tools],
      [SystemPrompt],
      [Permissions, {}],
      [toolFs],
      [plan],
      [AgentLoop],
      [checkpoints],
      [Mcp, {}],
      [Schedule, { tasksFile: join(dir, "schedules.json"), runsFile: join(dir, "schedule-runs.jsonl"), defaultModel: { provider: "scripted", model: "m" }, tickMs: 60_000 }],
      [sessionsRpc, { defaultModel: { provider: "scripted", model: "m" } }],
      [uiRpc],
      [{ name: "scripted", inject: ["llm"], apply: (ctx: never) => useScriptedProvider(ctx, provider) }],
    ],
  });
}

/** Poll until `check` holds. */
async function eventually(check: () => boolean | Promise<boolean>, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error("timed out");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

describe("harness runtimes", () => {
  it("run a task the way the store drives a Pi runtime", async () => {
    const provider = new ScriptedProvider([
      toolReply([{ id: "c1", name: "read", args: { path: "a.txt" } }]),
      toolReply([{ id: "c2", name: "write", args: { path: "b.txt", content: "made" } }]),
      textReply("Done."),
    ]);
    const { runtimes, events, until, nextQuestion } = await start(provider);
    const { runtimeId } = await runtimes.start(dir);

    // Nothing is created until the first prompt: a prewarmed workspace leaves no session.
    expect(await runtimes.state(runtimeId)).toMatchObject({ isStreaming: false });
    expect(await runtimes.messages(runtimeId)).toEqual([]);
    expect(await runtimes.setModel(runtimeId, "scripted", "m")).toMatchObject({ provider: "scripted", id: "m" });
    expect((await runtimes.state(runtimeId)).model).toMatchObject({ provider: "scripted", id: "m" });
    await runtimes.setThinkingLevel(runtimeId, "high");

    await runtimes.prompt(runtimeId, { message: "Copy a.txt", images: [] });
    // The write needs confirmation: answer it as the extension dialog would.
    const request = await nextQuestion();
    expect(request).toMatchObject({ method: "confirm", title: "允许修改文件？" });
    await runtimes.respond(request, { confirmed: true });
    await until((event) => event.type === "turn-end");

    const kinds = events.map(([, event]) => event.type);
    expect(kinds.slice(0, 3)).toEqual(["user", "turn-start", "assistant-start"]);
    expect(kinds.filter((kind) => kind === "tool-end")).toHaveLength(2);
    expect(readFileSync(join(dir, "b.txt"), "utf8")).toBe("made");
    expect(provider.requests[0]?.effort).toBe("high");

    const state = await runtimes.state(runtimeId);
    expect(state).toMatchObject({ isStreaming: false, thinkingLevel: "high", model: { provider: "scripted", id: "m" } });
    expect(String(state?.sessionFile)).toMatch(/^harness:/);
    const history = await runtimes.messages(runtimeId);
    expect(history.map((message) => message.role)).toEqual(["user", "assistant", "assistant", "assistant"]);
    expect(history.flatMap((message) => message.toolCalls ?? []).every((call) => !call.running && call.isError === false)).toBe(true);
    expect(await runtimes.stats(runtimeId)).toMatchObject({ totalMessages: 4, tokens: { input: 30, output: 15 } });

    // Reopening the session from its sessionFile shows the same history.
    const reopened = await runtimes.start(dir, String(state?.sessionFile));
    expect(await runtimes.messages(reopened.runtimeId)).toHaveLength(4);

    // The sidebar's view of it: listed with its first message, history readable without a runtime.
    const sessionId = String(state?.sessionId);
    const listed = await runtimes.listSessions();
    expect(listed.map((session) => [session.id, session.firstMessage])).toEqual([[sessionId, "Copy a.txt"]]);
    expect(sessionInfoFromHost(listed[0] as never)).toMatchObject({ file: `harness:${sessionId}`, cwd: dir, firstMessage: "Copy a.txt", messageCount: 4 });
    const logged = await runtimes.readEvents(sessionId);
    expect(historyToUi(logged).map((message) => message.role)).toEqual(["user", "assistant", "assistant", "assistant"]);
  });

  it("switch modes without creating a ghost session until the first prompt, and refuse a runtime that has stopped", async () => {
    const { runtimes, until } = await start(new ScriptedProvider([textReply("Planned.")]));
    const { runtimeId } = await runtimes.start(dir);
    await runtimes.setPermission(runtimeId, { agentMode: "plan" });
    expect((await runtimes.state(runtimeId)).sessionId).toBeUndefined();
    expect(await runtimes.listSessions()).toEqual([]);

    await runtimes.prompt(runtimeId, { message: "Outline steps", images: [] });
    await until((event) => event.type === "turn-end");
    const sessionId = String((await runtimes.state(runtimeId)).sessionId);
    const session = await host?.ctx.sessions.get(sessionId);
    expect(session === undefined ? undefined : host?.ctx.permissions.modes(session).agentMode).toBe("plan");
    expect(runtimes.thinkingLevels()).toEqual(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);
    expect(runtimes.thinkingLevels({ id: "plain", name: "Plain", provider: "p", reasoning: false })).toEqual(["off"]);
    expect(
      runtimes.thinkingLevels({
        id: "grok-4.7",
        name: "Grok 4.7",
        provider: "xai",
        reasoning: true,
        thinkingLevels: ["off", "low", "medium", "high", "xhigh", "ultra"],
      }),
    ).toEqual(["off", "low", "medium", "high", "xhigh", "ultra"]);
    await runtimes.setThinkingLevel(runtimeId, "ultra");
    expect((await runtimes.state(runtimeId)).thinkingLevel).toBe("ultra");
    await runtimes.stop(runtimeId);
    await expect(runtimes.state(runtimeId)).rejects.toThrow("Harness 任务已结束");
  });
});

describe("rewinding and forking", () => {
  it("rewind a message and its file changes, fork, clone and show the tree", async () => {
    const provider = new ScriptedProvider([
      toolReply([{ id: "c1", name: "write", args: { path: "b.txt", content: "made" } }]),
      textReply("Wrote it."),
      textReply("Second answer."),
    ]);
    const { runtimes, events, until, nextQuestion } = await start(provider);
    const { runtimeId } = await runtimes.start(dir);
    await runtimes.setPermission(runtimeId, { permission: "full-access" });
    await runtimes.prompt(runtimeId, { message: "Make b.txt", images: [] });
    await until((event) => event.type === "turn-end");
    expect(readFileSync(join(dir, "b.txt"), "utf8")).toBe("made");

    const points = await runtimes.forkPoints(runtimeId);
    expect(points.map((point) => point.text)).toEqual(["Make b.txt"]);

    // Rewinding asks before putting the files back, through the same dialog as Host questions.
    const rewinding = runtimes.rewind(runtimeId, String(points[0]?.entryId));
    const question = await nextQuestion("回退消息和工作区？");
    expect(question).toMatchObject({ message: expect.stringContaining("1 个文件将恢复") });
    await runtimes.respond(question, { confirmed: true });
    expect(await rewinding).toBe(true);
    expect(existsSync(join(dir, "b.txt"))).toBe(false);
    expect(await runtimes.messages(runtimeId)).toEqual([]);

    // The rewound turn stays in the tree as a side branch.
    events.length = 0;
    await runtimes.prompt(runtimeId, { message: "Just answer", images: [] });
    await until((event) => event.type === "turn-end");
    const tree = await runtimes.tree(runtimeId);
    expect(tree.tree).toHaveLength(2);
    const before = String((await runtimes.state(runtimeId)).sessionId);

    // Forking from the leaf (an assistant reply) keeps it; cloning copies everything.
    await runtimes.fork(runtimeId, String(tree.leafId));
    const forked = await runtimes.state(runtimeId);
    expect(forked?.sessionId).not.toBe(before);
    expect((await runtimes.messages(runtimeId)).map((message) => message.role)).toEqual(["user", "assistant"]);
    await runtimes.clone(runtimeId);
    expect((await runtimes.state(runtimeId)).sessionId).not.toBe(forked.sessionId);

    // A new session starts empty and is created on its first prompt.
    runtimes.newSession(runtimeId);
    expect((await runtimes.state(runtimeId)).sessionId).toBeUndefined();
  });

  it("cancel a rewind the user declines", async () => {
    const provider = new ScriptedProvider([toolReply([{ id: "c1", name: "write", args: { path: "b.txt", content: "made" } }]), textReply("Done.")]);
    const { runtimes, until, nextQuestion } = await start(provider);
    const { runtimeId } = await runtimes.start(dir);
    await runtimes.setPermission(runtimeId, { permission: "full-access" });
    await runtimes.prompt(runtimeId, { message: "Make b.txt", images: [] });
    await until((event) => event.type === "turn-end");
    const points = await runtimes.forkPoints(runtimeId);
    const rewinding = runtimes.rewind(runtimeId, String(points[0]?.entryId));
    const question = await nextQuestion();
    await runtimes.respond(question, { confirmed: false });
    expect(await rewinding).toBe(false);
    expect(readFileSync(join(dir, "b.txt"), "utf8")).toBe("made");
    expect((await runtimes.messages(runtimeId)).length).toBeGreaterThan(0);
  });
});

describe("side chats", () => {
  it("run on a hidden fork of the conversation that goes when the side chat stops", async () => {
    const { runtimes, events, until } = await start(new ScriptedProvider([textReply("Main answer."), textReply("Side answer.")]));
    const main = await runtimes.start(dir);
    await runtimes.prompt(main.runtimeId, { message: "Main question", images: [] });
    await until((event) => event.type === "turn-end");
    const parentFile = String((await runtimes.state(main.runtimeId)).sessionFile);

    const side = await runtimes.start(dir, parentFile, true);
    expect(side.sessionForked).toBe(true);
    const sideFile = String((await runtimes.state(side.runtimeId)).sessionFile);
    expect(sideFile).not.toBe(parentFile);
    expect((await runtimes.messages(side.runtimeId)).map((message) => message.role)).toEqual(["user", "assistant"]);
    events.length = 0;
    await runtimes.prompt(side.runtimeId, { message: "Side question", images: [] });
    await until((event) => event.type === "turn-end");
    const sideMessages = await runtimes.messages(side.runtimeId);
    expect(sideMessages.map((message) => message.role)).toEqual(["user", "assistant", "user", "assistant"]);
    expect(JSON.stringify(sideMessages.at(-1))).toContain("Side answer.");

    // The sidebar never lists it, and the parent keeps only its own turn.
    expect((await runtimes.listSessions()).map((session) => `harness:${session.id}`)).toEqual([parentFile]);
    expect(await runtimes.messages(main.runtimeId)).toHaveLength(2);

    await runtimes.stop(side.runtimeId);
    const all = await runtimes.call<{ sessions: Array<{ id: string }> }>("session.list");
    expect(all.sessions.map((session) => `harness:${session.id}`)).toEqual([parentFile]);
  });
});

describe("scheduled tasks through the adapter", () => {
  it("map tasks and runs, and hear the Host's run updates", async () => {
    const { runtimes } = await start(new ScriptedProvider([textReply("Report ready.")]));
    const heard: ScheduledRunInfo[] = [];
    const stop = runtimes.onNotification("schedule/run", (params) => void heard.push(params as ScheduledRunInfo));
    const task = { id: "nightly", name: "Nightly", prompt: "report", cwd: dir, frequency: "daily" as const, hour: 2, minute: 0, weekday: 1, permissionMode: "read-only" as const, timeoutMinutes: null, enabled: true, lastStatus: "" as const, lastMessage: "" };
    const saved = await runtimes.call<{ task: never }>("schedule.save", { task: taskToHost(task) });
    expect(taskFromHost(saved.task)).toMatchObject({ id: "nightly", permissionMode: "read-only", timeoutMinutes: null, lastStatus: "", enabled: true });
    const { run } = await runtimes.call<{ run: ScheduledRunInfo }>("schedule.run", { id: "nightly" });
    expect(runFromHost(run, task)).toMatchObject({ taskName: "Nightly", cwd: dir, prompt: "report", permissionMode: "read-only", status: "success", output: "Report ready.", sessionFile: `harness:${run.sessionId}` });
    expect(heard.map((item) => item.status)).toEqual(["running", "success"]);
    stop();
  });
});

describe("crash recovery", () => {
  it("reconnect after the Host restarts and catch up on what it logged meanwhile", async () => {
    const provider = new ScriptedProvider([textReply("One."), textReply("Two."), textReply("Three.")]);
    const { runtimes, events, until, crash, link } = await start(provider);
    const statuses: HostStatus[] = [];
    runtimes.onHostStatus((status) => statuses.push(status));
    const { runtimeId } = await runtimes.start(dir);
    await runtimes.prompt(runtimeId, { message: "one", images: [] });
    await until((event) => event.type === "turn-end");
    const sessionId = String((await runtimes.state(runtimeId)).sessionId);

    const baseUrl = await crash();
    await eventually(() => statuses.includes("reconnecting"));
    // While the runtime cannot reach the new Host, another client moves the session on.
    const other = await connectHarness({ baseUrl, token }, { name: "other", version: "1" });
    await other.call("session.prompt", { sessionId, content: [{ type: "text", text: "two" }] });
    await eventually(async () => {
      const got = await other.call<{ status: { running: boolean }; session: { messageCount: number } }>("session.get", { sessionId });
      return !got.status.running && got.session.messageCount === 4;
    });
    other.close();

    events.length = 0;
    link.reachable = true;
    // The runtime replays what it missed, in order.
    await until((event) => event.type === "assistant" && event.message.content === "Two.");
    const caughtUp = events.map(([, event]) => event.type);
    expect(caughtUp.slice(0, 2)).toEqual(["user", "assistant"]);
    expect(caughtUp).not.toContain("turn-interrupted");
    expect(statuses).toEqual(["connected", "reconnecting", "connected"]);

    // And works as before.
    await runtimes.prompt(runtimeId, { message: "three", images: [] });
    await until((event) => event.type === "assistant" && event.message.content === "Three.");
    expect((await runtimes.messages(runtimeId)).map((message) => message.content)).toEqual(["one", "One.", "two", "Two.", "three", "Three."]);
  });

  it("end a turn the Host stopped running as interrupted", async () => {
    const slowReply = [
      { type: "text-delta" as const, index: 0, text: "Partial " },
      { type: "text-delta" as const, index: 0, text: "answer" },
      { type: "finish" as const, reason: "stop" as const },
    ];
    const provider = new ScriptedProvider([slowReply], { chunkDelayMs: 300 });
    const { runtimes, events, until, crash, link } = await start(provider);
    const { runtimeId } = await runtimes.start(dir);
    await runtimes.prompt(runtimeId, { message: "go", images: [] });
    await until((event) => event.type === "assistant-delta");

    await crash();
    events.length = 0;
    link.reachable = true;
    await until((event) => event.type === "turn-end");
    expect(events.map(([, event]) => event.type)).toContain("turn-interrupted");
    expect((await runtimes.state(runtimeId)).isStreaming).toBe(false);

    // Reopened, the session shows the turn as failed rather than still going.
    const last = (await runtimes.messages(runtimeId)).at(-1);
    expect(last).toMatchObject({ role: "assistant", isError: true });
  });
});

describe("mid-stream snapshot replay, liveSeq dedup, and syncSession ordering", () => {
  it("deduplicates session/delta by liveSeq and resets watermark on newSession", async () => {
    let notify: ((method: string, params: unknown) => void) | undefined;
    let subscribeSeq = 5;
    let nextSession = 1;
    const runtimes = new HarnessRuntimes(async () => ({
      host: { protocolVersion: "1", host: { name: "mock", version: "1" }, capabilities: { methods: [] } },
      call: async <T>(method: string): Promise<T> => {
        if (method === "session.create") {
          nextSession += 1;
          return { session: { id: `s-${nextSession}`, cwd: "D:/repo" } } as T;
        }
        if (method === "session.subscribe") {
          return {
            events: [{ seq: 1, ts: "2026-10-29T00:00:00.000Z", type: "user", data: { content: [{ type: "text", text: "hi" }] } }],
            status: { running: true, streaming: [], runningTools: [], queue: { steer: 0, followUp: 0 } },
            liveSeq: subscribeSeq,
          } satisfies SessionSubscribeResult as T;
        }
        return {} as T;
      },
      onNotification: (fn) => {
        notify = fn;
        return () => undefined;
      },
      onClose: () => undefined,
      close: () => undefined,
    }));
    runtimesInUse = runtimes;

    const deltas: string[] = [];
    runtimes.subscribe((_id, event) => {
      if (event.type === "assistant-delta") deltas.push(event.text);
    });

    const { runtimeId } = await runtimes.start("D:/repo", "harness:s-1");
    notify?.("session/delta", { sessionId: "s-1", liveSeq: 4, delta: { type: "llm-chunk", chunk: { type: "text-delta", index: 0, text: "old-4" } } });
    notify?.("session/delta", { sessionId: "s-1", liveSeq: 5, delta: { type: "llm-chunk", chunk: { type: "text-delta", index: 0, text: "old-5" } } });
    notify?.("session/delta", { sessionId: "s-1", liveSeq: 6, delta: { type: "llm-chunk", chunk: { type: "text-delta", index: 0, text: "live-6" } } });
    notify?.("session/delta", { sessionId: "s-1", liveSeq: 6, delta: { type: "llm-chunk", chunk: { type: "text-delta", index: 0, text: "dup-6" } } });
    expect(deltas).toEqual(["live-6"]);

    // Starting a new session resets lastLiveSeq so a new session starting at liveSeq=1 is not dropped.
    runtimes.newSession(runtimeId);
    subscribeSeq = 0;
    await runtimes.prompt(runtimeId, { message: "next", images: [] });
    notify?.("session/delta", { sessionId: "s-2", liveSeq: 1, delta: { type: "llm-chunk", chunk: { type: "text-delta", index: 0, text: "fresh-1" } } });
    expect(deltas).toEqual(["live-6", "fresh-1"]);
  });

  it("continues seamlessly from mid-stream messages() snapshot to live session/delta chunks", async () => {
    let notify: ((method: string, params: unknown) => void) | undefined;
    let subscribeCalls = 0;
    const runtimes = new HarnessRuntimes(async () => ({
      host: { protocolVersion: "1", host: { name: "mock", version: "1" }, capabilities: { methods: [] } },
      call: async <T>(method: string): Promise<T> => {
        if (method === "session.subscribe") {
          subscribeCalls += 1;
          const liveSeq = subscribeCalls === 1 ? 8 : 10;
          return {
            events: [
              { seq: 1, ts: "2026-10-29T00:00:00.000Z", type: "user", data: { content: [{ type: "text", text: "edit" }] } },
            ],
            status: {
              running: true,
              runningTools: [],
              queue: { steer: 2, followUp: 1 },
              streaming: [
                { type: "text-delta", index: 0, text: "Hello " },
                { type: "tool-call-start", index: 1, id: "tc-1", name: "write" },
                { type: "tool-call-delta", index: 1, argumentsDelta: '{"path":"a.ts","con' },
              ],
            },
            liveSeq,
          } satisfies SessionSubscribeResult as T;
        }
        return {} as T;
      },
      onNotification: (fn) => {
        notify = fn;
        return () => undefined;
      },
      onClose: () => undefined,
      close: () => undefined,
    }));
    runtimesInUse = runtimes;

    const emitted: TranscriptEvent[] = [];
    runtimes.subscribe((_id, event) => emitted.push(event));
    const { runtimeId } = await runtimes.start("D:/repo", "harness:s-mid");
    let uiMessages = await runtimes.messages(runtimeId);

    expect(uiMessages[1]).toMatchObject({
      role: "assistant",
      isStreaming: true,
      content: "Hello ",
      toolCalls: [{ id: "tc-1", name: "write", args: { path: "a.ts" }, running: true }],
    });
    expect(emitted).toContainEqual({ type: "queue", steering: 2, followUp: 1 });
    expect(runtimes.streamingRuntimeIds()).toContain(runtimeId);

    emitted.length = 0;
    // Duplicate liveSeq <= 10 is ignored; 11..13 append seamlessly onto the replayed message & translator.
    notify?.("session/delta", { sessionId: "s-mid", liveSeq: 10, delta: { type: "llm-chunk", chunk: { type: "text-delta", index: 0, text: "Hello " } } });
    notify?.("session/delta", { sessionId: "s-mid", liveSeq: 11, delta: { type: "llm-chunk", chunk: { type: "text-delta", index: 0, text: "world" } } });
    notify?.("session/delta", { sessionId: "s-mid", liveSeq: 12, delta: { type: "llm-chunk", chunk: { type: "tool-call-delta", index: 1, argumentsDelta: 'tent":"ok"}' } } });
    notify?.("session/delta", { sessionId: "s-mid", liveSeq: 13, delta: { type: "llm-chunk", chunk: { type: "finish", reason: "tool-use" } } });

    for (const event of emitted) {
      if (event.type === "assistant-delta") uiMessages = streamAssistant(uiMessages, { text: event.text, thinking: event.thinking });
      if (event.type === "assistant-tool-calls") uiMessages = streamAssistant(uiMessages, { toolCalls: event.calls });
    }
    expect(uiMessages[1]).toMatchObject({
      content: "Hello world",
      toolCalls: [{ id: "tc-1", name: "write", args: { path: "a.ts", content: "ok" }, running: true }],
    });
  });

  it("replays active stream on resume() without duplicating already-streamed text", async () => {
    let notify: ((method: string, params: unknown) => void) | undefined;
    let onClose: (() => void) | undefined;
    let connCount = 0;
    const runtimes = new HarnessRuntimes(async () => {
      connCount += 1;
      const attempt = connCount;
      return {
        host: { protocolVersion: "1", host: { name: "mock", version: "1" }, capabilities: { methods: [] } },
        call: async <T>(method: string): Promise<T> => {
          if (method === "session.subscribe") {
            if (attempt === 1) {
              return {
                events: [{ seq: 1, ts: "2026-10-29T00:00:00.000Z", type: "user", data: { content: [{ type: "text", text: "go" }] } }],
                status: { running: false, streaming: [], runningTools: [], queue: { steer: 0, followUp: 0 } },
                liveSeq: 0,
              } satisfies SessionSubscribeResult as T;
            }
            return {
              events: [],
              status: {
                running: true,
                streaming: [
                  { type: "text-delta", index: 0, text: "Par" },
                  { type: "text-delta", index: 0, text: "tial" },
                ],
                runningTools: [],
                queue: { steer: 0, followUp: 1 },
              },
              liveSeq: 5,
            } satisfies SessionSubscribeResult as T;
          }
          return {} as T;
        },
        onNotification: (fn) => {
          notify = fn;
          return () => undefined;
        },
        onClose: (fn) => {
          onClose = fn;
        },
        close: () => undefined,
      };
    }, [10]);
    runtimesInUse = runtimes;

    let uiMessages: UiMessage[] = [];
    const queues: Array<{ steering: number; followUp: number }> = [];
    runtimes.subscribe((_id, event) => {
      if (event.type === "assistant-start") uiMessages = startAssistant(uiMessages);
      else if (event.type === "retry-status") uiMessages = resetStreamingAssistant(uiMessages);
      else if (event.type === "assistant-delta") uiMessages = streamAssistant(uiMessages, { text: event.text, thinking: event.thinking });
      else if (event.type === "assistant-tool-calls") uiMessages = streamAssistant(uiMessages, { toolCalls: event.calls });
      else if (event.type === "queue") queues.push({ steering: event.steering, followUp: event.followUp });
    });

    await runtimes.start("D:/repo", "harness:s-res");
    notify?.("session/delta", { sessionId: "s-res", liveSeq: 1, delta: { type: "agent-start" } });
    notify?.("session/delta", { sessionId: "s-res", liveSeq: 2, delta: { type: "llm-start" } });
    notify?.("session/delta", { sessionId: "s-res", liveSeq: 3, delta: { type: "llm-chunk", chunk: { type: "text-delta", index: 0, text: "Par" } } });
    expect(uiMessages.at(-1)?.content).toBe("Par");

    onClose?.();
    await eventually(() => connCount >= 2 && queues.length > 0);
    expect(uiMessages.at(-1)?.content).toBe("Partial");
    expect(queues.at(-1)).toEqual({ steering: 0, followUp: 1 });

    // Stale liveSeq 5 is dropped, liveSeq 6 appends smoothly.
    notify?.("session/delta", { sessionId: "s-res", liveSeq: 5, delta: { type: "llm-chunk", chunk: { type: "text-delta", index: 0, text: "dup" } } });
    notify?.("session/delta", { sessionId: "s-res", liveSeq: 6, delta: { type: "llm-chunk", chunk: { type: "text-delta", index: 0, text: "!" } } });
    expect(uiMessages.at(-1)?.content).toBe("Partial!");
  });

  it("replays mid-stream against a real Host and joins live deltas without dropping or duplicating text", async () => {
    const slowReply = [
      { type: "text-delta" as const, index: 0, text: "Alpha " },
      { type: "text-delta" as const, index: 0, text: "Beta" },
      { type: "finish" as const, reason: "stop" as const },
    ];
    const provider = new ScriptedProvider([slowReply], { chunkDelayMs: 120 });
    const { runtimes, until } = await start(provider);
    const first = await runtimes.start(dir);
    await runtimes.prompt(first.runtimeId, { message: "stream", images: [] });
    await until((event) => event.type === "assistant-delta");

    const sessionFile = String((await runtimes.state(first.runtimeId)).sessionFile);
    const second = await runtimes.start(dir, sessionFile);
    const secondDeltas: string[] = [];
    let secondDone = false;
    runtimes.subscribe((id, event) => {
      if (id !== second.runtimeId) return;
      if (event.type === "assistant-delta") secondDeltas.push(event.text);
      if (event.type === "turn-end") secondDone = true;
    });

    let replayed = await runtimes.messages(second.runtimeId);
    await eventually(() => secondDone);
    for (const text of secondDeltas) {
      replayed = streamAssistant(replayed, { text });
    }
    expect(replayed.find((m) => m.role === "assistant")?.content).toBe("Alpha Beta");
  });

  it("syncSession fetches messages after bindSession and clears stale pre-snapshot pending deltas", async () => {
    vi.stubGlobal("window", globalThis);
    const callOrder: string[] = [];
    let releaseBind: (() => void) | undefined;
    const bindGate = new Promise<void>((resolve) => {
      releaseBind = resolve;
    });

    let state: Partial<AppState> = {
      runtimeId: "harness:r1",
      cwd: "D:/repo",
      sessionFile: "harness:s1",
      sessionId: "s1",
      model: { id: "m", name: "M", provider: "p" },
      thinkingLevel: "medium",
      settings: null,
      messages: [],
      runtimes: {
        "harness:r1": {
          runtimeId: "harness:r1",
          cwd: "D:/repo",
          sessionFile: "harness:s1",
          isStreaming: true,
          status: "running",
          extensionRequest: null,
          updatedAt: 0,
        },
      },
      appendLog: () => undefined,
    };

    const setState = (updater: Partial<AppState> | ((prev: AppState) => Partial<AppState>)) => {
      const patch = typeof updater === "function" ? updater(state as AppState) : updater;
      state = { ...state, ...patch };
    };
    const getState = () => state as AppState;
    const ctx = new StoreContext(setState as never, getState as never);

    vi.spyOn(harnessRuntimes, "state").mockImplementation(async () => {
      callOrder.push("state");
      return { sessionFile: "harness:s1", sessionId: "s1", isStreaming: true, isCompacting: false };
    });
    vi.spyOn(harnessRuntimes, "models").mockResolvedValue([]);
    vi.spyOn(harnessRuntimes, "commands").mockResolvedValue([]);
    vi.spyOn(harnessRuntimes, "stats").mockResolvedValue({
      userMessages: 0,
      assistantMessages: 0,
      toolCalls: 0,
      toolResults: 0,
      totalMessages: 0,
      tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      cost: 0,
    });
    vi.spyOn(agent, "bindSession").mockImplementation(async () => {
      callOrder.push("bindSession:start");
      await bindGate;
      callOrder.push("bindSession:end");
    });
    vi.spyOn(harnessRuntimes, "messages").mockImplementation(async () => {
      callOrder.push("messages");
      return [{ id: "snap-1", role: "assistant", content: "Snapshot", isStreaming: true, timestamp: 1 }];
    });

    const syncing = ctx.syncSession(ctx.connectionVersion, false);
    await eventually(() => callOrder.includes("bindSession:start"));
    expect(callOrder).not.toContain("messages");

    // Pre-snapshot delta queued before messages() finishes must NOT clobber restoredMessages after timer fires.
    ctx.queueAssistantDelta("harness:r1", { text: "STALE " });
    releaseBind?.();
    await syncing;
    expect(callOrder.indexOf("bindSession:end")).toBeLessThan(callOrder.indexOf("messages"));

    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(state.messages).toEqual([{ id: "snap-1", role: "assistant", content: "Snapshot", isStreaming: true, timestamp: 1 }]);

    // Subsequent live deltas append cleanly after snapshot commit.
    ctx.queueAssistantDelta("harness:r1", { text: " + live" });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(state.messages?.[0]?.content).toBe("Snapshot + live");
  });

  it("prevents buffered delta timers from resurrecting streaming after abort, clears ui/cancel, and avoids suppressManagedDrainFor leaks", async () => {
    vi.stubGlobal("window", globalThis);
    const { useAppStore } = await import("../src/store/index.ts");
    const prev = useAppStore.getState();

    const runtimeId = "harness:abort-test";
    const promptCalls: string[] = [];
    vi.spyOn(harnessRuntimes, "abort").mockResolvedValue(undefined);
    vi.spyOn(harnessRuntimes, "prompt").mockImplementation(async (_id, input) => {
      promptCalls.push(input.message);
    });

    try {
      useAppStore.setState({
        runtimeId,
        cwd: "D:/repo",
        sessionFile: "harness:s-abort",
        sessionId: "s-abort",
        isStreaming: true,
        isCompacting: true,
        retryStatus: null,
        steeringQueue: [""],
        followUpQueue: [""],
        managedFollowUpQueue: [],
        extensionRequest: { type: "extension_ui_request", id: "ui-1", method: "confirm", title: "Allow?", message: "Run bash?" },
        messages: [
          { id: "u1", role: "user", content: "turn 1", timestamp: 1 },
          { id: "a1", role: "assistant", content: "ok", isStreaming: false, timestamp: 2 },
          { id: "u2", role: "user", content: "turn 2", timestamp: 3 },
          {
            id: "a2",
            role: "assistant",
            content: "Working",
            isStreaming: true,
            toolCalls: [{ id: "tc-1", name: "bash", args: {}, running: true }],
            timestamp: 4,
          },
        ],
        runtimes: {
          [runtimeId]: {
            runtimeId,
            cwd: "D:/repo",
            sessionFile: "harness:s-abort",
            isStreaming: true,
            status: "running",
            extensionRequest: { type: "extension_ui_request", id: "ui-1", method: "confirm", title: "Allow?", message: "Run bash?" },
            updatedAt: 1,
          },
        },
      });

      // Queue a delta whose 32ms timer is pending, then immediately abort.
      useAppStore.getState().handleEvent(runtimeId, { type: "assistant-delta", text: " late chunk", thinking: "" });
      useAppStore.getState().handleEvent(runtimeId, { type: "ui-cancel", requestId: "ui-1" });
      expect(useAppStore.getState().extensionRequest).toBeNull();

      await useAppStore.getState().abort();
      await new Promise((resolve) => setTimeout(resolve, 60));

      const afterAbort = useAppStore.getState();
      expect(afterAbort.isStreaming).toBe(false);
      expect(afterAbort.isCompacting).toBe(false);
      expect(afterAbort.retryStatus).toBeNull();
      expect(afterAbort.steeringQueue).toEqual([]);
      expect(afterAbort.followUpQueue).toEqual([]);
      expect(afterAbort.messages.at(-1)).toMatchObject({
        id: "a2",
        content: "Working",
        isStreaming: false,
        isAborted: true,
        toolCalls: [{ id: "tc-1", running: false, isError: true }],
      });

      // Because managedFollowUpQueue was empty during abort(), suppressManagedDrainFor must not suppress the next turn's follow-up.
      useAppStore.getState().handleEvent(runtimeId, { type: "turn-start" });
      await useAppStore.getState().sendMessage("queued after", [], "followUp");
      useAppStore.getState().handleEvent(runtimeId, { type: "turn-end" });
      await eventually(() => promptCalls.includes("queued after"));
    } finally {
      useAppStore.setState({
        runtimeId: prev.runtimeId,
        cwd: prev.cwd,
        sessionFile: prev.sessionFile,
        sessionId: prev.sessionId,
        isStreaming: prev.isStreaming,
        isCompacting: prev.isCompacting,
        retryStatus: prev.retryStatus,
        steeringQueue: prev.steeringQueue,
        followUpQueue: prev.followUpQueue,
        managedFollowUpQueue: prev.managedFollowUpQueue,
        extensionRequest: prev.extensionRequest,
        messages: prev.messages,
        runtimes: prev.runtimes,
      });
    }
  });
});

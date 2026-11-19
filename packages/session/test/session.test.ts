import { Context } from "@deepseek-ai/cordis";
import { describe, expect, it } from "vitest";
import {
  BRANCH_SUMMARY_PREFIX,
  COMPACTION_CONTINUE_SUFFIX,
  COMPACTION_PREFIX,
  CONTINUATION_NAMESPACE,
  INTERRUPTED_TOOL_RESULT,
  MemoryStorage,
  Sessions,
  charTokens,
  compactionPoint,
  currentBranch,
  deriveState,
  estimateEventTokens,
  forkEvents,
  hasVisibleProse,
  sessionMarkdown,
  settledSeq,
  slidingCompactionPoint,
  stripLeadingInlineThink,
  summarize,
  uuidv7,
  type SessionEvent,
} from "../src/index.ts";

let seq = 0;
function ev<T extends SessionEvent["type"]>(type: T, data: Extract<SessionEvent, { type: T }>["data"]): SessionEvent {
  seq += 1;
  return { seq, ts: "t", type, data } as SessionEvent;
}
const text = (value: string) => [{ type: "text" as const, text: value }];
const usage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };
const model = { provider: "p", model: "m" };
const assistant = (content: Extract<SessionEvent, { type: "assistant" }>["data"]["content"]) =>
  ev("assistant", { content, model, usage, stop: "stop" });

function log(build: () => SessionEvent[]): SessionEvent[] {
  seq = 0;
  return build();
}

describe("derivation", () => {
  it("follows rewinds to the current branch", () => {
    const events = log(() => [
      ev("user", { content: text("a") }),       // 1
      assistant(text("A")),                       // 2
      ev("user", { content: text("b") }),       // 3
      assistant(text("B")),                       // 4
      ev("rewind", { toSeq: 2 }),                 // 5
      ev("user", { content: text("c") }),       // 6
    ]);
    expect(currentBranch(events).map((event) => event.seq)).toEqual([1, 2, 6]);
    expect(deriveState(events).messages).toEqual([
      { role: "user", content: text("a") },
      { role: "assistant", content: text("A") },
      { role: "user", content: text("c") },
    ]);
  });

  it("replaces compacted events with the summary", () => {
    const events = log(() => [
      ev("model", model),
      ev("user", { content: text("old") }),
      assistant(text("OLD")),
      ev("user", { content: text("new") }),
      ev("compaction", { throughSeq: 3, summary: "S" }),
      assistant(text("NEW")),
    ]);
    const state = deriveState(events);
    expect(state.model).toEqual(model);
    expect(state.compactedThrough).toBe(5);
    expect(state.messages).toEqual([
      { role: "user", content: text(`${COMPACTION_PREFIX}S`) },
      { role: "user", content: text("new") },
      { role: "assistant", content: text("NEW") },
    ]);
  });

  it("appends COMPACTION_CONTINUE_SUFFIX for mid-run compactions with no trailing user turn", () => {
    const events = log(() => [
      ev("model", model),
      ev("user", { content: text("fix bug") }),
      assistant(text("Inspecting...")),
      ev("compaction", { throughSeq: 3, summary: "S" }),
    ]);
    expect(deriveState(events).messages).toEqual([
      { role: "user", content: text(`${COMPACTION_PREFIX}S${COMPACTION_CONTINUE_SUFFIX}`) },
    ]);
  });

  it("skips thinking-only and errored non-tool assistant replies while keeping thinking tool calls", () => {
    const events = log(() => [
      ev("user", { content: text("go") }),
      assistant([{ type: "thinking", text: "silent thought" }]),
      ev("assistant", { content: text("partial error"), model, usage, stop: "error" }),
      assistant([{ type: "thinking", text: "plan" }, { type: "tool-call", id: "c1", name: "read", arguments: {} }]),
      ev("tool-result", { callId: "c1", name: "read", content: text("ok"), isError: false }),
    ]);
    expect(deriveState(events).messages).toEqual([
      { role: "user", content: text("go") },
      { role: "assistant", content: [{ type: "thinking", text: "plan" }, { type: "tool-call", id: "c1", name: "read", arguments: {} }] },
      { role: "tool-result", callId: "c1", content: text("ok"), isError: false },
    ]);
  });

  it("derives CONTINUATION_NAMESPACE custom events into user messages without inflating summarize", () => {
    const events = log(() => [
      ev("user", { content: text("start") }),
      assistant(text("half")),
      ev("custom", { ns: CONTINUATION_NAMESPACE, data: { reason: "length", text: "Continue." } }),
    ]);
    expect(deriveState(events).messages).toEqual([
      { role: "user", content: text("start") },
      { role: "assistant", content: text("half") },
      { role: "user", content: text("Continue.") },
    ]);
    // Merges into immediately preceding user turn when assistant reply was skipped
    const merged = log(() => [
      ev("user", { content: text("start") }),
      assistant([{ type: "thinking", text: "only thinking" }]),
      ev("custom", { ns: CONTINUATION_NAMESPACE, data: { reason: "empty", text: "Retry." } }),
    ]);
    expect(deriveState(merged).messages).toEqual([
      { role: "user", content: [...text("start"), ...text("\n\nRetry.")] },
    ]);
    const summary = summarize({ format: "pid.session", version: 1, id: "s", createdAt: "c", cwd: "/w" }, events);
    expect(summary.messageCount).toBe(2);
  });

  it("closes tool calls that never got a result and skips empty replies", () => {
    const events = log(() => [
      ev("user", { content: text("go") }),
      assistant([{ type: "tool-call", id: "c1", name: "read", arguments: {} }]),
      ev("tool-call", { callId: "c1", name: "read", args: {} }),
      assistant([]),
      ev("tool-result", { callId: "stray", name: "x", content: text("ignored"), isError: false }),
    ]);
    expect(deriveState(events).messages).toEqual([
      { role: "user", content: text("go") },
      { role: "assistant", content: [{ type: "tool-call", id: "c1", name: "read", arguments: {} }] },
      { role: "tool-result", callId: "c1", content: text(INTERRUPTED_TOOL_RESULT), isError: true },
    ]);
  });

  it("tracks effort, title and archive labels", () => {
    const state = deriveState(log(() => [
      ev("effort", { effort: "high" }),
      ev("label", { title: "T" }),
      ev("label", { archived: true }),
    ]));
    expect(state).toMatchObject({ effort: "high", title: "T", archived: true });
  });

  it("forks the branch renumbered, moving compaction points", () => {
    const events = log(() => [
      ev("user", { content: text("x") }),        // 1
      assistant(text("dropped")),                  // 2
      ev("rewind", { toSeq: 1 }),                  // 3
      assistant(text("kept")),                     // 4
      ev("compaction", { throughSeq: 4, summary: "S" }), // 5
      ev("user", { content: text("y") }),        // 6
    ]);
    const forked = forkEvents(events, 5);
    expect(forked.map((event) => [event.seq, event.type])).toEqual([[1, "user"], [2, "assistant"], [3, "compaction"]]);
    expect(forked[2]?.data).toEqual({ throughSeq: 2, summary: "S" });
  });

  it("finds where a side chat can start without a dangling tool call", () => {
    const events = log(() => [
      ev("user", { content: text("a") }),                                     // 1
      assistant(text("A")),                                                    // 2
      ev("tool-call", { callId: "c", name: "bash", args: {} }),               // 3
      ev("tool-result", { callId: "c", name: "bash", content: [], isError: false }), // 4
      ev("tool-call", { callId: "d", name: "bash", args: {} }),               // 5
    ]);
    expect(settledSeq(events, 5)).toBe(4);
    expect(settledSeq(events, 3)).toBe(2);
    expect(settledSeq(events, 1)).toBe(1);
  });

  it("finds the compaction point", () => {
    const events = log(() => [
      ev("model", model),
      ev("user", { content: text("1") }),
      assistant(text("A")),
      ev("user", { content: text("2") }),
      assistant(text("B")),
    ]);
    expect(compactionPoint(events)).toBe(5);
    expect(compactionPoint(events, true)).toBe(3);
    expect(compactionPoint(events.slice(0, 3), true)).toBe(3);
  });
});

describe("summaries", () => {
  it("count messages and tokens across rewinds and clip the first message", () => {
    const events = log(() => [
      ev("user", { content: text(`  first

 line ${"x".repeat(300)}`) }),
      ev("assistant", { content: text("A"), model, usage: { inputTokens: 10, outputTokens: 5, cacheReadTokens: 2, cacheWriteTokens: 0 }, stop: "stop" }),
      ev("rewind", { toSeq: 1 }),
      ev("assistant", { content: text("B"), model, usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 3 }, stop: "stop" }),
    ]);
    const summary = summarize({ format: "pid.session", version: 1, id: "s", createdAt: "c", cwd: "/w" }, events);
    expect(summary.firstMessage).toBe(`first line ${"x".repeat(189)}`);
    expect(summary.messageCount).toBe(3);
    expect(summary.usage).toEqual({ inputTokens: 11, outputTokens: 6, cacheReadTokens: 2, cacheWriteTokens: 3 });
  });

  it("updates firstMessage when the initial user message is rewound to seq 0", () => {
    const header = { format: "pid.session" as const, version: 1, id: "s", createdAt: "c", cwd: "/w" };
    const rewoundEmpty = log(() => [
      ev("user", { content: text("discarded first prompt") }),
      ev("rewind", { toSeq: 0 }),
    ]);
    expect(summarize(header, rewoundEmpty)).toMatchObject({ messageCount: 1 });
    expect(summarize(header, rewoundEmpty).firstMessage).toBeUndefined();

    const rewoundReplaced = [
      ...rewoundEmpty,
      { seq: 3, ts: "t", type: "user" as const, data: { content: text("replacement first prompt") } },
    ];
    expect(summarize(header, rewoundReplaced)).toMatchObject({
      firstMessage: "replacement first prompt",
      messageCount: 2,
    });
  });

  it("tracks updatedAt from conversation activity events while ignoring label, model, and effort changes", () => {
    const header = { format: "pid.session" as const, version: 1, id: "s-ts", createdAt: "2026-01-01T00:00:00.000Z", cwd: "/w" };
    const metadataOnly: SessionEvent[] = [
      { seq: 1, ts: "2026-01-02T00:00:00.000Z", type: "model", data: model },
      { seq: 2, ts: "2026-01-02T00:01:00.000Z", type: "effort", data: { effort: "high" } },
      { seq: 3, ts: "2026-01-02T00:02:00.000Z", type: "label", data: { title: "Renamed" } },
    ];
    expect(summarize(header, metadataOnly)).toMatchObject({
      updatedAt: "2026-01-01T00:00:00.000Z",
      lastSeq: 3,
    });

    const withActivity: SessionEvent[] = [
      { seq: 1, ts: "2026-01-02T10:00:00.000Z", type: "user", data: { content: text("hi") } },
      { seq: 2, ts: "2026-01-02T10:01:00.000Z", type: "assistant", data: { content: text("hello"), model, usage, stop: "stop" } },
      { seq: 3, ts: "2026-01-03T12:00:00.000Z", type: "compaction", data: { throughSeq: 2, summary: "sum" } },
      { seq: 4, ts: "2026-01-04T12:00:00.000Z", type: "rewind", data: { toSeq: 2 } },
      { seq: 5, ts: "2026-01-10T00:00:00.000Z", type: "label", data: { title: "Custom" } },
      { seq: 6, ts: "2026-01-10T00:05:00.000Z", type: "label", data: { archived: true } },
      { seq: 7, ts: "2026-01-10T00:06:00.000Z", type: "model", data: model },
      { seq: 8, ts: "2026-01-10T00:07:00.000Z", type: "effort", data: { effort: "low" } },
    ];
    expect(summarize(header, withActivity)).toMatchObject({
      updatedAt: "2026-01-04T12:00:00.000Z",
      lastSeq: 8,
    });
  });
});

describe("sessions service", () => {
  it("unloads a session nobody holds once it is idle, and loads it again", async () => {
    const ctx = new Context();
    await ctx.plugin(Sessions);
    const unloaded: string[] = [];
    const deleted: string[] = [];
    ctx.on("session/unloaded", (id) => void unloaded.push(id));
    ctx.on("session/deleted", (id) => void deleted.push(id));
    const later = () => Date.now() + ctx.sessions.idleMs + 1;

    const a = ctx.sessions.create({ cwd: "." });
    a.append("user", { content: text("hi") });
    const b = ctx.sessions.create({ cwd: "." });
    const release = ctx.sessions.hold(b.id);
    expect(ctx.sessions.sweep()).toEqual([]);
    expect(ctx.sessions.sweep(later())).toEqual([a.id]);
    expect(unloaded).toEqual([a.id]);
    expect(ctx.sessions.loaded).toBe(1);

    const again = await ctx.sessions.get(a.id);
    expect(again).not.toBe(a);
    expect(again?.events).toEqual(a.events);
    release();
    release();
    expect(ctx.sessions.sweep(later()).sort()).toEqual([a.id, b.id].sort());

    await ctx.sessions.delete(a.id);
    expect(deleted).toEqual([a.id]);
    await ctx.fiber.dispose();
  });

  it("appends, emits and forks", async () => {
    const ctx = new Context();
    await ctx.plugin(Sessions);
    const seen: number[] = [];
    ctx.on("session/event", (_session, event) => void seen.push(event.seq));
    const session = ctx.sessions.create({ cwd: "/w" });
    session.append("user", { content: text("hi") });
    session.append("label", { title: "Greeting" });
    expect(seen).toEqual([1, 2]);
    expect(session.summary()).toMatchObject({ id: session.id, cwd: "/w", title: "Greeting", firstMessage: "hi", lastSeq: 2, archived: false, messageCount: 1 });

    const fork = ctx.sessions.fork(session, 1);
    expect(fork.header.forkedFrom).toEqual({ sessionId: session.id, seq: 1 });
    expect(fork.events.map((event) => event.type)).toEqual(["user"]);
    expect(await ctx.sessions.get(fork.id)).toBe(fork);
    expect((await ctx.sessions.list()).map((summary) => summary.id).sort()).toEqual([session.id, fork.id].sort());
    expect(await ctx.sessions.get("nope")).toBeUndefined();
    await ctx.fiber.dispose();
  });

  it("numbers live deltas apart from events", async () => {
    const ctx = new Context();
    await ctx.plugin(Sessions);
    const session = ctx.sessions.create({ cwd: "/w" });
    const live: number[] = [];
    ctx.on("session/delta", (_session, liveSeq) => void live.push(liveSeq));
    session.delta({ type: "a" });
    session.delta({ type: "b" });
    expect(live).toEqual([1, 2]);
    expect(session.lastSeq).toBe(0);
    await ctx.fiber.dispose();
  });

  it("makes time-ordered v7 ids", () => {
    const a = uuidv7(1_000);
    const b = uuidv7(2_000);
    expect(a).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(a < b).toBe(true);
  });

  it("preserves open sessions and adopts events seamlessly across storage plugin hot-swaps", async () => {
    const ctx = new Context();
    await ctx.plugin(Sessions);
    const session = ctx.sessions.create({ cwd: "/live" });
    session.append("user", { content: text("before-storage") });

    const externalStore = new MemoryStorage();
    const unregister = ctx.sessions.registerStorage(externalStore);

    // Active session instance stays identical (not cleared!) and was adopted into externalStore.
    expect(await ctx.sessions.get(session.id)).toBe(session);
    expect((await externalStore.load(session.id))?.events.map((e) => e.seq)).toEqual([1]);

    session.append("user", { content: text("during-storage") });
    expect((await externalStore.load(session.id))?.events.map((e) => e.seq)).toEqual([1, 2]);

    // Unregistering externalStore keeps the active session intact in fallback MemoryStorage.
    unregister();
    expect(await ctx.sessions.get(session.id)).toBe(session);
    expect(session.events.map((e) => e.seq)).toEqual([1, 2]);
    await ctx.fiber.dispose();
  });

  it("fallback search scans active branch messages and compactions without matching rewound branches or COMPACTION_PREFIX", async () => {
    const ctx = new Context();
    await ctx.plugin(Sessions);
    const session = ctx.sessions.create({ cwd: "/search" });
    session.append("user", { content: text("RootPrompt1") });
    const keptReply = session.append("assistant", {
      content: text("PreCompactionReplyToken2"),
      model: { provider: "p", model: "m" },
      stop: "stop",
      usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 },
    });
    session.append("user", { content: text("RewoundDeadEnd3") });
    session.append("rewind", { toSeq: keptReply.seq });
    session.append("compaction", { throughSeq: keptReply.seq, summary: "CompactedSummaryToken4" });
    session.append("user", { content: text("PostCompactionPrompt5") });

    expect(await ctx.sessions.search("RewoundDeadEnd3")).toEqual([]);
    expect(await ctx.sessions.search("conversation so far was compacted")).toEqual([]);
    expect((await ctx.sessions.search("PreCompactionReplyToken2")).map((h) => h.session.id)).toEqual([session.id]);
    expect((await ctx.sessions.search("CompactedSummaryToken4")).map((h) => h.session.id)).toEqual([session.id]);
    expect((await ctx.sessions.search("PostCompactionPrompt5")).map((h) => h.session.id)).toEqual([session.id]);
    await ctx.fiber.dispose();
  });

  it("sets initial and updated model and effort via Session and Sessions helpers", async () => {
    const ctx = new Context();
    await ctx.plugin(Sessions);
    const session = ctx.sessions.create({
      cwd: "/w",
      model: { provider: "deepseek", model: "deepseek-chat" },
      effort: "medium",
    });
    expect(session.state().model).toEqual({ provider: "deepseek", model: "deepseek-chat" });
    expect(session.state().effort).toBe("medium");

    session.setModel({ provider: "openai", model: "gpt-5" });
    session.setEffort("high");
    expect(session.state().model).toEqual({ provider: "openai", model: "gpt-5" });
    expect(session.state().effort).toBe("high");

    await ctx.sessions.setModel(session.id, { provider: "anthropic", model: "claude-sonnet-4-6" });
    await ctx.sessions.setEffort(session.id, "low");
    expect(session.state().model).toEqual({ provider: "anthropic", model: "claude-sonnet-4-6" });
    expect(session.state().effort).toBe("low");

    await expect(ctx.sessions.setModel("missing-session", { provider: "p", model: "m" })).rejects.toThrow("No session missing-session");
    await expect(ctx.sessions.setEffort("missing-session", "high")).rejects.toThrow("No session missing-session");
    await ctx.fiber.dispose();
  });

  it("injects branchSummary notes cleanly, clears superseded notes on earlier rewinds, and preserves them on fork", () => {
    const model = { provider: "p", model: "m" };
    const usage = { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 };
    seq = 0;
    const u1 = ev("user", { content: text("Start") });
    const a1 = ev("assistant", { content: [{ type: "tool-call", id: "c1", name: "read", arguments: { path: "a.ts" } }], model, stop: "tool-use", usage });
    const tr1 = ev("tool-result", { callId: "c1", name: "read", content: text("file-a"), isError: false });
    const uDead = ev("user", { content: text("Dead end path") });
    const aDead = ev("assistant", { content: text("Failed attempt"), model, stop: "stop", usage });
    const rw1 = ev("rewind", { toSeq: tr1.seq, branchSummary: "Approach A failed after reading a.ts." });
    const u2 = ev("user", { content: text("Next path") });

    const events = [u1, a1, tr1, uDead, aDead, rw1, u2];
    const state = deriveState(events);
    expect(state.messages.map((m) => m.role)).toEqual(["user", "assistant", "tool-result", "user", "user"]);
    expect(state.messages[3]).toEqual({ role: "user", content: text(`${BRANCH_SUMMARY_PREFIX}Approach A failed after reading a.ts.`) });
    expect(state.messages[4]).toEqual({ role: "user", content: text("Next path") });

    // Never splits a tool-call from its tool-result if a rewind points at the assistant tool-call itself.
    seq = 0;
    const x1 = ev("user", { content: text("U") });
    const x2 = ev("assistant", { content: [{ type: "tool-call", id: "tc", name: "read", arguments: {} }], model, stop: "tool-use", usage });
    const xRw = ev("rewind", { toSeq: x2.seq, branchSummary: "Deferred until tool-result closes." });
    const x3 = ev("tool-result", { callId: "tc", name: "read", content: text("ok"), isError: false });
    const unsplit = deriveState([x1, x2, xRw, x3]);
    expect(unsplit.messages.map((m) => m.role)).toEqual(["user", "assistant", "tool-result", "user"]);
    expect(unsplit.messages[3]).toEqual({ role: "user", content: text(`${BRANCH_SUMMARY_PREFIX}Deferred until tool-result closes.`) });

    // Forking preserves active branch summaries at renumbered anchor positions.
    const forked = forkEvents(events, u2.seq);
    expect(deriveState(forked).messages).toEqual(state.messages);

    // Rewinding further back than an earlier rewind discards its descendant note.
    const rwRoot = ev("rewind", { toSeq: u1.seq, branchSummary: "Root restart summary." });
    const rewoundBack = deriveState([...events, rwRoot]);
    expect(rewoundBack.messages).toEqual([
      { role: "user", content: text("Start") },
      { role: "user", content: text(`${BRANCH_SUMMARY_PREFIX}Root restart summary.`) },
    ]);
  });

  it("slidingCompactionPoint keeps newest complete steps within token budget and falls back cleanly", () => {
    const model = { provider: "p", model: "m" };
    const usage = { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 };
    const chunk400 = "x".repeat(400); // ~100 tokens
    seq = 0;
    const u1 = ev("user", { content: text(`turn1-${chunk400}`) });
    const a1 = ev("assistant", { content: text(`ans1-${chunk400}`), model, stop: "stop", usage });
    const u2 = ev("user", { content: text(`turn2-${chunk400}`) });
    const a2 = ev("assistant", { content: [{ type: "tool-call", id: "c2", name: "read", arguments: { text: chunk400 } }], model, stop: "tool-use", usage });
    const tr2 = ev("tool-result", { callId: "c2", name: "read", content: text(`res2-${chunk400}`), isError: false });
    const u3 = ev("user", { content: text(`turn3-${chunk400}`) });
    const a3 = ev("assistant", { content: text(`ans3-${chunk400}`), model, stop: "stop", usage });
    const all = [u1, a1, u2, a2, tr2, u3, a3];

    // Budget enough only for unit 3 (u3+a3 ~204 tokens): cuts right after tr2 (keeps u3+a3)
    expect(slidingCompactionPoint(all, 260)).toBe(tr2.seq);
    // Larger budget keeps unit 2 (u2+a2+tr2) AND unit 3 intact without splitting a2/tr2
    expect(slidingCompactionPoint(all, 650)).toBe(a1.seq);
    // Tiny budget where even newest unit doesn't fit falls back to full compactionPoint(events, false)
    expect(slidingCompactionPoint(all, 10)).toBe(a3.seq);
    // Single-step log falls back to compactionPoint(events, false)
    expect(slidingCompactionPoint([u1, a1], 10_000)).toBe(a1.seq);
  });
});

describe("CJK token estimation & session hygiene", () => {
  it("weights ASCII chars at 0.25 tokens and non-ASCII/CJK chars at 0.75 tokens", () => {
    expect(charTokens("abcd")).toBe(1);
    expect(charTokens("你好世界")).toBe(3);
    expect(charTokens("ab你好")).toBe(2);

    const asciiUser = ev("user", { content: text("a".repeat(400)) });
    const cjkUser = ev("user", { content: text("中".repeat(400)) });
    expect(estimateEventTokens(cjkUser)).toBeGreaterThan(estimateEventTokens(asciiUser) * 2);

    const cjkEvents = log(() => {
      const u1 = ev("user", { content: text("中".repeat(200)) });
      const a1 = assistant(text("文".repeat(200)));
      const u2 = ev("user", { content: text("测".repeat(200)) });
      const a2 = assistant(text("试".repeat(200)));
      return [u1, a1, u2, a2];
    });
    const cjkCut = slidingCompactionPoint(cjkEvents, 350);
    expect(cjkCut).toBe(cjkEvents[1].seq);
  });

  it("infers ThinkingBlock signatureProvider from model and preserves explicit or generic values", () => {
    const events = log(() => [
      ev("user", { content: text("think") }),
      ev("assistant", {
        content: [
          { type: "thinking", text: "gem", signature: "g-sig" },
          { type: "thinking", text: "kept", signature: "k-sig", signatureProvider: "custom" },
          { type: "thinking", text: "nosig" },
          { type: "text", text: "done-gem" },
        ],
        model: { provider: "google", model: "gemini-2.5-pro" },
        usage,
        stop: "stop",
      }),
      ev("assistant", {
        content: [
          { type: "thinking", text: "claude", signature: "a-sig" },
          { type: "text", text: "done-claude" },
        ],
        model: { provider: "bedrock", model: "claude-sonnet-4" },
        usage,
        stop: "stop",
      }),
      ev("assistant", {
        content: [
          { type: "thinking", text: "generic", signature: "m-sig" },
          { type: "text", text: "done-generic" },
        ],
        model,
        usage,
        stop: "stop",
      }),
    ]);

    const state = deriveState(events);
    expect(state.messages).toHaveLength(4);
    const gemMsg = state.messages[1];
    expect(gemMsg?.role).toBe("assistant");
    if (gemMsg?.role === "assistant") {
      expect(gemMsg.content[0]).toMatchObject({ type: "thinking", signatureProvider: "gemini" });
      expect(gemMsg.content[1]).toMatchObject({ type: "thinking", signatureProvider: "custom" });
      expect(gemMsg.content[2]).toEqual({ type: "thinking", text: "nosig" });
    }
    const claudeMsg = state.messages[2];
    if (claudeMsg?.role === "assistant") {
      expect(claudeMsg.content[0]).toMatchObject({ type: "thinking", signatureProvider: "anthropic" });
    }
    const genericMsg = state.messages[3];
    if (genericMsg?.role === "assistant") {
      expect(genericMsg.content[0]).toEqual({ type: "thinking", text: "generic", signature: "m-sig" });
    }
  });

  it("drops orphan __invalidJson tool-call blocks on stop=error while preserving valid or paired calls", () => {
    const events = log(() => [
      ev("user", { content: text("run") }),
      // Only a broken orphan __invalidJson tool-call on stop=error -> entire assistant message dropped
      ev("assistant", {
        content: [{ type: "tool-call", id: "bad-only", name: "bash", arguments: { __invalidJson: "{bad" } }],
        model,
        usage,
        stop: "error",
      }),
      // Text + broken orphan on stop=error -> broken tool-call dropped, partial non-tool error reply skipped
      ev("assistant", {
        content: [
          { type: "text", text: "partial text" },
          { type: "tool-call", id: "bad-with-text", name: "bash", arguments: { __invalidJson: "{partial" } },
        ],
        model,
        usage,
        stop: "error",
      }),
      // Valid tool-call + broken orphan on stop=error -> valid tool-call kept, orphan dropped
      ev("assistant", {
        content: [
          { type: "tool-call", id: "valid-on-err", name: "bash", arguments: { cmd: "pwd" } },
          { type: "tool-call", id: "bad-sibling", name: "bash", arguments: { __invalidJson: "{broken" } },
        ],
        model,
        usage,
        stop: "error",
      }),
      ev("tool-result", {
        callId: "valid-on-err",
        name: "bash",
        content: text("/work"),
        isError: false,
      }),
      // Paired __invalidJson tool-call + non-error stop __invalidJson -> both kept
      ev("assistant", {
        content: [{ type: "tool-call", id: "paired-bad", name: "bash", arguments: { __invalidJson: "{ok" } }],
        model,
        usage,
        stop: "error",
      }),
      ev("tool-result", {
        callId: "paired-bad",
        name: "bash",
        content: text("error output"),
        isError: true,
      }),
      ev("assistant", {
        content: [{ type: "tool-call", id: "non-error-bad", name: "bash", arguments: { __invalidJson: "{tooluse" } }],
        model,
        usage,
        stop: "tool-use",
      }),
      ev("tool-result", {
        callId: "non-error-bad",
        name: "bash",
        content: text("tool-use output"),
        isError: false,
      }),
    ]);

    const state = deriveState(events);
    expect(state.messages.map((m) => m.role)).toEqual([
      "user",
      "assistant",
      "tool-result",
      "assistant",
      "tool-result",
      "assistant",
      "tool-result",
    ]);
    const validErrMsg = state.messages[1];
    if (validErrMsg?.role === "assistant") {
      expect(validErrMsg.content).toEqual([
        { type: "tool-call", id: "valid-on-err", name: "bash", arguments: { cmd: "pwd" } },
      ]);
    }
    const pairedMsg = state.messages[3];
    if (pairedMsg?.role === "assistant") {
      expect(pairedMsg.content).toHaveLength(1);
      expect(pairedMsg.content[0]).toMatchObject({ type: "tool-call", id: "paired-bad" });
    }
    const toolUseMsg = state.messages[5];
    if (toolUseMsg?.role === "assistant") {
      expect(toolUseMsg.content).toHaveLength(1);
      expect(toolUseMsg.content[0]).toMatchObject({ type: "tool-call", id: "non-error-bad" });
    }
  });
});

describe("meta text blocks (slash command separation)", () => {
  const header = { format: "pid.session" as const, version: 1, id: "s-meta", createdAt: "2026-01-01T00:00:00.000Z", cwd: "/w" };

  it("keeps meta: true blocks in deriveState while hiding them from summarize, sessionMarkdown, and search", async () => {
    const events = log(() => [
      ev("user", {
        content: [
          { type: "text", text: "/goal 修复所有单测" },
          { type: "text", text: "SecretBoilerplateSystemExpansionToken777\n请拆解验收标准并调用 update_goal。", meta: true },
        ],
      }),
      assistant(text("好的，我立即开始检查并修复单测。")),
    ]);

    // 1. deriveState keeps both user visible command and expanded meta instructions for the LLM.
    const state = deriveState(events);
    expect(state.messages).toEqual([
      {
        role: "user",
        content: [
          { type: "text", text: "/goal 修复所有单测" },
          { type: "text", text: "SecretBoilerplateSystemExpansionToken777\n请拆解验收标准并调用 update_goal。", meta: true },
        ],
      },
      { role: "assistant", content: text("好的，我立即开始检查并修复单测。") },
    ]);

    // 2. summarize().firstMessage only shows the visible slash command, never the meta template.
    const summary = summarize(header, events);
    expect(summary.firstMessage).toBe("/goal 修复所有单测");

    // 3. sessionMarkdown() omits meta: true blocks on user messages while keeping assistant replies.
    const markdown = sessionMarkdown(events);
    expect(markdown).toBe(
      "# Qianji conversation\n\n## User\n\n/goal 修复所有单测\n\n## Assistant\n\n好的，我立即开始检查并修复单测。\n\n",
    );
    expect(markdown).not.toContain("SecretBoilerplateSystemExpansionToken777");

    // 4. Sessions.search() matches visible user command & assistant reply, never meta: true boilerplate.
    const ctx = new Context();
    await ctx.plugin(Sessions);
    const session = ctx.sessions.create({ cwd: "/meta-search" });
    session.append("user", {
      content: [
        { type: "text", text: "/goal 修复所有单测 VisibleGoalQuery888" },
        { type: "text", text: "SecretBoilerplateSystemExpansionToken777", meta: true },
      ],
    });
    session.append("assistant", {
      content: text("AssistantVisibleReply999"),
      model,
      usage,
      stop: "stop",
    });

    expect(await ctx.sessions.search("SecretBoilerplateSystemExpansionToken777")).toEqual([]);
    expect((await ctx.sessions.search("VisibleGoalQuery888")).map((h) => h.session.id)).toEqual([session.id]);
    expect((await ctx.sessions.search("AssistantVisibleReply999")).map((h) => h.session.id)).toEqual([session.id]);
    await ctx.fiber.dispose();
  });

  it("falls back to all text blocks in summarize().firstMessage only when zero non-meta text blocks exist", () => {
    const metaOnly = log(() => [
      ev("user", { content: [{ type: "text", text: "OnlyMetaFallbackPrompt", meta: true }] }),
    ]);
    expect(summarize(header, metaOnly).firstMessage).toBe("OnlyMetaFallbackPrompt");
    expect(sessionMarkdown(metaOnly)).toBe("# Qianji conversation\n\n");

    const emptyNonMetaThenReal = log(() => [
      ev("user", {
        content: [
          { type: "text", text: "   " },
          { type: "text", text: "HiddenMetaShouldNotLeak", meta: true },
        ],
      }),
      ev("user", { content: text("RealSecondTurnMessage") }),
    ]);
    expect(summarize(header, emptyNonMetaThenReal).firstMessage).toBe("RealSecondTurnMessage");

    const syntheticGoalRound = log(() => [
      ev("user", { content: [{ type: "text", text: "<goal_round>\nObjective: \"test\"\nRound: 1/256\n</goal_round>", meta: true }] }),
      ev("assistant", { content: text("working"), model, usage, stop: "stop" }),
      ev("user", { content: text("HumanFollowUp") }),
    ]);
    expect(summarize(header, syntheticGoalRound)).toMatchObject({
      firstMessage: "HumanFollowUp",
      messageCount: 2,
    });
  });
});

describe("inline <think> visibility and intra-turn tool-result continuations", () => {
  it("strips leading closed, consecutive, and unclosed <think> blocks without touching normal tags", () => {
    expect(stripLeadingInlineThink("<think>plan</think>")).toBe("");
    expect(stripLeadingInlineThink("  \n<THINK>\nstep 1\n</THINK>\n <think>step 2</think>  ")).toBe("");
    expect(stripLeadingInlineThink("<think>unclosed reasoning at stream end")).toBe("");
    expect(stripLeadingInlineThink("<think>step 1</think>\nFinal visible answer.")).toBe("Final visible answer.");
    expect(stripLeadingInlineThink("<thinking>not an inline think tag</thinking>")).toBe("<thinking>not an inline think tag</thinking>");
    expect(stripLeadingInlineThink("<div>hello</div>")).toBe("<div>hello</div>");

    expect(hasVisibleProse("<think>only thoughts</think>")).toBe(false);
    expect(hasVisibleProse("<think>unclosed thoughts")).toBe(false);
    expect(hasVisibleProse("<think></think>   ")).toBe(false);
    expect(hasVisibleProse("<think>thought</think>Visible summary")).toBe(true);
    expect(hasVisibleProse("<thinking>xml</thinking>")).toBe(true);
    expect(hasVisibleProse("a < b")).toBe(true);
  });

  it("skips inline <think>-only non-tool turns in deriveState while keeping visible prose and tool calls", () => {
    const events = log(() => [
      ev("user", { content: text("explain") }),
      assistant(text("<think>closed inline thought only</think>")),
      assistant(text("  <think>first</think>\n<think>unclosed second thought")),
      assistant([
        { type: "text", text: "<think>planning tool</think>" },
        { type: "tool-call", id: "c1", name: "read", arguments: { path: "a.ts" } },
      ]),
      ev("tool-result", { callId: "c1", name: "read", content: text("contents"), isError: false }),
      assistant(text("<think>synthesizing</think>\nHere is the explanation.")),
    ]);

    expect(deriveState(events).messages).toEqual([
      { role: "user", content: text("explain") },
      {
        role: "assistant",
        content: [
          { type: "text", text: "<think>planning tool</think>" },
          { type: "tool-call", id: "c1", name: "read", arguments: { path: "a.ts" } },
        ],
      },
      { role: "tool-result", callId: "c1", content: text("contents"), isError: false },
      { role: "assistant", content: text("<think>synthesizing</think>\nHere is the explanation.") },
    ]);
  });

  it("attaches CONTINUATION_NAMESPACE nudges after tool-result onto the tool-result message instead of adding a trailing user message", () => {
    const events = log(() => [
      ev("user", { content: text("fix issue") }),
      assistant([
        { type: "thinking", text: "Need to inspect file first." },
        { type: "tool-call", id: "c1", name: "read", arguments: { path: "index.ts" } },
      ]),
      ev("tool-result", { callId: "c1", name: "read", content: text("export const x = 1;"), isError: false }),
      // Post-tool turn emits only inline <think> (or native thinking) with no tool call -> AgentLoop appends continuation
      assistant(text("<think>Hmm, let me think more...</think>")),
      ev("custom", { ns: CONTINUATION_NAMESPACE, data: { reason: "empty", text: "Provide an answer or call the next tool." } }),
      // Even a second consecutive empty retry stays attached to the tool-result without creating a synthetic user turn
      assistant([{ type: "thinking", text: "Still thinking..." }]),
      ev("custom", { ns: CONTINUATION_NAMESPACE, data: { reason: "empty", text: "Continue now." } }),
    ]);

    const { messages } = deriveState(events);
    expect(messages).toEqual([
      { role: "user", content: text("fix issue") },
      {
        role: "assistant",
        content: [
          { type: "thinking", text: "Need to inspect file first." },
          { type: "tool-call", id: "c1", name: "read", arguments: { path: "index.ts" } },
        ],
      },
      {
        role: "tool-result",
        callId: "c1",
        content: [
          { type: "text", text: "export const x = 1;" },
          { type: "text", text: "\n\nProvide an answer or call the next tool." },
          { type: "text", text: "\n\nContinue now." },
        ],
        isError: false,
      },
    ]);
    // Critical for OpenAI-compat reasoning_content preservation: lastUserIndex remains 0!
    expect(messages.findLastIndex((m) => m.role === "user")).toBe(0);
  });
});

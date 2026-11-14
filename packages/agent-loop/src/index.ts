/**
 * The agent loop (ADR 0008), the one place that drives a run:
 *
 *   before-start → [turn-start → model call → tools → turn-end]* → settled
 *
 * Each turn derives the context from the session log, streams one model call
 * (chunks go out as `session/delta`), appends the assistant message, then runs
 * the tools it asked for in parallel and appends their results in call order.
 * Steering messages are delivered after a turn's tools; follow-ups once the
 * model would otherwise stop. A context-length error with no output compacts
 * the whole log once and retries.
 */
import { Context, Service } from "@deepseek-ai/cordis";
import {
  AgentBusyError,
  NoModelError,
  type AgentDelta,
  type AgentStatus,
  type Agents,
  type RunOutcome,
} from "@qianji/agent";
import { BlockAssembler, type LlmRequest, type Message, type StreamChunk, type ToolCallBlock, type UserContent } from "@qianji/llm";
import { CONTINUATION_NAMESPACE, compactionPoint, deriveState, slidingCompactionPoint, type EventOf, type ModelRef, type Session } from "@qianji/session";
import "@qianji/system-prompt";
import "@qianji/tools";
import { SUMMARY_CLIP_LEVELS, shrinkForSummary } from "./summary-input.ts";

export { SUMMARY_CLIP_LEVELS, shrinkForSummary } from "./summary-input.ts";

export interface AgentLoopConfig {
  /** Model calls per run before it stops with `max-turns`. */
  maxTurns?: number;
  /**
   * Compact before a turn once the previous call used more tokens than this
   * (input, cached input and output together). Takes precedence over
   * `compactAtContextRatio`.
   */
  compactAboveTokens?: number;
  /**
   * Without `compactAboveTokens`: compact before a turn once the previous call
   * used this share of the model's context window, as the provider's model list
   * reports it (ADR 0019). Models without a known window are not compacted
   * early. Default 0.8; 0 turns it off.
   */
  compactAtContextRatio?: number;
  /** Output budget of the compaction summary call. */
  summaryMaxTokens?: number;
  /** Approximate recent tokens kept verbatim during mid-run proactive compaction (`turn >= 2`). Default `12_000`. */
  keepRecentTokens?: number;
}

export const COMPACTION_SYSTEM = `You summarize a conversation between a user and a coding agent so the agent can continue the work with only your summary as context.`;

export const COMPACTION_REQUEST = `Summarize the conversation above so the agent can seamlessly continue the active task. Structure your summary clearly:
- Current user request: state the active goal, constraints, exact file paths/symbols, and acceptance criteria;
- Completed work: files read or modified, verified findings, commands run and their key outputs;
- Remaining work & next action: what steps remain and the exact next concrete action to execute.
Be specific (paths, names, values) and concise. Reply with the summary only.`;

export const LENGTH_CONTINUATION_PROMPT =
  "Your previous response hit the output token limit and was cut off mid-generation. Continue directly from where you stopped; if you were about to call a tool, invoke it now.";

export const EMPTY_TURN_CONTINUATION_PROMPT =
  "Your previous turn produced no visible response or tool call. Either invoke the next tool needed to advance the task, or provide a clear answer to the user.";

export const MAX_LENGTH_CONTINUATIONS = 3;
export const MAX_EMPTY_CONTINUATIONS = 2;
export const MAX_PLUGIN_CONTINUATIONS = 2;

interface Run {
  controller: AbortController;
  done: Promise<void>;
  steer: UserContent[][];
  followUp: UserContent[][];
  streaming: StreamChunk[];
  runningTools: Map<string, string>;
}

const IDLE_QUEUE = { steer: 0, followUp: 0 };
const DEFAULT_COMPACT_RATIO = 0.8;
const DEFAULT_KEEP_RECENT_TOKENS = 12_000;
/** A context this small is never worth summarizing, so its model's window is not even looked up. */
const MIN_COMPACT_TOKENS = 8_192;
/** How long a model's context window is remembered, and how long its lookup may take. */
const WINDOW_TTL_MS = 10 * 60_000;
const WINDOW_LOOKUP_TIMEOUT_MS = 5_000;

function totalTokens(usage: { inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheWriteTokens: number }): number {
  return usage.inputTokens + usage.outputTokens + usage.cacheReadTokens + usage.cacheWriteTokens;
}

export class AgentLoop extends Service implements Agents {
  static inject = ["llm", "sessions", "tools", "systemPrompt"];

  private readonly runs = new Map<string, Run>();
  private readonly maxTurns: number;
  private readonly windows = new Map<string, { at: number; window: Promise<number | undefined> }>();

  constructor(ctx: Context, private readonly config: AgentLoopConfig = {}) {
    super(ctx, "agents");
    this.maxTurns = Math.max(1, config.maxTurns ?? 100);
    ctx.effect(() => () => {
      for (const run of this.runs.values()) run.controller.abort();
    }, "agent-loop: abort runs");
  }

  prompt(session: Session, content: UserContent[]): EventOf<"user"> {
    if (this.runs.has(session.id)) throw new AgentBusyError(session.id);
    if (session.state().model === undefined) throw new NoModelError(session.id);
    const event = session.append("user", { content });
    this.start(session);
    return event;
  }

  steer(session: Session, content: UserContent[]): EventOf<"user"> | undefined {
    const run = this.runs.get(session.id);
    if (run === undefined) return this.prompt(session, content);
    run.steer.push(content);
    this.queueDelta(session, run);
    return undefined;
  }

  followUp(session: Session, content: UserContent[]): EventOf<"user"> | undefined {
    const run = this.runs.get(session.id);
    if (run === undefined) return this.prompt(session, content);
    run.followUp.push(content);
    this.queueDelta(session, run);
    return undefined;
  }

  async abort(sessionId: string): Promise<void> {
    const run = this.runs.get(sessionId);
    if (run === undefined) return;
    run.steer.length = 0;
    run.followUp.length = 0;
    run.controller.abort();
    await run.done;
  }

  async compact(session: Session, signal?: AbortSignal): Promise<EventOf<"compaction"> | undefined> {
    if (this.runs.has(session.id)) throw new AgentBusyError(session.id);
    return this.summarize(session, signal ?? new AbortController().signal, "keepLatestTurn");
  }

  status(sessionId: string): AgentStatus {
    const run = this.runs.get(sessionId);
    if (run === undefined) return { running: false, streaming: [], runningTools: [], queue: { ...IDLE_QUEUE } };
    return {
      running: true,
      streaming: [...run.streaming],
      runningTools: [...run.runningTools].map(([callId, name]) => ({ callId, name })),
      queue: { steer: run.steer.length, followUp: run.followUp.length },
    };
  }

  async idle(sessionId: string): Promise<void> {
    await this.runs.get(sessionId)?.done;
  }

  private delta(session: Session, delta: AgentDelta): void {
    session.delta(delta);
  }

  private queueDelta(session: Session, run: Run): void {
    this.delta(session, { type: "queue", steer: run.steer.length, followUp: run.followUp.length });
  }

  private start(session: Session): void {
    const run: Run = {
      controller: new AbortController(),
      done: Promise.resolve(),
      steer: [],
      followUp: [],
      streaming: [],
      runningTools: new Map(),
    };
    this.runs.set(session.id, run);
    // The run keeps its Session object, so the session stays loaded until it ends.
    const release = this.ctx.sessions.hold(session.id);
    run.done = this.drive(session, run).finally(release);
  }

  private async drive(session: Session, run: Run): Promise<void> {
    let outcome: RunOutcome = "error";
    this.delta(session, { type: "agent-start" });
    try {
      outcome = await this.loop(session, run);
    } catch (error) {
      this.ctx.logger("agent").error("run of %s failed: %s", session.id, error);
    }
    try {
      await session.flush();
    } catch (error) {
      this.ctx.logger("agent").error("flushing %s failed: %s", session.id, error);
    }
    this.runs.delete(session.id);
    this.delta(session, { type: "agent-end", outcome });
    await this.ctx.parallel("agent/settled", session, outcome);
  }

  private async loop(session: Session, run: Run): Promise<RunOutcome> {
    const { signal } = run.controller;
    await this.ctx.serial("agent/before-start", session);
    let compactedForLength = false;
    let lengthContinuations = 0;
    let emptyContinuations = 0;
    let pluginContinuations = 0;

    for (let turn = 1; ; turn += 1) {
      if (signal.aborted) return "aborted";
      if (turn > this.maxTurns) return "max-turns";
      // Before the first call the latest turn is only the new prompt, so it stays verbatim;
      // later in the run it holds the tool results that grew the context (ADR 0008).
      await this.compactIfLarge(session, signal, turn === 1);

      this.delta(session, { type: "turn-start", turn });
      await this.ctx.serial("agent/turn-start", session, turn);

      const state = session.state();
      const model = state.model;
      if (model === undefined) throw new NoModelError(session.id);
      const response = await this.call(session, run, model, signal);

      if (response.reason === "error" && response.error?.kind === "context-length"
        && response.message.content.length === 0 && !compactedForLength) {
        // Nothing was said yet: shrink the context and try the same turn again.
        compactedForLength = true;
        if (await this.summarize(session, signal, "full") !== undefined) {
          turn -= 1;
          continue;
        }
      }
      if (response.reason !== "error") compactedForLength = false;

      session.append("assistant", {
        content: response.message.content,
        model,
        usage: response.usage,
        stop: response.reason,
        ...(response.error === undefined ? {} : { error: response.error }),
      });

      const calls = response.message.content.filter((block): block is ToolCallBlock => block.type === "tool-call");
      if (response.reason === "aborted" || signal.aborted) {
        for (const call of calls) {
          session.append("tool-result", { callId: call.id, name: call.name, content: [{ type: "text", text: "Aborted before the tool ran." }], isError: true });
        }
        await this.ctx.serial("agent/turn-end", session, turn);
        return "aborted";
      }
      if (response.reason === "error") {
        await this.ctx.serial("agent/turn-end", session, turn);
        return "error";
      }

      if (calls.length > 0) await this.runTools(session, run, calls, signal);
      await this.ctx.serial("agent/turn-end", session, turn);
      if (signal.aborted) return "aborted";

      if (this.deliver(session, run, run.steer) || calls.length > 0 || this.deliver(session, run, run.followUp)) {
        lengthContinuations = 0;
        emptyContinuations = 0;
        pluginContinuations = 0;
        continue;
      }

      const hasText = response.message.content.some((block) => block.type === "text" && block.text.trim() !== "");
      if (response.reason === "length" && lengthContinuations < MAX_LENGTH_CONTINUATIONS) {
        lengthContinuations += 1;
        session.append("custom", { ns: CONTINUATION_NAMESPACE, data: { reason: "length", text: LENGTH_CONTINUATION_PROMPT } });
        continue;
      }
      if (!hasText && emptyContinuations < MAX_EMPTY_CONTINUATIONS) {
        emptyContinuations += 1;
        session.append("custom", { ns: CONTINUATION_NAMESPACE, data: { reason: "empty", text: EMPTY_TURN_CONTINUATION_PROMPT } });
        continue;
      }
      if (pluginContinuations < MAX_PLUGIN_CONTINUATIONS) {
        const nudge = await this.ctx.serial("agent/before-stop", session, { turn, stop: response.reason, hasText });
        if (signal.aborted) return "aborted";
        if (typeof nudge === "string" && nudge.trim() !== "") {
          pluginContinuations += 1;
          session.append("custom", { ns: CONTINUATION_NAMESPACE, data: { reason: "before-stop", text: nudge.trim() } });
          continue;
        }
      }
      return "done";
    }
  }

  /** Append every queued message as a user event; whether there were any. */
  private deliver(session: Session, run: Run, queue: UserContent[][]): boolean {
    if (queue.length === 0) return false;
    for (const content of queue.splice(0)) session.append("user", { content });
    this.queueDelta(session, run);
    return true;
  }

  private async call(session: Session, run: Run, model: ModelRef, signal: AbortSignal) {
    const tools = this.ctx.tools.schemas(session.id);
    const system = await this.ctx.systemPrompt.build({ sessionId: session.id, cwd: session.header.cwd, model, tools });
    const state = session.state();
    const request: LlmRequest = {
      provider: model.provider,
      model: model.model,
      sessionId: session.id,
      system,
      messages: state.messages,
      ...(tools.length === 0 ? {} : { tools }),
      ...(state.effort === undefined ? {} : { effort: state.effort }),
    };
    run.streaming = [];
    this.delta(session, { type: "llm-start", provider: model.provider, model: model.model });
    const assembler = new BlockAssembler();
    for await (const chunk of this.ctx.llm.stream(request, signal)) {
      if (chunk.type === "retry") run.streaming = [];
      assembler.push(chunk);
      run.streaming.push(chunk);
      this.delta(session, { type: "llm-chunk", chunk });
    }
    run.streaming = [];
    return assembler.result();
  }

  private async runTools(session: Session, run: Run, calls: ToolCallBlock[], signal: AbortSignal): Promise<void> {
    const env = { sessionId: session.id, cwd: session.header.cwd, signal };
    const pending = calls.map((call) => {
      session.append("tool-call", { callId: call.id, name: call.name, args: call.arguments });
      run.runningTools.set(call.id, call.name);
      this.delta(session, { type: "tool-start", callId: call.id, name: call.name });
      return this.ctx.tools.execute({ id: call.id, name: call.name, args: { ...call.arguments } }, env);
    });
    // Parallel execution, results appended in call order for a deterministic log.
    for (const [index, call] of calls.entries()) {
      const output = await pending[index];
      if (output === undefined) continue;
      session.append("tool-result", { callId: call.id, name: call.name, content: output.content, isError: output.isError === true });
      run.runningTools.delete(call.id);
      this.delta(session, { type: "tool-end", callId: call.id, isError: output.isError === true });
    }
  }

  private async compactIfLarge(session: Session, signal: AbortSignal, keepLatestTurn: boolean): Promise<void> {
    const state = session.state();
    const last = session.events.findLast((event) => event.type === "assistant");
    if (last?.type !== "assistant" || state.model === undefined) return;
    if (state.compactedThrough !== undefined && state.compactedThrough > last.seq) return;
    const used = totalTokens(last.data.usage);
    const explicit = this.config.compactAboveTokens;
    if (explicit === undefined && used <= MIN_COMPACT_TOKENS) return;
    const limit = explicit ?? await this.contextLimit(state.model);
    if (limit === undefined || used <= limit) return;
    await this.summarize(session, signal, keepLatestTurn ? "keepLatestTurn" : "sliding");
  }

  /** The token count past which `model`'s context counts as full, when its window is known. */
  private async contextLimit(model: ModelRef): Promise<number | undefined> {
    const ratio = this.config.compactAtContextRatio ?? DEFAULT_COMPACT_RATIO;
    if (!(ratio > 0)) return undefined;
    const window = await this.contextWindow(model);
    return window === undefined ? undefined : Math.floor(window * ratio);
  }

  /** `model`'s context window from its provider's model list, cached; undefined when unknown. */
  private contextWindow(model: ModelRef): Promise<number | undefined> {
    const key = `${model.provider}\u0000${model.model}`;
    const cached = this.windows.get(key);
    if (cached !== undefined && Date.now() - cached.at < WINDOW_TTL_MS) return cached.window;
    const window = this.ctx.llm.listModels(model.provider, AbortSignal.timeout(WINDOW_LOOKUP_TIMEOUT_MS))
      .then((models) => {
        const found = models.find((candidate) => candidate.id === model.model)?.contextWindow;
        return found !== undefined && found > 0 ? found : undefined;
      })
      .catch(() => undefined);
    this.windows.set(key, { at: Date.now(), window });
    return window;
  }

  /**
   * Summarize the log and append a compaction; undefined when it failed.
   * Mid-run (`sliding`) keeps the recent step window verbatim while compacting
   * earlier history; on turn 1 or manual compact (`keepLatestTurn`) the active
   * user turn stays verbatim; emergency overflow (`full`) summarizes all history.
   */
  private async summarize(
    session: Session,
    signal: AbortSignal,
    mode: "full" | "keepLatestTurn" | "sliding" = "full",
  ): Promise<EventOf<"compaction"> | undefined> {
    const model = session.state().model;
    const throughSeq = mode === "sliding"
      ? slidingCompactionPoint(session.events, this.config.keepRecentTokens ?? DEFAULT_KEEP_RECENT_TOKENS)
      : compactionPoint(session.events, mode === "keepLatestTurn");
    if (model === undefined || throughSeq === undefined) return undefined;
    this.delta(session, { type: "compaction-start" });
    const head = deriveState(session.events.filter((event) => event.seq <= throughSeq));
    const ask = async (messages: Message[]) => {
      const assembler = new BlockAssembler();
      const request: LlmRequest = {
        provider: model.provider,
        model: model.model,
        system: COMPACTION_SYSTEM,
        messages: [...messages, { role: "user", content: [{ type: "text", text: COMPACTION_REQUEST }] }],
        maxTokens: this.config.summaryMaxTokens ?? 8_192,
      };
      for await (const chunk of this.ctx.llm.stream(request, signal)) assembler.push(chunk);
      return assembler.result();
    };
    // The history verbatim first; when even the summary request is too long, clip it further (ADR 0019).
    let response = await ask(head.messages);
    for (const level of SUMMARY_CLIP_LEVELS) {
      if (response.reason !== "error" || response.error?.kind !== "context-length" || signal.aborted) break;
      response = await ask(shrinkForSummary(head.messages, level));
    }
    const summary = response.message.content
      .flatMap((block) => (block.type === "text" ? [block.text] : []))
      .join("")
      .trim();
    const ok = response.reason !== "error" && response.reason !== "aborted" && summary !== "";
    if (!ok) this.ctx.logger("agent").warn("compacting %s failed: %s", session.id, response.error?.message ?? response.reason);
    const event = ok ? session.append("compaction", { throughSeq, summary }) : undefined;
    this.delta(session, { type: "compaction-end", ok });
    return event;
  }
}

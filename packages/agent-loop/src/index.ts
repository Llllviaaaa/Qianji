/**
 * The agent loop (ADR 0008, ADR 0024), the one place that drives a run:
 *
 *   before-start → [turn-start → model call → tools → turn-end]* → settled
 *
 * Each turn derives the context from the session log, streams one model call
 * (chunks go out as `session/delta`), appends the assistant message, then runs
 * the tools it asked for in bounded batches and appends their results in call
 * order. Steering messages abort `steeringSignal` for cooperative tools and
 * preempt unstarted batches; `before-stop` aggregates nudges across all
 * registered listeners; `length` truncations below `maxOutputTokens` replay
 * silently once at the model's ceiling before falling back to continuation.
 */
import { Context, Service } from "@deepseek-ai/cordis";
import {
  AgentBusyError, NoModelError, type AgentDelta, type AgentStatus,
  type Agents, type BeforeStopContext, type RunOutcome,
} from "@qianji/agent";
import {
  BlockAssembler, toLlmError, type AssistantContent, type LlmRequest,
  type StreamChunk, type ToolCallBlock, type UserContent,
} from "@qianji/llm";
import { CONTINUATION_NAMESPACE, hasVisibleProse, type EventOf, type ModelRef, type Session } from "@qianji/session";
import "@qianji/system-prompt";
import "@qianji/tools";
import {
  compactIfLarge, maxOutputCeiling, summarizeSession,
  type AgentLoopConfig, type CompactionHost, type WindowCache,
} from "./compaction.ts";
import { DEFAULT_MAX_PARALLEL_TOOLS, runToolBatches } from "./tool-runner.ts";

export { buildCompactionWorkingSetAddendum } from "./rehydrate.ts";
export {
  PRUNE_HEAD_CHARS, PRUNE_HYSTERESIS_RATIO, PRUNE_IDLE_RATIO, PRUNE_IDLE_TTL_MS,
  PRUNE_MIN_CHARS, PRUNE_TAIL_CHARS, estimateBranchContextTokens, formatPrunedToolResult, pruneOldToolResults,
} from "./pruner.ts";
export { SUMMARY_CLIP_LEVELS, prepareSummaryMessages, serializeConversation, shrinkForSummary } from "./summary-input.ts";
export { COMPACTION_REQUEST, COMPACTION_SYSTEM, FORKED_COMPACTION_REQUEST, type AgentLoopConfig } from "./compaction.ts";
export { DEFAULT_MAX_PARALLEL_TOOLS, STEER_SKIPPED_MESSAGE, partitionToolBatches } from "./tool-runner.ts";

export const LENGTH_CONTINUATION_PROMPT =
  "Your previous response hit the output token limit and was cut off mid-generation. Continue directly from where you stopped; if you were about to call a tool, invoke it now.";

export const EMPTY_TURN_CONTINUATION_PROMPT =
  "Your previous turn produced no visible response or tool call. Either invoke the next tool needed to advance the task, or provide a clear answer to the user.";

export const DEFAULT_MAX_TURNS = 500;
export const MAX_LENGTH_CONTINUATIONS = 3;
export const MAX_EMPTY_CONTINUATIONS = 2;
export const MAX_PLUGIN_CONTINUATIONS = 2;

const EMPTY_RESPONSE_EXHAUSTED_MESSAGE = "模型未返回可见正文（连续仅输出思考或空响应）。";

interface Run {
  controller: AbortController;
  steeringController: AbortController;
  done: Promise<void>;
  steer: UserContent[][];
  followUp: UserContent[][];
  streaming: StreamChunk[];
  runningTools: Map<string, string>;
}

const IDLE_QUEUE = { steer: 0, followUp: 0 };
const ZERO_USAGE = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };

function isTruncatedToolCall(block: AssistantContent): boolean {
  return block.type === "tool-call" && (block.name.trim() === "" || "__invalidJson" in block.arguments);
}

export class AgentLoop extends Service implements Agents {
  static inject = ["llm", "sessions", "tools", "systemPrompt"];

  private readonly runs = new Map<string, Run>();
  private readonly maxTurns: number;
  private readonly maxParallelTools: number;
  private readonly windows: WindowCache = new Map();

  constructor(ctx: Context, private readonly config: AgentLoopConfig = {}) {
    super(ctx, "agents");
    this.maxTurns = Math.max(1, config.maxTurns ?? DEFAULT_MAX_TURNS);
    this.maxParallelTools = Math.max(1, config.maxParallelTools ?? DEFAULT_MAX_PARALLEL_TOOLS);
    ctx.effect(() => () => {
      for (const run of this.runs.values()) {
        run.steeringController.abort();
        run.controller.abort();
      }
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
    run.steeringController.abort();
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
    const hadQueued = run.steer.length > 0 || run.followUp.length > 0;
    run.steer.length = 0;
    run.followUp.length = 0;
    if (hadQueued) {
      const session = this.ctx.sessions.peek(sessionId);
      if (session !== undefined) this.queueDelta(session, run);
    }
    run.steeringController.abort();
    run.controller.abort();
    await run.done;
  }

  async compact(session: Session, signal?: AbortSignal): Promise<EventOf<"compaction"> | undefined> {
    if (this.runs.has(session.id)) throw new AgentBusyError(session.id);
    return summarizeSession(this.compactionHost(), session, signal ?? new AbortController().signal, "keepLatestTurn");
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

  isBusy(): boolean {
    return this.runs.size > 0;
  }

  async idle(sessionId: string): Promise<void> {
    await this.runs.get(sessionId)?.done;
  }

  private compactionHost(): CompactionHost {
    return {
      ctx: this.ctx,
      config: this.config,
      windows: this.windows,
      delta: (session, delta) => this.delta(session, delta),
    };
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
      steeringController: new AbortController(),
      done: Promise.resolve(),
      steer: [],
      followUp: [],
      streaming: [],
      runningTools: new Map(),
    };
    this.runs.set(session.id, run);
    const release = this.ctx.sessions.hold(session.id);
    run.done = this.drive(session, run).finally(release);
  }

  private async drive(session: Session, run: Run): Promise<void> {
    let outcome: RunOutcome;
    this.delta(session, { type: "agent-start" });
    for (;;) {
      outcome = "error";
      try {
        outcome = await this.loop(session, run);
      } catch (error) {
        this.ctx.logger("agent").error("run of %s failed: %s", session.id, error);
        const errorInfo = toLlmError(error, run.controller.signal).toInfo();
        const model = session.state().model ?? { provider: "unknown", model: "unknown" };
        session.append("assistant", {
          content: [],
          model,
          usage: { ...ZERO_USAGE },
          stop: "error",
          error: errorInfo,
        });
      }
      try {
        await session.flush();
      } catch (error) {
        this.ctx.logger("agent").error("flushing %s failed: %s", session.id, error);
      }
      if (
        outcome === "done"
        && !run.controller.signal.aborted
        && (this.deliverSteer(session, run) || this.deliverOneFollowUp(session, run))
      ) {
        continue;
      }
      break;
    }
    if (run.steer.length > 0 || run.followUp.length > 0) {
      run.steer.length = 0;
      run.followUp.length = 0;
      this.queueDelta(session, run);
    }
    this.runs.delete(session.id);
    this.delta(session, { type: "agent-end", outcome });
    await this.ctx.parallel("agent/settled", session, outcome);
  }

  private async collectBeforeStopNudges(
    session: Session,
    info: BeforeStopContext,
    signal: AbortSignal,
  ): Promise<string | undefined> {
    const dispatchArgs: unknown[] = ["agent/before-stop", session, info];
    const listeners = this.ctx.events.dispatch("serial", dispatchArgs) as Array<
      (s: Session, c: BeforeStopContext) => Promise<string | undefined> | string | undefined
    >;
    const nudges: string[] = [];
    for (const listener of listeners) {
      if (signal.aborted) return undefined;
      const result = await listener(session, info);
      if (typeof result === "string" && result.trim() !== "") nudges.push(result.trim());
    }
    return nudges.length > 0 ? nudges.join("\n\n") : undefined;
  }

  private async loop(session: Session, run: Run): Promise<RunOutcome> {
    const { signal } = run.controller;
    await this.ctx.serial("agent/before-start", session, signal);
    let compactedForLength = false;
    let lengthContinuations = 0;
    let emptyContinuations = 0;
    let pluginContinuations = 0;

    for (let turn = 1; ; turn += 1) {
      if (signal.aborted) return "aborted";
      if (turn > this.maxTurns) return "max-turns";
      if (run.steer.length === 0 && run.steeringController.signal.aborted) {
        run.steeringController = new AbortController();
      }
      await compactIfLarge(this.compactionHost(), session, signal, turn === 1);
      if (signal.aborted) return "aborted";

      this.delta(session, { type: "turn-start", turn });
      await this.ctx.serial("agent/turn-start", session, turn);
      if (signal.aborted) return "aborted";

      const state = session.state();
      const model = state.model;
      if (model === undefined) throw new NoModelError(session.id);
      const initialMaxTokens = this.config.defaultMaxTokens;
      let response = await this.call(session, run, model, signal, initialMaxTokens);

      if (response.reason === "length" && !signal.aborted) {
        const ceiling = await maxOutputCeiling(this.compactionHost(), model, signal);
        const usedCap = initialMaxTokens ?? response.usage.outputTokens;
        if (!signal.aborted && ceiling !== undefined && ceiling > usedCap && (initialMaxTokens === undefined || initialMaxTokens < ceiling)) {
          response = await this.call(session, run, model, signal, ceiling);
        }
      }

      if (response.reason === "error" && response.error?.kind === "context-length"
        && response.message.content.length === 0 && !compactedForLength) {
        compactedForLength = true;
        const compacted = await summarizeSession(this.compactionHost(), session, signal, "full");
        if (signal.aborted) {
          await this.ctx.serial("agent/turn-end", session, turn);
          return "aborted";
        }
        if (compacted !== undefined) {
          turn -= 1;
          continue;
        }
      }
      if (response.reason !== "error") compactedForLength = false;

      if ((response.reason === "aborted" || signal.aborted) && response.message.content.length === 0) {
        await this.ctx.serial("agent/turn-end", session, turn);
        return "aborted";
      }

      const persistedContent = response.reason === "error"
        ? response.message.content.filter((block) => block.type !== "tool-call")
        : response.reason === "length"
          ? response.message.content.filter((block) => !isTruncatedToolCall(block))
          : response.message.content;

      session.append("assistant", {
        content: persistedContent,
        model,
        usage: response.usage,
        stop: response.reason,
        ...(response.error === undefined ? {} : { error: response.error }),
      });

      const calls = persistedContent.filter((block): block is ToolCallBlock => block.type === "tool-call");
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

      if (calls.length > 0) {
        await runToolBatches({
          session,
          tools: this.ctx.tools,
          calls,
          signal,
          steeringSignal: run.steeringController.signal,
          maxParallelTools: this.maxParallelTools,
          runningTools: run.runningTools,
          hasSteer: () => run.steer.length > 0,
          delta: (delta) => this.delta(session, delta),
        });
      }
      await this.ctx.serial("agent/turn-end", session, turn);
      if (signal.aborted) return "aborted";

      if (this.deliverSteer(session, run) || calls.length > 0 || this.deliverOneFollowUp(session, run)) {
        lengthContinuations = 0;
        emptyContinuations = 0;
        pluginContinuations = 0;
        continue;
      }

      const hasText = persistedContent.some((block) => block.type === "text" && hasVisibleProse(block.text));
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
        const nudge = await this.collectBeforeStopNudges(session, { turn, stop: response.reason, hasText }, signal);
        if (signal.aborted) return "aborted";
        if (this.deliverSteer(session, run)) {
          lengthContinuations = 0;
          emptyContinuations = 0;
          pluginContinuations = 0;
          continue;
        }
        if (nudge !== undefined) {
          pluginContinuations += 1;
          session.append("custom", { ns: CONTINUATION_NAMESPACE, data: { reason: "before-stop", text: nudge } });
          continue;
        }
      }
      if (!signal.aborted && (this.deliverSteer(session, run) || this.deliverOneFollowUp(session, run))) {
        lengthContinuations = 0;
        emptyContinuations = 0;
        pluginContinuations = 0;
        continue;
      }
      if (!hasText && response.reason !== "length") {
        session.append("assistant", {
          content: [],
          model,
          usage: { ...ZERO_USAGE },
          stop: "error",
          error: {
            kind: "unknown",
            code: "empty_response_exhausted",
            message: EMPTY_RESPONSE_EXHAUSTED_MESSAGE,
            retryable: true,
          },
        });
        return "error";
      }
      return "done";
    }
  }

  private deliverSteer(session: Session, run: Run): boolean {
    if (run.steer.length === 0) return false;
    for (const content of run.steer.splice(0)) session.append("user", { content });
    run.steeringController = new AbortController();
    this.queueDelta(session, run);
    return true;
  }

  private deliverOneFollowUp(session: Session, run: Run): boolean {
    const next = run.followUp.shift();
    if (next === undefined) return false;
    session.append("user", { content: next });
    this.queueDelta(session, run);
    return true;
  }

  private async call(session: Session, run: Run, model: ModelRef, signal: AbortSignal, maxTokens?: number) {
    const tools = this.ctx.tools.schemas(session.id);
    const system = await this.ctx.systemPrompt.build({ sessionId: session.id, cwd: session.header.cwd, model, tools });
    if (signal.aborted) {
      return {
        message: { role: "assistant" as const, content: [] },
        usage: { ...ZERO_USAGE },
        reason: "aborted" as const,
      };
    }
    const state = session.state();
    const request: LlmRequest = {
      provider: model.provider,
      model: model.model,
      sessionId: session.id,
      system,
      messages: state.messages,
      ...(tools.length === 0 ? {} : { tools }),
      ...(state.effort === undefined ? {} : { effort: state.effort }),
      ...(maxTokens === undefined ? {} : { maxTokens }),
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
}

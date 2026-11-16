/**
 * The agent loop (ADR 0008), the one place that drives a run:
 *
 *   before-start → [turn-start → model call → tools → turn-end]* → settled
 *
 * Each turn derives the context from the session log, streams one model call
 * (chunks go out as `session/delta`), appends the assistant message, then runs
 * the tools it asked for in parallel and appends their results in call order.
 * Steering messages are delivered after a turn's tools (preempting remaining
 * batches when queued mid-turn); follow-ups once the model would otherwise
 * stop. A context-length error with no output compacts the whole log once and
 * retries.
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
import { BlockAssembler, type LlmRequest, type StreamChunk, type ToolCallBlock, type UserContent } from "@qianji/llm";
import { CONTINUATION_NAMESPACE, type EventOf, type ModelRef, type Session } from "@qianji/session";
import "@qianji/system-prompt";
import { ACTIVATE_TOOLS_NAME, textOutput, type ToolEnv, type ToolOutput } from "@qianji/tools";
import {
  compactIfLarge,
  summarizeSession,
  type AgentLoopConfig,
  type CompactionHost,
  type WindowCache,
} from "./compaction.ts";

export { buildCompactionWorkingSetAddendum } from "./rehydrate.ts";
export {
  SUMMARY_CLIP_LEVELS,
  prepareSummaryMessages,
  serializeConversation,
  shrinkForSummary,
} from "./summary-input.ts";
export { COMPACTION_REQUEST, COMPACTION_SYSTEM, type AgentLoopConfig } from "./compaction.ts";

export const LENGTH_CONTINUATION_PROMPT =
  "Your previous response hit the output token limit and was cut off mid-generation. Continue directly from where you stopped; if you were about to call a tool, invoke it now.";

export const EMPTY_TURN_CONTINUATION_PROMPT =
  "Your previous turn produced no visible response or tool call. Either invoke the next tool needed to advance the task, or provide a clear answer to the user.";

export const MAX_LENGTH_CONTINUATIONS = 3;
export const MAX_EMPTY_CONTINUATIONS = 2;
export const MAX_PLUGIN_CONTINUATIONS = 2;

const STEER_SKIPPED_MESSAGE = "Skipped due to queued user steering message.";

interface Run {
  controller: AbortController;
  done: Promise<void>;
  steer: UserContent[][];
  followUp: UserContent[][];
  streaming: StreamChunk[];
  runningTools: Map<string, string>;
}

interface IndexedCall {
  call: ToolCallBlock;
  index: number;
}

const IDLE_QUEUE = { steer: 0, followUp: 0 };

/** Group consecutive read-only calls into concurrent batches separated by serial barriers. */
function partitionToolBatches(
  calls: readonly ToolCallBlock[],
  isConcurrencySafe: (name: string) => boolean,
): IndexedCall[][] {
  const batches: IndexedCall[][] = [];
  let currentConcurrent: IndexedCall[] | undefined;
  for (const [index, call] of calls.entries()) {
    const item: IndexedCall = { call, index };
    if (isConcurrencySafe(call.name)) {
      if (currentConcurrent === undefined) {
        currentConcurrent = [item];
        batches.push(currentConcurrent);
      } else {
        currentConcurrent.push(item);
      }
    } else {
      currentConcurrent = undefined;
      batches.push([item]);
    }
  }
  return batches;
}

export class AgentLoop extends Service implements Agents {
  static inject = ["llm", "sessions", "tools", "systemPrompt"];

  private readonly runs = new Map<string, Run>();
  private readonly maxTurns: number;
  private readonly windows: WindowCache = new Map();

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
    const hadQueued = run.steer.length > 0 || run.followUp.length > 0;
    run.steer.length = 0;
    run.followUp.length = 0;
    if (hadQueued) {
      const session = this.ctx.sessions.peek(sessionId);
      if (session !== undefined) this.queueDelta(session, run);
    }
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
    await this.ctx.serial("agent/before-start", session, signal);
    let compactedForLength = false;
    let lengthContinuations = 0;
    let emptyContinuations = 0;
    let pluginContinuations = 0;

    for (let turn = 1; ; turn += 1) {
      if (signal.aborted) return "aborted";
      if (turn > this.maxTurns) return "max-turns";
      // Before the first call the latest turn is only the new prompt, so it stays verbatim;
      // later in the run it holds the tool results that grew the context (ADR 0008).
      await compactIfLarge(this.compactionHost(), session, signal, turn === 1);
      if (signal.aborted) return "aborted";

      this.delta(session, { type: "turn-start", turn });
      await this.ctx.serial("agent/turn-start", session, turn);
      if (signal.aborted) return "aborted";

      const state = session.state();
      const model = state.model;
      if (model === undefined) throw new NoModelError(session.id);
      const response = await this.call(session, run, model, signal);

      if (response.reason === "error" && response.error?.kind === "context-length"
        && response.message.content.length === 0 && !compactedForLength) {
        // Nothing was said yet: shrink the context and try the same turn again.
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
    if (signal.aborted) {
      return {
        message: { role: "assistant" as const, content: [] },
        usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
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

  private isConcurrencySafeTool(name: string): boolean {
    return name === ACTIVATE_TOOLS_NAME || this.ctx.tools.get(name)?.readOnly === true;
  }

  private async runTools(session: Session, run: Run, calls: ToolCallBlock[], signal: AbortSignal): Promise<void> {
    for (const call of calls) {
      session.append("tool-call", { callId: call.id, name: call.name, args: call.arguments });
    }

    const batches = partitionToolBatches(calls, (name) => this.isConcurrencySafeTool(name));
    const outputs: Array<ToolOutput | undefined> = new Array(calls.length);
    try {
      for (const [batchIndex, batch] of batches.entries()) {
        if (signal.aborted) break;
        if (batchIndex > 0 && !signal.aborted && run.steer.length > 0) {
          for (const remaining of batches.slice(batchIndex)) {
            for (const { index } of remaining) {
              outputs[index] = textOutput(STEER_SKIPPED_MESSAGE, true);
            }
          }
          break;
        }
        await Promise.all(batch.map(async ({ call, index }) => {
          run.runningTools.set(call.id, call.name);
          this.delta(session, { type: "tool-start", callId: call.id, name: call.name });
          let settled = false;
          const env: ToolEnv = {
            sessionId: session.id,
            cwd: session.header.cwd,
            signal,
            onProgress: (text) => {
              if (!settled && !signal.aborted) {
                this.delta(session, { type: "tool-progress", callId: call.id, name: call.name, text });
              }
            },
          };
          try {
            outputs[index] = await this.ctx.tools.execute({ id: call.id, name: call.name, args: { ...call.arguments } }, env);
          } catch (error) {
            const msg = signal.aborted ? "Aborted." : `${call.name} failed: ${error instanceof Error ? error.message : String(error)}`;
            outputs[index] = textOutput(msg, true);
          } finally {
            settled = true;
            run.runningTools.delete(call.id);
          }
        }));
      }
    } finally {
      // Deterministic log order: every tool-call gets a matching tool-result even on failure/interruption.
      for (const [index, call] of calls.entries()) {
        const output = outputs[index] ?? textOutput(signal.aborted ? "Aborted." : "Tool execution interrupted.", true);
        session.append("tool-result", { callId: call.id, name: call.name, content: output.content, isError: output.isError === true });
        run.runningTools.delete(call.id);
        this.delta(session, { type: "tool-end", callId: call.id, isError: output.isError === true });
      }
    }
  }
}

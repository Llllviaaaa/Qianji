/**
 * Independent Companion Execution Loop (`BotCompanionHarness`) implementing `Agents`
 * specifically for Qianji Bot Mode (`packages/host/src/bot/harness/bot-harness.ts`).
 *
 * Distinct from `AgentLoop` (`packages/agent-loop`): builds caring companion prompts
 * (`bot-prompt.ts`), injects Bot-exclusive proactive tools (`bot-tools.ts`), syncs
 * live in-flight turn activity, enforces outbound safety boundaries, and runs
 * asynchronous post-turn semantic reflection (`bot-reflection.ts`).
 */
import type { Context } from "@deepseek-ai/cordis";
import {
  AgentBusyError,
  NoModelError,
  type AgentDelta,
  type Agents,
  type AgentStatus,
  type RunOutcome,
} from "@qianji/agent";
import {
  BlockAssembler,
  toLlmError,
  type LlmRequest,
  type StreamChunk,
  type ToolCallBlock,
  type ToolSchema,
  type UserContent,
} from "@qianji/llm";
import type { BotActivityEntry } from "@qianji/protocol";
import type { ScheduledTask } from "@qianji/schedule";
import type { EventOf, ModelRef, Session } from "@qianji/session";
import { textOutput, type ToolCall, type ToolEnv, type ToolOutput } from "@qianji/tools";
import type { PersistedBotState } from "../defaults.ts";
import type { TurnRecordOptions } from "../store-threads.ts";
import { buildBotSystemPrompt } from "./bot-prompt.ts";
import { reflectOnSettledTurn } from "./bot-reflection.ts";
import {
  BOT_NATIVE_TOOL_NAMES,
  BOT_NATIVE_TOOL_SCHEMAS,
  executeBotNativeTool,
  type BotNativeToolsHost,
} from "./bot-tools.ts";

interface BotRun {
  controller: AbortController;
  done: Promise<void>;
  steer: UserContent[][];
  followUp: UserContent[][];
  streaming: StreamChunk[];
  runningTools: Map<string, string>;
  turnStartSeq: number;
  activityId?: string;
}

export interface BotHarnessHost extends BotNativeToolsHost {
  isBotSession(sessionId: string): boolean;
  ensureLoaded(): Promise<PersistedBotState>;
  readSoul(): string;
  readMemory(): string;
  persist(): void;
  getReflectionModel(state: PersistedBotState): ModelRef | undefined;
  executeToolInVm(call: ToolCall, env: ToolEnv): Promise<ToolOutput | undefined>;
  recordTurnProgress(session: Session, options?: TurnRecordOptions): Promise<BotActivityEntry | undefined>;
  recordSettledTurn(session: Session, options?: TurnRecordOptions): Promise<BotActivityEntry | undefined>;
  listScheduledTasks?(): ScheduledTask[];
  notifyUpdated(reason: string, extra?: Record<string, unknown>): void;
  readonly botWorkspaceDir: string;
  readonly memoryFile: string;
}

const MAX_BOT_TURNS = 40;

export class BotCompanionHarness implements Agents {
  private readonly runs = new Map<string, BotRun>();

  constructor(
    private readonly ctx: Context,
    private readonly host: BotHarnessHost,
  ) {
    ctx.effect(() => () => {
      for (const run of this.runs.values()) run.controller.abort();
    }, "bot-harness: abort runs");
  }

  ownsSession(sessionId: string): boolean {
    return this.host.isBotSession(sessionId);
  }

  prompt(session: Session, content: UserContent[]): EventOf<"user"> {
    if (this.runs.has(session.id)) throw new AgentBusyError(session.id);
    if (session.state().model === undefined) throw new NoModelError(session.id);
    const event = session.append("user", { content });
    this.startRun(session, event.seq);
    return event;
  }

  steer(session: Session, content: UserContent[]): EventOf<"user"> | undefined {
    const run = this.runs.get(session.id);
    if (run === undefined) return this.prompt(session, content);
    run.steer.push(content);
    session.delta({ type: "queue", steer: run.steer.length, followUp: run.followUp.length });
    return undefined;
  }

  followUp(session: Session, content: UserContent[]): EventOf<"user"> | undefined {
    const run = this.runs.get(session.id);
    if (run === undefined) return this.prompt(session, content);
    run.followUp.push(content);
    session.delta({ type: "queue", steer: run.steer.length, followUp: run.followUp.length });
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

  async compact(): Promise<undefined> {
    return undefined;
  }

  status(sessionId: string): AgentStatus {
    const run = this.runs.get(sessionId);
    if (run === undefined) {
      return { running: false, streaming: [], runningTools: [], queue: { steer: 0, followUp: 0 } };
    }
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

  private emit(session: Session, delta: AgentDelta): void {
    session.delta(delta);
  }

  private startRun(session: Session, turnStartSeq: number): void {
    const run: BotRun = {
      controller: new AbortController(),
      done: Promise.resolve(),
      steer: [],
      followUp: [],
      streaming: [],
      runningTools: new Map(),
      turnStartSeq,
    };
    this.runs.set(session.id, run);
    const release = this.ctx.sessions.hold(session.id);
    run.done = this.drive(session, run).finally(release);
  }

  private async drive(session: Session, run: BotRun): Promise<void> {
    let outcome: RunOutcome = "error";
    this.emit(session, { type: "agent-start" });
    const initialActivity = await this.host
      .recordTurnProgress(session, { turnStartSeq: run.turnStartSeq, status: "running" })
      .catch(() => undefined);
    if (initialActivity !== undefined) run.activityId = initialActivity.id;
    this.host.notifyUpdated("turn-started", { sessionId: session.id, activityId: run.activityId });

    try {
      outcome = await this.loop(session, run);
    } catch (error) {
      this.ctx.logger("bot-harness").error("run %s failed: %s", session.id, error);
      const model = session.state().model ?? { provider: "unknown", model: "unknown" };
      session.append("assistant", {
        content: [],
        model,
        usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
        stop: "error",
        error: toLlmError(error, run.controller.signal).toInfo(),
      });
    }
    await session.flush().catch(() => undefined);
    this.runs.delete(session.id);
    this.emit(session, { type: "agent-end", outcome });

    const settledOutcome = outcome === "done" ? "done" : outcome === "aborted" ? "aborted" : "error";
    const settledActivity = await this.host
      .recordSettledTurn(session, {
        turnStartSeq: run.turnStartSeq,
        activityId: run.activityId,
        outcome: settledOutcome,
      })
      .catch(() => undefined);
    this.host.notifyUpdated("turn-settled", { sessionId: session.id, activityId: settledActivity?.id });

    if (outcome === "done") {
      const state = await this.host.ensureLoaded().catch(() => null);
      if (state) {
        void reflectOnSettledTurn({
          ctx: this.ctx,
          session,
          state,
          memoryFile: this.host.memoryFile,
          botWorkspaceDir: this.host.botWorkspaceDir,
          reflectionModel: this.host.getReflectionModel(state),
          activityId: settledActivity?.id ?? run.activityId,
          turnStartSeq: run.turnStartSeq,
          onPersistAndNotify: (reason) => {
            this.host.persist();
            this.host.notifyUpdated(reason);
          },
        });
      }
    }
  }

  private async loop(session: Session, run: BotRun): Promise<RunOutcome> {
    const { signal } = run.controller;
    for (let turn = 1; turn <= MAX_BOT_TURNS; turn += 1) {
      if (signal.aborted) return "aborted";
      this.emit(session, { type: "turn-start", turn });

      const model = session.state().model;
      if (!model) throw new NoModelError(session.id);
      const st = await this.host.ensureLoaded();
      const system = buildBotSystemPrompt({
        displayName: st.profile.displayName,
        soulMarkdown: this.host.readSoul(),
        memoryMarkdown: this.host.readMemory(),
        state: st,
        scheduledTasks: this.host.listScheduledTasks?.() ?? [],
      });

      const hostToolSchemas = this.ctx.tools.schemas(session.id);
      const tools: ToolSchema[] = [...BOT_NATIVE_TOOL_SCHEMAS, ...hostToolSchemas];

      const request: LlmRequest = {
        provider: model.provider,
        model: model.model,
        sessionId: session.id,
        system,
        messages: session.state().messages,
        tools,
        ...(session.state().effort ? { effort: session.state().effort } : {}),
      };

      run.streaming = [];
      const llm = this.ctx.get("llm");
      if (!llm) throw new Error("LLM service is unavailable");
      this.emit(session, { type: "llm-start", provider: model.provider, model: model.model });
      const assembler = new BlockAssembler();
      for await (const chunk of llm.stream(request, signal)) {
        if (chunk.type === "retry") run.streaming = [];
        assembler.push(chunk);
        run.streaming.push(chunk);
        this.emit(session, { type: "llm-chunk", chunk });
      }
      run.streaming = [];
      const response = assembler.result();

      if ((response.reason === "aborted" || signal.aborted) && response.message.content.length === 0) {
        return "aborted";
      }

      session.append("assistant", {
        content: response.message.content,
        model,
        usage: response.usage,
        stop: response.reason,
        ...(response.error ? { error: response.error } : {}),
      });

      const calls = response.message.content.filter((b): b is ToolCallBlock => b.type === "tool-call");
      if (response.reason === "aborted" || signal.aborted) {
        for (const call of calls) {
          session.append("tool-result", {
            callId: call.id,
            name: call.name,
            content: [{ type: "text", text: "Aborted before execution." }],
            isError: true,
          });
        }
        return "aborted";
      }
      if (response.reason === "error") return "error";

      if (calls.length > 0) {
        await this.executeToolCalls(session, run, calls, signal);
        if (signal.aborted) return "aborted";
      }

      if (this.drainQueue(session, run, run.steer) || calls.length > 0 || this.drainQueue(session, run, run.followUp)) {
        continue;
      }
      return "done";
    }
    return "max-turns";
  }

  private drainQueue(session: Session, run: BotRun, queue: UserContent[][]): boolean {
    if (queue.length === 0) return false;
    for (const c of queue.splice(0)) session.append("user", { content: c });
    session.delta({ type: "queue", steer: run.steer.length, followUp: run.followUp.length });
    return true;
  }

  private async executeToolCalls(
    session: Session,
    run: BotRun,
    calls: readonly ToolCallBlock[],
    signal: AbortSignal,
  ): Promise<void> {
    for (const call of calls) {
      session.append("tool-call", { callId: call.id, name: call.name, args: call.arguments });
    }
    for (const call of calls) {
      if (signal.aborted) break;
      run.runningTools.set(call.id, call.name);
      this.emit(session, { type: "tool-start", callId: call.id, name: call.name });
      const startedAct = await this.host
        .recordTurnProgress(session, {
          turnStartSeq: run.turnStartSeq,
          activityId: run.activityId,
          status: "running",
          activeToolName: call.name,
        })
        .catch(() => undefined);
      if (startedAct !== undefined) run.activityId = startedAct.id;
      this.host.notifyUpdated("turn-tool-progress", { sessionId: session.id, activityId: run.activityId });

      const env: ToolEnv = { sessionId: session.id, cwd: this.host.botWorkspaceDir || session.header.cwd, signal };
      const toolCall: ToolCall = { id: call.id, name: call.name, args: { ...call.arguments } };
      let out: ToolOutput;
      try {
        if (BOT_NATIVE_TOOL_NAMES.has(call.name)) {
          out = await executeBotNativeTool(call.name, toolCall.args, env, this.host);
        } else {
          out = await this.ctx.tools.execute(toolCall, env);
        }
      } catch (err) {
        out = textOutput(`${call.name} failed: ${err instanceof Error ? err.message : String(err)}`, true);
      } finally {
        run.runningTools.delete(call.id);
      }
      session.append("tool-result", {
        callId: call.id,
        name: call.name,
        content: out.content,
        isError: out.isError === true,
      });
      this.emit(session, { type: "tool-end", callId: call.id, isError: out.isError === true });
      const endedAct = await this.host
        .recordTurnProgress(session, {
          turnStartSeq: run.turnStartSeq,
          activityId: run.activityId,
          status: "running",
        })
        .catch(() => undefined);
      if (endedAct !== undefined) run.activityId = endedAct.id;
      this.host.notifyUpdated("turn-tool-progress", { sessionId: session.id, activityId: run.activityId });
    }
  }
}

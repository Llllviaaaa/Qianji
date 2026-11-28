/**
 * The `session.*`, `model.set` and `model.setEffort` methods (ADR 0002, 0008),
 * and the per-connection `session/event` and `session/delta` notifications
 * that `session.subscribe` starts.
 */
import { existsSync, mkdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute } from "node:path";
import type { Context } from "@deepseek-ai/cordis";
import type { Agents } from "@qianji/agent";
import { AgentBusyError, NoModelError } from "@qianji/agent";
import { BlockAssembler, type Effort, type LlmRequest, type UserContent } from "@qianji/llm";
import "@qianji/pricing";
import {
  ErrorCode,
  type AgentStatusInfo,
  type AppendResult,
  type ModelChoice,
  type PromptContent,
  type SessionDeltaNotification,
  type SessionExportResult,
  type SessionEventNotification,
  type SessionGetResult,
  type SessionInfo,
  type SessionListResult,
  type SessionPromptResult,
  type SessionResult,
  type SessionSearchResult,
  type SessionSubscribeResult,
  type UsageSummaryResult,
} from "@qianji/protocol";
import { currentBranch, sessionMarkdown, settledSeq, type Session, type SessionEvent, type SessionSummary } from "@qianji/session";
import { RpcError, type RpcCall } from "./rpc.ts";

export const name = "qianji-sessions-rpc";
export const inject = ["rpc", "sessions", "agents", "llm"];

export interface Config {
  /** The model a new session gets when `session.create` names none; a function is asked each time. */
  defaultModel?: ModelChoice | (() => ModelChoice | undefined);
}

const EFFORT_ID_RE = /^[a-zA-Z0-9._:-]{1,64}$/;
const BRANCH_SUMMARY_EVENT_CHARS = 4_000;
const BRANCH_SUMMARY_MAX_CHARS = 48_000;
const BRANCH_SUMMARY_SYSTEM =
  "You summarize an abandoned conversation branch before rewinding so the main branch retains concise, factual learnings without repeating dead ends.";
const BRANCH_SUMMARY_REQUEST =
  "Summarize the abandoned branch below in 3-6 concise bullet points: (1) what was attempted, (2) files touched or verified facts discovered, and (3) why it failed or was abandoned so future attempts do not repeat the same mistakes.";

function clipSummaryText(text: string, limit: number): string {
  const trimmed = text.trim();
  if (trimmed.length <= limit) return trimmed;
  return `${trimmed.slice(0, limit)}…`;
}

export function formatDroppedEvent(event: SessionEvent): string | undefined {
  if (event.type === "user") {
    const text = event.data.content.flatMap((b) => (b.type === "text" && b.meta !== true ? [b.text] : [])).join("\n").trim();
    return text === "" ? undefined : `[user]: ${clipSummaryText(text, BRANCH_SUMMARY_EVENT_CHARS)}`;
  }
  if (event.type === "assistant") {
    const parts: string[] = [];
    for (const block of event.data.content) {
      if (block.type === "text" && block.text.trim() !== "") parts.push(block.text.trim());
      else if (block.type === "tool-call") parts.push(`[tool-call ${block.name}(${clipSummaryText(JSON.stringify(block.arguments), 400)})]`);
    }
    const text = parts.join("\n").trim();
    return text === "" ? undefined : `[assistant]: ${clipSummaryText(text, BRANCH_SUMMARY_EVENT_CHARS)}`;
  }
  if (event.type === "tool-result") {
    const text = event.data.content.flatMap((b) => (b.type === "text" ? [b.text] : [])).join("\n").trim();
    if (text === "") return undefined;
    const tag = event.data.isError ? `tool-result ${event.data.name} ERROR` : `tool-result ${event.data.name}`;
    return `[${tag}]: ${clipSummaryText(text, BRANCH_SUMMARY_EVENT_CHARS)}`;
  }
  return undefined;
}

async function summarizeDroppedBranch(
  ctx: Context,
  target: Session,
  toSeq: number,
  signal: AbortSignal,
  defaultModel: Config["defaultModel"],
): Promise<string | undefined> {
  const model = target.state().model ?? (typeof defaultModel === "function" ? defaultModel() : defaultModel);
  if (model === undefined) return undefined;
  const dropped = currentBranch(target.events).filter((event) => event.seq > toSeq);
  if (dropped.length === 0) return undefined;

  const lines: string[] = [];
  let total = 0;
  for (const event of dropped) {
    const line = formatDroppedEvent(event);
    if (line === undefined) continue;
    if (total + line.length > BRANCH_SUMMARY_MAX_CHARS && lines.length > 0) break;
    lines.push(line);
    total += line.length;
  }
  if (lines.length === 0) return undefined;

  const request: LlmRequest = {
    provider: model.provider,
    model: model.model,
    system: BRANCH_SUMMARY_SYSTEM,
    messages: [{ role: "user", content: [{ type: "text", text: `${BRANCH_SUMMARY_REQUEST}\n\n${lines.join("\n\n")}` }] }],
    maxTokens: 1_024,
  };
  const assembler = new BlockAssembler();
  try {
    for await (const chunk of ctx.llm.stream(request, signal)) assembler.push(chunk);
  } catch (error) {
    if (signal.aborted) throw error;
    ctx.logger("sessions-rpc").warn("summarizing dropped branch for %s failed: %s", target.id, String(error));
    return undefined;
  }
  if (signal.aborted) throw new Error("Request aborted");
  const response = assembler.result();
  const summary = response.message.content
    .flatMap((block) => (block.type === "text" ? [block.text] : []))
    .join("")
    .trim();
  if (response.reason === "error" || response.reason === "aborted" || summary === "") {
    ctx.logger("sessions-rpc").warn("summarizing dropped branch for %s failed: %s", target.id, response.error?.message ?? response.reason);
    return undefined;
  }
  return summary;
}

type Params = Record<string, unknown>;

function params(value: unknown): Params {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new RpcError(ErrorCode.InvalidParams, "params must be an object");
  return value as Params;
}

function str(p: Params, key: string): string {
  const value = p[key];
  if (typeof value !== "string" || value === "") throw new RpcError(ErrorCode.InvalidParams, `${key} must be a non-empty string`);
  return value;
}

function optionalSeq(p: Params, key: string): number | undefined {
  const value = p[key];
  if (value === undefined) return undefined;
  if (!Number.isInteger(value) || (value as number) < 0) throw new RpcError(ErrorCode.InvalidParams, `${key} must be a non-negative integer`);
  return value as number;
}

function effortOf(value: unknown): Effort {
  if (typeof value !== "string") {
    throw new RpcError(ErrorCode.InvalidParams, "effort must be a non-empty effort identifier");
  }
  const trimmed = value.trim();
  if (!EFFORT_ID_RE.test(trimmed)) {
    throw new RpcError(ErrorCode.InvalidParams, "effort must be a valid effort identifier (e.g. off, minimal, low, medium, high, xhigh, max)");
  }
  return trimmed;
}

/** Validate prompt content; a string becomes one text block. */
export function toUserContent(value: unknown): UserContent[] {
  const content = (typeof value === "string" ? [{ type: "text", text: value }] : value) as PromptContent;
  if (!Array.isArray(content) || content.length === 0) throw new RpcError(ErrorCode.InvalidParams, "content must be a string or a non-empty list of blocks");
  return content.map((block, index): UserContent => {
    if (block?.type === "text" && typeof block.text === "string") {
      return { type: "text", text: block.text, ...(block.meta === true ? { meta: true } : {}) };
    }
    if (block?.type === "image" && typeof block.mimeType === "string" && typeof block.data === "string") {
      return { type: "image", mimeType: block.mimeType, data: block.data };
    }
    throw new RpcError(ErrorCode.InvalidParams, `content[${index}] must be a text or image block`);
  });
}

/** Run `fn`, mapping the agent's errors to protocol errors. */
async function guarded<T>(fn: () => T | Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (error) {
    if (error instanceof AgentBusyError) throw new RpcError(ErrorCode.SessionBusy, error.message);
    if (error instanceof NoModelError) throw new RpcError(ErrorCode.InvalidParams, error.message);
    throw error;
  }
}

interface Subscriber {
  notify: RpcCall["notify"];
  /** Stops listening for the connection's close and lets the session unload. */
  release: () => void;
}

export function apply(ctx: Context, config: Config = {}): void {
  /** sessionId → subscribers; a connection is identified by its close signal. */
  const subscribers = new Map<string, Map<AbortSignal, Subscriber>>();

  ctx.on("session/event", (session, event) => {
    const notification: SessionEventNotification = { sessionId: session.id, seq: event.seq, event };
    for (const subscriber of subscribers.get(session.id)?.values() ?? []) subscriber.notify("session/event", notification);
  });
  ctx.on("session/delta", (session, liveSeq, delta) => {
    const notification: SessionDeltaNotification = { sessionId: session.id, liveSeq, delta };
    for (const subscriber of subscribers.get(session.id)?.values() ?? []) subscriber.notify("session/delta", notification);
  });

  const unsubscribe = (sessionId: string, signal: AbortSignal) => {
    const forSession = subscribers.get(sessionId);
    forSession?.get(signal)?.release();
    forSession?.delete(signal);
    if (forSession?.size === 0) subscribers.delete(sessionId);
  };

  const session = async (p: Params): Promise<Session> => {
    const id = str(p, "sessionId");
    const found = await ctx.sessions.get(id);
    if (found === undefined) throw new RpcError(ErrorCode.SessionNotFound, `No session ${id}`);
    return found;
  };

  const runnerFor = (sessionId: string): Agents => {
    const bot = ctx.get("botHarness") as (Agents & { ownsSession?: (id: string) => boolean }) | undefined;
    if (bot?.ownsSession?.(sessionId) === true) return bot;
    return ctx.agents;
  };

  const idle = (target: Session) => {
    if (runnerFor(target.id).status(target.id).running) throw new RpcError(ErrorCode.SessionBusy, `Session ${target.id} is running`);
  };

  const model = (p: Params): ModelChoice => {
    const choice = { provider: str(p, "provider"), model: str(p, "model") };
    if (!ctx.llm.listProviders().some((provider) => provider.id === choice.provider)) {
      throw new RpcError(ErrorCode.InvalidParams, `Unknown provider ${choice.provider}`);
    }
    return choice;
  };

  const status = (id: string): AgentStatusInfo => runnerFor(id).status(id);

  const toSessionInfo = (summary: SessionSummary): SessionInfo => {
    const cost = ctx.get("pricing")?.estimateSessionCost(summary) ?? 0;
    return cost > 0 ? { ...summary, estimatedCostUsd: cost } : summary;
  };

  const methods: Record<string, (p: Params, call: RpcCall) => unknown> = {
    "session.create": (p): SessionResult => {
      const cwd = str(p, "cwd");
      if (!isAbsolute(cwd) || !existsSync(cwd) || !statSync(cwd).isDirectory()) {
        throw new RpcError(ErrorCode.InvalidParams, "cwd must be the absolute path of an existing directory");
      }
      const fallback = config.defaultModel;
      const chosen = p.model === undefined ? (typeof fallback === "function" ? fallback() : fallback) : model(params(p.model));
      const created = ctx.sessions.create({ cwd });
      if (chosen !== undefined) created.setModel(chosen);
      if (p.effort !== undefined) created.setEffort(effortOf(p.effort));
      return { session: toSessionInfo(created.summary()) };
    },

    "session.list": async (): Promise<SessionListResult> => ({
      sessions: (await ctx.sessions.list()).map(toSessionInfo),
    }),

    "session.search": async (p): Promise<SessionSearchResult> => {
      if (typeof p.query !== "string") {
        throw new RpcError(ErrorCode.InvalidParams, "query must be a string");
      }
      const cwd = typeof p.cwd === "string" && p.cwd.trim() !== "" ? p.cwd.trim() : undefined;
      const includeArchived = p.includeArchived === true;
      const limit = optionalSeq(p, "limit");
      const hits = await ctx.sessions.search(p.query, {
        ...(cwd === undefined ? {} : { cwd }),
        ...(includeArchived ? { includeArchived: true } : {}),
        ...(limit !== undefined && limit > 0 ? { limit } : {}),
      });
      return {
        hits: hits.map((hit) => ({ session: toSessionInfo(hit.session), snippet: hit.snippet })),
      };
    },

    "session.get": async (p): Promise<SessionGetResult> => {
      const target = await session(p);
      const state = target.state();
      return {
        session: toSessionInfo(target.summary()),
        ...(state.model === undefined ? {} : { model: state.model }),
        ...(state.effort === undefined ? {} : { effort: state.effort }),
        status: status(target.id),
      };
    },

    "session.subscribe": async (p, call): Promise<SessionSubscribeResult> => {
      const target = await session(p);
      const afterSeq = optionalSeq(p, "afterSeq") ?? 0;
      let forSession = subscribers.get(target.id);
      if (forSession === undefined) {
        forSession = new Map();
        subscribers.set(target.id, forSession);
      }
      if (!forSession.has(call.signal)) {
        const signal = call.signal;
        const onClose = () => unsubscribe(target.id, signal);
        const unhold = ctx.sessions.hold(target.id);
        signal.addEventListener("abort", onClose, { once: true });
        forSession.set(signal, {
          notify: call.notify,
          release: () => {
            signal.removeEventListener("abort", onClose);
            unhold();
          },
        });
      }
      return {
        events: target.events.filter((event) => event.seq > afterSeq),
        status: status(target.id),
        liveSeq: target.currentLiveSeq,
      };
    },

    "session.unsubscribe": (p, call) => {
      unsubscribe(str(p, "sessionId"), call.signal);
      return {};
    },

    "session.prompt": async (p): Promise<SessionPromptResult> => {
      const target = await session(p);
      const content = toUserContent(p.content);
      return { seq: (await guarded(() => runnerFor(target.id).prompt(target, content))).seq };
    },

    "session.steer": async (p): Promise<SessionPromptResult> => {
      const target = await session(p);
      const content = toUserContent(p.content);
      const event = await guarded(() => runnerFor(target.id).steer(target, content));
      return event === undefined ? {} : { seq: event.seq };
    },

    "session.followUp": async (p): Promise<SessionPromptResult> => {
      const target = await session(p);
      const content = toUserContent(p.content);
      const event = await guarded(() => runnerFor(target.id).followUp(target, content));
      return event === undefined ? {} : { seq: event.seq };
    },

    "session.abort": async (p) => {
      const target = await session(p);
      await runnerFor(target.id).abort(target.id);
      return {};
    },

    "session.fork": async (p): Promise<SessionResult> => {
      const source = await session(p);
      const seq = optionalSeq(p, "seq") ?? source.lastSeq;
      if (seq > source.lastSeq) throw new RpcError(ErrorCode.InvalidParams, `seq ${seq} is past the end (${source.lastSeq})`);
      // A side chat may start while its source runs: it copies up to the last settled point.
      if (p.side === true) return { session: ctx.sessions.fork(source, settledSeq(source.events, seq), { side: true }).summary() };
      return { session: ctx.sessions.fork(source, seq).summary() };
    },

    "session.rewind": async (p, call): Promise<AppendResult> => {
      const target = await session(p);
      idle(target);
      const toSeq = optionalSeq(p, "toSeq");
      if (toSeq === undefined || toSeq > target.lastSeq) throw new RpcError(ErrorCode.InvalidParams, "toSeq must be a seq of this session");
      const reason = typeof p.reason === "string" ? p.reason : undefined;
      if (p.branchSummary !== undefined && typeof p.branchSummary !== "string") {
        throw new RpcError(ErrorCode.InvalidParams, "branchSummary must be a string");
      }
      if (p.summarizeDropped !== undefined && typeof p.summarizeDropped !== "boolean") {
        throw new RpcError(ErrorCode.InvalidParams, "summarizeDropped must be a boolean");
      }
      const explicitSummary = typeof p.branchSummary === "string" && p.branchSummary.trim() !== "" ? p.branchSummary.trim() : undefined;
      const branchSummary = explicitSummary ?? (
        p.summarizeDropped === true
          ? await summarizeDroppedBranch(ctx, target, toSeq, call.signal, config.defaultModel)
          : undefined
      );
      return {
        seq: target.append("rewind", {
          toSeq,
          ...(reason === undefined ? {} : { reason }),
          ...(branchSummary === undefined ? {} : { branchSummary }),
        }).seq,
      };
    },

    "session.compact": async (p, call): Promise<Partial<AppendResult>> => {
      const target = await session(p);
      const event = await guarded(() => runnerFor(target.id).compact(target, call.signal));
      return event === undefined ? {} : { seq: event.seq };
    },

    "session.rename": async (p): Promise<AppendResult> => {
      const target = await session(p);
      return { seq: target.append("label", { title: str(p, "title") }).seq };
    },

    "session.archive": async (p): Promise<AppendResult> => {
      const target = await session(p);
      return { seq: target.append("label", { archived: p.archived !== false }).seq };
    },

    "session.delete": async (p) => {
      const target = await session(p);
      idle(target);
      for (const subscriber of subscribers.get(target.id)?.values() ?? []) subscriber.release();
      subscribers.delete(target.id);
      await ctx.sessions.delete(target.id);
      return {};
    },

    "session.export": async (p): Promise<SessionExportResult> => {
      const target = await session(p);
      const destination = str(p, "destination");
      if (!isAbsolute(destination)) throw new RpcError(ErrorCode.InvalidParams, "destination must be an absolute path");
      mkdirSync(dirname(destination), { recursive: true });
      writeFileSync(destination, sessionMarkdown(target.events));
      return { path: destination };
    },

    "model.set": async (p): Promise<AppendResult> => {
      const target = await session(p);
      return { seq: target.setModel(model(p)).seq };
    },

    "model.setEffort": async (p): Promise<AppendResult> => {
      const target = await session(p);
      return { seq: target.setEffort(effortOf(p.effort)).seq };
    },

    "usage.summary": async (): Promise<UsageSummaryResult> => {
      const sessions = await ctx.sessions.list();
      const pricing = ctx.get("pricing");
      const total = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };
      let reasoningTokens = 0;
      let totalCostUsd = 0;
      let messages = 0;
      for (const item of sessions) {
        messages += item.messageCount;
        for (const key of Object.keys(total) as Array<keyof typeof total>) total[key] += item.usage[key];
        reasoningTokens += item.usage.reasoningTokens ?? 0;
        if (pricing !== undefined) totalCostUsd += pricing.estimateSessionCost(item);
      }
      return {
        sessions: sessions.length,
        messages,
        usage: reasoningTokens > 0 ? { ...total, reasoningTokens } : total,
        ...(totalCostUsd > 0 ? { totalCostUsd } : {}),
      };
    },
  };

  for (const [method, handler] of Object.entries(methods)) {
    ctx.effect(() => ctx.rpc.method(method, (raw, call) => handler(params(raw ?? {}), call)), `${name}: ${method}`);
  }
}

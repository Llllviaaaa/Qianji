/**
 * Two-stage context compaction for the agent loop (ADR 0008, ADR 0019, ADR 0022,
 * ADR 0024): Stage 1 non-destructive `tool-result` pruning with 65% hysteresis,
 * Stage 2 same-prefix cache-eligible summarization with automatic serialized
 * fallback, Turn-1 estimation, and active working-set slice rehydration.
 */
import type { Context } from "@deepseek-ai/cordis";
import type { AgentDelta } from "@qianji/agent";
import { BlockAssembler, type AssistantContent, type LlmRequest, type Message } from "@qianji/llm";
import {
  charTokens,
  compactionPoint,
  currentBranch,
  deriveState,
  slidingCompactionPoint,
  type EventOf,
  type ModelRef,
  type Session,
} from "@qianji/session";
import "@qianji/system-prompt";
import "@qianji/tools";
import {
  PRUNE_HYSTERESIS_RATIO,
  PRUNE_IDLE_RATIO,
  PRUNE_IDLE_TTL_MS,
  estimateBranchContextTokens,
  pruneOldToolResults,
} from "./pruner.ts";
import { buildCompactionWorkingSetAddendum } from "./rehydrate.ts";
import { SUMMARY_CLIP_LEVELS, serializeConversation, shrinkForSummary } from "./summary-input.ts";

export interface AgentLoopConfig {
  /** Model calls per run before it stops with `max-turns`. */
  maxTurns?: number;
  /** Maximum concurrent read-only tool calls per batch. Default `8`. */
  maxParallelTools?: number;
  /**
   * Compact before a turn once the previous call plus trailing events used more
   * tokens than this. Takes precedence over `compactAtContextRatio`.
   */
  compactAboveTokens?: number;
  /**
   * Without `compactAboveTokens`: compact before a turn once the previous call
   * plus trailing events used this share of the model's context window, as the
   * provider's model list reports it (ADR 0019). Models without a known window
   * are not compacted early unless `defaultContextWindow` is set. Default 0.8; 0 turns it off.
   */
  compactAtContextRatio?: number;
  /** Optional fallback context window (e.g. `128_000`) when the provider model list omits `contextWindow`. */
  defaultContextWindow?: number;
  /** Output budget of the compaction summary call. */
  summaryMaxTokens?: number;
  /** Approximate recent tokens kept verbatim during mid-run proactive compaction (`turn >= 2`). Default `12_000`. */
  keepRecentTokens?: number;
  /** Reuse the session's exact `system` + `tools` + `messages` prefix for cache-eligible summarization. Default `true`. */
  samePrefixCompaction?: boolean;
  /** Optional conservative default `maxTokens` per turn before silent ceiling escalation. */
  defaultMaxTokens?: number;
  /** Optional ceiling `maxTokens` for one-shot silent replay on `reason === "length"`. */
  escalatedMaxTokens?: number;
}

export const COMPACTION_SYSTEM = `You summarize a conversation between a user and a coding agent so the agent can continue the work with only your summary as context.`;

export const COMPACTION_REQUEST = `Summarize the conversation above so the agent can seamlessly continue the active task with only your summary as context. Use these exact markdown sections:

## Goal
State the active user objective, target behavior, and acceptance criteria.

## Constraints & Preferences
List explicit requirements, invariants, style/tooling rules, and user preferences.

## Progress
Summarize completed work, exact file paths/symbols modified or read, commands run, and verified findings or errors.

## Key Decisions
Record design choices made, dead ends ruled out, and why.

## Next Steps
State the remaining steps and the exact next concrete action to execute.

Be specific (paths, symbol names, values, errors) and concise. Reply with the summary only.`;

export const FORKED_COMPACTION_REQUEST = `IMPORTANT: Do NOT call any tools. ${COMPACTION_REQUEST}`;

const DEFAULT_COMPACT_RATIO = 0.8;
const DEFAULT_KEEP_RECENT_TOKENS = 12_000;
/** A context this small is never worth summarizing, so its model's window is not even looked up. */
const MIN_COMPACT_TOKENS = 8_192;
/** How long a model's metadata is remembered, and how long its lookup may take. */
const WINDOW_TTL_MS = 10 * 60_000;
const WINDOW_LOOKUP_TIMEOUT_MS = 5_000;

export interface CachedModelMeta {
  contextWindow?: number;
  maxOutputTokens?: number;
}

export type WindowCache = Map<string, { at: number; meta: Promise<CachedModelMeta> }>;

export interface CompactionHost {
  ctx: Pick<Context, "llm" | "logger"> & Partial<Pick<Context, "tools" | "systemPrompt">>;
  config: AgentLoopConfig;
  windows: WindowCache;
  delta: (session: Session, delta: AgentDelta) => void;
}

function raceAbort<T>(promise: Promise<T>, signal: AbortSignal): Promise<T | undefined> {
  if (signal.aborted) return Promise.resolve(undefined);
  return new Promise((resolve, reject) => {
    const onAbort = () => resolve(undefined);
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (error) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      },
    );
  });
}

function lookupModelMeta(host: CompactionHost, model: ModelRef, signal: AbortSignal): Promise<CachedModelMeta | undefined> {
  const key = `${model.provider}\u0000${model.model}`;
  const cached = host.windows.get(key);
  if (cached !== undefined && Date.now() - cached.at < WINDOW_TTL_MS) {
    return raceAbort(cached.meta, signal);
  }
  const meta = host.ctx.llm.listModels(model.provider, AbortSignal.timeout(WINDOW_LOOKUP_TIMEOUT_MS))
    .then((models): CachedModelMeta => {
      const found = models.find((candidate) => candidate.id === model.model);
      return {
        ...(found?.contextWindow !== undefined && found.contextWindow > 0 ? { contextWindow: found.contextWindow } : {}),
        ...(found?.maxOutputTokens !== undefined && found.maxOutputTokens > 0 ? { maxOutputTokens: found.maxOutputTokens } : {}),
      };
    })
    .catch((): CachedModelMeta => ({}));
  host.windows.set(key, { at: Date.now(), meta });
  return raceAbort(meta, signal);
}

/** Known `maxOutputTokens` ceiling for `model` (from provider metadata or `config.escalatedMaxTokens`). */
export async function maxOutputCeiling(host: CompactionHost, model: ModelRef, signal: AbortSignal): Promise<number | undefined> {
  if (host.config.escalatedMaxTokens !== undefined && host.config.escalatedMaxTokens > 0) {
    return host.config.escalatedMaxTokens;
  }
  const meta = await lookupModelMeta(host, model, signal);
  return meta?.maxOutputTokens;
}

/** The token count past which `model`'s context counts as full, when its window is known or configured. */
async function contextLimit(host: CompactionHost, model: ModelRef, signal: AbortSignal): Promise<number | undefined> {
  const ratio = host.config.compactAtContextRatio ?? DEFAULT_COMPACT_RATIO;
  if (!(ratio > 0)) return undefined;
  const meta = await lookupModelMeta(host, model, signal);
  const fallback = host.config.defaultContextWindow !== undefined && host.config.defaultContextWindow > 0
    ? host.config.defaultContextWindow
    : undefined;
  const window = meta?.contextWindow ?? fallback;
  return window === undefined ? undefined : Math.floor(window * ratio);
}

async function estimateTurnOneOverhead(host: CompactionHost, session: Session, model: ModelRef, baseTokens: number): Promise<number> {
  const tools = host.ctx.tools?.schemas(session.id) ?? [];
  const toolTokens = tools.length > 0 ? Math.ceil(charTokens(JSON.stringify(tools))) : 0;
  if (host.ctx.systemPrompt === undefined) return toolTokens;
  if (host.config.compactAboveTokens === undefined && baseTokens + toolTokens <= MIN_COMPACT_TOKENS / 2) {
    return toolTokens;
  }
  const system = await host.ctx.systemPrompt.build({ sessionId: session.id, cwd: session.header.cwd, model, tools });
  return toolTokens + Math.ceil(charTokens(system));
}

function extractSummaryText(content: readonly AssistantContent[]): string {
  return content.flatMap((block) => (block.type === "text" ? [block.text] : [])).join("").trim();
}

/**
 * Compact proactively before the next model call: runs Stage 1 `pruneOldToolResults`
 * first and skips Stage 2 LLM summarization when token pressure drops inside the 65%
 * hysteresis band.
 */
export async function compactIfLarge(
  host: CompactionHost,
  session: Session,
  signal: AbortSignal,
  keepLatestTurn: boolean,
): Promise<void> {
  if (signal.aborted) return;
  const state = session.state();
  if (state.model === undefined) return;
  const branch = currentBranch(session.events);
  const tipSeq = branch.at(-1)?.seq ?? 0;
  const initial = estimateBranchContextTokens(session.events);
  const { lastAssistant } = initial;
  if (state.compactedThrough !== undefined) {
    if (lastAssistant !== undefined && state.compactedThrough > lastAssistant.seq) return;
    if (lastAssistant === undefined && state.compactedThrough >= tipSeq) return;
  }

  const overhead = lastAssistant === undefined
    ? await estimateTurnOneOverhead(host, session, state.model, initial.used)
    : 0;
  if (signal.aborted) return;
  const used = initial.used + overhead;

  const explicit = host.config.compactAboveTokens;
  if (explicit === undefined && used <= MIN_COMPACT_TOKENS) return;
  const limit = explicit ?? await contextLimit(host, state.model, signal);
  if (signal.aborted || limit === undefined) return;

  const lastTs = lastAssistant === undefined ? NaN : Date.parse(lastAssistant.ts);
  const isIdleCold = !Number.isNaN(lastTs) && Date.now() - lastTs > PRUNE_IDLE_TTL_MS;
  const overHot = used > limit;
  const overColdIdle = isIdleCold && used > Math.floor(limit * PRUNE_IDLE_RATIO);
  if (!overHot && !overColdIdle) return;

  const keepRecent = host.config.keepRecentTokens ?? DEFAULT_KEEP_RECENT_TOKENS;
  pruneOldToolResults(session, keepRecent);
  const afterPrune = estimateBranchContextTokens(session.events).used + overhead;
  if (afterPrune <= Math.floor(limit * PRUNE_HYSTERESIS_RATIO)) return;

  await summarizeSession(host, session, signal, keepLatestTurn ? "keepLatestTurn" : "sliding");
}

/**
 * Summarize the log and append a compaction; undefined when it failed.
 * For proactive/manual compactions (`keepLatestTurn` / `sliding`), tries same-prefix
 * cache-eligible summarization first and seamlessly falls back to pure-text
 * serialized clipping on error, empty text, or unexpected `tool-call` blocks.
 */
export async function summarizeSession(
  host: CompactionHost,
  session: Session,
  signal: AbortSignal,
  mode: "full" | "keepLatestTurn" | "sliding" = "full",
): Promise<EventOf<"compaction"> | undefined> {
  if (signal.aborted) return undefined;
  const sessionState = session.state();
  const model = sessionState.model;
  const throughSeq = mode === "sliding"
    ? slidingCompactionPoint(session.events, host.config.keepRecentTokens ?? DEFAULT_KEEP_RECENT_TOKENS)
    : compactionPoint(session.events, mode === "keepLatestTurn");
  if (model === undefined || throughSeq === undefined) return undefined;
  host.delta(session, { type: "compaction-start" });
  const head = deriveState(session.events.filter((event) => event.seq <= throughSeq));

  const streamRequest = async (request: LlmRequest) => {
    const assembler = new BlockAssembler();
    for await (const chunk of host.ctx.llm.stream(request, signal)) assembler.push(chunk);
    return assembler.result();
  };

  const askSerialized = async (messages: Message[]) => streamRequest({
    provider: model.provider,
    model: model.model,
    system: COMPACTION_SYSTEM,
    messages: [...serializeConversation(messages), { role: "user", content: [{ type: "text", text: COMPACTION_REQUEST }] }],
    maxTokens: host.config.summaryMaxTokens ?? 8_192,
  });

  const canSamePrefix = mode !== "full"
    && host.config.samePrefixCompaction !== false
    && host.ctx.tools !== undefined
    && host.ctx.systemPrompt !== undefined
    && head.messages.length > 0
    && head.messages.at(-1)?.role !== "user";

  let response: Awaited<ReturnType<typeof streamRequest>> | undefined;
  if (canSamePrefix && host.ctx.tools !== undefined && host.ctx.systemPrompt !== undefined) {
    const startedAt = Date.now();
    const tools = host.ctx.tools.schemas(session.id);
    const system = await host.ctx.systemPrompt.build({ sessionId: session.id, cwd: session.header.cwd, model, tools });
    if (!signal.aborted) {
      const candidate = await streamRequest({
        provider: model.provider,
        model: model.model,
        sessionId: session.id,
        system,
        messages: [...head.messages, { role: "user", content: [{ type: "text", text: FORKED_COMPACTION_REQUEST }] }],
        ...(tools.length === 0 ? {} : { tools }),
        ...(sessionState.effort === undefined ? {} : { effort: sessionState.effort }),
        maxTokens: host.config.summaryMaxTokens ?? 8_192,
      });
      const durationMs = Date.now() - startedAt;
      const hasToolCall = candidate.message.content.some((b) => b.type === "tool-call");
      const candidateText = extractSummaryText(candidate.message.content);
      const valid = candidate.reason !== "error" && !hasToolCall && candidateText !== "";
      host.ctx.logger("agent").info(
        `compaction same-prefix ${session.id}: ok=${valid} cacheReadTokens=${candidate.usage.cacheReadTokens} inputTokens=${candidate.usage.inputTokens} durationMs=${durationMs}`,
      );
      if (valid || candidate.reason === "aborted" || signal.aborted) {
        response = candidate;
      }
    }
  }

  if (response === undefined && !signal.aborted) {
    response = await askSerialized(head.messages);
    for (const level of SUMMARY_CLIP_LEVELS) {
      if (response.reason !== "error" || response.error?.kind !== "context-length" || signal.aborted) break;
      response = await askSerialized(shrinkForSummary(head.messages, level));
    }
  }

  const rawSummary = response === undefined ? "" : extractSummaryText(response.message.content);
  const aborted = signal.aborted || response?.reason === "aborted";
  const ok = !aborted && response !== undefined && response.reason !== "error" && rawSummary !== "";
  if (!ok && !aborted) {
    host.ctx.logger("agent").warn("compacting %s failed: %s", session.id, response?.error?.message ?? response?.reason ?? "empty");
  }
  const addendum = ok ? buildCompactionWorkingSetAddendum(session.events, throughSeq, session.header.cwd) : "";
  const summary = addendum !== "" ? `${rawSummary}\n\n${addendum}` : rawSummary;
  const event = ok ? session.append("compaction", { throughSeq, summary }) : undefined;
  host.delta(session, aborted ? { type: "compaction-end", ok: false, aborted: true } : { type: "compaction-end", ok });
  return event;
}

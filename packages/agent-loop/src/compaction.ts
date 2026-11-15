/**
 * Context compaction for the agent loop (ADR 0008, ADR 0019, ADR 0022):
 * proactive watermark checks (including trailing post-assistant tokens),
 * serialized history summarization with progressive fallback clipping, and
 * working-set rehydration.
 */
import type { Context } from "@deepseek-ai/cordis";
import type { AgentDelta } from "@qianji/agent";
import { BlockAssembler, type LlmRequest, type Message } from "@qianji/llm";
import {
  compactionPoint,
  currentBranch,
  deriveState,
  estimateEventTokens,
  slidingCompactionPoint,
  type EventOf,
  type ModelRef,
  type Session,
} from "@qianji/session";
import { buildCompactionWorkingSetAddendum } from "./rehydrate.ts";
import { SUMMARY_CLIP_LEVELS, serializeConversation, shrinkForSummary } from "./summary-input.ts";

export interface AgentLoopConfig {
  /** Model calls per run before it stops with `max-turns`. */
  maxTurns?: number;
  /**
   * Compact before a turn once the previous call plus trailing events used more
   * tokens than this. Takes precedence over `compactAtContextRatio`.
   */
  compactAboveTokens?: number;
  /**
   * Without `compactAboveTokens`: compact before a turn once the previous call
   * plus trailing events used this share of the model's context window, as the
   * provider's model list reports it (ADR 0019). Models without a known window
   * are not compacted early. Default 0.8; 0 turns it off.
   */
  compactAtContextRatio?: number;
  /** Output budget of the compaction summary call. */
  summaryMaxTokens?: number;
  /** Approximate recent tokens kept verbatim during mid-run proactive compaction (`turn >= 2`). Default `12_000`. */
  keepRecentTokens?: number;
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

const DEFAULT_COMPACT_RATIO = 0.8;
const DEFAULT_KEEP_RECENT_TOKENS = 12_000;
/** A context this small is never worth summarizing, so its model's window is not even looked up. */
const MIN_COMPACT_TOKENS = 8_192;
/** How long a model's context window is remembered, and how long its lookup may take. */
const WINDOW_TTL_MS = 10 * 60_000;
const WINDOW_LOOKUP_TIMEOUT_MS = 5_000;

export type WindowCache = Map<string, { at: number; window: Promise<number | undefined> }>;

export interface CompactionHost {
  ctx: Pick<Context, "llm" | "logger">;
  config: AgentLoopConfig;
  windows: WindowCache;
  delta: (session: Session, delta: AgentDelta) => void;
}

function totalTokens(usage: { inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheWriteTokens: number }): number {
  return usage.inputTokens + usage.outputTokens + usage.cacheReadTokens + usage.cacheWriteTokens;
}

/** `model`'s context window from its provider's model list, cached; undefined when unknown. */
function contextWindow(host: CompactionHost, model: ModelRef): Promise<number | undefined> {
  const key = `${model.provider}\u0000${model.model}`;
  const cached = host.windows.get(key);
  if (cached !== undefined && Date.now() - cached.at < WINDOW_TTL_MS) return cached.window;
  const window = host.ctx.llm.listModels(model.provider, AbortSignal.timeout(WINDOW_LOOKUP_TIMEOUT_MS))
    .then((models) => {
      const found = models.find((candidate) => candidate.id === model.model)?.contextWindow;
      return found !== undefined && found > 0 ? found : undefined;
    })
    .catch(() => undefined);
  host.windows.set(key, { at: Date.now(), window });
  return window;
}

/** The token count past which `model`'s context counts as full, when its window is known. */
async function contextLimit(host: CompactionHost, model: ModelRef): Promise<number | undefined> {
  const ratio = host.config.compactAtContextRatio ?? DEFAULT_COMPACT_RATIO;
  if (!(ratio > 0)) return undefined;
  const window = await contextWindow(host, model);
  return window === undefined ? undefined : Math.floor(window * ratio);
}

/**
 * Compact proactively before the next model call when the last assistant usage
 * plus estimated tokens of trailing branch events exceeds the configured limit.
 */
export async function compactIfLarge(
  host: CompactionHost,
  session: Session,
  signal: AbortSignal,
  keepLatestTurn: boolean,
): Promise<void> {
  const state = session.state();
  const branch = currentBranch(session.events);
  const last = branch.findLast((event) => event.type === "assistant");
  if (last?.type !== "assistant" || state.model === undefined) return;
  if (state.compactedThrough !== undefined && state.compactedThrough > last.seq) return;

  const lastTokens = totalTokens(last.data.usage);
  let trailingTokens = 0;
  for (const ev of branch) {
    if (ev.seq > last.seq) trailingTokens += estimateEventTokens(ev);
  }
  const used = lastTokens + trailingTokens;

  const explicit = host.config.compactAboveTokens;
  if (explicit === undefined && used <= MIN_COMPACT_TOKENS) return;
  const limit = explicit ?? await contextLimit(host, state.model);
  if (limit === undefined || used <= limit) return;
  await summarizeSession(host, session, signal, keepLatestTurn ? "keepLatestTurn" : "sliding");
}

/**
 * Summarize the log and append a compaction; undefined when it failed.
 * Mid-run (`sliding`) keeps the recent step window verbatim while compacting
 * earlier history; on turn 1 or manual compact (`keepLatestTurn`) the active
 * user turn stays verbatim; emergency overflow (`full`) summarizes all history.
 */
export async function summarizeSession(
  host: CompactionHost,
  session: Session,
  signal: AbortSignal,
  mode: "full" | "keepLatestTurn" | "sliding" = "full",
): Promise<EventOf<"compaction"> | undefined> {
  const model = session.state().model;
  const throughSeq = mode === "sliding"
    ? slidingCompactionPoint(session.events, host.config.keepRecentTokens ?? DEFAULT_KEEP_RECENT_TOKENS)
    : compactionPoint(session.events, mode === "keepLatestTurn");
  if (model === undefined || throughSeq === undefined) return undefined;
  host.delta(session, { type: "compaction-start" });
  const head = deriveState(session.events.filter((event) => event.seq <= throughSeq));
  const ask = async (messages: Message[]) => {
    const assembler = new BlockAssembler();
    const request: LlmRequest = {
      provider: model.provider,
      model: model.model,
      system: COMPACTION_SYSTEM,
      messages: [...serializeConversation(messages), { role: "user", content: [{ type: "text", text: COMPACTION_REQUEST }] }],
      maxTokens: host.config.summaryMaxTokens ?? 8_192,
    };
    for await (const chunk of host.ctx.llm.stream(request, signal)) assembler.push(chunk);
    return assembler.result();
  };
  // The serialized history verbatim first; when even the summary request is too long, clip it further (ADR 0019).
  let response = await ask(head.messages);
  for (const level of SUMMARY_CLIP_LEVELS) {
    if (response.reason !== "error" || response.error?.kind !== "context-length" || signal.aborted) break;
    response = await ask(shrinkForSummary(head.messages, level));
  }
  const rawSummary = response.message.content
    .flatMap((block) => (block.type === "text" ? [block.text] : []))
    .join("")
    .trim();
  const ok = response.reason !== "error" && response.reason !== "aborted" && rawSummary !== "";
  if (!ok) host.ctx.logger("agent").warn("compacting %s failed: %s", session.id, response.error?.message ?? response.reason);
  const addendum = ok ? buildCompactionWorkingSetAddendum(session.events, throughSeq) : "";
  const summary = addendum !== "" ? `${rawSummary}\n\n${addendum}` : rawSummary;
  const event = ok ? session.append("compaction", { throughSeq, summary }) : undefined;
  host.delta(session, { type: "compaction-end", ok });
  return event;
}

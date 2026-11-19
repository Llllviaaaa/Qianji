/**
 * SSE stream translation for OpenAI-compatible Chat Completions endpoints,
 * including streaming `<think>...</think>` extraction, structured `delta.content`
 * parts, `choice.message` fallback, and multi-chunk `tool_calls` assembly.
 */
import { errorFromPayload, LlmError, type FinishReason, type StreamChunk } from "@qianji/llm";
import { InlineThinkParser, type ThinkSegment } from "./inline-think.ts";

const FINISH_REASONS: Record<string, FinishReason | "retryable-error"> = {
  stop: "stop",
  end_turn: "stop",
  length: "length",
  max_tokens: "length",
  model_context_window_exceeded: "length",
  tool_calls: "tool-use",
  function_call: "tool-use",
  tool_use: "tool-use",
  content_filter: "refusal",
  safety: "refusal",
  recitation: "refusal",
  prohibited_content: "refusal",
  blocklist: "refusal",
  spii: "refusal",
  image_safety: "refusal",
  malformed_function_call: "retryable-error",
  unexpected_tool_call: "retryable-error",
  error: "retryable-error",
  network_error: "retryable-error",
  other: "retryable-error",
};

function classifyOpenAiFinishReason(raw: string): FinishReason | "retryable-error" {
  return FINISH_REASONS[raw.trim().toLowerCase()] ?? "stop";
}

interface WireContentPart {
  type?: string;
  text?: string | null;
  thinking?: string | null;
  reasoning?: string | null;
}

interface WireToolCall {
  index?: number;
  id?: string;
  function?: { name?: string; arguments?: string };
}

interface WirePayload {
  content?: string | Array<WireContentPart | string> | null;
  reasoning_content?: string | null;
  reasoning?: string | null;
  tool_calls?: WireToolCall[] | null;
}

interface WireChunk {
  choices?: Array<{ delta?: WirePayload | null; message?: WirePayload | null; finish_reason?: string | null }>;
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    prompt_tokens_details?: { cached_tokens?: number };
    completion_tokens_details?: { reasoning_tokens?: number };
    prompt_cache_hit_tokens?: number;
  } | null;
  error?: { message?: string; code?: unknown };
}

interface ToolEntry {
  blockIndex: number;
  id?: string;
  name: string;
  started: boolean;
}

interface ToolIndexTracker {
  toolState: Map<number, ToolEntry>;
  activeAliasByWireIndex: Map<number, number>;
  lastImplicitWireIndex: number | undefined;
  nextSyntheticWireIndex: number;
}

function payloadHasContent(payload: WirePayload | null | undefined): boolean {
  if (payload === undefined || payload === null) return false;
  const reasoning = payload.reasoning_content ?? payload.reasoning;
  if (typeof reasoning === "string" && reasoning !== "") return true;
  if (typeof payload.content === "string" && payload.content !== "") return true;
  if (Array.isArray(payload.content)) {
    const hasPart = payload.content.some((part) => {
      if (typeof part === "string") return part !== "";
      if (typeof part !== "object" || part === null) return false;
      const text = part.thinking ?? part.text ?? part.reasoning;
      return typeof text === "string" && text !== "";
    });
    if (hasPart) return true;
  }
  return Array.isArray(payload.tool_calls) && payload.tool_calls.length > 0;
}

function resolveToolWireIndex(call: WireToolCall, callId: string | undefined, tracker: ToolIndexTracker): number {
  const { toolState, activeAliasByWireIndex } = tracker;
  if (typeof call.index === "number") {
    if (callId === undefined) return activeAliasByWireIndex.get(call.index) ?? call.index;
    const byId = [...toolState.entries()].find(([, entry]) => entry.id === callId);
    if (byId !== undefined) return byId[0];
    const existingAtIndex = toolState.get(call.index);
    if (existingAtIndex !== undefined && existingAtIndex.id !== undefined && existingAtIndex.id !== callId) {
      const synthetic = tracker.nextSyntheticWireIndex++;
      activeAliasByWireIndex.set(call.index, synthetic);
      return synthetic;
    }
    activeAliasByWireIndex.delete(call.index);
    return call.index;
  }
  if (callId !== undefined) {
    const byId = [...toolState.entries()].find(([, entry]) => entry.id === callId);
    if (byId !== undefined) return byId[0];
    const pending = tracker.lastImplicitWireIndex !== undefined ? toolState.get(tracker.lastImplicitWireIndex) : undefined;
    if (tracker.lastImplicitWireIndex !== undefined && pending !== undefined && pending.id === undefined && !pending.started) {
      return tracker.lastImplicitWireIndex;
    }
    const synthetic = tracker.nextSyntheticWireIndex++;
    tracker.lastImplicitWireIndex = synthetic;
    return synthetic;
  }
  const wireIndex = tracker.lastImplicitWireIndex ?? 0;
  tracker.lastImplicitWireIndex ??= wireIndex;
  return wireIndex;
}

/** Translate the provider's SSE stream into StreamChunks. Exported for the tests. */
export async function* translateStream(events: AsyncIterable<{ data: string }>, providerId: string): AsyncGenerator<StreamChunk> {
  let next = 0;
  let thinkingIndex: number | undefined;
  let textIndex: number | undefined;
  const thinkParser = new InlineThinkParser();
  const tracker: ToolIndexTracker = {
    toolState: new Map<number, ToolEntry>(),
    activeAliasByWireIndex: new Map<number, number>(),
    lastImplicitWireIndex: undefined,
    nextSyntheticWireIndex: 10_000,
  };
  const { toolState } = tracker;
  let reason: FinishReason | undefined;
  let rawFinishReason: string | undefined;
  let rawErrorFinishReason: string | undefined;
  let emittedContent = false;
  let reportedOutputTokens: number | undefined;
  let sawDone = false;

  function* emitThinking(text: string): Generator<StreamChunk> {
    if (text === "") return;
    thinkingIndex ??= next++;
    emittedContent = true;
    yield { type: "thinking-delta", index: thinkingIndex, text };
  }

  function* emitText(text: string): Generator<StreamChunk> {
    if (text === "") return;
    textIndex ??= next++;
    emittedContent = true;
    yield { type: "text-delta", index: textIndex, text };
  }

  function* emitSegments(segments: ThinkSegment[]): Generator<StreamChunk> {
    for (const seg of segments) {
      if (seg.kind === "thinking") yield* emitThinking(seg.text);
      else yield* emitText(seg.text);
    }
  }

  for await (const event of events) {
    if (event.data === "[DONE]") {
      sawDone = true;
      break;
    }
    let chunk: WireChunk;
    try {
      chunk = JSON.parse(event.data) as WireChunk;
    } catch {
      throw new LlmError({
        kind: "unknown",
        provider: providerId,
        message: `${providerId} sent malformed stream data`,
        retryable: false,
        rawBody: event.data.trim().slice(0, 2_000) || undefined,
      });
    }
    if (chunk.error !== undefined) {
      const parsed = errorFromPayload(providerId, event.data);
      if (parsed.kind === "unknown") {
        throw new LlmError({ ...parsed.toInfo(), kind: "server", retryable: true });
      }
      throw parsed;
    }
    for (const choice of chunk.choices ?? []) {
      const useMessageFallback =
        !payloadHasContent(choice.delta)
        && !emittedContent
        && !thinkParser.sawInput
        && toolState.size === 0
        && choice.message !== undefined
        && choice.message !== null;
      const payload: WirePayload = (useMessageFallback ? choice.message : choice.delta) ?? {};

      const thinking = payload.reasoning_content ?? payload.reasoning;
      if (typeof thinking === "string" && thinking !== "") yield* emitThinking(thinking);

      if (typeof payload.content === "string" && payload.content !== "") {
        yield* emitSegments(thinkParser.push(payload.content));
      } else if (Array.isArray(payload.content)) {
        for (const part of payload.content) {
          if (typeof part === "string") {
            if (part !== "") yield* emitSegments(thinkParser.push(part));
            continue;
          }
          if (typeof part !== "object" || part === null) continue;
          if (part.type === "thinking" || part.type === "reasoning") {
            const partThinking = part.thinking ?? part.text ?? part.reasoning;
            if (typeof partThinking === "string" && partThinking !== "") yield* emitThinking(partThinking);
          } else if (part.type === "text" || part.type === "output_text" || part.type === undefined) {
            if (typeof part.text === "string" && part.text !== "") yield* emitSegments(thinkParser.push(part.text));
          }
        }
      }

      if (Array.isArray(payload.tool_calls) && payload.tool_calls.length > 0) {
        yield* emitSegments(thinkParser.finish());
        for (const call of payload.tool_calls) {
          const callId = typeof call.id === "string" && call.id !== "" ? call.id : undefined;
          const wireIndex = resolveToolWireIndex(call, callId, tracker);
          let entry = toolState.get(wireIndex);
          if (entry === undefined) {
            entry = { blockIndex: next++, id: callId, name: "", started: false };
            toolState.set(wireIndex, entry);
          } else if (entry.id === undefined && callId !== undefined) {
            entry.id = callId;
          }
          const rawName = call.function?.name;
          if (!entry.started && typeof rawName === "string" && rawName !== "") entry.name += rawName;
          const args = call.function?.arguments;
          const hasArgs = typeof args === "string" && args !== "";
          if (!entry.started && (entry.name !== "" || hasArgs)) {
            entry.started = true;
            emittedContent = true;
            yield { type: "tool-call-start", index: entry.blockIndex, id: entry.id ?? `call_${entry.blockIndex}`, name: entry.name };
          }
          if (hasArgs) yield { type: "tool-call-delta", index: entry.blockIndex, argumentsDelta: args };
        }
      }

      if (typeof choice.finish_reason === "string") {
        rawFinishReason = choice.finish_reason;
        const classified = classifyOpenAiFinishReason(choice.finish_reason);
        if (classified === "retryable-error") {
          rawErrorFinishReason = choice.finish_reason;
          reason = undefined;
        } else {
          rawErrorFinishReason = undefined;
          reason = classified;
        }
      }
    }
    if (chunk.usage) {
      const cached = chunk.usage.prompt_tokens_details?.cached_tokens ?? chunk.usage.prompt_cache_hit_tokens ?? 0;
      const reasoning = chunk.usage.completion_tokens_details?.reasoning_tokens;
      if (typeof chunk.usage.completion_tokens === "number") reportedOutputTokens = chunk.usage.completion_tokens;
      yield {
        type: "usage",
        usage: {
          inputTokens: Math.max(0, (chunk.usage.prompt_tokens ?? 0) - cached),
          outputTokens: chunk.usage.completion_tokens ?? 0,
          cacheReadTokens: cached,
          ...(typeof reasoning === "number" && reasoning > 0 ? { reasoningTokens: reasoning } : {}),
        },
      };
    }
  }
  if (!sawDone && reason === undefined && rawErrorFinishReason === undefined) {
    throw new LlmError({ kind: "network", message: `${providerId}: upstream stream ended before completion`, retryable: true });
  }
  yield* emitSegments(thinkParser.finish());
  for (const entry of toolState.values()) {
    if (!entry.started) {
      entry.started = true;
      emittedContent = true;
      yield { type: "tool-call-start", index: entry.blockIndex, id: entry.id ?? `call_${entry.blockIndex}`, name: entry.name };
    }
  }
  if (toolState.size === 0 && reason === undefined && rawErrorFinishReason !== undefined) {
    throw new LlmError({
      kind: "server",
      message: `${providerId} aborted generation with finish_reason=${rawFinishReason ?? rawErrorFinishReason}`,
      retryable: true,
    });
  }
  const resolvedReason = toolState.size > 0 && (reason === undefined || reason === "stop") ? "tool-use" : (reason ?? "stop");
  if (
    !emittedContent
    && !thinkParser.sawThinkBlock
    && toolState.size === 0
    && resolvedReason === "stop"
    && (reportedOutputTokens === undefined || reportedOutputTokens === 0)
  ) {
    throw new LlmError({ kind: "server", message: `${providerId} returned an empty response stream (0 output tokens)`, retryable: true });
  }
  yield { type: "finish", reason: resolvedReason };
}

/**
 * LLM adapter for OpenAI-compatible Chat Completions endpoints
 * (`POST {baseUrl}/chat/completions` with `stream: true`). One plugin serves
 * every configured provider of this kind: OpenAI, DeepSeek, OpenRouter,
 * Ollama, vLLM and the like differ only in base URL, key and models.
 */
import type { Context } from "@deepseek-ai/cordis";
import {
  LlmError,
  getJson,
  joinUrl,
  postSse,
  transformMessagesForProvider,
  type FinishReason,
  type LlmAdapter,
  type LlmProtocolSpec,
  type LlmRequest,
  type Message,
  type ModelInfo,
  type StreamChunk,
} from "@qianji/llm";
import {
  clampFallbackEffort,
  effortValue,
  parseDiscoveredModel,
  supportsReasoningEffort,
  type ProviderConfig,
} from "./models.ts";

export { supportsReasoningEffort, type ProviderConfig } from "./models.ts";

export const name = "qianji-llm-openai-compat";
export const inject = ["llm", "credentials"];

export interface Config {
  providers?: ProviderConfig[];
}

type WireMessage = Record<string, unknown>;

function toUserContentParts(content: string | Array<Record<string, unknown>>): Array<Record<string, unknown>> {
  if (Array.isArray(content)) return content;
  return content === "" ? [] : [{ type: "text", text: content }];
}

function pushWireUser(wire: WireMessage[], content: string | Array<Record<string, unknown>>): void {
  const prev = wire.at(-1);
  if (prev?.role !== "user") {
    wire.push({ role: "user", content });
    return;
  }
  if (typeof prev.content === "string" && typeof content === "string") {
    prev.content = prev.content === ""
      ? content
      : content === ""
        ? prev.content
        : `${prev.content}\n\n${content}`;
    return;
  }
  const prevParts = toUserContentParts(prev.content as string | Array<Record<string, unknown>>);
  const nextParts = toUserContentParts(content);
  if (prevParts.length > 0 && nextParts.length > 0) {
    prev.content = [...prevParts, { type: "text", text: "\n\n" }, ...nextParts];
  } else {
    prev.content = [...prevParts, ...nextParts];
  }
}

function toWireMessages(
  system: string | undefined,
  messages: Message[],
  options?: { includeReasoningContent?: boolean },
): WireMessage[] {
  const wire: WireMessage[] = system ? [{ role: "system", content: system }] : [];
  const lastUserIndex = messages.findLastIndex((m) => m.role === "user");
  for (const [index, message] of messages.entries()) {
    if (message.role === "user") {
      const onlyText = message.content.every((block) => block.type === "text");
      pushWireUser(
        wire,
        onlyText
          ? message.content.map((block) => (block.type === "text" ? block.text : "")).join("")
          : message.content.map((block) => block.type === "text"
            ? { type: "text", text: block.text }
            : { type: "image_url", image_url: { url: `data:${block.mimeType};base64,${block.data}` } }),
      );
    } else if (message.role === "assistant") {
      const text = message.content.flatMap((block) => (block.type === "text" ? [block.text] : [])).join("");
      const thinking = message.content.flatMap((block) => (block.type === "thinking" ? [block.text] : [])).join("");
      const calls = message.content.flatMap((block) => (block.type === "tool-call"
        ? [{ id: block.id, type: "function", function: { name: block.name, arguments: JSON.stringify(block.arguments) } }]
        : []));
      if (text === "" && calls.length === 0) continue;
      // DeepSeek/Kimi require `reasoning_content` on intra-turn tool-call loops (`index > lastUserIndex`)
      // while omitting it before the latest user turn (`index < lastUserIndex`).
      const includeReasoning = options?.includeReasoningContent !== false && index > lastUserIndex && thinking !== "";
      wire.push({
        role: "assistant",
        content: text === "" && calls.length > 0 ? null : text,
        ...(includeReasoning ? { reasoning_content: thinking } : {}),
        ...(calls.length > 0 ? { tool_calls: calls } : {}),
      });
    } else {
      const text = message.content.map((block) => (block.type === "text" ? block.text : "[image omitted]")).join("\n");
      wire.push({ role: "tool", tool_call_id: message.callId, content: text });
    }
  }
  return wire;
}

export function buildRequestBody(
  request: LlmRequest,
  provider: ProviderConfig,
  unsupportedReasoningModels?: ReadonlySet<string>,
  unsupportedReasoningContentModels?: ReadonlySet<string>,
): Record<string, unknown> {
  const body: Record<string, unknown> = {
    model: request.model,
    messages: toWireMessages(request.system, transformMessagesForProvider(request.messages, "openai-compat"), {
      includeReasoningContent: !unsupportedReasoningContentModels?.has(request.model),
    }),
    stream: true,
    stream_options: { include_usage: true },
  };
  if (request.tools !== undefined && request.tools.length > 0) {
    body.tools = request.tools.map((tool) => ({
      type: "function",
      function: { name: tool.name, description: tool.description, parameters: tool.parameters },
    }));
  }
  if (request.maxTokens !== undefined) body.max_tokens = request.maxTokens;
  if (request.temperature !== undefined) body.temperature = request.temperature;
  const effort = effortValue(request.effort);
  if (effort !== undefined && supportsReasoningEffort(request.model, provider, unsupportedReasoningModels)) {
    body.reasoning_effort = effort;
  }
  return body;
}

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

interface WireDelta {
  content?: string | null;
  reasoning_content?: string | null;
  reasoning?: string | null;
  tool_calls?: Array<{ index?: number; id?: string; function?: { name?: string; arguments?: string } }>;
}

interface WireChunk {
  choices?: Array<{ delta?: WireDelta; finish_reason?: string | null }>;
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    prompt_tokens_details?: { cached_tokens?: number };
    completion_tokens_details?: { reasoning_tokens?: number };
    prompt_cache_hit_tokens?: number;
  } | null;
  error?: { message?: string; code?: unknown };
}

/** Translate the provider's SSE stream into StreamChunks. Exported for the tests. */
export async function* translateStream(events: AsyncIterable<{ data: string }>, providerId: string): AsyncGenerator<StreamChunk> {
  let next = 0;
  let thinkingIndex: number | undefined;
  let textIndex: number | undefined;
  const toolState = new Map<number, { blockIndex: number; id?: string }>();
  const activeAliasByWireIndex = new Map<number, number>();
  let lastImplicitWireIndex: number | undefined;
  let nextSyntheticWireIndex = 10_000;
  let reason: FinishReason | undefined;
  let rawFinishReason: string | undefined;
  let rawErrorFinishReason: string | undefined;
  let emittedContent = false;
  let reportedOutputTokens: number | undefined;
  let sawDone = false;

  for await (const event of events) {
    if (event.data === "[DONE]") {
      sawDone = true;
      break;
    }
    let chunk: WireChunk;
    try {
      chunk = JSON.parse(event.data) as WireChunk;
    } catch {
      throw new LlmError({ kind: "unknown", message: `${providerId} sent malformed stream data`, retryable: false });
    }
    if (chunk.error !== undefined) {
      throw new LlmError({ kind: "server", message: `${providerId}: ${chunk.error.message ?? "stream error"}`, retryable: true });
    }
    for (const choice of chunk.choices ?? []) {
      const delta = choice.delta ?? {};
      const thinking = delta.reasoning_content ?? delta.reasoning;
      if (typeof thinking === "string" && thinking !== "") {
        thinkingIndex ??= next++;
        emittedContent = true;
        yield { type: "thinking-delta", index: thinkingIndex, text: thinking };
      }
      if (typeof delta.content === "string" && delta.content !== "") {
        textIndex ??= next++;
        emittedContent = true;
        yield { type: "text-delta", index: textIndex, text: delta.content };
      }
      for (const call of delta.tool_calls ?? []) {
        const callId = typeof call.id === "string" && call.id !== "" ? call.id : undefined;
        let wireIndex: number;
        if (typeof call.index === "number") {
          if (callId !== undefined) {
            const byId = [...toolState.entries()].find(([, entry]) => entry.id === callId);
            if (byId !== undefined) {
              wireIndex = byId[0];
            } else {
              const existingAtIndex = toolState.get(call.index);
              if (existingAtIndex !== undefined && existingAtIndex.id !== undefined && existingAtIndex.id !== callId) {
                wireIndex = nextSyntheticWireIndex++;
                activeAliasByWireIndex.set(call.index, wireIndex);
              } else {
                wireIndex = call.index;
                activeAliasByWireIndex.delete(call.index);
              }
            }
          } else {
            wireIndex = activeAliasByWireIndex.get(call.index) ?? call.index;
          }
        } else if (callId !== undefined) {
          const byId = [...toolState.entries()].find(([, entry]) => entry.id === callId);
          if (byId !== undefined) {
            wireIndex = byId[0];
          } else {
            wireIndex = nextSyntheticWireIndex++;
            lastImplicitWireIndex = wireIndex;
          }
        } else {
          wireIndex = lastImplicitWireIndex ?? 0;
          lastImplicitWireIndex ??= wireIndex;
        }
        let entry = toolState.get(wireIndex);
        if (entry === undefined) {
          const blockIndex = next++;
          entry = { blockIndex, id: callId };
          toolState.set(wireIndex, entry);
          emittedContent = true;
          yield { type: "tool-call-start", index: blockIndex, id: callId ?? `call_${blockIndex}`, name: call.function?.name ?? "" };
        }
        const args = call.function?.arguments;
        if (typeof args === "string" && args !== "") yield { type: "tool-call-delta", index: entry.blockIndex, argumentsDelta: args };
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
      if (typeof chunk.usage.completion_tokens === "number") {
        reportedOutputTokens = chunk.usage.completion_tokens;
      }
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
    throw new LlmError({
      kind: "network",
      message: `${providerId}: upstream stream ended before completion`,
      retryable: true,
    });
  }
  if (toolState.size === 0 && reason === undefined && rawErrorFinishReason !== undefined) {
    throw new LlmError({
      kind: "server",
      message: `${providerId} aborted generation with finish_reason=${rawFinishReason ?? rawErrorFinishReason}`,
      retryable: true,
    });
  }
  const resolvedReason = toolState.size > 0 && (reason === undefined || reason === "stop")
    ? "tool-use"
    : (reason ?? "stop");
  if (
    !emittedContent
    && toolState.size === 0
    && resolvedReason === "stop"
    && (reportedOutputTokens === undefined || reportedOutputTokens === 0)
  ) {
    throw new LlmError({
      kind: "server",
      message: `${providerId} returned an empty response stream (0 output tokens)`,
      retryable: true,
    });
  }
  yield { type: "finish", reason: resolvedReason };
}

export class OpenAiCompatAdapter implements LlmAdapter {
  private readonly unsupportedReasoningModels = new Set<string>();
  private readonly unsupportedReasoningContentModels = new Set<string>();

  constructor(private readonly ctx: Context, private readonly provider: ProviderConfig) {}

  private async headers(request?: LlmRequest): Promise<Record<string, string>> {
    const key = await this.ctx.credentials.resolve(this.provider.apiKey);
    const sessionHeaders: Record<string, string> = {};
    if (request?.sessionId) {
      sessionHeaders["x-session-id"] = request.sessionId;
      if (/grok/i.test(request.model)) {
        sessionHeaders["x-grok-conv-id"] = request.sessionId;
      }
    }
    return {
      ...(key === undefined ? {} : { authorization: `Bearer ${key}` }),
      ...sessionHeaders,
      ...this.provider.headers,
    };
  }

  async *stream(request: LlmRequest, signal: AbortSignal): AsyncGenerator<StreamChunk> {
    const headers = await this.headers(request);
    const body = buildRequestBody(
      request,
      this.provider,
      this.unsupportedReasoningModels,
      this.unsupportedReasoningContentModels,
    );
    try {
      const events = postSse(
        joinUrl(this.provider.baseUrl, "chat/completions"),
        headers,
        body,
        signal,
        this.provider.id,
      );
      yield* translateStream(events, this.provider.id);
    } catch (error) {
      if (error instanceof LlmError && error.status === 400 && !signal.aborted) {
        const hasReasoningContent = Array.isArray(body.messages)
          && body.messages.some((msg) => typeof msg === "object" && msg !== null && "reasoning_content" in msg);
        if (hasReasoningContent && /reasoning_content/i.test(error.message)) {
          this.unsupportedReasoningContentModels.add(request.model);
          const fallbackBody = buildRequestBody(
            request,
            this.provider,
            this.unsupportedReasoningModels,
            this.unsupportedReasoningContentModels,
          );
          const retryEvents = postSse(
            joinUrl(this.provider.baseUrl, "chat/completions"),
            headers,
            fallbackBody,
            signal,
            this.provider.id,
          );
          yield* translateStream(retryEvents, this.provider.id);
          return;
        }
        if ("reasoning_effort" in body) {
          const sentEffort = String(body.reasoning_effort ?? "");
          const clamped = clampFallbackEffort(sentEffort);
          if (
            clamped !== undefined
            && /(?:invalid.*value|supported values|must be one of|not one of|enum|reasoning_effort)/i.test(error.message)
            && !/(?:unrecognized request argument|unknown (?:parameter|field)|extra_forbidden)/i.test(error.message)
          ) {
            const clampedBody = { ...body, reasoning_effort: clamped };
            const retryEvents = postSse(
              joinUrl(this.provider.baseUrl, "chat/completions"),
              headers,
              clampedBody,
              signal,
              this.provider.id,
            );
            yield* translateStream(retryEvents, this.provider.id);
            return;
          }
          // If an OpenAI-compat proxy rejects auto-inferred `reasoning_effort`, remember and retry once cleanly without it.
          if (this.provider.reasoningEffort === undefined && /reasoning_effort/i.test(error.message)) {
            this.unsupportedReasoningModels.add(request.model);
            const fallbackBody = buildRequestBody(
              request,
              this.provider,
              this.unsupportedReasoningModels,
              this.unsupportedReasoningContentModels,
            );
            const retryEvents = postSse(
              joinUrl(this.provider.baseUrl, "chat/completions"),
              headers,
              fallbackBody,
              signal,
              this.provider.id,
            );
            yield* translateStream(retryEvents, this.provider.id);
            return;
          }
        }
      }
      throw error;
    }
  }

  async listModels(signal?: AbortSignal): Promise<ModelInfo[]> {
    const configured = this.provider.models ?? [];
    let discovered: ModelInfo[] = [];
    try {
      const body = await getJson(joinUrl(this.provider.baseUrl, "models"), await this.headers(), this.provider.id, signal) as { data?: Array<Record<string, unknown>> };
      discovered = (body.data ?? []).flatMap((model) => (typeof model === "object" && model !== null ? parseDiscoveredModel(model) : []));
    } catch (error) {
      if (configured.length === 0) throw error;
    }
    const byId = new Map(discovered.map((model) => [model.id, model]));
    for (const model of configured) byId.set(model.id, { ...byId.get(model.id), ...model });
    return [...byId.values()].sort((a, b) => a.id.localeCompare(b.id));
  }
}

export const protocolSpec: LlmProtocolSpec = {
  requiresBaseUrl: true,
  normalizeBaseUrl: (baseUrl) => baseUrl ?? "",
  createAdapter: (ctx, provider) =>
    new OpenAiCompatAdapter(ctx, {
      ...provider,
      baseUrl: provider.baseUrl ?? "",
    }),
};

export function apply(ctx: Context, config?: Config): void {
  ctx.effect(() => ctx.llm.registerProtocol("openai-compat", protocolSpec), `${name}: protocol`);
  for (const provider of config?.providers ?? []) {
    ctx.effect(() => ctx.llm.registerAdapter(
      { id: provider.id, name: provider.name ?? provider.id, api: "openai-compat", baseUrl: provider.baseUrl },
      new OpenAiCompatAdapter(ctx, provider),
    ), `${name}: ${provider.id}`);
  }
}

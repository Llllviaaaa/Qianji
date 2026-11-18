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
import { translateStream } from "./stream.ts";

export { supportsReasoningEffort, type ProviderConfig } from "./models.ts";
export { translateStream } from "./stream.ts";

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
  maxCompletionTokensModels?: ReadonlySet<string>,
  discoveredMaxOutputTokens?: ReadonlyMap<string, number>,
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
  const configuredModel = provider.models?.find((m) => m.id === request.model);
  const maxTokens = request.maxTokens ?? configuredModel?.maxOutputTokens ?? discoveredMaxOutputTokens?.get(request.model);
  if (maxTokens !== undefined && maxTokens > 0) {
    if (maxCompletionTokensModels?.has(request.model)) {
      body.max_completion_tokens = maxTokens;
    } else {
      body.max_tokens = maxTokens;
    }
  }
  if (request.temperature !== undefined) body.temperature = request.temperature;
  const effort = effortValue(request.effort);
  if (effort !== undefined && supportsReasoningEffort(request.model, provider, unsupportedReasoningModels)) {
    body.reasoning_effort = effort;
  }
  return body;
}

export class OpenAiCompatAdapter implements LlmAdapter {
  private readonly unsupportedReasoningModels = new Set<string>();
  private readonly unsupportedReasoningContentModels = new Set<string>();
  private readonly maxCompletionTokensModels = new Set<string>();
  private readonly discoveredMaxOutputTokens = new Map<string, number>();

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
    const url = joinUrl(this.provider.baseUrl, "chat/completions");
    let clampedEffort: "low" | "medium" | "high" | undefined;
    const makeBody = (): Record<string, unknown> => {
      const built = buildRequestBody(
        request,
        this.provider,
        this.unsupportedReasoningModels,
        this.unsupportedReasoningContentModels,
        this.maxCompletionTokensModels,
        this.discoveredMaxOutputTokens,
      );
      if (clampedEffort !== undefined && "reasoning_effort" in built) {
        built.reasoning_effort = clampedEffort;
      }
      return built;
    };

    let body = makeBody();
    for (let attempt = 0; attempt <= 4; attempt++) {
      try {
        const events = postSse(url, headers, body, signal, this.provider.id);
        yield* translateStream(events, this.provider.id);
        return;
      } catch (error) {
        if (!(error instanceof LlmError) || error.status !== 400 || signal.aborted) {
          throw error;
        }
        if ("max_tokens" in body && /max_completion_tokens/i.test(error.message)) {
          this.maxCompletionTokensModels.add(request.model);
          body = makeBody();
          continue;
        }
        const hasReasoningContent = Array.isArray(body.messages)
          && body.messages.some((msg) => typeof msg === "object" && msg !== null && "reasoning_content" in msg);
        if (hasReasoningContent && /reasoning_content/i.test(error.message)) {
          this.unsupportedReasoningContentModels.add(request.model);
          body = makeBody();
          continue;
        }
        if ("reasoning_effort" in body) {
          const sentEffort = String(body.reasoning_effort ?? "");
          const clamped = clampFallbackEffort(sentEffort);
          if (
            clamped !== undefined
            && /(?:invalid.*value|supported values|must be one of|not one of|enum|reasoning_effort)/i.test(error.message)
            && !/(?:unrecognized request argument|unknown (?:parameter|field)|extra_forbidden)/i.test(error.message)
          ) {
            clampedEffort = clamped;
            body = makeBody();
            continue;
          }
          // If an OpenAI-compat proxy rejects auto-inferred `reasoning_effort`, remember and retry once cleanly without it.
          if (this.provider.reasoningEffort === undefined && /reasoning_effort/i.test(error.message)) {
            this.unsupportedReasoningModels.add(request.model);
            body = makeBody();
            continue;
          }
        }
        throw error;
      }
    }
  }

  async listModels(signal?: AbortSignal): Promise<ModelInfo[]> {
    const configured = this.provider.models ?? [];
    let discovered: ModelInfo[] = [];
    try {
      const body = await getJson(joinUrl(this.provider.baseUrl, "models"), await this.headers(), this.provider.id, signal) as { data?: Array<Record<string, unknown>> };
      discovered = (body.data ?? []).flatMap((model) => (typeof model === "object" && model !== null ? parseDiscoveredModel(model) : []));
      for (const model of discovered) {
        if (typeof model.maxOutputTokens === "number" && model.maxOutputTokens > 0) {
          this.discoveredMaxOutputTokens.set(model.id, model.maxOutputTokens);
        }
      }
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

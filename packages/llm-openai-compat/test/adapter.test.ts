import { afterEach, describe, expect, it } from "vitest";
import { Context } from "@deepseek-ai/cordis";
import { Credentials, LlmService, assemble, type LlmRequest } from "@qianji/llm";
import { sseFixture, startFakeProvider, type FakeProvider } from "../../llm/test/fake-server.ts";
import * as adapter from "../src/index.ts";

let root: Context | undefined;
let server: FakeProvider | undefined;

afterEach(async () => {
  await root?.fiber.dispose();
  await server?.close();
  root = undefined;
  server = undefined;
});

async function setup(provider: Partial<adapter.ProviderConfig> = {}): Promise<{ ctx: Context; server: FakeProvider }> {
  server = await startFakeProvider();
  root = new Context();
  await root.plugin(Credentials);
  await root.plugin(LlmService, { baseDelayMs: 0 });
  await root.plugin(adapter, { providers: [{ id: "compat", baseUrl: `${server.baseUrl}/v1`, apiKey: { value: "sk-test" }, ...provider }] });
  return { ctx: root, server };
}

const fixture = (name: string) => sseFixture(new URL(`./fixtures/${name}`, import.meta.url));

const request: LlmRequest = {
  provider: "compat",
  model: "deepseek-reasoner",
  system: "Be brief.",
  messages: [
    { role: "user", content: [{ type: "text", text: "read a.ts" }] },
    {
      role: "assistant",
      content: [
        { type: "thinking", text: "should read" },
        { type: "text", text: "Reading." },
        { type: "tool-call", id: "call_1", name: "read", arguments: { path: "a.ts" } },
      ],
    },
    { role: "tool-result", callId: "call_1", content: [{ type: "text", text: "export {}" }], isError: false },
    { role: "user", content: [{ type: "text", text: "and this" }, { type: "image", mimeType: "image/png", data: "AAAA" }] },
  ],
  tools: [{ name: "read", description: "Read a file", parameters: { type: "object", properties: { path: { type: "string" } } } }],
  maxTokens: 1000,
  effort: "high",
};

describe("openai-compat adapter", () => {
  it("sends Chat Completions with the key, tools and translated history", async () => {
    const { ctx, server } = await setup();
    server.reply({ sse: fixture("reasoning-text.sse") });
    await assemble(ctx.llm.stream(request));

    const [sent] = server.requests;
    expect(sent.method).toBe("POST");
    expect(sent.path).toBe("/v1/chat/completions");
    expect(sent.headers.authorization).toBe("Bearer sk-test");
    expect(sent.body).toEqual({
      model: "deepseek-reasoner",
      stream: true,
      stream_options: { include_usage: true },
      max_tokens: 1000,
      messages: [
        { role: "system", content: "Be brief." },
        { role: "user", content: "read a.ts" },
        {
          role: "assistant",
          content: "Reading.",
          tool_calls: [{ id: "call_1", type: "function", function: { name: "read", arguments: "{\"path\":\"a.ts\"}" } }],
        },
        { role: "tool", tool_call_id: "call_1", content: "export {}" },
        {
          role: "user",
          content: [{ type: "text", text: "and this" }, { type: "image_url", image_url: { url: "data:image/png;base64,AAAA" } }],
        },
      ],
      tools: [{ type: "function", function: request.tools?.[0] }],
    });
  });

  it("sends reasoning_effort only for providers that opt in", async () => {
    const { ctx, server } = await setup({ reasoningEffort: true, headers: { "HTTP-Referer": "https://pid.example" } });
    server.reply({ sse: fixture("reasoning-text.sse") });
    await assemble(ctx.llm.stream(request));
    expect((server.requests[0].body as Record<string, unknown>).reasoning_effort).toBe("high");
    expect(server.requests[0].headers["http-referer"]).toBe("https://pid.example");
  });

  it("auto-sends reasoning_effort and session affinity headers for configured reasoning models, with graceful 400 fallback", async () => {
    const { ctx, server } = await setup({
      models: [{ id: "grok-4.7", reasoning: true, thinkingLevel: "max" }, { id: "quirky-reasoner", reasoning: true }],
    });
    server.reply({ sse: fixture("reasoning-text.sse") });
    await assemble(ctx.llm.stream({ ...request, model: "grok-4.7", sessionId: "sess-abc" }));
    expect((server.requests[0].body as Record<string, unknown>).reasoning_effort).toBe("high");
    expect(server.requests[0].headers["x-session-id"]).toBe("sess-abc");
    expect(server.requests[0].headers["x-grok-conv-id"]).toBe("sess-abc");

    // If a proxy rejects reasoning_effort with HTTP 400, adapter strips it and succeeds on immediate fallback.
    server.reply({ status: 400, json: { error: { message: "Unrecognized request argument supplied: reasoning_effort" } } });
    server.reply({ sse: fixture("reasoning-text.sse") });
    const fallbackResult = await assemble(ctx.llm.stream({ ...request, model: "quirky-reasoner", sessionId: "sess-abc" }));
    expect(fallbackResult.reason).toBe("stop");
    expect((server.requests[1].body as Record<string, unknown>).reasoning_effort).toBe("high");
    expect((server.requests[2].body as Record<string, unknown>).reasoning_effort).toBeUndefined();
  });

  it("translates DeepSeek reasoning, text and cached usage", async () => {
    const { ctx, server } = await setup();
    server.reply({ sse: fixture("reasoning-text.sse") });
    const result = await assemble(ctx.llm.stream(request));
    expect(result).toEqual({
      message: { role: "assistant", content: [{ type: "thinking", text: "The user wants a greeting." }, { type: "text", text: "Hello there!" }] },
      usage: { inputTokens: 20, outputTokens: 18, cacheReadTokens: 100, cacheWriteTokens: 0 },
      reason: "stop",
    });
  });

  it("assembles parallel tool calls whose arguments arrive interleaved", async () => {
    const { ctx, server } = await setup();
    server.reply({ sse: fixture("parallel-tools.sse") });
    const result = await assemble(ctx.llm.stream({ ...request, model: "gpt-4.1" }));
    expect(result.reason).toBe("tool-use");
    expect(result.message.content).toEqual([
      { type: "tool-call", id: "call_a", name: "read", arguments: { path: "a.ts" } },
      { type: "tool-call", id: "call_b", name: "ls", arguments: {} },
    ]);
    expect(result.usage).toMatchObject({ inputTokens: 44, cacheReadTokens: 256, outputTokens: 40 });
  });

  it("retries a 429 and reports a 401 without retrying", async () => {
    const { ctx, server } = await setup();
    server.reply({ status: 429, json: { error: { message: "slow down" } }, headers: { "retry-after": "0" } }, { sse: fixture("reasoning-text.sse") });
    expect((await assemble(ctx.llm.stream(request))).reason).toBe("stop");
    expect(server.requests).toHaveLength(2);

    server.reply({ status: 401, json: { error: { message: "Invalid API key" } } });
    const denied = await assemble(ctx.llm.stream(request));
    expect(denied.reason).toBe("error");
    expect(denied.error).toMatchObject({ kind: "auth", status: 401, message: expect.stringContaining("Invalid API key") });
    expect(server.requests).toHaveLength(3);
  });

  it("omits the authorization header when no key is configured", async () => {
    const { ctx, server } = await setup({ apiKey: undefined });
    server.reply({ sse: fixture("reasoning-text.sse") });
    await assemble(ctx.llm.stream(request));
    expect(server.requests[0].headers.authorization).toBeUndefined();
  });

  it("lists discovered models merged with configured metadata", async () => {
    const { ctx, server } = await setup({ models: [{ id: "deepseek-chat", contextWindow: 128_000 }, { id: "local-only" }] });
    server.reply({ status: 200, json: { object: "list", data: [{ id: "deepseek-reasoner" }, { id: "deepseek-chat" }] } });
    expect(await ctx.llm.listModels("compat")).toEqual([
      { id: "deepseek-chat", contextWindow: 128_000 },
      { id: "deepseek-reasoner" },
      { id: "local-only" },
    ]);
    expect(server.requests[0].path).toBe("/v1/models");

    server.reply({ status: 404 });
    expect(await ctx.llm.listModels("compat")).toEqual([{ id: "deepseek-chat", contextWindow: 128_000 }, { id: "local-only" }]);

    server.reply({
      status: 200,
      json: {
        object: "list",
        data: [
          {
            id: "google/gemini-2.5-pro",
            name: "Gemini 2.5 Pro",
            context_length: 1_048_576,
            top_provider: { max_completion_tokens: 65_536 },
            supported_parameters: ["tools", "reasoning"],
            thinking_level: "high",
            architecture: { input_modalities: ["text", "image"] },
            pricing: { prompt: "0.00000125", completion: "0.00001" },
          },
        ],
      },
    });
    expect(await ctx.llm.listModels("compat")).toContainEqual({
      id: "google/gemini-2.5-pro",
      name: "Gemini 2.5 Pro",
      contextWindow: 1_048_576,
      maxOutputTokens: 65_536,
      reasoning: true,
      thinkingLevel: "high",
      input: ["text", "image"],
      cost: { input: 1.25, output: 10 },
    });
  });

  it("extracts completion_tokens_details.reasoning_tokens when reported", async () => {
    const { ctx, server } = await setup();
    server.reply({
      sse: [
        'data: {"choices":[{"delta":{"content":"Done."},"finish_reason":"stop"}]}',
        'data: {"usage":{"prompt_tokens":50,"completion_tokens":30,"completion_tokens_details":{"reasoning_tokens":18}}}',
        "data: [DONE]",
        "",
      ].join("\n\n"),
    });
    const result = await assemble(ctx.llm.stream(request));
    expect(result.usage).toEqual({
      inputTokens: 50,
      outputTokens: 30,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      reasoningTokens: 18,
    });
  });

  it("treats a truncated SSE stream without finish_reason or [DONE] as a retryable network drop", async () => {
    const { ctx, server } = await setup();
    server.reply(
      {
        sse: 'data: {"choices":[{"delta":{"reasoning_content":"half thought"},"finish_reason":null}]}\n\n',
      },
      { sse: fixture("reasoning-text.sse") },
    );
    const result = await assemble(ctx.llm.stream(request));
    expect(result.reason).toBe("stop");
    expect(result.message.content).toEqual([
      { type: "thinking", text: "The user wants a greeting." },
      { type: "text", text: "Hello there!" },
    ]);
    expect(server.requests).toHaveLength(2);
  });

  it("discovers per-model thinkingLevels from /models and clamps unsupported extended reasoning_effort tiers on 400", async () => {
    const { ctx, server } = await setup({ reasoningEffort: true });
    server.reply({
      status: 200,
      json: {
        data: [
          {
            id: "grok-4.7",
            name: "Grok 4.7",
            default_reasoning_effort: "high",
            supported_reasoning_efforts: ["low", "medium", "high", "xhigh", "ultra"],
          },
        ],
      },
    });

    const models = await ctx.llm.listModels("compat");
    expect(models).toEqual([
      expect.objectContaining({
        id: "grok-4.7",
        reasoning: true,
        thinkingLevel: "high",
        thinkingLevels: ["off", "low", "medium", "high", "xhigh", "ultra"],
      }),
    ]);

    // First attempt sends `reasoning_effort: "xhigh"`, upstream rejects enum value with 400 -> adapter retries clamped to `"high"`.
    server.reply(
      {
        status: 400,
        json: { error: { message: "Invalid value 'xhigh' for reasoning_effort; supported values are low, medium, high" } },
      },
      { sse: fixture("reasoning-text.sse") },
    );
    const result = await assemble(ctx.llm.stream({ ...request, model: "grok-4.7", effort: "xhigh" }));
    expect(result.reason).toBe("stop");
    expect(server.requests.slice(-2).map((req) => (req.body as { reasoning_effort?: string }).reasoning_effort)).toEqual([
      "xhigh",
      "high",
    ]);
  });

  it("includes reasoning_content on intra-turn tool-call loops after the last user turn and falls back on 400", async () => {
    const { ctx, server } = await setup();
    const intraTurnRequest: LlmRequest = {
      ...request,
      messages: [
        { role: "user", content: [{ type: "text", text: "first turn" }] },
        {
          role: "assistant",
          content: [
            { type: "thinking", text: "old turn reasoning" },
            { type: "text", text: "Done first." },
          ],
        },
        { role: "user", content: [{ type: "text", text: "inspect now" }] },
        {
          role: "assistant",
          content: [
            { type: "thinking", text: "need read_file" },
            { type: "tool-call", id: "call_2", name: "read", arguments: { path: "b.ts" } },
          ],
        },
        { role: "tool-result", callId: "call_2", content: [{ type: "text", text: "ok" }], isError: false },
      ],
    };

    server.reply({ sse: fixture("reasoning-text.sse") });
    await assemble(ctx.llm.stream(intraTurnRequest));
    const sentMessages = (server.requests[0].body as { messages: Array<Record<string, unknown>> }).messages;
    expect(sentMessages[2]).not.toHaveProperty("reasoning_content");
    expect(sentMessages[4]).toMatchObject({
      role: "assistant",
      reasoning_content: "need read_file",
      content: null,
      tool_calls: [{ id: "call_2" }],
    });

    // Strict relay rejecting `reasoning_content` gets an automatic retry without it, and remembers the model.
    server.reply(
      { status: 400, json: { error: { message: "Extra inputs are not permitted: reasoning_content" } } },
      { sse: fixture("reasoning-text.sse") },
    );
    const recovered = await assemble(ctx.llm.stream(intraTurnRequest));
    expect(recovered.reason).toBe("stop");
    expect((server.requests[2].body as { messages: Array<Record<string, unknown>> }).messages[4]).not.toHaveProperty("reasoning_content");

    server.reply({ sse: fixture("reasoning-text.sse") });
    await assemble(ctx.llm.stream(intraTurnRequest));
    expect((server.requests[3].body as { messages: Array<Record<string, unknown>> }).messages[4]).not.toHaveProperty("reasoning_content");
  });

  it("merges consecutive user messages, skips empty assistant messages, and normalizes relay tool_calls quirks", async () => {
    const { ctx, server } = await setup();
    server.reply({
      sse: [
        'data: {"choices":[{"delta":{"tool_calls":[{"id":"c1","type":"function","function":{"name":"read","arguments":"{\\"path\\":\\"a.ts\\"}"}}]}}]}',
        'data: {"choices":[{"delta":{"tool_calls":[{"id":"c2","type":"function","function":{"name":"ls","arguments":"{}"}}]}}]}',
        'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}',
        "data: [DONE]",
        "",
      ].join("\n\n"),
    });
    const res = await assemble(ctx.llm.stream({
      ...request,
      messages: [
        { role: "user", content: [{ type: "text", text: "Compacted summary." }] },
        { role: "assistant", content: [{ type: "thinking", text: "aborted before output" }] },
        { role: "user", content: [{ type: "text", text: "Actual prompt." }] },
      ],
    }));

    expect((server.requests[0].body as { messages: Array<Record<string, unknown>> }).messages).toEqual([
      { role: "system", content: "Be brief." },
      { role: "user", content: "Compacted summary.\n\nActual prompt." },
    ]);
    expect(res.reason).toBe("tool-use");
    expect(res.message.content).toEqual([
      { type: "tool-call", id: "c1", name: "read", arguments: { path: "a.ts" } },
      { type: "tool-call", id: "c2", name: "ls", arguments: {} },
    ]);
  });

  it("retries empty 0-token stop streams and MALFORMED_FUNCTION_CALL finish reasons while mapping SAFETY to refusal", async () => {
    const { ctx, server } = await setup();

    server.reply(
      {
        sse: [
          'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}',
          'data: {"usage":{"prompt_tokens":120,"completion_tokens":0}}',
          "data: [DONE]",
          "",
        ].join("\n\n"),
      },
      { sse: fixture("reasoning-text.sse") },
    );
    const emptyRecovered = await assemble(ctx.llm.stream(request));
    expect(emptyRecovered.reason).toBe("stop");
    expect(emptyRecovered.message.content).toEqual([
      { type: "thinking", text: "The user wants a greeting." },
      { type: "text", text: "Hello there!" },
    ]);
    expect(server.requests).toHaveLength(2);

    server.reply(
      {
        sse: [
          'data: {"choices":[{"delta":{},"finish_reason":"MALFORMED_FUNCTION_CALL"}]}',
          "data: [DONE]",
          "",
        ].join("\n\n"),
      },
      { sse: fixture("reasoning-text.sse") },
    );
    const malformedRecovered = await assemble(ctx.llm.stream(request));
    expect(malformedRecovered.reason).toBe("stop");
    expect(server.requests).toHaveLength(4);

    server.reply({
      sse: [
        'data: {"choices":[{"delta":{},"finish_reason":"SAFETY"}]}',
        "data: [DONE]",
        "",
      ].join("\n\n"),
    });
    const safetyRefusal = await assemble(ctx.llm.stream(request));
    expect(safetyRefusal.reason).toBe("refusal");
    expect(server.requests).toHaveLength(5);
  });

  it("normalizes >40-char tool IDs across pairs, drops orphans, sanitizes __invalidJson, and strips foreign signatures", () => {
    const longId = "call/anthropic:very.long." + "x".repeat(45);
    const body = adapter.buildRequestBody(
      {
        ...request,
        messages: [
          { role: "tool-result", callId: "orphan_id", content: [{ type: "text", text: "stale" }], isError: false },
          { role: "user", content: [{ type: "text", text: "inspect" }] },
          {
            role: "assistant",
            content: [
              { type: "thinking", text: "Claude thought", signature: "ant-sig", signatureProvider: "anthropic" },
              { type: "tool-call", id: longId, name: "read", arguments: { __invalidJson: "{broken" } },
            ],
          },
          { role: "tool-result", callId: longId, content: [{ type: "text", text: "content" }], isError: false },
        ],
      },
      { id: "compat", baseUrl: "http://localhost/v1" },
    );

    const messages = body.messages as Array<Record<string, unknown>>;
    expect(messages).toHaveLength(4);
    const assistantMsg = messages[2];
    expect(assistantMsg?.reasoning_content).toBe("Claude thought");
    expect(assistantMsg).not.toHaveProperty("signature");
    const toolCalls = assistantMsg?.tool_calls as Array<{ id: string; function: { arguments: string } }>;
    expect(toolCalls).toHaveLength(1);
    const normalizedId = toolCalls[0]?.id ?? "";
    expect(normalizedId.length).toBeLessThanOrEqual(40);
    expect(normalizedId).toMatch(/^[a-zA-Z0-9_-]+$/);
    expect(toolCalls[0]?.function.arguments).toBe("{}");

    expect(messages[3]).toEqual({ role: "tool", tool_call_id: normalizedId, content: "content" });
  });

  it("wires configured model maxOutputTokens into max_tokens and falls back to max_completion_tokens on 400", async () => {
    const { ctx, server } = await setup({
      models: [
        { id: "o3-mini", maxOutputTokens: 32_768 },
        { id: "deepseek-chat", maxOutputTokens: 8_192 },
      ],
    });
    const reqWithoutMaxTokens: LlmRequest = {
      provider: "compat",
      model: "o3-mini",
      messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
    };

    // First attempt sends max_tokens=32768 -> upstream rejects asking for max_completion_tokens -> retries once cleanly.
    server.reply(
      {
        status: 400,
        json: {
          error: {
            message: "Unsupported parameter: 'max_tokens' is not supported with this model. Use 'max_completion_tokens' instead.",
          },
        },
      },
      { sse: fixture("reasoning-text.sse") },
    );
    const first = await assemble(ctx.llm.stream(reqWithoutMaxTokens));
    expect(first.reason).toBe("stop");
    expect(server.requests).toHaveLength(2);
    expect(server.requests[0]?.body).toMatchObject({ model: "o3-mini", max_tokens: 32_768 });
    expect(server.requests[0]?.body).not.toHaveProperty("max_completion_tokens");
    expect(server.requests[1]?.body).toMatchObject({ model: "o3-mini", max_completion_tokens: 32_768 });
    expect(server.requests[1]?.body).not.toHaveProperty("max_tokens");

    // Subsequent calls for o3-mini use max_completion_tokens directly; explicit request.maxTokens overrides model default.
    server.reply({ sse: fixture("reasoning-text.sse") });
    await assemble(ctx.llm.stream({ ...reqWithoutMaxTokens, maxTokens: 4_096 }));
    expect(server.requests[2]?.body).toMatchObject({ model: "o3-mini", max_completion_tokens: 4_096 });
    expect(server.requests[2]?.body).not.toHaveProperty("max_tokens");

    // Other models on the same provider still use max_tokens.
    server.reply({ sse: fixture("reasoning-text.sse") });
    await assemble(ctx.llm.stream({ ...reqWithoutMaxTokens, model: "deepseek-chat" }));
    expect(server.requests[3]?.body).toMatchObject({ model: "deepseek-chat", max_tokens: 8_192 });
    expect(server.requests[3]?.body).not.toHaveProperty("max_completion_tokens");

    // Non-positive or unconfigured maxTokens omits both fields.
    const unconfiguredBody = adapter.buildRequestBody(
      { provider: "compat", model: "unknown-model", messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }], maxTokens: 0 },
      { id: "compat", baseUrl: "http://localhost/v1" },
    );
    expect(unconfiguredBody).not.toHaveProperty("max_tokens");
    expect(unconfiguredBody).not.toHaveProperty("max_completion_tokens");
  });

  it("extracts streaming inline <think> and <thinking> across split SSE chunks, consecutive blocks, and thinking-only turns", async () => {
    const { ctx, server } = await setup();

    // Split <think> and </think> across chunk boundaries with CRLF after <think> and false partial closing tags inside.
    server.reply({
      sse: [
        'data: {"choices":[{"delta":{"content":"  \\n<th"}}]}',
        'data: {"choices":[{"delta":{"content":"ink>\\r"}}]}',
        'data: {"choices":[{"delta":{"content":"\\nCheck a < b and </div and </th"}}]}',
        'data: {"choices":[{"delta":{"content":"</ThIn"}}]}',
        'data: {"choices":[{"delta":{"content":"k>\\n\\nFinal "}}]}',
        'data: {"choices":[{"delta":{"content":"answer with <think>literal</think>."},"finish_reason":"stop"}]}',
        "data: [DONE]",
        "",
      ].join("\n\n"),
    });
    const splitRes = await assemble(ctx.llm.stream(request));
    expect(splitRes.reason).toBe("stop");
    expect(splitRes.message.content).toEqual([
      { type: "thinking", text: "Check a < b and </div and </th" },
      { type: "text", text: "Final answer with <think>literal</think>." },
    ]);

    // Split <thinking>...</thinking> (e.g. Grok 4.7) across chunk boundaries, ignoring nested </think> until </thinking>.
    server.reply({
      sse: [
        'data: {"choices":[{"delta":{"content":"  <th"}}]}',
        'data: {"choices":[{"delta":{"content":"inking>\\nThe bash tool is running in PowerShell; </think> is not the close tag"}}]}',
        'data: {"choices":[{"delta":{"content":"</ThInKi"}}]}',
        'data: {"choices":[{"delta":{"content":"Ng>\\nClean visible reply."},"finish_reason":"stop"}]}',
        "data: [DONE]",
        "",
      ].join("\n\n"),
    });
    const splitThinkingRes = await assemble(ctx.llm.stream(request));
    expect(splitThinkingRes.reason).toBe("stop");
    expect(splitThinkingRes.message.content).toEqual([
      { type: "thinking", text: "The bash tool is running in PowerShell; </think> is not the close tag" },
      { type: "text", text: "Clean visible reply." },
    ]);

    // Consecutive leading <think> and <thinking> blocks share thinkingIndex; thinking-only turn produces no text block.
    server.reply({
      sse: [
        'data: {"choices":[{"delta":{"content":"<THINK>First. </THINK>\\n<thinking>Second.</thinking>\\n  "},"finish_reason":"stop"}]}',
        "data: [DONE]",
        "",
      ].join("\n\n"),
    });
    const consecutiveThinkOnly = await assemble(ctx.llm.stream(request));
    expect(consecutiveThinkOnly.reason).toBe("stop");
    expect(consecutiveThinkOnly.message.content).toEqual([
      { type: "thinking", text: "First. Second." },
    ]);
  });

  it("handles unclosed <think>/<thinking>, empty tags, and immediate flushing of non-thinking tags", async () => {
    async function collectChunks(payloads: string[]) {
      async function* gen() {
        for (const data of payloads) yield { data };
      }
      const out = [];
      for await (const chunk of adapter.translateStream(gen(), "compat")) {
        out.push(chunk);
      }
      return out;
    }

    // Unclosed <think> and <thinking> with partial closing tag at stream end flush everything as thinking-delta.
    const unclosed = await collectChunks([
      '{"choices":[{"delta":{"content":"<think>\\nTruncated thought</th"},"finish_reason":"length"}]}',
      "[DONE]",
    ]);
    expect(unclosed).toEqual([
      { type: "thinking-delta", index: 0, text: "Truncated thought" },
      { type: "thinking-delta", index: 0, text: "</th" },
      { type: "finish", reason: "length" },
    ]);

    const unclosedThinking = await collectChunks([
      '{"choices":[{"delta":{"content":"<thinking>\\nGrok truncated monologue</thinkin"},"finish_reason":"length"}]}',
      "[DONE]",
    ]);
    expect(unclosedThinking).toEqual([
      { type: "thinking-delta", index: 0, text: "Grok truncated monologue" },
      { type: "thinking-delta", index: 0, text: "</thinkin" },
      { type: "finish", reason: "length" },
    ]);

    // Empty <think></think> or <thinking></thinking> at EOF finishes cleanly without emitting empty blocks or 0-token error.
    for (const emptyTag of ["<think></think>", "<thinking></thinking>"]) {
      const emptyThinkOnly = await collectChunks([
        JSON.stringify({ choices: [{ delta: { content: emptyTag }, finish_reason: "stop" }] }),
        "[DONE]",
      ]);
      expect(emptyThinkOnly).toEqual([{ type: "finish", reason: "stop" }]);
    }

    // Empty <thinking></thinking> followed by prose emits only text-delta.
    const emptyThinkWithProse = await collectChunks([
      '{"choices":[{"delta":{"content":"<thinking></thinking>Hello!"},"finish_reason":"stop"}]}',
      "[DONE]",
    ]);
    expect(emptyThinkWithProse).toEqual([
      { type: "text-delta", index: 0, text: "Hello!" },
      { type: "finish", reason: "stop" },
    ]);

    // Non-thinking tags (<div>, <table, <thinkpad>, <section>) flush immediately on the diverging chunk, not buffered until EOF.
    for (const sample of ["<div>card</div>", "<table border='1'>", "<thinkpad>model</thinkpad>", "<section>body</section>", "  indented", "a < b"]) {
      const stepLog: string[] = [];
      async function* trackedEvents() {
        stepLog.push("yield-1");
        yield { data: JSON.stringify({ choices: [{ delta: { content: sample } }] }) };
        stepLog.push("yield-2");
        yield { data: JSON.stringify({ choices: [{ delta: { content: "!" }, finish_reason: "stop" }] }) };
        yield { data: "[DONE]" };
      }
      for await (const chunk of adapter.translateStream(trackedEvents(), "compat")) {
        if (chunk.type === "text-delta") stepLog.push(`text:${chunk.text}`);
      }
      expect(stepLog).toEqual(["yield-1", `text:${sample}`, "yield-2", "text:!"]);
    }
  });

  it("translates structured delta.content arrays and choice.message fallback without duplicating streamed deltas", async () => {
    const { ctx, server } = await setup();

    // Structured delta.content array with thinking, reasoning, text, output_text, and bare strings.
    server.reply({
      sse: [
        JSON.stringify({
          choices: [{
            delta: {
              content: [
                { type: "thinking", thinking: "Step A. " },
                { type: "reasoning", text: "Step B." },
                { type: "text", text: "Hello " },
                { type: "output_text", text: "structured " },
                "world!",
              ],
            },
            finish_reason: "stop",
          }],
        }).replace(/^/, "data: "),
        "data: [DONE]",
        "",
      ].join("\n\n"),
    });
    const structured = await assemble(ctx.llm.stream(request));
    expect(structured.message.content).toEqual([
      { type: "thinking", text: "Step A. Step B." },
      { type: "text", text: "Hello structured world!" },
    ]);

    // Buffered SSE relay returning choice.message with empty/missing choice.delta when nothing was emitted yet.
    server.reply({
      sse: [
        'data: {"choices":[{"delta":{"role":"assistant"},"finish_reason":null}]}',
        'data: {"choices":[{"delta":{},"message":{"role":"assistant","content":"<think>Buffered plan</think>\\nBuffered answer","tool_calls":[{"id":"call_buf","type":"function","function":{"name":"ls","arguments":"{}"}}]},"finish_reason":"tool_calls"}]}',
        "data: [DONE]",
        "",
      ].join("\n\n"),
    });
    const buffered = await assemble(ctx.llm.stream(request));
    expect(buffered.reason).toBe("tool-use");
    expect(buffered.message.content).toEqual([
      { type: "thinking", text: "Buffered plan" },
      { type: "text", text: "Buffered answer" },
      { type: "tool-call", id: "call_buf", name: "ls", arguments: {} },
    ]);

    // Streaming relay that also echoes full choice.message on the final chunk must NOT duplicate content.
    server.reply({
      sse: [
        'data: {"choices":[{"delta":{"content":"Once only."},"finish_reason":null}]}',
        'data: {"choices":[{"delta":{},"message":{"role":"assistant","content":"Once only."},"finish_reason":"stop"}]}',
        "data: [DONE]",
        "",
      ].join("\n\n"),
    });
    const nonDuplicated = await assemble(ctx.llm.stream(request));
    expect(nonDuplicated.message.content).toEqual([{ type: "text", text: "Once only." }]);
  });

  it("holds tool-call-start across multi-chunk tool_calls when function.name or id arrives after chunk 0", async () => {
    const { ctx, server } = await setup();

    server.reply({
      sse: [
        'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"type":"function","function":{"name":"","arguments":""}},{"index":1,"id":"call_2","type":"function","function":{"name":"","arguments":""}}]}}]}',
        'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_1","function":{"name":"read","arguments":""}}]}}]}',
        'data: {"choices":[{"delta":{"tool_calls":[{"index":1,"function":{"name":"ls","arguments":"{}"}}]}}]}',
        'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"{\\"path\\":\\"a.ts\\"}"}}]},"finish_reason":"tool_calls"}]}',
        "data: [DONE]",
        "",
      ].join("\n\n"),
    });
    const res = await assemble(ctx.llm.stream(request));
    expect(res.reason).toBe("tool-use");
    expect(res.message.content).toEqual([
      { type: "tool-call", id: "call_1", name: "read", arguments: { path: "a.ts" } },
      { type: "tool-call", id: "call_2", name: "ls", arguments: {} },
    ]);

    // Also flushes pending tool-call-start before tool-call-delta or finish even if function.name never arrives.
    async function* namelessToolEvents() {
      yield { data: '{"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_nameless","function":{"name":"","arguments":""}}]}}]}' };
      yield { data: '{"choices":[{"delta":{},"finish_reason":"tool_calls"}]}' };
      yield { data: "[DONE]" };
    }
    const namelessChunks = [];
    for await (const chunk of adapter.translateStream(namelessToolEvents(), "compat")) {
      namelessChunks.push(chunk);
    }
    expect(namelessChunks).toEqual([
      { type: "tool-call-start", index: 0, id: "call_nameless", name: "" },
      { type: "finish", reason: "tool-use" },
    ]);
  });

  it("preserves intra-turn reasoning_content when continuation reminders attach to tool-result without adding a user turn", () => {
    const body = adapter.buildRequestBody(
      {
        ...request,
        messages: [
          { role: "user", content: [{ type: "text", text: "analyze repo" }] },
          {
            role: "assistant",
            content: [
              { type: "thinking", text: "inspecting package.json first" },
              { type: "tool-call", id: "call_read_pkg", name: "read", arguments: { path: "package.json" } },
            ],
          },
          {
            role: "tool-result",
            callId: "call_read_pkg",
            content: [
              { type: "text", text: "{\"name\":\"demo\"}" },
              { type: "text", text: "<system-reminder>Please provide your response.</system-reminder>" },
            ],
            isError: false,
          },
          {
            role: "assistant",
            content: [{ type: "thinking", text: "thinking-only empty turn" }],
          },
        ],
      },
      { id: "compat", baseUrl: "http://localhost/v1" },
    );

    expect(body.messages).toEqual([
      { role: "system", content: "Be brief." },
      { role: "user", content: "analyze repo" },
      {
        role: "assistant",
        content: null,
        reasoning_content: "inspecting package.json first",
        tool_calls: [{ id: "call_read_pkg", type: "function", function: { name: "read", arguments: "{\"path\":\"package.json\"}" } }],
      },
      {
        role: "tool",
        tool_call_id: "call_read_pkg",
        content: "{\"name\":\"demo\"}\n<system-reminder>Please provide your response.</system-reminder>",
      },
    ]);
  });

  it("caches discovered maxOutputTokens from listModels() as stream() fallback while letting configured maxOutputTokens win", async () => {
    const { ctx, server } = await setup({
      models: [
        { id: "configured-override", maxOutputTokens: 12_000 },
        { id: "configured-without-limit", contextWindow: 128_000 },
      ],
    });

    server.reply({
      status: 200,
      json: {
        object: "list",
        data: [
          { id: "discovered-completion", max_completion_tokens: 65_536 },
          { id: "configured-without-limit", max_output_tokens: 16_384 },
          { id: "configured-override", top_provider: { max_completion_tokens: 64_000 } },
        ],
      },
    });
    await ctx.llm.listModels("compat");

    const baseReq = {
      provider: "compat",
      messages: [{ role: "user" as const, content: [{ type: "text" as const, text: "hi" }] }],
    };

    // Unconfigured model uses max_completion_tokens discovered from /models.
    server.reply({ sse: fixture("reasoning-text.sse") });
    await assemble(ctx.llm.stream({ ...baseReq, model: "discovered-completion" }));
    expect(server.requests[1]?.body).toMatchObject({ model: "discovered-completion", max_tokens: 65_536 });

    // Configured model omitting maxOutputTokens falls back to discovered max_output_tokens.
    server.reply({ sse: fixture("reasoning-text.sse") });
    await assemble(ctx.llm.stream({ ...baseReq, model: "configured-without-limit" }));
    expect(server.requests[2]?.body).toMatchObject({ model: "configured-without-limit", max_tokens: 16_384 });

    // Explicit provider.models maxOutputTokens still wins over discovered value.
    server.reply({ sse: fixture("reasoning-text.sse") });
    await assemble(ctx.llm.stream({ ...baseReq, model: "configured-override" }));
    expect(server.requests[3]?.body).toMatchObject({ model: "configured-override", max_tokens: 12_000 });
  });
});

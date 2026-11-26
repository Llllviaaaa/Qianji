import { afterEach, describe, expect, it } from "vitest";
import { Context } from "@deepseek-ai/cordis";
import { Credentials, LlmService, assemble, type LlmRequest, type StreamChunk } from "@qianji/llm";
import { startFakeProvider, type FakeProvider } from "../../llm/test/fake-server.ts";
import * as adapter from "../src/index.ts";

let root: Context | undefined;
let server: FakeProvider | undefined;

afterEach(async () => {
  await root?.fiber.dispose();
  await server?.close();
  root = undefined;
  server = undefined;
});

async function setup(): Promise<{ ctx: Context; server: FakeProvider }> {
  server = await startFakeProvider();
  root = new Context();
  await root.plugin(Credentials);
  await root.plugin(LlmService, { baseDelayMs: 0 });
  await root.plugin(adapter, { providers: [{ id: "compat", baseUrl: `${server.baseUrl}/v1`, apiKey: { value: "sk-test" } }] });
  return { ctx: root, server };
}

const baseRequest: LlmRequest = {
  provider: "compat",
  model: "deepseek-reasoner",
  messages: [{ role: "user", content: [{ type: "text", text: "summarize" }] }],
};

describe("openai-compat context-window finish_reason mapping", () => {
  it("maps 0-output model_context_window_exceeded and context_length_exceeded to non-retryable context-length finish errors", async () => {
    const { ctx, server } = await setup();

    server.reply({
      sse: [
        'data: {"choices":[{"delta":{},"finish_reason":"model_context_window_exceeded"}]}',
        'data: {"usage":{"prompt_tokens":131072,"completion_tokens":0}}',
        "data: [DONE]",
        "",
      ].join("\n\n"),
    });
    const first = await assemble(ctx.llm.stream(baseRequest));
    expect(server.requests).toHaveLength(1);
    expect(first.reason).toBe("error");
    expect(first.message.content).toEqual([]);
    expect(first.error).toEqual({
      kind: "context-length",
      provider: "compat",
      code: "model_context_window_exceeded",
      message: "compat context window exceeded (model_context_window_exceeded)",
      retryable: false,
    });

    server.reply({
      sse: [
        'data: {"choices":[{"delta":{},"finish_reason":"context_length_exceeded"}]}',
        "data: [DONE]",
        "",
      ].join("\n\n"),
    });
    const second = await assemble(ctx.llm.stream(baseRequest));
    expect(server.requests).toHaveLength(2);
    expect(second.reason).toBe("error");
    expect(second.error).toMatchObject({
      kind: "context-length",
      provider: "compat",
      code: "context_length_exceeded",
      retryable: false,
    });
  });

  it("preserves already-streamed thinking/text deltas, skips unstarted tool stubs, and ends with context-length finish error", async () => {
    const { ctx, server } = await setup();
    server.reply({
      sse: [
        'data: {"choices":[{"delta":{"reasoning_content":"Analyzing large file...","content":"<think> Extra thought.</think>Partial answer"}}]}',
        'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_stub","function":{"name":"","arguments":""}}]},"finish_reason":"model_context_window_exceeded"}]}',
        "data: [DONE]",
        "",
      ].join("\n\n"),
    });

    const streamed: StreamChunk[] = [];
    for await (const chunk of ctx.llm.stream(baseRequest)) {
      streamed.push(chunk);
    }

    expect(server.requests).toHaveLength(1);
    expect(streamed.some((chunk) => chunk.type === "thinking-delta")).toBe(true);
    expect(streamed.some((chunk) => chunk.type === "text-delta" && chunk.text === "Partial answer")).toBe(true);
    expect(streamed.some((chunk) => chunk.type === "tool-call-start")).toBe(false);
    expect(streamed.at(-1)).toEqual({
      type: "finish",
      reason: "error",
      error: {
        kind: "context-length",
        provider: "compat",
        code: "model_context_window_exceeded",
        message: "compat context window exceeded (model_context_window_exceeded)",
        retryable: false,
      },
    });
  });
});

import { describe, expect, it } from "vitest";
import { normalizeToolCallId, transformMessagesForProvider, type Message } from "../src/index.ts";

describe("normalizeToolCallId", () => {
  it("replaces disallowed characters and enforces per-protocol length limits deterministically", () => {
    const compatSeen = new Map<string, string>();
    const raw = "call/provider:1.sub+id|" + "x".repeat(60);

    const compatId = normalizeToolCallId(raw, "openai-compat", compatSeen);
    expect(compatId.length).toBeLessThanOrEqual(40);
    expect(compatId).toMatch(/^[a-zA-Z0-9_-]+$/);
    expect(compatId.startsWith("call_provider_1_sub_id_")).toBe(true);
    expect(normalizeToolCallId(raw, "openai-compat", compatSeen)).toBe(compatId);

    const anthropicSeen = new Map<string, string>();
    const longRaw = "toolu_" + "a".repeat(80);
    const anthropicId = normalizeToolCallId(longRaw, "anthropic", anthropicSeen);
    expect(anthropicId.length).toBeLessThanOrEqual(64);
    expect(anthropicId).toMatch(/^[a-zA-Z0-9_-]+$/);
    expect(normalizeToolCallId(longRaw, "gemini")).toBe(anthropicId);
    expect(normalizeToolCallId(longRaw, "openai-responses")).toBe(anthropicId);
  });

  it("disambiguates colliding raw IDs while keeping identical raw IDs consistent", () => {
    const seen = new Map<string, string>();
    const first = normalizeToolCallId("call/1", "openai-compat", seen);
    const second = normalizeToolCallId("call:1", "openai-compat", seen);

    expect(first).toBe("call_1");
    expect(second).not.toBe(first);
    expect(second.length).toBeLessThanOrEqual(40);
    expect(second).toMatch(/^[a-zA-Z0-9_-]+$/);
    expect(normalizeToolCallId("call/1", "openai-compat", seen)).toBe(first);
    expect(normalizeToolCallId("call:1", "openai-compat", seen)).toBe(second);

    const emptyId = normalizeToolCallId("", "openai-compat", seen);
    expect(emptyId).toMatch(/^[a-zA-Z0-9_-]+$/);
  });
});

describe("transformMessagesForProvider", () => {
  it("normalizes tool-call and tool-result IDs, drops orphans, and sanitizes __invalidJson without mutating input", () => {
    const longId = "call/very.long:" + "z".repeat(60);
    const input: Message[] = [
      { role: "tool-result", callId: "early-orphan", content: [{ type: "text", text: "ignored" }], isError: false },
      {
        role: "assistant",
        content: [
          { type: "tool-call", id: longId, name: "read", arguments: { __invalidJson: "{bad json" } },
          { type: "tool-call", id: "call/1", name: "ls", arguments: { __invalidJson: "keep", path: "." } },
        ],
      },
      { role: "tool-result", callId: longId, content: [{ type: "text", text: "ok" }], isError: false },
      // Shares sanitized string "call_1" with "call/1", but was never emitted by assistant.
      { role: "tool-result", callId: "call:1", content: [{ type: "text", text: "orphan collision" }], isError: true },
      { role: "tool-result", callId: "call/1", content: [{ type: "text", text: "dir" }], isError: false },
    ];
    const snapshot = structuredClone(input);

    const out = transformMessagesForProvider(input, "openai-compat");
    expect(input).toEqual(snapshot);

    expect(out).toHaveLength(3);
    const assistant = out[0];
    expect(assistant?.role).toBe("assistant");
    if (assistant?.role !== "assistant") throw new Error("expected assistant");
    const [call0, call1] = assistant.content;
    if (call0?.type !== "tool-call" || call1?.type !== "tool-call") throw new Error("expected tool-call blocks");

    expect(call0.id.length).toBeLessThanOrEqual(40);
    expect(call0.id).toMatch(/^[a-zA-Z0-9_-]+$/);
    expect(call0.arguments).toEqual({});
    expect(call1.id).toBe("call_1");
    expect(call1.arguments).toEqual({ __invalidJson: "keep", path: "." });

    expect(out[1]).toEqual({
      role: "tool-result",
      callId: call0.id,
      content: [{ type: "text", text: "ok" }],
      isError: false,
    });
    expect(out[2]).toEqual({
      role: "tool-result",
      callId: "call_1",
      content: [{ type: "text", text: "dir" }],
      isError: false,
    });
  });

  it("isolates thinking signatures across Anthropic, Gemini, and OpenAI protocols", () => {
    const mixed: Message[] = [
      { role: "user", content: [{ type: "text", text: "hello" }] },
      {
        role: "assistant",
        content: [
          { type: "thinking", text: "claude native", signature: "ant-sig", signatureProvider: "anthropic" },
          { type: "thinking", text: "gemini native", signature: "gem-sig", signatureProvider: "gemini" },
          { type: "thinking", text: "   ", signature: "gem-blank", signatureProvider: "gemini" },
          { type: "thinking", text: "legacy signed", signature: "legacy-sig" },
          { type: "thinking", text: "legacy unsigned" },
          { type: "text", text: "final answer" },
        ],
      },
    ];

    const forAnthropic = transformMessagesForProvider(mixed, "anthropic");
    expect(forAnthropic[1]).toEqual({
      role: "assistant",
      content: [
        { type: "thinking", text: "claude native", signature: "ant-sig", signatureProvider: "anthropic" },
        { type: "thinking", text: "legacy signed", signature: "legacy-sig" },
        { type: "text", text: "final answer" },
      ],
    });
    expect(
      transformMessagesForProvider(
        [
          { role: "user", content: [{ type: "text", text: "hi" }] },
          {
            role: "assistant",
            content: [{ type: "thinking", text: "gemini only", signature: "gem-sig", signatureProvider: "gemini" }],
          },
        ],
        "anthropic",
      ),
    ).toEqual([{ role: "user", content: [{ type: "text", text: "hi" }] }]);

    const forGemini = transformMessagesForProvider(mixed, "gemini");
    expect(forGemini[1]).toEqual({
      role: "assistant",
      content: [
        { type: "thinking", text: "claude native" },
        { type: "thinking", text: "gemini native", signature: "gem-sig", signatureProvider: "gemini" },
        { type: "thinking", text: "   ", signature: "gem-blank", signatureProvider: "gemini" },
        { type: "thinking", text: "legacy signed", signature: "legacy-sig" },
        { type: "thinking", text: "legacy unsigned" },
        { type: "text", text: "final answer" },
      ],
    });

    for (const target of ["openai-compat", "openai-responses"] as const) {
      const forOpenAi = transformMessagesForProvider(mixed, target);
      expect(forOpenAi[1]).toEqual({
        role: "assistant",
        content: [
          { type: "thinking", text: "claude native" },
          { type: "thinking", text: "gemini native" },
          { type: "thinking", text: "   " },
          { type: "thinking", text: "legacy signed" },
          { type: "thinking", text: "legacy unsigned" },
          { type: "text", text: "final answer" },
        ],
      });
    }
  });
});

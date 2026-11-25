import { afterEach, describe, expect, it } from "vitest";
import { Context } from "@deepseek-ai/cordis";
import {
  BlockAssembler,
  Credentials,
  LlmError,
  LlmService,
  assemble,
  type LlmAdapter,
  type LlmRequest,
  type LlmResponseInfo,
  type StreamChunk,
} from "../src/index.ts";

let root: Context | undefined;

afterEach(async () => {
  await root?.fiber.dispose();
  root = undefined;
});

function scripted(...scripts: Array<(req: LlmRequest, signal: AbortSignal) => AsyncGenerator<StreamChunk>>): LlmAdapter & { calls: LlmRequest[] } {
  const calls: LlmRequest[] = [];
  return {
    calls,
    stream(req, signal) {
      calls.push(req);
      const fn = scripts[Math.min(calls.length - 1, scripts.length - 1)];
      if (fn === undefined) throw new Error("No script");
      return fn(req, signal);
    },
  };
}

async function* okText(text: string): AsyncGenerator<StreamChunk> {
  yield { type: "usage", usage: { inputTokens: 10 } };
  yield { type: "text-delta", index: 0, text };
  yield { type: "usage", usage: { outputTokens: 4 } };
  yield { type: "finish", reason: "stop" };
}

describe("LlmService FailoverRouter", () => {
  it("fails over on sustained 529 overloaded / rate-limit and automatically reverts after fallbackCooldownMs", async () => {
    let clock = 1_000;
    root = new Context();
    await root.plugin(Credentials);
    await root.plugin(LlmService, {
      maxAttempts: 2,
      baseDelayMs: 0,
      fallbackModels: ["missing/ignored", "backup/model-b"],
      fallbackCooldownMs: 120_000,
      now: () => clock,
    });

    const overloaded529 = new LlmError({
      kind: "overloaded",
      status: 529,
      message: "Overloaded",
      retryable: true,
    });

    let primaryHealthy = false;
    const primaryAdapter = scripted(async function* () {
      if (!primaryHealthy) throw overloaded529;
      yield* okText("from-primary");
    });
    const backupAdapter = scripted(() => okText("from-backup"));

    root.llm.registerAdapter({ id: "primary", name: "Primary", api: "test", baseUrl: "http://p" }, primaryAdapter);
    root.llm.registerAdapter({ id: "backup", name: "Backup", api: "test", baseUrl: "http://b" }, backupAdapter);

    const responses: LlmResponseInfo[] = [];
    root.on("llm/response", (res) => void responses.push(res));

    const req: LlmRequest = {
      provider: "primary",
      model: "model-a",
      messages: [{ role: "user", content: [{ type: "text", text: "ping" }] }],
    };

    // Call 1: primary fails twice with 529 -> cools down and switches to backup/model-b.
    const r1 = await assemble(root.llm.stream(req));
    expect(r1.reason).toBe("stop");
    expect(r1.message.content).toEqual([{ type: "text", text: "from-backup" }]);
    expect(primaryAdapter.calls).toHaveLength(2);
    expect(backupAdapter.calls).toHaveLength(1);
    expect(backupAdapter.calls[0]?.model).toBe("model-b");
    expect(responses[0]).toMatchObject({ provider: "backup", model: "model-b", reason: "stop", attempts: 3 });

    // Call 2 (within cooldown window): starts directly on backup/model-b without hitting primary.
    primaryHealthy = true;
    clock += 60_000;
    const r2 = await assemble(root.llm.stream(req));
    expect(r2.message.content).toEqual([{ type: "text", text: "from-backup" }]);
    expect(primaryAdapter.calls).toHaveLength(2);
    expect(backupAdapter.calls).toHaveLength(2);

    // Call 3 (after 120s cooldown expiry): automatically reverts to primary/model-a.
    clock += 60_001;
    const r3 = await assemble(root.llm.stream(req));
    expect(r3.message.content).toEqual([{ type: "text", text: "from-primary" }]);
    expect(primaryAdapter.calls).toHaveLength(3);
    expect(backupAdapter.calls).toHaveLength(2);
  });

  it("emits a retry reset chunk to clear partial mid-stream output before running fallback, and handles quota errors", async () => {
    root = new Context();
    await root.plugin(Credentials);
    await root.plugin(LlmService, {
      maxAttempts: 1,
      baseDelayMs: 0,
      fallbackModels: ["backup/quota-safe"],
      fallbackCooldownMs: 30_000,
    });

    const primaryAdapter = scripted(async function* () {
      yield { type: "text-delta", index: 0, text: "partial-corrupt-prefix " };
      throw new LlmError({
        kind: "unknown",
        code: "insufficient_quota",
        message: "You exceeded your current quota",
        retryable: false,
      });
    });
    const backupAdapter = scripted(() => okText("clean-fallback-answer"));

    root.llm.registerAdapter({ id: "primary", name: "Primary", api: "test", baseUrl: "http://p" }, primaryAdapter);
    root.llm.registerAdapter({ id: "backup", name: "Backup", api: "test", baseUrl: "http://b" }, backupAdapter);

    const chunks: StreamChunk[] = [];
    const assembler = new BlockAssembler();
    for await (const chunk of root.llm.stream({
      provider: "primary",
      model: "m1",
      messages: [{ role: "user", content: [{ type: "text", text: "test" }] }],
    })) {
      chunks.push(chunk);
      assembler.push(chunk);
    }

    expect(chunks.some((c) => c.type === "retry" && c.delayMs === 0 && c.attempt === 1)).toBe(true);
    const assembled = assembler.result();
    expect(assembled.reason).toBe("stop");
    expect(assembled.message.content).toEqual([{ type: "text", text: "clean-fallback-answer" }]);
  });
});

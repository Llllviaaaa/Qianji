import { Context } from "@deepseek-ai/cordis";
import { describe, expect, it } from "vitest";
import { argumentProblem, MAX_SCHEMA_DEPTH, textOutput, Tools, type ToolDefinition, type ToolEnv } from "../src/index.ts";

const env = (sessionId = "s"): ToolEnv => ({ sessionId, cwd: "/w", signal: new AbortController().signal });
const firstText = (content: Array<{ type: string; text?: string }>): string =>
  content[0]?.type === "text" ? (content[0].text ?? "") : "";

describe("deep JSON Schema validation (schema-validate)", () => {
  const complexSchema: ToolDefinition["parameters"] = {
    type: "object",
    properties: {
      mode: { type: "string", enum: ["fast", "thorough"] },
      limit: { type: "integer", minimum: 1, maximum: 100 },
      weight: { type: "number", minimum: 0, maximum: 1 },
      tags: { type: "array", minItems: 1, maxItems: 3, items: { type: "string", enum: ["alpha", "beta", "gamma"] } },
      filter: {
        type: "object",
        properties: {
          owner: { type: "string" },
          depth: { type: "integer", minimum: 0 },
        },
        required: ["owner"],
      },
    },
    required: ["mode"],
  };

  it("validates enum, minimum/maximum, array bounds/items, and nested required/properties", () => {
    expect(
      argumentProblem(complexSchema, {
        mode: "fast",
        limit: 10,
        weight: 0.5,
        tags: ["alpha", "beta"],
        filter: { owner: "team", depth: 2 },
      }),
    ).toBeUndefined();

    expect(argumentProblem(complexSchema, {})).toBe('missing required argument "mode"');
    expect(argumentProblem(complexSchema, { mode: "invalid" })).toBe('argument "mode" must be one of "fast", "thorough"');
    expect(argumentProblem(complexSchema, { mode: "fast", limit: 0 })).toBe('argument "limit" must be >= 1');
    expect(argumentProblem(complexSchema, { mode: "fast", limit: 101 })).toBe('argument "limit" must be <= 100');
    expect(argumentProblem(complexSchema, { mode: "fast", weight: 1.5 })).toBe('argument "weight" must be <= 1');
    expect(argumentProblem(complexSchema, { mode: "fast", tags: [] })).toBe('argument "tags" must have at least 1 item(s)');
    expect(argumentProblem(complexSchema, { mode: "fast", tags: ["alpha", "beta", "gamma", "alpha"] })).toBe(
      'argument "tags" must have at most 3 item(s)',
    );
    expect(argumentProblem(complexSchema, { mode: "fast", tags: ["alpha", 42] })).toBe(
      'argument "tags[1]" must be a string',
    );
    expect(argumentProblem(complexSchema, { mode: "fast", tags: ["delta"] })).toBe(
      'argument "tags[0]" must be one of "alpha", "beta", "gamma"',
    );
    expect(argumentProblem(complexSchema, { mode: "fast", filter: {} })).toBe(
      'missing required argument "filter.owner"',
    );
    expect(argumentProblem(complexSchema, { mode: "fast", filter: { owner: "me", depth: -1 } })).toBe(
      'argument "filter.depth" must be >= 0',
    );
  });

  it("caps recursion cleanly at MAX_SCHEMA_DEPTH (12)", () => {
    expect(MAX_SCHEMA_DEPTH).toBe(12);
    let schema: Record<string, unknown> = { type: "integer" };
    let badDeepValue: unknown = "not-an-int";
    for (let i = 0; i < 15; i += 1) {
      schema = { type: "object", properties: { child: schema } };
      badDeepValue = { child: badDeepValue };
    }
    // Beyond depth 12, validator stops recursing rather than overflowing or rejecting deep opaque trees.
    expect(argumentProblem(schema as ToolDefinition["parameters"], badDeepValue as Record<string, unknown>)).toBeUndefined();

    // Within depth 12 (e.g. depth 6), nested errors are still caught accurately.
    let shallowSchema: Record<string, unknown> = { type: "integer" };
    let badShallowValue: unknown = "wrong";
    for (let i = 0; i < 5; i += 1) {
      shallowSchema = { type: "object", properties: { child: shallowSchema } };
      badShallowValue = { child: badShallowValue };
    }
    expect(argumentProblem(shallowSchema as ToolDefinition["parameters"], badShallowValue as Record<string, unknown>)).toBe(
      'argument "child.child.child.child.child" must be an integer',
    );
  });

  it("validates BEFORE tools/pre-execute AND re-validates AFTER pre-execute mutations", async () => {
    const ctx = new Context();
    await ctx.plugin(Tools);
    const preExecuteCalls: string[] = [];

    ctx.tools.register<{ count: number; mode?: string }>({
      name: "counted",
      description: "Test pre/post validation",
      parameters: {
        type: "object",
        properties: {
          count: { type: "integer", minimum: 1 },
          mode: { type: "string", enum: ["safe", "strict"] },
        },
        required: ["count"],
      },
      execute: ({ count, mode }) => textOutput(`ok:${count}:${mode ?? "none"}`),
    });

    ctx.on("tools/pre-execute", (call) => {
      preExecuteCalls.push(call.id);
      if (call.args.count === 99) {
        // Corrupt the argument during pre-execute to verify post-hook re-validation.
        call.args.mode = "corrupted";
      }
      return undefined;
    });

    // 1. Invalid initial args never reach tools/pre-execute (protects permissions/hooks).
    const preFail = await ctx.tools.execute({ id: "bad-pre", name: "counted", args: { __invalidJson: "{" } }, env());
    expect(preFail.isError).toBe(true);
    expect(firstText(preFail.content)).toContain("the arguments were not valid JSON");
    expect(preExecuteCalls).toEqual([]);

    const enumFail = await ctx.tools.execute({ id: "bad-enum", name: "counted", args: { count: 2, mode: "nope" } }, env());
    expect(enumFail.isError).toBe(true);
    expect(firstText(enumFail.content)).toContain('argument "mode" must be one of "safe", "strict"');
    expect(preExecuteCalls).toEqual([]);

    // 2. Valid initial args mutated into invalid args by pre-execute are caught before execute().
    const postFail = await ctx.tools.execute({ id: "bad-post", name: "counted", args: { count: 99 } }, env());
    expect(preExecuteCalls).toEqual(["bad-post"]);
    expect(postFail.isError).toBe(true);
    expect(firstText(postFail.content)).toContain('argument "mode" must be one of "safe", "strict"');

    // 3. Valid args pass both gates.
    const ok = await ctx.tools.execute({ id: "good", name: "counted", args: { count: 5, mode: "safe" } }, env());
    expect(ok.isError).toBeUndefined();
    expect(firstText(ok.content)).toBe("ok:5:safe");
  });
});

describe("Tools.isConcurrencySafe & steeringSignal contract", () => {
  it("handles readOnly fallback, dynamic classifiers, restrictions, invalid schemas, throws, and activate_tools", async () => {
    const ctx = new Context();
    await ctx.plugin(Tools);

    ctx.tools.register({
      name: "reader",
      description: "Static read-only tool",
      readOnly: true,
      parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
      execute: () => textOutput("ok"),
    });

    ctx.tools.register({
      name: "writer",
      description: "Mutating tool",
      parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
      execute: () => textOutput("ok"),
    });

    ctx.tools.register<{ action: string }>({
      name: "hybrid",
      description: "Multi-action tool",
      parameters: {
        type: "object",
        properties: { action: { type: "string", enum: ["read", "list", "write", "explode"] } },
        required: ["action"],
      },
      isConcurrencySafe: ({ action }) => {
        if (action === "explode") throw new Error("classifier boom");
        return action === "read" || action === "list";
      },
      execute: () => textOutput("ok"),
    });

    ctx.tools.register({
      name: "lazy_tool",
      description: "Deferred tool",
      deferred: true,
      group: "lazy",
      parameters: { type: "object", properties: {} },
      execute: () => textOutput("ok"),
    });

    // Unknown tool -> false
    expect(ctx.tools.isConcurrencySafe("unknown", {})).toBe(false);

    // Static readOnly fallback -> true only when schema-valid
    expect(ctx.tools.isConcurrencySafe("reader", { path: "a.ts" })).toBe(true);
    expect(ctx.tools.isConcurrencySafe("reader", {})).toBe(false);
    expect(ctx.tools.isConcurrencySafe("writer", { path: "a.ts" })).toBe(false);

    // Dynamic classifier -> respects args, fails closed on invalid schema or thrown error
    expect(ctx.tools.isConcurrencySafe("hybrid", { action: "read" })).toBe(true);
    expect(ctx.tools.isConcurrencySafe("hybrid", { action: "list" })).toBe(true);
    expect(ctx.tools.isConcurrencySafe("hybrid", { action: "write" })).toBe(false);
    expect(ctx.tools.isConcurrencySafe("hybrid", { action: "explode" })).toBe(false);
    expect(ctx.tools.isConcurrencySafe("hybrid", { action: "unknown-enum" })).toBe(false);
    expect(ctx.tools.isConcurrencySafe("hybrid", { __invalidJson: "{" })).toBe(false);

    // activate_tools -> concurrency-safe with valid names array, false on malformed args
    expect(ctx.tools.isConcurrencySafe("activate_tools", { names: ["lazy"] }, "s1")).toBe(true);
    expect(ctx.tools.isConcurrencySafe("activate_tools", {}, "s1")).toBe(false);
    expect(ctx.tools.isConcurrencySafe("activate_tools", { names: [123] }, "s1")).toBe(false);
    expect(ctx.tools.isConcurrencySafe("activate_tools", { __invalidJson: "x" }, "s1")).toBe(false);

    // Session restrictions fail closed for disallowed tools (including activate_tools when no deferred tools allowed)
    const unrestrict = ctx.tools.restrict("locked", ["writer"]);
    expect(ctx.tools.isConcurrencySafe("reader", { path: "a.ts" }, "locked")).toBe(false);
    expect(ctx.tools.isConcurrencySafe("activate_tools", { names: ["lazy"] }, "locked")).toBe(false);
    unrestrict();

    // steeringSignal forwards cleanly through ToolEnv
    const steerCtrl = new AbortController();
    let seenSteerSignal: AbortSignal | undefined;
    ctx.tools.register({
      name: "steer_observer",
      description: "Observes steeringSignal",
      parameters: { type: "object", properties: {} },
      execute: (_args, callEnv) => {
        seenSteerSignal = callEnv.steeringSignal;
        return textOutput("observed");
      },
    });
    await ctx.tools.execute(
      { id: "st-1", name: "steer_observer", args: {} },
      { ...env("s1"), steeringSignal: steerCtrl.signal },
    );
    expect(seenSteerSignal).toBe(steerCtrl.signal);
  });
});

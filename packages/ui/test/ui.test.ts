import { Context } from "@deepseek-ai/cordis";
import { describe, expect, it } from "vitest";
import { Ui, type PendingUiRequest } from "../src/index.ts";

async function setup() {
  const ctx = new Context();
  await ctx.plugin(Ui);
  const shown: PendingUiRequest[] = [];
  const cancelled: string[] = [];
  const notes: string[] = [];
  return {
    ctx,
    shown,
    cancelled,
    notes,
    attach: () => ctx.ui.attach({
      request: (pending) => void shown.push(pending),
      cancel: (id) => void cancelled.push(id),
      notify: (_session, message, level) => void notes.push(`${level}:${message}`),
    }),
  };
}

describe("ui service", () => {
  it("answers nothing without a transport", async () => {
    const { ctx } = await setup();
    expect(ctx.ui.available).toBe(false);
    expect(await ctx.ui.confirm("s", "Allow?", "rm -rf")).toBe(false);
    expect(await ctx.ui.input(undefined, "Name?")).toBeUndefined();
  });

  it("delivers requests and resolves them with the response", async () => {
    const { ctx, shown, attach } = await setup();
    attach();
    const confirmed = ctx.ui.confirm("s1", "Allow?", "git push");
    const picked = ctx.ui.select(undefined, "Pick", ["a", "b"]);
    expect(shown.map(({ requestId, sessionId, request }) => [requestId, sessionId, request.kind])).toEqual([["ui-1", "s1", "confirm"], ["ui-2", undefined, "select"]]);
    expect(ctx.ui.pending()).toHaveLength(2);
    expect(ctx.ui.respond("ui-1", true)).toBe(true);
    expect(ctx.ui.respond("ui-1", true)).toBe(false);
    ctx.ui.respond("ui-2", "c");
    expect(await confirmed).toBe(true);
    expect(await picked).toBeUndefined();
    expect(ctx.ui.pending()).toEqual([]);
  });

  it("cancels on abort and when the transport goes away", async () => {
    const { ctx, cancelled, attach } = await setup();
    const detach = attach();
    const controller = new AbortController();
    const aborted = ctx.ui.confirm("s", "A", "a", controller.signal);
    const orphaned = ctx.ui.input("s", "B");
    controller.abort();
    expect(await aborted).toBe(false);
    detach();
    expect(await orphaned).toBeUndefined();
    expect(cancelled).toEqual(["ui-1", "ui-2"]);
    expect(ctx.ui.available).toBe(false);
  });

  it("passes notifications through", async () => {
    const { ctx, notes, attach } = await setup();
    ctx.ui.notify("s", "lost");
    attach();
    ctx.ui.notify("s", "Hook failed", "error");
    expect(notes).toEqual(["error:Hook failed"]);
  });

  it("broadcasts to multiple transports, settles on first response, and cancels all", async () => {
    const { ctx, shown, cancelled, attach } = await setup();
    attach();
    const secondShown: PendingUiRequest[] = [];
    const secondCancelled: string[] = [];
    const secondNotes: string[] = [];
    ctx.ui.attach({
      request: (pending) => void secondShown.push(pending),
      cancel: (id) => void secondCancelled.push(id),
      notify: (_session, message, level) => void secondNotes.push(`${level}:${message}`),
    });

    const pending = ctx.ui.confirm("s1", "Allow?", "rm -rf /tmp/x");
    expect(shown).toHaveLength(1);
    expect(secondShown).toHaveLength(1);
    expect(secondShown[0]?.requestId).toBe(shown[0]?.requestId);

    const requestId = shown[0]?.requestId ?? "";
    expect(ctx.ui.respond(requestId, true)).toBe(true);
    expect(ctx.ui.respond(requestId, false)).toBe(false);
    expect(await pending).toBe(true);
    expect(cancelled).toEqual([requestId]);
    expect(secondCancelled).toEqual([requestId]);

    ctx.ui.notify("s1", "done", "info");
    expect(secondNotes).toEqual(["info:done"]);
  });

  it("detaching one of multiple transports cancels only that transport and keeps the request open", async () => {
    const { ctx, shown, cancelled, attach } = await setup();
    attach();
    const secondCancelled: string[] = [];
    const detachSecond = ctx.ui.attach({
      request: () => {},
      cancel: (id) => void secondCancelled.push(id),
      notify: () => {},
    });

    const pending = ctx.ui.input("s1", "Token?");
    const requestId = shown[0]?.requestId ?? "";
    detachSecond();
    expect(secondCancelled).toEqual([requestId]);
    expect(cancelled).toEqual([]);
    expect(ctx.ui.available).toBe(true);
    expect(ctx.ui.pending()).toHaveLength(1);

    expect(ctx.ui.respond(requestId, "abc")).toBe(true);
    expect(await pending).toBe("abc");
    expect(cancelled).toEqual([requestId]);
  });

  it("detaches automatically when the caller Cordis plugin fiber disposes", async () => {
    const { ctx, shown } = await setup();
    const childShown: PendingUiRequest[] = [];
    const childCancelled: string[] = [];
    const fiber = ctx.plugin({
      name: "test-ui-transport",
      inject: ["ui"],
      apply(innerCtx: Context) {
        innerCtx.ui.attach({
          request: (pending) => void childShown.push(pending),
          cancel: (id) => void childCancelled.push(id),
          notify: () => {},
        });
      },
    });
    await fiber;
    expect(ctx.ui.available).toBe(true);

    const req = ctx.ui.select("s1", "Pick", ["x", "y"]);
    expect(childShown).toHaveLength(1);
    await fiber.dispose();
    expect(childCancelled).toEqual([childShown[0]?.requestId]);
    expect(await req).toBeUndefined();
    expect(ctx.ui.available).toBe(false);
    expect(shown).toEqual([]);
  });

  it("isolates throwing transports from healthy ones", async () => {
    const { ctx, shown, cancelled, attach } = await setup();
    ctx.ui.attach({
      request: () => {
        throw new Error("boom request");
      },
      cancel: () => {
        throw new Error("boom cancel");
      },
      notify: () => {
        throw new Error("boom notify");
      },
    });
    attach();

    const pending = ctx.ui.confirm("s1", "Proceed?", "yes");
    expect(shown).toHaveLength(1);
    ctx.ui.notify("s1", "ok");
    const requestId = shown[0]?.requestId ?? "";
    expect(ctx.ui.respond(requestId, true)).toBe(true);
    expect(await pending).toBe(true);
    expect(cancelled).toEqual([requestId]);
  });
});

describe("unattended sessions", () => {
  it("answer nothing for a session nobody watches", async () => {
    const { ctx, shown, attach } = await setup();
    attach();
    const done = ctx.ui.markUnattended("scheduled");
    expect(ctx.ui.canAsk("scheduled")).toBe(false);
    expect(ctx.ui.canAsk("other")).toBe(true);
    expect(await ctx.ui.confirm("scheduled", "Allow?", "x")).toBe(false);
    expect(shown).toEqual([]);
    done();
    expect(ctx.ui.canAsk("scheduled")).toBe(true);
  });
});

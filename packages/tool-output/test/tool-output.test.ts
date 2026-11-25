import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Context } from "@deepseek-ai/cordis";
import { afterEach, describe, expect, it } from "vitest";
import { Tools, textOutput } from "@qianji/tools";
import * as toolOutput from "../src/index.ts";

let root: Context | undefined;
let temp: string | undefined;

afterEach(async () => {
  await root?.fiber.dispose();
  root = undefined;
  if (temp !== undefined) rmSync(temp, { recursive: true, force: true });
  temp = undefined;
});

async function setup(config: toolOutput.Config): Promise<Context> {
  root = new Context();
  await root.plugin(Tools);
  await root.plugin(toolOutput, config);
  root.tools.register<{ size: number }>({
    name: "dump",
    description: "Return `size` characters",
    parameters: { type: "object", properties: { size: { type: "integer" } }, required: ["size"] },
    execute: ({ size }) => ({
      content: [{ type: "text", text: `${"h".repeat(size / 2)}${"t".repeat(size / 2)}` }, { type: "image", mimeType: "image/png", data: "AAAA" }],
      details: { kept: true },
    }),
  });
  return root;
}

const env = (signal = new AbortController().signal) => ({ sessionId: "s/1", cwd: "/work", signal });

describe("tool output limit (ADR 0019)", () => {
  it("passes output within the limit through untouched", async () => {
    const ctx = await setup({ maxChars: 1_000 });
    const output = await ctx.tools.execute({ id: "c1", name: "dump", args: { size: 1_000 } }, env());
    expect(output.content[0]).toEqual({ type: "text", text: `${"h".repeat(500)}${"t".repeat(500)}` });
  });

  it("keeps the start and end of oversized text and saves the full text", async () => {
    temp = mkdtempSync(join(tmpdir(), "qianji-spill-"));
    const ctx = await setup({ maxChars: 1_000, spillDir: temp });
    const output = await ctx.tools.execute({ id: "c2", name: "dump", args: { size: 10_000 } }, env());
    const [text, image] = output.content;
    expect(text?.type).toBe("text");
    const body = text?.type === "text" ? text.text : "";
    expect(body.startsWith("h".repeat(400))).toBe(true);
    expect(body.endsWith("t".repeat(400))).toBe(true);
    expect(body).toContain("[Output truncated: 10000 characters");
    expect(body.length).toBeLessThan(1_400);
    expect(image).toEqual({ type: "image", mimeType: "image/png", data: "AAAA" });
    expect(output.details).toEqual({ kept: true });

    const saved = join(temp, "s_1", "c2.txt");
    expect(body).toContain(saved);
    expect(readFileSync(saved, "utf8")).toHaveLength(10_000);
  });

  it("still cuts the output when it cannot be saved", () => {
    const limited = toolOutput.limitOutput(textOutput("x".repeat(5_000)), 1_000, () => undefined);
    const first = limited.content[0];
    expect(first?.type === "text" ? first.text : "").toContain("could not be saved");
  });

  it("removes session folders past the retention period", () => {
    temp = mkdtempSync(join(tmpdir(), "qianji-spill-"));
    mkdirSync(join(temp, "old"));
    mkdirSync(join(temp, "new"));
    const longAgo = new Date(Date.now() - 30 * 86_400_000);
    utimesSync(join(temp, "old"), longAgo, longAgo);
    expect(toolOutput.pruneSpill(temp, Date.now() - 7 * 86_400_000)).toEqual(["old"]);
    expect(existsSync(join(temp, "old"))).toBe(false);
    expect(existsSync(join(temp, "new"))).toBe(true);
  });

  it("caps cumulative per-turn tool output at 200K chars and resets on agent/turn-start", async () => {
    temp = mkdtempSync(join(tmpdir(), "qianji-spill-turn-"));
    const ctx = await setup({ spillDir: temp });

    // 6 calls x 45,000 chars = 270,000 chars total in one turn (each below single-call 50,000 cap).
    const outputs = await Promise.all(
      Array.from({ length: 6 }, (_, index) =>
        ctx.tools.execute({ id: `turn1_c${index + 1}`, name: "dump", args: { size: 45_000 } }, env()),
      ),
    );

    const lengths = outputs.map((out) =>
      out.content.reduce((sum, block) => sum + (block.type === "text" ? block.text.length : 0), 0),
    );
    // First 4 calls (180,000 chars) stay whole; 5th and 6th spill once cumulative output crosses 200,000.
    expect(lengths.slice(0, 4)).toEqual([45_000, 45_000, 45_000, 45_000]);
    expect(lengths[4]).toBeLessThan(20_000);
    expect(lengths[5]).toBeLessThan(4_000);

    const fifthText = outputs[4]?.content[0]?.type === "text" ? outputs[4].content[0].text : "";
    const sixthText = outputs[5]?.content[0]?.type === "text" ? outputs[5].content[0].text : "";
    expect(fifthText).toContain("[Output truncated: 45000 characters");
    expect(sixthText).toContain("[Output truncated: 45000 characters");
    expect(readFileSync(join(temp, "s_1", "turn1_c5.txt"), "utf8")).toHaveLength(45_000);
    expect(readFileSync(join(temp, "s_1", "turn1_c6.txt"), "utf8")).toHaveLength(45_000);

    // Starting the next turn resets the session's turn budget cleanly.
    await ctx.serial("agent/turn-start", { id: "s/1" } as never, 2);
    const freshTurnOut = await ctx.tools.execute({ id: "turn2_c1", name: "dump", args: { size: 45_000 } }, env());
    const freshText = freshTurnOut.content[0]?.type === "text" ? freshTurnOut.content[0].text : "";
    expect(freshText).toHaveLength(45_000);
    expect(existsSync(join(temp, "s_1", "turn2_c1.txt"))).toBe(false);
  });
});

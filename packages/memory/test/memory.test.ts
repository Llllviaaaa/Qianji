import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Context } from "@deepseek-ai/cordis";
import { afterEach, describe, expect, it } from "vitest";
import { Permissions } from "@qianji/permissions";
import { Sessions } from "@qianji/session";
import { SystemPrompt } from "@qianji/system-prompt";
import { Tools } from "@qianji/tools";
import { Ui } from "@qianji/ui";
import * as memory from "../src/index.ts";

let dir = "";
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("local memory", () => {
  it("reads, appends, replaces and clears, and shows the memory to the model", async () => {
    dir = mkdtempSync(join(tmpdir(), "pid-memory-"));
    const file = join(dir, "nested", "memory.md");
    const ctx = new Context();
    await ctx.plugin(Tools);
    await ctx.plugin(SystemPrompt);
    await ctx.plugin(memory, { file });
    const env = { sessionId: "s", cwd: dir, signal: new AbortController().signal };
    const call = async (args: Record<string, unknown>) => {
      const output = await ctx.tools.execute({ id: "1", name: "desktop_memory", args }, env);
      return output.content[0]?.type === "text" ? output.content[0].text : "";
    };
    const prompt = () => ctx.systemPrompt.build({ sessionId: "s", cwd: dir, model: { provider: "p", model: "m" }, tools: [] });

    expect(await call({ action: "read" })).toBe("Local memory is empty.");
    expect(await prompt()).toBe("");
    await call({ action: "append", content: "Prefers pnpm." });
    await call({ action: "append", content: "Answers in Chinese." });
    expect(readFileSync(file, "utf8")).toBe("Prefers pnpm.\n\nAnswers in Chinese.\n");
    expect(await prompt()).toContain("<memory>\nPrefers pnpm.\n\nAnswers in Chinese.\n</memory>");
    await call({ action: "replace", content: "Only this." });
    expect(await call({ action: "read" })).toBe("Only this.\n");
    expect(await call({ action: "append" })).toBe("desktop_memory failed: content is required for append");
    await call({ action: "clear" });
    expect(readFileSync(file, "utf8")).toBe("");
    await ctx.fiber.dispose();
  });

  it("supports project scope (.qianji/memory.md) with independent switches and trust gate", async () => {
    dir = mkdtempSync(join(tmpdir(), "qianji-memory-proj-"));
    const globalFile = join(dir, "global", "memory.md");
    const workspace = join(dir, "workspace");
    let trusted = true;
    const ctx = new Context();
    await ctx.plugin(Tools);
    await ctx.plugin(SystemPrompt);
    await ctx.plugin(memory, { file: globalFile, userEnabled: true, projectEnabled: true, isTrusted: () => trusted });
    const env = { sessionId: "s", cwd: workspace, signal: new AbortController().signal };
    const call = async (args: Record<string, unknown>) => {
      const output = await ctx.tools.execute({ id: "1", name: "desktop_memory", args }, env);
      return output.content[0]?.type === "text" ? output.content[0].text : "";
    };
    const prompt = () => ctx.systemPrompt.build({ sessionId: "s", cwd: workspace, model: { provider: "p", model: "m" }, tools: [] });

    await call({ action: "append", scope: "user", content: "Global rule." });
    await call({ action: "append", scope: "project", content: "Use vitest for tests." });
    expect(readFileSync(join(workspace, ".qianji", "memory.md"), "utf8")).toBe("Use vitest for tests.\n");

    const built = await prompt();
    expect(built).toContain("<memory>\nGlobal rule.\n</memory>");
    expect(built).toContain("<project-memory>\nUse vitest for tests.\n</project-memory>");

    trusted = false;
    const untrustedPrompt = await prompt();
    expect(untrustedPrompt).toContain("<memory>");
    expect(untrustedPrompt).not.toContain("<project-memory>");
    expect(await call({ action: "append", scope: "project", content: "Blocked." })).toContain("not trusted");
    await ctx.fiber.dispose();
  });

  it("requests unified-diff confirmation before writing under ask/workspace-write modes", async () => {
    dir = mkdtempSync(join(tmpdir(), "pid-memory-confirm-"));
    const file = join(dir, "memory.md");
    const ctx = new Context();
    await ctx.plugin(Sessions);
    await ctx.plugin(Ui);
    await ctx.plugin(Tools);
    await ctx.plugin(SystemPrompt);
    await ctx.plugin(Permissions, { defaultPermission: "ask" });
    await ctx.plugin(memory, { file });

    const prompts: Array<{ title: string; message: string }> = [];
    let allow = true;
    ctx.ui.attach({
      request: ({ requestId, request }) => {
        if (request.kind === "confirm") prompts.push({ title: request.title, message: request.message });
        queueMicrotask(() => ctx.ui.respond(requestId, allow));
      },
      cancel: () => {},
      notify: () => {},
    });

    const session = ctx.sessions.create({ cwd: dir });
    const env = { sessionId: session.id, cwd: dir, signal: new AbortController().signal };
    const call = async (args: Record<string, unknown>) => {
      const output = await ctx.tools.execute({ id: "1", name: "desktop_memory", args }, env);
      return output.content[0]?.type === "text" ? output.content[0].text : "";
    };

    expect(await call({ action: "append", content: "Always use TypeScript." })).toBe("Preference added to local memory.");
    expect(prompts).toHaveLength(1);
    expect(prompts[0]?.title).toBe("更新全局本地记忆？");
    expect(prompts[0]?.message).toContain("```diff");
    expect(prompts[0]?.message).toContain("+Always use TypeScript.");

    allow = false;
    expect(await call({ action: "replace", content: "Overwrite everything." })).toContain("Denied:");
    expect(readFileSync(file, "utf8")).toBe("Always use TypeScript.\n");

    ctx.permissions.set(session, { permission: "full-access" });
    expect(await call({ action: "append", content: "No prompt under full-access." })).toBe("Preference added to local memory.");
    expect(prompts).toHaveLength(2);
    expect(readFileSync(file, "utf8")).toContain("No prompt under full-access.");
    await ctx.fiber.dispose();
  });

  it("switches large memories to indexed mode, searches, reads slices, and upserts sections with approval", async () => {
    dir = mkdtempSync(join(tmpdir(), "qianji-memory-index-"));
    const globalFile = join(dir, "memory.md");
    const ctx = new Context();
    await ctx.plugin(Sessions);
    await ctx.plugin(Ui);
    await ctx.plugin(Tools);
    await ctx.plugin(SystemPrompt);
    await ctx.plugin(Permissions, { defaultPermission: "ask" });
    await ctx.plugin(memory, { file: globalFile, inlineMaxChars: 120 });

    const prompts: Array<{ title: string; message: string }> = [];
    ctx.ui.attach({
      request: ({ requestId, request }) => {
        if (request.kind === "confirm") prompts.push({ title: request.title, message: request.message });
        queueMicrotask(() => ctx.ui.respond(requestId, true));
      },
      cancel: () => {},
      notify: () => {},
    });

    const session = ctx.sessions.create({ cwd: dir });
    const env = { sessionId: session.id, cwd: dir, signal: new AbortController().signal };
    const call = async (args: Record<string, unknown>) => {
      const output = await ctx.tools.execute({ id: "1", name: "desktop_memory", args }, env);
      return output.content[0]?.type === "text" ? output.content[0].text : "";
    };
    const buildPrompt = () => ctx.systemPrompt.build({ sessionId: session.id, cwd: dir, model: { provider: "p", model: "m" }, tools: [] });

    // Small memory is inlined cleanly
    await call({ action: "replace", content: "## Preferences\n\nUse concise output.\n" });
    expect(await buildPrompt()).toContain("<memory>\n## Preferences");

    // Larger memory (> 120 chars) switches to indexed directory mode and ignores headings inside code fences
    const largeDoc = [
      "# Coding Rules",
      "",
      "Always write tests first.",
      "",
      "## Build Commands",
      "",
      "```bash",
      "# Not A Heading Inside Fence",
      "pnpm run build",
      "```",
      "",
      "### Notes",
      "",
      "Extra context filler: " + "x".repeat(120),
    ].join("\n");
    await call({ action: "replace", content: largeDoc });

    const indexed = await buildPrompt();
    expect(indexed).toContain('<memory mode="indexed">');
    expect(indexed).not.toContain("Not A Heading Inside Fence");
    expect(indexed).toContain("Build Commands");
    expect(indexed).not.toContain("x".repeat(80));

    // Read-only mode still permits search and sliced read
    ctx.permissions.set(session, { permission: "read-only" });
    const searchRes = await call({ action: "search", query: "pnpm build" });
    expect(searchRes).toContain("Build Commands");
    expect(searchRes).toContain("pnpm run build");

    const sectionSlice = await call({ action: "read", section: "Build Commands" });
    expect(sectionSlice).toContain("[section: Build Commands");
    expect(sectionSlice).toContain("pnpm run build");
    expect(sectionSlice).not.toContain("Always write tests first.");

    const pagedSlice = await call({ action: "read", offset: 1, limit: 3 });
    expect(pagedSlice).toContain("[lines 1-3 of");
    expect(pagedSlice).toContain("1: # Coding Rules");

    // Denied in read-only mode on upsert_section, allowed with unified diff under ask mode
    expect(await call({ action: "upsert_section", section: "Build Commands", content: "Run npm test." })).toContain("Denied:");
    ctx.permissions.set(session, { permission: "ask" });
    const promptCountBefore = prompts.length;
    expect(
      await call({ action: "upsert_section", section: "build commands", content: "## Build Commands\n\nRun npm test." }),
    ).toBe("Section updated in local memory.");
    expect(prompts.length).toBe(promptCountBefore + 1);
    expect(prompts.at(-1)?.message).toContain("-pnpm run build");
    expect(prompts.at(-1)?.message).toContain("+Run npm test.");

    const updated = readFileSync(globalFile, "utf8");
    expect(updated).toContain("# Coding Rules\n\nAlways write tests first.");
    expect(updated).toContain("## Build Commands\n\nRun npm test.");
    expect(updated).toContain("### Notes");

    // Appending a brand-new section via upsert_section
    expect(
      await call({ action: "upsert_section", section: "Release Process", content: "Tag v1.x releases cleanly." }),
    ).toBe("Section updated in local memory.");
    expect(readFileSync(globalFile, "utf8")).toContain("## Release Process\n\nTag v1.x releases cleanly.");

    // Concurrency safety classification covers read, list, search and rejects mutating actions
    expect(ctx.tools.isConcurrencySafe("desktop_memory", { action: "read" }, session.id)).toBe(true);
    expect(ctx.tools.isConcurrencySafe("desktop_memory", { action: "list" }, session.id)).toBe(true);
    expect(ctx.tools.isConcurrencySafe("desktop_memory", { action: "search", query: "build" }, session.id)).toBe(true);
    expect(ctx.tools.isConcurrencySafe("desktop_memory", { action: "append", content: "x" }, session.id)).toBe(false);
    expect(ctx.tools.isConcurrencySafe("desktop_memory", { action: "clear" }, session.id)).toBe(false);
    expect(await call({ action: "list" })).toContain("Release Process");
    await ctx.fiber.dispose();
  });
});

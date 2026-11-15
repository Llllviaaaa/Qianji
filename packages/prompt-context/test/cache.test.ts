import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Context } from "@deepseek-ai/cordis";
import { SystemPrompt } from "@qianji/system-prompt";
import { Tools } from "@qianji/tools";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as promptContext from "../src/index.ts";
import {
  clearPromptContextCaches,
  discoverRules,
  findSkills,
  getCacheStats,
  getCachedContextBlocks,
  MAX_PINNED_SESSIONS,
  normalizeSkillPathKey,
  pinSessionDate,
} from "../src/index.ts";

let root = "";

beforeEach(() => {
  clearPromptContextCaches();
});

afterEach(() => {
  clearPromptContextCaches();
  if (root !== "") {
    rmSync(root, { recursive: true, force: true });
    root = "";
  }
});

describe("session-pinned date", () => {
  it("pins once per non-empty sessionId across midnight and keeps LRU bound at MAX_PINNED_SESSIONS", () => {
    let day = "2026-11-15T23:59:59Z";
    const now = (): Date => new Date(day);
    const cache = new Map<string, string>();

    expect(pinSessionDate("s1", now, cache)).toBe("2026-11-15");
    day = "2026-11-16T00:05:00Z";
    expect(pinSessionDate("s1", now, cache)).toBe("2026-11-15");
    expect(pinSessionDate("s2", now, cache)).toBe("2026-11-16");

    // Empty and undefined session IDs read now() live each call.
    expect(pinSessionDate(undefined, now, cache)).toBe("2026-11-16");
    expect(pinSessionDate("", now, cache)).toBe("2026-11-16");
    day = "2026-11-17T01:00:00Z";
    expect(pinSessionDate(undefined, now, cache)).toBe("2026-11-17");
    expect(pinSessionDate("", now, cache)).toBe("2026-11-17");

    // Verify bounded LRU eviction: keep touching s1 before overflow so s2 (now oldest) evicts instead of s1.
    const lru = new Map<string, string>();
    day = "2026-11-15T12:00:00Z";
    expect(pinSessionDate("keep-me", now, lru)).toBe("2026-11-15");
    for (let i = 0; i < MAX_PINNED_SESSIONS - 1; i += 1) {
      pinSessionDate(`fill-${i}`, now, lru);
    }
    expect(lru.size).toBe(MAX_PINNED_SESSIONS);

    // Touch keep-me so fill-0 is oldest, then insert one new session.
    expect(pinSessionDate("keep-me", now, lru)).toBe("2026-11-15");
    day = "2026-11-18T12:00:00Z";
    expect(pinSessionDate("overflow", now, lru)).toBe("2026-11-18");
    expect(lru.size).toBe(MAX_PINNED_SESSIONS);
    expect(lru.has("fill-0")).toBe(false);
    expect(lru.get("keep-me")).toBe("2026-11-15");
  });

  it("keeps environment Date invariant in SystemPrompt across midnight and unpins on session deletion", async () => {
    root = mkdtempSync(join(tmpdir(), "qianji-pin-date-"));
    const dataDir = join(root, "data");
    const cwd = join(root, "repo");
    mkdirSync(dataDir, { recursive: true });
    mkdirSync(cwd, { recursive: true });

    let isoNow = "2026-11-15T23:59:59Z";
    const model = { provider: "p", model: "m" };
    const ctx = new Context();
    await ctx.plugin(SystemPrompt);
    await ctx.plugin(promptContext, { dataDir, now: () => new Date(isoNow) });

    const first = await ctx.systemPrompt.build({ sessionId: "sess-a", cwd, model, tools: [] });
    expect(first).toContain("- Date: 2026-11-15");

    isoNow = "2026-11-16T00:02:00Z";
    const secondSameSession = await ctx.systemPrompt.build({ sessionId: "sess-a", cwd, model, tools: [] });
    expect(secondSameSession).toContain("- Date: 2026-11-15");

    const newSession = await ctx.systemPrompt.build({ sessionId: "sess-b", cwd, model, tools: [] });
    expect(newSession).toContain("- Date: 2026-11-16");

    // Deleting sess-a clears its pinned date so recreating that id gets the new date.
    (ctx as unknown as { emit: (ev: string, arg: string) => void }).emit("session/deleted", "sess-a");
    const afterDelete = await ctx.systemPrompt.build({ sessionId: "sess-a", cwd, model, tools: [] });
    expect(afterDelete).toContain("- Date: 2026-11-16");

    await ctx.fiber.dispose();
  });
});

describe("stat/mtime/size caching & rapid invalidation", () => {
  it("caches context-files and @imports, invalidating immediately on same-tick edit, import edit, or deletion", () => {
    root = mkdtempSync(join(tmpdir(), "qianji-ctx-cache-"));
    const dataDir = join(root, "data");
    const cwd = join(root, "repo");
    mkdirSync(dataDir, { recursive: true });
    mkdirSync(cwd, { recursive: true });

    // Start with no AGENTS.md; cache empty result.
    expect(getCachedContextBlocks(dataDir, cwd)).toEqual([]);
    expect(getCachedContextBlocks(dataDir, cwd)).toEqual([]);
    expect(getCacheStats().contextBlocks).toEqual({ hits: 1, misses: 1 });

    // Rapid same-tick file creation invalidates cached empty list.
    const importFile = join(cwd, "guide.md");
    writeFileSync(importFile, "import-v1");
    writeFileSync(join(cwd, "AGENTS.md"), "root-v1 @guide.md");

    const blocks1 = getCachedContextBlocks(dataDir, cwd);
    expect(blocks1.join("\n")).toContain("root-v1");
    expect(blocks1.join("\n")).toContain("import-v1");
    expect(getCachedContextBlocks(dataDir, cwd)).toBe(blocks1);
    expect(getCacheStats().contextBlocks.hits).toBe(2);

    // Same-length rapid edit of AGENTS.md invalidates cleanly.
    writeFileSync(join(cwd, "AGENTS.md"), "root-v2 @guide.md");
    const blocks2 = getCachedContextBlocks(dataDir, cwd);
    expect(blocks2).not.toBe(blocks1);
    expect(blocks2.join("\n")).toContain("root-v2");

    // Same-length rapid edit of imported file invalidates cleanly.
    writeFileSync(importFile, "import-v2");
    const blocks3 = getCachedContextBlocks(dataDir, cwd);
    expect(blocks3).not.toBe(blocks2);
    expect(blocks3.join("\n")).toContain("import-v2");

    // Deleting AGENTS.md invalidates cleanly.
    rmSync(join(cwd, "AGENTS.md"));
    expect(getCachedContextBlocks(dataDir, cwd)).toEqual([]);
  });

  it("shares discoverRules cache across context-files, scoped-rules, and registerScopedRuleInjector, and invalidates on edits", async () => {
    root = mkdtempSync(join(tmpdir(), "qianji-rules-cache-"));
    const dataDir = join(root, "data");
    const cwd = join(root, "repo");
    const rulesDir = join(cwd, ".qianji", "rules");
    mkdirSync(dataDir, { recursive: true });
    mkdirSync(rulesDir, { recursive: true });
    mkdirSync(join(cwd, "src"), { recursive: true });

    writeFileSync(join(cwd, "src", "app.ts"), "export const x = 1;\n");
    writeFileSync(join(rulesDir, "always-inc.md"), "included-v1");
    writeFileSync(
      join(rulesDir, "always.md"),
      "---\nalwaysApply: true\n---\nAlways rule v1\n@./always-inc.md\n",
    );
    writeFileSync(
      join(rulesDir, "ts.md"),
      "---\nglobs:\n  - src/**/*.ts\ndescription: TS rule v1\n---\nCheck TS v1.\n",
    );

    const model = { provider: "p", model: "m" };
    const ctx = new Context();
    await ctx.plugin(SystemPrompt);
    await ctx.plugin(Tools);
    await ctx.plugin(promptContext, { dataDir });

    ctx.tools.register({
      name: "read",
      description: "mock read",
      parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
      async execute() {
        return { content: [{ type: "text", text: "file body" }] };
      },
    });

    const prompt1 = await ctx.systemPrompt.build({ sessionId: "s1", cwd, model, tools: [] });
    expect(prompt1).toContain("Always rule v1");
    expect(prompt1).toContain("included-v1");
    expect(prompt1).toContain("TS rule v1");

    // Trigger scoped-rule injector via read tool call (3rd consumer of discoverRules in same turn).
    const readOut = await ctx.tools.execute(
      { id: "c1", name: "read", args: { path: "src/app.ts" } },
      { sessionId: "s1", cwd, signal: new AbortController().signal },
    );
    const readText = readOut.content.map((part) => (part.type === "text" ? part.text : "")).join("\n");
    expect(readText).toContain("Check TS v1.");

    // context-files + scoped-rules + registerScopedRuleInjector => 1 miss, 2 hits!
    expect(getCacheStats().rules).toEqual({ misses: 1, hits: 2 });
    expect(discoverRules(dataDir, cwd)).toBe(discoverRules(dataDir, cwd));

    // Modify @import target inside always rule (same byte length): alwaysRules invalidates cleanly.
    writeFileSync(join(rulesDir, "always-inc.md"), "included-v2");
    const prompt2 = await ctx.systemPrompt.build({ sessionId: "s1", cwd, model, tools: [] });
    expect(prompt2).toContain("included-v2");

    // Rapid same-length edit of scoped rule invalidates discoverRules.
    writeFileSync(
      join(rulesDir, "ts.md"),
      "---\nglobs:\n  - src/**/*.ts\ndescription: TS rule v2\n---\nCheck TS v2.\n",
    );
    const rulesAfterEdit = discoverRules(dataDir, cwd);
    expect(rulesAfterEdit.find((r) => r.id.endsWith(":ts"))?.body).toContain("Check TS v2.");

    await ctx.fiber.dispose();
  });

  it("caches findSkills across calls and disabled sets, invalidating on rapid SKILL.md creation or edit", () => {
    root = mkdtempSync(join(tmpdir(), "qianji-skills-cache-"));
    const dirA = join(root, "dirA");
    const dirB = join(root, "dirB");
    mkdirSync(join(dirA, "alpha"), { recursive: true });
    mkdirSync(join(dirB, "alpha"), { recursive: true });
    writeFileSync(join(dirA, "alpha", "SKILL.md"), "---\nname: alpha\ndescription: A desc v1\n---\nbody");
    writeFileSync(join(dirB, "alpha", "SKILL.md"), "---\nname: alpha\ndescription: B desc v1\n---\nbody");

    const found1 = findSkills([dirA, dirB]);
    expect(found1).toHaveLength(1);
    expect(found1[0]?.description).toBe("B desc v1");

    // Repeated call + disabled override reuse the cached scan without extra misses.
    const found2 = findSkills([dirA, dirB]);
    expect(found2).toEqual(found1);
    const withBDisabled = findSkills([dirA, dirB], {
      disabled: new Set([normalizeSkillPathKey(join(dirB, "alpha", "SKILL.md"))]),
    });
    expect(withBDisabled[0]?.description).toBe("A desc v1");
    expect(getCacheStats().skills).toEqual({ misses: 1, hits: 2 });

    // Rapid equal-length edit of B/alpha/SKILL.md invalidates cache.
    writeFileSync(join(dirB, "alpha", "SKILL.md"), "---\nname: alpha\ndescription: B desc v2\n---\nbody");
    expect(findSkills([dirA, dirB])[0]?.description).toBe("B desc v2");

    // Rapid addition of new skill directory invalidates cache.
    mkdirSync(join(dirA, "beta"), { recursive: true });
    writeFileSync(join(dirA, "beta", "SKILL.md"), "---\nname: beta\ndescription: Beta desc\n---\nbody");
    expect(findSkills([dirA, dirB]).map((s) => s.name)).toEqual(["alpha", "beta"]);
  });
});

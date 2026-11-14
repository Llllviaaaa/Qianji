import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Context } from "@deepseek-ai/cordis";
import { afterEach, describe, expect, it } from "vitest";
import { Commands } from "@qianji/commands";
import "@qianji/session";
import { SystemPrompt } from "@qianji/system-prompt";
import { Tools, textOutput, type ToolOutput } from "@qianji/tools";
import * as promptContext from "../src/index.ts";
import {
  contextFiles,
  discoverRules,
  expandContextImports,
  matchesRuleGlobs,
  nestedContextFiles,
  parseRuleFile,
} from "../src/index.ts";

let root = "";
let ctx: Context | undefined;

afterEach(async () => {
  await ctx?.fiber.dispose();
  ctx = undefined;
  if (root !== "") {
    rmSync(root, { recursive: true, force: true });
    root = "";
  }
});

function mkWorkspace() {
  root = mkdtempSync(join(tmpdir(), "qianji-rules-"));
  const dataDir = join(root, "data");
  const repo = join(root, "repo");
  const pkg = join(repo, "packages", "sub");
  mkdirSync(dataDir, { recursive: true });
  mkdirSync(join(repo, ".git"), { recursive: true });
  mkdirSync(pkg, { recursive: true });
  return { root, dataDir, repo, pkg };
}

function outputText(output: ToolOutput): string {
  return output.content
    .flatMap((block) => (block.type === "text" ? [block.text] : []))
    .join("\n");
}

describe("AGENTS.local.md and CLAUDE.local.md overrides", () => {
  it("loads .local.md after its matching directory file and prefers AGENTS.local.md over CLAUDE.local.md", () => {
    const { dataDir, repo, pkg } = mkWorkspace();
    const onlyLocalDir = join(repo, "apps", "web");
    mkdirSync(onlyLocalDir, { recursive: true });

    writeFileSync(join(dataDir, "AGENTS.md"), "global base");
    writeFileSync(join(dataDir, "AGENTS.local.md"), "global local");
    writeFileSync(join(repo, "AGENTS.md"), "repo base");
    writeFileSync(join(repo, "AGENTS.local.md"), "repo local");
    writeFileSync(join(repo, "CLAUDE.local.md"), "ignored claude local");
    writeFileSync(join(pkg, "CLAUDE.md"), "pkg claude");
    writeFileSync(join(pkg, "CLAUDE.local.md"), "pkg claude local");
    writeFileSync(join(onlyLocalDir, "CLAUDE.local.md"), "web local only");

    expect(contextFiles(dataDir, pkg)).toEqual([
      join(dataDir, "AGENTS.md"),
      join(dataDir, "AGENTS.local.md"),
      join(repo, "AGENTS.md"),
      join(repo, "AGENTS.local.md"),
      join(pkg, "CLAUDE.md"),
      join(pkg, "CLAUDE.local.md"),
    ]);

    expect(contextFiles(dataDir, onlyLocalDir)).toEqual([
      join(dataDir, "AGENTS.md"),
      join(dataDir, "AGENTS.local.md"),
      join(repo, "AGENTS.md"),
      join(repo, "AGENTS.local.md"),
      join(onlyLocalDir, "CLAUDE.local.md"),
    ]);
  });
});

describe("@path import expansion", () => {
  it("expands standalone and inline imports, handles diamond and circular graphs, and skips code spans", () => {
    const { repo, root: outerRoot } = mkWorkspace();
    mkdirSync(join(repo, "docs", "sub"), { recursive: true });
    writeFileSync(join(outerRoot, "outside.md"), "SECRET OUTSIDE CONTENT");
    writeFileSync(join(repo, ".env"), "API_KEY=super-secret");
    writeFileSync(join(repo, "secrets.dat"), "binary-or-secret");
    writeFileSync(join(repo, "docs", "shared.md"), "SHARED RULE");
    writeFileSync(join(repo, "docs", "a.md"), "A BODY\n@./shared.md");
    writeFileSync(join(repo, "docs", "b.md"), "B BODY\n@./shared.md");
    writeFileSync(join(repo, "docs", "loop1.md"), "LOOP1\n@./loop2.md");
    writeFileSync(join(repo, "docs", "loop2.md"), "LOOP2\n@./loop1.md");
    writeFileSync(join(repo, "docs", "sub", "guide.md"), "SUB GUIDE\n@../shared.md");
    writeFileSync(join(repo, "docs", "style.md"), "INLINE STYLE");

    const source = [
      "Header",
      "@docs/a.md",
      "- @docs/b.md",
      "@./docs/sub/guide.md",
      "See @docs/style.md.",
      "@docs/loop1.md",
      "Ignore `@docs/style.md` and dev@example.com and @qianji/protocol and @layer utilities.",
      "```md",
      "@docs/style.md",
      "```",
      "@../outside.md",
      "@.env",
      "@secrets.dat",
    ].join("\n");

    const agentsFile = join(repo, "AGENTS.md");
    writeFileSync(agentsFile, source);

    const expanded = expandContextImports(source, agentsFile, { boundaryDir: repo });

    expect(expanded).toContain("A BODY");
    expect(expanded).toContain("B BODY");
    expect(expanded).toContain("SUB GUIDE");
    expect(expanded).toContain("See @docs/style.md.");
    expect(expanded).toContain("INLINE STYLE");
    expect(expanded).toContain("LOOP1");
    expect(expanded).toContain("LOOP2");

    // Diamond deduplication: SHARED RULE only expanded once across a.md, b.md, sub/guide.md
    expect(expanded.match(/SHARED RULE/g)?.length).toBe(1);

    // Code fences, inline code, emails, CSS at-rules, and scoped npm names are untouched
    expect(expanded).toContain("Ignore `@docs/style.md` and dev@example.com and @qianji/protocol and @layer utilities.");
    expect(expanded).toContain("```md\n@docs/style.md\n```");

    // Traversal outside boundary and secret files are blocked
    expect(expanded).not.toContain("SECRET OUTSIDE CONTENT");
    expect(expanded).not.toContain("API_KEY=super-secret");
    expect(expanded).not.toContain("binary-or-secret");
  });
});

describe("rules discovery, glob matching, and tools/execute dynamic activation", () => {
  it("parses frontmatter formats and matches globs with braces and negations", () => {
    const parsedMdc = parseRuleFile(
      '---\ndescription: React UI rules\nglobs: ["src/**/*.tsx", "packages/**/src/*.ts"]\n---\nUse hooks cleanly.',
      "ui.mdc",
    );
    expect(parsedMdc.mode).toBe("glob");
    expect(parsedMdc.globs).toEqual(["src/**/*.tsx", "packages/**/src/*.ts"]);
    expect(parsedMdc.description).toBe("React UI rules");

    const parsedYamlList = parseRuleFile(
      "---\npaths:\n  - src/**/*.{ts,tsx}\n  - !*.test.tsx\n---\nStrict types.",
      "ts.md",
    );
    expect(parsedYamlList.mode).toBe("glob");
    expect(parsedYamlList.globs).toEqual(["src/**/*.{ts,tsx}", "!*.test.tsx"]);

    const parsedManual = parseRuleFile("---\nalwaysApply: false\ndescription: Manual checklist\n---\nCheck edge cases.", "check.mdc");
    expect(parsedManual.mode).toBe("manual");

    expect(matchesRuleGlobs("App.tsx", ["*.tsx"])).toBe(true);
    expect(matchesRuleGlobs("src/components/App.tsx", ["*.tsx"])).toBe(true);
    expect(matchesRuleGlobs("src/App.tsx", ["src/**/*.tsx"])).toBe(true);
    expect(matchesRuleGlobs("src/a/b/App.tsx", ["src/**/*.tsx"])).toBe(true);
    expect(matchesRuleGlobs("other/App.tsx", ["src/**/*.tsx"])).toBe(false);
    expect(matchesRuleGlobs("src/App.ts", ["src/**/*.{ts,tsx}", "!*.test.ts"])).toBe(true);
    expect(matchesRuleGlobs("src/App.test.ts", ["src/**/*.{ts,tsx}", "!*.test.ts"])).toBe(false);
    expect(matchesRuleGlobs("src/App.tsx", ["!*.test.tsx"])).toBe(false);
  });

  it("injects always rules, indexes scoped rules, and dynamically attaches matching rules & nested AGENTS.md once per session", async () => {
    const { dataDir, repo, pkg } = mkWorkspace();
    mkdirSync(join(dataDir, "rules"), { recursive: true });
    mkdirSync(join(repo, ".claude", "rules"), { recursive: true });
    mkdirSync(join(repo, ".qianji", "rules"), { recursive: true });
    mkdirSync(join(repo, ".cursor", "rules"), { recursive: true });
    mkdirSync(join(repo, "docs"), { recursive: true });
    mkdirSync(join(repo, "src", "styles"), { recursive: true });

    writeFileSync(join(dataDir, "rules", "global.md"), "Always follow global rule.");
    writeFileSync(join(repo, ".claude", "rules", "common.md"), "FROM CLAUDE");
    writeFileSync(join(repo, ".qianji", "rules", "common.md"), "FROM QIANJI OVERRIDE");
    writeFileSync(join(repo, "docs", "css-detail.md"), "USE CSS VARIABLES");
    writeFileSync(
      join(repo, ".cursor", "rules", "styles.mdc"),
      "---\ndescription: CSS cascade conventions\nglobs: src/styles/**/*.css\n---\nWrap styles carefully.\n@docs/css-detail.md",
    );
    writeFileSync(join(pkg, "AGENTS.md"), "SUBPACKAGE INVARIANTS");
    writeFileSync(join(repo, "src", "styles", "index.css"), "body {}");
    writeFileSync(join(pkg, "index.ts"), "export {};");

    const discovered = discoverRules(dataDir, repo);
    expect(discovered.some((r) => r.body === "FROM QIANJI OVERRIDE")).toBe(true);
    expect(discovered.some((r) => r.body === "FROM CLAUDE")).toBe(false);

    ctx = new Context();
    await ctx.plugin(SystemPrompt);
    await ctx.plugin(Tools);
    await ctx.plugin(promptContext, { dataDir });

    ctx.tools.register({
      name: "read",
      description: "Read stub",
      parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
      execute: ({ path }) => {
        if (String(path).includes("missing")) return textOutput("not found", true);
        return textOutput(`CONTENT:${String(path)}`);
      },
    });
    ctx.tools.register({
      name: "edit",
      description: "Edit stub",
      parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
      execute: ({ path }) => textOutput(`EDITED:${String(path)}`),
    });

    const prompt = await ctx.systemPrompt.build({
      sessionId: "s1",
      cwd: repo,
      model: { provider: "p", model: "m" },
      tools: [{ name: "read", description: "", parameters: {} }],
    });

    expect(prompt).toContain("Always follow global rule.");
    expect(prompt).toContain("FROM QIANJI OVERRIDE");
    expect(prompt).not.toContain("FROM CLAUDE");
    expect(prompt).toContain("<scoped-rules>");
    expect(prompt).toContain('globs="src/styles/**/*.css"');
    expect(prompt).toContain("CSS cascade conventions");
    // Scoped rule body must stay out of the static system prompt
    expect(prompt).not.toContain("Wrap styles carefully.");
    expect(prompt).not.toContain("USE CSS VARIABLES");

    const signal = new AbortController().signal;
    // Failed call must not mark rule as seen or inject rules
    const errOut = await ctx.tools.execute(
      { id: "c0", name: "read", args: { path: "src/styles/missing.css" } },
      { sessionId: "s1", cwd: repo, signal },
    );
    expect(errOut.isError).toBe(true);
    expect(outputText(errOut)).not.toContain("<project-rules-activated>");

    // First matching read in session s1 activates the glob rule (with @path expanded!)
    const firstCss = await ctx.tools.execute(
      { id: "c1", name: "read", args: { path: "src/styles/index.css" } },
      { sessionId: "s1", cwd: repo, signal },
    );
    const firstText = outputText(firstCss);
    expect(firstText).toContain("<project-rules-activated>");
    expect(firstText).toContain("Wrap styles carefully.");
    expect(firstText).toContain("USE CSS VARIABLES");

    // Second access to matching path in same session does not duplicate
    const secondCss = await ctx.tools.execute(
      { id: "c2", name: "edit", args: { path: "src/styles/index.css" } },
      { sessionId: "s1", cwd: repo, signal },
    );
    expect(outputText(secondCss)).not.toContain("<project-rules-activated>");

    // Different session gets the activation again
    const otherSession = await ctx.tools.execute(
      { id: "c3", name: "read", args: { path: "src/styles/index.css" } },
      { sessionId: "s2", cwd: repo, signal },
    );
    expect(outputText(otherSession)).toContain("Wrap styles carefully.");

    // After session/deleted, reusing s1 triggers activation again
    ctx.emit("session/deleted", "s1");
    const afterDelete = await ctx.tools.execute(
      { id: "c4", name: "read", args: { path: "src/styles/index.css" } },
      { sessionId: "s1", cwd: repo, signal },
    );
    expect(outputText(afterDelete)).toContain("Wrap styles carefully.");

    // Accessing a subdirectory below cwd activates nested AGENTS.md
    expect(nestedContextFiles(repo, "packages/sub/index.ts")).toEqual([join(pkg, "AGENTS.md")]);
    const nestedRead = await ctx.tools.execute(
      { id: "c5", name: "read", args: { path: "packages/sub/index.ts" } },
      { sessionId: "s1", cwd: repo, signal },
    );
    expect(outputText(nestedRead)).toContain("SUBPACKAGE INVARIANTS");
  });
});

describe("/init command", () => {
  it("lists /init and returns creation or audit prompts depending on AGENTS.md presence", async () => {
    const { dataDir, repo } = mkWorkspace();
    writeFileSync(join(repo, "package.json"), '{"name":"demo"}');
    writeFileSync(join(repo, ".cursorrules"), "legacy rules");

    ctx = new Context();
    await ctx.plugin(SystemPrompt);
    await ctx.plugin(Commands);
    await ctx.plugin(promptContext, { dataDir });

    const listed = await ctx.commands.list(repo);
    expect(listed.some((cmd) => cmd.name === "init")).toBe(true);

    const signal = new AbortController().signal;
    const createRes = await ctx.commands.run("init", "", { cwd: repo, signal });
    expect(createRes.handled).toBe(true);
    expect(createRes.prompt).toContain("package.json");
    expect(createRes.prompt).toContain(".cursorrules");
    expect(createRes.prompt).toContain("AGENTS.md");
    expect(createRes.prompt).toContain("write");

    writeFileSync(join(repo, "AGENTS.md"), "# Existing");
    const updateRes = await ctx.commands.run("init", "重点补充 Rust 命令", { cwd: repo, signal });
    expect(updateRes.handled).toBe(true);
    expect(updateRes.prompt).toContain("已存在 `AGENTS.md`");
    expect(updateRes.prompt).toContain("edit");
    expect(updateRes.prompt).toContain("用户补充要求：重点补充 Rust 命令");

    const invalidRes = await ctx.commands.run("init", "", { cwd: join(root, "nope"), signal });
    expect(invalidRes.handled).toBe(true);
    expect(invalidRes.isError).toBe(true);
  });
});

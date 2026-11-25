import { mkdtempSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Context } from "@deepseek-ai/cordis";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Sessions } from "@qianji/session";
import { Tools, type ToolEnv, type ToolOutput } from "@qianji/tools";
import * as toolFs from "../src/index.ts";

let cwd = "";

beforeEach(() => {
  cwd = mkdtempSync(join(tmpdir(), "qianji-fs-cas-"));
});

afterEach(() => {
  rmSync(cwd, { recursive: true, force: true });
});

const textOf = (output: ToolOutput): string =>
  output.content.map((block) => (block.type === "text" ? block.text : "")).join("\n");

async function createCtx(config: toolFs.Config = {}) {
  const ctx = new Context();
  await ctx.plugin(Sessions);
  await ctx.plugin(Tools);
  await ctx.plugin(toolFs, config);
  const session = ctx.sessions.create({ cwd });
  const env = (): ToolEnv => ({ sessionId: session.id, cwd, signal: new AbortController().signal });
  return { ctx, session, env };
}

describe("FileObservationTracker CAS & writethrough diagnostics", () => {
  it("denies editing or overwriting an existing unread file with [FS_NOT_OBSERVED], then allows after read", async () => {
    writeFileSync(join(cwd, "existing.ts"), "export const v = 1;\n", "utf8");
    const { ctx, env } = await createCtx();

    const blockedEdit = await ctx.tools.execute(
      { id: "e1", name: "edit", args: { path: "existing.ts", edits: [{ oldText: "v = 1", newText: "v = 2" }] } },
      env(),
    );
    expect(blockedEdit.isError).toBe(true);
    expect(textOf(blockedEdit)).toContain("[FS_NOT_OBSERVED]");
    expect(textOf(blockedEdit)).toContain("existing.ts");

    const blockedOverwrite = await ctx.tools.execute(
      { id: "w1", name: "write", args: { path: "existing.ts", content: "export const v = 99;\n" } },
      env(),
    );
    expect(blockedOverwrite.isError).toBe(true);
    expect(textOf(blockedOverwrite)).toContain("[FS_NOT_OBSERVED]");

    // Reading the file seeds its observation stamp and unlocks subsequent chained edits
    const readRes = await ctx.tools.execute({ id: "r1", name: "read", args: { path: "existing.ts" } }, env());
    expect(readRes.isError).toBeUndefined();

    const okEdit1 = await ctx.tools.execute(
      { id: "e2", name: "edit", args: { path: "existing.ts", edits: [{ oldText: "v = 1", newText: "v = 2" }] } },
      env(),
    );
    expect(okEdit1.isError).toBeUndefined();

    // Consecutive edit without re-reading works because edit updates the recorded stamp
    const okEdit2 = await ctx.tools.execute(
      { id: "e3", name: "edit", args: { path: "existing.ts", edits: [{ oldText: "v = 2", newText: "v = 3" }] } },
      env(),
    );
    expect(okEdit2.isError).toBeUndefined();
    expect(readFileSync(join(cwd, "existing.ts"), "utf8")).toBe("export const v = 3;\n");
    await ctx.fiber.dispose();
  });

  it("always allows creating a brand-new file via write without prior read, and seeds its stamp", async () => {
    const { ctx, env } = await createCtx();
    const created = await ctx.tools.execute(
      { id: "w-new", name: "write", args: { path: "sub/brand-new.txt", content: "alpha\n" } },
      env(),
    );
    expect(created.isError).toBeUndefined();

    const followEdit = await ctx.tools.execute(
      { id: "e-new", name: "edit", args: { path: "sub/brand-new.txt", edits: [{ oldText: "alpha", newText: "beta" }] } },
      env(),
    );
    expect(followEdit.isError).toBeUndefined();
    expect(readFileSync(join(cwd, "sub", "brand-new.txt"), "utf8")).toBe("beta\n");
    await ctx.fiber.dispose();
  });

  it("allows mtime drift when SHA-256 matches, and blocks external modifications with [FS_STALE_VERSION]", async () => {
    const file = join(cwd, "config.ts");
    writeFileSync(file, "export const port = 3000;\n", "utf8");
    const { ctx, env } = await createCtx();

    await ctx.tools.execute({ id: "r1", name: "read", args: { path: "config.ts" } }, env());

    // 1. Touch mtime (+60s) without changing file bytes (simulating Git checkout / Windows AV touch)
    const future = new Date(statSync(file).mtimeMs + 60_000);
    utimesSync(file, future, future);

    const mtimeDriftEdit = await ctx.tools.execute(
      { id: "e-drift", name: "edit", args: { path: "config.ts", edits: [{ oldText: "3000", newText: "4000" }] } },
      env(),
    );
    expect(mtimeDriftEdit.isError).toBeUndefined();
    expect(readFileSync(file, "utf8")).toBe("export const port = 4000;\n");

    // 2. External modification changes bytes on disk -> must reject with [FS_STALE_VERSION]
    writeFileSync(file, "export const port = 5000;\n", "utf8");
    const staleEdit = await ctx.tools.execute(
      { id: "e-stale", name: "edit", args: { path: "config.ts", edits: [{ oldText: "5000", newText: "6000" }] } },
      env(),
    );
    expect(staleEdit.isError).toBe(true);
    expect(textOf(staleEdit)).toContain("[FS_STALE_VERSION]");

    // Re-reading refreshes the CAS stamp and unlocks editing again
    await ctx.tools.execute({ id: "r2", name: "read", args: { path: "config.ts" } }, env());
    const recoveredEdit = await ctx.tools.execute(
      { id: "e-ok", name: "edit", args: { path: "config.ts", edits: [{ oldText: "5000", newText: "6000" }] } },
      env(),
    );
    expect(recoveredEdit.isError).toBeUndefined();
    expect(readFileSync(file, "utf8")).toBe("export const port = 6000;\n");
    await ctx.fiber.dispose();
  });

  it("lazily hydrates prior observed files from session history after restart/reload", async () => {
    const fileA = join(cwd, "a.txt");
    const fileB = join(cwd, "b.txt");
    writeFileSync(fileA, "hello A\n", "utf8");
    writeFileSync(fileB, "hello B\n", "utf8");

    // Simulate a restored session that already has historical tool-call + non-error tool-result events pre-restart
    const ctx = new Context();
    await ctx.plugin(Sessions);
    await ctx.plugin(Tools);
    const restored = ctx.sessions.create({ cwd });
    restored.append("tool-call", { callId: "hist-1", name: "read", args: { path: "a.txt" } });
    restored.append("tool-result", {
      callId: "hist-1",
      name: "read",
      content: [{ type: "text", text: "hello A\n" }],
      isError: false,
    });
    // Failed historical read must NOT mark b.txt as observed
    restored.append("tool-call", { callId: "hist-2", name: "read", args: { path: "b.txt" } });
    restored.append("tool-result", {
      callId: "hist-2",
      name: "read",
      content: [{ type: "text", text: "read error" }],
      isError: true,
    });

    // Mount tool-fs AFTER session events already existed (mirrors Host restart)
    await ctx.plugin(toolFs);
    const env: ToolEnv = { sessionId: restored.id, cwd, signal: new AbortController().signal };

    const editA = await ctx.tools.execute(
      { id: "e-a", name: "edit", args: { path: "a.txt", edits: [{ oldText: "hello A", newText: "updated A" }] } },
      env,
    );
    expect(editA.isError).toBeUndefined();
    expect(readFileSync(fileA, "utf8")).toBe("updated A\n");

    const editB = await ctx.tools.execute(
      { id: "e-b", name: "edit", args: { path: "b.txt", edits: [{ oldText: "hello B", newText: "updated B" }] } },
      env,
    );
    expect(editB.isError).toBe(true);
    expect(textOf(editB)).toContain("[FS_NOT_OBSERVED]");
    await ctx.fiber.dispose();
  });

  it("appends <diagnostics-summary> on error diagnostics after write/edit and respects enforceReadBeforeEdit: false", async () => {
    const { ctx, env } = await createCtx({ enforceReadBeforeEdit: false, writethroughDiagnosticsMs: 1_500 });

    const brokenWrite = await ctx.tools.execute(
      { id: "w-json", name: "write", args: { path: "package-meta.json", content: '{\n  "name": "demo",\n  broken\n}\n' } },
      env(),
    );
    expect(brokenWrite.isError).toBeUndefined();
    expect(textOf(brokenWrite)).toContain("<diagnostics-summary>");
    expect(textOf(brokenWrite)).toContain("package-meta.json:");
    expect(textOf(brokenWrite)).toContain("[error JSON]");

    const fixedEdit = await ctx.tools.execute(
      {
        id: "e-json",
        name: "edit",
        args: { path: "package-meta.json", edits: [{ oldText: '  "name": "demo",\n  broken', newText: '  "name": "demo"' }] },
      },
      env(),
    );
    expect(fixedEdit.isError).toBeUndefined();
    expect(textOf(fixedEdit)).not.toContain("<diagnostics-summary>");
    await ctx.fiber.dispose();
  });
});

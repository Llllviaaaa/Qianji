import { mkdirSync, mkdtempSync, readFileSync, rmSync, truncateSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ToolDefinition, ToolEnv, ToolOutput } from "@qianji/tools";
import {
  applyEdits,
  diagnostics,
  edit,
  find,
  globToRegExp,
  grep,
  grepWithNode,
  inspectFileBeforeRead,
  lineHash,
  ls,
  matchesGlob,
  MAX_IMAGE_BYTES,
  MAX_TEXT_READ_BYTES,
  parseTscDiagnostics,
  read,
  stripBom,
  write,
} from "../src/index.ts";

let cwd = "";
const env = (): ToolEnv => ({ sessionId: "s", cwd, signal: new AbortController().signal });

beforeEach(() => {
  cwd = mkdtempSync(join(tmpdir(), "pid-tool-fs-"));
  mkdirSync(join(cwd, "src", "deep"), { recursive: true });
  mkdirSync(join(cwd, "node_modules", "dep"), { recursive: true });
  writeFileSync(join(cwd, "src", "a.ts"), "export const a = 1;\nconst hidden = 'needle';\n");
  writeFileSync(join(cwd, "src", "deep", "b.test.ts"), "test('needle', () => {});\n");
  writeFileSync(join(cwd, "node_modules", "dep", "index.ts"), "needle\n");
  writeFileSync(join(cwd, "README.md"), "# Title\n");
});

afterEach(() => rmSync(cwd, { recursive: true, force: true }));

async function call<A extends Record<string, unknown>>(tool: ToolDefinition<A>, args: A): Promise<{ text: string; isError: boolean }> {
  const output: ToolOutput = await tool.execute(args, env());
  return { text: output.content.map((block) => (block.type === "text" ? block.text : `[${block.mimeType}]`)).join("\n"), isError: output.isError === true };
}

describe("read", () => {
  it("reads a window of lines and says how to continue", async () => {
    writeFileSync(join(cwd, "long.txt"), Array.from({ length: 10 }, (_, index) => `line ${index + 1}`).join("\n"));
    expect((await call(read, { path: "long.txt", offset: 3, limit: 2 })).text).toBe("line 3\nline 4\n\n[Lines 3-4 of 10. Use offset=5 to read more.]");
    expect((await call(read, { path: "long.txt", offset: 20 })).isError).toBe(true);
    expect((await call(read, { path: "README.md" })).text).toBe("# Title\n");
  });

  it("returns images as image blocks", async () => {
    writeFileSync(join(cwd, "pic.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    expect((await call(read, { path: "pic.png" })).text).toBe("Image pic.png:\n[image/png]");
  });
});

describe("write and edit", () => {
  it("writes files, creating directories", async () => {
    expect((await call(write, { path: "new/dir/f.txt", content: "hi" })).text).toBe("Wrote 2 bytes to new/dir/f.txt.");
    expect(readFileSync(join(cwd, "new", "dir", "f.txt"), "utf8")).toBe("hi");
  });

  it("applies unique replacements all or nothing", async () => {
    const result = await call(edit, { path: "src/a.ts", edits: [{ oldText: "a = 1", newText: "a = 2" }, { oldText: "'needle'", newText: "'pin'" }] });
    expect(result).toEqual({ text: "Applied 2 edit(s) to src/a.ts.", isError: false });
    expect(readFileSync(join(cwd, "src", "a.ts"), "utf8")).toBe("export const a = 2;\nconst hidden = 'pin';\n");

    const failed = await call(edit, { path: "src/a.ts", edits: [{ oldText: "a = 2", newText: "a = 3" }, { oldText: "absent", newText: "" }] });
    expect(failed.isError).toBe(true);
    expect(failed.text).toContain("edits[1].oldText was not found");
    expect(readFileSync(join(cwd, "src", "a.ts"), "utf8")).toContain("a = 2");
  });

  it("explains ambiguous, overlapping and empty edits", () => {
    expect(() => applyEdits("x x", [{ oldText: "x", newText: "y" }])).toThrow("more than once");
    expect(() => applyEdits("abcdef", [{ oldText: "abc", newText: "" }, { oldText: "cde", newText: "" }])).toThrow("overlap");
    expect(() => applyEdits("abc", [{ oldText: "", newText: "z" }])).toThrow("empty");
  });

  it("keeps CRLF files CRLF", () => {
    expect(applyEdits("one\r\ntwo\r\n", [{ oldText: "one\ntwo", newText: "1\n2" }])).toBe("1\r\n2\r\n");
  });

  it("falls back to tolerating retyped quotes, dashes, spaces and trailing whitespace", () => {
    const fuzzy: number[] = [];
    // The file has curly quotes, an em dash, a no-break space and trailing spaces; the model typed plain ASCII.
    const original = "const a = \u201Chello\u201D;   \nconst b = 1 \u2014 2;\nconst c = 3\u00A0+ 4;\nkeep \u201Cthis\u201D\n";
    const updated = applyEdits(original, [
      { oldText: 'const a = "hello";\nconst b = 1 - 2;', newText: 'const a = "hi";\nconst b = 0;' },
      { oldText: "const c = 3 + 4;", newText: "const c = 7;" },
    ], fuzzy);
    expect(updated).toBe("const a = \"hi\";\nconst b = 0;\nconst c = 7;\nkeep \u201Cthis\u201D\n");
    expect(fuzzy).toEqual([0, 1]);

    // Exact matches never take the fallback.
    const exact: number[] = [];
    applyEdits("x = 1", [{ oldText: "x = 1", newText: "x = 2" }], exact);
    expect(exact).toEqual([]);
  });

  it("still requires a unique match and exact indentation when tolerating", () => {
    expect(() => applyEdits("a \u2014 b\na \u2013 b\n", [{ oldText: "a - b", newText: "c" }])).toThrow("more than once");
    expect(() => applyEdits("  if (x) {\n", [{ oldText: "    if (x) {", newText: "" }])).toThrow("was not found");
    expect(() => applyEdits("[a] (b) $c", [{ oldText: "[a] (b) $d", newText: "" }])).toThrow("was not found");
    expect(applyEdits("f(a[0], 'x')  \n", [{ oldText: "f(a[0], \u2018x\u2019)", newText: "g()" }])).toBe("g()  \n");
  });

  it("tells the model when an edit matched only after tolerating differences", async () => {
    writeFileSync(join(cwd, "src", "quotes.ts"), "say(\u201Chi\u201D);\n");
    const result = await call(edit, { path: "src/quotes.ts", edits: [{ oldText: 'say("hi");', newText: 'say("bye");' }] });
    expect(result.isError).toBe(false);
    expect(result.text).toContain("edits[0] matched only after ignoring differences");
    expect(readFileSync(join(cwd, "src", "quotes.ts"), "utf8")).toBe('say("bye");\n');
  });
});

describe("ls, find and grep", () => {
  it("lists a directory with directories marked", async () => {
    expect((await call(ls, {})).text).toBe("node_modules/\nREADME.md\nsrc/");
  });

  it("finds files by glob, skipping node_modules", async () => {
    expect((await call(find, { pattern: "*.ts" })).text).toBe("src/a.ts\nsrc/deep/b.test.ts");
    expect((await call(find, { pattern: "src/**/*.test.ts" })).text).toBe("src/deep/b.test.ts");
    expect((await call(find, { pattern: "*.{md,txt}" })).text).toBe("README.md");
    expect((await call(find, { pattern: "*.rs" })).text).toBe("No files found.");
  });

  it("matches globs the way the descriptions say", () => {
    expect(globToRegExp("src/**/x.ts").test("src/x.ts")).toBe(true);
    expect(globToRegExp("src/**/x.ts").test("src/a/b/x.ts")).toBe(true);
    expect(globToRegExp("*.ts").test("a/b.ts")).toBe(false);
    expect(matchesGlob("*.ts", "a/b.ts")).toBe(true);
  });

  it("greps contents with paths and line numbers", async () => {
    expect((await call(grep, { pattern: "needle" })).text).toBe("src/a.ts:2: const hidden = 'needle';\nsrc/deep/b.test.ts:1: test('needle', () => {});");
    expect((await call(grep, { pattern: "NEEDLE", ignoreCase: true, glob: "*.test.ts" })).text).toBe("src/deep/b.test.ts:1: test('needle', () => {});");
    expect((await call(grep, { pattern: "(", literal: true, path: "src/deep/b.test.ts" })).text).toBe("b.test.ts:1: test('needle', () => {});");
    expect((await call(grep, { pattern: "needle", limit: 1 })).text).toContain("[Stopped at 1 matches");
    expect((await call(grep, { pattern: "(" })).isError).toBe(true);
    const nodeOnly = grepWithNode({ pattern: "needle" }, env());
    expect(nodeOnly.matches).toEqual([
      "src/a.ts:2: const hidden = 'needle';",
      "src/deep/b.test.ts:1: test('needle', () => {});",
    ]);
  });
});

describe("hashline read and edit", () => {
  it("formats hashlines on read when hashlines=true and supports replace/insert/delete", async () => {
    writeFileSync(join(cwd, "hash.ts"), "const a = 1;\nconst b = 2;\nconst c = 3;\n");
    const out = await call(read, { path: "hash.ts", hashlines: true });
    expect(out.isError).toBe(false);
    expect(out.text).toContain(`1:${lineHash("const a = 1;")}| const a = 1;`);
    expect(out.text).toContain(`2:${lineHash("const b = 2;")}| const b = 2;`);

    const a1 = `1:${lineHash("const a = 1;")}`;
    const a2 = `2:${lineHash("const b = 2;")}`;
    const a3 = `3:${lineHash("const c = 3;")}`;
    const edited = await edit.execute({
      path: "hash.ts",
      edits: [
        { anchor: a1, endAnchor: a2, op: "replace", newText: "const ab = 12;" },
        { anchor: a2, op: "insert_after", newText: "const mid = true;" },
        { anchor: a3, op: "delete" },
      ],
    }, env());
    expect(edited.isError).not.toBe(true);
    expect((edited.details as { diff?: string } | undefined)?.diff).toContain("@@");
    expect(readFileSync(join(cwd, "hash.ts"), "utf8")).toBe("const ab = 12;\nconst mid = true;\n");
  });

  it("relocates shifted anchors within ±20 lines and returns actionable mismatch errors", async () => {
    const file = join(cwd, "shift.ts");
    const original = "// header\n// inserted\nconst target = 42;\n// footer\n";
    writeFileSync(file, original);
    // Target moved from line 2 -> line 3, unique hash within ±20 lines.
    const staleAnchor = `2:${lineHash("const target = 42;")}`;
    const ok = await call(edit, { path: "shift.ts", edits: [{ anchor: staleAnchor, op: "replace", newText: "const target = 99;" }] });
    expect(ok.isError).toBe(false);
    expect(ok.text).toContain("relocated by line content hash");
    expect(readFileSync(file, "utf8")).toBe("// header\n// inserted\nconst target = 99;\n// footer\n");

    const bad = await call(edit, {
      path: "shift.ts",
      edits: [
        { anchor: `1:${lineHash("// header")}`, op: "replace", newText: "// changed" },
        { anchor: "3:000", op: "replace", newText: "broken" },
      ],
    });
    expect(bad.isError).toBe(true);
    expect(bad.text).toContain("Current lines near line 3");
    // Atomic rollback: line 1 stayed untouched.
    expect(readFileSync(file, "utf8")).toBe("// header\n// inserted\nconst target = 99;\n// footer\n");
  });

  it("supports CRLF and insert_before", () => {
    const original = "one\r\ntwo\r\n";
    const updated = applyEdits(original, [
      { anchor: `1:${lineHash("one")}`, op: "insert_before", newText: "zero" },
      { oldText: "two", newText: "2" },
    ]);
    expect(updated).toBe("zero\r\none\r\n2\r\n");
  });
});

describe("diagnostics", () => {
  it("registers as deferred read-only tool and reports JSON errors and tsc formatting", async () => {
    expect(diagnostics.readOnly).toBe(true);
    expect(diagnostics.deferred).toBe(true);
    expect(diagnostics.group).toBe("code_intelligence");

    writeFileSync(join(cwd, "broken.json"), '{\n  "ok": 1,\n  bad\n}\n');
    const res = await call(diagnostics, { paths: ["broken.json"] });
    expect(res.isError).toBe(false);
    expect(res.text).toContain("broken.json:");
    expect(res.text).toContain("[error JSON]");

    const parsed = parseTscDiagnostics(
      "src/a.ts(12,5): error TS2322: Type 'string' is not assignable to type 'number'.\n",
      cwd,
      cwd,
    );
    expect(parsed).toEqual([{
      file: "src/a.ts",
      line: 12,
      column: 5,
      severity: "error",
      code: "TS2322",
      message: "Type 'string' is not assignable to type 'number'.",
    }]);
  });
});

describe("readOnly metadata", () => {
  it("marks read-only FS tools as readOnly and mutating tools as non-readOnly", () => {
    expect(read.readOnly).toBe(true);
    expect(ls.readOnly).toBe(true);
    expect(find.readOnly).toBe(true);
    expect(grep.readOnly).toBe(true);
    expect(diagnostics.readOnly).toBe(true);
    expect(write.readOnly).not.toBe(true);
    expect(edit.readOnly).not.toBe(true);
  });
});

describe("file hygiene guards and UTF-8 BOM preservation", () => {
  it("strips UTF-8 BOM on read (including lineHash calculation) and preserves BOM across oldText and hashline edits", async () => {
    const bomPath = join(cwd, "bom.ts");
    const bomBytes = Buffer.from("\uFEFFconst a = 1;\nconst b = 2;\n", "utf8");
    expect([...bomBytes.subarray(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);
    writeFileSync(bomPath, bomBytes);

    expect(stripBom("\uFEFFhello")).toEqual({ hasBom: true, text: "hello" });
    expect(stripBom("hello")).toEqual({ hasBom: false, text: "hello" });

    const plainRead = await call(read, { path: "bom.ts" });
    expect(plainRead.isError).toBe(false);
    expect(plainRead.text).toBe("const a = 1;\nconst b = 2;\n");
    expect(plainRead.text.startsWith("\uFEFF")).toBe(false);

    const hashlineRead = await call(read, { path: "bom.ts", hashlines: true });
    expect(hashlineRead.isError).toBe(false);
    const expectedLine1 = `1:${lineHash("const a = 1;")}| const a = 1;`;
    expect(hashlineRead.text.split("\n")[0]).toBe(expectedLine1);

    const oldTextEdit = await call(edit, {
      path: "bom.ts",
      edits: [{ oldText: "const b = 2;", newText: "const b = 20;" }],
    });
    expect(oldTextEdit.isError).toBe(false);
    const afterOldText = readFileSync(bomPath);
    expect([...afterOldText.subarray(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);
    expect(afterOldText.toString("utf8")).toBe("\uFEFFconst a = 1;\nconst b = 20;\n");

    const hashlineEdit = await call(edit, {
      path: "bom.ts",
      edits: [{ anchor: `1:${lineHash("const a = 1;")}`, op: "replace", newText: "const a = 10;" }],
    });
    expect(hashlineEdit.isError).toBe(false);
    const afterHashline = readFileSync(bomPath);
    expect([...afterHashline.subarray(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);
    expect(afterHashline.toString("utf8")).toBe("\uFEFFconst a = 10;\nconst b = 20;\n");
  });

  it("rejects binary files with NUL bytes and UTF-16 BOM files with clear errors including byte size", async () => {
    const binPath = join(cwd, "data.bin");
    const payload = Buffer.from([0x48, 0x69, 0x00, 0x21, 0x0a]);
    writeFileSync(binPath, payload);

    const binDirect = inspectFileBeforeRead(binPath, false);
    expect(binDirect).toContain("NUL");
    expect(binDirect).toContain(`${payload.length} bytes`);

    const binRead = await call(read, { path: "data.bin" });
    expect(binRead.isError).toBe(true);
    expect(binRead.text).toContain("5 bytes");

    const binEdit = await call(edit, { path: "data.bin", edits: [{ oldText: "Hi", newText: "Bye" }] });
    expect(binEdit.isError).toBe(true);
    expect(binEdit.text).toContain("5 bytes");

    const utf16Path = join(cwd, "utf16.txt");
    const utf16Bytes = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from("hello", "utf16le")]);
    writeFileSync(utf16Path, utf16Bytes);
    const utf16Read = await call(read, { path: "utf16.txt" });
    expect(utf16Read.isError).toBe(true);
    expect(utf16Read.text).toContain(`${utf16Bytes.length} bytes`);
    expect(utf16Read.text).toContain("UTF-16");
  });

  it("rejects images larger than 4.5MB and huge text files before full readFileSync", async () => {
    const bigPng = join(cwd, "huge.png");
    writeFileSync(bigPng, Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    const overImageSize = MAX_IMAGE_BYTES + 1;
    truncateSync(bigPng, overImageSize);

    const imgOutput = await read.execute({ path: "huge.png" }, env());
    expect(imgOutput.isError).toBe(true);
    expect(imgOutput.content.some((block) => block.type === "image")).toBe(false);
    const imgText = imgOutput.content.map((block) => (block.type === "text" ? block.text : "")).join("");
    expect(imgText).toContain(`${overImageSize} bytes`);
    expect(imgText).toContain("4.5 MB");

    const bigTxt = join(cwd, "huge.log");
    writeFileSync(bigTxt, "");
    const overTextSize = MAX_TEXT_READ_BYTES + 1;
    truncateSync(bigTxt, overTextSize);

    const txtRes = await call(read, { path: "huge.log" });
    expect(txtRes.isError).toBe(true);
    expect(txtRes.text).toContain(`${overTextSize} bytes`);
    expect(txtRes.text).toContain("32 MB");
  });
});

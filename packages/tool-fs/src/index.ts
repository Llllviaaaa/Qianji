/**
 * Built-in file tools: read, write, edit, ls, find, grep, and deferred diagnostics.
 * Paths resolve against the session's cwd; output is capped so one call cannot
 * flood the context. Permission checks run in `tools/pre-execute` listeners.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, extname } from "node:path";
import type { Context } from "@deepseek-ai/cordis";
import { textOutput, type ToolDefinition, type ToolOutput } from "@qianji/tools";
import { diagnostics } from "./diagnostics.ts";
import { formatHashlines, isHashlineEdit, resolveHashlineSpan, type HashlineEdit, type TextEditSpan } from "./hashline.ts";
import { find, grep } from "./search.ts";
import { MAX_BYTES, MAX_LINES, resolvePath, truncateHead } from "./shared.ts";

export * from "./shared.ts";
export * from "./hashline.ts";
export * from "./search.ts";
export * from "./diagnostics.ts";

export const name = "qianji-tool-fs";
export const inject = ["tools"];

const IMAGE_TYPES: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
};

const MAX_ENTRIES = 500;

export const read: ToolDefinition<{ path: string; offset?: number; limit?: number; hashlines?: boolean }> = {
  name: "read",
  description: `Read a file. Text is returned from line \`offset\` (1-based) for at most \`limit\` lines, capped at ${MAX_LINES} lines or ${MAX_BYTES / 1024} KB; pass \`hashlines: true\` to prefix lines with \`line:hash|\` anchors for resilient \`edit\`. Images (png, jpg, gif, webp) return as image blocks.`,
  parameters: {
    type: "object",
    properties: {
      path: { type: "string", description: "File path, relative to the working directory or absolute" },
      offset: { type: "integer", description: "First line to read, 1-based" },
      limit: { type: "integer", description: "Maximum number of lines" },
      hashlines: { type: "boolean", description: "Prefix each line with `<line>:<hash>| ` for anchor-based editing" },
    },
    required: ["path"],
  },
  execute({ path, offset, limit, hashlines }, env) {
    const file = resolvePath(env.cwd, path);
    const mimeType = IMAGE_TYPES[extname(file).toLowerCase()];
    if (mimeType !== undefined) {
      return { content: [{ type: "text", text: `Image ${path}:` }, { type: "image", mimeType, data: readFileSync(file).toString("base64") }] };
    }
    const lines = readFileSync(file, "utf8").split("\n");
    const start = Math.max(1, offset ?? 1);
    if (start > lines.length) return textOutput(`${path} has ${lines.length} lines; offset ${start} is past the end.`, true);
    const wanted = lines.slice(start - 1, limit === undefined ? undefined : start - 1 + Math.max(1, limit));
    const displayLines = hashlines === true ? formatHashlines(wanted, start) : wanted;
    const { text, truncated } = truncateHead(displayLines.join("\n"));
    const shown = text === "" ? 0 : text.split("\n").length;
    const end = start + shown - 1;
    const more = end < lines.length;
    const note = truncated || more ? `\n\n[Lines ${start}-${end} of ${lines.length}. Use offset=${end + 1} to read more.]` : "";
    return textOutput(text + note);
  },
};

export const write: ToolDefinition<{ path: string; content: string }> = {
  name: "write",
  description: "Create or overwrite a file with `content`, creating parent directories as needed.",
  parameters: {
    type: "object",
    properties: {
      path: { type: "string", description: "File path, relative to the working directory or absolute" },
      content: { type: "string", description: "The complete new file content" },
    },
    required: ["path", "content"],
  },
  execute({ path, content }, env) {
    const file = resolvePath(env.cwd, path);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, content);
    return textOutput(`Wrote ${Buffer.byteLength(content)} bytes to ${path}.`);
  },
};

export interface Edit {
  oldText: string;
  newText: string;
}

export type FileEdit = Edit | HashlineEdit;

export interface EditApplyNotes {
  fuzzy?: number[];
  relocated?: number[];
}

/** Characters models swap for one another; each group matches any of its members. */
const LOOKALIKES = [
  "'\u2018\u2019\u201A\u201B",
  "\"\u201C\u201D\u201E\u201F",
  "-\u2010\u2011\u2012\u2013\u2014\u2015\u2212",
  " \u00A0\u2002\u2003\u2004\u2005\u2006\u2007\u2008\u2009\u200A\u202F\u205F\u3000",
] as const;
const TRAILING_SPACE = /[ \t\u00A0\u2002-\u200A\u202F\u205F\u3000]+$/;
const escapeRegExp = (text: string) => text.replace(/[.*+?^${}()|[\]\\-]/g, "\\$&");

function charPattern(char: string): string {
  const group = LOOKALIKES.find((members) => members.includes(char));
  return group === undefined ? escapeRegExp(char) : `[${escapeRegExp(group)}]`;
}

/**
 * A pattern for `text` that tolerates the differences models introduce when
 * they retype code: curly or straight quotes, Unicode dashes and spaces,
 * trailing whitespace at line ends, and CRLF or LF. Indentation and every
 * other character must still match exactly.
 */
export function tolerantPattern(text: string): RegExp {
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  const body = lines.map((line) => [...line.replace(TRAILING_SPACE, "")].map(charPattern).join("")).join("[ \\t\\u00A0\\u3000]*\\r?\\n");
  return new RegExp(body, "g");
}

function resolveTextEditSpan(
  original: string,
  edit: Edit,
  index: number,
  toFile: (text: string) => string,
  fuzzy?: number[],
): TextEditSpan {
  const oldText = toFile(edit.oldText);
  if (oldText === "") throw new Error(`edits[${index}].oldText is empty`);
  let start = original.indexOf(oldText);
  let end = start + oldText.length;
  if (start >= 0 && original.indexOf(oldText, start + 1) >= 0) {
    throw new Error(`edits[${index}].oldText occurs more than once; include more surrounding lines`);
  }
  if (start < 0) {
    const matches = edit.oldText.trim() === "" ? [] : [...original.matchAll(tolerantPattern(edit.oldText))];
    if (matches.length > 1) throw new Error(`edits[${index}].oldText occurs more than once; include more surrounding lines`);
    const match = matches[0];
    if (match === undefined) throw new Error(`edits[${index}].oldText was not found; read the file and copy the text exactly`);
    start = match.index;
    end = start + match[0].length;
    fuzzy?.push(index);
  }
  return { start, end, text: toFile(edit.newText), index };
}

/**
 * Apply unique text replacements or Hashline anchor edits atomically; throws
 * with an actionable reason on mismatch or overlap.
 */
export function applyEdits(original: string, edits: readonly FileEdit[], notes?: number[] | EditApplyNotes): string {
  const crlf = original.includes("\r\n");
  const toFile = (text: string) => (crlf && !text.includes("\r\n") ? text.replace(/\n/g, "\r\n") : text);
  const fuzzy = Array.isArray(notes) ? notes : notes?.fuzzy;
  const relocated = Array.isArray(notes) ? undefined : notes?.relocated;
  const spans: TextEditSpan[] = edits.map((item, index) => (
    isHashlineEdit(item)
      ? resolveHashlineSpan(original, item, index, relocated)
      : resolveTextEditSpan(original, item, index, toFile, fuzzy)
  ));

  spans.sort((a, b) => a.start - b.start || a.index - b.index);
  for (let index = 1; index < spans.length; index += 1) {
    const previous = spans[index - 1];
    const current = spans[index];
    if (previous !== undefined && current !== undefined && current.start < previous.end) {
      throw new Error(`edits[${previous.index}] and edits[${current.index}] overlap`);
    }
  }
  let result = "";
  let cursor = 0;
  for (const span of spans) {
    result += original.slice(cursor, span.start) + span.text;
    cursor = span.end;
  }
  return result + original.slice(cursor);
}

function buildEditDiff(original: string, updated: string, path: string): string {
  if (original === updated) return "";
  const oldLines = original.replace(/\r\n/g, "\n").split("\n");
  const newLines = updated.replace(/\r\n/g, "\n").split("\n");
  let prefix = 0;
  while (prefix < oldLines.length && prefix < newLines.length && oldLines[prefix] === newLines[prefix]) prefix += 1;
  let suffix = 0;
  while (
    suffix < oldLines.length - prefix
    && suffix < newLines.length - prefix
    && oldLines[oldLines.length - 1 - suffix] === newLines[newLines.length - 1 - suffix]
  ) {
    suffix += 1;
  }
  const delLines = oldLines.slice(prefix, oldLines.length - suffix);
  const addLines = newLines.slice(prefix, newLines.length - suffix);
  const header = `--- a/${path}\n+++ b/${path}\n@@ -${prefix + 1},${delLines.length} +${prefix + 1},${addLines.length} @@`;
  const body = [
    ...delLines.slice(0, 60).map((line) => `-${line}`),
    ...addLines.slice(0, 60).map((line) => `+${line}`),
  ];
  return [header, ...body].join("\n");
}

export const edit: ToolDefinition<{ path: string; edits: FileEdit[] }> = {
  name: "edit",
  description: [
    "Edit a file atomically: each item in `edits` can either use exact `{ oldText, newText }`",
    "or Hashline `{ anchor, endAnchor?, op?, newText? }` returned by `read(..., { hashlines: true })`.",
    "All edits apply together or none do.",
  ].join(" "),
  parameters: {
    type: "object",
    properties: {
      path: { type: "string", description: "File path, relative to the working directory or absolute" },
      edits: {
        type: "array",
        description: "Exact text replacements or Hashline anchor operations",
        items: {
          type: "object",
          properties: {
            oldText: { type: "string", description: "Exact text to replace (for text mode)" },
            newText: { type: "string", description: "Replacement or inserted text" },
            anchor: { type: "string", description: "Start `<line>:<hash>` anchor (for hashline mode)" },
            endAnchor: { type: "string", description: "Optional inclusive end `<line>:<hash>` anchor for replace/delete" },
            op: { type: "string", enum: ["replace", "insert_after", "insert_before", "delete"] },
          },
        },
      },
    },
    required: ["path", "edits"],
  },
  execute({ path, edits }, env): ToolOutput {
    const file = resolvePath(env.cwd, path);
    if (!existsSync(file)) return textOutput(`${path} does not exist; use write to create it.`, true);
    for (const item of edits) {
      if (isHashlineEdit(item)) {
        if (item.op !== "delete" && typeof item.newText !== "string") {
          return textOutput("Hashline edits require newText unless op is 'delete'.", true);
        }
      } else if (typeof item?.oldText !== "string" || typeof item?.newText !== "string") {
        return textOutput("Each edit needs oldText and newText strings, or a hashline anchor.", true);
      }
    }
    const original = readFileSync(file, "utf8");
    const fuzzy: number[] = [];
    const relocated: number[] = [];
    let updated: string;
    try {
      updated = applyEdits(original, edits, { fuzzy, relocated });
    } catch (error) {
      return textOutput(`No changes made to ${path}: ${(error as Error).message}.`, true);
    }
    writeFileSync(file, updated);
    const notes: string[] = [];
    if (relocated.length > 0) {
      notes.push(`${relocated.map((i) => `edits[${i}]`).join(", ")} relocated by line content hash after line shift.`);
    }
    if (fuzzy.length > 0) {
      notes.push(`${fuzzy.map((i) => `edits[${i}]`).join(", ")} matched only after ignoring differences in quotes, dashes, spaces or trailing whitespace.`);
    }
    const suffix = notes.length === 0 ? "" : ` ${notes.join(" ")}`;
    const diff = buildEditDiff(original, updated, path);
    return {
      content: [{ type: "text", text: `Applied ${edits.length} edit(s) to ${path}.${suffix}` }],
      ...(diff === "" ? {} : { details: { diff } }),
    };
  },
};

export const ls: ToolDefinition<{ path?: string }> = {
  name: "ls",
  description: `List a directory (default: the working directory). Directories end with "/". At most ${MAX_ENTRIES} entries.`,
  parameters: {
    type: "object",
    properties: { path: { type: "string", description: "Directory path" } },
  },
  execute({ path }, env) {
    const dir = resolvePath(env.cwd, path ?? ".");
    const entries = readdirSync(dir, { withFileTypes: true })
      .map((entry) => (entry.isDirectory() ? `${entry.name}/` : entry.name))
      .sort((a, b) => a.localeCompare(b));
    if (entries.length === 0) return textOutput("(empty directory)");
    const note = entries.length > MAX_ENTRIES ? `\n[${entries.length - MAX_ENTRIES} more entries not shown]` : "";
    return textOutput(entries.slice(0, MAX_ENTRIES).join("\n") + note);
  },
};

export const FS_TOOLS = [read, write, edit, ls, find, grep] as const;

export function apply(ctx: Context): void {
  for (const tool of FS_TOOLS) ctx.effect(() => ctx.tools.register(tool), `${name}: ${tool.name}`);
  ctx.effect(() => ctx.tools.register(diagnostics), `${name}: diagnostics`);
}

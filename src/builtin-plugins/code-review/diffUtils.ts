/**
 * Pure unified-diff parser and inline review comment helpers for `code-review` (ADR 0023).
 */
import type { UiMessage } from "@qianji/client";

export const OVERSIZED_DIFF_THRESHOLD = 800;

export interface ParsedDiffRow {
  readonly kind: "context" | "add" | "del" | "meta";
  readonly oldLine?: number;
  readonly newLine?: number;
  readonly text: string;
}

export interface ParsedDiffHunk {
  readonly header: string;
  readonly rows: readonly ParsedDiffRow[];
}

export interface ParsedDiffFile {
  readonly path: string;
  readonly oldPath: string;
  readonly newPath: string;
  readonly binary: boolean;
  readonly hunks: readonly ParsedDiffHunk[];
  readonly added: number;
  readonly deleted: number;
  readonly totalRows: number;
}

export interface AiCodeReviewComment {
  readonly id: string;
  readonly title: string;
  readonly body: string;
  readonly file: string;
  readonly start: number | null;
  readonly end: number | null;
  readonly priority: number | null;
}

export interface LocalDraftComment {
  readonly id: string;
  readonly file: string;
  readonly line: number;
  readonly side: "new" | "old";
  readonly lineText: string;
  readonly body: string;
}

function stripGitPrefix(raw: string): string {
  const clean = raw.replace(/\t$/, "").trim().replace(/^"|"$/g, "");
  if (clean === "/dev/null") return clean;
  if (clean.startsWith("a/") || clean.startsWith("b/")) return clean.slice(2);
  return clean;
}

export function normalizeReviewPath(path: string): string {
  return path.trim().replace(/\\/g, "/").replace(/^\.\//, "").toLowerCase();
}

export function matchesReviewPath(left: string, right: string): boolean {
  const a = normalizeReviewPath(left);
  const b = normalizeReviewPath(right);
  if (a === "" || b === "") return false;
  return a === b || a.endsWith(`/${b}`) || b.endsWith(`/${a}`);
}

export function parseUnifiedDiff(diffText: string): ParsedDiffFile[] {
  if (diffText.trim() === "") return [];
  const files: Array<{
    oldPath: string;
    newPath: string;
    binary: boolean;
    hunks: Array<{ header: string; rows: ParsedDiffRow[] }>;
  }> = [];

  let current: (typeof files)[number] | null = null;
  let currentHunk: { header: string; rows: ParsedDiffRow[] } | null = null;
  let oldNum = 0;
  let newNum = 0;

  for (const raw of diffText.split("\n")) {
    if (raw.startsWith("diff --git ")) {
      currentHunk = null;
      const body = raw.slice("diff --git ".length);
      const splitIdx = body.indexOf(" b/");
      const oldPath = splitIdx >= 0 ? stripGitPrefix(body.slice(0, splitIdx)) : "";
      const newPath = splitIdx >= 0 ? stripGitPrefix(body.slice(splitIdx + 1)) : "";
      current = { oldPath, newPath, binary: false, hunks: [] };
      files.push(current);
      continue;
    }
    if (current === null) continue;
    if (raw.startsWith("Binary files ") || raw === "GIT binary patch") {
      current.binary = true;
      currentHunk = null;
      continue;
    }
    if (currentHunk === null && raw.startsWith("--- ")) {
      current.oldPath = stripGitPrefix(raw.slice(4));
      continue;
    }
    if (currentHunk === null && raw.startsWith("+++ ")) {
      current.newPath = stripGitPrefix(raw.slice(4));
      continue;
    }
    const hunkMatch = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@(.*)$/.exec(raw);
    if (hunkMatch !== null) {
      oldNum = Number(hunkMatch[1] ?? 0);
      newNum = Number(hunkMatch[2] ?? 0);
      currentHunk = { header: hunkMatch[3] ?? "", rows: [] };
      current.hunks.push(currentHunk);
      continue;
    }
    if (currentHunk === null) continue;
    const prefix = raw[0];
    if (prefix === "\\") {
      currentHunk.rows.push({ kind: "meta", text: raw.slice(1) });
    } else if (prefix === "+") {
      currentHunk.rows.push({ kind: "add", newLine: newNum, text: raw.slice(1) });
      newNum += 1;
    } else if (prefix === "-") {
      currentHunk.rows.push({ kind: "del", oldLine: oldNum, text: raw.slice(1) });
      oldNum += 1;
    } else if (prefix === " ") {
      currentHunk.rows.push({ kind: "context", oldLine: oldNum, newLine: newNum, text: raw.slice(1) });
      oldNum += 1;
      newNum += 1;
    }
  }

  return files.map((file) => {
    let added = 0;
    let deleted = 0;
    let totalRows = 0;
    for (const hunk of file.hunks) {
      for (const row of hunk.rows) {
        totalRows += 1;
        if (row.kind === "add") added += 1;
        else if (row.kind === "del") deleted += 1;
      }
    }
    const path = file.newPath !== "" && file.newPath !== "/dev/null" ? file.newPath : file.oldPath;
    return {
      path,
      oldPath: file.oldPath,
      newPath: file.newPath,
      binary: file.binary,
      hunks: file.hunks,
      added,
      deleted,
      totalRows,
    };
  });
}

const DIRECTIVE_RE = /::code-comment\{([^}\n]*)\}/g;
const ATTR_RE = /([A-Za-z][\w-]*)=(?:"((?:\\.|[^"\\])*)"|'((?:\\.|[^'\\])*)'|([^\s]+))/g;

function parseAttrs(source: string): Record<string, string> {
  const attrs: Record<string, string> = {};
  ATTR_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = ATTR_RE.exec(source)) !== null) {
    const key = m[1];
    if (key === undefined) continue;
    const val = (m[2] ?? m[3] ?? m[4] ?? "").replace(/\\([\\"'])/g, "$1").replace(/\\n/g, "\n");
    attrs[key] = val;
  }
  return attrs;
}

export function deriveAiReviewComments(messages: readonly UiMessage[]): AiCodeReviewComment[] {
  const comments: AiCodeReviewComment[] = [];
  for (const msg of messages) {
    if (msg.role !== "assistant" || !msg.content.includes("::code-comment{")) continue;
    DIRECTIVE_RE.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = DIRECTIVE_RE.exec(msg.content)) !== null) {
      const attrs = parseAttrs(match[1] ?? "");
      if (!attrs.title || !attrs.body || !attrs.file) continue;
      const startParsed = attrs.start !== undefined ? Number.parseInt(attrs.start, 10) : Number.NaN;
      const endParsed = attrs.end !== undefined ? Number.parseInt(attrs.end, 10) : Number.NaN;
      const prioParsed = attrs.priority !== undefined ? Number.parseInt(attrs.priority, 10) : Number.NaN;
      const start = Number.isFinite(startParsed) && startParsed > 0 ? startParsed : null;
      const end = Number.isFinite(endParsed) && endParsed > 0 ? endParsed : start;
      comments.push({
        id: `${msg.id}:${match.index}`,
        title: attrs.title,
        body: attrs.body,
        file: attrs.file,
        start,
        end,
        priority: Number.isFinite(prioParsed) ? prioParsed : null,
      });
    }
  }
  return comments;
}

export function deriveSessionEditedPaths(messages: readonly UiMessage[]): ReadonlySet<string> {
  const paths = new Set<string>();
  for (const msg of messages) {
    for (const call of msg.toolCalls ?? []) {
      if (call.isError === true) continue;
      const name = call.name.toLowerCase();
      if (name !== "write" && !name.includes("write_file") && name !== "edit" && name !== "apply_patch" && !name.includes("edit_file")) {
        continue;
      }
      for (const key of ["path", "file", "filename", "filePath", "target"]) {
        const val = call.args[key];
        if (typeof val === "string" && val.trim() !== "") {
          paths.add(normalizeReviewPath(val));
          break;
        }
      }
    }
  }
  return paths;
}

export function formatDraftCommentsPrompt(comments: readonly LocalDraftComment[]): string {
  if (comments.length === 0) return "";
  const lines: string[] = [`请根据以下 ${comments.length} 条代码审查行内批注进行修改：`, ""];
  comments.forEach((item, index) => {
    const loc = item.side === "old" ? `${item.file} (旧行 ${item.line})` : `${item.file}:${item.line}`;
    lines.push(`${index + 1}. **${loc}**`);
    const snippet = item.lineText.trim();
    if (snippet !== "") lines.push(`   > \`${snippet.slice(0, 140)}\``);
    lines.push(`   - 修改意见：${item.body.trim()}`);
  });
  lines.push("", "请逐项应用上述修改，并简要说明改动内容。");
  return lines.join("\n");
}

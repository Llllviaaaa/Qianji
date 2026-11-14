/**
 * Content-hash anchored file reading and editing (Oh-My-Pi Hashline pattern).
 * Each line is identified by `<1-based-line>:<3-hex-fnv1a>`, allowing resilient
 * edits with ±20-line unique drift relocation and actionable mismatch errors.
 */

export type HashlineOp = "replace" | "insert_after" | "insert_before" | "delete";

export interface HashlineEdit {
  anchor: string;
  endAnchor?: string;
  op?: HashlineOp;
  newText?: string;
}

export interface TextEditSpan {
  start: number;
  end: number;
  text: string;
  index: number;
}

interface IndexedLine {
  lineNo: number;
  text: string;
  start: number;
  end: number;
  eol: string;
}

const DRIFT_WINDOW = 20;
const ANCHOR_RE = /^#?(\d+):([0-9a-f]{3})(?:\|.*)?$/i;

/** Deterministic 3-hex-char FNV-1a hash of a line ignoring trailing `\r` and horizontal whitespace. */
export function lineHash(line: string): string {
  const cleaned = line.replace(/\r$/, "").replace(/[ \t]+$/, "");
  let hash = 0x811c9dc5;
  const bytes = Buffer.from(cleaned, "utf8");
  for (const byte of bytes) {
    hash ^= byte;
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return (hash & 0xfff).toString(16).padStart(3, "0");
}

/** Prefix lines with `<lineNo>:<hash>| ` starting at 1-based `startLine`. */
export function formatHashlines(lines: readonly string[], startLine = 1): string[] {
  return lines.map((raw, idx) => {
    const clean = raw.replace(/\r$/, "");
    return `${startLine + idx}:${lineHash(clean)}| ${clean}`;
  });
}

export function isHashlineEdit(edit: unknown): edit is HashlineEdit {
  return typeof edit === "object" && edit !== null && typeof (edit as HashlineEdit).anchor === "string";
}

function indexLines(text: string): IndexedLine[] {
  const lines: IndexedLine[] = [];
  let start = 0;
  let lineNo = 1;
  while (start <= text.length) {
    const lf = text.indexOf("\n", start);
    if (lf < 0) {
      const hasCr = text.endsWith("\r");
      const raw = text.slice(start);
      const clean = hasCr ? raw.slice(0, -1) : raw;
      lines.push({ lineNo, text: clean, start, end: text.length, eol: "" });
      break;
    }
    const hasCr = lf > start && text[lf - 1] === "\r";
    const end = hasCr ? lf - 1 : lf;
    lines.push({
      lineNo,
      text: text.slice(start, end),
      start,
      end,
      eol: hasCr ? "\r\n" : "\n",
    });
    start = lf + 1;
    lineNo += 1;
  }
  return lines;
}

export function parseAnchor(raw: string, label: string): { line: number; hash: string } {
  const match = raw.trim().match(ANCHOR_RE);
  if (!match) {
    throw new Error(`${label} "${raw}" is invalid; expected "<line>:<3-hex-hash>" from read(..., { hashlines: true })`);
  }
  const line = Number.parseInt(match[1] ?? "", 10);
  if (!Number.isInteger(line) || line < 1) {
    throw new Error(`${label} line number in "${raw}" must be >= 1`);
  }
  return { line, hash: (match[2] ?? "").toLowerCase() };
}

function nearbySnippet(lines: readonly IndexedLine[], centerLine: number): string {
  const from = Math.max(1, centerLine - 3);
  const to = Math.min(lines.length, centerLine + 3);
  const subset = lines.slice(from - 1, to).map((entry) => entry.text);
  return formatHashlines(subset, from).join("\n");
}

function matchingLinesNear(lines: readonly IndexedLine[], targetLine: number, hash: string): number[] {
  const from = Math.max(1, targetLine - DRIFT_WINDOW);
  const to = Math.min(lines.length, targetLine + DRIFT_WINDOW);
  const matches: number[] = [];
  for (let lineNo = from; lineNo <= to; lineNo += 1) {
    const candidate = lines[lineNo - 1];
    if (candidate !== undefined && lineHash(candidate.text) === hash) {
      matches.push(lineNo);
    }
  }
  return matches;
}

function resolveLineRange(
  lines: readonly IndexedLine[],
  edit: HashlineEdit,
  index: number,
  relocated?: number[],
): { startLine: number; endLine: number } {
  const start = parseAnchor(edit.anchor, `edits[${index}].anchor`);
  const end = edit.endAnchor === undefined ? undefined : parseAnchor(edit.endAnchor, `edits[${index}].endAnchor`);

  const hashAt = (lineNo: number): string | undefined => {
    const entry = lines[lineNo - 1];
    return entry === undefined ? undefined : lineHash(entry.text);
  };

  if (end === undefined) {
    if (hashAt(start.line) === start.hash) return { startLine: start.line, endLine: start.line };
    const candidates = matchingLinesNear(lines, start.line, start.hash);
    if (candidates.length === 1 && candidates[0] !== undefined) {
      relocated?.push(index);
      return { startLine: candidates[0], endLine: candidates[0] };
    }
    const hint = candidates.length > 1
      ? `matches multiple nearby lines (${candidates.join(", ")})`
      : "was not found within ±20 lines";
    throw new Error(
      `edits[${index}].anchor "${edit.anchor}" ${hint}.\nCurrent lines near line ${start.line}:\n${nearbySnippet(lines, start.line)}`,
    );
  }

  if (end.line < start.line) {
    throw new Error(`edits[${index}].endAnchor (${end.line}) precedes anchor (${start.line})`);
  }
  if (hashAt(start.line) === start.hash && hashAt(end.line) === end.hash) {
    return { startLine: start.line, endLine: end.line };
  }

  const startCandidates = hashAt(start.line) === start.hash ? [start.line] : matchingLinesNear(lines, start.line, start.hash);
  const endCandidates = hashAt(end.line) === end.hash ? [end.line] : matchingLinesNear(lines, end.line, end.hash);
  const expectedSpan = end.line - start.line;
  const pairs: Array<{ startLine: number; endLine: number; spanDiff: number }> = [];
  for (const s of startCandidates) {
    for (const e of endCandidates) {
      if (e >= s) pairs.push({ startLine: s, endLine: e, spanDiff: Math.abs((e - s) - expectedSpan) });
    }
  }
  const exactSpanPairs = pairs.filter((pair) => pair.spanDiff === 0);
  const chosen = exactSpanPairs.length === 1 ? exactSpanPairs[0] : pairs.length === 1 ? pairs[0] : undefined;
  if (chosen !== undefined) {
    relocated?.push(index);
    return { startLine: chosen.startLine, endLine: chosen.endLine };
  }
  const center = hashAt(start.line) !== start.hash ? start.line : end.line;
  throw new Error(
    `edits[${index}] range "${edit.anchor}".."${edit.endAnchor}" could not be resolved uniquely.\nCurrent lines near line ${center}:\n${nearbySnippet(lines, center)}`,
  );
}

/** Resolve one HashlineEdit into an exact character replacement span on `original`. */
export function resolveHashlineSpan(
  original: string,
  edit: HashlineEdit,
  index: number,
  relocated?: number[],
): TextEditSpan {
  const op: HashlineOp = edit.op ?? "replace";
  if (op !== "replace" && op !== "insert_after" && op !== "insert_before" && op !== "delete") {
    throw new Error(`edits[${index}].op "${String(edit.op)}" must be replace, insert_after, insert_before, or delete`);
  }
  if (op !== "delete" && typeof edit.newText !== "string") {
    throw new Error(`edits[${index}].newText string is required for op="${op}"`);
  }
  if (edit.endAnchor !== undefined && (op === "insert_after" || op === "insert_before")) {
    throw new Error(`edits[${index}].endAnchor cannot be used with op="${op}"`);
  }

  const lines = indexLines(original);
  const { startLine, endLine } = resolveLineRange(lines, edit, index, relocated);
  const first = lines[startLine - 1];
  const last = lines[endLine - 1];
  if (first === undefined || last === undefined) {
    throw new Error(`edits[${index}] line range out of bounds`);
  }

  const fileEol = original.includes("\r\n") ? "\r\n" : "\n";
  const normalizeText = (raw: string): string => {
    const lf = raw.replace(/\r\n/g, "\n");
    return fileEol === "\r\n" ? lf.replace(/\n/g, "\r\n") : lf;
  };

  if (op === "replace") {
    return { start: first.start, end: last.end, text: normalizeText(edit.newText ?? ""), index };
  }
  if (op === "delete") {
    if (last.eol !== "") {
      return { start: first.start, end: last.end + last.eol.length, text: "", index };
    }
    if (startLine > 1) {
      const prev = lines[startLine - 2];
      if (prev !== undefined) return { start: prev.end, end: last.end, text: "", index };
    }
    return { start: 0, end: original.length, text: "", index };
  }

  const body = normalizeText(edit.newText ?? "");
  if (op === "insert_before") {
    const withEol = body.endsWith("\n") ? body : `${body}${fileEol}`;
    return { start: first.start, end: first.start, text: withEol, index };
  }
  if (first.eol !== "") {
    const pos = first.end + first.eol.length;
    const withEol = body.endsWith("\n") ? body : `${body}${fileEol}`;
    return { start: pos, end: pos, text: withEol, index };
  }
  return { start: first.end, end: first.end, text: `${fileEol}${body}`, index };
}

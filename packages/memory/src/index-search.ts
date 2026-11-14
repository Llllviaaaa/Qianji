export const DEFAULT_MEMORY_INLINE_MAX_CHARS = 4_000;

export interface MemorySection {
  heading: string;
  level: number;
  startLine: number;
  endLine: number;
  charCount: number;
  preview: string;
}

const HEADING_RE = /^(#{1,3})\s+(.+?)\s*#*\s*$/;
const FENCE_RE = /^ {0,3}(`{3,}|~{3,})/;

function splitLines(markdown: string): string[] {
  const normalized = markdown.replace(/\r\n/g, "\n");
  if (normalized === "") return [];
  const lines = normalized.split("\n");
  if (lines.at(-1) === "") lines.pop();
  return lines;
}

function normalizeHeadingKey(raw: string): string {
  return raw.trim().replace(/^#{1,6}\s+/, "").trim().toLowerCase();
}

function clipPreview(text: string, maxLen = 80): string {
  const compact = text.replace(/\s+/g, " ").trim();
  if (compact.length <= maxLen) return compact;
  return `${compact.slice(0, maxLen)}…`;
}

export function parseMemorySections(markdown: string): MemorySection[] {
  const lines = splitLines(markdown);
  if (lines.length === 0) return [];

  const boundaries: Array<{ lineIndex: number; heading: string; level: number }> = [];
  let activeFenceChar: "`" | "~" | undefined;
  let activeFenceLen = 0;

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i] ?? "";
    const fenceMatch = FENCE_RE.exec(line);
    if (fenceMatch !== null) {
      const marker = fenceMatch[1] ?? "";
      const markerChar = marker[0] as "`" | "~";
      if (activeFenceChar === undefined) {
        activeFenceChar = markerChar;
        activeFenceLen = marker.length;
      } else if (activeFenceChar === markerChar && marker.length >= activeFenceLen && line.trim().length === marker.length) {
        activeFenceChar = undefined;
        activeFenceLen = 0;
      }
      continue;
    }
    if (activeFenceChar !== undefined) continue;

    const match = HEADING_RE.exec(line);
    if (match !== null) {
      const hashes = match[1] ?? "##";
      const title = (match[2] ?? "").trim();
      boundaries.push({ lineIndex: i, heading: title, level: hashes.length });
    }
  }

  const sections: MemorySection[] = [];
  const buildSection = (heading: string, level: number, startIdx: number, endIdx: number, bodyStartIdx: number): MemorySection => {
    const slice = lines.slice(startIdx, endIdx + 1);
    const charCount = slice.join("\n").length;
    let preview = "";
    for (let k = bodyStartIdx; k <= endIdx; k += 1) {
      const candidate = (lines[k] ?? "").trim();
      if (candidate !== "") {
        preview = clipPreview(candidate);
        break;
      }
    }
    return { heading, level, startLine: startIdx + 1, endLine: endIdx + 1, charCount, preview };
  };

  if (boundaries.length === 0) {
    return [buildSection("(Preamble)", 0, 0, lines.length - 1, 0)];
  }

  const first = boundaries[0];
  if (first !== undefined && first.lineIndex > 0) {
    const preSlice = lines.slice(0, first.lineIndex);
    if (preSlice.some((line) => line.trim() !== "")) {
      sections.push(buildSection("(Preamble)", 0, 0, first.lineIndex - 1, 0));
    }
  }

  for (let i = 0; i < boundaries.length; i += 1) {
    const current = boundaries[i];
    if (current === undefined) continue;
    const next = boundaries[i + 1];
    const endIdx = next === undefined ? lines.length - 1 : next.lineIndex - 1;
    sections.push(buildSection(current.heading, current.level, current.lineIndex, endIdx, current.lineIndex + 1));
  }

  return sections;
}

export function formatMemoryDirectory(markdown: string, scope: "user" | "project"): string {
  const sections = parseMemorySections(markdown);
  const lines = [
    `[Indexed ${scope} memory: ${markdown.length} chars across ${sections.length} section(s). Only this directory is preloaded to save context.]`,
    ...sections.map((section) => {
      const tail = section.preview === "" ? "" : ` — ${section.preview}`;
      return `- ${section.heading} (lines ${section.startLine}-${section.endLine}, ${section.charCount} chars)${tail}`;
    }),
    `Use \`desktop_memory(action: "search", scope: "${scope}", query: "...")\` or \`desktop_memory(action: "read", scope: "${scope}", section: "...")\` (or \`offset\`/\`limit\`) to inspect details on demand, and \`upsert_section\` to update a single section.`,
  ];
  return lines.join("\n");
}

export function searchMemory(markdown: string, query: string, limit = 10): string {
  const q = query.trim();
  if (q === "") throw new Error("query is required for search");
  const lines = splitLines(markdown);
  if (lines.length === 0) return `No matches found for "${q}" (memory is empty).`;

  const sections = parseMemorySections(markdown);
  const lowerQuery = q.toLowerCase();
  const terms = lowerQuery.split(/\s+/).filter(Boolean);
  const clampedLimit = Math.min(Math.max(1, Math.floor(limit)), 50);

  interface Hit {
    section: string;
    line: number;
    text: string;
    score: number;
  }
  const hits: Hit[] = [];

  for (const sec of sections) {
    const headingLower = sec.heading.toLowerCase();
    const headingBonus = (headingLower.includes(lowerQuery) ? 5 : 0)
      + terms.filter((t) => headingLower.includes(t)).length * 2;
    let lineHitsInSection = 0;

    for (let lineNum = sec.startLine; lineNum <= sec.endLine; lineNum += 1) {
      const lineText = lines[lineNum - 1] ?? "";
      const lowerLine = lineText.toLowerCase();
      let score = 0;
      if (lowerLine.includes(lowerQuery)) score += 6;
      for (const term of terms) {
        if (lowerLine.includes(term)) score += 2;
      }
      if (score > 0) {
        lineHitsInSection += 1;
        hits.push({
          section: sec.heading,
          line: lineNum,
          text: clipPreview(lineText, 160),
          score: score + headingBonus,
        });
      }
    }

    if (headingBonus > 0 && lineHitsInSection === 0) {
      hits.push({
        section: sec.heading,
        line: sec.startLine,
        text: clipPreview(lines[sec.startLine - 1] ?? sec.heading, 160),
        score: headingBonus,
      });
    }
  }

  if (hits.length === 0) return `No matches found for "${q}".`;
  hits.sort((a, b) => (b.score !== a.score ? b.score - a.score : a.line - b.line));
  const shown = hits.slice(0, clampedLimit);
  return [
    `Matches for "${q}" (${shown.length} of ${hits.length}):`,
    ...shown.map((hit) => `- [${hit.section} | L${hit.line}] ${hit.text}`),
  ].join("\n");
}

export function readMemorySlice(
  markdown: string,
  options: { section?: string; offset?: number; limit?: number },
): string {
  const lines = splitLines(markdown);
  if (options.section === undefined && options.offset === undefined && options.limit === undefined) {
    return markdown;
  }

  if (options.section !== undefined && options.section.trim() !== "") {
    const sections = parseMemorySections(markdown);
    const key = normalizeHeadingKey(options.section);
    const matched = sections.find((s) => normalizeHeadingKey(s.heading) === key)
      ?? sections.find((s) => normalizeHeadingKey(s.heading).includes(key));
    if (matched === undefined) {
      const available = sections.map((s) => s.heading).join(", ") || "(none)";
      return `Section "${options.section}" not found. Available sections: ${available}.`;
    }
    const header = `[section: ${matched.heading} | lines ${matched.startLine}-${matched.endLine} of ${lines.length}]`;
    const numbered = lines
      .slice(matched.startLine - 1, matched.endLine)
      .map((line, idx) => `${matched.startLine + idx}: ${line}`);
    return [header, ...numbered].join("\n");
  }

  if (lines.length === 0) return "";
  const start = Math.min(Math.max(1, Math.floor(options.offset ?? 1)), lines.length);
  const count = Math.min(Math.max(1, Math.floor(options.limit ?? 100)), 500);
  const end = Math.min(lines.length, start + count - 1);
  const header = `[lines ${start}-${end} of ${lines.length}]`;
  const numbered = lines
    .slice(start - 1, end)
    .map((line, idx) => `${start + idx}: ${line}`);
  return [header, ...numbered].join("\n");
}

export function upsertMemorySection(current: string, section: string, content: string): string {
  const cleanTitle = section.trim().replace(/^#{1,6}\s+/, "").trim();
  if (cleanTitle === "") throw new Error("section is required for upsert_section");
  const rawBody = content.trim();
  if (rawBody === "") throw new Error("content is required for upsert_section");

  const sections = parseMemorySections(current);
  const key = cleanTitle.toLowerCase();
  const existing = sections.find((s) => s.level > 0 && normalizeHeadingKey(s.heading) === key);
  const headingPrefix = "#".repeat(existing !== undefined && existing.level >= 1 ? existing.level : 2);
  const targetTitle = existing?.heading ?? cleanTitle;

  const firstNewline = rawBody.indexOf("\n");
  const firstLine = (firstNewline === -1 ? rawBody : rawBody.slice(0, firstNewline)).trim();
  const headingMatch = HEADING_RE.exec(firstLine);
  let blockLines: string[];
  if (headingMatch !== null && normalizeHeadingKey(headingMatch[2] ?? "") === key) {
    const rest = firstNewline === -1 ? "" : rawBody.slice(firstNewline + 1).replace(/^\n+/, "").trimEnd();
    blockLines = rest === "" ? [`${headingPrefix} ${targetTitle}`] : [`${headingPrefix} ${targetTitle}`, "", ...rest.split("\n")];
  } else {
    blockLines = [`${headingPrefix} ${targetTitle}`, "", ...rawBody.split("\n")];
  }

  if (existing === undefined) {
    const trimmed = current.trimEnd();
    const appended = blockLines.join("\n");
    return trimmed === "" ? `${appended}\n` : `${trimmed}\n\n${appended}\n`;
  }

  const lines = splitLines(current);
  const before = lines.slice(0, existing.startLine - 1);
  const after = lines.slice(existing.endLine);
  while (before.length > 0 && before.at(-1)?.trim() === "") before.pop();
  while (after.length > 0 && after[0]?.trim() === "") after.shift();

  const merged: string[] = [];
  if (before.length > 0) merged.push(...before, "");
  merged.push(...blockLines);
  if (after.length > 0) merged.push("", ...after);
  return `${merged.join("\n")}\n`;
}

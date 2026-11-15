/**
 * Frontmatter parsing (`globs`, `paths`, `alwaysApply`, `description`) and
 * POSIX glob matching for project and user rule files.
 */
import { basename, posix } from "node:path";

export type RuleMode = "always" | "glob" | "manual";

export interface ParsedRuleFile {
  mode: RuleMode;
  globs: string[];
  description: string;
  body: string;
}

function stripQuotes(value: string): string {
  const trimmed = value.trim();
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"') && trimmed.length >= 2) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'") && trimmed.length >= 2)
  ) {
    return trimmed.slice(1, -1).trim();
  }
  return trimmed;
}

/** Split comma-separated globs without splitting inside `{a,b}` brace expansions. */
function splitCommaOutsideBraces(input: string): string[] {
  const items: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < input.length; i += 1) {
    const ch = input[i];
    if (ch === "{") depth += 1;
    else if (ch === "}" && depth > 0) depth -= 1;
    else if (ch === "," && depth === 0) {
      items.push(input.slice(start, i));
      start = i + 1;
    }
  }
  items.push(input.slice(start));
  return items;
}

function parseGlobValueList(raw: string): string[] {
  const trimmed = raw.trim();
  if (trimmed === "") return [];
  const inner =
    trimmed.startsWith("[") && trimmed.endsWith("]")
      ? trimmed.slice(1, -1)
      : trimmed;
  return splitCommaOutsideBraces(inner)
    .map((item) => stripQuotes(item))
    .filter((item) => item !== "");
}

function stripYamlListItemComment(rawItem: string): string {
  const trimmed = rawItem.trim();
  if (
    (trimmed.startsWith('"') && trimmed.includes('"', 1)) ||
    (trimmed.startsWith("'") && trimmed.includes("'", 1))
  ) {
    const quote = trimmed.charAt(0);
    const end = trimmed.indexOf(quote, 1);
    return trimmed.slice(1, end).trim();
  }
  return stripQuotes(trimmed.replace(/\s+#.*$/, ""));
}

function fallbackDescription(body: string, filePath: string): string {
  for (const rawLine of body.split("\n")) {
    const line = rawLine.trim();
    if (line === "") continue;
    const cleaned = line.startsWith("#") ? line.replace(/^#+\s*/, "").trim() : line;
    if (cleaned === "") continue;
    return cleaned.length > 100 ? `${cleaned.slice(0, 97)}...` : cleaned;
  }
  return basename(filePath);
}

/** Parse optional YAML frontmatter (`globs`, `paths`, `alwaysApply`, `description`) and body. */
export function parseRuleFile(rawText: string, filePath: string): ParsedRuleFile {
  const normalized = rawText.replace(/\r\n/g, "\n");
  const match = /^---\n([\s\S]*?)\n---(?:\n|$)/.exec(normalized);
  if (match === null) {
    const body = normalized.trim();
    return {
      mode: "always",
      globs: [],
      description: fallbackDescription(body, filePath),
      body,
    };
  }

  const frontmatter = match[1] ?? "";
  const body = normalized.slice(match[0].length).trim();
  let description = "";
  let alwaysApply: boolean | undefined;
  const globs: string[] = [];
  let activeListKey = false;

  for (const line of frontmatter.split("\n")) {
    const listItem = /^\s*-\s+(.+)$/.exec(line);
    if (activeListKey && listItem?.[1] !== undefined) {
      const cleaned = stripYamlListItemComment(listItem[1]);
      if (cleaned !== "") globs.push(cleaned);
      continue;
    }

    const keyMatch = /^([A-Za-z_-]+):\s*(.*)$/.exec(line);
    if (keyMatch?.[1] === undefined) {
      if (line.trim() !== "") activeListKey = false;
      continue;
    }

    const key = keyMatch[1];
    const value = keyMatch[2] ?? "";
    activeListKey = false;

    if (key === "description") {
      description = stripQuotes(value);
    } else if (key === "alwaysApply") {
      const lowered = stripQuotes(value).toLowerCase();
      if (lowered === "true") alwaysApply = true;
      else if (lowered === "false") alwaysApply = false;
    } else if (key === "globs" || key === "paths") {
      const trimmedVal = value.trim();
      if (trimmedVal === "") {
        activeListKey = true;
      } else {
        globs.push(...parseGlobValueList(trimmedVal));
      }
    }
  }

  const mode: RuleMode =
    alwaysApply === true
      ? "always"
      : globs.length > 0
        ? "glob"
        : alwaysApply === false || (filePath.toLowerCase().endsWith(".mdc") && description !== "")
          ? "manual"
          : "always";

  return {
    mode,
    globs,
    description: description !== "" ? description : fallbackDescription(body, filePath),
    body,
  };
}

function escapeRegexChar(ch: string): string {
  return /[.+^$()|[\]\\]/.test(ch) ? `\\${ch}` : ch;
}

function findClosingBrace(pattern: string, openIndex: number): number {
  let depth = 0;
  for (let i = openIndex; i < pattern.length; i += 1) {
    if (pattern[i] === "{") depth += 1;
    else if (pattern[i] === "}") {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  return -1;
}

function compileGlobFragment(pattern: string): string {
  let regex = "";
  let i = 0;
  while (i < pattern.length) {
    if (pattern.slice(i, i + 4) === "/**/") {
      regex += "(?:/.+)?/";
      i += 4;
      while (pattern.slice(i, i + 3) === "**/") i += 3;
      continue;
    }
    if (i === 0 && pattern.slice(0, 3) === "**/") {
      regex += "(?:.+/)?";
      i += 3;
      while (pattern.slice(i, i + 3) === "**/") i += 3;
      continue;
    }
    if (pattern.slice(i) === "/**") {
      regex += "(?:/.*)?";
      i += 3;
      continue;
    }
    if (pattern.slice(i, i + 2) === "**") {
      regex += ".*";
      i += 2;
      continue;
    }

    const ch = pattern[i] ?? "";
    if (ch === "{") {
      const close = findClosingBrace(pattern, i);
      if (close !== -1) {
        const inner = pattern.slice(i + 1, close);
        const parts = splitCommaOutsideBraces(inner).map((part) => compileGlobFragment(part));
        regex += `(?:${parts.join("|")})`;
        i = close + 1;
        continue;
      }
      regex += "\\{";
      i += 1;
      continue;
    }
    if (ch === "}") {
      regex += "\\}";
      i += 1;
      continue;
    }
    if (ch === "*") {
      regex += "[^/]*";
      i += 1;
      continue;
    }
    if (ch === "?") {
      regex += "[^/]";
      i += 1;
      continue;
    }
    if (ch === "[") {
      const close = pattern.indexOf("]", i + 1);
      if (close !== -1) {
        const body = pattern.slice(i + 1, close);
        const negated = body.startsWith("!") || body.startsWith("^") ? `^${body.slice(1)}` : body;
        regex += `[${negated}]`;
        i = close + 1;
        continue;
      }
      regex += "\\[";
      i += 1;
      continue;
    }

    regex += escapeRegexChar(ch);
    i += 1;
  }
  return regex;
}

function normalizeGlobPattern(pattern: string): string {
  return pattern
    .trim()
    .replace(/\\/g, "/")
    .replace(/^\.\//, "")
    .replace(/^\/+/, "")
    .replace(/\/\*\*(\/\*\*)+/g, "/**");
}

/** Compile a POSIX glob pattern (with `**`, `*`, `?`, `{a,b}`, `[abc]`) to a full-match RegExp. */
export function globToRegExp(pattern: string): RegExp {
  const norm = normalizeGlobPattern(pattern);
  if (norm === "") return /^$/;
  if (norm === "**") return /^.*$/;
  return new RegExp(`^${compileGlobFragment(norm)}$`);
}

function matchSingleGlob(pattern: string, relPosixPath: string): boolean {
  const norm = normalizeGlobPattern(pattern);
  if (norm === "") return false;
  const regex = globToRegExp(norm);
  if (regex.test(relPosixPath)) return true;
  return !norm.includes("/") && regex.test(posix.basename(relPosixPath));
}

/** Match a workspace-relative POSIX path against positive and `!`-negated rule globs. */
export function matchesRuleGlobs(relPosixPath: string, globs: readonly string[]): boolean {
  const normRel = relPosixPath.replace(/\\/g, "/").replace(/^\.\//, "").replace(/^\/+/, "");
  if (normRel === "" || normRel.startsWith("..")) return false;

  const positives: string[] = [];
  const negatives: string[] = [];
  for (const raw of globs) {
    const trimmed = raw.trim();
    if (trimmed === "") continue;
    if (trimmed.startsWith("!")) {
      const neg = trimmed.slice(1).trim();
      if (neg !== "") negatives.push(neg);
    } else {
      positives.push(trimmed);
    }
  }

  if (positives.length === 0) return false;
  if (!positives.some((pattern) => matchSingleGlob(pattern, normRel))) return false;
  return !negatives.some((pattern) => matchSingleGlob(pattern, normRel));
}

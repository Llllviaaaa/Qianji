import { defaultUrlTransform } from "react-markdown";

export const FILE_SCHEME = "pifile://";

/**
 * File tokens come in two conservative shapes:
 * - path with >= 1 separator and any short extension (src/App.tsx, D:\repo\a.rs, 文档/报告.pdf)
 * - bare filename with a whitelisted code/doc/media extension (README.md, report.pdf, sheet.xlsx) —
 *   the whitelist keeps domains (pi.dev) and version numbers (1.30.0) unlinked.
 */
const BARE_FILE_EXTENSIONS =
  "tsx|ts|jsx|js|mjs|cjs|rs|py|go|java|rb|php|md|markdown|json|jsonc|css|scss|less|html|htm|svg|toml|yaml|yml|txt|xml|sql|ps1|bat|ini|cfg|conf|lock|csv|svelte|vue|pdf|doc|docx|xls|xlsx|ppt|pptx|png|jpg|jpeg|gif|webp|bmp|ico|mp3|wav|mp4|webm|zip|tar|gz|7z|rar|rtf|epub|log";

const PATH_SEGMENT = String.raw`[\p{L}\p{N}_.-]+`;
const PATH_FILE_TOKEN = String.raw`(?:[A-Za-z]:[\\/])?(?:\.{1,2}[\\/])?${PATH_SEGMENT}(?:[\\/]${PATH_SEGMENT})+\.[A-Za-z0-9]{1,8}`;
const BARE_FILE_TOKEN = String.raw`[\p{L}\p{N}_-]+(?:\.[\p{L}\p{N}_-]+)*\.(?:${BARE_FILE_EXTENSIONS})(?![\p{L}\p{N}_.-])`;

export const INLINE_FILE_RE = new RegExp(`^(${PATH_FILE_TOKEN}|${BARE_FILE_TOKEN})(?::(\\d+))?$`, "u");
const TEXT_FILE_RE = new RegExp(
  String.raw`(?<![\p{L}\p{N}_\u0060[(\\/.-])(${PATH_FILE_TOKEN}|${BARE_FILE_TOKEN})(?::(\d+)|\s?[（(]\s*line\s+(\d+)\s*[)）])?`,
  "gu",
);

const EXTERNAL_SCHEME_RE = /^[a-zA-Z][a-zA-Z0-9+.-]*:/;

export function fileHref(path: string, line?: string): string {
  return `${FILE_SCHEME}${encodeURIComponent(path)}${line ? `#L${line}` : ""}`;
}

export function parseFileHref(href: string): { path: string; line?: number } {
  const [encoded, hash] = href.slice(FILE_SCHEME.length).split("#");
  const line = hash?.startsWith("L") ? Number(hash.slice(1)) : undefined;
  return {
    path: safeDecode(encoded),
    line: line !== undefined && Number.isFinite(line) ? line : undefined,
  };
}

function safeDecode(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

/** Turn bare file-path tokens in prose (not inside code spans/fences) into pifile:// links. */
export function linkifyFilePaths(markdown: string): string {
  const parts = markdown.split(/(```[\s\S]*?(?:```|$)|~~~[\s\S]*?(?:~~~|$)|`[^`\n]*`)/);
  return parts
    .map((part, index) => {
      if (index % 2 === 1) return part;
      return part.replace(TEXT_FILE_RE, (full, path: string, colonLine?: string, parenLine?: string) =>
        `[${full}](${fileHref(path, colonLine || parenLine)})`);
    })
    .join("");
}

function splitPathAndLine(raw: string): { path: string; line?: string } {
  const [withoutHash, hash] = raw.split("#");
  const hashLine = hash && /^L(\d+)$/i.exec(hash)?.[1];
  const colonMatch = /^(.*?):(\d+)(?::\d+)?$/.exec(withoutHash);
  if (colonMatch?.[1] && !/^[A-Za-z]$/.test(colonMatch[1])) {
    return { path: colonMatch[1], line: hashLine ?? colonMatch[2] };
  }
  return { path: withoutHash, line: hashLine };
}

/**
 * Normalize Markdown link URLs so `file:///...`, Windows drive paths (`D:\a\b.pdf`),
 * and relative local file paths (`./docs/a.md`, `report.pdf`) route through `pifile://`
 * instead of being stripped by react-markdown's `defaultUrlTransform` or failing in `openUrl`.
 */
export function normalizeMarkdownUrl(url: string): string {
  const trimmed = url.trim();
  if (trimmed === "") return "";
  if (trimmed.startsWith(FILE_SCHEME)) return trimmed;
  if (trimmed.startsWith("#")) return trimmed;

  if (/^file:\/\//i.test(trimmed)) {
    const stripped = trimmed.replace(/^file:\/\/(?:localhost)?/i, "");
    const { path: rawPath, line } = splitPathAndLine(stripped);
    const decoded = safeDecode(rawPath);
    const normalized = /^\/[A-Za-z]:[\\/]/.test(decoded) ? decoded.slice(1) : decoded;
    return fileHref(normalized, line);
  }

  if (/^[A-Za-z]:[\\/]/.test(trimmed)) {
    const { path, line } = splitPathAndLine(trimmed);
    return fileHref(safeDecode(path), line);
  }

  if (EXTERNAL_SCHEME_RE.test(trimmed) || trimmed.startsWith("//")) {
    return defaultUrlTransform(trimmed);
  }

  // Relative local path (e.g. `./spec.md`, `docs/report.pdf`, `report.docx`).
  const { path, line } = splitPathAndLine(trimmed);
  const decoded = safeDecode(path);
  if (decoded !== "" && !decoded.startsWith("?")) {
    return fileHref(decoded, line);
  }
  return defaultUrlTransform(trimmed);
}

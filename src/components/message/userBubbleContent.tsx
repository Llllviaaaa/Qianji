import type { ReactNode } from "react";
import { FileText, Folder, Link2, Sparkles } from "lucide-react";
import type { SlashCommand } from "../../types";

export interface ParsedAttachedFile {
  readonly fileName: string;
  readonly path: string;
  readonly ext: string;
}

export interface ParsedUserDirective {
  readonly kind: "goal" | "skill" | "command";
  readonly rawCommand: string;
  readonly displayName: string;
  readonly args: string;
}

export interface StructuredUserMessage {
  readonly quotedText: string | null;
  readonly connectors: readonly string[];
  readonly attachedFiles: readonly ParsedAttachedFile[];
  readonly directive: ParsedUserDirective | null;
  readonly bodyText: string;
}

const TRAILING_ATTACHED_FILES_RE = /(?:^|\r?\n\r?\n)附加的本地文件：\r?\n((?:- .+(?:\r?\n|$))+)\s*$/;
const LEADING_QUOTE_BLOCK_RE = /^((?:>[ \t]?.*(?:\r?\n|$))+)\r?\n([\s\S]*)$/;
const LEADING_CONNECTOR_PREFIX_RE = /^\[已关联连接器上下文:\s*([^\]]+)\]\r?\n?([\s\S]*)$/;
const LEADING_SLASH_CMD_RE = /^\/([a-zA-Z0-9][a-zA-Z0-9:_-]*)(?:\s+([\s\S]*))?$/;

const INLINE_MENTION_RE =
  /(^|[\s(（[【])(?:@"([^"\r\n]+)"|@([A-Za-z0-9_.\u4e00-\u9fa5~-]+(?:[\\/][A-Za-z0-9_.\u4e00-\u9fa5~-]*)+|[A-Za-z0-9_\u4e00-\u9fa5-]+\.[A-Za-z0-9]{1,8}))/g;

function extractFileExt(fileName: string): string {
  const clean = fileName.replace(/[\\/]+$/, "");
  const dot = clean.lastIndexOf(".");
  if (dot <= 0 || dot === clean.length - 1) return "";
  return clean.slice(dot + 1).toUpperCase().slice(0, 6);
}

function parseAttachedFileLines(rawLines: string): ParsedAttachedFile[] {
  const out: ParsedAttachedFile[] = [];
  for (const rawLine of rawLines.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line.startsWith("- ")) continue;
    const body = line.slice(2).trim();
    const colonIdx = body.indexOf(": ");
    if (colonIdx <= 0) continue;
    const fileName = body.slice(0, colonIdx).trim();
    const path = body.slice(colonIdx + 2).trim();
    if (!fileName || !path) continue;
    out.push({ fileName, path, ext: extractFileExt(fileName) });
  }
  return out;
}

export function buildKnownSkillSet(commands?: readonly Pick<SlashCommand, "name" | "source">[]): ReadonlySet<string> {
  const skills = new Set<string>();
  if (!commands) return skills;
  for (const cmd of commands) {
    if (cmd.name.startsWith("skill:")) {
      const slug = cmd.name.slice(6).trim().toLowerCase();
      if (slug) skills.add(slug);
    } else if (cmd.source === "skill") {
      skills.add(cmd.name.trim().toLowerCase());
    }
  }
  return skills;
}

export function parseStructuredUserMessage(
  rawContent: string,
  knownSkills?: ReadonlySet<string>,
): StructuredUserMessage {
  let working = rawContent;
  let attachedFiles: ParsedAttachedFile[] = [];

  const attachMatch = TRAILING_ATTACHED_FILES_RE.exec(working);
  if (attachMatch?.[1] !== undefined) {
    const parsedFiles = parseAttachedFileLines(attachMatch[1]);
    if (parsedFiles.length > 0) {
      attachedFiles = parsedFiles;
      working = working.slice(0, attachMatch.index).trimEnd();
    }
  }

  let quotedText: string | null = null;
  const quoteMatch = LEADING_QUOTE_BLOCK_RE.exec(working);
  if (quoteMatch?.[1] !== undefined && quoteMatch[2] !== undefined) {
    const strippedQuote = quoteMatch[1]
      .split(/\r?\n/)
      .map((line) => line.replace(/^>[ \t]?/, "").trimEnd())
      .filter((line, idx, arr) => !(idx === arr.length - 1 && line === ""))
      .join("\n")
      .trim();
    if (strippedQuote !== "") {
      quotedText = strippedQuote;
      working = quoteMatch[2];
    }
  }

  let connectors: string[] = [];
  const connMatch = LEADING_CONNECTOR_PREFIX_RE.exec(working);
  if (connMatch?.[1] !== undefined && connMatch[2] !== undefined) {
    connectors = connMatch[1]
      .split(/[、,，]/)
      .map((item) => item.trim())
      .filter(Boolean);
    working = connMatch[2];
  }

  let directive: ParsedUserDirective | null = null;
  const trimmed = working.trim();
  const slashMatch = LEADING_SLASH_CMD_RE.exec(trimmed);
  if (slashMatch?.[1] !== undefined) {
    const rawCommand = slashMatch[1];
    const args = (slashMatch[2] ?? "").trim();
    const lower = rawCommand.toLowerCase();
    if (rawCommand === "goal" && args !== "") {
      directive = { kind: "goal", rawCommand, displayName: "goal", args };
      working = args;
    } else if (lower.startsWith("skill:") && rawCommand.length > 6) {
      const slug = rawCommand.slice(6);
      directive = { kind: "skill", rawCommand, displayName: slug, args };
      working = args;
    } else if (knownSkills?.has(lower)) {
      directive = { kind: "skill", rawCommand, displayName: rawCommand, args };
      working = args;
    } else {
      directive = { kind: "command", rawCommand, displayName: rawCommand, args };
      working = args;
    }
  }

  return {
    quotedText,
    connectors,
    attachedFiles,
    directive,
    bodyText: directive !== null ? directive.args : working,
  };
}

function mentionDisplayLabel(rawPath: string): { label: string; isDir: boolean } {
  const normalized = rawPath.replace(/\\/g, "/");
  const isDir = normalized.endsWith("/");
  const clean = normalized.replace(/\/+$/, "");
  const parts = clean.split("/").filter(Boolean);
  const leaf = parts[parts.length - 1] ?? clean;
  return { label: isDir ? `${leaf}/` : leaf, isDir };
}

export function renderTextWithFileMentions(
  text: string,
  onOpenFile?: ((path: string) => void) | null,
): ReactNode {
  if (!text.includes("@")) return text;
  const nodes: ReactNode[] = [];
  let cursor = 0;
  INLINE_MENTION_RE.lastIndex = 0;
  let match: RegExpExecArray | null;

  while ((match = INLINE_MENTION_RE.exec(text)) !== null) {
    const leading = match[1] ?? "";
    const refPath = (match[2] ?? match[3] ?? "").trim();
    if (!refPath) continue;
    const tokenStart = match.index + leading.length;
    if (tokenStart > cursor) {
      nodes.push(text.slice(cursor, tokenStart));
    }
    const { label, isDir } = mentionDisplayLabel(refPath);
    const key = `mention-${tokenStart}-${refPath}`;
    if (!isDir && onOpenFile) {
      nodes.push(
        <button
          key={key}
          type="button"
          className="qj-mention-pill is-clickable"
          title={`打开引用文件：${refPath}`}
          onClick={(event) => {
            event.stopPropagation();
            onOpenFile(refPath);
          }}
        >
          <FileText size={11} strokeWidth={1.9} aria-hidden="true" />
          <span>{label}</span>
        </button>,
      );
    } else {
      nodes.push(
        <span key={key} className="qj-mention-pill" title={refPath}>
          {isDir ? (
            <Folder size={11} strokeWidth={1.9} aria-hidden="true" />
          ) : (
            <FileText size={11} strokeWidth={1.9} aria-hidden="true" />
          )}
          <span>{label}</span>
        </span>,
      );
    }
    cursor = match.index + match[0].length;
  }

  if (nodes.length === 0) return text;
  if (cursor < text.length) nodes.push(text.slice(cursor));
  return <>{nodes}</>;
}

export function renderStructuredUserBubbleBody(
  structured: StructuredUserMessage,
  onOpenFile?: ((path: string) => void) | null,
): ReactNode {
  const { quotedText, connectors, directive, bodyText } = structured;

  const renderDirectiveAndBody = (): ReactNode => {
    if (directive === null) {
      return renderTextWithFileMentions(bodyText, onOpenFile);
    }
    if (directive.kind === "goal") {
      return (
        <>
          <span className="qj-cmd-pill is-goal">🎯 /goal</span>{" "}
          <span className="qj-cmd-objective">{renderTextWithFileMentions(directive.args, onOpenFile)}</span>
        </>
      );
    }
    if (directive.kind === "skill") {
      return (
        <>
          <span className="qj-cmd-pill is-skill" data-skill={directive.displayName} title={`调用技能：${directive.displayName}`}>
            <Sparkles size={11} strokeWidth={2.1} className="qj-cmd-pill-icon" aria-hidden="true" />
            <span className="qj-cmd-skill-badge">技能</span>
            <span className="qj-cmd-skill-name">{directive.displayName}</span>
          </span>
          {directive.args !== "" ? (
            <>
              {" "}
              <span className="qj-cmd-args">{renderTextWithFileMentions(directive.args, onOpenFile)}</span>
            </>
          ) : null}
        </>
      );
    }
    return (
      <>
        <span className="qj-cmd-pill">/{directive.displayName}</span>
        {directive.args !== "" ? (
          <>
            {" "}
            <span className="qj-cmd-args">{renderTextWithFileMentions(directive.args, onOpenFile)}</span>
          </>
        ) : null}
      </>
    );
  };

  const hasHeaderMeta = quotedText !== null || connectors.length > 0;
  const hasMainBody = directive !== null || bodyText.trim() !== "";

  if (!hasHeaderMeta) {
    return renderDirectiveAndBody();
  }

  return (
    <div className="qj-user-structured-body">
      {quotedText !== null && (
        <blockquote className="qj-user-quote-card">
          <span>{quotedText}</span>
        </blockquote>
      )}
      {connectors.length > 0 && (
        <div className="qj-user-connector-row" aria-label="已关联应用上下文">
          {connectors.map((name) => (
            <span key={name} className="qj-user-connector-pill">
              <Link2 size={10.5} strokeWidth={2} aria-hidden="true" />
              <span>{name}</span>
            </span>
          ))}
        </div>
      )}
      {hasMainBody && <div className="qj-user-prose-line">{renderDirectiveAndBody()}</div>}
    </div>
  );
}

export function AttachedFileChips({
  files,
  onOpenFile,
}: {
  readonly files: readonly ParsedAttachedFile[];
  readonly onOpenFile?: ((path: string) => void) | null;
}): ReactNode {
  if (files.length === 0) return null;
  return (
    <>
      {files.map((file, idx) =>
        onOpenFile ? (
          <button
            key={`${file.path}-${idx}`}
            type="button"
            className="dshc-file-attachment-chip is-clickable"
            title={`预览本地文件：${file.path}`}
            onClick={() => onOpenFile(file.path)}
          >
            <FileText size={13.5} strokeWidth={1.8} className="dshc-file-attachment-icon" aria-hidden="true" />
            <span className="dshc-file-attachment-name">{file.fileName}</span>
            {file.ext && <span className="dshc-file-attachment-ext">{file.ext}</span>}
          </button>
        ) : (
          <span key={`${file.path}-${idx}`} className="dshc-file-attachment-chip" title={file.path}>
            <FileText size={13.5} strokeWidth={1.8} className="dshc-file-attachment-icon" aria-hidden="true" />
            <span className="dshc-file-attachment-name">{file.fileName}</span>
            {file.ext && <span className="dshc-file-attachment-ext">{file.ext}</span>}
          </span>
        ),
      )}
    </>
  );
}

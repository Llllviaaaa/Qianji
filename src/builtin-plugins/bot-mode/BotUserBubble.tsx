/**
 * Structured User Message Bubble for Bot Companion Chat (`BotUserBubble.tsx`).
 *
 * Parses serialized connector headers (`[已关联连接器上下文: ...]`), Markdown reply quotes
 * (`> ...`), trailing local file attachment manifests (`附加的本地文件：`), leading `/skill:*`
 * and `/command` directives, and inline `@file` mentions into tactile Muse tokens.
 */
import { useMemo, useState, type ReactElement, type ReactNode } from "react";
import { Check, Copy, FileText, Folder, Reply, Sparkles } from "lucide-react";
import { CONNECTOR_CATALOG } from "./botConnectorCatalog";
import { ConnectorBrandIcon } from "./BotConnectorLogos";

export interface BotAttachedImage {
  readonly data: string;
  readonly mimeType: string;
}

interface BotParsedFile {
  readonly fileName: string;
  readonly path: string;
  readonly ext: string;
}

interface BotParsedDirective {
  readonly kind: "goal" | "skill" | "command";
  readonly displayName: string;
  readonly args: string;
}

interface BotStructuredUserPayload {
  readonly quotedText: string | null;
  readonly connectors: ReadonlyArray<{ readonly id: string | null; readonly label: string }>;
  readonly attachedFiles: readonly BotParsedFile[];
  readonly directive: BotParsedDirective | null;
  readonly bodyText: string;
  readonly cleanCopyText: string;
}

const TRAILING_FILES_RE = /(?:^|\r?\n\r?\n)附加的本地文件：\r?\n((?:- .+(?:\r?\n|$))+)\s*$/;
const LEADING_QUOTE_RE = /^((?:>[ \t]?.*(?:\r?\n|$))+)\r?\n([\s\S]*)$/;
const LEADING_CONN_RE = /^\[已关联连接器上下文:\s*([^\]]+)\]\r?\n?([\s\S]*)$/;
const LEADING_SLASH_RE = /^\/([a-zA-Z0-9][a-zA-Z0-9:_-]*)(?:\s+([\s\S]*))?$/;
const INLINE_FILE_MENTION_RE =
  /(^|[\s(（[【])(?:@"([^"\r\n]+)"|@([A-Za-z0-9_.\u4e00-\u9fa5~-]+(?:[\\/][A-Za-z0-9_.\u4e00-\u9fa5~-]*)+|[A-Za-z0-9_\u4e00-\u9fa5-]+\.[A-Za-z0-9]{1,8}))/g;

function resolveConnectorBrandId(label: string): string | null {
  const norm = label.trim().toLowerCase();
  const matched = CONNECTOR_CATALOG.find(
    (entry) => entry.id.toLowerCase() === norm || entry.name.toLowerCase() === norm,
  );
  return matched?.id ?? null;
}

function fileExtOf(name: string): string {
  const dot = name.lastIndexOf(".");
  if (dot <= 0 || dot === name.length - 1) return "";
  return name.slice(dot + 1).toUpperCase().slice(0, 6);
}

export function parseBotUserMessage(
  rawContent: string,
  knownSkills?: ReadonlySet<string>,
): BotStructuredUserPayload {
  let working = rawContent;
  const attachedFiles: BotParsedFile[] = [];

  const fileMatch = TRAILING_FILES_RE.exec(working);
  if (fileMatch?.[1] !== undefined) {
    for (const rawLine of fileMatch[1].split(/\r?\n/)) {
      const line = rawLine.trim();
      if (!line.startsWith("- ")) continue;
      const sep = line.indexOf(": ");
      if (sep > 2) {
        const fileName = line.slice(2, sep).trim();
        const path = line.slice(sep + 2).trim();
        if (fileName && path) {
          attachedFiles.push({ fileName, path, ext: fileExtOf(fileName) });
        }
      }
    }
    if (attachedFiles.length > 0) {
      working = working.slice(0, fileMatch.index).trimEnd();
    }
  }

  let quotedText: string | null = null;
  const quoteMatch = LEADING_QUOTE_RE.exec(working);
  if (quoteMatch?.[1] !== undefined && quoteMatch[2] !== undefined) {
    const stripped = quoteMatch[1]
      .split(/\r?\n/)
      .map((l) => l.replace(/^>[ \t]?/, "").trimEnd())
      .filter((l, i, arr) => !(i === arr.length - 1 && l === ""))
      .join("\n")
      .trim();
    if (stripped !== "") {
      quotedText = stripped;
      working = quoteMatch[2];
    }
  }

  let connectors: Array<{ id: string | null; label: string }> = [];
  const connMatch = LEADING_CONN_RE.exec(working);
  if (connMatch?.[1] !== undefined && connMatch[2] !== undefined) {
    connectors = connMatch[1]
      .split(/[、,，]/)
      .map((s) => s.trim())
      .filter(Boolean)
      .map((label) => ({ id: resolveConnectorBrandId(label), label }));
    working = connMatch[2];
  }

  const cleanCopyText = working.trim() || rawContent.trim();

  let directive: BotParsedDirective | null = null;
  const trimmed = working.trim();
  const slashMatch = LEADING_SLASH_RE.exec(trimmed);
  if (slashMatch?.[1] !== undefined) {
    const cmdName = slashMatch[1];
    const args = (slashMatch[2] ?? "").trim();
    const lower = cmdName.toLowerCase();
    if (cmdName === "goal" && args !== "") {
      directive = { kind: "goal", displayName: "goal", args };
    } else if (lower.startsWith("skill:") && cmdName.length > 6) {
      directive = { kind: "skill", displayName: cmdName.slice(6), args };
    } else if (knownSkills?.has(lower)) {
      directive = { kind: "skill", displayName: cmdName, args };
    } else {
      directive = { kind: "command", displayName: cmdName, args };
    }
  }

  return {
    quotedText,
    connectors,
    attachedFiles,
    directive,
    bodyText: directive !== null ? directive.args : working,
    cleanCopyText,
  };
}

function renderBotMentions(text: string): ReactNode {
  if (!text.includes("@")) return text;
  const parts: ReactNode[] = [];
  let cursor = 0;
  INLINE_FILE_MENTION_RE.lastIndex = 0;
  let match: RegExpExecArray | null;

  while ((match = INLINE_FILE_MENTION_RE.exec(text)) !== null) {
    const prefix = match[1] ?? "";
    const rawPath = (match[2] ?? match[3] ?? "").trim();
    if (!rawPath) continue;
    const start = match.index + prefix.length;
    if (start > cursor) parts.push(text.slice(cursor, start));

    const norm = rawPath.replace(/\\/g, "/");
    const isDir = norm.endsWith("/");
    const clean = norm.replace(/\/+$/, "");
    const leaf = clean.split("/").filter(Boolean).pop() ?? clean;
    parts.push(
      <span key={`bm-${start}-${rawPath}`} className="qj-mention-pill" title={rawPath}>
        {isDir ? <Folder size={11} strokeWidth={1.9} aria-hidden="true" /> : <FileText size={11} strokeWidth={1.9} aria-hidden="true" />}
        <span>{isDir ? `${leaf}/` : leaf}</span>
      </span>,
    );
    cursor = match.index + match[0].length;
  }

  if (parts.length === 0) return text;
  if (cursor < text.length) parts.push(text.slice(cursor));
  return <>{parts}</>;
}

export function BotUserBubbleRow(props: {
  readonly content: string;
  readonly images?: readonly BotAttachedImage[];
  readonly knownSkills?: ReadonlySet<string>;
  readonly onCopy?: (text: string) => void;
  readonly onQuote?: (snippet: string) => void;
}): ReactElement {
  const { content, images, knownSkills, onCopy, onQuote } = props;
  const [copied, setCopied] = useState(false);

  const parsed = useMemo(() => parseBotUserMessage(content, knownSkills), [content, knownSkills]);
  const hasAttachments = (images !== undefined && images.length > 0) || parsed.attachedFiles.length > 0;
  const hasHeaderMeta = parsed.quotedText !== null || parsed.connectors.length > 0;
  const hasMainText = parsed.directive !== null || parsed.bodyText.trim() !== "";
  const hasBubble = hasHeaderMeta || hasMainText;

  const renderDirectiveAndProse = (): ReactNode => {
    if (parsed.directive === null) {
      return renderBotMentions(parsed.bodyText);
    }
    if (parsed.directive.kind === "goal") {
      return (
        <>
          <span className="qj-cmd-pill is-goal">🎯 /goal</span>{" "}
          <span className="qj-cmd-objective">{renderBotMentions(parsed.directive.args)}</span>
        </>
      );
    }
    if (parsed.directive.kind === "skill") {
      return (
        <>
          <span
            className="qj-cmd-pill is-skill"
            data-skill={parsed.directive.displayName}
            title={`调用技能：${parsed.directive.displayName}`}
          >
            <Sparkles size={11} strokeWidth={2.1} className="qj-cmd-pill-icon" aria-hidden="true" />
            <span className="qj-cmd-skill-badge">技能</span>
            <span className="qj-cmd-skill-name">{parsed.directive.displayName}</span>
          </span>
          {parsed.directive.args !== "" ? (
            <>
              {" "}
              <span className="qj-cmd-args">{renderBotMentions(parsed.directive.args)}</span>
            </>
          ) : null}
        </>
      );
    }
    return (
      <>
        <span className="qj-cmd-pill">/{parsed.directive.displayName}</span>
        {parsed.directive.args !== "" ? (
          <>
            {" "}
            <span className="qj-cmd-args">{renderBotMentions(parsed.directive.args)}</span>
          </>
        ) : null}
      </>
    );
  };

  const handleCopy = () => {
    if (onCopy) {
      onCopy(parsed.cleanCopyText);
    } else if (typeof navigator !== "undefined") {
      void navigator.clipboard?.writeText(parsed.cleanCopyText);
    }
    setCopied(true);
    if (typeof window !== "undefined") {
      window.setTimeout(() => setCopied(false), 1200);
    }
  };

  return (
    <div className="qj-msg-row qj-sanctuary-msg-user-row">
      <div className="qj-bot-user-stack">
        {hasAttachments && (
          <div className="qj-bot-user-attachments">
            {images?.map((img, idx) => (
              <img
                key={`img-${idx}`}
                className="qj-bot-user-image"
                src={`data:${img.mimeType};base64,${img.data}`}
                alt={`图片附件 ${idx + 1}`}
              />
            ))}
            {parsed.attachedFiles.map((file, idx) => (
              <span key={`${file.path}-${idx}`} className="dshc-file-attachment-chip" title={file.path}>
                <FileText size={13.5} strokeWidth={1.8} className="dshc-file-attachment-icon" aria-hidden="true" />
                <span className="dshc-file-attachment-name">{file.fileName}</span>
                {file.ext && <span className="dshc-file-attachment-ext">{file.ext}</span>}
              </span>
            ))}
          </div>
        )}

        {hasBubble && (
          <div className="qj-bot-user-bubble-line">
            {(onCopy !== undefined || onQuote !== undefined) && (
              <div className="qj-msg-actions is-user">
                <button
                  type="button"
                  className="qj-msg-action-btn"
                  title={copied ? "已复制" : "复制消息"}
                  aria-label={copied ? "已复制" : "复制消息"}
                  onClick={handleCopy}
                >
                  {copied ? <Check size={13.5} /> : <Copy size={13.5} />}
                </button>
                {onQuote && parsed.cleanCopyText !== "" && (
                  <button
                    type="button"
                    className="qj-msg-action-btn"
                    title="引用消息"
                    aria-label="引用消息"
                    onClick={() => onQuote(parsed.cleanCopyText.slice(0, 100))}
                  >
                    <Reply size={14} />
                  </button>
                )}
              </div>
            )}

            <div className="qj-sanctuary-bubble-user">
              {hasHeaderMeta ? (
                <div className="qj-user-structured-body">
                  {parsed.quotedText !== null && (
                    <blockquote className="qj-user-quote-card">
                      <span>{parsed.quotedText}</span>
                    </blockquote>
                  )}
                  {parsed.connectors.length > 0 && (
                    <div className="qj-user-connector-row" aria-label="已关联应用">
                      {parsed.connectors.map((conn) => (
                        <span key={conn.label} className="qj-user-connector-pill">
                          {conn.id !== null && <ConnectorBrandIcon id={conn.id} size={13} />}
                          <span>@{conn.label}</span>
                        </span>
                      ))}
                    </div>
                  )}
                  {hasMainText && <div className="qj-user-prose-line">{renderDirectiveAndProse()}</div>}
                </div>
              ) : (
                renderDirectiveAndProse()
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

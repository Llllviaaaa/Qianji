/**
 * Pure reasoning-tag sanitizer (`stripBotThinking`), quick-option extractor
 * (`extractBotQuickOptions`), and per-turn consecutive assistant message
 * collapser (`filterVisibleBotMessages`) for Bot Companion Chat.
 */

const ORPHAN_BOT_THINK_PREFIX_RE =
  /^(?:(?!(?:<(?:think(?:ing)?|thought)(?:\s|>)))[\s\S])*?<\/(?:think(?:ing)?|thought)\s*>\s*/i;
const CLOSED_BOT_THINK_RE = /<(think(?:ing)?|thought)(?:\s[^>]*)?>[\s\S]*?<\/\1\s*>/gi;
const UNCLOSED_BOT_THINK_RE = /<(?:think(?:ing)?|thought)(?:\s[^>]*)?>[\s\S]*$/i;
const STRAY_BOT_THINK_CLOSE_RE = /<\/(?:think(?:ing)?|thought)\s*>/gi;
const PARTIAL_BOT_THINK_EOF_RE =
  /<\/?(?:(?:think(?:ing)?|thought)\s[^>]*|t(?:h(?:i(?:n(?:k(?:i(?:n(?:g)?)?)?)?)?|o(?:u(?:g(?:h(?:t)?)?)?)?)?)?)$/i;

export function stripBotThinking(raw: string): string {
  if (!raw.includes("<")) return raw;
  return raw
    .replace(ORPHAN_BOT_THINK_PREFIX_RE, "")
    .replace(CLOSED_BOT_THINK_RE, "")
    .replace(UNCLOSED_BOT_THINK_RE, "")
    .replace(STRAY_BOT_THINK_CLOSE_RE, "")
    .replace(PARTIAL_BOT_THINK_EOF_RE, "")
    .trimStart();
}

export function extractBotQuickOptions(text: string): {
  readonly cleanBody: string;
  readonly options: readonly string[];
} {
  const closedMatch = /\[\[\s*options\s*:\s*([\s\S]*?)\]\]\s*$/i.exec(text);
  if (closedMatch !== null) {
    const rawList = closedMatch[1] ?? "";
    const options = rawList
      .split(/\||｜/)
      .map((part) => part.trim())
      .filter((part) => part.length > 0);
    const cleanBody = text.slice(0, closedMatch.index).trimEnd();
    return { cleanBody, options };
  }
  const openIdx = text.search(/\[\[\s*options\s*:/i);
  if (openIdx >= 0) {
    return { cleanBody: text.slice(0, openIdx).trimEnd(), options: [] };
  }
  return { cleanBody: text, options: [] };
}

function collapseBotAssistantGroup<
  T extends {
    readonly role: string;
    readonly content: string;
    readonly toolCalls?: readonly unknown[];
  },
>(group: readonly T[], groupStreaming: boolean): T | undefined {
  const lastMsg = group[group.length - 1];
  if (lastMsg === undefined) return undefined;

  for (let i = group.length - 1; i >= 0; i -= 1) {
    const msg = group[i];
    if (msg === undefined) continue;
    if ((msg.toolCalls?.length ?? 0) > 0) break;
    const cleaned = stripBotThinking(msg.content);
    if (cleaned.trim() !== "") {
      return cleaned === msg.content ? msg : { ...msg, content: cleaned };
    }
  }

  if (groupStreaming) {
    return lastMsg.content === "" ? lastMsg : { ...lastMsg, content: "" };
  }

  for (let i = group.length - 1; i >= 0; i -= 1) {
    const msg = group[i];
    if (msg === undefined) continue;
    const cleaned = stripBotThinking(msg.content);
    if (cleaned.trim() !== "") {
      return cleaned === msg.content ? msg : { ...msg, content: cleaned };
    }
  }
  return undefined;
}

export function filterVisibleBotMessages<
  T extends {
    readonly role: string;
    readonly content: string;
    readonly toolCalls?: readonly unknown[];
  },
>(messages: readonly T[], isStreaming: boolean): readonly T[] {
  const out: T[] = [];
  let assistantGroup: T[] = [];

  const flushGroup = (isTrailing: boolean) => {
    if (assistantGroup.length === 0) return;
    const collapsed = collapseBotAssistantGroup(assistantGroup, isStreaming && isTrailing);
    if (collapsed !== undefined) out.push(collapsed);
    assistantGroup = [];
  };

  for (const msg of messages) {
    if (msg.role === "assistant") {
      assistantGroup.push(msg);
    } else {
      flushGroup(false);
      if (msg.role === "user" || stripBotThinking(msg.content).trim() !== "") {
        out.push(msg);
      }
    }
  }
  flushGroup(true);
  return out;
}

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

const SKILL_PATH_EXTRACT_RE = /(?:^|[/\\])([^/\\]+)[/\\]SKILL\.md$/i;

function extractUsedSkillsFromGroup(
  group: ReadonlyArray<{ readonly toolCalls?: readonly unknown[] }>,
): readonly string[] | undefined {
  const seen = new Set<string>();
  for (const msg of group) {
    for (const rawCall of msg.toolCalls ?? []) {
      if (typeof rawCall !== "object" || rawCall === null) continue;
      const rec = rawCall as { name?: unknown; args?: Record<string, unknown> };
      const args = rec.args;
      if (!args || typeof args !== "object") continue;
      for (const key of ["path", "file", "filePath", "target_file"]) {
        const val = args[key];
        if (typeof val === "string") {
          const m = SKILL_PATH_EXTRACT_RE.exec(val.trim());
          if (m?.[1]) seen.add(m[1]);
        }
      }
    }
  }
  return seen.size > 0 ? [...seen] : undefined;
}

function collapseBotAssistantGroup<
  T extends {
    readonly role: string;
    readonly content: string;
    readonly toolCalls?: readonly unknown[];
    readonly usedSkills?: readonly string[];
  },
>(group: readonly T[], groupStreaming: boolean): T | undefined {
  const lastMsg = group[group.length - 1];
  if (lastMsg === undefined) return undefined;
  const usedSkills = !groupStreaming ? extractUsedSkillsFromGroup(group) : undefined;

  for (let i = group.length - 1; i >= 0; i -= 1) {
    const msg = group[i];
    if (msg === undefined) continue;
    if ((msg.toolCalls?.length ?? 0) > 0) break;
    const cleaned = stripBotThinking(msg.content);
    if (cleaned.trim() !== "") {
      if (cleaned === msg.content && usedSkills === undefined) return msg;
      return {
        ...msg,
        content: cleaned,
        ...(usedSkills !== undefined ? { usedSkills } : {}),
      };
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
      if (cleaned === msg.content && usedSkills === undefined) return msg;
      return {
        ...msg,
        content: cleaned,
        ...(usedSkills !== undefined ? { usedSkills } : {}),
      };
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

  for (let i = 0; i < messages.length; i += 1) {
    const msg = messages[i];
    if (msg === undefined) continue;
    if (msg.role === "assistant") {
      assistantGroup.push(msg);
      const isSettledStandaloneReply =
        (msg.toolCalls?.length ?? 0) === 0 && stripBotThinking(msg.content).trim() !== "";
      if (isSettledStandaloneReply && i < messages.length - 1) {
        flushGroup(false);
      }
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

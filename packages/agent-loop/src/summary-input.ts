/**
 * Shrinking and text-only serialization for compaction summaries (ADR 0019).
 *
 * Compaction in a run summarizes the branch with the session's model (ADR 0008).
 * Serializing history into a single plain-text `<conversation>` user message
 * prevents strict providers from rejecting wire `tool-call` / `tool-result` blocks
 * when `tools` are omitted, and fallback levels progressively clip long texts
 * and replace images with `[image omitted]`.
 */
import type { AssistantContent, Message, ToolResultContent, UserContent } from "@qianji/llm";
import { COMPACTION_CONTINUE_SUFFIX, COMPACTION_PREFIX } from "@qianji/session";

/** Longest text kept verbatim at each fallback level, in characters. */
export const SUMMARY_CLIP_LEVELS = [8_000, 1_000] as const;

export const IMAGE_OMITTED = "[image omitted]";

/** `text` cut to its first and last `max / 2` characters, with how much was left out. */
export function clipText(text: string, max: number): string {
  if (text.length <= max) return text;
  const half = Math.floor(max / 2);
  return `${text.slice(0, half)}\n[… ${text.length - 2 * half} characters omitted …]\n${text.slice(text.length - half)}`;
}

function clipValue(value: unknown, max: number): unknown {
  if (typeof value === "string") return clipText(value, max);
  if (Array.isArray(value)) return value.map((item) => clipValue(item, max));
  if (typeof value === "object" && value !== null) {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, clipValue(item, max)]));
  }
  return value;
}

function clipContent<T extends UserContent | ToolResultContent>(block: T, max: number): UserContent | ToolResultContent {
  if (block.type === "image") return { type: "text", text: IMAGE_OMITTED };
  return { type: "text", text: clipText(block.text, max) };
}

function omitImagesOnly<T extends UserContent | ToolResultContent>(block: T): UserContent | ToolResultContent {
  if (block.type === "image") return { type: "text", text: IMAGE_OMITTED };
  return block;
}

function clipAssistant(block: AssistantContent, max: number): AssistantContent {
  if (block.type !== "tool-call") return block;
  return { ...block, arguments: clipValue(block.arguments, max) as Record<string, unknown> };
}

/** `messages` with every long text clipped to `max` characters and images replaced by a note. */
export function shrinkForSummary(messages: readonly Message[], max: number): Message[] {
  return messages.map((message): Message => {
    if (message.role === "assistant") return { ...message, content: message.content.map((block) => clipAssistant(block, max)) };
    if (message.role === "user") return { ...message, content: message.content.map((block) => clipContent(block, max)) };
    return { ...message, content: message.content.map((block) => clipContent(block, max)) };
  });
}

/**
 * Prepare `messages` for summarization: always replace images with `[image omitted]`,
 * and enforce `maxTextChars` clipping budgets when specified.
 */
export function prepareSummaryMessages(messages: readonly Message[], maxTextChars?: number): Message[] {
  if (maxTextChars !== undefined) return shrinkForSummary(messages, maxTextChars);
  return messages.map((message): Message => {
    if (message.role === "assistant") return message;
    if (message.role === "user") return { ...message, content: message.content.map((block) => omitImagesOnly(block)) };
    return { ...message, content: message.content.map((block) => omitImagesOnly(block)) };
  });
}

function renderTextBlocks(blocks: ReadonlyArray<UserContent | ToolResultContent>): string {
  return blocks
    .map((block) => (block.type === "image" ? IMAGE_OMITTED : block.text))
    .filter((text) => text !== "")
    .join("\n");
}

function stripCompactionEnvelope(raw: string): string {
  let body = raw.startsWith(COMPACTION_PREFIX) ? raw.slice(COMPACTION_PREFIX.length) : raw;
  if (body.endsWith(COMPACTION_CONTINUE_SUFFIX)) {
    body = body.slice(0, body.length - COMPACTION_CONTINUE_SUFFIX.length);
  }
  return body.trim();
}

function formatAssistantTurn(content: readonly AssistantContent[]): string {
  const parts: string[] = [];
  for (const block of content) {
    if (block.type === "text") {
      if (block.text.trim() !== "") parts.push(block.text);
    } else if (block.type === "thinking") {
      const thinkingText = typeof block.text === "string" ? block.text : "";
      if (thinkingText.trim() !== "") parts.push(`[Thinking]: ${thinkingText}`);
    } else if (block.type === "tool-call") {
      parts.push(`[Tool call ${block.name} (${block.id})]: ${JSON.stringify(block.arguments)}`);
    }
  }
  return parts.join("\n");
}

/**
 * Serialize conversation messages into a pure-text `user` message (zero wire
 * `tool-call`/`tool-result`/`image` blocks). Any prior `COMPACTION_PREFIX`
 * summary is placed in `<previous-summary>...</previous-summary>` and turns in
 * `<conversation>...</conversation>`.
 */
export function serializeConversation(messages: readonly Message[], maxTextChars?: number): Message[] {
  const prepared = prepareSummaryMessages(messages, maxTextChars);
  if (prepared.length === 0) return [];

  const previousSummaries: string[] = [];
  const turns: string[] = [];

  for (const message of prepared) {
    if (message.role === "user") {
      const first = message.content[0];
      if (first?.type === "text" && first.text.startsWith(COMPACTION_PREFIX)) {
        const extracted = stripCompactionEnvelope(first.text);
        if (extracted !== "") previousSummaries.push(extracted);
        const rest = renderTextBlocks(message.content.slice(1)).trim();
        if (rest !== "") turns.push(`[User]: ${rest}`);
        continue;
      }
      const userText = renderTextBlocks(message.content).trim();
      if (userText !== "") turns.push(`[User]: ${userText}`);
    } else if (message.role === "assistant") {
      const assistantText = formatAssistantTurn(message.content).trim();
      if (assistantText !== "") turns.push(`[Assistant]: ${assistantText}`);
    } else {
      const resultText = renderTextBlocks(message.content).trim();
      const label = message.isError ? `${message.callId}, error` : message.callId;
      turns.push(`[Tool result (${label})]: ${resultText}`);
    }
  }

  const sections: string[] = [];
  if (previousSummaries.length > 0) {
    sections.push(`<previous-summary>\n${previousSummaries.join("\n\n")}\n</previous-summary>`);
  }
  if (turns.length > 0) {
    sections.push(`<conversation>\n${turns.join("\n\n")}\n</conversation>`);
  }
  if (sections.length === 0) return [];
  return [{ role: "user", content: [{ type: "text", text: sections.join("\n\n") }] }];
}

/**
 * Character-weighted token estimation for session events (ADR 0004, ADR 0022).
 * ASCII code units (<= 0x7f) count as 1/4 token; non-ASCII/CJK (> 0x7f) count
 * as 3/4 token so CJK prompts and tool outputs are accurately sized.
 */
import type { SessionEvent } from "./types.ts";

const CONTINUATION_NS = "qianji-continuation";
const IMAGE_BLOCK_TOKENS = 256;

/**
 * Estimate tokens for a text string: ASCII (`<= 0x7f`) counts as 1/4 token per
 * char and non-ASCII/CJK (`> 0x7f`) counts as 3/4 (0.75) token per char.
 */
export function charTokens(text: string): number {
  let quarterTokens = 0;
  for (let i = 0; i < text.length; i += 1) {
    quarterTokens += text.charCodeAt(i) <= 0x7f ? 1 : 3;
  }
  return quarterTokens / 4;
}

/** Estimate token count for a persisted session event. */
export function estimateEventTokens(event: SessionEvent): number {
  let tokens = 0;
  if (event.type === "user") {
    for (const block of event.data.content) {
      tokens += block.type === "text" ? charTokens(block.text) : IMAGE_BLOCK_TOKENS;
    }
  } else if (event.type === "assistant") {
    for (const block of event.data.content) {
      if (block.type === "text" || block.type === "thinking") tokens += charTokens(block.text);
      else if (block.type === "tool-call") {
        tokens += charTokens(block.name) + charTokens(JSON.stringify(block.arguments) ?? "{}");
      }
    }
  } else if (event.type === "tool-result") {
    for (const block of event.data.content) {
      tokens += block.type === "text" ? charTokens(block.text) : IMAGE_BLOCK_TOKENS;
    }
  } else if (event.type === "custom" && event.data.ns === CONTINUATION_NS) {
    tokens += charTokens(JSON.stringify(event.data.data) ?? "");
  }
  return Math.ceil(tokens);
}

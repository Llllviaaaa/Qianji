import { createHash } from "node:crypto";
import type { AssistantContent, Message, ThinkingBlock, ToolCallBlock } from "./types.ts";

export type TargetWireProtocol = "anthropic" | "gemini" | "openai-compat" | "openai-responses";

const HASH_HEX_CHARS = 8;

function maxToolCallIdLength(target: TargetWireProtocol): number {
  return target === "openai-compat" ? 40 : 64;
}

function shortHash(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, HASH_HEX_CHARS);
}

function hasNormalizedValue(seenMap: Map<string, string>, candidate: string): boolean {
  for (const existing of seenMap.values()) {
    if (existing === candidate) return true;
  }
  return false;
}

/**
 * Normalize a tool call ID for `target` wire constraints:
 * - Characters outside `[a-zA-Z0-9_-]` are replaced with `_`.
 * - Length is capped at `40` (`openai-compat`) or `64` (`anthropic` | `gemini` | `openai-responses`).
 * - Truncated or colliding raw IDs receive a deterministic short hash suffix,
 *   and `seenMap` maps identical raw IDs (`tool-call.id` and `tool-result.callId`) identically.
 */
export function normalizeToolCallId(
  id: string,
  target: TargetWireProtocol,
  seenMap?: Map<string, string>,
): string {
  const cached = seenMap?.get(id);
  if (cached !== undefined) return cached;

  const maxLen = maxToolCallIdLength(target);
  const replaced = id.replace(/[^a-zA-Z0-9_-]/g, "_");
  const base = replaced === "" ? `call_${shortHash(id)}` : replaced;

  const needsHashForLength = base.length > maxLen;
  const needsHashForCollision = seenMap !== undefined && hasNormalizedValue(seenMap, base);

  let normalized: string;
  if (!needsHashForLength && !needsHashForCollision) {
    normalized = base;
  } else {
    const hash = shortHash(id);
    const prefixLen = Math.max(0, maxLen - hash.length - 1);
    normalized = `${base.slice(0, prefixLen)}_${hash}`;
    let attempt = 0;
    while (seenMap !== undefined && hasNormalizedValue(seenMap, normalized)) {
      attempt += 1;
      const disambig = shortHash(`${id}#${attempt}`);
      const nextPrefixLen = Math.max(0, maxLen - disambig.length - 1);
      normalized = `${base.slice(0, nextPrefixLen)}_${disambig}`;
    }
  }

  seenMap?.set(id, normalized);
  return normalized;
}

function sanitizeToolCallArguments(args: Record<string, unknown>): Record<string, unknown> {
  const keys = Object.keys(args);
  if (keys.length === 1 && keys[0] === "__invalidJson" && typeof args.__invalidJson === "string") {
    return {};
  }
  return { ...args };
}

function cloneThinking(block: ThinkingBlock, includeSignature: boolean): ThinkingBlock {
  const next: ThinkingBlock = { type: "thinking", text: block.text };
  if (includeSignature && block.signature !== undefined) next.signature = block.signature;
  if (includeSignature && block.signatureProvider !== undefined) next.signatureProvider = block.signatureProvider;
  if (includeSignature && block.redacted !== undefined) next.redacted = block.redacted;
  return next;
}

function transformThinkingBlock(block: ThinkingBlock, target: TargetWireProtocol): AssistantContent[] {
  if (target === "anthropic") {
    const isForeign = block.signatureProvider !== undefined && block.signatureProvider !== "anthropic";
    if (isForeign) {
      return [];
    }
    if (block.redacted !== undefined || block.signature !== undefined) {
      return [cloneThinking(block, true)];
    }
    return [];
  }

  if (target === "gemini") {
    if (block.signatureProvider === undefined || block.signatureProvider === "gemini") {
      return [cloneThinking(block, true)];
    }
    if (block.text === "") return [];
    return [cloneThinking(block, false)];
  }

  if (block.text === "") return [];
  return [cloneThinking(block, false)];
}

/**
 * Normalize and isolate a canonical conversation history for `target` wire protocol:
 * - Normalizes `tool-call.id` and `tool-result.callId` deterministically across the conversation.
 * - Drops orphan `tool-result` messages whose `callId` was not seen in a preceding `assistant` `tool-call`.
 * - Sanitizes `{ __invalidJson: string }` historical tool-call arguments to `{}`.
 * - Isolates thinking signatures across providers so foreign signatures are never replayed.
 */
export function transformMessagesForProvider(
  messages: readonly Message[],
  target: TargetWireProtocol,
): Message[] {
  const idMap = new Map<string, string>();
  const seenRawCallIds = new Set<string>();
  const transformed: Message[] = [];

  for (const message of messages) {
    if (message.role === "user") {
      transformed.push({
        role: "user",
        content: message.content.map((block) => ({ ...block })),
      });
      continue;
    }

    if (message.role === "assistant") {
      const content: AssistantContent[] = [];
      for (const block of message.content) {
        if (block.type === "text") {
          content.push({ type: "text", text: block.text });
        } else if (block.type === "thinking") {
          content.push(...transformThinkingBlock(block, target));
        } else {
          const toolCall: ToolCallBlock = {
            type: "tool-call",
            id: normalizeToolCallId(block.id, target, idMap),
            name: block.name,
            arguments: sanitizeToolCallArguments(block.arguments),
          };
          seenRawCallIds.add(block.id);
          content.push(toolCall);
        }
      }
      if (content.length > 0) {
        transformed.push({ role: "assistant", content });
      }
      continue;
    }

    if (!seenRawCallIds.has(message.callId)) {
      continue;
    }
    transformed.push({
      role: "tool-result",
      callId: normalizeToolCallId(message.callId, target, idMap),
      content: message.content.map((block) => ({ ...block })),
      isError: message.isError,
    });
  }

  return transformed;
}

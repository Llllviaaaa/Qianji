import type { UiMessage, UiToolCall } from "../types";

export const INTERRUPTED_TURN = "这一轮因 Harness 断开而中断";

/** A call still running, or one a log records without its result. */
const unanswered = (call: UiToolCall): boolean => call.running || call.isError === undefined;

/**
 * Mark a turn's final `tool-use` assistant message as `isAborted` when every
 * tool call on it failed solely due to user abort, so reloaded sessions do not
 * mistake aborted tool runs for empty-prose completions.
 */
export function markAbortedToolUseAssistant(message: UiMessage | undefined): void {
  if (message === undefined || message.isError || message.stopReason !== "tool-use") return;
  const toolCalls = message.toolCalls;
  if (
    toolCalls !== undefined
    && toolCalls.length > 0
    && toolCalls.every((call) => {
      const text = call.result?.trim();
      return call.isError === true && (text === "Aborted." || text === "Aborted before the tool ran.");
    })
  ) {
    message.isAborted = true;
  }
}

/**
 * End a turn that stopped without finishing: its unanswered tool calls fail,
 * and its reply, the one streaming or a missing last one, is marked as an
 * error. A turn ends on a reply without tool calls; one that did is left as it is.
 */
export function interruptTurn(messages: UiMessage[], now = Date.now()): UiMessage[] {
  let last = messages.length - 1;
  while (last >= 0 && (messages[last].role === "notice" || messages[last].role === "terminal")) last -= 1;
  const reply = messages[last];
  if (reply === undefined) return messages;
  if (reply.role === "assistant" && !reply.isStreaming && (reply.toolCalls ?? []).length === 0) return messages;
  const turnStart = messages.findLastIndex((message) => message.role === "user");
  const next = messages.map((message, index) => {
    if (index < turnStart || !message.toolCalls?.some(unanswered)) return message;
    return {
      ...message,
      toolCalls: message.toolCalls.map((call) => (
        unanswered(call) ? { ...call, running: false, isError: true, result: INTERRUPTED_TURN, finishedAt: now } : call
      )),
    };
  });
  if (reply.role === "assistant" && reply.isStreaming) {
    const partial = next[last].content.trim();
    next[last] = {
      ...next[last],
      isStreaming: false,
      isError: true,
      content: partial === "" ? INTERRUPTED_TURN : `${partial}\n\n${INTERRUPTED_TURN}`,
    };
    return next;
  }
  return [...next, { id: `interrupted-${now}`, role: "assistant", content: INTERRUPTED_TURN, isError: true, timestamp: now }];
}

/** Settle a finished or stopped turn: drop empty streaming placeholders, clear streaming/running flags, and record terminal outcomes. */
export function settleStoppedTurn(messages: UiMessage[], now = Date.now(), outcome?: string): UiMessage[] {
  const last = messages[messages.length - 1];
  if (
    last?.role === "assistant"
    && last.isStreaming
    && !last.content.trim()
    && !last.thinking?.trim()
    && !last.toolCalls?.length
  ) {
    return settleStoppedTurn(messages.slice(0, -1), now, outcome);
  }
  const turnStart = Math.max(0, messages.findLastIndex((message) => message.role === "user"));
  const markStreamingAborted = outcome === undefined || outcome === "aborted";
  let changed = false;
  let next = messages.map((message, index) => {
    if (index < turnStart) return message;
    const hasRunning = message.toolCalls?.some((call) => call.running) === true;
    if (!message.isStreaming && !hasRunning) return message;
    changed = true;
    return {
      ...message,
      isStreaming: false,
      ...(message.isStreaming && markStreamingAborted && message.isAborted === undefined && !message.isError
        ? { isAborted: true }
        : {}),
      ...(hasRunning
        ? {
          toolCalls: message.toolCalls?.map((call) => (
            call.running ? { ...call, running: false, isError: call.isError ?? true, finishedAt: call.finishedAt ?? now } : call
          )),
        }
        : {}),
    };
  });

  let lastAssistantIndex = -1;
  for (let index = next.length - 1; index >= turnStart; index -= 1) {
    if (next[index]?.role === "assistant") {
      lastAssistantIndex = index;
      break;
    }
  }

  if (outcome === "aborted" && lastAssistantIndex >= 0) {
    const target = next[lastAssistantIndex];
    if (target !== undefined && !target.isError && target.isAborted !== true) {
      next[lastAssistantIndex] = { ...target, isAborted: true };
      changed = true;
    }
  } else if (outcome === "max-turns" && lastAssistantIndex >= 0) {
    const target = next[lastAssistantIndex];
    if (target !== undefined && target.stopReason !== "max-turns") {
      next[lastAssistantIndex] = { ...target, stopReason: "max-turns" };
      changed = true;
    }
  } else if (outcome === "error") {
    const hasTurnError = next.slice(turnStart).some((message) => message.role === "assistant" && message.isError === true);
    if (!hasTurnError) {
      if (lastAssistantIndex >= 0) {
        const target = next[lastAssistantIndex];
        if (target !== undefined) {
          next[lastAssistantIndex] = { ...target, isError: true };
          changed = true;
        }
      } else {
        next = [
          ...next,
          { id: `error-${now}`, role: "assistant", content: "本轮执行异常中断", isError: true, stopReason: "error", timestamp: now },
        ];
        changed = true;
      }
    }
  }

  return changed ? next : messages;
}

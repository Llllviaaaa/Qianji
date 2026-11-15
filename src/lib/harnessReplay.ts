/**
 * Mid-stream snapshot replay (P6d-2, docs/adr/0014): reconstructs the UI
 * transcript and `TranscriptTranslator` state from a `session.subscribe`
 * snapshot (`PersistedEvent[]` + live `AgentStatusInfo`) so reconnecting or
 * switching into a running task never drops active tool status, streamed
 * text/thinking, partial tool arguments, or queued counts.
 */
import type { AgentStatusInfo, PersistedEvent, SessionSubscribeResult } from "@qianji/protocol";
import type { UiMessage } from "../types";
import {
  TranscriptTranslator,
  historyToUi,
  interruptTurn,
  resetStreamingAssistant,
  startAssistant,
  startToolCall,
  streamAssistant,
  updateToolCall,
  type TranscriptEvent,
} from "./transcript";

const IDLE_STATUS: AgentStatusInfo = {
  running: false,
  streaming: [],
  runningTools: [],
  queue: { steer: 0, followUp: 0 },
};

const hasToolCall = (messages: readonly UiMessage[], callId: string): boolean =>
  messages.some((message) => message.toolCalls?.some((call) => call.id === callId) === true);

function applyReplayChunkEvents(messages: UiMessage[], events: readonly TranscriptEvent[]): UiMessage[] {
  let next = messages;
  for (const event of events) {
    if (event.type === "assistant-delta") {
      next = streamAssistant(next, { text: event.text, thinking: event.thinking });
    } else if (event.type === "assistant-tool-calls") {
      next = streamAssistant(next, { toolCalls: event.calls });
    } else if (event.type === "retry-status") {
      next = resetStreamingAssistant(next);
    }
  }
  return next;
}

/**
 * Rebuild the full UI transcript and seeded `TranscriptTranslator` from a
 * `session.subscribe` response. When the run is still active, marks running
 * tools and replays in-flight `streaming` chunks onto the trailing streaming
 * assistant message.
 */
export function replaySessionToUi(replay: SessionSubscribeResult): {
  messages: UiMessage[];
  translator: TranscriptTranslator;
  queueEvent?: TranscriptEvent;
} {
  let messages = historyToUi(replay.events);
  const translator = new TranscriptTranslator();
  const status = replay.status;
  const steer = status?.queue?.steer ?? 0;
  const followUp = status?.queue?.followUp ?? 0;
  const queueEvent: TranscriptEvent | undefined =
    steer > 0 || followUp > 0 ? { type: "queue", steering: steer, followUp } : undefined;

  if (!status?.running) {
    return {
      messages: interruptTurn(messages),
      translator,
      ...(queueEvent ? { queueEvent } : {}),
    };
  }

  for (const tool of status.runningTools ?? []) {
    if (hasToolCall(messages, tool.callId)) {
      messages = updateToolCall(
        messages,
        tool.callId,
        (call) => ({ ...call, running: true }),
        tool.name,
      );
    } else {
      messages = startToolCall(messages, tool.callId, tool.name, {});
    }
  }

  const streaming = status.streaming ?? [];
  if (streaming.length > 0) {
    translator.delta({ type: "llm-start" });
    messages = startAssistant(messages);
    for (const chunk of streaming) {
      const events = translator.delta({ type: "llm-chunk", chunk });
      messages = applyReplayChunkEvents(messages, events);
    }
  }

  return {
    messages,
    translator,
    ...(queueEvent ? { queueEvent } : {}),
  };
}

/** Convert persisted events plus optional live agent status into UI messages. */
export function replayToUi(events: readonly PersistedEvent[], status?: AgentStatusInfo): UiMessage[] {
  return replaySessionToUi({
    events: [...events],
    status: status ?? IDLE_STATUS,
    liveSeq: 0,
  }).messages;
}

/** Seed a `TranscriptTranslator` from an active `AgentStatusInfo` snapshot (used on `attach`). */
export function seedTranslatorFromStatus(status: AgentStatusInfo): TranscriptTranslator {
  const translator = new TranscriptTranslator();
  if (status?.running && (status.streaming?.length ?? 0) > 0) {
    translator.delta({ type: "llm-start" });
    for (const chunk of status.streaming) {
      translator.delta({ type: "llm-chunk", chunk });
    }
  }
  return translator;
}

/**
 * Build live `TranscriptEvent`s to restore an active turn after a reconnect
 * without duplicating text already accumulated in the store before disconnect.
 */
export function buildResumeEvents(status: AgentStatusInfo, translator: TranscriptTranslator): TranscriptEvent[] {
  if (!status?.running) return [];
  const events: TranscriptEvent[] = [];
  const streaming = status.streaming ?? [];
  if (streaming.length > 0) {
    events.push(...translator.delta({ type: "llm-start" }));
    const chunkEvents: TranscriptEvent[] = [];
    for (const chunk of streaming) {
      chunkEvents.push(...translator.delta({ type: "llm-chunk", chunk }));
    }
    const hasContentDelta = chunkEvents.some(
      (event) => event.type === "assistant-delta" || event.type === "assistant-tool-calls",
    );
    if (hasContentDelta && chunkEvents[0]?.type !== "retry-status") {
      // Clear any pre-disconnect partial stream text before replaying the Host's full active buffer.
      events.push({ type: "retry-status", text: "" });
    }
    events.push(...chunkEvents);
  }
  if (status.queue !== undefined) {
    events.push({ type: "queue", steering: status.queue.steer, followUp: status.queue.followUp });
  }
  return events;
}

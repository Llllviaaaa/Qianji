/**
 * Branch filtering, session list summarization, custom-event queries, and
 * Markdown export over append-only session event logs (ADR 0004).
 */
import type { SessionEvent, SessionHeader, SessionModelUsage, SessionSummary } from "./types.ts";

const FIRST_MESSAGE_CHARS = 200;

/**
 * The events on the current branch, in order: each `rewind` drops the
 * branch's events after its `toSeq`. `rewind` events themselves are left out.
 */
export function currentBranch(events: readonly SessionEvent[]): SessionEvent[] {
  let branch: SessionEvent[] = [];
  for (const event of events) {
    if (event.type === "rewind") {
      const { toSeq } = event.data;
      branch = branch.filter((kept) => kept.seq <= toSeq);
    } else {
      branch.push(event);
    }
  }
  return branch;
}

function isActivityEvent(event: SessionEvent): boolean {
  return event.type !== "label" && event.type !== "model" && event.type !== "effort";
}

export function summarize(header: SessionHeader, events: readonly SessionEvent[]): SessionSummary {
  let title: string | undefined;
  let archived = false;
  let firstMessage: string | undefined;
  let messageCount = 0;
  const usage: SessionSummary["usage"] = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };
  let reasoningTokens = 0;
  const byModel = new Map<string, SessionModelUsage>();
  for (const event of events) {
    if (event.type === "user") {
      messageCount += 1;
    } else if (event.type === "assistant") {
      messageCount += 1;
      const evUsage = event.data.usage;
      usage.inputTokens += evUsage.inputTokens ?? 0;
      usage.outputTokens += evUsage.outputTokens ?? 0;
      usage.cacheReadTokens += evUsage.cacheReadTokens ?? 0;
      usage.cacheWriteTokens += evUsage.cacheWriteTokens ?? 0;
      if (typeof evUsage.reasoningTokens === "number" && evUsage.reasoningTokens > 0) {
        reasoningTokens += evUsage.reasoningTokens;
      }
      const modelKey = `${event.data.model.provider}/${event.data.model.model}`;
      let bucket = byModel.get(modelKey);
      if (bucket === undefined) {
        bucket = {
          provider: event.data.model.provider,
          model: event.data.model.model,
          usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
        };
        byModel.set(modelKey, bucket);
      }
      bucket.usage.inputTokens += evUsage.inputTokens ?? 0;
      bucket.usage.outputTokens += evUsage.outputTokens ?? 0;
      bucket.usage.cacheReadTokens += evUsage.cacheReadTokens ?? 0;
      bucket.usage.cacheWriteTokens += evUsage.cacheWriteTokens ?? 0;
      if (typeof evUsage.reasoningTokens === "number" && evUsage.reasoningTokens > 0) {
        bucket.usage.reasoningTokens = (bucket.usage.reasoningTokens ?? 0) + evUsage.reasoningTokens;
      }
    }
  }
  if (reasoningTokens > 0) usage.reasoningTokens = reasoningTokens;
  for (const event of currentBranch(events)) {
    if (event.type === "user" && firstMessage === undefined) {
      const nonMeta = event.data.content.flatMap((block) => (block.type === "text" && block.meta !== true ? [block.text] : []));
      const source = nonMeta.length > 0 ? nonMeta : event.data.content.flatMap((block) => (block.type === "text" ? [block.text] : []));
      const text = source.join(" ").replace(/\s+/g, " ").trim();
      if (text !== "") firstMessage = text.slice(0, FIRST_MESSAGE_CHARS);
    } else if (event.type === "label") {
      if (event.data.title !== undefined) title = event.data.title;
      if (event.data.archived !== undefined) archived = event.data.archived;
    }
  }
  const last = events.at(-1);
  const lastActivity = events.findLast(isActivityEvent);
  return {
    id: header.id,
    cwd: header.cwd,
    createdAt: header.createdAt,
    updatedAt: lastActivity?.ts ?? header.createdAt,
    ...(title === undefined ? {} : { title }),
    ...(firstMessage === undefined ? {} : { firstMessage }),
    archived,
    lastSeq: last?.seq ?? 0,
    messageCount,
    usage,
    ...(byModel.size > 0 ? { modelUsage: [...byModel.values()] } : {}),
    ...(header.forkedFrom === undefined ? {} : { forkedFrom: header.forkedFrom }),
    ...(header.parent === undefined ? {} : { parent: header.parent }),
    ...(header.side === true ? { side: true as const } : {}),
  };
}

/** The data of the latest `custom` event of `ns` (or any in `ns`) on the current branch: a plugin's session state. */
export function latestCustom<T = unknown>(events: readonly SessionEvent[], ns: string | readonly string[]): T | undefined {
  const allowed = typeof ns === "string" ? new Set([ns]) : new Set(ns);
  const branch = currentBranch(events);
  for (let index = branch.length - 1; index >= 0; index -= 1) {
    const event = branch[index];
    if (event?.type === "custom" && allowed.has(event.data.ns)) return event.data.data as T;
  }
  return undefined;
}

/** Every `custom` event of `ns` (or any in `ns`) on the current branch, oldest first. */
export function customEvents(events: readonly SessionEvent[], ns: string | readonly string[]): Array<Extract<SessionEvent, { type: "custom" }>> {
  const allowed = typeof ns === "string" ? new Set([ns]) : new Set(ns);
  return currentBranch(events).filter((event): event is Extract<SessionEvent, { type: "custom" }> => event.type === "custom" && allowed.has(event.data.ns));
}

/**
 * The current branch as Markdown: each user and assistant message's text
 * under a heading, the format the desktop has always exported.
 */
export function sessionMarkdown(events: readonly SessionEvent[]): string {
  let output = "# Qianji conversation\n\n";
  for (const event of currentBranch(events)) {
    if (event.type !== "user" && event.type !== "assistant") continue;
    const blocks = event.type === "user"
      ? event.data.content.flatMap((block) => (block.type === "text" && block.meta !== true ? [block.text] : []))
      : event.data.content.flatMap((block) => (block.type === "text" ? [block.text] : []));
    const text = blocks.join("").trim();
    if (text !== "") output += `## ${event.type === "user" ? "User" : "Assistant"}\n\n${text}\n\n`;
  }
  return output;
}

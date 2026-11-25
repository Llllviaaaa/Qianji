/**
 * Settled conversation prefix cloning (`forkContext: true`) so explorer/reviewer
 * subagents inherit the parent's settled history and upstream prompt-cache prefix.
 */
import {
  currentBranch,
  forkEvents,
  settledSeq,
  type Session,
  type SessionEvent,
  type SessionHeader,
} from "@qianji/session";

export interface ForkedSubagentSeed {
  forkedFrom?: SessionHeader["forkedFrom"];
  events: SessionEvent[];
}

/**
 * Clone `parent`'s current branch up to `settledSeq`, stepping back past any
 * trailing in-flight `assistant` event whose `tool-call` blocks have not all
 * received `tool-result` events yet (such as the active `delegate_task` or
 * `spawn_agent` invocation itself).
 */
export function buildForkedContextSeed(parent: Session): ForkedSubagentSeed {
  const lastSeq = parent.events.at(-1)?.seq ?? 0;
  if (lastSeq <= 0) return { events: [] };

  const branch = currentBranch(parent.events);
  let targetSeq = settledSeq(parent.events, lastSeq);

  while (targetSeq > 0) {
    const idx = branch.findIndex((event) => event.seq === targetSeq);
    const candidate = idx >= 0 ? branch[idx] : undefined;
    if (candidate === undefined) break;
    if (candidate.type === "assistant") {
      const callIds = candidate.data.content
        .filter((block): block is Extract<typeof block, { type: "tool-call" }> => block.type === "tool-call")
        .map((block) => block.id);
      if (callIds.length > 0) {
        const answered = new Set<string>();
        for (let i = idx + 1; i < branch.length; i += 1) {
          const ev = branch[i];
          if (ev === undefined || ev.seq > targetSeq) break;
          if (ev.type === "tool-result") answered.add(ev.data.callId);
        }
        if (callIds.some((id) => !answered.has(id))) {
          targetSeq = idx > 0 ? (branch[idx - 1]?.seq ?? 0) : 0;
          continue;
        }
      }
    }
    break;
  }

  if (targetSeq <= 0) return { events: [] };
  return {
    forkedFrom: { sessionId: parent.id, seq: targetSeq },
    events: forkEvents(parent.events, targetSeq),
  };
}

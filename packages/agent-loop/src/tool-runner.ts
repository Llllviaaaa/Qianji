/**
 * Tool batch partitioning and bounded-concurrency execution for the agent loop:
 * groups consecutive concurrency-safe calls into rolling worker-pool batches
 * separated by serial mutating barriers, preempts unstarted batches (including
 * batch 0) when user steering is queued, passes `steeringSignal` to cooperative
 * tools, emits per-call `tool-end` deltas immediately on completion, and appends
 * `tool-result` events in deterministic call order.
 */
import type { AgentDelta } from "@qianji/agent";
import type { ToolCallBlock } from "@qianji/llm";
import type { Session } from "@qianji/session";
import { ACTIVATE_TOOLS_NAME, textOutput, type ToolEnv, type ToolOutput, type Tools } from "@qianji/tools";

export const DEFAULT_MAX_PARALLEL_TOOLS = 8;
export const STEER_SKIPPED_MESSAGE = "Skipped due to queued user steering message.";

export interface IndexedCall {
  call: ToolCallBlock;
  index: number;
}

export type ToolRunnerRegistry = Pick<Tools, "get" | "execute"> & Partial<Pick<Tools, "isConcurrencySafe">>;

export interface RunToolBatchesOptions {
  session: Session;
  tools: ToolRunnerRegistry;
  calls: readonly ToolCallBlock[];
  signal: AbortSignal;
  steeringSignal?: AbortSignal;
  maxParallelTools?: number;
  runningTools: Map<string, string>;
  hasSteer: () => boolean;
  delta: (delta: AgentDelta) => void;
}

export function isConcurrencySafeTool(tools: ToolRunnerRegistry, call: ToolCallBlock, sessionId?: string): boolean {
  if (typeof tools.isConcurrencySafe === "function") {
    return tools.isConcurrencySafe(call.name, call.arguments, sessionId);
  }
  return call.name === ACTIVATE_TOOLS_NAME || tools.get(call.name)?.readOnly === true;
}

/** Group consecutive concurrency-safe calls into concurrent batches separated by serial barriers. */
export function partitionToolBatches(
  calls: readonly ToolCallBlock[],
  isConcurrencySafe: (call: ToolCallBlock) => boolean,
): IndexedCall[][] {
  const batches: IndexedCall[][] = [];
  let currentConcurrent: IndexedCall[] | undefined;
  for (const [index, call] of calls.entries()) {
    const item: IndexedCall = { call, index };
    if (isConcurrencySafe(call)) {
      if (currentConcurrent === undefined) {
        currentConcurrent = [item];
        batches.push(currentConcurrent);
      } else {
        currentConcurrent.push(item);
      }
    } else {
      currentConcurrent = undefined;
      batches.push([item]);
    }
  }
  return batches;
}

export async function runToolBatches(options: RunToolBatchesOptions): Promise<void> {
  const { session, tools, calls, signal, steeringSignal, runningTools, hasSteer, delta } = options;
  const concurrencyCap = Math.max(1, options.maxParallelTools ?? DEFAULT_MAX_PARALLEL_TOOLS);

  for (const call of calls) {
    session.append("tool-call", { callId: call.id, name: call.name, args: call.arguments });
  }

  const batches = partitionToolBatches(calls, (call) => isConcurrencySafeTool(tools, call, session.id));
  const outputs: Array<ToolOutput | undefined> = new Array(calls.length);
  const emittedEnds = new Set<string>();

  const runSingleCall = async ({ call, index }: IndexedCall): Promise<void> => {
    runningTools.set(call.id, call.name);
    delta({ type: "tool-start", callId: call.id, name: call.name });
    let settled = false;
    const env: ToolEnv = {
      sessionId: session.id,
      cwd: session.header.cwd,
      signal,
      ...(steeringSignal === undefined ? {} : { steeringSignal }),
      onProgress: (text) => {
        if (!settled && !signal.aborted) {
          delta({ type: "tool-progress", callId: call.id, name: call.name, text });
        }
      },
    };
    try {
      outputs[index] = await tools.execute({ id: call.id, name: call.name, args: { ...call.arguments } }, env);
    } catch (error) {
      const msg = signal.aborted ? "Aborted." : `${call.name} failed: ${error instanceof Error ? error.message : String(error)}`;
      outputs[index] = textOutput(msg, true);
    } finally {
      settled = true;
      runningTools.delete(call.id);
      emittedEnds.add(call.id);
      delta({ type: "tool-end", callId: call.id, isError: outputs[index]?.isError === true });
    }
  };

  try {
    for (const [batchIndex, batch] of batches.entries()) {
      if (signal.aborted) break;
      if (!signal.aborted && hasSteer()) {
        for (const remaining of batches.slice(batchIndex)) {
          for (const { call, index } of remaining) {
            outputs[index] = textOutput(STEER_SKIPPED_MESSAGE, true);
            emittedEnds.add(call.id);
            delta({ type: "tool-end", callId: call.id, isError: true });
          }
        }
        break;
      }
      const workerCount = Math.min(batch.length, concurrencyCap);
      let cursor = 0;
      await Promise.all(
        Array.from({ length: workerCount }, async () => {
          while (!signal.aborted) {
            const item = batch[cursor];
            cursor += 1;
            if (item === undefined) break;
            await runSingleCall(item);
          }
        }),
      );
    }
  } finally {
    // Deterministic log order: every tool-call gets a matching tool-result even on failure/interruption.
    for (const [index, call] of calls.entries()) {
      const output = outputs[index] ?? textOutput(signal.aborted ? "Aborted." : "Tool execution interrupted.", true);
      session.append("tool-result", {
        callId: call.id,
        name: call.name,
        content: output.content,
        isError: output.isError === true,
      });
      runningTools.delete(call.id);
      if (!emittedEnds.has(call.id)) {
        emittedEnds.add(call.id);
        delta({ type: "tool-end", callId: call.id, isError: output.isError === true });
      }
    }
  }
}

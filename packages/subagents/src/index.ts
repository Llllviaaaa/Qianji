/**
 * The `delegate_task` tool and persistent background collaboration tools
 * (ADR 0010, ADR 0022, ADR 0024): run isolated child sessions with per-role
 * model routing, `forkContext` prefix sharing, trusted verification shell
 * access, and dirty-aware Git worktree isolation.
 */
import type { Context } from "@deepseek-ai/cordis";
import "@qianji/agent";
import type { Session } from "@qianji/session";
import { textOutput, type ToolDefinition, type ToolEnv } from "@qianji/tools";
import type {} from "@qianji/ui";
import { spawnConfiguredChild, type Config } from "./child-session.ts";
import { registerCollabTools } from "./collab.ts";
import {
  normalizeSubagentTasks,
  subagentPrompt,
  type SubagentPermission,
  type SubagentRole,
  type SubagentTask,
} from "./core.ts";
import { readStructuredAnswer, structuredInstruction, structuredRetry, type JsonSchema } from "./structured.ts";
import {
  applyOrSaveWorktreePatch,
  cleanupWorktree,
  collectWorktreePatch,
  type CollectedWorktreePatch,
  type WorktreePatchResult,
} from "./worktree.ts";

export * from "./child-session.ts";
export * from "./collab.ts";
export * from "./core.ts";
export { buildForkedContextSeed, type ForkedSubagentSeed } from "./fork-context.ts";
export * from "./structured.ts";
export {
  applyOrSaveWorktreePatch,
  cleanupWorktree,
  collectWorktreePatch,
  prepareIsolatedWorktree,
  type CollectedWorktreePatch,
  type PreparedWorktree,
  type WorktreePatchResult,
} from "./worktree.ts";

export const name = "qianji-subagents";
export const inject = ["sessions", "tools", "agents"];

export interface SubagentResult extends SubagentTask {
  sessionId: string;
  ok: boolean;
  output: string;
  /** The parsed answer, when the call passed an `outputSchema` and the answer matched it. */
  structured?: unknown;
  /** Present when `isolateWorktree: true` was used for this task. */
  patch?: WorktreePatchResult;
  error: string;
}

export interface RunSubagentOptions {
  schema?: JsonSchema;
  allowShell?: boolean;
  isolateWorktree?: boolean;
  forkContext?: boolean;
}

type Status = "queued" | "running" | "completed" | "failed";

function finalText(session: Session, afterSeq = 0): string {
  const last = session.events.findLast((event) => event.seq > afterSeq && event.type === "assistant");
  if (last?.type !== "assistant") return "";
  return last.data.content.flatMap((block) => (block.type === "text" ? [block.text] : [])).join("\n").trim();
}

async function mapWithConcurrency<T, R>(items: T[], concurrency: number, fn: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (next < items.length) {
      const index = next;
      next += 1;
      results[index] = await fn(items[index] as T, index);
    }
  }));
  return results;
}

interface InternalRunOutcome {
  result: SubagentResult;
  collectedPatch?: { repoRoot: string; patch: CollectedWorktreePatch };
}

function isJsonSchemaArg(value: JsonSchema | RunSubagentOptions | undefined): value is JsonSchema {
  if (value === undefined) return false;
  return !("schema" in value) && !("allowShell" in value) && !("isolateWorktree" in value) && !("forkContext" in value);
}

async function runSubagentInternal(
  ctx: Context,
  parent: Session,
  task: SubagentTask,
  permission: SubagentPermission,
  env: ToolEnv,
  config: Config,
  opts: RunSubagentOptions,
): Promise<InternalRunOutcome> {
  const spawned = await spawnConfiguredChild(ctx, parent, {
    label: task.label,
    task: task.task,
    role: task.role,
    permission,
    allowShell: opts.allowShell,
    isolateWorktree: opts.isolateWorktree,
    forkContext: opts.forkContext,
    callId: env.callId,
    signal: env.signal,
  }, config);
  if (!spawned.ok) {
    return { result: { ...task, sessionId: "", ok: false, output: "", error: spawned.error } };
  }

  const { child, prepared, allowShell, disposeRestrictions } = spawned;
  const base = { ...task, sessionId: child.id };
  const abort = () => void ctx.agents.abort(child.id);
  env.signal.addEventListener("abort", abort, { once: true });
  let outcome = "error";
  try {
    if (env.signal.aborted) return { result: { ...base, ok: false, output: "", error: "Aborted" } };
    const off = ctx.on("agent/settled", async (session, status) => {
      if (session === child) outcome = status;
    });
    const ask = async (text: string): Promise<string> => {
      const baselineSeq = child.lastSeq;
      ctx.agents.prompt(child, [{ type: "text", text }]);
      await ctx.agents.idle(child.id);
      return finalText(child, baselineSeq);
    };
    let output: string;
    let structured: ReturnType<typeof readStructuredAnswer> | undefined;
    try {
      const promptText = subagentPrompt(task, { allowShell, isolatedWorktree: prepared !== undefined });
      output = await ask(opts.schema === undefined ? promptText : `${promptText}\n\n${structuredInstruction(opts.schema)}`);
      if (opts.schema !== undefined && outcome === "done") {
        structured = readStructuredAnswer(output, opts.schema);
        if (!structured.ok && !env.signal.aborted) {
          output = await ask(structuredRetry(structured.error));
          if (outcome === "done") structured = readStructuredAnswer(output, opts.schema);
        }
      }
    } finally {
      off();
    }

    let collectedPatch: { repoRoot: string; patch: CollectedWorktreePatch } | undefined;
    if (prepared !== undefined && outcome === "done" && !env.signal.aborted) {
      const patch = await collectWorktreePatch({ wtRoot: prepared.wtRoot, baseHead: prepared.baseHead, childId: child.id });
      if (!patch.empty) collectedPatch = { repoRoot: prepared.repoRoot, patch };
    }

    if (outcome === "done" && output !== "") {
      if (structured === undefined) return { result: { ...base, ok: true, output, error: "" }, collectedPatch };
      if (structured.ok) return { result: { ...base, ok: true, output, structured: structured.value, error: "" }, collectedPatch };
      return { result: { ...base, ok: false, output, error: `Structured result rejected: ${structured.error}` }, collectedPatch };
    }
    const error = outcome === "done" ? "Subagent returned no assistant text" : `Subagent ended: ${outcome}`;
    return { result: { ...base, ok: false, output, error }, collectedPatch };
  } finally {
    env.signal.removeEventListener("abort", abort);
    disposeRestrictions();
    if (prepared !== undefined) {
      await cleanupWorktree(prepared.repoRoot, prepared.wtRoot);
    }
  }
}

export async function runSubagent(
  ctx: Context,
  parent: Session,
  task: SubagentTask,
  permission: SubagentPermission,
  env: ToolEnv,
  config: Config,
  schemaOrOptions?: JsonSchema | RunSubagentOptions,
): Promise<SubagentResult> {
  const opts: RunSubagentOptions = isJsonSchemaArg(schemaOrOptions)
    ? { schema: schemaOrOptions }
    : (schemaOrOptions ?? {});
  const { result } = await runSubagentInternal(ctx, parent, task, permission, env, config, opts);
  return result;
}

export function delegateTool(ctx: Context, config: Config): ToolDefinition<{
  task?: string;
  role?: SubagentRole;
  tasks?: Array<Partial<SubagentTask>>;
  permission?: SubagentPermission;
  allowShell?: boolean;
  isolateWorktree?: boolean;
  forkContext?: boolean;
  applyChanges?: boolean;
  outputSchema?: JsonSchema;
}> {
  const concurrency = Math.max(1, Math.min(4, config.concurrency ?? 3));
  return {
    name: "delegate_task",
    timeoutMs: 0,
    isConcurrencySafe: (args) => args.permission !== "workspace-write",
    description: [
      "Run one isolated subagent or up to eight independent subagents in parallel; each gets a fresh context (or settled parent prefix when `forkContext: true`) and returns its final answer.",
      "Use it only when an isolated context or independent parallel investigation materially helps.",
      "Default to read-only. Request workspace-write for workers that must edit files; pass `allowShell: true` only when verification commands/diagnostics are needed, and `isolateWorktree: true` when parallel workers should edit in separate Git worktrees before applying patches sequentially.",
      "Pass outputSchema (a JSON Schema) when you need structured JSON answers.",
    ].join(" "),
    parameters: {
      type: "object",
      properties: {
        task: { type: "string", description: "One delegated task" },
        role: { type: "string", enum: ["explorer", "planner", "reviewer", "worker"] },
        tasks: {
          type: "array",
          maxItems: 8,
          description: "Independent tasks to run in parallel",
          items: {
            type: "object",
            properties: {
              label: { type: "string", description: "Short display label" },
              task: { type: "string", description: "Self-contained delegated task" },
              role: { type: "string", enum: ["explorer", "planner", "reviewer", "worker"] },
            },
            required: ["task"],
          },
        },
        permission: { type: "string", enum: ["read-only", "workspace-write"] },
        allowShell: { type: "boolean", description: "When permission is workspace-write, grant verification shell and diagnostics tools" },
        isolateWorktree: { type: "boolean", description: "When permission is workspace-write, run each subagent in a temporary Git worktree and collect patches" },
        forkContext: { type: "boolean", description: "Clone the parent session's settled conversation prefix into each subagent" },
        applyChanges: { type: "boolean", description: "When isolateWorktree is true, automatically apply clean patches sequentially back to the repo (default true)" },
        outputSchema: { type: "object", description: "JSON Schema every subagent's final answer must match; the answers then come back as JSON" },
      },
    },
    async execute({ task, role, tasks: many, permission: requested, allowShell, isolateWorktree, forkContext, applyChanges, outputSchema }, env) {
      if (outputSchema !== undefined && (typeof outputSchema !== "object" || outputSchema === null || Array.isArray(outputSchema))) {
        return textOutput("outputSchema must be a JSON Schema object.", true);
      }
      const parent = await ctx.sessions.get(env.sessionId);
      if (parent === undefined) return textOutput("No session to delegate from.", true);
      const raw = many?.length ? many : task ? [{ label: role ?? "subagent", task, role: role ?? "explorer" }] : [];
      let tasks: SubagentTask[];
      try {
        tasks = normalizeSubagentTasks(raw);
      } catch (error) {
        return textOutput((error as Error).message, true);
      }
      const permission: SubagentPermission = requested === "workspace-write" ? "workspace-write" : "read-only";
      const statuses: Status[] = tasks.map(() => "queued");
      const sessions: Array<string | undefined> = tasks.map(() => undefined);
      const publish = () => parent.delta({
        type: "subagents",
        callId: env.callId,
        permission,
        tasks: tasks.map((item, index) => ({ ...item, status: statuses[index], sessionId: sessions[index] })),
      });
      const outcomes = await mapWithConcurrency(tasks, concurrency, async (item, index) => {
        if (env.signal.aborted) {
          return { result: { ...item, sessionId: "", ok: false, output: "", error: "Aborted" } };
        }
        statuses[index] = "running";
        publish();
        const itemOutcome = await runSubagentInternal(ctx, parent, item, permission, env, config, {
          ...(outputSchema === undefined ? {} : { schema: outputSchema }),
          allowShell,
          isolateWorktree,
          forkContext,
        });
        sessions[index] = itemOutcome.result.sessionId;
        statuses[index] = itemOutcome.result.ok ? "completed" : "failed";
        publish();
        return itemOutcome;
      });

      const results: SubagentResult[] = [];
      for (const itemOutcome of outcomes) {
        const res = itemOutcome.result;
        if (itemOutcome.collectedPatch !== undefined && itemOutcome.collectedPatch.patch.patchBuffer !== undefined) {
          const patch = await applyOrSaveWorktreePatch({
            repoRoot: itemOutcome.collectedPatch.repoRoot,
            label: res.label,
            childId: res.sessionId,
            changedFiles: itemOutcome.collectedPatch.patch.changedFiles,
            patchBuffer: itemOutcome.collectedPatch.patch.patchBuffer,
            applyChanges: applyChanges !== false,
          });
          res.patch = patch;
          const patchNote = patch.applied
            ? `[Worktree patch applied: ${patch.changedFiles.join(", ")}]`
            : patch.conflict
              ? `[Worktree patch conflicted (${patch.reason ?? "conflict"}); saved to ${patch.patchFile}]`
              : `[Worktree patch saved (not applied): ${patch.patchFile}]`;
          res.output = res.output ? `${res.output}\n\n${patchNote}` : patchNote;
        }
        results.push(res);
      }

      const successful = results.filter((result) => result.ok).length;
      const answer = (result: SubagentResult): string => {
        if (!result.ok) return result.error;
        return result.structured === undefined ? result.output : `\`\`\`json\n${JSON.stringify(result.structured, null, 2)}\n\`\`\``;
      };
      const text = results
        .map((result) => `### ${result.label} (${result.role}) - ${result.ok ? "completed" : "failed"}\n\n${answer(result)}`)
        .join("\n\n---\n\n");
      return {
        content: [{ type: "text", text: `${successful}/${results.length} subagents completed.\n\n${text}` }],
        isError: successful === 0,
        details: { permission, results },
      };
    },
  };
}

export function apply(ctx: Context, config: Config = {}): void {
  ctx.effect(() => ctx.tools.register(delegateTool(ctx, config)), `${name}: delegate_task`);
  ctx.effect(
    () =>
      registerCollabTools(ctx, {
        maxActiveAgents: config.maxActiveAgents,
        maxDepth: config.maxDepth,
        spawnChild: (parent, input) => spawnConfiguredChild(ctx, parent, input, config),
      }),
    `${name}: collab_tools`,
  );
}

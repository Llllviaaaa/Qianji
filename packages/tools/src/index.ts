/**
 * The tool registry and execution pipeline (ADR 0003, 0008):
 *
 * 1. `tools/pre-execute` (async bail): the first listener to return a
 *    decision wins; none means allow.
 * 2. `tools/execute` (waterfall): wraps the call, e.g. checkpoints, timeouts,
 *    output truncation; the innermost `next` runs the tool. `env` belongs to
 *    this call alone, so a listener may replace `env.signal` (to add a
 *    deadline, say) for the listeners and the tool below it, restoring it after.
 * 3. `tools/result` (emit): observes the outcome.
 *
 * `execute` never throws: a failing, denied or unknown tool becomes an error
 * result the model can read.
 */
import { Context, Service } from "@deepseek-ai/cordis";
import type { ToolResultContent, ToolSchema } from "@qianji/llm";
import { argumentProblem, MAX_SCHEMA_DEPTH } from "./schema-validate.ts";

export { argumentProblem, MAX_SCHEMA_DEPTH };

declare module "@deepseek-ai/cordis" {
  interface Context {
    tools: Tools;
  }

  interface Events {
    "tools/pre-execute"(call: ToolCall, env: ToolEnv): Promise<ToolDecision | undefined> | ToolDecision | undefined;
    "tools/execute"(call: ToolCall, env: ToolEnv, next: () => Promise<ToolOutput>): Promise<ToolOutput>;
    "tools/result"(call: ToolCall, env: ToolEnv, output: ToolOutput): void;
  }
}

export interface ToolCall {
  id: string;
  name: string;
  /** May be rewritten by `tools/pre-execute` listeners before the tool runs. */
  args: Record<string, unknown>;
}

/** Where a call runs. */
export interface ToolEnv {
  sessionId: string;
  cwd: string;
  signal: AbortSignal;
  /** Optional cooperative signal aborted when the user queues a mid-turn `steer` message. */
  steeringSignal?: AbortSignal;
  /** The call being executed; set by `Tools.execute`. */
  callId?: string;
  /** Optional incremental progress callback emitted while a tool executes. */
  onProgress?: (text: string) => void;
}

export type ToolDecision =
  | { allow: true }
  | { deny: true; reason: string };

export interface ToolOutput {
  content: ToolResultContent[];
  isError?: boolean;
  /** Structured data for the UI; not sent to the model. */
  details?: unknown;
}

export const ACTIVATE_TOOLS_NAME = "activate_tools";

export interface ToolDefinition<Args extends Record<string, unknown> = Record<string, unknown>> {
  name: string;
  description: string;
  /** JSON Schema of the arguments object; `required` and top-level types are checked. */
  parameters: Record<string, unknown> & { type: "object" };
  /** Optional capability group (e.g. `"browser"`, `"computer"`) for batch on-demand activation. */
  group?: string;
  /** Optional owning plugin identifier stamped automatically by `PluginManager`. */
  pluginId?: string;
  /** Optional connector identifier when this tool belongs to a specific Connector. */
  connectorId?: string;
  /** Short summary shown in `activate_tools` when this tool's group is deferred. */
  groupDescription?: string;
  /**
   * When true, omit this tool's full JSON schema from per-session `schemas(sessionId)`
   * until activated via `activate_tools` or called directly in that session.
   */
  deferred?: boolean;
  /**
   * When true, declares this tool is strictly side-effect-free / read-only so
   * `Plan`, `Ask`, and `ask`-permission modes allow it without confirmation prompts.
   */
  readOnly?: boolean;
  /**
   * Optional per-call concurrency safety classifier evaluated on validated arguments.
   * When omitted, `Tools.isConcurrencySafe` falls back to `readOnly === true`.
   */
  isConcurrencySafe?(args: Args): boolean;
  /**
   * The longest a call may run, in milliseconds, before the tool-guards plugin
   * aborts it and reports a timeout. Omitted means the plugin's default; 0
   * means no limit (for tools that bound their own run time, like `bash`).
   */
  timeoutMs?: number;
  execute(args: Args, env: ToolEnv): Promise<ToolOutput> | ToolOutput;
}

export function textOutput(text: string, isError = false): ToolOutput {
  return isError ? { content: [{ type: "text", text }], isError } : { content: [{ type: "text", text }] };
}

function bindCallerEffect(ctx: Context | undefined, dispose: () => void, label: string): () => void {
  let disposed = false;
  const once = (): void => {
    if (disposed) return;
    disposed = true;
    dispose();
  };
  if (ctx?.fiber?.uid != null && ctx.fiber.state !== 5) {
    try {
      return ctx.effect(() => once, label) as unknown as () => void;
    } catch {
      return once;
    }
  }
  return once;
}

const ACTIVATE_TOOLS_PARAMETERS: ToolDefinition["parameters"] = {
  type: "object",
  properties: {
    names: {
      type: "array",
      items: { type: "string" },
      description: "Group names (e.g. 'browser', 'computer') or tool names to activate.",
    },
  },
  required: ["names"],
};

export class Tools extends Service {
  private readonly definitions = new Map<string, ToolDefinition>();
  /** sessionId → the only tools that session may see and call. */
  private readonly restrictions = new Map<string, ReadonlySet<string>>();
  /** sessionId → deferred tool names activated for that session. */
  private readonly activated = new Map<string, Set<string>>();
  private pluginIdResolver: (() => string | undefined) | undefined;
  private sessionFilter: ((sessionId: string, definition: ToolDefinition) => boolean) | undefined;

  constructor(ctx: Context) {
    super(ctx, "tools");
    ctx.on("session/deleted" as never, ((sessionId: string) => {
      this.activated.delete(sessionId);
    }) as never);
  }

  /** Set ambient plugin-ID resolver used to stamp `definition.pluginId` during `register()`. */
  setPluginIdResolver(resolver: (() => string | undefined) | undefined): void {
    this.pluginIdResolver = resolver;
  }

  /** Set dynamic per-session visibility gate (`Agent` vs `Bot` scopes & connected plugin connectors). */
  setSessionFilter(filter: ((sessionId: string, definition: ToolDefinition) => boolean) | undefined): void {
    this.sessionFilter = filter;
  }

  /** Offer a tool to every session. Automatically cleans up with the caller's Cordis fiber. */
  register<Args extends Record<string, unknown>>(definition: ToolDefinition<Args>): () => void {
    if (definition.name === ACTIVATE_TOOLS_NAME || this.definitions.has(definition.name)) {
      throw new Error(`Tool ${definition.name} is already registered`);
    }
    const rawEntry = definition as unknown as ToolDefinition;
    const ambientPluginId = rawEntry.pluginId ?? this.pluginIdResolver?.();
    const entry: ToolDefinition =
      ambientPluginId !== undefined && rawEntry.pluginId === undefined
        ? { ...rawEntry, pluginId: ambientPluginId }
        : rawEntry;
    this.definitions.set(definition.name, entry);
    return bindCallerEffect(
      this.ctx,
      () => {
        if (this.definitions.get(definition.name) === entry) this.definitions.delete(definition.name);
      },
      `tools.register:${definition.name}`,
    );
  }

  get(name: string): ToolDefinition | undefined {
    return this.definitions.get(name);
  }

  /** Return all registered tool definitions (sorted by name) for runtime introspection. */
  listDefinitions(): ToolDefinition[] {
    return [...this.definitions.values()].sort((a, b) => a.name.localeCompare(b.name));
  }

  /**
   * Activate deferred tools by tool name, group name, or `"all"` for `sessionId`.
   * Returns the sorted list of matching tool names now active in the session.
   */
  activate(sessionId: string, namesOrGroups: Iterable<string>): string[] {
    const queries = [...namesOrGroups]
      .map((item) => String(item).trim().toLowerCase())
      .filter((item) => item !== "");
    if (queries.length === 0) return [];
    const wantAll = queries.includes("all") || queries.includes("*");
    const matched: string[] = [];
    for (const def of this.definitions.values()) {
      if (!def.deferred || !this.allows(sessionId, def.name)) continue;
      const lowerName = def.name.toLowerCase();
      const lowerGroup = def.group?.toLowerCase();
      const hit = wantAll || queries.some((q) => q === lowerName || (lowerGroup !== undefined && q === lowerGroup) || lowerName.startsWith(`${q}_`));
      if (hit) matched.push(def.name);
    }
    if (matched.length > 0) {
      let set = this.activated.get(sessionId);
      if (set === undefined) {
        set = new Set();
        this.activated.set(sessionId, set);
      }
      for (const name of matched) set.add(name);
    }
    return matched.sort((a, b) => a.localeCompare(b));
  }

  /** Whether a deferred tool has been activated for `sessionId`. */
  isActivated(sessionId: string, name: string): boolean {
    return this.activated.get(sessionId)?.has(name) === true;
  }

  /**
   * Limit `sessionId` to the tools named in `names` (a subagent's toolbox).
   * Returns the disposer.
   */
  restrict(sessionId: string, names: Iterable<string>): () => void {
    const allowed = new Set(names);
    this.restrictions.set(sessionId, allowed);
    return bindCallerEffect(
      this.ctx,
      () => {
        if (this.restrictions.get(sessionId) === allowed) this.restrictions.delete(sessionId);
      },
      `tools.restrict:${sessionId}`,
    );
  }

  /** Whether `sessionId` may use `name`. */
  allows(sessionId: string | undefined, name: string): boolean {
    const allowed = sessionId === undefined ? undefined : this.restrictions.get(sessionId);
    if (allowed !== undefined && !allowed.has(name)) return false;
    if (sessionId !== undefined && this.sessionFilter !== undefined) {
      const def = this.definitions.get(name);
      if (def !== undefined && !this.sessionFilter(sessionId, def)) return false;
    }
    return true;
  }

  /**
   * Whether `name` with `args` is safe to execute concurrently alongside other concurrency-safe calls.
   * Unknown tools, disallowed tools, schema validation failures, and classifier throws fail closed (`false`).
   */
  isConcurrencySafe(name: string, args: Record<string, unknown> = {}, sessionId?: string): boolean {
    if (args === null || typeof args !== "object" || Array.isArray(args)) return false;
    if (name === ACTIVATE_TOOLS_NAME) {
      if (sessionId !== undefined && !this.allows(sessionId, ACTIVATE_TOOLS_NAME) && this.deferredCatalogFor(sessionId).length === 0) {
        return false;
      }
      return argumentProblem(ACTIVATE_TOOLS_PARAMETERS, args) === undefined;
    }
    if (!this.allows(sessionId, name)) return false;
    const def = this.definitions.get(name);
    if (def === undefined) return false;
    if (argumentProblem(def.parameters, args) !== undefined) return false;
    if (typeof def.isConcurrencySafe === "function") {
      try {
        return def.isConcurrencySafe(args) === true;
      } catch {
        return false;
      }
    }
    return def.readOnly === true;
  }

  private buildActivateToolsSchema(definitions: ToolDefinition[]): ToolSchema {
    const groups = new Map<string, ToolDefinition[]>();
    for (const def of definitions) {
      const key = def.group ?? def.name;
      const list = groups.get(key) ?? [];
      list.push(def);
      groups.set(key, list);
    }
    const summaries = [...groups.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, items]) => {
        const sortedItems = [...items].sort((a, b) => a.name.localeCompare(b.name));
        const single = sortedItems[0];
        if (sortedItems.length === 1 && single !== undefined && single.group === undefined) {
          return `${key} (${single.description})`;
        }
        const desc =
          sortedItems.find((item) => item.groupDescription)?.groupDescription ??
          sortedItems.map((item) => item.name).join(", ");
        return `${key} (${sortedItems.length} tools: ${desc})`;
      });
    return {
      name: ACTIVATE_TOOLS_NAME,
      description: `Load full schemas for on-demand toolsets before calling them. Available: ${summaries.join("; ")}.`,
      parameters: ACTIVATE_TOOLS_PARAMETERS,
    };
  }

  /**
   * What the model is told about each tool, sorted by name for stable prompts.
   * When `sessionId` is omitted, returns all registered tools (global introspection).
   * When `sessionId` is provided, unactivated `deferred` tools are collapsed into `activate_tools`.
   */
  schemas(sessionId?: string): ToolSchema[] {
    if (sessionId === undefined) {
      return [...this.definitions.values()]
        .map(({ name, description, parameters }) => ({ name, description, parameters }))
        .sort((a, b) => a.name.localeCompare(b.name));
    }
    const visible: ToolSchema[] = [];
    const allowedDeferred: ToolDefinition[] = [];
    let hasUnactivated = false;
    for (const def of this.definitions.values()) {
      if (!this.allows(sessionId, def.name)) continue;
      if (def.deferred) {
        allowedDeferred.push(def);
        if (this.isActivated(sessionId, def.name)) {
          visible.push({ name: def.name, description: def.description, parameters: def.parameters });
        } else {
          hasUnactivated = true;
        }
      } else {
        visible.push({ name: def.name, description: def.description, parameters: def.parameters });
      }
    }
    if (hasUnactivated) {
      // Keep activate_tools description invariant across partial activations for prompt cache stability.
      visible.push(this.buildActivateToolsSchema(allowedDeferred));
    }
    return visible.sort((a, b) => a.name.localeCompare(b.name));
  }

  async execute(call: ToolCall, env: ToolEnv): Promise<ToolOutput> {
    // Each call gets its own env: parallel calls of a turn share the caller's object,
    // and a `tools/execute` listener may replace `signal` for the calls below it.
    const callEnv: ToolEnv = { ...env, callId: call.id };
    const output = await this.run(call, callEnv);
    try {
      this.ctx.emit("tools/result", call, callEnv, output);
    } catch (error) {
      this.ctx.logger("tools").warn(
        "tools/result listener failed for %s: %s",
        call.name,
        error instanceof Error ? error.message : String(error),
      );
    }
    return output;
  }

  private deferredCatalogFor(sessionId: string): ToolDefinition[] {
    return [...this.definitions.values()].filter((def) => def.deferred && this.allows(sessionId, def.name));
  }

  private async run(call: ToolCall, env: ToolEnv): Promise<ToolOutput> {
    if (call.name === ACTIVATE_TOOLS_NAME) {
      const availableDeferred = this.deferredCatalogFor(env.sessionId);
      if (availableDeferred.length === 0 && !this.allows(env.sessionId, ACTIVATE_TOOLS_NAME)) {
        return textOutput(`Unknown tool "${call.name}".`, true);
      }
      if (env.signal.aborted) return textOutput("Aborted before the tool ran.", true);
      const schema = this.buildActivateToolsSchema(availableDeferred);
      const preProblem = argumentProblem(schema.parameters as ToolDefinition["parameters"], call.args);
      if (preProblem !== undefined) return textOutput(`Invalid arguments for ${call.name}: ${preProblem}.`, true);
      try {
        const decision = await this.ctx.serial("tools/pre-execute", call, env);
        if (decision !== undefined && "deny" in decision) return textOutput(`Denied: ${decision.reason}`, true);
        const postProblem = argumentProblem(schema.parameters as ToolDefinition["parameters"], call.args);
        if (postProblem !== undefined) return textOutput(`Invalid arguments for ${call.name}: ${postProblem}.`, true);
        return await this.ctx.waterfall("tools/execute", call, env, async () => {
          const requested = Array.isArray(call.args.names) ? call.args.names.map(String) : [];
          const matched = this.activate(env.sessionId, requested);
          if (matched.length === 0) {
            const validGroups = [...new Set(availableDeferred.map((def) => def.group ?? def.name))].sort();
            return textOutput(
              `No deferred tools matched [${requested.join(", ")}]. Available groups/tools: ${validGroups.join(", ") || "none"}.`,
              true,
            );
          }
          const lines = matched.map((toolName) => {
            const def = this.definitions.get(toolName);
            return `- ${toolName}: ${def?.description ?? ""}`;
          });
          return textOutput(`Activated ${matched.length} tools for this session:\n${lines.join("\n")}`);
        });
      } catch (error) {
        if (env.signal.aborted) return textOutput("Aborted.", true);
        return textOutput(`${call.name} failed: ${error instanceof Error ? error.message : String(error)}`, true);
      }
    }

    const definition = this.allows(env.sessionId, call.name) ? this.definitions.get(call.name) : undefined;
    if (definition === undefined) return textOutput(`Unknown tool "${call.name}".`, true);
    if (env.signal.aborted) return textOutput("Aborted before the tool ran.", true);
    const preProblem = argumentProblem(definition.parameters, call.args);
    if (preProblem !== undefined) return textOutput(`Invalid arguments for ${call.name}: ${preProblem}.`, true);
    if (definition.deferred) {
      this.activate(env.sessionId, [definition.group ?? definition.name]);
    }
    try {
      const decision = await this.ctx.serial("tools/pre-execute", call, env);
      if (decision !== undefined && "deny" in decision) return textOutput(`Denied: ${decision.reason}`, true);
      const postProblem = argumentProblem(definition.parameters, call.args);
      if (postProblem !== undefined) return textOutput(`Invalid arguments for ${call.name}: ${postProblem}.`, true);
      return await this.ctx.waterfall("tools/execute", call, env, async () => definition.execute(call.args, { ...env, callId: call.id }));
    } catch (error) {
      if (env.signal.aborted) return textOutput("Aborted.", true);
      return textOutput(`${call.name} failed: ${error instanceof Error ? error.message : String(error)}`, true);
    }
  }
}

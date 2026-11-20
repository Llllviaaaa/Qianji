/**
 * Runtime introspection catalogs surfaced by `qianji_inspect` (`plugin-dev-tools.ts`).
 *
 * Host plugins are mounted with the full Cordis context (`targetCtx.plugin`), not a
 * trimmed facade, so `HOST_SERVICE_CATALOG` and `CORDIS_EVENTS_CATALOG` must stay
 * aligned with the actual service classes and event declarations across `packages/*`.
 * These are internal Cordis methods, not a SemVer-versioned plugin contract.
 */
import { CLIENT_SLOT_CATALOG } from "@qianji/protocol";

export interface HostServiceCatalogEntry {
  readonly name: string;
  readonly plane: "host" | "client";
  readonly methods: readonly string[];
  readonly autoDispose: boolean;
  readonly notes?: readonly string[];
}

export interface CordisEventCatalogEntry {
  readonly name: string;
  readonly mode: string;
  readonly signature: string;
  readonly description: string;
}

export const HOST_SERVICE_CATALOG: readonly HostServiceCatalogEntry[] = [
  {
    name: "tools",
    plane: "host",
    methods: ["register(def)", "get(name)", "listDefinitions()", "schemas(sessionId?)", "execute(call, env)"],
    autoDispose: true,
  },
  {
    name: "commands",
    plane: "host",
    methods: ["register(def)", "registerProvider(fn)", "list(cwd?)", "run(name, args, env)", "has(name, cwd?)"],
    autoDispose: true,
    notes: ["There is no execute(); CommandResult.clientAction may be clear or compact, and the caller runs compaction."],
  },
  {
    name: "systemPrompt",
    plane: "host",
    methods: ["section(id, render, { order? })", "build(env)"],
    autoDispose: true,
  },
  {
    name: "rpc",
    plane: "host",
    methods: ["method(name, handler)", "methods()", "broadcast(method, params?)"],
    autoDispose: true,
  },
  {
    name: "webServer",
    plane: "host",
    methods: ["register({ kind, path, handler })", "registerUpgrade({ path, handler })"],
    autoDispose: true,
    notes: ["Listens on loopback 127.0.0.1; server-to-server webhooks without browser Origin/Referer headers are admitted as \"unattributed\"."],
  },
  {
    name: "sessions",
    plane: "host",
    methods: [
      "get(id)",
      "peek(id)",
      "list()",
      "search(query, opts?)",
      "create({ cwd, model?, effort?, ... })",
      "setModel(target, model)",
      "setEffort(target, effort)",
      "fork(session, atSeq?, opts?)",
      "delete(id)",
      "hold(id)",
      "openSessions()",
    ],
    autoDispose: false,
    notes: [
      "sessions.list() takes no cwd; filter SessionSummary.cwd yourself.",
      "Session exposes events, append(type, data), setModel(model), setEffort(effort), delta(), state(), summary(), flush().",
    ],
  },
  {
    name: "agents",
    plane: "host",
    methods: [
      "prompt(session, content)",
      "steer(session, content)",
      "followUp(session, content)",
      "abort(sessionId)",
      "compact(session, signal?)",
      "status(sessionId)",
      "idle(sessionId)",
    ],
    autoDispose: false,
    notes: [
      "prompt/steer/followUp return immediately once queued. prompt throws AgentBusyError while a run is active; wait with idle() or agent/settled.",
      "There is no run() or isRunning(); inspect status(sessionId).running instead.",
    ],
  },
  {
    name: "llm",
    plane: "host",
    methods: [
      "registerProtocol(id, spec)",
      "listProtocols()",
      "registerAdapter(info, adapter)",
      "listProviders()",
      "listModels(provider, signal?)",
      "stream(request, signal?)",
      "instantiateProtocolAdapter(api, provider)",
    ],
    autoDispose: true,
    notes: [
      "ModelInfo returned by listModels(provider) includes reasoning, thinkingLevel, and thinkingLevels.",
      "There is no models() or complete(); stream() yields StreamChunk and always finishes.",
    ],
  },
  {
    name: "credentials",
    plane: "host",
    methods: ["get(id)", "set(id, value)", "delete(id)", "resolve(ref)", "describe(ref)", "registerStore(store)", "writable"],
    autoDispose: false,
    notes: ["Backed by DPAPI-encrypted secrets.dat when secret-store is mounted (writable === true)."],
  },
  {
    name: "permissions",
    plane: "host",
    methods: ["modes(session)", "defaultModes()", "defaultModesForSession(session?)", "set(session, { permission?, agentMode? })"],
    autoDispose: false,
  },
  {
    name: "ui",
    plane: "host",
    methods: [
      "attach(transport)",
      "confirm(sessionId, title, message, signal?)",
      "select(sessionId, title, options, signal?)",
      "input(sessionId, title, placeholder?, signal?)",
      "notify(sessionId, message, level?)",
      "canAsk(sessionId)",
      "ask(sessionId, request, signal?)",
      "pending()",
      "respond(requestId, value)",
      "markUnattended(sessionId)",
    ],
    autoDispose: false,
    notes: [
      "Multi-transport fan-out: desktop ui-rpc and IM/remote plugins may attach simultaneously; first respond(requestId, value) wins and cancels all transports.",
      "Detaching a plugin fiber automatically detaches its attached transport.",
    ],
  },
  {
    name: "pricing",
    plane: "host",
    methods: ["resolvePricing(provider, model)", "estimateCallCost(provider, model, usage)", "estimateSessionCost(summary)", "setCustomPricing(fn)"],
    autoDispose: false,
  },
  {
    name: "mcp",
    plane: "host",
    methods: [
      "statuses()",
      "reconnect(serverId?)",
      "listAllResources(serverId?)",
      "readServerResource(serverId, uri)",
      "listAllPrompts(serverId?)",
      "getServerPrompt(serverId, name, args?)",
    ],
    autoDispose: false,
  },
  {
    name: "schedule",
    plane: "host",
    methods: ["list()", "save(input)", "delete(id)", "runs(taskId?, limit?)", "isRunning(id)", "cancel(id)", "run(id, trigger)"],
    autoDispose: false,
  },
  {
    name: "hostInfo",
    plane: "host",
    methods: ["version", "protocolVersion", "dataDir", "startedAt"],
    autoDispose: false,
  },
  {
    name: "contributions",
    plane: "client",
    methods: CLIENT_SLOT_CATALOG.map((slot) => `${slot.method.replace("ctx.contributions.", "")}(def)`),
    autoDispose: true,
  },
  {
    name: "slots",
    plane: "client",
    methods: ["defineSlot(slotKey, spec)", "register(slotKey, input)", "registerFactory(factoryKey, input)", "wrap(slotKey, input)", "inspectSlot(slotKey)", "inspectAllSlots()"],
    autoDispose: true,
    notes: ["Typed ADR 0023 core slot tree service (`@qianji/client-slots`); call `qianji_inspect(topic: \"slot_tree\")` for the full catalog."],
  },
  {
    name: "styles",
    plane: "client",
    methods: ["inject(css, key?)", "injectGlobal(css, key?)"],
    autoDispose: true,
  },
  {
    name: "betterSidebar",
    plane: "client",
    methods: ["registerTab(desc)", "registerFileViewer(desc)", "openFile(scope, path)", "openTab(seed, scope?)"],
    autoDispose: true,
  },
];

export const CORDIS_EVENTS_CATALOG: readonly CordisEventCatalogEntry[] = [
  { name: "tools/pre-execute", mode: "bail (async)", signature: "(call: ToolCall, env: ToolEnv) => ToolDecision | undefined", description: "Intercept, rewrite args, or deny a tool call before execution." },
  { name: "tools/execute", mode: "waterfall", signature: "(call: ToolCall, env: ToolEnv, next: () => Promise<ToolOutput>) => Promise<ToolOutput>", description: "Wrap tool execution (e.g. timing, checkpoints, output post-processing)." },
  { name: "tools/result", mode: "emit", signature: "(call: ToolCall, env: ToolEnv, output: ToolOutput) => void", description: "Observe completed tool outputs." },
  { name: "session/created", mode: "emit", signature: "(session: Session) => void", description: "A session log was created." },
  { name: "session/event", mode: "emit", signature: "(session: Session, event: SessionEvent) => void", description: "A persisted session event was appended (user, assistant, tool-call, tool-result, model, effort, compaction, rewind, label, custom)." },
  { name: "session/delta", mode: "emit", signature: "(session: Session, liveSeq: number, delta: SessionDelta) => void", description: "Live, unpersisted progress. Agent deltas include llm-chunk, tool-start/end, queue, and compaction-start/end." },
  { name: "session/flush", mode: "parallel", signature: "(session: Session) => Promise<void>", description: "Storage synced; plugins persist what they keep for this session." },
  { name: "session/unloaded", mode: "emit", signature: "(sessionId: string) => void", description: "The session left memory and will reload on next use." },
  { name: "session/deleted", mode: "emit", signature: "(sessionId: string) => void", description: "Clean up per-session state when a session is deleted." },
  { name: "agent/before-start", mode: "parallel", signature: "(session: Session) => Promise<void> | void", description: "A run is starting, before its first model call." },
  { name: "agent/turn-start", mode: "parallel", signature: "(session: Session, turn: number) => Promise<void> | void", description: "Before each model call of a run; turn counts from 1." },
  { name: "agent/turn-end", mode: "parallel", signature: "(session: Session, turn: number) => Promise<void> | void", description: "After a model call and the tools it asked for." },
  { name: "agent/before-stop", mode: "bail (async)", signature: "(session: Session, context: BeforeStopContext) => Promise<string | undefined> | string | undefined", description: "Right before a run would stop with done; return a continuation prompt string to keep working." },
  { name: "agent/settled", mode: "parallel", signature: "(session: Session, outcome: RunOutcome) => Promise<void>", description: "The run ended and its queues are empty. outcome is done, aborted, error, or max-turns." },
  { name: "llm/request", mode: "waterfall", signature: "(request: LlmRequest, next: () => AsyncIterable<StreamChunk>) => AsyncIterable<StreamChunk>", description: "Wrap every model call; change request before next(), or wrap the returned stream." },
  { name: "llm/response", mode: "emit", signature: "(response: LlmResponseInfo) => void", description: "One model call finished after retries, with usage and timing." },
  { name: "llm/protocols-changed", mode: "emit", signature: "() => void", description: "An LLM wire-protocol plugin registered or unregistered." },
  { name: "commands/changed", mode: "emit", signature: "(reason: string) => void", description: "The slash-command registry changed." },
  { name: "mcp/changed", mode: "emit", signature: "() => void", description: "The MCP server registry changed." },
  { name: "pricing/recorded", mode: "emit", signature: "(record: PricingCallRecord) => void", description: "A model call's local cost estimate was recorded." },
  { name: "schedule/task", mode: "emit", signature: "(id: string, task: ScheduledTask | undefined) => void", description: "A scheduled task was saved, started, finished, or deleted (task undefined)." },
  { name: "schedule/run", mode: "emit", signature: "(run: ScheduledRun) => void", description: "A scheduled task run was recorded." },
];

export const INSPECT_TOPICS = [
  "all",
  "services",
  "events",
  "rpc_methods",
  "shared_modules",
  "client_slots",
  "slot_tree",
  "frontend_services",
  "slot_owners",
  "primitives",
  "theme_tokens",
  "plugins",
] as const;

export type InspectTopic = (typeof INSPECT_TOPICS)[number];

export const THEME_TOKENS_CATALOG = {
  cascadeLayers: "@layer theme, base, plugin-ui, legacy, skin, components, plugin-skin, utilities;",
  scopingRule: "Use `ctx.styles.inject(css, key?)` or `import './style.css'`; rules are automatically wrapped in `@layer plugin-ui { @scope ([data-qj-plugin=\"<id>\"]) { ... } }`.",
  globalSkinRule: "Use `ctx.styles.injectGlobal(css, key?)` or `import './skin.global.css'`; rules are wrapped in unscoped `@layer plugin-skin { ... }` (above host legacy/skin/components, below Tailwind utilities) and cleaned up automatically on HMR or plugin unload.",
  tokens: {
    backgrounds: [
      "--qj-bg-app",
      "--qj-bg-canvas",
      "--qj-bg-sidebar",
      "--qj-bg-surface",
      "--qj-bg-elevated",
      "--qj-bg-subtle",
      "--qj-bg-hover",
      "--qj-bg-active",
    ],
    text: [
      "--qj-text-primary",
      "--qj-text-secondary",
      "--qj-text-muted",
      "--qj-text-inverse",
    ],
    borders: [
      "--qj-border-subtle",
      "--qj-border-default",
      "--qj-border-strong",
    ],
    brandAndStatus: [
      "--qj-brand-primary",
      "--qj-brand-hover",
      "--qj-brand-soft",
      "--qj-brand-contrast",
      "--qj-status-success",
      "--qj-status-warning",
      "--qj-status-danger",
      "--qj-status-info",
    ],
    typographyAndRadius: [
      "--qj-font-sans",
      "--qj-font-mono",
      "--qj-radius-sm",
      "--qj-radius-md",
      "--qj-radius-lg",
    ],
  },
} as const;

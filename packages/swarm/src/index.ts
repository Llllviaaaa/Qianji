/**
 * `@qianji/swarm` — Native Hub-and-Board Multi-Agent Swarm Runtime Engine.
 */
import type { Context } from "@deepseek-ai/cordis";
import "@qianji/agent";
import "@qianji/commands";
import "@qianji/llm";
import "@qianji/pricing";
import type {
  SwarmAlertNotification,
  SwarmBoardNotification,
  SwarmBoardReadResult,
  SwarmConfigUpdatedNotification,
  SwarmMemberDeltaNotification,
  SwarmMemberRole,
  SwarmOpenNotification,
  SwarmUpdatedNotification,
  SwarmWorkspaceMode,
} from "@qianji/protocol";
import "@qianji/session";
import "@qianji/subagents";
import "@qianji/system-prompt";
import "@qianji/tools";
import "@qianji/ui";
import { SwarmService } from "./service.ts";

export * from "./board.ts";
export * from "./command.ts";
export * from "./lifecycle.ts";
export * from "./model-config.ts";
export * from "./outcomes.ts";
export * from "./persistence.ts";
export * from "./prompts.ts";
export { SwarmService } from "./service.ts";
export * from "./state.ts";
export * from "./tasks.ts";
export * from "./tools.ts";
export * from "./worker-session.ts";
export * from "./worktrees.ts";

declare module "@deepseek-ai/cordis" {
  interface Context {
    swarm: SwarmService;
  }

  interface Events {
    "swarm/updated"(payload: SwarmUpdatedNotification): void;
    "swarm/board"(payload: SwarmBoardNotification): void;
    "swarm/memberDelta"(payload: SwarmMemberDeltaNotification): void;
    "swarm/alert"(payload: SwarmAlertNotification): void;
    "swarm/open"(payload: SwarmOpenNotification): void;
    "swarm/configUpdated"(payload: SwarmConfigUpdatedNotification): void;
  }
}

export interface SwarmServiceOptions {
  dataDir?: string;
  branchPrefix?: string;
  defaultStallTimeoutMs?: number;
  watchdogIntervalMs?: number;
}

export interface SwarmAddMemberInput {
  swarmId: string;
  name: string;
  brief: string;
  role?: Exclude<SwarmMemberRole, "coordinator">;
  addedBy?: string;
  provider?: string;
  model?: string;
  effort?: string;
  forkFrom?: string;
  workspaceMode?: SwarmWorkspaceMode;
  channels?: string[];
  tasks?: string[];
  n?: number;
  signal?: AbortSignal;
}

export interface SwarmWaitInput {
  swarmId: string;
  memberName: string;
  since: number;
  mentionsOnly?: boolean;
  timeoutMs?: number;
  signal?: AbortSignal;
}

export interface SwarmWaitResult {
  messages: SwarmBoardReadResult["messages"];
  headSeq: number;
  timedOut: boolean;
  aborted: boolean;
}

export interface SwarmChannelManageInput {
  swarmId: string;
  action: "create" | "join" | "leave" | "archive" | "list";
  channel?: string;
  topic?: string;
  actor?: string;
}

export const name = "qianji-swarm";
export const inject = ["llm", "sessions", "agents", "tools", "commands", "systemPrompt"];

export function apply(ctx: Context, options: SwarmServiceOptions = {}): void {
  ctx.plugin(SwarmService, options);
}

/**
 * Minimalist 4-tool Swarm coordination kernel (`swarm`, `read_board`,
 * `post_message`, `swarm_wait`) (`@qianji/swarm`).
 */
import type { Context } from "@deepseek-ai/cordis";
import type { SwarmMemberRole, SwarmWorkspaceMode } from "@qianji/protocol";
import { textOutput, type ToolDefinition } from "@qianji/tools";
import { resolveSwarmAndActor } from "./command.ts";
import type { SwarmPlanThreadInput } from "./outcomes.ts";
import type { SwarmService } from "./service.ts";
import { SWARM_GROUP_DESCRIPTION, SWARM_TOOL_GROUP } from "./worker-session.ts";

function jsonResult(data: unknown, isError = false) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }],
    ...(isError ? { isError: true } : {}),
    details: data,
  };
}

export function createSwarmTools(ctx: Context, service: SwarmService): ToolDefinition[] {
  const swarmTool: ToolDefinition<{
    action?: string;
    swarmId?: string;
    goal?: string;
    title?: string;
    goalTitle?: string;
    goalLine?: string;
    memberTasks?: Record<string, string>;
    threads?: SwarmPlanThreadInput[];
    name?: string;
    role?: string;
    brief?: string;
    provider?: string;
    model?: string;
    fork?: string;
    workspace?: string;
    channels?: string[];
    tasks?: string[];
    n?: number;
    channelAction?: string;
    channel?: string;
    topic?: string;
    forceKillUnmerged?: boolean;
    applyChanges?: boolean;
    reason?: string;
  }> = {
    name: "swarm",
    deferred: true,
    group: SWARM_TOOL_GROUP,
    groupDescription: SWARM_GROUP_DESCRIPTION,
    isConcurrencySafe: (args) => args.action === "status" || args.action === "models",
    description:
      "Manage the multi-agent swarm: create, status, models, add (spawn specialist workers), plan (publish 1-6 outcome threads), model (hot-swap model preserving history), merge (land isolated worktree patch), kill, pause, resume, stop, title, or channel.",
    parameters: {
      type: "object",
      properties: {
        action: {
          type: "string",
          enum: [
            "create",
            "status",
            "models",
            "add",
            "plan",
            "model",
            "merge",
            "kill",
            "pause",
            "resume",
            "stop",
            "title",
            "channel",
          ],
        },
        swarmId: { type: "string" },
        goal: { type: "string" },
        title: { type: "string" },
        goalTitle: { type: "string", description: "Concise plan headline for action='plan'" },
        goalLine: { type: "string", description: "One-line outcome summary for action='plan'" },
        memberTasks: {
          type: "object",
          additionalProperties: { type: "string" },
          description: "Per-member short task label map (e.g. { parser: 'Fix lexer edge cases' })",
        },
        threads: {
          type: "array",
          description: "1 to 6 outcome-oriented threads grouping members by deliverable (never 1-per-agent unless single piece)",
          items: {
            type: "object",
            properties: {
              id: { type: "string" },
              title: { type: "string" },
              goal: { type: "string" },
              members: { type: "array", items: { type: "string" } },
            },
            required: ["title", "members"],
          },
        },
        name: { type: "string", description: "Worker roster name (lowercase [a-z0-9_-])" },
        role: {
          type: "string",
          enum: ["explorer", "planner", "worker", "verifier", "monitor"],
          description: "Specialist role; selects workspace isolation, tool allowlist, and user-configured role model",
        },
        brief: { type: "string", description: "Self-contained worker assignment posted on the board" },
        provider: { type: "string", description: "Leave omitted unless explicitly requested so role model config applies" },
        model: { type: "string", description: "Leave omitted unless explicitly requested so role model config applies" },
        fork: { type: "string", description: "Optional member name (or 'coordinator') to fork settled context from" },
        workspace: { type: "string", enum: ["inherit", "share", "branch"] },
        channels: { type: "array", items: { type: "string" } },
        tasks: { type: "array", items: { type: "string" } },
        n: { type: "number" },
        channelAction: { type: "string", enum: ["create", "join", "leave", "archive", "list"] },
        channel: { type: "string" },
        topic: { type: "string" },
        forceKillUnmerged: { type: "boolean" },
        applyChanges: { type: "boolean" },
        reason: { type: "string" },
      },
      required: ["action"],
    },
    async execute(args, env) {
      if (args.action === "models") {
        const llm = ctx.get("llm");
        const providers = llm?.listProviders() ?? [];
        const catalog: Array<{ provider: string; models: string[] }> = [];
        for (const p of providers) {
          const models = llm !== undefined ? await llm.listModels(p.id, env.signal).catch(() => []) : [];
          catalog.push({ provider: p.id, models: models.map((m) => m.id) });
        }
        return jsonResult({ providers: catalog });
      }

      if (args.action === "create") {
        const goal = (args.goal ?? args.title ?? "").trim();
        if (goal === "") return textOutput("goal is required when action is 'create'.", true);
        const snap = await service.createSwarm({
          goal,
          title: args.title,
          cwd: env.cwd,
          coordinatorSessionId: env.sessionId,
        });
        ctx.emit("swarm/open", { swarmId: snap.run.id, sessionId: env.sessionId, cwd: env.cwd, surface: "pane" });
        return jsonResult(snap);
      }

      const resolved = resolveSwarmAndActor(service, env, args.swarmId);
      if ("error" in resolved) return textOutput(resolved.error, true);
      const { snap, actorName } = resolved;
      const swarmId = snap.run.id;

      switch (args.action) {
        case "status":
          return jsonResult(snap);
        case "add": {
          if (!args.name || !args.brief) {
            return textOutput("Both 'name' and 'brief' are required when action is 'add'.", true);
          }
          try {
            const role = (args.role as Exclude<SwarmMemberRole, "coordinator"> | undefined) ?? "worker";
            const added = await service.addMember({
              swarmId,
              name: args.name,
              brief: args.brief,
              role,
              addedBy: actorName,
              provider: args.provider,
              model: args.model,
              forkFrom: args.fork,
              workspaceMode: args.workspace as SwarmWorkspaceMode | undefined,
              channels: args.channels,
              tasks: args.tasks,
              n: args.n,
              signal: env.signal,
            });
            return jsonResult({ swarmId, added });
          } catch (err) {
            return textOutput((err as Error).message, true);
          }
        }
        case "plan": {
          if (actorName !== "coordinator") {
            return textOutput("Only @coordinator can set the swarm plan.", true);
          }
          const plan = service.updatePlan({
            swarmId,
            goalTitle: args.goalTitle,
            goalLine: args.goalLine,
            memberTasks: args.memberTasks,
            threads: args.threads,
          });
          return jsonResult({ swarmId, plan });
        }
        case "model": {
          const targetName = args.name?.trim() || actorName;
          if (!args.model || args.model.trim() === "") {
            return textOutput("'model' is required when action is 'model'.", true);
          }
          if (actorName !== "coordinator" && targetName !== actorName) {
            const target = snap.members.find((m) => m.name === targetName);
            if (target?.addedBy !== actorName) {
              return textOutput(`@${actorName} may only switch its own model or helpers it added.`, true);
            }
          }
          const res = await service.controlMember({
            swarmId,
            name: targetName,
            action: "switchModel",
            provider: args.provider,
            model: args.model,
            reason: args.reason,
          });
          return jsonResult(res, !res.ok);
        }
        case "merge": {
          if (!args.name) return textOutput("'name' is required when action is 'merge'.", true);
          const res = await service.controlMember({
            swarmId,
            name: args.name,
            action: "mergeWorktree",
            applyChanges: args.applyChanges !== false,
          });
          return jsonResult(res, !res.ok);
        }
        case "kill": {
          if (!args.name) return textOutput("'name' is required when action is 'kill'.", true);
          const killTargetName = args.name.trim().toLowerCase();
          if (actorName !== "coordinator") {
            const target = snap.members.find((m) => m.name === killTargetName);
            if (target === undefined || target.addedBy !== actorName) {
              return textOutput(`@${actorName} can only kill helpers it added itself.`, true);
            }
          }
          const res = await service.controlMember({
            swarmId,
            name: killTargetName,
            action: "kill",
            forceKillUnmerged: args.forceKillUnmerged,
          });
          return jsonResult(res, !res.ok);
        }
        case "pause":
        case "resume":
        case "stop": {
          const res = await service.controlRun({ swarmId, action: args.action });
          return jsonResult(res);
        }
        case "title": {
          if (actorName !== "coordinator") {
            return textOutput("Only @coordinator can rename the swarm title.", true);
          }
          const res = await service.controlRun({ swarmId, action: "setTitle", title: args.title ?? "" });
          return jsonResult(res);
        }
        case "channel": {
          try {
            const channels = service.manageChannel({
              swarmId,
              action: (args.channelAction as "create" | "join" | "leave" | "archive" | "list" | undefined) ?? "list",
              channel: args.channel,
              topic: args.topic,
              actor: actorName,
            });
            return jsonResult({ channels });
          } catch (err) {
            return textOutput((err as Error).message, true);
          }
        }
        default:
          return textOutput(`Unsupported swarm action "${String(args.action)}".`, true);
      }
    },
  };

  const readBoardTool: ToolDefinition<{
    swarmId?: string;
    channel?: string;
    since?: number;
    seqs?: number[];
    limit?: number;
    status?: boolean;
  }> = {
    name: "read_board",
    deferred: true,
    group: SWARM_TOOL_GROUP,
    readOnly: true,
    isConcurrencySafe: () => true,
    description: "Read messages from the shared swarm message board (oldest first when `since` is set).",
    parameters: {
      type: "object",
      properties: {
        swarmId: { type: "string" },
        channel: { type: "string", description: "Optional channel filter (e.g. 'main', 'backend')" },
        since: { type: "number", description: "Return messages with seq > since" },
        seqs: { type: "array", items: { type: "number" }, description: "Fetch exact message sequence numbers" },
        limit: { type: "number" },
        status: { type: "boolean", description: "When true, return roster status instead of messages" },
      },
    },
    execute(args, env) {
      const resolved = resolveSwarmAndActor(service, env, args.swarmId);
      if ("error" in resolved) return textOutput(resolved.error, true);
      if (args.status === true) {
        return jsonResult({ members: resolved.snap.members, headSeq: resolved.snap.run.headSeq });
      }
      const res = service.readBoard({
        swarmId: resolved.snap.run.id,
        channel: args.channel,
        since: args.since,
        seqs: args.seqs,
        limit: args.limit,
        readerName: resolved.actorName,
      });
      return jsonResult(res);
    },
  };

  const postMessageTool: ToolDefinition<{
    swarmId?: string;
    text?: string;
    channel?: string;
    replyToSeq?: number;
  }> = {
    name: "post_message",
    deferred: true,
    group: SWARM_TOOL_GROUP,
    description: "Post a message to the swarm board (`#main` or `#channel`). `@name` wakes parked workers.",
    parameters: {
      type: "object",
      properties: {
        swarmId: { type: "string" },
        text: { type: "string", description: "Message text (use @name to wake specific peers, [done] when finished)" },
        channel: { type: "string", description: "Channel name (defaults to 'main')" },
        replyToSeq: { type: "number" },
      },
      required: ["text"],
    },
    async execute(args, env) {
      const text = (args.text ?? "").trim();
      if (text === "") return textOutput("Message text must be non-empty.", true);
      const resolved = resolveSwarmAndActor(service, env, args.swarmId);
      if ("error" in resolved) return textOutput(resolved.error, true);
      const posted = await service.postBoardMessage({
        swarmId: resolved.snap.run.id,
        text,
        channel: args.channel,
        sender: resolved.actorName,
        replyToSeq: args.replyToSeq,
      });
      return jsonResult(posted);
    },
  };

  const swarmWaitTool: ToolDefinition<{
    swarmId?: string;
    since?: number;
    mentionsOnly?: boolean;
    timeoutMs?: number;
  }> = {
    name: "swarm_wait",
    deferred: true,
    group: SWARM_TOOL_GROUP,
    readOnly: true,
    isConcurrencySafe: () => true,
    timeoutMs: 0,
    description: "Sleep at zero token cost until a board message after `since` wakes you (`@your-name` or `@all`).",
    parameters: {
      type: "object",
      properties: {
        swarmId: { type: "string" },
        since: { type: "number", description: "Highest board seq you have already read" },
        mentionsOnly: { type: "boolean", description: "Wake only on @mention / @all (default true)" },
        timeoutMs: { type: "number" },
      },
      required: ["since"],
    },
    async execute(args, env) {
      const resolved = resolveSwarmAndActor(service, env, args.swarmId);
      if ("error" in resolved) return textOutput(resolved.error, true);
      const res = await service.waitForBoard({
        swarmId: resolved.snap.run.id,
        memberName: resolved.actorName,
        since: args.since ?? 0,
        mentionsOnly: args.mentionsOnly,
        timeoutMs: args.timeoutMs,
        signal: env.signal,
      });
      return jsonResult(res);
    },
  };

  return [swarmTool, readBoardTool, postMessageTool, swarmWaitTool] as ToolDefinition[];
}

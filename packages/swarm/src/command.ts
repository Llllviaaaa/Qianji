/**
 * `/swarm` slash command, dynamic `swarm-protocol` system prompt registration,
 * and shared swarm actor lookup helpers (`@qianji/swarm`).
 */
import type { Context } from "@deepseek-ai/cordis";
import type { CommandDefinition } from "@qianji/commands";
import type { SwarmSnapshotResult } from "@qianji/protocol";
import { SectionOrder } from "@qianji/system-prompt";
import type { ToolEnv } from "@qianji/tools";
import { buildCoordinatorKickoffPrompt, buildSwarmProtocolSection } from "./prompts.ts";
import type { SwarmService } from "./service.ts";
import { createSwarmTools } from "./tools.ts";
import { SWARM_TOOL_GROUP, SWARM_TOOL_NAMES } from "./worker-session.ts";

export function formatSnapshotMarkdown(snap: SwarmSnapshotResult): string {
  const { run, members, tasks, alerts } = snap;
  const outcomeWorkers = members.filter((m) => m.role !== "coordinator" && m.role !== "monitor" && (!m.killed || m.completedAt !== undefined));
  const completed = tasks.length > 0
    ? tasks.filter((t) => t.status === "completed").length
    : outcomeWorkers.filter((m) => m.completedAt !== undefined).length;
  const totalItems = tasks.length > 0 ? tasks.length : outcomeWorkers.length;
  const unresolved = alerts.filter((a) => !a.resolved);
  const lines = [
    `### 蜂群态势：${run.title} (\`${run.id}\`)`,
    `- **状态**：\`${run.status}\` | **消息序号**：\`#${run.headSeq}\` | **成果进度**：\`${completed}/${totalItems}\` | **累计成本**：\`$${run.totalCostUsd.toFixed(4)}\` (\`${run.totalUsage.totalTokens}\` tokens)`,
    `- **目标**：${run.goal}`,
    "",
    "**成员花名册**：",
    ...members.map(
      (m) =>
        `- \`@${m.name}\` (\`${m.role}\`, \`${m.state}\`, \`${m.workspaceMode}\`, model: \`${m.model}\`, changes: ${m.changedFileCount})`,
    ),
  ];
  if (unresolved.length > 0) {
    lines.push("", "**未解决告警**：", ...unresolved.map((a) => `- [${a.kind}] ${a.message}`));
  }
  return lines.join("\n");
}

export function resolveSwarmAndActor(
  service: SwarmService,
  env: ToolEnv,
  explicitSwarmId?: string,
): { snap: SwarmSnapshotResult; actorName: string } | { error: string } {
  if (explicitSwarmId !== undefined && explicitSwarmId.trim() !== "") {
    try {
      const id = explicitSwarmId.trim();
      const snap = service.adoptCoordinatorSessionById(env.sessionId, id) ?? service.getSnapshot(id);
      const member = snap.members.find((m) => m.sessionId === env.sessionId);
      return { snap, actorName: member?.name ?? "coordinator" };
    } catch (err) {
      return { error: (err as Error).message };
    }
  }
  const bySession = service.getActiveSwarmForSession(env.sessionId);
  if (bySession !== undefined) {
    const member = bySession.members.find((m) => m.sessionId === env.sessionId);
    return { snap: bySession, actorName: member?.name ?? "coordinator" };
  }
  const byCwd = service.listSwarms({ cwd: env.cwd }).swarms[0];
  if (byCwd !== undefined) {
    const snap = service.adoptCoordinatorSessionById(env.sessionId, byCwd.run.id) ?? service.getSnapshot(byCwd.run.id);
    const member = snap.members.find((m) => m.sessionId === env.sessionId);
    return { snap, actorName: member?.name ?? "coordinator" };
  }
  return { error: "No active swarm found for this session. Call swarm(action:\"create\", goal:\"...\") or use /swarm <goal>." };
}

export function createSwarmCommand(ctx: Context, service: SwarmService): CommandDefinition {
  return {
    name: "swarm",
    description: "启动或控制多智能体蜂群协作（/swarm <目标> | ui | status | pause | resume | stop）",
    argsHint: "[goal | ui | status | pause | resume | stop]",
    source: "builtin",
    async execute(rawArgs, env) {
      const trimmed = rawArgs.trim();
      const existing =
        (env.sessionId !== undefined ? service.getActiveSwarmForSession(env.sessionId) : undefined)
        ?? service.listSwarms({ cwd: env.cwd }).swarms.map((s) => service.getSnapshot(s.run.id))[0];

      if (trimmed === "" || trimmed === "ui" || trimmed === "board") {
        ctx.emit("swarm/open", {
          ...(existing === undefined ? {} : { swarmId: existing.run.id }),
          ...(env.sessionId === undefined ? {} : { sessionId: env.sessionId }),
          cwd: env.cwd,
          surface: "pane",
        });
        return {
          output: existing !== undefined
            ? `已打开蜂群任务面板。\n\n${formatSnapshotMarkdown(existing)}`
            : "已打开蜂群任务面板。可使用 `/swarm <任务目标>` 启动新蜂群。",
        };
      }

      if (trimmed === "status") {
        return {
          output: existing !== undefined
            ? formatSnapshotMarkdown(existing)
            : "当前会话或工作区暂无运行中的蜂群。使用 `/swarm <目标>` 创建蜂群。",
        };
      }

      if (trimmed === "pause" || trimmed === "resume" || trimmed === "stop") {
        if (existing === undefined) {
          return { isError: true, output: "当前没有可控制的活跃蜂群。" };
        }
        const res = await service.controlRun({ swarmId: existing.run.id, action: trimmed });
        return { output: `蜂群 \`${res.run.title}\` 状态已更新为 \`${res.run.status}\`。` };
      }

      const snap = await service.createSwarm({
        goal: trimmed,
        cwd: env.cwd,
        coordinatorSessionId: env.sessionId,
      });
      if (env.sessionId !== undefined) {
        ctx.tools.activate(env.sessionId, [SWARM_TOOL_GROUP, ...SWARM_TOOL_NAMES]);
      }
      ctx.emit("swarm/open", {
        swarmId: snap.run.id,
        ...(env.sessionId === undefined ? {} : { sessionId: env.sessionId }),
        cwd: env.cwd,
        surface: "pane",
      });
      return { prompt: buildCoordinatorKickoffPrompt(snap, trimmed) };
    },
  };
}

export function registerSwarmCapabilities(ctx: Context, service: SwarmService): () => void {
  const disposers: Array<() => void> = [];
  for (const tool of createSwarmTools(ctx, service)) {
    disposers.push(ctx.tools.register(tool));
  }
  disposers.push(ctx.commands.register(createSwarmCommand(ctx, service)));
  disposers.push(
    ctx.systemPrompt.section(
      "swarm-protocol",
      (env) => {
        const snap = service.getActiveSwarmForSession(env.sessionId);
        return snap === undefined ? undefined : buildSwarmProtocolSection(snap, env.sessionId);
      },
      { order: SectionOrder.guidelines + 50 },
    ),
  );
  return () => {
    for (const dispose of disposers) dispose();
  };
}

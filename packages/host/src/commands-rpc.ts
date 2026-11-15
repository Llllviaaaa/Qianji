/**
 * Slash command RPC endpoints (`command.list`, `command.run`), built-in Host
 * slash commands (`/clear`, `/compact`, `/doctor`, `/mcp`, `/skills`), and `command/changed`
 * broadcast notifications (ADR 0002, 0003).
 */
import type { Context } from "@deepseek-ai/cordis";
import "@qianji/agent";
import "@qianji/commands";
import "@qianji/llm";
import "@qianji/mcp";
import {
  ErrorCode,
  PROTOCOL_VERSION,
  type CommandListResult,
  type CommandRunResult,
} from "@qianji/protocol";
import "@qianji/session";
import "@qianji/tools";
import "./host-info.ts";
import type { PluginManager } from "./plugin-manager.ts";
import { RpcError, type RpcCall } from "./rpc.ts";

export const name = "qianji-commands-rpc";
export const inject = ["rpc", "commands", "sessions", "agents", "llm", "tools", "hostInfo"];

export interface Config {
  manager?: PluginManager | (() => PluginManager | undefined);
}

type Params = Record<string, unknown>;

function params(value: unknown): Params {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new RpcError(ErrorCode.InvalidParams, "params must be an object");
  }
  return value as Params;
}

function resolveManager(config: Config): PluginManager | undefined {
  return typeof config.manager === "function" ? config.manager() : config.manager;
}

export function apply(ctx: Context, config: Config = {}): void {
  ctx.effect(
    () =>
      ctx.commands.register({
        name: "clear",
        description: "开启新对话",
        source: "builtin",
        execute() {
          return { clientAction: "clear" };
        },
      }),
    "command: /clear",
  );

  ctx.effect(
    () =>
      ctx.commands.register({
        name: "compact",
        description: "压缩当前会话上下文",
        source: "builtin",
        execute() {
          return { clientAction: "compact" };
        },
      }),
    "command: /compact",
  );

  ctx.effect(
    () =>
      ctx.commands.register({
        name: "doctor",
        description: "检查宿主运行状态、模型服务商、插件与 MCP 连接",
        source: "builtin",
        async execute(_rawArgs, env) {
          const providers = ctx.llm.listProviders();
          const tools = ctx.tools.schemas();
          const manager = resolveManager(config);
          const plugins = manager ? await manager.list(env.cwd) : [];
          const activePlugins = plugins.filter((item) => item.status === "active").length;
          const erroredPlugins = plugins.filter((item) => item.status === "errored");
          const mcpService = ctx.get("mcp") as
            | {
                ready: Promise<void>;
                statuses(): Array<{ config: { id: string; name?: string }; connected: boolean; toolCount: number; error?: string }>;
              }
            | undefined;
          if (mcpService !== undefined) {
            await mcpService.ready;
          }
          const mcpStatuses = mcpService?.statuses() ?? [];

          const lines = [
            "### 千机 宿主诊断报告",
            `- **Host 版本**: \`${ctx.hostInfo.version}\`（协议 \`v${PROTOCOL_VERSION}\`）`,
            `- **当前工作目录**: \`${env.cwd}\``,
            `- **模型服务商**: 已加载 ${providers.length} 个${providers.length > 0 ? `（${providers.map((item) => `\`${item.id}\``).join("、")}）` : ""}`,
            `- **已注册工具**: ${tools.length} 个`,
          ];
          if (plugins.length > 0) {
            lines.push(
              `- **插件状态**: 共 ${plugins.length} 个（运行中 ${activePlugins} 个${erroredPlugins.length > 0 ? `，异常 ${erroredPlugins.length} 个` : ""}）`,
            );
            for (const broken of erroredPlugins) {
              lines.push(`  - ⚠️ \`${broken.id}\`: ${broken.error ?? "加载失败"}`);
            }
          }
          if (mcpStatuses.length === 0) {
            lines.push("- **MCP 服务器**: 未配置已启用服务");
          } else {
            const connectedCount = mcpStatuses.filter((item) => item.connected).length;
            lines.push(`- **MCP 服务器**: 已连接 ${connectedCount}/${mcpStatuses.length} 个`);
            for (const item of mcpStatuses) {
              const title = item.config.name || item.config.id;
              lines.push(
                item.connected
                  ? `  - ✅ **${title}** (\`${item.config.id}\`): ${item.toolCount} 个工具`
                  : `  - ❌ **${title}** (\`${item.config.id}\`): ${item.error ?? "未连接"}`,
              );
            }
          }
          return { output: lines.join("\n") };
        },
      }),
    "command: /doctor",
  );

  ctx.effect(
    () =>
      ctx.commands.register({
        name: "mcp",
        description: "打开 MCP 服务管理页或查看已启用 MCP 服务状态",
        source: "builtin",
        async execute() {
          const mcpService = ctx.get("mcp") as
            | {
                ready: Promise<void>;
                statuses(): Array<{
                  config: { id: string; name?: string; transport?: string };
                  connected: boolean;
                  toolCount: number;
                  error?: string;
                }>;
              }
            | undefined;
          if (mcpService !== undefined) {
            await mcpService.ready;
          }
          const statuses = mcpService?.statuses() ?? [];
          if (statuses.length === 0) {
            return { output: "当前未配置或未启用任何 MCP 服务器。可在设置 → 扩展插件（mcp）添加并启用连接器。" };
          }
          const connectedCount = statuses.filter((item) => item.connected).length;
          const totalTools = statuses.reduce((acc, item) => acc + item.toolCount, 0);
          const lines = [`### MCP 服务状态（已连接 ${connectedCount}/${statuses.length}，共 ${totalTools} 个工具）`];
          for (const item of statuses) {
            const title = item.config.name || item.config.id;
            const transport = item.config.transport ? `[${item.config.transport.toUpperCase()}] ` : "";
            lines.push(
              item.connected
                ? `- ✅ **${title}** ${transport}(\`${item.config.id}\`): ${item.toolCount} 个工具`
                : `- ❌ **${title}** ${transport}(\`${item.config.id}\`): ${item.error ?? "未连接"}`,
            );
          }
          return { output: lines.join("\n") };
        },
      }),
    "command: /mcp",
  );

  ctx.effect(
    () =>
      ctx.commands.register({
        name: "skills",
        description: "打开 Agent 技能管理页或列出已启用技能",
        source: "builtin",
        async execute(_rawArgs, env) {
          const allCommands = await ctx.commands.list(env.cwd);
          const skillCommands = allCommands.filter((item) => item.source === "skill");
          if (skillCommands.length === 0) {
            return { output: "当前工作区尚未启用任何 Agent 技能。可在设置 → 扩展插件（prompt-context）创建或启用技能。" };
          }
          const lines = [`### 已启用 Agent 技能（共 ${skillCommands.length} 个）`];
          for (const item of skillCommands) {
            lines.push(`- \`/${item.name}\` — ${item.description}`);
          }
          return { output: lines.join("\n") };
        },
      }),
    "command: /skills",
  );

  ctx.on("commands/changed", (reason) => {
    ctx.rpc.broadcast("command/changed", { reason });
  });

  ctx.effect(
    () =>
      ctx.rpc.method("command.list", async (raw): Promise<CommandListResult> => {
        const p = params(raw ?? {});
        const cwd = typeof p.cwd === "string" && p.cwd.trim() !== "" ? p.cwd.trim() : undefined;
        return { commands: await ctx.commands.list(cwd) };
      }),
    `${name}: command.list`,
  );

  ctx.effect(
    () =>
      ctx.rpc.method("command.run", async (raw, call: RpcCall): Promise<CommandRunResult> => {
        const p = params(raw ?? {});
        if (typeof p.name !== "string" || p.name.trim() === "") {
          throw new RpcError(ErrorCode.InvalidParams, "name must be a non-empty string");
        }
        const sessionId = typeof p.sessionId === "string" && p.sessionId.trim() !== "" ? p.sessionId.trim() : undefined;
        let cwd = typeof p.cwd === "string" && p.cwd.trim() !== "" ? p.cwd.trim() : undefined;
        if (cwd === undefined && sessionId !== undefined) {
          const found = await ctx.sessions.get(sessionId);
          cwd = found?.header.cwd;
        }
        const args = typeof p.args === "string" ? p.args : "";
        return ctx.commands.run(p.name, args, {
          ...(sessionId === undefined ? {} : { sessionId }),
          cwd: cwd ?? process.cwd(),
          signal: call.signal,
        });
      }),
    `${name}: command.run`,
  );
}

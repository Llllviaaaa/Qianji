/**
 * Slash command registrations (`/mcp-status`, `/mcp-diagnose`, `/mcp-resources`,
 * `/mcp-read`, `/mcp-prompts`) for the `@qianji/mcp` service (`packages/mcp/src/slash-commands.ts`).
 */
import type { Context } from "@deepseek-ai/cordis";
import "@qianji/commands";
import type { Mcp } from "./index.ts";

export function registerMcpSlashCommands(ctx: Context, mcp: Mcp): void {
  const formatStatuses = (): string => {
    const list = mcp.statuses();
    if (list.length === 0) return "### MCP 服务器状态\n\n尚未启用任何 MCP 服务器。";
    const rows = list.map((status) => {
      const label = status.config.name || status.config.id;
      const state = status.connected ? `已连接（${status.toolCount} 个工具）` : `未连接（${status.error || "连接失败"}）`;
      const caps = [
        status.hasResources ? "资源" : null,
        status.hasPrompts ? "提示词" : null,
        status.protocolVersion ? `协议 ${status.protocolVersion}` : null,
      ].filter(Boolean).join(" · ");
      return `- **${label}** (\`${status.config.id}\`, ${status.config.transport.toUpperCase()})：${state}${caps ? ` — ${caps}` : ""}`;
    });
    return `### MCP 服务器状态\n\n${rows.join("\n")}`;
  };

  ctx.inject(["commands"], (inner) => {
    const disposers = [
      inner.commands.register({
        name: "mcp-status",
        description: "查看 MCP 服务器连接状态、协议版本与工具数量",
        source: "mcp",
        async execute() {
          await inner.mcp.ready;
          return { output: formatStatuses() };
        },
      }),
      inner.commands.register({
        name: "mcp-diagnose",
        description: "诊断已启用的 MCP 服务器连接状态（等同 /mcp-status）",
        source: "mcp",
        async execute() {
          await inner.mcp.ready;
          return { output: formatStatuses() };
        },
      }),
      inner.commands.register({
        name: "mcp-resources",
        description: "列出已连接 MCP 服务器提供的只读资源",
        argsHint: "[serverId]",
        source: "mcp",
        async execute(rawArgs) {
          await inner.mcp.ready;
          const serverId = rawArgs.trim() || undefined;
          const resources = await inner.mcp.listAllResources(serverId);
          if (resources.length === 0) return { output: "### MCP 资源\n\n没有发现可用资源。" };
          const lines = resources.map((item) => {
            const title = item.title || item.name || item.uri;
            const meta = [item.serverName, item.mimeType, item.description].filter(Boolean).join(" · ");
            return `- **${title}** — \`${item.uri}\`${meta ? `（${meta}）` : ""}`;
          });
          return { output: `### MCP 资源列表\n\n${lines.join("\n")}` };
        },
      }),
      inner.commands.register({
        name: "mcp-read",
        description: "读取指定 MCP 资源 URI 的内容",
        argsHint: "[serverId] <uri>",
        source: "mcp",
        async execute(rawArgs) {
          const parts = rawArgs.trim().split(/\s+/).filter(Boolean);
          if (parts.length === 0) return { output: "用法：`/mcp-read [serverId] <uri>`", isError: true };
          const [first, second] = parts;
          const uri = second !== undefined ? second : (first ?? "");
          const serverId = second !== undefined ? first : undefined;
          const read = await inner.mcp.readServerResource(serverId, uri);
          return { output: read.text };
        },
      }),
      inner.commands.register({
        name: "mcp-prompts",
        description: "列出或解析 MCP 服务器的提示词模板",
        argsHint: "[serverId] [promptName]",
        source: "mcp",
        async execute(rawArgs) {
          const parts = rawArgs.trim().split(/\s+/).filter(Boolean);
          if (parts.length <= 1) {
            const prompts = await inner.mcp.listAllPrompts(parts[0]);
            if (prompts.length === 0) return { output: "### MCP 提示词\n\n没有发现可用提示词模板。" };
            const lines = prompts.map((item) => {
              const args = (item.arguments ?? []).map((arg) => `${arg.name}${arg.required ? "*" : ""}`).join(", ");
              return `- **${item.title || item.name}** (\`${item.serverId}\`)${item.description ? `：${item.description}` : ""}${args ? ` — 参数：\`${args}\`` : ""}`;
            });
            return { output: `### MCP 提示词模板\n\n${lines.join("\n")}` };
          }
          const [serverId, promptName] = parts;
          const resolved = await inner.mcp.getServerPrompt(serverId, promptName ?? "");
          return { output: resolved.markdown };
        },
      }),
    ];
    inner.effect(() => () => {
      for (const dispose of disposers) dispose();
    }, "mcp: slash commands");
  });
}

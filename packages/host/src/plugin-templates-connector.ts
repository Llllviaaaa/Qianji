/**
 * Scaffold template builder for `"connector"` plugins (`plugin_manager` `scaffold`),
 * registering a dual-mode (`agent` + `bot`) Connector via `qianji.connectors`
 * and `ctx.connectors.register` alongside read/write tools.
 */

export interface ConnectorTemplateInput {
  pluginId: string;
  title: string;
  description: string;
  toolPrefix: string;
}

export interface ConnectorTemplateSpec {
  pkgJson: Record<string, unknown>;
  tsconfigInclude: string[];
  files: Array<{ relPath: string; content: string }>;
}

export function buildConnectorTemplateSpec(input: ConnectorTemplateInput): ConnectorTemplateSpec {
  const { pluginId, title, description, toolPrefix } = input;
  const connectorId = toolPrefix;

  const pkgJson: Record<string, unknown> = {
    name: pluginId,
    version: "0.1.0",
    private: true,
    type: "module",
    description,
    main: "./index.ts",
    qianji: {
      id: pluginId,
      name: title,
      host: "./index.ts",
      targets: ["agent", "bot"],
      inject: ["tools", "connectors"],
      connectors: [
        {
          id: connectorId,
          name: title,
          tagline: description,
          category: "automation",
          authLabel: "插件连接器授权",
          starterPrompts: [`使用 ${title} 查询最新动态摘要`],
        },
      ],
      configSchema: {
        type: "object",
        properties: {
          endpointUrl: {
            type: "string",
            title: "服务地址",
            description: "连接器后端 API 地址",
            default: "https://api.example.com",
          },
        },
      },
    },
  };

  const hostSource = `import type { Context } from "@deepseek-ai/cordis";
import { textOutput } from "@qianji/tools";

export interface ConnectorPluginConfig {
  endpointUrl?: string;
}

export const name = ${JSON.stringify(pluginId)};
export const inject = ["tools", "connectors"];

export function apply(ctx: Context, config: ConnectorPluginConfig = {}): void {
  const endpoint = config.endpointUrl?.trim() || "https://api.example.com";

  ctx.connectors.register({
    id: ${JSON.stringify(connectorId)},
    name: ${JSON.stringify(title)},
    tagline: ${JSON.stringify(description)},
    category: "automation",
    authLabel: "插件连接器授权",
    async connect({ config: nextCfg }) {
      const target = typeof nextCfg.endpointUrl === "string" && nextCfg.endpointUrl.trim() !== ""
        ? nextCfg.endpointUrl.trim()
        : endpoint;
      return {
        connected: true,
        accountLabel: target,
      };
    },
    status() {
      return {
        connected: true,
        accountLabel: endpoint,
      };
    },
  });

  ctx.tools.register({
    name: "${toolPrefix}_query",
    description: \`[\${${JSON.stringify(title)}}] 查询最新条目与摘要（只读）\`,
    readOnly: true,
    parameters: {
      type: "object",
      properties: {
        query: { type: "string", description: "检索关键词" },
      },
    },
    async execute(args) {
      const q = typeof args.query === "string" ? args.query.trim() : "";
      return textOutput(JSON.stringify({ connector: ${JSON.stringify(connectorId)}, endpoint, query: q }, null, 2));
    },
  });

  ctx.tools.register({
    name: "${toolPrefix}_publish",
    description: \`[\${${JSON.stringify(title)}}] 提交外部变更（Bot 形态下默认进入批准栏确认）\`,
    readOnly: false,
    parameters: {
      type: "object",
      properties: {
        content: { type: "string", description: "待发布内容" },
      },
      required: ["content"],
    },
    async execute(args) {
      return textOutput(JSON.stringify({ ok: true, endpoint, content: String(args.content ?? "") }, null, 2));
    },
  });
}
`;

  return {
    pkgJson,
    tsconfigInclude: ["index.ts"],
    files: [{ relPath: "index.ts", content: hostSource }],
  };
}

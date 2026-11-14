import { useState } from "react";
import { Plus } from "lucide-react";
import type { McpServerConfig } from "../../types";
import {
  MCP_PRESET_TEMPLATES,
  parseKeyValuePairs,
  parseShellArgLine,
  type McpPresetTemplate,
  type Notice,
} from "../plugins/pluginHelpers";

export interface McpAddServerSectionProps {
  cwd: string;
  servers: McpServerConfig[];
  onAddServer: (server: McpServerConfig, feedback: string) => void;
  onNotify: (notice: Notice) => void;
}

/** Preset connectors and custom STDIO / HTTP MCP server creator. */
export function McpAddServerSection({ cwd, servers, onAddServer, onNotify }: McpAddServerSectionProps) {
  const [mcpTransport, setMcpTransport] = useState<"stdio" | "http">("stdio");
  const [mcpName, setMcpName] = useState("");
  const [mcpCmdLine, setMcpCmdLine] = useState("");
  const [mcpUrl, setMcpUrl] = useState("");
  const [mcpEnvLine, setMcpEnvLine] = useState("");
  const [mcpReadOnly, setMcpReadOnly] = useState(false);

  const handleAddPreset = (preset: McpPresetTemplate) => {
    if (servers.some((s) => s.id === preset.id)) return;
    onAddServer(
      {
        id: preset.id,
        name: preset.name,
        enabled: true,
        transport: "stdio",
        command: preset.command,
        args: preset.buildArgs(cwd),
        cwd: cwd.trim(),
        env: {},
        inheritEnvironment: true,
        url: "",
        headers: {},
        trustedReadOnly: preset.trustedReadOnly ?? false,
      },
      `已添加 MCP 连接器 "${preset.name}"，正在自动连接…`,
    );
  };

  const handleAddCustom = () => {
    const cleanName = mcpName.trim();
    if (mcpTransport === "stdio") {
      const tokens = parseShellArgLine(mcpCmdLine.trim());
      if (tokens.length === 0) {
        onNotify({ kind: "error", text: "请填写 STDIO 启动命令（例如 npx -y @playwright/mcp@latest）。" });
        return;
      }
      const [command, ...args] = tokens;
      const baseId = (cleanName || command).toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^-|-$/g, "") || "mcp";
      const uniqueId = servers.some((s) => s.id === baseId) ? `${baseId}-${Date.now().toString(36).slice(-4)}` : baseId;
      onAddServer(
        {
          id: uniqueId,
          name: cleanName || command,
          enabled: true,
          transport: "stdio",
          command,
          args,
          cwd: cwd.trim(),
          env: parseKeyValuePairs(mcpEnvLine),
          inheritEnvironment: true,
          url: "",
          headers: {},
          trustedReadOnly: mcpReadOnly,
        },
        `已添加 MCP 服务 "${cleanName || command}"。`,
      );
      setMcpName("");
      setMcpCmdLine("");
      setMcpEnvLine("");
      setMcpReadOnly(false);
      return;
    }

    const trimmedUrl = mcpUrl.trim();
    if (!/^https?:\/\//i.test(trimmedUrl)) {
      onNotify({ kind: "error", text: "请填写以 http:// 或 https:// 开头的远程 MCP 地址。" });
      return;
    }
    const hostFallback = (() => {
      try {
        return new URL(trimmedUrl).hostname;
      } catch {
        return "remote-mcp";
      }
    })();
    const baseId = (cleanName || hostFallback).toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^-|-$/g, "") || "http-mcp";
    const uniqueId = servers.some((s) => s.id === baseId) ? `${baseId}-${Date.now().toString(36).slice(-4)}` : baseId;
    onAddServer(
      {
        id: uniqueId,
        name: cleanName || hostFallback,
        enabled: true,
        transport: "http",
        command: "",
        args: [],
        cwd: "",
        env: {},
        inheritEnvironment: false,
        url: trimmedUrl,
        headers: parseKeyValuePairs(mcpEnvLine),
        trustedReadOnly: mcpReadOnly,
      },
      `已添加远程 MCP 服务 "${cleanName || hostFallback}"。`,
    );
    setMcpName("");
    setMcpUrl("");
    setMcpEnvLine("");
    setMcpReadOnly(false);
  };

  return (
    <>
      <div className="plugin-mcp-templates">
        <span className="plugin-mcp-section-label">一键挂载官方常用连接器</span>
        <div className="plugin-mcp-template-row">
          {MCP_PRESET_TEMPLATES.map((preset) => {
            const exists = servers.some((s) => s.id === preset.id);
            return (
              <button
                key={preset.id}
                type="button"
                className="plugin-mcp-template-pill"
                disabled={exists}
                onClick={() => handleAddPreset(preset)}
              >
                <span>{exists ? `✓ ${preset.name}` : preset.badge}</span>
              </button>
            );
          })}
        </div>
      </div>

      <div className="plugin-mcp-add-card">
        <div className="mcp-add-header">
          <span className="plugin-mcp-section-label">添加自定义 MCP 服务</span>
          <div className="settings-segmented">
            <button
              type="button"
              className={mcpTransport === "stdio" ? "active" : ""}
              onClick={() => setMcpTransport("stdio")}
            >
              {mcpTransport === "stdio" && <span className="settings-segmented-thumb" />}
              <span>STDIO 命令行</span>
            </button>
            <button
              type="button"
              className={mcpTransport === "http" ? "active" : ""}
              onClick={() => setMcpTransport("http")}
            >
              {mcpTransport === "http" && <span className="settings-segmented-thumb" />}
              <span>HTTP 远程</span>
            </button>
          </div>
        </div>

        <div className="plugin-mcp-add-grid">
          <input
            placeholder="显示名称（如 Postgres）"
            value={mcpName}
            onChange={(event) => setMcpName(event.target.value)}
          />
          {mcpTransport === "stdio" ? (
            <input
              className="mono"
              placeholder="启动命令，例如 npx -y @modelcontextprotocol/server-postgres postgresql://..."
              value={mcpCmdLine}
              onChange={(event) => setMcpCmdLine(event.target.value)}
            />
          ) : (
            <input
              className="mono"
              placeholder="远程 MCP Endpoint，例如 https://mcp.example.com/mcp"
              value={mcpUrl}
              onChange={(event) => setMcpUrl(event.target.value)}
            />
          )}
        </div>

        <input
          className="mono"
          placeholder={
            mcpTransport === "stdio"
              ? "环境变量（可选，格式 KEY=VALUE，多项用逗号分隔，例如 GITHUB_PERSONAL_ACCESS_TOKEN=ghp_...）"
              : "请求头（可选，格式 Authorization=Bearer xxx，多项用逗号分隔）"
          }
          value={mcpEnvLine}
          onChange={(event) => setMcpEnvLine(event.target.value)}
        />

        <div className="plugin-mcp-add-foot">
          <label className="plugin-watch-toggle">
            <input
              type="checkbox"
              checked={mcpReadOnly}
              onChange={(event) => setMcpReadOnly(event.target.checked)}
            />
            <span>信任为只读查询服务（工具调用免弹窗确认）</span>
          </label>
          <button type="button" className="primary-button" onClick={handleAddCustom}>
            <Plus size={13} />
            <span>添加连接器</span>
          </button>
        </div>
      </div>
    </>
  );
}

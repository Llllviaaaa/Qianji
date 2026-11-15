import { useMemo, useState } from "react";
import type { McpServerStatus } from "@qianji/protocol";
import { Check, Pencil, RefreshCw, Trash2 } from "lucide-react";
import type { AppSettings, McpServerConfig } from "../../types";
import { parseKeyValuePairs, parseShellArgLine, type Notice } from "./pluginHelpers";
import { McpAddServerSection } from "./McpAddServerSection";
import { McpInspectorPanel } from "./McpInspectorPanel";

export interface McpCapabilityDrawerProps {
  cwd: string;
  pluginEnabled: boolean;
  form: AppSettings;
  onSyncAppSetting: <K extends keyof AppSettings>(key: K, value: AppSettings[K]) => void;
  mcpStatuses: readonly McpServerStatus[];
  mcpReconnecting: boolean;
  onReconnectMcp: (serverId?: string) => void;
  onMcpServersUpdated: () => void;
  onNotify: (notice: Notice) => void;
  onCloseSettings?: () => void;
}

/** Unified MCP control center embedded inside the `mcp` core extension drawer. */
export function McpCapabilityDrawer({
  cwd,
  pluginEnabled,
  form,
  onSyncAppSetting,
  mcpStatuses,
  mcpReconnecting,
  onReconnectMcp,
  onMcpServersUpdated,
  onNotify,
  onCloseSettings,
}: McpCapabilityDrawerProps) {
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editName, setEditName] = useState("");
  const [editTarget, setEditTarget] = useState("");
  const [editCwd, setEditCwd] = useState("");
  const [editEnvLine, setEditEnvLine] = useState("");
  const [editReadOnly, setEditReadOnly] = useState(false);

  const servers = form.mcpServers ?? [];
  const statusMap = useMemo(() => new Map(mcpStatuses.map((item) => [item.id, item])), [mcpStatuses]);
  const connectedServers = useMemo(() => mcpStatuses.filter((item) => item.connected), [mcpStatuses]);
  const totalTools = useMemo(
    () => connectedServers.reduce((sum, item) => sum + item.toolCount, 0),
    [connectedServers],
  );

  const commitServers = (next: McpServerConfig[], feedback?: string) => {
    onSyncAppSetting("mcpServers", next);
    onMcpServersUpdated();
    if (feedback) onNotify({ kind: "success", text: feedback });
  };

  const upsertServer = (server: McpServerConfig, feedback: string) => {
    const exists = servers.some((item) => item.id === server.id);
    const next = exists
      ? servers.map((item) => (item.id === server.id ? server : item))
      : [...servers, server];
    commitServers(next, feedback);
  };

  const beginEdit = (srv: McpServerConfig) => {
    if (editingId === srv.id) {
      setEditingId(null);
      return;
    }
    setEditingId(srv.id);
    setEditName(srv.name);
    setEditTarget(srv.transport === "http" ? srv.url : [srv.command, ...srv.args].join(" "));
    setEditCwd(srv.cwd);
    setEditEnvLine("");
    setEditReadOnly(srv.trustedReadOnly);
  };

  const saveEdit = (srv: McpServerConfig) => {
    const cleanName = editName.trim() || srv.name || srv.id;
    const overrides = parseKeyValuePairs(editEnvLine);
    if (srv.transport === "http") {
      const url = editTarget.trim();
      if (!/^https?:\/\//i.test(url)) {
        onNotify({ kind: "error", text: "远程 MCP URL 需以 http:// 或 https:// 开头。" });
        return;
      }
      upsertServer(
        {
          ...srv,
          name: cleanName,
          url,
          trustedReadOnly: editReadOnly,
          headers: Object.keys(overrides).length > 0 ? { ...srv.headers, ...overrides } : srv.headers,
        },
        `已更新 MCP 服务 "${cleanName}"。`,
      );
      setEditingId(null);
      return;
    }

    const tokens = parseShellArgLine(editTarget.trim());
    const [command, ...args] = tokens;
    if (!command) {
      onNotify({ kind: "error", text: "STDIO 启动命令不能为空。" });
      return;
    }
    upsertServer(
      {
        ...srv,
        name: cleanName,
        command,
        args,
        cwd: editCwd.trim(),
        trustedReadOnly: editReadOnly,
        env: Object.keys(overrides).length > 0 ? { ...srv.env, ...overrides } : srv.env,
      },
      `已更新 MCP 服务 "${cleanName}"。`,
    );
    setEditingId(null);
  };

  return (
    <div className="plugin-structured-form">
      <div className="plugin-structured-row">
        <div className="plugin-structured-copy">
          <strong>工具调用安全确认</strong>
          <small>开启后，非只读 MCP 工具在首次执行副作用操作前会请求你的批准</small>
        </div>
        <div className="plugin-structured-control">
          <button
            type="button"
            role="switch"
            aria-checked={form.mcpConfirmTools}
            aria-label="MCP 工具调用前确认"
            className={`settings-switch ${form.mcpConfirmTools ? "on" : ""}`}
            onClick={() => onSyncAppSetting("mcpConfirmTools", !form.mcpConfirmTools)}
          >
            <span />
          </button>
        </div>
      </div>

      <div className="mcp-overview-footer">
        <div className="mcp-overview-stats">
          <span className="plugin-op-chip">已配置 {servers.length} 项</span>
          <span className={`plugin-op-chip${connectedServers.length > 0 ? " tone-green" : ""}`}>
            已连接 {connectedServers.length} 项
          </span>
          <span className="plugin-op-chip tone-accent">已暴露 {totalTools} 个工具</span>
        </div>
        <button
          type="button"
          className="secondary-button"
          disabled={!pluginEnabled || mcpReconnecting || servers.length === 0}
          onClick={() => onReconnectMcp(undefined)}
        >
          <RefreshCw size={12.5} />
          <span>重连全部</span>
        </button>
      </div>

      <div className="plugin-mcp-block">
        <div className="plugin-mcp-block-head">
          <strong>已配置服务器 ({servers.length})</strong>
          <small>支持启用开关、行内编辑启动参数与单服务热重连；敏感密钥加密保存在本机 secrets 存储</small>
        </div>

        {servers.length === 0 ? (
          <div className="plugin-drawer-note">
            尚未配置任何 MCP 服务器。你可以直接启用下方官方常用模板，或添加自定义 STDIO / HTTP 服务。
          </div>
        ) : (
          <div className="plugin-mcp-server-list">
            {servers.map((srv) => {
              const st = statusMap.get(srv.id);
              const cmdSummary = srv.transport === "http" ? srv.url : [srv.command, ...srv.args].join(" ");
              const isEditing = editingId === srv.id;
              return (
                <div key={srv.id} className="mcp-server-card" data-mcp-server-id={srv.id}>
                  <div className="plugin-mcp-server-item">
                    <div className="plugin-mcp-server-main">
                      <div className="plugin-mcp-server-title">
                        <strong>{srv.name || srv.id}</strong>
                        <span className="plugin-quiet-pill">{srv.transport.toUpperCase()}</span>
                        {srv.trustedReadOnly && <span className="plugin-quiet-pill">只读免确认</span>}
                        {st?.resources && <span className="plugin-quiet-pill">Resources</span>}
                        {st?.prompts && <span className="plugin-quiet-pill">Prompts</span>}
                        {!srv.enabled || !pluginEnabled ? (
                          <span className="plugin-op-chip">已停用</span>
                        ) : st?.connected ? (
                          <span className="plugin-op-chip tone-green">已连接 · {st.toolCount} 个工具</span>
                        ) : st?.error ? (
                          <span className="plugin-op-chip tone-warn" title={st.error}>连接失败：{st.error.slice(0, 42)}</span>
                        ) : (
                          <span className="plugin-op-chip">待连接</span>
                        )}
                      </div>
                      <div className="plugin-mcp-server-cmd" title={cmdSummary}>{cmdSummary}</div>
                    </div>

                    <div className="plugin-mcp-server-actions">
                      <button
                        type="button"
                        className={`plugin-ghost-btn icon-only${isEditing ? " active" : ""}`}
                        title="编辑配置"
                        aria-label={`编辑 ${srv.name || srv.id}`}
                        onClick={() => beginEdit(srv)}
                      >
                        <Pencil size={12.5} />
                      </button>
                      <button
                        type="button"
                        className="plugin-ghost-btn icon-only"
                        title="重新连接该服务"
                        aria-label={`重新连接 ${srv.name || srv.id}`}
                        disabled={!pluginEnabled || mcpReconnecting || !srv.enabled}
                        onClick={() => onReconnectMcp(srv.id)}
                      >
                        <RefreshCw size={12.5} />
                      </button>
                      <button
                        type="button"
                        role="switch"
                        aria-checked={srv.enabled}
                        aria-label={`${srv.enabled ? "停用" : "启用"} MCP ${srv.name || srv.id}`}
                        className={`settings-switch ${srv.enabled ? "on" : ""}`}
                        onClick={() => {
                          const next = servers.map((item) => (
                            item.id === srv.id ? { ...item, enabled: !item.enabled } : item
                          ));
                          commitServers(next);
                        }}
                      >
                        <span />
                      </button>
                      <button
                        type="button"
                        className="plugin-ghost-btn danger icon-only"
                        title="移除该 MCP 服务"
                        aria-label={`移除 ${srv.name || srv.id}`}
                        onClick={() => {
                          if (isEditing) setEditingId(null);
                          commitServers(servers.filter((item) => item.id !== srv.id));
                        }}
                      >
                        <Trash2 size={12.5} />
                      </button>
                    </div>
                  </div>

                  {isEditing && (
                    <div className="mcp-edit-drawer">
                      <div className="plugin-mcp-add-grid">
                        <input
                          placeholder="显示名称"
                          value={editName}
                          onChange={(event) => setEditName(event.target.value)}
                        />
                        <input
                          className="mono"
                          placeholder={srv.transport === "http" ? "远程 Endpoint URL" : "STDIO 启动命令"}
                          value={editTarget}
                          onChange={(event) => setEditTarget(event.target.value)}
                        />
                      </div>
                      {srv.transport === "stdio" && (
                        <input
                          className="mono"
                          placeholder="工作目录 cwd（留空则使用当前项目目录）"
                          value={editCwd}
                          onChange={(event) => setEditCwd(event.target.value)}
                        />
                      )}
                      <input
                        className="mono"
                        placeholder={
                          srv.transport === "http"
                            ? "补充/覆盖请求头（KEY=VALUE，留空保留已存加密凭证）"
                            : "补充/覆盖环境变量（KEY=VALUE，留空保留已存加密密钥）"
                        }
                        value={editEnvLine}
                        onChange={(event) => setEditEnvLine(event.target.value)}
                      />
                      <div className="plugin-mcp-add-foot">
                        <label className="plugin-watch-toggle">
                          <input
                            type="checkbox"
                            checked={editReadOnly}
                            onChange={(event) => setEditReadOnly(event.target.checked)}
                          />
                          <span>信任为只读查询服务（免弹窗确认）</span>
                        </label>
                        <div className="mcp-edit-buttons">
                          <button type="button" className="secondary-button" onClick={() => setEditingId(null)}>
                            取消
                          </button>
                          <button type="button" className="primary-button" onClick={() => saveEdit(srv)}>
                            <Check size={12.5} />
                            <span>保存修改</span>
                          </button>
                        </div>
                      </div>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>

      <McpAddServerSection
        cwd={cwd}
        servers={servers}
        onAddServer={upsertServer}
        onNotify={onNotify}
      />

      <details className="plugin-raw-json-details">
        <summary>高级能力探测（Resources · Prompts）</summary>
        <div className="mcp-drawer-inspector-wrap">
          <McpInspectorPanel
            connectedServers={connectedServers}
            onNotify={onNotify}
            onCloseSettings={onCloseSettings}
          />
        </div>
      </details>
    </div>
  );
}

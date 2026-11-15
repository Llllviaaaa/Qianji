import { useMemo, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import type { McpPromptInfo, McpResourceInfo, McpServerStatus } from "@qianji/protocol";
import { BookOpen, Copy, Database, Eye, Play, RefreshCw, Sparkles } from "lucide-react";
import { describeError } from "../../lib/errors";
import { mcpClient } from "../../lib/mcpClient";
import { queryKeys } from "../../lib/queries";
import { rewindController } from "../../lib/rewindController";
import type { Notice } from "./pluginHelpers";

export interface McpInspectorPanelProps {
  connectedServers: readonly McpServerStatus[];
  onNotify: (notice: Notice) => void;
  onCloseSettings?: () => void;
}

type InspectorTab = "resources" | "prompts";

const NO_RESOURCES: McpResourceInfo[] = [];
const NO_PROMPTS: McpPromptInfo[] = [];

/** Live inspector for MCP Resources and Prompts exposed by connected servers. */
export function McpInspectorPanel({
  connectedServers,
  onNotify,
  onCloseSettings,
}: McpInspectorPanelProps) {
  const [tab, setTab] = useState<InspectorTab>("resources");
  const [serverFilter, setServerFilter] = useState<string>("all");
  const [resourcePreview, setResourcePreview] = useState<{ key: string; text: string } | null>(null);
  const [activePromptKey, setActivePromptKey] = useState<string | null>(null);
  const [promptArgs, setPromptArgs] = useState<Record<string, string>>({});
  const [promptPreview, setPromptPreview] = useState<{ key: string; markdown: string } | null>(null);

  const selectedServerId = useMemo(() => {
    if (serverFilter === "all") return undefined;
    return connectedServers.some((srv) => srv.id === serverFilter) ? serverFilter : undefined;
  }, [connectedServers, serverFilter]);

  const queryFilterKey = selectedServerId ?? "all";

  const resourcesQuery = useQuery({
    queryKey: queryKeys.mcpResources(queryFilterKey),
    queryFn: () => mcpClient.resources(selectedServerId),
    enabled: connectedServers.length > 0 && tab === "resources",
  });

  const promptsQuery = useQuery({
    queryKey: queryKeys.mcpPrompts(queryFilterKey),
    queryFn: () => mcpClient.prompts(selectedServerId),
    enabled: connectedServers.length > 0 && tab === "prompts",
  });

  const readResourceMutation = useMutation({
    mutationFn: (res: McpResourceInfo) => mcpClient.readResource(res.serverId, res.uri),
    onSuccess: (result) => {
      setResourcePreview({ key: `${result.serverId}:${result.uri}`, text: result.text });
    },
    onError: (err) => onNotify({ kind: "error", text: describeError(err) }),
  });

  const getPromptMutation = useMutation({
    mutationFn: (params: { prompt: McpPromptInfo; args: Record<string, string> }) =>
      mcpClient.getPrompt(params.prompt.serverId, params.prompt.name, params.args),
    onSuccess: (result) => {
      setPromptPreview({ key: `${result.serverId}:${result.name}`, markdown: result.markdown });
    },
    onError: (err) => onNotify({ kind: "error", text: describeError(err) }),
  });

  const resources = resourcesQuery.data ?? NO_RESOURCES;
  const prompts = promptsQuery.data ?? NO_PROMPTS;

  const copyText = async (text: string, label: string) => {
    try {
      await navigator.clipboard.writeText(text);
      onNotify({ kind: "success", text: `已复制${label}。` });
    } catch (err) {
      onNotify({ kind: "error", text: describeError(err) });
    }
  };

  return (
    <section className="mcp-inspector-card" aria-label="MCP 资源与提示词模板检视">
      <div className="mcp-inspector-head">
        <div>
          <h3>在线资源与提示词模板</h3>
          <small>直接浏览已连接 MCP 服务器暴露的 Resources 与 Prompts，并将模板一键插入对话</small>
        </div>
        <div className="mcp-inspector-controls">
          <select
            aria-label="筛选已连接的 MCP 服务"
            value={selectedServerId ?? "all"}
            onChange={(event) => setServerFilter(event.target.value)}
            disabled={connectedServers.length === 0}
          >
            <option value="all">全部已连接服务（{connectedServers.length}）</option>
            {connectedServers.map((srv) => (
              <option key={srv.id} value={srv.id}>{srv.name || srv.id}</option>
            ))}
          </select>

          <div className="settings-segmented" role="tablist" aria-label="检视类别">
            <button
              type="button"
              role="tab"
              aria-selected={tab === "resources"}
              className={tab === "resources" ? "active" : ""}
              onClick={() => setTab("resources")}
            >
              {tab === "resources" && <span className="settings-segmented-thumb" />}
              <Database size={12.5} />
              <span>Resources</span>
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={tab === "prompts"}
              className={tab === "prompts" ? "active" : ""}
              onClick={() => setTab("prompts")}
            >
              {tab === "prompts" && <span className="settings-segmented-thumb" />}
              <BookOpen size={12.5} />
              <span>Prompts</span>
            </button>
          </div>

          <button
            type="button"
            className="plugin-ghost-btn icon-only"
            title="刷新检视列表"
            aria-label="刷新检视列表"
            disabled={connectedServers.length === 0}
            onClick={() => {
              if (tab === "resources") void resourcesQuery.refetch();
              else void promptsQuery.refetch();
            }}
          >
            <RefreshCw size={12.5} />
          </button>
        </div>
      </div>

      {connectedServers.length === 0 ? (
        <div className="mcp-inspector-empty">暂无已连接的 MCP 服务器；启用并连接服务器后可在此浏览 Resources 与 Prompts。</div>
      ) : tab === "resources" ? (
        resourcesQuery.isPending ? (
          <div className="mcp-inspector-empty">正在读取 MCP Resources…</div>
        ) : resourcesQuery.isError ? (
          <div className="plugin-inline-alert error">
            <span>读取 MCP Resources 失败：{describeError(resourcesQuery.error)}</span>
          </div>
        ) : resources.length === 0 ? (
          <div className="mcp-inspector-empty">当前已连接的 MCP 服务器未声明可浏览的 Resources。</div>
        ) : (
          <div className="mcp-inspector-list">
            {resources.map((res) => {
              const key = `${res.serverId}:${res.uri}`;
              const shown = resourcePreview?.key === key;
              return (
                <div key={key} className="mcp-inspector-row">
                  <div className="mcp-inspector-row-top">
                    <div className="mcp-inspector-meta">
                      <div className="plugin-mcp-server-title">
                        <strong>{res.title || res.name || res.uri}</strong>
                        <span className="plugin-quiet-pill">{res.serverName}</span>
                        {res.mimeType && <span className="plugin-quiet-pill">{res.mimeType}</span>}
                      </div>
                      {res.description && <p className="mcp-inspector-desc">{res.description}</p>}
                      <code className="mcp-inspector-uri">{res.uri}</code>
                    </div>
                    <button
                      type="button"
                      className="plugin-ghost-btn"
                      disabled={readResourceMutation.isPending}
                      onClick={() => {
                        if (shown) setResourcePreview(null);
                        else readResourceMutation.mutate(res);
                      }}
                    >
                      <Eye size={12.5} />
                      <span>{shown ? "收起" : "读取内容"}</span>
                    </button>
                  </div>
                  {shown && resourcePreview && (
                    <div className="mcp-inspector-preview-box">
                      <pre className="mcp-inspector-preview">{resourcePreview.text}</pre>
                      <div className="mcp-inspector-preview-actions">
                        <button
                          type="button"
                          className="plugin-ghost-btn"
                          onClick={() => void copyText(resourcePreview.text, "资源内容")}
                        >
                          <Copy size={12} />
                          <span>复制内容</span>
                        </button>
                      </div>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )
      ) : promptsQuery.isPending ? (
        <div className="mcp-inspector-empty">正在读取 MCP Prompts…</div>
      ) : promptsQuery.isError ? (
        <div className="plugin-inline-alert error">
          <span>读取 MCP Prompts 失败：{describeError(promptsQuery.error)}</span>
        </div>
      ) : prompts.length === 0 ? (
        <div className="mcp-inspector-empty">当前已连接的 MCP 服务器未声明 Prompts 模板。</div>
      ) : (
        <div className="mcp-inspector-list">
          {prompts.map((prompt) => {
            const key = `${prompt.serverId}:${prompt.name}`;
            const expanded = activePromptKey === key;
            const args = prompt.arguments ?? [];
            return (
              <div key={key} className="mcp-inspector-row">
                <div className="mcp-inspector-row-top">
                  <div className="mcp-inspector-meta">
                    <div className="plugin-mcp-server-title">
                      <strong>{prompt.title || prompt.name}</strong>
                      <span className="plugin-quiet-pill">{prompt.serverName}</span>
                      {args.length > 0 && <span className="plugin-quiet-pill">{args.length} 个参数</span>}
                    </div>
                    {prompt.description && <p className="mcp-inspector-desc">{prompt.description}</p>}
                  </div>
                  <button
                    type="button"
                    className="plugin-ghost-btn"
                    onClick={() => {
                      if (expanded) {
                        setActivePromptKey(null);
                      } else {
                        setActivePromptKey(key);
                        setPromptArgs({});
                      }
                    }}
                  >
                    <Sparkles size={12.5} />
                    <span>{expanded ? "收起" : "填充调用"}</span>
                  </button>
                </div>

                {expanded && (
                  <div className="mcp-inspector-preview-box">
                    {args.length > 0 && (
                      <div className="mcp-prompt-args">
                        {args.map((arg) => (
                          <label key={arg.name} className="mcp-prompt-arg-field">
                            <span>
                              {arg.name}
                              {arg.required ? " *" : ""}
                            </span>
                            <input
                              placeholder={arg.description || `输入 ${arg.name}`}
                              value={promptArgs[arg.name] ?? ""}
                              onChange={(event) =>
                                setPromptArgs((prev) => ({ ...prev, [arg.name]: event.target.value }))
                              }
                            />
                          </label>
                        ))}
                      </div>
                    )}
                    <div className="mcp-inspector-preview-actions">
                      <button
                        type="button"
                        className="primary-button"
                        disabled={getPromptMutation.isPending}
                        onClick={() => getPromptMutation.mutate({ prompt, args: promptArgs })}
                      >
                        <Play size={12} />
                        <span>生成预览</span>
                      </button>
                      {promptPreview?.key === key && (
                        <button
                          type="button"
                          className="secondary-button"
                          onClick={() => {
                            rewindController.setComposerDraft({ text: promptPreview.markdown, focus: true });
                            onNotify({ kind: "success", text: `已将模板 "${prompt.name}" 填入对话输入框。` });
                            onCloseSettings?.();
                          }}
                        >
                          <span>填入对话输入框</span>
                        </button>
                      )}
                    </div>
                    {promptPreview?.key === key && (
                      <pre className="mcp-inspector-preview">{promptPreview.markdown}</pre>
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </section>
  );
}

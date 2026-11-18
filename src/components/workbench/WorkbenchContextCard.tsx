import { useCallback, useEffect, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { save as saveDialog } from "@tauri-apps/plugin-dialog";
import {
  ChevronDown,
  ChevronRight,
  Cpu,
  Download,
  FileText,
  FolderOpen,
  Plug,
  RefreshCw,
  TerminalSquare,
} from "lucide-react";
import type { HostInfoResult } from "@qianji/protocol";
import { useSyncOnChange } from "../../hooks/useSyncOnChange";
import { agent } from "../../lib/agent";
import { deriveEnvSources } from "../../lib/envSources";
import { describeError } from "../../lib/errors";
import { harnessRuntimes, isRpcMethodNotFound } from "../../lib/harnessRuntime";
import { useAppStore } from "../../store";
import { useWorkbenchStore } from "../../stores/workbenchStore";

export interface WorkbenchContextCardProps {
  cwd: string;
  sessionFile: string | null;
}

interface DiagnosticsLogsResult {
  dir: string;
}

interface DiagnosticsExportResult {
  path: string;
  files: string[];
}

const RULE_FILE_NAMES = new Set(["agents.md", "claude.md", ".cursorrules"]);

export function WorkbenchContextCard({ cwd, sessionFile }: WorkbenchContextCardProps) {
  const messages = useAppStore((state) => state.messages);
  const stats = useAppStore((state) => state.stats);
  const model = useAppStore((state) => state.model);
  const logs = useAppStore((state) => state.hostLog);
  const summaryFocus = useWorkbenchStore((state) => state.summaryFocus);
  const diagnosticsRef = useRef<HTMLElement>(null);
  const [diagExpanded, setDiagExpanded] = useState(() => summaryFocus === "diagnostics");
  const [logFilter, setLogFilter] = useState<"all" | "warn" | "error">("all");
  const [exporting, setExporting] = useState(false);

  useSyncOnChange([summaryFocus], () => {
    if (summaryFocus === "diagnostics") setDiagExpanded(true);
  });

  useEffect(() => {
    if (summaryFocus === "diagnostics") {
      diagnosticsRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
    }
  }, [summaryFocus]);

  const usageQuery = useQuery({
    queryKey: ["workbench-usage", messages.length],
    queryFn: () => agent.usageSummary(),
    staleTime: 10_000,
  });

  const mcpQuery = useQuery({
    queryKey: ["workbench-mcp"],
    queryFn: () => agent.mcpStatus(),
    staleTime: 10_000,
  });

  const rulesQuery = useQuery({
    queryKey: ["workbench-context-rules", cwd],
    queryFn: async () => {
      try {
        const entries = await agent.listWorkspaceDir(cwd);
        return entries.filter((entry) => !entry.isDir && RULE_FILE_NAMES.has(entry.name.toLowerCase()));
      } catch {
        return [];
      }
    },
    enabled: Boolean(cwd),
    staleTime: 30_000,
  });

  const resourcesQuery = useQuery({
    queryKey: ["workbench-context-resources", cwd],
    queryFn: async () => {
      try {
        return await agent.listResources(cwd);
      } catch {
        return [];
      }
    },
    enabled: Boolean(cwd),
    staleTime: 30_000,
  });

  const hostInfoQuery = useQuery({
    queryKey: ["workbench-host-info"],
    queryFn: () => harnessRuntimes.call<HostInfoResult>("host.info"),
    staleTime: 30_000,
  });

  const diagLogsQuery = useQuery({
    queryKey: ["workbench-diag-dir"],
    queryFn: async (): Promise<DiagnosticsLogsResult> => {
      try {
        return await harnessRuntimes.call<DiagnosticsLogsResult>("diagnostics.logs");
      } catch (error) {
        if (isRpcMethodNotFound(error)) return { dir: "" };
        throw error;
      }
    },
    staleTime: 60_000,
  });

  const handleReconnectMcp = useCallback(async (serverId?: string) => {
    try {
      await agent.mcpReconnect(serverId);
      await mcpQuery.refetch();
      useAppStore.getState().showToast("已重新连接 MCP 服务", "info");
    } catch (error) {
      useAppStore.getState().showToast(`重连 MCP 失败：${describeError(error)}`, "error");
    }
  }, [mcpQuery]);

  const handleExportDiagnostics = useCallback(async () => {
    const destination = await saveDialog({
      defaultPath: `pi-desktop-diagnostics-${new Date().toISOString().slice(0, 10)}.zip`,
      filters: [{ name: "ZIP 归档", extensions: ["zip"] }],
    });
    if (!destination) return;
    setExporting(true);
    try {
      const result = await harnessRuntimes.call<DiagnosticsExportResult>("diagnostics.export", {
        path: destination,
        desktop: { cwd, sessionFile, recentLogs: logs.slice(-200) },
      });
      useAppStore.getState().showToast(`已导出诊断包（含 ${result.files.length} 个文件）`, "info");
    } catch (error) {
      useAppStore.getState().showToast(`导出诊断包失败：${describeError(error)}`, "error");
    } finally {
      setExporting(false);
    }
  }, [cwd, logs, sessionFile]);

  const contextTokens = stats?.contextUsage?.tokens ?? stats?.tokens.total ?? 0;
  const contextWindow = stats?.contextUsage?.contextWindow ?? model?.contextWindow ?? 0;
  const rawContextPercent = stats?.contextUsage?.percent;
  const contextPct = typeof rawContextPercent === "number"
    ? Math.min(100, Math.max(0, Math.round(rawContextPercent)))
    : contextWindow > 0 && contextTokens > 0
      ? Math.min(100, Math.round((contextTokens / contextWindow) * 100))
      : null;

  const meterTone = contextPct !== null && contextPct >= 90
    ? "danger"
    : contextPct !== null && contextPct >= 75
      ? "warn"
      : "normal";

  const resources = resourcesQuery.data ?? [];
  const skillCount = resources.filter((item) => item.kind === "skill").length;
  const extCount = resources.filter((item) => item.kind === "extension").length;
  const ruleFiles = rulesQuery.data ?? [];
  const sources = deriveEnvSources(messages, 6);
  const mcpServers = mcpQuery.data ?? [];

  const filteredLogs = logs.filter((line) => {
    if (logFilter === "all") return true;
    const lower = line.toLowerCase();
    if (logFilter === "error") return lower.includes("error") || lower.includes("失败") || lower.includes("异常");
    return lower.includes("warn") || lower.includes("error") || lower.includes("失败");
  });

  return (
    <>
      <section className="pid-wb-cowork-card">
        <header className="pid-wb-card-header">
          <div className="pid-wb-card-title">
            <Cpu size={14} />
            <span>上下文探针</span>
          </div>
          <div className="pid-wb-subbar-actions">
            {contextPct !== null && (
              <span className={`pid-wb-badge${meterTone !== "normal" ? ` ${meterTone}` : ""}`}>
                {contextPct}%
              </span>
            )}
            <button
              type="button"
              className="pid-wb-icon-btn"
              title="刷新上下文与用量"
              onClick={() => void usageQuery.refetch()}
            >
              <RefreshCw size={12} />
            </button>
          </div>
        </header>

        <div className="pid-wb-context-meter">
          <div className="pid-wb-context-meter-row">
            <span>{(stats?.tokens.total ?? 0).toLocaleString()} tokens</span>
            <span className="pid-wb-muted">
              {contextWindow > 0 ? `/ ${contextWindow.toLocaleString()} 窗口` : ""} · ${(stats?.cost ?? 0).toFixed(4)}
            </span>
          </div>
          {contextPct !== null && (
            <div className="pid-wb-progress-track" aria-hidden="true">
              <div className={`pid-wb-progress-fill tone-${meterTone}`} style={{ width: `${contextPct}%` }} />
            </div>
          )}
          {usageQuery.data && (
            <div className="pid-wb-muted" style={{ fontSize: "11px" }}>
              累计 {usageQuery.data.sessions} 会话 · {usageQuery.data.totalTokens.toLocaleString()} tokens · ${usageQuery.data.totalCost.toFixed(4)}
            </div>
          )}
        </div>

        {(ruleFiles.length > 0 || skillCount > 0 || extCount > 0) && (
          <div className="pid-wb-context-chips">
            {ruleFiles.map((entry) => (
              <button
                key={entry.path}
                type="button"
                className="pid-wb-context-chip is-clickable"
                title={`打开规则文件 ${entry.path}`}
                onClick={() => void useWorkbenchStore.getState().openFile(cwd, entry.path)}
              >
                <FileText size={11} />
                <span>{entry.name}</span>
              </button>
            ))}
            {skillCount > 0 && <span className="pid-wb-context-chip">{skillCount} Skills</span>}
            {extCount > 0 && <span className="pid-wb-context-chip">{extCount} Extensions</span>}
          </div>
        )}

        <div className="pid-wb-context-subsection">
          <div className="pid-wb-context-subhead">
            <span className="pid-wb-card-sublabel">
              <Plug size={12} />
              <span>MCP 服务</span>
            </span>
            <button
              type="button"
              className="pid-wb-icon-btn"
              title="重连全部 MCP 服务"
              onClick={() => void handleReconnectMcp()}
            >
              <RefreshCw size={11} />
            </button>
          </div>
          {mcpServers.length === 0 ? (
            <div className="pid-wb-card-empty">暂未配置启用的 MCP 服务。</div>
          ) : (
            <ul className="pid-wb-mcp-list">
              {mcpServers.map((server) => (
                <li key={server.id} className="pid-wb-mcp-row">
                  <div>
                    <strong>{server.name}</strong>
                    <span className="pid-wb-muted"> ({server.transport} · {server.toolCount} 工具)</span>
                    {server.error && <div className="pid-wb-subagent-error">{server.error}</div>}
                  </div>
                  <span className={`pid-wb-status-pill ${server.connected ? "completed" : "failed"}`}>
                    {server.connected ? "已连接" : "断开"}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </div>

        {sources.length > 0 && (
          <div className="pid-wb-context-subsection">
            <span className="pid-wb-card-sublabel">近期读取与工具来源</span>
            <ul className="pid-wb-output-list">
              {sources.map((src) => (
                <li key={src.id} className="pid-wb-source-row">
                  <span className="pid-wb-source-label" title={src.detail || src.label}>{src.label}</span>
                  <span className="pid-wb-muted">{src.activity} ×{src.count}</span>
                </li>
              ))}
            </ul>
          </div>
        )}
      </section>

      <section ref={diagnosticsRef} className="pid-wb-cowork-card" data-diagnostics-section>
        <header className="pid-wb-card-header">
          <button
            type="button"
            className="pid-wb-card-collapse-btn"
            aria-expanded={diagExpanded}
            onClick={() => setDiagExpanded((open) => !open)}
          >
            {diagExpanded ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
            <TerminalSquare size={14} />
            <span>宿主诊断与日志</span>
            {logs.length > 0 && <span className="pid-wb-badge">{logs.length}</span>}
          </button>
          <div className="pid-wb-subbar-actions">
            {diagLogsQuery.data?.dir && (
              <button
                type="button"
                className="pid-wb-icon-btn"
                title={`打开日志目录：${diagLogsQuery.data.dir}`}
                onClick={() => void agent.openWorkspaceInFileManager(diagLogsQuery.data?.dir ?? "")}
              >
                <FolderOpen size={12} />
              </button>
            )}
            <button
              type="button"
              className="pid-wb-btn small"
              disabled={exporting}
              onClick={() => void handleExportDiagnostics()}
            >
              <Download size={12} />
              <span>{exporting ? "导出中…" : "导出诊断包"}</span>
            </button>
          </div>
        </header>
        {diagExpanded && (
          <>
            {hostInfoQuery.data && (
              <div className="pid-wb-meta-strip">
                <span>Host v{hostInfoQuery.data.version}</span>
                <span className="pid-wb-muted">协议 v{hostInfoQuery.data.protocolVersion}</span>
              </div>
            )}
            <div className="pid-wb-filter-pills">
              <button
                type="button"
                className={`pid-wb-pill${logFilter === "all" ? " active" : ""}`}
                onClick={() => setLogFilter("all")}
              >
                全部 ({logs.length})
              </button>
              <button
                type="button"
                className={`pid-wb-pill${logFilter === "warn" ? " active" : ""}`}
                onClick={() => setLogFilter("warn")}
              >
                警告/错误
              </button>
              <button
                type="button"
                className={`pid-wb-pill${logFilter === "error" ? " active" : ""}`}
                onClick={() => setLogFilter("error")}
              >
                仅错误
              </button>
            </div>
            {filteredLogs.length === 0 ? (
              <div className="pid-wb-card-empty">暂无匹配的运行日志记录。</div>
            ) : (
              <pre className="pid-wb-log-box">
                {filteredLogs.slice(-120).join("\n")}
              </pre>
            )}
          </>
        )}
      </section>
    </>
  );
}

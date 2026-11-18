import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { save as saveDialog } from "@tauri-apps/plugin-dialog";
import {
  ChevronDown,
  ChevronRight,
  Download,
  FileText,
  FolderOpen,
  RefreshCw,
} from "lucide-react";
import type { HostInfoResult } from "@qianji/protocol";
import { useSyncOnChange } from "../../hooks/useSyncOnChange";
import { agent } from "../../lib/agent";
import { describeError } from "../../lib/errors";
import { harnessRuntimes, isRpcMethodNotFound } from "../../lib/harnessRuntime";
import { useAppStore } from "../../store";
import { useWorkbenchStore } from "../../stores/workbenchStore";

export interface WorkbenchContextCardProps {
  cwd: string;
  sessionFile: string | null;
  children?: ReactNode;
}

interface DiagnosticsLogsResult {
  dir: string;
}

interface DiagnosticsExportResult {
  path: string;
  files: string[];
}

const RULE_FILE_NAMES = new Set(["agents.md", "claude.md", ".cursorrules"]);

export function WorkbenchContextCard({ cwd, sessionFile, children }: WorkbenchContextCardProps) {
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
    enabled: diagExpanded,
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
    enabled: diagExpanded,
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
      defaultPath: `qianji-diagnostics-${new Date().toISOString().slice(0, 10)}.zip`,
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
  const mcpServers = mcpQuery.data ?? [];

  const hasContextActivity = messages.length > 0
    || contextTokens > 0
    || ruleFiles.length > 0
    || skillCount > 0
    || extCount > 0;

  const filteredLogs = logs.filter((line) => {
    if (logFilter === "all") return true;
    const lower = line.toLowerCase();
    if (logFilter === "error") return lower.includes("error") || lower.includes("失败") || lower.includes("异常");
    return lower.includes("warn") || lower.includes("error") || lower.includes("失败");
  });

  return (
    <>
      <section className="pid-wb-inspector-section">
        <header className="pid-wb-inspector-head">
          <span>上下文</span>
          {contextPct !== null && (
            <span className={`pid-wb-inspector-metric${meterTone !== "normal" ? ` ${meterTone}` : ""}`}>
              {contextPct}%
            </span>
          )}
        </header>

        {!hasContextActivity ? (
          <p className="pid-wb-inspector-empty">发送消息后查看上下文用量。</p>
        ) : (
          <div className="pid-wb-inspector-context">
            {contextPct !== null && (
              <div className="pid-wb-progress-track" aria-hidden="true">
                <div className={`pid-wb-progress-fill tone-${meterTone}`} style={{ width: `${contextPct}%` }} />
              </div>
            )}
            <div className="pid-wb-inspector-token-row">
              <span>{contextTokens.toLocaleString()} tokens</span>
              {contextWindow > 0 && (
                <span className="pid-wb-muted">/ {contextWindow.toLocaleString()}</span>
              )}
            </div>
            {(ruleFiles.length > 0 || skillCount > 0 || extCount > 0) && (
              <div className="pid-wb-inspector-chips">
                {ruleFiles.map((entry) => (
                  <button
                    key={entry.path}
                    type="button"
                    className="pid-wb-inspector-chip is-clickable"
                    title={`打开规则文件 ${entry.path}`}
                    onClick={() => void useWorkbenchStore.getState().openFile(cwd, entry.path)}
                  >
                    <FileText size={11} />
                    <span>{entry.name}</span>
                  </button>
                ))}
                {skillCount > 0 && <span className="pid-wb-inspector-chip">{skillCount} Skills</span>}
                {extCount > 0 && <span className="pid-wb-inspector-chip">{extCount} Extensions</span>}
              </div>
            )}
          </div>
        )}
      </section>

      <section className="pid-wb-inspector-section">
        <header className="pid-wb-inspector-head">
          <span>连接器</span>
          <button
            type="button"
            className="pid-wb-icon-btn small"
            title="重连 MCP 服务"
            aria-label="重连 MCP 服务"
            onClick={() => void handleReconnectMcp()}
          >
            <RefreshCw size={11} />
          </button>
        </header>

        {mcpServers.length === 0 ? (
          <p className="pid-wb-inspector-empty">暂未连接外部扩展服务。</p>
        ) : (
          <ul className="pid-wb-inspector-list">
            {mcpServers.map((server) => (
              <li key={server.id} className="pid-wb-connector-row">
                <span className={`pid-wb-status-dot${server.connected ? " online" : " offline"}`} />
                <span className="pid-wb-connector-name">{server.name}</span>
                <span className="pid-wb-muted">{server.toolCount} 工具</span>
              </li>
            ))}
          </ul>
        )}
      </section>

      {children}

      <section ref={diagnosticsRef} className="pid-wb-inspector-section is-footer" data-diagnostics-section>
        <div className="pid-wb-inspector-head">
          <button
            type="button"
            className="pid-wb-diag-toggle"
            aria-expanded={diagExpanded}
            onClick={() => setDiagExpanded((open) => !open)}
          >
            {diagExpanded ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
            <span>诊断日志</span>
            {logs.length > 0 && <span className="pid-wb-muted">({logs.length})</span>}
          </button>
          {diagExpanded && (
            <div className="pid-wb-subbar-actions">
              {diagLogsQuery.data?.dir && (
                <button
                  type="button"
                  className="pid-wb-icon-btn small"
                  title={`打开日志目录：${diagLogsQuery.data.dir}`}
                  onClick={() => void agent.openWorkspaceInFileManager(diagLogsQuery.data?.dir ?? "")}
                >
                  <FolderOpen size={11} />
                </button>
              )}
              <button
                type="button"
                className="pid-wb-icon-btn small"
                disabled={exporting}
                title="导出诊断包"
                onClick={() => void handleExportDiagnostics()}
              >
                <Download size={11} />
              </button>
            </div>
          )}
        </div>

        {diagExpanded && (
          <div className="pid-wb-diag-body">
            {hostInfoQuery.data && (
              <div className="pid-wb-diag-meta">
                Host v{hostInfoQuery.data.version} · 协议 v{hostInfoQuery.data.protocolVersion}
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
                警告
              </button>
              <button
                type="button"
                className={`pid-wb-pill${logFilter === "error" ? " active" : ""}`}
                onClick={() => setLogFilter("error")}
              >
                错误
              </button>
            </div>
            {filteredLogs.length === 0 ? (
              <p className="pid-wb-inspector-empty">暂无运行日志。</p>
            ) : (
              <pre className="pid-wb-log-box">{filteredLogs.slice(-120).join("\n")}</pre>
            )}
          </div>
        )}
      </section>
    </>
  );
}

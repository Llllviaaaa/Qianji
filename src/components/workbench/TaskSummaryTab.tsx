import { useQuery } from "@tanstack/react-query";
import {
  CheckCircle2,
  Circle,
  Clock,
  FileCode2,
  FileText,
  Folder,
  Globe,
  MessageSquare,
  Monitor,
  Puzzle,
} from "lucide-react";
import type { PlanGetResult } from "@qianji/protocol";
import { agent } from "../../lib/agent";
import { useClientContributions } from "../../lib/clientContributions";
import {
  deriveSubagentActivities,
  deriveTaskOutputs,
  deriveTaskPlan,
} from "../../lib/envSources";
import {
  HARNESS_SESSION_PREFIX,
  harnessRuntimes,
  isHarnessSessionFile,
  isRpcMethodNotFound,
} from "../../lib/harnessRuntime";
import { useAppStore } from "../../store";
import { useWorkbenchPaneAvailable } from "../../kernel/runtime/featureSlotQueries";
import { useWorkbenchLayoutStore } from "../../stores/workbenchLayoutStore";
import { previewKindForPath, useWorkbenchStore } from "../../stores/workbenchStore";
import { WorkbenchContextCard } from "./WorkbenchContextCard";

export interface TaskSummaryTabProps {
  cwd: string;
  sessionFile: string | null;
}

function splitWorkspaceDisplay(cwd: string): { name: string; parent: string } {
  const cleaned = cwd.replace(/[\\/]+$/, "");
  if (!cleaned) return { name: "未选择工作区", parent: "" };
  const parts = cleaned.split(/[\\/]/).filter(Boolean);
  const name = parts.pop() ?? cleaned;
  const sep = cleaned.includes("\\") ? "\\" : "/";
  const parent = parts.length > 0 ? parts.join(sep) : "";
  return { name, parent };
}

function renderOutputGlyph(filePath: string) {
  const kind = previewKindForPath(filePath);
  if (kind === "html" || kind === "svg") return <Globe size={13} className="pid-wb-output-icon" />;
  const ext = filePath.split(".").pop()?.toLowerCase() ?? "";
  if (["ts", "tsx", "js", "jsx", "py", "rs", "css", "json", "vue"].includes(ext)) {
    return <FileCode2 size={13} className="pid-wb-output-icon" />;
  }
  return <FileText size={13} className="pid-wb-output-icon" />;
}

export function TaskSummaryTab({ cwd, sessionFile }: TaskSummaryTabProps) {
  const messages = useAppStore((state) => state.messages);
  const git = useAppStore((state) => state.git);
  const sideChatEnabled = useWorkbenchPaneAvailable("side-chat");
  const openPanes = useWorkbenchLayoutStore((state) => state.openPanes);
  const contributions = useClientContributions();

  const hostSessionId = sessionFile && isHarnessSessionFile(sessionFile)
    ? sessionFile.slice(HARNESS_SESSION_PREFIX.length)
    : undefined;

  const planQuery = useQuery({
    queryKey: ["workbench-plan", hostSessionId, messages.length],
    queryFn: async (): Promise<PlanGetResult> => {
      try {
        return await harnessRuntimes.call<PlanGetResult>("plan.get", { sessionId: hostSessionId });
      } catch (error) {
        if (isRpcMethodNotFound(error)) return { plan: { explanation: "", items: [] } };
        throw error;
      }
    },
    enabled: Boolean(hostSessionId),
    staleTime: 4_000,
  });

  const derivedPlan = deriveTaskPlan(messages);
  const rpcPlan = planQuery.data?.plan;
  const planSteps = (rpcPlan && rpcPlan.items.length > 0)
    ? rpcPlan.items
    : (derivedPlan?.steps ?? []);
  const completedSteps = planSteps.filter((step) => step.status === "completed").length;

  const subagents = deriveSubagentActivities(messages);
  const outputs = deriveTaskOutputs(messages, 20);
  const ws = splitWorkspaceDisplay(cwd);
  const uncommittedCount = git?.files.length ?? 0;

  return (
    <div className="pid-wb-pane pid-wb-inspector-pane">
      <div className="pid-wb-scroll pid-wb-inspector-scroll">
        {/* 1. Environment */}
        <section className="pid-wb-inspector-section">
          <header className="pid-wb-inspector-head">
            <span>运行环境</span>
          </header>
          <div className="pid-wb-env-rows">
            <div className="pid-wb-env-row">
              <Monitor size={13} className="pid-wb-env-icon" />
              <span>本机环境</span>
              {git?.branch && <span className="pid-wb-env-branch">{git.branch}</span>}
            </div>
            <button
              type="button"
              className="pid-wb-env-row is-folder"
              disabled={!cwd}
              title={cwd || "未选择工作区"}
              onClick={() => {
                if (cwd) void agent.openWorkspaceInFileManager(cwd);
              }}
            >
              <Folder size={13} className="pid-wb-env-icon" />
              <span className="pid-wb-env-name">{ws.name}</span>
              {ws.parent && <span className="pid-wb-env-parent">{ws.parent}</span>}
            </button>
          </div>
        </section>

        {/* 2. Context, Connectors, Outputs, and quiet Diagnostics Footer */}
        <WorkbenchContextCard cwd={cwd} sessionFile={sessionFile}>
          {(planSteps.length > 0 || subagents.length > 0) && (
            <section className="pid-wb-inspector-section">
              <header className="pid-wb-inspector-head">
                <span>任务进度</span>
                {planSteps.length > 0 && (
                  <span className="pid-wb-muted">
                    {completedSteps}/{planSteps.length}
                  </span>
                )}
              </header>
              {planSteps.length > 0 && (
                <ul className="pid-wb-plan-list">
                  {planSteps.map((step) => (
                    <li key={step.id} className={`pid-wb-plan-item status-${step.status}`}>
                      {step.status === "completed" ? (
                        <CheckCircle2 size={13} className="pid-wb-plan-icon done" />
                      ) : step.status === "in_progress" ? (
                        <Clock size={13} className="pid-wb-plan-icon active" />
                      ) : (
                        <Circle size={13} className="pid-wb-plan-icon" />
                      )}
                      <span>{step.text}</span>
                    </li>
                  ))}
                </ul>
              )}
              {subagents.length > 0 && (
                <ul className="pid-wb-inspector-list">
                  {subagents.map((item) => (
                    <li key={item.id} className="pid-wb-connector-row">
                      <span className={`pid-wb-status-dot ${item.status === "completed" ? "online" : item.status === "failed" ? "offline" : "running"}`} />
                      <span className="pid-wb-connector-name">{item.label}</span>
                      <span className="pid-wb-muted">{item.role}</span>
                    </li>
                  ))}
                </ul>
              )}
            </section>
          )}

          {/* 3. Outputs */}
          <section className="pid-wb-inspector-section">
            <header className="pid-wb-inspector-head">
              <span>产出文件</span>
              {uncommittedCount > 0 && (
                <button
                  type="button"
                  className="pid-wb-inspector-action"
                  onClick={() => useWorkbenchStore.getState().openReview()}
                >
                  审查 ({uncommittedCount})
                </button>
              )}
            </header>
            {outputs.length > 0 ? (
              <ul className="pid-wb-output-list">
                {outputs.map((output) => {
                  const fileName = output.path.split(/[\\/]/).pop() ?? output.path;
                  return (
                    <li key={output.id} className="pid-wb-output-row">
                      <button
                        type="button"
                        className="pid-wb-output-btn"
                        title={output.path}
                        onClick={() => {
                          if (cwd) void useWorkbenchStore.getState().openFile(cwd, output.path);
                        }}
                      >
                        {renderOutputGlyph(output.path)}
                        <span className="pid-wb-output-name">{fileName}</span>
                      </button>
                    </li>
                  );
                })}
              </ul>
            ) : (
              <p className="pid-wb-inspector-empty">本轮尚未写入或修改工作区文件。</p>
            )}
          </section>

          {/* 4. Extension & Side Chat Panels */}
          {(sideChatEnabled || contributions.rightWorkbenchTabs.length > 0) && (
            <section className="pid-wb-inspector-section">
              <header className="pid-wb-inspector-head">
                <span>扩展视图</span>
              </header>
              <div className="pid-wb-ext-tabs" role="tablist" aria-label="扩展面板">
                {sideChatEnabled && (
                  <button
                    type="button"
                    role="tab"
                    data-wb-tab="side-chat"
                    aria-selected={openPanes.includes("side-chat")}
                    className={`pid-wb-ext-tab-btn${openPanes.includes("side-chat") ? " active" : ""}`}
                    onClick={() => useWorkbenchLayoutStore.getState().activateExtensionPane("side-chat")}
                  >
                    <MessageSquare size={12} />
                    <span>侧边对话</span>
                  </button>
                )}
                {contributions.rightWorkbenchTabs.map((tab) => (
                  <button
                    key={tab.id}
                    type="button"
                    role="tab"
                    data-wb-tab={tab.id}
                    aria-selected={openPanes.includes(tab.id)}
                    className={`pid-wb-ext-tab-btn${openPanes.includes(tab.id) ? " active" : ""}`}
                    onClick={() => useWorkbenchLayoutStore.getState().activateExtensionPane(tab.id)}
                  >
                    {tab.icon ?? <Puzzle size={12} />}
                    <span>{tab.label}</span>
                  </button>
                ))}
              </div>
            </section>
          )}
        </WorkbenchContextCard>
      </div>
    </div>
  );
}

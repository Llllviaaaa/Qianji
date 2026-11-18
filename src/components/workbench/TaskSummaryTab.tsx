import { useQuery } from "@tanstack/react-query";
import {
  Activity,
  Bot,
  CheckCircle2,
  Circle,
  Clock,
  Eye,
  FolderOpen,
  GitBranch,
  GitCompare,
  ListChecks,
} from "lucide-react";
import type { PlanGetResult } from "@qianji/protocol";
import { agent } from "../../lib/agent";
import {
  deriveSubagentActivities,
  deriveTaskOutputs,
  deriveTaskPlan,
  summarizeSubagents,
} from "../../lib/envSources";
import {
  HARNESS_SESSION_PREFIX,
  harnessRuntimes,
  isHarnessSessionFile,
  isRpcMethodNotFound,
} from "../../lib/harnessRuntime";
import { useAppStore } from "../../store";
import { previewKindForPath, useWorkbenchStore } from "../../stores/workbenchStore";
import { WorkbenchContextCard } from "./WorkbenchContextCard";

export interface TaskSummaryTabProps {
  cwd: string;
  sessionFile: string | null;
}

export function TaskSummaryTab({ cwd, sessionFile }: TaskSummaryTabProps) {
  const messages = useAppStore((state) => state.messages);
  const isStreaming = useAppStore((state) => state.isStreaming);
  const git = useAppStore((state) => state.git);

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
  const planExplanation = rpcPlan?.explanation || derivedPlan?.explanation || "";
  const completedSteps = planSteps.filter((step) => step.status === "completed").length;
  const planProgressPct = planSteps.length > 0 ? Math.round((completedSteps / planSteps.length) * 100) : 0;

  const subagents = deriveSubagentActivities(messages);
  const subagentSummary = summarizeSubagents(subagents);
  const outputs = deriveTaskOutputs(messages, 20);

  let activeCalls: NonNullable<typeof messages[number]["toolCalls"]> = [];
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const msg = messages[i];
    if (msg?.role === "assistant" && msg.toolCalls && msg.toolCalls.length > 0) {
      activeCalls = msg.toolCalls.slice(-3);
      break;
    }
  }

  const workspaceLabel = cwd.split(/[\\/]/).filter(Boolean).pop() || cwd || "未选择工作区";
  const uncommittedCount = git?.files.length ?? 0;

  return (
    <div className="pid-wb-pane">
      <div className="pid-wb-scroll pid-wb-summary-scroll">
        {/* Card 1: Progress */}
        <section className="pid-wb-cowork-card">
          <header className="pid-wb-card-header">
            <div className="pid-wb-card-title">
              <ListChecks size={14} />
              <span>任务进度</span>
            </div>
            {planSteps.length > 0 ? (
              <span className="pid-wb-badge">
                {completedSteps}/{planSteps.length}
              </span>
            ) : isStreaming ? (
              <span className="pid-wb-status-pill running">执行中</span>
            ) : null}
          </header>

          {planSteps.length > 0 && (
            <div className="pid-wb-progress-track" aria-label={`计划完成进度 ${planProgressPct}%`}>
              <div className="pid-wb-progress-fill tone-normal" style={{ width: `${planProgressPct}%` }} />
            </div>
          )}

          {planExplanation && <p className="pid-wb-card-desc">{planExplanation}</p>}

          {planSteps.length === 0 ? (
            isStreaming && activeCalls.length > 0 ? (
              <ul className="pid-wb-plan-list">
                {activeCalls.map((call) => (
                  <li key={call.id} className="pid-wb-plan-item">
                    {call.running ? (
                      <Clock size={14} className="pid-wb-plan-icon active" />
                    ) : (
                      <CheckCircle2 size={14} className="pid-wb-plan-icon done" />
                    )}
                    <span>{call.name}</span>
                  </li>
                ))}
              </ul>
            ) : (
              <div className="pid-wb-card-empty">
                {isStreaming ? "Agent 正在处理当前请求…" : "当前会话尚未创建结构化计划。"}
              </div>
            )
          ) : (
            <ul className="pid-wb-plan-list">
              {planSteps.map((step) => (
                <li key={step.id} className={`pid-wb-plan-item status-${step.status}`}>
                  {step.status === "completed" ? (
                    <CheckCircle2 size={14} className="pid-wb-plan-icon done" />
                  ) : step.status === "in_progress" ? (
                    <Clock size={14} className="pid-wb-plan-icon active" />
                  ) : (
                    <Circle size={14} className="pid-wb-plan-icon" />
                  )}
                  <span>{step.text}</span>
                </li>
              ))}
            </ul>
          )}

          {subagents.length > 0 && (
            <div className="pid-wb-context-subsection">
              <div className="pid-wb-context-subhead">
                <span className="pid-wb-card-sublabel">
                  <Bot size={12} />
                  <span>子代理协作</span>
                </span>
                <span className="pid-wb-badge">
                  运行 {subagentSummary.running} · 完成 {subagentSummary.completed}
                  {subagentSummary.failed > 0 ? ` · 失败 ${subagentSummary.failed}` : ""}
                </span>
              </div>
              <div className="pid-wb-subagent-list">
                {subagents.map((item) => (
                  <div key={item.id} className={`pid-wb-subagent-card status-${item.status}`}>
                    <div className="pid-wb-subagent-top">
                      <strong>{item.label}</strong>
                      <span className="pid-wb-badge">{item.role}</span>
                      <span className={`pid-wb-status-pill ${item.status}`}>
                        {item.status === "running"
                          ? "运行中"
                          : item.status === "completed"
                            ? "已完成"
                            : item.status === "failed"
                              ? "失败"
                              : "排队中"}
                      </span>
                    </div>
                    <p className="pid-wb-subagent-task">{item.task}</p>
                    {item.error && <p className="pid-wb-subagent-error">{item.error}</p>}
                    {item.output && !item.error && (
                      <p className="pid-wb-subagent-output">{item.output.slice(0, 180)}</p>
                    )}
                  </div>
                ))}
              </div>
            </div>
          )}
        </section>

        {/* Card 2: Working Folder & Deliverables */}
        <section className="pid-wb-cowork-card">
          <header className="pid-wb-card-header">
            <div className="pid-wb-card-title">
              <FolderOpen size={14} />
              <span>工作目录与产出</span>
            </div>
            {uncommittedCount > 0 && (
              <button
                type="button"
                className="pid-wb-btn small"
                onClick={() => useWorkbenchStore.getState().openReview()}
              >
                <GitCompare size={12} />
                <span>审查变更 ({uncommittedCount})</span>
              </button>
            )}
          </header>

          <div className="pid-wb-context-chips">
            <button
              type="button"
              className="pid-wb-context-chip is-clickable"
              disabled={!cwd}
              title={cwd ? `在文件管理器中打开 ${cwd}` : "未选择工作区"}
              onClick={() => {
                if (cwd) void agent.openWorkspaceInFileManager(cwd);
              }}
            >
              <FolderOpen size={11} />
              <span>{workspaceLabel}</span>
            </button>
            {git?.branch && (
              <span className="pid-wb-context-chip">
                <GitBranch size={11} />
                <span>{git.branch}</span>
              </span>
            )}
          </div>

          {outputs.length > 0 ? (
            <ul className="pid-wb-output-list">
              {outputs.map((output) => {
                const canPreview = previewKindForPath(output.path) !== null;
                return (
                  <li key={output.id} className="pid-wb-output-row">
                    <button
                      type="button"
                      className="pid-wb-output-btn"
                      onClick={() => {
                        if (cwd) void useWorkbenchStore.getState().openFile(cwd, output.path);
                      }}
                    >
                      <span>{output.path}</span>
                      <span className="pid-wb-muted">{output.activity === "written" ? "写入" : "修改"} ×{output.count}</span>
                    </button>
                    {canPreview && (
                      <button
                        type="button"
                        className="pid-wb-icon-btn"
                        title="在右侧预览文件"
                        aria-label={`预览 ${output.path}`}
                        onClick={() => {
                          if (cwd) void useWorkbenchStore.getState().openFile(cwd, output.path, { viewMode: "preview" });
                        }}
                      >
                        <Eye size={12} />
                      </button>
                    )}
                  </li>
                );
              })}
            </ul>
          ) : (
            <div className="pid-wb-card-empty">
              {uncommittedCount > 0 ? (
                <button
                  type="button"
                  className="pid-wb-inline-link"
                  onClick={() => useWorkbenchStore.getState().openReview()}
                >
                  <Activity size={12} />
                  <span>工作区当前有 {uncommittedCount} 个未提交变更，点击审查</span>
                </button>
              ) : (
                "本轮尚未写入或修改工作区文件。"
              )}
            </div>
          )}
        </section>

        {/* Card 3: Context Inspector + Collapsible Diagnostics */}
        <WorkbenchContextCard cwd={cwd} sessionFile={sessionFile} />
      </div>
    </div>
  );
}

/**
 * Session-Scoped Conversation Integrations for `swarm` (`src/builtin-plugins/swarm/SwarmConversationCards.tsx`).
 *
 * Strictly bound to Swarm-enabled sessions:
 * 1. `SwarmLiveCapsule` (`conversation.turnFooter`): Concentric inline telemetry capsule
 *    with procedural Pixel Bees cluster, 1-line `tabular-nums` prose, `3px` progress track,
 *    and quiet `查看面板` pill opening the Right Workbench `"swarm"` pane.
 * 2. `SwarmToolCallCard` (`conversation.toolCall`): Native-blended 24px transcript tool row
 *    with 14px muted icon, crisp 500-weight label, muted summary, hover chevron, and `打开面板` pill.
 */
import { useState, type ReactNode } from "react";
import {
  ChevronDown,
  ChevronRight,
  LoaderCircle,
  MessageSquare,
  Moon,
} from "lucide-react";
import { useFrontendService } from "@qianji/client";
import type {
  ConversationToolCallSlotProps,
  ConversationTurnFooterSlotProps,
  SlotComponentProps,
} from "@qianji/client-slots";
import { SwarmBeeCluster, SwarmPixelBee } from "./SwarmPixelBee";
import {
  deriveOutcomeOverview,
  patchSwarmUi,
  resolveSessionSwarmSummary,
  useSwarmData,
  useSwarmUi,
} from "./swarmStore";
import { openSwarmAuxPane } from "./SwarmWorkbenchPane";

/* ── 1. Inline `SwarmLiveCapsule` (`conversation.turnFooter`) ── */

export function SwarmLiveCapsule({
  sessionFile,
  sessionId,
  ctx,
}: SlotComponentProps<ConversationTurnFooterSlotProps, "session">): ReactNode {
  const data = useSwarmData();
  const ui = useSwarmUi();
  const workbenchService = useFrontendService("workbenchService", ctx);

  const summary = resolveSessionSwarmSummary(data, ui, sessionId, sessionFile);
  if (summary === undefined) return null;

  const snap = data.snapshotsById[summary.run.id];
  const overview = snap !== undefined ? deriveOutcomeOverview(snap) : null;

  const done = overview !== null ? overview.doneCount : summary.taskCounts.completed;
  const total = overview !== null ? overview.totalCount : summary.taskCounts.total;
  const dirtyFiles = overview !== null ? overview.dirtyFileCount : 0;

  const queen = snap?.members.find((m) => m.role === "coordinator" || m.name === "coordinator");
  const workerMembers =
    snap !== undefined
      ? snap.members.filter((m) => m.role !== "coordinator" && m.name !== "coordinator" && !m.killed)
      : [];
  const workerCount =
    snap !== undefined ? workerMembers.length : Math.max(0, summary.memberCounts.total - 1);
  const workingWorkers =
    snap !== undefined
      ? workerMembers.filter((m) => m.state === "working").length
      : Math.max(0, summary.memberCounts.working - 1);

  const isCompleted =
    summary.run.status === "completed" ||
    (total > 0 && done >= total && workingWorkers === 0 && summary.memberCounts.working === 0);

  let prose: string;
  if (isCompleted) {
    prose =
      dirtyFiles > 0
        ? `已完成 ${Math.max(done, total)} 项协作任务，${dirtyFiles} 处代码变更待合并`
        : `已完成 ${Math.max(done, total)} 项蜂群协作任务`;
  } else if (summary.run.status === "paused") {
    prose = `蜂群调度已暂停，已完成 ${done}/${total} 项`;
  } else if (workingWorkers > 0) {
    prose = `${workingWorkers} 名专职成员并行推进中，已完成 ${done}/${total} 项`;
  } else if (workerCount === 0) {
    prose = queen?.currentStep
      ? `协调者正在推进：${queen.currentStep}`
      : "协调者正在分析仓库并规划分工…";
  } else {
    prose = `${workerCount} 名成员待命协同，已完成 ${done}/${total} 项`;
  }

  const pct =
    isCompleted
      ? 100
      : total > 0
        ? Math.min(100, Math.round((done / total) * 100))
        : workingWorkers > 0
          ? 24
          : 10;

  return (
    <button
      type="button"
      className={`qj-swarm-live-capsule${isCompleted ? " is-completed" : ""}`}
      data-testid="swarm-live-capsule"
      aria-label={`${prose}，点击查看面板`}
      onClick={() => {
        patchSwarmUi({ activeSwarmId: summary.run.id });
        openSwarmAuxPane(workbenchService);
      }}
    >
      <SwarmBeeCluster members={snap?.members} workingCount={summary.memberCounts.working} />

      <span className="qj-swarm-capsule-center">
        <span className="qj-swarm-capsule-prose">{prose}</span>
        <span className="qj-swarm-capsule-track" aria-hidden="true">
          <span
            className={`qj-swarm-capsule-fill${isCompleted ? " is-completed" : ""}`}
            style={{ width: `${pct}%` }}
          />
        </span>
      </span>

      <span className="qj-swarm-capsule-cta">查看面板</span>
    </button>
  );
}

export const SwarmTurnFooterCard = SwarmLiveCapsule;

/* ── 2. Native-Blended Swarm Tool Call Row (`conversation.toolCall`) ── */

const SWARM_ACTION_LABELS: Readonly<Record<string, string>> = {
  add: "派生蜂群成员",
  status: "查看蜂群编队",
  models: "查询可用模型",
  model: "切换成员模型",
  kill: "退役蜂群成员",
  title: "命名蜂群任务",
  plan: "更新蜂群任务主线",
};

function summarizeSwarmToolCall(toolName: string, args: Record<string, unknown>): {
  readonly label: string;
  readonly detail: string;
} {
  if (toolName === "post_message") {
    const channel =
      typeof args.channel === "string" && args.channel !== "" && args.channel !== "main"
        ? ` #${args.channel}`
        : "";
    const text = typeof args.text === "string" ? args.text.replace(/\s+/g, " ").trim().slice(0, 68) : "";
    return { label: `发布消息板${channel}`, detail: text };
  }
  if (toolName === "read_board") {
    const detail =
      typeof args.since === "number"
        ? `#${args.since} 之后`
        : Array.isArray(args.seqs) && args.seqs.length > 0
          ? `#${args.seqs.join(", #")}`
          : "最新消息";
    return { label: "读取消息板", detail };
  }
  if (toolName === "swarm_wait") {
    const since = typeof args.since === "number" ? `#${args.since}` : "#0";
    return { label: "待命监听消息板", detail: `${since} 之后唤醒` };
  }
  const action = typeof args.action === "string" ? args.action : "status";
  if (action === "plan") {
    const goalTitle = typeof args.goalTitle === "string" ? args.goalTitle : "";
    return { label: "更新蜂群任务主线", detail: goalTitle };
  }
  const name = typeof args.name === "string" && args.name !== "" ? `@${args.name}` : "";
  const role = typeof args.role === "string" && args.role !== "" ? args.role : "";
  const title = typeof args.title === "string" && args.title !== "" ? args.title : "";
  const model = action === "model" && typeof args.model === "string" ? args.model : "";
  return {
    label: SWARM_ACTION_LABELS[action] ?? `蜂群调度 (${action})`,
    detail: [name, role, model, title].filter((x) => x !== "").join(" "),
  };
}

export function SwarmToolCallCard({
  call,
  state,
  ctx,
}: SlotComponentProps<ConversationToolCallSlotProps, "session">): ReactNode {
  const [expanded, setExpanded] = useState(false);
  const workbenchService = useFrontendService("workbenchService", ctx);
  const { label, detail } = summarizeSwarmToolCall(call.name, call.args);
  const hasPayload = Object.keys(call.args).length > 0 || Boolean(call.result);

  return (
    <div
      className={`qj-swarm-tool-card state-${state}`}
      data-tool={call.name}
      data-state={state}
      data-expanded={expanded ? "true" : undefined}
      data-testid={`swarm-tool-call-${call.name}`}
    >
      <div className="qj-swarm-tool-row">
        <button
          type="button"
          className="qj-swarm-tool-trigger"
          aria-expanded={hasPayload ? expanded : undefined}
          onClick={() => hasPayload && setExpanded((v) => !v)}
        >
          <span className="qj-swarm-tool-icon" aria-hidden="true">
            {state === "running" ? (
              <LoaderCircle className="qj-swarm-spin-icon" size={14} />
            ) : call.name === "swarm_wait" ? (
              <Moon size={14} />
            ) : call.name === "post_message" || call.name === "read_board" ? (
              <MessageSquare size={14} />
            ) : (
              <SwarmPixelBee name="coordinator" isQueen state="waiting" size="sm" className="qj-tool-bee" />
            )}
          </span>
          <span className="qj-swarm-tool-label">{label}</span>
          {detail !== "" && <span className="qj-swarm-tool-detail">{detail}</span>}
          {hasPayload && (
            <span className="qj-swarm-tool-chevron" aria-hidden="true">
              {expanded ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
            </span>
          )}
        </button>

        <button
          type="button"
          className="qj-swarm-tool-open-btn"
          data-testid={`swarm-tool-open-${call.name}`}
          onClick={() => openSwarmAuxPane(workbenchService)}
        >
          打开面板
        </button>
      </div>

      {expanded && hasPayload && (
        <div className="qj-swarm-tool-io">
          {Object.keys(call.args).length > 0 && (
            <div className="qj-swarm-tool-io-block">
              <span className="qj-swarm-tool-io-label">参数</span>
              <pre className="qj-swarm-tool-io-pre">{JSON.stringify(call.args, null, 2)}</pre>
            </div>
          )}
          {call.result !== undefined && call.result !== "" && (
            <div className="qj-swarm-tool-io-block">
              <span className="qj-swarm-tool-io-label">返回</span>
              <pre className="qj-swarm-tool-io-pre" data-error={state === "error" ? "true" : undefined}>
                {call.result}
              </pre>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

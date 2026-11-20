/**
 * Built-in default slot components for `conversation.header` and
 * `conversation.composerDock` (including `LivePlanBar`, ADR 0023 `core-conversation`).
 */
import { useCallback, useId, useMemo, useState, type ReactNode } from "react";
import {
  Check,
  ChevronUp,
  Circle,
  Clock,
  LoaderCircle,
  ShieldAlert,
  ShieldCheck,
} from "lucide-react";
import {
  useFrontendService,
  useNavigationState,
  useSessionHandle,
  useSessionState,
  useWorkspaceState,
  type AttachmentPayload,
  type UiMessage,
} from "@qianji/client";
import type {
  ConversationComposerDockSlotProps,
  ConversationHeaderSlotProps,
  SlotComponentProps,
} from "@qianji/client-slots";
import {
  currentPlanStepIndex,
  deriveLivePlan,
  type LivePlanStep,
} from "./conversationHelpers";

/* ── conversation.header: WorkspaceTrustBanner ── */

export function CoreWorkspaceTrustBanner({
  cwd: ownerCwd,
}: SlotComponentProps<ConversationHeaderSlotProps, "session">): ReactNode {
  const workspaceState = useWorkspaceState();
  const workspaceService = useFrontendService("workspaceService");
  const navigationService = useFrontendService("navigationService");
  const [dismissedWorkspace, setDismissedWorkspace] = useState<string | null>(null);
  const [enabling, setEnabling] = useState(false);

  const workspace = (ownerCwd ?? workspaceState?.cwd ?? "").trim();
  const trust = workspaceState?.trust;
  if (
    workspace === "" ||
    dismissedWorkspace === workspace ||
    trust === undefined ||
    trust.trusted ||
    (!trust.hasProjectPlugins && !trust.hasProjectConfig)
  ) {
    return null;
  }

  const summary =
    trust.pluginIds.length > 0
      ? `检测到当前项目包含 ${trust.pluginIds.length} 个项目级插件（${trust.pluginIds.join("、")}），出于安全保护默认暂未运行。`
      : "检测到当前项目包含项目级插件配置（.qianji/harness.json），出于安全保护默认暂未生效。";

  const handleTrust = async () => {
    if (enabling || workspaceService === undefined) return;
    setEnabling(true);
    try {
      await workspaceService.setWorkspaceTrust(workspace, true);
      navigationService?.showToast("已信任工作区并启用项目级插件", "info");
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      navigationService?.showToast(`信任工作区失败：${msg}`, "error");
    } finally {
      setEnabling(false);
    }
  };

  return (
    <div className="workspace-trust-banner" role="region" aria-label="工作区插件信任提示">
      <div className="workspace-trust-copy">
        <ShieldAlert size={16} />
        <span>{summary}</span>
      </div>
      <div className="workspace-trust-actions">
        <button
          type="button"
          className="plugin-mini-button"
          onClick={() => navigationService?.setHubView("plugins")}
        >
          查看详情
        </button>
        <button
          type="button"
          className="plugin-mini-button"
          onClick={() => setDismissedWorkspace(workspace)}
        >
          暂不信任
        </button>
        <button
          type="button"
          className="primary-button"
          disabled={enabling}
          onClick={() => void handleTrust()}
        >
          <ShieldCheck size={14} />
          <span>{enabling ? "正在启用…" : "信任并启用项目插件"}</span>
        </button>
      </div>
    </div>
  );
}

/* ── LivePlanBar (pinned above composer inside conversation.composerDock) ── */

function PlanStepIcon({ status }: { readonly status: LivePlanStep["status"] }): ReactNode {
  if (status === "completed") return <Check size={13} strokeWidth={2} />;
  if (status === "in_progress") return <LoaderCircle className="spin" size={13} strokeWidth={2} />;
  return <Circle size={13} strokeWidth={1.8} />;
}

function PlanProgressRing({ completed, total }: { readonly completed: number; readonly total: number }): ReactNode {
  const radius = 5.5;
  const circumference = 2 * Math.PI * radius;
  const done = total > 0 ? Math.min(1, completed / total) : 0;
  return (
    <svg className="plan-progress-ring" width="14" height="14" viewBox="0 0 14 14" aria-hidden="true">
      <circle cx="7" cy="7" r={radius} fill="none" strokeWidth="2" className="plan-progress-track" />
      <circle
        cx="7"
        cy="7"
        r={radius}
        fill="none"
        strokeWidth="2"
        strokeLinecap="round"
        strokeDasharray={`${circumference * done} ${circumference}`}
        transform="rotate(-90 7 7)"
        className="plan-progress-value"
      />
    </svg>
  );
}

const EMPTY_MESSAGES: readonly UiMessage[] = [];

function CoreLivePlanBar({
  sessionId,
  isolated,
}: {
  readonly sessionId: string | null;
  readonly isolated?: boolean;
}): ReactNode {
  const sessionState = useSessionState();
  const handleOptions = useMemo(
    () => (isolated === true ? { isolated: true } : undefined),
    [isolated],
  );
  const { snapshot: handleSnap } = useSessionHandle(sessionId, handleOptions);
  const [expanded, setExpanded] = useState(false);
  const stepsId = useId();

  const matchesMain =
    sessionState !== undefined &&
    (sessionId === null ||
      sessionId === "active" ||
      sessionId === sessionState.sessionId ||
      sessionId === sessionState.sessionFile);
  const messages = handleSnap !== null ? handleSnap.messages : matchesMain ? sessionState.messages : EMPTY_MESSAGES;
  const isStreaming = handleSnap !== null ? handleSnap.isStreaming : matchesMain ? sessionState.isStreaming : false;

  const plan = useMemo(() => (isStreaming ? deriveLivePlan(messages) : null), [isStreaming, messages]);
  if (plan === null) return null;

  const total = plan.steps.length;
  const finished = plan.completed === total;
  const stepIndex = currentPlanStepIndex(plan);
  const activeStep = plan.steps[stepIndex];
  const label = finished ? `计划 ${total}/${total} 已完成` : `第 ${stepIndex + 1}/${total} 步`;
  const detail = finished ? plan.explanation : activeStep?.text;
  const toggleLabel = expanded ? "收起计划" : "展开计划";

  return (
    <section className={`live-plan${expanded ? " is-expanded" : ""}`} aria-label="当前计划进度">
      {expanded && (
        <ol id={stepsId} className="plan-steps">
          {plan.steps.map((step) => (
            <li key={step.id} className={`plan-step is-${step.status}`}>
              <PlanStepIcon status={step.status} />
              <span>{step.text}</span>
              <em>
                {step.status === "completed" ? "完成" : step.status === "in_progress" ? "进行中" : "待处理"}
              </em>
            </li>
          ))}
        </ol>
      )}
      <button
        type="button"
        className="live-plan-toggle"
        title={toggleLabel}
        aria-expanded={expanded}
        aria-controls={stepsId}
        onClick={() => setExpanded((value) => !value)}
      >
        <PlanProgressRing completed={plan.completed} total={total} />
        <strong>{label}</strong>
        {detail !== undefined && detail !== "" && <span title={detail}>{detail}</span>}
        <ChevronUp className={expanded ? "open" : undefined} size={14} strokeWidth={1.8} aria-hidden="true" />
      </button>
    </section>
  );
}

/* ── conversation.composerDock ── */

export function CoreComposerDock({
  cwd: ownerCwd,
  sessionFile: ownerSessionFile,
  variant = "follow-up",
  isolated,
  sessionId,
  renderSlotChain,
}: SlotComponentProps<ConversationComposerDockSlotProps, "session-maybe">): ReactNode {
  const sessionState = useSessionState();
  const sessionService = useFrontendService("sessionService");
  const workspaceState = useWorkspaceState();
  const navigationState = useNavigationState();
  const handleOptions = useMemo(
    () => (isolated === true ? { isolated: true, cwd: ownerCwd } : undefined),
    [isolated, ownerCwd],
  );
  const { handle, snapshot: handleSnap } = useSessionHandle(sessionId, handleOptions);

  const resolvedCwd = ownerCwd ?? handleSnap?.cwd ?? sessionState?.cwd ?? workspaceState?.cwd ?? "";
  const resolvedSessionFile =
    ownerSessionFile !== undefined
      ? ownerSessionFile
      : (handleSnap?.sessionFile ?? sessionState?.sessionFile ?? null);
  const resolvedSessionKey = sessionId ?? resolvedSessionFile ?? "__draft__";
  const isStreaming = handleSnap !== null ? handleSnap.isStreaming : (sessionState?.isStreaming ?? false);
  const pendingApproval = isolated !== true && navigationState?.extensionRequest != null;

  const handleSend = useCallback(
    async (text: string, attachments?: AttachmentPayload[]): Promise<boolean> => {
      if (handle !== null) {
        return handle.sendMessage(text, attachments);
      }
      if (sessionService !== undefined) {
        return sessionService.sendMessage(text, attachments);
      }
      return false;
    },
    [handle, sessionService],
  );

  return (
    <div
      className="composer-dock"
      data-slot="conversation.composerDock"
      data-session-id={sessionId ?? undefined}
    >
      <CoreLivePlanBar sessionId={sessionId} isolated={isolated} />
      {renderSlotChain(
        "composer.main",
        {
          cwd: resolvedCwd,
          sessionFile: resolvedSessionFile,
          variant,
          sessionKey: resolvedSessionKey,
          isolated,
          isStreaming,
          pendingApproval,
          onSend: handleSend,
        },
        {
          sessionId,
          fallback: (
            <div className="composer-fallback" data-testid="composer-dock-fallback">
              <Clock size={14} aria-hidden="true" />
              <span>输入栏正在加载…</span>
            </div>
          ),
        },
      )}
    </div>
  );
}

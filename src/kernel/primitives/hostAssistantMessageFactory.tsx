/**
 * Host-owned production assistant turn factory (`host.conversation.assistantMessage`).
 *
 * Mirrors Qianji's pre-ADR-0023 `Message.tsx` assistant turn presentation
 * (`ProcessGroup`, `ReasoningRow`, `RunningRow`, `ToolCall`, `ConversationPlan`,
 * `TurnErrorCard`, `MessageIconActions`, `Markdown`) while preserving live slot
 * delegation to `conversation.thinking`, `conversation.toolCall`,
 * `conversation.markdown.codeBlock`, `conversation.message.actions`, and
 * `conversation.turnFooter`.
 */
import {
  useCallback,
  useContext,
  useMemo,
  useState,
  useSyncExternalStore,
  type ReactElement,
  type ReactNode,
} from "react";
import type { SlotComponentProps } from "@qianji/client-slots";
import { ConversationPlan } from "../../components/ConversationPlan";
import { IconChevronDown } from "../../components/DshIcons";
import { Markdown } from "../../components/Markdown";
import { MessageIconActions } from "../../components/message/MessageActionToolbar";
import {
  computeMergedFileTools,
  formatRunDuration,
  liveActivityLabel,
  processSegments,
  settledEmptyTurnHint,
  summarizeProcessGroup,
  TRANSCRIPT_POLICIES,
  workDurationMs,
} from "../../components/message/messageHelpers";
import {
  ProcessGroup,
  ReasoningRow,
  RunningRow,
} from "../../components/message/MessageProcessBlocks";
import {
  DEFAULT_TURN_CONTINUE_PROMPT,
  DEFAULT_TURN_RETRY_PROMPT,
  TurnErrorCard,
  TurnIncompleteBanner,
} from "../../components/message/TurnErrorCard";
import { ToolCall } from "../../components/ToolCall";
import { goalToolKind } from "../../lib/activeGoal";
import { deriveTurnPlanState } from "../../lib/envSources";
import { extractInlineThinking, foldThinking } from "../../lib/thinkingDisplay";
import { normalizeTranscriptDensity } from "../../lib/transcriptDensity";
import { groupTranscriptMessages } from "../../lib/transcriptTurns";
import { useAppStore } from "../../store";
import { useWorkbenchStore } from "../../stores/workbenchStore";
import type { UiMessage, UiToolCall, WorkStep } from "../../types";
import { SlotKernelContext } from "../slots/boundaries";
import { clientSlotsRegistry } from "../slots/registry";

const DEFAULT_THINKING_ENTRY_ID = "core-conversation:thinking";
const DEFAULT_TOOL_CALL_ENTRY_ID = "core-conversation:toolCall";

export interface HostAssistantMessageFactoryProps {
  readonly message: UiMessage;
  readonly working: boolean;
  readonly isLast?: boolean;
  readonly cwd?: string;
  readonly sessionFile?: string | null;
  readonly sessionId?: string;
  readonly turnStartedAt?: number;
  readonly footer?: ReactNode;
  readonly renderToolCall?: (call: UiToolCall) => ReactNode;
  readonly renderThinking?: (thinking: string, running: boolean) => ReactNode;
  readonly renderActions?: (contentText: string) => ReactNode;
}

function collectInlineUiCalls(
  toolCalls: readonly UiToolCall[],
  hasCustomToolSlot: (name: string) => boolean,
): UiToolCall[] {
  const byWidgetId = new Map<string, UiToolCall>();
  const anonymous: UiToolCall[] = [];
  for (const call of toolCalls) {
    if (call.name !== "render_ui" && call.name !== "update_ui") continue;
    if (!hasCustomToolSlot(call.name)) continue;
    const rawId = typeof call.args?.id === "string" ? call.args.id.trim() : "";
    if (rawId !== "") {
      byWidgetId.set(rawId, call);
    } else {
      anonymous.push(call);
    }
  }
  return [...byWidgetId.values(), ...anonymous];
}

export function HostAssistantMessageFactory({
  message,
  working,
  isLast = false,
  sessionId,
  turnStartedAt,
  footer,
  renderToolCall,
  renderThinking,
  renderActions,
  ctx,
}: SlotComponentProps<HostAssistantMessageFactoryProps, "root">): ReactElement | null {
  const [processOpen, setProcessOpen] = useState<boolean | null>(null);
  const kernel = useContext(SlotKernelContext);
  const registry = kernel.registry ?? clientSlotsRegistry;
  useSyncExternalStore(registry.subscribe, registry.getVersion, registry.getVersion);

  const settings = useAppStore((s) => s.settings);
  const thinkingLevel = useAppStore((s) => s.thinkingLevel);
  const model = useAppStore((s) => s.model);
  const storeMessages = useAppStore((s) => s.messages);
  const globalStreaming = useAppStore((s) => s.isStreaming);
  const retryStatus = useAppStore((s) => s.retryStatus);
  const isCompacting = useAppStore((s) => s.isCompacting);

  const showThinking = settings?.showThinking ?? true;
  const transcriptDensity = normalizeTranscriptDensity(settings?.transcriptDensity ?? "normal");
  const policy = TRANSCRIPT_POLICIES[transcriptDensity];
  const expectVisibleThinking = thinkingLevel !== "off" && model?.reasoning === true;
  const workingLabel = isLast
    ? (retryStatus || (isCompacting ? "正在压缩上下文…" : undefined))
    : undefined;

  const { turnPlans, latestPlanMessageId } = useMemo(() => {
    const grouped = groupTranscriptMessages(storeMessages);
    return deriveTurnPlanState(grouped, globalStreaming);
  }, [storeMessages, globalStreaming]);
  const plan = turnPlans.get(message.id);
  const onOpenPlan = useCallback(() => {
    useWorkbenchStore.getState().openSummary("overview");
  }, []);

  const hasCustomThinkingSlot =
    registry.getWrappers("conversation.thinking").length > 0 ||
    registry
      .getRankedCandidates("conversation.thinking")
      .some(
        (entry) =>
          entry.id !== DEFAULT_THINKING_ENTRY_ID &&
          !registry.abdication.isAbdicated("conversation.thinking", entry.id, entry.pluginId),
      );

  const hasCustomToolSlot = (toolName: string): boolean => {
    if (registry.getWrappers("conversation.toolCall").length > 0) return true;
    return registry
      .getKeyedCandidates("conversation.toolCall", toolName)
      .some(
        (entry) =>
          entry.id !== DEFAULT_TOOL_CALL_ENTRY_ID &&
          !registry.abdication.isAbdicated("conversation.toolCall", entry.id, entry.pluginId),
      );
  };

  const normalizedAssistant = extractInlineThinking(message.content, message.thinking);
  const assistantContent = normalizedAssistant.content;
  const toolCalls = (message.toolCalls ?? []).filter((call) => goalToolKind(call.name) !== "get");
  const thinkingText = showThinking ? foldThinking(normalizedAssistant.thinking, assistantContent) : "";
  const steps: WorkStep[] = message.workSteps
    ? message.workSteps.filter((step) =>
        step.kind === "tool"
          ? goalToolKind(step.call.name) !== "get"
          : step.kind !== "thinking" || showThinking,
      )
    : [
        ...(thinkingText ? [{ kind: "thinking" as const, text: thinkingText }] : []),
        ...toolCalls.map((call) => ({ kind: "tool" as const, call })),
      ];

  const hasProcess = steps.length > 0;
  const hasContent = Boolean(assistantContent.trim());
  const hasRunningTool = toolCalls.some((call) => call.running);
  const lastStep = steps[steps.length - 1];
  const reasoningLive = showThinking && working && !hasContent && lastStep?.kind === "thinking";
  const thinkingCount = steps.filter((step) => step.kind === "thinking").length;
  const segments = processSegments(steps);
  const mergedFileTools = computeMergedFileTools(
    steps.flatMap((step) => (step.kind === "tool" ? [step.call] : [])),
  );
  const reasoningUnavailable =
    showThinking &&
    expectVisibleThinking &&
    isLast &&
    !working &&
    thinkingCount === 0 &&
    hasContent &&
    !message.isError &&
    !message.isAborted;
  const durationMs =
    message.durationMs !== undefined && message.durationMs > 0
      ? message.durationMs
      : workDurationMs(toolCalls);
  const hadOnlyHiddenTools = (message.toolCalls?.length ?? 0) > 0 && toolCalls.length === 0;
  const inlineUiCalls = !message.isError ? collectInlineUiCalls(toolCalls, hasCustomToolSlot) : [];
  const hasUiWidgets = inlineUiCalls.length > 0;
  const emptyTurn = settledEmptyTurnHint({
    working,
    hasContent,
    hasProcess,
    hasUiWidgets,
    hadOnlyHiddenTools,
    toolCallCount: toolCalls.length,
    hasTurnTelemetry: message.durationMs !== undefined || message.usage !== undefined,
    isError: message.isError,
    isAborted: message.isAborted,
    stopReason: message.stopReason,
  });
  const effectiveProcessOpen = processOpen ?? emptyTurn.autoOpenProcess;
  const isLengthIncomplete =
    !working && !message.isError && !message.isAborted && message.stopReason === "length";

  const dispatchIsolatedPrompt =
    sessionId !== undefined &&
    sessionId !== "" &&
    sessionId !== "active" &&
    (ctx?.get("sessionService")?.getRetainCount(sessionId) ?? 0) > 0
      ? (promptText: string) => {
          const svc = ctx?.get("sessionService");
          if (svc === undefined || svc.getRetainCount(sessionId) <= 0) return;
          const retained = svc.retain(sessionId);
          if (retained.getSnapshot().isStreaming) {
            retained.release();
            return;
          }
          void retained.sendMessage(promptText).finally(() => {
            retained.release();
          });
        }
      : undefined;

  if (
    !hasContent &&
    !working &&
    !hasProcess &&
    !hasUiWidgets &&
    !reasoningUnavailable &&
    !emptyTurn.hint &&
    !isLengthIncomplete &&
    !message.isError &&
    !message.isAborted
  ) {
    return null;
  }

  const usage = message.usage;
  const copyTitle = usage
    ? `复制回复${message.model ? ` · ${message.model}` : ""} · ${(usage.totalTokens ?? usage.input + usage.output).toLocaleString()} 个 token`
    : "复制回复";

  const renderStep = (step: WorkStep, index: number): ReactNode => {
    if (step.kind === "thinking") {
      const running = reasoningLive && index === steps.length - 1;
      if (hasCustomThinkingSlot && renderThinking !== undefined) {
        return <div key={`thinking-${index}`}>{renderThinking(step.text, running)}</div>;
      }
      return (
        <ReasoningRow
          key={`thinking-${index}`}
          text={step.text}
          running={running}
          settledPreview={policy.settledReasoningPreview}
        />
      );
    }
    if (step.kind === "note") return null;

    const isInlineUiTool = step.call.name === "render_ui" || step.call.name === "update_ui";
    if (!isInlineUiTool && hasCustomToolSlot(step.call.name) && renderToolCall !== undefined) {
      return <div key={step.call.id}>{renderToolCall(step.call)}</div>;
    }

    const mergeMeta = mergedFileTools.get(step.call.id);
    const head = mergeMeta?.headId === step.call.id;
    return (
      <ToolCall
        call={step.call}
        key={step.call.id}
        mergedCount={head ? mergeMeta.count : undefined}
        mergedAdded={head ? mergeMeta.added : undefined}
        mergedRemoved={head ? mergeMeta.removed : undefined}
        mergedDiff={head ? mergeMeta.diff : undefined}
        mergedHidden={mergeMeta !== undefined && !head}
      />
    );
  };

  const renderProcess = (grouped: boolean): ReactNode =>
    segments.map((segment, position) => {
      if (segment.kind === "text") {
        return (
          <div
            key={segment.key}
            className="dshc-process-text dshc-md dshc-md-prose"
            data-chat-group-part="response"
          >
            <Markdown
              content={segment.text}
              isStreaming={working && position === segments.length - 1 && !hasContent}
            />
          </div>
        );
      }
      const active = working && position === segments.length - 1 && (!hasContent || hasRunningTool);
      return (
        <ProcessGroup
          key={segment.key}
          grouped={grouped}
          live={active}
          autoOpen={active}
          summary={summarizeProcessGroup(
            segment.thinking,
            segment.members.flatMap(({ step }) => (step.kind === "tool" ? [step.call] : [])),
          )}
          activity={segment.activity}
        >
          {segment.members.map(({ step, index }) => renderStep(step, index))}
        </ProcessGroup>
      );
    });

  const canCollapse = hasProcess;
  const settledProcessVisible = hasProcess && effectiveProcessOpen;
  const showTurnProcess =
    !working &&
    (hasProcess ||
      (showThinking && durationMs !== null) ||
      reasoningUnavailable ||
      Boolean(emptyTurn.hint) ||
      isLengthIncomplete ||
      message.isAborted === true ||
      message.isError === true);
  const turnProcessLabel = message.isError
    ? "处理失败"
    : message.isAborted
      ? durationMs !== null
        ? "已停止，用时 "
        : "已停止"
      : isLengthIncomplete
        ? durationMs !== null
          ? "未完成（输出受限），用时 "
          : "未完成（输出受限）"
        : durationMs !== null
          ? "已完成，用时 "
          : "已完成";
  const durationParts =
    !message.isError && durationMs !== null ? formatRunDuration(Math.max(1000, durationMs)) : [];
  const liveProcessVisible = working && hasProcess;
  const liveLabel = liveActivityLabel(
    workingLabel,
    hasRunningTool,
    reasoningLive,
    working && hasContent,
  );
  const toolActivity = toolCalls
    .map((call) => `${call.id}:${call.running ? 1 : 0}:${Object.keys(call.args).length}`)
    .join(",");
  const activityKey = `${workingLabel ?? ""}:${assistantContent.length}:${(normalizedAssistant.thinking ?? "").length}:${toolActivity}`;

  return (
    <article
      className={`dshc-flow dshc-turn${message.isError ? " is-error" : ""}`}
      data-chat-flow-kind="assistant"
      data-turn-open={working || undefined}
      data-actions-reveal={isLast ? "always" : "hover"}
      data-session-id={sessionId}
      data-message-id={message.id}
      id={`message-${message.id}`}
    >
      {showTurnProcess && (
        <button
          type="button"
          className="dshc-turn-process"
          data-open={(canCollapse && effectiveProcessOpen) || undefined}
          disabled={!canCollapse}
          aria-expanded={canCollapse ? effectiveProcessOpen : undefined}
          aria-label={canCollapse ? (effectiveProcessOpen ? "收起工作过程" : "展开工作过程") : undefined}
          onClick={(event) => {
            event.currentTarget.focus({ preventScroll: true });
            setProcessOpen((value) => !(value ?? emptyTurn.autoOpenProcess));
          }}
        >
          <span className="dshc-turn-process-label">
            {turnProcessLabel}
            {durationParts.map((part, index) => (
              <span key={index} className={part.numeric ? "dshc-duration-number" : undefined}>
                {part.text}
              </span>
            ))}
          </span>
          {canCollapse && <IconChevronDown className="dshc-turn-process-chevron" />}
        </button>
      )}
      {reasoningUnavailable && !hasProcess && <div className="dshc-hint">模型未返回可见推理</div>}
      {settledProcessVisible && !working && renderProcess(true)}
      {liveProcessVisible && renderProcess(policy.liveGrouping)}
      {plan !== undefined && !working && (
        <ConversationPlan
          plan={plan}
          onOpenPlan={message.id === latestPlanMessageId ? onOpenPlan : undefined}
        />
      )}
      {emptyTurn.hint && <div className="dshc-hint">{emptyTurn.hint}</div>}
      {hasUiWidgets && renderToolCall !== undefined && (
        <div className="dshc-turn-widgets">
          {inlineUiCalls.map((call) => (
            <div key={call.id} style={{ display: "contents" }}>
              {renderToolCall(call)}
            </div>
          ))}
        </div>
      )}
      {hasContent &&
        (!message.isError ||
          (message.error !== undefined &&
            assistantContent.trim() !== message.error.message.trim())) && (
          <div className="dshc-answer" data-streaming={working || undefined}>
            <div className="dshc-md dshc-md-prose">
              <Markdown content={assistantContent} allowRichContent={!working} isStreaming={working} />
            </div>
          </div>
        )}
      {isLengthIncomplete && (
        <TurnIncompleteBanner
          isLast={isLast}
          onContinue={
            dispatchIsolatedPrompt === undefined
              ? undefined
              : () => dispatchIsolatedPrompt(DEFAULT_TURN_CONTINUE_PROMPT)
          }
        />
      )}
      {message.isError && (
        <TurnErrorCard
          message={message}
          fallbackContent={assistantContent}
          isLast={isLast}
          onRetry={
            dispatchIsolatedPrompt === undefined
              ? undefined
              : () => dispatchIsolatedPrompt(DEFAULT_TURN_RETRY_PROMPT)
          }
        />
      )}
      {working && (
        <RunningRow
          label={liveLabel}
          startTime={turnStartedAt ?? message.timestamp}
          activityKey={activityKey}
          divider={hasProcess || hasContent}
          overtimeAllowed={!hasRunningTool}
        />
      )}
      {footer !== undefined && !working && <div className="dshc-turn-footer">{footer}</div>}
      {hasContent && !working && (
        <MessageIconActions
          text={assistantContent}
          time={message.timestamp}
          clock="end"
          copyTitle={copyTitle}
          className="dshc-turn-actions"
          extraActions={renderActions?.(assistantContent)}
        />
      )}
    </article>
  );
}

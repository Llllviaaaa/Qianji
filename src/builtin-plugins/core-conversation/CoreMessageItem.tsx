/**
 * Built-in default `conversation.message` slot component (ADR 0023 `core-conversation`).
 */
import type { ReactNode } from "react";
import { Check, Info, LoaderCircle, Terminal } from "lucide-react";
import { useFrontendService, useThemeState, type UiToolCall } from "@qianji/client";
import { Markdown } from "@qianji/client-primitives";
import type {
  ConversationMessageSlotProps,
  SlotComponentProps,
} from "@qianji/client-slots";
import {
  extractInlineThinking,
  formatMessageClock,
  formatRunDuration,
} from "./conversationHelpers";
import { CopyActionButton, CoreUserMessageRow } from "./CoreUserMessageRow";

export function CoreMessageItem({
  cwd: ownerCwd,
  sessionFile: ownerSessionFile,
  message,
  isStreaming = false,
  isLast = false,
  isLastUserTurn = true,
  turnStartedAt,
  footer,
  onRewind,
  onEditAndResend,
  sessionId,
  renderSlot,
  renderSlotChain,
  renderFactory,
}: SlotComponentProps<ConversationMessageSlotProps, "session">): ReactNode {
  const workbenchService = useFrontendService("workbenchService");
  const themeState = useThemeState();
  const resolvedCwd = ownerCwd ?? "";
  const resolvedSessionFile = ownerSessionFile ?? null;
  const density = themeState?.transcriptDensity ?? "normal";
  const clockLabel = formatMessageClock(message.timestamp);

  const openFileFromMarkdown = (filePath: string, line?: number) => {
    void workbenchService?.openFile(filePath, {
      ...(resolvedCwd !== "" ? { cwd: resolvedCwd } : {}),
      ...(typeof line === "number" && line > 0 ? { line } : {}),
    });
  };

  if (message.role === "terminal") {
    return (
      <article
        className={`dshc-flow message-row terminal-message ${message.isError ? "error" : ""}`}
        id={`message-${message.id}`}
        data-session-id={sessionId}
        data-message-id={message.id}
      >
        <div className="notice-heading">
          <Terminal size={14} /> 终端
        </div>
        <pre>{message.content}</pre>
      </article>
    );
  }

  if (message.role === "notice") {
    if (message.noticeKind === "continuation") {
      return (
        <div
          className="dshc-flow compaction-divider is-continuation"
          role="separator"
          id={`message-${message.id}`}
          data-session-id={sessionId}
          data-message-id={message.id}
        >
          <span>↻ {message.content}</span>
        </div>
      );
    }
    if (message.noticeKind === "goal-complete") {
      const newlineIdx = message.content.indexOf("\n");
      const objective = (newlineIdx >= 0 ? message.content.slice(0, newlineIdx) : message.content).trim();
      const notes = newlineIdx >= 0 ? message.content.slice(newlineIdx + 1).trim() : "";
      return (
        <div
          className="dshc-flow goal-complete-banner"
          role="status"
          id={`message-${message.id}`}
          data-session-id={sessionId}
          data-message-id={message.id}
        >
          <span className="goal-complete-badge">
            <Check size={14} strokeWidth={2} />
            <span>目标已达成</span>
          </span>
          <span className="goal-complete-objective">{objective}</span>
          {notes !== "" && <span className="goal-complete-notes">{notes}</span>}
        </div>
      );
    }
    if (message.noticeKind === "compaction" || message.noticeKind === "branch") {
      const label = message.noticeKind === "compaction" ? "上下文已压缩" : "会话已分叉";
      const detail = message.content.replace(/^(Context compacted|Branch summary)\s*/i, "").trim();
      return (
        <div
          className={`dshc-flow compaction-divider is-${message.noticeKind}`}
          role="separator"
          id={`message-${message.id}`}
          data-session-id={sessionId}
          data-message-id={message.id}
        >
          <span>{label}</span>
          {detail !== "" && density === "verbose" && <small>{detail}</small>}
        </div>
      );
    }
    return (
      <article
        className="dshc-flow message-row notice-message"
        id={`message-${message.id}`}
        data-session-id={sessionId}
        data-message-id={message.id}
      >
        <Info size={14} strokeWidth={1.75} aria-hidden="true" />
        <div className="notice-content">
          <Markdown content={message.content} cwd={resolvedCwd} onOpenFile={openFileFromMarkdown} />
        </div>
      </article>
    );
  }

  if (message.role === "user") {
    const extraSlotActions = renderSlot("conversation.message.actions", {
      cwd: resolvedCwd,
      sessionFile: resolvedSessionFile,
      message,
      contentText: message.content,
    });
    return renderFactory(
      "host.conversation.userMessage",
      {
        message,
        cwd: resolvedCwd,
        sessionFile: resolvedSessionFile,
        sessionId,
        isLastUserTurn,
        onRewind,
        onEditAndResend,
        extraSlotActions,
      },
      {
        fallback: (
          <CoreUserMessageRow
            message={message}
            cwd={resolvedCwd}
            sessionFile={resolvedSessionFile}
            sessionId={sessionId}
            clockLabel={clockLabel}
            onRewind={onRewind}
            onEditAndResend={onEditAndResend}
            renderSlot={renderSlot}
          />
        ),
      },
    );
  }

  const working = message.isStreaming === true || (isLast && isStreaming);

  const renderToolCall = (call: UiToolCall): ReactNode => {
    const state: "running" | "error" | "ok" = call.running ? "running" : call.isError ? "error" : "ok";
    return renderSlot(
      "conversation.toolCall",
      {
        cwd: resolvedCwd,
        sessionFile: resolvedSessionFile,
        call,
        state,
        messageId: message.id,
      },
      { key: call.name },
    );
  };

  const renderThinking = (thinking: string, running: boolean): ReactNode =>
    renderSlotChain("conversation.thinking", {
      cwd: resolvedCwd,
      sessionFile: resolvedSessionFile,
      message,
      thinking,
      isStreaming: running,
      ...(message.workSteps === undefined ? {} : { workSteps: message.workSteps }),
    });

  const renderActions = (contentText: string): ReactNode =>
    renderSlot("conversation.message.actions", {
      cwd: resolvedCwd,
      sessionFile: resolvedSessionFile,
      message,
      contentText,
    });

  const extracted = extractInlineThinking(message.content, message.thinking);
  const assistantContent = extracted.content;
  const thinkingText = extracted.thinking;
  const toolCalls = message.toolCalls ?? [];
  const hasContent = assistantContent.trim() !== "";
  const workSteps = message.workSteps;
  const fallbackNoteText =
    workSteps !== undefined
      ? workSteps
          .filter((step): step is { kind: "note"; text: string } => step.kind === "note")
          .map((step) => step.text)
          .join("\n\n")
      : "";
  const actionContent = hasContent ? assistantContent : fallbackNoteText;

  const fallbackAssistantArticle = (
    <article
      className={`dshc-flow dshc-turn${message.isError ? " is-error" : ""}`}
      data-chat-flow-kind="assistant"
      data-turn-open={working || undefined}
      data-actions-reveal={isLast ? "always" : "hover"}
      data-session-id={sessionId}
      data-message-id={message.id}
      id={`message-${message.id}`}
    >
      {!working && (message.durationMs !== undefined || message.isError || message.isAborted) && (
        <div className="dshc-turn-process">
          <span className="dshc-turn-process-label">
            {message.isError
              ? "处理失败"
              : message.isAborted
                ? "已停止"
                : message.durationMs !== undefined && message.durationMs > 0
                  ? `已完成，用时 ${formatRunDuration(message.durationMs)}`
                  : "已完成"}
          </span>
        </div>
      )}

      {workSteps !== undefined && workSteps.length > 0 ? (
        workSteps.map((step, index) => {
          if (step.kind === "thinking") {
            return (
              <div key={`thinking-${index}`} style={{ display: "contents" }}>
                {renderThinking(step.text, working && !hasContent && index === workSteps.length - 1)}
              </div>
            );
          }
          if (step.kind === "note") {
            return (
              <div key={`note-${index}`} className="dshc-process-text dshc-md dshc-md-prose">
                <Markdown
                  content={step.text}
                  cwd={resolvedCwd}
                  onOpenFile={openFileFromMarkdown}
                  allowRichContent={!working}
                  isStreaming={working && index === workSteps.length - 1 && !hasContent}
                />
              </div>
            );
          }
          return (
            <div key={step.call.id} className="dshc-tool-list">
              {renderToolCall(step.call)}
            </div>
          );
        })
      ) : (
        <>
          {thinkingText !== "" && renderThinking(thinkingText, working && !hasContent)}
          {toolCalls.length > 0 && (
            <div className="dshc-tool-list">
              {toolCalls.map((call) => (
                <div key={call.id} style={{ display: "contents" }}>
                  {renderToolCall(call)}
                </div>
              ))}
            </div>
          )}
        </>
      )}

      {hasContent && (
        <div className="dshc-answer" data-streaming={working || undefined}>
          <div className="dshc-md dshc-md-prose">
            <Markdown
              content={assistantContent}
              cwd={resolvedCwd}
              onOpenFile={openFileFromMarkdown}
              allowRichContent={!working}
              isStreaming={working}
            />
          </div>
        </div>
      )}

      {message.isError && message.error !== undefined && (
        <div className="dshc-turn-error" role="status">
          <div className="dshc-turn-error-message">{message.error.message}</div>
        </div>
      )}

      {working && (
        <div className="dshc-running" data-chat-running="">
          <LoaderCircle className="spin" size={14} aria-hidden="true" />
          <span className="dsh-claude-chat-wait-label">正在生成回复…</span>
        </div>
      )}

      {footer !== undefined && !working && <div className="dshc-turn-footer">{footer}</div>}

      {actionContent !== "" && !working && (
        <div className="dshc-actions dshc-turn-actions" data-clock="end">
          <CopyActionButton text={actionContent} title="复制回复" />
          {renderActions(actionContent)}
          {clockLabel !== "" && (
            <span className="dshc-end-info">
              <span className="dshc-time-end">{clockLabel}</span>
            </span>
          )}
        </div>
      )}
    </article>
  );

  return renderFactory(
    "host.conversation.assistantMessage",
    {
      message,
      working,
      isLast,
      cwd: resolvedCwd,
      sessionFile: resolvedSessionFile,
      sessionId,
      ...(turnStartedAt === undefined ? {} : { turnStartedAt }),
      ...(footer === undefined ? {} : { footer }),
      renderToolCall,
      renderThinking,
      renderActions,
    },
    { fallback: fallbackAssistantArticle },
  );
}

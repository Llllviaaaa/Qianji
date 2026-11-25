/**
 * Built-in default `conversation.message` slot component (ADR 0023 `core-conversation`).
 */
import type { ReactNode } from "react";
import { Check, Info, LoaderCircle, RotateCcw, Terminal } from "lucide-react";
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

const CORE_RETRY_PROMPT = "请重试并继续完成上一轮未完成的回复。";
const CORE_CONTINUE_PROMPT = "请从上次截断处直接继续输出剩余内容。";

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
  const sessionService = useFrontendService("sessionService");
  const composerService = useFrontendService("composerService");
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
  const isLengthIncomplete =
    !working && !message.isError && !message.isAborted && message.stopReason === "length";

  const sendFollowUpPrompt = (promptText: string) => {
    if (working) return;
    if (sessionService !== undefined) {
      const snap = sessionService.getSnapshot();
      const isMain =
        sessionId === undefined ||
        sessionId === "" ||
        sessionId === "active" ||
        sessionId === snap.sessionId ||
        sessionId === snap.sessionFile;
      if (isMain) {
        if (snap.isStreaming) return;
        void sessionService.sendMessage(promptText);
        return;
      }
      if (sessionService.getRetainCount(sessionId) > 0) {
        const retained = sessionService.retain(sessionId);
        if (retained.getSnapshot().isStreaming) {
          retained.release();
          return;
        }
        void retained.sendMessage(promptText).finally(() => {
          retained.release();
        });
        return;
      }
      void sessionService.sendMessage(promptText);
      return;
    }
    composerService?.prefill(promptText, sessionId);
  };

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
      {!working &&
        (message.durationMs !== undefined ||
          message.isError ||
          message.isAborted ||
          isLengthIncomplete) && (
          <div className="dshc-turn-process">
            <span className="dshc-turn-process-label">
              {message.isError
                ? "处理失败"
                : message.isAborted
                  ? message.durationMs !== undefined && message.durationMs > 0
                    ? `已停止，用时 ${formatRunDuration(message.durationMs)}`
                    : "已停止"
                  : isLengthIncomplete
                    ? message.durationMs !== undefined && message.durationMs > 0
                      ? `未完成（输出受限），用时 ${formatRunDuration(message.durationMs)}`
                      : "未完成（输出受限）"
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

      {hasContent &&
        (!message.isError ||
          (message.error !== undefined &&
            assistantContent.trim() !== message.error.message.trim())) && (
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

      {isLengthIncomplete && (
        <div className="dshc-turn-incomplete" role="status">
          <div className="dshc-turn-incomplete-copy">
            <span className="dshc-state-dot" data-state="warn" aria-hidden="true" />
            <span>回答因达到输出长度上限而未完成</span>
          </div>
          {isLast && (
            <button
              type="button"
              className="dshc-turn-incomplete-btn"
              onClick={() => sendFollowUpPrompt(CORE_CONTINUE_PROMPT)}
              title="让模型从上次截断处继续输出"
            >
              <RotateCcw size={12} strokeWidth={1.75} aria-hidden="true" />
              <span>继续生成</span>
            </button>
          )}
        </div>
      )}

      {message.isError && (
        <div className="dshc-turn-error" role="status">
          <div className="dshc-turn-error-header">
            <div className="dshc-turn-error-heading">
              <span className="dshc-state-dot" data-state="error" aria-hidden="true" />
              <span className="dshc-turn-error-title">
                {message.error?.code === "empty_response_exhausted"
                  ? "模型未返回可见正文"
                  : "提供商接口异常"}
              </span>
              {message.error?.code !== undefined && (
                <span className="dshc-turn-error-badge is-code">{message.error.code}</span>
              )}
            </div>
            {isLast && !working && message.error?.retryable !== false && (
              <div className="dshc-turn-error-tools">
                <button
                  type="button"
                  className="dshc-turn-error-btn"
                  onClick={() => sendFollowUpPrompt(CORE_RETRY_PROMPT)}
                  title="重试本轮请求"
                >
                  <RotateCcw size={12} strokeWidth={1.75} aria-hidden="true" />
                  <span>重试</span>
                </button>
              </div>
            )}
          </div>
          <div className="dshc-turn-error-copy">
            <div className="dshc-turn-error-message">
              {message.error?.message || assistantContent || "本轮执行失败"}
            </div>
            {message.error?.code === "empty_response_exhausted" && (
              <div className="dshc-turn-error-hint">
                模型连续仅输出了内部思考或空响应。可点击重试，或调低推理强度后再试。
              </div>
            )}
          </div>
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
